import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { connect as open, exchange, greeting, reply, request, until, type Frame, type Peer } from './helpers/socket';

let nextIp = 40;

type StoredSessionTest = { v: 1; userId: string; origin: string; expiresMs: number };

/** A socket from its own 192.0.2.N address; `null` omits the Origin. */
const connect = (origin: string | null = 'http://localhost:5173') => open({ ip: `192.0.2.${nextIp++}`, origin });

const stub = () => env.DEMO.getByName('public-demo-v1');
const isolatedStub = () => env.DEMO.getByName(`session-cleanup-${crypto.randomUUID()}`);

async function sweepSessions(target: ReturnType<typeof env.DEMO.getByName>, now: number): Promise<void> {
	await runInDurableObject(target, async (instance) => {
		await (instance as unknown as { sweepSessions(now: number): Promise<void> }).sweepSessions(now);
	});
}

/**
 * Registers an identity straight into the object's store, bypassing the
 * ceremony; with `rooms`, it starts in them, as a guest registering on its
 * connection does. Returns the rooms it kept.
 */
async function registerIdentity(userId: string, ipKey = 'session-test-ip', rooms?: string[]): Promise<string[]> {
	return runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as { store: { registerIdentity(input: Record<string, unknown>): { rooms: string[] } } };
		return runtime.store.registerIdentity({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 }, ...(rooms ? { rooms } : {}),
		}).rooms;
	});
}

async function issueSession(userId: string, origin: string): Promise<string> {
	return runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as { issueSession(userId: string, origin: string, now: number): Promise<string> };
		return runtime.issueSession(userId, origin, Date.now());
	});
}

/** Resumes `token` on a fresh connection; the peer and the auth reply, which may be an error. */
async function resume(token: string, id = 'resume', origin?: string | null): Promise<{ peer: Peer; reply: Frame }> {
	const peer = await connect(origin);
	await greeting(peer);
	return { peer, reply: await request(peer, id, 'auth', { scheme: 'token', token }) };
}

it('resumes a registered identity from a session token, renews it, and rejects bad tokens', async () => {
	await registerIdentity('user_session_one');
	const token = await issueSession('user_session_one', 'http://localhost:5173');

	const peer = await connect();
	await greeting(peer);
	peer.send({ id: 'bad', method: 'auth', params: { scheme: 'token', token: 'not-a-session' } });
	const denied = await peer.next();
	expect(denied.id).toBe('bad');
	expect(denied.error.code).toBe(-32001);

	peer.send({ id: 'resume', method: 'auth', params: { scheme: 'token', token } });
	const resumed = await peer.next();
	expect(resumed.id).toBe('resume');
	expect(resumed.result.you).toEqual(expect.objectContaining({ user_id: 'user_session_one', name: 'Name of user_session_one' }));
	expect(resumed.result.token).toBe(token);

	// A registered connection cannot switch identities in place.
	peer.send({ id: 'again', method: 'auth', params: { scheme: 'token', token } });
	expect((await peer.next()).error.code).toBe(-32001);
	peer.close();

	// A fresh session still has most of its lifetime: the resume left it as is.
	const expiresMs = await runInDurableObject(stub(), async (_instance, state) => {
		const sessions = await state.storage.list<{ userId: string; expiresMs: number }>({ prefix: 'session:' });
		return [...sessions.values()].find((session) => session.userId === 'user_session_one')!.expiresMs;
	});
	expect(expiresMs).toBeGreaterThan(Date.now() + 11 * 60 * 60 * 1000);
	// Simulate a crash between writing a renewed session and removing its old
	// index row. Cleanup must discard the stale due row while preserving the
	// still-live authoritative session.
	await runInDurableObject(stub(), async (_instance, state) => {
		const entries = await state.storage.list<{ sessionKey: string; expiresMs: number }>({ prefix: 'session-expiry:' });
		const current = [...entries].find(([, entry]) => entry.expiresMs === expiresMs);
		expect(current).toBeDefined();
		const [, entry] = current!;
		await state.storage.put(`session-expiry:${(Date.now() - 1).toString().padStart(16, '0')}:${entry.sessionKey.slice('session:'.length)}`, {
			...entry, expiresMs: Date.now() - 1,
		});
	});
	const racePeer = await connect();
	await greeting(racePeer);
	racePeer.send({ id: 'race-resume', method: 'auth', params: { scheme: 'token', token } });
	const [raceResumed] = await Promise.all([racePeer.next(), sweepSessions(stub(), Date.now() + 1)]);
	expect(raceResumed.result.you.user_id).toBe('user_session_one');
	racePeer.close();
	const sessionStillLive = await runInDurableObject(stub(), async (_instance, state) => {
		const index = await state.storage.list<{ expiresMs: number }>({ prefix: 'session-expiry:' });
		expect([...index.values()].every((entry) => entry.expiresMs > Date.now())).toBe(true);
		const sessions = await state.storage.list<StoredSessionTest>({ prefix: 'session:' });
		return [...sessions.values()].some((session) => session.userId === 'user_session_one' && session.expiresMs > Date.now());
	});
	expect(sessionStillLive).toBe(true);
});

