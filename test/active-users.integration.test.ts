import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { type Store } from '../src/store';
import { connect, greeting, request, type Peer } from './helpers/socket';

const stub = () => env.DEMO.getByName('public-demo-v1');
const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
let nextIp = 1;

type Point = { indexes: string[]; blobs: string[]; doubles: number[] };
type Metered = { runtimeEnv: { METRICS?: unknown } };

afterEach(async () => {
	vi.restoreAllMocks();
	await runInDurableObject(stub(), (instance) => { delete (instance as unknown as Metered).runtimeEnv.METRICS; });
});

/** Captures the points the object writes from now on; the returned function gives the `active` ones. */
async function activePoints(): Promise<() => Point[]> {
	const points: Point[] = [];
	await runInDurableObject(stub(), (instance) => {
		(instance as unknown as Metered).runtimeEnv.METRICS = { writeDataPoint: (point: Point) => { points.push(point); } };
	});
	return () => points.filter((point) => point.indexes[0] === 'active');
}

/** A registered user, signed in on a new connection. */
async function signedIn(userId: string): Promise<Peer> {
	const token = await runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as { store: Store; issueSession(userId: string, origin: string, now: number): Promise<string> };
		runtime.store.registerIdentity({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
		return runtime.issueSession(userId, 'http://localhost:5173', Date.now());
	});
	const peer = await connect({ ip: `198.51.100.${nextIp++ % 250 + 1}` });
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
	return peer;
}

it('counts a registered user active once a day per connection: read at sign-in or a frame, write at a new message', async () => {
	const active = await activePoints();
	const userId = unique('active');
	const peer = await signedIn(userId);
	try {
		expect(active()).toEqual([{ indexes: ['active'], blobs: ['active', 'read', 'registered', userId], doubles: [1] }]);
		// More frames and messages the same day add nothing to read, and write once.
		expect((await request(peer, 'list', 'room_list', {})).result).toBeTruthy();
		expect((await request(peer, 'post-1', 'message', { room_id: 'general', body: { text: 'hello' } })).result.message_id).toEqual(expect.any(String));
		expect((await request(peer, 'post-2', 'message', { room_id: 'general', body: { text: 'again' } })).result.message_id).toEqual(expect.any(String));
		expect(active().map((point) => point.blobs.slice(1))).toEqual([['read', 'registered', userId], ['write', 'registered', userId]]);
		// The next UTC day, the same connection counts again: its first frame, then its first message.
		const realNow = Date.now.bind(Date);
		vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 86_400_000);
		expect((await request(peer, 'list-2', 'room_list', {})).result).toBeTruthy();
		expect((await request(peer, 'post-3', 'message', { room_id: 'general', body: { text: 'tomorrow' } })).result.message_id).toEqual(expect.any(String));
		expect(active().map((point) => point.blobs.slice(1))).toEqual([
			['read', 'registered', userId], ['write', 'registered', userId],
			['read', 'registered', userId], ['write', 'registered', userId],
		]);
	} finally { peer.close(); }
});

it('counts a guest by its address key, since its id is new at each sign-in', async () => {
	const active = await activePoints();
	const guest = await connect({ ip: `198.51.100.${nextIp++ % 250 + 1}` });
	try {
		await greeting(guest);
		expect((await request(guest, 'auth', 'auth', { scheme: 'guest' })).result.you.user_id).toMatch(/^guest_/);
		const ipKey = await runInDurableObject(stub(), (_instance, state) => {
			const mine = state.getWebSockets().map((socket) => socket.deserializeAttachment() as { tier: string; activeDay?: string; ipKey: string })
				.filter((attachment) => attachment.tier === 'anonymous' && attachment.activeDay);
			return mine.at(-1)!.ipKey;
		});
		expect(active()).toEqual([{ indexes: ['active'], blobs: ['active', 'read', 'guest', `ip:${ipKey}`], doubles: [1] }]);
	} finally { guest.close(); }
});
