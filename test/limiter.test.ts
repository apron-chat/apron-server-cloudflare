import { describe, expect, it } from 'vitest';
import { bucketHorizonMs, chargeBucket, type Bucket, type ChargeResult } from '../src/limiter';

const empty: Bucket = { level: 0, at: 0 };

function bucket(result: ChargeResult): Bucket {
	if (!('bucket' in result)) throw new Error(`refused for ${result.retryAfterMs} ms`);
	return result.bucket;
}

describe('token bucket limiter', () => {
	it('spends a whole burst at once, then refuses with the exact wait for one step', () => {
		const rate = { perMinute: 20, burst: 60 };
		let state = empty;
		for (let index = 0; index < 60; index++) state = bucket(chargeBucket(state, 1_000, rate));
		expect(chargeBucket(state, 1_000, rate)).toEqual({ retryAfterMs: 3_000 });
		expect(chargeBucket(state, 3_999, rate)).toEqual({ retryAfterMs: 1 });
		state = bucket(chargeBucket(state, 4_000, rate));
		// Sustained: one every 3 s.
		expect(chargeBucket(state, 4_000, rate)).toEqual({ retryAfterMs: 3_000 });
	});

	it('defaults the burst to a minute of the rate, as a rolling minute allows', () => {
		let state = empty;
		for (let index = 0; index < 5; index++) state = bucket(chargeBucket(state, 0, { perMinute: 5 }));
		expect(chargeBucket(state, 0, { perMinute: 5 })).toEqual({ retryAfterMs: 12_000 });
		// A minute later the bucket is empty again.
		expect(bucket(chargeBucket(state, 60_000, { perMinute: 5 })).level).toBe(1);
	});

	it('charges a weight at once, and lets a weight past the whole burst through only when empty', () => {
		const rate = { perMinute: 10 };
		const half = bucket(chargeBucket(empty, 0, rate, 4));
		expect(half.level).toBe(4);
		expect(chargeBucket(half, 0, rate, 7)).toEqual({ retryAfterMs: 6_000 });
		// 30 at once: waits until the 4 outstanding have drained, then fits.
		expect(chargeBucket(half, 0, rate, 30)).toEqual({ retryAfterMs: 24_000 });
		const big = bucket(chargeBucket(half, 24_000, rate, 30));
		expect(big.level).toBe(30);
		// Then 21 must drain before one more fits in the burst of 10.
		expect(chargeBucket(big, 24_000, rate)).toEqual({ retryAfterMs: 126_000 });
	});

	it('drains in events whatever rate applies next, so a lower allowance counts what was spent at a higher one', () => {
		let state = empty;
		for (let index = 0; index < 20; index++) state = bucket(chargeBucket(state, 0, { perMinute: 50 }));
		// Twenty spent: a 20-a-minute allowance is full, not 40% used.
		expect(chargeBucket(state, 0, { perMinute: 20 })).toEqual({ retryAfterMs: 3_000 });
	});

	it('ignores a clock that went back, and bounds how long a charge matters', () => {
		const state = bucket(chargeBucket(empty, 10_000, { perMinute: 1 }));
		expect(chargeBucket(state, 5_000, { perMinute: 1 })).toEqual({ retryAfterMs: 60_000 });
		// A charge that fits while the clock is behind keeps the later time, so it drains nothing twice.
		const rate = { perMinute: 60, burst: 2 };
		const behind = bucket(chargeBucket(bucket(chargeBucket(empty, 10_000, rate)), 5_000, rate));
		expect(behind).toEqual({ level: 2, at: 10_000 });
		expect(chargeBucket(behind, 10_000, rate)).toEqual({ retryAfterMs: 1_000 });
		expect(bucketHorizonMs({ perMinute: 20, burst: 60 })).toBe(180_000);
		expect(bucketHorizonMs({ perMinute: 30 })).toBe(60_000);
	});
});
