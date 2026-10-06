import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, PUSH_POLICY } from '../src/budget';
import { MUTE_FOREVER, type Store } from '../src/store';
import { connect as open, exchange, request, status as statusRequest, statusOnly, type Frame, type Peer } from './helpers/socket';
import { softPasskey } from './helpers/webauthn';
import { withStore } from './helpers/store';

let nextIp = 1;
const stub = () => env.DEMO.getByName('public-demo-v1');
const connect = () => open({ ip: `198.18.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`, statuses: true });
const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const COALESCE = DEFAULT_LIMITS.statusCoalesceSeconds * 1_000;
const GRACE = DEFAULT_LIMITS.offlineGraceSeconds * 1_000;

type Runtime = {
	store: Store;
	config: { presence: boolean };
	announcedAt: Map<string, number>;
	issueSession(userId: string, origin: string, now: number): Promise<string>;
	flushPresence(now?: number): void;
};
type Attachment = { userId?: string; closing?: boolean; pres?: { s: string; a: number; h?: number }; owed?: Array<[string, string, string, number]>; choice?: string; muteUntil?: number; roomMuteNext?: number };

// Status changes wait for time to pass (coalescing, the offline grace), so
// these tests move the clock the object reads: Date.now runs `offset` ahead,
// which only grows, so the object never sees time go back between tests.
const realNow = Date.now.bind(Date);
let offset = 0;
beforeEach(() => { vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset); });
afterEach(() => { vi.restoreAllMocks(); });

/** Lets `ms` pass, then has the object announce what is due, as its timer would. */
async function advance(ms: number): Promise<void> {
	offset += ms;
	await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).flushPresence());
}

async function register(userId: string): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		(instance as unknown as Runtime).store.registerIdentity({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
	});
}

/**
 * A connection signed in as a registered user (registered here unless
 * `existing`), which says at once that it is attended. Its auth result and
 * the frames after it are in `afterAuth`.
 */
async function signIn(userId: string, { existing = false } = {}): Promise<{ peer: Peer; auth: Frame; afterAuth: Frame[] }> {
	if (!existing) await register(userId);
	const token = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).issueSession(userId, 'http://localhost:5173', Date.now()));
	const peer = await connect();
	await peer.next();
	await peer.next();
	const auth = await request(peer, 'auth', 'auth', { scheme: 'token', token });
	expect(auth.result.you.user_id).toBe(userId);
	const afterAuth = await drain(peer);
	await status(peer, { idle: false });
	return { peer, auth, afterAuth };
}

async function signedIn(userId: string, options: { existing?: boolean } = {}): Promise<Peer> {
	return (await signIn(userId, options)).peer;
}

async function guest(): Promise<{ peer: Peer; userId: string; afterAuth: Frame[] }> {
	const peer = await connect();
	await peer.next();
	await peer.next();
	const auth = await request(peer, 'auth', 'auth', { scheme: 'guest' });
	const afterAuth = await drain(peer);
	await status(peer, { idle: false });
	return { peer, userId: auth.result.you.user_id, afterAuth };
}

/** The frames `peer` got before the reply to a request sent now: everything the object sent it so far. */
async function drain(peer: Peer): Promise<Frame[]> {
	return (await exchange(peer, `sync-${crypto.randomUUID()}`, 'me', {})).skipped;
}

/** The statuses `peer` was told for `userId` (`user` `new`), in order. */
function told(frames: Frame[], userId: string): string[] {
	return frames.filter((frame) => frame.method === 'user' && frame.params?.new?.user_id === userId && frame.params.new.status !== undefined)
		.map((frame) => frame.params.new.status);
}

/** The statuses `peer`'s own user was told in `you`, in order. */
function own(frames: Frame[]): string[] {
	return frames.filter((frame) => frame.method === 'user' && frame.params?.you?.status !== undefined).map((frame) => frame.params.you.status);
}

/** Sends a `status` request; the frames before its `{}` reply. */
async function status(peer: Peer, params: Record<string, unknown>): Promise<Frame[]> {
	const { frame, skipped } = await statusRequest(peer, params);
	expect(frame.result, JSON.stringify(frame.error)).toEqual({});
	return skipped;
}

/** Sets the status `peer`'s user chooses with `me`; the reply. */
async function choose(peer: Peer, value: unknown): Promise<Frame> {
	return request(peer, `me-${crypto.randomUUID()}`, 'me', { status: value });
}

/** The users of a fresh members listing of general, as `observer` sees them. */
async function listing(observer: Peer): Promise<Map<string, Record<string, unknown>>> {
	await runInDurableObject(stub(), (instance) => {
		// Each listing in these tests reads afresh, whatever an earlier one kept.
		(instance as unknown as { store: { memberCache: Map<string, unknown> } }).store.memberCache.clear();
	});
	// Listings are limited per user per minute: let one pass.
	offset += 10_000;
	const reply = await request(observer, `list-${crypto.randomUUID()}`, 'room_list', { room_id: 'general', members: true });
	expect(reply.error).toBeUndefined();
	return new Map(reply.result.users.map((user: { user_id: string }) => [user.user_id, user]));
}

/** How `observer` sees `userId` in a fresh members listing of general. */
async function listed(observer: Peer, userId: string): Promise<Record<string, unknown> | undefined> {
	return (await listing(observer)).get(userId);
}

/**
 * Evicts the object as a deploy or a restart would, after stopping its
 * status timer (the test runtime waits for pending timers before evicting).
 */
async function evict(): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const runtime = instance as unknown as { presenceTimer?: ReturnType<typeof setTimeout> };
		if (runtime.presenceTimer !== undefined) clearTimeout(runtime.presenceTimer);
	});
	await evictDurableObject(stub());
}

/** How many of `userId`'s connections the object still counts. */
function counted(userId: string): Promise<number> {
	return runInDurableObject(stub(), (_instance, state) => state.getWebSockets()
		.filter((socket) => socket.readyState === 1 && (socket.deserializeAttachment() as Attachment).userId === userId && !(socket.deserializeAttachment() as Attachment).closing).length);
}

