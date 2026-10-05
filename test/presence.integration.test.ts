import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, PUSH_POLICY } from '../src/budget';
import type { Store } from '../src/store';
import { connect as open, exchange, request, type Frame, type Peer } from './helpers/socket';
import { withStore } from './helpers/store';

let nextIp = 1;
const stub = () => env.DEMO.getByName('public-demo-v1');
const connect = () => open({ ip: `198.18.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}` });
const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const COALESCE = DEFAULT_LIMITS.statusCoalesceSeconds * 1_000;
const GRACE = DEFAULT_LIMITS.offlineGraceSeconds * 1_000;

type Runtime = {
	store: Store;
	config: { presence: 'full' | 'connected' | false };
	announcedAt: Map<string, number>;
	issueSession(userId: string, origin: string, now: number): Promise<string>;
	flushPresence(now?: number): void;
};
type Attachment = { userId?: string; closing?: boolean; pres?: { s: string; y: string; a: number; h?: number }; owed?: Array<[string, string, string, number]>; muteUntil?: number; invisible?: true; pushUntil?: number };

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
 * `existing`). `aware`: it sends `status` first, so it is told of changes
 * (§4.11 lets the server tell only those).
 */
async function signedIn(userId: string, { existing = false, aware = true } = {}): Promise<Peer> {
	if (!existing) await register(userId);
	const token = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).issueSession(userId, 'http://localhost:5173', Date.now()));
	const peer = await connect();
	await peer.next();
	await peer.next();
	if (aware) peer.send({ method: 'status', params: { idle: false } });
	const auth = await request(peer, 'auth', 'auth', { scheme: 'token', token });
	expect(auth.result.you.user_id).toBe(userId);
	return peer;
}

async function guest(aware = true): Promise<{ peer: Peer; userId: string }> {
	const peer = await connect();
	await peer.next();
	await peer.next();
	if (aware) peer.send({ method: 'status', params: { idle: false } });
	const auth = await request(peer, 'auth', 'auth', { scheme: 'guest' });
	return { peer, userId: auth.result.you.user_id };
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

/** Sends `status` and waits until the object has taken it. */
async function status(peer: Peer, params: Record<string, unknown>): Promise<Frame[]> {
	peer.send({ method: 'status', params });
	return drain(peer);
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

/** No user object anyone but its user was sent carries their mute or `invisible`. */
function expectPrivate(frames: Frame[], userId: string): void {
	const objects = JSON.stringify(frames).match(new RegExp(`\\{[^{}]*"user_id":"${userId}"[^{}]*\\}`, 'g')) ?? [];
	for (const object of objects) {
		expect(object).not.toMatch(/"mute"|"invisible"|"push_id"/);
	}
}

/** Forgets when anyone's status was last announced, so the next change goes out at once. */
async function forgetAnnouncements(): Promise<void> {
	offset += COALESCE;
	await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).announcedAt.clear());
}

