import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, PUSH_POLICY, SEEN_WRITE_GRANULARITY_MS } from '../src/budget';
import { MUTE_FOREVER, type Store } from '../src/store';
import { StoreError } from '../src/store-error';
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
type Attachment = { userId?: string; closing?: boolean; pres?: { s: string; a: number; h?: number }; owed?: Array<[string, string, string, number, number?]>; choice?: string; muteUntil?: number; roomMuteNext?: number; seen?: number };

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

describe('the status a user chooses (§4.5)', () => {
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
			await status(bob, { idle: 0 });
			await status(bobToo, { idle: 0 });
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
			// A value this server does not support is "" (§4.5), and so is shown.
			for (const unsupported of ['busy', 'idle', 'offline', 'DND']) {
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
			// A registration that wakes for messages never makes anyone idle.
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
			// Connected, invisible: listed as stored members are, offline, with
			// the seen its change to offline carried.
			const hidden = seen.find((frame) => frame.params?.new?.user_id === shyId && frame.params.new.status === 'offline')!;
			expect(list.result.users.find((user: { user_id: string }) => user.user_id === shyId)).toEqual({ user_id: shyId, name: `Name of ${shyId}`, roles: [], status: 'offline', seen: hidden.params.new.seen });
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
			await status(bob, { idle: 0 });
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
				runtime.handleStatus(socket, { method: 'status', id: 'idle', params: { idle: 0 }, full: false });
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
			for (const idle of [0, false, 0, false, 0]) await status(flipper, { idle });
			mine.push(...await status(second, { idle: 0 }));
			// Five changes, then a sixth, in the minute: only the latest goes out, once.
			await advance(COALESCE);
			expect(told(await drain(watcher), flipperId)).toEqual(['idle']);
			// Back and forth within the next minute, ending where it was told: nothing.
			mine.push(...await status(second, { idle: false }));
			mine.push(...await status(second, { idle: 0 }));
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
			await status(mobile, { idle: 0 });
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
			await status(stayer, { idle: 0 });
			await hangUp(leaver, leaverId);
			await advance(1_000);
			const held = await attachments();
			expect(held.find((state) => state.userId === stayerId && !state.closing)?.pres).toMatchObject({ s: 'online' });
			// The change to offline carries seen, when the leaver left.
			const owed = held.find((state) => state.userId === watcherId)?.owed;
			expect(owed).toEqual([[leaverId, 'online', 'offline', expect.any(Number), expect.any(Number)]]);
			// The object is evicted (a pending timer keeps it from hibernating, but
			// not from being evicted): its timer and memory are gone, the
			// attachments stay.
			await evict();
			offset += Math.max(COALESCE, GRACE);
			// The next event sweeps the attachments and announces what is due.
			const frames = await drain(watcher);
			expect(told(frames, leaverId)).toEqual(['offline']);
			expect(frames.find((frame) => frame.params?.new?.user_id === leaverId)!.params.new).toEqual({ user_id: leaverId, status: 'offline', seen: String(owed![0][4]) });
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
			await status(joiner, { idle: 0 });
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
			store.settleSeen({ userId, at: now - 1_000, now });
			store.renameIdentity({ from: userId, to: `${userId}x`, now });
			expect(store.statusInputs(userId, now)).toEqual({ choice: 'online', roomMutes: [] });
			expect(store.statusInputs(`${userId}x`, now)).toEqual({ choice: 'invisible', muteUntil: now + 60_000, roomMutes: [{ roomId: 'general', untilMs: MUTE_FOREVER }] });
			// `seen` moves with the identity row, which a sign-in reads.
			expect(store.getIdentity(`${userId}x`)?.seen).toBe(now - 1_000);
			store.setMute({ userId: `${userId}x`, untilMs: null, now });
			expect(store.statusInputs(`${userId}x`, now)).toEqual({ choice: 'invisible', roomMutes: [{ roomId: 'general', untilMs: MUTE_FOREVER }] });
			store.purgeUsers({ userIds: [`${userId}x`], now });
			expect(store.statusInputs(`${userId}x`, now)).toEqual({ choice: 'online', roomMutes: [] });
			expect(store.getIdentity(`${userId}x`)).toBeNull();
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
			// (§4.5), for each user it shares a room with; `you` keeps the choice.
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
			// Off: no status shown to others, nor sent after auth; the chosen one
			// is kept and in `you`. Listings still carry `status`, as §4.5 has
			// every listing do, and it is `""` (none) for everyone, as off told.
			const offList = await listing(watcher);
			expect(offList.get(watcherId)).toMatchObject({ status: '' });
			expect(offList.get(adminId)).toMatchObject({ status: '' });
			expect([...offList.values()].every((user) => user.status === '')).toBe(true);
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
			// Each signed-in connection is sent the statuses others see, as after
			// a sign-in: the watcher learns the admin is online again; the admin
			// is told nothing of the invisible watcher.
			expect(told(on.skipped, watcherId)).toEqual([]);
			expect(told(await drain(watcher), adminId)).toEqual(['online']);
			// On again, it starts from each user's status now, announcing nothing
			// for it; the invisible chosen while off holds, so others see offline.
			expect(await listed(admin, watcherId)).toMatchObject({ status: 'offline' });
			await forgetAnnouncements();
			await choose(watcher, 'online');
			expect(told(await drain(admin), watcherId)).toEqual(['online']);
		} finally { admin.close(); watcher.close(); }
	});
});

/** The frames among `frames` that §4.5 sends after a sign-in: mutes in effect (`status`) and others' statuses. */
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

describe('server.status and what follows a sign-in (§3.1, §4.5)', () => {
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
			const sent = await status(peer, { room_id: 'general', idle: 0, mute: true });
			expect(sent.filter((frame) => frame.method === 'status').map((frame) => frame.params)).toEqual([{ room_id: 'general', mute: true }]);
			expect((await drain(other)).filter((frame) => frame.method === 'status').map((frame) => frame.params)).toEqual([{ room_id: 'general', mute: true }]);
			expect(await idleOf()).toEqual([false, true]);
			const stored = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.statusInputs(userId, Date.now()));
			expect(stored).toEqual({ choice: 'online', roomMutes: [{ roomId: 'general', untilMs: MUTE_FOREVER }] });
			// idle with a room_id and no mute is invalid_params (§4.5): nothing changes, nothing is sent.
			const refused = await statusRequest(peer, { room_id: 'nowhere', idle: false });
			expect(refused.frame.error.code).toBe(-32602);
			expect(signInSends(refused.skipped)).toEqual([]);
			expect(await idleOf()).toEqual([false, true]);
			const back = await status(peer, { idle: false });
			expect(signInSends(back)).toEqual([]);
			expect(await idleOf()).toEqual([false, false]);
			expect((await drain(other)).filter((frame) => frame.method === 'status')).toEqual([]);
		} finally { peer.close(); other.close(); }
	});
});

