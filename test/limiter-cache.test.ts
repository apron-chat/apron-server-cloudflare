import { describe, expect, it } from 'vitest';
import { LIMITER_FLUSH_MS, LimiterCache, type RawLimitRow } from '../src/limiter-cache';

/** A stand-in for the store's limiter row write, recording each one. */
function host() {
	const writes: { key: string; posts_day: number; at: number }[] = [];
	return { writes, cacheHost: { write(row: RawLimitRow, now: number) { writes.push({ key: row.principal_key, posts_day: row.posts_day, at: now }); } } };
}

const noon = Date.parse('2026-09-21T12:00:00Z');

function row(principalKey: string, postsDay = 0, scope = 'history'): RawLimitRow {
	return { scope, principal_key: principalKey, level: 0, level_ms: 0, day: '2026-09-21', posts_day: postsDay, registrations_day: 0, uploads_day: 0, updated_ms: noon };
}

/** Charges one more to the cached row's day count at `now`. */
function charge(cache: LimiterCache, principalKey: string, now: number): void {
	const current = cache.get('history', principalKey)!;
	cache.change({ ...current, posts_day: current.posts_day + 1 }, now);
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

	it('keeps a loaded row\'s changes in memory within a minute of its last write, and writes them a minute on', () => {
		const { writes, cacheHost } = host();
		const cache = new LimiterCache(cacheHost);
		cache.loaded(row('user:reader', 1), noon);
		charge(cache, 'user:reader', noon + 1_000);
		charge(cache, 'user:reader', noon + LIMITER_FLUSH_MS - 1);
		expect(writes).toEqual([]);
		expect(cache.peek('history', 'user:reader')?.posts_day).toBe(3);
		charge(cache, 'user:reader', noon + LIMITER_FLUSH_MS);
		expect(writes).toEqual([{ key: 'user:reader', posts_day: 4, at: noon + LIMITER_FLUSH_MS }]);
		// The write moves `updated_ms`, and starts the next minute.
		expect(cache.peek('history', 'user:reader')?.updated_ms).toBe(noon + LIMITER_FLUSH_MS);
		charge(cache, 'user:reader', noon + LIMITER_FLUSH_MS + 1_000);
		expect(writes).toHaveLength(1);
	});

	it('writes a new row\'s first charge through, and holds the next', () => {
		const { writes, cacheHost } = host();
		const cache = new LimiterCache(cacheHost);
		cache.created(row('user:reader'), noon);
		charge(cache, 'user:reader', noon);
		charge(cache, 'user:reader', noon + 1_000);
		expect(writes).toEqual([{ key: 'user:reader', posts_day: 1, at: noon }]);
	});

	it('writes through on a new UTC day, however recent the last write', () => {
		const { writes, cacheHost } = host();
		const cache = new LimiterCache(cacheHost);
		const lateNight = Date.parse('2026-09-21T23:59:50Z');
		cache.loaded(row('user:reader', 5), lateNight);
		charge(cache, 'user:reader', lateNight + 5_000);
		expect(writes).toEqual([]);
		charge(cache, 'user:reader', lateNight + 15_000);
		expect(writes).toEqual([{ key: 'user:reader', posts_day: 7, at: lateNight + 15_000 }]);
	});

	it('writes the least recently used row past the cap only if it holds changes', () => {
		const { writes, cacheHost } = host();
		const cache = new LimiterCache(cacheHost, 2);
		cache.loaded(row('user:a'), noon);
		cache.loaded(row('user:b'), noon);
		charge(cache, 'user:a', noon + 1_000);
		// `a` is now the most recently used: `b`, clean, goes unwritten.
		cache.loaded(row('user:c'), noon);
		expect(cache.peek('history', 'user:b')).toBeUndefined();
		expect(writes).toEqual([]);
		charge(cache, 'user:c', noon + 2_000);
		// `a` holds a charge it has not written: written as it goes.
		cache.loaded(row('user:d'), noon + 3_000);
		expect(cache.peek('history', 'user:a')).toBeUndefined();
		expect(writes).toEqual([{ key: 'user:a', posts_day: 1, at: noon + 3_000 }]);
		expect(cache.size).toBe(2);
	});

	it('writes out a row before the store moves it, and drops a deleted one unwritten', () => {
		const { writes, cacheHost } = host();
		const cache = new LimiterCache(cacheHost);
		cache.loaded(row('user:a'), noon);
		cache.loaded(row('user:b'), noon);
		cache.loaded(row('user:b', 0, 'post'), noon);
		charge(cache, 'user:a', noon + 1_000);
		cache.writeOut('history', 'user:a', noon + 2_000);
		expect(writes).toEqual([{ key: 'user:a', posts_day: 1, at: noon + 2_000 }]);
		cache.dropPrincipal('user:b');
		expect(cache.size).toBe(0);
		expect(writes).toHaveLength(1);
	});

	it('restores what a rolled-back transaction changed, rows it evicted too, and keeps what a committed one did', () => {
		const { writes, cacheHost } = host();
		const cache = new LimiterCache(cacheHost, 2);
		cache.loaded(row('user:a'), noon);
		cache.loaded(row('user:b'), noon);
		charge(cache, 'user:a', noon + 1_000);
		cache.begin();
		charge(cache, 'user:b', noon + 2_000);
		// Evicts `a`, writing its charge: the rollback undoes that write, so `a` must come back holding it.
		cache.loaded(row('user:c'), noon + 2_000);
		expect(writes).toHaveLength(1);
		cache.rollback();
		expect(cache.peek('history', 'user:a')?.posts_day).toBe(1);
		expect(cache.peek('history', 'user:b')?.posts_day).toBe(0);
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
