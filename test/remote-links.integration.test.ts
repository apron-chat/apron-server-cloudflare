import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Store } from '../src/store';
import { connect as open, exchange, request, until, type Frame, type Peer } from './helpers/socket';

// Link accounts (extension `ext:remote`): an admin's `/remote invite` binds an
// account to a remote server, whose bridge then posts as that server's users.

let nextIp = 1;
const stub = () => env.DEMO.getByName('public-demo-v1');
const ADMIN_TOKEN = 'admin-token-0123456789abcdef';
const connect = () => open({ ip: `203.0.113.${nextIp++}`, origin: null });
const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const DENIED = -32001;
const INVALID_PARAMS = -32602;

async function setAdminToken(value: string | undefined): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as { config: { adminToken?: string } };
		server.config = { ...server.config, adminToken: value };
	});
}

beforeEach(() => setAdminToken(ADMIN_TOKEN));
afterEach(() => setAdminToken(undefined));

async function signIn(token: string): Promise<{ peer: Peer; you: Record<string, any> }> {
	const peer = await connect();
	await peer.next();
	const reply = await request(peer, 'auth', 'auth', { scheme: 'token', token });
	expect(reply.result?.you).toBeDefined();
	return { peer, you: reply.result.you };
}

async function command(peer: Peer, id: string, text: string, roomId: string): Promise<{ frame: Frame; notice?: Frame; skipped: Frame[] }> {
	const { frame, skipped } = await exchange(peer, id, 'command', { room_id: roomId, body: { text } });
	const notice = skipped.find((candidate) => candidate.method === 'message' && candidate.params.from.user_id === '~private');
	return { frame, notice, skipped };
}

/**
 * The admin in a new private room, and a link to `server` invited into it:
 * the link's connection, its user_id, and the invite notice's text.
 */
async function linked(server: string): Promise<{ admin: Peer; adminId: string; link: Peer; linkId: string; roomId: string; text: string }> {
	const { peer: admin, userId: adminId } = await freshAdmin();
	// A request id of its own: an accepted request id is deduplicated for a day (§1.2).
	const roomId = (await request(admin, unique('room'), 'room_set', { private: true })).result.room_id as string;
	const invited = await command(admin, 'invite', `/remote invite ${server}`, roomId);
	expect(invited.frame.result).toEqual({});
	const text: string = invited.notice!.params.body.text;
	const token = text.match(/&token=(apron_invite_[A-Za-z0-9_-]{43})/)![1];
	const { peer: link, you } = await signIn(token);
	return { admin, adminId, link, linkId: you.user_id, roomId, text };
}

/**
 * A new admin of its own, so each test's private rooms count against its
 * own limits: the `admin` user makes a token user and gives it the role.
 */
async function freshAdmin(): Promise<{ peer: Peer; userId: string }> {
	const root = (await signIn(ADMIN_TOKEN)).peer;
	const userId = unique('op');
	const made = await command(root, unique('make'), `/invite-token ${userId}`, 'general');
	const token = made.notice!.params.body.text.match(/```\n(apron_invite_[A-Za-z0-9_-]{43})\n```/)![1];
	expect((await command(root, unique('grant'), `/admin ${userId}`, 'general')).frame.result).toEqual({});
	root.close();
	return { peer: (await signIn(token)).peer, userId };
}

const messageFrom = (userId: string) => (frame: Frame) => frame.method === 'message' && frame.params.from?.user_id === userId;

