/*
 * Users as records carry them (protocol §3.3: a message's `from`, a
 * reaction set's `from`, a member's `user`), and a user's `ext` (§4.13).
 * Which recorded users a client could have sent, and within which name
 * limits, is @apron/archive's (clientUser, withClientUsers): one rule for a
 * post and an import. The server's own `ext` keys and its `ext` size cap
 * are this server's policy.
 */

import { utf8Bytes } from "./verdict.ts";

/**
 * Largest serialized `ext` a user keeps (protocol §4.13), after a write's
 * merge: room for an extension's few fields, such as a bridge's nick or a
 * time zone. Every connection of the user carries it in its attachment, and
 * every listing that shows the user carries it in `users`.
 */
export const MAX_USER_EXT_BYTES = 512;

/**
 * Keys of a user's `ext` that the server owns: `permissions` (extension
 * `ext:permissions`), which only the user's own `you` carries. A `me` write
 * of one is ignored, like `roles`, and one stored before is never read.
 */
export const SERVER_USER_EXT_KEYS: readonly string[] = ["permissions"];

/** A user's `ext` without the keys the server owns (SERVER_USER_EXT_KEYS), or undefined when nothing is left. */
export function clientUserExt(ext: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!ext || !SERVER_USER_EXT_KEYS.some((key) => Object.hasOwn(ext, key))) return ext;
	const kept = Object.fromEntries(Object.entries(ext).filter(([key]) => !SERVER_USER_EXT_KEYS.includes(key)));
	return Object.keys(kept).length ? kept : undefined;
}

/** Whether a user's merged `ext` fits MAX_USER_EXT_BYTES. */
export function userExtFits(ext: Record<string, unknown> | undefined): boolean {
	return ext === undefined || utf8Bytes(JSON.stringify(ext)) <= MAX_USER_EXT_BYTES;
}

/** A recorded user (§3.3): `user_id`, and `name` when it has a non-empty one. */
export function recordedUser(userId: string, name: string | null | undefined): { user_id: string; name?: string } {
	return { user_id: userId, ...(name ? { name } : {}) };
}
