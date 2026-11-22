import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { PUSH_POLICY } from '../src/budget';
import { type Store, openStore } from '../src/store';
import { sqliteOf } from '../src/store/open';
import { SCHEMA_VERSION } from '../src/store/schema';
import { LOBBY_TITLE, WAKE_SCOPES } from '../src/domain';
import { connect as open, exchange, request, until, type Frame, type Peer } from './helpers/socket';
import { withStore } from './helpers/store';
import { noAuditSink, type AdminAuditEvent, type AuditSink } from '../src/commands/audit';
import { softPasskey } from './helpers/webauthn';

/**
 * Access modes (`ACCESS=lobby` and `ACCESS=private`): the lobby room, what
 * guests and waiting accounts see and may do, `/welcome`, `/lobby`,
 * the `server` frame of each, switching modes, and the schema 12 upgrade.
 * The suite sets the mode on the running object, as other suites set
 * GUEST_POSTING (vitest.config.ts sets it for the public mode).
 */

let nextIp = 1;
const stub = () => env.DEMO.getByName('public-demo-v1');
const ADMIN_TOKEN = 'admin-token-lobby-0123456789ab';
const ORIGIN = 'http://localhost:5173';
const connect = (origin: string | null = ORIGIN) => open({ ip: `198.51.104.${nextIp++}`, origin });
const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

type Runtime = {
	config: Record<string, unknown>;
	lobbyReady: boolean;
	toggles: Map<string, boolean | undefined>;
	topLevelRooms: string[] | undefined;
	applyAccess(): void;
	store: Store;
	issueSession(userId: string, origin: string, now: number): Promise<string>;
};

/** Puts the running object in `access` mode, with the lobby open and the admin token set. */
async function setAccess(access: 'public' | 'lobby' | 'private'): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as Runtime;
		server.config = { ...server.config, access, lobbyRoom: 'lobby', guestPosting: access === 'public', adminToken: ADMIN_TOKEN };
		server.lobbyReady = false;
		server.toggles.delete('lobby');
		server.store.server.setToggle('lobby', undefined);
		server.topLevelRooms = undefined;
		server.applyAccess();
	});
}

afterEach(() => setAccess('public'));

/** A user registered straight into the store (waiting or not), signed in on a new connection with a session token. */
async function signedIn(userId: string, options: { waiting?: boolean } = {}): Promise<{ peer: Peer; auth: Frame; token: string }> {
	const token = await runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as Runtime;
		runtime.store.accounts.register({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
			...(options.waiting ? { waiting: true, rooms: ['lobby'] } : {}),
		});
		return runtime.issueSession(userId, ORIGIN, Date.now());
	});
	return { ...await resume(token), token };
}

/** Signs a new connection in with a session token. */
async function resume(token: string): Promise<{ peer: Peer; auth: Frame }> {
	const peer = await connect();
	await peer.next();
	await peer.next();
	const auth = await request(peer, 'auth', 'auth', { scheme: 'token', token });
	return { peer, auth };
}

async function signedInAdmin(): Promise<Peer> {
	const peer = await connect(null);
	await peer.next();
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token: ADMIN_TOKEN })).result.you.user_id).toBe('admin');
	return peer;
}

/** A member with the role `mod`, given by the admin. */
async function signedInMod(admin: Peer): Promise<{ peer: Peer; userId: string }> {
	const userId = unique('mod');
	const { peer } = await signedIn(userId);
	expect((await command(admin, 'role-mod', `/role ${userId} mod`)).frame.result).toEqual({});
	await until(peer, (frame) => frame.method === 'user' && frame.params.you?.roles?.includes('mod'));
	return { peer, userId };
}

async function guest(): Promise<{ peer: Peer; auth: Frame; server: Frame }> {
	const peer = await connect();
	const server = await peer.next();
	await peer.next();
	const auth = await request(peer, 'auth', 'auth', { scheme: 'guest' });
	return { peer, auth, server };
}

/** Runs a command; its reply, the `~private` notice before it if any, and every frame before it. */
async function command(peer: Peer, id: string, text: string, roomId = 'general'): Promise<{ frame: Frame; notice?: Frame; skipped: Frame[] }> {
	const { frame, skipped } = await exchange(peer, id, 'command', { room_id: roomId, body: { text } });
	const notice = skipped.find((candidate) => candidate.method === 'message' && candidate.params.from.user_id === '~private');
	return { frame, notice, skipped };
}

/** Registers a passkey over the wire on `peer`: begin, then finish with a software authenticator. */
async function registerPasskey(peer: Peer, id: string) {
	const passkey = await softPasskey(ORIGIN);
	const begun = await request(peer, `${id}-begin`, 'auth', { scheme: 'webauthn', action: 'register', step: 'begin' });
	if (begun.error) return { begun, finished: begun, passkey };
	const credential = await passkey.register(begun.result.public_key);
	const finished = await request(peer, `${id}-finish`, 'auth', { scheme: 'webauthn', action: 'register', step: 'finish', challenge_id: begun.result.challenge_id, credential });
	return { begun, finished, passkey };
}

/** A message posted in `general` by a member, for lookups others must not reach. */
async function generalMessage(peer: Peer): Promise<string> {
	const posted = await request(peer, unique('post'), 'message', { room_id: 'general', body: { text: 'members only' } });
	return posted.result.message_id;
}

const unknownRoom = (frame: Frame) => expect(frame.error, JSON.stringify(frame)).toMatchObject({ code: -32602 });
const denied = (frame: Frame) => expect(frame.error, JSON.stringify(frame)).toMatchObject({ code: -32001 });

describe('configuration', () => {
	const base = { NODE_ENV: 'test' };
	it('defaults to public, and validates ACCESS, LOBBY_ROOM and GUEST_POSTING', () => {
		expect(loadConfig({ ...base })).toMatchObject({ access: 'public', lobbyRoom: 'lobby' });
		expect(loadConfig({ ...base, ACCESS: 'lobby', LOBBY_ROOM: 'front-door' })).toMatchObject({ access: 'lobby', lobbyRoom: 'front-door', guestPosting: false });
		expect(loadConfig({ ...base, ACCESS: 'private' })).toMatchObject({ access: 'private', guestPosting: false });
		expect(() => loadConfig({ ...base, ACCESS: 'secret' })).toThrow(/ACCESS must be public, lobby or private/);
		for (const room of ['general', 'private_1', '123', 'Lobby', 'a'.repeat(33)]) {
			expect(() => loadConfig({ ...base, ACCESS: 'lobby', LOBBY_ROOM: room }), room).toThrow(/LOBBY_ROOM/);
		}
		// GUEST_POSTING applies only to public: set at all with another mode, it fails.
		expect(() => loadConfig({ ...base, ACCESS: 'lobby', GUEST_POSTING: 'true' })).toThrow(/GUEST_POSTING applies only with ACCESS=public/);
		expect(() => loadConfig({ ...base, ACCESS: 'private', GUEST_POSTING: 'false' })).toThrow(/GUEST_POSTING/);
		expect(loadConfig({ ...base, ACCESS: 'public', GUEST_POSTING: 'true' }).guestPosting).toBe(true);
	});
});

