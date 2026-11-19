/*
 * History tiers (PLAN §5): each store holding a contiguous range of the log.
 * Tier 0 is the head (the Durable Object's SQLite), where records are made;
 * the tiers below hold what left it, ordered newest to oldest. Tiers know
 * nothing of each other: HistoryPipeline orders them and keeps every
 * cross-tier rule.
 */

import type { ArchivedRoom, ArchivedUser } from "./archive/types";
import type { ChatRecord, HistoryOp, HistoryQuery, QueuedOp, RecordRange, Retention, TierStats } from "./records";

/** What floorFor may count against: the floor of the tier above (records at or past it are only copies) and the time. */
export interface FloorContext {
	now: number;
	/** The floor of the tier above; its records from there on are copies held above too. Infinity for the head. */
	below: number;
}

/** One history store. Every method may be repeated with the same arguments without harm. */
export interface HistoryTier {
	/** Stable: names its state. */
	readonly name: string;
	/** Serves joined-rooms pages, which read several rooms at once (PLAN §7). Default true. */
	readonly multiRoom?: boolean;
	/** INSERT OR REPLACE semantics. */
	append(range: RecordRange): Promise<void>;
	/** Oldest first from `from`, at most `limit` distinct log IDs, every room's copy of each. */
	scan(from: number, limit: number): Promise<RecordRange>;
	/** Absent: write-only (a backup tier). Records of the window's first `limit` distinct log IDs. */
	read?(query: HistoryQuery): Promise<ChatRecord[]>;
	/** Records with these log IDs, any room (import's duplicate check, PLAN §10.3). */
	lookup?(logIds: readonly number[]): Promise<ChatRecord[]>;
	stats(context?: { lower?: number; upper?: number }): Promise<TierStats>;
	/** The floor its retention allows: records below it may leave. Undefined: nothing need leave. */
	floorFor(retention: Retention, context: FloorContext): Promise<number | undefined>;
	/** Deletes records below `floor`, at most `max` (blob tiers: whole segments only); returns how many went. */
	trimBelow(floor: number, max: number): Promise<number>;
	/** Upkeep a tier may want when nothing else is due (the blob tier's compaction); returns whether it did any. */
	upkeep?(budget: { steps: number }, context: { final: number }): Promise<boolean>;
}

/** What a purge found that the tiers above may still refer to. */
export interface PurgeResult {
	/** Messages of the purged users this tier held: reaction sets on them elsewhere go too. */
	messageIds: string[];
}

/** A tier /purge and /rename reach (decision 3). */
export interface RewritableTier extends HistoryTier {
	/** Removes the users' message snapshots, every reaction set on those messages (and on `messageIds`), and their reaction sets and memberships elsewhere. */
	purge(userIds: readonly string[], messageIds?: readonly string[]): Promise<PurgeResult>;
	/** Every record naming `from` names `to`. */
	rename(from: string, to: string): Promise<void>;
}

export function isRewritable(tier: HistoryTier): tier is RewritableTier {
	return typeof (tier as Partial<RewritableTier>).purge === "function" &&
		typeof (tier as Partial<RewritableTier>).rename === "function";
}

/**
 * The head: where records are made, with current state beside them. Its
 * trimming is its own (Store.runCleanup, with the copy marker as a ceiling);
 * the pipeline asks for it through trimBelow.
 */
export interface HistoryHead extends RewritableTier {
	/** The floor history is published from: the deepest readable tier's. */
	publishedFloor(): Promise<number>;
	/** Raises the published floor (never past the head's own floor). */
	publish(floor: number): Promise<void>;
	/** The op log: `/purge` and `/rename` done here, for the rewritable tiers below (PLAN §8). */
	ops(): Promise<QueuedOp[]>;
	/** Forgets ops through `seq`, once every rewritable tier applied them. */
	dropOps(seq: number): Promise<void>;
	/** Queues an op for the tiers below, as the head's own purge and rename do. */
	queueOp?(op: HistoryOp): Promise<void>;
	/** Drops the head's reaction records on messages only a lower tier held (PurgeResult.messageIds). */
	dropReactionsOn(messageIds: readonly string[]): Promise<void>;
	hasRoom(roomId: string): Promise<boolean>;
	hasUser(userId: string): Promise<boolean>;
	/** Import only: adds a new room (listing and records at or above the head's floor) and rebuilds its current state. */
	restoreRoom(room: ArchivedRoom, records: readonly ChatRecord[]): Promise<void>;
	/** Import only: adds placeholder users, marked unclaimed (PLAN §10.4). */
	restoreUsers(users: readonly ArchivedUser[]): Promise<void>;
	/** Import only: whether a user ID is retired (purged or renamed away) and may not be reused. */
	isRetired?(userId: string): Promise<boolean>;
	/** Export: every room, as a listing (`room_list`'s shape) with its members. */
	rooms?(): Promise<ArchivedRoom[]>;
	/** Export: these users' profiles, as far as they exist here. */
	users?(userIds: readonly string[]): Promise<ArchivedUser[]>;
	/** The newest log ID given here (import's renumbering). */
	latest?(): Promise<number>;
	/** Import: a room that exists with nothing logged past its creation (a new server's `general`), which an import may fill. */
	roomIsEmpty?(roomId: string): Promise<boolean>;
	/** Import: the running import's journal (importArchive), so a retry finishes it. */
	journal?(): Promise<string | undefined>;
	setJournal?(value: string | null): Promise<void>;
}

/** Per-tier progress, persisted in the head's `_meta` under `history:<tier>:<field>`. */
export interface TierState {
	/** Nothing below this is in the tier. */
	floor: number;
	/** The floor retention allows, applied on the next cycle. */
	target: number;
	/** The newest log ID the NEXT tier holds a copy of (unused on the last tier). */
	through: number;
	/** The last op (QueuedOp.seq) this tier applied (rewritable tiers below the head). */
	ops: number;
	/** When the copy to the next tier first failed, since its last success. */
	stalledSince?: number;
	/** When admins were alerted of this stall. */
	alertedAt?: number;
}

export interface TierStateStore {
	load(names: readonly string[]): Promise<Record<string, TierState>>;
	save(name: string, state: Partial<TierState>): Promise<void>;
}

/** A TierStateStore in memory, for tests and Node scripts. */
export class MemoryTierStateStore implements TierStateStore {
	readonly states = new Map<string, TierState>();
	constructor(private readonly initial: () => TierState = () => ({ floor: 1, target: 1, through: 0, ops: 0 })) {}
	async load(names: readonly string[]): Promise<Record<string, TierState>> {
		return Object.fromEntries(names.map((name) => [name, { ...(this.states.get(name) ?? this.initial()) }]));
	}
	async save(name: string, state: Partial<TierState>): Promise<void> {
		const merged: TierState = { ...(this.states.get(name) ?? this.initial()), ...state };
		for (const key of Object.keys(state) as Array<keyof TierState>) if (state[key] === undefined) delete merged[key];
		this.states.set(name, merged);
	}
}
