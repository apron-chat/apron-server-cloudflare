import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Store } from '../src/store';
import { connect as open, exchange, request, type Frame, type Peer } from './helpers/socket';

let nextIp = 1;
const stub = () => env.DEMO.getByName('public-demo-v1');
const ADMIN_TOKEN = 'admin-token-idle-bots-0123456789';
const DAY = 24 * 60 * 60_000;
const connect = (origin: string | null = 'http://localhost:5173') => open({ ip: `198.51.102.${nextIp++}`, origin });
const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

type Runtime = { store: Store; alarm(): Promise<void>; config: { adminToken?: string }; botActiveAt: Map<string, number> };

async function setAdminToken(value: string | undefined): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as Runtime;
		server.config = { ...server.config, adminToken: value };
	});
}

beforeEach(() => setAdminToken(ADMIN_TOKEN));
afterEach(() => setAdminToken(undefined));

async function signedInAdmin(): Promise<Peer> {
	const peer = await connect(null);
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token: ADMIN_TOKEN })).result.you.user_id).toBe('admin');
	return peer;
}

/** Registers a passkey user straight into the store and signs a connection in with a session token. */
async function signedIn(userId: string): Promise<Peer> {
	const token = await runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as {
			store: { registerIdentity(input: Record<string, unknown>): unknown };
			issueSession(userId: string, origin: string, now: number): Promise<string>;
		};
		runtime.store.registerIdentity({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
		return runtime.issueSession(userId, 'http://localhost:5173', Date.now());
	});
	const peer = await connect();
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
	return peer;
}

/** Runs a command in `general`; its reply, and the token in the `~private` notice before it, if any. */
async function command(peer: Peer, id: string, text: string): Promise<{ frame: Frame; token?: string }> {
	const { frame, skipped } = await exchange(peer, id, 'command', { room_id: 'general', body: { text } });
	const notice = skipped.find((candidate) => candidate.method === 'message' && candidate.params.from.user_id === '~private');
	const token = /apron_(?:bot|invite)_[A-Za-z0-9_-]+/.exec(notice?.params.body.text ?? '')?.[0];
	return { frame, ...(token ? { token } : {}) };
}

async function tokenSignIn(token: string): Promise<{ peer: Peer; frame: Frame }> {
	const peer = await connect(null);
	await peer.next();
	return { peer, frame: await request(peer, 'auth', 'auth', { scheme: 'token', token }) };
}

/** Sets users' last activity, and forgets when it was written, so the next sign-in or post writes it again. */
async function setActive(userIds: readonly string[], ms: number): Promise<void> {
	await runInDurableObject(stub(), (instance, state) => {
		for (const userId of userIds) {
			state.storage.sql.exec('UPDATE identities SET updated_ms = ? WHERE user_id = ?', ms, userId);
			(instance as unknown as Runtime).botActiveAt.delete(userId);
		}
	});
}

const activeMs = (userId: string) => runInDurableObject(stub(), (_instance, state) =>
	state.storage.sql.exec<{ updated_ms: number }>('SELECT updated_ms FROM identities WHERE user_id = ?', userId).one().updated_ms);

/** Runs the alarm, with the idle bot sweep due at `due` (absent: never swept before). */
async function sweep(due: number | null = 0): Promise<void> {
	await runInDurableObject(stub(), async (instance, state) => {
		if (due === null) state.storage.sql.exec("DELETE FROM _meta WHERE key = 'bot_sweep_ms'");
		else state.storage.sql.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('bot_sweep_ms', ?)", String(due));
		await (instance as unknown as Runtime).alarm();
	});
}

/** A user's rooms, or null when the account is gone. */
const roomsOf = (userId: string) => runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.getIdentity(userId)?.rooms ?? null);