/** Closes `peer`, one of `userId`'s connections, and waits until the object has handled the close. */
async function hangUp(peer: Peer, userId: string): Promise<void> {
	const before = await counted(userId);
	peer.close();
	for (let tries = 0; tries < 200 && await counted(userId) >= before; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(await counted(userId)).toBe(before - 1);
}

function attachments(): Promise<Attachment[]> {
	return runInDurableObject(stub(), (_instance, state) => state.getWebSockets().map((socket) => socket.deserializeAttachment() as Attachment));
}

/**
 * The SQL statements matching `match` that `run` executes, and the rows
 * their cursors read: an operation's own reads, without the reservation
 * bookkeeping around it.
 */
function statements(state: DurableObjectState, match: RegExp, run: () => unknown): { queries: string[]; reads: number } {
	const sql = state.storage.sql;
	const original = sql.exec.bind(sql);
	const cursors: Array<{ query: string; cursor: { rowsRead: number } }> = [];
	const spy = vi.spyOn(sql, 'exec').mockImplementation(((query: string, ...bindings: unknown[]) => {
		const cursor = original(query, ...(bindings as []));
		if (match.test(query)) cursors.push({ query: query.replace(/\s+/g, ' ').trim(), cursor });
		return cursor;
	}) as typeof sql.exec);
	try {
		run();
	} finally {
		spy.mockRestore();
	}
	return { queries: cursors.map((entry) => entry.query), reads: cursors.reduce((total, entry) => total + entry.cursor.rowsRead, 0) };
}

/** The SQL `run` (in the object) executes, and the rows it reads and writes, reservations included. */
async function measured(run: (runtime: Runtime & Record<string, any>, state: DurableObjectState) => void): Promise<{ queries: string[]; reads: number; writes: number }> {
	return runInDurableObject(stub(), (instance, state) => {
		const runtime = instance as unknown as Runtime & Record<string, any>;
		const before = runtime.store.storageAccounting();
		const sql = statements(state, /./, () => run(runtime, state));
		const after = runtime.store.storageAccounting();
		return { queries: sql.queries, reads: after.reads - before.reads, writes: after.writes - before.writes };
	});
}

/** No frame anyone but the user was sent carries their mutes, their chosen status as such, or a push_id. */
function expectPrivate(frames: Frame[], userId: string): void {
	const objects = JSON.stringify(frames).match(new RegExp(`\\{[^{}]*"user_id":"${userId}"[^{}]*\\}`, 'g')) ?? [];
	for (const object of objects) {
		expect(object).not.toMatch(/"mute"|"invisible"|"push_id"/);
	}
	expect(frames.filter((frame) => frame.method === 'status')).toEqual([]);
}

/** Forgets when anyone's status was last announced, so the next change goes out at once. */
async function forgetAnnouncements(): Promise<void> {
	offset += COALESCE;
	await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).announcedAt.clear());
}