it('/remote invite creates a link bound to the address, in the private room, with an A.4 link', async () => {
	const { admin, link, linkId, roomId, text } = await linked('WS://127.0.0.1:8081/ws');
	try {
		expect(linkId).toMatch(/^link_\d+$/);
		// The address is normalized (scheme and host lowercased), and the link names this server, the room and the token.
		expect(text).toContain(`To share this room with ws://127.0.0.1:8081/ws`);
		expect(text).toContain(`(\`${linkId}\`)`);
		// The invite, in a code span: this server, this room and a token of the link.
		expect(text).toMatch(new RegExp(`\n\`https://link\\.apron\\.chat/#server=wss://demo\\.test/ws&room=${roomId}&token=apron_invite_[A-Za-z0-9_-]{43}\``));
		// Signed in, the link is a bot in that private room only.
		const joined = await request(link, 'joined', 'room_list', { filter: 'joined' });
		expect(joined.result.joined.map((room: { room_id: string }) => room.room_id)).toEqual([roomId]);
		const me = await request(link, 'me', 'me', {});
		expect(me.result.you).toMatchObject({ user_id: linkId, roles: ['bot'] });
		// The admin saw it join.
		const members = await request(admin, 'members', 'room_list', { room_id: roomId, members: true });
		expect(members.result.joined[0].members.map((member: { user_id: string }) => member.user_id)).toContain(linkId);
		const listed = await command(admin, 'list', '/remote list', roomId);
		expect(listed.notice!.params.body.text).toContain(`- ws://127.0.0.1:8081/ws: link \`${linkId}\`; shared rooms: none`);
		// Bad addresses are refused.
		for (const address of ['http://127.0.0.1:8081/ws', 'ws://user@host/ws', 'chat.example', 'wss://demo.test/ws']) {
			expect((await command(admin, `bad-${address}`, `/remote invite ${address}`, roomId)).frame.error.code).toBe(INVALID_PARAMS);
		}
	} finally { admin.close(); link.close(); }
});

it('runs a link\'s message as a shadow user that joins the room, and keeps ext.remote across saves', async () => {
	const server = 'ws://127.0.0.1:8081/ws';
	const { admin, link, linkId, roomId } = await linked(server);
	const remoteId = unique('carol');
	const shadowId = `${remoteId}@127.0.0.1:8081`;
	try {
		link.send({ id: 'post', method: 'message', params: {
			room_id: roomId, body: { text: 'hello from A' },
			ext: { remote: { server: 'wss://forged.example/ws', user_id: remoteId, room_id: 'ops', message_id: '1724803599120' }, other: 1 },
		} });
		// The shadow's logged join, then the message, reach the room's members.
		const join = await until(admin, (frame) => frame.method === 'room_update' && frame.params.memberships?.[0]?.members?.[0]?.user?.user_id === shadowId);
		expect(join.frame.params.memberships[0].members[0]).toEqual({
			user: { user_id: shadowId, name: remoteId, ext: { remote: { server, user_id: remoteId } } }, joined: true,
		});
		const posted = (await until(admin, messageFrom(shadowId))).frame.params;
		expect(posted.from).toEqual({ user_id: shadowId, name: remoteId, ext: { remote: { server, user_id: remoteId } } });
		expect(posted.ext).toEqual({ remote: { server, user_id: remoteId, room_id: 'ops', message_id: '1724803599120' }, other: 1 });
		const reply = await until(link, (frame) => frame.id === 'post');
		expect(reply.frame.result).toEqual({ message_id: posted.message_id });

		// The shadow is a member with the server-owned ext.remote.
		const members = await request(admin, 'members', 'room_list', { room_id: roomId, members: true });
		expect(members.result.joined[0].members.map((member: { user_id: string }) => member.user_id)).toContain(shadowId);
		const shadow = members.result.users.find((member: { user_id: string }) => member.user_id === shadowId);
		expect(shadow).toMatchObject({ user_id: shadowId, roles: [], ext: { remote: { server, user_id: remoteId } } });

		// A save as the shadow keeps from and the remote IDs; the link itself is not the author.
		const saved = await request(link, 'save', 'message', { message_id: posted.message_id, room_id: roomId, body: { text: 'edited on A' }, ext: { remote: { user_id: remoteId } } });
		expect(saved.result).toEqual({ message_id: posted.message_id });
		const edit = (await until(admin, (frame) => frame.method === 'message' && frame.params.message_id === posted.message_id && frame.params.body?.text === 'edited on A')).frame.params;
		expect(edit.from).toEqual(posted.from);
		expect(edit.ext.remote).toEqual({ server, user_id: remoteId, room_id: 'ops', message_id: '1724803599120' });
		const notAuthor = await request(link, 'link-save', 'message', { message_id: posted.message_id, room_id: roomId, body: { text: 'as the link' } });
		expect(notAuthor.error.code).toBe(DENIED);
		// Another remote user is not the author either.
		const otherSave = await request(link, 'other-save', 'message', { message_id: posted.message_id, room_id: roomId, body: { text: 'x' }, ext: { remote: { user_id: unique('mallory') } } });
		expect(otherSave.error.code).toBe(DENIED);

		// A delete as the shadow is a tombstone, which carries no ext (§4.13).
		const deleted = await request(link, 'delete', 'message', { message_id: posted.message_id, room_id: roomId, deleted: true, ext: { remote: { user_id: remoteId } } });
		expect(deleted.result).toEqual({ message_id: posted.message_id });
		const tombstone = (await until(admin, (frame) => frame.method === 'message' && frame.params.message_id === posted.message_id && frame.params.deleted === true)).frame.params;
		expect(tombstone.from.user_id).toBe(shadowId);
		expect(tombstone).not.toHaveProperty('ext');

		// An act-as user_id must be a non-empty protocol id (two: a third invalid_params closes the connection).
		for (const [id, userId] of [['empty', ''], ['system', '~server']] as const) {
			const refused = await request(link, `bad-${id}`, 'message', { room_id: roomId, body: { text: 'x' }, ext: { remote: { user_id: userId } } });
			expect(refused.error.code).toBe(INVALID_PARAMS);
		}
		expect(linkId).toMatch(/^link_/);
	} finally { admin.close(); link.close(); }
});

