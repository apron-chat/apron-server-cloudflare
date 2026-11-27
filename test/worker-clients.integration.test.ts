import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { connect as open, exchange, greeting, request, type Peer } from './helpers/socket';

// A bot hosted on Cloudflare Workers (CF-Worker, from another zone) reaches
// the server from the address every Worker shares, so it is keyed by its
// zone and otherwise treated as any client.
const WORKER_ADDRESS = '2a06:98c0:3600::103';
const stub = () => env.DEMO.getByName('public-demo-v1');
let nextIp = 1;
let nextZone = 1;

const direct = () => open({ ip: `198.51.103.${nextIp++}` });
/** A connection from a Worker in its own zone (each is new, so tests share no limits). */
const fromWorker = (zone = `bots${nextZone++}.example.workers.dev`) => open({ ip: WORKER_ADDRESS, origin: null, headers: { 'CF-Worker': zone } });

/** Registers a passkey user straight into the store, and signs a direct connection in with a session token. */
async function signedIn(userId: string): Promise<Peer> {
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
	return peer;
}

describe('connections from Cloudflare Workers', () => {
	it('sign in with a bot token from /invite-bot and post', async () => {
		const owner = await signedIn(`owner_${crypto.randomUUID().slice(0, 8)}`);
		const bot = await fromWorker();
		try {
			const { frame, skipped } = await exchange(owner, 'bot', 'command', { room_id: 'general', body: { text: '/invite-bot' } });
			expect(frame.result).toEqual({});
			const notice = skipped.find((candidate) => candidate.method === 'message' && candidate.params.from.user_id === '~private')!;
			const token = /apron_bot_[A-Za-z0-9_-]+/.exec(notice.params.body.text)![0];
			await greeting(bot);
			expect((await request(bot, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toMatch(/^bot_/);
			const posted = await request(bot, 'post', 'message', { room_id: 'general', body: { text: 'hello from a Worker' } });
			expect(posted.error).toBeUndefined();
		} finally {
			bot.close();
			owner.close();
		}
	});

	it('are offered what any client is', async () => {
		const peer = await fromWorker();
		try {
			const { server } = await greeting(peer);
			expect(server.params.auth).toEqual(expect.arrayContaining(['token', 'guest']));
			expect((await request(peer, 'guest', 'auth', { scheme: 'guest' })).result.you.user_id).toMatch(/^guest_/);
		} finally {
			peer.close();
		}
	});

	it('are refused as a same-zone subrequest, or at the shared address without a zone', async () => {
		const upgrade = (headers: Record<string, string>) => SELF.fetch('https://demo.test/ws', { headers: { Upgrade: 'websocket', ...headers } });
		// In its own zone a Worker chooses CF-Connecting-IP, so it proves
		// nothing, even when it chooses the shared address.
		expect((await upgrade({ 'CF-Connecting-IP': '198.51.103.250', 'CF-Worker': 'demo.test' })).status).toBe(403);
		expect((await upgrade({ 'CF-Connecting-IP': WORKER_ADDRESS, 'CF-Worker': 'demo.test' })).status).toBe(403);
		expect((await upgrade({ 'CF-Connecting-IP': WORKER_ADDRESS })).status).toBe(403);
	});
});
