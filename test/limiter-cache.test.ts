import { describe, expect, it } from 'vitest';
import { LIMITER_FLUSH_MS, LIMITER_UNWRITTEN_EVENTS, LimiterCache, type RawLimitRow } from '../src/limiter-cache';

/** A stand-in for the store's limiter row write, recording each one. */
function host() {
	const writes: { key: string; posts_day: number; at: number }[] = [];
	return { writes, cacheHost: { write(row: RawLimitRow, now: number) { writes.push({ key: row.principal_key, posts_day: row.posts_day, at: now }); } } };
}

const noon = Date.parse('2026-09-21T12:00:00Z');

function row(principalKey: string, postsDay = 0, scope = 'history'): RawLimitRow {
	return { scope, principal_key: principalKey, level: 0, level_ms: 0, day: '2026-09-21', posts_day: postsDay, registrations_day: 0, uploads_day: 0, updated_ms: noon };
}

/** Caches a row and charges it once, which writes it: it then holds charges within a minute. */
function warm(cache: LimiterCache, principalKey: string, now: number): void {
	cache.loaded(row(principalKey), now);
	charge(cache, principalKey, now);
}

/** Charges `weight` more to the cached row's day count at `now`. */
function charge(cache: LimiterCache, principalKey: string, now: number, weight = 1): void {
	const current = cache.get('history', principalKey)!;
	cache.change({ ...current, posts_day: current.posts_day + weight }, now, weight);
}