it('strips ext.remote from everyone but a link acting as a remote user', async () => {
	const { admin, adminId, link, linkId, roomId } = await linked('ws://127.0.0.1:8082/ws');
	const forged = { server: 'wss://b.example/ws', user_id: 'carol' };
	try {
		const posted = await exchange(admin, 'post', 'message', { room_id: roomId, body: { text: 'hi' }, ext: { remote: forged, kept: true } });
		const snapshot = posted.skipped.find((frame) => frame.method === 'message' && frame.params.message_id === posted.frame.result.message_id)!.params;
		expect(snapshot.from).toEqual({ user_id: adminId, name: adminId });
		expect(snapshot.ext).toEqual({ kept: true });
		const me = await request(admin, 'me', 'me', { ext: { remote: forged } });
		expect(me.result.you.ext?.remote).toBeUndefined();
		const room = await exchange(admin, 'room-save', 'room_set', { room_id: roomId, ext: { remote: forged, topic: 'x' } });
		expect(room.frame.error).toBeUndefined();
		const listed = await request(admin, 'listed', 'room_list', { room_id: roomId });
		expect(listed.result.joined[0].ext).toEqual({ topic: 'x' });
		// A link without ext.remote.user_id posts as itself, and its ext.remote is dropped too.
		const own = await exchange(link, 'own', 'message', { room_id: roomId, body: { text: 'link bot here' }, ext: { remote: { room_id: 'ops' } } });
		const ownSnapshot = own.skipped.find((frame) => frame.method === 'message' && frame.params.message_id === own.frame.result.message_id)!.params;
		expect(ownSnapshot.from.user_id).toBe(linkId);
		expect(ownSnapshot).not.toHaveProperty('ext');
	} finally { admin.close(); link.close(); }
});

