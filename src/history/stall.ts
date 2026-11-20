/*
 * A hop's stall: whether the work of copying from one tier into the next
 * (the copy itself, or a step on the tier below that the copy waits on) is
 * failing, since when, and whether admins were told. One lifecycle, used by
 * the pipeline and by the runtime for a tier it cannot reach (the D1 tier
 * unbound):
 *
 *   ok --fail(step)--> stalled(since, step) --alert--> alerted(since, step, at)
 *   stalled | alerted --clear(step)--> ok, when `step` is a copy or the step that failed
 *
 * A success of some other step clears nothing: a trim that works says
 * nothing of a copy that keeps failing.
 *
 * Persisted as `stalledSince`, `stalledOn` and `alertedAt` (fields), the
 * shape tier state is kept in; a stall without `stalledOn` was a copy's.
 */

/** The step kinds that can stall a hop (plan.ts Step kinds, but `idle`). */
export type StallStep = "ops" | "target" | "copy" | "advance" | "trim" | "publish";

export type Stall =
	| { kind: "ok" }
	| { kind: "stalled"; since: number; step: StallStep }
	| { kind: "alerted"; since: number; step: StallStep; at: number };

export const NOT_STALLED: Stall = Object.freeze({ kind: "ok" });

/** `step` failed at `now`: a stall starts, or goes on as it was (its start and alert kept). */
export function stallFailed(stall: Stall, now: number, step: StallStep): Stall {
	return stall.kind === "ok" ? { kind: "stalled", since: now, step } : stall;
}

/** `step` succeeded: a copy ends any stall, any other step only the stall it started. */
export function stallCleared(stall: Stall, step: StallStep): Stall {
	return stall.kind !== "ok" && (step === "copy" || step === stall.step) ? NOT_STALLED : stall;
}

/** The stall as alerted, when it has lasted `afterMs` and admins were not told yet; undefined otherwise. */
export function stallAlert(stall: Stall, now: number, afterMs: number): Extract<Stall, { kind: "alerted" }> | undefined {
	return stall.kind === "stalled" && now - stall.since >= afterMs ? { kind: "alerted", since: stall.since, step: stall.step, at: now } : undefined;
}

/** The persisted fields of a stall. */
export interface StallFields {
	stalledSince?: number;
	stalledOn?: StallStep;
	alertedAt?: number;
}

const STEPS: readonly string[] = ["ops", "target", "copy", "advance", "trim", "publish"];

export function stallFromFields(fields: StallFields | undefined): Stall {
	if (typeof fields?.stalledSince !== "number") return NOT_STALLED;
	const step = typeof fields.stalledOn === "string" && STEPS.includes(fields.stalledOn) ? fields.stalledOn : "copy";
	return typeof fields.alertedAt === "number"
		? { kind: "alerted", since: fields.stalledSince, step, at: fields.alertedAt }
		: { kind: "stalled", since: fields.stalledSince, step };
}

export function stallToFields(stall: Stall): StallFields {
	if (stall.kind === "ok") return {};
	return { stalledSince: stall.since, stalledOn: stall.step, ...(stall.kind === "alerted" ? { alertedAt: stall.at } : {}) };
}
