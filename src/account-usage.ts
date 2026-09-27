import { ACCOUNT_USAGE_POLICY } from "./budget";

export interface AccountUsageSnapshot {
	day: string;
	sampledAt: number;
	workerRequests: number;
	durableObjectRequests: number;
	durableObjectDurationGbSeconds: number;
	sqlRowsRead: number;
	sqlRowsWritten: number;
	storedBytes: number;
	/** Usage since the start of the UTC calendar month, for a plan that bills past its included usage. */
	month?: AccountUsageMonth;
	stop: boolean;
}

export interface AccountUsageMonth {
	/** The month, `YYYY-MM`. */
	month: string;
	workerRequests: number;
	workerCpuMs: number;
	durableObjectRequests: number;
	durableObjectDurationGbSeconds: number;
	sqlRowsRead: number;
	sqlRowsWritten: number;
	logEvents: number;
}

export interface AccountUsageEnvironment {
	ACCOUNT_ID?: string;
	ACCOUNT_ANALYTICS_TOKEN?: string;
}

export class AccountUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AccountUsageError";
	}
}

function dayFor(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function numberValue(value: unknown, field: string): number {
	const number = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(number) || number < 0) throw new AccountUsageError(`analytics field ${field} is invalid`);
	return number;
}

function sum(groups: unknown, field: string, weight: (group: object) => number = () => 1): number {
	if (!Array.isArray(groups)) throw new AccountUsageError(`analytics field ${field} is missing`);
	return groups.reduce((total, group) => {
		if (!group || typeof group !== "object") throw new AccountUsageError(`analytics field ${field} is invalid`);
		const value = (group as { sum?: Record<string, unknown> }).sum?.[field];
		if (value === undefined || value === null) throw new AccountUsageError(`analytics field ${field} is missing`);
		return total + numberValue(value, field) * weight(group);
	}, 0);
}

// Incoming messages on hibernatable WebSockets are invocations of type
// `hibernation`; the plan may bill several of them as one request.
function billedRequestWeight(group: object): number {
	const type = (group as { dimensions?: { type?: unknown } }).dimensions?.type;
	return type === "hibernation" ? 1 / ACCOUNT_USAGE_POLICY.webSocketMessagesPerRequest : 1;
}

function max(groups: unknown, field: string): number {
	if (!Array.isArray(groups)) throw new AccountUsageError(`analytics field ${field} is missing`);
	return groups.reduce((highest, group) => {
		if (!group || typeof group !== "object") throw new AccountUsageError(`analytics field ${field} is invalid`);
		const value = (group as { max?: Record<string, unknown> }).max?.[field];
		if (value === undefined || value === null) throw new AccountUsageError(`analytics field ${field} is missing`);
		return Math.max(highest, numberValue(value, field));
	}, 0);
}

/**
 * The allowances usage has reached its stop ratio of, as `daily.<field>`,
 * `storedBytes`, or `monthly.<field>`; empty while it may continue.
 */
export function exceededAllowances(usage: Omit<AccountUsageSnapshot, "stop">): string[] {
	const { daily, monthly, monthlyStopRatio, stopRatio, storedBytes } = ACCOUNT_USAGE_POLICY;
	const exceeded = (Object.keys(daily) as (keyof typeof daily)[])
		.filter((field) => usage[field] >= daily[field] * stopRatio)
		.map((field) => `daily.${field}`);
	if (usage.storedBytes >= storedBytes * stopRatio) exceeded.push("storedBytes");
	if (monthly && usage.month) {
		const month = usage.month;
		const ratio = monthlyStopRatio ?? stopRatio;
		for (const field of Object.keys(monthly) as (keyof typeof monthly)[]) {
			if (month[field] >= monthly[field] * ratio) exceeded.push(`monthly.${field}`);
		}
	}
	return exceeded;
}

