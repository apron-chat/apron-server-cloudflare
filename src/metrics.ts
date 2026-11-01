/**
 * Exact operational counters in Workers Analytics Engine (the `METRICS`
 * dataset binding), beside the sampled Workers Logs: a data point is never
 * sampled away by `head_sampling_rate`, and one SQL query counts them
 * (`npm run usage:report`). Each point is `blob1` the event, `blob2` and
 * `blob3` its details, and `double1` its value (1 for a plain count), with
 * the event as its index. Writing is fire-and-forget: it neither awaits nor
 * throws, and without the binding nothing is written.
 */
export type MetricEvent =
	/** A stale connection closed (closeStale): `pinged` or `unpinged`, and its origin (`none` without one). */
	| "stale_close"
	/** An alarm ran: `light` (status changes only) or `full`. */
	| "alarm"
	/** Pushes delivered: `sent`, `failed` or `gone`, valued by count. */
	| "push"
	/** Storage accounting overran (`overrun`, observed), closed on a storage failure (`uncertain`), or reopened (`recovered`); with what happened where known. */
	| "accounting"
	/** An admin alert posted (notifyAdmins): `pushed` or `not_pushed`, valued by admins mentioned. */
	| "admins_notified"
	/** The edge stop turned on (`guard` or `flood`, and what was reached) or off (`lifted`). */
	| "edge_stop"
	/** The server changed tier (Store tiers, ApronDemoServer.evaluateTier): the new tier and the one before. */
	| "tier"
	/** A user tripped a long refusal (ApronDemoServer.noteTrip): its trigger and the method refused. */
	| "throttle"
	/** The attack pause (ApronDemoServer.pauseForAttack): its trigger (`flood`, `burn`, `breakers`), valued by the hold in minutes. */
	| "attack"
	/** A heavy burn of mostly admitted traffic alerted the admins, valued by shadow dollars an hour. */
	| "burn";

export function recordMetric(dataset: AnalyticsEngineDataset | undefined, event: MetricEvent, details: readonly string[] = [], value = 1): void {
	if (!dataset) return;
	try {
		dataset.writeDataPoint({ indexes: [event], blobs: [event, ...details], doubles: [value] });
	} catch { /* a metric never breaks what it counts */ }
}