it('renews a resumed session only once less than half its lifetime remains', async () => {
	await registerIdentity('user_session_renew', 'session-renew-ip');
	const token = await issueSession('user_session_renew', 'http://localhost:5173');
	const stored = () => runInDurableObject(stub(), async (_instance, state) => {
		const sessions = await state.storage.list<StoredSessionTest>({ prefix: 'session:' });
		const index = await state.storage.list<{ sessionKey: string; expiresMs: number }>({ prefix: 'session-expiry:' });
		const [key, session] = [...sessions].find(([, value]) => value.userId === 'user_session_renew')!;
		return { key, session, indexed: [...index.values()].filter((entry) => entry.sessionKey === key).map((entry) => entry.expiresMs) };
	});
	const renew = async () => {
		const { peer, reply } = await resume(token);
		expect(reply.result.you.user_id).toBe('user_session_renew');
		peer.close();
	};

	const issued = await stored();
	await renew();
	// Most of the lifetime remains: nothing is rewritten.
	expect(await stored()).toEqual(issued);

	// Two hours left: the resume renews it and moves its index entry.
	const soon = Date.now() + 2 * 60 * 60 * 1000;
	await runInDurableObject(stub(), async (_instance, state) => {
		await state.storage.put(issued.key, { ...issued.session, expiresMs: soon });
		for (const [indexKey, entry] of await state.storage.list<{ sessionKey: string }>({ prefix: 'session-expiry:' })) {
			if (entry.sessionKey === issued.key) await state.storage.delete(indexKey);
		}
		await state.storage.put(`session-expiry:${soon.toString().padStart(16, '0')}:${issued.key.slice('session:'.length)}`, { v: 1, sessionKey: issued.key, expiresMs: soon });
	});
	await renew();
	const renewed = await stored();
	expect(renewed.session.expiresMs).toBeGreaterThan(Date.now() + 11 * 60 * 60 * 1000);
	expect(renewed.indexed).toEqual([renewed.session.expiresMs]);
});

it('binds sessions to their origin, refuses them without one, and drops expired ones on the alarm', async () => {
	await registerIdentity('user_session_two');
	const cross = await resume(await issueSession('user_session_two', 'https://other.example'), 'cross');
	expect(cross.reply.error.code).toBe(-32001);
	cross.peer.close();
	// Without an Origin `token` is still offered, for bot tokens (/invite-bot),
	// but a passkey session stays on the origin it was issued for.
	const originless = await resume(await issueSession('user_session_two', 'http://localhost:5173'), 'originless', null);
	expect(originless.reply.error.code).toBe(-32001);
	originless.peer.close();

	await runInDurableObject(stub(), async (_instance, state) => {
		const sessions = await state.storage.list<{ userId: string; expiresMs: number }>({ prefix: 'session:' });
		for (const [key, session] of sessions) {
			if (session.userId === 'user_session_two') {
				const expiredMs = Date.now() - 1;
				await state.storage.put(key, { ...session, expiresMs: expiredMs });
				const index = await state.storage.list<{ sessionKey: string }>({ prefix: 'session-expiry:' });
				for (const [indexKey, entry] of index) if (entry.sessionKey === key) {
					await state.storage.delete(indexKey);
					const suffix = key.slice('session:'.length);
					await state.storage.put(`session-expiry:${Math.max(0, expiredMs).toString().padStart(16, '0')}:${suffix}`, { ...entry, expiresMs: expiredMs });
				}
			}
		}
	});
	await sweepSessions(stub(), Date.now());
	const remaining = await runInDurableObject(stub(), (_instance, state) => state.storage.list<{ userId: string }>({ prefix: 'session:' }));
	expect([...remaining.values()].some((session) => session.userId === 'user_session_two')).toBe(false);
});

