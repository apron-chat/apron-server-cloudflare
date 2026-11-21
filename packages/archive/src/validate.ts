/*
 * What makes an archived record valid, and what makes it one a client could
 * have sent: the format-level checks every reader of an archive needs
 * (ARCHIVE.md §3, PROTOCOL §3.3). A server adds its own rules on top (body
 * normalization, size caps, which IDs may hold an account); those stay its
 * own, passed in where they are needed (limits, plan.ts's ImportTarget).
 *
 * Everything here is pure: no I/O, no clock.
 */

import { type ChatRecord, type RecordKind, canonicalJson } from "./records.ts";
import type { CollectedArchive } from "./format.ts";
import type { ArchivedRoom } from "./types.ts";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(text: unknown): JsonObject | null {
	if (typeof text !== "string") return null;
	try {
		const value: unknown = JSON.parse(text);
		return isObject(value) ? value : null;
	} catch {
		return null;
	}
}

const KINDS: readonly string[] = ["room", "message", "reactions", "membership"];

/** A recorded user (a message's `from`, a reaction set's `from`, a member's `user`): an object with a non-empty string `user_id`. */
export function isRecordedUser(value: unknown): value is { user_id: string; name?: unknown } {
	return isObject(value) && typeof value.user_id === "string" && value.user_id.length > 0;
}

/** A protocol ID (PROTOCOL §2.2): a non-empty string without whitespace or control characters. */
export function isProtocolId(value: unknown): value is string {
	return typeof value === "string" && /^[^\s\p{Cc}]+$/u.test(value);
}

/** A record checked by validateRecord, with its parsed wire value. */
export interface ValidRecord extends ChatRecord {
	value: JsonObject;
}

/**
 * Whether a record is one of the format's (ARCHIVE.md §3): a safe positive
 * log ID, one of the four kinds, and a wire value of that kind's shape (a
 * message's `message_id` and `from`, a reaction record's `message_id` and
 * sets, a membership record's members). With `roomId`, it must be that
 * room's. The record with its parsed value, `commit_ms` made a positive
 * integer (its log ID when it has none); or what is wrong with it, as a
 * phrase to follow "Record <log_id> of <room>".
 */
export function validateRecord(record: ChatRecord, roomId?: string): { record: ValidRecord } | { problem: string } {
	if (roomId !== undefined && record?.room_id !== roomId) return { problem: "belongs to another room" };
	if (!Number.isSafeInteger(record?.log_id) || record.log_id <= 0) return { problem: "has no valid log_id" };
	const commitMs = Number.isFinite(record.commit_ms) && record.commit_ms > 0 ? Math.trunc(record.commit_ms) : record.log_id;
	const kind = record.kind as RecordKind;
	if (!KINDS.includes(kind)) return { problem: "is of an unknown kind" };
	const value = parseObject(record.record_json);
	if (!value) return { problem: "is not a JSON object" };
	const valid = kind === "room" ? true
		: kind === "message" ? typeof value.message_id === "string" && value.message_id.length > 0 && isRecordedUser(value.from)
		: kind === "reactions" ? typeof value.message_id === "string" && value.message_id.length > 0 && Array.isArray(value.reactions)
			&& value.reactions.every((set) => isObject(set) && isRecordedUser(set.from) && Array.isArray(set.emojis) && set.emojis.every((emoji) => typeof emoji === "string"))
		: Array.isArray(value.members) && value.members.every((member) => isObject(member) && isRecordedUser(member.user) && typeof member.joined === "boolean");
	if (!valid) return { problem: `is not a valid ${kind} record` };
	return { record: { room_id: record.room_id, log_id: record.log_id, commit_ms: commitMs, kind, record_json: record.record_json, value } };
}

/** A recorded user as a client's record holds one: `user_id`, and `name` if a non-empty string; nothing else (no roles, no tier). */
export function bareUser(value: unknown): unknown {
	if (!isObject(value)) return value;
	return { user_id: value.user_id, ...(typeof value.name === "string" && value.name !== "" ? { name: value.name } : {}) };
}

/** A record with every recorded user (`from`, reaction sets' `from`, members' `user`) made bare (bareUser); the same record when nothing changed. */
export function withBareUsers(record: ChatRecord): ChatRecord {
	const value = JSON.parse(record.record_json) as JsonObject;
	if ("from" in value) value.from = bareUser(value.from);
	if (Array.isArray(value.reactions)) value.reactions = value.reactions.map((set: unknown) => (isObject(set) ? { ...set, from: bareUser(set.from) } : set));
	if (Array.isArray(value.members)) value.members = value.members.map((member: unknown) => (isObject(member) ? { ...member, user: bareUser(member.user) } : member));
	const json = JSON.stringify(value);
	return json === record.record_json ? record : { ...record, record_json: json };
}