describe('lobby mode', () => {
	it('makes the Public Lobby, outside the created-room caps, and advertises it', async () => {
		await setAccess('lobby');
		const { peer, server } = await guest();
		try {
			expect(server.params.auth).toContain('guest');
			expect(server.params.signup).toEqual(['webauthn', 'token']);
			// No protocol change: the frame says nothing of the lobby.
			expect(server.params.ext.settings).not.toHaveProperty('lobby');
			const listed = await request(peer, 'list', 'room_list', {});
			expect([...listed.result.joined, ...listed.result.not_joined].map((room: { room_id: string }) => room.room_id)).toEqual(['lobby']);
			expect(listed.result.joined[0]).toMatchObject({ room_id: 'lobby', title: LOBBY_TITLE });
		} finally { peer.close(); }
		await withStore('lobby-caps', {}, (store) => {
			store.lifecycle.setAccess({ lobbyRoom: 'lobby', waitingRefused: false });
			expect(store.rooms.ensureLobby('lobby')).toMatchObject({ room_id: 'lobby', title: LOBBY_TITLE });
			// Made once; a second call adopts it as it is.
			expect(store.rooms.ensureLobby('lobby')).toBeNull();
			const counts = { createdTopLevelRooms: () => (sqliteOf(store) as unknown as { createdTopLevelRooms(): number }).createdTopLevelRooms(), recentRoomCount: (_kind: string, now: number) => store.rooms.counts(now).public.recent };
			expect(counts.createdTopLevelRooms()).toBe(0);
			expect(counts.recentRoomCount('public', Date.now() + 10_000)).toBe(0);
		});
	});

	it('takes welcome and description from the lobby before sign-in and for those it holds, and general\'s for members', async () => {
		await setAccess('lobby');
		const admin = await signedInAdmin();
		try {
			expect((await request(admin, 'lobby-desc', 'room_set', { room_id: 'lobby', title: 'Public Lobby', description: 'Say hi to get in.' })).result).toEqual({ room_id: 'lobby' });
			expect((await request(admin, 'general-desc', 'room_set', { room_id: 'general', title: 'General', description: 'Members talk here.' })).result).toEqual({ room_id: 'general' });
			const { peer, server } = await guest();
			try {
				// The lobby's description once, as the description, and no `welcome` beside it.
				expect(server.params.description).toBe('Say hi to get in.');
				expect(server.params).not.toHaveProperty('welcome');
			} finally { peer.close(); }
			// With a description of the server's own, the lobby's is the `welcome`.
			expect((await command(admin, unique('server-desc'), '/server description A server for testing.')).frame.result).toEqual({});
			try {
				const { peer: other, server: framed } = await guest();
				try {
					expect(framed.params.description).toBe('A server for testing.');
					expect(framed.params.welcome).toBe('Say hi to get in.');
				} finally { other.close(); }
			} finally {
				expect((await command(admin, unique('server-clear'), '/server description')).frame.result).toEqual({});
			}
			// A member signing in is sent a member's frame.
			const { peer: member } = await signedIn(unique('member'));
			try {
				const { frame } = await until(member, (candidate) => candidate.method === 'server');
				expect(frame.params.description).toBe('Members talk here.');
				expect(frame.params.welcome).toBe('Members talk here.');
				expect(frame.params.ext.settings).not.toHaveProperty('lobby');
			} finally { member.close(); }
		} finally {
			await request(admin, 'lobby-clear', 'room_set', { room_id: 'lobby', title: 'Public Lobby' });
			await request(admin, 'general-clear', 'room_set', { room_id: 'general', title: 'General' });
			admin.close();
		}
	});

	it('never shows general\'s description before sign-in where the frame reads the lobby, or nothing', async () => {
		await setAccess('lobby');
		const admin = await signedInAdmin();
		const description = (frame: Frame) => [frame.params.description, frame.params.welcome];
		try {
			const saved = await request(admin, unique('general-desc'), 'room_set', { room_id: 'general', title: 'General', description: 'Members only talk here.' });
			expect(saved.result, JSON.stringify(saved)).toEqual({ room_id: 'general' });
			// A lobby without a description: none from general.
			const open = await connect();
			try {
				expect(description(await open.next())).not.toContain('Members only talk here.');
			} finally { open.close(); }
			// A closed lobby.
			expect((await command(admin, unique('close'), '/lobby close')).frame.result).toEqual({});
			const closed = await connect();
			try {
				const server = await closed.next();
				expect(server.params.description).toBeUndefined();
				expect(description(server)).not.toContain('Members only talk here.');
			} finally { closed.close(); }
			// Private.
			await setAccess('private');
			const shut = await connect();
			try {
				const server = await shut.next();
				expect(server.params.description).toBeUndefined();
				expect(description(server)).not.toContain('Members only talk here.');
			} finally { shut.close(); }
		} finally {
			await request(admin, unique('general-clear'), 'room_set', { room_id: 'general', title: 'General' });
			admin.close();
		}
	});

	it('a guest that makes an account in the lobby leaves as the guest and arrives as a new user, with no old link', async () => {
		await setAccess('lobby');
		const { peer: member } = await signedIn(unique('watcher'));
		try {
			expect((await request(member, 'join', 'room_join', { room_id: 'lobby' })).result).toEqual({});
			const { peer, auth } = await guest();
			const guestId = auth.result.you.user_id;
			await until(member, (frame) => frame.method === 'room_update' && frame.params.memberships?.[0]?.members?.[0]?.user?.user_id === guestId);
			const { finished } = await registerPasskey(peer, 'register');
			const accountId = finished.result.you.user_id;
			const seen: Frame[] = [];
			const membership = (userId: string, joined: boolean) => (frame: Frame) => frame.method === 'room_update' &&
				frame.params.memberships?.some((record: { members: Array<{ user: { user_id: string }; joined: boolean }> }) => record.members[0].user.user_id === userId && record.members[0].joined === joined);
			const isProfile = (frame: Frame) => frame.method === 'user' && frame.params.new?.user_id === accountId;
			// The account's logged join, its profile, and the guest's logged leave, in whatever order they come.
			while (![membership(accountId, true), membership(guestId, false), isProfile].every((match) => seen.some(match))) seen.push(await member.next());
			expect(seen.filter((frame) => frame.method === 'user' && frame.params.old !== undefined)).toEqual([]);
			expect(seen.find(isProfile)!.params.new.roles).toEqual(['waiting']);
			peer.close();
		} finally { member.close(); }
	});

	it('logs guests coming into and leaving the lobby for its members', async () => {
		await setAccess('lobby');
		const memberId = unique('watcher');
		const { peer: member } = await signedIn(memberId);
		try {
			expect((await request(member, 'join', 'room_join', { room_id: 'lobby' })).result).toEqual({});
			const { peer, auth } = await guest();
			const guestId = auth.result.you.user_id;
			const joined = await until(member, (frame) => frame.method === 'room_update' && frame.params.memberships?.[0]?.members?.[0]?.user?.user_id === guestId);
			expect(joined.frame.params.memberships[0]).toMatchObject({ room_id: 'lobby', log_id: expect.any(String), members: [{ user: { user_id: guestId }, joined: true }] });
			peer.close();
			const left = await until(member, (frame) => frame.method === 'room_update' && frame.params.memberships?.[0]?.members?.[0]?.user?.user_id === guestId);
			expect(left.frame.params.memberships[0].members[0].joined).toBe(false);
			// Both are in the lobby's history, as any membership is.
			const history = await request(member, 'history', 'history', { room_id: 'lobby' });
			expect(history.result.memberships.filter((record: { members: Array<{ user: { user_id: string } }> }) => record.members[0].user.user_id === guestId)).toHaveLength(2);
		} finally { member.close(); }
	});

	it('lets a guest post in the lobby only, and answers every other room as unknown', async () => {
		await setAccess('lobby');
		const { peer: member } = await signedIn(unique('member'));
		const { peer, auth } = await guest();
		try {
			// ext:permissions as in public mode: a guest here may write (in the lobby).
			expect(auth.result.you.ext).toEqual({ permissions: {} });
			expect(auth.result.you.roles).toBeUndefined();
			const messageId = await generalMessage(member);
			const thread = await request(member, 'thread', 'room_set', { parent_room_id: 'lobby', title: 'Intros' });
			const threadId = thread.result.room_id;
			// Posting: in the lobby, and without room_id (its default room); not in general.
			expect((await request(peer, 'post', 'message', { room_id: 'lobby', body: { text: 'hello' } })).result.message_id).toBeDefined();
			const defaulted = await exchange(peer, 'post-default', 'message', { body: { text: 'hello again' } });
			expect(defaulted.skipped.find((frame) => frame.method === 'message')?.params.room_id).toBe('lobby');
			expect((await request(peer, 'thread-post', 'message', { room_id: threadId, body: { text: 'in a lobby thread' } })).result.message_id).toBeDefined();
			// Every other room reads as one that does not exist: each asked on a
			// guest of its own, as each answer counts as a policy violation.
			const asked: Array<[string, Record<string, unknown>]> = [
				['message', { room_id: 'general', body: { text: 'nope' } }],
				['history', { room_id: 'general' }],
				['room_list', { room_id: 'general' }],
				['room_join', { room_id: 'general' }],
				['room_leave', { room_id: 'general' }],
				['reactions', { message_id: messageId, reactions: ['👍'] }],
				['message', { room_id: 'lobby', reply_to: { message_id: messageId }, body: { text: 'reply' } }],
				['command', { room_id: 'general', body: { text: '/help' } }],
			];
			for (const [method, params] of asked) {
				const other = await guest();
				try {
					unknownRoom(await request(other.peer, method, method, params));
				} finally { other.peer.close(); }
			}
			// It sees the lobby's history and threads.
			expect((await request(peer, 'lobby-history', 'history', { room_id: 'lobby' })).result).toBeDefined();
			const threads = await request(peer, 'threads', 'room_list', { parent_room_id: 'lobby' });
			expect(threads.result.not_joined.map((room: { room_id: string }) => room.room_id)).toContain(threadId);
			// It starts no thread or room, changes none, and adds nobody.
			denied(await request(peer, 'new-thread', 'room_set', { parent_room_id: 'lobby', title: 'Mine' }));
			denied(await request(peer, 'new-room', 'room_set', { title: 'Mine' }));
			denied(await request(peer, 'edit-thread', 'room_set', { room_id: threadId, title: 'Renamed' }));
			denied(await request(peer, 'add', 'room_join', { room_id: 'lobby', user_id: 'admin' }));
			// /help lists no /invite-bot.
			const help = await command(peer, 'help', '/help', 'lobby');
			expect(help.notice!.params.body.text).not.toContain('/invite-bot');
		} finally { peer.close(); member.close(); }
	});

	it('makes a waiting account of a guest that adds a passkey, which sees only the lobby and resumes as waiting', async () => {
		await setAccess('lobby');
		const { peer: member } = await signedIn(unique('member'));
		const { peer, auth } = await guest();
		try {
			const guestId = auth.result.you.user_id;
			const { finished } = await registerPasskey(peer, 'register');
			const you = finished.result.you;
			expect(you.user_id).not.toBe(guestId);
			expect(you.roles).toEqual(['waiting']);
			expect(you.ext.permissions).toEqual({});
			const joined = await request(peer, 'joined', 'room_list', { filter: 'joined' });
			expect(joined.result.joined.map((room: { room_id: string }) => room.room_id)).toEqual(['lobby']);
			unknownRoom(await request(peer, 'history', 'history', { room_id: 'general' }));
			denied(await request(peer, 'bot', 'command', { room_id: 'lobby', body: { text: '/invite-bot' } }));
			// It may name itself, unlike a guest, and is not added elsewhere.
			expect((await request(peer, 'name', 'me', { name: 'Waiter' })).result.you.name).toBe('Waiter');
			const admin = await signedInAdmin();
			try {
				denied(await request(admin, 'add', 'room_join', { room_id: 'general', user_id: you.user_id }));
			} finally { admin.close(); }
			// A session resume keeps it waiting.
			const resumed = await resume(finished.result.token);
			try {
				expect(resumed.auth.result.you.roles).toEqual(['waiting']);
				unknownRoom(await request(resumed.peer, 'history', 'history', { room_id: 'general' }));
			} finally { resumed.peer.close(); }
		} finally { peer.close(); member.close(); }
	});

	it('/welcome by a mod lets a waiting account in at once, telling it of the rooms it now sees', async () => {
		await setAccess('lobby');
		const admin = await signedInAdmin();
		const mod = await signedInMod(admin);
		// A room only members see, which the waiting account learns of once in.
		const created = await request(admin, 'room', 'room_set', { title: unique('Projects') });
		const roomId = created.result.room_id;
		const waitingId = unique('waiter');
		const { peer, auth } = await signedIn(waitingId, { waiting: true });
		try {
			expect(auth.result.you.roles).toEqual(['waiting']);
			unknownRoom(await request(peer, 'unseen', 'room_list', { room_id: roomId }));
			// No ext.permissions key says who may welcome (no protocol change).
			expect((await request(mod.peer, 'me', 'me', {})).result.you.ext.permissions).not.toHaveProperty('invite');
			const welcomed = await command(mod.peer, 'welcome', `/welcome @${waitingId}`);
			expect(welcomed.frame.result).toEqual({});
			expect(welcomed.notice!.params.body.text).toContain('is now a member');
			const you = await until(peer, (frame) => frame.method === 'user' && frame.params.you !== undefined);
			expect(you.frame.params.you.roles).toEqual([]);
			expect(you.frame.params.you.ext.permissions).not.toHaveProperty('lobby');
			const joined = await until(peer, (frame) => frame.method === 'room_update' && frame.params.joined?.[0]?.room_id === 'general');
			expect(joined.frame.params.memberships).toHaveLength(1);
			// The rooms it sees now and has not joined, as an unfiltered room_list's not_joined.
			const updated = await until(peer, (frame) => frame.method === 'room_update' && frame.params.updated !== undefined);
			const ids = updated.frame.params.updated.map((room: { room_id: string }) => room.room_id);
			expect(ids).toContain(roomId);
			expect(ids).not.toContain('general');
			expect(ids).not.toContain('lobby');
			const notice = (await until(peer, (frame) => frame.method === 'message' && frame.params.from.user_id === '~private')).frame;
			expect(notice.params.body.text).toBe(`@${mod.userId} welcomed you in.`);
			// Where it was: the lobby.
			expect(notice.params.room_id).toBe('lobby');
			const listed = await request(peer, 'list', 'room_list', { filter: 'not_joined' });
			expect([...ids].sort()).toEqual(listed.result.not_joined.map((room: { room_id: string }) => room.room_id).sort());
			expect(updated.frame.params.updated.find((room: { room_id: string }) => room.room_id === roomId)).toEqual(listed.result.not_joined.find((room: { room_id: string }) => room.room_id === roomId));
			expect((await request(peer, 'history', 'history', { room_id: 'general' })).result).toBeDefined();
			// Again: a member already.
			expect((await command(mod.peer, 'again', `/welcome ${waitingId}`)).notice!.params.body.text).toContain('already a member');
			unknownRoom((await command(mod.peer, 'nobody', '/welcome nobody_at_all')).frame);
		} finally { peer.close(); mod.peer.close(); admin.close(); }
	});

	it('splits the rooms a welcomed account now sees into frames within the response cap', async () => {
		await setAccess('lobby');
		const admin = await signedInAdmin();
		try {
			for (let n = 0; n < 3; n += 1) expect((await request(admin, `room-${n}`, 'room_set', { title: unique('Room'), description: 'x'.repeat(300) })).result.room_id).toBeDefined();
		} finally { admin.close(); }
		await runInDurableObject(stub(), (instance) => {
			const server = instance as unknown as Runtime & { newlyVisibleRooms(joined: string[]): Frame[] };
			const limits = server.config.limits as Record<string, number>;
			const all = server.newlyVisibleRooms(['lobby']);
			const rooms = all.flatMap((frame) => frame.params.updated);
			expect(rooms.map((room: { room_id: string }) => room.room_id)).toContain('general');
			expect(rooms.every((room: { parent_room_id?: string; private?: boolean }) => room.parent_room_id === undefined && !room.private)).toBe(true);
			const saved = limits.historyMaxResponseBytes;
			server.config = { ...server.config, limits: { ...limits, historyMaxResponseBytes: 1_024 + 700 } };
			try {
				const split = server.newlyVisibleRooms(['lobby']);
				expect(split.length).toBeGreaterThan(1);
				expect(split.flatMap((frame) => frame.params.updated)).toEqual(rooms);
				for (const frame of split) if (frame.params.updated.length > 1) expect(JSON.stringify(frame).length).toBeLessThanOrEqual(1_024 + 700);
			} finally {
				server.config = { ...server.config, limits: { ...limits, historyMaxResponseBytes: saved } };
			}
		});
	});

	it('/welcome finds its target as the typed user_id (with @, trailing spaces), the one mention, or the author of the message it replies to', async () => {
		await setAccess('lobby');
		const admin = await signedInAdmin();
		const welcome = (peer: Peer, id: string, params: Record<string, unknown>) => exchange(peer, id, 'command', { room_id: 'lobby', ...params });
		const welcomedBy = async (guestPeer: Peer) => {
			const you = await until(guestPeer, (frame) => frame.method === 'user' && frame.params.you !== undefined);
			expect(you.frame.params.you.roles).toEqual(['welcomed']);
		};
		try {
			// In reply to a guest's introduction in the lobby.
			const intro = await guest();
			const posted = await request(intro.peer, 'intro', 'message', { room_id: 'lobby', body: { text: 'Hi, I am new here' } });
			const replied = await welcome(admin, 'reply', { reply_to: { message_id: posted.result.message_id }, body: { text: '/welcome' } });
			expect(replied.frame, JSON.stringify(replied.frame)).toMatchObject({ result: {} });
			await welcomedBy(intro.peer);
			intro.peer.close();
			// The typed id with `@` and trailing spaces, as autocompletion leaves it.
			const typed = await guest();
			expect((await welcome(admin, 'typed', { body: { text: `/welcome @${typed.auth.result.you.user_id}   ` } })).frame.result).toEqual({});
			await welcomedBy(typed.peer);
			typed.peer.close();
			// The one mention, whatever the text shows of it.
			const mentioned = await guest();
			expect((await welcome(admin, 'mention', { body: { text: `/welcome @${mentioned.auth.result.you.name}`, mentions: [mentioned.auth.result.you.user_id] } })).frame.result).toEqual({});
			await welcomedBy(mentioned.peer);
			mentioned.peer.close();
			// One mention wins over a typed word.
			const both = await guest();
			const other = await guest();
			expect((await welcome(admin, 'both', { body: { text: `/welcome @${other.auth.result.you.user_id}`, mentions: [both.auth.result.you.user_id] } })).frame.result).toEqual({});
			await welcomedBy(both.peer);
			both.peer.close();
			other.peer.close();
			// A waiting account, in reply to its message.
			const waitingId = unique('waiter');
			const waiting = await signedIn(waitingId, { waiting: true });
			const said = await request(waiting.peer, 'said', 'message', { room_id: 'lobby', body: { text: 'let me in' } });
			const admitted = await welcome(admin, 'reply-waiting', { reply_to: { message_id: said.result.message_id }, body: { text: '/welcome' } });
			expect(admitted.frame.result).toEqual({});
			expect(admitted.skipped.find((frame) => frame.method === 'message')!.params.body.text).toContain(`@${waitingId} is now a member`);
			waiting.peer.close();
			// Nothing to go by, or a message the sender cannot find: the usage error, no violation.
			const usage = { code: -32602, message: 'Usage: /welcome <user_id>, or /welcome in reply to their message' };
			expect((await welcome(admin, 'bare', { body: { text: '/welcome' } })).frame.error).toMatchObject(usage);
			expect((await welcome(admin, 'gone', { reply_to: { message_id: '1' }, body: { text: '/welcome' } })).frame.error).toMatchObject(usage);
			expect((await welcome(admin, 'two', { body: { text: '/welcome', mentions: ['a_1', 'b_2'] } })).frame.error).toMatchObject(usage);
			expect(admin.closed()).toBeUndefined();
		} finally { admin.close(); }
	});

	it('/welcome of a guest marks it welcomed, and its passkey makes a member', async () => {
		await setAccess('lobby');
		const admin = await signedInAdmin();
		const watcher = await guest();
		const { peer, auth } = await guest();
		try {
			const guestId = auth.result.you.user_id;
			// Not for members without the role.
			const { peer: plain } = await signedIn(unique('plain'));
			try {
				denied((await command(plain, 'nope', `/welcome ${guestId}`)).frame);
			} finally { plain.close(); }
			expect((await command(admin, 'welcome', `/welcome ${guestId}`)).frame.result).toEqual({});
			const you = await until(peer, (frame) => frame.method === 'user' && frame.params.you !== undefined);
			expect(you.frame.params.you.roles).toEqual(['welcomed']);
			expect(you.frame.params.you.ext.permissions).toEqual({});
			const notice = await until(peer, (frame) => frame.method === 'message' && frame.params.from.user_id === '~private');
			expect(notice.frame.params.body.text).toBe('@admin welcomed you. Add a passkey to finish joining; until you do, closing this page ends your visit.');
			// Who shares the lobby sees the role.
			const seen = await until(watcher.peer, (frame) => frame.method === 'user' && frame.params.new?.user_id === guestId);
			expect(seen.frame.params.new.roles).toEqual(['welcomed']);
			const { finished } = await registerPasskey(peer, 'register');
			expect(finished.result.you.roles).toEqual([]);
			expect(finished.result.you.ext.permissions).not.toHaveProperty('lobby');
			const joined = await request(peer, 'joined', 'room_list', { filter: 'joined' });
			expect(joined.result.joined.map((room: { room_id: string }) => room.room_id).sort()).toEqual(['general', 'lobby']);
		} finally { peer.close(); watcher.peer.close(); admin.close(); }
	});

	it('/lobby by a mod shows, closes and opens the lobby, audited; /toggle has no lobby and stays admin-only', async () => {
		await setAccess('lobby');
		const admin = await signedInAdmin();
		const mod = await signedInMod(admin);
		const { peer: visitor } = await guest();
		const waitingId = unique('waiter');
		const { token } = await signedIn(waitingId, { waiting: true });
		const events: AdminAuditEvent[] = [];
		const setSink = (sink: AuditSink) => runInDurableObject(stub(), (instance) => { (instance as unknown as { audit: AuditSink }).audit = sink; });
		await setSink({ record: (event) => { events.push(event); } });
		try {
			denied((await command(mod.peer, 'activity', '/toggle activity')).frame);
			// No lobby in /toggle, for admins either.
			expect((await command(admin, 'toggle-lobby', '/toggle lobby')).frame.error).toMatchObject({ code: -32602, message: expect.stringMatching(/^Usage: \/toggle /) });
			const help = await command(mod.peer, 'help', '/help');
			expect(help.notice!.params.body.text).toContain('- `/lobby [open|close]`:');
			expect(help.notice!.params.body.text).not.toContain('/toggle');
			events.length = 0;
			const shown = await command(mod.peer, 'show', '/lobby');
			expect(shown.notice!.params.body.text).toMatch(/^The Public Lobby is \*\*open\*\*/);
			const closed = await command(mod.peer, 'close', '/lobby close');
			expect(closed.frame.result).toEqual({});
			expect(closed.notice!.params.body.text).toContain('closed');
			expect((await command(mod.peer, 'shown-closed', '/lobby')).notice!.params.body.text).toMatch(/^The Public Lobby is \*\*closed\*\*/);
			// Each run is audited as an admin command is.
			expect(events).toEqual([
				expect.objectContaining({ event: 'admin_action', actor: mod.userId, command: 'lobby', target: 'lobby', action: 'show', outcome: 'ok' }),
				expect.objectContaining({ event: 'admin_action', actor: mod.userId, command: 'lobby', target: 'lobby', action: 'close', outcome: 'ok' }),
				expect.objectContaining({ event: 'admin_action', actor: mod.userId, command: 'lobby', target: 'lobby', action: 'show', outcome: 'ok' }),
			]);
			// The guest is told, then closed; everyone else gets a new `server` frame.
			const told = await until(visitor, (frame) => frame.method === 'message' && frame.params.from.user_id === '~private');
			expect(told.frame.params.body.text).toBe('The Public Lobby is closed.');
			// Then the connection error with no id (§1.1), so the client does not reconnect.
			const error = await until(visitor, (frame) => frame.error !== undefined);
			expect(error.frame).toEqual({ error: { code: -32001, message: 'The Public Lobby is closed. Ask for an invite link.' } });
			await vi.waitFor(() => expect(visitor.closed()?.code).toBe(1008));
			// `close` again changes nothing.
			expect((await command(mod.peer, 'close-again', '/lobby close')).notice!.params.body.text).toBe('The Public Lobby is already **closed**.');
			// Before the result (§1).
			const modFrame = closed.skipped.find((frame) => frame.method === 'server');
			expect(modFrame!.params.ext.settings).not.toHaveProperty('lobby');
			// A new connection: no guest, the invite link alone, nothing from the rooms.
			const fresh = await connect();
			try {
				const server = await fresh.next();
				expect(server.params.auth).not.toContain('guest');
				expect(server.params.signup).toEqual(['token']);
				expect(server.params.ext).toBeUndefined();
				await fresh.next();
				expect((await request(fresh, 'guest', 'auth', { scheme: 'guest' })).error.code).toBe(-32601);
				denied((await registerPasskey(fresh, 'register')).finished);
			} finally { fresh.close(); }
			// A waiting account still signs in and sees the lobby.
			const waiting = await resume(token);
			try {
				expect(waiting.auth.result.you.roles).toEqual(['waiting']);
				expect((await request(waiting.peer, 'history', 'history', { room_id: 'lobby' })).result).toBeDefined();
			} finally { waiting.peer.close(); }
			expect((await command(mod.peer, 'open', '/lobby open')).notice!.params.body.text).toContain('now **open**');
			expect((await command(mod.peer, 'open-again', '/lobby open')).notice!.params.body.text).toBe('The Public Lobby is already **open**.');
			expect((await command(mod.peer, 'bad', '/lobby ajar')).frame.error).toMatchObject({ code: -32602, message: 'Usage: /lobby [open|close]' });
			// Refused to a member without the role, and audited as refused.
			const { peer: plain, auth } = await signedIn(unique('plain'));
			try {
				events.length = 0;
				denied((await command(plain, 'plain', '/lobby close')).frame);
				expect(events).toEqual([expect.objectContaining({ actor: auth.result.you.user_id, command: 'lobby', outcome: 'refused', reason: 'denied' })]);
			} finally { plain.close(); }
			const reopened = await guest();
			try {
				expect(reopened.server.params.auth).toContain('guest');
				expect(reopened.auth.result.you.user_id).toMatch(/^guest_/);
			} finally { reopened.peer.close(); }
		} finally { await setSink(noAuditSink); visitor.close(); mod.peer.close(); admin.close(); }
	});

	it('posts a waiting account under the guests\' limits, and wakes it only from the lobby', async () => {
		await withStore('lobby-limits', { guestPostsPerMinute: 2, registeredPostsPerMinute: 10, ipPostsPerMinute: 100 }, (store, clock) => {
			store.lifecycle.setAccess({ lobbyRoom: 'lobby', waitingRefused: false });
			store.rooms.ensureLobby('lobby', clock.value);
			const register = (userId: string, waiting: boolean) => store.accounts.register({
				userId, name: userId, userHandle: `h-${userId}`, now: clock.value, ipKey: `ip-${userId}`,
				credential: { credentialId: `c-${userId}`, userId, publicKey: 'AAAA', counter: 0 }, ...(waiting ? { waiting, rooms: ['lobby'] } : {}),
			});
			register('waiter', true);
			register('member', false);
			// A waiting account counts against the identity cap like any account.
			expect((sqliteOf(store) as unknown as { metaNumber(key: string): number }).metaNumber('identity_count')).toBe(2);
			const post = (userId: string, n: number, roomId = 'lobby') => store.messages.mutate({
				userId, tier: 'registered', ipKey: `ip-${userId}`, requestId: `${userId}-${n}`, method: 'message', now: clock.value,
				params: { room_id: roomId, body: { text: `post ${n}` } }, identity: { user_id: userId, name: userId, tier: 'registered' },
			});
			// It cannot post in general at all; the lobby is all it sees.
			expect(() => post('waiter', 0, 'general')).toThrow(/unknown room/);
			post('waiter', 1);
			post('waiter', 2);
			expect(() => post('waiter', 3)).toThrow(/Guest posting limit/);
			for (let n = 1; n <= 3; n += 1) post('member', n);
			// Another mode ignores the mark: a member's limits, and general.
			store.lifecycle.setAccess({ lobbyRoom: null, waitingRefused: false });
			post('waiter', 5, 'general');
			expect(store.accounts.get('waiter')?.waiting).toBe(true);
		});
		await withStore('lobby-push', { push: PUSH_POLICY ? { ...PUSH_POLICY } : null }, (store, clock) => {
			store.lifecycle.setAccess({ lobbyRoom: 'lobby', waitingRefused: false });
			store.rooms.ensureLobby('lobby', clock.value);
			store.accounts.register({
				userId: 'waiter', name: 'Waiter', userHandle: 'h-waiter', now: clock.value, ipKey: 'ip-waiter',
				credential: { credentialId: 'c-waiter', userId: 'waiter', publicKey: 'AAAA', counter: 0 }, waiting: true, rooms: ['lobby'],
			});
			store.push!.register({ userId: 'waiter', url: 'https://push.example.net/waiter', p256dh: 'p'.repeat(87), auth: 'a'.repeat(22), now: clock.value });
			const claim = (roomId: string) => store.push!.claim({ senderId: 'someone', roomId, candidates: [{ userId: 'waiter', reasons: WAKE_SCOPES.mentions }], now: clock.value }).subscriptions;
			// A mention elsewhere wakes nobody the lobby holds; one in the lobby does.
			expect(claim('general')).toHaveLength(0);
			expect(claim('lobby')).toHaveLength(1);
		});
	});
});

