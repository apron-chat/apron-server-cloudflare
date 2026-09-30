import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/budget';
import { connect as open, exchange, request, until, type Frame, type Peer } from './helpers/socket';

let nextIp = 1;
const stub = () => env.DEMO.getByName('public-demo-v1');
const ADMIN_TOKEN = 'admin-token-0123456789abcdef';
const connect = (origin: string | null = 'http://localhost:5173') => open({ ip: `198.51.100.${nextIp++}`, origin });
const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

async function setAdminToken(value: string | undefined): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as { config: { adminToken?: string } };
		server.config = { ...server.config, adminToken: value };
	});
}

beforeEach(() => setAdminToken(ADMIN_TOKEN));
afterEach(() => setAdminToken(undefined));

/** Registers a passkey user straight into the store and signs a connection in with a session token. */
async function signedIn(userId: string): Promise<Peer> {
	const token = await runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as {
			store: { registerIdentity(input: Record<string, unknown>): unknown };
			issueSession(userId: string, origin: string, now: number): Promise<string>;
		};
		runtime.store.registerIdentity({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
		return runtime.issueSession(userId, 'http://localhost:5173', Date.now());
	});
	const peer = await connect();
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
	return peer;
}

async function signedInAdmin(): Promise<Peer> {
	const peer = await connect(null);
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token: ADMIN_TOKEN })).result.you.user_id).toBe('admin');
	return peer;
}

/** Runs a command in a room; its reply and the `~private` notice before it, if any. */
async function command(peer: Peer, id: string, text: string, roomId = 'general'): Promise<{ frame: Frame; notice?: Frame; skipped: Frame[] }> {
	const { frame, skipped } = await exchange(peer, id, 'command', { room_id: roomId, body: { text } });
	const notice = skipped.find((candidate) => candidate.method === 'message' && candidate.params.from.user_id === '~private');
	return { frame, notice, skipped };
}

it('lists and runs the admin commands for admins only', async () => {
	const admin = await signedInAdmin();
	const aliceId = unique('alice');
	const alice = await signedIn(aliceId);
	try {
		const help = await command(admin, 'help', '/help');
		expect(help.frame.result).toEqual({});
		expect(help.notice!.params.body.text).toContain('/admin <user_id>');
		expect(help.notice!.params.body.text).toContain('/kick <user_id>');
		expect(help.notice!.params.body.text).toContain('/status');
		expect(help.notice!.params.body.text).toContain('/rename <old_user_id> <new_user_id>');

		const plain = await command(alice, 'help', '/help');
		expect(plain.notice!.params.body.text).toContain('/invite-bot');
		expect(plain.notice!.params.body.text).not.toContain('/kick');
		for (const text of ['/status', '/kick admin', `/admin ${aliceId}`]) {
			const denied = await command(alice, `denied-${text}`, text);
			expect(denied.frame.error.code).toBe(-32001);
			expect(denied.frame.error.message).toMatch(/Only an admin/);
		}
	} finally { admin.close(); alice.close(); }
});

it('/admin makes a registered user an admin, but not a guest, bot, or unknown user', async () => {
	const admin = await signedInAdmin();
	const userId = unique('carol');
	const carol = await signedIn(userId);
	const guest = await connect();
	try {
		await guest.next();
		const guestId = (await request(guest, 'auth', 'auth', { scheme: 'guest' })).result.you.user_id;

		expect((await command(carol, 'before', '/status')).frame.error.code).toBe(-32001);
		const granted = await command(admin, 'grant', `/admin ${userId}`);
		expect(granted.frame.result).toEqual({});
		expect(granted.notice!.params.body.text).toBe(`**Name of ${userId}** (\`${userId}\`) is now an admin.`);
		expect((await command(admin, 'again', `/admin ${userId}`)).notice!.params.body.text).toMatch(/is already an admin/);
		// The new admin can run the admin commands, /admin included.
		expect((await command(carol, 'after', '/status')).frame.result).toEqual({});

		for (const target of [guestId, 'bot_nobody', 'nobody_123']) {
			expect((await command(admin, `bad-${target}`, `/admin ${target}`)).frame.error.code).toBe(-32602);
		}
		expect((await command(admin, 'usage', '/admin')).frame.error.message).toBe('Usage: /admin <user_id>');
	} finally { admin.close(); carol.close(); guest.close(); }
});

