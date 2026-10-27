import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Store } from '../src/store';
import { connect as open, exchange, request, until, type Frame, type Peer } from './helpers/socket';

let nextIp = 1;
const stub = () => env.DEMO.getByName('public-demo-v1');
const connect = () => open({ ip: `198.19.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}` });
const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

type Attachment = { userId?: string; reads?: Record<string, string>; readsAt?: number };
type Runtime = {
	store: Store;
	config: { activityEnabled: boolean };
	issueSession(userId: string, origin: string, now: number): Promise<string>;
	alarm(): Promise<void>;
	ctx: DurableObjectState;
};

const runtime = <T>(fn: (runtime: Runtime) => T | Promise<T>) => runInDurableObject(stub(), (instance) => fn(instance as unknown as Runtime));

beforeAll(async () => { await runtime((server) => { server.config = { ...server.config, activityEnabled: true }; }); });
afterAll(async () => { await runtime((server) => { server.config = { ...server.config, activityEnabled: false }; }); });

async function register(userId: string): Promise<void> {
	await runtime(({ store }) => {
		store.registerIdentity({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
	});
}

/** A connection signed in as `userId`, and the `server` frame it opened with. */
async function signIn(userId: string): Promise<{ peer: Peer; server: Frame }> {
	const token = await runtime((server) => server.issueSession(userId, 'http://localhost:5173', Date.now()));
	const peer = await connect();
	const server = await peer.next();
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
	return { peer, server };
}

/** The frames `peer` got before the reply to a request sent now. */
async function drain(peer: Peer): Promise<Frame[]> {
	return (await exchange(peer, `sync-${crypto.randomUUID()}`, 'me', {})).skipped;
}

const reads = (frames: Frame[]) => frames.filter((frame) => frame.method === 'activity' && frame.params.read_message_id !== undefined).map((frame) => frame.params);
const kept = (userId: string) => runtime(({ store }) => Object.fromEntries(store.readCursors(userId)));
const attachments = (userId: string) => runtime(({ ctx }) => ctx.getWebSockets()
	.map((ws) => ws.deserializeAttachment() as Attachment)
	.filter((attachment) => attachment.userId === userId));

async function post(peer: Peer, text: string): Promise<string> {
	return (await request(peer, `post-${crypto.randomUUID()}`, 'message', { room_id: 'general', body: { text } })).result.message_id;
}

it('advertises read cursors with activity, relays one to the user\'s other connections only, and keeps it', async () => {
	const ada = unique('ada');
	const bob = unique('bob');
	await register(ada);
	await register(bob);
	const first = await signIn(ada);
	const second = await signIn(ada);
	const other = await signIn(bob);
	try {
		expect(first.server.params.ext.settings.read_cursors).toBe(true);
		const one = await post(other.peer, 'one');
		await drain(first.peer);
		await drain(second.peer);
		first.peer.send({ method: 'activity', params: { room_id: 'general', read_message_id: one } });
		const relayed = await until(second.peer, (frame) => frame.method === 'activity');
		expect(relayed.frame.params).toEqual({ room_id: 'general', from: { user_id: ada, name: `Name of ${ada}` }, read_message_id: one });
		// Not echoed to the sender, nor shown to anyone else: no read receipts.
		expect(reads(await drain(first.peer))).toEqual([]);
		expect(reads(await drain(other.peer))).toEqual([]);
		// The connection's first cursor is written at once.
		expect(await kept(ada)).toEqual({ general: one });
	} finally { first.peer.close(); second.peer.close(); other.peer.close(); }
});

it('writes a connection\'s cursors at most once a minute, sends the furthest after a listing, and writes the rest on close', async () => {
	const ada = unique('ada');
	await register(ada);
	const first = await signIn(ada);
	try {
		const one = await post(first.peer, 'one');
		const two = await post(first.peer, 'two');
		const three = await post(first.peer, 'three');
		first.peer.send({ method: 'activity', params: { room_id: 'general', read_message_id: one } });
		await drain(first.peer);
		expect(await kept(ada)).toEqual({ general: one });
		// Within the minute: kept on the connection, not written.
		first.peer.send({ method: 'activity', params: { room_id: 'general', read_message_id: three } });
		// One not past the one kept is dropped.
		first.peer.send({ method: 'activity', params: { room_id: 'general', read_message_id: two } });
		await drain(first.peer);
		expect(await kept(ada)).toEqual({ general: one });
		expect((await attachments(ada)).map((attachment) => attachment.reads)).toEqual([{ general: three }]);
		// Another device's listing gets the furthest: the unwritten one.
		const second = await signIn(ada);
		const listing = await exchange(second.peer, 'list', 'room_list', { filter: 'joined' });
		expect(listing.frame.result.joined.map((room: { room_id: string }) => room.room_id)).toContain('general');
		expect(reads(await drain(second.peer))).toEqual([{ room_id: 'general', from: { user_id: ada, name: `Name of ${ada}` }, read_message_id: three }]);
		// Closing writes it.
		first.peer.close();
		await vi.waitFor(async () => expect(await kept(ada)).toEqual({ general: three }));
		second.peer.close();
	} finally { first.peer.close(); }
});

it('writes a connection\'s cursors at the next alarm once a minute has passed', async () => {
	const ada = unique('ada');
	await register(ada);
	const first = await signIn(ada);
	try {
		const one = await post(first.peer, 'one');
		const two = await post(first.peer, 'two');
		first.peer.send({ method: 'activity', params: { room_id: 'general', read_message_id: one } });
		first.peer.send({ method: 'activity', params: { room_id: 'general', read_message_id: two } });
		await drain(first.peer);
		expect(await kept(ada)).toEqual({ general: one });
		const realNow = Date.now.bind(Date);
		vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);
		try {
			await runtime((server) => server.alarm());
		} finally { vi.restoreAllMocks(); }
		expect(await kept(ada)).toEqual({ general: two });
		expect((await attachments(ada)).map((attachment) => attachment.reads)).toEqual([undefined]);
	} finally { first.peer.close(); }
});

it('keeps no cursor for a room the user has not joined, nor a guest\'s, and a leave deletes the one kept', async () => {
	const ada = unique('ada');
	await register(ada);
	const first = await signIn(ada);
	const guest = await connect();
	try {
		const one = await post(first.peer, 'one');
		first.peer.send({ method: 'activity', params: { room_id: 'general', read_message_id: one } });
		await drain(first.peer);
		expect(await kept(ada)).toEqual({ general: one });
		await request(first.peer, 'leave', 'room_leave', { room_id: 'general' });
		expect(await kept(ada)).toEqual({});
		// Not joined now: relayed, but neither kept nor written.
		first.peer.send({ method: 'activity', params: { room_id: 'general', read_message_id: one } });
		await drain(first.peer);
		expect((await attachments(ada)).map((attachment) => attachment.reads)).toEqual([undefined]);
		expect(await kept(ada)).toEqual({});
		// A malformed cursor is refused like malformed typing; nothing changes.
		first.peer.send({ id: 'bad', method: 'activity', params: { room_id: 'general', read_message_id: 'x' } });
		await drain(first.peer);
		await guest.next();
		await guest.next();
		const auth = await request(guest, 'auth', 'auth', { scheme: 'guest' });
		guest.send({ method: 'activity', params: { room_id: 'general', read_message_id: one } });
		await drain(guest);
		expect(await kept(auth.result.you.user_id)).toEqual({});
	} finally { first.peer.close(); guest.close(); }
});

it('moves cursors with /rename and deletes them with /purge', async () => {
	const ada = unique('ada');
	const renamed = unique('renamed');
	await register(ada);
	await runtime(({ store }) => {
		const message = store.mutate({
			userId: ada, ipKey: `ip-${ada}`, requestId: 'one', method: 'message', now: Date.now(), identity: { user_id: ada }, params: { room_id: 'general', body: { text: 'one' } },
		});
		store.saveReadCursors({ userId: ada, cursors: [['general', String(message.result.message_id)]] });
		store.renameIdentity({ from: ada, to: renamed });
		expect(Object.keys(Object.fromEntries(store.readCursors(renamed)))).toEqual(['general']);
		expect(store.readCursors(ada).size).toBe(0);
		store.purgeUsers({ userIds: [renamed] });
		expect(store.readCursors(renamed).size).toBe(0);
	});
});