describe('private mode', () => {
	it('offers no guests, sends the minimal frame before sign-in, refuses sign-ups and waiting accounts, and lets members in', async () => {
		await setAccess('lobby');
		const waitingId = unique('waiter');
		const { peer: was, token: waitingToken } = await signedIn(waitingId, { waiting: true });
		was.close();
		const memberId = unique('member');
		const { peer: m, token: memberToken } = await signedIn(memberId);
		m.close();
		await setAccess('private');
		const peer = await connect();
		try {
			const server = await peer.next();
			expect(server.params.auth).toEqual(['webauthn', 'token']);
			expect(server.params.signup).toEqual(['token']);
			expect(server.params.ext).toBeUndefined();
			expect(server.params.capabilities).not.toContain('ext:emoji');
			expect(server.params.welcome).toMatch(/invite-only/);
			const welcome = await peer.next();
			expect(welcome.params.body.text).toMatch(/invite-only/);
			expect((await request(peer, 'guest', 'auth', { scheme: 'guest' })).error).toMatchObject({ code: -32601, message: expect.stringMatching(/invite-only/) });
			const register = await registerPasskey(peer, 'register');
			denied(register.finished);
			expect(register.finished.error.message).toMatch(/invite-only/);
		} finally { peer.close(); }
		// A waiting account cannot sign in; a member can, and gets a member's frame.
		const waiting = await resume(waitingToken);
		try {
			expect(waiting.auth.error).toMatchObject({ code: -32001, message: 'This server is invite-only; ask for an invite link' });
		} finally { waiting.peer.close(); }
		const member = await resume(memberToken);
		try {
			expect(member.auth.result.you.user_id).toBe(memberId);
			const frame = await until(member.peer, (candidate) => candidate.method === 'server');
			expect(frame.frame.params.ext.settings).toBeDefined();
			expect(frame.frame.params.ext.settings).not.toHaveProperty('lobby');
		} finally { member.peer.close(); }
	});
});

