import { describe, expect, it } from 'vitest';
import { EMAIL_POLICY } from '../src/budget';
import { ConfigError, loadConfig } from '../src/config';
import { emailCode, emailLink, emailMessage, isEmailCode, normalizeEmail, validEmailState } from '../src/email';

describe('email addresses', () => {
	it('keeps one lowercase spelling of plain addresses', () => {
		expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
		expect(normalizeEmail('ada.lovelace+chat@mail.example.co.uk')).toBe('ada.lovelace+chat@mail.example.co.uk');
	});

	it('refuses anything that is not a plain address a sender could type', () => {
		for (const value of [
			'', 'ada', '@example.com', 'ada@', 'ada@example', 'ada@@example.com', 'a@b@example.com',
			'Ada <ada@example.com>', '"ada"@example.com', 'ada@example.com\r\nBcc: eve@example.com',
			'ada @example.com', '.ada@example.com', 'ada.@example.com', 'a..da@example.com',
			'ada@-example.com', 'ada@example.123', 'ada@[127.0.0.1]', `${'a'.repeat(65)}@example.com`,
			`ada@${'a'.repeat(250)}.com`, 42, null,
		]) expect(normalizeEmail(value), String(value)).toBeNull();
	});

	it('takes a state of printable ASCII up to 256 bytes (§4.11.1)', () => {
		expect(validEmailState('q8Rz')).toBe(true);
		expect(validEmailState('x'.repeat(256))).toBe(true);
		expect(validEmailState('x'.repeat(257))).toBe(false);
		expect(validEmailState('')).toBe(false);
		expect(validEmailState('a b')).toBe(false);
		expect(validEmailState('é')).toBe(false);
	});
});

describe('codes and links (§4.11.2)', () => {
	it('makes six-digit codes, leading zeros kept', () => {
		const codes = Array.from({ length: 200 }, emailCode);
		for (const code of codes) {
			expect(code).toMatch(/^[0-9]{6}$/);
			expect(isEmailCode(code)).toBe(true);
		}
		expect(new Set(codes).size).toBeGreaterThan(190);
		expect(isEmailCode('12345')).toBe(false);
		expect(isEmailCode('1234567')).toBe(false);
		expect(isEmailCode('12345a')).toBe(false);
	});

	it('puts the server, the token and the proposal\'s state in the fragment', () => {
		expect(emailLink('https://link.apron.chat/', { server: 'wss://chat.example/ws', token: 'apron_email_Hk41x9', state: 'q8Rz' }))
			.toBe('https://link.apron.chat/#server=wss://chat.example/ws&token=apron_email_Hk41x9&state=q8Rz');
		// The page's own fragment is replaced; a state's reserved characters are encoded.
		expect(emailLink('https://web.example/login?x=1#old', { server: 'wss://chat.example/', token: 't', state: 'a&b=c#d' }))
			.toBe('https://web.example/login?x=1#server=wss://chat.example/&token=t&state=a%26b%3Dc%23d');
	});

	it('words the email for what approving it does', () => {
		const signIn = emailMessage({ server: 'Demo', code: '012345', link: 'https://link.example/#token=t', purpose: { kind: 'sign-in', userId: 'ada_1' }, minutes: 10 });
		expect(signIn.subject).toBe('012345 is your Demo code');
		expect(signIn.text).toContain('sign in to Demo as ada_1');
		expect(signIn.text).toContain('https://link.example/#token=t');
		expect(signIn.text).toContain('The code and the link expire in 10 minutes and work once.');
		const signUp = emailMessage({ server: 'Demo', code: '1', purpose: { kind: 'sign-up' }, minutes: 10 });
		expect(signUp.text).toContain('create an account on Demo');
		expect(signUp.text).toContain('The code expires in 10 minutes and works once.');
		expect(signUp.text).not.toContain('link');
		expect(emailMessage({ server: 'Demo', code: '1', purpose: { kind: 'add', userId: 'ada_1' }, minutes: 10 }).text).toContain('add this address to ada_1 on Demo');
		// A title cannot add header lines.
		expect(emailMessage({ server: 'Evil\r\nBcc: x', code: '1', purpose: { kind: 'sign-up' }, minutes: 1 }).subject).toBe('1 is your Evil Bcc: x code');
	});
});

describe('email configuration', () => {
	const binding = { send: async () => ({ messageId: 'x' }) };
	const config = (extra: Record<string, unknown>) => loadConfig({ NODE_ENV: 'test', ...extra } as Parameters<typeof loadConfig>[0]);

	it('is off unless the deployment sets both EMAIL_FROM and the EMAIL binding', () => {
		expect(config({}).email).toBeUndefined();
		expect(config({ EMAIL: binding }).email).toBeUndefined();
		expect(config({ EMAIL_FROM: 'login@example.com', PUBLIC_ORIGIN: 'https://chat.example' }).email).toBeUndefined();
	});

	it('names the server from PUBLIC_ORIGIN, or EMAIL_SERVER, and links to EMAIL_LINK_URL or link.apron.chat', () => {
		expect(config({ EMAIL: binding, EMAIL_FROM: 'Login@Example.com', PUBLIC_ORIGIN: 'https://chat.example' }).email)
			.toEqual({ policy: EMAIL_POLICY, from: 'login@example.com', linkUrl: 'https://link.apron.chat/', server: 'wss://chat.example/' });
		expect(config({ EMAIL: binding, EMAIL_FROM: 'login@example.com', EMAIL_SERVER: 'wss://chat.example/ws', EMAIL_LINK_URL: 'https://web.example/#x' }).email)
			.toMatchObject({ server: 'wss://chat.example/ws', linkUrl: 'https://web.example/' });
		expect(config({ EMAIL: binding, EMAIL_FROM: 'login@example.com', PUBLIC_ORIGIN: 'http://localhost:8787', EMAIL_LINK_URL: 'http://localhost:5173/' }).email)
			.toMatchObject({ server: 'ws://localhost:8787/', linkUrl: 'http://localhost:5173/' });
	});

	it('refuses a malformed sender, link page or server', () => {
		const on = { EMAIL: binding, EMAIL_FROM: 'login@example.com', PUBLIC_ORIGIN: 'https://chat.example' };
		expect(() => config({ ...on, EMAIL_FROM: 'Login <login@example.com>' })).toThrow(ConfigError);
		expect(() => config({ ...on, EMAIL_LINK_URL: 'http://web.example/' })).toThrow(ConfigError);
		expect(() => config({ ...on, EMAIL_LINK_URL: 'javascript:alert(1)' })).toThrow(ConfigError);
		expect(() => config({ ...on, EMAIL_SERVER: 'https://chat.example/' })).toThrow(ConfigError);
		expect(() => config({ EMAIL: binding, EMAIL_FROM: 'login@example.com' })).toThrow(/PUBLIC_ORIGIN or EMAIL_SERVER/);
	});
});