it('denies a session token whose identity no longer exists without recreating it', async () => {
	// A storage reset wipes identities; a token that outlives its identity must
	// fall back to sign-in rather than crash or resurrect the account.
	const token = await issueSession('user_session_gone', 'http://localhost:5173');
	const { peer, reply: denied } = await resume(token, 'orphan');
	expect(denied.error.code).toBe(-32001);
	// The connection stays usable as a guest.
	peer.send({ id: 'guest', method: 'auth', params: { scheme: 'guest' } });
	expect((await peer.next()).result.you.user_id).toMatch(/^guest_/);
	peer.close();
	const after = await runInDurableObject(stub(), async (instance, state) => ({
		identity: (instance as unknown as { store: { getIdentity(id: string): unknown } }).store.getIdentity('user_session_gone'),
		session: [...(await state.storage.list<StoredSessionTest>({ prefix: 'session:' })).values()].some((session) => session.userId === 'user_session_gone'),
	}));
	expect(after).toEqual({ identity: null, session: false });
});

it('updates a registered name with me, declines avatar and ext, and treats name as unknown', async () => {
	await registerIdentity('user_session_me');
	const token = await issueSession('user_session_me', 'http://localhost:5173');
	const { peer, reply: resumed } = await resume(token);
	expect(resumed.result.you.user_id).toBe('user_session_me');

	peer.send({ id: 'rename', method: 'me', params: { name: 'Ada' } });
	expect((await reply(peer, 'rename')).result).toEqual({ you: { user_id: 'user_session_me', name: 'Ada', roles: [] } });
	// Omitted fields stay unchanged; the demo keeps no avatars or profile ext.
	peer.send({ id: 'profile', method: 'me', params: { avatar: 'https://example.test/a.png', ext: { demo: true } } });
	expect((await reply(peer, 'profile')).result).toEqual({ you: { user_id: 'user_session_me', name: 'Ada', roles: [] } });
	peer.send({ id: 'bad-avatar', method: 'me', params: { avatar: 7 } });
	expect((await reply(peer, 'bad-avatar')).error.code).toBe(-32602);
	// An empty name removes it, so clients fall back to the user_id.
	// It is announced as its empty value (§3.3).
	peer.send({ id: 'clear', method: 'me', params: { name: '' } });
	expect((await reply(peer, 'clear')).result).toEqual({ you: { user_id: 'user_session_me', name: '', roles: [] } });
	peer.send({ id: 'unchanged', method: 'me', params: {} });
	expect((await reply(peer, 'unchanged')).result).toEqual({ you: { user_id: 'user_session_me', roles: [] } });
	peer.close();

	// The removal is durable: a later resume carries no name either.
	const again = await resume(token);
	expect(again.reply.result.you).toEqual({ user_id: 'user_session_me', roles: [] });
	again.peer.close();
});

it('stops session cleanup safely when the maintenance budget is exhausted', async () => {
	const now = Date.now();
	const target = isolatedStub();
	await runInDurableObject(target, async (instance, state) => {
		await state.storage.put<StoredSessionTest>('session:budget-expired', {
			v: 1, userId: 'budget-expired', origin: 'http://localhost:5173', expiresMs: now - 1,
		});
		await state.storage.put(`session-expiry:${(now - 1).toString().padStart(16, '0')}:budget-expired`, {
			v: 1, sessionKey: 'session:budget-expired', expiresMs: now - 1,
		});
		const day = new Date(now).toISOString().slice(0, 10);
		state.storage.sql.exec(
			'UPDATE resource_budgets SET maintenance_reads = 100000000, maintenance_writes = 100000000 WHERE day = ?', day,
		);
		// The object was initialized before the direct SQL fixture update; force
		// the Store to reload the durable budget row on the next reservation.
		const store = (instance as unknown as { store: Record<string, unknown> }).store;
		store.budgetCache = null;
		store.budgetCacheDay = null;
		store.budgetHandoverPending = true;
	});
	await expect(sweepSessions(target, now)).rejects.toMatchObject({ code: 'retry_after' });
	const state = await runInDurableObject(target, async (_instance, durableState) => ({
		remaining: [...(await durableState.storage.list<StoredSessionTest>({ prefix: 'session:' })).values()].filter((session) => session.userId === 'budget-expired').length,
		indexed: (await durableState.storage.list({ prefix: 'session-expiry:' })).size,
	}));
	// Exhaustion leaves the expired session and its index row for a later alarm.
	expect(state).toEqual({ remaining: 1, indexed: 1 });
});

