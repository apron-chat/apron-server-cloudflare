// Web Push (protocol §4.7, push kind `webpush`): message encryption for the
// browser's push service (RFC 8291, `aes128gcm` from RFC 8188) and the
// server's VAPID identification (RFC 8292), with WebCrypto only. Nothing here
// reads storage or configuration; the Durable Object decides whom to wake.

/** One browser push subscription: its endpoint and the keys its `PushSubscription` gives. */
export interface WebPushSubscription {
	/** The push service endpoint, which also identifies the registration (§4.7). */
	url: string;
	/** The browser's P-256 public key, uncompressed, unpadded base64url (65 bytes). */
	p256dh: string;
	/** The browser's authentication secret, unpadded base64url (16 bytes). */
	auth: string;
}

/** The server's VAPID key pair (RFC 8292) and the contact the push service may use. */
export interface VapidKeys {
	/** Uncompressed P-256 public key, unpadded base64url (65 bytes); what `server.push.webpush.key` advertises. */
	publicKey: string;
	/** The private scalar `d`, unpadded base64url (32 bytes). */
	privateKey: string;
	/** A `mailto:` or `https:` URL (RFC 8292 section 2.1). */
	subject: string;
}

export const P256_PUBLIC_KEY_BYTES = 65;
export const P256_PRIVATE_KEY_BYTES = 32;
export const AUTH_SECRET_BYTES = 16;
/** The one record's size in the `aes128gcm` header. */
const RECORD_SIZE = 4096;
/** Salt, record size, key ID length, and the 65-byte key ID (RFC 8291 section 4). */
const HEADER_BYTES = 16 + 4 + 1 + P256_PUBLIC_KEY_BYTES;
/**
 * The longest plaintext one push carries: a push service accepts 4096 bytes
 * of body (RFC 8030 section 7.2), which holds the header, the plaintext with
 * its padding delimiter, and the 16-byte AES-GCM tag.
 */
export const MAX_PUSH_PLAINTEXT_BYTES = RECORD_SIZE - HEADER_BYTES - 1 - 16;
/** How long a VAPID token is valid; RFC 8292 allows at most 24 hours. */
const VAPID_TOKEN_SECONDS = 12 * 60 * 60;

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Decodes base64url, padded or not; null when it is not base64url. */
export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return null;
	const bare = text.replace(/=+$/, "");
	if (bare.length % 4 === 1) return null;
	try {
		const binary = atob(bare.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - bare.length % 4) % 4));
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

/** A private P-256 key as a JWK, from its scalar and uncompressed public point. */
export function p256PrivateJwk(privateKey: Uint8Array, publicKey: Uint8Array): JsonWebKey {
	return {
		kty: "EC", crv: "P-256", ext: true,
		d: base64UrlEncode(privateKey),
		x: base64UrlEncode(publicKey.subarray(1, 33)),
		y: base64UrlEncode(publicKey.subarray(33, 65)),
	};
}

/**
 * Whether bytes are an uncompressed P-256 point WebCrypto accepts as a
 * public key: on the curve, which a 65-byte length alone does not show.
 */
export async function validP256PublicKey(bytes: Uint8Array): Promise<boolean> {
	if (bytes.byteLength !== P256_PUBLIC_KEY_BYTES || bytes[0] !== 0x04) return false;
	try {
		await crypto.subtle.importKey("raw", concat(bytes), { name: "ECDH", namedCurve: "P-256" }, false, []);
		return true;
	} catch {
		return false;
	}
}

/** HKDF-SHA-256 (RFC 5869), `bytes` long. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", concat(ikm), "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: concat(salt), info: concat(info) }, key, bytes * 8));
}

/** The application server's ephemeral ECDH key pair for one message (RFC 8291 section 3.1). */
export interface LocalKeys {
	privateKey: CryptoKey;
	/** Uncompressed, 65 bytes. */
	publicKey: Uint8Array;
}

/**
 * Encrypts one push message for a subscription (RFC 8291): a fresh ECDH key
 * pair and salt per message, one `aes128gcm` record with no padding past its
 * delimiter. `local` and `salt` exist for the RFC's test vector; leave them out.
 */