describe('sign-ins, listings and attendance', () => {
	beforeEach(forgetAnnouncements);

	it('sends nothing after a repeat auth as the same user on the same connection, token or guest', async () => {
		const busyId = unique('busy');
		const busy = await signedIn(busyId);
		const userId = unique('repeat');
		await register(userId);
		await storeMutes(userId);
		const token = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).issueSession(userId, 'http://localhost:5173', Date.now()));
		const peer = await opened();
		try {
			await choose(busy, 'dnd');
			const first = await exchange(peer, 'auth', 'auth', { scheme: 'token', token });
			expect(first.frame.result.you.user_id).toBe(userId);
			// The sign-in sends the mutes and Busy's status.
			const after = await drain(peer);
			expect(after.filter((frame) => frame.method === 'status')).toHaveLength(2);
			expect(told(after, busyId)).toEqual(['dnd']);
			// The same token again on the same connection is not a sign-in: no
			// mutes, no statuses, whatever its answer.
			const again = await exchange(peer, 'auth-again', 'auth', { scheme: 'token', token });
			expect(signInSends([...again.skipped, ...await drain(peer)])).toEqual([]);
			// Nor is a guest auth on it.
			const asGuest = await exchange(peer, 'auth-guest', 'auth', { scheme: 'guest' });
			expect(asGuest.frame.result.you.user_id).toBe(userId);
			expect(signInSends([...asGuest.skipped, ...await drain(peer)])).toEqual([]);
			// A guest's own repeat is the same.
			const { peer: visitor, userId: guestId } = await guest();
			try {
				const repeated = await exchange(visitor, 'again', 'auth', { scheme: 'guest' });
				expect(repeated.frame.result.you.user_id).toBe(guestId);
				expect(signInSends([...repeated.skipped, ...await drain(visitor)])).toEqual([]);
			} finally { visitor.close(); }
		} finally { busy.close(); peer.close(); }
	});

	it('carries status on every current user object in room_list and room_update, offline and "" included, and "" for all with presence off', async () => {
		const observerId = unique('observer');
		const ids = { gone: unique('gone'), none: unique('none'), dnd: unique('dnd') };
		for (const id of Object.values(ids)) await register(id);
		await runInDurableObject(stub(), (instance) => {
			const { store } = instance as unknown as Runtime;
			store.setStatus({ userId: ids.none, choice: '', now: Date.now() });
			store.setStatus({ userId: ids.dnd, choice: 'dnd', now: Date.now() });
		});
		const observer = await signedIn(observerId);
		const dnd = await signedIn(ids.dnd, { existing: true });
		const setPresence = (presence: boolean) => runInDurableObject(stub(), (instance) => {
			const runtime = instance as unknown as Runtime;
			runtime.config = { ...runtime.config, presence };
		});
		/** The users of a `room_update` `joined` for general, as a repeated join sends it. */
		const joined = async (id: string): Promise<Map<string, Record<string, unknown>>> => {
			await runInDurableObject(stub(), (instance) => (instance as unknown as { store: { memberCache: Map<string, unknown> } }).store.memberCache.clear());
			const { skipped } = await exchange(observer, id, 'room_join', { room_id: 'general' });
			const update = skipped.find((frame) => frame.method === 'room_update' && frame.params.joined);
			expect(update, id).toBeDefined();
			return new Map(update!.params.users.map((user: { user_id: string }) => [user.user_id, user]));
		};
		try {
			for (const users of [await listing(observer), await joined('join-on')]) {
				expect([...users.values()].every((user) => typeof user.status === 'string')).toBe(true);
				expect(users.get(ids.gone)).toMatchObject({ status: 'offline' });
				expect(users.get(ids.none)).toMatchObject({ status: '' });
				expect(users.get(ids.dnd)).toMatchObject({ status: 'dnd' });
				expect(users.get(observerId)).toMatchObject({ status: 'online' });
			}
			// Presence off, capability `status` still advertised: `status` is
			// still on every object, and it is `""` (none), as off told clients.
			await setPresence(false);
			try {
				for (const users of [await listing(observer), await joined('join-off')]) {
					expect(users.size).toBeGreaterThanOrEqual(4);
					expect([...users.values()].every((user) => user.status === '')).toBe(true);
				}
			} finally { await setPresence(true); }
		} finally { observer.close(); dnd.close(); }
	});

	it('never infers idle: a connection that never sent idle stays online to others however long it is quiet', async () => {
		const watcherId = unique('watcher');
		const watcher = await signedIn(watcherId);
		const userId = unique('quiet');
		await register(userId);
		const token = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).issueSession(userId, 'http://localhost:5173', Date.now()));
		const quiet = await opened();
		try {
			// Signed in, it never sends `status`.
			expect((await request(quiet, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
			await advance(COALESCE);
			expect(told(await drain(watcher), userId)).toEqual(['online']);
			// An hour without a frame from it: still attended, so nothing changes.
			await advance(60 * 60_000);
			await advance(COALESCE);
			expect(told(await drain(watcher), userId)).toEqual([]);
			expect(await listed(watcher, userId)).toMatchObject({ status: 'online' });
			const attended = await runInDurableObject(stub(), (instance) => (instance as unknown as { attended(userId: string, now: number): boolean }).attended(userId, Date.now()));
			expect(attended).toBe(true);
			// Only `idle` with seconds makes it idle.
			await status(quiet, { idle: 0 });
			await advance(COALESCE);
			expect(told(await drain(watcher), userId)).toEqual(['idle']);
		} finally { watcher.close(); quiet.close(); }
	});

	it('changes nothing for an invalid me: the name is checked before the status applies (B3)', async () => {
		const watcherId = unique('watcher');
		const watcher = await signedIn(watcherId);
		const userId = unique('atomic');
		const peer = await signedIn(userId);
		try {
			await drain(watcher);
			for (const params of [
				{ name: 'n'.repeat(DEFAULT_LIMITS.maxNameCodePoints + 1), status: 'dnd' },
				{ name: '€'.repeat(Math.ceil(DEFAULT_LIMITS.maxNameBytes / 3) + 1), status: 'dnd' },
				{ name: 7, status: 'dnd' },
				{ avatar: 7, status: 'dnd' },
			]) {
				const reply = await request(peer, `bad-${crypto.randomUUID()}`, 'me', params);
				expect(reply.error, JSON.stringify(params)).toBeDefined();
				expect((await request(peer, `still-${crypto.randomUUID()}`, 'me', {})).result.you.status, JSON.stringify(params)).toBe('online');
				// Each is a policy violation: forgiven, so the connection stays open.
				await runInDurableObject(stub(), (_instance, state) => {
					for (const socket of state.getWebSockets()) socket.serializeAttachment({ ...(socket.deserializeAttachment() as object), policyViolations: [] });
				});
			}
			expect(told(await drain(watcher), userId)).toEqual([]);
			const stored = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.statusInputs(userId, Date.now()));
			expect(stored.choice).toBe('online');
			// None of them spent the status limit: the limit's worth of changes still applies.
			for (let index = 0; index < PUSH_POLICY!.mutesPerUserMinute; index++) {
				expect((await choose(peer, index % 2 ? 'online' : 'dnd')).error).toBeUndefined();
			}
		} finally { watcher.close(); peer.close(); }
	});

	it('reads the status and mutes before issuing a passkey session, so a failed read leaves no session', async () => {
		const fresh = await opened();
		const login = await opened();
		try {
			const { passkey, finished } = await registerPasskey(fresh, 'orphan');
			const userId = finished.frame.result.you.user_id;
			const sessions = () => runInDurableObject(stub(), async (_instance, state) => (await state.storage.list({ prefix: 'session:' })).size);
			const before = await sessions();
			const order: string[] = [];
			await runInDurableObject(stub(), (instance) => {
				const runtime = instance as unknown as Runtime & { issueSession: Runtime['issueSession'] };
				vi.spyOn(runtime.store, 'statusInputs').mockImplementationOnce(() => { order.push('read'); throw new Error('storage unavailable'); });
				const issue = runtime.issueSession.bind(runtime);
				vi.spyOn(runtime, 'issueSession').mockImplementation((...args) => { order.push('issue'); return issue(...args); });
			});
			const begun = await request(login, 'login-begin', 'auth', { scheme: 'webauthn', action: 'login', step: 'begin' });
			const credential = await passkey.assert(begun.result.public_key);
			const failed = await request(login, 'login-finish', 'auth', { scheme: 'webauthn', action: 'login', step: 'finish', challenge_id: begun.result.challenge_id, credential });
			expect(failed.error.code).toBe(-32603);
			expect(failed.error.message).toMatch(/sign in again/);
			expect(order).toEqual(['read']);
			expect(await sessions()).toBe(before);
			expect((await attachments()).filter((attachment) => attachment.userId === userId && !attachment.closing)).toHaveLength(1);
		} finally { fresh.close(); login.close(); }
	});
});

