import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ACCOUNT_USAGE_POLICY, DEFAULT_LIMITS } from '../src/budget';
import type { Store } from '../src/store';
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

		// Kicking yourself is well formed but not allowed: denied (§1.1).
		expect((await command(admin, 'kick-self', '/kick admin')).frame.error.code).toBe(-32001);
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
		// Lists, not GFM tables, so strict CommonMark clients render it.
		expect(text).not.toContain('|');
		expect(text).toMatch(new RegExp(`^- SQL rows written: [\\d,]+ / ${DEFAULT_LIMITS.sqlWritesPerDay.toLocaleString('en-US')} \\(\\d+%\\)$`, 'm'));
		expect(text).toMatch(/^- Registered users: [\d,]+ \/ 10,000/m);
		expect(text).toMatch(/^- Database: /m);
		// Nor the budget guard's zone and token: a plan that relies on the guard says it can't work.
		if (ACCOUNT_USAGE_POLICY.monthly) expect(text).toMatch(/^\*\*Edge stop\*\* \(`apron_budget_stop`\): \*\*not working\*\*: `ZONE_ID` or `EDGE_STOP_TOKEN` is not set/m);
		else expect(text).not.toContain('Edge stop');
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
		// Only their own `you` carries what they may now do (ext:permissions).
		expect(granted.frame.params).toEqual({ you: { user_id: fromId, name: `Name of ${fromId}`, roles: ['admin'], ext: { permissions: { move_any: true, add_members: true } }, status: 'online' } });
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
		expect(you.frame.params).toEqual({ you: { user_id: toId, name: `Name of ${fromId}`, roles: ['admin'], ext: { permissions: { move_any: true, add_members: true } }, status: 'online' } });
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
			// It would not end a mention in text (Appendix A.3).
			['dash-end', `/rename ${toId} nope-`],
			['to-admin', `/rename ${toId} admin`],
			['unknown', `/rename nobody_123 somebody_else`],
		]) {
			expect((await command(admin, `rename-${id}`, text)).frame.error.code).toBe(-32602);
		}
		// The admin user's own user_id is fixed by policy: denied (§1.1).
		expect((await command(admin, 'rename-admin', '/rename admin somebody_else')).frame.error.code).toBe(-32001);
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
		// The same token in a link that any Apron app opens (Appendix A.4).
		expect(text).toContain(`<https://link.apron.chat/#server=wss://demo.test/ws&token=${token}>`);

		// The token signs in from any origin, as a registered user in general.
		const first = await signIn(token);
		expect(first.reply.result.you).toEqual({ user_id: userId, name: userId, roles: [], ext: { permissions: { add_members: true } }, status: 'online' });
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

it('/invite-device mints up to three named tokens that sign in as the user, a name again replacing its token', async () => {
	const admin = await signedInAdmin();
	const userId = unique('owner');
	const owner = await signedIn(userId);
	const opened: Peer[] = [];
	const signIn = async (token: string) => {
		const peer = await connect(null);
		opened.push(peer);
		await peer.next();
		return { peer, reply: await request(peer, 'auth', 'auth', { scheme: 'token', token }) };
	};
	const mint = async (name: string) => {
		const minted = await command(owner, `device-${name}`, `/invite-device ${name}`);
		expect(minted.frame.result).toEqual({});
		const token = minted.notice!.params.body.text.match(/```\n(apron_device_[A-Za-z0-9_-]{43})\n```/)![1] as string;
		// The same token in a link that any Apron app opens (Appendix A.4).
		expect(minted.notice!.params.body.text).toContain(`<https://link.apron.chat/#server=wss://demo.test/ws&token=${token}>`);
		return token;
	};
	try {
		expect((await command(owner, 'help', '/help')).notice!.params.body.text).toContain('/invite-device <name>');

		// The token signs in as the user from any origin.
		const laptop = await mint('laptop');
		const onLaptop = await signIn(laptop);
		expect(onLaptop.reply.result.you.user_id).toBe(userId);
		expect(onLaptop.reply.result.token).toBeUndefined();
		// A device signed in with a token may mint one too.
		const phone = (await command(onLaptop.peer, 'device-phone', '/invite-device phone')).notice!.params.body.text.match(/apron_device_[A-Za-z0-9_-]{43}/)![0];
		const onPhone = await signIn(phone);
		expect(onPhone.reply.result.you.user_id).toBe(userId);
		const tablet = await mint('tablet');

		// A fourth name is refused, naming the three; bad names and usage are errors to show.
		const fourth = await command(owner, 'device-desktop', '/invite-device desktop');
		expect(fourth.frame.error.code).toBe(-32001);
		expect(fourth.frame.error.message).toContain('`laptop`, `phone`, `tablet`');
		expect((await command(owner, 'usage', '/invite-device')).frame.error.message).toBe('Usage: /invite-device <name>');
		expect((await command(owner, 'usage-2', '/invite-device a b')).frame.error.code).toBe(-32602);
		expect((await command(owner, 'bad-name', '/invite-device -x')).frame.error.code).toBe(-32602);
		expect((await command(owner, 'proto', '/invite-device __proto__')).frame.error.code).toBe(-32602);
		expect(owner.closed()).toBeUndefined();

		// The same name again replaces its token, closing what signed in with
		// the old one, but not the asking connection or the other devices.
		const replaced = await command(onLaptop.peer, 'device-laptop-again', '/invite-device laptop');
		expect(replaced.notice!.params.body.text).toContain('replaces its earlier token');
		const laptop2 = replaced.notice!.params.body.text.match(/apron_device_[A-Za-z0-9_-]{43}/)![0];
		expect(onLaptop.peer.closed()).toBeUndefined();
		const again = await command(owner, 'device-laptop-3', '/invite-device laptop');
		const laptop3 = again.notice!.params.body.text.match(/apron_device_[A-Za-z0-9_-]{43}/)![0];
		await vi.waitFor(() => expect(onLaptop.peer.closed()?.code).toBe(1008));
		expect(onPhone.peer.closed()).toBeUndefined();
		expect(owner.closed()).toBeUndefined();
		for (const old of [laptop, laptop2]) {
			expect((await signIn(old)).reply.error.message).toBe('This device token is not valid; get a new one with /invite-device on a signed-in device');
		}
		expect((await signIn(laptop3)).reply.result.you.user_id).toBe(userId);

		// Guests, bots and the admin user can't mint one.
		const guest = await connect();
		opened.push(guest);
		await guest.next();
		await request(guest, 'auth', 'auth', { scheme: 'guest' });
		expect((await command(guest, 'guest', '/invite-device laptop')).frame.error.code).toBe(-32001);
		expect((await command(admin, 'admin', '/invite-device laptop')).frame.error.code).toBe(-32001);

		// /rename moves the tokens to the new user_id, and /purge revokes them.
		for (const peer of opened) peer.close();
		const renamedId = unique('renamed');
		await command(admin, 'rename', `/rename ${userId} ${renamedId}`);
		expect((await signIn(tablet)).reply.result.you.user_id).toBe(renamedId);
		expect((await signIn(phone)).reply.result.you.user_id).toBe(renamedId);
		await command(admin, 'purge', `/purge ${renamedId}`);
		for (const token of [laptop3, phone, tablet]) expect((await signIn(token)).reply.error.code).toBe(-32001);
	} finally {
		for (const peer of opened) peer.close();
		admin.close(); owner.close();
	}
});

