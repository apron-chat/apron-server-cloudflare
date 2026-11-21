import { describe, expect, it } from 'vitest';
import { contentBytes, hasAppend, messageContent, sharesText, withEditedBy, withoutOutputs } from '../../src/content/snapshot';
import { asPublic, withoutOutputs as publicWithoutOutputs } from '../../src/history/records';
import { refsOf, withoutOutputRefs } from '../../src/content/output-ref';

const snapshot = { message_id: '5', log_id: '5', room_id: 'general', from: { user_id: 'ada' }, body: { text: 'hi', embeds: [] as unknown[] } };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe('what a snapshot holds of its author\'s, and what the server adds', () => {
	it('counts client content only: no links to the previous snapshot, no terminal output', () => {
		expect(contentBytes(snapshot)).toBe(bytes(snapshot));
		expect(contentBytes({ ...snapshot, prev_log_id: '4', prev_room_id: 'hall' })).toBe(bytes(snapshot));
		const terminal = { kind: 'terminal', title: 'build' };
		const withOutput = { ...snapshot, body: { text: '', embeds: [{ ...terminal, output: 'x'.repeat(10_000) }] } };
		const withRef = { ...snapshot, body: { text: '', embeds: [{ ...terminal, output_ref: { key: 'f/k', bytes: 9 } }] } };
		const bare = { ...snapshot, body: { text: '', embeds: [terminal] } };
		expect(contentBytes(withOutput)).toBe(bytes(bare));
		expect(contentBytes(withRef)).toBe(bytes(bare));
	});

	it('removes outputs and refs without touching other embeds, and returns a snapshot without them as it is', () => {
		const kept = { ...snapshot, body: { text: '', embeds: [{ kind: 'link' }, 'odd'] } };
		expect(withoutOutputs(kept)).toBe(kept);
		const mixed = { ...snapshot, body: { text: '', embeds: [{ kind: 'link' }, { kind: 'terminal', output: 'o', output_ref: { key: 'k', bytes: 1 } }] } };
		expect(withoutOutputs(mixed).body.embeds).toEqual([{ kind: 'link' }, { kind: 'terminal' }]);
		expect(mixed.body.embeds[1]).toHaveProperty('output');
	});

	it('takes a snapshot\'s content as body, reply, deletion and ext', () => {
		expect(messageContent({ ...snapshot, reply_to: { message_id: '1' }, ext: { a: 1 }, prev_log_id: '4' }))
			.toEqual({ body: snapshot.body, reply_to: { message_id: '1' }, deleted: false, ext: { a: 1 } });
		expect(messageContent({ deleted: true }).deleted).toBe(true);
	});

	it('knows an append embed writes into the text', () => {
		expect(hasAppend({ body: { embeds: [{ kind: 'append' }] } })).toBe(true);
		expect(hasAppend({ body: { embeds: [{ kind: 'terminal' }] } })).toBe(false);
		expect(hasAppend({})).toBe(false);
	});
});

describe('ext:editors', () => {
	const shared = { ext: { editors: { 'body.text': 'mentioned' } }, body: { mentions: ['bob'] } };

	it.each([
		['a mentioned user of a shared message', shared, 'bob', true],
		['a user it does not mention', shared, 'eve', false],
		['a tombstone', { ...shared, deleted: true }, 'bob', false],
		['another grant', { ...shared, ext: { editors: { 'body.text': 'everyone' } } }, 'bob', false],
		['no grant', { body: { mentions: ['bob'] } }, 'bob', false],
		['no mentions', { ext: shared.ext }, 'bob', false],
	])('shares the text with %s: %s', (_name, value, userId, shares) => {
		expect(sharesText(value, userId)).toBe(shares);
	});

	it('sets edited_by on another\'s save and removes it on the sender\'s', () => {
		expect(withEditedBy({ editors: { 'body.text': 'mentioned' } }, 'bob')).toEqual({ editors: { 'body.text': 'mentioned', edited_by: 'bob' } });
		expect(withEditedBy({ editors: { 'body.text': 'mentioned', edited_by: 'bob' } }, undefined)).toEqual({ editors: { 'body.text': 'mentioned' } });
		expect(withEditedBy({ x: 1, editors: { edited_by: 'bob' } }, undefined)).toEqual({ x: 1 });
		expect(withEditedBy({ editors: { edited_by: 'bob' } }, undefined)).toBeUndefined();
		const untouched = { editors: { 'body.text': 'mentioned' } };
		expect(withEditedBy(untouched, undefined)).toBe(untouched);
		expect(withEditedBy(undefined, 'bob')).toBeUndefined();
		expect(withEditedBy({ a: 1 }, 'bob')).toEqual({ a: 1 });
	});
});

const stored = (embeds: unknown[]) => ({ room_id: 'general', log_id: 5, commit_ms: 5, kind: 'message' as const, record_json: JSON.stringify({ message_id: '5', log_id: '5', room_id: 'general', from: { user_id: 'ada' }, body: { text: '', embeds } }) });
const refEmbed = { kind: 'terminal', title: 'build', output_ref: { key: 'f/AAAAAAAAAAAAAAAAAAAAAA', bytes: 8 } };

describe('internal output references', () => {
	it('are found by one check, and dropped without output put back', () => {
		expect(refsOf(stored([refEmbed]))).toBeDefined();
		expect(refsOf(stored([{ kind: 'link', title: 'output_ref' }]))).toBeUndefined();
		expect(refsOf({ ...stored([refEmbed]), kind: 'reactions' })).toBeUndefined();
		const dropped = withoutOutputRefs(stored([refEmbed]));
		expect(JSON.parse(dropped.record_json).body.embeds).toEqual([{ kind: 'terminal', title: 'build' }]);
		expect(withoutOutputRefs(stored([]))).toEqual(stored([]));
	});

	it('never leave as public records: one still holding a reference is an error', async () => {
		expect(() => asPublic([stored([refEmbed])])).toThrow(/still holds an internal output reference/);
		const published = await publicWithoutOutputs([stored([refEmbed])]);
		expect(refsOf(published[0])).toBeUndefined();
	});
});