it('/kick removes a registered user or a guest from the room of the command', async () => {
	const admin = await signedInAdmin();
	const bobId = unique('bob');
	const bob = await signedIn(bobId);
	const guest = await connect();
	try {
		await guest.next();
		const guestId = (await request(guest, 'auth', 'auth', { scheme: 'guest' })).result.you.user_id;

		const kicked = await command(admin, 'kick-bob', `/kick ${bobId}`);
		expect(kicked.frame.result).toEqual({});
		expect(kicked.notice!.params.body.text).toBe(`Removed \`${bobId}\` from this room.`);
		const left = await until(bob, (frame) => frame.method === 'room_update' && frame.params.left !== undefined);
		expect(left.frame.params.left).toEqual([{ room_id: 'general' }]);
		// The leave is stored: bob's joined rooms no longer include general.
		const rooms = await request(bob, 'rooms', 'room_list', { filter: 'joined' });
		expect(rooms.result.joined.map((room: { room_id: string }) => room.room_id)).not.toContain('general');
		// Kicking again finds nobody to remove; bob may join again.
		expect((await command(admin, 'kick-bob-again', `/kick ${bobId}`)).frame.error.code).toBe(-32602);
		expect((await request(bob, 'rejoin', 'room_join', { room_id: 'general' })).result).toEqual({});

		expect((await command(admin, 'kick-guest', `/kick ${guestId}`)).frame.result).toEqual({});
		const guestLeft = await until(guest, (frame) => frame.method === 'room_update' && frame.params.left !== undefined);
		expect(guestLeft.frame.params.left).toEqual([{ room_id: 'general' }]);

		expect((await command(admin, 'kick-self', '/kick admin')).frame.error.code).toBe(-32602);
		expect((await command(admin, 'kick-nobody', '/kick nobody_123')).frame.error.code).toBe(-32602);
		// Mistakes are shown, not counted as policy violations: the socket stays open.
		expect((await command(admin, 'kick-usage', '/kick')).frame.error.message).toBe('Usage: /kick <user_id>');
		expect(admin.closed()).toBeUndefined();
	} finally { admin.close(); bob.close(); guest.close(); }
});

it('/status sends the caller the Cloudflare usage and the demo budgets', async () => {
	const admin = await signedInAdmin();
	try {
		const status = await command(admin, 'status', '/status');
		expect(status.frame.result).toEqual({});
		const text: string = status.notice!.params.body.text;
		expect(status.notice!.params.body.format).toBe('markdown');
		// Tests configure no account analytics, so only the object's budgets show.
		expect(text).toContain('no usage sample');
		expect(text).toMatch(new RegExp(`\\| SQL rows written \\| [\\d,]+ / ${DEFAULT_LIMITS.sqlWritesPerDay.toLocaleString('en-US')} \\(\\d+%\\) \\|`));
		expect(text).toMatch(/\| Registered users \| [\d,]+ \/ 10,000/);
		expect(text).toContain('| Database |');
	} finally { admin.close(); }
});

