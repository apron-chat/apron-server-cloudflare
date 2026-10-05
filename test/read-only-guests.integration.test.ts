import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { connect as open, exchange, greeting, request, until, type Frame, type Peer } from './helpers/socket';

let nextIp = 1;

const stub = () => env.DEMO.getByName('public-demo-v1');

/** The deployed default: guests only read (vitest.config.ts turns guest posting on for the other suites). */
async function guestsReadOnly(): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as { config: { guestPosting: boolean } };
		server.config = { ...server.config, guestPosting: false };
	});
}

/** A socket from its own 203.0.113.N address; `null` omits the Origin, as a bot does. */
const connect = (origin: string | null = 'http://localhost:5173') => open({ ip: `203.0.113.${nextIp++}`, origin });

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
	const auth = await request(peer, 'auth', 'auth', { scheme: 'token', token });
	expect(auth.result.you.user_id).toBe(userId);
	return peer;
}

/** Runs `/invite-bot` and returns the token from the private notice that answers it. */
async function inviteBot(peer: Peer, id: string): Promise<{ token: string; notice: Frame; skipped: Frame[] }> {
	const { frame, skipped } = await exchange(peer, id, 'command', { room_id: 'general', body: { text: '/invite-bot' } });
	expect(frame.result).toEqual({});
	const notice = skipped.find((candidate) => candidate.method === 'message' && candidate.params.from.user_id === '~private');
	expect(notice).toBeDefined();
	const token = /```\n(apron_bot_[A-Za-z0-9_-]+)\n```/.exec(notice!.params.body.text)?.[1];
	expect(token).toBeDefined();
	return { token: token!, notice: notice!, skipped };
}

it('tells a guest it only reads, then denies its writes, joins and leaves included, but not its reads', async () => {
	await guestsReadOnly();
	const guest = await connect();
	try {
		const { server, welcome } = await greeting(guest);
		expect(server.params.ext.demo.guest_posting).toBe(false);
		// The welcome follows the server frame, before any auth (Appendix B):
		// transient (§3.5), with no room_id since the client knows no rooms yet.
		// Where guests only read, it says so after the server version.
		expect(welcome.params.room_id).toBeUndefined();
		expect(welcome.params.message_id).toBeUndefined();
		expect(welcome.params.body.text).toMatch(/\n\nGuests can read\. \*Sign in with passkey\* to participate\.$/);
		guest.send({ id: 'auth', method: 'auth', params: { scheme: 'guest' } });
		const auth = await guest.next();
		expect(auth.id).toBe('auth');
		expect(auth.result.you.user_id).toMatch(/^guest_/);

		const denied = (frame: Frame) => {
			expect(frame.error.code).toBe(-32001);
			expect(frame.error.message).toMatch(/sign in/i);
		};
		denied(await request(guest, 'post', 'message', { room_id: 'general', body: { text: 'hello' } }));
		denied(await request(guest, 'post-default', 'message', { body: { text: 'hello' } }));
		denied(await request(guest, 'thread', 'room_set', { parent_room_id: 'general', title: 'Nope' }));
		denied(await request(guest, 'bot', 'command', { body: { text: '/invite-bot' } }));
		// Joining and leaving are writes too: the guest stays in general, where auth put it.
		denied(await request(guest, 'leave', 'room_leave', { room_id: 'general' }));
		denied(await request(guest, 'rejoin', 'room_join', { room_id: 'general' }));

		// Reading stays open: listing, history, and /help.
		expect((await request(guest, 'rooms', 'room_list', { filter: 'joined' })).result.joined[0].room_id).toBe('general');
		expect((await request(guest, 'history', 'history', { room_id: 'general' })).result.latest_log_id).toBeDefined();
		const help = await exchange(guest, 'help', 'command', { body: { text: '/help' } });
		expect(help.frame.result).toEqual({});
		const listed = help.skipped.find((frame) => frame.method === 'message')!.params.body.text;
		expect(listed).toContain('/help');
		expect(listed).not.toContain('/invite-bot');

		// Something to react to and a thread to read, from a registered user.
		const owner = await signedIn('reader_owner');
		try {
			const posted = await request(owner, 'post', 'message', { room_id: 'general', body: { text: 'for the guest' } });
			denied(await request(guest, 'react', 'reactions', { message_id: posted.result.message_id, emojis: ['👍'] }));
			const thread = (await request(owner, 'thread', 'room_set', { parent_room_id: 'general', title: 'Readable' })).result.room_id;
			await request(owner, 'reply', 'message', { room_id: thread, body: { text: 'in the thread' } });
			// The guest lists the thread and reads its history without joining it, but cannot join it.
			const threads = await request(guest, 'threads', 'room_list', { parent_room_id: 'general', filter: 'not_joined' });
			expect(threads.result.not_joined.map((room: { room_id: string }) => room.room_id)).toContain(thread);
			const page = await request(guest, 'thread-history', 'history', { room_id: thread });
			expect(page.result.messages.map((message: { body: { text: string } }) => message.body.text)).toContain('in the thread');
			denied(await request(guest, 'join-thread', 'room_join', { room_id: thread }));
		} finally { owner.close(); }
	} finally { guest.close(); }
});

