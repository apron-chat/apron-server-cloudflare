import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { PRIVATE_ROOM_PREFIX } from '../src/store';
import { connect as open, exchange, greeting, request, until, type Frame, type Peer } from './helpers/socket';

// Private rooms over the socket (§4.2.4): only members list, read, post in,
// or add to one, and everyone else is answered as for a room that does not exist.

let nextIp = 0;
const RANGES = ['192.0.2', '198.51.100', '203.0.113'];
const stub = () => env.DEMO.getByName('public-demo-v1');
/** A connection from an address of its own, so per-address limits never couple the checks. */
const connect = () => { const n = nextIp++; return open({ ip: `${RANGES[n % 3]}.${10 + Math.floor(n / 3)}` }); };
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

/** A new connection signed in with `token`, or as a guest without one. */
async function session(token?: string): Promise<Peer> {
	const peer = await connect();
	await greeting(peer);
	const reply = await request(peer, 'auth', 'auth', token ? { scheme: 'token', token } : { scheme: 'guest' });
	expect(reply.result.you).toBeDefined();
	return peer;
}

async function signedIn(prefix: string): Promise<{ peer: Peer; userId: string; token: string }> {
	const userId = unique(prefix);
	const token = await register(userId);
	return { peer: await session(token), userId, token };
}

const joinedRecord = (frames: Frame[]) => frames.find((frame) => frame.method === 'room_update' && frame.params.joined)?.params.joined[0];

it('creates a private room only its creator lists, and adds a member who then sees it', async () => {
	const ada = await signedIn('ada');
	const bob = await signedIn('bob');
	try {
		const created = await exchange(ada.peer, 'create', 'room_set', { private: true });
		const roomId = created.frame.result.room_id as string;
		expect(roomId.startsWith(PRIVATE_ROOM_PREFIX)).toBe(true);
		// The joined record says private, so the client may post (§4.2.4).
		expect(joinedRecord(created.skipped)).toMatchObject({ room_id: roomId, private: true });
		expect(joinedRecord(created.skipped)).not.toHaveProperty('title');
		const adaList = await request(ada.peer, 'ada-list', 'room_list', { filter: 'joined' });
		expect(adaList.result.joined.map((room: { room_id: string }) => room.room_id)).toContain(roomId);
		const bobList = await request(bob.peer, 'bob-list', 'room_list', {});
		expect([...bobList.result.joined, ...bobList.result.not_joined].map((room: { room_id: string }) => room.room_id)).not.toContain(roomId);

		// Ada adds Bob: his connections get the room with its members.
		const added = await exchange(ada.peer, 'add', 'room_join', { room_id: roomId, user_id: bob.userId });
		expect(added.frame.result).toEqual({});
		const joined = await until(bob.peer, (frame) => frame.method === 'room_update' && frame.params.joined?.[0]?.room_id === roomId);
		expect(joined.frame.params.joined[0]).toMatchObject({ private: true });
		expect(joined.frame.params.joined[0].members.map((member: { user_id: string }) => member.user_id).sort()).toEqual([ada.userId, bob.userId].sort());
		const posted = await request(bob.peer, 'post', 'message', { room_id: roomId, body: { text: 'hi Ada' } });
		expect(posted.result.message_id).toBeDefined();
		const page = await request(bob.peer, 'history', 'history', { room_id: roomId });
		expect(page.result.messages.map((message: { message_id: string }) => message.message_id)).toContain(posted.result.message_id);
		const listed = await request(bob.peer, 'bob-listed', 'room_list', { room_id: roomId, members: true });
		expect(listed.result.joined[0]).toMatchObject({ room_id: roomId, private: true });
	} finally { ada.peer.close(); bob.peer.close(); }
});

