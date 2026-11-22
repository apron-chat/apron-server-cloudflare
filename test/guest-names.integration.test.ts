import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { connect as open, request, until, type Frame, type Peer } from './helpers/socket';
import { softPasskey } from './helpers/webauthn';

/**
 * Guests' display names (`me` `name`, §3.3): kept on the connection,
 * checked and charged as a registered user's, announced as any profile
 * change, and carried over when the guest makes an account.
 */

let nextIp = 1;
const stub = () => env.DEMO.getByName('public-demo-v1');
const ORIGIN = 'http://localhost:5173';
const connect = () => open({ ip: `198.51.105.${nextIp++}`, origin: ORIGIN });

async function guest(): Promise<{ peer: Peer; you: Frame['result'] }> {
	const peer = await connect();
	await peer.next();
	await peer.next();
	const auth = await request(peer, 'auth', 'auth', { scheme: 'guest' });
	return { peer, you: auth.result.you };
}

/** Sets a runtime or store field for the test, returning what it was. */
async function setGuestPosting(on: boolean): Promise<boolean> {
	return runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as { config: { guestPosting: boolean } };
		const before = server.config.guestPosting;
		server.config = { ...server.config, guestPosting: on };
		return before;
	});
}

async function guestPostsPerMinute(value: number): Promise<number> {
	return runInDurableObject(stub(), (instance) => {
		const store = (instance as unknown as { store: { ops: { config: { guestPostsPerMinute: number } } } }).store.ops;
		const previous = store.config.guestPostsPerMinute;
		store.config.guestPostsPerMinute = value;
		return previous;
	});
}

it('lets a guest set and clear its name, announced to those who share a room, and stores nothing', async () => {
	const ada = await guest();
	const watcher = await guest();
	try {
		const guestId = ada.you.user_id;
		const number = guestId.slice('guest_'.length);
		expect(ada.you.name).toBe(`Guest ${number}`);
		const set = await request(ada.peer, 'name', 'me', { name: 'Ada L' });
		expect(set.result.you).toMatchObject({ user_id: guestId, name: 'Ada L' });
		const seen = await until(watcher.peer, (frame) => frame.method === 'user' && frame.params.new?.user_id === guestId);
		expect(seen.frame.params.new.name).toBe('Ada L');
		// Its messages carry the name.
		await request(ada.peer, 'post', 'message', { room_id: 'general', body: { text: 'hello' } });
		const posted = await until(watcher.peer, (frame) => frame.method === 'message' && frame.params.from?.user_id === guestId);
		expect(posted.frame.params.from.name).toBe('Ada L');
		// `""` returns to the generated name.
		expect((await request(ada.peer, 'clear', 'me', { name: '' })).result.you.name).toBe(`Guest ${number}`);
		const back = await until(watcher.peer, (frame) => frame.method === 'user' && frame.params.new?.user_id === guestId);
		expect(back.frame.params.new.name).toBe(`Guest ${number}`);
		const rows = await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec('SELECT * FROM identities WHERE user_id = ?', guestId).toArray());
		expect(rows).toEqual([]);
	} finally { ada.peer.close(); watcher.peer.close(); }
});

it('checks a guest\'s name as a registered user\'s, and charges it to the guests\' posting limit', async () => {
	const { peer } = await guest();
	const other = await guest();
	const limit = await guestPostsPerMinute(2);
	try {
		expect((await request(peer, 'long', 'me', { name: 'x'.repeat(200) })).error.code).toBe(-32003);
		expect((await request(other.peer, 'number', 'me', { name: 7 })).error.code).toBe(-32602);
		expect((await request(peer, 'one', 'me', { name: 'One' })).result.you.name).toBe('One');
		expect((await request(peer, 'two', 'me', { name: 'Two' })).result.you.name).toBe('Two');
		const limited = await request(peer, 'three', 'me', { name: 'Three' });
		expect(limited.error.code).toBe(-32002);
		// A `me` names no limit category, as a registered user's does.
		expect(limited.error.data.ext).toBeUndefined();
		expect((await request(peer, 'check', 'me', {})).result.you.name).toBe('Two');
	} finally { await guestPostsPerMinute(limit); peer.close(); other.peer.close(); }
});

