import { describe, expect, it } from 'vitest';
import { activeUsersConfigured, activeUsersLine, fetchActiveUsers } from '../src/active-users';

const env = { ACCOUNT_ID: 'account-1', ACCOUNT_ANALYTICS_TOKEN: 'token-1', METRICS_DATASET: 'apron_server_metrics' };
const now = Date.UTC(2026, 11, 20, 15, 30);

/** A fetcher answering each query from `rows` by the window it asks for, recording the queries. */
function fakeFetch(rows: (from: string) => unknown[], status = 200) {
	const calls: Array<{ url: string; auth: string | null; sql: string }> = [];
	const fetcher = (async (url: string, init: RequestInit) => {
		const sql = String(init.body);
		calls.push({ url, auth: new Headers(init.headers).get('Authorization'), sql });
		const from = sql.match(/toDateTime\('([^']+)'\)/)![1];
		return new Response(JSON.stringify({ data: rows(from) }), { status });
	}) as unknown as typeof fetch;
	return { fetcher, calls };
}

describe('active users for /status', () => {
	it('is configured only with the account, the token and a plain dataset name', () => {
		expect(activeUsersConfigured(env)).toBe(true);
		expect(activeUsersConfigured({ ...env, METRICS_DATASET: undefined })).toBe(false);
		expect(activeUsersConfigured({ ...env, ACCOUNT_ANALYTICS_TOKEN: undefined })).toBe(false);
		// The name goes into the SQL: anything but letters, digits and _ is refused.
		expect(activeUsersConfigured({ ...env, METRICS_DATASET: "x WHERE 1=1; --" })).toBe(false);
	});

	it('counts distinct readers and writers today (UTC), over 7 days and over 30, in three queries', async () => {
		const { fetcher, calls } = fakeFetch((from) => {
			const counts: Record<string, [number, number]> = { '2026-12-20 00:00:00': [4, 1], '2026-12-13 15:30:00': [20, 5], '2026-11-20 15:30:00': [60, 9] };
			const [read, write] = counts[from];
			// Counting began on Nov 25, within the 30 days that start on Nov 20.
			return [{ bucket: 'read', users: String(read), first: '2026-11-25 18:01:30' }, { bucket: 'write', users: write, first: '2026-11-26 09:00:00' }];
		});
		const result = await fetchActiveUsers(env, now, fetcher);
		expect(result).toEqual({ today: { read: 4, write: 1 }, week: { read: 20, write: 5 }, month: { read: 60, write: 9 }, since: '2026-11-25' });
		expect(calls).toHaveLength(3);
		for (const call of calls) {
			expect(call.url).toBe('https://api.cloudflare.com/client/v4/accounts/account-1/analytics_engine/sql');
			expect(call.auth).toBe('Bearer token-1');
			expect(call.sql).toMatch(/COUNT\(DISTINCT blob4\)[\s\S]*FROM apron_server_metrics WHERE blob1 = 'active'/);
		}
	});

	it('leaves out "since" once counting covers the 30 days, and counts a bucket with no rows as 0', async () => {
		const { fetcher } = fakeFetch(() => [{ bucket: 'read', users: 7, first: '2026-11-20 15:31:00' }]);
		expect(await fetchActiveUsers(env, now, fetcher)).toEqual({ today: { read: 7, write: 0 }, week: { read: 7, write: 0 }, month: { read: 7, write: 0 } });
	});

	it('fails on an HTTP error, and when not configured', async () => {
		await expect(fetchActiveUsers(env, now, fakeFetch(() => [], 403).fetcher)).rejects.toThrow('Analytics Engine HTTP 403');
		await expect(fetchActiveUsers({}, now, fakeFetch(() => []).fetcher)).rejects.toThrow('not configured');
	});

	it('reads as one /status line, or says why it is unavailable', () => {
		expect(activeUsersLine({ today: { read: 4, write: 1 }, week: { read: 1200, write: 5 }, month: { read: 1300, write: 9 }, since: '2026-11-17' }))
			.toBe('- Active users (read / wrote): today 4 / 1 · last 7 days 1,200 / 5 · last 30 days 1,300 / 9 (counted since 2026-11-17)');
		expect(activeUsersLine(new Error('Analytics Engine HTTP 403'))).toBe('- Active users (read / wrote): unavailable (Analytics Engine HTTP 403)');
	});
});
