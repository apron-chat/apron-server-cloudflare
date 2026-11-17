import { describe, expect, it } from 'vitest';
import { activeUsersConfigured, activeUsersLine, fetchActiveUsers } from '../src/active-users';

const env = { ACCOUNT_ID: 'account-1', ACCOUNT_ANALYTICS_TOKEN: 'token-1', METRICS_DATASET: 'apron_server_metrics' };
const now = Date.UTC(2026, 11, 20, 15, 30);

/**
 * A fetcher answering each window query from `rows` by the time it starts
 * at, and the first-point query with `first`, recording every query.
 */
function fakeFetch(rows: (from: string) => unknown[], first: string | null, status = 200) {
	const calls: Array<{ url: string; auth: string | null; sql: string }> = [];
	const fetcher = (async (url: string, init: RequestInit) => {
		const sql = String(init.body);
		calls.push({ url, auth: new Headers(init.headers).get('Authorization'), sql });
		if (status !== 200) return new Response('{"errors":["Syntax error near first"]}', { status });
		const from = sql.match(/toDateTime\('([^']+)'\)/)?.[1];
		return new Response(JSON.stringify({ data: from ? rows(from) : first ? [{ first }] : [{ first: null }] }));
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

	it('counts distinct readers and writers today (UTC), over 7 days and over 30, and says when counting began', async () => {
		const { fetcher, calls } = fakeFetch((from) => {
			const counts: Record<string, [number, number]> = { '2026-12-20 00:00:00': [4, 1], '2026-12-13 15:30:00': [20, 5], '2026-11-20 15:30:00': [60, 9] };
			const [read, write] = counts[from];
			return [{ bucket: 'read', users: String(read) }, { bucket: 'write', users: write }];
		}, '2026-11-25 18:01:30');
		expect(await fetchActiveUsers(env, now, fetcher)).toEqual({ today: { read: 4, write: 1 }, week: { read: 20, write: 5 }, month: { read: 60, write: 9 }, since: '2026-11-25' });
		expect(calls).toHaveLength(4);
		for (const call of calls) {
			expect(call.url).toBe('https://api.cloudflare.com/client/v4/accounts/account-1/analytics_engine/sql');
			expect(call.auth).toBe('Bearer token-1');
			expect(call.sql).toMatch(/FROM apron_server_metrics WHERE blob1 = 'active'[\s\S]* FORMAT JSON$/);
		}
		expect(calls.filter((call) => call.sql.includes('COUNT(DISTINCT blob4)'))).toHaveLength(3);
	});

	it('says when counting began only while that is inside the 30 days, whatever the start of the window was like', async () => {
		const at = async (first: string | null) => (await fetchActiveUsers(env, now, fakeFetch(() => [{ bucket: 'read', users: 7 }], first).fetcher)).since;
		// The window starts at 2026-11-20 15:30: a first point after it is where counting began.
		expect(await at('2026-11-20 15:31:00')).toBe('2026-11-20');
		// Counting began before the window, even if the window's first days were quiet: none.
		expect(await at('2026-11-20 15:29:00')).toBeUndefined();
		expect(await at('2026-09-01 00:00:00')).toBeUndefined();
		expect(await at(null)).toBeUndefined();
	});

	it('counts a bucket with no rows as 0', async () => {
		const { fetcher } = fakeFetch(() => [{ bucket: 'read', users: 7 }], null);
		expect(await fetchActiveUsers(env, now, fetcher)).toEqual({ today: { read: 7, write: 0 }, week: { read: 7, write: 0 }, month: { read: 7, write: 0 } });
	});

	it('fails with what a refused query says, when not configured, and once its signal aborts', async () => {
		await expect(fetchActiveUsers(env, now, fakeFetch(() => [], null, 422).fetcher)).rejects.toThrow('Analytics Engine HTTP 422: {"errors":["Syntax error near first"]}');
		await expect(fetchActiveUsers({}, now, fakeFetch(() => [], null).fetcher)).rejects.toThrow('not configured');
		// A query that never answers is cut off by the signal /status passes.
		const hung = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
			init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
		})) as unknown as typeof fetch;
		const error = await fetchActiveUsers(env, now, hung, AbortSignal.timeout(20)).catch((caught: Error) => caught);
		expect(error).toBeInstanceOf(Error);
		expect(activeUsersLine(error as Error)).toMatch(/^- Active users \(read \/ wrote\): unavailable \(.*time/);
	});

	it('reads as one /status line, or says why it is unavailable', () => {
		expect(activeUsersLine({ today: { read: 4, write: 1 }, week: { read: 1200, write: 5 }, month: { read: 1300, write: 9 }, since: '2026-11-17' }))
			.toBe('- Active users (read / wrote): today 4 / 1 · last 7 days 1,200 / 5 · last 30 days 1,300 / 9 (counted since 2026-11-17)');
		expect(activeUsersLine(new Error('Analytics Engine HTTP 403: denied'))).toBe('- Active users (read / wrote): unavailable (Analytics Engine HTTP 403: denied)');
	});
});