it('lets a guest that only reads name itself, but not keep ext', async () => {
	const before = await setGuestPosting(false);
	const { peer } = await guest();
	try {
		expect((await request(peer, 'name', 'me', { name: 'Reader' })).result.you).toMatchObject({ name: 'Reader', ext: { permissions: { write: false } } });
		expect((await request(peer, 'ext', 'me', { ext: { color: 'red' } })).error.code).toBe(-32001);
	} finally { await setGuestPosting(before); peer.close(); }
});

it('carries a guest\'s name over to the account its passkey makes', async () => {
	const { peer } = await guest();
	try {
		expect((await request(peer, 'name', 'me', { name: 'Grace H' })).result.you.name).toBe('Grace H');
		const passkey = await softPasskey(ORIGIN);
		const begun = await request(peer, 'begin', 'auth', { scheme: 'webauthn', action: 'register', step: 'begin' });
		const finished = await request(peer, 'finish', 'auth', { scheme: 'webauthn', action: 'register', step: 'finish', challenge_id: begun.result.challenge_id, credential: await passkey.register(begun.result.public_key) });
		expect(finished.result.you.name).toBe('Grace H');
		expect(finished.result.you.user_id).toMatch(/^grace_h_\d{4}$/);
	} finally { peer.close(); }
});

it('cleans names on every way in: me (guests and members), a passkey registration, and a sign-up invite', async () => {
	// A guest's: cleaned, and one that cleans to nothing is the generated name.
	const { peer, you } = await guest();
	try {
		expect((await request(peer, 'dirty', 'me', { name: '  \u202EAda\u0007   L\u200B ' })).result.you.name).toBe('Ada L');
		expect((await request(peer, 'empty', 'me', { name: '\u200B\u0000' })).result.you.name).toBe(`Guest ${you.user_id.slice('guest_'.length)}`);
		// A passkey registration's begin `name`.
		const passkey = await softPasskey(ORIGIN);
		const begun = await request(peer, 'begin', 'auth', { scheme: 'webauthn', action: 'register', step: 'begin', name: '\uFF27\uFF52\uFF41\uFF43\uFF45\u202E  Hopper\u0000' });
		const finished = await request(peer, 'finish', 'auth', { scheme: 'webauthn', action: 'register', step: 'finish', challenge_id: begun.result.challenge_id, credential: await passkey.register(begun.result.public_key) });
		expect(finished.result.you.name).toBe('Grace Hopper');
		// A member's `me`: cleaned; one that cleans to nothing removes the name.
		expect((await request(peer, 'member', 'me', { name: '\uFB01ne\u200D  name' })).result.you.name).toBe('fine name');
		expect((await request(peer, 'member-empty', 'me', { name: '\u2066\u2069' })).result.you.name).toBe('');
		// Too long after cleaning is still refused.
		expect((await request(peer, 'long', 'me', { name: `${'x'.repeat(200)}\u200B` })).error.code).toBe(-32003);
	} finally { peer.close(); }
	// A sign-up invite's name.
	const token = await runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as { ctx: DurableObjectState; config: { limits: unknown } };
		const raw = `apron_join_${'a'.repeat(43)}`;
		const key = `join-token:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
		await runtime.ctx.storage.put(key, { v: 1, remaining: 1, expiresMs: Date.now() + 60_000 });
		return raw;
	});
	const joiner = await connect();
	try {
		await joiner.next();
		await joiner.next();
		const joined = await request(joiner, 'join', 'auth', { scheme: 'token', token, name: '\u0007Lin\u00A0\u00A0 Wu\u202C' });
		expect(joined.result.you.name).toBe('Lin Wu');
		// Its bot's name comes from its name, cleaned too.
		const userId = joined.result.you.user_id;
		expect((await request(joiner, 'bot', 'command', { room_id: 'general', body: { text: '/invite-bot' } })).result).toEqual({});
		const botName = await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ name: string }>('SELECT name FROM identities WHERE user_id = ?', `bot_${userId}`).one().name);
		expect(botName).toBe('Bot of Lin Wu');
	} finally { joiner.close(); }
});