it('keeps concurrent async reservations isolated from unrelated SQL work', async () => {
	const target = isolatedStub();
	await runInDurableObject(target, async (instance) => {
		const store = (instance as unknown as {
			store: {
				withMeterAsync<T>(kind: 'foreground' | 'maintenance', cost: { reads: number; writes: number }, fn: () => Promise<T>): Promise<T>;
				getRoomState(): unknown;
				accountingStatus(): { unsafe: boolean };
			};
		}).store;
		await Promise.all([
			store.withMeterAsync('foreground', { reads: 1, writes: 1 }, async () => {
				await Promise.resolve();
				store.getRoomState();
				return 'foreground';
			}),
			store.withMeterAsync('maintenance', { reads: 1, writes: 1 }, async () => {
				await Promise.resolve();
				store.getRoomState();
				return 'maintenance';
			}),
		]);
		expect(store.accountingStatus().unsafe).toBe(false);
	});
});

it('sends user notifications for renames and for a guest signing in on its connection', async () => {
	await registerIdentity('user_session_notify', 'session-notify-ip');
	const token = await issueSession('user_session_notify', 'http://localhost:5173');
	const watcher = await connect();
	const tab = await connect();
	const second = await connect();
	try {
		for (const peer of [watcher, tab, second]) await greeting(peer);
		watcher.send({ id: 'guest', method: 'auth', params: { scheme: 'guest' } });
		await until(watcher, (frame) => frame.id === 'guest');
		tab.send({ id: 'guest', method: 'auth', params: { scheme: 'guest' } });
		const guest = (await until(tab, (frame) => frame.id === 'guest')).frame.result.you;
		// Signing in on a guest's connection retires the guest for everyone else.
		tab.send({ id: 'resume', method: 'auth', params: { scheme: 'token', token } });
		expect((await until(tab, (frame) => frame.id === 'resume')).frame.result.you.user_id).toBe('user_session_notify');
		expect((await until(watcher, (frame) => frame.method === 'user')).frame.params).toEqual({ new: { user_id: 'user_session_notify', name: 'Name of user_session_notify', roles: [] }, old: guest });

		second.send({ id: 'resume', method: 'auth', params: { scheme: 'token', token } });
		await until(second, (frame) => frame.id === 'resume');
		tab.send({ id: 'rename', method: 'me', params: { name: 'Notified' } });
		await until(tab, (frame) => frame.id === 'rename');
		expect((await until(second, (frame) => frame.method === 'user')).frame.params).toEqual({ you: { user_id: 'user_session_notify', name: 'Notified', roles: [] } });
		expect((await until(watcher, (frame) => frame.method === 'user')).frame.params).toEqual({ new: { user_id: 'user_session_notify', name: 'Notified', roles: [] } });
	} finally { watcher.close(); tab.close(); second.close(); }
});

it('does not count a closing connection against the per-user limit on resume', async () => {
	const userId = 'user_session_capacity';
	await registerIdentity(userId, 'session-capacity-ip');
	const token = await issueSession(userId, 'http://localhost:5173');
	const open = [];
	for (const id of ['one', 'two', 'three']) {
		const { peer, reply } = await resume(token, id);
		expect(reply.result.you.user_id).toBe(userId);
		open.push(peer);
	}
	const refused = await resume(token, 'four');
	expect(refused.reply.error).toEqual(expect.objectContaining({ code: -32002, message: 'Demo capacity reached' }));
	refused.peer.close();

	// One of them dropped and its close is on the way: its replacement resumes.
	await runInDurableObject(stub(), async (instance) => {
		const sockets = (instance as unknown as { ctx: DurableObjectState }).ctx.getWebSockets();
		const dropped = sockets.find((socket) => (socket.deserializeAttachment() as { userId?: string } | null)?.userId === userId)!;
		dropped.serializeAttachment({ ...(dropped.deserializeAttachment() as object), closing: true });
	});
	const replacement = await resume(token, 'replacement');
	expect(replacement.reply.result.you.user_id).toBe(userId);
	replacement.peer.close();
	for (const peer of open) peer.close();
});

