/*
 * The head over the Durable Object's Store (PLAN §5, store-head.ts): an
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

import type { ArchivedRoom, ArchivedUser } from "./archive/types";
import { type ChatRecord, type HistoryOp, type HistoryQuery, type QueuedOp, type RecordRange, type TierStats, toRange } from "./records";
import type { HistoryHead, PurgeResult, TierState, TierStateStore } from "./tier";

/** What the adapter needs of the Store (src/store.ts), so this module does not load it. */
export interface StorePort {
	historyFloors(): { hot: number; published: number };
	historyTarget(): number | undefined;
	historyScan(from: number, limit?: number): ChatRecord[];
	historyRecords(query: HistoryQuery): ChatRecord[];
	historyLookup(logIds: readonly number[]): ChatRecord[];
	historyState(names: readonly string[], head: string): Record<string, TierState>;
	saveHistoryState(name: string, head: string, update: Partial<TierState>): void;
	publishHistoryFloor(floor: number): void;
	historyOps(): QueuedOp[];
	dropHistoryOps(seq: number): void;
	dropReactionsOn(messageIds: readonly string[]): void;
	hotRecords(): number;
	purgeUsers(input: { userIds: readonly string[] }): unknown;
	renameIdentity(input: { from: string; to: string }): unknown;
	getRoom(roomId: string): unknown;
	identityExists(userId: string): boolean;
	restoreRoom?(room: ArchivedRoom, records: readonly ChatRecord[]): void;
	restoreUsers?(users: readonly ArchivedUser[]): void;
	isRetiredUserId?(userId: string): boolean;
	importRecords?(records: readonly ChatRecord[]): void;
}

export class StoreHead implements HistoryHead {
	readonly multiRoom = true;

	constructor(readonly name: string, private readonly store: StorePort) {}

	async append(range: RecordRange): Promise<void> {
		if (!range.records.length) return;
		if (!this.store.importRecords) throw new Error("this head takes records only by commit");
		this.store.importRecords(range.records);
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

	async purge(userIds: readonly string[]): Promise<PurgeResult> {
		this.store.purgeUsers({ userIds });
		return { messageIds: [] };
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

	/** The Store queues its own ops, in /purge's and /rename's transactions. */
	async queueOp(_op: HistoryOp): Promise<void> {
		throw new Error("the Store queues its own history ops");
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
		return this.store.isRetiredUserId?.(userId) ?? false;
	}

	async restoreRoom(room: ArchivedRoom, records: readonly ChatRecord[]): Promise<void> {
		if (!this.store.restoreRoom) throw new Error("this head cannot restore rooms");
		this.store.restoreRoom(room, records);
	}

	async restoreUsers(users: readonly ArchivedUser[]): Promise<void> {
		if (!this.store.restoreUsers) throw new Error("this head cannot restore users");
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
