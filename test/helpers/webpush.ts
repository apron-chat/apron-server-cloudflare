import { base64UrlDecode, base64UrlEncode, p256PrivateJwk } from '../../src/webpush';

/** A browser's side of a push subscription: its ECDH key pair and authentication secret. */
export interface TestBrowser {
	privateKey: CryptoKey;
	/** Uncompressed public key, unpadded base64url: `keys.p256dh`. */
	p256dh: string;
	/** Unpadded base64url: `keys.auth`. */
	auth: string;
}

export async function testBrowser(): Promise<TestBrowser> {
	const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
	const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer);
	return { privateKey: pair.privateKey, p256dh: base64UrlEncode(raw), auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) };
}

/** Imports a P-256 private key for ECDH from its scalar and public point, both base64url. */
export async function importEcdhPrivateKey(privateKey: string, publicKey: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('jwk', p256PrivateJwk(base64UrlDecode(privateKey)!, base64UrlDecode(publicKey)!), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', new Uint8Array(ikm), 'HKDF', false, ['deriveBits']);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(salt), info: new Uint8Array(info) }, key, bytes * 8));
}

const text = (value: string) => new TextEncoder().encode(value);

/**
 * Decrypts an `aes128gcm` push message as the browser does (RFC 8291
 * section 3.4, RFC 8188 section 2), independently of the server's encryption
 * code: reads the header, derives the keys from the browser's private key,
 * and strips the padding delimiter.
 */
export async function decryptPush(body: Uint8Array, browser: TestBrowser): Promise<{ plaintext: string; recordSize: number; serverKey: Uint8Array }> {
	const salt = body.slice(0, 16);
	const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16);
	const idLength = body[20];
	const serverKey = body.slice(21, 21 + idLength);
	const ciphertext = body.slice(21 + idLength);
	const uaPublic = base64UrlDecode(browser.p256dh)!;
	const server = await crypto.subtle.importKey('raw', serverKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: server }, browser.privateKey, 256));
	const keyInfo = new Uint8Array([...text('WebPush: info\0'), ...uaPublic, ...serverKey]);
	const ikm = await hkdf(base64UrlDecode(browser.auth)!, ecdhSecret, keyInfo, 32);
	const cek = await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16);
	const nonce = await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12);
	const key = await crypto.subtle.importKey('raw', new Uint8Array(cek), 'AES-GCM', false, ['decrypt']);
	const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(nonce) }, key, ciphertext));
	// The last record ends with 0x02 and then only zero padding.
	let end = padded.length - 1;
	while (end >= 0 && padded[end] === 0) end--;
	if (padded[end] !== 2) throw new Error('missing last-record delimiter');
	return { plaintext: new TextDecoder().decode(padded.slice(0, end)), recordSize, serverKey };
}
