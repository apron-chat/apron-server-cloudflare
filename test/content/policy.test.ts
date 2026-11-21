import { describe, expect, it } from 'vitest';
import { contentPolicy } from '../../src/content/policy';

const policy = contentPolicy({
	maxTextBytes: 64, maxEmbeds: 2, ogMediaHosts: [], maxNameBytes: 32, maxNameCodePoints: 16,
	maxSnapshotBytes: 512, reactionEmojisPerUser: 3, roomMetadataBytes: 128,
});

const record = (kind: string, value: Record<string, unknown>) => ({ room_id: 'lobby', log_id: 7, commit_ms: 7, kind, record_json: JSON.stringify(value) }) as Parameters<typeof policy.record>[0];
const message = (value: Record<string, unknown>) => record('message', { message_id: '7', log_id: '7', room_id: 'lobby', from: { user_id: 'ada' }, body: { text: 'hi' }, ...value });
/** The record's value as the policy keeps it; a refusal fails the test. */
const kept = (input: Parameters<typeof policy.record>[0]) => {
	const checked = policy.record(input);
	if (!checked.ok) throw new Error(`refused: ${checked.code} ${checked.message}`);
	return JSON.parse(checked.value.record_json);
};

describe('a record as a post would have made it', () => {
	it('keeps a record a post would make as it is', () => {
		const posted = record('message', { message_id: '7', log_id: '7', room_id: 'lobby', from: { user_id: 'ada' }, body: { text: 'hi', format: 'plain', embeds: [] } });
		expect(policy.record(posted)).toEqual({ ok: true, value: posted });
	});

	it('normalizes a message as a post is: bare users, the body, a reference, a tombstone', () => {
		expect(kept(message({ from: { user_id: 'ada', name: 'Ada', roles: ['admin'] } })).from).toEqual({ user_id: 'ada', name: 'Ada' });
		expect(kept(message({ body: { text: 'hi', mentions: ['bob', 'bob'] } })).body).toEqual({ text: 'hi', format: 'plain', embeds: [], mentions: ['bob'] });
		// A reply keeps only its reference, as a post does.
		expect(kept(message({ reply_to: { message_id: '3', body: { text: 'quoted' } } })).reply_to).toEqual({ message_id: '3' });
		// A tombstone has no body and no ext (§4.4).
		expect(kept(message({ deleted: true, ext: { a: 1 } }))).toEqual({ message_id: '7', log_id: '7', room_id: 'lobby', from: { user_id: 'ada' }, deleted: true });
		// The server's links and terminal output are not the client's content.
		expect(policy.record(message({ prev_log_id: '6', body: { text: '', embeds: [{ kind: 'terminal', output: 'x'.repeat(2_000) }] } })).ok).toBe(true);
	});

	it.each([
		['a user no client could be', message({ from: { user_id: '~server' } }), 'invalid_params'],
		['a body past maxTextBytes', message({ body: { text: 'x'.repeat(65) } }), 'too_large'],
		['more embeds than maxEmbeds', message({ body: { text: 'hi', embeds: [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }] } }), 'denied'],
		['a mention that cannot be a user_id', message({ body: { text: 'hi', mentions: ['not an id'] } }), 'invalid_params'],
		['a snapshot past maxSnapshotBytes', message({ ext: { pad: 'x'.repeat(600) } }), 'too_large'],
		// Drift a post never had: an import used to keep these.
		['a message without a body that is not deleted', message({ body: undefined }), 'invalid_params'],
		['an empty message', message({ body: { text: '' } }), 'invalid_params'],
		['a deleted flag that is not a boolean', message({ deleted: 'yes' }), 'invalid_params'],
		['an ext that is not an object', message({ ext: ['a'] }), 'invalid_params'],
		['a reply without a message_id', message({ reply_to: { quote: 'x' } }), 'invalid_params'],
		['a record that is not a JSON object', { ...message({}), record_json: '[1]' }, 'invalid_params'],
		['a record that is not JSON', { ...message({}), record_json: '{' }, 'invalid_params'],
	])('refuses %s', (_name, value, code) => {
		expect(policy.record(value)).toMatchObject({ ok: false, code });
	});

	it('normalizes an imported reaction set exactly as a post would, and refuses what a post refuses', () => {
		const reactions = (emojis: unknown) => record('reactions', { message_id: '3', reactions: [{ from: { user_id: 'bob', roles: ['mod'] }, emojis }] });
		// Qualified, deduplicated (U+FE0F aside), bare users: what posting the same set keeps.
		expect(kept(reactions(['❤', '❤️', '👍', '👍'])).reactions).toEqual([{ from: { user_id: 'bob' }, emojis: ['❤️', '👍'] }]);
		expect(kept(reactions(['❤', '❤️', '👍', '👍'])).reactions[0].emojis).toEqual(policy.emojis(['❤', '❤️', '👍', '👍']).ok && (policy.emojis(['❤', '❤️', '👍', '👍']) as { value: string[] }).value);
		// An empty set clears a user's reaction, as a post's does.
		expect(kept(reactions([])).reactions[0].emojis).toEqual([]);
		for (const [emojis, code] of [
			[['👍', '❤', '🎉', '🚀'], 'denied'],
			[['x'.repeat(65)], 'too_large'],
			[['👍\u0007'], 'invalid_params'],
			[[''], 'invalid_params'],
			['👍', 'invalid_params'],
			[undefined, 'invalid_params'],
		] as const) {
			expect(policy.record(reactions(emojis)), JSON.stringify(emojis)).toMatchObject({ ok: false, code });
			expect(policy.emojis(emojis)).toMatchObject({ ok: false, code });
		}
	});

	it('refuses a room record a room_set would refuse', () => {
		const room = (value: Record<string, unknown>) => record('room', { room_id: 'lobby', log_id: '7', ...value });
		expect(policy.record(room({ title: 'Lobby', description: 'Hi' })).ok).toBe(true);
		expect(policy.record(room({ title: 'x'.repeat(200) }))).toMatchObject({ ok: false, code: 'too_large', message: 'room metadata is too large' });
		expect(policy.record(room({ title: 5 }))).toMatchObject({ ok: false, code: 'invalid_params', message: 'title must be a string' });
		expect(policy.record(room({ description: [] }))).toMatchObject({ ok: false, code: 'invalid_params', message: 'description must be a string' });
		expect(policy.record(room({ ext: 'x' }))).toMatchObject({ ok: false, code: 'invalid_params', message: 'ext must be an object' });
		// Delivery fields are no client fields: a long history_log_id never counts.
		expect(policy.record(room({ title: 'Lobby', latest_log_id: '9'.repeat(200) })).ok).toBe(true);
	});

	it('takes membership records with users a client could be', () => {
		expect(kept(record('membership', { members: [{ user: { user_id: 'ada', name: 'Ada', tier: 'registered' }, joined: true }] })).members)
			.toEqual([{ user: { user_id: 'ada', name: 'Ada' }, joined: true }]);
		expect(policy.record(record('membership', { members: [{ user: { user_id: 'a b' }, joined: true }] }))).toMatchObject({ ok: false, code: 'invalid_params' });
	});
});

describe('the parts a post calls', () => {
	it('bounds a snapshot and a room\'s fields by the same limits as a record', () => {
		expect(policy.snapshot({ body: { text: 'x'.repeat(400) } })).toEqual({ ok: true, value: undefined });
		expect(policy.snapshot({ body: { text: 'x'.repeat(600) } })).toEqual({ ok: false, code: 'too_large', message: 'message snapshot is too large' });
		expect(policy.roomFields({ title: 'x'.repeat(100) }).ok).toBe(true);
		expect(policy.roomFields({ title: 'x'.repeat(200) })).toEqual({ ok: false, code: 'too_large', message: 'room metadata is too large' });
		expect(policy.body({ text: 'hi' })).toEqual({ ok: true, value: { text: 'hi', format: 'plain', embeds: [] } });
		expect(policy.sharedText({ text: 'a', format: 'markdown' }, { text: 'b' })).toEqual({ ok: true, value: { text: 'b', format: 'markdown' } });
	});
});
