/*
 * Users as records carry them (protocol §3.3: a message's `from`, a
 * reaction set's `from`, a member's `user`), and a user's `ext` (§4.13).
 * Which recorded users a client could have sent, and within which name
 * limits, is @apron/archive's (clientUser, withClientUsers): one rule for a
 * post and an import. The server's own `ext` keys and its `ext` size cap
 * are this server's policy.
 */

import { cloneJson, isPlainObject, utf8Bytes } from "./verdict.ts";

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

/**
 * Characters a display name drops rather than refuses (Unicode general
 * categories Cc, Cf, Co, Cs): controls, format characters such as
 * bidirectional overrides and zero-width joiners (which also breaks emoji
 * ZWJ sequences into their parts, as the Go server does), private use, and
 * lone surrogates.
 */
const INVISIBLE_IN_NAMES = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu;
/** Unassigned code points, which the PRECIS Nickname profile disallows. */
const UNASSIGNED = /\p{Cn}/u;

/**
 * A display name as this server keeps it (protocol §3.3: the server may
 * alter names, and `you.name` is the answer), the same as the Go server's
 * prepareName: the invisible characters (INVISIBLE_IN_NAMES) dropped, then
 * the PRECIS Nickname profile (RFC 8266): every space separator mapped to
 * U+0020, NFKC compatibility normalization, runs of spaces folded to one,
 * and leading and trailing spaces trimmed. A name with an unassigned code
 * point cannot be a nickname and cleans to `""`, as Go's does. `""` means
 * no name: each path treats it as it treats a name left out or removed.
 * The length limits apply to the result. Names stored before are kept as
 * they are.
 */
export function cleanName(name: string): string {
	const visible = name.replace(INVISIBLE_IN_NAMES, "");
	if (UNASSIGNED.test(visible)) return "";
	return visible.replace(/\p{Zs}/gu, " ").normalize("NFKC").replace(/\p{Zs}/gu, " ").replace(/ {2,}/g, " ").trim();
}

/** A recorded user (§3.3): `user_id`, and `name` when it has a non-empty one. */
export function recordedUser(userId: string, name: string | null | undefined): { user_id: string; name?: string } {
	return { user_id: userId, ...(name ? { name } : {}) };
}

/** An empty value (`""`, `[]`, `{}`), which clears a key in a merge (protocol §3.3, §4.13). */
function emptyValue(value: unknown): boolean {
	return value === "" || (Array.isArray(value) && value.length === 0) || (isPlainObject(value) && Object.keys(value).length === 0);
}

/**
 * Merges a write's `ext` into the stored one, one level deep (protocol §4.13):
 * each key the write carries replaces the stored value whole, a key whose
 * value is empty (`""`, `[]`, `{}`) is removed, and keys it leaves out stay.
 * `null` is an ordinary value. Without a write, or with `{}`, the stored
 * `ext` is unchanged. Undefined when nothing is left. Built from entries, so
 * a `"__proto__"` key is an ordinary own key, never a prototype.
 */
export function mergeExt(stored: unknown, write: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	const merged = new Map<string, unknown>(isPlainObject(stored) ? Object.entries(stored) : []);
	for (const [key, value] of Object.entries(write ?? {})) {
		if (emptyValue(value)) merged.delete(key);
		else merged.set(key, value);
	}
	return merged.size ? cloneJson(Object.fromEntries(merged)) : undefined;
}