it('/rename moves a registered user, their passkey, rooms and admin status to a new user_id', async () => {
	const admin = await signedInAdmin();
	const fromId = unique('dave');
	const toId = unique('david');
	const dave = await signedIn(fromId);
	const erin = await signedIn(unique('erin'));
	try {
		expect((await command(admin, 'grant', `/admin ${fromId}`)).frame.result).toEqual({});
		// A role change is a profile change (§3.3): the new admin and a room-mate hear of it.
		const granted = await until(dave, (frame) => frame.method === 'user');
		expect(granted.frame.params).toEqual({ you: { user_id: fromId, name: `Name of ${fromId}`, roles: ['admin'] } });
		const seen = await until(erin, (frame) => frame.method === 'user' && frame.params.new?.user_id === fromId);
		expect(seen.frame.params).toEqual({ new: { user_id: fromId, name: `Name of ${fromId}`, roles: ['admin'] } });
		const renamed = await command(admin, 'rename', `/rename ${fromId} ${toId}`);
		expect(renamed.frame.result).toEqual({});
		expect(renamed.notice!.params.body.text).toBe(`Renamed \`${fromId}\` to \`${toId}\`.`);
		// The user's connection becomes the new identity; a room-mate learns of the change (§3.3).
		const you = await until(dave, (frame) => frame.method === 'user');
		expect(you.frame.params).toEqual({ you: { user_id: toId, name: `Name of ${fromId}`, roles: ['admin'] } });
		const change = await until(erin, (frame) => frame.method === 'user' && frame.params.old?.user_id === fromId);
		expect(change.frame.params).toEqual({ new: { user_id: toId, name: `Name of ${fromId}`, roles: ['admin'] }, old: { user_id: fromId, name: `Name of ${fromId}` } });
		const posted = await exchange(dave, 'post', 'message', { room_id: 'general', body: { text: 'renamed' } });
		expect(posted.frame.result.message_id).toBeDefined();
		// Still an admin under the new id.
		expect((await command(dave, 'status', '/status')).frame.result).toEqual({});

		await runInDurableObject(stub(), (instance) => {
			const { store } = instance as unknown as { store: {
				getIdentity(id: string): { rooms: string[] } | null; getCredential(id: string): { userId: string } | null;
				identityExists(id: string): boolean; userIdTaken(id: string): boolean;
			} };
			expect(store.getIdentity(toId)?.rooms).toContain('general');
			expect(store.getCredential(`cred-${fromId}`)?.userId).toBe(toId);
			expect(store.identityExists(fromId)).toBe(false);
			// The old user_id is retired, never reissued.
			expect(store.userIdTaken(fromId)).toBe(true);
		});

		for (const [id, text] of [
			['taken', `/rename ${toId} ${fromId}`],
			['guest', `/rename ${toId} guest_77`],
			['bot', `/rename ${toId} bot_x`],
			['bad-chars', `/rename ${toId} no@pe`],
			['admin', `/rename admin somebody_else`],
			['unknown', `/rename nobody_123 somebody_else`],
		]) {
			expect((await command(admin, `rename-${id}`, text)).frame.error.code).toBe(-32602);
		}
		expect((await command(admin, 'rename-usage', `/rename ${toId}`)).frame.error.message).toBe('Usage: /rename <old_user_id> <new_user_id>');
		expect(admin.closed()).toBeUndefined();
	} finally { admin.close(); dave.close(); erin.close(); }
});

it('/invite-token creates a user who signs in with the token, which /rename moves and /purge revokes', async () => {
	const admin = await signedInAdmin();
	const userId = unique('invited');
	const signIn = async (token: string) => {
		const peer = await connect(null);
		await peer.next();
		return { peer, reply: await request(peer, 'auth', 'auth', { scheme: 'token', token }) };
	};
	try {
		const invited = await command(admin, 'invite', `/invite-token @${userId}`);
		expect(invited.frame.result).toEqual({});
		const text: string = invited.notice!.params.body.text;
		expect(text).toContain(`Created \`${userId}\``);
		const token = text.match(/```\n(apron_invite_[A-Za-z0-9_-]{43})\n```/)![1];

		// The token signs in from any origin, as a registered user in general.
		const first = await signIn(token);
		expect(first.reply.result.you).toEqual({ user_id: userId, name: userId });
		expect((await request(first.peer, 'rename-self', 'me', { name: 'Newcomer' })).result.you.name).toBe('Newcomer');
		first.peer.close();

		// A taken user_id, a guest's or bot's, and a non-admin are refused.
		expect((await command(admin, 'again', `/invite-token ${userId}`)).frame.error.message).toBe(`The user_id ${userId} is taken`);
		expect((await command(admin, 'guest', '/invite-token guest_9')).frame.error.code).toBe(-32602);
		expect((await command(admin, 'self', '/invite-token admin')).frame.error.code).toBe(-32602);
		expect((await command(admin, 'usage', '/invite-token')).frame.error.message).toBe('Usage: /invite-token <user_id>');
		const other = await signedIn(unique('plain'));
		expect((await command(other, 'denied', `/invite-token ${unique('x')}`)).frame.error.code).toBe(-32001);
		other.close();

		// /rename moves the token to the new user_id.
		const renamedId = unique('renamed');
		await command(admin, 'rename', `/rename ${userId} ${renamedId}`);
		const second = await signIn(token);
		expect(second.reply.result.you.user_id).toBe(renamedId);
		second.peer.close();

		// /purge revokes it.
		await command(admin, 'purge', `/purge ${renamedId}`);
		const third = await signIn(token);
		expect(third.reply.error.message).toBe('This invite token is not valid; ask an admin for a new one');
		third.peer.close();
	} finally { admin.close(); }
});

