/*
 * Links: the pure core of the chain. A link joins one tier to the next and
 * carries two things down it, in one order: copies of the records leaving
 * the tier above, and the rewrites (/purge, /rename) the head logged. This
 * module plans what the next step is, what each tier serves of a page, and
 * what must always hold. Synchronous, no I/O; HistoryChain (chain.ts)
 * executes the plans.
 *
 * Each step is a link's or a tier's own, and depends only on its
 * neighbours:
 *
 * - deliver: link `i` hands its tier below the next rewrite the tier above
 *   has (the head has every one). A tier that cannot take rewrites has them
 *   acknowledged: the link moves on.
 * - copy: link `i` copies what its tier above holds below that tier's
 *   target, once that tier is current (every rewrite delivered to it): a
 *   copy never carries a record a rewrite on its way would change. Into a
 *   tier that takes whole batches (HistoryTier.appendBatch: the cold tier's
 *   chunks), only a whole batch at a time, unless the tier above is at its
 *   limit (copyNow): until then the link waits, and the tier above holds
 *   the rest.
 * - target, advance, trim: a tier's own floor, never past what the link
 *   below holds of it (copy before delete) nor past the tier above.
 * - publish: the deepest tier's floor is where history starts; it rises
 *   before that tier lets anything go.
 *
 * Steps run bottom-up, so space is made below before the tiers above fill it.
 */

import { type ChatRecord, type HistoryQuery, limitByLogId } from "./records";
import type { ChainState, LinkState, TierFloor } from "./tier";

/** One tier as the planner sees it. Index 0 is the head. */
export interface TierView extends TierFloor {
	name: string;
	/** Whether it takes rewrites (HistoryTier.rewrite). */
	rewrites: boolean;
}

/** The chain as the planner sees it: tiers, and the links between them (link `i` joins tier `i` to `i + 1`). */
export interface ChainView {
	tiers: readonly TierView[];
	links: readonly LinkState[];
}

/** The chain's state, plus what the running round of cycles has done already. */
export interface ChainSnapshot extends ChainView {
	/** The head's published floor. */
	published: number;
	/** The newest rewrite in the head's log (0: none). */
	logged: number;
	/**
	 * The oldest rewrite still in the head's log (logged + 1: none). Older
	 * ones were delivered everywhere there was a link then: a link that has
	 * delivered fewer is new, its tier empty when they were logged, so it
	 * starts here.
	 */
	oldest: number;
	/** Tiers whose target this round has found. */
	targeted: ReadonlySet<number>;
	/** The floor each tier was asked to advance to, this round (the head's advances by its own cleanup, later). */
	advanced: ReadonlyMap<number, number>;
	/** The floor each tier was last trimmed below, completely. */
	trimmed: ReadonlyMap<number, number>;
	/**
	 * Links waiting for a whole batch this round (copyNow said no), by what
	 * the tier above held then (arrivedThrough): they look again only once
	 * more has arrived in it.
	 */
	waiting: ReadonlyMap<number, number>;
}

export type Step =
	/** Link `link` delivers rewrite `seq` to the tier below it. */
	| { kind: "deliver"; link: number; seq: number }
	/** Find tier `tier`'s target (floorFor). */
	| { kind: "target"; tier: number }
	/** Link `link` copies its tier above's next batch from `start`, below `below`, then marks `through`. */
	| { kind: "copy"; link: number; start: number; below: number }
	/** Raise tier `tier`'s floor. */
	| { kind: "advance"; tier: number; floor: number }
	/** Delete tier `tier`'s records below `below`. */
	| { kind: "trim"; tier: number; below: number }
	/** Raise the head's published floor. */
	| { kind: "publish"; floor: number }
	| { kind: "idle" };

/** The step kinds that can fail (and so stall a link). */
export type WorkStep = Exclude<Step["kind"], "idle">;

/**
 * Whether a link into a tier that takes whole batches copies now: a whole
 * batch is due (`pending` records below the tier above's target), the tier
 * above holds its limit or more (`held` of `limit` records: it must let
 * them go now), or no count limits it (its retention is by age or bytes
 * alone). Otherwise the link waits, so the tier below gets whole batches,
 * and the tier above holds at most its limit and one batch.
 */
export function copyNow(input: { pending: number; batch: number; held: number; limit?: number }): boolean {
	return input.pending >= input.batch || input.limit === undefined || input.limit <= 0 || input.held >= input.limit;
}

/** What has arrived in the tier above link `link`, for `waiting`: the copy marker of the link into it (-1 for the head, which nothing copies into). */
export function arrivedThrough(chain: Pick<ChainView, "links">, link: number): number {
	return link === 0 ? -1 : chain.links[link - 1].through;
}

/**
 * The next rewrite link `link` delivers: after what it has, from the oldest
 * still logged. Where the log holds none it has yet to deliver (all gone
 * from it), the step acknowledges up to what the tier above holds.
 */
export function nextRewrite(snapshot: Pick<ChainSnapshot, "links" | "oldest">, link: number): number {
	return Math.max(snapshot.links[link].delivered + 1, snapshot.oldest);
}

/** The newest rewrite the tier above link `link` holds: the head holds every one logged. */
export function upstream(chain: Pick<ChainView, "links">, link: number, logged: number): number {
	return link === 0 ? logged : chain.links[link - 1].delivered;
}

/** Whether tier `tier` holds every rewrite logged: copies from it then carry none on its way. */
export function current(chain: Pick<ChainView, "links">, tier: number, logged: number): boolean {
	return tier === 0 || chain.links[tier - 1].delivered >= logged;
}

