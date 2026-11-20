/*
 * ID remapping on import (PLAN §10.3, §10.4, §10.6).
 *
 * An import keeps each record's log ID unless it collides with one this
 * server holds; a colliding record moves to the next free millisecond, and
 * an archive user may be given another user ID here. `IdMap` holds both
 * mappings, and `remapRecord` applies them to every place an ID occurs, from
 * one table of fields. This server mints message IDs, thread room IDs and
 * public room IDs from the creating record's log ID, and private room IDs
 * as `private_<log id>`, so those follow the log ID map too. Any ID that is
 * not a decimal log ID (such as `general`, or a foreign server's message
 * IDs) is left alone.
 *
 * Everything here is pure: no I/O, no clock.
 */

import type { ChatRecord } from "./records.ts";
import type { ArchivedUser, RoomListing } from "./types.ts";

/** As Store.PRIVATE_ROOM_PREFIX; kept here so this module stays free of the store. */
const PRIVATE_ROOM_PREFIX = "private_";

/** A decimal log ID as the wire writes it: digits, no sign, no leading zeros. */
const DECIMAL_ID = /^(0|[1-9][0-9]*)$/;

/** The old-to-new mapping of log IDs and user IDs that an import applies (PLAN §10.6). IDs absent from a map stay as they are. */
export class IdMap {
	readonly logIds: Map<number, number>;
	readonly users: Map<string, string>;

	constructor(logIds: Map<number, number> = new Map(), users: Map<string, string> = new Map()) {
		this.logIds = logIds;
		this.users = users;
	}

	/** The new log ID of `id`. */
	logId(id: number): number {
		return this.logIds.get(id) ?? id;
	}

	/** The new log ID of a decimal log ID string; anything else is returned as it is. */
	logIdString(id: string): string {
		if (!DECIMAL_ID.test(id)) return id;
		const value = Number(id);
		if (!Number.isSafeInteger(value)) return id;
		const mapped = this.logIds.get(value);
		return mapped === undefined ? id : String(mapped);
	}

	/** The new user ID of `id`. */
	userId(id: string): string {
		return this.users.get(id) ?? id;
	}

	/**
	 * The new ID of a room: a room whose ID is a log ID (a thread, or a room
	 * created here) and a private room (`private_<log id>`) follow the log ID
	 * map. Other room IDs, such as `general`, stay.
	 */
	roomId(id: string): string {
		if (id.startsWith(PRIVATE_ROOM_PREFIX)) {
			const rest = id.slice(PRIVATE_ROOM_PREFIX.length);
			const mapped = this.logIdString(rest);
			return mapped === rest ? id : PRIVATE_ROOM_PREFIX + mapped;
		}
		return this.logIdString(id);
	}
}

/** How a field's value is mapped: a log ID (a decimal string, or a number), a room ID, or a user ID. */
type FieldKind = "log" | "room" | "user";

/** A field of a wire object, as a path of keys; `*` stands for every element of an array. */
interface Field {
	path: readonly string[];
	kind: FieldKind;
}

/**
 * Every place an ID occurs in a record's wire shape (PLAN §10.6), whatever
 * its kind: a field a kind does not have is skipped. Room records log no
 * delivery fields, but a record holding them maps them too.
 */
export const RECORD_FIELDS: readonly Field[] = [
	{ path: ["log_id"], kind: "log" },
	{ path: ["message_id"], kind: "log" },
	{ path: ["prev_log_id"], kind: "log" },
	{ path: ["reply_to", "message_id"], kind: "log" },
	{ path: ["latest_log_id"], kind: "log" },
	{ path: ["history_log_id"], kind: "log" },
	{ path: ["room_id"], kind: "room" },
	{ path: ["parent_room_id"], kind: "room" },
	{ path: ["prev_room_id"], kind: "room" },
	{ path: ["from", "user_id"], kind: "user" },
	{ path: ["reactions", "*", "from", "user_id"], kind: "user" },
	{ path: ["members", "*", "user", "user_id"], kind: "user" },
	{ path: ["body", "mentions", "*"], kind: "user" },
	{ path: ["ext", "editors", "edited_by"], kind: "user" },
];

/** Every place an ID occurs in a room listing, as `room_list` gives it. */
export const LISTING_FIELDS: readonly Field[] = [
	{ path: ["room_id"], kind: "room" },
	{ path: ["log_id"], kind: "log" },
	{ path: ["parent_room_id"], kind: "room" },
	{ path: ["latest_log_id"], kind: "log" },
	{ path: ["history_log_id"], kind: "log" },
	{ path: ["members", "*", "user_id"], kind: "user" },
];

