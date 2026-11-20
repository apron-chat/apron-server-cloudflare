/*
 * HistoryPipeline: the head and the tiers below it, in
 * order, and every rule between them. It runs bounded maintenance cycles
 * (copy down, mark, advance, trim, publish), serves history pages across
 * tiers, and carries /purge and /rename down to each tier below the head.
 * Planning is pure (plan.ts); this file only executes.
 */

import { type PipelineSnapshot, type ReadPart, type Step, type TierView, mergePages, planRead, planStep } from "./plan";
import { type ChatRecord, type Clock, type HistoryOp, type HistoryQuery, type QueuedOp, type Retention, type TierStats, applyOps, logIds, toRange } from "./records";
import { type Stall, type StallStep, stallAlert, stallCleared, stallFailed } from "./stall";
import { type HistoryHead, type HeadStateUpdate, type HistoryTier, type LowerTier, TIER_METHODS, type TierState, type TierStateStore } from "./tier";

export interface PipelineStage {
	tier: LowerTier;
	retention: Retention;
	/** Whether history pages read it (default true). */
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
	/** Log IDs per copy step, where the tier copied into does not ask for its own (HistoryTier.appendBatch). */
	batch?: number;
	/** Records per trim step. */
	trimBatch?: number;
}

export interface TierReport {
	name: string;
	label: string;
	stats: TierStats;
	state: TierState;
	retention: Retention;
	readable: boolean;
}

const DEFAULT_BATCH = 100;
const DEFAULT_TRIM_BATCH = 500;
/** How long an applied op still applies to pages read below the head (a page may have read before it applied). */
const RECENT_OPS_MS = 60_000;
/** How long a lower tier's target stands while nothing above it changed (age retention moves it with time). */
const TARGET_REFRESH_MS = 3_600_000;

export class HistoryPipeline {
	readonly head: HistoryHead;
	readonly tiers: readonly HistoryTier[];
	/** The tiers below the head, by their index in `tiers` less one. */
	private readonly lower: readonly LowerTier[];
	private readonly retentions: readonly Retention[];
	private readonly readable: readonly boolean[];
	private readonly labels: readonly string[];
	private readonly state: TierStateStore;
	private readonly clock: Clock;
	private readonly batch: number;
	private readonly trimBatch: number;
	/** The floor each tier was last trimmed below, completely, in this instance. */
	private readonly trimmed = new Map<number, number>();
	/** What the running round of cycles has done: it ends when a cycle finds nothing to do. */
	private round = HistoryPipeline.newRound();
	private static newRound() {
		return { targeted: new Set<number>(), advanced: new Map<number, number>(), worked: false };
	}
	/** What each lower tier's last target was found from (what the tier above held then), and when. */
	private readonly targetBasis = new Map<number, { basis: string; at: number }>();
	/** Ops applied lately, for pages that read a tier before they were. */
	private recent: Array<{ op: HistoryOp; at: number }> = [];

	constructor(options: PipelineOptions) {
		this.head = options.head;
		this.lower = options.stages.map((stage) => stage.tier);
		this.tiers = [options.head, ...this.lower];
		this.retentions = [options.headRetention, ...options.stages.map((stage) => stage.retention)];
		this.readable = [true, ...options.stages.map((stage) => stage.readable ?? true)];
		this.labels = ["SQLite", ...options.stages.map((stage) => stage.label ?? stage.tier.name)];
		this.state = options.state;
		this.clock = options.clock;
		this.batch = options.batch ?? DEFAULT_BATCH;
		this.trimBatch = options.trimBatch ?? DEFAULT_TRIM_BATCH;
	}

	/** The tiers as the planner sees them, with their saved state. */
	async views(): Promise<TierView[]> {
		const states = await this.state.load(this.tiers.map((tier) => tier.name));
		return this.tiers.map((tier, index) => ({
			name: tier.name,
			readable: this.readable[index],
			state: states[tier.name],
		}));
	}

	async snapshot(progress: Pick<PipelineSnapshot, "targeted" | "advanced"> = { targeted: new Set(), advanced: new Map() }): Promise<PipelineSnapshot> {
		const [tiers, published, ops] = await Promise.all([this.views(), this.head.publishedFloor(), this.head.opLog.list()]);
		return { tiers, published, opsSeq: ops.length ? ops[ops.length - 1].seq : 0, trimmed: this.trimmed, ...progress };
	}