describe('private mode, more', () => {
	it('refuses a passkey ceremony begun while the lobby was open and finished after the switch', async () => {
		await setAccess('lobby');
		const peer = await connect();
		try {
			await peer.next();
			await peer.next();
			const passkey = await softPasskey(ORIGIN);
			const begun = await request(peer, 'begin', 'auth', { scheme: 'webauthn', action: 'register', step: 'begin' });
			expect(begun.result.challenge_id).toBeDefined();
			await setAccess('private');
			const credential = await passkey.register(begun.result.public_key);
			const finished = await request(peer, 'finish', 'auth', { scheme: 'webauthn', action: 'register', step: 'finish', challenge_id: begun.result.challenge_id, credential });
			expect(finished.error).toMatchObject({ code: -32001, message: 'This server is invite-only; ask for an invite link' });
		} finally { peer.close(); }
	});

	it('/welcome admits a waiting account left from the lobby, which then signs in as a member and sees the rooms', async () => {
		await setAccess('lobby');
		const waitingId = unique('waiter');
		const { peer: first, token } = await signedIn(waitingId, { waiting: true });
		const said = await request(first, 'said', 'message', { room_id: 'lobby', body: { text: 'still waiting' } });
		first.close();
		await setAccess('private');
		const admin = await signedInAdmin();
		const mod = await signedInMod(admin);
		try {
			const refused = await resume(token);
			expect(refused.auth.error).toMatchObject({ code: -32001, message: 'This server is invite-only; ask for an invite link' });
			refused.peer.close();
			// Same target rules: here, in reply to its message, which members see.
			const welcomed = await exchange(mod.peer, 'welcome', 'command', { room_id: 'lobby', reply_to: { message_id: said.result.message_id }, body: { text: '/welcome' } });
			expect(welcomed.frame.result).toEqual({});
			expect(welcomed.skipped.find((frame) => frame.method === 'message')!.params.body.text).toContain(`${waitingId} is now a member`);
			// No guests here to welcome; a member is one already.
			expect((await command(mod.peer, 'guest', '/welcome guest_1')).frame.error.code).toBe(-32602);
			expect((await command(mod.peer, 'again', `/welcome @${waitingId}`)).notice!.params.body.text).toContain('already a member');
			const back = await resume(token);
			try {
				expect(back.auth.result.you).toMatchObject({ user_id: waitingId, roles: [] });
				const listed = await request(back.peer, 'list', 'room_list', {});
				expect(listed.result.joined.map((room: { room_id: string }) => room.room_id)).toContain('general');
				expect((await request(back.peer, 'history', 'history', { room_id: 'general' })).result).toBeDefined();
			} finally { back.peer.close(); }
		} finally { mod.peer.close(); admin.close(); }
	});
});

