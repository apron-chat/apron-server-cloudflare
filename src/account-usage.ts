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
	/** R2 today, for a plan with R2 allowances: operations by class, and bytes stored across buckets. */
	r2?: R2Usage & { storedBytes: number };
	stop: boolean;
}

interface R2Usage {
	classAOperations: number;
	classBOperations: number;
}

interface AccountUsageMonth {
	/** The month, `YYYY-MM`. */
	month: string;
	workerRequests: number;
	workerCpuMs: number;
	durableObjectRequests: number;
	durableObjectDurationGbSeconds: number;
	sqlRowsRead: number;
	sqlRowsWritten: number;
	/** Log bytes ingested, estimated (`logEstimate`). */
	logBytes: number;
	/** R2 operations this month, for a plan with R2 allowances. */
	r2?: R2Usage;
}

// R2 bills operations by class (developers.cloudflare.com/r2/pricing). Deletes
// and aborted multipart uploads are free; any other action is counted as the
// dearer Class A, so a new one is never missed.
const R2_CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration"]);
const R2_FREE = new Set(["DeleteObject", "DeleteObjects", "DeleteBucket", "AbortMultipartUpload"]);

function r2Operations(groups: unknown): R2Usage {
	const actionType = (group: object) => String((group as { dimensions?: { actionType?: unknown } }).dimensions?.actionType ?? "");
	return {
		classAOperations: sum(groups, "requests", (group) => (R2_FREE.has(actionType(group)) || R2_CLASS_B.has(actionType(group)) ? 0 : 1)),
		classBOperations: sum(groups, "requests", (group) => (R2_CLASS_B.has(actionType(group)) ? 1 : 0)),
	};
}

/** Bytes stored across buckets: each bucket's largest reading, added up. */
function r2StoredBytes(groups: unknown): number {
	if (!Array.isArray(groups)) throw new AccountUsageError("analytics field storedBytes is missing");
	return groups.reduce((total, group) => {
		const largest = (group as { max?: Record<string, unknown> } | null)?.max;
		if (!largest) throw new AccountUsageError("analytics field storedBytes is invalid");
		return total + numberValue(largest.payloadSize ?? 0, "payloadSize") + numberValue(largest.metadataSize ?? 0, "metadataSize");
	}, 0);
}

export interface AccountUsageEnvironment {
	ACCOUNT_ID?: string;
	ACCOUNT_ANALYTICS_TOKEN?: string;
}

class AccountUsageError extends Error {
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
	const { daily, monthly, monthlyStopRatio, stopRatio, storedBytes, r2 } = ACCOUNT_USAGE_POLICY;
	const ratio = monthlyStopRatio ?? stopRatio;
	const exceeded = (Object.keys(daily) as (keyof typeof daily)[])
		.filter((field) => usage[field] >= daily[field] * stopRatio)
		.map((field) => `daily.${field}`);
	if (usage.storedBytes >= storedBytes * stopRatio) exceeded.push("storedBytes");
	if (monthly && usage.month) {
		const month = usage.month;
		for (const field of Object.keys(monthly) as (keyof typeof monthly)[]) {
			if (month[field] >= monthly[field] * ratio) exceeded.push(`monthly.${field}`);
		}
	}
	if (r2 && usage.r2) {
		// Each day stops at its share of the month, like the Workers allowances.
		if (usage.r2.classAOperations >= (r2.classAOperationsMonthly / 31) * stopRatio) exceeded.push("daily.r2ClassAOperations");
		if (usage.r2.classBOperations >= (r2.classBOperationsMonthly / 31) * stopRatio) exceeded.push("daily.r2ClassBOperations");
		if (usage.r2.storedBytes >= r2.storedBytes * stopRatio) exceeded.push("r2StoredBytes");
		if (usage.month?.r2 && usage.month.r2.classAOperations >= r2.classAOperationsMonthly * ratio) exceeded.push("monthly.r2ClassAOperations");
		if (usage.month?.r2 && usage.month.r2.classBOperations >= r2.classBOperationsMonthly * ratio) exceeded.push("monthly.r2ClassBOperations");
	}
	return exceeded;
}

/**
 * Whether a snapshot still stops the server at `now`: through its UTC day,
 * or, when it reached a monthly allowance, through its calendar month, so a
 * monthly stop does not lift at midnight while the next reading is pending
 * or failing.
 */
export function accountUsageStops(snapshot: AccountUsageSnapshot | null, now: number): boolean {
	if (!snapshot?.stop) return false;
	const today = dayFor(now);
	if (snapshot.day === today) return true;
	return snapshot.day.slice(0, 7) === today.slice(0, 7) && exceededAllowances(snapshot).some((name) => name.startsWith("monthly."));
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
		...(ACCOUNT_USAGE_POLICY.r2 ? { r2: { ...r2Operations(account.r2Operations), storedBytes: r2StoredBytes(account.r2Storage) } } : {}),
	};
	return { ...usage, stop: exceededAllowances(usage).length > 0 };
}

/**
 * Log bytes for a month's invocations: each entry Worker request and Durable
 * Object invocation at the most its event takes, times the sampling rate.
 * scripts/budget.mjs refuses a plan with monthly allowances but no estimate.
 */
