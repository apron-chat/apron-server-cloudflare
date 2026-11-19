/*
 * HistoryPipeline (PLAN §4, §6–§8): the head and the tiers below it, in
 * order, and every rule between them. It runs bounded maintenance cycles
 * (copy down, mark, advance, trim, publish), serves history pages across
 * tiers, and carries /purge and /rename down to each rewritable tier.
 * Planning is pure (plan.ts); this file only executes.
 */

import { type PipelineSnapshot, type ReadPart, type Step, type TierView, deepestReadable, mergePages, planRead, planStep, rewritableReach } from "./plan";
import { type ChatRecord, type Clock, type HistoryOp, type HistoryQuery, type QueuedOp, type Retention, type TierStats, applyOps, logIds, toRange } from "./records";
import { type HistoryHead, type HistoryTier, type RewritableTier, type TierState, type TierStateStore, isRewritable } from "./tier";

export interface PipelineStage {
	tier: HistoryTier;
	retention: Retention;
	/** Whether history pages read it (default: when it has `read`). */
	readable?: boolean;
	/** A label for /status, e.g. "D1". */
	label?: string;
}

export interface CycleReport {
	steps: Step[];
	copied: number;
	trimmed: number;
	/** The step that failed, and why. */
	failure?: { step: Step; error: unknown };
}

export interface PipelineOptions {
	head: HistoryHead;
	headRetention: Retention;
	stages: readonly PipelineStage[];
	state: TierStateStore;
	clock: Clock;
	/** Log IDs per copy step. */
	batch?: number;
	/** Records per trim step. */
	trimBatch?: number;
	/** How long an applied op still applies to pages read below the head (a page may have read before it applied). */
	recentOpsMs?: number;
	/** The head's label for /status. */
	headLabel?: string;
}

export interface TierReport {
	name: string;
	label: string;
	stats: TierStats;
	state: TierState;
	retention: Retention;
	readable: boolean;
	rewritable: boolean;
}

const DEFAULT_BATCH = 100;
const DEFAULT_TRIM_BATCH = 500;
const DEFAULT_RECENT_OPS_MS = 60_000;

export class HistoryPipeline {
	readonly head: HistoryHead;
	readonly tiers: readonly HistoryTier[];
	private readonly retentions: readonly Retention[];
	private readonly readable: readonly boolean[];
	private readonly labels: readonly string[];
	private readonly state: TierStateStore;
	private readonly clock: Clock;
	private readonly batch: number;
	private readonly trimBatch: number;
	private readonly recentOpsMs: number;
	/** The floor each tier was last trimmed below, completely, in this instance. */
	private readonly trimmed = new Map<number, number>();
	/** What the running round of cycles has done: it ends when a cycle finds nothing to do. */
	private round = HistoryPipeline.newRound();
	private static newRound() {
		return { targeted: new Set<number>(), advanced: new Map<number, number>(), upkept: new Set<number>(), worked: false };
	}
	/** Ops applied lately, for pages that read a tier before they were (PLAN §8). */
	private recent: Array<{ op: HistoryOp; at: number }> = [];

	constructor(options: PipelineOptions) {
		this.head = options.head;
		this.tiers = [options.head, ...options.stages.map((stage) => stage.tier)];
		this.retentions = [options.headRetention, ...options.stages.map((stage) => stage.retention)];
		this.readable = [true, ...options.stages.map((stage) => stage.readable ?? typeof stage.tier.read === "function")];
		this.labels = [options.headLabel ?? "SQLite", ...options.stages.map((stage) => stage.label ?? stage.tier.name)];
		this.state = options.state;
		this.clock = options.clock;
		this.batch = options.batch ?? DEFAULT_BATCH;
		this.trimBatch = options.trimBatch ?? DEFAULT_TRIM_BATCH;
		this.recentOpsMs = options.recentOpsMs ?? DEFAULT_RECENT_OPS_MS;
	}

	/** Whether any tier is below the head. */
	get tiered(): boolean {
		return this.tiers.length > 1;
	}

