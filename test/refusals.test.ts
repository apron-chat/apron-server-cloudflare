import { describe, expect, it } from 'vitest';
import { RefusalMeter, type RefusalKind } from '../src/refusals';

function meter(windowMs = 60_000, maxKeys = 128) {
	const written: Array<[RefusalKind, string, string, number]> = [];
	return { written, meter: new RefusalMeter((...point) => { written.push(point); }, windowMs, maxKeys) };
}

describe('RefusalMeter', () => {
	it('writes the first refusal of a key at once, and its repeats as one point after the window', () => {
		const { written, meter: refusals } = meter();
		refusals.note('error', 'Posting limit reached', 'message', 1_000);
		expect(written).toEqual([['error', 'Posting limit reached', 'message', 1]]);
		for (let index = 0; index < 5; index += 1) refusals.note('error', 'Posting limit reached', 'message', 2_000 + index);
		expect(written).toHaveLength(1);
		refusals.flush(30_000);
		expect(written).toHaveLength(1);
		refusals.flush(61_000);
		expect(written).toEqual([['error', 'Posting limit reached', 'message', 1], ['error', 'Posting limit reached', 'message', 5]]);
		// A new window writes the key's first refusal at once again.
		refusals.note('error', 'Posting limit reached', 'message', 62_000);
		expect(written.at(-1)).toEqual(['error', 'Posting limit reached', 'message', 1]);
	});

	it('keeps kinds, reasons and details apart', () => {
		const { written, meter: refusals } = meter();
		refusals.note('error', 'retry_after', 'history', 0);
		refusals.note('error', 'retry_after', 'message', 0);
		refusals.note('close', '1008 Frame rate limit reached', '', 0);
		refusals.note('http', '429 Demo capacity reached', 'upgrade', 0);
		expect(written.map(([, , , count]) => count)).toEqual([1, 1, 1, 1]);
	});

	it('counts keys past its bound under one overflow key, and bounds what it writes', () => {
		const { written, meter: refusals } = meter(60_000, 2);
		for (let index = 0; index < 50; index += 1) refusals.note('error', `reason ${index}`, '', 0);
		refusals.flush(60_000);
		expect(written.filter(([, reason]) => reason !== 'overflow')).toHaveLength(2);
		const overflow = written.filter(([, reason]) => reason === 'overflow');
		expect(overflow.reduce((sum, [, , , count]) => sum + count, 0)).toBe(48);
		expect(overflow).toHaveLength(2);
	});

	it('cuts long reasons and details, and never throws from its writer', () => {
		const long = 'x'.repeat(500);
		const seen: string[] = [];
		const refusals = new RefusalMeter((_kind, reason, detail) => { seen.push(reason, detail); throw new Error('dataset down'); });
		expect(() => refusals.note('close', long, long, 0)).not.toThrow();
		expect(seen).toHaveLength(2);
		expect(seen.every((part) => part.length === 96)).toBe(true);
	});
});
