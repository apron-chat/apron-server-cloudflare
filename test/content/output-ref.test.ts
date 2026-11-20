import { describe, expect, it } from 'vitest';
import { asPublic, withoutOutputs } from '../../src/history/records';
import { refsOf, withoutOutputRefs } from '../../src/content/output-ref';

const record = (embeds: unknown[]) => ({ room_id: 'general', log_id: 5, commit_ms: 5, kind: 'message' as const, record_json: JSON.stringify({ message_id: '5', log_id: '5', room_id: 'general', from: { user_id: 'ada' }, body: { text: '', embeds } }) });
const ref = { kind: 'terminal', title: 'build', output_ref: { key: 'f/AAAAAAAAAAAAAAAAAAAAAA', bytes: 8 } };

describe('internal output references', () => {
	it('are found by one check, and dropped without output put back', () => {
		expect(refsOf(record([ref]))).toBeDefined();
		expect(refsOf(record([{ kind: 'link', title: 'output_ref' }]))).toBeUndefined();
		expect(refsOf({ ...record([ref]), kind: 'reactions' })).toBeUndefined();
		const dropped = withoutOutputRefs(record([ref]));
		expect(JSON.parse(dropped.record_json).body.embeds).toEqual([{ kind: 'terminal', title: 'build' }]);
		expect(withoutOutputRefs(record([]))).toEqual(record([]));
	});

	it('never leave as public records: one still holding a reference is an error', async () => {
		expect(() => asPublic([record([ref])])).toThrow(/still holds an internal output reference/);
		const published = await withoutOutputs([record([ref])]);
		expect(refsOf(published[0])).toBeUndefined();
	});
});
