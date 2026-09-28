// A `write_url` (protocol §4.6.3) is a credential: its token names the R2
// object, the largest body it accepts, and when it expires, signed with
// `UPLOAD_SIGNING_KEY`. The entry Worker checks the signature before it reads
// a byte, so a guessed or altered URL never reaches R2 or the Durable Object.

export interface UploadGrant {
	/** The R2 object key, `f/<id>` or `a/<id>`. */
	key: string;
	maxBytes: number;
	expiresMs: number;
}

const encoder = new TextEncoder();
const KEY_PATTERN = /^[fa]\/[A-Za-z0-9_-]{22}$/;

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
	const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
	try {
		return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** `<key with / as .>.<max bytes>.<expiry, seconds>`: the signed part of a token. */
function payload(grant: UploadGrant): string {
	return `${grant.key.replace("/", ".")}.${grant.maxBytes}.${Math.ceil(grant.expiresMs / 1_000)}`;
}

export async function signUploadToken(secret: string, grant: UploadGrant): Promise<string> {
	const signed = payload(grant);
	const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(signed));
	return `${signed}.${base64Url(new Uint8Array(signature))}`;
}

/** The grant a token carries if its signature holds and it has not expired, else null. */
export async function verifyUploadToken(secret: string, token: string, now = Date.now()): Promise<UploadGrant | null> {
	const parts = token.split(".");
	if (parts.length !== 5) return null;
	const [purpose, id, maxText, expiryText, signatureText] = parts;
	const key = `${purpose}/${id}`;
	if (!KEY_PATTERN.test(key) || !/^\d{1,10}$/.test(maxText) || !/^\d{1,12}$/.test(expiryText)) return null;
	const signature = fromBase64Url(signatureText);
	// Only the canonical encoding: its last character's spare bits are zero.
	if (!signature || base64Url(signature) !== signatureText) return null;
	const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, encoder.encode(parts.slice(0, 4).join(".")));
	const expiresMs = Number(expiryText) * 1_000;
	if (!valid || expiresMs <= now) return null;
	return { key, maxBytes: Number(maxText), expiresMs };
}
