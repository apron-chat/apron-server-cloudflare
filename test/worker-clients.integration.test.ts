import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect as open, exchange, greeting, request, type Frame, type Peer } from './helpers/socket';

// A bot hosted on Cloudflare Workers (CF-Worker, from another zone) reaches
// the server from the address every Worker shares, so it is keyed by its
// zone, and signs in with a token for an existing account only.
const WORKER_ADDRESS = '2a06:98c0:3600::103';
/** The protocol's error codes (§2). */
const UNSUPPORTED = -32601;
const DENIED = -32001;
const stub = () => env.DEMO.getByName('public-demo-v1');
const ADMIN_TOKEN = 'admin-token-worker-clients-0123456789';
let nextIp = 1;
let nextZone = 1;

type Runtime = { config: { adminToken?: string } };

async function setAdminToken(value: string | undefined): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as Runtime;
		server.config = { ...server.config, adminToken: value };
	});
}

beforeEach(() => setAdminToken(ADMIN_TOKEN));
afterEach(() => setAdminToken(undefined));

const direct = (origin: string | null = 'http://localhost:5173') => open({ ip: `198.51.103.${nextIp++}`, origin });
/** A connection from a Worker in its own zone (each test's zone is new, so their limits are not shared). */
const fromWorker = (zone = `bots${nextZone++}.example.workers.dev`) => open({ ip: WORKER_ADDRESS, origin: null, headers: { 'CF-Worker': zone } });

/** Registers a passkey user straight into the store, and signs a direct connection in with a session token. */
async function signedIn(userId: string): Promise<{ peer: Peer }> {
	const token = await runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as {
			store: { accounts: { register(input: Record<string, unknown>): unknown } };
			issueSession(userId: string, origin: string, now: number): Promise<string>;
		};
		runtime.store.accounts.register({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
		return runtime.issueSession(userId, 'http://localhost:5173', Date.now());
	});
	const peer = await direct();
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
	return { peer };
}

/** Runs a command in `general`: its reply, and the `~private` notice before it, if any. */
async function command(peer: Peer, id: string, text: string): Promise<{ frame: Frame; notice?: Frame }> {
	const { frame, skipped } = await exchange(peer, id, 'command', { room_id: 'general', body: { text } });
	const notice = skipped.find((candidate) => candidate.method === 'message' && candidate.params.from.user_id === '~private');
	return { frame, ...(notice ? { notice } : {}) };
}

const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

describe('connections from Cloudflare Workers', () => {
	it('are admitted under their zone, offered token sign-in alone', async () => {
		const peer = await fromWorker();
		try {
			const { server, welcome } = await greeting(peer);
			expect(welcome.params.body.text).toContain('sign in with a token');
			expect(server.params.auth).toEqual(['token']);
			expect(server.params.signup).toEqual([]);
		} finally {
			peer.close();
		}
		// A direct client is offered everything, guest included.
		const person = await direct();
		try {
			const { server } = await greeting(person);
			expect(server.params.auth).toContain('guest');
			expect(server.params.signup).toContain('token');
		} finally {
			person.close();
		}
	});

	it('cannot be a guest or sign up, and stay unsigned-in', async () => {
		const peer = await fromWorker();
		try {
			await greeting(peer);
			const guest = await request(peer, 'guest', 'auth', { scheme: 'guest' });
			expect(guest.error.code).toBe(UNSUPPORTED);
			expect(guest.error.message).toMatch(/Cloudflare Worker/);
			expect((await request(peer, 'passkey', 'auth', { scheme: 'webauthn', action: 'register', step: 'begin' })).error.code).toBe(UNSUPPORTED);
			// A sign-up invite creates an account, so it is refused too.
			const admin = await direct(null);
			try {
				await admin.next();
				expect((await request(admin, 'admin', 'auth', { scheme: 'token', token: ADMIN_TOKEN })).result.you.user_id).toBe('admin');
				const minted = await command(admin, 'invite', '/invite-code 1');
				const invite = /apron_join_[A-Za-z0-9_-]+/.exec(minted.notice!.params.body.text)![0];
				const join = await request(peer, 'join', 'auth', { scheme: 'token', token: invite });
				expect(join.error.code).toBe(DENIED);
				expect(join.error.message).toMatch(/Cloudflare Worker/);
				await command(admin, 'revoke', '/invite-code 0');
			} finally {
				admin.close();
			}
			expect((await request(peer, 'post', 'message', { room_id: 'general', body: { text: 'hi' } })).error.code).toBe(DENIED);
		} finally {
			peer.close();
		}
	});

	it('sign in with a bot token from /invite-bot and post', async () => {
		const owner = await signedIn(unique('owner'));
		const bot = await fromWorker();
		try {
			const minted = await command(owner.peer, 'bot', '/invite-bot');
			expect(minted.frame.result).toEqual({});
			const token = /apron_bot_[A-Za-z0-9_-]+/.exec(minted.notice!.params.body.text)![0];
			await greeting(bot);
			const signed = await request(bot, 'auth', 'auth', { scheme: 'token', token });
			expect(signed.result.you.user_id).toMatch(/^bot_/);
			const posted = await request(bot, 'post', 'message', { room_id: 'general', body: { text: 'hello from a Worker' } });
			expect(posted.error).toBeUndefined();
			expect(posted.result).toBeDefined();
		} finally {
			bot.close();
			owner.peer.close();
		}
	});

	it('sign in with a device token from /invite-device', async () => {
		const userId = unique('person');
		const person = await signedIn(userId);
		const peer = await fromWorker();
		try {
			const minted = await command(person.peer, 'device', '/invite-device add');
			const token = /apron_device_[A-Za-z0-9_-]+/.exec(minted.notice!.params.body.text)![0];
			await greeting(peer);
			expect((await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
		} finally {
			peer.close();
			person.peer.close();
		}
	});

	it('are refused as a same-zone subrequest, or at the shared address without a zone', async () => {
		const upgrade = (headers: Record<string, string>) => SELF.fetch('https://demo.test/ws', { headers: { Upgrade: 'websocket', ...headers } });
		// In its own zone a Worker chooses CF-Connecting-IP, so it proves nothing.
		expect((await upgrade({ 'CF-Connecting-IP': '198.51.103.250', 'CF-Worker': 'demo.test' })).status).toBe(403);
		// Even at the shared address, which it may choose too.
		expect((await upgrade({ 'CF-Connecting-IP': WORKER_ADDRESS, 'CF-Worker': 'demo.test' })).status).toBe(403);
		expect((await upgrade({ 'CF-Connecting-IP': WORKER_ADDRESS })).status).toBe(403);
	});

	it('cannot be claimed by a direct client with the internal marker', async () => {
		const peer = await open({ ip: `198.51.103.${nextIp++}`, headers: { 'X-Apron-Worker-Client': '1' } });
		try {
			const { server } = await greeting(peer);
			expect(server.params.auth).toContain('guest');
			expect((await request(peer, 'guest', 'auth', { scheme: 'guest' })).result.you.user_id).toMatch(/^guest_/);
		} finally {
			peer.close();
		}
	});
});
