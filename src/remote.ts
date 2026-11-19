/**
 * Link accounts (extension `ext:remote`): an account an admin binds to one
 * remote Apron server with `/remote invite <address>`, whose requests that
 * carry `ext.remote.user_id` run as a shadow user standing for that user of
 * the remote server. The remote server's bridge connects here as the link;
 * this server never dials out.
 */

/** The longest remote server address a link is bound to, in characters. */
export const MAX_REMOTE_ADDRESS_CHARS = 256;
/** The longest remote `user_id` a shadow stands for, in UTF-8 bytes. */
export const MAX_REMOTE_USER_ID_BYTES = 128;
/** The most link accounts one server keeps (`_meta` `remote_links`). */
export const MAX_REMOTE_LINKS = 32;
/** A link account's `user_id` is this plus a number: `link_1`. */
export const REMOTE_LINK_PREFIX = "link_";

/** A link account's binding, as `_meta` `remote_links` keeps it by the link's `user_id`. */
export interface RemoteLink {
	server: string;
}

/** The server-owned `remote` of a link (`user.ext.remote`): its server, with no `user_id`. */
export interface RemoteOrigin {
	server: string;
	user_id?: string;
}

/** The server-owned `remote` of a shadow user (`user.ext.remote`). */
export interface RemoteUser {
	server: string;
	user_id: string;
}

/**
 * A remote server's address (protocol §1) as a link is bound to it: a `ws`
 * or `wss` URI without user info or fragment, with its scheme and host
 * lowercased (RFC 3986 §6.2.2.1) and everything else as written, so the
 * operator's spelling of the path stays the one the bridge compares with.
 * Undefined when it is not one.
 */
export function normalizeRemoteAddress(value: string): string | undefined {
	if (value.length === 0 || value.length > MAX_REMOTE_ADDRESS_CHARS) return undefined;
	const match = /^(wss?):\/\/([^/?#]+)([^#]*)$/i.exec(value);
	if (!match) return undefined;
	const [, scheme, authority, rest] = match;
	if (authority.includes("@")) return undefined;
	// A host, a bracketed IPv6 literal, and an optional port of digits.
	const hostPort = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(authority);
	if (!hostPort || (hostPort[2] !== undefined && Number(hostPort[2]) > 65_535)) return undefined;
	if (/[\s\p{Cc}]/u.test(rest)) return undefined;
	const normalized = `${scheme.toLowerCase()}://${authority.toLowerCase()}${rest}`;
	try {
		new URL(normalized);
	} catch {
		return undefined;
	}
	return normalized;
}

/** The authority of a normalized address: its host, plus `:port` when it has one. */
export function remoteAuthority(address: string): string {
	return /^wss?:\/\/([^/?#]+)/.exec(address)?.[1] ?? address;
}

/**
 * The `user_id` of the shadow user for user `remoteUserId` of `server`:
 * `<remoteUserId>@<authority>`. No other `user_id` this server issues has
 * an `@` (assertIssuableUserId, candidateUserIdFor), so none can be taken
 * for a shadow's, and an `@` marks a shadow.
 */
export function shadowUserId(server: string, remoteUserId: string): string {
	return `${remoteUserId}@${remoteAuthority(server)}`;
}

/** Whether a `user_id` is a shadow user's (shadowUserId). */
export function isShadowUserId(userId: string): boolean {
	return userId.includes("@");
}

/**
 * Why a remote `user_id` cannot have a shadow, or undefined when it can:
 * a protocol `user_id` (§2.4: not empty, no whitespace or control
 * characters), not a system identity (`~`), within MAX_REMOTE_USER_ID_BYTES.
 */
export function remoteUserIdError(value: string): string | undefined {
	if (value.length === 0) return "ext.remote.user_id must be a non-empty string";
	if (new TextEncoder().encode(value).length > MAX_REMOTE_USER_ID_BYTES) return `ext.remote.user_id is at most ${MAX_REMOTE_USER_ID_BYTES} bytes`;
	if (/[\s\p{Cc}]/u.test(value)) return "ext.remote.user_id has whitespace or control characters";
	if (value.startsWith("~")) return "ext.remote.user_id names a system identity";
	return undefined;
}

/** `ext` without `remote`, which only the server sets; undefined when nothing is left. */
export function withoutRemote(ext: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!ext || !Object.hasOwn(ext, "remote")) return ext;
	const { remote: _, ...rest } = ext;
	void _;
	return Object.keys(rest).length ? rest : undefined;
}

/**
 * The `user_id` an act-as request names in `params.ext.remote.user_id`:
 * undefined when it names none (no `ext.remote`, or no `user_id` key), the
 * string otherwise. A `user_id` that is present but not a string is the
 * empty string, which remoteUserIdError refuses.
 */
export function actAsUserId(params: Record<string, unknown>): string | undefined {
	const ext = params.ext;
	if (!ext || typeof ext !== "object" || Array.isArray(ext)) return undefined;
	const remote = (ext as Record<string, unknown>).remote;
	if (!remote || typeof remote !== "object" || Array.isArray(remote)) return undefined;
	if (!Object.hasOwn(remote, "user_id")) return undefined;
	const userId = (remote as Record<string, unknown>).user_id;
	return typeof userId === "string" ? userId : "";
}

/**
 * The keys of an Apron link (Appendix A.4) that a `/remote invite` writes:
 * `server` (normalized), `room` and `token`, from the `https` form
 * (`https://link.apron.chat/#…`) or the `apron:?` form, the first value of
 * each key. Undefined unless all three are there and `server` is an address.
 */
export function parseInvite(link: string): { server: string; room: string; token: string } | undefined {
	const trimmed = link.trim().replace(/^<|>$/g, "").replace(/^`|`$/g, "");
	const keys = trimmed.startsWith("https://link.apron.chat/#") ? trimmed.slice("https://link.apron.chat/#".length)
		: trimmed.startsWith("apron:?") ? trimmed.slice("apron:?".length) : undefined;
	if (keys === undefined || keys.length > 2048) return undefined;
	let params: URLSearchParams;
	try {
		params = new URLSearchParams(keys);
	} catch {
		return undefined;
	}
	const server = normalizeRemoteAddress(params.get("server") ?? "");
	const room = params.get("room") ?? "";
	const token = params.get("token") ?? "";
	if (!server || !room || !token || /[\s\p{Cc}]/u.test(room + token)) return undefined;
	return { server, room, token };
}