/** A server's limits on a recorded user's name (and ID). */
export interface NameLimits {
	maxNameBytes: number;
	maxNameCodePoints: number;
	/** Longest user ID, in UTF-8 bytes (default 256). */
	maxUserIdBytes?: number;
}

const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text).byteLength;

/**
 * A recorded user as a client could have sent it, or null when none could:
 * a protocol ID (never a server notice's, `~…`) within `maxUserIdBytes`,
 * and its `name` only if non-blank and within the limits.
 */
export function clientUser(candidate: unknown, limits: NameLimits): { user_id: string; name?: string } | null {
	if (!isRecordedUser(candidate) || candidate.user_id.startsWith("~") || !isProtocolId(candidate.user_id) || utf8Bytes(candidate.user_id) > (limits.maxUserIdBytes ?? 256)) return null;
	const name = candidate.name;
	const kept = typeof name === "string" && name.trim() !== "" && utf8Bytes(name) <= limits.maxNameBytes && [...name].length <= limits.maxNameCodePoints ? name : undefined;
	return { user_id: candidate.user_id, ...(kept ? { name: kept } : {}) };
}

/**
 * Makes every recorded user of a record's wire `value` a client's
 * (clientUser), in place: a message's `from`, each reaction set's `from`,
 * each member's `user`. False when one cannot be, or a reaction or
 * membership record has no list of them; a room record has none.
 */
export function withClientUsers(value: JsonObject, kind: string, limits: NameLimits): boolean {
	if (kind === "message") {
		const from = clientUser(value.from, limits);
		if (!from) return false;
		value.from = from;
	} else if (kind === "reactions" || kind === "membership") {
		const key = kind === "reactions" ? "reactions" : "members";
		const field = kind === "reactions" ? "from" : "user";
		const list = value[key];
		if (!Array.isArray(list)) return false;
		const out: unknown[] = [];
		for (const entry of list) {
			const user = isObject(entry) ? clientUser(entry[field], limits) : null;
			if (!user) return false;
			out.push({ ...entry, [field]: user });
		}
		value[key] = out;
	}
	return true;
}

/** The client fields of a room record or listing (`title`, a non-blank `description`, a non-empty `ext`), copied. */
export function roomClientFields(value: JsonObject): JsonObject {
	return {
		...(typeof value.title === "string" ? { title: value.title } : {}),
		...(typeof value.description === "string" && value.description.trim() !== "" ? { description: value.description } : {}),
		...(isObject(value.ext) && Object.keys(value.ext).length ? { ext: JSON.parse(JSON.stringify(value.ext)) as JsonObject } : {}),
	};
}

/** A record's content, for telling duplicates: everything but where it is (room, previous room) and its log ID's spelling. */
export function contentKey(record: ChatRecord): string {
	const { room_id: _room, prev_room_id: _prev, log_id: _log, ...rest } = JSON.parse(record.record_json) as JsonObject;
	return `${record.kind}\u0000${canonicalJson(rest)}`;
}

/** An archive's identity: its header and the extent of its records (what an import's journal is checked against). */
export function archiveIdentity(archive: Pick<CollectedArchive, "header" | "records">): string {
	const records = archive.records;
	return canonicalJson({ header: archive.header, records: records.length, first: records[0]?.log_id ?? null, last: records[records.length - 1]?.log_id ?? null });
}

/**
 * An archive's content and its references (ARCHIVE.md §3.1): the rooms it
 * lists (a later listing replaces an earlier one), and their records from
 * each room's `history_log_id` on (none where it is null, all where it is
 * absent). A record of a room the file does not list, or below its room's
 * `history_log_id`, is a reference, there for a `reply_to`.
 */
export function splitReferences(archive: Pick<CollectedArchive, "rooms" | "records">): { rooms: Map<string, ArchivedRoom>; content: ChatRecord[]; references: ChatRecord[] } {
	const rooms = new Map<string, ArchivedRoom>();
	for (const room of archive.rooms) rooms.set(room.listing.room_id, room);
	const content: ChatRecord[] = [];
	const references: ChatRecord[] = [];
	// A record repeated (a move a writer took from both rooms' histories, each
	// naming the room it went to) is read once: the last one stands.
	const once = new Map<string, ChatRecord>();
	for (const record of archive.records) once.set(`${record.room_id}\u0000${record.log_id}`, record);
	for (const record of once.values()) {
		const room = rooms.get(record.room_id);
		const listed = room?.listing.history_log_id;
		const start = listed === null ? Number.POSITIVE_INFINITY : listed === undefined ? undefined : Number(listed);
		(room && (start === undefined || record.log_id >= start) ? content : references).push(record);
	}
	return { rooms, content, references };
}