describe('a guest connection signing in (§3.3)', () => {
	beforeEach(forgetAnnouncements);

	/** The `user` frames among `frames` that link an `old` identity. */
	const links = (frames: Frame[]) => frames.filter((frame) => frame.method === 'user' && frame.params?.old !== undefined);

	/** A guest whose `online` the watcher has been told. */
	async function toldGuest(watcher: Peer): Promise<{ peer: Peer; userId: string; frames: Frame[] }> {
		const visitor = await guest();
		const frames = await drain(watcher);
		expect(told(frames, visitor.userId)).toEqual(['online']);
		return { ...visitor, frames };
	}

	it('links the guest to a new account with old: passkey registration and invite sign-up', async () => {
		const watcherId = unique('watcher');
		const watcher = await signedIn(watcherId);
		const peers: Peer[] = [watcher];
		try {
			// Passkey registration: the same person under a new user_id.
			const registering = await toldGuest(watcher);
			peers.push(registering.peer);
			const { finished } = await registerPasskey(registering.peer, 'new-account');
			const accountId = finished.frame.result.you.user_id;
			const linked = links(await drain(watcher));
			expect(linked).toHaveLength(1);
			expect(linked[0].params.old.user_id).toBe(registering.userId);
			expect(linked[0].params.new.user_id).toBe(accountId);

			// Sign-up invite: a new account too.
			await forgetAnnouncements();
			const joining = await toldGuest(watcher);
			peers.push(joining.peer);
			const invite = `apron_join_${crypto.randomUUID().replaceAll('-', '')}`;
			const inviteKey = `join-token:${await sha256Hex(invite)}`;
			await runInDurableObject(stub(), (_instance, state) => state.storage.put(inviteKey, { v: 1, remaining: 1, expiresMs: Date.now() + 3_600_000 }));
			const joined = await request(joining.peer, 'join', 'auth', { scheme: 'token', token: invite, name: 'Joiner' });
			expect(joined.error, JSON.stringify(joined.error)).toBeUndefined();
			const joinedLinks = links(await drain(watcher));
			expect(joinedLinks).toHaveLength(1);
			expect(joinedLinks[0].params.old.user_id).toBe(joining.userId);
			expect(joinedLinks[0].params.new.user_id).toBe(joined.result.you.user_id);
		} finally { for (const peer of peers) peer.close(); }
	}, 20_000);

	it('lets the guest depart when it signs in to an existing account: no old link, offline after the grace', async () => {
		const watcherId = unique('watcher');
		const watcher = await signedIn(watcherId);
		const accountId = unique('account');
		await register(accountId);
		const token = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).issueSession(accountId, 'http://localhost:5173', Date.now()));
		const visitor = await toldGuest(watcher);
		try {
			const resumed = await exchange(visitor.peer, 'resume', 'auth', { scheme: 'token', token });
			expect(resumed.frame.result.you.user_id).toBe(accountId);
			const after = await drain(watcher);
			expect(links(after)).toEqual([]);
			// The account shows through its status, as any sign-in does.
			expect(told(after, accountId)).toEqual(['online']);
			// The guest departs like a guest that disconnects: offline, after the grace.
			expect(told(after, visitor.userId)).toEqual([]);
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			expect(told(await drain(watcher), visitor.userId)).toEqual(['offline']);
			// And is gone from connected members, with nothing left of it on the connection.
			const members = await listing(watcher);
			expect(members.has(visitor.userId)).toBe(false);
			expect(members.get(accountId)).toMatchObject({ status: 'online' });
		} finally { watcher.close(); visitor.peer.close(); }
	});

	it('never tells others that an invisible existing account connected: passkey login and invite token', async () => {
		const watcherId = unique('watcher');
		const watcher = await signedIn(watcherId);
		const peers: Peer[] = [watcher];
		try {
			// An invisible account made with a passkey, signed out again.
			const maker = await opened();
			peers.push(maker);
			const { passkey, finished } = await registerPasskey(maker, 'hidden');
			const hiddenId = finished.frame.result.you.user_id;
			expect((await choose(maker, 'invisible')).result.you.status).toBe('invisible');
			await hangUp(maker, hiddenId);
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			await drain(watcher);
			// An invisible account an invite token signs in to.
			const invitedId = unique('invited');
			await register(invitedId);
			await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.setStatus({ userId: invitedId, choice: 'invisible', now: Date.now() }));
			const invite = `apron_invite_${crypto.randomUUID().replaceAll('-', '')}`;
			await runInDurableObject(stub(), async (_instance, state) => state.storage.put(`invite-token:${await sha256Hex(invite)}`, { v: 1, userId: invitedId }));

			const seen: Frame[] = [];
			// Passkey login on a guest's connection.
			await forgetAnnouncements();
			const loginGuest = await toldGuest(watcher);
			peers.push(loginGuest.peer);
			const begun = await request(loginGuest.peer, 'login-begin', 'auth', { scheme: 'webauthn', action: 'login', step: 'begin' });
			const credential = await passkey.assert(begun.result.public_key);
			const loggedIn = await request(loginGuest.peer, 'login-finish', 'auth', { scheme: 'webauthn', action: 'login', step: 'finish', challenge_id: begun.result.challenge_id, credential });
			expect(loggedIn.result.you).toMatchObject({ user_id: hiddenId, status: 'invisible' });
			seen.push(...await drain(watcher));
			// An invite token on another guest's connection.
			await forgetAnnouncements();
			const inviteGuest = await toldGuest(watcher);
			peers.push(inviteGuest.peer);
			seen.push(...inviteGuest.frames);
			const invited = await request(inviteGuest.peer, 'invited', 'auth', { scheme: 'token', token: invite });
			expect(invited.result.you).toMatchObject({ user_id: invitedId, status: 'invisible' });
			seen.push(...await drain(watcher));
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			seen.push(...await drain(watcher));

			// No link, nothing about either account; each guest just went offline.
			expect(links(seen)).toEqual([]);
			expect(JSON.stringify(seen)).not.toContain(hiddenId);
			expect(JSON.stringify(seen)).not.toContain(invitedId);
			expect(told(seen, loginGuest.userId)).toEqual(['offline']);
			// (`seen` holds the invite guest's own `online` from before it signed in.)
			expect(told(seen, inviteGuest.userId)).toEqual(['online', 'offline']);
			const members = await listing(watcher);
			for (const id of [hiddenId, invitedId]) expect(members.get(id) ?? { status: 'offline' }, id).toMatchObject({ status: 'offline' });
			expect(members.has(loginGuest.userId)).toBe(false);
		} finally { for (const peer of peers) peer.close(); }
	}, 20_000);
});

describe('a sign-in that logs joins', () => {
	/** The `room_update` frames carrying a logged membership of `userId`. */
	const joins = (frames: Frame[], userId: string) => frames.filter((frame) => frame.method === 'room_update' &&
		frame.params.memberships?.some((record: { members: Array<{ user: { user_id: string } }> }) => record.members.some((entry) => entry.user.user_id === userId)));

	it('sends a new account\'s logged joins to its own connection after the auth result, and to other members at once (§3.2)', async () => {
		const watcher = await guest();
		const fresh = await opened();
		const { peer: visitor } = await guest();
		try {
			// A connection not signed in yet gets the join after its result.
			const { finished } = await registerPasskey(fresh, 'fresh');
			const freshId = finished.frame.result.you.user_id;
			expect(joins(finished.skipped, freshId)).toEqual([]);
			expect(joins(await drain(fresh), freshId)).toHaveLength(1);
			// So does a guest's connection, though it was in general already.
			const { finished: upgraded } = await registerPasskey(visitor, 'visitor');
			const upgradedId = upgraded.frame.result.you.user_id;
			expect(joins(upgraded.skipped, upgradedId)).toEqual([]);
			expect(joins(await drain(visitor), upgradedId)).toHaveLength(1);
			// Other members of general got each one.
			const seen = await drain(watcher.peer);
			expect(joins(seen, freshId)).toHaveLength(1);
			expect(joins(seen, upgradedId)).toHaveLength(1);
		} finally { watcher.peer.close(); fresh.close(); visitor.close(); }
	});
});