describe('user status shown to others (full presence)', () => {
	beforeEach(forgetAnnouncements);

	it('announces each rule in order to status-aware connections, coalesced to one change a minute', async () => {
		const aliceId = unique('alice');
		const bobId = unique('bob');
		const alice = await signedIn(aliceId);
		const { peer: carol } = await guest(false);
		const bob = await signedIn(bobId);
		try {
			// Bob signing in is announced at once: nothing was announced for him this minute.
			let frames = await drain(alice);
			expect(told(frames, bobId)).toEqual(['online']);
			// Rule 4: a connection that is idle. The change waits out the minute since the last.
			await status(bob, { idle: true });
			expect(told(await drain(alice), bobId)).toEqual([]);
			await advance(COALESCE / 2);
			expect(told(await drain(alice), bobId)).toEqual([]);
			await advance(COALESCE / 2);
			expect(told(await drain(alice), bobId)).toEqual(['idle']);
			// Rule 2: the unscoped mute with a connection is dnd, over idle and online.
			await status(bob, { mute: 3600 });
			await advance(COALESCE);
			expect(told(await drain(alice), bobId)).toEqual(['dnd']);
			await status(bob, { idle: false });
			await advance(COALESCE);
			expect(told(await drain(alice), bobId)).toEqual([]);
			// Rule 1: invisible is offline to others, at once, whatever the minute.
			const echo = await status(bob, { invisible: true });
			expect(echo.filter((frame) => frame.params?.you?.invisible === true)).toHaveLength(1);
			expect(own(echo)).toEqual(['dnd']);
			frames = await drain(alice);
			expect(told(frames, bobId)).toEqual(['offline']);
			expect(await listed(alice, bobId)).toMatchObject({ status: 'offline' });
			// `you` ignores invisible and carries it while set.
			expect((await request(bob, 'me', 'me', {})).result.you).toMatchObject({ status: 'dnd', invisible: true, mute: expect.any(Number) });
			// Turning it off waits for the minute like any other change.
			await status(bob, { invisible: false });
			expect(told(await drain(alice), bobId)).toEqual([]);
			await advance(COALESCE);
			expect(told(await drain(alice), bobId)).toEqual(['dnd']);
			// Rule 3: an attended connection, once the mute ends.
			await status(bob, { mute: 0 });
			await advance(COALESCE);
			expect(told(await drain(alice), bobId)).toEqual(['online']);
			// Muted again, then gone: without a connection a muted user is offline, not dnd.
			await status(bob, { mute: true });
			await advance(COALESCE);
			expect(told(await drain(alice), bobId)).toEqual(['dnd']);
			await hangUp(bob, bobId);
			await advance(GRACE / 2);
			expect(told(await drain(alice), bobId)).toEqual([]);
			await advance(GRACE / 2 + 1_000);
			frames = await drain(alice);
			expect(told(frames, bobId)).toEqual(['offline']);
			expect(await listed(alice, bobId)).toMatchObject({ status: 'offline' });
			// Carol never sent `status`: she is told nothing, and lists the same statuses.
			const carolFrames = await drain(carol);
			expect(told(carolFrames, bobId)).toEqual([]);
			expectPrivate([...frames, ...carolFrames], bobId);
			expect(await listed(carol, bobId)).toMatchObject({ status: 'offline' });
			const accounting = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.accountingStatus());
			expect(accounting.unsafe).toBe(false);
		} finally { alice.close(); bob.close(); carol.close(); }
	});

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
			// The user's own status-aware connections hear their own status in `you`, coalesced alike.
			await status(flipper, { idle: false });
			await advance(COALESCE);
			expect(told(await drain(watcher), flipperId)).toEqual(['online']);
			mine.push(...await drain(second));
			expect(own(mine)).toEqual(['idle', 'online']);
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
			expect(held.find((state) => state.userId === stayerId && !state.closing)?.pres).toMatchObject({ s: 'online', y: 'online' });
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
		const quiet = await signedIn(unique('quiet'), { aware: false });
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
			// With no connection that is told of changes, nothing keeps the object awake.
			await hangUp(watcher, watcherId);
			const idleTimer = await runInDurableObject(stub(), (instance) => (instance as unknown as { presenceTimer?: unknown }).presenceTimer !== undefined);
			expect(idleTimer).toBe(false);
		} finally { watcher.close(); leaver.close(); quiet.close(); }
	});

	it('shows users without a connection as storage says: idle when a registration wakes them, else offline', async () => {
		const observerId = unique('observer');
		const ids = { pushed: unique('pushed'), muted: unique('muted'), hidden: unique('hidden'), silent: unique('silent'), expired: unique('expired'), plain: unique('plain') };
		for (const id of Object.values(ids)) await register(id);
		await runInDurableObject(stub(), (instance, state) => {
			const { store } = instance as unknown as Runtime;
			const now = Date.now();
			const keys = { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) };
			for (const id of [ids.pushed, ids.muted, ids.hidden, ids.expired]) store.registerPushSubscription({ userId: id, url: `https://push.example.net/${id}`, ...keys, now });
			store.registerPushSubscription({ userId: ids.silent, url: `https://push.example.net/${ids.silent}`, ...keys, wake: 0, now });
			store.setMute({ userId: ids.muted, untilMs: now + 3_600_000, now });
			store.setInvisible({ userId: ids.hidden, invisible: true, now });
			state.storage.sql.exec('UPDATE push_subscriptions SET updated_ms = ? WHERE user_id = ?', now - (PUSH_POLICY!.pushExpiryDays + 1) * 86_400_000, ids.expired);
		});
		const observer = await signedIn(observerId);
		try {
			const users = await listing(observer);
			expect(users.get(ids.pushed)).toMatchObject({ status: 'idle' });
			// Rule 2 needs a connection: muted and away is offline, registration or not.
			expect(users.get(ids.muted)).toMatchObject({ status: 'offline' });
			expect(users.get(ids.hidden)).toMatchObject({ status: 'offline' });
			// A registration that wakes for nothing, or one past pushExpiryDays, does not count.
			expect(users.get(ids.silent)).toMatchObject({ status: 'offline' });
			expect(users.get(ids.expired)).toMatchObject({ status: 'offline' });
			expect(users.get(ids.plain)).toMatchObject({ status: 'offline' });
			expect(users.get(observerId)).toMatchObject({ status: 'online' });
			// The pushed user connects and leaves again: back to idle, never offline.
			const pushed = await signedIn(ids.pushed, { existing: true });
			expect(told(await drain(observer), ids.pushed)).toEqual(['online']);
			await hangUp(pushed, ids.pushed);
			await advance(Math.max(COALESCE, GRACE) + 1_000);
			expect(told(await drain(observer), ids.pushed)).toEqual(['idle']);
		} finally { observer.close(); }
	});

	it('keeps mute, invisible and push registrations private: others see only the status', async () => {
		const observerId = unique('observer');
		const shyId = unique('shy');
		const observer = await signedIn(observerId);
		const shy = await signedIn(shyId);
		const shyToo = await signedIn(shyId, { existing: true, aware: false });
		try {
			await request(shy, 'register', 'push_register', { kind: 'webpush', url: `https://push.example.net/${shyId}`, keys: { p256dh: 'BDiU8ZnLVhCayOIihLkro6Di0XjZW7iK59umfbY--JzLTzNbhd94tTuBsIzrhXljFDqw5xn8gLqahSsSPDCauDM', auth: 'AAAAAAAAAAAAAAAAAAAAAA' }, push_id: 'shy-phone' });
			await status(shy, { mute: true, invisible: true });
			// Both connections of the user hear both changes in `you`, with their own status.
			const echoes = (await drain(shyToo)).filter((frame) => frame.method === 'user' && frame.params.you);
			expect(echoes.map((frame) => frame.params.you)).toEqual([
				expect.objectContaining({ mute: true, status: 'dnd' }),
				expect.objectContaining({ invisible: true, status: 'dnd' }),
			]);
			const seen = await drain(observer);
			expect(told(seen, shyId)).toEqual(['online', 'offline']);
			const listing = await request(observer, 'list', 'room_list', { filter: 'joined', members: true });
			expectPrivate([...seen, listing], shyId);
			// Connected, invisible: listed as stored members are, offline.
			expect(listing.result.users.find((user: { user_id: string }) => user.user_id === shyId)).toEqual({ user_id: shyId, name: `Name of ${shyId}`, roles: [], status: 'offline' });
			// A new connection of theirs learns it in `you`.
			const third = await signedIn(shyId, { existing: true });
			const you = (await request(third, 'me', 'me', {})).result.you;
			expect(you).toMatchObject({ invisible: true, mute: true, status: 'dnd' });
			third.close();
		} finally { observer.close(); shy.close(); shyToo.close(); }
	});

	it('takes invisible before signing in, ignores it for guests and with room_id, and counts it with mutes', async () => {
		const userId = unique('early');
		const watcherId = unique('watcher');
		const watcher = await signedIn(watcherId);
		await register(userId);
		const token = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).issueSession(userId, 'http://localhost:5173', Date.now()));
		const early = await connect();
		const { peer: visitor, userId: visitorId } = await guest();
		try {
			await early.next();
			await early.next();
			early.send({ method: 'status', params: { idle: false, invisible: true } });
			expect((await request(early, 'auth', 'auth', { scheme: 'token', token })).result.you).toMatchObject({ invisible: true, status: 'online' });
			// Never shown online to others.
			expect(told(await drain(watcher), userId)).toEqual([]);
			expect(await listed(watcher, userId)).toMatchObject({ status: 'offline' });
			// A guest's invisible is ignored: guests are seen only while connected.
			const ignored = await status(visitor, { invisible: true });
			expect(ignored.filter((frame) => frame.method === 'user')).toEqual([]);
			expect((await request(visitor, 'me', 'me', {})).result.you).not.toHaveProperty('invisible');
			// A scoped invisible changes nothing.
			await status(early, { room_id: 'general', invisible: false });
			expect((await request(early, 'me', 'me', {})).result.you.invisible).toBe(true);
			// Mute and invisible changes share mutesPerUserMinute; past it, both are dropped.
			let echoes = 0;
			for (let index = 0; index < PUSH_POLICY!.mutesPerUserMinute; index++) {
				const frames = await status(early, index % 2 ? { mute: index } : { invisible: index % 4 === 0 });
				echoes += frames.filter((frame) => frame.method === 'user' && frame.params.you).length;
			}
			const dropped = await status(early, { mute: 0, invisible: true });
			expect(dropped.filter((frame) => frame.method === 'user' && frame.params.you)).toEqual([]);
			// The first was a no-op (already invisible), so one fewer echo than changes.
			expect(echoes).toBe(PUSH_POLICY!.mutesPerUserMinute - 1);
			expect(told(await drain(visitor), visitorId)).toEqual([]);
		} finally { watcher.close(); early.close(); visitor.close(); }
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
			const told = frames.findIndex((frame) => frame.method === 'user' && frame.params.new?.user_id === joinerId);
			expect(membership).toBeGreaterThanOrEqual(0);
			expect(told).toBeGreaterThan(membership);
			expect(frames[told].params.new).toEqual({ user_id: joinerId, status: 'online' });
			expect(JSON.stringify(frames[membership])).not.toContain('"status"');
		} finally { owner.close(); joiner.close(); }
	});

	it('/rename and /purge move and delete the user status row', async () => {
		const userId = 'rn';
		await withStore('presence-rename', { push: { ...PUSH_POLICY! } }, (store, clock) => {
			store.registerIdentity({
				userId, name: 'Rn', userHandle: 'handle-rn', now: clock.value, ipKey: 'ip-rn',
				credential: { credentialId: 'cred-rn', userId, publicKey: 'AAAA', counter: 0 },
			});
			const now = clock.value;
			store.setInvisible({ userId, invisible: true, now });
			store.setMute({ userId, untilMs: now + 60_000, now });
			store.renameIdentity({ from: userId, to: `${userId}x`, now });
			expect(store.statusInputs(userId, true, now)).toEqual({ invisible: false });
			expect(store.statusInputs(`${userId}x`, true, now)).toEqual({ invisible: true, muteUntil: now + 60_000 });
			store.setMute({ userId: `${userId}x`, untilMs: null, now });
			expect(store.statusInputs(`${userId}x`, false, now)).toEqual({ invisible: true });
			store.purgeUsers({ userIds: [`${userId}x`], now });
			expect(store.statusInputs(`${userId}x`, true, now)).toEqual({ invisible: false });
		});
	});

	it('/toggle presence turns status off and on for everyone, keeping invisible while off', async () => {
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
			const off = await toggle('off');
			expect(off.frame.result).toEqual({});
			expect(off.skipped.find((frame) => frame.params?.from?.user_id === '~private')?.params.body.text).toMatch(/^Status is now \*\*off\*\*/);
			// Off: no status anywhere, but invisible is still kept and echoed, as `status` is still advertised.
			expect((await request(watcher, 'me-off', 'me', {})).result.you).not.toHaveProperty('status');
			expect(await listed(watcher, watcherId)).not.toHaveProperty('status');
			const hidden = (await status(watcher, { invisible: true })).filter((frame) => frame.method === 'user');
			expect(hidden.map((frame) => frame.params.you)).toEqual([expect.objectContaining({ user_id: watcherId, invisible: true })]);
			expect(hidden[0].params.you).not.toHaveProperty('status');
			expect((await request(watcher, 'me-off-invisible', 'me', {})).result.you).toMatchObject({ invisible: true });
			// A new connection of theirs learns it from its auth result.
			const second = await signedIn(watcherId, { existing: true, aware: false });
			expect((await request(second, 'me-second', 'me', {})).result.you).toMatchObject({ invisible: true });
			second.close();
			// Invisible users are left out of connected member listings with presence off too.
			const members = await runInDurableObject(stub(), (instance) => (instance as unknown as { connectedMembers(): Map<string, Array<{ user_id: string }>> }).connectedMembers());
			expect((members.get('general') ?? []).map((user) => user.user_id)).not.toContain(watcherId);
			await status(watcher, { idle: true });
			await advance(COALESCE);
			expect(told(await drain(admin), watcherId)).toEqual([]);
			const on = await toggle('on');
			expect(on.skipped.find((frame) => frame.params?.from?.user_id === '~private')?.params.body.text).toMatch(/^Status is now \*\*on\*\*/);
			// On again, it starts from each user's status now, announcing nothing
			// for it; the invisible set while off holds, so others see offline.
			expect((await request(watcher, 'me-on', 'me', {})).result.you).toMatchObject({ status: 'idle', invisible: true });
			expect(await listed(admin, watcherId)).toMatchObject({ status: 'offline' });
			await status(watcher, { invisible: false, idle: false });
			await advance(COALESCE);
			expect(told(await drain(admin), watcherId)).toEqual(['online']);
			expect((await request(watcher, 'me-on-again', 'me', {})).result.you).not.toHaveProperty('invisible');
		} finally { admin.close(); watcher.close(); }
	});
});