function logBytes(workerRequests: number, invocations: number): number {
	const estimate = ACCOUNT_USAGE_POLICY.logEstimate;
	if (!estimate) throw new AccountUsageError("the plan has no logEstimate");
	return (workerRequests * estimate.workerEventBytes + invocations * estimate.durableObjectEventBytes) * estimate.sampleRate;
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
		logBytes: logBytes(workerRequests, invocations),
		...(ACCOUNT_USAGE_POLICY.r2 ? { r2: r2Operations(account.monthR2Operations) } : {}),
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
	const r2 = ACCOUNT_USAGE_POLICY.r2 ? `
		r2Operations: r2OperationsAdaptiveGroups(${day}) { dimensions { actionType } sum { requests } }
		r2Storage: r2StorageAdaptiveGroups(${day}) { dimensions { bucketName } max { payloadSize metadataSize } }${ACCOUNT_USAGE_POLICY.monthly ? `
		monthR2Operations: r2OperationsAdaptiveGroups(${month}) { dimensions { actionType } sum { requests } }` : ""}` : "";
	const query = `query { viewer { accounts(filter: { accountTag: ${JSON.stringify(env.ACCOUNT_ID)} }) {
		workersInvocationsAdaptive(${day}) { sum { requests } }
		durableObjectsInvocationsAdaptiveGroups(${day}) { dimensions { type } sum { requests } }
		durableObjectsPeriodicGroups(${day}) { sum { duration rowsRead rowsWritten } }
		durableObjectsStorageGroups(${day}) { max { storedBytes } }${monthly}${r2}
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

interface AccountUsageMonitorOptions {
	env: AccountUsageEnvironment;
	/** Saves a fresh snapshot, so a wake starts from it; a failure keeps the in-memory one. */
	persist(snapshot: AccountUsageSnapshot, now: number): void;
	/** Keeps a refresh an event started alive after the event's response. */
	waitUntil(promise: Promise<unknown>): void;
	/** Called when a fresh snapshot newly stops the server (it did not stop before), to close what is open. */
	onStop(): void;
	/** Called after every fresh snapshot, once it is current, so the runtime can re-evaluate its tier. */
	onSnapshot?(): void;
	fetcher?: typeof fetch;
}

/**
 * The Durable Object's account-usage stop: the latest snapshot, and when to
 * read the next one. Events count toward a refresh every
 * `refreshEveryEvents`, or as soon as the snapshot is `staleAfterMs` old, at
 * most once per `minimumRefreshIntervalMs`; a failed reading keeps the last
 * snapshot and retries with backoff. Without `ACCOUNT_ID` and
 * `ACCOUNT_ANALYTICS_TOKEN` it never reads, and only a restored snapshot can
 * stop the server.
 */
export class AccountUsageMonitor {
	private events = 0;
	private retryAt = 0;
	private failures = 0;
	private verified = false;
	private pending?: Promise<void>;

	constructor(private readonly options: AccountUsageMonitorOptions, private current: AccountUsageSnapshot | null = null) {}

	/** The latest snapshot, read now or restored from storage. */
	get snapshot(): AccountUsageSnapshot | null {
		return this.current;
	}

	/** Starts from a snapshot read back from storage. */
	restore(snapshot: AccountUsageSnapshot | null): void {
		this.current = snapshot;
	}

	/** Whether the latest snapshot stops the server at `now` (accountUsageStops). */
	stops(now: number): boolean {
		return accountUsageStops(this.current, now);
	}

	/** Counts one event, and starts a refresh in the background when one is due. */
	noteActivity(now = Date.now()): void {
		if (!this.configured()) return;
		this.events += 1;
		const stale = !this.current || now - this.current.sampledAt >= ACCOUNT_USAGE_POLICY.staleAfterMs;
		if (this.events < ACCOUNT_USAGE_POLICY.refreshEveryEvents && !stale) return;
		// Keep the refresh alive after the request returns without adding its latency
		// to the admitted WebSocket attempt.
		this.options.waitUntil(this.refresh(now, false));
	}

	/**
	 * Reads usage now unless a reading is under way (it waits for that one),
	 * the last is under a minute old, or, unless `forced`, a failure's backoff
	 * has not passed.
	 */
	async refresh(now: number, forced: boolean): Promise<void> {
		if (!this.configured()) return;
		if (this.pending) return this.pending;
		if (!forced && now < this.retryAt) return;
		if (this.current && now - this.current.sampledAt < ACCOUNT_USAGE_POLICY.minimumRefreshIntervalMs) return;
		this.events = 0;
		const task = this.read(now);
		this.pending = task;
		await task;
		this.pending = undefined;
	}

	private configured(): boolean {
		return !!this.options.env.ACCOUNT_ID && !!this.options.env.ACCOUNT_ANALYTICS_TOKEN;
	}

	private async read(now: number): Promise<void> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5_000);
		try {
			const snapshot = await fetchAccountUsage(this.options.env, now, controller.signal, this.options.fetcher ?? fetch);
			// Bounded confirmation per instance and after recovery; no sensitive data.
			if (!this.verified || this.failures > 0) {
				console.info(JSON.stringify({ event: "account_usage_refresh_succeeded", sampledAt: snapshot.sampledAt, stop: snapshot.stop }));
			}
			this.verified = true;
			try { this.options.persist(snapshot, now); } catch { /* retain the in-memory safety stop */ }
			// Only a newly stopping reading closes what is open: an admin's
			// `/status` refresh while stopped would otherwise close their own socket.
			const stopping = this.stops(now);
			this.current = snapshot;
			this.failures = 0;
			this.retryAt = 0;
			if (snapshot.stop && !stopping) this.options.onStop();
			try { this.options.onSnapshot?.(); } catch { /* the tier is re-evaluated at the next event */ }
		} catch {
			this.failures += 1;
			const delay = Math.min(ACCOUNT_USAGE_POLICY.maxRetryMs, ACCOUNT_USAGE_POLICY.initialRetryMs * 2 ** Math.min(this.failures - 1, 4));
			this.retryAt = now + delay;
			if ((this.failures & (this.failures - 1)) === 0) console.warn(JSON.stringify({ event: "account_usage_refresh_failed", count: this.failures }));
		} finally {
			clearTimeout(timeout);
		}
	}
}