it('logs a registered user\'s joins and leaves as memberships, delivered around the change and kept in history', async () => {
	const userId = 'user_session_rooms';
	const name = `Name of ${userId}`;
	// A registration keeps the rooms a guest had joined that still exist.
	expect(await registerIdentity(userId, `ip-${userId}`, ['general', 'no-such-room'])).toEqual(['general']);
	const token = await issueSession(userId, 'http://localhost:5173');
	const signIn = async () => {
		const { peer, reply } = await resume(token);
		expect(reply.result.you.user_id).toBe(userId);
		return peer;
	};
	const joinedIds = async (peer: Peer) =>
		(await request(peer, 'mine', 'room_list', { filter: 'joined' })).result.joined.map((room: { room_id: string }) => room.room_id);
	const methods = (frames: Frame[]) => frames.map((frame) => frame.method);
	// A logged membership record, as `room_update` `membership` carries it (§4.3.2).
	const record = (roomId: string, joined: boolean) => ({
		log_id: expect.stringMatching(/^[1-9][0-9]*$/), room_id: roomId, members: [{ user: { user_id: userId, name }, joined }],
	});
	const membershipOnly = (roomId: string, joined: boolean) => ({ method: 'room_update', params: { memberships: [record(roomId, joined)] } });
	const tab = await signIn();
	const other = await signIn();
	const reader = await connect();
	let threadId: string;
	try {
		await greeting(reader);
		const guest = (await exchange(reader, 'guest', 'auth', { scheme: 'guest' })).frame.result.you;
		// Creating: one `room_update` with `joined` (the creator as the only
		// member, whose head is already the creator's logged membership), that
		// `membership`, and `users`, then the result; on every connection of the user.
		const created = await exchange(tab, 'thread', 'room_set', { parent_room_id: 'general', title: 'Kept' });
		threadId = created.frame.result.room_id;
		expect(methods(created.skipped)).toEqual(['room_update']);
		const [update] = created.skipped;
		expect(Object.keys(update.params)).toEqual(['joined', 'memberships', 'users']);
		expect(update.params.joined[0]).toMatchObject({ room_id: threadId, log_id: threadId, members: [{ user_id: userId }] });
		// Current objects carry the registered user's roles, [] when none (§3.3).
		expect(update.params.users).toEqual([{ user_id: userId, name, roles: [] }]);
		const joinedRecord = update.params.memberships[0];
		expect(joinedRecord).toEqual(record(threadId, true));
		expect(update.params.joined[0].latest_log_id).toBe(joinedRecord.log_id);
		expect(BigInt(joinedRecord.log_id)).toBeGreaterThan(BigInt(threadId));
		const otherCreated = await until(other, (frame) => frame.method === 'room_update' && frame.params.joined?.[0]?.room_id === threadId);
		expect(otherCreated.frame.params.memberships).toEqual([record(threadId, true)]);
		// The parent's other members get the new thread, but not its membership.
		const announced = await until(reader, (frame) => frame.method === 'room_update');
		expect(announced.frame.params).toEqual({ updated: [expect.objectContaining({ room_id: threadId })] });

		// A guest's join is not logged: `joined` alone, with every member.
		const guestJoin = await exchange(reader, 'guest-join', 'room_join', { room_id: threadId });
		expect(methods(guestJoin.skipped)).toEqual(['room_update']);
		expect(guestJoin.skipped[0].params.memberships).toBeUndefined();
		expect(guestJoin.skipped[0].params.joined[0].members.map((member: { user_id: string }) => member.user_id)).toEqual([guest.user_id, userId].sort());
		expect(guestJoin.skipped[0].params.users).toEqual([guest, { user_id: userId, name, roles: [] }].sort((a, b) => a.user_id < b.user_id ? -1 : 1));

		// Leaving: the leaver's connections get `left` with the membership in one
		// frame, then the result; the room's other members get the membership alone.
		const left = await exchange(tab, 'leave', 'room_leave', { room_id: threadId });
		expect(left.skipped).toEqual([{ method: 'room_update', params: { left: [{ room_id: threadId }], memberships: [record(threadId, false)] } }]);
		const otherLeft = await until(other, (frame) => frame.method === 'room_update' && frame.params.left !== undefined);
		expect(otherLeft.frame.params.memberships).toEqual([record(threadId, false)]);
		expect((await until(reader, (frame) => frame.method === 'room_update' && frame.params.memberships)).frame).toEqual(membershipOnly(threadId, false));
		// Joining again: the joiner's connections get `joined` with the membership;
		// the room's other members the membership alone.
		const rejoined = await exchange(other, 'join', 'room_join', { room_id: threadId });
		expect(methods(rejoined.skipped)).toEqual(['room_update']);
		const rejoin = rejoined.skipped[0].params;
		expect(rejoin.memberships).toEqual([record(threadId, true)]);
		expect(rejoin.joined[0].latest_log_id).toBe(rejoin.memberships[0].log_id);
		expect((await until(tab, (frame) => frame.method === 'room_update' && frame.params.joined)).frame.params.memberships).toEqual([record(threadId, true)]);
		expect((await until(reader, (frame) => frame.method === 'room_update' && frame.params.memberships)).frame).toEqual(membershipOnly(threadId, true));

		// History holds the logged memberships, and records keep the user
		// objects they were logged with: no `users`.
		const page = (await exchange(reader, 'history', 'history', { room_id: threadId })).frame.result;
		expect(page.memberships.map((record: { members: Array<{ joined: boolean }> }) => record.members[0].joined)).toEqual([true, false, true]);
		expect(page.memberships[0]).toEqual(joinedRecord);
		expect(page.messages).toBeUndefined();
		expect(page.last_log_id).toBe(rejoin.memberships[0].log_id);
		const posted = await exchange(tab, 'post', 'message', { body: { text: 'before the rename' } });
		await exchange(tab, 'rename', 'me', { name: 'Renamed later' });
		const general = (await exchange(reader, 'general', 'history', { after: posted.frame.result.message_id })).frame.result;
		expect(general.messages[0].from).toEqual({ user_id: userId, name });
		expect(general.users).toBeUndefined();
		// Listings carry the current name.
		const listed = (await exchange(reader, 'members', 'room_list', { room_id: threadId, members: true })).frame.result;
		expect(listed.users).toEqual(expect.arrayContaining([{ user_id: userId, name: 'Renamed later', roles: [] }]));
	} finally { tab.close(); other.close(); reader.close(); }

	// A later connection has the same rooms, until the user leaves general;
	// an offline registered member is still listed as a member.
	const later = await signIn();
	try {
		expect((await joinedIds(later)).sort()).toEqual(['general', threadId!].sort());
		await exchange(later, 'leave-general', 'room_leave', { room_id: 'general' });
	} finally { later.close(); }
	const watcher = await connect();
	try {
		await greeting(watcher);
		await exchange(watcher, 'guest', 'auth', { scheme: 'guest' });
		const listed = (await exchange(watcher, 'members', 'room_list', { room_id: threadId!, members: true })).frame.result;
		expect(listed.not_joined[0].members).toEqual([{ user_id: userId }]);
	} finally { watcher.close(); }
	const last = await signIn();
	try {
		expect(await joinedIds(last)).toEqual([threadId!]);
	} finally { last.close(); }
});

it('sends a rename only to users who share a room with the renamed user', async () => {
	await registerIdentity('user_session_scope', 'session-scope-ip');
	const token = await issueSession('user_session_scope', 'http://localhost:5173');
	const tab = await connect();
	const sharing = await connect();
	const apart = await connect();
	try {
		for (const peer of [tab, sharing, apart]) await greeting(peer);
		await exchange(tab, 'resume', 'auth', { scheme: 'token', token });
		await exchange(sharing, 'guest', 'auth', { scheme: 'guest' });
		await exchange(apart, 'guest', 'auth', { scheme: 'guest' });
		await exchange(apart, 'leave', 'room_leave', { room_id: 'general' });
		await exchange(tab, 'rename', 'me', { name: 'Scoped' });
		expect((await until(sharing, (frame) => frame.method === 'user')).frame.params).toEqual({ new: { user_id: 'user_session_scope', name: 'Scoped', roles: [] } });
		// Apart shares no room: a round trip shows no `user` came before it.
		expect((await exchange(apart, 'sync', 'me', {})).skipped.filter((frame) => frame.method === 'user')).toEqual([]);
	} finally { tab.close(); sharing.close(); apart.close(); }
});
