/*
 * Replay (PROTOCOL §2.3; ARCHIVE.md v1): the current state a set of records
 * gives, as a reader would show it after replaying them. It is the one
 * definition of what a record does to current state: a server restoring an
 * archive writes the rows it yields, a client renders it, and it is the
 * oracle of every round trip: two histories are the same when their
 * replayed states compare equal.
 *
 * Replay keeps, for each key, the record with the greatest log ID (the
 * record's `log_id`), whatever the order the records come in:
 * - a room record per room (its `room_id`); a listing of the room counts as
 *   a room record at its `log_id` (a listing without one is older than every
 *   record), and a record wins a tie;
 * - a message snapshot per `message_id`; at an equal log ID a tombstone
 *   wins. A moved message is in the room of its latest snapshot (the wire
 *   `room_id`, not the room a copy is stored under). Tombstones stay;
 * - a reaction set per (message, user); an empty set removes the user, and
 *   the reactions of a deleted message are hidden, as clients hide them
 *   (`reactions`; `reactionSets` keeps every user's latest set as logged,
 *   empty ones and deleted messages' included, for a writer of state);
 * - a membership per (room, user); `joined: false` removes the user
 *   (`members`; `memberships` keeps each user's latest change as logged). A
 *   listing's `members` is the room's member list as of its `latest_log_id`
 *   (as of everything, without one): only membership records after it
 *   change it;
 * - a user object per user, from the `users` given, the later one winning.
 *
 * compareReplayed compares:
 * - rooms: every logged field of the latest room record (`title`,
 *   `description`, `parent_room_id`, `private`, `ext`, and any other), but
 *   not `log_id`, `prev_log_id` or the delivery fields (`latest_log_id`,
 *   `history_log_id`, `members`, `member_count`);
 * - messages: `message_id`, the room, `from.user_id`, `body`, `ext`,
 *   `reply_to.message_id` and `deleted`; not `log_id`, `prev_log_id`,
 *   `prev_room_id`, the rest of `from` (a name as logged), or the content of
 *   an embedded `reply_to` snapshot (which is not installed either);
 * - reactions: each user's set per message, as a set of entries compared
 *   without U+FE0F (PROTOCOL §4.7); not their order or log IDs;
 * - members: the set of user IDs per room;
 * - users: `name`, `avatar` and `ext`; not `roles` (an import replaces them)
 *   or `status` and `seen`.
 * It never compares record order, superseded snapshots, or the log IDs of
 * folded records. ARCHIVE.md references (records of unlisted rooms, or below
 * a room's `history_log_id`) are rendered like any record: deciding what is
 * a reference is the importer's job.
 *
 * Everything here is pure: no I/O, no clock.
 */

import { byLog, canonicalJson, type ChatRecord } from "./records.ts";
import type { ArchivedRoom, ArchivedUser } from "./types.ts";

type JsonObject = Record<string, unknown>;

/** A room as replayed: the logged fields of its latest room record or listing. */
export interface ReplayedRoom {
	room_id: string;
	/** The log ID of the record or listing it came from; 0 for a listing without one. Not compared. */
	log_id: number;
	/** Every logged field but `room_id`, `log_id` and `prev_log_id`, without delivery fields. */
	fields: JsonObject;
}

/** A message as replayed: its latest snapshot. */
export interface ReplayedMessage {
	message_id: string;
	/** The room it is in now. */
	room_id: string;
	/** Of the latest snapshot. Not compared. */
	log_id: number;
	from: { user_id: string; [extra: string]: unknown };
	body?: unknown;
	ext?: unknown;
	/** The replied-to message's ID. */
	reply_to?: string;
	deleted: boolean;
}

/** A user's latest reaction set on a message, as logged. */
export interface ReplayedReactionSet {
	/** Of the record it came from. */
	log_id: number;
	/** The recorded user, as the record holds it. */
	from: { user_id: string; [extra: string]: unknown };
	/** Empty when the user's last set removed their reactions. */
	emojis: string[];
}

