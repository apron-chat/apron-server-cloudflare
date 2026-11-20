/*
 * History tiers in memory: a rewritable tier and a head, for tests and the
 * reference model's runs (PLAN §12.3); never in the Worker. They keep records
 * as the SQLite and D1 tiers do, one per room and log ID, and rewrite them
 * with the same functions (records.ts).
 */

import type { ArchivedRoom, ArchivedUser } from "@apron/archive";
import { retentionFloor } from "../../../src/history/plan";
import { type ChatRecord, type Clock, type HistoryOp, type HistoryQuery, type QueuedOp, type RecordRange, type Retention, type TierStats, authoredMessages, byLog, limitByLogId, logIds, purgedRecord, renamedRecord, toRange } from "../../../src/history/records";
import type { FloorContext, HistoryHead, PurgeResult, RewritableTier, TierState, TierStateStore } from "../../../src/history/tier";

const key = (record: Pick<ChatRecord, "room_id" | "log_id">) => `${record.log_id}\u0000${record.room_id}`;

export class MemoryHistoryTier implements RewritableTier {
	readonly records = new Map<string, ChatRecord>();
	multiRoom = true;

	constructor(readonly name: string) {}

	/** Every record, in log order. */
	all(): ChatRecord[] {
		return [...this.records.values()].sort(byLog);
	}

	async append(range: RecordRange): Promise<void> {
		for (const record of range.records) this.records.set(key(record), { ...record });
	}

	async scan(from: number, limit: number): Promise<RecordRange> {
		return toRange(limitByLogId(this.all().filter((record) => record.log_id >= from), limit, true));
	}

	async read(query: HistoryQuery): Promise<ChatRecord[]> {
		const rooms = new Set(query.roomIds);
		return limitByLogId(this.all().filter((record) => rooms.has(record.room_id) && record.log_id >= query.lower && record.log_id <= query.upper), query.limit, query.forward);
	}

	async lookup(ids: readonly number[]): Promise<ChatRecord[]> {
		const wanted = new Set(ids);
		return this.all().filter((record) => wanted.has(record.log_id));
	}

	async stats(context: { lower?: number; upper?: number } = {}): Promise<TierStats> {
		const ids = logIds(this.all()).filter((id) => id >= (context.lower ?? 0) && id <= (context.upper ?? Number.MAX_SAFE_INTEGER));
		return { records: ids.length, ...(ids.length ? { oldest: ids[0], newest: ids[ids.length - 1] } : {}) };
	}

	async floorFor(retention: Retention, context: FloorContext): Promise<number | undefined> {
		const entries = new Map<number, { log_id: number; commit_ms: number }>();
		for (const record of this.all()) if (!entries.has(record.log_id)) entries.set(record.log_id, { log_id: record.log_id, commit_ms: record.commit_ms });
		return retentionFloor([...entries.values()], retention, context);
	}

	async trimBelow(floor: number, max: number): Promise<number> {
		let removed = 0;
		for (const record of this.all()) {
			if (record.log_id >= floor || removed >= max) break;
			this.records.delete(key(record));
			removed += 1;
		}
		return removed;
	}

	async purge(userIds: readonly string[], messageIds: readonly string[] = []): Promise<PurgeResult> {
		const authored = authoredMessages(this.all(), userIds);
		const messages = [...new Set([...messageIds, ...authored])];
		for (const record of this.all()) {
			const json = purgedRecord(record, userIds, messages);
			if (json === null) this.records.delete(key(record));
			else if (json !== record.record_json) this.records.set(key(record), { ...record, record_json: json });
		}
		return { messageIds: authored };
	}

	async rename(from: string, to: string): Promise<void> {
		for (const record of this.all()) {
			const json = renamedRecord(record, from, to);
			if (json !== record.record_json) this.records.set(key(record), { ...record, record_json: json });
		}
	}
}

/**
 * A head in memory: the records, the op log, the published floor, rooms and
 * users. Commits come through `commit` (tests make the log); its retention
 * is its tier's (floorFor), as the pipeline asks.
 */
export class MemoryHead extends MemoryHistoryTier implements HistoryHead {
	published = 1;
	queued: QueuedOp[] = [];
	private seq = 0;
	readonly rooms_ = new Map<string, ArchivedRoom>();
	readonly people = new Map<string, ArchivedUser>();
	readonly retired = new Set<string>();
	private last = 0;
	/** Import: what a client could have sent of a record (HistoryHead.normalizeRecord); unset, every record is taken as it is. */
	normalizeRecord?: (record: ChatRecord) => ChatRecord | null;