it('lets a registered user invite a bot that signs in from anywhere with its token', async () => {
	await guestsReadOnly();
	const owner = await signedIn('u_owner');
	const bot = await connect(null);
	try {
		const help = await exchange(owner, 'help', 'command', { body: { text: '/help' } });
		expect(help.skipped.find((frame) => frame.method === 'message')!.params.body.text).toContain('/invite-bot');

		const { token, notice, skipped } = await inviteBot(owner, 'invite');
		expect(notice.params.body.text).toContain('**Bot of Name of u_owner**');
		expect(notice.params.body.text).toContain('`bot_u_owner`');
		// Instructions an LLM can follow, naming this server as the connection reached it.
		expect(notice.params.body.text).toContain([
			"If you're using an LLM, you can give it these instructions:",
			'',
			'```',
			'Read https://github.com/shazow/apron/blob/main/PROTOCOL.md',
			'Connect to wss://demo.test/ws',
			`Auth using token scheme with this token: "${token}"`,
			'Say hello when you join and listen for messages',
			'```',
		].join('\n'));
		// The new bot's logged join of general reaches its members, the owner among them.
		const joined = skipped.find((frame) => frame.method === 'room_update' && frame.params.memberships)?.params.memberships[0];
		expect(joined?.members).toEqual([{ user: { user_id: 'bot_u_owner', name: 'Bot of Name of u_owner' }, joined: true }]);

		// A bot has no Origin: it is offered `token`, and its token needs none.
		expect((await bot.next()).params.auth).toEqual(['token', 'guest']);
		const auth = await request(bot, 'auth', 'auth', { scheme: 'token', token });
		expect(auth.result).toEqual({ you: { user_id: 'bot_u_owner', name: 'Bot of Name of u_owner', roles: ['bot'], status: 'online' } });
		expect(auth.result.token).toBeUndefined();
		expect((await request(bot, 'rooms', 'room_list', { filter: 'joined' })).result.joined.map((room: { room_id: string }) => room.room_id)).toEqual(['general']);

		// The bot posts like any registered user; its owner receives it.
		const posted = await request(bot, 'post', 'message', { room_id: 'general', body: { text: 'beep' } });
		expect(posted.result.message_id).toBeDefined();
		const delivered = await until(owner, (frame) => frame.method === 'message' && frame.params.message_id === posted.result.message_id);
		expect(delivered.frame.params.from).toEqual({ user_id: 'bot_u_owner', name: 'Bot of Name of u_owner' });

		// A bot keeps its owner's name and cannot invite bots of its own.
		expect((await request(bot, 'rename', 'me', { name: 'Evil' })).error.code).toBe(-32001);
		const botHelp = await exchange(bot, 'bot-help', 'command', { body: { text: '/help' } });
		expect(botHelp.skipped.find((frame) => frame.method === 'message')!.params.body.text).not.toContain('/invite-bot');
		expect((await request(bot, 'bot-invite', 'command', { body: { text: '/invite-bot' } })).error.code).toBe(-32001);
	} finally { owner.close(); bot.close(); }
});

it('replaces a bot token on a new invite, signing out the old one, and renames the bot after its owner', async () => {
	await guestsReadOnly();
	const owner = await signedIn('u_rotating');
	const first = await connect(null);
	const stale = await connect(null);
	const fresh = await connect(null);
	try {
		const { token: oldToken } = await inviteBot(owner, 'invite-1');
		await first.next();
		expect((await request(first, 'auth', 'auth', { scheme: 'token', token: oldToken })).result.you.user_id).toBe('bot_u_rotating');

		await request(owner, 'rename', 'me', { name: 'Rotated' });
		const { token: newToken, skipped } = await inviteBot(owner, 'invite-2');
		// No second join: the bot exists and only takes the owner's new name.
		expect(skipped.some((frame) => frame.params?.memberships)).toBe(false);
		expect(newToken).not.toBe(oldToken);

		// The connection that used the old token is closed, and the old token no longer signs in.
		await expect.poll(() => first.closed()?.code).toBe(1008);
		await stale.next();
		expect((await request(stale, 'auth', 'auth', { scheme: 'token', token: oldToken })).error.code).toBe(-32001);
		await fresh.next();
		expect((await request(fresh, 'auth', 'auth', { scheme: 'token', token: newToken })).result.you).toEqual({ user_id: 'bot_u_rotating', name: 'Bot of Rotated', roles: ['bot'], status: 'online' });
	} finally { owner.close(); first.close(); stale.close(); fresh.close(); }
});