	/** The tiers as the planner sees them, with their saved state. */
	async views(): Promise<TierView[]> {
		const states = await this.state.load(this.tiers.map((tier) => tier.name));
		return this.tiers.map((tier, index) => ({
			name: tier.name,
			readable: this.readable[index],
			rewritable: isRewritable(tier),
			multiRoom: tier.multiRoom ?? true,
			upkeep: typeof tier.upkeep === "function",
			state: states[tier.name],
		}));
	}

	async snapshot(progress: Pick<PipelineSnapshot, "targeted" | "advanced" | "upkept"> = { targeted: new Set(), advanced: new Map(), upkept: new Set() }): Promise<PipelineSnapshot> {
		const [tiers, published, ops] = await Promise.all([this.views(), this.head.publishedFloor(), this.head.ops()]);
		return { tiers, published, opsSeq: ops.length ? ops[ops.length - 1].seq : 0, trimmed: this.trimmed, ...progress };
	}

	/**
	 * One bounded maintenance pass (PLAN §6): at most `steps` steps, each
	 * planned from a fresh snapshot. Stops at the first failure: nothing is
	 * trimmed that is not copied, so a failing tier only stalls the ones
	 * above it. `more` asks to be called again soon.
	 */
	async cycle(budget: { steps: number }): Promise<{ more: boolean; report: CycleReport }> {
		const report: CycleReport = { steps: [], copied: 0, trimmed: 0 };
		const progress = this.round;
		for (let count = 0; count < budget.steps; count += 1) {
			const snapshot = await this.snapshot(progress);
			const step = planStep(snapshot);
			if (step.kind === "idle") {
				// The round is done: the next one finds every target afresh, at
				// once if this one moved anything (a tier's target may have moved with it).
				const worked = progress.worked;
				this.round = HistoryPipeline.newRound();
				if (worked) {
					return { more: true, report };
				}
				return { more: false, report };
			}
			report.steps.push(step);
			try {
				await this.execute(step, snapshot, progress, report);
			} catch (error) {
				report.failure = { step, error };
				if (step.kind === "copy") {
					const state = snapshot.tiers[step.from].state;
					if (state.stalledSince === undefined) await this.state.save(this.tiers[step.from].name, { stalledSince: this.clock.now() });
				}
				return { more: false, report };
			}
		}
		const more = planStep(await this.snapshot(progress)).kind !== "idle" || progress.worked;
		if (planStep(await this.snapshot(progress)).kind === "idle") this.round = HistoryPipeline.newRound();
		return { more, report };
	}

	private async execute(step: Step, snapshot: PipelineSnapshot, progress: { targeted: Set<number>; advanced: Map<number, number>; upkept: Set<number>; worked: boolean }, report: CycleReport): Promise<void> {
		const now = this.clock.now();
		switch (step.kind) {
			case "ops":
				await this.applyOps(step.tier);
				return;
			case "target": {
				const tier = this.tiers[step.tier];
				const state = snapshot.tiers[step.tier].state;
				const below = step.tier === 0 ? Number.POSITIVE_INFINITY : snapshot.tiers[step.tier - 1].state.floor;
				const target = await tier.floorFor(this.retentions[step.tier], { now, below });
				if (target !== undefined && target > state.target) await this.state.save(tier.name, { target });
				progress.targeted.add(step.tier);
				return;
			}
			case "copy": {
				const from = this.tiers[step.from];
				const to = this.tiers[step.to];
				const range = await from.scan(step.start, this.batch);
				const records = range.records.filter((record) => record.log_id < step.below);
				if (records.length) await to.append(toRange(records));
				// The tier holds everything below the target once a scan came short of a batch or reached it.
				const exhausted = logIds(range.records).length < this.batch || records.length < range.records.length;
				const through = exhausted ? step.below - 1 : records[records.length - 1].log_id;
				const state = snapshot.tiers[step.from].state;
				await this.state.save(from.name, { through: Math.max(state.through, through), stalledSince: undefined, alertedAt: undefined });
				report.copied += records.length;
				if (records.length) progress.worked = true;
				return;
			}
			case "advance":
				await this.state.save(this.tiers[step.tier].name, { floor: step.floor });
				progress.advanced.set(step.tier, step.floor);
				// A floor that moved may move the targets below it. (The Store's head
				// floor moves later, by its own cleanup, and reads back unmoved.)
				if ((await this.state.load([this.tiers[step.tier].name]))[this.tiers[step.tier].name].floor >= step.floor) progress.worked = true;
				return;
			case "trim": {
				const count = await this.tiers[step.tier].trimBelow(step.below, this.trimBatch);
				report.trimmed += count;
				// A full batch may have left more: trimmed again on the next step.
				if (count < this.trimBatch) this.trimmed.set(step.tier, step.below);
				return;
			}
			case "publish":
				await this.head.publish(step.floor);
				return;
			case "upkeep": {
				const reach = rewritableReach(snapshot.tiers);
				const final = snapshot.tiers[Math.max(0, reach - 1)].state.floor;
				await this.tiers[step.tier].upkeep!({ steps: 1 }, { final });
				progress.upkept.add(step.tier);
				return;
			}
		}
	}