it('sets a shadow\'s reactions, renames it with me, and lets it leave', async () => {
	const server = 'ws://127.0.0.1:8083/ws';
	const { admin, link, linkId, roomId } = await linked(server);
	const carol = unique('carol');
	const dave = unique('dave');
	const daveId = `${dave}@127.0.0.1:8083`;
	try {
		const posted = await request(link, 'post', 'message', { room_id: roomId, body: { text: 'react to me' }, ext: { remote: { user_id: carol } } });
		const messageId = posted.result.message_id as string;
		const reacted = await request(link, 'react', 'reactions', { message_id: messageId, emojis: ['👍'], ext: { remote: { user_id: dave } } });
		expect(reacted.result).toEqual({});
		const reactions = (await until(admin, (frame) => frame.method === 'reactions' && frame.params.message_id === messageId)).frame.params;
		expect(reactions.reactions).toEqual([{ from: { user_id: daveId, name: dave, ext: { remote: { server, user_id: dave } } }, emojis: ['👍'] }]);

		// `me` renames the shadow, not the link, and others are told.
		const renamed = await exchange(link, 'rename', 'me', { name: 'Dave D', ext: { remote: { user_id: dave } } });
		expect(renamed.frame.result.you).toMatchObject({ user_id: daveId, name: 'Dave D', roles: [], ext: { remote: { server, user_id: dave } } });
		const told = await until(admin, (frame) => frame.method === 'user' && frame.params.new?.user_id === daveId);
		expect(told.frame.params.new).toEqual({ user_id: daveId, name: 'Dave D', roles: [] });
		expect((await request(link, 'self', 'me', {})).result.you).toMatchObject({ user_id: linkId });
		expect((await request(link, 'self', 'me', {})).result.you.name).not.toBe('Dave D');

		// The shadow leaves the room.
		const left = await request(link, 'leave', 'room_leave', { room_id: roomId, ext: { remote: { user_id: dave } } });
		expect(left.result).toEqual({});
		const membership = await until(admin, (frame) => frame.method === 'room_update' && frame.params.memberships?.[0]?.members?.[0]?.user?.user_id === daveId && frame.params.memberships[0].members[0].joined === false);
		expect(membership.frame.params.memberships[0].room_id).toBe(roomId);
	} finally { admin.close(); link.close(); }
});

it('refuses act-as writes in a room the link is not in', async () => {
	const { admin, link, roomId } = await linked('ws://127.0.0.1:8084/ws');
	try {
		// `general` is public, and the link is not in it: denied.
		const general = await request(link, 'general', 'message', { room_id: 'general', body: { text: 'x' }, ext: { remote: { user_id: 'carol' } } });
		expect(general.error.code).toBe(DENIED);
		// A private room the link is not in is unknown to it.
		const other = (await request(admin, unique('other'), 'room_set', { private: true })).result.room_id as string;
		const hidden = await request(link, 'hidden', 'message', { room_id: other, body: { text: 'x' }, ext: { remote: { user_id: 'carol' } } });
		expect(hidden.error.code).toBe(INVALID_PARAMS);
		// In its own room it may.
		const ok = await request(link, 'ok', 'message', { room_id: roomId, body: { text: 'x' }, ext: { remote: { user_id: 'carol' } } });
		expect(ok.result.message_id).toBeDefined();
	} finally { admin.close(); link.close(); }
});

