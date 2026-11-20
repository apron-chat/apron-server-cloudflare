/*
 * The pipeline's pure core: what to do next, what to
 * ask each tier for a page, how pages merge, and what must always hold.
 * Synchronous, no I/O; HistoryPipeline (pipeline.ts) executes the plans.
 */

import { type ChatRecord, type HistoryQuery, limitByLogId } from "./records";
import type { TierState } from "./tier";

/** One tier as the planner sees it. Index 0 is the head. */
export interface TierView {
	name: string;
	readable: boolean;
	state: TierState;
}

/** The pipeline's state, plus what the running cycle has done already. */
export interface PipelineSnapshot {
	tiers: readonly TierView[];
	/** The head's published floor. */
	published: number;
	/** The newest op in the head's op log (0: none). */
	opsSeq: number;
	/** Tiers whose target this cycle has found. */
	targeted: ReadonlySet<number>;
	/** The floor each tier was asked to advance to, this cycle (the head's advances by its own cleanup, later). */
	advanced: ReadonlyMap<number, number>;
	/** The floor each tier was last trimmed below, completely. */
	trimmed: ReadonlyMap<number, number>;
}

export type Step =
	/** Apply the op log past `after` to tier `tier`. */
	| { kind: "ops"; tier: number; after: number }
	/** Find tier `tier`'s target (floorFor). */
	| { kind: "target"; tier: number }
	/** Copy tier `from`'s next batch from `start`, below `below`, into tier `to`, then mark `through`. */
	| { kind: "copy"; from: number; to: number; start: number; below: number }
	/** Raise tier `tier`'s floor. */
	| { kind: "advance"; tier: number; floor: number }
	/** Delete tier `tier`'s records below `below`. */
	| { kind: "trim"; tier: number; below: number }
	/** Raise the head's published floor. */
	| { kind: "publish"; floor: number }
	| { kind: "idle" };

/** The deepest readable tier: history is published from its floor. */
export function deepestReadable(tiers: readonly Pick<TierView, "readable">[]): number {
	for (let index = tiers.length - 1; index > 0; index -= 1) if (tiers[index].readable) return index;
	return 0;
}

/** The floor tier `index` may advance to now: its target, never past what the next tier holds (I2) nor the floor above (I1). */
export function allowedFloor(tiers: readonly TierView[], index: number): number {
	const state = tiers[index].state;
	let floor = state.target;
	if (index < tiers.length - 1) floor = Math.min(floor, state.through + 1);
	if (index > 0) floor = Math.min(floor, tiers[index - 1].state.floor);
	return Math.max(state.floor, floor);
}

/**
 * The next step of a cycle: first the op log for each tier below the
 * head, in order (an op reaches a tier once every tier above it applied
 * it); then bottom-up, so space is made before it is
 * filled, each tier's target, copy of what is below it to the next tier,
 * advance and trim; then the published floor.
 */
export function planStep(snapshot: PipelineSnapshot): Step {
	const { tiers } = snapshot;
	const last = tiers.length - 1;
	for (let index = 1; index <= last; index += 1) {
		if (tiers[index].state.ops < snapshot.opsSeq) return { kind: "ops", tier: index, after: tiers[index].state.ops };
	}
	const deepest = deepestReadable(tiers);
	for (let index = last; index >= 0; index -= 1) {
		const state = tiers[index].state;
		if (!snapshot.targeted.has(index)) return { kind: "target", tier: index };
		if (index < last) {
			const start = Math.max(state.floor, state.through + 1);
			if (start < state.target) return { kind: "copy", from: index, to: index + 1, start, below: state.target };
		}
		const floor = allowedFloor(tiers, index);
		if (floor > Math.max(state.floor, snapshot.advanced.get(index) ?? 0)) return { kind: "advance", tier: index, floor };
		let trimTo = Math.max(state.floor, snapshot.advanced.get(index) ?? 0);
		if (index === deepest) {
			// History is served from the published floor: it rises before the
			// deepest readable tier lets anything go.
			if (trimTo > snapshot.published) return { kind: "publish", floor: trimTo };
			trimTo = Math.min(trimTo, snapshot.published);
		}
		if ((snapshot.trimmed.get(index) ?? 0) < trimTo) return { kind: "trim", tier: index, below: trimTo };
	}
	return { kind: "idle" };
}