/** Registers a passkey user straight into the store without connecting them. */
async function registered(userId: string): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		(instance as unknown as { store: { registerIdentity(input: Record<string, unknown>): unknown } }).store.registerIdentity({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
	});
}

async function setRoomListMembers(value: number): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as { config: { limits: Record<string, number> } };
		server.config = { ...server.config, limits: { ...server.config.limits, roomListMembers: value } };
	});
}

it('room_join and room_leave with a user_id add and remove others: an admin anyone, an owner their bot', async () => {
	const admin = await signedInAdmin();
	const bobId = unique('bob');
	const bob = await signedIn(bobId);
	const carolId = unique('carol');
	await registered(carolId);
	const guest = await connect();
	try {
		await guest.next();
		const guestId = (await request(guest, 'auth', 'auth', { scheme: 'guest' })).result.you.user_id;
		const roomId = (await request(admin, unique('thread'), 'room_set', { parent_room_id: 'general', title: 'Invites' })).result.room_id;

		// The admin adds Bob: a logged join for the room's members, then Bob's connections get `joined`.
		const added = await exchange(admin, 'add-bob', 'room_join', { room_id: roomId, user_id: bobId });
		expect(added.frame.result).toEqual({});
		expect(added.skipped.find((frame) => frame.method === 'membership')?.params.members).toEqual([{ user: { user_id: bobId, name: `Name of ${bobId}` }, joined: true }]);
		const joined = await until(bob, (frame) => frame.method === 'room_update' && frame.params.joined !== undefined);
		expect(joined.skipped.find((frame) => frame.method === 'membership')?.params.room_id).toBe(roomId);
		expect(joined.frame.params.joined[0]).toMatchObject({ room_id: roomId, title: 'Invites' });
		expect(joined.frame.params.joined[0].members.map((member: { user_id: string }) => member.user_id)).toEqual(['admin', bobId].sort());
		// `users` are current objects: the admin's carry its role (§3.3).
		expect(joined.frame.params.users).toContainEqual({ user_id: 'admin', name: 'Admin', roles: ['admin'] });
		expect(joined.frame.params.users).toContainEqual({ user_id: bobId, name: `Name of ${bobId}` });
		// Adding a member again changes nothing.
		expect((await exchange(admin, 'add-bob-again', 'room_join', { room_id: roomId, user_id: bobId })).skipped.some((frame) => frame.method === 'membership')).toBe(false);

		// Bob may not add others, but may add his own bot.
		const denied = await request(bob, 'add-carol', 'room_join', { room_id: roomId, user_id: carolId });
		expect(denied.error.code).toBe(-32001);
		expect((await exchange(bob, 'bot', 'command', { room_id: 'general', body: { text: '/invite-bot' } })).frame.result).toEqual({});
		expect((await request(bob, 'add-bot', 'room_join', { room_id: roomId, user_id: `bot_${bobId}` })).result).toEqual({});

		// Only registered users can be added, by a string user_id. (Each
		// invalid_params counts toward the socket's policy violations.)
		expect((await request(admin, 'add-guest', 'room_join', { room_id: roomId, user_id: guestId })).error.code).toBe(-32602);
		expect((await request(bob, 'add-typed', 'room_join', { room_id: roomId, user_id: 7 })).error.code).toBe(-32602);

		// Bob may remove his bot but nobody else; the admin removes Bob.
		expect((await request(bob, 'remove-bot', 'room_leave', { room_id: roomId, user_id: `bot_${bobId}` })).result).toEqual({});
		expect((await request(bob, 'remove-admin', 'room_leave', { room_id: roomId, user_id: 'admin' })).error.code).toBe(-32001);
		const removed = await exchange(admin, 'remove-bob', 'room_leave', { room_id: roomId, user_id: bobId });
		expect(removed.frame.result).toEqual({});
		expect(removed.skipped.filter((frame) => frame.method === 'membership').at(-1)?.params.members).toEqual([{ user: { user_id: bobId, name: `Name of ${bobId}` }, joined: false }]);
		const left = await until(bob, (frame) => frame.method === 'room_update' && frame.params.left !== undefined);
		expect(left.frame.params.left).toEqual([{ room_id: roomId }]);
		// Removing someone not in the room changes nothing; an unknown user is invalid.
		expect((await request(admin, 'remove-bob-again', 'room_leave', { room_id: roomId, user_id: bobId })).result).toEqual({});
		expect((await request(admin, 'remove-nobody', 'room_leave', { room_id: roomId, user_id: 'nobody_123' })).error.code).toBe(-32602);
		// A connected guest can be removed, as with /kick.
		expect((await request(admin, 'remove-guest', 'room_leave', { room_id: 'general', user_id: guestId })).result).toEqual({});
		expect((await until(guest, (frame) => frame.method === 'room_update' && frame.params.left !== undefined)).frame.params.left).toEqual([{ room_id: 'general' }]);
		expect(admin.closed()).toBeUndefined();
	} finally { admin.close(); bob.close(); guest.close(); }
});