it('answers every request about a private room someone is not in exactly as for one that does not exist', async () => {
	const ada = await signedIn('ada');
	const bob = await signedIn('bob');
	const carol = await signedIn('carol');
	try {
		const roomId = (await exchange(ada.peer, 'create', 'room_set', { private: true })).frame.result.room_id as string;
		const secret = (await request(ada.peer, 'secret', 'message', { room_id: roomId, body: { text: 'just us' } })).result.message_id as string;
		const missingRoom = `${PRIVATE_ROOM_PREFIX}1`;
		const missingMessage = '1';
		const probes = (room: string, message: string): Array<[string, Record<string, unknown>]> => [
			['room_list', { room_id: room }],
			['room_list', { parent_room_id: room }],
			['history', { room_id: room }],
			['message', { room_id: room, body: { text: 'hello?' } }],
			['message', { message_id: message, body: { text: 'mine now' } }],
			['message', { room_id: 'general', body: { text: 'replying' }, reply_to: { message_id: message } }],
			['reactions', { message_id: message, emojis: ['👍'] }],
			['room_join', { room_id: room }],
			['room_join', { room_id: room, user_id: carol.userId }],
			['room_leave', { room_id: room }],
			['room_set', { room_id: room, title: 'Mine' }],
			['room_set', { parent_room_id: room, title: 'Side' }],
			['command', { room_id: room, body: { text: '/help' } }],
			['status', { room_id: room, mute: 60 }],
		];
		const real = probes(roomId, secret);
		const fake = probes(missingRoom, missingMessage);
		// Bob, signed in, and a guest. Each pair on a connection of its own: a
		// third refused request in a minute closes one (repeatedPolicyViolations).
		for (const token of [bob.token, undefined]) {
			for (let index = 0; index < real.length; index += 1) {
				const peer = await session(token);
				try {
					const [method, params] = real[index];
					const onReal = await request(peer, 'real', method, params);
					const onFake = await request(peer, 'fake', fake[index][0], fake[index][1]);
					expect(onReal.error, `${method} ${JSON.stringify(params)}`).toBeDefined();
					expect({ method, params, error: onReal.error }).toEqual({ method, params, error: onFake.error });
				} finally { peer.close(); }
			}
		}
		// Nothing reached the room.
		const page = await request(ada.peer, 'page', 'history', { room_id: roomId });
		expect(page.result.messages.map((message: { message_id: string }) => message.message_id)).toEqual([secret]);
	} finally { ada.peer.close(); bob.peer.close(); carol.peer.close(); }
}, 60_000);

it('lets members add others while adding is turned off elsewhere, and removes the room when its last member leaves', async () => {
	const ada = await signedIn('ada');
	const bob = await signedIn('bob');
	const carol = await signedIn('carol');
	await runInDurableObject(stub(), (instance) => { (instance as unknown as { toggles: Map<string, boolean> }).toggles.set('addmember', false); });
	try {
		const roomId = (await exchange(ada.peer, 'create', 'room_set', { private: true, title: 'Plans' })).frame.result.room_id as string;
		// Adding to a public room is off, but a private room's members still add people.
		const publicAdd = await request(ada.peer, 'public-add', 'room_join', { room_id: 'general', user_id: carol.userId });
		expect(publicAdd.error.code).toBe(-32001);
		expect((await request(ada.peer, 'add-bob', 'room_join', { room_id: roomId, user_id: bob.userId })).result).toEqual({});
		await until(bob.peer, (frame) => frame.method === 'room_update' && frame.params.joined?.[0]?.room_id === roomId);
		expect((await request(bob.peer, 'add-carol', 'room_join', { room_id: roomId, user_id: carol.userId })).result).toEqual({});
		await until(carol.peer, (frame) => frame.method === 'room_update' && frame.params.joined?.[0]?.room_id === roomId);
		// Guests are never added.
		expect((await request(ada.peer, 'add-guest', 'room_join', { room_id: roomId, user_id: 'guest_1' })).error.code).toBe(-32602);

		for (const member of [ada, bob, carol]) {
			const left = await exchange(member.peer, `leave-${member.userId}`, 'room_leave', { room_id: roomId });
			expect(left.skipped.some((frame) => frame.method === 'room_update' && frame.params.left?.[0]?.room_id === roomId)).toBe(true);
		}
		// Gone: even its last member cannot find it now.
		expect((await request(carol.peer, 'gone', 'room_list', { room_id: roomId })).error.code).toBe(-32602);
	} finally {
		await runInDurableObject(stub(), (instance) => { (instance as unknown as { toggles: Map<string, boolean> }).toggles.delete('addmember'); });
		ada.peer.close(); bob.peer.close(); carol.peer.close();
	}
});

it('advertises how many private rooms one user may be in', async () => {
	const peer = await connect();
	try {
		const { server } = await greeting(peer);
		expect(server.params.ext.settings.private_rooms).toBeGreaterThan(0);
	} finally { peer.close(); }
});
