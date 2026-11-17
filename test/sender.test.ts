import { describe, expect, it } from 'vitest';
import { addServerToLinks, linkLeftRoom, Outbox, requestId, RetryLater, rewriteMentions, type OutboxDeps, type OutboxRecord, type ReplyFrame } from '../src/sender';

// The sender's mapping and order (extension `ext:remote`), with a fake link connection.

const S = 'ws://b.example/ws';
const SELF = 'ws://a.example/ws';

type Sent = { method: string; params: Record<string, any>; id: string };

function world(records: OutboxRecord[]) {
	const state = {
		cursor: 0,
		pairs: new Map([['room', 'ops'], ['other', 'ops2']]),
		starts: new Map<string, number>(),
		linkIn: new Set(['room', 'other']),
		messages: new Map<string, Record<string, unknown>>(),
		copies: new Map<string, string>(),
		users: new Map<string, { id: string; name: string }>(),
		names: new Map([['ada', 'Ada'], ['bob', 'Bob'], ['guest_7', '']]),
		dropped: [] as string[],
		logs: [] as string[],
	};
	const deps: OutboxDeps = {
		self: SELF,
		pairs: () => new Map([...state.pairs].filter(([room]) => !state.dropped.includes(room)).map(([room, remote]) => [room, { remote, start: state.starts.get(room) ?? 0 }])),
		linkInRoom: (room) => state.linkIn.has(room),
		dropPair: (room) => { state.dropped.push(room); },
		cursor: () => state.cursor,
		advance: (logId) => { state.cursor = Math.max(state.cursor, logId); },
		records: (rooms, after, limit) => records.filter((record) => rooms.includes(record.room_id) && record.log_id > after).slice(0, limit),
		message: (id) => state.messages.get(id) ?? null,
		isLocalUser: (id) => state.names.has(id),
		userName: (id) => state.names.get(id),
		remoteUserOf: (id) => (id === 'carol@b.example' ? 'carol' : undefined),
		copy: async (id) => state.copies.get(id),
		setCopy: async (id, copy) => { state.copies.set(id, copy); },
		user: async (id) => state.users.get(id),
		setUser: async (id, value) => { state.users.set(id, value); },
		log: (event) => { state.logs.push(event); },
	};
	const sent: Sent[] = [];
	let next = 100;
	const answers = new Map<string, (request: Sent) => ReplyFrame>();
	const call = async (method: string, params: Record<string, unknown>, id: string): Promise<ReplyFrame> => {
		const request = { method, params: params as Record<string, any>, id };
		sent.push(request);
		const special = answers.get(method);
		if (special) return special(request);
		if (method === 'me') return { result: { you: { user_id: `${(params.ext as any).remote.user_id}@a.example`, name: params.name } } };
		if (method === 'message') return { result: { message_id: (params.message_id as string) ?? String(next++) } };
		return { result: {} };
	};
	return { state, deps, sent, call, answers, outbox: new Outbox(S, deps) };
}

const message = (logId: number, fields: Record<string, unknown>, room = 'room'): OutboxRecord => ({
	room_id: room, log_id: logId, kind: 'message',
	record: { message_id: String(logId), log_id: String(logId), room_id: room, from: { user_id: 'ada', name: 'Ada' }, body: { text: 'hi' }, ...fields },
});