/** A user's latest membership change in a room, as logged. */
export interface ReplayedMembership {
	/** Of the record it came from. */
	log_id: number;
	/** The recorded user, as the record holds it. */
	user: { user_id: string; [extra: string]: unknown };
	joined: boolean;
}

/** What a reader would render after replaying records (PROTOCOL §2.3). */
export interface ReplayedState {
	rooms: Map<string, ReplayedRoom>;
	/** Last snapshot per message_id, tombstones included. */
	messages: Map<string, ReplayedMessage>;
	/** message_id → user_id → emojis (last set; empty sets and deleted messages' reactions left out). */
	reactions: Map<string, Map<string, string[]>>;
	/** room_id → user_ids (last membership, or a listing's members and the changes after it). */
	members: Map<string, Set<string>>;
	users: Map<string, ArchivedUser>;
	/** message_id → user_id → the latest set as logged, empty sets and deleted messages' included. Not compared. */
	reactionSets: Map<string, Map<string, ReplayedReactionSet>>;
	/** room_id → user_id → the latest membership change in the room's records (listings aside). Not compared. */
	memberships: Map<string, Map<string, ReplayedMembership>>;
}

/** Room fields that are not logged, or that replay does not compare. */
const ROOM_IGNORED = new Set(["room_id", "log_id", "prev_log_id", "latest_log_id", "history_log_id", "members", "member_count"]);

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logIdOf(value: unknown): number | undefined {
	const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function parse(record: ChatRecord): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(record.record_json);
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function roomFields(value: JsonObject): JsonObject {
	return Object.fromEntries(Object.entries(value).filter(([key, item]) => !ROOM_IGNORED.has(key) && item !== undefined));
}

/** Of two candidates for one key, whether `next` replaces `current`: a greater log ID, or at an equal one a tombstone over a snapshot. */
function replaces(current: { log_id: number; deleted?: boolean } | undefined, next: { log_id: number; deleted?: boolean }): boolean {
	if (!current) return true;
	if (next.log_id !== current.log_id) return next.log_id > current.log_id;
	return Boolean(next.deleted) && !current.deleted;
}

interface ReactionEntry { from?: unknown; emojis?: unknown }
interface MemberEntry { user?: unknown; joined?: unknown }

/**
 * Replays records, with listings and users, into what a reader renders. The
 * records may come in any order and hold duplicates (a move's copies).
 */
export function replayRecords(records: Iterable<ChatRecord>, listings: readonly ArchivedRoom[] = [], users: readonly ArchivedUser[] = []): ReplayedState {
	const rooms = new Map<string, ReplayedRoom & { fromRecord: boolean }>();
	const messages = new Map<string, ReplayedMessage>();
	const reactionSets = new Map<string, Map<string, ReplayedReactionSet>>();
	const memberships = new Map<string, Map<string, ReplayedMembership>>();

	for (const record of [...records].sort(byLog)) {
		const value = parse(record);
		if (!value) continue;
		const logId = record.log_id;
		const roomId = typeof value.room_id === "string" ? value.room_id : record.room_id;
		if (record.kind === "room") {
			const current = rooms.get(roomId);
			if (!current || logId >= current.log_id) rooms.set(roomId, { room_id: roomId, log_id: logId, fields: roomFields(value), fromRecord: true });
		} else if (record.kind === "message") {
			if (typeof value.message_id !== "string") continue;
			const from = isObject(value.from) && typeof value.from.user_id === "string" ? value.from as ReplayedMessage["from"] : { user_id: "" };
			const replyTo = isObject(value.reply_to) && typeof value.reply_to.message_id === "string" ? value.reply_to.message_id : undefined;
			const next: ReplayedMessage = {
				message_id: value.message_id, room_id: roomId, log_id: logId, from,
				...(value.body !== undefined ? { body: value.body } : {}),
				...(value.ext !== undefined ? { ext: value.ext } : {}),
				...(replyTo !== undefined ? { reply_to: replyTo } : {}),
				deleted: value.deleted === true,
			};
			if (replaces(messages.get(next.message_id), next)) messages.set(next.message_id, next);
		} else if (record.kind === "reactions") {
			if (typeof value.message_id !== "string" || !Array.isArray(value.reactions)) continue;
			const sets = reactionSets.get(value.message_id) ?? new Map<string, ReplayedReactionSet>();
			reactionSets.set(value.message_id, sets);
			for (const entry of value.reactions as ReactionEntry[]) {
				const from = isObject(entry) && isObject(entry.from) && typeof entry.from.user_id === "string" ? entry.from as ReplayedReactionSet["from"] : undefined;
				if (!from) continue;
				const emojis = Array.isArray(entry.emojis) ? entry.emojis.filter((emoji): emoji is string => typeof emoji === "string") : [];
				const current = sets.get(from.user_id);
				if (!current || logId >= current.log_id) sets.set(from.user_id, { log_id: logId, from, emojis });
			}
		} else if (record.kind === "membership") {
			if (!Array.isArray(value.members)) continue;
			const room = memberships.get(roomId) ?? new Map<string, ReplayedMembership>();
			memberships.set(roomId, room);
			for (const entry of value.members as MemberEntry[]) {
				const user = isObject(entry) && isObject(entry.user) && typeof entry.user.user_id === "string" ? entry.user as ReplayedMembership["user"] : undefined;
				if (!user) continue;
				const current = room.get(user.user_id);
				if (!current || logId >= current.log_id) room.set(user.user_id, { log_id: logId, user, joined: entry.joined === true });
			}
		}
	}

	// Listings: a later listing of a room replaces an earlier one (ARCHIVE.md §3).
	const lastListing = new Map<string, ArchivedRoom["listing"]>();
	for (const { listing } of listings) lastListing.set(listing.room_id, listing);
	for (const [roomId, listing] of lastListing) {
		const logId = logIdOf(listing.log_id) ?? 0;
		const current = rooms.get(roomId);
		if (!current || logId > current.log_id || (logId === current.log_id && !current.fromRecord)) {
			rooms.set(roomId, { room_id: roomId, log_id: logId, fields: roomFields(listing), fromRecord: false });
		}
	}

	const members = new Map<string, Set<string>>();
	for (const [roomId, room] of memberships) {
		members.set(roomId, new Set([...room].filter(([, membership]) => membership.joined).map(([userId]) => userId)));
	}
	for (const [roomId, listing] of lastListing) {
		if (!Array.isArray(listing.members)) continue;
		const asOf = logIdOf(listing.latest_log_id) ?? Infinity;
		const set = new Set(listing.members.map((member) => member?.user_id).filter((id): id is string => typeof id === "string"));
		for (const [userId, membership] of memberships.get(roomId) ?? []) {
			if (membership.log_id <= asOf) continue;
			if (membership.joined) set.add(userId);
			else set.delete(userId);
		}
		members.set(roomId, set);
	}
	for (const [roomId, set] of members) if (!set.size) members.delete(roomId);

	const reactions = new Map<string, Map<string, string[]>>();
	for (const [messageId, sets] of reactionSets) {
		if (messages.get(messageId)?.deleted) continue;
		const kept = new Map([...sets].filter(([, set]) => set.emojis.length).map(([userId, set]) => [userId, set.emojis]));
		if (kept.size) reactions.set(messageId, kept);
	}

	const userMap = new Map<string, ArchivedUser>();
	for (const user of users) if (user && typeof user.user_id === "string") userMap.set(user.user_id, user);

	return {
		rooms: new Map([...rooms].map(([roomId, { fromRecord: _, ...room }]) => [roomId, room])),
		messages, reactions, members, users: userMap, reactionSets, memberships,
	};
}

/**
 * How the 'a' side's IDs map to the 'b' side's, as an import reports it
 * (an IdMap, ids.ts). Each function returns its argument for an ID that did not
 * move. `roomId` defaults to: room IDs that are log IDs (threads) and
 * `private_<log ID>` go through `logId`; others stay.
 */
export interface CompareIdMap {
	logId?(id: string): string;
	userId?(id: string): string;
	roomId?(id: string): string;
}

export interface CompareOptions {
	idMap?: CompareIdMap;
}

const PRIVATE_PREFIX = "private_";
/** The longest JSON a difference quotes before it cuts it short. */
const QUOTE_LIMIT = 160;

function quote(value: unknown): string {
	const text = value === undefined ? "(none)" : canonicalJson(value);
	return text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT - 1)}…` : text;
}

/** Normalises an emoji set for comparison: entries without U+FE0F, deduplicated, sorted. */
function emojiSet(emojis: readonly string[]): string[] {
	return [...new Set(emojis.map((emoji) => emoji.replace(/️/g, "")))].sort();
}

/** The 'a' side of a comparison, with every ID it holds mapped through `idMap`. */
export function remapReplayed(state: ReplayedState, idMap: CompareIdMap): ReplayedState {
	const logId = (id: string) => idMap.logId?.(id) ?? id;
	const userId = (id: string) => idMap.userId?.(id) ?? id;
	const roomId = (id: string): string => {
		if (idMap.roomId) return idMap.roomId(id);
		if (/^\d+$/.test(id)) return logId(id);
		if (id.startsWith(PRIVATE_PREFIX) && /^\d+$/.test(id.slice(PRIVATE_PREFIX.length))) return PRIVATE_PREFIX + logId(id.slice(PRIVATE_PREFIX.length));
		return id;
	};
	const body = (value: unknown): unknown => {
		if (!isObject(value) || !Array.isArray(value.mentions)) return value;
		return { ...value, mentions: value.mentions.map((id) => typeof id === "string" ? userId(id) : id) };
	};
	const ext = (value: unknown): unknown => {
		if (!isObject(value) || !isObject(value.editors) || typeof value.editors.edited_by !== "string") return value;
		return { ...value, editors: { ...value.editors, edited_by: userId(value.editors.edited_by) } };
	};

	const rooms = new Map<string, ReplayedRoom>();
	for (const room of state.rooms.values()) {
		const fields = typeof room.fields.parent_room_id === "string" ? { ...room.fields, parent_room_id: roomId(room.fields.parent_room_id) } : room.fields;
		rooms.set(roomId(room.room_id), { ...room, room_id: roomId(room.room_id), fields });
	}
	const messages = new Map<string, ReplayedMessage>();
	for (const message of state.messages.values()) {
		const mapped: ReplayedMessage = {
			...message,
			message_id: logId(message.message_id),
			room_id: roomId(message.room_id),
			from: { ...message.from, user_id: userId(message.from.user_id) },
			...(message.body !== undefined ? { body: body(message.body) } : {}),
			...(message.ext !== undefined ? { ext: ext(message.ext) } : {}),
			...(message.reply_to !== undefined ? { reply_to: logId(message.reply_to) } : {}),
		};
		messages.set(mapped.message_id, mapped);
	}
	const reactions = new Map([...state.reactions].map(([messageId, sets]) => [logId(messageId), new Map([...sets].map(([id, emojis]) => [userId(id), emojis]))]));
	const members = new Map([...state.members].map(([id, set]) => [roomId(id), new Set([...set].map(userId))]));
	const users = new Map([...state.users].map(([id, user]) => [userId(id), { ...user, user_id: userId(id) }]));
	const reactionSets = new Map([...state.reactionSets].map(([messageId, sets]) => [logId(messageId), new Map([...sets].map(([id, set]) => [userId(id), { ...set, from: { ...set.from, user_id: userId(id) } }]))]));
	const memberships = new Map([...state.memberships].map(([id, room]) => [roomId(id), new Map([...room].map(([user, membership]) => [userId(user), { ...membership, user: { ...membership.user, user_id: userId(user) } }]))]));
	return { rooms, messages, reactions, members, users, reactionSets, memberships };
}

/** Compares two replayed states, the 'a' side through `idMap`; `differences` lists each in a readable line. */
export function compareReplayed(a: ReplayedState, b: ReplayedState, options: CompareOptions = {}): { equal: boolean; differences: string[] } {
	const left = options.idMap ? remapReplayed(a, options.idMap) : a;
	const differences: string[] = [];
	const differ = (what: string, field: string, x: unknown, y: unknown) => {
		if (canonicalJson(x ?? null) !== canonicalJson(y ?? null)) differences.push(`${what}: ${field} differs: a ${quote(x)}, b ${quote(y)}`);
	};
	const sorted = <T>(keys: Iterable<T>) => [...new Set(keys)].sort();

	for (const id of sorted([...left.rooms.keys(), ...b.rooms.keys()])) {
		const x = left.rooms.get(id);
		const y = b.rooms.get(id);
		if (!x || !y) {
			differences.push(`room ${id}: only in ${x ? "a" : "b"}`);
			continue;
		}
		for (const field of sorted([...Object.keys(x.fields), ...Object.keys(y.fields)])) differ(`room ${id}`, field, x.fields[field], y.fields[field]);
	}

	for (const id of sorted([...left.messages.keys(), ...b.messages.keys()])) {
		const x = left.messages.get(id);
		const y = b.messages.get(id);
		if (!x || !y) {
			const only = (x ?? y)!;
			differences.push(`message ${id} in ${only.room_id}: only in ${x ? "a" : "b"}`);
			continue;
		}
		const what = `message ${id} in ${y.room_id}`;
		if (x.room_id !== y.room_id) differences.push(`${what}: room differs: a ${x.room_id}, b ${y.room_id}`);
		if (x.from.user_id !== y.from.user_id) differences.push(`${what}: from differs: a ${x.from.user_id}, b ${y.from.user_id}`);
		if (x.deleted !== y.deleted) differences.push(`${what}: deleted differs: a ${x.deleted}, b ${y.deleted}`);
		differ(what, "body", x.body, y.body);
		differ(what, "ext", x.ext, y.ext);
		differ(what, "reply_to", x.reply_to, y.reply_to);
	}

	for (const id of sorted([...left.reactions.keys(), ...b.reactions.keys()])) {
		const x = left.reactions.get(id) ?? new Map<string, string[]>();
		const y = b.reactions.get(id) ?? new Map<string, string[]>();
		for (const user of sorted([...x.keys(), ...y.keys()])) {
			const xs = x.get(user);
			const ys = y.get(user);
			if (!xs || !ys) differences.push(`reactions on ${id}: ${user}'s set only in ${xs ? "a" : "b"}: ${quote(xs ?? ys)}`);
			else if (canonicalJson(emojiSet(xs)) !== canonicalJson(emojiSet(ys))) differences.push(`reactions on ${id}: ${user}'s set differs: a ${quote(xs)}, b ${quote(ys)}`);
		}
	}

	for (const id of sorted([...left.members.keys(), ...b.members.keys()])) {
		const x = left.members.get(id) ?? new Set<string>();
		const y = b.members.get(id) ?? new Set<string>();
		const onlyA = sorted([...x].filter((user) => !y.has(user)));
		const onlyB = sorted([...y].filter((user) => !x.has(user)));
		if (onlyA.length || onlyB.length) {
			const parts = [onlyA.length ? `only in a: ${onlyA.join(", ")}` : "", onlyB.length ? `only in b: ${onlyB.join(", ")}` : ""].filter(Boolean);
			differences.push(`members of ${id}: ${parts.join("; ")}`);
		}
	}

	for (const id of sorted([...left.users.keys(), ...b.users.keys()])) {
		const x = left.users.get(id);
		const y = b.users.get(id);
		if (!x || !y) {
			differences.push(`user ${id}: only in ${x ? "a" : "b"}`);
			continue;
		}
		for (const field of ["name", "avatar", "ext"] as const) differ(`user ${id}`, field, x[field], y[field]);
	}

	return { equal: differences.length === 0, differences };
}