describe('switching modes', () => {
	it('signs a waiting account in as a member in public mode, keeping its mark for the lobby', async () => {
		await setAccess('lobby');
		const waitingId = unique('waiter');
		const { peer: first, token } = await signedIn(waitingId, { waiting: true });
		first.close();
		await setAccess('public');
		const pub = await resume(token);
		try {
			expect(pub.auth.result.you.roles).toEqual([]);
			expect(pub.auth.result.you.ext.permissions).not.toHaveProperty('lobby');
			expect((await request(pub.peer, 'history', 'history', { room_id: 'general' })).result).toBeDefined();
			// The lobby stays as an ordinary public room, and the server says nothing of it.
			expect((await request(pub.peer, 'lobby-history', 'history', { room_id: 'lobby' })).result).toBeDefined();
		} finally { pub.peer.close(); }
		await setAccess('lobby');
		const back = await resume(token);
		try {
			expect(back.auth.result.you.roles).toEqual(['waiting']);
		} finally { back.peer.close(); }
	});
});

describe('restricted users keep no member powers', () => {
	it('a waiting account back in the lobby acts on no role from a public spell, and its bot stays out; a role given while public makes a member', async () => {
		await setAccess('lobby');
		const waiterId = unique('waiter');
		const { peer: w0, token } = await signedIn(waiterId, { waiting: true });
		w0.close();
		const promotedId = unique('promoted');
		const { peer: p0, token: promotedToken } = await signedIn(promotedId, { waiting: true });
		p0.close();
		await setAccess('public');
		const admin = await signedInAdmin();
		const pub = await resume(token);
		let botToken: string;
		try {
			// While public it is a member: it invites a bot.
			const minted = await command(pub.peer, 'bot', '/invite-bot');
			botToken = /```\n(apron_bot_[A-Za-z0-9_-]+)\n```/.exec(minted.notice!.params.body.text)![1];
			// A role given while public makes the account a member for good.
			expect((await command(admin, 'role-friend', `/role ${promotedId} friend`)).frame.result).toEqual({});
		} finally { pub.peer.close(); }
		// A role it holds from before (as an older build or an import could leave it).
		await runInDurableObject(stub(), (_instance, state) => {
			state.storage.sql.exec("UPDATE identities SET roles_json = '[\"mod\"]' WHERE user_id = ?", waiterId);
		});
		await setAccess('lobby');
		try {
			const back = await resume(token);
			try {
				expect(back.auth.result.you.roles).toEqual(['waiting']);
				denied((await command(back.peer, 'lobby', '/lobby close', 'lobby')).frame);
				denied((await command(back.peer, 'welcome', `/welcome @${waiterId}`, 'lobby')).frame);
				unknownRoom(await request(back.peer, 'history', 'history', { room_id: 'general' }));
			} finally { back.peer.close(); }
			const bot = await connect(null);
			try {
				await bot.next();
				await bot.next();
				expect((await request(bot, 'auth', 'auth', { scheme: 'token', token: botToken })).error).toMatchObject({ code: -32001, message: expect.stringMatching(/owner is waiting/) });
			} finally { bot.close(); }
			const promoted = await resume(promotedToken);
			try {
				expect(promoted.auth.result.you.roles).toEqual(['friend']);
				expect((await request(promoted.peer, 'history', 'history', { room_id: 'general' })).result).toBeDefined();
			} finally { promoted.peer.close(); }
			// The computed roles are never given.
			for (const role of ['waiting', 'welcomed']) expect((await command(admin, `role-${role}`, `/role ${promotedId} ${role}`)).frame.error.code).toBe(-32602);
		} finally { admin.close(); }
	});

	it('refuses moves and replies across the lobby\'s edge', async () => {
		await setAccess('lobby');
		const admin = await signedInAdmin();
		try {
			const inLobby = await request(admin, unique('lobby-post'), 'message', { room_id: 'lobby', body: { text: 'in the lobby' } });
			const inGeneral = await request(admin, unique('general-post'), 'message', { room_id: 'general', body: { text: 'members only' } });
			denied(await request(admin, unique('out'), 'message', { message_id: inLobby.result.message_id, room_id: 'general', body: { text: 'in the lobby' } }));
			denied(await request(admin, unique('in'), 'message', { message_id: inGeneral.result.message_id, room_id: 'lobby', body: { text: 'members only' } }));
			denied(await request(admin, unique('reply'), 'message', { room_id: 'lobby', reply_to: { message_id: inGeneral.result.message_id }, body: { text: 'see this' } }));
			// From elsewhere, a reply may name the lobby's message.
			expect((await request(admin, unique('reply-in'), 'message', { room_id: 'general', reply_to: { message_id: inLobby.result.message_id }, body: { text: 'about that intro' } })).result.message_id).toBeDefined();
		} finally { admin.close(); }
	});

	it('welcomes a waiting account already in general with general among its rooms', async () => {
		await setAccess('lobby');
		const admin = await signedInAdmin();
		const waiterId = unique('waiter');
		const token = await runInDurableObject(stub(), async (instance) => {
			const runtime = instance as unknown as Runtime;
			runtime.store.accounts.register({
				userId: waiterId, name: waiterId, userHandle: `handle-${waiterId}`, now: Date.now(), ipKey: `ip-${waiterId}`,
				credential: { credentialId: `cred-${waiterId}`, userId: waiterId, publicKey: 'AAAA', counter: 0 }, waiting: true, rooms: ['lobby', 'general'],
			});
			return runtime.issueSession(waiterId, ORIGIN, Date.now());
		});
		const { peer } = await resume(token);
		try {
			expect((await command(admin, unique('welcome'), `/welcome ${waiterId}`)).frame.result).toEqual({});
			await until(peer, (frame) => frame.method === 'room_update' && frame.params.joined?.[0]?.room_id === 'general');
			await request(admin, unique('hello'), 'message', { room_id: 'general', body: { text: 'hello members' } });
			const delivered = await until(peer, (frame) => frame.method === 'message' && frame.params.body?.text === 'hello members');
			expect(delivered.frame.params.room_id).toBe('general');
		} finally { peer.close(); admin.close(); }
	});

	it('keeps every lobby room it had outside the caps, up to four', async () => {
		await withStore('lobby-rooms', {}, (store) => {
			store.lifecycle.setAccess({ lobbyRoom: 'lobby', waitingRefused: false });
			store.rooms.ensureLobby('lobby');
			store.lifecycle.setAccess({ lobbyRoom: 'front', waitingRefused: false });
			store.rooms.ensureLobby('front');
			const counts = { createdTopLevelRooms: () => (sqliteOf(store) as unknown as { createdTopLevelRooms(): number }).createdTopLevelRooms(), recentRoomCount: (_kind: string, now: number) => store.rooms.counts(now).public.recent };
			expect(counts.createdTopLevelRooms()).toBe(0);
			expect(counts.recentRoomCount('public', Date.now() + 10_000)).toBe(0);
			store.rooms.ensureLobby('third');
			store.rooms.ensureLobby('fourth');
			expect(() => store.rooms.ensureLobby('fifth')).toThrow(/4 lobby rooms/);
			expect(counts.createdTopLevelRooms()).toBe(0);
		});
	});
});

