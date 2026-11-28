/*
 * Push kind `webhook` (protocol §4.9.4): the Standard Webhooks pieces this
 * server needs, with WebCrypto only. Calls and endpoint verifications are
 * signed with the asymmetric scheme `v2a` (Ed25519 over the SHA-256 of
 * `endpoint_id.msg_id.timestamp.body`) with each key of
 * `WEBHOOK_SIGNING_KEY`, a list of `whsk_` secret keys (the 32-byte Ed25519
 * seed, in standard base64), whose public keys `server.push.webhook`
 * advertises as `whpk_` keys. The endpoint verification extension's answer
 * is `v2a,` and the base64 HMAC-SHA256 of the challenge under
 * HMAC-SHA256(public key bytes + "." + endpoint_id, "wev-v1"). The short-lived
 * `apron_webhook_` bearer token a call carries is signed with an HMAC key
 * derived from the same secret keys, so it needs no storage.
 *
 * References: https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
 * and its spec/extensions/endpoint-verification.md.
 */

const encoder = new TextEncoder();

/** The `whsk_` and `whpk_` prefixes of Standard Webhooks' asymmetric keys. */
export const WEBHOOK_SECRET_KEY_PREFIX = "whsk_";
export const WEBHOOK_PUBLIC_KEY_PREFIX = "whpk_";
/** The short-lived bearer token a call carries (§4.9.4 `token`), told from others by its prefix without a storage read. */
export const WEBHOOK_TOKEN_PREFIX = "apron_webhook_";
/** How long a call's token signs in: 15 minutes, as Discord's interaction token. */
export const WEBHOOK_TOKEN_TTL_MS = 15 * 60_000;
/** The endpoint verification extension's key label. */
const VERIFICATION_LABEL = "wev-v1";
/** The label of the HMAC key the call tokens are signed with, derived from each signing key. */
const TOKEN_LABEL = "apron-webhook-token-v1";
/** An Ed25519 PKCS #8 private key is this DER prefix and the 32-byte seed (RFC 8410). */
const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
/** Most signing keys `WEBHOOK_SIGNING_KEY` may list: the current one and those being rotated out. */
export const MAX_WEBHOOK_SIGNING_KEYS = 3;

/**
 * Server policy for webhooks (SPEC section 4.4, Webhook; docs/limits.md).
 * Calls are outbound requests, which no storage budget counts, but each
 * costs the object awake time and a few rows, so they are bounded per bot,
 * per server, and per response.
 */
export const WEBHOOK_LIMITS = {
	/** Webhook registrations one account may hold. */
	perUser: 2,
	/** Webhook registrations the whole server may hold, which bounds the in-memory set a message is matched against. */
	perServer: 32,
	/** Calls one account gets a UTC day; past it calls are skipped and counted in the next call's `skipped`. */
	callsPerUserDay: 1_000,
	/** Calls the whole server makes a UTC day. */
	callsPerDay: 5_000,
	/** Messages one call carries at most; a burst past it while a call is in flight is skipped. */
	messagesPerCall: 20,
	/** Request frames a response body may hold that the server runs; the rest are ignored. */
	framesPerResponse: 10,
	/** Largest response body read, in bytes; the frames past it are ignored. */
	responseBytes: 64 * 1024,
	/** How long a call or verification may take to answer (§4.9.4: 2xx within 30 seconds). */
	timeoutMs: 30_000,
	/** Delays before each retry of a call or verification that timed out, could not connect, or got 429 or 5xx. */
	retryDelaysMs: [5_000, 30_000] as readonly number[],
	/** Longest `Retry-After` honoured: a longer one gives up, as the bot recovers with `history`. */
	maxRetryAfterMs: 60_000,
	/** Consecutive calls given up after which a webhook is `failing` and called no more until registered again. */
	failingAfter: 5,
} as const;

/** One signing key: its private key, and its public key as raw bytes and as `whpk_` text. */
export interface WebhookSigningKey {
	privateKey: CryptoKey;
	publicKey: Uint8Array<ArrayBuffer>;
	publicText: string;
	/** The HMAC key call tokens are signed and checked with (TOKEN_LABEL). */
	tokenKey: CryptoKey;
}

export function base64Encode(bytes: Uint8Array): string {
	let text = "";
	for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	return btoa(text);
}

