/**
 * Exact operational counters in Workers Analytics Engine (the `METRICS`
 * dataset binding), beside the sampled Workers Logs: a data point is never
 * sampled away by `head_sampling_rate`, and one SQL query counts them
 * (`npm run usage:report`). Each point is `blob1` the event, `blob2`
 * onward its details, and `double1` its value (1 for a plain count; an
 * event with more than one value has them in `double2` onward), with
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
	/** The attack pause (ApronDemoServer.pauseForAttack): its trigger (`flood` or `burn`), valued by the hold in minutes. */
	| "attack"
	/** A heavy burn of mostly admitted traffic alerted the admins, valued by shadow dollars an hour. */
	| "burn"
	/**
	 * Refusals (src/refusals.ts): `error` (a JSON-RPC error: a `retry_after`'s
	 * message, else the error's name), `close` (a policy close: its code and
	 * reason) or `http` (the object's refusal of an upgrade or probe: status
	 * and message); then the reason, and the method or path. Valued by count,
	 * so sum `double1`, not the points.
	 */
	| "refusal"
	/**
	 * The SQLite database's occupied bytes (Store.databaseSize), valued by
	 * the size: from a full alarm (maintenance: about daily on a quiet Paid
	 * server, so a day may have none; more with uploads, live text or
	 * sweeps), at most once an hour per instance
	 * (ApronDemoServer.checkDatabaseSize). Take its max, not its sum.
	 */
	| "db_bytes"
	/**
	 * Something took 5 seconds or more (src/stalls.ts): its kind (`handler`,
	 * `queue`, `mutation`, `r2`, `push`, `analytics` or `storage`) and detail
	 * (the event, or the R2 operation); valued by count, with the worst and
	 * the total milliseconds in `double2` and `double3`.
	 */
	| "slow"
	/**
	 * An instance stayed in memory 3 minutes or more without hibernating
	 * (src/stalls.ts), then at most once per 15: what it had in flight
	 * (`none`, or `kind=count` pairs, with its guest (`anonymous`), not yet
	 * signed in (`pending`, `overdue` past the deadline) and closed but still
	 * listed (`closing`, `closing_min` since the oldest opened) sockets);
	 * valued by its age in minutes, with the events it
	 * handled since its last report and its open sockets in `double2` and
	 * `double3`.
	 */
	| "awake"
	/**
	 * A user active on a UTC day (ApronDemoServer.noteActive): `read` the
	 * first frame or sign-in of a connection's day, `write` its first new
	 * message that day; then the tier (`registered`, `guest` or `bot`) and
	 * who: the user_id, or for a guest (a new id each sign-in) `ip:` and its
	 * hashed address key. At most one of each a connection a day; count
	 * distinct `blob4` for daily, weekly and monthly active users. Internal:
	 * the dataset is read only with the account's API token.
	 */
	| "active";

export function recordMetric(dataset: AnalyticsEngineDataset | undefined, event: MetricEvent, details: readonly string[] = [], value: number | readonly number[] = 1): void {
	if (!dataset) return;
	try {
		dataset.writeDataPoint({ indexes: [event], blobs: [event, ...details], doubles: typeof value === "number" ? [value] : [...value] });
	} catch { /* a metric never breaks what it counts */ }
}
