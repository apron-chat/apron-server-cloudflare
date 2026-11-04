import { expect, it } from 'vitest';
import { Deadline } from '../src/deadline';

it('keeps the earliest time noted, recomputes exactly, and reports when it has passed', () => {
	const deadline = new Deadline();
	expect(deadline.at).toBeUndefined();
	expect(deadline.passed(Number.MAX_SAFE_INTEGER)).toBe(false);
	expect(deadline.isSooner(Number.POSITIVE_INFINITY)).toBe(false);
	expect(deadline.soonest(200)).toBe(true);
	expect(deadline.soonest(300)).toBe(false);
	expect(deadline.soonest(100)).toBe(true);
	expect(deadline.at).toBe(100);
	expect(deadline.passed(99)).toBe(false);
	expect(deadline.passed(100)).toBe(true);
	// Recomputed from what is open now, it may move later, or to none.
	expect(deadline.set(500)).toBe(true);
	expect(deadline.set(500)).toBe(false);
	expect(deadline.set(undefined)).toBe(true);
	expect(deadline.at).toBeUndefined();
	deadline.soonest(10);
	deadline.clear();
	expect(deadline.at).toBeUndefined();
});