describe('ext:command_list', () => {
	type Listed = { name: string; group?: string; hint?: string; uses?: string[] };
	const list = async (peer: Peer) => (await request(peer, unique('list'), 'ext:command_list', {})).result.commands as Listed[];
	const lobbyForms = (listed: Listed[]) => listed.filter((form) => form.name === 'lobby' || form.name === 'welcome');

	it('lists /welcome and /lobby exactly to those who may run them, in each mode', async () => {
		await setAccess('lobby');
		const admin = await signedInAdmin();
		const mod = await signedInMod(admin);
		const { peer: member } = await signedIn(unique('member'));
		const waiterId = unique('waiter');
		const { peer: waiter, token } = await signedIn(waiterId, { waiting: true });
		const visitor = await guest();
		try {
			expect(lobbyForms(await list(mod.peer))).toEqual([
				{ name: 'lobby', group: 'role', description: expect.any(String), hint: '[open|close]' },
				{ name: 'welcome', group: 'role', description: expect.any(String), hint: '@user', uses: ['reply_to', 'body.mentions'] },
			]);
			expect(lobbyForms(await list(admin)).map((form) => form.name)).toEqual(['lobby', 'welcome']);
			expect(lobbyForms(await list(member))).toEqual([]);
			expect(lobbyForms(await list(visitor.peer))).toEqual([]);
			// A waiting account lists neither, even holding a role from before; nor /invite-bot.
			waiter.close();
			await runInDurableObject(stub(), (_instance, state) => {
				state.storage.sql.exec("UPDATE identities SET roles_json = '[\"mod\"]' WHERE user_id = ?", waiterId);
			});
			const back = await resume(token);
			try {
				const listed = await list(back.peer);
				expect(lobbyForms(listed)).toEqual([]);
				expect(listed.map((form) => form.name)).not.toContain('invite-bot');
				expect(listed.map((form) => form.name)).toContain('passkeys');
			} finally { back.peer.close(); }
			// Private: /welcome only (for waiting accounts left from a lobby).
			await setAccess('private');
			expect(lobbyForms(await list(mod.peer)).map((form) => form.name)).toEqual(['welcome']);
			// Public: neither.
			await setAccess('public');
			expect(lobbyForms(await list(mod.peer))).toEqual([]);
			expect(lobbyForms(await list(admin))).toEqual([]);
		} finally { visitor.peer.close(); member.close(); mod.peer.close(); admin.close(); }
	});
});

