import { ACCOUNT_USAGE_POLICY } from "./budget.ts";

/**
 * Workers Paid list prices past each monthly inclusion, checked against
 * developers.cloudflare.com/workers/platform/pricing and /r2/pricing on
 * 2026-11-01. The inclusions themselves are the plan's `account.monthly`
 * and `account.r2` (src/plans/paid.ts). Cloudflare rounds each dimension's
 * billable usage up to its next whole unit before pricing it, so a few
 * operations past an inclusion already cost one unit.
 */
export const PRICES = Object.freeze({
	baseUsd: 5,
	workerRequests: { unit: 1_000_000, usd: 0.30 },
	workerCpuMs: { unit: 1_000_000, usd: 0.02 },
	durableObjectRequests: { unit: 1_000_000, usd: 0.15 },
	durableObjectDurationGbSeconds: { unit: 1_000_000, usd: 12.50 },
	sqlRowsRead: { unit: 1_000_000, usd: 0.001 },
	sqlRowsWritten: { unit: 1_000_000, usd: 1.00 },
	// Workers Logs from 2026-12-01 (Cloudflare Observability pricing); until
	// then logs bill per event past 20 million, which the 10% sampling keeps
	// out of reach of anything else the cap allows.
	logBytes: { unit: 1_000_000_000, usd: 0.25 },
	r2ClassAOperations: { unit: 1_000_000, usd: 4.50 },
	r2ClassBOperations: { unit: 1_000_000, usd: 0.36 },
	/** SQLite storage past 5 GB-month, per GB-month. */
	storedGbMonthUsd: 0.20,
	/** R2 Standard storage past 10 GB-month, per GB-month. */
	r2StoredGbMonthUsd: 0.015,
});

export type PricedField = Exclude<keyof typeof PRICES, "baseUsd" | "storedGbMonthUsd" | "r2StoredGbMonthUsd">;

const FIELDS: readonly PricedField[] = ["workerRequests", "workerCpuMs", "durableObjectRequests", "durableObjectDurationGbSeconds", "sqlRowsRead", "sqlRowsWritten", "logBytes", "r2ClassAOperations", "r2ClassBOperations"];

/** Names for `/status` and the stop reasons. */
export const PRICED_LABEL: Readonly<Record<PricedField | "storage", string>> = Object.freeze({
	workerRequests: "Worker requests",
	workerCpuMs: "Worker CPU",
	durableObjectRequests: "Durable Object requests",
	durableObjectDurationGbSeconds: "Durable Object duration",
	sqlRowsRead: "SQL rows read",
	sqlRowsWritten: "SQL rows written",
	logBytes: "logs",
	r2ClassAOperations: "R2 Class A",
	r2ClassBOperations: "R2 Class B",
	storage: "storage",
});

export type MeteredUsage = Record<PricedField, number>;

/** The overage a dollar cap allows: per UTC day, and per calendar month. */
export interface BillCap {
	dayUsd: number;
	monthUsd: number;
}

export interface BillCapEnvironment {
	BILL_CAP_DAY?: string;
	BILL_CAP_MONTH?: string;
}

