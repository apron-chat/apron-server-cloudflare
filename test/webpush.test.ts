import { describe, expect, it } from 'vitest';
import { PUSH_POLICY } from '../src/budget';
import { ConfigError, loadConfig, validatePushPolicy } from '../src/config';
import { FREE_PLAN } from '../src/plans/free';
import { PAID_PLAN } from '../src/plans/paid';
import {
	base64UrlDecode,
	base64UrlEncode,
	encryptPushPayload,
	MAX_PUSH_PLAINTEXT_BYTES,
	vapidAuthorization,
	validP256PublicKey,
} from '../src/webpush';
import { decryptPush, importEcdhPrivateKey, testBrowser } from './helpers/webpush';

const b64 = (value: string) => base64UrlDecode(value.replace(/\s+/g, ''))!;

// RFC 8291 Appendix A, with the whitespace the RFC wraps its values in.
const RFC = {
	plaintext: 'When I grow up, I want to be a watermelon',
	asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
	asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
	uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
	uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
	salt: 'DGv6ra1nlYgDCS1FRnbzlw',
	auth: 'BTBZMqHH6r4Tts7J_aSIgg',
	header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8',
	ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ',
};

describe('Web Push message encryption (RFC 8291)', () => {
	it('reproduces the RFC 8291 Appendix A message from its keys and salt', async () => {
		const asPublic = b64(RFC.asPublic);
		const local = { privateKey: await importEcdhPrivateKey(RFC.asPrivate, base64UrlEncode(asPublic)), publicKey: asPublic };
		const body = await encryptPushPayload(new TextEncoder().encode(RFC.plaintext), { p256dh: b64(RFC.uaPublic), auth: b64(RFC.auth) }, { local, salt: b64(RFC.salt) });
		expect(base64UrlEncode(body)).toBe(base64UrlEncode(new Uint8Array([...b64(RFC.header), ...b64(RFC.ciphertext)])));
		// And the receiver's private key recovers it.
		const browser = { privateKey: await importEcdhPrivateKey(RFC.uaPrivate, RFC.uaPublic.replace(/\s+/g, '')), p256dh: RFC.uaPublic.replace(/\s+/g, ''), auth: RFC.auth };
		const decrypted = await decryptPush(body, browser);
		expect(decrypted).toMatchObject({ plaintext: RFC.plaintext, recordSize: 4096 });
		expect(base64UrlEncode(decrypted.serverKey)).toBe(base64UrlEncode(asPublic));
	});

	it('round-trips with a fresh key pair and salt per message', async () => {
		const browser = await testBrowser();
		const keys = { p256dh: base64UrlDecode(browser.p256dh)!, auth: base64UrlDecode(browser.auth)! };
		const message = JSON.stringify({ message_id: '1', body: { text: 'héllo 👋' } });
		const first = await encryptPushPayload(new TextEncoder().encode(message), keys);
		const second = await encryptPushPayload(new TextEncoder().encode(message), keys);
		expect((await decryptPush(first, browser)).plaintext).toBe(message);
		expect((await decryptPush(second, browser)).plaintext).toBe(message);
		// A new salt and server key each time: the same message never encrypts the same.
		expect(base64UrlEncode(first.slice(0, 16))).not.toBe(base64UrlEncode(second.slice(0, 16)));
		expect(base64UrlEncode(first.slice(21, 86))).not.toBe(base64UrlEncode(second.slice(21, 86)));
		// The largest plaintext fills the 4096-byte body a push service must accept; one more byte is refused.
		const largest = await encryptPushPayload(new Uint8Array(MAX_PUSH_PLAINTEXT_BYTES), keys);
		expect(largest.byteLength).toBe(4096);
		await expect(encryptPushPayload(new Uint8Array(MAX_PUSH_PLAINTEXT_BYTES + 1), keys)).rejects.toThrow(RangeError);
	});

	it('checks that a public key is a point on P-256', async () => {
		const browser = await testBrowser();
		expect(await validP256PublicKey(base64UrlDecode(browser.p256dh)!)).toBe(true);
		const off = base64UrlDecode(browser.p256dh)!;
		off[64] ^= 1;
		expect(await validP256PublicKey(off)).toBe(false);
		expect(await validP256PublicKey(new Uint8Array(65))).toBe(false);
		expect(await validP256PublicKey(base64UrlDecode(browser.p256dh)!.slice(0, 33))).toBe(false);
	});

	it('decodes base64url only', () => {
		expect(base64UrlDecode('AQID')).toEqual(new Uint8Array([1, 2, 3]));
		expect(base64UrlDecode('AQI')).toEqual(new Uint8Array([1, 2]));
		expect(base64UrlDecode('AQI=')).toEqual(new Uint8Array([1, 2]));
		expect(base64UrlDecode('-_8')).toEqual(new Uint8Array([0xfb, 0xff]));
		for (const bad of ['+/8', 'A', 'AQ I', 'AQ==='] as const) expect(base64UrlDecode(bad)).toBeNull();
	});
});

