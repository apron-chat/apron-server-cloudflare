/*
 * History tiers in memory: a tier below the head and a head, for tests and the
 * reference model's runs; never in the Worker. They keep records
 * as the SQLite and D1 tiers do, one per room and log ID, and take rewrites
 * as they do, with the same functions (records.ts).
 */

import type { ArchivedRoom, ArchivedUser } from "@apron/archive";
import { type ChatRecord, type Clock, type HistoryQuery, type QueuedRewrite, type RecordRange, type Retention, type Rewrite, type TierStats, authoredMessages, thresholdCount, byLog, limitByLogId, logIds, purgedRecord, renamedRecord, toRange } from "../../../src/history/records";
import { NOT_STALLED } from "../../../src/history/stall";
import type { Cell, ChainState, ChainStateStore, ExportPort, FloorContext, HistoryHead, HistoryTier, LinkState, RestorePort, RestoreResult, RewriteLog, TierFloor } from "../../../src/history/tier";

/**
 * The floor a retention allows over a tier's log entries, oldest first
 * (one per log ID), counting only those below `below` (records past it are
 * copies held above). The count keeps its threshold's share newest first;
 * the age drops what is older than `ageMs`; `minAgeMs` holds back whatever
 * is younger. Undefined while nothing need leave. The tiers the Worker
 * runs find theirs in their own storage (SQL, the chunk index).
 */
function retentionFloor(entries: ReadonlyArray<{ log_id: number; commit_ms: number }>, retention: Retention, context: { now: number; below: number }): number | undefined {
	const own = entries.filter((entry) => entry.log_id < context.below);
	let floor: number | undefined;
	const keep = thresholdCount(retention.records, retention.thresholdPercent);
	if (keep > 0 && own.length > keep) floor = own[own.length - keep].log_id;
	if (retention.ageMs && retention.ageMs > 0) {
		const cutoff = context.now - retention.ageMs;
		const fresh = own.find((entry) => entry.commit_ms >= cutoff);
		const ageFloor = fresh ? fresh.log_id : own.length ? own[own.length - 1].log_id + 1 : undefined;
		if (ageFloor !== undefined && (floor === undefined || ageFloor > floor)) floor = ageFloor;
	}
	if (floor !== undefined && retention.minAgeMs && retention.minAgeMs > 0) {
		const young = own.find((entry) => entry.commit_ms >= context.now - retention.minAgeMs!);
		if (young && young.log_id < floor) floor = young.log_id;
	}
	if (floor === undefined || !own.length || floor <= own[0].log_id) return undefined;
	return floor;
}

const key = (record: Pick<ChatRecord, "room_id" | "log_id">) => `${record.log_id}\u0000${record.room_id}`;

export class MemoryHistoryTier implements HistoryTier {
	readonly records = new Map<string, ChatRecord>();

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

	/** /purge and /rename in one step; a purge tells the messages of its user found here first. */
	async rewrite(rewrite: Rewrite, found: (messageIds: readonly string[]) => Promise<void>): Promise<void> {
		if (rewrite.into === null) {
			await found(authoredMessages(this.all(), [rewrite.user]));
			this.purgeHere([rewrite.user], rewrite.messages ?? []);
		} else this.renameHere(rewrite.user, rewrite.into);
	}

	/** Purges the records here: returns the messages of the users found here. */
	protected purgeHere(userIds: readonly string[], messageIds: readonly string[]): string[] {
		const authored = authoredMessages(this.all(), userIds);
		const messages = [...new Set([...messageIds, ...authored])];
		for (const record of this.all()) {
			const json = purgedRecord(record, userIds, messages);
			if (json === null) this.records.delete(key(record));
			else if (json !== record.record_json) this.records.set(key(record), { ...record, record_json: json });
		}
		return authored;
	}

	protected renameHere(from: string, to: string): void {
		for (const record of this.all()) {
			const json = renamedRecord(record, from, to);
			if (json !== record.record_json) this.records.set(key(record), { ...record, record_json: json });
		}
	}
}

/**
 * A head in memory: the records, the rewrite log, the published floor, rooms and
 * users; also what imports and exports need of a server (RestorePort,
 * ExportPort). Commits come through `commit` (tests make the log); its
 * retention is its tier's (floorFor), as the chain asks.
 */