	/**
	 * One bounded maintenance pass: at most `steps` steps, each
	 * planned from a fresh snapshot. Stops at the first failure: nothing is
	 * trimmed that is not copied, so a failing tier only stalls the ones
	 * above it. `more` asks to be called again soon.
	 */
	async cycle(budget: { steps: number }): Promise<{ more: boolean; report: CycleReport }> {
		const report: CycleReport = { steps: [], copied: 0, trimmed: 0 };
		const progress = this.round;
		await this.forgetOpsWithoutTiers();
		for (let count = 0; count < budget.steps; count += 1) {
			const snapshot = await this.snapshot(progress);
			const step = planStep(snapshot);
			if (step.kind === "idle") {
				// The round is done: the next one finds every target afresh, at
				// once if this one moved anything (a tier's target may have moved with it).
				this.round = HistoryPipeline.newRound();
				return { more: progress.worked, report };
			}
			report.steps.push(step);
			// The hop a step depends on: a copy's, or the one into the tier the step works on.
			const hop = step.kind === "copy" ? step.from : "tier" in step && step.tier > 0 ? step.tier - 1 : undefined;
			try {
				await this.execute(step, snapshot, progress, report);
			} catch (error) {
				report.failure = { step, error };
				// Whatever fails below the head stalls the copy into it: noted for /status and the alert.
				if (hop !== undefined) await this.saveStall(hop, snapshot.tiers[hop].state.stall, (stall) => stallFailed(stall, this.clock.now(), step.kind as StallStep));
				return { more: false, report };
			}
			// A copy clears its hop's stall as it saves its marker (execute); another step only the stall it started.
			if (hop !== undefined && step.kind !== "copy") await this.saveStall(hop, snapshot.tiers[hop].state.stall, (stall) => stallCleared(stall, step.kind as StallStep));
		}
		const idle = planStep(await this.snapshot(progress)).kind === "idle";
		if (idle) this.round = HistoryPipeline.newRound();
		return { more: !idle || progress.worked, report };
	}

	private async execute(step: Step, snapshot: PipelineSnapshot, progress: { targeted: Set<number>; advanced: Map<number, number>; worked: boolean }, report: CycleReport): Promise<void> {
		const now = this.clock.now();
		switch (step.kind) {
			case "ops":
				await this.applyOps(step.tier);
				return;
			case "target": {
				const tier = this.tiers[step.tier];
				const state = snapshot.tiers[step.tier].state;
				const below = step.tier === 0 ? Number.POSITIVE_INFINITY : snapshot.tiers[step.tier - 1].state.floor;
				// A lower tier changes only by what the tier above copies into it or lets go
				// of (and by age): unchanged since its last target, that target stands, and
				// its count (up to every record it keeps) is not read again within the hour.
				const basis = step.tier === 0 ? "" : `${below}:${snapshot.tiers[step.tier - 1].state.through}`;
				const last = this.targetBasis.get(step.tier);
				if (step.tier > 0 && last && last.basis === basis && now - last.at < TARGET_REFRESH_MS) {
					progress.targeted.add(step.tier);
					return;
				}
				const target = await tier.floorFor(this.retentions[step.tier], { now, below });
				if (step.tier > 0) this.targetBasis.set(step.tier, { basis, at: now });
				if (target !== undefined && target > state.target) await this.saveState(step.tier, { target });
				progress.targeted.add(step.tier);
				return;
			}
			case "copy": {
				const from = this.tiers[step.from];
				const to = this.tiers[step.to];
				const batch = to.appendBatch ?? this.batch;
				const range = await from.scan(step.start, batch);
				const records = range.records.filter((record) => record.log_id < step.below);
				if (records.length) await to.append(toRange(records));
				// The tier holds everything below the target once a scan came short of a batch or reached it.
				const exhausted = logIds(range.records).length < batch || records.length < range.records.length;
				const through = exhausted ? step.below - 1 : records[records.length - 1].log_id;
				const state = snapshot.tiers[step.from].state;
				await this.saveState(step.from, { through: Math.max(state.through, through), stall: stallCleared(state.stall, "copy") });
				report.copied += records.length;
				if (records.length) progress.worked = true;
				return;
			}
			case "advance":
				await this.saveState(step.tier, { floor: step.floor });
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
		}
	}