describe('VAPID (RFC 8292)', () => {
	const keys = {
		publicKey: 'BDiU8ZnLVhCayOIihLkro6Di0XjZW7iK59umfbY--JzLTzNbhd94tTuBsIzrhXljFDqw5xn8gLqahSsSPDCauDM',
		privateKey: '64gdTp6zfZqSbwXmh7xaMx-kTVi4S34yCZxCZ2QT954',
		subject: 'mailto:push-test@example.com',
	};

	it('signs an ES256 token for the endpoint origin that the public key verifies', async () => {
		const now = Date.UTC(2026, 9, 1, 12);
		const header = await vapidAuthorization('https://push.example.net/send/abc?x=1', keys, now);
		const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
		expect(match).not.toBeNull();
		const [, head, claims, signature, k] = match!;
		expect(k).toBe(keys.publicKey);
		const json = (part: string) => JSON.parse(new TextDecoder().decode(base64UrlDecode(part)!));
		expect(json(head)).toEqual({ typ: 'JWT', alg: 'ES256' });
		expect(json(claims)).toEqual({ aud: 'https://push.example.net', exp: now / 1_000 + 12 * 3_600, sub: keys.subject });
		const verifier = await crypto.subtle.importKey('raw', base64UrlDecode(keys.publicKey)!, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
		const signed = new TextEncoder().encode(`${head}.${claims}`);
		const bytes = base64UrlDecode(signature)!;
		expect(bytes.byteLength).toBe(64);
		expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, bytes, signed)).toBe(true);
	});
});

describe('push configuration', () => {
	const base = { NODE_ENV: 'test' };
	const vapid = {
		VAPID_PUBLIC_KEY: 'BDiU8ZnLVhCayOIihLkro6Di0XjZW7iK59umfbY--JzLTzNbhd94tTuBsIzrhXljFDqw5xn8gLqahSsSPDCauDM',
		VAPID_PRIVATE_KEY: '64gdTp6zfZqSbwXmh7xaMx-kTVi4S34yCZxCZ2QT954',
		VAPID_SUBJECT: 'https://apron.chat/contact',
	};

	it('is on only with all three VAPID settings, and refuses malformed ones', () => {
		expect(loadConfig(base).push).toBeUndefined();
		expect(loadConfig({ ...base, ...vapid, VAPID_SUBJECT: '' }).push).toBeUndefined();
		expect(loadConfig({ ...base, ...vapid }).push).toEqual({ publicKey: vapid.VAPID_PUBLIC_KEY, privateKey: vapid.VAPID_PRIVATE_KEY, subject: vapid.VAPID_SUBJECT });
		expect(loadConfig({ ...base, ...vapid, VAPID_SUBJECT: 'mailto:ops@apron.chat' }).push?.subject).toBe('mailto:ops@apron.chat');
		for (const bad of [
			{ VAPID_PUBLIC_KEY: vapid.VAPID_PUBLIC_KEY.slice(1) },
			{ VAPID_PUBLIC_KEY: `${vapid.VAPID_PUBLIC_KEY}=` },
			{ VAPID_PRIVATE_KEY: vapid.VAPID_PUBLIC_KEY },
			{ VAPID_SUBJECT: 'http://apron.chat' },
			{ VAPID_SUBJECT: 'ops@apron.chat' },
		]) {
			expect(() => loadConfig({ ...base, ...vapid, ...bad })).toThrow(ConfigError);
		}
	});

	it('keeps both plans within the calibrated push bounds', () => {
		expect(PUSH_POLICY).toBeDefined();
		for (const plan of [FREE_PLAN, PAID_PLAN]) expect(() => validatePushPolicy(plan.push!)).not.toThrow();
		expect(() => validatePushPolicy({ ...PUSH_POLICY!, wakesPerMessage: 20, subscriptionsPerUser: 5 })).toThrow(ConfigError);
		expect(() => validatePushPolicy({ ...PUSH_POLICY!, pushesPerDay: 0 })).toThrow(ConfigError);
		expect(() => validatePushPolicy({ ...PUSH_POLICY!, ttlSeconds: 29 * 86_400 })).toThrow(ConfigError);
	});
});
