/*
 * History tiers: each store holding a contiguous range of the log.
 * Tier 0 is the head (the Durable Object's SQLite), where records are made;
 * the tiers below hold what left it, ordered newest to oldest. Tiers know
 * nothing of each other: HistoryPipeline orders them and keeps every
 * cross-tier rule.
 */

import type { ArchivedRoom, ArchivedUser } from "@apron/archive";
import type { ChatRecord, HistoryOp, HistoryQuery, QueuedOp, RecordRange, Retention, TierStats } from "./records";
import type { Stall } from "./stall";

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
	/**
	 * Log IDs a copy into this tier takes at once (the pipeline scans the tier
	 * above with it): a tier that stores records in large pieces (the cold
	 * tier's chunks) asks for a piece's worth. Default: the pipeline's batch.
	 */
	readonly appendBatch?: number;
	/** INSERT OR REPLACE semantics. */
	append(range: RecordRange): Promise<void>;
	/** Oldest first from `from`, at most `limit` distinct log IDs, every room's copy of each. */
	scan(from: number, limit: number): Promise<RecordRange>;
	/** Records of the window's first `limit` distinct log IDs. */
	read(query: HistoryQuery): Promise<ChatRecord[]>;
	/** Records with these log IDs, any room (import's duplicate check). */
	lookup(logIds: readonly number[]): Promise<ChatRecord[]>;
	stats(context?: { lower?: number; upper?: number }): Promise<TierStats>;
	/** The floor its retention allows: records below it may leave. Undefined: nothing need leave. */
	floorFor(retention: Retention, context: FloorContext): Promise<number | undefined>;
	/** Deletes records below `floor`, at most `max` (or a little more, where it keeps records in pieces); returns how many went. */
	trimBelow(floor: number, max: number): Promise<number>;
}

/** The methods every tier has, by name: what instrument() wraps (and nothing else a tier may have). */
export const TIER_METHODS = ["append", "scan", "read", "lookup", "stats", "floorFor", "trimBelow", "applyOp"] as const;

/** What a tier is given to apply one op with (LowerTier.applyOp). */
export interface OpStep {
	/** Where a previous step of this op stopped (what applyOp returned), or undefined to start. */
	cursor?: string;
	/**
	 * Called with the messages of a purge's users this tier holds that the op
	 * does not name yet, before the tier rewrites anything: the pipeline adds
	 * them to the op (HistoryHead.amendPurge) for the tiers below and pages
	 * read from them, and drops their reactions above. Called before a
	 * rewrite, so a crash after it loses nothing the rewrite removed.
	 */
	found(messageIds: readonly string[]): Promise<void>;
}

/**
 * A tier below the head: /purge and /rename reach every one, through the
 * head's op log (HistoryPipeline.applyOps).
 */
export interface LowerTier extends HistoryTier {
	/**
	 * Applies `op` (a purge: drop the users' message snapshots, every reaction
	 * set on those messages and on `op.messageIds`, and their reaction sets and
	 * memberships elsewhere; a rename: every record naming `from` names `to`),
	 * or a bounded part of it. Returns the cursor to continue from in the next
	 * step, or undefined once the op is applied. Repeating a step does no harm.
	 */
	applyOp(op: HistoryOp, step: OpStep): Promise<string | undefined>;
}

/** The head's log of `/purge` and `/rename`, for the tiers below (HistoryPipeline.applyOps). */
export interface OpLog {
	/** The ops the tiers below have yet to apply, oldest first. */
	list(): Promise<QueuedOp[]>;
	/** Forgets ops through `seq`, once every tier below applied them. */
	drop(seq: number): Promise<void>;
	/**
	 * Adds `messageIds` to queued purge `seq`: messages of its users that a
	 * tier below found (OpStep.found), so the tiers below that one,
	 * and pages read from them meanwhile, drop those messages' records too.
	 */
	amend(seq: number, messageIds: readonly string[]): Promise<void>;
}

/**
 * The head, as the pipeline sees it: where records are made. Its trimming
 * is its own (Store.runCleanup, with the copy marker as a ceiling); the
 * pipeline asks for it through trimBelow.
 */
export interface HistoryHead extends HistoryTier {
	readonly opLog: OpLog;
	/** /purge here: the users' records and state go, and the op is queued for the tiers below (opLog). */
	purge(userIds: readonly string[]): Promise<void>;
	/** /rename here: every record naming `from` names `to`, and the op is queued for the tiers below. */
	rename(from: string, to: string): Promise<void>;
	/** Drops the head's reaction records on messages only a lower tier held (OpStep.found). */
	dropReactionsOn(messageIds: readonly string[]): Promise<void>;
	/** The floor history is published from: the deepest readable tier's. */
	publishedFloor(): Promise<number>;
	/** Raises the published floor (never past the head's own floor). */
	publish(floor: number): Promise<void>;
}