it('gives member_count where members leaves registered members out, and keeps the stored count current', async () => {
	const admin = await signedInAdmin();
	const [carolId, danId] = [unique('carol'), unique('dan')];
	await registered(carolId);
	await registered(danId);
	try {
		const roomId = (await request(admin, unique('thread'), 'room_set', { parent_room_id: 'general', title: 'Counted' })).result.room_id;
		for (const userId of [carolId, danId]) expect((await request(admin, `add-${userId}`, 'room_join', { room_id: roomId, user_id: userId })).result).toEqual({});
		// Everyone fits: no member_count.
		const full = (await request(admin, 'list-full', 'room_list', { room_id: roomId, members: true })).result.joined[0];
		expect(full.members).toHaveLength(3);
		expect(full).not.toHaveProperty('member_count');

		// Listing one registered member per room leaves the unconnected ones out.
		await setRoomListMembers(1);
		const truncated = (await request(admin, 'list-truncated', 'room_list', { room_id: roomId, members: true })).result.joined[0];
		expect(truncated.members.length).toBeLessThan(3);
		expect(truncated.members).toContainEqual({ user_id: 'admin' });
		expect(truncated.member_count).toBe(3);
		const rejoined = await exchange(admin, 'rejoin', 'room_join', { room_id: roomId });
		expect(rejoined.skipped.find((frame) => frame.method === 'room_update')?.params.joined[0].member_count).toBe(3);

		// Leaves and purges keep the stored count equal to the stored memberships.
		expect((await request(admin, 'remove-dan', 'room_leave', { room_id: roomId, user_id: danId })).result).toEqual({});
		expect((await exchange(admin, 'purge-carol', 'command', { room_id: 'general', body: { text: `/purge ${carolId}` } })).frame.result).toEqual({});
		await runInDurableObject(stub(), (_instance, state) => {
			const rows = state.storage.sql.exec<{ room_id: string; member_count: number; stored: number }>(
				'SELECT room_id, member_count, (SELECT COUNT(*) FROM memberships m WHERE m.room_id = rooms.room_id) AS stored FROM rooms',
			).toArray();
			for (const row of rows) expect(row.member_count, row.room_id).toBe(row.stored);
			expect(rows.find((row) => row.room_id === roomId)?.member_count).toBe(1);
		});
	} finally { await setRoomListMembers(DEFAULT_LIMITS.roomListMembers); admin.close(); }
});

it('never gives out a ~ user_id, which protocol v7 reserves for system identities', async () => {
	const admin = await signedInAdmin();
	const guest = await connect();
	try {
		await guest.next();
		expect((await request(guest, 'auth', 'auth', { scheme: 'guest', user_id: '~server', name: '~server' })).result.you.user_id).toMatch(/^guest_\d+$/);
		for (const text of ['/invite-token ~server', '/invite-token @~room']) {
			expect((await command(admin, text, text)).frame.error.code).toBe(-32602);
		}
		// `roles` are the server's to assign: `me` ignores them.
		expect((await request(admin, 'me', 'me', { roles: ['moderator'] })).result.you).toEqual({ user_id: 'admin', name: 'Admin', roles: ['admin'] });
	} finally { admin.close(); guest.close(); }
});