	/**
	 * Applies the op log to tier `index` (a rewritable tier below the head),
	 * in order, each op once; then forgets the ops every such tier applied.
	 * Messages of purged users that only this tier held have their reaction
	 * records at the head dropped too.
	 */
	private async applyOps(index: number): Promise<void> {
		const tier = this.tiers[index];
		if (!isRewritable(tier)) return;
		const views = await this.views();
		const ops = await this.head.ops();
		let applied = views[index].state.ops;
		for (const { seq, op } of ops) {
			if (seq <= applied) continue;
			if (op.op === "purge") {
				const result = await tier.purge(op.userIds, op.messageIds);
				// Messages only this tier held: reaction records come after their
				// message, so any on them are here or above, in tiers that already
				// applied the op without knowing these messages.
				const fresh = result.messageIds.filter((id) => !op.messageIds.includes(id));
				if (fresh.length) {
					await this.head.dropReactionsOn(fresh);
					for (let above = 1; above < index; above += 1) await (this.tiers[above] as RewritableTier).purge([], fresh);
				}
			} else {
				await tier.rename(op.from, op.to);
			}
			applied = seq;
			await this.state.save(tier.name, { ops: seq });
			this.noteRecent(op);
		}
		const reach = rewritableReach(views);
		const cursors = views.slice(1, reach).map((view, offset) => offset + 1 === index ? applied : view.state.ops);
		const done = cursors.length ? Math.min(...cursors) : ops.length ? ops[ops.length - 1].seq : 0;
		if (ops.length && ops[0].seq <= done) await this.head.dropOps(done);
	}

	private noteRecent(op: HistoryOp): void {
		const now = this.clock.now();
		this.recent = [...this.recent.filter((entry) => entry.at > now - this.recentOpsMs), { op, at: now }];
	}

	/**
	 * /purge through the pipeline: the head first, then each rewritable tier
	 * below it in order, stopping at the first that is not (decision 3). A
	 * tier that fails now is caught up by the next cycle; pages read from it
	 * meanwhile have the op applied in memory.
	 */
	async purge(userIds: readonly string[]): Promise<{ reached: string[] }> {
		await this.head.purge(userIds);
		return this.carryOps();
	}

	/** /rename through the pipeline, as purge. */
	async rename(from: string, to: string): Promise<{ reached: string[] }> {
		await this.head.rename(from, to);
		return this.carryOps();
	}

	/** Applies the op log down the rewritable tiers now; returns the tiers that hold every op. */
	async carryOps(): Promise<{ reached: string[] }> {
		const reached = [this.head.name];
		const reach = rewritableReach(await this.views());
		for (let index = 1; index < reach; index += 1) {
			try {
				await this.applyOps(index);
				reached.push(this.tiers[index].name);
			} catch {
				break;
			}
		}
		if (reach <= 1) {
			const ops = await this.head.ops();
			if (ops.length) await this.head.dropOps(ops[ops.length - 1].seq);
		}
		return { reached };
	}

	async publishedFloor(): Promise<number> {
		return this.head.publishedFloor();
	}