/** Every place an ID occurs in an archived user. */
export const USER_FIELDS: readonly Field[] = [
	{ path: ["user_id"], kind: "user" },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One value mapped as `kind` says; a value of another type (null, say) stays. */
function mapValue(value: unknown, kind: FieldKind, map: IdMap): unknown {
	if (kind === "log") {
		if (typeof value === "string") return map.logIdString(value);
		if (typeof value === "number") return map.logId(value);
		return value;
	}
	if (typeof value !== "string") return value;
	return kind === "room" ? map.roomId(value) : map.userId(value);
}

/** `value` with `fn` applied at `path` from `index`; the same object where nothing changed. */
function mapPath(value: unknown, path: readonly string[], index: number, fn: (value: unknown) => unknown): unknown {
	const key = path[index];
	if (key === undefined) return fn(value);
	if (key === "*") {
		if (!Array.isArray(value)) return value;
		let changed = false;
		const out = value.map((item) => {
			const next = mapPath(item, path, index + 1, fn);
			if (next !== item) changed = true;
			return next;
		});
		return changed ? out : value;
	}
	if (!isPlainObject(value) || !Object.hasOwn(value, key)) return value;
	const item = value[key];
	const next = mapPath(item, path, index + 1, fn);
	return next === item ? value : { ...value, [key]: next };
}

/** `value` with every field of `fields` mapped; the same object where nothing changed. */
function mapFields<T>(value: T, fields: readonly Field[], map: IdMap): T {
	let out: unknown = value;
	for (const field of fields) out = mapPath(out, field.path, 0, (item) => mapValue(item, field.kind, map));
	return out as T;
}

/**
 * A record with every ID it holds remapped: its `room_id` and `log_id`
 * columns, and every field of RECORD_FIELDS in its wire shape. `commit_ms`
 * follows the log ID only where it equalled it (a record committed at its log
 * ID's time), and otherwise stays. The same object when nothing changed, and
 * the same `record_json` text when the wire shape did not.
 */
export function remapRecord(record: ChatRecord, map: IdMap): ChatRecord {
	if (map.logIds.size === 0 && map.users.size === 0) return record;
	const logId = map.logId(record.log_id);
	const roomId = map.roomId(record.room_id);
	const commitMs = record.commit_ms === record.log_id ? logId : record.commit_ms;
	let recordJson = record.record_json;
	const value = JSON.parse(record.record_json) as unknown;
	const mapped = mapFields(value, RECORD_FIELDS, map);
	if (mapped !== value) recordJson = JSON.stringify(mapped);
	if (logId === record.log_id && roomId === record.room_id && commitMs === record.commit_ms && recordJson === record.record_json) return record;
	return { ...record, room_id: roomId, log_id: logId, commit_ms: commitMs, record_json: recordJson };
}

/** A room listing with its room, log IDs and members remapped; the same object when nothing changed. */
export function remapListing(listing: RoomListing, map: IdMap): RoomListing {
	return mapFields(listing, LISTING_FIELDS, map);
}

/** An archived user with its user ID remapped; the same object when nothing changed. */
export function remapUser(user: ArchivedUser, map: IdMap): ArchivedUser {
	return mapFields(user, USER_FIELDS, map);
}

/** The first ID at or after `from` that is not taken. */
export function nextFree(taken: (id: number) => boolean, from: number): number {
	let id = from;
	while (taken(id)) {
		if (id >= Number.MAX_SAFE_INTEGER) throw new Error("no free log ID");
		id++;
	}
	return id;
}

/**
 * Where colliding imported log IDs move (PLAN §10.3): each imported ID that
 * is taken moves to the next free millisecond after it, and a later imported
 * ID that the move reaches or passes moves on past it too, so the imported
 * records keep their order. `imported` is sorted ascending, without
 * duplicates. The new IDs are strictly increasing, free, and each at least
 * its old one; the map holds only the IDs that moved.
 */
export function nudgeLogIds(imported: readonly number[], taken: (id: number) => boolean): Map<number, number> {
	const moved = new Map<number, number>();
	let previous = -Infinity;
	for (const id of imported) {
		// An ID that an earlier move reached or passed follows it.
		const next = nextFree(taken, Math.max(id, previous + 1));
		if (next !== id) moved.set(id, next);
		previous = next;
	}
	return moved;
}

/** A user ID for `base` that is not taken: `base` itself, else `base-2`, `base-3`, ... (PLAN §10.4). */
export function freeUserId(base: string, taken: (id: string) => boolean): string {
	if (!taken(base)) return base;
	for (let n = 2; ; n++) {
		const id = `${base}-${n}`;
		if (!taken(id)) return id;
	}
}
