import { describe, expect, it } from 'vitest';
import { NOT_STALLED, stallAlert, stallCleared, stallFailed, stallFromFields, stallToFields } from '../../src/history/stall';

describe('a hop\'s stall', () => {
	it('starts at the first failure, keeps its start through more, and alerts once after its time', () => {
		const stalled = stallFailed(NOT_STALLED, 100, 'copy');
		expect(stalled).toEqual({ kind: 'stalled', since: 100, step: 'copy' });
		expect(stallFailed(stalled, 500, 'trim')).toBe(stalled);
		expect(stallAlert(stalled, 150, 100)).toBeUndefined();
		const alerted = stallAlert(stalled, 200, 100)!;
		expect(alerted).toEqual({ kind: 'alerted', since: 100, step: 'copy', at: 200 });
		// Told once: an alerted stall is never due again.
		expect(stallAlert(alerted, 900, 100)).toBeUndefined();
	});

	it('ends on a copy, or on the step that started it, but not on another step that works', () => {
		const copying = stallFailed(NOT_STALLED, 1, 'copy');
		// A trim that works says nothing of a copy that keeps failing.
		expect(stallCleared(copying, 'trim')).toBe(copying);
		expect(stallCleared(copying, 'copy')).toEqual(NOT_STALLED);
		const targeting = stallFailed(NOT_STALLED, 1, 'target');
		expect(stallCleared(targeting, 'trim')).toBe(targeting);
		expect(stallCleared(targeting, 'target')).toEqual(NOT_STALLED);
		expect(stallCleared(targeting, 'copy')).toEqual(NOT_STALLED);
	});

	it('is kept as fields, and read back as it was', () => {
		const alerted = { kind: 'alerted', since: 1, step: 'deliver', at: 2 } as const;
		expect(stallFromFields(stallToFields(alerted))).toEqual(alerted);
		expect(stallToFields(NOT_STALLED)).toEqual({});
		// Fields that do not make a stall (no step, or one it does not know) read as none: the next failure stalls afresh.
		expect(stallFromFields({ stalledSince: 5, stalledOn: 'rebuild' as never })).toEqual(NOT_STALLED);
		expect(stallFromFields({ stalledSince: 5 })).toEqual(NOT_STALLED);
		expect(stallFromFields({})).toEqual(NOT_STALLED);
	});
});