describe('the status a user chooses (§4.11)', () => {
	beforeEach(forgetAnnouncements);

	it('shows each status as others see it: chosen ones at once, derived changes coalesced to one a minute', async () => {
		const aliceId = unique('alice');
		const bobId = unique('bob');
		const alice = await signedIn(aliceId);
		const bob = await signedIn(bobId);
		const bobToo = await signedIn(bobId, { existing: true });
		try {
			// Bob signing in is announced at once: nothing was announced for him this minute.
			expect(told(await drain(alice), bobId)).toEqual(['online']);
			// online, the default: idle once no connection is attended, after the minute.
			await status(bob, { idle: true });
			await status(bobToo, { idle: true });
			expect(told(await drain(alice), bobId)).toEqual([]);
			await advance(COALESCE / 2);
			expect(told(await drain(alice), bobId)).toEqual([]);
			await advance(COALESCE / 2);
			expect(told(await drain(alice), bobId)).toEqual(['idle']);
			// dnd: shown at once, whatever the minute; `you` shows the choice.
			const dnd = await choose(bob, 'dnd');
			expect(dnd.result.you).toMatchObject({ user_id: bobId, status: 'dnd' });
			expect(told(await drain(alice), bobId)).toEqual(['dnd']);
			// Bob's other connection is told his choice in `you`.
			expect(own(await drain(bobToo))).toEqual(['dnd']);
			expect(await listed(alice, bobId)).toMatchObject({ status: 'dnd' });
			// invisible: offline to others; `you` shows invisible.
			expect((await choose(bob, 'invisible')).result.you.status).toBe('invisible');
			expect(told(await drain(alice), bobId)).toEqual(['offline']);
			expect(await listed(alice, bobId)).toMatchObject({ status: 'offline' });
			// "": none, to opt out.
			expect((await choose(bob, '')).result.you.status).toBe('');
			expect(told(await drain(alice), bobId)).toEqual(['']);
			expect(await listed(alice, bobId)).toMatchObject({ status: '' });
			// online again: what his connections say, idle.
			expect((await choose(bob, 'online')).result.you.status).toBe('online');
			expect(told(await drain(alice), bobId)).toEqual(['idle']);
			// A value this server does not support is "" (§4.11), and so is shown.
			for (const unsupported of ['away', 'idle', 'offline', 'DND']) {
				await forgetAnnouncements();
				await choose(bob, 'online');
				const reply = await choose(bob, unsupported);
				expect(reply.result.you.status, unsupported).toBe('');
			}
			expect(told(await drain(alice), bobId).slice(-1)).toEqual(['']);
			// Not a string: invalid_params, and nothing changes.
			const invalid = await choose(bob, 42);
			expect(invalid.error.code).toBe(-32602);
			expect((await request(bob, 'still', 'me', {})).result.you.status).toBe('');
			// Attended again with online chosen: online, after the minute.
			await forgetAnnouncements();
			await choose(bob, 'online');
			await status(bob, { idle: false });
			await advance(COALESCE);
			expect(told(await drain(alice), bobId).slice(-1)).toEqual(['online']);
			expect(await listed(alice, bobId)).toMatchObject({ status: 'online' });
			// The choice outlasts the connections: a new one's `you` carries it.
			await forgetAnnouncements();
			await choose(bob, 'dnd');
			const later = await signIn(bobId, { existing: true });
			expect(later.auth.result.you.status).toBe('dnd');
			later.peer.close();
			const accounting = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.accountingStatus());
			expect(accounting.unsafe).toBe(false);
		} finally { alice.close(); bob.close(); bobToo.close(); }
	});

	it('shows users without a connection offline, or "" when they chose none, from the listing\'s own read', async () => {
		const observerId = unique('observer');
		const ids = { plain: unique('plain'), dnd: unique('dnd'), hidden: unique('hidden'), none: unique('none'), muted: unique('muted'), pushed: unique('pushed') };
		for (const id of Object.values(ids)) await register(id);
		await runInDurableObject(stub(), (instance) => {
			const { store } = instance as unknown as Runtime;
			const now = Date.now();
			store.setStatus({ userId: ids.dnd, choice: 'dnd', now });
			store.setStatus({ userId: ids.hidden, choice: 'invisible', now });
			store.setStatus({ userId: ids.none, choice: '', now });
			store.setMute({ userId: ids.muted, untilMs: now + 3_600_000, now });
			// A registration that wakes for messages no longer makes anyone idle.
			store.registerPushSubscription({ userId: ids.pushed, url: `https://push.example.net/${ids.pushed}`, p256dh: 'p'.repeat(87), auth: 'a'.repeat(22), now });
		});
		const observer = await signedIn(observerId);
		try {
			const users = await listing(observer);
			for (const id of [ids.plain, ids.dnd, ids.hidden, ids.muted, ids.pushed]) expect(users.get(id), id).toMatchObject({ status: 'offline' });
			expect(users.get(ids.none)).toMatchObject({ status: '' });
			expect(users.get(observerId)).toMatchObject({ status: 'online' });
			// The dnd user connects: dnd while connected, offline again once gone.
			const dnd = await signIn(ids.dnd, { existing: true });
			expect(dnd.auth.result.you.status).toBe('dnd');
			expect(told(await drain(observer), ids.dnd)).toEqual(['dnd']);
			await hangUp(dnd.peer, ids.dnd);
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			expect(told(await drain(observer), ids.dnd)).toEqual(['offline']);
			// The one who chose none comes and goes without anyone being told.
			const none = await signIn(ids.none, { existing: true });
			await hangUp(none.peer, ids.none);
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			expect(told(await drain(observer), ids.none)).toEqual([]);
			// The listing reads each member's chosen status with them: a member
			// who never chose one or muted costs no row more.
			const cost = await runInDurableObject(stub(), (instance, state) => {
				const runtime = instance as unknown as Runtime & { membersOf(ids: string[]): unknown };
				const measure = () => {
					(runtime.store as unknown as { memberCache: Map<string, unknown> }).memberCache.clear();
					return statements(state, /FROM memberships m/, () => runtime.membersOf(['general']));
				};
				const on = measure();
				runtime.config = { ...runtime.config, presence: false };
				try {
					const rows = Number(state.storage.sql.exec("SELECT COUNT(*) AS count FROM user_status s JOIN memberships m ON m.user_id = s.user_id AND m.room_id = 'general'").one().count);
					return { on, off: measure(), rows };
				} finally {
					runtime.config = { ...runtime.config, presence: true };
				}
			});
			expect(cost.on.queries[0]).toMatch(/LEFT JOIN user_status s/);
			expect(cost.off.queries[0]).not.toMatch(/user_status/);
			// Only members with a row (these four, and any earlier tests left) cost one read more each.
			expect(cost.rows).toBeGreaterThanOrEqual(4);
			expect(cost.on.reads - cost.off.reads).toBeLessThanOrEqual(cost.rows);
		} finally { observer.close(); }
	});

	it('keeps invisible private: offline to others everywhere, never told after auth, left out of connected members', async () => {
		const observerId = unique('observer');
		const shyId = unique('shy');
		const observer = await signedIn(observerId);
		const shy = await signedIn(shyId);
		try {
			await request(shy, 'register', 'push_register', { kind: 'webpush', url: `https://push.example.net/${shyId}`, keys: { p256dh: 'BDiU8ZnLVhCayOIihLkro6Di0XjZW7iK59umfbY--JzLTzNbhd94tTuBsIzrhXljFDqw5xn8gLqahSsSPDCauDM', auth: 'AAAAAAAAAAAAAAAAAAAAAA' }, push_id: 'shy-phone' });
			await status(shy, { mute: true });
			await status(shy, { room_id: 'general', mute: 600 });
			await choose(shy, 'invisible');
			const seen = await drain(observer);
			expect(told(seen, shyId)).toEqual(['online', 'offline']);
			const list = await request(observer, 'list', 'room_list', { filter: 'joined', members: true });
			expectPrivate([...seen, list], shyId);
			// Connected, invisible: listed as stored members are, offline.
			expect(list.result.users.find((user: { user_id: string }) => user.user_id === shyId)).toEqual({ user_id: shyId, name: `Name of ${shyId}`, roles: [], status: 'offline' });
			const members = await runInDurableObject(stub(), (instance) => (instance as unknown as { connectedMembers(): Map<string, Array<{ user_id: string }>> }).connectedMembers());
			expect((members.get('general') ?? []).map((user) => user.user_id)).not.toContain(shyId);
			// A new connection of someone else's is not told of them after auth, as
			// users without a connection are not; nor anything private.
			const late = await signIn(unique('late'));
			try {
				expect(told(late.afterAuth, shyId)).toEqual([]);
				expect(told(late.afterAuth, observerId)).toEqual(['online']);
				expectPrivate(late.afterAuth, shyId);
			} finally { late.peer.close(); }
			// What they do still shows: a post carries no status.
			await request(shy, 'post', 'message', { room_id: 'general', body: { text: 'hello' } });
			expectPrivate(await drain(observer), shyId);
		} finally { observer.close(); shy.close(); }
	});

	it('sends after auth the mutes in effect and the status of each connected user sharing a room, from attachments only', async () => {
		const aliceId = unique('alice');
		const bobId = unique('bob');
		const busyId = unique('busy');
		const noneId = unique('none');
		const lateId = unique('late');
		const alice = await signedIn(aliceId);
		const bob = await signedIn(bobId);
		const busy = await signedIn(busyId);
		const none = await signedIn(noneId);
		const lateFirst = await signedIn(lateId);
		const { peer: visitor, userId: visitorId } = await guest();
		try {
			await choose(busy, 'dnd');
			await choose(none, '');
			await status(lateFirst, { mute: 3600 });
			await status(lateFirst, { room_id: 'general', mute: true });
			// Bob goes idle within the minute after his sign-in was announced:
			// others were told online, and still are.
			expect(told(await drain(alice), bobId)).toEqual(['online']);
			await status(bob, { idle: true });
			await drain(lateFirst);
			// Late's second connection signs in: measure what its auth does past
			// the reads that sign it in.
			const result = await signIn(lateId, { existing: true });
			const frames = result.afterAuth;
			const mutes = frames.filter((frame) => frame.method === 'status').map((frame) => frame.params);
			expect(mutes).toEqual([{ mute: expect.any(Number) }, { room_id: 'general', mute: true }]);
			expect(mutes[0].mute).toBeGreaterThan(3500);
			// Mutes first, then statuses: each as others were last told it.
			expect(frames.findIndex((frame) => frame.method === 'status')).toBeLessThan(frames.findIndex((frame) => frame.method === 'user'));
			expect(told(frames, aliceId)).toEqual(['online']);
			expect(told(frames, bobId)).toEqual(['online']);
			expect(told(frames, busyId)).toEqual(['dnd']);
			expect(told(frames, visitorId)).toEqual(['online']);
			// Its own user and one who chose none are left out.
			expect(told(frames, lateId)).toEqual([]);
			expect(told(frames, noneId)).toEqual([]);
			expect(frames.filter((frame) => frame.method === 'user' && frame.params.you)).toEqual([]);
			expect(frames.filter((frame) => frame.method === 'user').every((frame) => Object.keys(frame.params.new).sort().join() === 'status,user_id')).toBe(true);
			// Sending the statuses is attachments only: no SQL at all.
			const resend = await measured((runtime, state) => {
				const socket = state.getWebSockets().find((ws) => (ws.deserializeAttachment() as Attachment).userId === lateId && !(ws.deserializeAttachment() as Attachment).closing)!;
				runtime.sendShownStatus(socket);
			});
			expect(resend).toEqual({ queries: [], reads: 0, writes: 0 });
			expect(told(await drain(result.peer), aliceId)).toEqual(['online']);
			result.peer.close();
			// A guest has no mutes: none are sent; the statuses are.
			const other = await guest();
			try {
				const sent = other.afterAuth;
				expect(sent.filter((frame) => frame.method === 'status')).toEqual([]);
				expect(told(sent, aliceId)).toEqual(['online']);
			} finally { other.peer.close(); }
		} finally { alice.close(); bob.close(); busy.close(); none.close(); lateFirst.close(); visitor.close(); }
	});

	it('derives and announces status with no SQL: sweeps, idle changes, closes, and listings of connected users', async () => {
		const watcherId = unique('watcher');
		const ids = [unique('one'), unique('two'), unique('three')];
		const watcher = await signedIn(watcherId);
		const peers = await Promise.all(ids.map((id) => signedIn(id)));
		try {
			await drain(watcher);
			await choose(peers[1], 'dnd');
			await choose(peers[2], 'invisible');
			await drain(watcher);
			offset += COALESCE;
			const idle = await measured((runtime, state) => {
				const socket = state.getWebSockets().find((ws) => (ws.deserializeAttachment() as Attachment).userId === ids[0])!;
				runtime.handleStatus(socket, { method: 'status', id: 'idle', params: { idle: true }, full: false });
			});
			expect(idle).toEqual({ queries: [], reads: 0, writes: 0 });
			const sweep = await measured((runtime) => runtime.flushPresence());
			expect(sweep).toEqual({ queries: [], reads: 0, writes: 0 });
			const shown = await measured((runtime) => { runtime.presenceSnapshot(Date.now()); });
			expect(shown).toEqual({ queries: [], reads: 0, writes: 0 });
			expect(told(await drain(watcher), ids[0])).toEqual(['idle']);
			await hangUp(peers[1], ids[1]);
			offset += GRACE + 1_000;
			const closed = await measured((runtime) => runtime.flushPresence());
			expect(closed).toEqual({ queries: [], reads: 0, writes: 0 });
			expect(told(await drain(watcher), ids[1])).toEqual(['offline']);
		} finally { watcher.close(); for (const peer of peers) peer.close(); }
	});

	it('takes a guest\'s status on its connection alone, and leaves an invisible guest out of members', async () => {
		const observerId = unique('observer');
		const observer = await signedIn(observerId);
		const { peer: visitor, userId: visitorId } = await guest();
		try {
			await drain(observer);
			const reply = await choose(visitor, 'dnd');
			expect(reply.result.you).toMatchObject({ user_id: visitorId, status: 'dnd' });
			expect(told(await drain(observer), visitorId)).toEqual(['dnd']);
			// Kept on the connection: no row.
			const rows = await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec('SELECT * FROM user_status WHERE user_id = ?', visitorId).toArray());
			expect(rows).toEqual([]);
			await choose(visitor, 'invisible');
			expect(told(await drain(observer), visitorId)).toEqual(['offline']);
			// Never stored, a guest listed only because connected would show it is: left out.
			expect((await listing(observer)).has(visitorId)).toBe(false);
			// Guests still may not rename themselves.
			expect((await request(visitor, 'rename', 'me', { name: 'Visitor', status: 'online' })).error.code).toBe(-32001);
			expect((await request(visitor, 'check', 'me', {})).result.you.status).toBe('invisible');
		} finally { observer.close(); visitor.close(); }
	});
});