/** The floor tier `index` may advance to now: its target, never past what the link below holds (I2) nor the floor above (I1). */
export function allowedFloor(chain: ChainView, index: number): number {
	const tier = chain.tiers[index];
	let floor = tier.target;
	if (index < chain.tiers.length - 1) floor = Math.min(floor, chain.links[index].through + 1);
	if (index > 0) floor = Math.min(floor, chain.tiers[index - 1].floor);
	return Math.max(tier.floor, floor);
}

/** The next step of a cycle (see the top of the file). */
export function planStep(snapshot: ChainSnapshot): Step {
	const { tiers, links, logged } = snapshot;
	const last = tiers.length - 1;
	for (let index = last; index >= 0; index -= 1) {
		const tier = tiers[index];
		if (index > 0) {
			const link = index - 1;
			const above = upstream(snapshot, link, logged);
			if (links[link].delivered < above) return { kind: "deliver", link, seq: Math.min(nextRewrite(snapshot, link), above) };
		}
		if (!snapshot.targeted.has(index)) return { kind: "target", tier: index };
		if (index < last && current(snapshot, index, logged)) {
			const start = Math.max(tier.floor, links[index].through + 1);
			const waiting = snapshot.waiting.get(index) === arrivedThrough(snapshot, index);
			if (start < tier.target && !waiting) return { kind: "copy", link: index, start, below: tier.target };
		}
		const floor = allowedFloor(snapshot, index);
		const advanced = Math.max(tier.floor, snapshot.advanced.get(index) ?? 0);
		if (floor > advanced) return { kind: "advance", tier: index, floor };
		let trimTo = advanced;
		if (index === last) {
			// History is served from the published floor: it rises before the
			// deepest tier lets anything go.
			if (trimTo > snapshot.published) return { kind: "publish", floor: trimTo };
			trimTo = Math.min(trimTo, snapshot.published);
		}
		if ((snapshot.trimmed.get(index) ?? 0) < trimTo) return { kind: "trim", tier: index, below: trimTo };
	}
	return { kind: "idle" };
}

/**
 * What must always hold, as readable violations; empty when all do. I3 and
 * I4 need the tiers' contents: the model tests check them.
 *
 * - I1: floors are ordered down the chain, and never fall.
 * - I2: a tier's floor never passes what the link below holds of it (copy before delete).
 * - I7: rewrites go down in order: a link has delivered no more than the tier above holds, and never fewer than before.
 * - I6: history starts at the deepest tier's floor or above, and never earlier than before.
 */
export function checkInvariants(chain: ChainView, published: number, logged: number, previous?: { chain: ChainView; published: number }): string[] {
	const violations: string[] = [];
	const { tiers, links } = chain;
	for (let index = 1; index < tiers.length; index += 1) {
		if (tiers[index].floor > tiers[index - 1].floor) violations.push(`I1: ${tiers[index].name}'s floor ${tiers[index].floor} is above ${tiers[index - 1].name}'s ${tiers[index - 1].floor}`);
	}
	for (let index = 0; index < links.length; index += 1) {
		if (tiers[index].floor > links[index].through + 1) violations.push(`I2: ${tiers[index].name}'s floor ${tiers[index].floor} passed what ${tiers[index + 1].name} holds (through ${links[index].through})`);
		const above = upstream(chain, index, logged);
		if (links[index].delivered > above) violations.push(`I7: ${tiers[index + 1].name} was delivered rewrite ${links[index].delivered}, past ${above}, what ${tiers[index].name} holds`);
	}
	const deepest = tiers[tiers.length - 1].floor;
	if (published > deepest) violations.push(`I6: the published floor ${published} is above ${deepest}, the deepest tier's`);
	if (previous) {
		for (const [index, tier] of tiers.entries()) {
			const before = previous.chain.tiers.find((other) => other.name === tier.name);
			if (before && tier.floor < before.floor) violations.push(`I1: ${tier.name}'s floor fell from ${before.floor} to ${tier.floor}`);
			const link = links[index];
			const was = previous.chain.links[index];
			if (link && was && previous.chain.tiers[index]?.name === tier.name && link.delivered < was.delivered) violations.push(`I7: the link from ${tier.name} went back from rewrite ${was.delivered} to ${link.delivered}`);
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
 * Which tier serves which part of a page's window: each tier the log IDs
 * from its floor up to the floor of the tier above it (records it holds past
 * that are copies, served above), none below the published floor. In fill
 * order: a forward page reads the oldest first, a backward page the newest.
 */
export function planRead(query: HistoryQuery, tiers: readonly TierFloor[], published: number, options: { skipHead?: boolean } = {}): ReadPart[] {
	const parts: ReadPart[] = [];
	let above = Number.POSITIVE_INFINITY;
	for (const [index, tier] of tiers.entries()) {
		// The deepest tier serves down to the published floor, which its trimming waits for.
		const lower = Math.max(query.lower, index === tiers.length - 1 ? published : tier.floor, published);
		const upper = Math.min(query.upper, above - 1);
		above = Math.min(above, tier.floor);
		if (lower > upper || (index === 0 && options.skipHead)) continue;
		parts.push({ tier: index, query: { ...query, lower, upper } });
	}
	return query.forward ? parts.reverse() : parts;
}

/**
 * Pages from several tiers as one: by log ID, the first `limit` distinct
 * ones nearest the page's start. Where two tiers hold the same record (room
 * and log ID), the upper one wins: a rewrite reaches upper tiers first.
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

/** A ChainState with the tiers' names and capabilities: what the planner reads. */
export function chainView(state: ChainState, tiers: ReadonlyArray<{ name: string; rewrites: boolean }>): ChainView {
	return { tiers: tiers.map((tier, index) => ({ ...state.tiers[index], name: tier.name, rewrites: tier.rewrites })), links: state.links };
}