	constructor(name: string, private readonly clock: Clock) {
		super(name);
	}

	/** Commits a record at the next log ID (the clock's time, or one past the last); returns it. */
	commit(roomId: string, kind: ChatRecord["kind"], value: Record<string, unknown>, options: { alsoIn?: string } = {}): ChatRecord {
		const logId = Math.max(this.clock.now(), this.last + 1);
		this.last = logId;
		const rooms = [roomId, ...(options.alsoIn ? [options.alsoIn] : [])];
		let made!: ChatRecord;
		for (const room of rooms) {
			const record: ChatRecord = { room_id: room, log_id: logId, commit_ms: logId, kind, record_json: JSON.stringify({ ...value, room_id: roomId, log_id: String(logId) }) };
			this.records.set(`${logId}\u0000${room}`, record);
			if (room === roomId) made = record;
		}
		if (!this.rooms_.has(roomId)) this.rooms_.set(roomId, { listing: { room_id: roomId }, joined: false });
		return made;
	}

	/** The newest log ID committed here. */
	head(): number {
		return this.last;
	}

	async publishedFloor(): Promise<number> {
		return this.published;
	}

	async publish(floor: number): Promise<void> {
		if (floor > this.published) this.published = floor;
	}

	async ops(): Promise<QueuedOp[]> {
		return this.queued.map((entry) => ({ ...entry }));
	}

	async dropOps(seq: number): Promise<void> {
		this.queued = this.queued.filter((entry) => entry.seq > seq);
	}

	async amendPurge(seq: number, messageIds: readonly string[]): Promise<void> {
		this.queued = this.queued.map((entry) => entry.seq === seq && entry.op.op === "purge" ? { seq, op: { ...entry.op, messageIds: [...new Set([...entry.op.messageIds, ...messageIds])] } } : entry);
	}

	async queueOp(op: HistoryOp): Promise<void> {
		this.seq += 1;
		this.queued.push({ seq: this.seq, op });
	}

	override async purge(userIds: readonly string[], messageIds: readonly string[] = []): Promise<PurgeResult> {
		const result = await super.purge(userIds, messageIds);
		for (const id of userIds) {
			this.people.delete(id);
			this.retired.add(id);
		}
		await this.queueOp({ op: "purge", userIds: [...userIds], messageIds: [...new Set([...messageIds, ...result.messageIds])] });
		return result;
	}

	override async rename(from: string, to: string): Promise<void> {
		await super.rename(from, to);
		const user = this.people.get(from);
		if (user) {
			this.people.delete(from);
			this.people.set(to, { ...user, user_id: to });
		}
		this.retired.add(from);
		await this.queueOp({ op: "rename", from, to });
	}

	async dropReactionsOn(messageIds: readonly string[]): Promise<void> {
		for (const record of this.all()) {
			if (record.kind !== "reactions") continue;
			const id = (JSON.parse(record.record_json) as { message_id?: string }).message_id;
			if (id && messageIds.includes(id)) this.records.delete(key(record));
		}
	}

	async hasRoom(roomId: string): Promise<boolean> {
		return this.rooms_.has(roomId);
	}

	async hasUser(userId: string): Promise<boolean> {
		return this.people.has(userId);
	}

	async isRetired(userId: string): Promise<boolean> {
		return this.retired.has(userId);
	}

	async restoreRoom(room: ArchivedRoom, records: readonly ChatRecord[]): Promise<void> {
		this.rooms_.set(room.listing.room_id, room);
		await this.append(toRange(records));
		for (const record of records) this.last = Math.max(this.last, record.log_id);
	}

	async rooms(): Promise<ArchivedRoom[]> {
		return [...this.rooms_.values()];
	}

	async users(userIds: readonly string[]): Promise<ArchivedUser[]> {
		return userIds.flatMap((id) => this.people.get(id) ?? []);
	}

	async latest(): Promise<number> {
		return this.last;
	}

	journalText: string | undefined;

	async journal(): Promise<string | undefined> {
		return this.journalText;
	}

	async setJournal(value: string | null): Promise<void> {
		this.journalText = value ?? undefined;
	}

	async roomIsEmpty(roomId: string): Promise<boolean> {
		return this.rooms_.has(roomId) && !this.all().some((record) => record.room_id === roomId);
	}

	async restoreUsers(users: readonly ArchivedUser[]): Promise<void> {
		for (const user of users) if (!this.people.has(user.user_id)) this.people.set(user.user_id, { ...user, roles: ["unclaimed"] });
	}
}

/** A TierStateStore in memory. */
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