describe('user status timing', () => {
	beforeEach(forgetAnnouncements);

	it('coalesces changes within the minute to the latest, and sends none when it is back to what was told', async () => {
		const watcherId = unique('watcher');
		const flipperId = unique('flipper');
		const watcher = await signedIn(watcherId);
		const flipper = await signedIn(flipperId);
		const second = await signedIn(flipperId, { existing: true });
		try {
			expect(told(await drain(watcher), flipperId)).toEqual(['online']);
			const mine: Frame[] = [...await drain(second)];
			for (const idle of [true, false, true, false, true]) await status(flipper, { idle });
			mine.push(...await status(second, { idle: true }));
			// Five changes, then a sixth, in the minute: only the latest goes out, once.
			await advance(COALESCE);
			expect(told(await drain(watcher), flipperId)).toEqual(['idle']);
			// Back and forth within the next minute, ending where it was told: nothing.
			mine.push(...await status(second, { idle: false }));
			mine.push(...await status(second, { idle: true }));
			await advance(COALESCE);
			expect(told(await drain(watcher), flipperId)).toEqual([]);
			await status(flipper, { idle: false });
			await advance(COALESCE);
			expect(told(await drain(watcher), flipperId)).toEqual(['online']);
			// The user's own connections are not told what others see: `you` shows their choice.
			mine.push(...await drain(second));
			expect(own(mine)).toEqual([]);
			expect(told(mine, flipperId)).toEqual([]);
		} finally { watcher.close(); flipper.close(); second.close(); }
	});

	it('waits out the offline grace: a reconnect within it announces nothing', async () => {
		const watcherId = unique('watcher');
		const mobileId = unique('mobile');
		const watcher = await signedIn(watcherId);
		let mobile = await signedIn(mobileId);
		try {
			expect(told(await drain(watcher), mobileId)).toEqual(['online']);
			// The phone drops its connection and comes back well within the grace.
			await hangUp(mobile, mobileId);
			await advance(GRACE / 3);
			// Owed to the watcher, kept on its connection.
			expect((await attachments()).some((state) => state.owed?.some(([id, from, to]) => id === mobileId && from === 'online' && to === 'offline'))).toBe(true);
			mobile = await signedIn(mobileId, { existing: true });
			await advance(GRACE);
			expect(told(await drain(watcher), mobileId)).toEqual([]);
			expect((await attachments()).some((state) => state.owed?.some(([id]) => id === mobileId))).toBe(false);
			// A desktop tab closed while an idle phone stays: idle, after the grace too.
			const desktop = await signedIn(mobileId, { existing: true });
			await status(mobile, { idle: true });
			await advance(COALESCE);
			expect(told(await drain(watcher), mobileId)).toEqual([]);
			await hangUp(desktop, mobileId);
			await advance(GRACE - 1_000);
			expect(told(await drain(watcher), mobileId)).toEqual([]);
			await advance(2_000);
			expect(told(await drain(watcher), mobileId)).toEqual(['idle']);
			// Gone for good: offline once the grace is over, not before.
			await hangUp(mobile, mobileId);
			await advance(GRACE - 1_000);
			expect(told(await drain(watcher), mobileId)).toEqual([]);
			await advance(2_000);
			expect(told(await drain(watcher), mobileId)).toEqual(['offline']);
		} finally { watcher.close(); mobile.close(); }
	});

	it('keeps changes still to come across hibernation, in attachments, and sends them on the next event', async () => {
		const watcherId = unique('watcher');
		const leaverId = unique('leaver');
		const stayerId = unique('stayer');
		const watcher = await signedIn(watcherId);
		const leaver = await signedIn(leaverId);
		const stayer = await signedIn(stayerId);
		try {
			const signedInFrames = await drain(watcher);
			expect([...told(signedInFrames, leaverId), ...told(signedInFrames, stayerId)]).toEqual(['online', 'online']);
			// One user goes idle within the minute, another leaves: both wait.
			await status(stayer, { idle: true });
			await hangUp(leaver, leaverId);
			await advance(1_000);
			const held = await attachments();
			expect(held.find((state) => state.userId === stayerId && !state.closing)?.pres).toMatchObject({ s: 'online' });
			expect(held.find((state) => state.userId === watcherId)?.owed).toEqual([[leaverId, 'online', 'offline', expect.any(Number)]]);
			// The object is evicted (a pending timer keeps it from hibernating, but
			// not from being evicted): its timer and memory are gone, the
			// attachments stay.
			await evict();
			offset += Math.max(COALESCE, GRACE);
			// The next event sweeps the attachments and announces what is due.
			const frames = await drain(watcher);
			expect(told(frames, leaverId)).toEqual(['offline']);
			expect(told(frames, stayerId)).toEqual(['idle']);
			const after = await attachments();
			expect(after.find((state) => state.userId === watcherId)?.owed).toBeUndefined();
			expect(after.find((state) => state.userId === stayerId && !state.closing)?.pres).toMatchObject({ s: 'idle' });
			// A wake with nothing waiting announces nothing.
			await evict();
			expect(told(await drain(watcher), stayerId)).toEqual([]);
		} finally { watcher.close(); leaver.close(); stayer.close(); }
	});

	it('waits on one in-memory timer, at most a minute ahead: no SQL, no alarm, no request', async () => {
		const watcherId = unique('watcher');
		const leaverId = unique('leaver');
		const watcher = await signedIn(watcherId);
		const leaver = await signedIn(leaverId);
		try {
			await drain(watcher);
			await hangUp(leaver, leaverId);
			const pending = await runInDurableObject(stub(), async (instance, state) => {
				const runtime = instance as unknown as Runtime & { presenceTimer?: unknown; presenceTimerAt: number };
				return { timer: runtime.presenceTimer !== undefined, ahead: runtime.presenceTimerAt - Date.now(), alarm: await state.storage.getAlarm() };
			});
			// Armed for the grace, never more than MAX_STATUS_DELAY_SECONDS ahead.
			expect(pending.timer).toBe(true);
			expect(pending.ahead).toBeGreaterThan(GRACE - 5_000);
			expect(pending.ahead).toBeLessThanOrEqual(Math.max(GRACE, COALESCE) + 100);
			offset += GRACE;
			const flushed = await runInDurableObject(stub(), async (instance, state) => {
				const runtime = instance as unknown as Runtime & { presenceTimer?: unknown };
				const before = runtime.store.storageAccounting();
				runtime.flushPresence();
				const after = runtime.store.storageAccounting();
				return { reads: after.reads - before.reads, writes: after.writes - before.writes, alarm: await state.storage.getAlarm(), timer: runtime.presenceTimer !== undefined };
			});
			// Announcing touched no storage, scheduled no alarm (so no extra
			// request), and left nothing waiting to keep the object awake.
			expect(flushed).toMatchObject({ reads: 0, writes: 0, alarm: pending.alarm, timer: false });
			expect(told(await drain(watcher), leaverId)).toEqual(['offline']);
			// A mute that runs out in an hour arms nothing: an event sweeps for it.
			await status(watcher, { mute: 3600 });
			expect(await runInDurableObject(stub(), (instance) => (instance as unknown as { presenceTimer?: unknown }).presenceTimer !== undefined)).toBe(false);
			// With no connection to tell of changes, nothing keeps the object awake.
			await hangUp(watcher, watcherId);
			const idleTimer = await runInDurableObject(stub(), (instance) => (instance as unknown as { presenceTimer?: unknown }).presenceTimer !== undefined);
			expect(idleTimer).toBe(false);
		} finally { watcher.close(); leaver.close(); }
	});

	it('fails a sign-in whose stored status and mutes cannot be read, leaving the connection as it was', async () => {
		const userId = unique('unread');
		const watcherId = unique('watcher');
		const watcher = await signedIn(watcherId);
		const first = await signedIn(userId);
		const token = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).issueSession(userId, 'http://localhost:5173', Date.now()));
		const peer = await connect();
		try {
			await choose(first, 'invisible');
			await status(first, { mute: 3600 });
			first.close();
			await drain(watcher);
			await peer.next();
			await peer.next();
			peer.send({ method: 'status', params: { idle: false } });
			await runInDurableObject(stub(), (instance) => {
				vi.spyOn((instance as unknown as Runtime).store, 'statusInputs').mockImplementationOnce(() => { throw new Error('storage unavailable'); });
			});
			// Signing in without them would show an invisible user as connected: the sign-in fails instead.
			const failed = await request(peer, 'auth-failed', 'auth', { scheme: 'token', token });
			expect(failed.error.code).toBe(-32603);
			expect(failed.error.message).toMatch(/sign in again/);
			// The connection is as it was: not signed in, and nobody was told of it.
			expect((await request(peer, 'me-failed', 'me', {})).error.code).toBe(-32001);
			expect((await attachments()).filter((attachment) => attachment.userId === userId && !attachment.closing)).toEqual([]);
			await advance(COALESCE);
			expect(told(await drain(watcher), userId)).toEqual([]);
			// Tried again, it signs in with both.
			const { frame: auth, skipped } = await exchange(peer, 'auth-again', 'auth', { scheme: 'token', token });
			expect(auth.result.you).toMatchObject({ user_id: userId, status: 'invisible' });
			expect(skipped.filter((frame) => frame.method === 'status')).toEqual([]);
			expect((await drain(peer)).filter((frame) => frame.method === 'status').map((frame) => frame.params)).toEqual([{ mute: expect.any(Number) }]);
			await advance(COALESCE);
			expect(told(await drain(watcher), userId)).toEqual([]);
		} finally { watcher.close(); first.close(); peer.close(); }
	});

	it('tells a room\'s members the status of a user who joins it', async () => {
		const ownerId = unique('owner');
		const joinerId = unique('joiner');
		const owner = await signedIn(ownerId);
		const joiner = await signedIn(joinerId);
		try {
			const roomId = (await request(owner, 'thread', 'room_set', { parent_room_id: 'general', title: 'Status join' })).result.room_id;
			await status(joiner, { idle: true });
			await drain(owner);
			await request(joiner, 'join', 'room_join', { room_id: roomId });
			// The membership record carries no status; the joiner's status follows it, as others were told it.
			const frames = await drain(owner);
			const membership = frames.findIndex((frame) => frame.method === 'room_update' && frame.params.memberships);
			const announced = frames.findIndex((frame) => frame.method === 'user' && frame.params.new?.user_id === joinerId);
			expect(membership).toBeGreaterThanOrEqual(0);
			expect(announced).toBeGreaterThan(membership);
			expect(frames[announced].params.new).toEqual({ user_id: joinerId, status: 'online' });
			expect(JSON.stringify(frames[membership])).not.toContain('"status"');
		} finally { owner.close(); joiner.close(); }
	});

	it('/rename and /purge move and delete the user status row and room mutes', async () => {
		const userId = 'rn';
		await withStore('presence-rename', { push: { ...PUSH_POLICY! } }, (store, clock) => {
			store.registerIdentity({
				userId, name: 'Rn', userHandle: 'handle-rn', now: clock.value, ipKey: 'ip-rn',
				credential: { credentialId: 'cred-rn', userId, publicKey: 'AAAA', counter: 0 },
			});
			const now = clock.value;
			store.setStatus({ userId, choice: 'invisible', now });
			store.setMute({ userId, untilMs: now + 60_000, now });
			store.setRoomMute({ userId, roomId: 'general', untilMs: MUTE_FOREVER, now });
			store.renameIdentity({ from: userId, to: `${userId}x`, now });
			expect(store.statusInputs(userId, now)).toEqual({ choice: 'online', roomMutes: [] });
			expect(store.statusInputs(`${userId}x`, now)).toEqual({ choice: 'invisible', muteUntil: now + 60_000, roomMutes: [{ roomId: 'general', untilMs: MUTE_FOREVER }] });
			store.setMute({ userId: `${userId}x`, untilMs: null, now });
			expect(store.statusInputs(`${userId}x`, now)).toEqual({ choice: 'invisible', roomMutes: [{ roomId: 'general', untilMs: MUTE_FOREVER }] });
			store.purgeUsers({ userIds: [`${userId}x`], now });
			expect(store.statusInputs(`${userId}x`, now)).toEqual({ choice: 'online', roomMutes: [] });
			expect(store.accountingStatus().unsafe).toBe(false);
		});
	});

	it('/toggle presence turns status off and on for everyone, keeping the chosen status and mutes while off', async () => {
		const adminId = unique('admin');
		await register(adminId);
		await runInDurableObject(stub(), (instance) => { (instance as unknown as Runtime).store.setRole({ userId: adminId, role: 'admin', on: true }); });
		const admin = await signedIn(adminId, { existing: true });
		const watcherId = unique('watcher');
		const watcher = await signedIn(watcherId);
		const toggle = (id: string) => exchange(admin, id, 'command', { room_id: 'general', body: { text: '/toggle presence' } });
		try {
			// Only admins may toggle.
			expect((await request(watcher, 'nope', 'command', { room_id: 'general', body: { text: '/toggle presence' } })).error.code).toBe(-32001);
			await drain(admin);
			await drain(watcher);
			const off = await toggle('off');
			expect(off.frame.result).toEqual({});
			expect(off.skipped.find((frame) => frame.params?.from?.user_id === '~private')?.params.body.text).toMatch(/^Status is now \*\*off\*\*/);
			// Off clears what every connection was shown with `status: ""`, none
			// (§4.11), for each user it shares a room with; `you` keeps the choice.
			expect(told(off.skipped, watcherId)).toEqual(['']);
			expect(own(off.skipped)).toEqual([]);
			const cleared = await drain(watcher);
			expect(told(cleared, adminId)).toEqual(['']);
			expect(cleared.filter((frame) => frame.method === 'user').every((frame) => Object.keys(frame.params.new).sort().join() === 'status,user_id')).toBe(true);
			// Clearing reads and writes no storage.
			const clearing = await measured((runtime) => runtime.clearShownStatus());
			expect(clearing).toEqual({ queries: [], reads: 0, writes: 0 });
			await drain(admin);
			await drain(watcher);
			// Off: no status shown to others, nor sent after auth; the chosen one is kept and in `you`.
			expect(await listed(watcher, watcherId)).not.toHaveProperty('status');
			expect((await choose(watcher, 'invisible')).result.you).toMatchObject({ user_id: watcherId, status: 'invisible' });
			expect(told(await drain(admin), watcherId)).toEqual([]);
			const second = await signIn(watcherId, { existing: true });
			expect(second.auth.result.you.status).toBe('invisible');
			expect(second.afterAuth.filter((frame) => frame.method === 'user')).toEqual([]);
			// Mutes are still sent, and still run out.
			await status(second.peer, { mute: 5 });
			offset += 6_000;
			await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).flushPresence());
			expect((await drain(watcher)).filter((frame) => frame.method === 'status').map((frame) => frame.params)).toEqual([{ mute: 5 }, { mute: false }]);
			second.peer.close();
			// Invisible users are left out of connected member listings with presence off too.
			const members = await runInDurableObject(stub(), (instance) => (instance as unknown as { connectedMembers(): Map<string, Array<{ user_id: string }>> }).connectedMembers());
			expect((members.get('general') ?? []).map((user) => user.user_id)).not.toContain(watcherId);
			const on = await toggle('on');
			expect(on.skipped.find((frame) => frame.params?.from?.user_id === '~private')?.params.body.text).toMatch(/^Status is now \*\*on\*\*/);
			// On again, it starts from each user's status now, announcing nothing
			// for it; the invisible chosen while off holds, so others see offline.
			expect(await listed(admin, watcherId)).toMatchObject({ status: 'offline' });
			await forgetAnnouncements();
			await choose(watcher, 'online');
			expect(told(await drain(admin), watcherId)).toEqual(['online']);
		} finally { admin.close(); watcher.close(); }
	});
});

