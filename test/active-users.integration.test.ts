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
		const posted = (await request(peer, 'post-1', 'message', { room_id: 'general', body: { text: 'hello' } })).result.message_id;
		expect(posted).toEqual(expect.any(String));
		expect((await request(peer, 'post-2', 'message', { room_id: 'general', body: { text: 'again' } })).result.message_id).toEqual(expect.any(String));
		// A retry and an edit are not new messages either.
		expect((await request(peer, 'post-1', 'message', { room_id: 'general', body: { text: 'hello' } })).result.message_id).toBe(posted);
		expect((await request(peer, 'edit', 'message', { message_id: posted, room_id: 'general', body: { text: 'edited' } })).result).toBeTruthy();
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

it('counts a guest by a keyed hash of its address key: the same for two guests on one address, and not the key itself', async () => {
	const active = await activePoints();
	const ip = `198.51.100.${nextIp++ % 250 + 1}`;
	const guests = [await connect({ ip }), await connect({ ip })];
	try {
		const ids: string[] = [];
		for (const guest of guests) {
			await greeting(guest);
			ids.push((await request(guest, 'auth', 'auth', { scheme: 'guest' })).result.you.user_id);
		}
		expect(new Set(ids).size).toBe(2);
		const ipKey = await runInDurableObject(stub(), (_instance, state) => state.getWebSockets()
			.map((socket) => socket.deserializeAttachment() as { userId?: string; ipKey: string })
			.find((attachment) => attachment.userId === ids[0])!.ipKey);
		// A guest's point is recorded once its hash is made.
		for (let tries = 0; tries < 50 && active().length < 2; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
		const points = active();
		expect(points).toHaveLength(2);
		expect(points.map((point) => point.blobs.slice(0, 3))).toEqual([['active', 'read', 'guest'], ['active', 'read', 'guest']]);
		const [who, other] = points.map((point) => point.blobs[3]);
		expect(who).toMatch(/^g:[A-Za-z0-9_-]{22}$/);
		expect(other).toBe(who);
		expect(who).not.toContain(ipKey);
	} finally { for (const guest of guests) guest.close(); }
});