export class MemoryHead extends MemoryHistoryTier implements HistoryHead, RestorePort, ExportPort {
	published = 1;
	queued: QueuedRewrite[] = [];
	private seq = 0;
	readonly rooms_ = new Map<string, ArchivedRoom>();
	readonly people = new Map<string, ArchivedUser>();
	readonly retired = new Set<string>();
	private last = 0;
	/** Import: what a client could have sent of a record (RestorePort.normalize); unset, every record is taken as it is. */
	normalizer?: (record: ChatRecord) => ChatRecord | null;

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

	readonly rewrites: RewriteLog = {
		list: async () => this.queued.map((entry) => ({ ...entry })),
		logged: async () => this.seq,
		drop: async (seq) => {
			this.queued = this.queued.filter((entry) => entry.seq > seq);
		},
		amend: async (seq, messageIds) => {
			this.queued = this.queued.map((entry) => entry.seq === seq && entry.rewrite.into === null ? { seq, rewrite: { ...entry.rewrite, messages: [...new Set([...(entry.rewrite.messages ?? []), ...messageIds])] } } : entry);
		},
	};

	normalize(record: ChatRecord): ChatRecord | null {
		return this.normalizer ? this.normalizer(record) : record;
	}

	private queue(rewrite: Rewrite): void {
		this.seq += 1;
		this.queued.push({ seq: this.seq, rewrite });
	}

	async purge(userIds: readonly string[]): Promise<void> {
		const authored = this.purgeHere(userIds, []);
		for (const id of userIds) {
			this.people.delete(id);
			this.retired.add(id);
		}
		for (const user of userIds) this.queue({ user, into: null, messages: authored });
	}

	async rename(from: string, to: string): Promise<void> {
		this.renameHere(from, to);
		const user = this.people.get(from);
		if (user) {
			this.people.delete(from);
			this.people.set(to, { ...user, user_id: to });
		}
		this.retired.add(from);
		this.queue({ user: from, into: to });
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

	async restoreRoom(room: ArchivedRoom, records: readonly ChatRecord[]): Promise<RestoreResult> {
		this.rooms_.set(room.listing.room_id, room);
		await this.append(toRange(records));
		for (const record of records) this.last = Math.max(this.last, record.log_id);
		return {};
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

	readonly journal: Cell<string> = {
		get: async () => this.journalText,
		set: async (value) => {
			this.journalText = value ?? undefined;
		},
	};

	async roomIsEmpty(roomId: string): Promise<boolean> {
		return this.rooms_.has(roomId) && !this.all().some((record) => record.room_id === roomId);
	}

	async restoreUsers(users: readonly ArchivedUser[]): Promise<void> {
		for (const user of users) if (!this.people.has(user.user_id)) this.people.set(user.user_id, { ...user, roles: ["unclaimed"] });
	}
}

/** A ChainStateStore in memory: each tier's and link's state by name, fresh as an empty chain's. */
export class MemoryChainStateStore implements ChainStateStore {
	private readonly tiers = new Map<string, TierFloor>();
	private readonly links = new Map<string, LinkState>();
	private tier(name: string): TierFloor {
		return { ...(this.tiers.get(name) ?? { floor: 1, target: 1 }) };
	}
	private link(from: string): LinkState {
		return { ...(this.links.get(from) ?? { through: 0, delivered: 0, stall: NOT_STALLED }) };
	}
	async load(names: readonly string[]): Promise<ChainState> {
		return { tiers: names.map((name) => this.tier(name)), links: names.slice(0, -1).map((name) => this.link(name)) };
	}
	async loadLink(from: string): Promise<LinkState> {
		return this.link(from);
	}
	async has(name: string): Promise<boolean> {
		return this.tiers.has(name);
	}
	async saveTier(name: string, update: Partial<TierFloor>): Promise<void> {
		this.tiers.set(name, { ...this.tier(name), ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)) });
	}
	async saveLink(from: string, update: Partial<LinkState>): Promise<void> {
		this.links.set(from, { ...this.link(from), ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)) });
	}
}