/** The frames among `frames` that §4.11 sends after a sign-in: mutes in effect (`status`) and others' statuses. */
function signInSends(frames: Frame[]): Frame[] {
	return frames.filter((frame) => frame.method === 'status' || statusOnly(frame));
}

/** Registers a passkey over the wire on `peer`: begin, then finish with a software authenticator; the finish exchange. */
async function registerPasskey(peer: Peer, id: string): Promise<{ passkey: Awaited<ReturnType<typeof softPasskey>>; finished: { frame: Frame; skipped: Frame[] } }> {
	const passkey = await softPasskey('http://localhost:5173');
	const begun = await request(peer, `${id}-begin`, 'auth', { scheme: 'webauthn', action: 'register', step: 'begin' });
	expect(begun.error).toBeUndefined();
	const credential = await passkey.register(begun.result.public_key);
	const finished = await exchange(peer, `${id}-finish`, 'auth', { scheme: 'webauthn', action: 'register', step: 'finish', challenge_id: begun.result.challenge_id, credential });
	expect(finished.frame.error).toBeUndefined();
	return { passkey, finished };
}

/** A fresh connection past its greeting. */
async function opened(): Promise<Peer> {
	const peer = await connect();
	await peer.next();
	await peer.next();
	return peer;
}

async function sha256Hex(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Stores a mute everywhere and one in general for `userId`, as an earlier connection would have. */
async function storeMutes(userId: string): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const { store } = instance as unknown as Runtime;
		const now = Date.now();
		store.setMute({ userId, untilMs: now + 3_600_000, now });
		(store as unknown as { setRoomMute(input: { userId: string; roomId: string; untilMs: number | null; now?: number }): unknown })
			.setRoomMute({ userId, roomId: 'general', untilMs: MUTE_FOREVER, now });
	});
}

