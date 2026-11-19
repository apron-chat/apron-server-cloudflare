/*
 * Records: the unit every history tier stores and hands on (PLAN §3, §5).
 *
 * A record is one entry of the server-wide log (a room record, message
 * snapshot, reaction record or membership record) in its wire shape, as
 * `history` serves it, with the room it is logged in and its log ID. A move
 * is logged once per room it belongs to: two records, one log ID.
 *
 * Everything here is pure: no I/O, no clock.
 */

export type RecordKind = "room" | "message" | "reactions" | "membership";

/** One stored record, the same shape in every tier. */
export interface ChatRecord {
	room_id: string;
	/** Server-wide, increasing: the commit time in ms (PROTOCOL §2.1). */
	log_id: number;
	commit_ms: number;
	kind: RecordKind | string;
	/** The wire shape, as `history` serves it. */
	record_json: string;
}

/** A contiguous range of the log: the unit tiers hand on. Records sorted by (log_id, room_id). */
export interface RecordRange {
	first: number;
	last: number;
	records: ChatRecord[];
}

/** What a history page asks of a tier. `limit` counts distinct log IDs (a move's rows take one place). */
export interface HistoryQuery {
	roomIds: string[];
	/** Inclusive. */
	lower: number;
	/** Inclusive. */
	upper: number;
	forward: boolean;
	limit: number;
	/** A joined-rooms page (PROTOCOL §4.3.3): only tiers that serve several rooms at once take part. */
	joined?: boolean;
}

/**
 * A tier's ceiling: retention keeps `thresholdPercent` of whichever limits
 * are set (the strictest wins). `minAgeMs` holds records younger than it
 * whatever the count says.
 */
export interface Retention {
	records?: number;
	bytes?: number;
	ageMs?: number;
	minAgeMs?: number;
	thresholdPercent: number;
}

export interface TierStats {
	records: number;
	bytes?: number;
	oldest?: number;
	newest?: number;
}

/** A clock, injected: nothing under src/history/ reads Date.now(). */
export interface Clock {
	now(): number;
}

/** What `/purge` or `/rename` did to the head, for the tiers below to do too (PLAN §8). */
export type HistoryOp =
	| { op: "purge"; userIds: string[]; messageIds: string[] }
	| { op: "rename"; from: string; to: string };

/** A HistoryOp in the head's op log, numbered in order. */
export interface QueuedOp {
	seq: number;
	op: HistoryOp;
}

/** The records a count keeps under a threshold: `percent` of `limit`, at least one; 0 without a limit. */
export function thresholdCount(limit: number | undefined, percent: number): number {
	return limit && limit > 0 ? Math.max(1, Math.floor((limit * percent) / 100)) : 0;
}

/** Orders records by log ID, then room. */
export function byLog(a: ChatRecord, b: ChatRecord): number {
	return a.log_id - b.log_id || (a.room_id < b.room_id ? -1 : a.room_id > b.room_id ? 1 : 0);
}

/** The distinct log IDs of `records`, in order of first appearance. */
export function logIds(records: readonly ChatRecord[]): number[] {
	return [...new Set(records.map((record) => record.log_id))];
}

/**
 * The records of the first `limit` distinct log IDs, nearest the page's
 * start first: oldest first `forward`, else newest. Every room's copy of a
 * kept log ID stays.
 */
export function limitByLogId(records: readonly ChatRecord[], limit: number, forward: boolean): ChatRecord[] {
	const sorted = [...records].sort((a, b) => (forward ? 1 : -1) * byLog(a, b));
	const kept = new Set<number>();
	const out: ChatRecord[] = [];
	for (const record of sorted) {
		if (!kept.has(record.log_id)) {
			if (kept.size >= limit) break;
			kept.add(record.log_id);
		}
		out.push(record);
	}
	return out;
}

/** A range over `records`, sorted; empty ranges have first > last. */
export function toRange(records: readonly ChatRecord[]): RecordRange {
	const sorted = [...records].sort(byLog);
	return sorted.length
		? { first: sorted[0].log_id, last: sorted[sorted.length - 1].log_id, records: sorted }
		: { first: 1, last: 0, records: [] };
}