describe('seen: when the shown status last became offline (§4.5.2)', () => {
	beforeEach(forgetAnnouncements);

	/** The `user` `new` objects `frames` carry for `userId`'s status, in order. */
	const shown = (frames: Frame[], userId: string): Array<Record<string, unknown>> =>
		frames.filter((frame) => frame.method === 'user' && frame.params?.new?.user_id === userId && frame.params.new.status !== undefined).map((frame) => frame.params.new);

	/** `userId`'s stored seen_ms, 0 for none. */
	const stored = (userId: string): Promise<number> => runInDurableObject(stub(), (_instance, state) =>
		Number(state.storage.sql.exec<{ seen_ms: number }>('SELECT seen_ms FROM identities WHERE user_id = ?', userId).toArray()[0]?.seen_ms ?? 0));

	/** No `you` among `frames` (and no auth or me result) carries seen. */
	const expectNoOwnSeen = (frames: Frame[]) => {
		for (const frame of frames) {
			expect(frame.params?.you ?? {}).not.toHaveProperty('seen');
			expect(frame.result?.you ?? {}).not.toHaveProperty('seen');
		}
	};

	it('sends seen with a disconnect, keeps it in later listings, and leaves it out while the shown status is not offline or in you', async () => {
		const watcherId = unique('watcher');
		const leaverId = unique('leaver');
		const watcher = await signedIn(watcherId);
		let leaver = await signIn(leaverId);
		try {
			expect(shown(await drain(watcher), leaverId)).toEqual([{ user_id: leaverId, status: 'online' }]);
			expectNoOwnSeen([leaver.auth, ...leaver.afterAuth]);
			// Online: no seen, though none is recorded anyway.
			expect(await listed(watcher, leaverId)).not.toHaveProperty('seen');
			const left = Date.now();
			await hangUp(leaver.peer, leaverId);
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			const [offline] = shown(await drain(watcher), leaverId);
			// A log_id-format timestamp: when the last connection closed.
			expect(offline).toEqual({ user_id: leaverId, status: 'offline', seen: expect.stringMatching(/^[1-9]\d*$/) });
			const seen = Number(offline.seen);
			expect(seen).toBeGreaterThanOrEqual(left);
			expect(seen).toBeLessThanOrEqual(Date.now());
			expect(await stored(leaverId)).toBe(seen);
			// A later listing carries the same seen with the shown offline.
			expect(await listed(watcher, leaverId)).toMatchObject({ status: 'offline', seen: offline.seen });
			// Back online: the kept seen is not shown, and never in their own you.
			leaver = await signIn(leaverId, { existing: true });
			expectNoOwnSeen([leaver.auth, ...leaver.afterAuth, await request(leaver.peer, 'me', 'me', {}), await choose(leaver.peer, 'dnd')]);
			expect(shown(await drain(watcher), leaverId)).toEqual([{ user_id: leaverId, status: 'dnd' }]);
			const back = await listing(leaver.peer);
			expect(back.get(leaverId)).toEqual(expect.objectContaining({ status: 'dnd' }));
			expect(back.get(leaverId)).not.toHaveProperty('seen');
			expect(back.get(watcherId)).not.toHaveProperty('seen');
			// A dnd user who disconnects, longer than SEEN_WRITE_GRANULARITY_MS
			// after the stored seen, is shown offline with a new one.
			offset += SEEN_WRITE_GRANULARITY_MS;
			await hangUp(leaver.peer, leaverId);
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			const [again] = shown(await drain(watcher), leaverId);
			expect(again).toEqual({ user_id: leaverId, status: 'offline', seen: expect.stringMatching(/^\d+$/) });
			expect(Number(again.seen)).toBeGreaterThan(seen);
			expect(await listed(watcher, leaverId)).toMatchObject({ status: 'offline', seen: again.seen });
			// A reconnect within the grace shows nothing, and leaves the shown seen as it was.
			const quick = await signIn(leaverId, { existing: true });
			await hangUp(quick.peer, leaverId);
			const brief = await signIn(leaverId, { existing: true });
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			expect(shown(await drain(watcher), leaverId)).toEqual([{ user_id: leaverId, status: 'dnd' }]);
			brief.peer.close();
		} finally { watcher.close(); leaver.peer.close(); }
	});

	it('shows a chosen invisible offline with seen, and its connections coming and going never move it', async () => {
		const watcherId = unique('watcher');
		const shyId = unique('shy');
		const watcher = await signedIn(watcherId);
		let shy = await signedIn(shyId);
		try {
			await drain(watcher);
			const before = Date.now();
			const chosen = await choose(shy, 'invisible');
			expect(chosen.result.you).toEqual(expect.objectContaining({ user_id: shyId, status: 'invisible' }));
			expectNoOwnSeen([chosen]);
			const [hidden] = shown(await drain(watcher), shyId);
			expect(hidden).toEqual({ user_id: shyId, status: 'offline', seen: expect.stringMatching(/^\d+$/) });
			expect(Number(hidden.seen)).toBeGreaterThanOrEqual(before);
			expect(await stored(shyId)).toBe(Number(hidden.seen));
			// Connected and invisible: listed offline with that seen, from the connections.
			expect(await listed(watcher, shyId)).toMatchObject({ status: 'offline', seen: hidden.seen });
			// Its own listing shows others' view of it, as any listing does; its you does not.
			expect((await listing(shy)).get(shyId)).toMatchObject({ status: 'offline', seen: hidden.seen });
			// A second connection comes and goes, then the first: nothing is sent, seen stays.
			const second = await signIn(shyId, { existing: true });
			expectNoOwnSeen([second.auth, ...second.afterAuth]);
			await hangUp(second.peer, shyId);
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			await hangUp(shy, shyId);
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			expect(shown(await drain(watcher), shyId)).toEqual([]);
			expect(await stored(shyId)).toBe(Number(hidden.seen));
			expect(await listed(watcher, shyId)).toMatchObject({ status: 'offline', seen: hidden.seen });
			// Signing in again, still invisible: nothing, and the listing's seen is unchanged.
			shy = await signedIn(shyId, { existing: true });
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			expect(shown(await drain(watcher), shyId)).toEqual([]);
			expect(await listed(watcher, shyId)).toMatchObject({ status: 'offline', seen: hidden.seen });
			// Visible again, then invisible again: a new change to offline, which
			// within SEEN_WRITE_GRANULARITY_MS carries the stored seen again.
			await choose(shy, 'online');
			offset += 1_000;
			await choose(shy, 'invisible');
			expect(shown(await drain(watcher), shyId)).toEqual([{ user_id: shyId, status: 'online' }, { user_id: shyId, status: 'offline', seen: hidden.seen }]);
			// Past it, a new seen.
			offset += SEEN_WRITE_GRANULARITY_MS;
			await choose(shy, 'online');
			await choose(shy, 'invisible');
			const changes = shown(await drain(watcher), shyId);
			expect(changes).toEqual([{ user_id: shyId, status: 'online' }, { user_id: shyId, status: 'offline', seen: expect.stringMatching(/^\d+$/) }]);
			expect(Number(changes[1].seen)).toBeGreaterThan(Number(hidden.seen) + SEEN_WRITE_GRANULARITY_MS);
			expect(await stored(shyId)).toBe(Number(changes[1].seen));
		} finally { watcher.close(); shy.close(); }
	});

	it('gives "" no seen, and a guest a seen kept only on its connection', async () => {
		const watcherId = unique('watcher');
		const noneId = unique('none');
		const watcher = await signedIn(watcherId);
		const none = await signedIn(noneId);
		const visitor = await guest();
		const hiding = await guest();
		try {
			await drain(watcher);
			await choose(none, '');
			expect(shown(await drain(watcher), noneId)).toEqual([{ user_id: noneId, status: '' }]);
			await hangUp(none, noneId);
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			expect(shown(await drain(watcher), noneId)).toEqual([]);
			expect(await stored(noneId)).toBe(0);
			expect(await listed(watcher, noneId)).toEqual(expect.not.objectContaining({ seen: expect.anything() }));
			// A guest that disconnects is shown offline with seen; guests have no row to keep it.
			await hangUp(visitor.peer, visitor.userId);
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			expect(shown(await drain(watcher), visitor.userId)).toEqual([{ user_id: visitor.userId, status: 'offline', seen: expect.stringMatching(/^\d+$/) }]);
			// A guest that chooses invisible too, and its connection keeps that seen.
			await choose(hiding.peer, 'invisible');
			const [hidden] = shown(await drain(watcher), hiding.userId);
			expect(hidden).toEqual({ user_id: hiding.userId, status: 'offline', seen: expect.stringMatching(/^\d+$/) });
			expect((await attachments()).find((state) => state.userId === hiding.userId && !state.closing)?.seen).toBe(Number(hidden.seen));
			// It goes without anything sent: it was already shown offline.
			await hangUp(hiding.peer, hiding.userId);
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			expect(shown(await drain(watcher), hiding.userId)).toEqual([]);
		} finally { watcher.close(); none.close(); visitor.peer.close(); hiding.peer.close(); }
	});

	it('keeps seen across eviction, and updates listings kept for reuse in place', async () => {
		const watcherId = unique('watcher');
		const leaverId = unique('leaver');
		const watcher = await signedIn(watcherId);
		const leaver = await signedIn(leaverId);
		try {
			await drain(watcher);
			await hangUp(leaver, leaverId);
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			const [offline] = shown(await drain(watcher), leaverId);
			expect(offline.seen).toMatch(/^\d+$/);
			await evict();
			expect(await listed(watcher, leaverId)).toMatchObject({ status: 'offline', seen: offline.seen });
			// A listing kept for reuse is updated by a later seen without reading again.
			const reuse = await runInDurableObject(stub(), (instance, state) => {
				const runtime = instance as unknown as Runtime & { membersOf(ids: string[]): Map<string, Array<{ user_id: string; seen?: string }>> };
				runtime.membersOf(['general']);
				// Past SEEN_WRITE_GRANULARITY_MS, so it is written.
				const later = Number(offline.seen) + SEEN_WRITE_GRANULARITY_MS + 1_000;
				runtime.store.settleSeen({ userId: leaverId, at: later, now: Date.now() });
				let members: Map<string, Array<{ user_id: string; seen?: string }>> | undefined;
				const sql = statements(state, /FROM memberships m/, () => { members = runtime.membersOf(['general']); });
				return { queries: sql.queries, seen: members!.get('general')!.find((user) => user.user_id === leaverId)?.seen, later };
			});
			expect(reuse.queries).toEqual([]);
			expect(reuse.seen).toBe(String(reuse.later));
		} finally { watcher.close(); leaver.close(); }
	});
});