it('signs out accounts whose only role is bot after a week without signing in or posting, keeping what they posted', async () => {
	const admin = await signedInAdmin();
	const ownerId = unique('owner');
	const owner = await signedIn(ownerId);
	const posterOwnerId = unique('poster');
	const posterOwner = await signedIn(posterOwnerId);
	const scriptId = unique('script');
	const friendId = unique('friend');
	try {
		const botId = `bot_${ownerId}`;
		const botToken = (await command(owner, 'bot', '/invite-bot')).token!;
		const posterId = `bot_${posterOwnerId}`;
		const posterToken = (await command(posterOwner, 'poster', '/invite-bot')).token!;
		// A user made a bot by /role, and one that is a bot and a friend.
		const scriptToken = (await command(admin, 'script', `/invite-token ${scriptId}`)).token!;
		expect((await command(admin, 'script-role', `/role ${scriptId} bot`)).frame.result).toEqual({});
		expect((await command(admin, 'friend', `/invite-token ${friendId}`)).frame.result).toEqual({});
		expect((await command(admin, 'friend-bot', `/role ${friendId} bot`)).frame.result).toEqual({});
		expect((await command(admin, 'friend-friend', `/role ${friendId} friend`)).frame.result).toEqual({});

		// Signing in, and posting, mark a bot active.
		const long = Date.now() - 10 * DAY;
		await setActive([botId], long);
		const signedInAt = Date.now();
		const bot = await tokenSignIn(botToken);
		expect(bot.frame.result.you.user_id).toBe(botId);
		expect(await activeMs(botId)).toBeGreaterThanOrEqual(signedInAt);
		const kept = (await request(bot.peer, 'kept', 'message', { room_id: 'general', body: { text: 'kept after sign-out' } })).result.message_id;
		const poster = await tokenSignIn(posterToken);
		await setActive([posterId], long);
		const postedAt = Date.now();
		expect((await request(poster.peer, 'post', 'message', { room_id: 'general', body: { text: 'still here' } })).result).toBeDefined();
		expect(await activeMs(posterId)).toBeGreaterThanOrEqual(postedAt);

		// Ten days without either: the bot is signed out, connected or not, as
		// is the user made a bot: out of every room, its tokens revoked, its
		// account and messages kept. The bot with another role stays, as do the
		// active ones.
		await setActive([botId, scriptId, friendId], long);
		const passive = await tokenSignIn(botToken);
		await setActive([botId], long);
		await sweep(0);
		expect(await roomsOf(botId)).toEqual([]);
		expect(await roomsOf(scriptId)).toEqual([]);
		expect(await activeMs(botId)).toBe(0);
		expect(await roomsOf(friendId)).toEqual(['general']);
		expect(await roomsOf(posterId)).toEqual(['general']);
		expect(await roomsOf(ownerId)).toEqual(['general']);
		await runInDurableObject(stub(), (_instance, state) => {
			expect(state.storage.sql.exec('SELECT author_id FROM message_state WHERE message_id = ?', kept).one().author_id).toBe(botId);
		});
		const gone = await tokenSignIn(botToken);
		expect(gone.frame.error.message).toMatch(/Bot token is not valid/);
		gone.peer.close();
		const goneScript = await tokenSignIn(scriptToken);
		expect(goneScript.frame.error.message).toMatch(/invite token is not valid/);
		goneScript.peer.close();
		// A signed-out bot is not swept again.
		await runInDurableObject(stub(), (instance, state) => {
			state.storage.sql.exec("UPDATE _meta SET value = '0' WHERE key = 'bot_sweep_ms'");
			expect((instance as unknown as Runtime).store.idleBots({ now: Date.now(), before: Date.now(), limit: 100, intervalMs: DAY, graceMs: DAY })).not.toContain(botId);
		});

		// The next sweep is a day on; the owner can invite their bot again, and it joins rooms anew.
		const due = await runInDurableObject(stub(), (_instance, state) =>
			Number(state.storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'bot_sweep_ms'").one().value));
		expect(due).toBeGreaterThanOrEqual(signedInAt + DAY);
		const again = await tokenSignIn((await command(owner, 'bot-again', '/invite-bot')).token!);
		expect(again.frame.result.you.user_id).toBe(botId);
		expect(await activeMs(botId)).toBeGreaterThan(0);
		expect((await request(again.peer, 'rejoin', 'room_join', { room_id: 'general' })).result).toBeDefined();
		again.peer.close();
		bot.peer.close();
		poster.peer.close();
		passive.peer.close();
	} finally { admin.close(); owner.close(); posterOwner.close(); }
});

it('waits a week before the first sweep, and a day between sweeps', async () => {
	const owner = unique('first');
	const peer = await signedIn(owner);
	try {
		expect((await command(peer, 'bot', '/invite-bot')).frame.result).toEqual({});
		const botId = `bot_${owner}`;
		await setActive([botId], Date.now() - 10 * DAY);
		const before = Date.now();
		// Never swept: the first sweep is set a week out, and removes nothing.
		await sweep(null);
		expect(await roomsOf(botId)).toEqual(['general']);
		const due = await runInDurableObject(stub(), (_instance, state) =>
			Number(state.storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'bot_sweep_ms'").one().value));
		expect(due).toBeGreaterThanOrEqual(before + 7 * DAY);
		// Not yet due.
		await sweep(Date.now() + DAY);
		expect(await roomsOf(botId)).toEqual(['general']);
		await sweep(0);
		expect(await roomsOf(botId)).toEqual([]);
	} finally { peer.close(); }
});
