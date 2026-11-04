/**
 * When one kind of work next falls due, held in memory for the object's
 * alarm: the earliest of the times noted for it, or none. The runtime keeps
 * one per kind of server work (ApronDemoServer.deadlines) and schedules the
 * alarm for the earliest of them all, so every deadline the alarm acts on is
 * also one it is scheduled for, and each is moved by the same few rules
 * rather than by its own `undefined`, infinity and `Math.min` handling.
 *
 * In memory only: a wake forgets it, and the work it stood for is then
 * found again from storage, or by the alarm that woke the object.
 */
export class Deadline {
	private time: number | undefined;

	/** The time it falls due, or undefined for none. */
	get at(): number | undefined {
		return this.time;
	}

	/** Whether `at` is sooner than the time it falls due now (any time is sooner than none). */
	isSooner(at: number): boolean {
		return Number.isFinite(at) && (this.time === undefined || at < this.time);
	}

	/** Moves it earlier to `at` if that is sooner; returns whether it moved. */
	soonest(at: number): boolean {
		if (!this.isSooner(at)) return false;
		this.time = at;
		return true;
	}

	/** Sets it to exactly `at` (as recomputed from what is open now), or none; returns whether it changed. */
	set(at: number | undefined): boolean {
		const next = at !== undefined && Number.isFinite(at) ? at : undefined;
		if (next === this.time) return false;
		this.time = next;
		return true;
	}

	/** Whether it has fallen due by `now`. */
	passed(now: number): boolean {
		return this.time !== undefined && this.time <= now;
	}

	/** Forgets it: nothing is due. */
	clear(): void {
		this.time = undefined;
	}
}