	/**
	 * Applies the op log to tier `index` (below the head), in order, each op
	 * once, a bounded step at a time: a tier that needs several steps for an
	 * op (the cold tier's sweep) returns a cursor, kept in its state, and the
	 * next "ops" step goes on from it. Then forgets the ops every tier below
	 * the head applied. Returns whether the tier holds every op.
	 */
	private async applyOps(index: number): Promise<boolean> {
		const tier = this.tiers[index] as LowerTier;
		const views = await this.views();
		const ops = await this.head.opLog.list();
		const state = views[index].state;
		let applied = state.ops;
		let cursor = state.opCursor;
		for (const { seq, op } of ops) {
			if (seq <= applied) continue;
			const next = await tier.applyOp(op, { cursor, found: (messageIds) => this.carryFound(index, seq, op, messageIds) });
			if (next !== undefined) {
				await this.state.saveLower(tier.name, { opCursor: next });
				return false;
			}
			applied = seq;
			cursor = undefined;
			await this.state.saveLower(tier.name, { ops: seq, opCursor: null });
			this.noteRecent(op);
		}
		const cursors = views.slice(1).map((view, offset) => offset + 1 === index ? applied : view.state.ops);
		const done = Math.min(...cursors);
		if (ops.length && ops[0].seq <= done) await this.head.opLog.drop(done);
		return true;
	}

	/**
	 * Messages of a purge's users that tier `index` holds and the op did not
	 * name: their records can be anywhere. Reactions on them can be above, in
	 * tiers that already applied the op, and also below: a message's latest
	 * snapshot (an edit, a move) can be here while reactions made before it
	 * went further down and its first snapshot is gone. The op takes them
	 * with it for the tiers below (and pages read from them meanwhile); the
	 * tiers above drop them now.
	 */
	private async carryFound(index: number, seq: number, op: HistoryOp, messageIds: readonly string[]): Promise<void> {
		if (op.op !== "purge") return;
		const fresh = messageIds.filter((id) => !op.messageIds.includes(id));
		if (!fresh.length) return;
		await this.head.opLog.amend(seq, fresh);
		await this.head.dropReactionsOn(fresh);
		const drop: HistoryOp = { op: "purge", userIds: [], messageIds: fresh };
		for (const above of this.lower.slice(0, index - 1)) {
			let cursor: string | undefined;
			do cursor = await above.applyOp(drop, { cursor, found: async () => undefined });
			while (cursor !== undefined);
		}
	}

	/** A pipeline with no tier below the head: the op log has no one to wait for. */
	private async forgetOpsWithoutTiers(): Promise<void> {
		if (this.lower.length) return;
		const ops = await this.head.opLog.list();
		if (ops.length) await this.head.opLog.drop(ops[ops.length - 1].seq);
	}

	private noteRecent(op: HistoryOp): void {
		const now = this.clock.now();
		this.recent = [...this.recent.filter((entry) => entry.at > now - RECENT_OPS_MS), { op, at: now }];
	}

	/**
	 * /purge through the pipeline: the head first, then each tier below it
	 * in order, as far as each gets in a step. A tier that fails, or needs
	 * more steps, is caught up by the next cycles; pages read from it
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

	/** Applies the op log down the tiers now, a step each; returns the tiers that hold every op. */
	async carryOps(): Promise<{ reached: string[] }> {
		const reached = [this.head.name];
		for (let index = 1; index < this.tiers.length; index += 1) {
			try {
				if (!await this.applyOps(index)) break;
				reached.push(this.tiers[index].name);
			} catch {
				break;
			}
		}
		await this.forgetOpsWithoutTiers();
		return { reached };
	}

	async publishedFloor(): Promise<number> {
		return this.head.publishedFloor();
	}

	/**
	 * A history page across tiers: each tier's part of the window,
	 * filled from the page's start until it has `limit` log IDs, merged with
	 * upper tiers winning. Records read below the head have the ops they have
	 * yet to apply (and those applied lately) applied. `skipHead` reads only
	 * the tiers below the head, for a head (the Store) that read its own.
	 */
	async read(query: HistoryQuery, options: { skipHead?: boolean } = {}): Promise<ChatRecord[]> {
		if (!query.roomIds.length || query.lower > query.upper || query.limit <= 0) return [];
		const [views, published] = await Promise.all([this.views(), this.head.publishedFloor()]);
		const parts = planRead(query, views, published, options);
		const pending = parts.some((part) => part.tier > 0) ? await this.head.opLog.list() : [];
		const pages: Array<{ tier: number; records: ChatRecord[] }> = [];
		let found = new Set<number>();
		for (const part of parts) {
			if (found.size >= query.limit) break;
			const ops = part.tier === 0 ? [] : this.opsFor(views[part.tier].state, pending);
			const records = await this.readPart(part, query.limit - found.size, ops);
			pages.push({ tier: part.tier, records });
			found = new Set([...found, ...logIds(records)]);
		}
		return mergePages(pages, query);
	}