it('keeps shadow user_ids from being issued, renamed, or acted as by anyone but a link', async () => {
	const { admin, adminId, link, roomId, text } = await linked('ws://127.0.0.1:8085/ws');
	const carol = unique('carol');
	const shadowId = `${carol}@127.0.0.1:8085`;
	try {
		expect((await request(link, 'post', 'message', { room_id: roomId, body: { text: 'x' }, ext: { remote: { user_id: carol } } })).result.message_id).toBeDefined();
		expect((await command(admin, 'claim', `/invite-token ${shadowId}`, roomId)).frame.error.code).toBe(INVALID_PARAMS);
		expect((await command(admin, 'claim-new', `/invite-token new@127.0.0.1:8085`, roomId)).frame.error.code).toBe(INVALID_PARAMS);
		expect((await command(admin, 'rename', `/rename ${shadowId} ${unique('x')}`, roomId)).frame.error.code).toBe(DENIED);
		// The admin is no link: its ext.remote.user_id is dropped, and it posts as itself.
		const own = await exchange(admin, 'own', 'message', { room_id: roomId, body: { text: 'me' }, ext: { remote: { user_id: carol } } });
		expect(own.skipped.find((frame) => frame.method === 'message' && frame.params.message_id === own.frame.result.message_id)!.params.from.user_id).toBe(adminId);
		// Revoked, the link signs in no more and no longer acts as anyone.
		const linkId = (await request(link, 'whoami', 'me', {})).result.you.user_id as string;
		const revoked = await command(admin, 'revoke', `/remote revoke ws://127.0.0.1:8085/ws`, roomId);
		expect(revoked.notice!.params.body.text).toContain(`Revoked the link \`${linkId}\` for ws://127.0.0.1:8085/ws`);
		for (let i = 0; i < 100 && !link.closed(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
		expect(link.closed()?.code).toBe(1008);
		const again = await connect();
		await again.next();
		expect((await request(again, 'auth', 'auth', { scheme: 'token', token: text.match(/&token=(apron_invite_[A-Za-z0-9_-]{43})/)![1] })).error.code).toBe(DENIED);
		again.close();
	} finally { admin.close(); link.close(); }
});

it('never signs a link out as an idle bot, nor prunes a shadow as an idle account', async () => {
	const day = 86_400_000;
	await runInDurableObject(env.DEMO.getByName('remote-idle'), (_instance, state) => {
		const clock = { now: Date.now() };
		const store = new Store(state, { idleAccountMs: 30 * day, keptActiveAccounts: 1 }, { now: () => clock.now });
		store.initialize();
		const sql = state.storage.sql;
		sql.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('idle_activity_since', ?)", String(clock.now - 365 * day));
		const { userId: linkId } = store.createRemoteLink({ server: 'ws://a.example/ws', name: 'Link bot', roomId: 'general', now: clock.now, ipKey: 'ip' });
		expect(store.remoteLink(linkId)).toBe('ws://a.example/ws');
		const shadow = store.ensureShadow({ userId: 'carol@a.example', remote: { server: 'ws://a.example/ws', user_id: 'carol' }, name: 'carol', now: clock.now, ipKey: 'ip' });
		expect(shadow).toEqual({ name: 'carol', created: true });
		// The same id for another server's user is refused (two addresses, one authority).
		expect(() => store.ensureShadow({ userId: 'carol@a.example', remote: { server: 'wss://a.example/ws', user_id: 'carol' }, name: 'carol', now: clock.now, ipKey: 'ip' })).toThrow(/another server/);
		// An ordinary bot and an ordinary account, idle as long as the link and the shadow.
		sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms, roles_json) VALUES ('plain_bot', '', 'bot', 'registered', ?, ?, '[\"bot\"]')", clock.now - 90 * day, clock.now - 90 * day);
		sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms, roles_json) VALUES ('plain', '', 'plain', 'registered', ?, ?, '[]')", clock.now - 90 * day, clock.now - 90 * day);
		sql.exec("UPDATE identities SET created_ms = ?, updated_ms = ? WHERE user_id IN (?, 'carol@a.example')", clock.now - 90 * day, clock.now - 90 * day, linkId);
		sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms, roles_json) VALUES ('recent', '', 'recent', 'registered', ?, ?, '[]')", clock.now, clock.now);
		sql.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('bot_sweep_ms', '1')");
		expect(store.idleBots({ now: clock.now, before: clock.now - 7 * day, limit: 10, intervalMs: day, graceMs: day })).toEqual(['plain_bot']);
		expect(store.pruneIdleIdentities(clock.now).pruned).toEqual(['plain']);
		expect(store.removeRemoteLink(linkId)).toBe(true);
		expect(store.remoteLink(linkId)).toBeUndefined();
	});
});

it('gives a link\'s own user object ext.remote with its server and no user_id', async () => {
	const server = 'ws://127.0.0.1:8087/ws';
	const { admin, link, linkId, roomId } = await linked(server);
	try {
		expect((await request(link, 'me', 'me', {})).result.you).toMatchObject({ user_id: linkId, ext: { remote: { server } } });
		expect((await request(link, 'me2', 'me', {})).result.you.ext.remote).not.toHaveProperty('user_id');
		const members = await request(admin, 'members', 'room_list', { room_id: roomId, members: true });
		expect(members.result.users.find((user: { user_id: string }) => user.user_id === linkId)).toMatchObject({ ext: { remote: { server } } });
		// Its own posts' recorded `from`, but not the message, carry it.
		const own = await exchange(link, 'own', 'message', { room_id: roomId, body: { text: 'link bot here' } });
		const snapshot = own.skipped.find((frame) => frame.method === 'message' && frame.params.message_id === own.frame.result.message_id)!.params;
		expect(snapshot.from).toEqual({ user_id: linkId, name: expect.any(String), ext: { remote: { server } } });
		expect(snapshot).not.toHaveProperty('ext');
		// A `me` of its own keeps it.
		const renamed = await request(link, 'rename', 'me', { name: 'Bridge bot', ext: { remote: { server: 'ws://forged/ws' } } });
		expect(renamed.result.you).toMatchObject({ name: 'Bridge bot', ext: { remote: { server } } });
	} finally { admin.close(); link.close(); }
});