it('lets a bot send auth and a post together before the server frame, and retry the post without posting twice', async () => {
	await guestsReadOnly();
	const owner = await signedIn('u_deployer');
	try {
		const { token } = await inviteBot(owner, 'invite');
		// A deploy hook (Appendix B): both frames at once, without waiting for `server`.
		const post = { room_id: 'general', body: { text: 'Deployed v1.4.2' } };
		const hook = await connect(null);
		hook.send({ id: 'auth', method: 'auth', params: { scheme: 'token', token, client: 'deploy-hook/1.0' } });
		hook.send({ id: 'deploy-7f3a', method: 'message', params: post });
		// Guests only read, and a bot has no Origin: its welcome points at the demo's site.
		const { welcome } = await greeting(hook);
		expect(welcome.params.body.text).toMatch(/bot token/);
		expect((await hook.next()).result.you.user_id).toBe('bot_u_deployer');
		// The bot joined general when it was made, so its broadcast comes first (§1).
		const posted = (await until(hook, (frame) => frame.id === 'deploy-7f3a')).frame;
		expect(posted.result.message_id).toBeDefined();
		hook.close();
		// The same id and params on a new connection return the original result.
		const retry = await connect(null);
		retry.send({ id: 'auth', method: 'auth', params: { scheme: 'token', token } });
		retry.send({ id: 'deploy-7f3a', method: 'message', params: post });
		expect((await until(retry, (frame) => frame.id === 'deploy-7f3a')).frame.result).toEqual(posted.result);
		const page = await request(owner, 'history', 'history', { room_id: 'general' });
		expect(page.result.messages.filter((message: { body: { text: string } }) => message.body.text === 'Deployed v1.4.2')).toHaveLength(1);
		retry.close();
	} finally { owner.close(); }
});

it('signs in as the admin user with APRON_ADMIN_TOKEN from anywhere, once it is set', async () => {
	await guestsReadOnly();
	const adminToken = 'admin-token-0123456789abcdef';
	const withAdminToken = (value: string | undefined) => runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as { config: { adminToken?: string } };
		server.config = { ...server.config, adminToken: value };
	});
	const unset = await connect(null);
	try {
		await unset.next();
		// Unset, the token is only a failed session resume.
		expect((await request(unset, 'auth', 'auth', { scheme: 'token', token: adminToken })).error.code).toBe(-32001);
	} finally { unset.close(); }

	await withAdminToken(adminToken);
	const first = await connect(null);
	const second = await connect();
	try {
		await first.next();
		const auth = await request(first, 'auth', 'auth', { scheme: 'token', token: adminToken });
		expect(auth.result).toEqual({ you: { user_id: 'admin', name: 'Admin', roles: ['admin'], status: 'online' } });
		// Created on first use, it starts in general.
		expect((await request(first, 'rooms', 'room_list', { filter: 'joined' })).result.joined.map((room: { room_id: string }) => room.room_id)).toEqual(['general']);
		const posted = await request(first, 'post', 'message', { room_id: 'general', body: { text: 'testing' } });
		expect(posted.result.message_id).toBeDefined();
		const { token: botToken } = await inviteBot(first, 'invite');
		expect(botToken).toMatch(/^apron_bot_/);

		// The same token signs in again, as the same user, from a browser too.
		await second.next();
		expect((await request(second, 'auth', 'auth', { scheme: 'token', token: adminToken })).result.you).toEqual({ user_id: 'admin', name: 'Admin', roles: ['admin'], status: 'online' });
	} finally { first.close(); second.close(); await withAdminToken(undefined); }
});

it('rejects a made-up bot token', async () => {
	await guestsReadOnly();
	const peer = await connect(null);
	try {
		await peer.next();
		const forged = await request(peer, 'forged', 'auth', { scheme: 'token', token: 'apron_bot_not-a-real-token' });
		expect(forged.error.code).toBe(-32001);
		expect(forged.error.message).toMatch(/invite-bot/);
	} finally { peer.close(); }
});