/** One stored value: read, written, or cleared with null. */
export interface Cell<T> {
	get(): Promise<T | undefined>;
	set(value: T | null): Promise<void>;
}

/**
 * What an import needs of the server it restores into (importArchive).
 * Every method is required: one missing would quietly weaken the import
 * (no resume, records unchecked, a retired ID reused).
 */
export interface RestorePort {
	hasRoom(roomId: string): Promise<boolean>;
	/** A room that exists with nothing logged past its creation (a new server's `general`), which an import may fill. */
	roomIsEmpty(roomId: string): Promise<boolean>;
	hasUser(userId: string): Promise<boolean>;
	/** Whether a user ID is retired (purged or renamed away) and may not be reused. */
	isRetired(userId: string): Promise<boolean>;
	/** The newest log ID given here (renumbering). */
	latest(): Promise<number>;
	/**
	 * A record as this server would take it from a client (its recorded
	 * users bare, a message's body normalized as a post's, its size within a
	 * snapshot's), or null when a client could not have sent it.
	 */
	normalize(record: ChatRecord): ChatRecord | null;
	/** Adds placeholder users, marked unclaimed. */
	restoreUsers(users: readonly ArchivedUser[]): Promise<void>;
	/**
	 * Adds a new room (listing and records at or above the head's floor) and
	 * rebuilds its current state. `context.rooms` are the rooms this import
	 * adds (their IDs here): a message here already is taken for the same one
	 * only when it is in one of them.
	 */
	restoreRoom(room: ArchivedRoom, records: readonly ChatRecord[], context: RestoreContext): Promise<RestoreResult>;
	/** The running import's journal, so a retry finishes it. */
	readonly journal: Cell<string>;
}

/** What an export needs of the server beside its records (exportArchive). */
export interface ExportPort {
	/** Every room, as a listing (`room_list`'s shape) with its members. */
	rooms(): Promise<ArchivedRoom[]>;
	/** These users' profiles, as far as they exist here. */
	users(userIds: readonly string[]): Promise<ArchivedUser[]>;
}

/** What restoreRoom is told of the import it serves. */
export interface RestoreContext {
	/** The rooms the import adds, by their IDs here. */
	rooms: readonly string[];
}

/** What a restoreRoom call did. */
export interface RestoreResult {
	stored?: number;
	/** Messages whose ID another message here holds: their state (and reaction sets) were left as they are. */
	collided?: number;
	/** Records dropped: not something a client could have sent (normalizeRecord). */
	rejected?: number;
}

/**
 * Per-tier progress, as the planner reads it. The head's floor is its hot
 * floor and it applies no ops (`ops` 0); a tier's `through` and `stall` are
 * those of the copy from it into the next one.
 */
export interface TierState {
	/** Nothing below this is in the tier. */
	floor: number;
	/** The floor retention allows, applied on the next cycle. */
	target: number;
	/** The newest log ID the NEXT tier holds a copy of (unused on the last tier). */
	through: number;
	/** The last op (QueuedOp.seq) this tier applied (tiers below the head; 0 for the head). */
	ops: number;
	/** Where this tier's application of the next op (`ops` + 1) stopped, while it takes several steps (LowerTier.applyOp). */
	opCursor?: string;
	/** Whether the copy (and the work) into the next tier is failing, and whether admins were told (stall.ts). */
	stall: Stall;
}

/**
 * What the pipeline may change of the head's state: no ops (it applies
 * none). Its floor is asked for, not set: where the head's own cleanup
 * moves it (the Store), that floor stands.
 */
export interface HeadStateUpdate {
	floor?: number;
	target?: number;
	through?: number;
	stall?: Stall;
}

/** What the pipeline may change of a lower tier's state. `opCursor: null` clears it. */
export interface LowerStateUpdate extends HeadStateUpdate {
	ops?: number;
	opCursor?: string | null;
}

/** Where tier state is kept (state.ts over the Store; memory in tests). */
export interface TierStateStore {
	load(names: readonly string[]): Promise<Record<string, TierState>>;
	/** Whether a lower tier has state saved: it has held history here since tiers were last on. */
	has(name: string): Promise<boolean>;
	saveHead(update: HeadStateUpdate): Promise<void>;
	saveLower(name: string, update: LowerStateUpdate): Promise<void>;
}
