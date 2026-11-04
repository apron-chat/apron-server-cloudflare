// Email sign-in (protocol §4.11, scheme `email`): addresses, codes, links,
// and the message a proposal sends. The runtime's side (proposals, approval,
// accounts' addresses) lives in index.ts; this module holds what needs no
// storage, so config.ts and the tests can use it too.

/** The longest address taken, in characters (RFC 5321's path limit, less its angle brackets). */
export const MAX_EMAIL_CHARS = 254;
/** The longest `state` a proposal may carry, in UTF-8 bytes (§4.11.1). */
export const MAX_EMAIL_STATE_BYTES = 256;
/** Digits in a code typed on the connection that proposed (§4.11.2). */
export const EMAIL_CODE_DIGITS = 6;
/** Link tokens start with this, so `auth` tells them from other tokens without a storage read. */
export const EMAIL_LINK_TOKEN_PREFIX = "apron_email_";
/** Where links open when the deployment names no page (`EMAIL_LINK_URL`): the protocol's universal link (Appendix A.4). */
export const DEFAULT_EMAIL_LINK_URL = "https://link.apron.chat/";

/**
 * An address as accounts hold it, or null when it is not one this server
 * mails: trimmed and lowercased (so one inbox has one spelling), at most
 * MAX_EMAIL_CHARS, one `@` between a local part of printable ASCII other
 * than quotes, brackets, commas, semicolons, colons and backslashes (no
 * quoted local parts, display names, or comments), and a domain of at least
 * two dot-separated labels of letters, digits and hyphens. Strict on
 * purpose: the address goes in a header, and nothing a sender could not
 * type is worth the risk.
 */
export function normalizeEmail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const address = value.trim().toLowerCase();
	if (!address || address.length > MAX_EMAIL_CHARS) return null;
	const at = address.lastIndexOf("@");
	if (at <= 0 || at !== address.indexOf("@")) return null;
	const local = address.slice(0, at);
	const domain = address.slice(at + 1);
	if (local.length > 64 || !/^[!#$%&'*+\-/=?^_`{|}~.a-z0-9]+$/.test(local)) return null;
	if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
	const labels = domain.split(".");
	if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
	if (/^[0-9]+$/.test(labels[labels.length - 1])) return null;
	return address;
}

/**
 * Whether `state` is one a proposal may carry: 1 to MAX_EMAIL_STATE_BYTES
 * bytes of printable ASCII (§4.11.1). It goes back unchanged in the link's
 * fragment, form-encoded, so nothing else needs escaping rules.
 */
export function validEmailState(state: string): boolean {
	return state.length > 0 && state.length <= MAX_EMAIL_STATE_BYTES && /^[\x21-\x7e]+$/.test(state);
}

/** A uniformly random code of EMAIL_CODE_DIGITS digits, leading zeros kept. */
export function emailCode(): string {
	const limit = 10 ** EMAIL_CODE_DIGITS;
	// The largest multiple of `limit` below 2^32, so taking the remainder is uniform.
	const bound = Math.floor(0x1_0000_0000 / limit) * limit;
	const word = new Uint32Array(1);
	for (;;) {
		crypto.getRandomValues(word);
		if (word[0] < bound) return String(word[0] % limit).padStart(EMAIL_CODE_DIGITS, "0");
	}
}

/** Whether a presented token is shaped like a code (§4.11.2), so it is checked against the connection's proposal. */
export function isEmailCode(token: string): boolean {
	return token.length === EMAIL_CODE_DIGITS && /^[0-9]+$/.test(token);
}

/**
 * The sign-in link a proposal sends (§4.11.2, Appendix A.4): `page`, with
 * the server's address, the link token, and the proposal's `state` in its
 * fragment, which replaces any fragment `page` has. Written only for a
 * proposal that carried `state`, so the client that proposed can tell its
 * own link from one someone else sent it.
 */
export function emailLink(page: string, keys: { server: string; token: string; state: string }): string {
	const encode = (value: string) => encodeURIComponent(value)
		.replace(/%3A/g, ":").replace(/%2F/g, "/")
		.replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
	const base = page.split("#")[0];
	return `${base}#${(["server", "token", "state"] as const).map((key) => `${key}=${encode(keys[key])}`).join("&")}`;
}

/**
 * What a proposal is for, as the email tells its reader: signing in to the
 * account that holds the address, signing up a new one, adding the address
 * to an account, or a guest's registration for an address that already has
 * an account (`exists`), which sends no code: a guest is never switched
 * into an existing account.
 */
export type EmailPurpose =
	| { kind: "sign-in"; userId: string }
	| { kind: "sign-up" }
	| { kind: "add"; userId: string }
	| { kind: "exists"; userId: string };

/**
 * The email a proposal sends: a subject, and a plain-text body with the
 * code, the link (when the proposal carried `state`), what approving it
 * does, and when it expires; for `exists`, how to sign in instead, and no
 * code. Plain text only, so nothing in it is markup a mail client renders,
 * and the server title, which an admin sets, cannot add any.
 */
export function emailMessage(input: { server: string; code?: string; link?: string; purpose: EmailPurpose; minutes: number }): { subject: string; text: string } {
	const server = input.server.replace(/[\r\n]+/g, " ").trim() || "Apron";
	if (input.purpose.kind === "exists" || input.code === undefined) {
		const userId = input.purpose.kind === "sign-up" ? "" : ` (${input.purpose.userId})`;
		return {
			subject: `You already have an account on ${server}`,
			text: [
				`Someone asked to create an account on ${server} with this address, which already has one${userId}.`,
				"",
				"To use it, sign in with this address instead, from the app's sign-in screen rather than as a guest. Nothing was changed.",
				"",
				"If you didn't ask for this, ignore this email.",
			].join("\n"),
		};
	}
	const action = input.purpose.kind === "sign-in"
		? `sign in to ${server} as ${input.purpose.userId}`
		: input.purpose.kind === "sign-up"
			? `create an account on ${server} with this address`
			: `add this address to ${input.purpose.userId} on ${server}`;
	const lines = [
		`Your code is ${input.code}. Type it in the app where you asked for it, to ${action}.`,
		"",
		...(input.link ? ["Or open this link in that app:", input.link, ""] : []),
		`The code${input.link ? " and the link" : ""} expire${input.link ? "" : "s"} in ${input.minutes} minutes and work${input.link ? "" : "s"} once.`,
		"",
		`If you didn't ask for this, ignore this email: nothing changes without the code${input.link ? " or the link" : ""}. Never share them.`,
	];
	return { subject: `${input.code} is your ${server} code`, text: lines.join("\n") };
}