export function base64Decode(text: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
	try {
		return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}

function base64UrlEncode(bytes: Uint8Array): string {
	return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
	return base64Decode(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
}

/** The 32-byte seed a `whsk_` key holds, or null when it is not one. */
export function webhookSecretSeed(text: string): Uint8Array<ArrayBuffer> | null {
	if (!text.startsWith(WEBHOOK_SECRET_KEY_PREFIX)) return null;
	const seed = base64Decode(text.slice(WEBHOOK_SECRET_KEY_PREFIX.length));
	return seed?.byteLength === 32 ? seed : null;
}

/** `WEBHOOK_SIGNING_KEY`'s keys, current first: `whsk_` keys separated by spaces or commas. Throws on any other entry. */
export function parseWebhookSigningKeys(raw: string): string[] {
	const keys = raw.split(/[\s,]+/).filter(Boolean);
	if (!keys.length) throw new Error("WEBHOOK_SIGNING_KEY lists no key");
	if (keys.length > MAX_WEBHOOK_SIGNING_KEYS) throw new Error(`WEBHOOK_SIGNING_KEY lists at most ${MAX_WEBHOOK_SIGNING_KEYS} keys`);
	for (const key of keys) if (!webhookSecretSeed(key)) throw new Error("WEBHOOK_SIGNING_KEY must list whsk_ keys, each a 32-byte Ed25519 seed in base64");
	if (new Set(keys).size !== keys.length) throw new Error("WEBHOOK_SIGNING_KEY lists a key twice");
	return keys;
}

/** Imports one `whsk_` key: its Ed25519 private key, its public key, and the HMAC key for call tokens. */
export async function importWebhookSigningKey(text: string): Promise<WebhookSigningKey> {
	const seed = webhookSecretSeed(text);
	if (!seed) throw new Error("not a whsk_ key");
	const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
	pkcs8.set(PKCS8_ED25519_PREFIX);
	pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
	// Extractable only to read the public key back (its JWK `x`); the private key never leaves.
	const extractable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
	const jwk = await crypto.subtle.exportKey("jwk", extractable) as JsonWebKey;
	const publicKey = base64UrlDecode(jwk.x ?? "");
	if (publicKey?.byteLength !== 32) throw new Error("Ed25519 public key not derived");
	const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
	const tokenBytes = await hmac(seed, encoder.encode(TOKEN_LABEL));
	const tokenKey = await crypto.subtle.importKey("raw", tokenBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
	return { privateKey, publicKey, publicText: WEBHOOK_PUBLIC_KEY_PREFIX + base64Encode(publicKey), tokenKey };
}

async function hmac(key: Uint8Array<ArrayBuffer>, message: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", imported, message));
}

/** What `v2a` signs: the SHA-256 of `endpoint_id.msg_id.timestamp.body`. */
async function signedDigest(endpointId: string, msgId: string, timestamp: number, body: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", encoder.encode(`${endpointId}.${msgId}.${timestamp}.${body}`));
}

/**
 * The `webhook-signature` header: one `v2a,<base64>` for each key, space
 * separated, so a consumer still trusting a key being rotated out verifies
 * (§4.9.4: while `signature_keys` change, the server signs with each).
 */
export async function signWebhook(keys: readonly WebhookSigningKey[], endpointId: string, msgId: string, timestamp: number, body: string): Promise<string> {
	if (endpointId.includes(".") || msgId.includes(".")) throw new Error("endpoint and message IDs have no '.'");
	const digest = await signedDigest(endpointId, msgId, timestamp, body);
	const signatures = await Promise.all(keys.map(async (key) => `v2a,${base64Encode(new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, digest)))}`));
	return signatures.join(" ");
}

/**
 * Whether a `webhook-signature` header holds a `v2a` signature that one of
 * `publicKeys` (raw Ed25519 bytes) verifies: what a consumer checks. For
 * tests, and to prove the configured keys sign as they should.
 */
export async function verifyWebhookSignature(publicKeys: readonly Uint8Array<ArrayBuffer>[], endpointId: string, msgId: string, timestamp: number, body: string, header: string): Promise<boolean> {
	const digest = await signedDigest(endpointId, msgId, timestamp, body);
	for (const entry of header.split(" ")) {
		const [version, encoded] = entry.split(",", 2);
		if (version !== "v2a" || !encoded) continue;
		const signature = base64Decode(encoded);
		if (signature?.byteLength !== 64) continue;
		for (const publicKey of publicKeys) {
			const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
			if (await crypto.subtle.verify("Ed25519", key, signature, digest)) return true;
		}
	}
	return false;
}

/**
 * The endpoint verification answer for one key (`webhook-challenge-response`):
 * `v2a,` and base64(HMAC-SHA256(verification_key, challenge)), where
 * verification_key = HMAC-SHA256(public key bytes + "." + endpoint_id, "wev-v1")
 * and the challenge is the header's text as sent.
 */
export async function verificationResponse(publicKey: Uint8Array, endpointId: string, challenge: string): Promise<string> {
	const id = encoder.encode(`.${endpointId}`);
	const endpointKey = new Uint8Array(publicKey.length + id.length);
	endpointKey.set(publicKey);
	endpointKey.set(id, publicKey.length);
	const verificationKey = await hmac(endpointKey, encoder.encode(VERIFICATION_LABEL));
	return `v2a,${base64Encode(await hmac(verificationKey, encoder.encode(challenge)))}`;
}

/** Whether two strings are equal, compared in time that depends on their lengths only. */
function constantTimeEqual(a: string, b: string): boolean {
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	let difference = left.length ^ right.length;
	for (let index = 0; index < Math.max(left.length, right.length); index++) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	return difference === 0;
}

/**
 * Whether an endpoint's `webhook-challenge-response` answers `challenge` for
 * one of the active keys: the whole header, one signature, compared in
 * constant time (anything else, a list included, fails).
 */
export async function checkVerificationResponse(keys: readonly { publicKey: Uint8Array }[], endpointId: string, challenge: string, header: string | null): Promise<boolean> {
	if (header === null) return false;
	let matched = false;
	for (const key of keys) if (constantTimeEqual(header.trim(), await verificationResponse(key.publicKey, endpointId, challenge))) matched = true;
	return matched;
}

/** A fresh 32-byte challenge, base64 (endpoint verification). */
export function newChallenge(): string {
	return base64Encode(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * A fresh ID with no `.` and only URL-safe characters: an endpoint's
 * `endpoint_id` (`wh_` and 96 random bits) or a call's `webhook-id`
 * (`msg_` and 96 random bits, the same on each retry).
 */
export function newWebhookId(prefix: "wh_" | "msg_"): string {
	return prefix + base64UrlEncode(crypto.getRandomValues(new Uint8Array(12)));
}

/** What a call's token grants: the account, the creation time of its identity (so a recreated account is another), and the expiry. */
export interface WebhookTokenGrant {
	userId: string;
	createdMs: number;
	expiresMs: number;
}

/** `<user_id base64url>.<identity created, ms>.<expiry, ms>`: the signed part of a token. */
function tokenPayload(grant: WebhookTokenGrant): string {
	return `${base64UrlEncode(encoder.encode(grant.userId))}.${Math.max(0, Math.floor(grant.createdMs))}.${Math.floor(grant.expiresMs)}`;
}

/** A call's short-lived bearer token (§4.9.4 `token`), signed with the current key's token HMAC key. */
export async function signWebhookToken(key: WebhookSigningKey, grant: WebhookTokenGrant): Promise<string> {
	const payload = tokenPayload(grant);
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key.tokenKey, encoder.encode(payload)));
	return `${WEBHOOK_TOKEN_PREFIX}${payload}.${base64UrlEncode(signature)}`;
}

/** The grant a token carries if one of the keys signed it and it has not expired, else null. */
export async function verifyWebhookToken(keys: readonly WebhookSigningKey[], token: string, now = Date.now()): Promise<WebhookTokenGrant | null> {
	if (!token.startsWith(WEBHOOK_TOKEN_PREFIX) || token.length > 256) return null;
	const parts = token.slice(WEBHOOK_TOKEN_PREFIX.length).split(".");
	if (parts.length !== 4) return null;
	const [userText, createdText, expiresText, signatureText] = parts;
	if (!/^\d{1,16}$/.test(createdText) || !/^\d{1,16}$/.test(expiresText)) return null;
	const userBytes = base64UrlDecode(userText);
	const signature = base64UrlDecode(signatureText);
	// Only the canonical encodings, so one grant has one token.
	if (!userBytes || !userBytes.length || base64UrlEncode(userBytes) !== userText || signature?.byteLength !== 32 || base64UrlEncode(signature) !== signatureText) return null;
	const signed = encoder.encode(parts.slice(0, 3).join("."));
	let valid = false;
	for (const key of keys) if (await crypto.subtle.verify("HMAC", key.tokenKey, signature, signed)) valid = true;
	const expiresMs = Number(expiresText);
	if (!valid || !(expiresMs > now)) return null;
	let userId: string;
	try {
		userId = new TextDecoder("utf-8", { fatal: true }).decode(userBytes);
	} catch {
		return null;
	}
	return { userId, createdMs: Number(createdText), expiresMs };
}

/** What one webhook POST came back with. */
export interface WebhookOutcome {
	/** The HTTP status, 0 when nothing answered (a timeout or a failed connection). */
	status: number;
	/** `Retry-After`, in milliseconds, when the answer carried one. */
	retryAfterMs?: number;
	/** `webhook-challenge-response`, for a verification. */
	challengeResponse: string | null;
	/** A 2xx body, cut to WEBHOOK_LIMITS.responseBytes. */
	body?: string;
	/** Why nothing answered. */
	error?: string;
}

/** `Retry-After` as milliseconds: seconds, or an HTTP date. */
function retryAfterMs(value: string | null, now: number): number | undefined {
	if (!value) return undefined;
	if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1_000;
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Reads at most `limit` bytes of a body as text, then lets the rest go. */
async function boundedText(response: Response, limit: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(Math.min(size, limit));
	let offset = 0;
	for (const chunk of chunks) {
		const room = bytes.length - offset;
		if (room <= 0) break;
		bytes.set(chunk.subarray(0, room), offset);
		offset += Math.min(room, chunk.byteLength);
	}
	return new TextDecoder().decode(bytes);
}

/**
 * POSTs one signed webhook request: a call, or with `challenge` an endpoint
 * verification. Never follows a redirect (Standard Webhooks: a 3xx is a
 * failure), and gives up after WEBHOOK_LIMITS.timeoutMs. A 2xx call's body
 * is read, up to WEBHOOK_LIMITS.responseBytes, within the same deadline.
 */
export async function postWebhook(input: {
	url: string; endpointId: string; msgId: string; body: string; keys: readonly WebhookSigningKey[]; nowMs: number; challenge?: string; readBody?: boolean;
}): Promise<WebhookOutcome> {
	const timestamp = Math.floor(input.nowMs / 1_000);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"webhook-id": input.msgId,
		"webhook-timestamp": String(timestamp),
		"webhook-signature": await signWebhook(input.keys, input.endpointId, input.msgId, timestamp, input.body),
	};
	if (input.challenge !== undefined) headers["webhook-challenge"] = input.challenge;
	const signal = AbortSignal.timeout(WEBHOOK_LIMITS.timeoutMs);
	try {
		const response = await fetch(input.url, { method: "POST", headers, body: input.body, redirect: "manual", signal });
		const outcome: WebhookOutcome = { status: response.status, challengeResponse: response.headers.get("webhook-challenge-response") };
		const retry = retryAfterMs(response.headers.get("retry-after"), Date.now());
		if (retry !== undefined) outcome.retryAfterMs = retry;
		if (input.readBody && response.status >= 200 && response.status < 300) outcome.body = await boundedText(response, WEBHOOK_LIMITS.responseBytes);
		else await response.body?.cancel().catch(() => undefined);
		return outcome;
	} catch (error) {
		const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
		return { status: 0, challengeResponse: null, error: timedOut ? "no answer within 30 seconds" : "could not connect" };
	}
}

/** Whether an outcome is worth retrying (Standard Webhooks; recipes/bot.md): no answer, 429, or 5xx. */
export function retryableOutcome(outcome: WebhookOutcome): boolean {
	return outcome.status === 0 || outcome.status === 429 || outcome.status >= 500;
}

/** The delay before retry `index` (0 for the first retry), or undefined to give up: Retry-After when it is within bounds. */
export function retryDelay(outcome: WebhookOutcome, index: number): number | undefined {
	const base = WEBHOOK_LIMITS.retryDelaysMs[index];
	if (base === undefined) return undefined;
	if (outcome.retryAfterMs === undefined) return base;
	return outcome.retryAfterMs > WEBHOOK_LIMITS.maxRetryAfterMs ? undefined : Math.max(base, outcome.retryAfterMs);
}

/** An outcome said in a few words, for a registration's `error`. */
export function describeOutcome(outcome: WebhookOutcome, what: "call" | "verification"): string {
	if (outcome.status === 0) return `${what} failed: ${outcome.error ?? "no answer"}`;
	if (outcome.status >= 300 && outcome.status < 400) return `${what} failed: redirect ${outcome.status} (redirects are not followed)`;
	return `${what} failed: HTTP ${outcome.status}`;
}