type RecordValue = Record<string, unknown>;
interface Identity { user_id: string; [key: string]: unknown }

/** A reactions or membership record without the purged users' entries (null if none is left), as Store.purgeUsers rewrites it. */
export function purgedValue(kind: string, record: RecordValue, userIds: readonly string[], messageIds: readonly string[]): RecordValue | null {
	if (kind === "reactions") {
		const sets = (record.reactions as Array<{ from: Identity }>) ?? [];
		const kept = messageIds.includes(record.message_id as string) ? [] : sets.filter((set) => !userIds.includes(set.from.user_id));
		return kept.length ? { ...record, reactions: kept } : null;
	}
	if (kind === "membership") {
		const members = ((record.members as Array<{ user: Identity }>) ?? []).filter((member) => !userIds.includes(member.user.user_id));
		return members.length ? { ...record, members } : null;
	}
	if (kind === "message") return userIds.includes((record.from as Identity | undefined)?.user_id ?? "") ? null : record;
	return record;
}

/** A record naming `to` wherever it named `from`, as Store.renameIdentity rewrites it. */
export function renamedValue(kind: string, record: RecordValue, from: string, to: string): RecordValue {
	const renamed = (user: Identity): Identity => user.user_id === from ? { ...user, user_id: to } : user;
	if (kind === "message") return record.from ? { ...record, from: renamed(record.from as Identity) } : record;
	if (kind === "reactions") return { ...record, reactions: ((record.reactions as Array<{ from: Identity }>) ?? []).map((set) => ({ ...set, from: renamed(set.from) })) };
	if (kind === "membership") return { ...record, members: ((record.members as Array<{ user: Identity }>) ?? []).map((member) => ({ ...member, user: renamed(member.user) })) };
	return record;
}

/** purgedValue of a stored record, as JSON; null if the record goes. */
export function purgedRecord(row: Pick<ChatRecord, "kind" | "record_json">, userIds: readonly string[], messageIds: readonly string[]): string | null {
	const value = purgedValue(row.kind, JSON.parse(row.record_json) as RecordValue, userIds, messageIds);
	return value ? JSON.stringify(value) : null;
}

/** renamedValue of a stored record, as JSON. */
export function renamedRecord(row: Pick<ChatRecord, "kind" | "record_json">, from: string, to: string): string {
	return JSON.stringify(renamedValue(row.kind, JSON.parse(row.record_json) as RecordValue, from, to));
}

/** The message IDs of the message snapshots among `records` sent by `userIds`. */
export function authoredMessages(records: readonly ChatRecord[], userIds: readonly string[]): string[] {
	const ids = new Set<string>();
	for (const record of records) {
		if (record.kind !== "message") continue;
		const value = JSON.parse(record.record_json) as { message_id?: string; from?: Identity };
		if (value.message_id && value.from && userIds.includes(value.from.user_id)) ids.add(value.message_id);
	}
	return [...ids];
}

/**
 * Records with `/purge` and `/rename` applied in order, as a rewritable tier
 * applies them to what it holds: a purged user's message snapshots go, with
 * every reaction set on those messages (the op's own, and those found among
 * `records`), and their reaction sets and memberships; a record left empty
 * goes. Used on pages read from a tier that has yet to apply them (PLAN §8).
 */
export function applyOps(records: readonly ChatRecord[], ops: readonly HistoryOp[]): ChatRecord[] {
	let out = [...records];
	for (const op of ops) {
		if (op.op === "purge") {
			const messages = [...new Set([...op.messageIds, ...authoredMessages(out, op.userIds)])];
			out = out.flatMap((record) => {
				const json = purgedRecord(record, op.userIds, messages);
				return json === null ? [] : [json === record.record_json ? record : { ...record, record_json: json }];
			});
		} else {
			out = out.map((record) => {
				const json = renamedRecord(record, op.from, op.to);
				return json === record.record_json ? record : { ...record, record_json: json };
			});
		}
	}
	return out;
}

/** Canonical JSON: keys sorted at every level, for comparing contents (PLAN §10.3). */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as RecordValue).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