describe('the connected variant', () => {
	beforeEach(forgetAnnouncements);
	afterEach(async () => {
		await runInDurableObject(stub(), (instance) => {
			const runtime = instance as unknown as Runtime;
			runtime.config = { ...runtime.config, presence: 'full' };
		});
	});

	async function variant(presence: 'full' | 'connected' | false): Promise<void> {
		await runInDurableObject(stub(), (instance) => {
			const runtime = instance as unknown as Runtime;
			runtime.config = { ...runtime.config, presence };
		});
	}

	it('shows users without a connection offline and reads nothing more for listings or sign-ins', async () => {
		const observerId = unique('observer');
		const awayId = unique('away');
		await register(awayId);
		await runInDurableObject(stub(), (instance) => {
			const { store } = instance as unknown as Runtime;
			store.registerPushSubscription({ userId: awayId, url: `https://push.example.net/${awayId}`, p256dh: 'p'.repeat(87), auth: 'a'.repeat(22), now: Date.now() });
		});
		await variant('connected');
		const observer = await signedIn(observerId);
		const hidden = await signedIn(unique('hidden'));
		try {
			// A waking registration does not make an away user idle here.
			expect(await listed(observer, awayId)).toMatchObject({ status: 'offline' });
			expect(await listed(observer, observerId)).toMatchObject({ status: 'online' });
			// Invisible works for connected users, from the connection alone.
			await status(hidden, { invisible: true });
			const hiddenId = (await request(hidden, 'me', 'me', {})).result.you.user_id;
			expect(await listed(observer, hiddenId)).toMatchObject({ status: 'offline' });
			// The member listing reads exactly what it reads with status off: the
			// same statements, and the same rows by their cursors, with nothing per
			// member for status. (The reservation's own bookkeeping is left out:
			// it does not depend on the listing.)
			const cost = async (presence: 'connected' | false) => {
				await variant(presence);
				return runInDurableObject(stub(), (instance, state) => {
					const runtime = instance as unknown as Runtime;
					(runtime.store as unknown as { memberCache: Map<string, unknown> }).memberCache.clear();
					const spy = vi.spyOn(runtime.store, 'roomMembers');
					const measured = statements(state, /FROM memberships m/, () => (runtime as unknown as { membersOf(ids: string[]): unknown }).membersOf(['general']));
					const withStatus = spy.mock.calls[0]?.[4];
					spy.mockRestore();
					return { ...measured, withStatus };
				});
			};
			const connectedCost = await cost('connected');
			const offCost = await cost(false);
			expect(connectedCost.withStatus).toBe(false);
			expect(connectedCost.queries).toEqual(offCost.queries);
			expect(connectedCost.reads).toBe(offCost.reads);
			expect(connectedCost.reads).toBeGreaterThan(0);
			// A sign-in reads the user's status row only, as reading the mute did.
			await variant('connected');
			const signIn = await runInDurableObject(stub(), (instance, state) => {
				const { store } = instance as unknown as Runtime;
				return {
					status: statements(state, /user_status|push_subscriptions/, () => store.statusInputs(awayId, false)),
					mute: statements(state, /user_status/, () => store.muteOf(awayId)),
				};
			});
			expect(signIn.status.queries).toHaveLength(1);
			expect(signIn.status.reads).toBe(signIn.mute.reads);
		} finally { observer.close(); hidden.close(); }
	});
});