describe('server.status and what follows a sign-in (§3.1, §4.11)', () => {
	beforeEach(forgetAnnouncements);

	it('advertises the optional statuses in server.status with presence on, and leaves it out with presence off', async () => {
		const on = await connect();
		try {
			const server = (await on.next()).params;
			expect(server.capabilities).toContain('status');
			expect(server.status).toEqual(['dnd', 'invisible']);
		} finally { on.close(); }
		await runInDurableObject(stub(), (instance) => {
			(instance as unknown as { presenceMode(): boolean }).presenceMode = () => false;
		});
		try {
			const off = await connect();
			try {
				const server = (await off.next()).params;
				// Capability `status` stays (idle and mutes still work); only the list goes.
				expect(server.capabilities).toContain('status');
				expect(server).not.toHaveProperty('status');
			} finally { off.close(); }
		} finally {
			await runInDurableObject(stub(), (instance) => { delete (instance as unknown as { presenceMode?: unknown }).presenceMode; });
		}
		const again = await connect();
		try { expect((await again.next()).params.status).toEqual(['dnd', 'invisible']); } finally { again.close(); }
	});

	it('sends the mutes in effect and others\' statuses only after the auth result, on every sign-in path', async () => {
		const busyId = unique('busy');
		const busy = await signedIn(busyId);
		const peers: Peer[] = [busy];
		/** Checks one sign-in's exchange: nothing before its result, then the mutes and Busy's dnd after it. */
		const check = async (path: string, peer: Peer, exchanged: { frame: Frame; skipped: Frame[] }, mutes: unknown[]) => {
			expect(exchanged.frame.error, path).toBeUndefined();
			expect(signInSends(exchanged.skipped), path).toEqual([]);
			const after = await drain(peer);
			expect(after.filter((frame) => frame.method === 'status').map((frame) => frame.params), path).toEqual(mutes);
			expect(told(after, busyId), path).toEqual(['dnd']);
			// Mutes first, then statuses.
			if (mutes.length) expect(after.findIndex((frame) => frame.method === 'status'), path).toBeLessThan(after.findIndex(statusOnly));
		};
		const stored = [{ mute: expect.any(Number) }, { room_id: 'general', mute: true }];
		try {
			await choose(busy, 'dnd');

			// Token resume (a passkey's session token).
			const resumedId = unique('resumed');
			await register(resumedId);
			await storeMutes(resumedId);
			const token = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).issueSession(resumedId, 'http://localhost:5173', Date.now()));
			const resumed = await opened();
			peers.push(resumed);
			await check('token resume', resumed, await exchange(resumed, 'auth', 'auth', { scheme: 'token', token }), stored);

			// Keyless: an invite token (`/invite-token`), as bots and the admin token sign in.
			const invitedId = unique('invited');
			await register(invitedId);
			await storeMutes(invitedId);
			const invite = `apron_invite_${crypto.randomUUID().replaceAll('-', '')}`;
			const inviteKey = `invite-token:${await sha256Hex(invite)}`;
			await runInDurableObject(stub(), (_instance, state) => state.storage.put(inviteKey, { v: 1, userId: invitedId }));
			const invited = await opened();
			peers.push(invited);
			await check('keyless token', invited, await exchange(invited, 'auth', 'auth', { scheme: 'token', token: invite }), stored);

			// Guest: no mutes, the statuses after the result.
			const visitor = await opened();
			peers.push(visitor);
			await check('guest', visitor, await exchange(visitor, 'auth', 'auth', { scheme: 'guest' }), []);

			// Passkey registration, a new account: `status` before signing in is
			// denied and changes nothing, so it has no mutes in effect after it.
			const fresh = await opened();
			peers.push(fresh);
			expect((await statusRequest(fresh, { idle: false, mute: 600 })).frame.error.code).toBe(-32001);
			expect((await statusRequest(fresh, { room_id: 'general', mute: true })).frame.error.code).toBe(-32001);
			const { passkey, finished } = await registerPasskey(fresh, 'signup');
			await check('passkey registration', fresh, finished, []);
			const newId = finished.frame.result.you.user_id;
			expect(await status(fresh, { mute: 600 })).toEqual([{ method: 'status', params: { mute: 600 } }]);
			await status(fresh, { room_id: 'general', mute: true });

			// Passkey login: the new account's stored mutes, after the result.
			const login = await opened();
			peers.push(login);
			const begun = await request(login, 'login-begin', 'auth', { scheme: 'webauthn', action: 'login', step: 'begin' });
			const credential = await passkey.assert(begun.result.public_key);
			const loggedIn = await exchange(login, 'login-finish', 'auth', { scheme: 'webauthn', action: 'login', step: 'finish', challenge_id: begun.result.challenge_id, credential });
			expect(loggedIn.frame.result?.you.user_id).toBe(newId);
			await check('passkey login', login, loggedIn, [{ mute: expect.any(Number) }, { room_id: 'general', mute: true }]);
		} finally { for (const peer of peers) peer.close(); }
	}, 20_000);

	it('sends nothing after an auth that adds a passkey to a signed-in connection, nor after a repeated guest auth', async () => {
		const busyId = unique('busy');
		const busy = await signedIn(busyId);
		const userId = unique('adder');
		await register(userId);
		await storeMutes(userId);
		const user = await signedIn(userId, { existing: true });
		const { peer: visitor } = await guest();
		try {
			await choose(busy, 'dnd');
			await drain(user);
			await drain(visitor);
			// Adding a passkey is an auth, but not a sign-in.
			const { finished } = await registerPasskey(user, 'add');
			expect(finished.frame.result.you.user_id).toBe(userId);
			expect(signInSends([...finished.skipped, ...await drain(user)])).toEqual([]);
			// Nor is a guest auth on a connection already signed in.
			const repeated = await exchange(visitor, 'again', 'auth', { scheme: 'guest' });
			expect(repeated.frame.error).toBeUndefined();
			expect(signInSends([...repeated.skipped, ...await drain(visitor)])).toEqual([]);
		} finally { busy.close(); user.close(); visitor.close(); }
	});

	it('shows dnd only while connected, and leaves users shown offline or "" out after a sign-in', async () => {
		const ids = { dnd: unique('dnd'), gone: unique('gone'), none: unique('none'), hidden: unique('hidden'), here: unique('here') };
		const peers = new Map<string, Peer>();
		for (const id of Object.values(ids)) peers.set(id, await signedIn(id));
		try {
			await choose(peers.get(ids.dnd)!, 'dnd');
			await choose(peers.get(ids.none)!, '');
			await choose(peers.get(ids.hidden)!, 'invisible');
			// While connected, dnd is sent after a sign-in.
			const first = await signIn(unique('first'));
			expect(told(first.afterAuth, ids.dnd)).toEqual(['dnd']);
			expect(told(first.afterAuth, ids.here)).toEqual(['online']);
			first.peer.close();
			// Gone, the dnd user is offline to others: told so, listed so, and not sent after a sign-in.
			const watcher = await signedIn(unique('watcher'));
			try {
				await drain(watcher);
				await hangUp(peers.get(ids.dnd)!, ids.dnd);
				await hangUp(peers.get(ids.gone)!, ids.gone);
				await advance(Math.max(COALESCE, GRACE) + 1_000);
				const seen = await drain(watcher);
				expect(told(seen, ids.dnd)).toEqual(['offline']);
				expect(told(seen, ids.gone)).toEqual(['offline']);
				expect(await listed(watcher, ids.dnd)).toMatchObject({ status: 'offline' });
			} finally { watcher.close(); }
			const later = await signIn(unique('later'));
			try {
				// offline (gone, dnd without a connection, invisible) and "" are left out.
				for (const id of [ids.dnd, ids.gone, ids.hidden, ids.none]) expect(told(later.afterAuth, id), id).toEqual([]);
				expect(told(later.afterAuth, ids.here)).toEqual(['online']);
				expect(later.afterAuth.filter(statusOnly).map((frame) => frame.params.new.status)).not.toContain('offline');
				expect(later.afterAuth.filter(statusOnly).map((frame) => frame.params.new.status)).not.toContain('');
			} finally { later.peer.close(); }
		} finally { for (const peer of peers.values()) peer.close(); }
	}, 20_000);

	it('scopes only mute with room_id: idle stays the connection\'s, and is never echoed', async () => {
		const userId = unique('scoped');
		const peer = await signedIn(userId);
		const other = await signedIn(userId, { existing: true });
		const idleOf = () => runInDurableObject(stub(), (_instance, state) => state.getWebSockets()
			.map((socket) => socket.deserializeAttachment() as Attachment & { idle?: boolean })
			.filter((attachment) => attachment.userId === userId && !attachment.closing)
			.map((attachment) => attachment.idle === true).sort());
		try {
			await drain(other);
			// idle and mute with room_id: the room is muted, not everywhere, and the sending connection is idle.
			const sent = await status(peer, { room_id: 'general', idle: true, mute: true });
			expect(sent.filter((frame) => frame.method === 'status').map((frame) => frame.params)).toEqual([{ room_id: 'general', mute: true }]);
			expect((await drain(other)).filter((frame) => frame.method === 'status').map((frame) => frame.params)).toEqual([{ room_id: 'general', mute: true }]);
			expect(await idleOf()).toEqual([false, true]);
			const stored = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.statusInputs(userId, Date.now()));
			expect(stored).toEqual({ choice: 'online', roomMutes: [{ roomId: 'general', untilMs: MUTE_FOREVER }] });
			// idle with a room_id alone, even one that names no room: the connection's, no mute, nothing sent.
			const back = await status(peer, { room_id: 'nowhere', idle: false });
			expect(signInSends(back)).toEqual([]);
			expect(await idleOf()).toEqual([false, false]);
			expect((await drain(other)).filter((frame) => frame.method === 'status')).toEqual([]);
		} finally { peer.close(); other.close(); }
	});
});
