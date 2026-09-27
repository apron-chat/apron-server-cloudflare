import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
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

/** Runs a command in a room; its reply and the `@private` notice before it, if any. */
async function command(peer: Peer, id: string, text: string, roomId = 'general'): Promise<{ frame: Frame; notice?: Frame; skipped: Frame[] }> {
	const { frame, skipped } = await exchange(peer, id, 'command', { room_id: roomId, body: { text } });
	const notice = skipped.find((candidate) => candidate.method === 'message' && candidate.params.from.user_id === '@private');
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
		// A user_id may be written as a mention.
		const granted = await command(admin, 'grant', `/admin @${userId}`);
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
		expect((await command(admin, 'kick-bare-at', '/kick @')).frame.error.message).toBe('Usage: /kick <user_id>');
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
		expect(text).toMatch(/\| SQL rows written \| [\d,]+ \/ 80,000 \(\d+%\) \|/);
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
		const renamed = await command(admin, 'rename', `/rename @${fromId} @${toId}`);
		expect(renamed.frame.result).toEqual({});
		expect(renamed.notice!.params.body.text).toBe(`Renamed \`${fromId}\` to \`${toId}\`.`);
		// The user's connection becomes the new identity; a room-mate learns of the change (§3.3).
		const you = await until(dave, (frame) => frame.method === 'user');
		expect(you.frame.params).toEqual({ you: { user_id: toId, name: `Name of ${fromId}` } });
		const change = await until(erin, (frame) => frame.method === 'user' && frame.params.old?.user_id === fromId);
		expect(change.frame.params).toEqual({ new: { user_id: toId, name: `Name of ${fromId}` }, old: { user_id: fromId, name: `Name of ${fromId}` } });
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
