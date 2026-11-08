/**
 * Counts what the server refuses, for the `refusal` metric (src/metrics.ts):
 * JSON-RPC errors (`error`), connections closed by policy (`close`), and
 * HTTP refusals the object answers before an upgrade (`http`). Workers Logs
 * are sampled and log none of these, so without this count nobody could
 * tell which limits users actually run into.
 *
 * A refusal is written at once the first time its key is seen in a window
 * (`windowMs`), so one that happens once and is followed by hibernation is
 * still counted; repeats inside the window are added up and written as one
 * data point when the window has passed (`flush`, from the next event or
 * alarm). A key is thus at most two data points a window, however many
 * refusals it counts, and at most `maxKeys` keys are kept: the rest count
 * under one `overflow` key. So a flood of refusals writes at most 130 points
 * a minute, under 6 million a month at worst, inside the 10 million
 * Workers Paid includes. Repeats an evicted instance held unwritten are
 * lost, which undercounts a burst, never a single refusal.
 */
export type RefusalKind = "error" | "close" | "http";

export interface RefusalWriter {
	(kind: RefusalKind, reason: string, detail: string, count: number): void;
}

const MAX_PART_LENGTH = 96;

export class RefusalMeter {
	private readonly pending = new Map<string, { kind: RefusalKind; reason: string; detail: string; count: number }>();
	/** Keys written in the current window, with or without repeats since. */
	private readonly seen = new Set<string>();
	private windowStart = 0;

	constructor(
		private readonly write: RefusalWriter,
		private readonly windowMs = 60_000,
		private readonly maxKeys = 64,
	) {}

	note(kind: RefusalKind, reason: string, detail: string, now: number): void {
		this.flush(now);
		reason = reason.slice(0, MAX_PART_LENGTH);
		detail = detail.slice(0, MAX_PART_LENGTH);
		let key = `${kind}\u0000${reason}\u0000${detail}`;
		if (!this.seen.has(key) && this.seen.size >= this.maxKeys) {
			key = "overflow";
			kind = "error";
			reason = "overflow";
			detail = "";
		}
		if (!this.seen.has(key)) {
			this.seen.add(key);
			this.safeWrite(kind, reason, detail, 1);
			return;
		}
		const entry = this.pending.get(key);
		if (entry) entry.count += 1;
		else this.pending.set(key, { kind, reason, detail, count: 1 });
	}

	/** Writes the repeats held over a finished window, and starts a new one. */
	flush(now: number): void {
		if (now - this.windowStart < this.windowMs) return;
		for (const { kind, reason, detail, count } of this.pending.values()) this.safeWrite(kind, reason, detail, count);
		this.pending.clear();
		this.seen.clear();
		this.windowStart = now;
	}

	private safeWrite(kind: RefusalKind, reason: string, detail: string, count: number): void {
		try { this.write(kind, reason, detail, count); } catch { /* a metric never breaks what it counts */ }
	}
}
