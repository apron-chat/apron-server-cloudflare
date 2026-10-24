/*
 * The rate limiter every per-minute allowance uses: a token bucket kept as
 * a level and the time it was measured, on the limiter row it counts for.
 *
 * The level is the events still outstanding; it drains at `perMinute` a
 * minute. An event fits while the level stays within `burst`, so a quiet
 * principal may spend `burst` events at once and then `perMinute` a minute,
 * and a refused one learns its exact wait. This is GCRA (the generic cell
 * rate algorithm) counted in events rather than as one theoretical arrival
 * time: a stored time only means something at the rate that set it, while a
 * level drains correctly at whatever rate applies next, as when a poster
 * loses the role that gave them a higher allowance. Two numbers replace a
 * list of timestamps: the same row read and update as a rolling window, with
 * no list to parse, filter or rewrite.
 */

export interface Rate {
	/** Events a minute, sustained. */
	perMinute: number;
	/** Events at once from a whole allowance; `perMinute` when left out. */
	burst?: number;
}

/** A principal's outstanding events (`level`) as of `at`; {0, 0} when never charged. */
export interface Bucket {
	level: number;
	at: number;
}

export type ChargeResult = { bucket: Bucket } | { retryAfterMs: number };

/**
 * Charges `weight` events at `now`. Returns the bucket to store, or the wait
 * before the same charge fits. A weight past the whole burst fits once the
 * bucket is empty, as a rolling window lets one through once it is empty.
 */
export function chargeBucket(bucket: Bucket, now: number, rate: Rate, weight = 1): ChargeResult {
	const perMs = rate.perMinute / 60_000;
	const burst = rate.burst ?? rate.perMinute;
	const level = Math.max(0, bucket.level - Math.max(0, now - bucket.at) * perMs);
	// The same float noise must not refuse an event that drains exactly in time.
	// Measured as of the later time: a clock that went back must not drain the same span again.
	if (level + weight <= burst + 1e-9 || level === 0) return { bucket: { level: level + weight, at: Math.max(now, bucket.at) } };
	// Rounded up to the ms, less float noise (a whole 10,999 computes as 10,999.000001).
	return { retryAfterMs: Math.ceil((weight > burst ? level : level + weight - burst) / perMs - 1e-6) };
}

/** How long a charge can keep mattering after it: the time a whole burst takes to drain. */
export function bucketHorizonMs(rate: Rate): number {
	return Math.ceil((rate.burst ?? rate.perMinute) * 60_000 / rate.perMinute);
}
