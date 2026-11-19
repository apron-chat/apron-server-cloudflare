/**
 * Daily, weekly and monthly active users for `/status`, read back from the
 * `active` metric (src/metrics.ts) through the Analytics Engine SQL API:
 * distinct users who read (signed in or sent a frame) and who wrote (posted
 * a new message) today (UTC), over the last 7 days and over the last 30.
 *
 * It needs `ACCOUNT_ID` and `ACCOUNT_ANALYTICS_TOKEN` (the account usage
 * reading's; Account Analytics Read covers this API too) and
 * `METRICS_DATASET`, the dataset the `METRICS` binding writes, which the
 * binding does not tell the Worker (npm run budget:check holds the two
 * equal). Four small queries, run only when an admin asks for `/status`.
 */
export interface ActiveUsersEnv {
	ACCOUNT_ID?: string;
	ACCOUNT_ANALYTICS_TOKEN?: string;
	METRICS_DATASET?: string;
}

export interface ActiveCounts {
	read: number;
	write: number;
}

export interface ActiveUsers {
	today: ActiveCounts;
	week: ActiveCounts;
	month: ActiveCounts;
	/** The first day with any point, when it is within the 30 days: the counts start there. */
	since?: string;
}

/** A dataset name safe to put in SQL; also held by npm run budget:check and usage:report. */
export const DATASET_PATTERN = /^[A-Za-z0-9_]+$/;
const DAY_MS = 86_400_000;

/** Whether `/status` can read active users here; without it the line is left out. */
export function activeUsersConfigured(env: ActiveUsersEnv): boolean {
	return !!env.ACCOUNT_ID && !!env.ACCOUNT_ANALYTICS_TOKEN && !!env.METRICS_DATASET && DATASET_PATTERN.test(env.METRICS_DATASET);
}

/** An Analytics Engine time, `YYYY-MM-DD hh:mm:ss`. */
function sqlTime(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** Reads the three windows and when counting began; throws when any query fails. */
export async function fetchActiveUsers(env: ActiveUsersEnv, now: number, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<ActiveUsers> {
	if (!activeUsersConfigured(env)) throw new Error("active users are not configured");
	const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.ACCOUNT_ID!)}/analytics_engine/sql`;
	const query = async <Row>(sql: string): Promise<Row[]> => {
		const response = await fetcher(url, { method: "POST", headers: { Authorization: `Bearer ${env.ACCOUNT_ANALYTICS_TOKEN}` }, body: `${sql} FORMAT JSON`, signal });
		// What a refused query says, so `/status` can show it.
		if (!response.ok) throw new Error(`Analytics Engine HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
		return ((await response.json()) as { data?: Row[] }).data ?? [];
	};
	const window = async (fromMs: number): Promise<ActiveCounts> => {
		const counts: ActiveCounts = { read: 0, write: 0 };
		const rows = await query<{ bucket?: unknown; users?: unknown }>(`SELECT blob2 AS bucket, COUNT(DISTINCT blob4) AS users
			FROM ${env.METRICS_DATASET} WHERE blob1 = 'active' AND timestamp >= toDateTime('${sqlTime(fromMs)}') GROUP BY bucket`);
		for (const row of rows) if (row.bucket === "read" || row.bucket === "write") counts[row.bucket] = Number(row.users) || 0;
		return counts;
	};
	const monthStart = now - 30 * DAY_MS;
	const [today, week, month, firstRows] = await Promise.all([
		window(Math.floor(now / DAY_MS) * DAY_MS), window(now - 7 * DAY_MS), window(monthStart),
		// The first point of all (the dataset keeps about 90 days), not of the window: a quiet start of the window is not where counting began.
		query<{ first?: unknown }>(`SELECT MIN(timestamp) AS first FROM ${env.METRICS_DATASET} WHERE blob1 = 'active'`),
	]);
	const first = Date.parse(`${String(firstRows[0]?.first ?? "").replace(" ", "T")}Z`);
	// Counting began within the 30 days: say so, or the month reads as complete.
	const since = Number.isFinite(first) && first > monthStart ? new Date(first).toISOString().slice(0, 10) : undefined;
	return { today, week, month, ...(since ? { since } : {}) };
}

/** `/status`'s line for a reading, or for a failure. */
export function activeUsersLine(result: ActiveUsers | Error): string {
	const label = "- Active users (read / wrote)";
	if (result instanceof Error) return `${label}: unavailable (${result.message})`;
	const pair = (counts: ActiveCounts) => `${counts.read.toLocaleString("en-US")} / ${counts.write.toLocaleString("en-US")}`;
	return `${label}: today ${pair(result.today)} · last 7 days ${pair(result.week)} · last 30 days ${pair(result.month)}${result.since ? ` (counted since ${result.since})` : ""}`;
}
