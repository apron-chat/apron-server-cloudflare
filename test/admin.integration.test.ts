import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/budget';
import { connect as open, exchange, request, until, type Frame, type Peer } from './helpers/socket';
import { softPasskey } from './helpers/webauthn';

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
		expect(help.notice!.params.body.text).toContain('/admin [remove] <user_id>');
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
		expect((await command(admin, 'again', `/admin @${userId}`)).notice!.params.body.text).toMatch(/is already an admin/);
		// The new admin can run the admin commands, /admin included.
		expect((await command(carol, 'after', '/status')).frame.result).toEqual({});

		for (const target of [guestId, 'bot_nobody', 'nobody_123']) {
			expect((await command(admin, `bad-${target}`, `/admin ${target}`)).frame.error.code).toBe(-32602);
		}
		expect((await command(admin, 'usage', '/admin')).frame.error.message).toBe('Usage: /admin [remove] <user_id>');
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

		const kicked = await command(admin, 'kick-bob', `/kick @${bobId}`);
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
		const granted = await until(dave, (frame) => frame.method === 'user' && frame.params.you !== undefined);
		expect(granted.frame.params).toEqual({ you: { user_id: fromId, name: `Name of ${fromId}`, roles: ['admin'], status: 'online' } });
		const seen = await until(erin, (frame) => frame.method === 'user' && frame.params.new?.user_id === fromId && frame.params.new.roles !== undefined);
		expect(seen.frame.params).toEqual({ new: { user_id: fromId, name: `Name of ${fromId}`, roles: ['admin'] } });
		const before = await exchange(dave, 'before', 'message', { room_id: 'general', body: { text: 'before the rename' } });
		const earlier: string = before.frame.result.message_id;
		// Either user_id may be written `@user_id`, as a mention is sent.
		const renamed = await command(admin, 'rename', `/rename @${fromId} @${toId}`);
		expect(renamed.frame.result).toEqual({});
		expect(renamed.notice!.params.body.text).toBe(`Renamed \`${fromId}\` to \`${toId}\`.`);
		// The user's connection becomes the new identity; a room-mate learns of the change (§3.3).
		const you = await until(dave, (frame) => frame.method === 'user' && frame.params.you !== undefined);
		expect(you.frame.params).toEqual({ you: { user_id: toId, name: `Name of ${fromId}`, roles: ['admin'], status: 'online' } });
		const change = await until(erin, (frame) => frame.method === 'user' && frame.params.old?.user_id === fromId);
		// The new user_id carries the status others were shown under the old one (§4.5).
		expect(change.frame.params).toEqual({ new: { user_id: toId, name: `Name of ${fromId}`, roles: ['admin'], status: 'online' }, old: { user_id: fromId, name: `Name of ${fromId}` } });
		const posted = await exchange(dave, 'post', 'message', { room_id: 'general', body: { text: 'renamed' } });
		expect(posted.frame.result.message_id).toBeDefined();
		// The earlier message was rewritten to the new id, so it is still theirs to edit.
		expect((await exchange(dave, 'edit', 'message', { room_id: 'general', message_id: earlier, body: { text: 'edited after the rename' } })).frame.result.message_id).toBe(earlier);
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
		await runInDurableObject(stub(), (_instance, state) => {
			const froms = state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM records WHERE kind = 'message' AND json_extract(record_json, '$.message_id') = ?", earlier)
				.toArray().map((row) => JSON.parse(row.record_json).from.user_id);
			expect(froms.length).toBeGreaterThan(1);
			expect(new Set(froms)).toEqual(new Set([toId]));
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
		expect(first.reply.result.you).toEqual({ user_id: userId, name: userId, roles: [], status: 'online' });
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

		// The admin adds Bob: the room's other members get the logged join in `room_update`
		// `membership`, and Bob's connections get it with `joined` in one frame (§4.3.2).
		const added = await exchange(admin, 'add-bob', 'room_join', { room_id: roomId, user_id: bobId });
		expect(added.frame.result).toEqual({});
		const bobJoin = [{ user: { user_id: bobId, name: `Name of ${bobId}` }, joined: true }];
		const others = added.skipped.filter((frame) => frame.method === 'room_update' && frame.params.memberships);
		expect(others.map((frame) => Object.keys(frame.params))).toEqual([['memberships']]);
		expect(others[0].params.memberships[0].members).toEqual(bobJoin);
		const joined = await until(bob, (frame) => frame.method === 'room_update' && frame.params.joined !== undefined);
		expect(Object.keys(joined.frame.params)).toEqual(['joined', 'memberships', 'users']);
		expect(joined.frame.params.memberships[0]).toMatchObject({ room_id: roomId, members: bobJoin });
		expect(joined.frame.params.joined[0].latest_log_id).toBe(joined.frame.params.memberships[0].log_id);
		expect(joined.frame.params.joined[0]).toMatchObject({ room_id: roomId, title: 'Invites' });
		expect(joined.frame.params.joined[0].members.map((member: { user_id: string }) => member.user_id)).toEqual(['admin', bobId].sort());
		// `users` are current objects: the admin's carry its role (§3.3), and each
		// their status (§4.5). The admin signed in earlier in this file, so what
		// others were last told of them may still be waiting out a minute.
		expect(joined.frame.params.users).toContainEqual({ user_id: 'admin', name: 'Admin', roles: ['admin'], status: expect.stringMatching(/^(online|offline)$/) });
		expect(joined.frame.params.users).toContainEqual({ user_id: bobId, name: `Name of ${bobId}`, roles: [], status: 'online' });
		// Adding a member again changes nothing.
		expect((await exchange(admin, 'add-bob-again', 'room_join', { room_id: roomId, user_id: bobId })).skipped.some((frame) => frame.params?.memberships)).toBe(false);

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
		expect(removed.skipped.filter((frame) => frame.params?.memberships).at(-1)?.params.memberships[0].members).toEqual([{ user: { user_id: bobId, name: `Name of ${bobId}` }, joined: false }]);
		// The removed user's connections get `left` with the membership (§4.3.2, §4.1 /kick).
		const left = await until(bob, (frame) => frame.method === 'room_update' && frame.params.left !== undefined);
		expect(left.frame.params.left).toEqual([{ room_id: roomId }]);
		expect(left.frame.params.memberships[0].members).toEqual([{ user: { user_id: bobId, name: `Name of ${bobId}` }, joined: false }]);
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
		expect((await request(admin, 'me', 'me', { roles: ['moderator'] })).result.you).toEqual({ user_id: 'admin', name: 'Admin', roles: ['admin'], status: 'online' });
	} finally { admin.close(); guest.close(); }
});

