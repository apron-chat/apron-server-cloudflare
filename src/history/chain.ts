/*
 * HistoryChain: the head and the tiers below it, joined by links, and the
 * driver that runs them. Registration is the topology (the stages, in
 * order); each link and tier works only with its neighbours (link.ts plans
 * every step). It runs bounded maintenance cycles within the alarm's
 * budget, serves history pages down the chain, and answers /status.
 *
 * A link delivers the head's rewrites (/purge, /rename) to the tier below
 * it in log order, and copies records down only from a tier that holds
 * every rewrite: a rewrite never overtakes a copy it affects, and a copy
 * never carries what a rewrite on its way would change. A tier that cannot
 * take rewrites (no HistoryTier.rewrite: the cold tier) keeps the ones it is
 * delivered (KeptRewrite, with the newest log ID it held then) until its
 * floor passes them, and every read of it applies them (withKept): what it
 * holds still names a purged or renamed user, but nothing read or exported
 * from it does.
 */

import { authoredMessages, purgedRecord } from "@apron/archive";
import { type ChainSnapshot, type ChainView, type ReadPart, type Step, type WorkStep, arrivedThrough, chainView, copyNow, mergePages, planRead, planStep } from "./link";
import { type ChatRecord, type Clock, type HistoryQuery, type KeptRewrite, type QueuedRewrite, type Retention, type Rewrite, type TierStats, logIds, rewritten, toRange, withKept } from "./records";
import { MAX_KEPT_REWRITES } from "./state";
import { type Stall, stallAlert, stallCleared, stallFailed } from "./stall";
import { type ChainStateStore, type HistoryHead, type HistoryTier, type LinkState, TIER_METHODS, type TierFloor } from "./tier";

/** A tier below the head, as registered. */
export interface ChainStage {
	tier: HistoryTier;
	retention: Retention;
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

export interface ChainOptions {
	head: HistoryHead;
	headRetention: Retention;
	stages: readonly ChainStage[];
	state: ChainStateStore;
	clock: Clock;
	/** Log IDs per copy, where the tier copied into does not ask for its own (HistoryTier.appendBatch). */
	batch?: number;
	/** Records per trim step. */
	trimBatch?: number;
}

/** One tier for /status: its counts, floor, limits, and the link below it. */
export interface TierReport {
	name: string;
	label: string;
	stats: TierStats;
	floor: TierFloor;
	retention: Retention;
	/** The link to the next tier (none for the deepest). */
	link?: LinkState;
}

const DEFAULT_BATCH = 100;
const DEFAULT_TRIM_BATCH = 500;
/** How long a lower tier's target stands while nothing above it changed (age retention moves it with time). */
const TARGET_REFRESH_MS = 3_600_000;

/**
 * What a read across the chain may carry besides its query: `purged`, the
 * messages of purged users seen so far, for a reader that goes oldest first
 * over everything (an export). Each part read from a tier that takes no
 * rewrites adds the messages its kept purges drop, and every part drops the
 * reaction sets on any of them: a reaction comes after its message, so an
 * export drops each reaction set on a purged message, whichever tier or page
 * holds it. Pages for clients go without (withKept alone, so a page is the
 * same whatever records share it).
 */
export interface ReadOptions {
	skipHead?: boolean;
	purged?: Set<string>;
}

/** Records with the reaction sets on `messages` dropped (a record left empty goes). */
function withoutReactionsOn(records: readonly ChatRecord[], messages: ReadonlySet<string>): ChatRecord[] {
	if (!messages.size) return [...records];
	const ids = [...messages];
	return records.flatMap((record) => {
		if (record.kind !== "reactions") return [record];
		const json = purgedRecord(record, [], ids);
		return json === null ? [] : [json === record.record_json ? record : { ...record, record_json: json }];
	});
}

export class HistoryChain {
	readonly head: HistoryHead;
	readonly tiers: readonly HistoryTier[];
	private readonly retentions: readonly Retention[];
	private readonly labels: readonly string[];
	private readonly state: ChainStateStore;
	private readonly clock: Clock;
	private readonly batch: number;
	private readonly trimBatch: number;
	/** The floor each tier was last trimmed below, completely, in this instance. */
	private readonly trimmed = new Map<number, number>();
	/** What the running round of cycles has done: it ends when a cycle finds nothing to do. */
	private round = HistoryChain.newRound();
	private static newRound() {
		return { targeted: new Set<number>(), advanced: new Map<number, number>(), waiting: new Map<number, number>(), worked: false };
	}
	/** What each lower tier's last target was found from (what the tier above held then), and when. */
	private readonly targetBasis = new Map<number, { basis: string; at: number }>();
	/** The kept rewrites of each tier that takes none, as last read (this instance alone changes them). */
	private readonly keptCache = new Map<number, KeptRewrite[]>();

