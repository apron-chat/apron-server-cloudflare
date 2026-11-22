/** The durable/runtime boundary shared by the WebSocket server and SQLite store, and the chat's domain rules both apply: rooms, roles, names, caps and mutes. */

import { CALIBRATED_THREAD_LIMIT, MAX_CREATED_ROOMS, MAX_PRIVATE_MEMBERSHIPS_PER_USER, SEEN_WRITE_GRANULARITY_MS } from "./budget";

export interface Identity {
	user_id: string;
	name?: string;
	/** Internal quota tier. The wire name of the `anonymous` tier is `guest`. */
	tier?: "anonymous" | "registered";
}

export interface StoredCredential {
	credentialId: string;
	userId: string;
	publicKey: string;
	counter: number;
	deviceType?: string;
	backedUp?: boolean;
	transports?: string[];
}

export interface StoredIdentity {
	userId: string;
	name: string;
	userHandle: string;
	/** When the identity was created, where it was read from its row. */
	createdMs?: number;
	credentialCount: number;
	/** Rooms the identity has joined (protocol §4.2.2), kept across connections. */
	rooms: string[];
	/** The identity's avatar while it lasts (protocol §4.8.7). */
	avatar?: string;
	/** The identity's roles (protocol §3.3), kept in its row: `admin`, `bot`, or labels. */
	roles: string[];
	/** The identity's `ext` (protocol §4.13), kept in its row; absent when empty. */
	ext?: Record<string, unknown>;
	/**
	 * When the status others see of the identity last became `offline`
	 * (protocol §4.5.2 `seen`), epoch milliseconds, kept in its row; absent
	 * when none is recorded. A sign-in carries it onto the connection.
	 */
	seen?: number;
}

/**
 * Whether `value` can be a `user_id` or `room_id` (protocol §2.4): a string
 * that is not empty and has no whitespace or control characters. One
 * definition, @apron/archive's.
 */
export { isProtocolId } from "@apron/archive";

/** The seeded, permanent top-level room. */
export const ROOM_ID = "general";
/** Passkeys one registered identity may hold (§4.10: a registration while signed in adds one). */
export const MAX_PASSKEYS_PER_USER = 8;
/** Rooms a new identity has joined: the permanent top-level room (§3.4). */
export const DEFAULT_JOINED_ROOMS: readonly string[] = [ROOM_ID];
/**
 * Prefix of a private room's `room_id` (§4.2.4): `private_<log id>`. A
 * private room is visible only to its members, who alone may add others;
 * nobody joins one by themselves. The ID is opaque to clients, which go by
 * the record's `private: true`; here it tells a private room apart without
 * a read, and keeps private rooms in a range of the rooms table's key that
 * the public scans never touch (PUBLIC_ROOMS).
 */
export const PRIVATE_ROOM_PREFIX = "private_";
/** Whether `roomId` names a private room (PRIVATE_ROOM_PREFIX). */
export function isPrivateRoomId(roomId: string): boolean {
	return roomId.startsWith(PRIVATE_ROOM_PREFIX);
}
/**
 * Most rooms one registered user's listing names as joined (userRooms), the
 * most recently active: the public rooms and threads a listing names at
 * CALIBRATED_THREAD_LIMIT, and their share of private ones. Fixed whatever
 * `threads` is: it is what a connection's attachment carries
 * (MAX_LISTED_USER_ROOMS), which has a fixed size, so a user in more rooms
 * is delivered to in the most recently active of them.
 */
export const MAX_USER_ROOMS = 3 * CALIBRATED_THREAD_LIMIT + 1 + MAX_PRIVATE_MEMBERSHIPS_PER_USER;
/** The most members a private room may have for its members to see each other's read cursors (read receipts). */
export const MAX_READ_RECEIPT_MEMBERS = 10;

/** Roles whose holders stream for `moderatorMaxSeconds` rather than `maxSeconds`. */
export const LIVE_TEXT_LONG_ROLES: readonly string[] = ["admin", "mod"];
/**
 * The role of an imported placeholder account: it reserves the
 * archive's user ID, holds no credential, and, holding a role, is never
 * removed by the idle prune (pruneIdleIdentities).
 */
export const UNCLAIMED_ROLE = "unclaimed";
/**
 * Moderator roles. A registered user holding one may move other users'
 * messages (§4.4): a `message` save of someone else's message that changes
 * only its `room_id`, such as into a thread or back out to its parent room.
 * `threader` grants that alone, for someone who tidies conversations into
 * threads; creating threads and saving any thread's title and description
 * are open to every participant already (commitRoom). Their posts count
 * against the trusted posting limits, not the registered ones
 * (chargePosting), since a move is one post per message.
 */
export const MODERATOR_ROLES: readonly string[] = ["admin", "mod", "threader"];
/**
 * The moderator roles an owner's bot (tier `bot`, `bot_…`) acts on: an admin
 * may give one `threader` so a script re-threads conversations. Its owner
 * holds its token, so `admin` and `mod` stay labels on it.
 */