it('joins a remote user that left a room again on its next write, but not one another user removed', async () => {
	const { admin, link, roomId } = await linked('ws://127.0.0.1:8088/ws');
	const carol = unique('carol');
	const dave = unique('dave');
	const carolId = `${carol}@127.0.0.1:8088`;
	const daveId = `${dave}@127.0.0.1:8088`;
	const post = (id: string, user: string) => request(link, id, 'message', { room_id: roomId, body: { text: id }, ext: { remote: { user_id: user } } });
	try {
		expect((await post('carol-1', carol)).result.message_id).toBeDefined();
		const reacted = (await post('dave-1', dave)).result.message_id as string;
		// Carol leaves through her link: her next write joins her again.
		expect((await request(link, 'leave', 'room_leave', { room_id: roomId, ext: { remote: { user_id: carol } } })).result).toEqual({});
		const rejoined = await exchange(link, 'carol-2', 'message', { room_id: roomId, body: { text: 'back' }, ext: { remote: { user_id: carol } } });
		expect(rejoined.frame.result.message_id).toBeDefined();
		expect(rejoined.skipped.some((frame) => frame.method === 'room_update' && frame.params.memberships?.[0]?.members?.[0]?.user?.user_id === carolId && frame.params.memberships[0].members[0].joined)).toBe(true);
		// The admin removes Carol and Dave: their writes and reactions are refused.
		expect((await command(admin, 'kick-carol', `/kick ${carolId}`, roomId)).frame.result).toEqual({});
		expect((await command(admin, 'kick-dave', `/kick ${daveId}`, roomId)).frame.result).toEqual({});
		expect((await post('carol-3', carol)).error.code).toBe(DENIED);
		expect((await post('dave-2', dave)).error.code).toBe(DENIED);
		expect((await request(link, 'carol-react', 'reactions', { message_id: reacted, emojis: ['👍'], ext: { remote: { user_id: carol } } })).error.code).toBe(DENIED);
		// Added back by the admin, Carol writes again.
		expect((await request(admin, 'add', 'room_join', { room_id: roomId, user_id: carolId })).result).toEqual({});
		expect((await post('carol-4', carol)).result.message_id).toBeDefined();
	} finally { admin.close(); link.close(); }
});

it('answers a link\'s repeated create of a remote message with the copy it already wrote', async () => {
	const { admin, link, roomId } = await linked('ws://127.0.0.1:8089/ws');
	const carol = unique('carol');
	const remote = { user_id: carol, room_id: 'ops', message_id: '1724803599120' };
	try {
		const first = await request(link, 'first', 'message', { room_id: roomId, body: { text: 'once' }, ext: { remote } });
		const messageId = first.result.message_id as string;
		// Another request id, even as another remote user: the same message, and nothing logged.
		const again = await exchange(link, 'again', 'message', { room_id: roomId, body: { text: 'twice' }, ext: { remote: { ...remote, user_id: unique('dave') } } });
		expect(again.frame.result).toEqual({ message_id: messageId });
		expect(again.skipped.filter((frame) => frame.method === 'message' || frame.method === 'room_update')).toEqual([]);
		const page = await request(admin, 'history', 'history', { room_id: roomId });
		expect(page.result.messages.filter((message: { body?: { text?: string } }) => message.body?.text === 'twice')).toEqual([]);
		// A save is no create; another remote message id is another message.
		expect((await request(link, 'save', 'message', { message_id: messageId, room_id: roomId, body: { text: 'saved' }, ext: { remote } })).result).toEqual({ message_id: messageId });
		const other = await request(link, 'other', 'message', { room_id: roomId, body: { text: 'other' }, ext: { remote: { ...remote, message_id: '1724803599121' } } });
		expect(other.result.message_id).not.toBe(messageId);
		// Still a duplicate once deleted.
		await request(link, 'delete', 'message', { message_id: messageId, room_id: roomId, deleted: true, ext: { remote } });
		expect((await request(link, 'after-delete', 'message', { room_id: roomId, body: { text: 'x' }, ext: { remote } })).result).toEqual({ message_id: messageId });
	} finally { admin.close(); link.close(); }
});

