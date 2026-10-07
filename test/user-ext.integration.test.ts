import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { MAX_USER_EXT_BYTES } from '../src/store';
import { connect as open, exchange, greeting, request, until, type Frame, type Peer } from './helpers/socket';

// Capability `ext` (§4.12) on users: `me` merges it one level deep, complete
// user objects carry it whole, and `user` notifications carry the keys that changed.

let nextIp = 1;
const stub = () => env.DEMO.getByName('public-demo-v1');
const connect = () => open({ ip: `198.51.100.${200 + (nextIp++ % 50)}` });
const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

/** Registers a passkey user straight into the store and returns a session token for it. */
async function register(userId: string): Promise<string> {
	return runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as {
			store: { registerIdentity(input: Record<string, unknown>): unknown };
			issueSession(userId: string, origin: string, now: number): Promise<string>;
		};
		runtime.store.registerIdentity({
			userId, name: userId, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
		return runtime.issueSession(userId, 'http://localhost:5173', Date.now());
	});
}

async function signIn(token: string): Promise<{ peer: Peer; you: Record<string, unknown> }> {
	const peer = await connect();
	await greeting(peer);
	const reply = await request(peer, 'auth', 'auth', { scheme: 'token', token });
	return { peer, you: reply.result.you };
}

let syncs = 0;
/** The `user` notifications a peer got before a round trip made now. */
async function userFrames(peer: Peer): Promise<Frame[]> {
	const id = `sync-${++syncs}`;
	peer.send({ id, method: 'me', params: {} });
	return (await until(peer, (frame) => frame.id === id)).skipped.filter((frame) => frame.method === 'user');
}

it('advertises capability ext', async () => {
	const peer = await connect();
	try {
		expect((await greeting(peer)).server.params.capabilities).toContain('ext');
	} finally { peer.close(); }
});

it('merges a user ext one level deep, sends it whole in complete objects, and only what changed in notifications (§4.12)', async () => {
	const aliceId = unique('alice');
	const bobId = unique('bob');
	const aliceToken = await register(aliceId);
	const alice = await signIn(aliceToken);
	const other = await signIn(aliceToken);
	const bob = await signIn(await register(bobId));
	try {
		expect(alice.you).not.toHaveProperty('ext');
		await userFrames(bob.peer);
		await userFrames(other.peer);

		const set = await request(alice.peer, 'set', 'me', { ext: { irc: { nick: 'ada_' }, tz: 'Europe/Oslo', flag: null } });
		expect(set.result.you.ext).toEqual({ irc: { nick: 'ada_' }, tz: 'Europe/Oslo', flag: null });
		// Others get the keys that changed; the user's other connections get `you`.
		const told = (await userFrames(bob.peer)).filter((frame) => frame.params.new?.user_id === aliceId);
		expect(told.map((frame) => frame.params.new.ext)).toEqual([{ irc: { nick: 'ada_' }, tz: 'Europe/Oslo', flag: null }]);
		expect((await userFrames(other.peer)).map((frame) => frame.params.you?.ext)).toEqual([{ irc: { nick: 'ada_' }, tz: 'Europe/Oslo', flag: null }]);

		// A key it leaves out stays; the value under a key is replaced whole.
		const tz = await request(alice.peer, 'tz', 'me', { ext: { tz: 'America/Toronto', irc: { nick: 'ada_' } } });
		expect(tz.result.you.ext).toEqual({ irc: { nick: 'ada_' }, tz: 'America/Toronto', flag: null });
		expect((await userFrames(bob.peer)).map((frame) => frame.params.new.ext)).toEqual([{ tz: 'America/Toronto' }]);

		// An empty value clears a key, announced as `""`.
		const cleared = await request(alice.peer, 'clear', 'me', { ext: { irc: '', flag: [] } });
		expect(cleared.result.you.ext).toEqual({ tz: 'America/Toronto' });
		expect((await userFrames(bob.peer)).map((frame) => frame.params.new.ext)).toEqual([{ irc: '', flag: '' }]);

		// `"ext": {}`, and a write that changes no key, change nothing and tell no one.
		expect((await request(alice.peer, 'empty', 'me', { ext: {} })).result.you.ext).toEqual({ tz: 'America/Toronto' });
		expect((await request(alice.peer, 'same', 'me', { ext: { tz: 'America/Toronto' } })).result.you.ext).toEqual({ tz: 'America/Toronto' });
		expect(await userFrames(bob.peer)).toEqual([]);

		// A merged ext past the limit is too_large, and nothing changes.
		const big = await request(alice.peer, 'big', 'me', { ext: { big: 'x'.repeat(MAX_USER_EXT_BYTES) } });
		expect(big.error.code).toBe(-32003);
		expect((await request(alice.peer, 'after-big', 'me', {})).result.you.ext).toEqual({ tz: 'America/Toronto' });
		// An ext that is not an object is invalid.
		expect((await request(alice.peer, 'bad', 'me', { ext: 'x' })).error.code).toBe(-32602);

		// A retry gets the current `you` and announces nothing again.
		await request(alice.peer, 'retry', 'me', { ext: { lang: 'nb' } });
		await userFrames(bob.peer);
		expect((await request(alice.peer, 'retry', 'me', { ext: { lang: 'nb' } })).result.you.ext).toEqual({ tz: 'America/Toronto', lang: 'nb' });
		expect(await userFrames(bob.peer)).toEqual([]);

		// Listing `users` are complete: they carry the whole ext, as stored.
		const listed = await request(bob.peer, 'list', 'room_list', { filter: 'joined', members: true });
		expect(listed.result.users.find((user: { user_id: string }) => user.user_id === aliceId).ext).toEqual({ tz: 'America/Toronto', lang: 'nb' });
		// A later sign-in reads it with the identity.
		const again = await signIn(aliceToken);
		expect(again.you.ext).toEqual({ tz: 'America/Toronto', lang: 'nb' });
		again.peer.close();
		// Recorded objects never carry it.
		const { skipped } = await exchange(alice.peer, 'post', 'message', { body: { text: 'hi' } });
		const posted = skipped.find((frame) => frame.method === 'message');
		expect(posted!.params.from).toEqual({ user_id: aliceId, name: aliceId });
	} finally { alice.peer.close(); other.peer.close(); bob.peer.close(); }
});

it('keeps no ext for guests', async () => {
	const peer = await connect();
	try {
		await greeting(peer);
		await request(peer, 'auth', 'auth', { scheme: 'guest' });
		expect((await request(peer, 'set', 'me', { ext: { tz: 'Europe/Oslo' } })).error.code).toBe(-32001);
		expect((await request(peer, 'empty', 'me', { ext: {} })).result.you).not.toHaveProperty('ext');
	} finally { peer.close(); }
});
