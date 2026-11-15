/*
 * The authorization server pieces of the sign-in pages: the passkey page of
 * the `webauthn` scheme (PLAN_WEBAUTHN_EXTERNAL.md, on shazow/apron#116), and
 * the `/oauth/authorize` page of `external` (protocol §4.12.3). Both take an
 * OAuth 2.1 authorization request with PKCE from any client, and end in a
 * code that the client redeems on its connection (or, for `external`, at
 * `/oauth/token`). Pure helpers only: what is kept, and when, is the Durable
 * Object's (index.ts, "Sign-in pages").
 *
 * Section numbers in these files are PROTOCOL.md's on shazow/apron#115,
 * where §4.12 is external sign-in (v10's §4.12 `ext` is §4.13 there).
 */

/** Which page issued a code: a passkey-page code finishes only `webauthn`, an `/oauth/authorize` code only `external`. */
export type SignInPage = "passkey" | "authorize";
export type PasskeyAction = "login" | "register";

/** How long a code is good for, from when the page issues it. */
export const CODE_TTL_MS = 5 * 60_000;
/**
 * How long an addition's `request` handle is good for, from begin: long
 * enough to open the page, read it, and create the passkey, after which the
 * code it leads to has its own CODE_TTL_MS.
 */
export const REQUEST_HANDLE_TTL_MS = 10 * 60_000;

/** The page paths, on the server's origin. */
export const PASSKEY_PAGE_PATH = "/passkey";
export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";
export const METADATA_PATH = "/.well-known/oauth-authorization-server";
/** The page script's own requests: begin and finish a ceremony on the page. */
export const PAGE_BEGIN_PATH = "/passkey/begin";
export const PAGE_FINISH_PATH = "/passkey/finish";

/** Bounds on what a request may carry, so nothing unbounded reaches storage. */
const MAX_CLIENT_ID_CHARS = 512;
const MAX_REDIRECT_URI_CHARS = 2_048;
const MAX_STATE_CHARS = 1_024;
const MAX_NAME_CHARS = 256;
/** An addition's handle: `rq_` and 32 random bytes, base64url. */
export const REQUEST_HANDLE_PATTERN = /^rq_[A-Za-z0-9_-]{43}$/;
/** An S256 code challenge: a SHA-256, base64url without padding. */
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1. */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/** An authorization request as both pages take it (protocol §4.12.2), validated. */
export interface AuthorizationRequest {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	state: string;
	resource: string;
}

/** The passkey page's request: its own parameters (`action`, `name`, `request`) besides the client's. */
export interface PasskeyPageRequest extends AuthorizationRequest {
	action: PasskeyAction;
	name?: string;
	request?: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A `redirect_uri` that a page may send a code to (protocol §4.12.3), or
 * null: `https` with a host; `http` on a loopback address, any port; or a
 * private-use scheme with a `.`, such as `com.example.app:/signed-in`
 * (RFC 8252 §7.1). Never a fragment or credentials (RFC 6749 §3.1.2).
 */
export function redirectTarget(value: string): URL | null {
	if (value.length === 0 || value.length > MAX_REDIRECT_URI_CHARS) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.hash || value.includes("#") || url.username || url.password) return null;
	if (url.protocol === "https:") return url.hostname ? url : null;
	if (url.protocol === "http:") return isLoopback(url.hostname) ? url : null;
	const scheme = url.protocol.slice(0, -1);
	return /^[a-z][a-z0-9+.-]*$/.test(scheme) && scheme.includes(".") ? url : null;
}

function isLoopback(hostname: string): boolean {
	return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost";
}

/**
 * Who is asking, in the page's words (PLAN_WEBAUTHN_EXTERNAL.md,
 * "Confirmation"): an `https` redirect's host; an app scheme as "An app on
 * this device (com.example.myapp)"; a loopback address as "An app on this
 * device". `where` is how "Only continue if you just started signing in on
 * …" ends.
 */
export function clientLabel(redirect: URL): { who: string; where: string } {
	if (redirect.protocol === "https:") return { who: redirect.host, where: redirect.host };
	if (redirect.protocol === "http:") return { who: "An app on this device", where: "an app on this device" };
	return { who: `An app on this device (${redirect.protocol.slice(0, -1)})`, where: "an app on this device" };
}

/**
 * Whether the server recognises the client (PLAN_WEBAUTHN_EXTERNAL.md,
 * "Confirmation"), so the page leaves out "has not verified this app": only
 * an `https` redirect on one of the server's own passkey origins
 * (`RP_ORIGINS`), its first-party clients. App schemes and loopback
 * addresses never are; nor is any `client_id`.
 */
export function recognisedClient(redirect: URL, firstParty: readonly string[]): boolean {
	return redirect.protocol === "https:" && firstParty.includes(redirect.origin);
}

/**
 * Whether a page on `origin` can run a ceremony for `rpId`: its host is the
 * RP ID or under it, over `https`, or `http` on `localhost` for local
 * development (a secure context).
 */
export function pageOriginServes(origin: string, rpId: string): boolean {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.origin !== origin) return false;
	const host = url.hostname.toLowerCase();
	if (url.protocol === "http:" && host !== "localhost") return false;
	if (url.protocol !== "https:" && url.protocol !== "http:") return false;
	return host === rpId || host.endsWith(`.${rpId}`);
}

/**
 * The server's origin from the WebSocket address a connection reached
 * (protocol §4.12.1): `https://` and its host and port, or `http://` for a
 * plain `ws://` address, which only local development uses. Undefined for
 * anything else.
 */