export function accountUsageSnapshotFromResult(result: unknown, sampledAt: number): AccountUsageSnapshot {
	if (!result || typeof result !== "object") throw new AccountUsageError("analytics result is missing");
	const data = (result as { data?: unknown; errors?: unknown[] }).data;
	const errors = (result as { errors?: unknown[] }).errors;
	if (Array.isArray(errors) && errors.length) throw new AccountUsageError("analytics query failed");
	if (!data || typeof data !== "object") throw new AccountUsageError("analytics data is missing");
	const viewer = (data as { viewer?: { accounts?: unknown[] } }).viewer;
	const account = viewer?.accounts?.[0] as Record<string, unknown> | undefined;
	if (!account) throw new AccountUsageError("analytics account is missing");
	const usage = {
		day: dayFor(sampledAt),
		sampledAt,
		workerRequests: sum(account.workersInvocationsAdaptive, "requests"),
		durableObjectRequests: sum(account.durableObjectsInvocationsAdaptiveGroups, "requests", billedRequestWeight),
		durableObjectDurationGbSeconds: sum(account.durableObjectsPeriodicGroups, "duration"),
		sqlRowsRead: sum(account.durableObjectsPeriodicGroups, "rowsRead"),
		sqlRowsWritten: sum(account.durableObjectsPeriodicGroups, "rowsWritten"),
		storedBytes: max(account.durableObjectsStorageGroups, "storedBytes"),
		...(ACCOUNT_USAGE_POLICY.monthly ? { month: monthUsage(account, sampledAt) } : {}),
	};
	return { ...usage, stop: exceededAllowances(usage).length > 0 };
}

function monthUsage(account: Record<string, unknown>, sampledAt: number): AccountUsageMonth {
	const workerRequests = sum(account.monthWorkers, "requests");
	const invocations = sum(account.monthInvocations, "requests");
	return {
		month: dayFor(sampledAt).slice(0, 7),
		workerRequests,
		workerCpuMs: sum(account.monthWorkers, "cpuTimeUs") / 1_000,
		durableObjectRequests: sum(account.monthInvocations, "requests", billedRequestWeight),
		durableObjectDurationGbSeconds: sum(account.monthPeriodic, "duration"),
		sqlRowsRead: sum(account.monthPeriodic, "rowsRead"),
		sqlRowsWritten: sum(account.monthPeriodic, "rowsWritten"),
		logEvents: workerRequests + invocations,
	};
}

/** Dataset arguments for the range from `startMs` to `endMs`. */
function range(startMs: number, endMs: number): string {
	return `filter: { datetime_geq: ${JSON.stringify(new Date(startMs).toISOString())}, datetime_leq: ${JSON.stringify(new Date(endMs).toISOString())} }, limit: 1000`;
}

export async function fetchAccountUsage(env: AccountUsageEnvironment, sampledAt = Date.now(), signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<AccountUsageSnapshot> {
	if (!env.ACCOUNT_ID || !env.ACCOUNT_ANALYTICS_TOKEN) throw new AccountUsageError("account analytics credentials are not configured");
	const date = new Date(sampledAt);
	const day = range(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()), sampledAt);
	const month = range(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), sampledAt);
	const monthly = ACCOUNT_USAGE_POLICY.monthly ? `
		monthWorkers: workersInvocationsAdaptive(${month}) { sum { requests cpuTimeUs } }
		monthInvocations: durableObjectsInvocationsAdaptiveGroups(${month}) { dimensions { type } sum { requests } }
		monthPeriodic: durableObjectsPeriodicGroups(${month}) { sum { duration rowsRead rowsWritten } }` : "";
	const query = `query { viewer { accounts(filter: { accountTag: ${JSON.stringify(env.ACCOUNT_ID)} }) {
		workersInvocationsAdaptive(${day}) { sum { requests } }
		durableObjectsInvocationsAdaptiveGroups(${day}) { dimensions { type } sum { requests } }
		durableObjectsPeriodicGroups(${day}) { sum { duration rowsRead rowsWritten } }
		durableObjectsStorageGroups(${day}) { max { storedBytes } }${monthly}
	} } }`;
	const response = await fetcher("https://api.cloudflare.com/client/v4/graphql", {
		method: "POST",
		headers: { Authorization: `Bearer ${env.ACCOUNT_ANALYTICS_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query }),
		signal,
	});
	if (!response.ok) throw new AccountUsageError(`analytics HTTP ${response.status}`);
	return accountUsageSnapshotFromResult(await response.json(), sampledAt);
}