	/**
	 * A tier's part of a page, with `ops` applied: read on past what they
	 * drop until the part has `limit` log IDs or the tier has no more in its
	 * window, so a page whose records were all purged is not taken for the
	 * end of history.
	 */
	private async readPart(part: ReadPart, limit: number, ops: readonly HistoryOp[]): Promise<ChatRecord[]> {
		const tier = this.tiers[part.tier];
		const kept: ChatRecord[] = [];
		let query = { ...part.query, limit };
		for (;;) {
			const records = await tier.read(query);
			kept.push(...(ops.length ? applyOps(records, ops) : records));
			const ids = logIds(records);
			if (ids.length < query.limit || logIds(kept).length >= limit) return kept;
			// The tier filled the page, but the ops dropped some: on from past what it read.
			query = query.forward ? { ...query, lower: Math.max(...ids) + 1 } : { ...query, upper: Math.min(...ids) - 1 };
			if (query.lower > query.upper) return kept;
		}
	}

	/** The ops a tier has yet to apply, after those applied lately (applying one twice changes nothing). */
	private opsFor(state: TierState, pending: readonly QueuedOp[]): HistoryOp[] {
		const now = this.clock.now();
		const recent = this.recent.filter((entry) => entry.at > now - RECENT_OPS_MS).map((entry) => entry.op);
		return [...recent, ...pending.filter((entry) => entry.seq > state.ops).map((entry) => entry.op)];
	}

	/** Records with these log IDs, from every tier that can look them up (import's duplicate check). */
	async lookup(ids: readonly number[]): Promise<ChatRecord[]> {
		if (!ids.length) return [];
		const found: ChatRecord[] = [];
		for (const tier of this.tiers) found.push(...await tier.lookup(ids));
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
				state: views[index].state, retention: this.retentions[index], readable: views[index].readable,
			};
		}));
	}

	/** Hops whose copy has failed for at least `afterMs` and have not been alerted of since: noted as alerted. */
	async stallsToAlert(afterMs: number): Promise<Array<{ from: string; to: string; since: number }>> {
		const now = this.clock.now();
		const views = await this.views();
		const due: Array<{ from: string; to: string; since: number }> = [];
		for (let index = 0; index < views.length - 1; index += 1) {
			const alerted = stallAlert(views[index].state.stall, now, afterMs);
			if (!alerted) continue;
			due.push({ from: views[index].name, to: views[index + 1].name, since: alerted.since });
			await this.saveState(index, { stall: alerted });
		}
		return due;
	}

	/** Whether tier `name` has state saved: it has held history here, whether or not it is in this pipeline. */
	async hasTierState(name: string): Promise<boolean> {
		return this.state.has(name);
	}

	/**
	 * The copy from the head is blocked by a tier this pipeline cannot reach
	 * (the D1 tier holding history while it is off): stalled from now, as a
	 * failing copy would be. Returns the stall once it has lasted `afterMs`,
	 * to alert of, once.
	 */
	async noteHeadBlocked(now: number, afterMs: number): Promise<{ since: number } | undefined> {
		const stall = (await this.state.load([this.head.name]))[this.head.name].stall;
		const failing = stallFailed(stall, now, "copy");
		const alerted = stallAlert(failing, now, afterMs);
		const next = alerted ?? failing;
		if (next !== stall) await this.state.saveHead({ stall: next });
		return alerted ? { since: alerted.since } : undefined;
	}

	/** Saves tier `index`'s state: the head's takes no ops. */
	private async saveState(index: number, update: HeadStateUpdate): Promise<void> {
		if (index > 0) return this.state.saveLower(this.tiers[index].name, update);
		await this.state.saveHead(update);
	}

	/** Moves hop `index`'s stall by `change`, saving it only when it changed. */
	private async saveStall(index: number, stall: Stall, change: (stall: Stall) => Stall): Promise<void> {
		const next = change(stall);
		if (next !== stall) await this.saveState(index, { stall: next });
	}
}

/**
 * A tier whose methods (TIER_METHODS) go through `wrap` (named by the method): for
 * timing and stall tracking (the runtime's `stalls.track`) and, in tests,
 * fault injection. Properties pass through.
 */
export function instrument<T extends HistoryTier>(tier: T, wrap: <R>(method: string, call: () => Promise<R>) => Promise<R>): T {
	const wrapped = new Set<string>(TIER_METHODS);
	return new Proxy(tier, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			// Only the tier's own (asynchronous) methods: anything else it has passes through as it is.
			if (typeof value !== "function" || typeof property !== "string" || !wrapped.has(property)) return value;
			return (...args: unknown[]) => wrap(property, () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
		},
	}) as T;
}
