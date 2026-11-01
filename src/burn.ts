import { ACCOUNT_USAGE_POLICY } from "./budget.ts";
import { PRICES } from "./pricing.ts";

/**
 * The attack pause's thresholds (docs/configuration.md, Attack pause). The
 * meter prices every billed event at its overage rate, as if every
 * inclusion were spent ("shadow" dollars): what the traffic would cost past
 * the plan, whatever the month has used so far.
 */
export const BURN_POLICY = Object.freeze({
	/** The rolling window, in whole minutes. */
	windowMinutes: 10,
	/** The fast window for a mostly refused flood. */
	fastMinutes: 2,
	/** The burn rate that pauses (or, for mostly admitted traffic, alerts). */
	usdPerHour: 1,
	/** Refused share of entry requests over the window at or past which a sustained burn pauses. */
	sustainedRefusedShare: 0.5,
	/** Refused share over the fast window at or past which the fast rule pauses. */
	fastRefusedShare: 0.8,
	/** Entry requests the Worker answers itself are reported one in this many. */
	entrySampleEvery: 100,
	/** How often an isolate may report its samples to the object, at most. */
	entryReportMs: 1_000,
	/** How often the object weighs the meter, at most. */
	checkEveryMs: 5_000,
	/** The first pause; each later one in the same UTC day doubles it. */
	firstHoldMs: 30 * 60_000,
	maxHoldMs: 4 * 60 * 60_000,
	/** Open breakers on this many operations at once pause the server. */
	pauseBreakers: 3,
	/** A high burn of mostly admitted traffic alerts the admins at most this often. */
	alertEveryMs: 60 * 60_000,
});

/** Assumed CPU of one request the Worker answers, in ms. */
const ENTRY_CPU_MS = 2;

function perUnit(price: { unit: number; usd: number }): number {
	return price.usd / price.unit;
}

const logEstimate = ACCOUNT_USAGE_POLICY.logEstimate;
const logUsdPerByte = perUnit(PRICES.logBytes);
const workerLogUsd = logEstimate ? logEstimate.workerEventBytes * logEstimate.sampleRate * logUsdPerByte : 0;
const objectLogUsd = logEstimate ? logEstimate.durableObjectEventBytes * logEstimate.sampleRate * logUsdPerByte : 0;
const workerUsd = perUnit(PRICES.workerRequests) + ENTRY_CPU_MS * perUnit(PRICES.workerCpuMs) + workerLogUsd;
const objectUsd = perUnit(PRICES.durableObjectRequests) + objectLogUsd;

/** What the meter counts. */
export type BurnKind =
	/** A request the entry Worker answered without the object (sampled). */
	| "entry"
	/** A request the entry Worker forwarded to the object's fetch. */
	| "fetch"
	/** An incoming WebSocket message. */
	| "message"
	/** An alarm. */
	| "alarm"
	/** An RPC call into the object. */
	| "rpc";

/** Each event's shadow price in dollars: SQL rows and duration are left out, since the app's ceilings bound them. */
export const SHADOW_USD: Readonly<Record<BurnKind, number>> = Object.freeze({
	entry: workerUsd,
	fetch: workerUsd + objectUsd,
	message: perUnit(PRICES.durableObjectRequests) / ACCOUNT_USAGE_POLICY.webSocketMessagesPerRequest + objectLogUsd,
	alarm: objectUsd,
	rpc: objectUsd,
});

interface Bucket {
	usd: number;
	/** Entry requests seen: forwarded fetches and the Worker's own answers. */
	seen: number;
	refused: number;
}

export interface BurnWindow {
	usd: number;
	usdPerHour: number;
	seen: number;
	refused: number;
	/** Refused share of the entry requests seen; 0 with none seen. */
	refusedShare: number;
}

export type BurnDecision =
	| { action: "none" }
	| { action: "pause"; trigger: "flood" | "burn"; window: BurnWindow }
	| { action: "alert"; window: BurnWindow };

/**
 * Per-minute buckets of shadow dollars and entry requests over the last
 * `windowMinutes`, in memory: a wake starts empty, and the object stays
 * awake while traffic is heavy enough to matter.
 */
export class BurnMeter {
	private readonly buckets = new Map<number, Bucket>();

	/** Counts `count` events of `kind` at `now`, `refused` of them refused (entry requests only). */
	note(kind: BurnKind, now: number, count = 1, refused = 0): void {
		if (!(count > 0)) return;
		const minute = Math.floor(now / 60_000);
		let bucket = this.buckets.get(minute);
		if (!bucket) {
			bucket = { usd: 0, seen: 0, refused: 0 };
			this.buckets.set(minute, bucket);
			for (const key of this.buckets.keys()) if (key <= minute - BURN_POLICY.windowMinutes) this.buckets.delete(key);
		}
		bucket.usd += SHADOW_USD[kind] * count;
		if (kind === "entry" || kind === "fetch") {
			bucket.seen += count;
			bucket.refused += Math.min(count, Math.max(0, refused));
		}
	}

	/** The last `minutes` whole minutes, the current one included. */
	window(now: number, minutes: number = BURN_POLICY.windowMinutes): BurnWindow {
		const minute = Math.floor(now / 60_000);
		let usd = 0, seen = 0, refused = 0;
		for (const [key, bucket] of this.buckets) {
			if (key <= minute - minutes || key > minute) continue;
			usd += bucket.usd;
			seen += bucket.seen;
			refused += bucket.refused;
		}
		return { usd, usdPerHour: (usd * 60) / minutes, seen, refused, refusedShare: seen ? refused / seen : 0 };
	}

	/**
	 * Whether the traffic is an attack to pause for: past `usdPerHour` over
	 * the fast window and mostly refused (a flood the limiters already turn
	 * away, which still bills), or past it over the whole window with at
	 * least half refused. Past it with most of it admitted is a launch, not
	 * an attack: an alert, and the bill cap bounds it.
	 */
	decide(now: number): BurnDecision {
		const fast = this.window(now, BURN_POLICY.fastMinutes);
		if (fast.usdPerHour >= BURN_POLICY.usdPerHour && fast.refusedShare >= BURN_POLICY.fastRefusedShare) return { action: "pause", trigger: "flood", window: fast };
		const whole = this.window(now);
		if (whole.usdPerHour < BURN_POLICY.usdPerHour) return { action: "none" };
		if (whole.refusedShare >= BURN_POLICY.sustainedRefusedShare) return { action: "pause", trigger: "burn", window: whole };
		return { action: "alert", window: whole };
	}
}

/** The hold for the `count`th pause of a UTC day: 30 minutes, doubling, at most 4 hours. */
export function attackHoldMs(count: number): number {
	return Math.min(BURN_POLICY.maxHoldMs, BURN_POLICY.firstHoldMs * 2 ** Math.max(0, count - 1));
}

/** A burn rate for people: `$3.20/h, 92% refused`. */
export function burnSummary(window: BurnWindow): string {
	const rate = window.usdPerHour >= 0.1 ? window.usdPerHour.toFixed(2) : window.usdPerHour.toPrecision(2);
	return `$${rate}/h, ${Math.round(window.refusedShare * 100)}% of ${window.seen.toLocaleString("en-US")} requests refused`;
}
