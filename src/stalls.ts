/**
 * Finds out what keeps the Durable Object slow or awake, for the `slow` and
 * `awake` metrics (src/metrics.ts).
 *
 * On a normal day the object hibernates seconds after each event. Some days
 * it stayed in memory for hours instead (on 2026-11-14 for eight). Each
 * episode began about 30 seconds after a client aborted its WebSocket
 * upgrade, when the sign-in timeout closed the socket it left; that a socket
 * accepted for a client already gone then holds the object is a hypothesis,
 * not yet reproduced. A Durable Object event's wall time runs until the next
 * event while something holds the object, so the sampled logs showed
 * minutes-long alarms that were really idle gaps. This meter tells a real
 * wait from such a hold, at almost no cost:
 *
 * - `slow`: anything that took `slowMs` or longer. Time in the Workers
 *   runtime is the time of the last I/O, so a long duration is mostly a
 *   long wait (with any computation before its last I/O, its own or other
 *   events'), never computation alone. It notes the object's own handlers (`handler`, by
 *   event), the wait for earlier changes (`queue`) and a change's own run
 *   (`mutation`, which awaits only R2 and signing), and the I/O each
 *   awaits: R2 (`r2`), pushes (`push`), the account usage reading
 *   (`analytics`), and the storage flush after an alarm (`storage`). Fast
 *   handlers with slow platform totals mean the platform waited, not us.
 * - `awake`: an instance alive `firstAwakeMs` without hibernating (a wake
 *   from hibernation builds a new one, so an instance's age is how long the
 *   object has been in memory; the runtime may keep an idle one that could
 *   hibernate, unbilled, a little longer), told then and once per `awakeMs`,
 *   with how many events it handled since the last report and what was in
 *   flight, the handlers and RPC calls still running among them: busy
 *   traffic shows many events, a stall shows few events and something
 *   pending. It is told from the next event, so an instance stuck with no
 *   new event at all reports nothing until one comes (an alarm, a message);
 *   the `slow` point comes when the stuck work ends.
 *
 * A slow key's first in a minute is written at once, and its repeats are
 * summed into one point when the minute has passed (like src/refusals.ts),
 * so a stall that slows every event writes a few points a minute, not one
 * per event. Keys are fixed names, never user input. Neither ever throws.
 */
export type StallKind = "handler" | "queue" | "mutation" | "r2" | "push" | "analytics" | "storage";

export interface StallWriter {
	/**
	 * `slow`: [kind, detail], then [count, worst ms, total ms].
	 * `awake`: [what was in flight], then [age in minutes, events since the last report, open sockets].
	 */
	(event: "slow" | "awake", details: string[], values: number[]): void;
}

export interface StallOptions {
	slowMs: number;
	windowMs: number;
	/** The first report, from the instance's start; then one every awakeMs. */
	firstAwakeMs: number;
	awakeMs: number;
}

export const STALL_DEFAULTS: Readonly<StallOptions> = Object.freeze({
	// Every handler and wait here takes milliseconds when all is well; a push
	// or the usage reading is cut off at 10 or 5 seconds.
	slowMs: 5_000,
	windowMs: 60_000,
	// An instance normally hibernates seconds after its last event: three
	// minutes up already says something holds it, and catches short episodes
	// (one held 6.5 minutes). Then every 15, at most 4 points an hour.
	firstAwakeMs: 3 * 60_000,
	awakeMs: 15 * 60_000,
});

/** What else an awake report counts: open sockets, and any other counts by name (guests, live texts, waiting pushes). */
export interface AwakeSnapshot {
	sockets: number;
	[kind: string]: number;
}

export class StallMeter {
	private readonly pending = new Map<string, { kind: StallKind; detail: string; count: number; worst: number; total: number }>();
	/** Keys written in the current window. */
	private readonly seen = new Set<string>();
	private windowStart = 0;
	private readonly inFlight = new Map<string, number>();
	private events = 0;
	private awakeReportedAt: number;
	private awakeReported = false;

	constructor(
		private readonly write: StallWriter,
		private readonly clock: () => number,
		private readonly startedAt = clock(),
		private readonly options: Readonly<StallOptions> = STALL_DEFAULTS,
	) {
		this.awakeReportedAt = startedAt;
	}

	/** Notes how long something took: written as `slow` from `slowMs` up. */
	note(kind: StallKind, detail: string, ms: number, now = this.clock()): void {
		this.flush(now);
		if (!(ms >= this.options.slowMs)) return;
		const key = `${kind}\u0000${detail}`;
		if (!this.seen.has(key)) {
			this.seen.add(key);
			this.safeWrite("slow", [kind, detail], [1, ms, ms]);
			return;
		}
		const entry = this.pending.get(key);
		if (entry) {
			entry.count += 1;
			entry.worst = Math.max(entry.worst, ms);
			entry.total += ms;
		} else this.pending.set(key, { kind, detail, count: 1, worst: ms, total: ms });
	}

	/**
	 * Times a promise, counting it in flight until it settles. Returns a
	 * promise that settles as it does; the timing never changes the outcome.
	 * `timed` false only counts it in flight: for what is long by design.
	 */
	track<T>(kind: StallKind, detail: string, work: Promise<T>, timed = true): Promise<T> {
		const start = this.clock();
		const key = detail ? `${kind}:${detail}` : kind;
		this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
		// Never throws: runMutation's queue and the handlers settle through it.
		const settle = () => {
			try {
				const left = (this.inFlight.get(key) ?? 1) - 1;
				if (left > 0) this.inFlight.set(key, left);
				else this.inFlight.delete(key);
				if (timed) this.note(kind, detail, this.clock() - start);
			} catch { /* a metric never breaks what it counts */ }
		};
		return work.then((value) => { settle(); return value; }, (error: unknown) => { settle(); throw error; });
	}

	/**
	 * Counts an event the object handles, and reports the instance as
	 * `awake` once it has lived `firstAwakeMs` since it started, then each
	 * `awakeMs` after its last report.
	 * `snapshot` is only called to report.
	 */
	event(snapshot: () => AwakeSnapshot, now = this.clock()): void {
		this.flush(now);
		this.events += 1;
		if (now - this.awakeReportedAt < (this.awakeReported ? this.options.awakeMs : this.options.firstAwakeMs)) return;
		this.awakeReportedAt = now;
		this.awakeReported = true;
		let state: AwakeSnapshot;
		try { state = snapshot(); } catch { state = { sockets: -1 }; }
		const { sockets, ...others } = state;
		const parts = [...this.inFlight, ...Object.entries(others)]
			.filter(([, count]) => count > 0)
			.map(([kind, count]) => `${kind}=${count}`)
			.sort();
		this.safeWrite("awake", [parts.join(" ") || "none"], [Math.round((now - this.startedAt) / 60_000), this.events, sockets]);
		this.events = 0;
	}

	/** Writes the repeats held over a finished window, and starts a new one. */
	flush(now = this.clock()): void {
		if (now - this.windowStart < this.options.windowMs) return;
		for (const { kind, detail, count, worst, total } of this.pending.values()) this.safeWrite("slow", [kind, detail], [count, worst, total]);
		this.pending.clear();
		this.seen.clear();
		this.windowStart = now;
	}

	private safeWrite(event: "slow" | "awake", details: string[], values: number[]): void {
		try { this.write(event, details, values); } catch { /* a metric never breaks what it counts */ }
	}
}