	/**
	 * A history page across tiers (PLAN §7): each tier's part of the window,
	 * filled from the page's start until it has `limit` log IDs, merged with
	 * upper tiers winning. Records read below the head have the ops they have
	 * yet to apply (and those applied lately) applied. `skipHead` reads only
	 * the tiers below the head, for a head (the Store) that read its own.
	 */
	async read(query: HistoryQuery, options: { skipHead?: boolean } = {}): Promise<ChatRecord[]> {
		if (!query.roomIds.length || query.lower > query.upper || query.limit <= 0) return [];
		const [views, published] = await Promise.all([this.views(), this.head.publishedFloor()]);
		const parts = planRead(query, views, published, options);
		const pages: Array<{ tier: number; records: ChatRecord[] }> = [];
		let found = new Set<number>();
		for (const part of parts) {
			if (found.size >= query.limit) break;
			const records = await this.readPart(part, query.limit - found.size);
			pages.push({ tier: part.tier, records });
			found = new Set([...found, ...logIds(records)]);
		}
		const pending = pages.some((page) => page.tier > 0) ? await this.head.ops() : [];
		const rewritten = pages.map((page) => page.tier === 0 || !views[page.tier].rewritable ? page : { ...page, records: applyOps(page.records, this.opsFor(views[page.tier].state, pending)) });
		return mergePages(rewritten, query);
	}

	private async readPart(part: ReadPart, limit: number): Promise<ChatRecord[]> {
		const tier = this.tiers[part.tier];
		if (!tier.read) return [];
		return tier.read({ ...part.query, limit });
	}

	/** The ops a tier has yet to apply, after those applied lately (applying one twice changes nothing). */
	private opsFor(state: TierState, pending: readonly QueuedOp[]): HistoryOp[] {
		const now = this.clock.now();
		const recent = this.recent.filter((entry) => entry.at > now - this.recentOpsMs).map((entry) => entry.op);
		return [...recent, ...pending.filter((entry) => entry.seq > state.ops).map((entry) => entry.op)];
	}

	/** Records with these log IDs, from every tier that can look them up (import's duplicate check). */
	async lookup(ids: readonly number[]): Promise<ChatRecord[]> {
		if (!ids.length) return [];
		const found: ChatRecord[] = [];
		for (const tier of this.tiers) if (tier.lookup) found.push(...await tier.lookup(ids));
		return found;
	}

	/** Each tier's counts, state and limits, for /status. Counts are of the log IDs each tier serves (above ones are copies). */
	async stats(): Promise<TierReport[]> {
		const views = await this.views();
		const published = await this.head.publishedFloor();
		return Promise.all(this.tiers.map(async (tier, index) => {
			const lower = index === 0 ? views[0].state.floor : Math.max(views[index].state.floor, published);
			const upper = index === 0 ? undefined : views[index - 1].state.floor - 1;
			return {
				name: tier.name, label: this.labels[index], stats: await tier.stats({ lower, ...(upper === undefined ? {} : { upper }) }),
				state: views[index].state, retention: this.retentions[index], readable: views[index].readable, rewritable: views[index].rewritable,
			};
		}));
	}

	/** Hops whose copy has failed for at least `afterMs` and have not been alerted of since: noted as alerted. */
	async stallsToAlert(afterMs: number): Promise<Array<{ from: string; to: string; since: number }>> {
		const now = this.clock.now();
		const views = await this.views();
		const due: Array<{ from: string; to: string; since: number }> = [];
		for (let index = 0; index < views.length - 1; index += 1) {
			const state = views[index].state;
			if (state.stalledSince === undefined || state.alertedAt !== undefined || now - state.stalledSince < afterMs) continue;
			due.push({ from: views[index].name, to: views[index + 1].name, since: state.stalledSince });
			await this.state.save(views[index].name, { alertedAt: now });
		}
		return due;
	}

	/** The index of the deepest readable tier. */
	async deepest(): Promise<number> {
		return deepestReadable(await this.views());
	}
}

/**
 * A tier whose every method goes through `wrap` (named by the method): for
 * timing and stall tracking (the runtime's `stalls.track`) and, in tests,
 * fault injection. Properties pass through.
 */
export function instrument<T extends HistoryTier>(tier: T, wrap: <R>(method: string, call: () => Promise<R>) => Promise<R>): T {
	return new Proxy(tier, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function" || typeof property !== "string") return value;
			return (...args: unknown[]) => wrap(property, () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)) ;
		},
	}) as T;
}