it('sends a ~private notice to the one connection that asked, not the user\'s other connections', async () => {
	const userId = unique('twin');
	const first = await signedIn(userId);
	const token = await runInDurableObject(stub(), (instance) =>
		(instance as unknown as { issueSession(userId: string, origin: string, now: number): Promise<string> }).issueSession(userId, 'http://localhost:5173', Date.now()));
	const second = await connect();
	try {
		await second.next();
		expect((await request(second, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
		const help = await command(first, 'help', '/help');
		expect(help.notice!.params.from).toEqual({ user_id: '~private', name: 'System message to you' });
		// The bot token is for the asking connection only (Appendix A.1).
		const invited = await command(first, 'invite', '/invite-bot');
		expect(invited.notice!.params.body.text).toContain('apron_bot_');
		// A round trip on the other connection: everything sent to it so far arrives first.
		const { skipped } = await exchange(second, 'probe', 'room_list', { filter: 'joined' });
		expect(skipped.filter((frame) => frame.method === 'message' && frame.params.from?.user_id === '~private')).toEqual([]);
	} finally { first.close(); second.close(); }
});

/** Registers a passkey over the wire on `peer`: begin, then finish with a software authenticator. */
async function registerPasskey(peer: Peer, id: string, params: Record<string, unknown> = {}) {
	const passkey = await softPasskey('http://localhost:5173');
	const begun = await request(peer, `${id}-begin`, 'auth', { scheme: 'webauthn', action: 'register', step: 'begin', ...params });
	if (begun.error) return { passkey, begun, finished: begun };
	const credential = await passkey.register(begun.result.public_key);
	const finished = await request(peer, `${id}-finish`, 'auth', { scheme: 'webauthn', action: 'register', step: 'finish', challenge_id: begun.result.challenge_id, credential });
	return { passkey, begun, finished };
}

async function passkeyLogin(passkey: Awaited<ReturnType<typeof softPasskey>>): Promise<Frame> {
	const peer = await connect();
	try {
		await peer.next();
		const begun = await request(peer, 'login-begin', 'auth', { scheme: 'webauthn', action: 'login', step: 'begin' });
		const credential = await passkey.assert(begun.result.public_key);
		return await request(peer, 'login-finish', 'auth', { scheme: 'webauthn', action: 'login', step: 'finish', challenge_id: begun.result.challenge_id, credential });
	} finally { peer.close(); }
}

it('adds a passkey to the signed-in account (§4.10); a guest\'s registration makes a new account', async () => {
	const userId = unique('keys');
	const user = await signedIn(userId);
	const guest = await connect();
	const admin = await signedInAdmin();
	try {
		// A registered user adds a second passkey: the connection stays that user, and the
		// authenticator is told the account's user handle and existing passkey. The
		// account's other connections are told.
		const other = await connect();
		await other.next();
		const session = await runInDurableObject(stub(), (instance) =>
			(instance as unknown as { issueSession(userId: string, origin: string, now: number): Promise<string> }).issueSession(userId, 'http://localhost:5173', Date.now()));
		expect((await request(other, 'auth', 'auth', { scheme: 'token', token: session })).result.you.user_id).toBe(userId);
		const added = await registerPasskey(user, 'add');
		const told = await until(other, (frame) => frame.method === 'message' && frame.params.from?.user_id === '~private');
		expect(told.frame.params.body.text).toMatch(/A passkey was added to your account/);
		expect(added.begun.result.public_key.user.name).toBe(userId);
		expect(added.begun.result.public_key.excludeCredentials.map((entry: { id: string }) => entry.id)).toEqual([`cred-${userId}`]);
		expect(added.finished.result).toEqual({ you: { user_id: userId, name: `Name of ${userId}`, roles: [], status: 'online' } });
		const credentials = await runInDurableObject(stub(), (_instance, state) =>
			state.storage.sql.exec<{ credential_id: string }>('SELECT credential_id FROM credentials WHERE user_id = ? ORDER BY created_ms', userId).toArray().map((row) => row.credential_id));
		expect(credentials).toEqual([`cred-${userId}`, added.passkey.id]);
		// The new passkey signs in as the same account.
		expect((await passkeyLogin(added.passkey)).result.you.user_id).toBe(userId);
		// /passkeys lists both; removing one tells the other connections, and the last cannot go.
		const listed = await command(user, 'list', '/passkeys');
		expect(listed.notice!.params.body.text).toMatch(/^Your passkeys:\n1\. .*\n2\. /);
		const removed = await command(user, 'remove', '/passkeys remove 2');
		expect(removed.frame.result).toEqual({});
		expect((await until(other, (frame) => frame.method === 'message' && /Removed the passkey/.test(frame.params.body?.text ?? ''))).frame.params.from.user_id).toBe('~private');
		expect((await passkeyLogin(added.passkey)).error.code).toBe(-32001);
		expect((await command(user, 'remove-last', '/passkeys remove 1')).frame.error.message).toMatch(/only passkey/);
		other.close();
		// Signing in as someone else on a signed-in connection still takes a reconnect.
		expect((await request(user, 'login', 'auth', { scheme: 'webauthn', action: 'login', step: 'begin' })).error.code).toBe(-32001);

		// The admin user never takes a passkey, so deleting APRON_ADMIN_TOKEN turns it off; nor does a bot.
		const adminKey = await connect();
		await adminKey.next();
		expect((await request(adminKey, 'auth', 'auth', { scheme: 'token', token: ADMIN_TOKEN })).result.you.user_id).toBe('admin');
		expect((await registerPasskey(adminKey, 'admin-add')).finished.error.code).toBe(-32001);
		adminKey.close();
		await runInDurableObject(stub(), (_instance, state) => {
			expect(state.storage.sql.exec("SELECT 1 FROM credentials WHERE user_id = 'admin'").toArray()).toEqual([]);
		});
		const { frame, skipped } = await exchange(user, 'bot', 'command', { room_id: 'general', body: { text: '/invite-bot' } });
		expect(frame.result).toEqual({});
		const token = /apron_bot_[A-Za-z0-9_-]+/.exec(skipped.find((candidate) => candidate.params?.from?.user_id === '~private')!.params.body.text)![0];
		const bot = await connect();
		await bot.next();
		expect((await request(bot, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(`bot_${userId}`);
		expect((await registerPasskey(bot, 'bot-add')).finished.error.code).toBe(-32001);
		bot.close();

		// A guest has no account to add to: its registration creates one, which replaces the guest.
		await guest.next();
		const guestId = (await request(guest, 'auth', 'auth', { scheme: 'guest' })).result.you.user_id;
		const created = await registerPasskey(guest, 'guest', { name: 'Newcomer' });
		expect(created.finished.result.you.user_id).toMatch(/^newcomer_\d{4}$/);
		expect(created.finished.result.you.user_id).not.toBe(guestId);
		expect(created.finished.result.token).toEqual(expect.any(String));
	} finally { user.close(); guest.close(); admin.close(); }
});

it('/invite mints a sign-up token that creates a user per use, each with its own token (Appendix B)', async () => {
	const admin = await signedInAdmin();
	const peers: Peer[] = [];
	const fresh = async () => { const peer = await connect(); peers.push(peer); await peer.next(); return peer; };
	try {
		const minted = await command(admin, 'invite', '/invite 2');
		expect(minted.frame.result).toEqual({});
		const invite = /apron_join_[A-Za-z0-9_-]+/.exec(minted.notice!.params.body.text)![0];

		// A guest signs up with it: a new registered user, named as asked, with its own token.
		const ada = await fresh();
		await request(ada, 'guest', 'auth', { scheme: 'guest' });
		const joined = await exchange(ada, 'join', 'auth', { scheme: 'token', token: invite, name: 'Ada' });
		const signedUp = joined.frame;
		expect(signedUp.result.you).toEqual({ user_id: expect.stringMatching(/^ada_\d{4}$/), name: 'Ada', roles: [], status: 'online' });
		expect(signedUp.result.token).toMatch(/^apron_invite_/);
		const adaId = signedUp.result.you.user_id;
		// The new user's logged join of general reaches the guest's connection,
		// already in general, after the auth result (§3.2), not before.
		const joinOf = (userId: string) => (frame: Frame) => frame.method === 'room_update' && frame.params?.memberships?.[0]?.members?.[0]?.user?.user_id === userId;
		expect(joined.skipped.some(joinOf(adaId))).toBe(false);
		expect((await until(ada, joinOf(adaId))).frame.params.memberships[0]).toMatchObject({ room_id: 'general', members: [{ joined: true }] });
		// Posting works, and the saved token signs in again as the same user.
		expect((await request(ada, 'post', 'message', { room_id: 'general', body: { text: 'hi from an invite' } })).result.message_id).toBeDefined();
		const again = await fresh();
		expect((await request(again, 'auth', 'auth', { scheme: 'token', token: signedUp.result.token })).result.you.user_id).toBe(adaId);

		// A second use makes another user; the third finds the invite used up.
		const second = await fresh();
		// Without a name, a sign-up is a "Member" (not "Guest", which names guests).
		const member = await exchange(second, 'join', 'auth', { scheme: 'token', token: invite });
		expect(member.frame.result.you).toMatchObject({ user_id: expect.stringMatching(/^member_\d{4}$/), name: 'Member' });
		// A connection that was not signed in gets the join after the result too.
		expect(member.skipped.some(joinOf(member.frame.result.you.user_id))).toBe(false);
		await until(second, joinOf(member.frame.result.you.user_id));
		const third = await fresh();
		expect((await request(third, 'join', 'auth', { scheme: 'token', token: invite, name: 'Late' })).error.code).toBe(-32001);
		// The used-up invite was dropped when it was tried.
		expect(await runInDurableObject(stub(), async (_instance, state) => (await state.storage.list({ prefix: 'join-token:' })).size)).toBe(0);

		// A budget failure before the sign-up leaves no account and spends no use.
		const budgeted = /apron_join_[A-Za-z0-9_-]+/.exec((await command(admin, 'invite-budget', '/invite 1')).notice!.params.body.text)![0];
		const identities = () => runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM identities').one().n);
		const before = await identities();
		await runInDurableObject(stub(), (instance) => {
			const store = (instance as unknown as { store: Record<string, unknown> }).store;
			const original = store.withMeterAsync as (...args: unknown[]) => Promise<unknown>;
			store.withMeterAsync = (kind: unknown, cost: { reads?: number; writes?: number }, ...rest: unknown[]) => {
				if (cost.reads === 1 && cost.writes === 3) {
					store.withMeterAsync = original;
					throw Object.assign(new Error('Daily write budget exhausted'), { name: 'StoreError' });
				}
				return original.call(store, kind, cost, ...rest);
			};
		});
		expect((await request(await fresh(), 'join', 'auth', { scheme: 'token', token: budgeted, name: 'Broke' })).error).toBeDefined();
		expect(await identities()).toBe(before);
		expect((await request(await fresh(), 'join', 'auth', { scheme: 'token', token: budgeted, name: 'Fine' })).result.you.name).toBe('Fine');

		// A new invite replaces the last; /invite 0 revokes it.
		const replaced = /apron_join_[A-Za-z0-9_-]+/.exec((await command(admin, 'invite-2', '/invite 1')).notice!.params.body.text)![0];
		expect((await command(admin, 'revoke', '/invite 0')).notice!.params.body.text).toMatch(/revoked/);
		expect((await request(await fresh(), 'join', 'auth', { scheme: 'token', token: replaced })).error.code).toBe(-32001);
		expect((await command(admin, 'too-many', '/invite 51')).frame.error.code).toBe(-32602);
		// Only admins mint invites.
		expect((await command(ada, 'not-admin', '/invite 1')).frame.error.code).toBe(-32001);
	} finally { admin.close(); for (const peer of peers) peer.close(); }
});

it('advertises which schemes create accounts in server.signup (§3.2)', async () => {
	const withPasskeys = await connect();
	const plain = await connect(null);
	try {
		const server = (await withPasskeys.next()).params;
		expect(server.auth).toEqual(['webauthn', 'token', 'guest']);
		expect(server.signup).toEqual(['webauthn', 'token']);
		expect(server.welcome).toMatch(/invite token/);
		const other = (await plain.next()).params;
		expect([other.auth, other.signup]).toEqual([['token', 'guest'], ['token']]);
	} finally { withPasskeys.close(); plain.close(); }
});

it('/admin remove takes the admin role away, announced with roles: [] (§3.3)', async () => {
	const admin = await signedInAdmin();
	const userId = unique('demoted');
	const demoted = await signedIn(userId);
	const mate = await signedIn(unique('mate'));
	try {
		await command(admin, 'grant', `/admin ${userId}`);
		await until(demoted, (frame) => frame.method === 'user' && frame.params.you !== undefined);
		await until(mate, (frame) => frame.method === 'user' && frame.params.new?.user_id === userId && frame.params.new.roles !== undefined);
		const removed = await command(admin, 'demote', `/admin remove @${userId}`);
		expect(removed.notice!.params.body.text).toMatch(/is no longer an admin/);
		// An empty value means cleared: both the user and a room-mate drop the role.
		expect((await until(demoted, (frame) => frame.method === 'user' && frame.params.you !== undefined)).frame.params).toEqual({ you: { user_id: userId, name: `Name of ${userId}`, roles: [], status: 'online' } });
		expect((await until(mate, (frame) => frame.method === 'user' && frame.params.new?.user_id === userId && frame.params.new.roles !== undefined)).frame.params.new.roles).toEqual([]);
		expect((await command(demoted, 'status', '/status')).frame.error.code).toBe(-32001);
		// A client that missed the notification clears the role from any current object, such as a listing's users.
		const listed = await request(mate, 'list', 'room_list', { room_id: 'general', members: true });
		expect(listed.result.users.find((user: { user_id: string }) => user.user_id === userId).roles).toEqual([]);
		expect(listed.result.users.find((user: { user_id: string }) => user.user_id === 'admin').roles).toEqual(['admin']);
		expect((await command(admin, 'again', `/admin remove ${userId}`)).notice!.params.body.text).toMatch(/was not an admin/);
		expect((await command(admin, 'builtin', '/admin remove admin')).frame.error.code).toBe(-32602);
	} finally { admin.close(); demoted.close(); mate.close(); }
});

it('/role shows a user\'s roles and toggles one, any name a label, admin also the admin commands', async () => {
	const admin = await signedInAdmin();
	const userId = unique('labeled');
	const labeled = await signedIn(userId);
	const mate = await signedIn(unique('mate'));
	try {
		expect((await command(admin, 'help', '/help')).notice!.params.body.text).toContain('/role <user_id> [<role>]');
		const who = `**Name of ${userId}** (\`${userId}\`)`;
		expect((await command(admin, 'show-none', `/role ${userId}`)).notice!.params.body.text).toBe(`${who} has no roles.`);

		const given = await command(admin, 'give', `/role @${userId} Friend`);
		expect(given.frame.result).toEqual({});
		expect(given.notice!.params.body.text).toBe(`${who} now has the role \`friend\`.`);
		expect((await until(labeled, (frame) => frame.method === 'user' && frame.params.you !== undefined)).frame.params).toEqual({ you: { user_id: userId, name: `Name of ${userId}`, roles: ['friend'], status: 'online' } });
		expect((await until(mate, (frame) => frame.method === 'user' && frame.params.new?.user_id === userId && frame.params.new.roles !== undefined)).frame.params.new.roles).toEqual(['friend']);
		// A label grants nothing.
		expect((await command(labeled, 'status-label', '/status')).frame.error.code).toBe(-32001);

		// `admin` given with /role is the same as /admin.
		await command(admin, 'give-admin', `/role ${userId} admin`);
		expect((await command(labeled, 'status-admin', '/status')).frame.result).toEqual({});
		expect((await command(admin, 'show', `/role ${userId}`)).notice!.params.body.text).toBe(`${who} has the roles \`friend\`, \`admin\`.`);
		expect((await command(admin, 'show-admin', '/role admin')).notice!.params.body.text).toMatch(/has the roles `admin`\.$/);

		// Toggling a held role takes it away.
		expect((await command(admin, 'take', `/role ${userId} friend`)).notice!.params.body.text).toBe(`${who} no longer has the role \`friend\`.`);
		await command(admin, 'take-admin', `/role ${userId} admin`);
		const cleared = await until(labeled, (frame) => frame.method === 'user' && frame.params.you?.roles?.length === 0);
		expect(cleared.frame.params.you.roles).toEqual([]);
		expect((await command(labeled, 'status-after', '/status')).frame.error.code).toBe(-32001);

		for (const [id, text] of [
			['bad-name', `/role ${userId} no!pe`],
			['guest', '/role guest_1 friend'],
			['unknown', '/role nobody_123 friend'],
			['builtin-admin', '/role admin admin'],
			['builtin-bot', '/role admin bot'],
		]) {
			expect((await command(admin, `role-${id}`, text)).frame.error.code).toBe(-32602);
		}
		expect((await command(admin, 'usage', '/role')).frame.error.message).toBe('Usage: /role <user_id> [<role>]');
		expect((await command(labeled, 'denied', `/role ${userId} friend`)).frame.error.message).toMatch(/Only an admin/);
		expect(admin.closed()).toBeUndefined();
	} finally { admin.close(); labeled.close(); mate.close(); }
});

it('/role <user_id> bot makes a token user a bot in full, but not a passkey holder or an admin', async () => {
	const admin = await signedInAdmin();
	const userId = unique('announcer');
	const passkeyId = unique('person');
	const person = await signedIn(passkeyId);
	try {
		const invited = await command(admin, 'invite', `/invite-token ${userId}`);
		const token = invited.notice!.params.body.text.match(/```\n(apron_invite_[A-Za-z0-9_-]{43})\n```/)![1];
		const bot = await connect(null);
		await bot.next();
		expect((await request(bot, 'auth', 'auth', { scheme: 'token', token })).result.you.roles).toEqual([]);

		expect((await command(admin, 'make-bot', `/role ${userId} bot`)).notice!.params.body.text).toMatch(/now has the role `bot`/);
		expect((await until(bot, (frame) => frame.method === 'user' && frame.params.you !== undefined)).frame.params.you.roles).toEqual(['bot']);
		// It acts as a bot: no passkey, no commands for owners, a fixed name and user_id, and never an admin.
		expect((await command(bot, 'invite-bot', '/invite-bot')).frame.error.message).toBe("A bot can't use /invite-bot");
		expect((await request(bot, 'rename-self', 'me', { name: 'Other' })).error.code).toBe(-32001);
		expect((await request(bot, 'passkey', 'auth', { scheme: 'webauthn', action: 'register', step: 'begin' })).error.code).toBe(-32001);
		expect((await command(admin, 'bot-admin', `/admin ${userId}`)).frame.error.message).toBe("A bot can't be an admin");
		expect((await command(admin, 'bot-rename', `/rename ${userId} ${unique('moved')}`)).frame.error.message).toBe("A bot's user_id is fixed");
		const posted = await exchange(bot, 'post', 'message', { room_id: 'general', body: { text: 'beep' } });
		expect(posted.frame.result.message_id).toBeDefined();

		// A user who holds a passkey, or an admin, can't be made a bot.
		expect((await command(admin, 'passkey-bot', `/role ${passkeyId} bot`)).frame.error.code).toBe(-32602);
		await command(admin, 'invite-2', `/invite-token ${unique('second')}`);
		const adminId = unique('boss');
		await command(admin, 'invite-3', `/invite-token ${adminId}`);
		await command(admin, 'boss', `/admin ${adminId}`);
		expect((await command(admin, 'admin-bot', `/role ${adminId} bot`)).frame.error.code).toBe(-32602);
		// An owner's bot is always one.
		expect((await command(admin, 'owner-bot', '/role bot_nobody bot')).frame.error.code).toBe(-32602);

		// Taking the role away makes it an ordinary user again.
		await command(admin, 'unmake-bot', `/role ${userId} bot`);
		expect((await until(bot, (frame) => frame.method === 'user' && frame.params.you !== undefined)).frame.params.you.roles).toEqual([]);
		expect((await request(bot, 'rename-after', 'me', { name: 'Other' })).result.you.name).toBe('Other');
		bot.close();
	} finally { admin.close(); person.close(); }
});