it('lets a link send past the per-connection frame limit, and keeps it open through invalid_params', async () => {
	const { admin, link, linkId } = await linked('ws://127.0.0.1:8090/ws');
	try {
		for (let i = 0; i < 5; i += 1) {
			expect((await request(link, `bad-${i}`, 'message', { room_id: 'nowhere', body: { text: 'x' } })).error.code).toBe(INVALID_PARAMS);
		}
		for (let i = 0; i < 70; i += 1) expect((await request(link, `me-${i}`, 'me', {})).result.you.user_id).toBe(linkId);
		expect(link.closed()).toBeUndefined();
	} finally { admin.close(); link.close(); }
});

it('reuses one link a remote server across rooms, with a token for each invite', async () => {
	const server = 'ws://127.0.0.1:8091/ws';
	const first = await linked(server);
	const { admin, link, linkId } = first;
	try {
		const second = (await request(admin, unique('room2'), 'room_set', { private: true })).result.room_id as string;
		const invited = await command(admin, 'invite2', `/remote invite ${server}`, second);
		const text: string = invited.notice!.params.body.text;
		expect(text).toContain(`(\`${linkId}\`)`);
		const token = text.match(/&token=(apron_invite_[A-Za-z0-9_-]{43})/)![1];
		expect(text).toContain(`&room=${second}&`);
		// The link joined the second room too; both tokens sign in as it.
		await until(link, (frame) => frame.method === 'room_update' && frame.params.joined?.[0]?.room_id === second);
		const again = await signIn(token);
		expect(again.you.user_id).toBe(linkId);
		const rooms = (await request(again.peer, 'joined', 'room_list', { filter: 'joined' })).result.joined.map((room: { room_id: string }) => room.room_id).sort();
		expect(rooms).toEqual([first.roomId, second].sort());
		again.peer.close();
		// One link for the server.
		const listing: string = (await command(admin, 'list', '/remote list', second)).notice!.params.body.text;
		expect(listing.split('\n').filter((line) => line.startsWith(`- ${server}:`))).toEqual([`- ${server}: link \`${linkId}\`; shared rooms: none`]);
	} finally { admin.close(); link.close(); }
});

it('pairs a room on an ext:remote request from its link, and refuses everything else', async () => {
	const server = 'ws://127.0.0.1:8092/ws';
	const { admin, link, roomId } = await linked(server);
	const remoteLink = `https://link.apron.chat/#server=${server}&room=ops&token=apron_invite_secret`;
	try {
		// Not a link: denied.
		expect((await request(admin, 'not-link', 'ext:remote', { room_id: roomId, link: remoteLink })).error.code).toBe(DENIED);
		// A room the link has not joined, a link of another server, or none that parses: invalid_params.
		expect((await request(link, 'general', 'ext:remote', { room_id: 'general', link: remoteLink })).error.code).toBe(INVALID_PARAMS);
		expect((await request(link, 'other', 'ext:remote', { room_id: roomId, link: 'https://link.apron.chat/#server=ws://elsewhere/ws&room=ops&token=t' })).error.code).toBe(INVALID_PARAMS);
		expect((await request(link, 'garbage', 'ext:remote', { room_id: roomId, link: 'hello' })).error.code).toBe(INVALID_PARAMS);
	} finally { link.close(); }
	// A new connection: three invalid_params count as policy violations only for others; it is still open anyway.
	const fresh = await linked(server);
	try {
		const reply = await request(fresh.link, 'pair', 'ext:remote', { room_id: fresh.roomId, link: `apron:?server=WS://127.0.0.1:8092/ws&room=ops&token=apron_invite_secret` });
		expect(reply.result).toEqual({});
		const listing: string = (await command(fresh.admin, 'list', '/remote list', fresh.roomId)).notice!.params.body.text;
		expect(listing).toContain(`\`${fresh.roomId}\` ↔ \`ops\``);
		expect(listing).not.toContain('apron_invite_secret');
		// The pair's token is on no user object.
		const members = await request(fresh.admin, 'members', 'room_list', { room_id: fresh.roomId, members: true });
		expect(JSON.stringify(members.result)).not.toContain('apron_invite_secret');
		expect(roomId).not.toBe(fresh.roomId);
	} finally { admin.close(); fresh.admin.close(); fresh.link.close(); }
});