	constructor(options: ChainOptions) {
		this.head = options.head;
		this.tiers = [options.head, ...options.stages.map((stage) => stage.tier)];
		this.retentions = [options.headRetention, ...options.stages.map((stage) => stage.retention)];
		this.labels = ["SQLite", ...options.stages.map((stage) => stage.label ?? stage.tier.name)];
		this.state = options.state;
		this.clock = options.clock;
		this.batch = options.batch ?? DEFAULT_BATCH;
		this.trimBatch = options.trimBatch ?? DEFAULT_TRIM_BATCH;
	}

	/** The chain as the planner sees it, with its saved state. */
	async view(): Promise<ChainView> {
		const state = await this.state.load(this.tiers.map((tier) => tier.name));
		return chainView(state, this.tiers.map((tier, index) => ({ name: tier.name, rewrites: index === 0 || typeof tier.rewrite === "function" })));
	}

	/** The newest rewrite logged (0: none). */
	async logged(): Promise<number> {
		return this.head.rewrites.logged();
	}

	private async snapshot(): Promise<ChainSnapshot> {
		const [view, published, logged, queued] = await Promise.all([this.view(), this.head.publishedFloor(), this.logged(), this.head.rewrites.list()]);
		const oldest = queued.length ? queued[0].seq : logged + 1;
		return { ...view, published, logged, oldest, trimmed: this.trimmed, targeted: this.round.targeted, advanced: this.round.advanced, waiting: this.round.waiting };
	}

	/**
	 * One bounded maintenance pass: at most `steps` steps, each planned from
	 * a fresh snapshot. Stops at the first failure: nothing is trimmed that
	 * is not copied, so a failing tier only stalls the link above it. `more`
	 * asks to be called again soon.
	 */
	async cycle(budget: { steps: number }): Promise<{ more: boolean; report: CycleReport }> {
		const report: CycleReport = { steps: [], copied: 0, trimmed: 0 };
		const round = this.round;
		await this.forgetDelivered();
		await this.forgetKept();
		for (let count = 0; count < budget.steps; count += 1) {
			const snapshot = await this.snapshot();
			const step = planStep(snapshot);
			if (step.kind === "idle") {
				// The round is done: the next one finds every target afresh, at
				// once if this one moved anything (a tier's target may have moved with it).
				this.round = HistoryChain.newRound();
				return { more: round.worked, report };
			}
			report.steps.push(step);
			// The link a step works for: a delivery's or copy's own, or the one into the tier the step works on.
			const link = step.kind === "deliver" || step.kind === "copy" ? step.link : "tier" in step && step.tier > 0 ? step.tier - 1 : undefined;
			try {
				await this.execute(step, snapshot, report);
			} catch (error) {
				report.failure = { step, error };
				if (link !== undefined) await this.saveStall(link, snapshot.links[link].stall, (stall) => stallFailed(stall, this.clock.now(), step.kind as WorkStep));
				return { more: false, report };
			}
			if (link !== undefined && step.kind !== "copy") await this.saveStall(link, snapshot.links[link].stall, (stall) => stallCleared(stall, step.kind as WorkStep));
		}
		const idle = planStep(await this.snapshot()).kind === "idle";
		if (idle) this.round = HistoryChain.newRound();
		return { more: !idle || round.worked, report };
	}