describe('limiter cache', () => {
	it('holds a principal\'s rows in the minute-limited scopes, never a server-wide one', () => {
		const cache = new LimiterCache(host().cacheHost);
		expect(cache.covers('history', 'user:reader')).toBe(true);
		expect(cache.covers('history', 'global')).toBe(false);
		expect(cache.covers('upload', 'user:reader')).toBe(false);
		cache.loaded(row('global'), noon);
		cache.loaded(row('user:reader', 0, 'upload'), noon);
		expect(cache.size).toBe(0);
	});

	it('writes a loaded row\'s first charge through, and holds the next within a minute of it, writing them a minute on', () => {
		const { writes, cacheHost } = host();
		const cache = new LimiterCache(cacheHost);
		cache.loaded(row('user:reader', 1), noon);
		charge(cache, 'user:reader', noon);
		expect(writes).toEqual([{ key: 'user:reader', posts_day: 2, at: noon }]);
		charge(cache, 'user:reader', noon + 1_000);
		charge(cache, 'user:reader', noon + LIMITER_FLUSH_MS - 1);
		expect(writes).toHaveLength(1);
		expect(cache.peek('history', 'user:reader')?.posts_day).toBe(4);
		charge(cache, 'user:reader', noon + LIMITER_FLUSH_MS);
		expect(writes[1]).toEqual({ key: 'user:reader', posts_day: 5, at: noon + LIMITER_FLUSH_MS });
		// The write moves `updated_ms`, and starts the next minute.
		expect(cache.peek('history', 'user:reader')?.updated_ms).toBe(noon + LIMITER_FLUSH_MS);
		charge(cache, 'user:reader', noon + LIMITER_FLUSH_MS + 1_000);
		expect(writes).toHaveLength(2);
	});

	it('writes once it would hold LIMITER_UNWRITTEN_EVENTS events unwritten, counting a charge\'s weight', () => {
		const { writes, cacheHost } = host();
		const cache = new LimiterCache(cacheHost);
		cache.loaded(row('user:reader'), noon);
		for (let index = 1; index <= 1 + 2 * LIMITER_UNWRITTEN_EVENTS; index++) charge(cache, 'user:reader', noon + index);
		// The first, then every LIMITER_UNWRITTEN_EVENTS-th after it.
		expect(writes.map((write) => write.posts_day)).toEqual([1, 1 + LIMITER_UNWRITTEN_EVENTS, 1 + 2 * LIMITER_UNWRITTEN_EVENTS]);
		charge(cache, 'user:reader', noon + 100);
		charge(cache, 'user:reader', noon + 101, LIMITER_UNWRITTEN_EVENTS - 1);
		expect(writes.at(-1)?.posts_day).toBe(2 + 2 * LIMITER_UNWRITTEN_EVENTS + LIMITER_UNWRITTEN_EVENTS - 1);
		// A charge that alone reaches it is written however recent the last write.
		charge(cache, 'user:reader', noon + 102, LIMITER_UNWRITTEN_EVENTS);
		expect(writes).toHaveLength(5);
	});

	it('writes through on a new UTC day, however recent the last write', () => {
		const { writes, cacheHost } = host();
		const cache = new LimiterCache(cacheHost);
		const lateNight = Date.parse('2026-09-21T23:59:50Z');
		cache.loaded(row('user:reader', 5), lateNight);
		charge(cache, 'user:reader', lateNight);
		charge(cache, 'user:reader', lateNight + 5_000);
		expect(writes).toEqual([{ key: 'user:reader', posts_day: 6, at: lateNight }]);
		charge(cache, 'user:reader', lateNight + 15_000);
		expect(writes[1]).toEqual({ key: 'user:reader', posts_day: 8, at: lateNight + 15_000 });
	});

	it('forgets at most a few events of a row through each eviction, so a daily cap holds within its bound', () => {
		// Each cycle is a new instance over the same stored row: an eviction.
		const cap = 10;
		let stored = row('user:reader');
		let served = 0;
		for (let cycle = 0; cycle < 20; cycle++) {
			const cache = new LimiterCache({ write(next) { stored = { ...next }; } });
			cache.loaded(stored, noon + cycle * 15_000);
			for (let index = 0; index < 50; index++) {
				if (cache.get('history', 'user:reader')!.posts_day >= cap) break;
				charge(cache, 'user:reader', noon + cycle * 15_000 + index);
				served += 1;
			}
		}
		expect(served).toBeLessThanOrEqual(cap + 6);
		// Stopping short of the cap each time forgets at most LIMITER_UNWRITTEN_EVENTS - 1 a wake, for one written.
		stored = row('user:other');
		served = 0;
		for (let cycle = 0; cycle < 100; cycle++) {
			const cache = new LimiterCache({ write(next) { stored = { ...next }; } });
			cache.loaded(stored, noon + cycle * 15_000);
			for (let index = 0; index < LIMITER_UNWRITTEN_EVENTS; index++) {
				if (cache.get('history', 'user:other')!.posts_day >= cap) break;
				charge(cache, 'user:other', noon + cycle * 15_000 + index);
				served += 1;
			}
		}
		expect(served).toBeLessThanOrEqual(LIMITER_UNWRITTEN_EVENTS * cap);
	});

	it('writes the least recently used row past the cap only if it holds changes', () => {
		const { writes, cacheHost } = host();
		const cache = new LimiterCache(cacheHost, 2);
		warm(cache, 'user:a', noon);
		warm(cache, 'user:b', noon);
		writes.length = 0;
		charge(cache, 'user:a', noon + 1_000);
		// `a` is now the most recently used: `b`, clean, goes unwritten.
		cache.loaded(row('user:c'), noon);
		expect(cache.peek('history', 'user:b')).toBeUndefined();
		expect(writes).toEqual([]);
		charge(cache, 'user:c', noon + 2_000);
		// `a` holds a charge it has not written: written as it goes.
		cache.loaded(row('user:d'), noon + 3_000);
		expect(cache.peek('history', 'user:a')).toBeUndefined();
		expect(writes.filter((write) => write.key === 'user:a')).toEqual([{ key: 'user:a', posts_day: 2, at: noon + 3_000 }]);
		expect(cache.size).toBe(2);
	});

	it('writes out a row before the store moves it, and drops a deleted one unwritten', () => {
		const { writes, cacheHost } = host();
		const cache = new LimiterCache(cacheHost);
		warm(cache, 'user:a', noon);
		cache.loaded(row('user:b'), noon);
		cache.loaded(row('user:b', 0, 'post'), noon);
		writes.length = 0;
		charge(cache, 'user:a', noon + 1_000);
		expect(cache.writeOut('history', 'user:a', noon + 2_000)).toBe(true);
		expect(writes).toEqual([{ key: 'user:a', posts_day: 2, at: noon + 2_000 }]);
		// Nothing unwritten: uncached without a write.
		expect(cache.writeOut('history', 'user:b', noon + 2_000)).toBe(false);
		cache.dropPrincipal('user:b');
		expect(cache.size).toBe(0);
		expect(writes).toHaveLength(1);
	});

	it('keeps, written, a row cleanup would delete only while it holds changes made since the cutoff', () => {
		const { writes, cacheHost } = host();
		const cache = new LimiterCache(cacheHost);
		warm(cache, 'user:recent', noon);
		warm(cache, 'user:stale', noon);
		warm(cache, 'user:clean', noon);
		writes.length = 0;
		charge(cache, 'user:recent', noon + 30_000);
		charge(cache, 'user:stale', noon + 1_000);
		expect(cache.keepIfChanged('history', 'user:recent', noon + 10_000, noon + 40_000)).toBe(true);
		expect(writes).toEqual([{ key: 'user:recent', posts_day: 2, at: noon + 40_000 }]);
		expect(cache.keepIfChanged('history', 'user:stale', noon + 10_000, noon + 40_000)).toBe(false);
		expect(cache.keepIfChanged('history', 'user:clean', noon + 10_000, noon + 40_000)).toBe(false);
		expect(writes).toHaveLength(1);
		expect(cache.size).toBe(0);
	});

	it('restores what a rolled-back transaction changed, rows it evicted too, and keeps what a committed one did', () => {
		const { writes, cacheHost } = host();
		const cache = new LimiterCache(cacheHost, 2);
		warm(cache, 'user:a', noon);
		warm(cache, 'user:b', noon);
		writes.length = 0;
		charge(cache, 'user:a', noon + 1_000);
		cache.begin();
		charge(cache, 'user:b', noon + 2_000);
		// Evicts `a`, writing its charge: the rollback undoes that write, so `a` must come back holding it.
		cache.loaded(row('user:c'), noon + 2_000);
		expect(writes).toHaveLength(1);
		cache.rollback();
		expect(cache.peek('history', 'user:a')?.posts_day).toBe(2);
		expect(cache.peek('history', 'user:b')?.posts_day).toBe(1);
		expect(cache.peek('history', 'user:c')).toBeUndefined();
		expect(cache.size).toBe(2);
		// Still unwritten, as far as the cache knows: a later eviction writes it again.
		cache.loaded(row('user:d'), noon + 3_000);
		cache.loaded(row('user:e'), noon + 3_000);
		expect(writes.filter((write) => write.key === 'user:a')).toHaveLength(2);

		cache.begin();
		charge(cache, 'user:e', noon + 4_000);
		cache.commit();
		cache.begin();
		cache.rollback();
		expect(cache.peek('history', 'user:e')?.posts_day).toBe(1);
	});
});