it('takes a create for a remote message_id the link already wrote as a duplicate, whatever its room', async () => {
	const { admin, link, roomId } = await linked('ws://127.0.0.1:8093/ws');
	try {
		const first = await request(link, 'first', 'message', { room_id: roomId, body: { text: 'once' }, ext: { remote: { user_id: 'carol', room_id: 'ops', message_id: '42' } } });
		const again = await request(link, 'again', 'message', { room_id: roomId, body: { text: 'twice' }, ext: { remote: { user_id: 'carol', room_id: 'elsewhere', message_id: '42' } } });
		expect(again.result).toEqual({ message_id: first.result.message_id });
		const bare = await request(link, 'bare', 'message', { room_id: roomId, body: { text: 'thrice' }, ext: { remote: { user_id: 'carol', message_id: '42' } } });
		expect(bare.result).toEqual({ message_id: first.result.message_id });
	} finally { admin.close(); link.close(); }
});

it('/remote unshare takes the links out of the room and drops its pairs', async () => {
	const server = 'ws://127.0.0.1:8094/ws';
	const { admin, link, linkId, roomId } = await linked(server);
	try {
		expect((await request(link, 'pair', 'ext:remote', { room_id: roomId, link: `https://link.apron.chat/#server=${server}&room=ops&token=t` })).result).toEqual({});
		const unshared = await command(admin, 'unshare', '/remote unshare', roomId);
		// The other server (none listens here) could not be told.
		expect(unshared.notice!.params.body.text).toMatch(new RegExp(`^This room is no longer shared with ${server.replace(/[.:/]/g, '\\$&')}\\. Could not tell `));
		expect(unshared.skipped.some((frame) => frame.method === 'room_update' && frame.params.memberships?.[0]?.members?.[0]?.user?.user_id === linkId && frame.params.memberships[0].members[0].joined === false)).toBe(true);
		expect((await command(admin, 'list', '/remote list', roomId)).notice!.params.body.text).toContain('shared rooms: none');
		// The link may no longer write there: its pair has ended.
		const refused = await request(link, 'post', 'message', { room_id: roomId, body: { text: 'x' }, ext: { remote: { user_id: 'carol' } } });
		expect(refused.error).toMatchObject({ code: INVALID_PARAMS, data: { ext: { remote: 'not_joined' } } });
	} finally { admin.close(); link.close(); }
});

it('ends a pair on an ext:remote request without link, and the link leaves the room', async () => {
	const server = 'ws://127.0.0.1:8095/ws';
	const { admin, link, linkId, roomId } = await linked(server);
	try {
		expect((await request(link, 'pair', 'ext:remote', { room_id: roomId, link: `https://link.apron.chat/#server=${server}&room=ops&token=t` })).result).toEqual({});
		const ended = await exchange(link, 'end', 'ext:remote', { room_id: roomId });
		expect(ended.frame.result).toEqual({});
		expect(ended.skipped.some((frame) => frame.method === 'room_update' && frame.params.left?.[0]?.room_id === roomId)).toBe(true);
		const left = await until(admin, (frame) => frame.method === 'room_update' && frame.params.memberships?.[0]?.members?.[0]?.user?.user_id === linkId && frame.params.memberships[0].members[0].joined === false);
		expect(left.frame.params.memberships[0].room_id).toBe(roomId);
		expect((await command(admin, 'list', '/remote list', roomId)).notice!.params.body.text).toContain('shared rooms: none');
		// A link in a public room it has not joined is denied, with the same reason.
		const general = await request(link, 'general', 'message', { room_id: 'general', body: { text: 'x' }, ext: { remote: { user_id: 'carol' } } });
		expect(general.error).toMatchObject({ code: DENIED, data: { ext: { remote: 'not_joined' } } });
	} finally { admin.close(); link.close(); }
});
