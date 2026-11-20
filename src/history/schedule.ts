/*
 * HistorySchedule: when history upkeep runs, and what may run beside it.
 * One state for each of the two questions the runtime used to answer with
 * loose fields:
 *
 * - What is running: nothing, a pipeline cycle, or a job (an export, an
 *   import, a scheduled backup), one at a time, plus any number of rewrites
 *   (`/purge`, `/rename`) at the head. Each is held by a lease that only
 *   `acquire` hands out, and only once: a holder releases it, and releasing
 *   twice is an error. A cycle waits for a job (tiers must not move under
 *   its plan), a job for a cycle (it must not write between a cycle's copy
 *   and its copy marker). An import and a rewrite exclude each other: an
 *   import's later writes would put back what a purge removed, past the
 *   op the tiers below already applied.
 * - Whether a cycle is wanted: unknown after a wake (queued ops unread),
 *   idle, due (a cycle asked to go on, or an op was queued), or backing off
 *   after a failure until a time. A cycle that finds the lock held leaves
 *   itself due, and the lease's release says so, so the holder asks for it
 *   then: nothing polls while a job runs.
 *
 * Pure: no clock, no I/O; the runtime asks and schedules.
 */

/** A history job: what an admin or the backup schedule runs. */
export type HistoryJob = "export" | "import" | "backup";

/** What may hold the history lock. */
export type HistoryHolder = { kind: "cycle" } | { kind: "job"; job: HistoryJob } | { kind: "rewrite" };

/** Whether a cycle is wanted. */
export type HistoryWant =
	| { kind: "unknown" }
	| { kind: "idle" }
	| { kind: "due" }
	| { kind: "backoff"; until: number; failures: number };

/** A held part of the lock: its holder, and the one way to give it back. */
export interface HistoryLease<H extends HistoryHolder = HistoryHolder> {
	readonly holder: H;
	/** Gives the lease back; `cycleSoon`: a cycle waited for it, so ask for one now. */
	release(): { cycleSoon: boolean };
}

/** Why a lease was refused: what holds the lock. */
export type HistoryRefusal = { refused: "cycle" } | { refused: "job"; job: HistoryJob } | { refused: "rewrite" };

/** Why a history job, `/purge` or `/rename` cannot start now. */
export function refusalMessage(refusal: HistoryRefusal): string {
	switch (refusal.refused) {
		case "cycle":
			return "History upkeep is running; try again in a moment";
		case "rewrite":
			return "A purge or rename is running; try again in a moment";
		case "job":
			return refusal.job === "import" ? "A history import is running; try again when it ends" : "Another history export or import is running; try again when it ends";
	}
}

export class HistorySchedule {
	private running: { kind: "none" } | { kind: "cycle" } | { kind: "job"; job: HistoryJob } = { kind: "none" };
	private rewrites = 0;
	private wanted: HistoryWant = { kind: "unknown" };

	/** What is wanted of upkeep now (for /status and tests). */
	get want(): HistoryWant {
		return this.wanted;
	}

	/** What holds the exclusive part of the lock (for /status and tests). */
	get holder(): "cycle" | HistoryJob | undefined {
		return this.running.kind === "none" ? undefined : this.running.kind === "cycle" ? "cycle" : this.running.job;
	}

	/** Whether the last cycles failed: cleanup then waits longer for the copy below. */
	get retrying(): boolean {
		return this.wanted.kind === "backoff" && this.wanted.failures > 0;
	}

	/** A lease for `holder`, or why not: see the file's comment for what excludes what. */
	acquire<H extends HistoryHolder>(holder: H): HistoryLease<H> | HistoryRefusal {
		const refusal = this.refusal(holder);
		if (refusal) {
			// A cycle that waits is wanted when the lock is released.
			if (holder.kind === "cycle") this.wanted = { kind: "due" };
			return refusal;
		}
		if (holder.kind === "rewrite") this.rewrites += 1;
		else this.running = holder.kind === "cycle" ? { kind: "cycle" } : { kind: "job", job: holder.job };
		let released = false;
		return {
			holder,
			release: () => {
				if (released) throw new Error("a history lease was released twice");
				released = true;
				if (holder.kind === "rewrite") this.rewrites -= 1;
				else this.running = { kind: "none" };
				return { cycleSoon: holder.kind === "job" && this.wanted.kind === "due" };
			},
		};
	}

	private refusal(holder: HistoryHolder): HistoryRefusal | undefined {
		const running = this.running;
		if (holder.kind === "rewrite") return running.kind === "job" && running.job === "import" ? { refused: "job", job: "import" } : undefined;
		if (running.kind === "cycle") return { refused: "cycle" };
		if (running.kind === "job") return { refused: "job", job: running.job };
		if (holder.kind === "job" && holder.job === "import" && this.rewrites > 0) return { refused: "rewrite" };
		return undefined;
	}

	/** Whether a cycle may run now: not while backing off. */
	mayRun(now: number): boolean {
		return this.wanted.kind !== "backoff" || now >= this.wanted.until;
	}

	/**
	 * Whether upkeep has work for an alarm: a cycle that is due or done
	 * backing off, or, once a wake, queued ops (`hasOps`; a failure to read
	 * them counts as work).
	 */
	workDue(now: number, hasOps: () => boolean): boolean {
		switch (this.wanted.kind) {
			case "due":
				return true;
			case "idle":
				return false;
			case "backoff":
				return now >= this.wanted.until;
			case "unknown":
				try {
					if (!hasOps()) {
						this.wanted = { kind: "idle" };
						return false;
					}
				} catch {
					return true;
				}
				this.wanted = { kind: "due" };
				return true;
		}
	}

	/** A `/purge` or `/rename` was queued for the tiers below, or work asks for a cycle: due now, whatever backed off. */
	request(): void {
		this.wanted = { kind: "due" };
	}

	/** Nothing can move below the head for now (the D1 tier unbound): no cycle is wanted. */
	idle(): void {
		this.wanted = { kind: "idle" };
	}

	/** A cycle ended: `more` asks for another soon. */
	succeeded(more: boolean): void {
		this.wanted = more ? { kind: "due" } : { kind: "idle" };
	}

	/**
	 * A cycle failed (`step`: a step of it; else its state could not be read
	 * or saved): due again after `retryMs`, each step failure counted.
	 */
	failed(now: number, retryMs: number, step: boolean): void {
		const failures = this.wanted.kind === "backoff" ? this.wanted.failures : 0;
		this.wanted = { kind: "backoff", until: now + retryMs, failures: step ? failures + 1 : failures };
	}
}

/** Whether `acquire` refused. */
export function isRefusal(result: HistoryLease | HistoryRefusal): result is HistoryRefusal {
	return "refused" in result;
}
