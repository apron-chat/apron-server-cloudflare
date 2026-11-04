import { describe, expect, it } from 'vitest';
import { EMAIL_POLICY } from '../src/budget';
import { ConfigError, loadConfig } from '../src/config';
import { emailCode, emailLink, emailMessage, isEmailCode, normalizeEmail, validEmailState } from '../src/email';

describe('email sign-in building blocks (§4.11)', () => {
	it('takes plain addresses in one lowercase spelling, printable states, and uniform six-digit codes', () => {
		expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
		expect(normalizeEmail('ada.lovelace+chat@mail.example.co.uk')).toBe('ada.lovelace+chat@mail.example.co.uk');
		for (const value of [
			'', 'ada', '@example.com', 'ada@', 'ada@example', 'a@b@example.com', 'Ada <ada@example.com>', '"ada"@example.com',
			'ada@example.com\r\nBcc: eve@example.com', 'ada @example.com', '.ada@example.com', 'a..da@example.com',
			'ada@-example.com', 'ada@example.123', 'ada@[127.0.0.1]', `${'a'.repeat(65)}@example.com`, `ada@${'a'.repeat(250)}.com`, 42, null,
		]) expect(normalizeEmail(value), String(value)).toBeNull();
		expect([validEmailState('q8Rz'), validEmailState('x'.repeat(256))]).toEqual([true, true]);
		for (const state of ['', 'x'.repeat(257), 'a b', 'é']) expect(validEmailState(state), state).toBe(false);
		const codes = Array.from({ length: 200 }, emailCode);
		for (const code of codes) expect(isEmailCode(code), code).toBe(true);
		expect(new Set(codes).size).toBeGreaterThan(190);
		for (const token of ['12345', '1234567', '12345a', 'apron_email_x']) expect(isEmailCode(token), token).toBe(false);
	});

	it('writes links with the state in the fragment, and emails worded for what approving does', () => {
		expect(emailLink('https://link.apron.chat/', { server: 'wss://chat.example/ws', token: 'apron_email_Hk41x9', state: 'q8Rz' }))
			.toBe('https://link.apron.chat/#server=wss://chat.example/ws&token=apron_email_Hk41x9&state=q8Rz');
		// The page's own fragment is replaced; a state's reserved characters are encoded.
		expect(emailLink('https://web.example/login?x=1#old', { server: 'wss://chat.example/', token: 't', state: 'a&b=c#d' }))
			.toBe('https://web.example/login?x=1#server=wss://chat.example/&token=t&state=a%26b%3Dc%23d');
		const signIn = emailMessage({ server: 'Demo', code: '012345', link: 'https://link.example/#token=t', purpose: { kind: 'sign-in', userId: 'ada_1' }, minutes: 10 });
		expect(signIn.subject).toBe('012345 is your Demo code');
		expect(signIn.text).toContain('sign in to Demo as ada_1');
		expect(signIn.text).toContain('The code and the link expire in 10 minutes and work once.');
		const signUp = emailMessage({ server: 'Demo', code: '1', purpose: { kind: 'sign-up' }, minutes: 10 }).text;
		expect(signUp).toContain('create an account on Demo');
		expect(signUp).toContain('The code expires in 10 minutes and works once.');
		expect(signUp).not.toContain('link');
		expect(emailMessage({ server: 'Demo', code: '1', purpose: { kind: 'add', userId: 'ada_1' }, minutes: 10 }).text).toContain('add this address to ada_1 on Demo');
		const exists = emailMessage({ server: 'Demo', purpose: { kind: 'exists', userId: 'ada_1' }, minutes: 10 });
		expect(exists.subject).toBe('You already have an account on Demo');
		expect(exists.text).toContain('already has one (ada_1)');
		expect(exists.text).not.toMatch(/[0-9]{6}/);
		// A title cannot add header lines.
		expect(emailMessage({ server: 'Evil\r\nBcc: x', code: '1', purpose: { kind: 'sign-up' }, minutes: 1 }).subject).toBe('1 is your Evil Bcc: x code');
	});

	it('is configured only with a sender and binding, from the plan with EMAIL_<KEY> overrides, and refuses malformed settings', () => {
		const binding = { send: async () => ({ messageId: 'x' }) };
		const config = (extra: Record<string, unknown>) => loadConfig({ NODE_ENV: 'test', ...extra } as Parameters<typeof loadConfig>[0]);
		const on = { EMAIL: binding, EMAIL_FROM: 'Login@Example.com', PUBLIC_ORIGIN: 'https://chat.example' };
		expect(config({}).email).toBeUndefined();
		expect(config({ EMAIL: binding }).email).toBeUndefined();
		expect(config({ EMAIL_FROM: 'login@example.com', PUBLIC_ORIGIN: 'https://chat.example' }).email).toBeUndefined();
		expect(config(on).email).toEqual({ policy: EMAIL_POLICY, from: 'login@example.com', linkUrl: 'https://link.apron.chat/', server: 'wss://chat.example/' });
		expect(config({ ...on, EMAIL_SERVER: 'wss://chat.example/ws', EMAIL_LINK_URL: 'https://web.example/#x' }).email).toMatchObject({ server: 'wss://chat.example/ws', linkUrl: 'https://web.example/' });
		expect(config({ ...on, PUBLIC_ORIGIN: 'http://localhost:8787', EMAIL_LINK_URL: 'http://localhost:5173/' }).email).toMatchObject({ server: 'ws://localhost:8787/', linkUrl: 'http://localhost:5173/' });
		expect(EMAIL_POLICY).toMatchObject({ addressesPerUser: 1, sendsPerDay: 190 });
		expect(config({ ...on, EMAIL_ADDRESSES_PER_USER: '3', EMAIL_SENDS_PER_DAY: '50', EMAIL_PROPOSAL_SECONDS: '' }).email!.policy).toEqual({ ...EMAIL_POLICY, addressesPerUser: 3, sendsPerDay: 50 });
		for (const extra of [
			{ EMAIL_FROM: 'Login <login@example.com>' }, { EMAIL_LINK_URL: 'http://web.example/' }, { EMAIL_LINK_URL: 'javascript:alert(1)' },
			{ EMAIL_SERVER: 'https://chat.example/' }, { EMAIL_ADDRESSES_PER_USER: '0' }, { EMAIL_ADDRESSES_PER_USER: '11' },
			{ EMAIL_MAX_FAILURES: 'x' }, { EMAIL_PROPOSAL_SECONDS: '3600' }, { EMAIL_SENDS_PER_DAY: '2' },
		]) expect(() => config({ ...on, ...extra }), JSON.stringify(extra)).toThrow(ConfigError);
		expect(() => config({ EMAIL: binding, EMAIL_FROM: 'login@example.com' })).toThrow(/PUBLIC_ORIGIN or EMAIL_SERVER/);
	});
});