	private async execute(step: Step, snapshot: ChainSnapshot, report: CycleReport): Promise<void> {
		const now = this.clock.now();
		const round = this.round;
		switch (step.kind) {
			case "deliver":
				await this.deliver(step.link, step.seq);
				round.worked = true;
				return;
			case "target": {
				const tier = this.tiers[step.tier];
				const below = step.tier === 0 ? Number.POSITIVE_INFINITY : snapshot.tiers[step.tier - 1].floor;
				// A lower tier changes only by what the tier above copies into it or lets go
				// of (and by age): unchanged since its last target, that target stands, and
				// its count (up to every record it keeps) is not read again within the hour.
				const basis = step.tier === 0 ? "" : `${below}:${snapshot.links[step.tier - 1].through}`;
				const last = this.targetBasis.get(step.tier);
				if (step.tier > 0 && last && last.basis === basis && now - last.at < TARGET_REFRESH_MS) {
					round.targeted.add(step.tier);
					return;
				}
				const target = await tier.floorFor(this.retentions[step.tier], { now, below });
				if (step.tier > 0) this.targetBasis.set(step.tier, { basis, at: now });
				if (target !== undefined && target > snapshot.tiers[step.tier].target) await this.state.saveTier(tier.name, { target });
				round.targeted.add(step.tier);
				return;
			}
			case "copy": {
				const from = this.tiers[step.link];
				const to = this.tiers[step.link + 1];
				const batch = to.appendBatch ?? this.batch;
				if (to.appendBatch !== undefined && !await this.copyNow(step, snapshot, batch)) {
					// Less than a whole batch is due, and the tier above has room: it holds the rest until more arrives.
					round.waiting.set(step.link, arrivedThrough(snapshot, step.link));
					return;
				}
				const { records, exhausted } = await this.gather(from, step.start, step.below, batch);
				if (records.length) await to.append(toRange(records));
				// The tier below holds everything below the target once the tier above had no more below it.
				const through = exhausted ? step.below - 1 : records[records.length - 1].log_id;
				const link = snapshot.links[step.link];
				await this.state.saveLink(from.name, { through: Math.max(link.through, through), stall: stallCleared(link.stall, "copy") });
				report.copied += records.length;
				if (records.length) round.worked = true;
				return;
			}
			case "advance": {
				const tier = this.tiers[step.tier];
				await this.state.saveTier(tier.name, { floor: step.floor });
				round.advanced.set(step.tier, step.floor);
				// A floor that moved may move the targets below it. (The Store's head
				// floor moves later, by its own cleanup, and reads back unmoved.)
				const moved = (await this.state.load([tier.name])).tiers[0].floor >= step.floor;
				if (moved) round.worked = true;
				return;
			}
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
	 * Up to `batch` log IDs of `from`'s records from `start`, below `below`,
	 * gathered over as many scans as its scanLimit needs. `exhausted` only
	 * when a scan returned fewer log IDs than it was asked, or reached
	 * `below`: a source that caps its scans is never taken to be empty when
	 * it only returned its most.
	 */
	private async gather(from: HistoryTier, start: number, below: number, batch: number): Promise<{ records: ChatRecord[]; exhausted: boolean }> {
		const most = Math.max(1, Math.min(batch, from.scanLimit ?? batch));
		const records: ChatRecord[] = [];
		let gathered = 0;
		let next = start;
		while (gathered < batch) {
			const asked = Math.min(most, batch - gathered);
			const range = await from.scan(next, asked);
			const ids = logIds(range.records);
			const kept = range.records.filter((record) => record.log_id < below);
			records.push(...kept);
			gathered += logIds(kept).length;
			if (ids.length < asked || kept.length < range.records.length) return { records, exhausted: true };
			next = Math.max(...ids) + 1;
		}
		return { records, exhausted: false };
	}

	/**
	 * Whether a copy into a tier that takes whole batches goes now (link.ts,
	 * copyNow): from what the tier above holds below its target, and in all,
	 * against its count limit.
	 */
	private async copyNow(step: Extract<Step, { kind: "copy" }>, snapshot: ChainSnapshot, batch: number): Promise<boolean> {
		const from = this.tiers[step.link];
		const limit = this.retentions[step.link].records;
		const pending = (await from.stats({ lower: step.start, upper: step.below - 1 })).records;
		if (pending >= batch || !limit) return true;
		// What it serves: from its floor up to the floor of the tier above (the rest are copies).
		const upper = step.link === 0 ? undefined : snapshot.tiers[step.link - 1].floor - 1;
		const held = (await from.stats({ lower: snapshot.tiers[step.link].floor, ...(upper === undefined ? {} : { upper }) })).records;
		return copyNow({ pending, batch, held, limit });
	}

	/**
	 * Link `link` delivers rewrite `seq` to the tier below it: applied where
	 * the tier takes rewrites, kept where it does not (KeptRewrite: applied
	 * to what it holds now, through the link's copy marker, whenever it is
	 * read; a tier holding nothing yet keeps nothing). A purge's
	 * messages that tier finds go with the rewrite from now on (the log's
	 * amend), for the tiers below and pages read from them; the tiers above,
	 * which had it already, drop the reaction sets on them now.
	 */
	private async deliver(link: number, seq: number): Promise<void> {
		const below = link + 1;
		const tier = this.tiers[below];
		const queued = await this.head.rewrites.list();
		const entry = queued.find((item) => item.seq === seq);
		// Gone from the log: delivered everywhere before this link had state, while its tier was empty (link.ts, nextRewrite).
		if (entry && tier.rewrite) {
			const { rewrite } = entry;
			await tier.rewrite(rewrite, async (messageIds) => {
				const fresh = messageIds.filter((id) => !(rewrite.messages ?? []).includes(id));
				if (rewrite.into !== null || !fresh.length) return;
				await this.head.rewrites.amend(seq, fresh);
				await this.head.dropReactionsOn(fresh);
				const drop: Rewrite = { user: rewrite.user, into: null, messages: fresh };
				for (const above of this.tiers.slice(1, below)) await above.rewrite?.(drop, async () => undefined);
			});
		} else if (entry) {
			const view = await this.view();
			const through = view.links[link].through;
			if (through >= view.tiers[below].floor) {
				const kept = await this.kept(below);
				if (!kept.some((each) => each.seq === seq) && kept.length >= MAX_KEPT_REWRITES) {
					throw new Error(`${tier.name} keeps ${MAX_KEPT_REWRITES} rewrites already: it must trim before it takes another /purge or /rename`);
				}
				await this.state.keep(tier.name, { seq, rewrite: entry.rewrite, through });
				this.keptCache.delete(below);
			}
		}
		await this.state.saveLink(this.tiers[link].name, { delivered: seq });
		await this.forgetDelivered();
	}

	/** The kept rewrites of tier `index` (one that takes none), read once and cached. */
	private async kept(index: number): Promise<KeptRewrite[]> {
		const cached = this.keptCache.get(index);
		if (cached) return cached;
		const kept = (await this.state.kept(this.tiers[index].name)).sort((a, b) => a.seq - b.seq);
		this.keptCache.set(index, kept);
		return kept;
	}

	/** Forgets each tier's kept rewrites that reach nothing it holds now (`through` below its floor). */
	private async forgetKept(): Promise<void> {
		const view = await this.view();
		for (const [index, tier] of this.tiers.entries()) {
			if (index === 0 || tier.rewrite) continue;
			const floor = view.tiers[index].floor;
			if (!(await this.kept(index)).some((each) => each.through < floor)) continue;
			await this.state.forgetKept(tier.name, floor);
			this.keptCache.delete(index);
		}
	}

	/** Forgets the rewrites every link delivered (all of them, with no tier below the head). */
	private async forgetDelivered(): Promise<void> {
		const queued = await this.head.rewrites.list();
		if (!queued.length) return;
		const done = this.tiers.length > 1 ? (await this.view()).links[this.tiers.length - 2].delivered : queued[queued.length - 1].seq;
		if (queued[0].seq <= done) await this.head.rewrites.drop(done);
	}

	async publishedFloor(): Promise<number> {
		return this.head.publishedFloor();
	}

	/**
	 * A history page down the chain: each tier's part of the window, filled
	 * from the page's start until it has `limit` log IDs, merged with upper
	 * tiers winning. A part read from a tier that takes rewrites has those
	 * its link has yet to deliver applied: the log is read after the links'
	 * state, so a rewrite delivered meanwhile is either among them or already
	 * in the tier when it is read (applying one twice changes nothing). A
	 * part read from a tier that takes no rewrites has those it keeps
	 * applied, and those its link has yet to deliver, record by record
	 * (withKept). `skipHead` reads only the tiers below the head, for a head
	 * (the Store) that read its own; `purged` is for an export (ReadOptions).
	 */
	async read(query: HistoryQuery, options: ReadOptions = {}): Promise<ChatRecord[]> {
		if (!query.roomIds.length || query.lower > query.upper || query.limit <= 0) return [];
		const [view, published] = await Promise.all([this.view(), this.head.publishedFloor()]);
		const parts = planRead(query, view.tiers, published, options);
		const pending = parts.some((part) => part.tier > 0) ? await this.head.rewrites.list() : [];
		const pages: Array<{ tier: number; records: ChatRecord[] }> = [];
		let found = new Set<number>();
		for (const part of parts) {
			if (found.size >= query.limit) break;
			const applied = part.tier === 0 ? undefined : await this.applyFor(part.tier, view, pending, options.purged);
			// Forward, the deepest part comes first: the purged messages it holds are known before the reactions above.
			const purged = options.purged;
			const apply = purged ? (records: ChatRecord[]) => withoutReactionsOn(applied ? applied(records) : records, purged) : applied;
			const records = await this.readPart(part, query.limit - found.size, apply);
			pages.push({ tier: part.tier, records });
			found = new Set([...found, ...logIds(records)]);
		}
		return mergePages(pages, query);
	}

	/**
	 * What a page part read from tier `index` has applied: where the tier
	 * takes rewrites, those its link has yet to deliver; where it does not,
	 * those it keeps and those on their way, record by record. With
	 * `purged`, the messages each kept purge drops are noted in it first.
	 */
	private async applyFor(index: number, view: ChainView, pending: readonly QueuedRewrite[], purged?: Set<string>): Promise<((records: ChatRecord[]) => ChatRecord[]) | undefined> {
		const tier = this.tiers[index];
		const coming = pending.filter((entry) => entry.seq > view.links[index - 1].delivered);
		if (tier.rewrite) {
			const rewrites = coming.map((entry) => entry.rewrite);
			return rewrites.length ? (records) => rewritten(records, rewrites) : undefined;
		}
		const kept: KeptRewrite[] = [...await this.kept(index), ...coming.map((entry) => ({ ...entry, through: Number.MAX_SAFE_INTEGER }))];
		if (!kept.length) return undefined;
		return (records) => {
			if (purged) {
				// Each purge's messages as this tier holds them, its earlier rewrites applied (a rename may come first).
				for (const [at, entry] of kept.entries()) {
					if (entry.rewrite.into !== null) continue;
					const held = withKept(records, kept.slice(0, at)).filter((record) => record.log_id <= entry.through);
					for (const id of authoredMessages(held, [entry.rewrite.user])) purged.add(id);
				}
			}
			return withKept(records, kept);
		};
	}

	/**
	 * A tier's part of a page, with `apply` applied: read on past what it
	 * drops until the part has `limit` log IDs or the tier has no more in
	 * its window, so a page whose records were all purged is not taken for
	 * the end of history.
	 */
	private async readPart(part: ReadPart, limit: number, apply?: (records: ChatRecord[]) => ChatRecord[]): Promise<ChatRecord[]> {
		const tier = this.tiers[part.tier];
		const kept: ChatRecord[] = [];
		let query = { ...part.query, limit };
		for (;;) {
			const records = await tier.read(query);
			kept.push(...(apply ? apply(records) : records));
			const ids = logIds(records);
			if (ids.length < query.limit || logIds(kept).length >= limit) return kept;
			// The tier filled the page, but what was applied dropped some: on from past what it read.
			query = query.forward ? { ...query, lower: Math.max(...ids) + 1 } : { ...query, upper: Math.min(...ids) - 1 };
			if (query.lower > query.upper) return kept;
		}
	}

	/** Records with these log IDs, from every tier (import's duplicate check). */
	async lookup(ids: readonly number[]): Promise<ChatRecord[]> {
		if (!ids.length) return [];
		const found: ChatRecord[] = [];
		for (const tier of this.tiers) found.push(...await tier.lookup(ids));
		return found;
	}

	/** Each tier's counts, floors and limits, and its link below, for /status. Counts are of the log IDs each tier serves (above ones are copies). */
	async stats(): Promise<TierReport[]> {
		const view = await this.view();
		const published = await this.head.publishedFloor();
		return Promise.all(this.tiers.map(async (tier, index) => {
			const lower = index === 0 ? view.tiers[0].floor : Math.max(view.tiers[index].floor, published);
			const upper = index === 0 ? undefined : view.tiers[index - 1].floor - 1;
			const { floor, target } = view.tiers[index];
			return {
				name: tier.name, label: this.labels[index], stats: await tier.stats({ lower, ...(upper === undefined ? {} : { upper }) }),
				floor: { floor, target }, retention: this.retentions[index], ...(view.links[index] ? { link: view.links[index] } : {}),
			};
		}));
	}

	/** Links whose work has failed for at least `afterMs` and have not been alerted of since: noted as alerted. */
	async stallsToAlert(afterMs: number): Promise<Array<{ from: string; to: string; since: number }>> {
		const now = this.clock.now();
		const view = await this.view();
		const due: Array<{ from: string; to: string; since: number }> = [];
		for (const [index, link] of view.links.entries()) {
			const alerted = stallAlert(link.stall, now, afterMs);
			if (!alerted) continue;
			due.push({ from: view.tiers[index].name, to: view.tiers[index + 1].name, since: alerted.since });
			await this.state.saveLink(view.tiers[index].name, { stall: alerted });
		}
		return due;
	}

	/** Whether tier `name` has state saved: it has held history here, whether or not it is in this chain. */
	async hasTierState(name: string): Promise<boolean> {
		return this.state.has(name);
	}

	/**
	 * The link out of the head is blocked by a tier this chain cannot reach
	 * (the D1 tier holding history while it is off): stalled from now, as a
	 * failing copy would be. Returns the stall once it has lasted `afterMs`,
	 * to alert of, once.
	 */
	async noteHeadBlocked(now: number, afterMs: number): Promise<{ since: number } | undefined> {
		const { stall } = await this.state.loadLink(this.head.name);
		const failing = stallFailed(stall, now, "copy");
		const alerted = stallAlert(failing, now, afterMs);
		const next = alerted ?? failing;
		if (next !== stall) await this.state.saveLink(this.head.name, { stall: next });
		return alerted ? { since: alerted.since } : undefined;
	}

	/** Moves link `index`'s stall by `change`, saving it only when it changed. */
	private async saveStall(index: number, stall: Stall, change: (stall: Stall) => Stall): Promise<void> {
		const next = change(stall);
		if (next !== stall) await this.state.saveLink(this.tiers[index].name, { stall: next });
	}
}

/**
 * A tier whose methods (TIER_METHODS) go through `wrap` (named by the
 * method): for timing and stall tracking (the runtime's `stalls.track`)
 * and, in tests, fault injection. Properties pass through, and a method the
 * tier lacks stays absent.
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
