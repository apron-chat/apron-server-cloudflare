/*
 * History tiers: each store holding a contiguous range of the log, joined
 * in a chain by links (chain.ts). Tier 0 is the head (the Durable Object's
 * SQLite), where records are made; each tier below takes what leaves the
 * one above it, over the link between them. Tiers know nothing of each
 * other: a link is the only thing that connects two.
 */

import type { ArchivedRoom, ArchivedUser } from "@apron/archive";
import type { ChatRecord, HistoryQuery, QueuedRewrite, RecordRange, Retention, Rewrite, TierStats } from "./records";
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
	 * Log IDs a copy into this tier takes at once (its link scans the tier
	 * above with it): a tier that stores records in large pieces (the cold
	 * tier's chunks) asks for a piece's worth. Default: the chain's batch.
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
	/**
	 * The capability to take /purge and /rename: applies `rewrite` to what it
	 * holds, in one step. A purge drops its user's message snapshots, every
	 * reaction set on those messages and on `rewrite.messages`, and the
	 * user's reaction sets and memberships; a rename renames the user
	 * everywhere. A purge first tells `found` the messages of its user held
	 * here that it does not name yet, before it rewrites anything. Repeating
	 * it does no harm. A tier without it is still linked: its link
	 * acknowledges rewrites without applying them (chain.ts).
	 */
	rewrite?(rewrite: Rewrite, found: (messageIds: readonly string[]) => Promise<void>): Promise<void>;
}

/** The methods a tier may have, by name: what instrument() wraps (and nothing else a tier may have). */
export const TIER_METHODS = ["append", "scan", "read", "lookup", "stats", "floorFor", "trimBelow", "rewrite"] as const;

/** The head's log of /purge and /rename, which the links deliver down the chain in order. */
export interface RewriteLog {
	/** The rewrites some link has yet to deliver, oldest first. */
	list(): Promise<QueuedRewrite[]>;
	/** The newest seq ever logged (0: none), delivered or not. */
	logged(): Promise<number>;
	/** Forgets rewrites through `seq`, once every link delivered them. */
	drop(seq: number): Promise<void>;
	/**
	 * Adds `messageIds` to queued purge `seq`: messages of its user a tier
	 * found (HistoryTier.rewrite's `found`), so the tiers it has yet to
	 * reach, and pages read from them meanwhile, drop the reaction sets on
	 * those messages too.
	 */
	amend(seq: number, messageIds: readonly string[]): Promise<void>;
}

/**
 * The head, as the chain sees it: where records are made, and where /purge
 * and /rename happen first. Its trimming is its own (Store.runCleanup, with
 * the copy marker as a ceiling); the chain asks for it through trimBelow.
 */
export interface HistoryHead extends HistoryTier {
	readonly rewrites: RewriteLog;
	/** /purge here: the users' records and state go, and a rewrite each is queued (rewrites). */
	purge(userIds: readonly string[]): Promise<void>;
	/** /rename here: every record naming `from` names `to`, and the rewrite is queued. */
	rename(from: string, to: string): Promise<void>;
	/** Drops the head's reaction records on messages only a lower tier held (a rewrite's `found`). */
	dropReactionsOn(messageIds: readonly string[]): Promise<void>;
	/** The floor history is published from: the deepest tier's. */
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
	/** Records dropped: not something a client could have sent (RestorePort.normalize). */
	rejected?: number;
}

/** A tier's own state: nothing below `floor` is in it; `target` is the floor its retention allows, applied next. */
export interface TierFloor {
	floor: number;
	target: number;
}

/**
 * A link's state: what the tier below holds of the tier above (`through`:
 * a copy of every record up to it), the last rewrite it delivered below
 * (`delivered`, a seq of the head's log), and whether its work is failing
 * (`stall`, stall.ts).
 */
export interface LinkState {
	through: number;
	delivered: number;
	stall: Stall;
}

/** The chain's state: each tier's, and each link's (link `i` joins tier `i` to tier `i + 1`). */
export interface ChainState {
	tiers: TierFloor[];
	links: LinkState[];
}

/**
 * Where the chain's state is kept (state.ts over the Store; memory in
 * tests). The head's floor is its own (the Store's cleanup moves it):
 * saving it may change nothing.
 */
export interface ChainStateStore {
	/** The state of the tiers named, in chain order, and of the links between them. */
	load(names: readonly string[]): Promise<ChainState>;
	/** The link out of tier `from`, whatever tier is below it now (the head's, while the D1 tier is off). */
	loadLink(from: string): Promise<LinkState>;
	/** Whether a tier has state saved: it has held history here since tiers were last on. */
	has(name: string): Promise<boolean>;
	saveTier(name: string, update: Partial<TierFloor>): Promise<void>;
	/** Saves the link out of tier `from`. */
	saveLink(from: string, update: Partial<LinkState>): Promise<void>;
}