it('/invite-device closes what used a replaced token even when clearing pushes fails', async () => {
	const owner = await signedIn(unique('owner'));
	let phone: Peer | undefined;
	type Patchable = { store: { clearPushSubscriptions: (...args: unknown[]) => void } };
	try {
		const token = (await command(owner, 'device-phone', '/invite-device phone')).notice!.params.body.text.match(/apron_device_[A-Za-z0-9_-]{43}/)![0];
		phone = await connect(null);
		await phone.next();
		expect((await request(phone, 'auth', 'auth', { scheme: 'token', token })).result.you).toBeDefined();
		// As when the day's budget refuses the push clear's reservation.
		await runInDurableObject(stub(), (instance) => {
			const store = (instance as unknown as Patchable).store;
			store.clearPushSubscriptions = () => { throw new Error('budget refused'); };
		});
		expect((await command(owner, 'device-phone-again', '/invite-device phone')).frame.error).toBeDefined();
		await vi.waitFor(() => expect(phone!.closed()?.code).toBe(1008));
		expect(owner.closed()).toBeUndefined();
	} finally {
		await runInDurableObject(stub(), (instance) => {
			const store = (instance as unknown as Patchable).store;
			delete (store as Partial<Patchable['store']>).clearPushSubscriptions;
		});
		phone?.close(); owner.close();
	}
});

