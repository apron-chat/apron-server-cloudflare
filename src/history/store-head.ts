/*
 * The head over the Durable Object's Store: an
 * adapter, not a reimplementation. The Store keeps its records, current
 * state and cleanup; this hands the pipeline what it needs of them, and
 * keeps the pipeline's tier state in the Store's `_meta`.
 *
 * Its trimming is the Store's own cleanup (Store.runCleanup), which removes
 * records only below the copy marker (`through`) and on its own schedule:
 * trimBelow asks nothing of it. Likewise its retention is the Store's
 * config (retentionRecords, minRetentionMs, retentionMs), found by the
 * running cleanup job: floorFor ignores the Retention passed in.
 */

import type { ArchivedRoom, ArchivedUser } from "@apron/archive";
import { type ChatRecord, type HistoryQuery, type QueuedOp, type RecordRange, type TierStats, toRange } from "./records";
import type { HistoryHead, RestoreContext, RestoreResult, TierState, TierStateStore } from "./tier";

/** What the adapter needs of the Store (src/store.ts), so this module does not load it. */
export interface StorePort {
	historyFloors(): { hot: number; published: number; latest: number };
	listRooms(now?: number, options?: { maintenance?: boolean; withPrivate?: boolean }): Array<{ room_id: string }>;
	historyImportJournal(): string | undefined;
	setHistoryImportJournal(value: string | null): void;
	roomIsEmpty(roomId: string): boolean;
	getIdentity(userId: string): { userId: string; name: string; avatar?: string; roles: string[]; ext?: Record<string, unknown> } | null;
	historyTarget(): number | undefined;
	historyScan(from: number, limit?: number): ChatRecord[];
	historyRecords(query: HistoryQuery): ChatRecord[];
	historyLookup(logIds: readonly number[]): ChatRecord[];
	historyState(names: readonly string[], head: string): Record<string, TierState>;
	saveHistoryState(name: string, head: string, update: Partial<TierState>): void;
	publishHistoryFloor(floor: number): void;
	historyOps(): QueuedOp[];
	dropHistoryOps(seq: number): void;
	amendHistoryPurge(seq: number, messageIds: readonly string[]): void;
	dropReactionsOn(messageIds: readonly string[]): void;
	hotRecords(): number;
	purgeUsers(input: { userIds: readonly string[] }): unknown;
	renameIdentity(input: { from: string; to: string }): unknown;
	getRoom(roomId: string): unknown;
	identityExists(userId: string): boolean;
	restoreRoom(room: ArchivedRoom, records: readonly ChatRecord[], now?: number, options?: { rooms?: readonly string[] }): RestoreResult;
	restorableRecord(record: ChatRecord): ChatRecord | null;
	restoreUsers(users: readonly ArchivedUser[]): void;
	isRetiredUserId(userId: string): boolean;
}

export class StoreHead implements HistoryHead {
	constructor(readonly name: string, private readonly store: StorePort) {}

	/** The Store makes its records by commit: nothing is copied into it. */
	async append(range: RecordRange): Promise<void> {
		if (range.records.length) throw new Error("this head takes records only by commit");
	}

	async scan(from: number, limit: number): Promise<RecordRange> {
		return toRange(this.store.historyScan(from, limit));
	}

	async read(query: HistoryQuery): Promise<ChatRecord[]> {
		return this.store.historyRecords(query);
	}

	async lookup(ids: readonly number[]): Promise<ChatRecord[]> {
		return this.store.historyLookup(ids);
	}

	async stats(): Promise<TierStats> {
		return { records: this.store.hotRecords() };
	}

	async floorFor(): Promise<number | undefined> {
		return this.store.historyTarget();
	}

	/** Cleanup trims, below the copy marker, on its own schedule. */
	async trimBelow(): Promise<number> {
		return 0;
	}

	async purge(userIds: readonly string[]): Promise<void> {
		this.store.purgeUsers({ userIds });
	}

	async rename(from: string, to: string): Promise<void> {
		this.store.renameIdentity({ from, to });
	}

	async publishedFloor(): Promise<number> {
		return this.store.historyFloors().published;
	}

	async publish(floor: number): Promise<void> {
		this.store.publishHistoryFloor(floor);
	}

	async ops(): Promise<QueuedOp[]> {
		return this.store.historyOps();
	}

	async dropOps(seq: number): Promise<void> {
		this.store.dropHistoryOps(seq);
	}

	async amendPurge(seq: number, messageIds: readonly string[]): Promise<void> {
		this.store.amendHistoryPurge(seq, messageIds);
	}

	async dropReactionsOn(messageIds: readonly string[]): Promise<void> {
		this.store.dropReactionsOn(messageIds);
	}

	async hasRoom(roomId: string): Promise<boolean> {
		return this.store.getRoom(roomId) !== null;
	}

	async hasUser(userId: string): Promise<boolean> {
		return this.store.identityExists(userId);
	}

	async isRetired(userId: string): Promise<boolean> {
		return this.store.isRetiredUserId(userId);
	}

	/** Every room, as `room_list` lists it, private ones included (an export is the server's, not a member's view). */
	async rooms(): Promise<ArchivedRoom[]> {
		return this.store.listRooms(undefined, { maintenance: true, withPrivate: true }).map((room) => {
			const { latest_log_id, history_log_id, ...rest } = room as Record<string, unknown> & { room_id: string };
			// Members come from the membership records the export carries.
			return { listing: { ...rest, room_id: room.room_id, ...(typeof latest_log_id === "string" ? { latest_log_id } : {}), ...(typeof history_log_id === "string" || history_log_id === null ? { history_log_id } : {}) }, joined: false };
		});
	}

	async users(userIds: readonly string[]): Promise<ArchivedUser[]> {
		return userIds.flatMap((id) => {
			const identity = this.store.getIdentity(id);
			if (!identity) return [];
			return [{ user_id: identity.userId, name: identity.name, ...(identity.avatar ? { avatar: identity.avatar } : {}), roles: identity.roles, ...(identity.ext ? { ext: identity.ext } : {}) }];
		});
	}

	async latest(): Promise<number> {
		return this.store.historyFloors().latest;
	}

	async roomIsEmpty(roomId: string): Promise<boolean> {
		return this.store.roomIsEmpty(roomId);
	}

	async journal(): Promise<string | undefined> {
		return this.store.historyImportJournal();
	}

	async setJournal(value: string | null): Promise<void> {
		this.store.setHistoryImportJournal(value);
	}

	async restoreRoom(room: ArchivedRoom, records: readonly ChatRecord[], context?: RestoreContext): Promise<RestoreResult> {
		return this.store.restoreRoom(room, records, undefined, context ? { rooms: context.rooms } : {});
	}

	normalizeRecord(record: ChatRecord): ChatRecord | null {
		return this.store.restorableRecord(record);
	}

	async restoreUsers(users: readonly ArchivedUser[]): Promise<void> {
		this.store.restoreUsers(users);
	}

	/**
	 * The pipeline's tier state, kept in the Store's `_meta` (Store.historyState).
	 * The head's target is kept here, in memory: the running cleanup job
	 * gives it again after a wake (historyTarget), so it need not be stored.
	 */
	stateStore(): TierStateStore {
		return {
			load: async (names) => {
				const states = this.store.historyState(names, this.name);
				const head = states[this.name];
				if (head) head.target = Math.max(head.target, this.target);
				return states;
			},
			save: async (name, update) => {
				if (name === this.name && update.target !== undefined) this.target = Math.max(this.target, update.target);
				this.store.saveHistoryState(name, this.name, update);
			},
		};
	}

	/** The head's target, this instance (stateStore). */
	private target = 0;
}