export const BOT_MODERATOR_ROLES: readonly string[] = ["threader"];
/**
 * A bot (an owner's bot, or a user with the role `bot`) may change its name
 * with `me`, but only to one that says it is a bot: "bot" anywhere in it,
 * in any case. An owner's bot's default, "Bot of <owner>", already does.
 */
export const BOT_NAME_PATTERN = /bot/i;
/** Why a bot's `me` with another name is `denied`. */
export const BOT_NAME_RULE = "A bot's name must contain \"bot\"";
/**
 * Roles whose registered holders may create top-level rooms beside
 * `general`, and save their client fields (§4.2.4); only `admin` may save
 * `general`'s. Such rooms are
 * permanent, as `general` is: they neither expire nor go when emptied.
 */
export const ROOM_CREATOR_ROLES: readonly string[] = ["admin", "mod"];
export { MAX_CREATED_ROOMS };
/** Most rooms userRooms lists: MAX_USER_ROOMS, the top-level rooms, and a room just joined. What a connection's attachment carries. */
export const MAX_LISTED_USER_ROOMS = MAX_USER_ROOMS + MAX_CREATED_ROOMS + 2;
/** Most roles one user holds, so the column stays small. */
export const MAX_ROLES_PER_USER = 8;
/** A role name: lowercase letters, digits, `_` or `-`, starting with a letter. */
export const ROLE_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;
/**
 * Longest push endpoint URL kept (protocol §4.9). Browsers' are a few
 * hundred bytes; a tighter bound keeps each row small, so sybil accounts
 * cannot fill storage with registrations.
 */
export const MAX_PUSH_URL_BYTES = 512;

/** A registration's `push_id` (protocol §4.9): 1 to 64 letters, digits, `_` or `-`. */
export const PUSH_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The wake scopes this server implements (protocol §4.9), each a bit of a
 * registration's `wake` column: `mentions` (messages whose `mentions` list
 * the user), `replies` (replies to the user's messages), `private`
 * (messages in the private rooms the user is in; they have no threads) and
 * `joined` (messages in the rooms the user joined, and their threads; for
 * JOINED_WAKE_ROLES only).
 */
export const WAKE_SCOPES = { mentions: 1, replies: 2, private: 4, joined: 8 } as const;
/**
 * The roles that may wake for `joined` (§4.9.4), every message in a room
 * they joined: a registered user holding one keeps the scope when they
 * register, and only they are woken for it. Others' registrations drop it,
 * so the few who keep it are all a message's `joined` wake reads.
 */
export const JOINED_WAKE_ROLES: readonly string[] = ["admin", "mod"];
/**
 * The roles whose registered holders may add, replace and remove custom
 * emoji with `/emoji` (extension `ext:emoji`). Their images are the
 * server's (EMOJI_OWNER), so they stay when the user who added them is
 * purged or renamed.
 */
export const EMOJI_ROLES: readonly string[] = ["admin", "mod", "friend"];

/** A `user_status` or `room_mutes` row's `mute_until_ms` for a mute that lasts until changed (`mute: true`). */
export const MUTE_FOREVER = Number.MAX_SAFE_INTEGER;
/** The longest timed mute: a year; longer ones are cut to it. */
export const MAX_MUTE_SECONDS = 365 * 86_400;
/**
 * Most room mutes one user keeps (protocol §4.5 `status` with `room_id`):
 * past it, a mute of another room is declined. It bounds what a sign-in
 * reads to tell the mutes in effect, and what a wake claim's probes can find.
 */
export const MAX_ROOM_MUTES_PER_USER = 100;

/** One of a user's room mutes: the room, and until when (MUTE_FOREVER for `true`). */
export interface RoomMute {
	roomId: string;
	untilMs: number;
}

/**
 * Whether a stored `seen` (protocol §4.5.2) stands for a change to `offline`
 * at `at`: it is no more than SEEN_WRITE_GRANULARITY_MS before it (and not
 * after it), so it is carried again rather than written.
 */
export function seenStands(stored: number | undefined, at: number): boolean {
	return stored !== undefined && stored > 0 && stored <= at && at - stored <= SEEN_WRITE_GRANULARITY_MS;
}

/** A room mute's stored end as `status` `mute` carries it (§4.5): `true`, else the seconds left, rounded up. */
export function muteValue(untilMs: number, effective: number): number | true {
	return untilMs >= MUTE_FOREVER ? true : Math.max(1, Math.ceil((untilMs - effective) / 1_000));
}

/** When the first of `mutes` that is timed runs out, as `{next}`, or `{}` when none is. */
export function nextRoomMuteEnd(mutes: readonly RoomMute[]): { next?: number } {
	const timed = mutes.filter((mute) => mute.untilMs < MUTE_FOREVER).map((mute) => mute.untilMs);
	return timed.length ? { next: Math.min(...timed) } : {};
}