it('/invite-device refuses a user renamed while the command was on its way', async () => {
	const userId = unique('owner');
	const owner = await signedIn(userId);
	try {
		// The store has the new user_id, but the connection does not yet: the
		// state /rename leaves while it moves the user's tokens.
		await runInDurableObject(stub(), (instance) => {
			(instance as unknown as { store: Store }).store.renameIdentity({ from: userId, to: unique('renamed'), now: Date.now() });
		});
		const refused = await command(owner, 'device', '/invite-device laptop');
		expect(refused.frame.error.message).toBe('Your account changed; reconnect and try again');
		expect(refused.notice).toBeUndefined();
		expect(await runInDurableObject(stub(), (_instance, state) => state.storage.get(`devices:${userId}`))).toBeUndefined();
	} finally { owner.close(); }
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

it('room_list with user_id lists only that member, also one a truncated listing leaves out, and no one for a non-member', async () => {
	const admin = await signedInAdmin();
	// Not connected, so a truncated listing can leave them out.
	const zoeId = unique('zoe');
	await registered(zoeId);
	const guest = await connect();
	try {
		await guest.next();
		const guestId = (await request(guest, 'auth', 'auth', { scheme: 'guest' })).result.you.user_id;
		const roomId = (await request(admin, unique('thread'), 'room_set', { parent_room_id: 'general', title: 'Lookup' })).result.room_id;
		await request(admin, 'add-zoe', 'room_join', { room_id: roomId, user_id: zoeId });
		await request(guest, 'join', 'room_join', { room_id: roomId });
		await setRoomListMembers(1);
		// The full listing lists one registered member, and counts the rest.
		const full = (await request(admin, 'full', 'room_list', { room_id: roomId, members: true })).result.joined[0];
		expect(full.members.map((member: { user_id: string }) => member.user_id)).not.toContain(zoeId);
		expect(full.member_count).toBe(3);
		for (const [id, userId] of [['zoe', zoeId], ['guest', guestId]]) {
			const one = (await request(admin, `one-${id}`, 'room_list', { room_id: roomId, members: true, user_id: userId })).result;
			expect(one.joined[0].members).toEqual([{ user_id: userId }]);
			expect(one.joined[0].member_count).toBeUndefined();
			expect(one.users.map((user: { user_id: string }) => user.user_id)).toEqual([userId]);
		}
		const none = (await request(admin, 'none', 'room_list', { room_id: roomId, members: true, user_id: unique('nobody') })).result;
		expect(none.joined[0].members).toEqual([]);
		expect(none.users).toEqual([]);
	} finally { await setRoomListMembers(DEFAULT_LIMITS.roomListMembers); admin.close(); guest.close(); }
});

it('room_join and room_leave with a user_id add and remove others: an admin anyone, an owner their bot, and with addmember on anyone adds', async () => {
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
		// `membership`, and Bob's connections get it with `joined` in one frame (§4.2.2).
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
		// others were last told of them may still be waiting out a minute; an
		// offline one carries when it went offline (`seen`, §4.5.2).
		const listedAdmin = joined.frame.params.users.find((user: { user_id: string }) => user.user_id === 'admin');
		expect(listedAdmin).toEqual(listedAdmin.status === 'offline'
			? { user_id: 'admin', name: 'Admin', roles: ['admin'], status: 'offline', seen: expect.stringMatching(/^\d+$/) }
			: { user_id: 'admin', name: 'Admin', roles: ['admin'], status: 'online' });
		expect(joined.frame.params.users).toContainEqual({ user_id: bobId, name: `Name of ${bobId}`, roles: [], status: 'online' });
		// Adding a member again changes nothing.
		expect((await exchange(admin, 'add-bob-again', 'room_join', { room_id: roomId, user_id: bobId })).skipped.some((frame) => frame.params?.memberships)).toBe(false);

		// With `/toggle addmember` off, Bob may not add others, but may add his own bot.
		const off = await exchange(admin, 'addmember-off', 'command', { room_id: 'general', body: { text: '/toggle addmember' } });
		expect(off.skipped.find((frame) => frame.params?.from?.user_id === '~private')?.params.body.text).toMatch(/^Adding members is now \*\*off\*\*/);
		// Bob's own `you` says he may no longer add others (ext:permissions); an admin's is unchanged.
		expect((await until(bob, (frame) => frame.method === 'user' && frame.params.you !== undefined)).frame.params).toEqual({ you: { user_id: bobId, ext: { permissions: {} } } });
		expect(off.skipped.filter((frame) => frame.method === 'user' && frame.params.you !== undefined)).toEqual([]);
		try {
			const denied = await request(bob, 'add-carol', 'room_join', { room_id: roomId, user_id: carolId });
			expect(denied.error.code).toBe(-32001);
			expect((await exchange(bob, 'bot', 'command', { room_id: 'general', body: { text: '/invite-bot' } })).frame.result).toEqual({});
			expect((await request(bob, 'add-bot', 'room_join', { room_id: roomId, user_id: `bot_${bobId}` })).result).toEqual({});
			// Only admins may toggle it.
			expect((await request(bob, 'bob-toggle', 'command', { room_id: 'general', body: { text: '/toggle addmember' } })).error.code).toBe(-32001);
		} finally {
			const on = await exchange(admin, 'addmember-on', 'command', { room_id: 'general', body: { text: '/toggle addmember' } });
			expect(on.skipped.find((frame) => frame.params?.from?.user_id === '~private')?.params.body.text).toMatch(/^Adding members is now \*\*on\*\*/);
		}
		expect((await until(bob, (frame) => frame.method === 'user' && frame.params.you !== undefined)).frame.params).toEqual({ you: { user_id: bobId, ext: { permissions: { add_members: true } } } });
		// Back on (the default, so the override is forgotten), Bob adds Carol,
		// but his bot may not add anyone.
		expect(await runInDurableObject(stub(), (instance) => (instance as unknown as { store: Store }).store.toggle('addmember'))).toBeUndefined();
		expect((await request(bob, 'add-carol-on', 'room_join', { room_id: roomId, user_id: carolId })).result).toEqual({});

		// Only registered users can be added, by a string user_id. (Each
		// invalid_params counts toward the socket's policy violations.)
		expect((await request(admin, 'add-guest', 'room_join', { room_id: roomId, user_id: guestId })).error.code).toBe(-32602);
		expect((await request(bob, 'add-typed', 'room_join', { room_id: roomId, user_id: 7 })).error.code).toBe(-32602);

		// Bob may remove his bot but nobody else, even someone he added; the admin removes Bob.
		expect((await request(bob, 'remove-carol', 'room_leave', { room_id: roomId, user_id: carolId })).error.code).toBe(-32001);
		expect((await request(bob, 'remove-bot', 'room_leave', { room_id: roomId, user_id: `bot_${bobId}` })).result).toEqual({});
		expect((await request(bob, 'remove-admin', 'room_leave', { room_id: roomId, user_id: 'admin' })).error.code).toBe(-32001);
		const removed = await exchange(admin, 'remove-bob', 'room_leave', { room_id: roomId, user_id: bobId });
		expect(removed.frame.result).toEqual({});
		expect(removed.skipped.filter((frame) => frame.params?.memberships).at(-1)?.params.memberships[0].members).toEqual([{ user: { user_id: bobId, name: `Name of ${bobId}` }, joined: false }]);
		// The removed user's connections get `left` with the membership (§4.2.2, §4.1 /kick).
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

it('room_join and room_leave reject a user_id that cannot be one: empty, or with whitespace or control characters', async () => {
	// A user_id is never empty and has no whitespace or control characters (§2.4),
	// so these are invalid_params before any permission check. Each socket sends
	// at most two, under the policy-violation limit.
	for (const bad of ['', ' ', 'bo b', 'bob\n', 'bo\u0000b']) {
		const bob = await signedIn(unique('bob'));
		const guest = await connect();
		try {
			await guest.next();
			await request(guest, 'auth', 'auth', { scheme: 'guest' });
			const label = JSON.stringify(bad);
			expect((await request(bob, 'join', 'room_join', { room_id: 'general', user_id: bad })).error.code, label).toBe(-32602);
			expect((await request(bob, 'leave', 'room_leave', { room_id: 'general', user_id: bad })).error.code, label).toBe(-32602);
			expect((await request(guest, 'join', 'room_join', { room_id: 'general', user_id: bad })).error.code, label).toBe(-32602);
			expect((await request(guest, 'leave', 'room_leave', { room_id: 'general', user_id: bad })).error.code, label).toBe(-32602);
		} finally { bob.close(); guest.close(); }
	}
});

it('a room\'s creator may remove anyone from it, across saves and /rename, until /purge', async () => {
	const admin = await signedInAdmin();
	const bobId = unique('bob');
	const bob = await signedIn(bobId);
	const carolId = unique('carol');
	const carol = await signedIn(carolId);
	const danId = unique('dan');
	const dan = await signedIn(danId);
	const creatorOf = (roomId: string) => runInDurableObject(stub(), (instance) => (instance as unknown as { store: Store }).store.roomCreator(roomId));
	try {
		const roomId = (await request(bob, unique('thread'), 'room_set', { parent_room_id: 'general', title: 'Bob\'s' })).result.room_id;
		expect(await creatorOf(roomId)).toBe(bobId);
		// The creator is kept out of the room record.
		const listed = (await request(bob, 'list', 'room_list', { room_id: roomId })).result.joined[0];
		expect(JSON.stringify(listed)).not.toContain('creator');
		for (const userId of [carolId, danId]) expect((await request(bob, `add-${userId}`, 'room_join', { room_id: roomId, user_id: userId })).result).toEqual({});

		// Dan did not create the room: he may not remove Carol, nor may she remove Bob.
		const denied = await request(dan, 'dan-removes', 'room_leave', { room_id: roomId, user_id: carolId });
		expect(denied.error.code).toBe(-32001);
		expect(denied.error.message).toBe('Only an admin, the room\'s creator, or a bot\'s owner, can remove someone else');
		expect((await request(carol, 'carol-removes', 'room_leave', { room_id: roomId, user_id: bobId })).error.code).toBe(-32001);
		// Nor in general, which nobody created.
		expect((await request(bob, 'general-removes', 'room_leave', { room_id: 'general', user_id: carolId })).error.code).toBe(-32001);

		// Carol saves the room's fields; Bob stays its creator and removes her.
		expect((await request(carol, 'save', 'room_set', { room_id: roomId, title: 'Renamed', ext: { x: 1 } })).result).toBeDefined();
		expect(await creatorOf(roomId)).toBe(bobId);
		expect((await request(bob, 'remove-carol', 'room_leave', { room_id: roomId, user_id: carolId })).result).toEqual({});
		expect((await until(carol, (frame) => frame.method === 'room_update' && frame.params.left !== undefined)).frame.params.left).toEqual([{ room_id: roomId }]);

		// /rename moves the room to Bob's new user_id.
		const newBobId = unique('robert');
		expect((await command(admin, 'rename', `/rename ${bobId} ${newBobId}`)).frame.result).toEqual({});
		await until(bob, (frame) => frame.method === 'user' && frame.params.you?.user_id === newBobId);
		expect(await creatorOf(roomId)).toBe(newBobId);
		expect((await request(bob, 'remove-dan', 'room_leave', { room_id: roomId, user_id: danId })).result).toEqual({});

		// /purge leaves the room without a creator, so a later user given the id gains nothing.
		expect((await command(admin, 'purge', `/purge ${newBobId}`)).frame.result).toEqual({});
		expect(await creatorOf(roomId)).toBeUndefined();
	} finally { admin.close(); bob.close(); carol.close(); dan.close(); }
});

it('/purge removes the threads it leaves empty, and retires the user_id so a session for it never signs in again', async () => {
	const admin = await signedInAdmin();
	const bobId = unique('bob');
	const bob = await signedIn(bobId);
	const carolId = unique('carol');
	const carol = await signedIn(carolId);
	const exists = (roomId: string) => runInDurableObject(stub(), (instance) => (instance as unknown as { store: Store }).store.getRoom(roomId) !== null);
	// A second session Bob keeps on another device.
	const token = await runInDurableObject(stub(), (instance) =>
		(instance as unknown as { issueSession(userId: string, origin: string, now: number): Promise<string> }).issueSession(bobId, 'http://localhost:5173', Date.now()));
	try {
		const alone = (await request(bob, 'alone', 'room_set', { parent_room_id: 'general', title: 'Alone' })).result.room_id;
		const shared = (await request(bob, 'shared', 'room_set', { parent_room_id: 'general', title: 'Shared' })).result.room_id;
		expect((await request(carol, 'join-shared', 'room_join', { room_id: shared })).result).toEqual({});

		expect((await command(admin, 'purge', `/purge ${bobId}`)).frame.result).toEqual({});
		// The thread only Bob was in goes with him; the one Carol is in stays.
		expect(await exists(alone)).toBe(false);
		expect(await exists(shared)).toBe(true);

		// The user_id is never issued again, so the session cannot sign in as anyone.
		const reissued = await command(admin, 'reissue', `/invite-token ${bobId}`);
		expect(reissued.frame.error.code).toBe(-32602);
		expect(reissued.frame.error.message).toContain('is taken');
		const device = await connect();
		try {
			await device.next();
			expect((await request(device, 'resume', 'auth', { scheme: 'token', token })).error.code).toBe(-32001);
		} finally { device.close(); }
	} finally { admin.close(); bob.close(); carol.close(); }
});

it('removes a thread when the last one in it leaves, with any messages in it', async () => {
	const bobId = unique('bob');
	const bob = await signedIn(bobId);
	const carolId = unique('carol');
	await registered(carolId);
	const guest = await connect();
	const threadCount = () => runInDurableObject(stub(), (_instance, state) =>
		Number(state.storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'thread_count'").one().value));
	// Asked of the store: a request for a room that is gone is invalid_params, and repeated errors close the socket.
	const exists = (roomId: string) => runInDurableObject(stub(), (instance) => (instance as unknown as { store: Store }).store.getRoom(roomId) !== null);
	const thread = async (title: string) => (await request(bob, unique('thread'), 'room_set', { parent_room_id: 'general', title })).result.room_id as string;
	try {
		await guest.next();
		await request(guest, 'auth', 'auth', { scheme: 'guest' });
		const before = await threadCount();

		// A thread nobody wrote in goes with its last member, freeing its slot.
		const unused = await thread('Unused');
		expect(await threadCount()).toBe(before + 1);
		const left = await exchange(bob, 'leave-unused', 'room_leave', { room_id: unused });
		expect(left.frame.result).toEqual({});
		expect(left.skipped.find((frame) => frame.method === 'room_update')?.params.left).toEqual([{ room_id: unused }]);
		expect(await exists(unused)).toBe(false);
		expect(await threadCount()).toBe(before);
		// It is gone: joining it is invalid_params.
		expect((await request(bob, 'join-unused', 'room_join', { room_id: unused })).error.code).toBe(-32602);

		// Messages in it do not keep it: they go with it, and can no longer be
		// edited, reacted to, moved out, or replied to.
		const written = await thread('Written');
		const message = (await request(bob, 'post', 'message', { room_id: written, body: { text: 'hello' } })).result.message_id;
		expect((await request(bob, 'leave-written', 'room_leave', { room_id: written })).result).toEqual({});
		expect(await exists(written)).toBe(false);
		// Split between connections: three invalid requests a minute close one.
		expect((await request(bob, 'move-gone', 'message', { message_id: message, room_id: 'general', body: { text: 'hello' } })).error.code).toBe(-32602);
		expect((await request(guest, 'react-gone', 'reactions', { message_id: message, emojis: ['👍'] })).error.code).toBe(-32602);
		expect((await request(guest, 'reply-gone', 'message', { body: { text: 're' }, reply_to: { message_id: message } })).error.code).toBe(-32602);
		expect(await runInDurableObject(stub(), (instance) => (instance as unknown as { store: Store }).store.messageAuthor(message))).toBeNull();

		// A registered member who is not connected keeps it; the creator
		// removing them, from outside it, empties it.
		const offline = await thread('Offline');
		expect((await request(bob, 'add-carol', 'room_join', { room_id: offline, user_id: carolId })).result).toEqual({});
		expect((await request(bob, 'leave-offline', 'room_leave', { room_id: offline })).result).toEqual({});
		expect(await exists(offline)).toBe(true);
		expect((await request(bob, 'remove-carol', 'room_leave', { room_id: offline, user_id: carolId })).result).toEqual({});
		expect(await exists(offline)).toBe(false);

		// A connected guest keeps it until the guest leaves too.
		const guests = await thread('Guests');
		expect((await request(guest, 'guest-join', 'room_join', { room_id: guests })).result).toEqual({});
		expect((await request(bob, 'leave-guests', 'room_leave', { room_id: guests })).result).toEqual({});
		expect(await exists(guests)).toBe(true);
		expect((await request(guest, 'guest-leave', 'room_leave', { room_id: guests })).result).toEqual({});
		expect(await exists(guests)).toBe(false);

		// Leaving general removes nothing.
		expect((await request(bob, 'leave-general', 'room_leave', { room_id: 'general' })).result).toEqual({});
		expect(await exists('general')).toBe(true);
		expect(await threadCount()).toBe(before);
		expect((await request(bob, 'rejoin-general', 'room_join', { room_id: 'general' })).result).toEqual({});
	} finally { bob.close(); guest.close(); }
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

it('never gives out a ~ user_id, which the protocol reserves for system identities', async () => {
	const admin = await signedInAdmin();
	const guest = await connect();
	try {
		await guest.next();
		expect((await request(guest, 'auth', 'auth', { scheme: 'guest', user_id: '~server', name: '~server' })).result.you.user_id).toMatch(/^guest_\d+$/);
		for (const text of ['/invite-token ~server', '/invite-token @~room']) {
			expect((await command(admin, text, text)).frame.error.code).toBe(-32602);
		}
		// `roles` are the server's to assign: `me` ignores them.
		expect((await request(admin, 'me', 'me', { roles: ['moderator'] })).result.you).toEqual({ user_id: 'admin', name: 'Admin', roles: ['admin'], ext: { permissions: { move_any: true, add_members: true } }, status: 'online' });
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

async function passkeyLogin(passkey: Awaited<ReturnType<typeof softPasskey>>, edit = (credential: Record<string, unknown>) => credential, counter = 1): Promise<Frame> {
	const peer = await connect();
	try {
		await peer.next();
		const begun = await request(peer, 'login-begin', 'auth', { scheme: 'webauthn', action: 'login', step: 'begin' });
		const credential = edit(await passkey.assert(begun.result.public_key, counter));
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
		expect(added.finished.result).toEqual({ you: { user_id: userId, name: `Name of ${userId}`, roles: [], ext: { permissions: { add_members: true } }, status: 'online' } });
		const credentials = await runInDurableObject(stub(), (_instance, state) =>
			state.storage.sql.exec<{ credential_id: string }>('SELECT credential_id FROM credentials WHERE user_id = ? ORDER BY created_ms', userId).toArray().map((row) => row.credential_id));
		expect(credentials).toEqual([`cred-${userId}`, added.passkey.id]);
		// The new passkey signs in as the same account.
		expect((await passkeyLogin(added.passkey)).result.you.user_id).toBe(userId);
		// Also when a password manager leaves out the extension results, or sends null.
		expect((await passkeyLogin(added.passkey, ({ clientExtensionResults: _, ...rest }) => rest, 2)).result.you.user_id).toBe(userId);
		expect((await passkeyLogin(added.passkey, (credential) => ({ ...credential, clientExtensionResults: null }), 3)).result.you.user_id).toBe(userId);
		expect((await passkeyLogin(added.passkey, (credential) => ({ ...credential, clientExtensionResults: [] }), 4)).error.message).toBe('clientExtensionResults must be an object');
		// /passkeys lists both; removing one tells the other connections, and the last cannot go.
		const listed = await command(user, 'list', '/passkeys');
		expect(listed.notice!.params.body.text).toMatch(/^Your passkeys:\n1\. .*\n2\. /);
		const removed = await command(user, 'remove', '/passkeys remove 2');
		expect(removed.frame.result).toEqual({});
		expect((await until(other, (frame) => frame.method === 'message' && /Removed the passkey/.test(frame.params.body?.text ?? ''))).frame.params.from.user_id).toBe('~private');
		expect((await passkeyLogin(added.passkey)).error.code).toBe(-32001);
		expect((await command(user, 'remove-last', '/passkeys remove 1')).frame.error).toMatchObject({ code: -32001, message: expect.stringMatching(/only passkey/) });
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
		expect(minted.notice!.params.body.text).toContain(`<https://link.apron.chat/#server=wss://demo.test/ws&token=${invite}>`);

		// A guest signs up with it: a new registered user, named as asked, with its own token.
		const ada = await fresh();
		await request(ada, 'guest', 'auth', { scheme: 'guest' });
		const joined = await exchange(ada, 'join', 'auth', { scheme: 'token', token: invite, name: 'Ada' });
		const signedUp = joined.frame;
		expect(signedUp.result.you).toEqual({ user_id: expect.stringMatching(/^ada_\d{4}$/), name: 'Ada', roles: [], ext: { permissions: { add_members: true } }, status: 'online' });
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
		// Past the server's count limit: denied (§1.1).
		expect((await command(admin, 'too-many', '/invite 51')).frame.error.code).toBe(-32001);
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

it("shows general's description as server.welcome while it has one", async () => {
	const admin = await signedInAdmin();
	const description = 'Say hi in **general**.';
	try {
		expect((await exchange(admin, 'describe', 'room_set', { room_id: 'general', title: 'General', description })).frame.result).toEqual({ room_id: 'general' });
		const greeted = await connect();
		const plain = await connect(null);
		try {
			// The same text whatever the origin can sign in with.
			expect((await greeted.next()).params.welcome).toBe(description);
			expect((await plain.next()).params.welcome).toBe(description);
		} finally { greeted.close(); plain.close(); }
	} finally {
		// Without a description, the generated sign-in welcome comes back.
		expect((await exchange(admin, 'undescribe', 'room_set', { room_id: 'general', title: 'General' })).frame.result).toEqual({ room_id: 'general' });
		admin.close();
	}
	const after = await connect();
	try { expect((await after.next()).params.welcome).toMatch(/Apron public demo/); } finally { after.close(); }
});

it("falls back to general's description as server.description, re-announced while it is in use (§3.1)", async () => {
	const admin = await signedInAdmin();
	const watcher = await connect();
	const configured = await runInDurableObject(stub(), (instance) => (instance as unknown as { config: { server: Record<string, string> } }).config.server);
	const setVariables = (server: Record<string, string>) => runInDurableObject(stub(), (instance) => {
		const runtime = instance as unknown as { config: { server: Record<string, string> } };
		runtime.config = { ...runtime.config, server };
	});
	// Request ids are unique: a room_set retried with an id already used is deduplicated.
	const describe = (id: string, description?: string) => exchange(admin, unique(id), 'room_set', { room_id: 'general', title: 'General', ...(description !== undefined ? { description } : {}) });
	const serverFrames = (skipped: Frame[]) => skipped.filter((frame) => frame.method === 'server');
	const fresh = async () => { const peer = await connect(); try { return (await peer.next()).params; } finally { peer.close(); } };
	try {
		await watcher.next();
		// The admin's sign-in may have sent it a new server frame (wake scope joined).
		await command(admin, 'drain', '/help');
		await setVariables({});
		// Unset: general's description, sent to every connection when it changes.
		const described = await describe('describe', '  Say hi in **general**. ');
		expect(serverFrames(described.skipped).map((frame) => frame.params.description)).toEqual(['Say hi in **general**.']);
		expect((await until(watcher, (frame) => frame.method === 'server')).frame.params.description).toBe('Say hi in **general**.');
		expect(await fresh()).toMatchObject({ description: 'Say hi in **general**.', welcome: '  Say hi in **general**. ' });
		expect((await command(admin, 'show', '/server')).notice!.params.body.text).toContain("- **description** (from the default room `general`'s description):\n  > Say hi in **general**.");
		// Past 500 bytes it is left out, not cut; without one, there is none.
		const long = await describe('long', 'x'.repeat(501));
		expect(serverFrames(long.skipped).map((frame) => frame.params.description)).toEqual([undefined]);
		expect((await command(admin, 'show-long', '/server')).notice!.params.body.text).toContain("- **description**: none (`general`'s description is longer than 500 bytes or holds control characters, so it is left out)");
		expect(serverFrames((await describe('again', 'Say hi.')).skipped).map((frame) => frame.params.description)).toEqual(['Say hi.']);
		expect(serverFrames((await describe('removed')).skipped).map((frame) => frame.params.description)).toEqual([undefined]);
		expect(await fresh()).not.toHaveProperty('description');
		// An unchanged one sends nothing.
		expect(serverFrames((await describe('unchanged')).skipped)).toEqual([]);

		// SERVER_DESCRIPTION (empty counts as unset) and /server description come first: general's changes then send nothing.
		await describe('set', 'Say hi.');
		await setVariables({ description: 'From the variable.' });
		expect(serverFrames((await describe('overridden', 'Say hello.')).skipped)).toEqual([]);
		expect((await fresh()).description).toBe('From the variable.');
		await command(admin, 'own', '/server description Our own.');
		expect((await fresh()).description).toBe('Our own.');
		await setVariables({});
		expect(serverFrames((await describe('still-overridden', 'Say hey.')).skipped)).toEqual([]);
		expect((await fresh()).description).toBe('Our own.');
		// Cleared, general's applies again.
		const cleared = await command(admin, 'clear', '/server description');
		expect(serverFrames(cleared.skipped).map((frame) => frame.params.description)).toEqual(['Say hey.']);
		expect((await fresh()).description).toBe('Say hey.');
	} finally {
		await describe('undescribe');
		await setVariables(configured);
		admin.close(); watcher.close();
	}
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
		// An empty value means cleared: both the user and a room-mate drop the role,
		// and the user's own `you` no longer has `move_any`.
		expect((await until(demoted, (frame) => frame.method === 'user' && frame.params.you !== undefined)).frame.params).toEqual({ you: { user_id: userId, name: `Name of ${userId}`, roles: [], ext: { permissions: { add_members: true } }, status: 'online' } });
		expect((await until(mate, (frame) => frame.method === 'user' && frame.params.new?.user_id === userId && frame.params.new.roles !== undefined)).frame.params.new.roles).toEqual([]);
		expect((await command(demoted, 'status', '/status')).frame.error.code).toBe(-32001);
		// A client that missed the notification clears the role from any current object, such as a listing's users.
		const listed = await request(mate, 'list', 'room_list', { room_id: 'general', members: true });
		expect(listed.result.users.find((user: { user_id: string }) => user.user_id === userId).roles).toEqual([]);
		expect(listed.result.users.find((user: { user_id: string }) => user.user_id === 'admin').roles).toEqual(['admin']);
		expect((await command(admin, 'again', `/admin remove ${userId}`)).notice!.params.body.text).toMatch(/was not an admin/);
		expect((await command(admin, 'builtin', '/admin remove admin')).frame.error.code).toBe(-32001);
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
		expect((await until(labeled, (frame) => frame.method === 'user' && frame.params.you !== undefined)).frame.params).toEqual({ you: { user_id: userId, name: `Name of ${userId}`, roles: ['friend'], ext: { permissions: { add_members: true } }, status: 'online' } });
		expect((await until(mate, (frame) => frame.method === 'user' && frame.params.new?.user_id === userId && frame.params.new.roles !== undefined)).frame.params.new.roles).toEqual(['friend']);
		// `friend` grants no admin command.
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
		]) {
			expect((await command(admin, `role-${id}`, text)).frame.error.code).toBe(-32602);
		}
		// Role changes the server never allows are denied (§1.1): the admin user
		// stays an admin, and an admin can't be a bot.
		for (const [id, text] of [['builtin-admin', '/role admin admin'], ['builtin-bot', '/role admin bot']]) {
			expect((await command(admin, `role-${id}`, text)).frame.error.code).toBe(-32001);
		}
		expect((await command(admin, 'usage', '/role')).frame.error.message).toBe('Usage: /role <user_id> [<role>]');
		expect((await command(labeled, 'denied', `/role ${userId} friend`)).frame.error.message).toMatch(/Only an admin/);
		expect(admin.closed()).toBeUndefined();
	} finally { admin.close(); labeled.close(); mate.close(); }
});

it('tells only a user their own permissions (ext:permissions): admin, mod and threader move others\' messages, admin and mod get push for joined, but not an owner\'s bot', async () => {
	const admin = await signedInAdmin();
	const tiaId = unique('tia');
	const tia = await signedIn(tiaId);
	const mateId = unique('mate');
	const mate = await signedIn(mateId);
	try {
		const ownYou = async (peer: Peer) => (await until(peer, (frame) => frame.method === 'user' && frame.params.you !== undefined)).frame.params.you;
		const theirNew = async (peer: Peer, userId: string) => (await until(peer, (frame) => frame.method === 'user' && frame.params.new?.user_id === userId && frame.params.new.roles !== undefined)).frame.params.new;
		const posted = (await exchange(mate, 'post', 'message', { room_id: 'general', body: { text: 'tidy me' } })).frame.result.message_id;
		const threadId = (await request(admin, unique('thread'), 'room_set', { parent_room_id: 'general', title: 'Tidied' })).result.room_id;
		const move = (peer: Peer, id: string, roomId: string) => request(peer, id, 'message', { message_id: posted, room_id: roomId, body: { text: 'tidy me', format: 'plain' } });

		// Without a moderator role, a user may add others but not move their messages.
		expect((await move(tia, 'before', threadId)).error.code).toBe(-32001);
		for (const role of ['threader', 'mod', 'admin']) {
			await command(admin, `give-${role}`, `/role ${tiaId} ${role}`);
			expect((await ownYou(tia)).ext).toEqual({ permissions: { move_any: true, add_members: true } });
			// Others' objects for her never carry it.
			expect(await theirNew(mate, tiaId)).not.toHaveProperty('ext');
			// What it says is so: she moves the message into the thread, and back.
			expect((await move(tia, `${role}-in`, threadId)).result).toBeDefined();
			expect((await move(tia, `${role}-out`, 'general')).result).toBeDefined();
			await command(admin, `take-${role}`, `/role ${tiaId} ${role}`);
			expect((await ownYou(tia)).ext).toEqual({ permissions: { add_members: true } });
			await theirNew(mate, tiaId);
		}
		expect((await move(tia, 'after', threadId)).error.code).toBe(-32001);

		// An owner's bot (identity tier `bot`) may not move others' messages
		// even with `mod`, nor add others, so it is told neither.
		const invited = await command(tia, 'invite-bot', '/invite-bot');
		const token = /```\n(apron_bot_[A-Za-z0-9_-]+)\n```/.exec(invited.notice!.params.body.text)![1];
		const bot = await connect(null);
		try {
			await bot.next();
			expect((await request(bot, 'auth', 'auth', { scheme: 'token', token })).result.you.ext).toEqual({ permissions: {} });
			await command(admin, 'bot-mod', `/role bot_${tiaId} mod`);
			expect((await ownYou(bot)).ext).toEqual({ permissions: {} });
			expect((await move(bot, 'bot-move', threadId)).error.code).toBe(-32001);
		} finally { bot.close(); }
	} finally { admin.close(); tia.close(); mate.close(); }
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
		// Its connection has no Origin, so passkeys are not offered to it at all: unsupported (§3.2).
		expect((await request(bot, 'passkey', 'auth', { scheme: 'webauthn', action: 'register', step: 'begin' })).error.code).toBe(-32601);
		expect((await command(admin, 'bot-admin', `/admin ${userId}`)).frame.error.message).toBe("A bot can't be an admin");
		expect((await command(admin, 'bot-rename', `/rename ${userId} ${unique('moved')}`)).frame.error.message).toBe("A bot's user_id is fixed");
		const posted = await exchange(bot, 'post', 'message', { room_id: 'general', body: { text: 'beep' } });
		expect(posted.frame.result.message_id).toBeDefined();

		// A user who holds a passkey, or an admin, can't be made a bot.
		expect((await command(admin, 'passkey-bot', `/role ${passkeyId} bot`)).frame.error.code).toBe(-32001);
		await command(admin, 'invite-2', `/invite-token ${unique('second')}`);
		const adminId = unique('boss');
		await command(admin, 'invite-3', `/invite-token ${adminId}`);
		await command(admin, 'boss', `/admin ${adminId}`);
		expect((await command(admin, 'admin-bot', `/role ${adminId} bot`)).frame.error.code).toBe(-32001);
		// An owner's bot is always one (an unknown bot_ user_id is still invalid_params).
		expect((await command(admin, 'owner-bot', '/role bot_nobody bot')).frame.error.code).toBe(-32602);

		// Taking the role away makes it an ordinary user again.
		await command(admin, 'unmake-bot', `/role ${userId} bot`);
		expect((await until(bot, (frame) => frame.method === 'user' && frame.params.you !== undefined)).frame.params.you.roles).toEqual([]);
		expect((await request(bot, 'rename-after', 'me', { name: 'Other' })).result.you.name).toBe('Other');
		bot.close();
	} finally { admin.close(); person.close(); }
});

it('an admin creates a top-level room that others find with room_list and join, and that stays when emptied', async () => {
	const admin = await signedInAdmin();
	const guest = await connect();
	try {
		await guest.next();
		await request(guest, 'auth', 'auth', { scheme: 'guest' });
		expect((await request(guest, 'guest-room', 'room_set', { title: 'Mine' })).error.code).toBe(-32001);

		const created = await exchange(admin, 'room', 'room_set', { title: 'Random', description: 'Off topic' });
		const roomId = created.frame.result.room_id as string;
		const joined = created.skipped.find((frame) => frame.method === 'room_update')!.params.joined[0];
		expect(joined).toMatchObject({ room_id: roomId, title: 'Random', description: 'Off topic', members: [{ user_id: 'admin' }] });
		expect(joined.parent_room_id).toBeUndefined();

		// The guest, in general only, now has a top-level room to join.
		const browse = (await request(guest, 'browse', 'room_list', { filter: 'not_joined' })).result;
		expect(browse.not_joined.map((room: { room_id: string }) => room.room_id)).toContain(roomId);
		expect((await request(guest, 'join', 'room_join', { room_id: roomId })).result).toEqual({});
		expect((await request(guest, 'browse-again', 'room_list', { filter: 'not_joined' })).result).toEqual({ not_joined: [] });

		// A thread may start in it, and when everyone leaves the room stays.
		const thread = (await request(guest, 'thread', 'room_set', { parent_room_id: roomId, title: 'Side' })).result.room_id;
		expect(thread).toEqual(expect.any(String));
		await request(guest, 'leave', 'room_leave', { room_id: roomId });
		await request(admin, 'leave', 'room_leave', { room_id: roomId });
		const exists = await runInDurableObject(stub(), (instance) => (instance as unknown as { store: Store }).store.getRoom(roomId) !== null);
		expect(exists).toBe(true);
	} finally { admin.close(); guest.close(); }
});