function capValue(value: string | undefined, name: string, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a dollar amount of 0 or more`);
	return number;
}

/**
 * The plan's bill cap with `BILL_CAP_DAY` and `BILL_CAP_MONTH` (dollars of
 * overage) applied; null for a plan that fails closed at its allowances
 * instead of billing past them. Throws on a value that is not a dollar
 * amount, which loadConfig turns into a configuration error.
 */
export function billCap(env: BillCapEnvironment = {}): BillCap | null {
	const cap = ACCOUNT_USAGE_POLICY.billCap;
	if (!cap) return null;
	return {
		dayUsd: capValue(env.BILL_CAP_DAY, "BILL_CAP_DAY", cap.dayUsd),
		monthUsd: capValue(env.BILL_CAP_MONTH, "BILL_CAP_MONTH", cap.monthUsd),
	};
}

/** Each field's monthly inclusion on the plan. */
function included(field: PricedField): number {
	const { monthly, r2 } = ACCOUNT_USAGE_POLICY;
	if (field === "r2ClassAOperations") return r2?.classAOperationsMonthly ?? 0;
	if (field === "r2ClassBOperations") return r2?.classBOperationsMonthly ?? 0;
	return monthly?.[field] ?? 0;
}

/**
 * The overage, per field, of a month's usage: billable units rounded up, as
 * Cloudflare bills them, then priced; or, `rounded` false, prorated, for
 * what a day adds (estimateBill).
 */
export function usageOverage(usage: MeteredUsage, rounded = true): Record<PricedField, number> {
	const out = {} as Record<PricedField, number>;
	for (const field of FIELDS) {
		const { unit, usd } = PRICES[field];
		const units = Math.max(0, usage[field] - included(field)) / unit;
		out[field] = exact((rounded ? Math.ceil(units) : units) * usd);
	}
	return out;
}

/** A month's storage overage at the bytes stored now, as if they stayed all month. */
export function storageOverage(storedBytes: number, r2StoredBytes: number): number {
	const gb = 1024 ** 3;
	const sqlite = Math.ceil(Math.max(0, storedBytes - ACCOUNT_USAGE_POLICY.storedBytes) / gb) * PRICES.storedGbMonthUsd;
	const r2 = Math.ceil(Math.max(0, r2StoredBytes - (ACCOUNT_USAGE_POLICY.r2?.storedBytes ?? 0)) / gb) * PRICES.r2StoredGbMonthUsd;
	return exact(sqlite + r2);
}

export interface BillEstimate {
	/** Overage so far this calendar month, storage included. */
	monthUsd: number;
	/**
	 * What today added: the month's overage less what it was before today,
	 * prorated, so a day that only crosses into a billing unit (a whole $4.50
	 * of R2 Class A, rounded) is charged for what it used of it.
	 */
	dayUsd: number;
	/** The month's overage per field (and storage), largest first, zeros left out. */
	items: Array<[PricedField | "storage", number]>;
}

/** Dollars to a millionth, so sums of list prices compare and print exactly. */
function exact(amount: number): number {
	return Math.round(amount * 1e6) / 1e6;
}

function total(values: Record<string, number>): number {
	return exact(Object.values(values).reduce((sum, value) => sum + value, 0));
}

/**
 * The bill estimate from a month's usage and the part of it that is today's.
 * Today's usage is taken out of the month's (clamped: the two come from
 * separate analytics queries) to price the month before today.
 */
export function estimateBill(month: MeteredUsage, today: Partial<MeteredUsage>, storedBytes: number, r2StoredBytes: number): BillEstimate {
	const before = {} as MeteredUsage;
	for (const field of FIELDS) before[field] = Math.max(0, month[field] - Math.min(month[field], today[field] ?? 0));
	const now = usageOverage(month);
	const storage = storageOverage(storedBytes, r2StoredBytes);
	const monthUsd = exact(total(now) + storage);
	const dayUsd = Math.max(0, exact(total(usageOverage(month, false)) - total(usageOverage(before, false))));
	const items = ([...Object.entries(now), ["storage", storage]] as Array<[PricedField | "storage", number]>)
		.filter(([, usd]) => usd > 0)
		.sort((a, b) => b[1] - a[1]);
	return { monthUsd, dayUsd, items };
}

/** Dollars for people: `$0.31`, `$26.10`, `$5`. */
export function usd(amount: number): string {
	const cents = Math.round(amount * 100);
	return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/**
 * Why a bill estimate stops the server under `cap`: `day overage $5.20 over
 * $5` or `month overage $26.10 over $25`; empty while it may run. A day
 * reason lifts at midnight UTC, a month one on the 1st (accountUsageStops
 * tells them apart by their first word).
 */
export function billReasons(bill: BillEstimate, cap: BillCap): string[] {
	const reasons: string[] = [];
	if (bill.dayUsd > cap.dayUsd) reasons.push(`day overage ${usd(bill.dayUsd)} over ${usd(cap.dayUsd)}`);
	if (bill.monthUsd > cap.monthUsd) reasons.push(`month overage ${usd(bill.monthUsd)} over ${usd(cap.monthUsd)}`);
	return reasons;
}