export function originOfEndpoint(endpoint: string | undefined): string | undefined {
	if (!endpoint) return undefined;
	try {
		const url = new URL(endpoint);
		if (url.protocol === "wss:") return `https://${url.host}`;
		if (url.protocol === "ws:") return `http://${url.host}`;
	} catch { /* not a URL */ }
	return undefined;
}

/** One value of a parameter that must appear at most once (RFC 6749 §3.1). */
function single(query: URLSearchParams, name: string): string | undefined | null {
	const values = query.getAll(name);
	if (values.length > 1) return null;
	return values[0];
}

/**
 * The client's part of an authorization request (protocol §4.12.2,
 * §4.12.3), checked in the order a reader would fix it: where the code goes
 * first, so every error before it is known to be safe stays on the page.
 * Errors are worded for the person looking at the page.
 */
export function parseAuthorizationRequest(query: URLSearchParams, origin: string): Parsed<AuthorizationRequest> {
	const redirectUri = single(query, "redirect_uri");
	if (redirectUri === null) return { ok: false, error: "The sign-in request names more than one return address (redirect_uri)." };
	if (!redirectUri) return { ok: false, error: "The sign-in request has no return address (redirect_uri)." };
	if (!redirectTarget(redirectUri)) {
		return { ok: false, error: "The sign-in request's return address (redirect_uri) is not one this server sends sign-ins to: it must be https, an app's own scheme with a dot in it, or http on this device (127.0.0.1, [::1] or localhost)." };
	}
	const clientId = single(query, "client_id");
	if (!clientId || clientId.length > MAX_CLIENT_ID_CHARS) return { ok: false, error: "The sign-in request has no valid client_id." };
	if (single(query, "response_type") !== "code") return { ok: false, error: "The sign-in request must ask for a code (response_type=code)." };
	const method = single(query, "code_challenge_method");
	const codeChallenge = single(query, "code_challenge");
	if (method !== "S256" || !codeChallenge || !CODE_CHALLENGE_PATTERN.test(codeChallenge)) {
		return { ok: false, error: "The sign-in request must use PKCE with S256 (code_challenge and code_challenge_method=S256)." };
	}
	const state = single(query, "state");
	if (!state || state.length > MAX_STATE_CHARS) return { ok: false, error: "The sign-in request has no valid state." };
	const resource = single(query, "resource");
	if (resource !== origin) {
		return { ok: false, error: resource ? `The sign-in request is for another server (${resource}), not ${origin}.` : `The sign-in request must name this server (resource=${origin}).` };
	}
	return { ok: true, value: { clientId, redirectUri, codeChallenge, state, resource } };
}

/**
 * The passkey page's request: the client's part, then the server's own
 * query that begin put in `external.url` (`action`, and `name` for a new
 * account or `request` for an addition).
 */
export function parsePasskeyPageRequest(query: URLSearchParams, origin: string): Parsed<PasskeyPageRequest> {
	const parsed = parseAuthorizationRequest(query, origin);
	if (!parsed.ok) return parsed;
	const action = single(query, "action");
	if (action !== "login" && action !== "register") return { ok: false, error: "The sign-in request does not say whether to sign in or create a passkey (action)." };
	const name = single(query, "name");
	const request = single(query, "request");
	if (name === null || request === null) return { ok: false, error: "The sign-in request repeats a parameter." };
	if (action === "login" && (name !== undefined || request !== undefined)) return { ok: false, error: "The sign-in request mixes a sign-in with a new passkey." };
	if (request !== undefined && (!REQUEST_HANDLE_PATTERN.test(request) || name !== undefined)) return { ok: false, error: "This link to add a passkey is not valid. Start again from the app." };
	if (name !== undefined && (name.trim().length === 0 || name.length > MAX_NAME_CHARS)) return { ok: false, error: "The name for the new account is not valid." };
	return { ok: true, value: { ...parsed.value, action, ...(name !== undefined ? { name: name.trim() } : {}), ...(request !== undefined ? { request } : {}) } };
}

/** `uri` with `params` added to its query, as a code or an error goes back (RFC 6749 §4.1.2). */
export function redirectWith(uri: string, params: Record<string, string>): string {
	const url = new URL(uri);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	return url.href;
}

/** Whether `verifier` answers an S256 `challenge` (RFC 7636 §4.6). */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
	if (!CODE_VERIFIER_PATTERN.test(verifier)) return false;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	let binary = "";
	for (const byte of digest) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") === challenge;
}

/** The server's authorization server metadata (RFC 8414), for `external` (protocol §4.12.3). */
export function authorizationServerMetadata(origin: string): Record<string, unknown> {
	return {
		issuer: origin,
		authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
		token_endpoint: `${origin}${TOKEN_PATH}`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"],
		authorization_response_iss_parameter_supported: true,
	};
}

/**
 * Whether WebAuthn client data says the ceremony ran in a frame on another
 * site (WebAuthn Level 3 §13.4.9): `crossOrigin: true`, or any `topOrigin`.
 * The page refuses those, as it refuses to be framed. Unreadable client data
 * counts as framed; verification would refuse it anyway.
 */
export function clientDataFramed(credential: unknown): boolean {
	try {
		const response = (credential as { response?: { clientDataJSON?: unknown } }).response;
		const encoded = response?.clientDataJSON;
		if (typeof encoded !== "string") return true;
		const padded = encoded.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - encoded.length % 4) % 4);
		const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
		const data = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
		return data.crossOrigin === true || data.topOrigin !== undefined;
	} catch {
		return true;
	}
}