describe('Outbox', () => {
	it('sends a profile, then the create with ext.remote, and keeps the copy', async () => {
		const { outbox, sent, call, state } = world([message(1, {})]);
		await outbox.drain(call);
		expect(sent.map((request) => request.method)).toEqual(['me', 'message']);
		expect(sent[0].params).toEqual({ name: 'Ada', ext: { remote: { user_id: 'ada' } } });
		expect(sent[1].params).toEqual({ room_id: 'ops', body: { text: 'hi', format: 'plain' }, ext: { remote: { user_id: 'ada', room_id: 'room', message_id: '1' } } });
		expect(state.copies.get('1')).toBe('100');
		expect(state.cursor).toBe(1);
		// Ids come from the record, so a resend is a duplicate.
		expect(sent[1].id).toMatch(/^fed-1-create-[0-9a-f]{14}$/);
		// The same request again is the same id; other params, another.
		expect(requestId(1, 'create', 'message', sent[1].params)).toBe(sent[1].id);
		expect(requestId(1, 'create', 'message', { ...sent[1].params, body: { text: 'other' } })).not.toBe(sent[1].id);
	});

	it('saves the copy on an edit, deletes it on a delete or a move out, and skips a delete of an unknown copy', async () => {
		const records = [
			message(1, {}),
			message(2, { message_id: '1', prev_log_id: '1', body: { text: 'edited' } }),
			message(3, { message_id: '1', prev_log_id: '2', deleted: true, body: undefined }),
			message(4, { message_id: '9', prev_log_id: '8', deleted: true }),
			message(5, {}),
			message(6, { message_id: '5', prev_log_id: '5', room_id: 'elsewhere' }),
		];
		const { outbox, sent, call } = world(records);
		await outbox.drain(call);
		const writes = sent.filter((request) => request.method === 'message').map((request) => request.params);
		expect(writes[1]).toMatchObject({ message_id: '100', room_id: 'ops', body: { text: 'edited' } });
		expect(writes[2]).toEqual({ message_id: '100', room_id: 'ops', deleted: true, ext: { remote: { user_id: 'ada', room_id: 'room', message_id: '1' } } });
		expect(writes[3]).toMatchObject({ room_id: 'ops' });
		expect(writes[4]).toEqual({ message_id: '101', room_id: 'ops', deleted: true, ext: { remote: { user_id: 'ada', room_id: 'room', message_id: '5' } } });
		expect(writes).toHaveLength(5);
	});

	it('never sends the records of remote users, links, or system identities, and still moves past them', async () => {
		const { outbox, sent, call, state } = world([
			message(1, { from: { user_id: 'carol@b.example', ext: { remote: { server: S, user_id: 'carol' } } } }),
			message(2, { from: { user_id: 'link_1', ext: { remote: { server: S } } } }),
			message(3, { from: { user_id: '~room' } }),
		]);
		await outbox.drain(call);
		expect(sent).toEqual([]);
		expect(state.cursor).toBe(3);
	});

	it('maps replies and mentions, outside code', async () => {
		const { outbox, sent, call, state } = world([
			message(1, {}),
			message(2, {
				reply_to: { message_id: '1' },
				body: { text: 'hey @bob and @carol@b.example and @dave, not `@bob`', mentions: ['bob', 'carol@b.example', 'dave'], format: 'markdown' },
			}),
			message(3, { reply_to: { message_id: 'copy-of-carols' } }),
			message(4, { reply_to: { message_id: 'third-servers' } }),
		]);
		state.messages.set('1', { message_id: '1', from: { user_id: 'ada' } });
		state.messages.set('copy-of-carols', { message_id: 'copy-of-carols', from: { user_id: 'carol@b.example' }, ext: { remote: { server: S, user_id: 'carol', message_id: '777' } } });
		state.messages.set('third-servers', { message_id: 'third-servers', from: { user_id: 'eve@c.example' }, ext: { remote: { server: 'ws://c.example/ws', message_id: '5' } } });
		await outbox.drain(call);
		const creates = sent.filter((request) => request.method === 'message');
		expect(creates[1].params.reply_to).toEqual({ message_id: '100' });
		expect(creates[1].params.body).toEqual({ text: 'hey @bob@a.example and @carol and @dave, not `@bob`', format: 'markdown', mentions: ['bob@a.example', 'carol'] });
		// Bob's profile went first, so his ID on the remote server is known.
		expect(sent.find((request) => request.method === 'me' && request.params.ext.remote.user_id === 'bob')).toBeDefined();
		expect(creates[2].params.reply_to).toEqual({ message_id: '777' });
		expect(creates[3].params).not.toHaveProperty('reply_to');
	});

	it('sends reactions to the copy or to the original, and leaves of users it sent', async () => {
		const { outbox, sent, call, state } = world([
			message(1, {}),
			{ room_id: 'room', log_id: 2, kind: 'reactions', record: { message_id: '1', reactions: [{ from: { user_id: 'bob' }, emojis: ['👍'] }, { from: { user_id: 'carol@b.example', ext: { remote: { server: S } } }, emojis: ['x'] }] } },
			{ room_id: 'room', log_id: 3, kind: 'reactions', record: { message_id: 'copy', reactions: [{ from: { user_id: 'ada' }, emojis: [] }] } },
			{ room_id: 'room', log_id: 4, kind: 'membership', record: { members: [{ user: { user_id: 'bob' }, joined: false }, { user: { user_id: 'guest_7' }, joined: false }] } },
		]);
		state.messages.set('1', { message_id: '1', from: { user_id: 'ada' } });
		state.messages.set('copy', { message_id: 'copy', from: { user_id: 'carol@b.example' }, ext: { remote: { server: S, message_id: '777' } } });
		await outbox.drain(call);
		const reactions = sent.filter((request) => request.method === 'reactions').map((request) => request.params);
		expect(reactions).toEqual([
			{ message_id: '100', emojis: ['👍'], ext: { remote: { user_id: 'bob' } } },
			{ message_id: '777', emojis: [], ext: { remote: { user_id: 'ada' } } },
		]);
		// Bob was sent (his reaction), the guest never was.
		expect(sent.filter((request) => request.method === 'room_leave').map((request) => request.params)).toEqual([{ room_id: 'ops', ext: { remote: { user_id: 'bob' } } }]);
	});

	it('moves the copy between two rooms shared with the server, and saves after a create of an edited message', async () => {
		const { outbox, sent, call, state } = world([
			message(1, {}),
			// Moved from `room` to `other`: one record in both rooms.
			message(2, { message_id: '1', prev_log_id: '1', room_id: 'other', prev_room_id: 'room' }, 'room'),
			message(2, { message_id: '1', prev_log_id: '1', room_id: 'other', prev_room_id: 'room' }, 'other'),
			// An edit of a message sent after the pair whose copy this server lost: a create (the remote server finds the copy), then a save.
			message(3, { message_id: '9', prev_log_id: '9', body: { text: 'restored' } }),
		]);
		await outbox.drain(call);
		const writes = sent.filter((request) => request.method === 'message').map((request) => [request.params.message_id, request.params.room_id, request.params.deleted]);
		expect(writes).toEqual([[undefined, 'ops', undefined], ['100', 'ops2', undefined], [undefined, 'ops', undefined], ['101', 'ops', undefined]]);
		expect(state.copies.get('9')).toBe('101');
	});

	it('never sends a record of a room at or before its pair started, nor an edit of a message from before it', async () => {
		const { outbox, sent, call, state } = world([message(5, {}), message(6, { message_id: '3', prev_log_id: '4', body: { text: 'old edited' } }), message(7, {})]);
		state.starts.set('room', 5);
		await outbox.drain(call);
		expect(sent.filter((request) => request.method === 'message').map((request) => request.params.ext.remote.message_id)).toEqual(['7']);
		expect(state.cursor).toBe(7);
	});

	it('sends a changed profile of a user it sent for, before any record', async () => {
		const { outbox, sent, call, state } = world([]);
		state.users.set('ada', { id: 'ada@a.example', name: 'Old' });
		outbox.profilesDue.add('ada');
		outbox.profilesDue.add('bob');
		expect(outbox.behind(0)).toBe(true);
		await outbox.drain(call);
		expect(sent.map((request) => [request.method, request.params.name, request.id.startsWith('fed-0-me-')])).toEqual([['me', 'Ada', true]]);
		expect(outbox.profilesDue.size).toBe(0);
	});

	it('sends a profile again when the name changed', async () => {
		const { outbox, sent, call, state } = world([message(1, {}), message(2, {})]);
		state.users.set('ada', { id: 'ada@a.example', name: 'Old' });
		await outbox.drain(call);
		expect(sent.filter((request) => request.method === 'me')).toHaveLength(1);
		expect(state.users.get('ada')).toEqual({ id: 'ada@a.example', name: 'Ada' });
	});

	it('waits on retry_after without moving, skips a refused record, and drops a pair the link left', async () => {
		const first = world([message(1, {})]);
		first.answers.set('message', () => ({ error: { code: -32002, message: 'slow down', data: { retry_after: 3 } } }));
		await expect(first.outbox.drain(first.call)).rejects.toBeInstanceOf(RetryLater);
		expect(first.state.cursor).toBe(0);

		const second = world([message(1, {}), message(2, {})]);
		second.answers.set('message', (request) => request.params.ext.remote.message_id === '1' ? { error: { code: -32001, message: 'no' } } : { result: { message_id: 'c2' } });
		await second.outbox.drain(second.call);
		expect(second.state.cursor).toBe(2);
		expect(second.state.logs).toEqual(['remote_send_refused']);

		const third = world([message(1, {}), message(2, {}, 'other')]);
		third.answers.set('message', (request) => request.params.room_id === 'ops' ? { error: { code: -32602, message: 'x', data: { ext: { remote: 'not_joined' } } } } : { result: { message_id: 'c' } });
		await third.outbox.drain(third.call);
		expect(third.state.dropped).toEqual(['room']);
		expect(third.state.cursor).toBe(2);
		// This server's own link left a room: its pair goes without sending.
		const fourth = world([message(1, {})]);
		fourth.state.linkIn.delete('room');
		await fourth.outbox.drain(fourth.call);
		expect(fourth.sent).toEqual([]);
		expect(fourth.state.dropped).toEqual(['room']);
	});
});

describe('text', () => {
	it('rewrites mentions by A.3 rules, outside code', () => {
		const ids = new Map([['ada', 'ada@a.example']]);
		expect(rewriteMentions('@ada, @ada. x@ada `@ada` ```\n@ada\n``` @adam', ids)).toBe('@ada@a.example, @ada@a.example. x@ada `@ada` ```\n@ada\n``` @adam');
	});

	it('gives links without server this server', () => {
		expect(addServerToLinks('see apron:?room=ops&message=1 and https://link.apron.chat/#room=x and apron:?server=ws://b/ws&room=y', SELF))
			.toBe('see apron:?server=ws://a.example/ws&room=ops&message=1 and https://link.apron.chat/#server=ws://a.example/ws&room=x and apron:?server=ws://b/ws&room=y');
	});

	it('tells a refusal for a link not in the room', () => {
		expect(linkLeftRoom({ code: -32001, message: 'x', data: { ext: { remote: 'not_joined' } } })).toBe(true);
		expect(linkLeftRoom({ code: -32602, message: 'Unknown room', data: { ext: { remote: 'not_joined' } } })).toBe(true);
		expect(linkLeftRoom({ code: -32001, message: 'Only the original author may edit this message' })).toBe(false);
	});
});
