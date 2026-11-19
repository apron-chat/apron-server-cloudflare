/*
 * Records: one entry of an Apron server's log (PROTOCOL §2.1) in its wire
 * shape, as `history` serves it and an ARCHIVE.md v1 file holds it: a room
 * record, message snapshot, reaction record or membership record, with the
 * room it is logged in and its log ID. A move is logged once per room it
 * belongs to: two records, one log ID.
 *
 * Everything here is pure: no I/O, no clock.
 */

export type RecordKind = "room" | "message" | "reactions" | "membership";

/** One stored record, the same shape wherever it is kept. */
export interface ChatRecord {
	room_id: string;
	/** Server-wide, increasing: the commit time in ms (PROTOCOL §2.1). */
	log_id: number;
	commit_ms: number;
	kind: RecordKind | string;
	/** The wire shape, as `history` serves it. */
	record_json: string;
}

/** Orders records by log ID, then room. */
export function byLog(a: ChatRecord, b: ChatRecord): number {
	return a.log_id - b.log_id || (a.room_id < b.room_id ? -1 : a.room_id > b.room_id ? 1 : 0);
}

/** The distinct log IDs of `records`, in order of first appearance. */
export function logIds(records: readonly ChatRecord[]): number[] {
	return [...new Set(records.map((record) => record.log_id))];
}

type RecordValue = Record<string, unknown>;
interface Identity { user_id: string; [key: string]: unknown }

/** The user IDs a record names: its sender, reaction sets' senders, members. */
export function namedUsers(record: ChatRecord): string[] {
	const value = JSON.parse(record.record_json) as {
		from?: { user_id?: string };
		reactions?: Array<{ from?: { user_id?: string } }>;
		members?: Array<{ user?: { user_id?: string } }>;
	};
	const ids = [
		value.from?.user_id,
		...(value.reactions ?? []).map((set) => set.from?.user_id),
		...(value.members ?? []).map((member) => member.user?.user_id),
	];
	return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** A reactions or membership record without the purged users' entries (null if none is left), as a server's `/purge` rewrites it. */
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

/** A record naming `to` wherever it named `from`, as a server's `/rename` rewrites it. */
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

/** Canonical JSON: keys sorted at every level, for comparing contents. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as RecordValue).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