/**
 * What must always hold, as readable violations; empty when all
 * do. I3 and I4 need the tiers' contents: the model tests check them.
 */
export function checkInvariants(tiers: readonly Pick<TierView, "name" | "readable" | "state">[], published: number, previous?: { tiers: readonly Pick<TierView, "name" | "state">[]; published: number }): string[] {
	const violations: string[] = [];
	for (let index = 1; index < tiers.length; index += 1) {
		// I1: ordered floors.
		if (tiers[index].state.floor > tiers[index - 1].state.floor) {
			violations.push(`I1: ${tiers[index].name}'s floor ${tiers[index].state.floor} is above ${tiers[index - 1].name}'s ${tiers[index - 1].state.floor}`);
		}
	}
	for (let index = 0; index < tiers.length - 1; index += 1) {
		// I2: copy before trim.
		const state = tiers[index].state;
		if (state.floor > state.through + 1) violations.push(`I2: ${tiers[index].name}'s floor ${state.floor} passed what ${tiers[index + 1].name} holds (through ${state.through})`);
	}
	// I6: history starts at the deepest readable tier's floor.
	const deepest = tiers[deepestReadable(tiers as TierView[])].state.floor;
	if (published > deepest) violations.push(`I6: the published floor ${published} is above ${deepest}, the deepest readable tier's`);
	if (previous) {
		for (const tier of tiers) {
			const before = previous.tiers.find((other) => other.name === tier.name);
			if (before && tier.state.floor < before.state.floor) violations.push(`I1: ${tier.name}'s floor fell from ${before.state.floor} to ${tier.state.floor}`);
		}
		if (published < previous.published) violations.push(`I6: the published floor fell from ${previous.published} to ${published}`);
	}
	return violations;
}

/** One tier's part of a page. */
export interface ReadPart {
	tier: number;
	query: HistoryQuery;
}

/**
 * Which tier serves which part of a page's window: each readable
 * tier the log IDs from its floor up to the floor of the readable tier
 * above it (records it holds past that are copies, served above), none
 * below the published floor. In fill order: a forward page reads the
 * oldest first, a backward page the newest.
 */
export function planRead(query: HistoryQuery, tiers: readonly Pick<TierView, "readable" | "state">[], published: number, options: { skipHead?: boolean } = {}): ReadPart[] {
	const parts: ReadPart[] = [];
	const deepest = deepestReadable(tiers);
	let above = Number.POSITIVE_INFINITY;
	for (let index = 0; index < tiers.length; index += 1) {
		const tier = tiers[index];
		if (!tier.readable) continue;
		// The deepest readable tier serves down to the published floor, which its trimming waits for.
		const lower = Math.max(query.lower, index === deepest ? published : tier.state.floor, published);
		const upper = Math.min(query.upper, above - 1);
		above = Math.min(above, tier.state.floor);
		if (lower > upper || (index === 0 && options.skipHead)) continue;
		parts.push({ tier: index, query: { ...query, lower, upper } });
	}
	return query.forward ? parts.reverse() : parts;
}

/**
 * Pages from several tiers as one: by log ID, the first `limit` distinct
 * ones nearest the page's start. Where two tiers hold the same record (room
 * and log ID), the upper one wins: only upper tiers may have been purged.
 */
export function mergePages(pages: ReadonlyArray<{ tier: number; records: readonly ChatRecord[] }>, query: Pick<HistoryQuery, "forward" | "limit">): ChatRecord[] {
	const chosen = new Map<string, { tier: number; record: ChatRecord }>();
	for (const page of pages) {
		for (const record of page.records) {
			const key = `${record.log_id}\u0000${record.room_id}`;
			const held = chosen.get(key);
			if (!held || page.tier < held.tier) chosen.set(key, { tier: page.tier, record });
		}
	}
	return limitByLogId([...chosen.values()].map((entry) => entry.record), query.limit, query.forward);
}