describe('seen is written at most once in SEEN_WRITE_GRANULARITY_MS', () => {
	beforeEach(forgetAnnouncements);

	const WAIT = Math.max(COALESCE, GRACE) + 1_000;
	const DAY = 24 * 60 * 60_000;

	/** The `user` `new` objects `frames` carry for `userId`'s status changes (not a /rename's), in order. */
	const shown = (frames: Frame[], userId: string): Array<Record<string, unknown>> =>
		frames.filter((frame) => frame.method === 'user' && !frame.params?.old && frame.params?.new?.user_id === userId && frame.params.new.status !== undefined).map((frame) => frame.params.new);

	/** `userId`'s stored seen_ms, 0 for none. */
	const stored = (userId: string): Promise<number> => runInDurableObject(stub(), (_instance, state) =>
		Number(state.storage.sql.exec<{ seen_ms: number }>('SELECT seen_ms FROM identities WHERE user_id = ?', userId).toArray()[0]?.seen_ms ?? 0));

	/**
	 * Records the SQL the object runs from now until the test ends (afterEach
	 * restores sql.exec), with each statement's bindings.
	 */
	async function recordSql(): Promise<Array<{ query: string; bindings: unknown[]; written: () => number }>> {
		const log: Array<{ query: string; bindings: unknown[]; written: () => number }> = [];
		await runInDurableObject(stub(), (_instance, state) => {
			const sql = state.storage.sql;
			const original = sql.exec.bind(sql);
			vi.spyOn(sql, 'exec').mockImplementation(((query: string, ...bindings: unknown[]) => {
				const cursor = original(query, ...(bindings as []));
				log.push({ query: query.replace(/\s+/g, ' ').trim(), bindings, written: () => cursor.rowsWritten });
				return cursor;
			}) as typeof sql.exec);
		});
		return log;
	}

	/** The seen values written for `userId` in `log` (statements that wrote a row), in order. */
	const writes = (log: Array<{ query: string; bindings: unknown[]; written: () => number }>, userId: string): unknown[] =>
		log.filter((entry) => /^UPDATE identities SET seen_ms/.test(entry.query) && entry.bindings[1] === userId && entry.written() > 0).map((entry) => entry.bindings[0]);

	/** The seen each of `userId`'s open connections holds. */
	const held = async (userId: string): Promise<Array<number | undefined>> =>
		(await attachments()).filter((state) => state.userId === userId && !state.closing).map((state) => state.seen);

	/** Signs `userId` in again and lets others be told they are back. */
	async function back(watcher: Peer, userId: string): Promise<Peer> {
		const peer = await signedIn(userId, { existing: true });
		await advance(COALESCE + 1_000);
		expect(shown(await drain(watcher), userId)).toEqual([{ user_id: userId, status: 'online' }]);
		return peer;
	}

	it('re-announces a stored seen within it with no write, writes a later departure, and never misses a brief return after a week', async () => {
		const watcherId = unique('watcher');
		const leaverId = unique('leaver');
		const watcher = await signedIn(watcherId);
		let leaver = await signedIn(leaverId);
		const sql = await recordSql();
		try {
			await drain(watcher);
			await hangUp(leaver, leaverId);
			await advance(WAIT);
			const [first] = shown(await drain(watcher), leaverId);
			expect(first).toEqual({ user_id: leaverId, status: 'offline', seen: expect.stringMatching(/^\d+$/) });
			const s1 = Number(first.seen);
			expect(writes(sql, leaverId)).toEqual([s1]);
			expect(await stored(leaverId)).toBe(s1);
			expect(await listed(watcher, leaverId)).toMatchObject({ status: 'offline', seen: first.seen });

			// Back within it: the sign-in keeps the stored seen on the connection.
			leaver = await back(watcher, leaverId);
			expect(await held(leaverId)).toEqual([s1]);
			// Gone again a few minutes later: the stored seen stands, announced again, unwritten.
			offset += 3 * 60_000;
			await hangUp(leaver, leaverId);
			await advance(WAIT);
			expect(shown(await drain(watcher), leaverId)).toEqual([{ user_id: leaverId, status: 'offline', seen: first.seen }]);
			expect(writes(sql, leaverId)).toEqual([s1]);
			expect(await listed(watcher, leaverId)).toMatchObject({ status: 'offline', seen: first.seen });

			// A reload within the grace: nothing announced, nothing written.
			leaver = await back(watcher, leaverId);
			await hangUp(leaver, leaverId);
			leaver = await signedIn(leaverId, { existing: true });
			await advance(WAIT);
			expect(shown(await drain(watcher), leaverId)).toEqual([]);
			expect(writes(sql, leaverId)).toEqual([s1]);
			expect(await held(leaverId)).toEqual([s1]);

			// Gone longer than SEEN_WRITE_GRANULARITY_MS after the stored seen: a new one, written.
			offset += SEEN_WRITE_GRANULARITY_MS;
			const left = Date.now();
			await hangUp(leaver, leaverId);
			await advance(WAIT);
			const [second] = shown(await drain(watcher), leaverId);
			const s2 = Number(second.seen);
			expect(s2).toBeGreaterThanOrEqual(left);
			expect(s2).toBeGreaterThan(s1 + SEEN_WRITE_GRANULARITY_MS);
			expect(writes(sql, leaverId)).toEqual([s1, s2]);
			expect(await stored(leaverId)).toBe(s2);
			expect(await listed(watcher, leaverId)).toMatchObject({ status: 'offline', seen: second.seen });

			// Away a week, back for a minute, gone again: the new departure is recorded.
			offset += 7 * DAY;
			await drain(watcher);
			leaver = await back(watcher, leaverId);
			offset += 60_000;
			const returned = Date.now();
			await hangUp(leaver, leaverId);
			await advance(WAIT);
			const [third] = shown(await drain(watcher), leaverId);
			const s3 = Number(third.seen);
			expect(third).toEqual({ user_id: leaverId, status: 'offline', seen: String(s3) });
			expect(s3).toBeGreaterThanOrEqual(returned);
			expect(s3 - s2).toBeGreaterThan(7 * DAY);
			expect(writes(sql, leaverId)).toEqual([s1, s2, s3]);
			expect(await stored(leaverId)).toBe(s3);
			expect(await listed(watcher, leaverId)).toMatchObject({ status: 'offline', seen: third.seen });
		} finally { watcher.close(); leaver.close(); }
	});

	it('writes at most one seen in it for a user flipping invisible, on any of their connections, and never for an invisible user\'s connections', async () => {
		const watcherId = unique('watcher');
		const shyId = unique('shy');
		const watcher = await signedIn(watcherId);
		let shy = await signedIn(shyId);
		let other = await signedIn(shyId, { existing: true });
		const sql = await recordSql();
		try {
			await drain(watcher);
			await choose(shy, 'invisible');
			const [hidden] = shown(await drain(watcher), shyId);
			const s1 = Number(hidden.seen);
			expect(writes(sql, shyId)).toEqual([s1]);
			// Kept on both connections, so either one's next change knows it.
			expect(await held(shyId)).toEqual([s1, s1]);
			expect(await listed(watcher, shyId)).toMatchObject({ status: 'offline', seen: hidden.seen });
			// Flipping back and forth, a minute apart (status changes are limited a minute), from either connection.
			for (const peer of [shy, other, shy]) {
				offset += 60_000;
				await choose(peer, 'online');
				await choose(peer, 'invisible');
				expect(shown(await drain(watcher), shyId)).toEqual([{ user_id: shyId, status: 'online' }, { user_id: shyId, status: 'offline', seen: hidden.seen }]);
				expect(await listed(watcher, shyId)).toMatchObject({ status: 'offline', seen: hidden.seen });
			}
			expect(writes(sql, shyId)).toEqual([s1]);
			// Visible on one connection, then both close within it: the stored seen, unwritten.
			offset += 60_000;
			await choose(other, 'online');
			expect(shown(await drain(watcher), shyId)).toEqual([{ user_id: shyId, status: 'online' }]);
			await hangUp(shy, shyId);
			await hangUp(other, shyId);
			await advance(WAIT);
			expect(shown(await drain(watcher), shyId)).toEqual([{ user_id: shyId, status: 'offline', seen: hidden.seen }]);
			expect(writes(sql, shyId)).toEqual([s1]);
			expect(await listed(watcher, shyId)).toMatchObject({ status: 'offline', seen: hidden.seen });

			// Past it: the next flip writes once, then stands again.
			shy = await back(watcher, shyId);
			offset += SEEN_WRITE_GRANULARITY_MS;
			await choose(shy, 'invisible');
			const [later] = shown(await drain(watcher), shyId);
			const s2 = Number(later.seen);
			expect(s2).toBeGreaterThan(s1 + SEEN_WRITE_GRANULARITY_MS);
			offset += 60_000;
			await choose(shy, 'online');
			await choose(shy, 'invisible');
			expect(shown(await drain(watcher), shyId)).toEqual([{ user_id: shyId, status: 'online' }, { user_id: shyId, status: 'offline', seen: later.seen }]);
			expect(writes(sql, shyId)).toEqual([s1, s2]);
			expect(await stored(shyId)).toBe(s2);

			// Invisible, long past it: connections coming and going tell nothing and write nothing.
			offset += 2 * SEEN_WRITE_GRANULARITY_MS;
			other = await signedIn(shyId, { existing: true });
			await hangUp(other, shyId);
			await advance(WAIT);
			await hangUp(shy, shyId);
			await advance(WAIT);
			shy = await signedIn(shyId, { existing: true });
			await advance(WAIT);
			expect(shown(await drain(watcher), shyId)).toEqual([]);
			expect(writes(sql, shyId)).toEqual([s1, s2]);
			expect(await stored(shyId)).toBe(s2);
			expect(await listed(watcher, shyId)).toMatchObject({ status: 'offline', seen: later.seen });
		} finally { watcher.close(); shy.close(); other.close(); }
	});

	it('reads seen at sign-in with the identity row, with no read of its own', async () => {
		const userId = unique('reader');
		await register(userId);
		const recorded = Date.now() - 60_000;
		await runInDurableObject(stub(), (instance) => { (instance as unknown as Runtime).store.settleSeen({ userId, at: recorded, now: Date.now() }); });
		const sql = await recordSql();
		const peer = await signedIn(userId, { existing: true });
		try {
			const identityReads = sql.filter((entry) => /\bFROM identities WHERE user_id = \?/.test(entry.query) && entry.bindings[0] === userId);
			// The identity row reads a sign-in did before seen (the identity
			// lookup, and the avatar refresh check after the reply), the column
			// now among the ones they read, and nothing else of `identities`.
			const row = 'SELECT user_id, user_handle, name, tier, created_ms, updated_ms, avatar_url, avatar_expires_ms, roles_json, ext_json, seen_ms FROM identities WHERE user_id = ? LIMIT 1';
			expect(identityReads.map((entry) => entry.query)).toEqual([row, row]);
			expect(sql.filter((entry) => /\bidentities\b/.test(entry.query)).length).toBe(2);
			expect(sql.some((entry) => /^SELECT seen_ms FROM identities WHERE/.test(entry.query))).toBe(false);
			expect(await held(userId)).toEqual([recorded]);
		} finally { peer.close(); }
	});

	it('keeps seen through /rename, on the connection and in a change still owed', async () => {
		const ADMIN_TOKEN = 'admin-token-seen-0123456789';
		const setAdminToken = (value: string | undefined) => runInDurableObject(stub(), (instance) => {
			const server = instance as unknown as { config: { adminToken?: string } };
			server.config = { ...server.config, adminToken: value };
		});
		await setAdminToken(ADMIN_TOKEN);
		const watcherId = unique('watcher');
		const fromId = unique('dave');
		const toId = unique('david');
		const lastId = unique('davy');
		const watcher = await signedIn(watcherId);
		let dave = await signedIn(fromId);
		const admin = await connect();
		await admin.next();
		await admin.next();
		expect((await request(admin, 'admin', 'auth', { scheme: 'token', token: ADMIN_TOKEN })).result.you.user_id).toBe('admin');
		const sql = await recordSql();
		const rename = async (from: string, to: string) => {
			const { frame } = await exchange(admin, `rename-${crypto.randomUUID()}`, 'command', { room_id: 'general', body: { text: `/rename ${from} ${to}` } });
			expect(frame.result).toEqual({});
		};
		try {
			await drain(watcher);
			await hangUp(dave, fromId);
			await advance(WAIT);
			const [first] = shown(await drain(watcher), fromId);
			const s1 = Number(first.seen);
			dave = await back(watcher, fromId);
			// Renamed while connected: the connection keeps the stored seen, which moved with the row.
			await rename(fromId, toId);
			expect(await held(toId)).toEqual([s1]);
			offset += 60_000;
			await hangUp(dave, toId);
			await advance(WAIT);
			expect(shown(await drain(watcher), toId)).toEqual([{ user_id: toId, status: 'offline', seen: first.seen }]);
			expect(await listed(watcher, toId)).toMatchObject({ status: 'offline', seen: first.seen });
			// Renamed while the change to offline is still owed: it goes out under the new user_id, with its seen.
			dave = await back(watcher, toId);
			await hangUp(dave, toId);
			await rename(toId, lastId);
			await advance(WAIT);
			expect(shown(await drain(watcher), lastId)).toEqual([{ user_id: lastId, status: 'offline', seen: first.seen }]);
			expect(await listed(watcher, lastId)).toMatchObject({ status: 'offline', seen: first.seen });
			expect(await stored(lastId)).toBe(s1);
			expect([...writes(sql, fromId), ...writes(sql, toId), ...writes(sql, lastId)]).toEqual([s1]);
		} finally {
			watcher.close(); dave.close(); admin.close();
			await setAdminToken(undefined);
		}
	});

	/** Closes all of `peers`, `userId`'s connections, back to back, and waits until the object has handled every close. */
	async function closeTogether(peers: Peer[], userId: string): Promise<void> {
		for (const peer of peers) peer.close();
		for (let tries = 0; tries < 400 && await counted(userId) > 0; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
		expect(await counted(userId)).toBe(0);
	}

	/** `userId` signed in on `tabs` connections, and others told they are online. */
	async function tabsOf(watcher: Peer, userId: string, tabs: number): Promise<Peer[]> {
		const peers = [await signedIn(userId)];
		while (peers.length < tabs) peers.push(await signedIn(userId, { existing: true }));
		await advance(COALESCE + 1_000);
		expect(shown(await drain(watcher), userId)).toEqual([{ user_id: userId, status: 'online' }]);
		return peers;
	}

	/**
	 * Has the object's Store.settleSeen run `settle` instead, with the real
	 * one, until the test ends (afterEach restores it).
	 */
	function replaceSettle(settle: (real: (input: { userId: string; at: number; now?: number }) => number | undefined, input: { userId: string; at: number; now?: number }, runtime: Runtime & Record<string, any>) => number | undefined): Promise<void> {
		return runInDurableObject(stub(), (instance) => {
			const runtime = instance as unknown as Runtime & Record<string, any>;
			const real = runtime.store.settleSeen.bind(runtime.store);
			vi.spyOn(runtime.store, 'settleSeen').mockImplementation((input) => settle(real, input, runtime));
		});
	}

	const refused = () => new StoreError('retry_after', 'Demo capacity reached', { retryAfterMs: 60_000 });

	it('writes once when several tabs close together, each handled as the last, and tells one seen, the one listed', async () => {
		const watcher = await signedIn(unique('watcher'));
		const sql = await recordSql();
		const opened: Peer[] = [];
		try {
			await drain(watcher);
			for (const tabs of [2, 3]) {
				const userId = unique(`tabs${tabs}`);
				const peers = await tabsOf(watcher, userId, tabs);
				opened.push(...peers);
				await closeTogether(peers, userId);
				await advance(WAIT);
				const changes = shown(await drain(watcher), userId);
				expect(changes).toEqual([{ user_id: userId, status: 'offline', seen: expect.stringMatching(/^\d+$/) }]);
				expect(writes(sql, userId)).toEqual([Number(changes[0].seen)]);
				expect(await stored(userId)).toBe(Number(changes[0].seen));
				expect(await listed(watcher, userId)).toMatchObject({ status: 'offline', seen: changes[0].seen });
			}
			// Again with the object's memory of each close lost once it is
			// handled, as an eviction between the closes would lose it: the
			// rest find the change still owed to others, and the store, which
			// would refuse them now, is not asked again.
			const userId = unique('evicted');
			const peers = await tabsOf(watcher, userId, 3);
			opened.push(...peers);
			let calls = 0;
			await replaceSettle((real, input) => {
				if (++calls > 1) throw refused();
				return real(input);
			});
			await runInDurableObject(stub(), (instance) => {
				const runtime = instance as unknown as { departed: Set<string>; connectionGone(attachment: unknown): void };
				const real = runtime.connectionGone.bind(runtime);
				vi.spyOn(runtime, 'connectionGone').mockImplementation((attachment) => {
					real(attachment);
					runtime.departed.clear();
				});
			});
			await closeTogether(peers, userId);
			// Every close handled before the grace ends.
			for (let tries = 0; tries < 400 && await runInDurableObject(stub(), (instance) => (instance as unknown as { connectionGone: { mock: { calls: unknown[] } } }).connectionGone.mock.calls.length) < peers.length; tries++) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			await advance(WAIT);
			const changes = shown(await drain(watcher), userId);
			expect(changes).toEqual([{ user_id: userId, status: 'offline', seen: expect.stringMatching(/^\d+$/) }]);
			expect(calls).toBe(1);
			expect(writes(sql, userId)).toEqual([Number(changes[0].seen)]);
			vi.restoreAllMocks();
			expect(await listed(watcher, userId)).toMatchObject({ status: 'offline', seen: changes[0].seen });
		} finally { watcher.close(); for (const peer of opened) peer.close(); }
	});

	it('tells the stored seen when the store refuses to settle a departure, from every tab closing', async () => {
		const watcher = await signedIn(unique('watcher'));
		const userId = unique('refused');
		await register(userId);
		// A seen recorded long ago, which no longer stands.
		const recorded = Date.now() - 3 * SEEN_WRITE_GRANULARITY_MS;
		await runInDurableObject(stub(), (instance) => { (instance as unknown as Runtime).store.settleSeen({ userId, at: recorded, now: Date.now() }); });
		const sql = await recordSql();
		const peers = [await signedIn(userId, { existing: true }), await signedIn(userId, { existing: true })];
		try {
			await advance(COALESCE + 1_000);
			await drain(watcher);
			let calls = 0;
			await replaceSettle(() => { calls += 1; throw refused(); });
			await closeTogether(peers, userId);
			await advance(WAIT);
			expect(calls).toBeGreaterThanOrEqual(1);
			// Refused: what is stored is told, the same from each close, and listed.
			expect(shown(await drain(watcher), userId)).toEqual([{ user_id: userId, status: 'offline', seen: String(recorded) }]);
			expect(writes(sql, userId)).toEqual([]);
			vi.restoreAllMocks();
			expect(await stored(userId)).toBe(recorded);
			expect(await listed(watcher, userId)).toMatchObject({ status: 'offline', seen: String(recorded) });
		} finally { watcher.close(); for (const peer of peers) peer.close(); }
	});

	it('lets the store decide from what it holds when a connection\'s copy is stale', async () => {
		const watcher = await signedIn(unique('watcher'));
		const userId = unique('stale');
		let peer = await tabsOf(watcher, userId, 1).then((peers) => peers[0]);
		const sql = await recordSql();
		try {
			await hangUp(peer, userId);
			await advance(WAIT);
			const [first] = shown(await drain(watcher), userId);
			peer = await back(watcher, userId);
			// The connection's copy is lost (as one from code before seen has
			// none): within SEEN_WRITE_GRANULARITY_MS, the store finds its own
			// standing, and tells it.
			await runInDurableObject(stub(), (_instance, state) => {
				for (const socket of state.getWebSockets()) {
					const attachment = socket.deserializeAttachment() as Attachment;
					if (attachment?.userId !== userId) continue;
					delete attachment.seen;
					socket.serializeAttachment(attachment);
				}
			});
			offset += 60_000;
			await hangUp(peer, userId);
			await advance(WAIT);
			expect(shown(await drain(watcher), userId)).toEqual([{ user_id: userId, status: 'offline', seen: first.seen }]);
			expect(writes(sql, userId)).toEqual([Number(first.seen)]);
			expect(await listed(watcher, userId)).toMatchObject({ status: 'offline', seen: first.seen });
		} finally { watcher.close(); peer.close(); }
	});

	it('keeps an owed change whose seen is malformed, without seen', async () => {
		const watcher = await signedIn(unique('watcher'));
		const userId = unique('malformed');
		try {
			await drain(watcher);
			const due = Date.now() + 1_000;
			await runInDurableObject(stub(), (_instance, state) => {
				for (const socket of state.getWebSockets()) {
					const attachment = socket.deserializeAttachment() as Omit<Attachment, 'owed'> & { owed?: unknown[] };
					if (attachment?.userId === undefined || socket.readyState !== 1 || attachment.closing) continue;
					attachment.owed = [...(attachment.owed ?? []), [userId, 'online', 'offline', due, 'not a time']];
					socket.serializeAttachment(attachment);
				}
			});
			await advance(2_000);
			expect(shown(await drain(watcher), userId)).toEqual([{ user_id: userId, status: 'offline' }]);
		} finally { watcher.close(); }
	});

	it('fits 32 owed changes with seen and the longest user IDs in a busy connection\'s attachment', async () => {
		const watcher = await signedIn(unique('watcher'));
		const warn = vi.spyOn(console, 'warn');
		try {
			await drain(watcher);
			const bytes = await runInDurableObject(stub(), (instance, state) => {
				const now = Date.now();
				// The longest user IDs: a bot of an admin-issued 64-character ID.
				const id = (index: number) => `bot_${'x'.repeat(60)}${String(index).padStart(4, '0')}`;
				const socket = state.getWebSockets().find((ws) => (ws.deserializeAttachment() as Attachment)?.userId !== undefined && ws.readyState === 1)!;
				const attachment = socket.deserializeAttachment() as Record<string, unknown>;
				socket.serializeAttachment({
					...attachment,
					owed: Array.from({ length: 32 }, (_, index) => [id(index), 'online', 'offline', now + 3_600_000, now]),
					// A busy connection's other bounded lists, at their longest.
					frameTimes: Array.from({ length: 120 }, (_, index) => now - index),
					policyViolations: Array.from({ length: 120 }, (_, index) => now - index),
					held: Array.from({ length: 8 }, (_, index) => ['m'.repeat(60) + String(index).padStart(4, '0'), 'r'.repeat(64), now, now]),
				});
				// The sweep reads it and writes it back (writeAttachment, with its safety check).
				(instance as unknown as Runtime).flushPresence(now);
				const written = socket.deserializeAttachment() as { owed?: unknown[] };
				expect(written.owed).toHaveLength(32);
				return new TextEncoder().encode(JSON.stringify(written)).length;
			});
			expect(warn.mock.calls.flat().some((line) => /presence_failed|exceeds safety budget/.test(String(line)))).toBe(false);
			console.info('attachment-bytes', bytes);
			expect(bytes).toBeLessThanOrEqual(12_000);
		} finally {
			// The owed entries are for no one: clear them.
			await runInDurableObject(stub(), (_instance, state) => {
				for (const socket of state.getWebSockets()) {
					const attachment = socket.deserializeAttachment() as Attachment;
					if (!attachment?.owed) continue;
					delete attachment.owed;
					socket.serializeAttachment(attachment);
				}
			});
			watcher.close();
		}
	});

	it('shows each user shown offline after /toggle presence comes back on as offline since then, with no write per user', async () => {
		const adminId = unique('admin');
		await register(adminId);
		await runInDurableObject(stub(), (instance) => { (instance as unknown as Runtime).store.setRole({ userId: adminId, role: 'admin', on: true }); });
		const admin = await signedIn(adminId, { existing: true });
		const toggle = async (id: string) => expect((await exchange(admin, id, 'command', { room_id: 'general', body: { text: '/toggle presence' } })).frame.result).toEqual({});
		// Away throughout, with a seen from long ago; back briefly while presence is off;
		// connected and invisible throughout; and online when it comes back on.
		const awayId = unique('away');
		const briefId = unique('brief');
		const shyId = unique('shy');
		const stayId = unique('stay');
		const old = Date.now() - 2 * DAY;
		for (const userId of [awayId, briefId]) {
			await register(userId);
			await runInDurableObject(stub(), (instance) => { (instance as unknown as Runtime).store.settleSeen({ userId, at: old, now: Date.now() }); });
		}
		const shy = await signedIn(shyId);
		await choose(shy, 'invisible');
		let stay = await signedIn(stayId);
		const sql = await recordSql();
		try {
			await toggle('off');
			offset += 60_000;
			const brief = await signedIn(briefId, { existing: true });
			await hangUp(brief, briefId);
			await advance(WAIT);
			offset += 60_000;
			const before = Date.now();
			await toggle('on');
			const after = Date.now();
			await drain(admin);
			// Each shown offline: offline since presence came on, whatever was
			// stored before, and later than the brief return it hid.
			const list = await listing(admin);
			const since = list.get(awayId)?.seen as string;
			expect(Number(since)).toBeGreaterThanOrEqual(before);
			expect(Number(since)).toBeLessThanOrEqual(after);
			for (const userId of [awayId, briefId, shyId]) expect(list.get(userId)).toMatchObject({ status: 'offline', seen: since });
			expect(list.get(stayId)).not.toHaveProperty('seen');
			// One _meta row, no identity row.
			expect(sql.filter((entry) => /^UPDATE identities SET seen_ms/.test(entry.query) && entry.written() > 0)).toEqual([]);
			// Leaving within 10 minutes of it: told that time, listed with it, nothing written.
			offset += 3 * 60_000;
			await hangUp(stay, stayId);
			await advance(WAIT);
			expect(shown(await drain(admin), stayId)).toEqual([{ user_id: stayId, status: 'offline', seen: since }]);
			expect(await listed(admin, stayId)).toMatchObject({ status: 'offline', seen: since });
			expect(writes(sql, stayId)).toEqual([]);
			// Kept across eviction, read with the toggle.
			await evict();
			expect(await listed(admin, awayId)).toMatchObject({ status: 'offline', seen: since });
			expect(await listed(admin, shyId)).toMatchObject({ status: 'offline', seen: since });
			// Later departures write their own as before.
			offset += SEEN_WRITE_GRANULARITY_MS;
			stay = await back(admin, stayId);
			await hangUp(stay, stayId);
			await advance(WAIT);
			const [later] = shown(await drain(admin), stayId);
			expect(Number(later.seen)).toBeGreaterThan(Number(since) + SEEN_WRITE_GRANULARITY_MS);
			expect(await stored(stayId)).toBe(Number(later.seen));
		} finally { admin.close(); shy.close(); stay.close(); }
	});

	it('lists a reused listing with the stored seen when the status it was written with rolls back', async () => {
		const userId = unique('rollback');
		await register(userId);
		const result = await runInDurableObject(stub(), (instance) => {
			const store = (instance as unknown as Runtime).store as Store & Record<string, any>;
			const now = Date.now();
			const old = now - 3 * SEEN_WRITE_GRANULARITY_MS;
			store.settleSeen({ userId, at: old, now });
			const seenOf = () => store.roomMembers(['general'], DEFAULT_LIMITS.roomListMembers, Date.now(), undefined, true).get('general')?.find((member: { user_id: string }) => member.user_id === userId)?.seen;
			expect(seenOf()).toBe(old);
			const spy = vi.spyOn(store, 'writeUserStatus').mockImplementation(() => { throw new Error('status write failed'); });
			expect(() => store.setStatus({ userId, choice: 'invisible', seenAt: now, now })).toThrow('status write failed');
			spy.mockRestore();
			return { old, listed: seenOf(), stored: store.getIdentity(userId)?.seen };
		});
		// Rolled back with the status: neither stored nor listed.
		expect(result.stored).toBe(result.old);
		expect(result.listed).toBe(result.old);
	});
});