describe('private mode, waiting accounts', () => {
	it('wakes no waiting account by push, and leaves no session when its sign-in is refused', async () => {
		await withStore('private-push', { push: PUSH_POLICY ? { ...PUSH_POLICY } : null }, (store, clock) => {
			store.accounts.register({
				userId: 'waiter', name: 'Waiter', userHandle: 'h-waiter', now: clock.value, ipKey: 'ip-waiter',
				credential: { credentialId: 'c-waiter', userId: 'waiter', publicKey: 'AAAA', counter: 0 }, waiting: true,
			});
			store.push!.register({ userId: 'waiter', url: 'https://push.example.net/waiter', p256dh: 'p'.repeat(87), auth: 'a'.repeat(22), now: clock.value });
			const claim = () => store.push!.claim({ senderId: 'someone', roomId: 'general', candidates: [{ userId: 'waiter', reasons: WAKE_SCOPES.mentions }], now: clock.value }).subscriptions;
			store.lifecycle.setAccess({ lobbyRoom: null, waitingRefused: true });
			expect(claim()).toHaveLength(0);
		});
		// A waiting account with a real passkey, made as a guest in the lobby.
		await setAccess('lobby');
		const { peer } = await guest();
		const { passkey, finished } = await registerPasskey(peer, 'register');
		expect(finished.result.you.roles).toEqual(['waiting']);
		peer.close();
		await setAccess('private');
		const sessions = () => runInDurableObject(stub(), async (_instance, state) => (await state.storage.list({ prefix: 'session:' })).size);
		const before = await sessions();
		const login = await connect();
		try {
			await login.next();
			await login.next();
			const begun = await request(login, 'login-begin', 'auth', { scheme: 'webauthn', action: 'login', step: 'begin' });
			const credential = await passkey.assert(begun.result.public_key, 2);
			const refused = await request(login, 'login-finish', 'auth', { scheme: 'webauthn', action: 'login', step: 'finish', challenge_id: begun.result.challenge_id, credential });
			expect(refused.error).toMatchObject({ code: -32001, message: 'This server is invite-only; ask for an invite link' });
		} finally { login.close(); }
		expect(await sessions()).toBe(before);
	});
});

describe('schema', () => {
	it('keeps schema 11: the waiting tier needs no new version, so rolling back resets nothing', async () => {
		expect(SCHEMA_VERSION).toBe(11);
		await withStore('schema11', {}, (store, clock, state) => {
			store.lifecycle.setAccess({ lobbyRoom: 'lobby', waitingRefused: false });
			store.accounts.register({
				userId: 'kept', name: 'Kept', userHandle: 'h-kept', now: clock.value, ipKey: 'ip-kept',
				credential: { credentialId: 'c-kept', userId: 'kept', publicKey: 'AAAA', counter: 0 }, waiting: true,
			});
			// A wake of the same build changes nothing and resets nothing.
			const again = openStore(state, {}, clock.clock);
			expect(again.lifecycle.requiresReset()).toBe(false);
			again.lifecycle.initialize();
			expect(state.storage.sql.exec<{ tier: string }>("SELECT tier FROM identities WHERE user_id = 'kept'").one().tier).toBe('waiting');
			expect(again.accounts.get('kept')?.waiting).toBe(true);
		});
	});
});