export async function encryptPushPayload(
	plaintext: Uint8Array,
	subscription: { p256dh: Uint8Array; auth: Uint8Array },
	options: { local?: LocalKeys; salt?: Uint8Array } = {},
): Promise<Uint8Array<ArrayBuffer>> {
	if (plaintext.byteLength > MAX_PUSH_PLAINTEXT_BYTES) throw new RangeError("push payload is too large");
	const uaPublic = subscription.p256dh;
	const local = options.local ?? await generateLocalKeys();
	const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
	const receiver = await crypto.subtle.importKey("raw", concat(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
	const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: receiver }, local.privateKey, 256));
	// key_info = "WebPush: info" || 0x00 || ua_public || as_public
	const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, local.publicKey);
	const ikm = await hkdf(subscription.auth, ecdhSecret, keyInfo, 32);
	const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
	const key = await crypto.subtle.importKey("raw", concat(cek), "AES-GCM", false, ["encrypt"]);
	// The last (and only) record ends with the 0x02 delimiter (RFC 8188 section 2).
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: concat(nonce) }, key, concat(plaintext, Uint8Array.of(2))));
	const header = new Uint8Array(HEADER_BYTES);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE);
	header[20] = P256_PUBLIC_KEY_BYTES;
	header.set(local.publicKey, 21);
	return concat(header, ciphertext);
}

async function generateLocalKeys(): Promise<LocalKeys> {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
	const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
	return { privateKey: pair.privateKey, publicKey };
}

/** Imported VAPID signing keys, by private key, so each one is imported once per isolate. */
const signingKeys = new Map<string, Promise<CryptoKey>>();

function signingKey(vapid: VapidKeys): Promise<CryptoKey> {
	let key = signingKeys.get(vapid.privateKey);
	if (!key) {
		const d = base64UrlDecode(vapid.privateKey);
		const point = base64UrlDecode(vapid.publicKey);
		if (!d || !point) return Promise.reject(new Error("VAPID keys are not base64url"));
		key = crypto.subtle.importKey("jwk", p256PrivateJwk(d, point), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
		// A failed import is not cached, so a fixed key takes effect without a restart.
		key.catch(() => signingKeys.delete(vapid.privateKey));
		signingKeys.set(vapid.privateKey, key);
	}
	return key;
}

/**
 * The `Authorization` header that identifies this server to the push service
 * of `endpoint` (RFC 8292 section 3): `vapid t=<ES256 JWT>, k=<public key>`,
 * the token for the endpoint's origin and valid for 12 hours from `nowMs`.
 */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, nowMs: number): Promise<string> {
	const json = (value: unknown) => base64UrlEncode(encoder.encode(JSON.stringify(value)));
	const claims = { aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1_000) + VAPID_TOKEN_SECONDS, sub: vapid.subject };
	const unsigned = `${json({ typ: "JWT", alg: "ES256" })}.${json(claims)}`;
	// WebCrypto's ECDSA signature is r || s, the JWS ES256 form (RFC 7515 appendix A.3).
	const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(vapid), encoder.encode(unsigned)));
	return `vapid t=${unsigned}.${base64UrlEncode(signature)}, k=${vapid.publicKey}`;
}

/** What the push service said about one push. */
export interface PushOutcome {
	status: number;
	/** 404 or 410: the subscription is gone and should be forgotten (RFC 8030 section 7.3). */
	gone: boolean;
}

/**
 * Sends one push message (RFC 8030 section 5): encrypted for the
 * subscription and signed with VAPID. A failure to reach the push service
 * rejects; the caller decides what a status means beyond `gone`.
 */
export async function sendWebPush(
	subscription: WebPushSubscription,
	payload: string,
	vapid: VapidKeys,
	options: { ttlSeconds: number; urgency: "very-low" | "low" | "normal" | "high"; nowMs: number; timeoutMs?: number },
): Promise<PushOutcome> {
	const p256dh = base64UrlDecode(subscription.p256dh);
	const auth = base64UrlDecode(subscription.auth);
	if (!p256dh || !auth) throw new Error("subscription keys are not base64url");
	const body = await encryptPushPayload(encoder.encode(payload), { p256dh, auth });
	const response = await fetch(subscription.url, {
		method: "POST",
		headers: {
			Authorization: await vapidAuthorization(subscription.url, vapid, options.nowMs),
			"Content-Encoding": "aes128gcm",
			"Content-Type": "application/octet-stream",
			TTL: String(options.ttlSeconds),
			Urgency: options.urgency,
		},
		body,
		// A push service answers directly; following a redirect could reach a
		// host the endpoint checks never saw.
		redirect: "manual",
		signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
	});
	// Nothing in the answer is used; release the connection.
	await response.body?.cancel().catch(() => undefined);
	return { status: response.status, gone: response.status === 404 || response.status === 410 };
}
