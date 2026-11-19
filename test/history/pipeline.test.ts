import { env } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "./support/memory-blob-store";
import { MemorySegmentIndex } from "../../src/history/blob/segments";
import { BlobHistoryTier } from "../../src/history/blob/tier";
import { MemoryHead, MemoryHistoryTier } from "./support/memory-tiers";
import { type TierView, checkInvariants, mergePages, planRead, planStep, retentionFloor } from "../../src/history/plan";
import { HistoryPipeline, type PipelineStage, instrument } from "../../src/history/pipeline";
import type { ChatRecord, Retention } from "../../src/history/records";
import { type HistoryTier, MemoryTierStateStore, type TierState } from "../../src/history/tier";
import { Model, show } from "./model";

const state = (floor: number, target = floor, through = floor - 1, ops = 0): TierState => ({ floor, target, through, ops });
const view = (name: string, tierState: TierState, extra: Partial<TierView> = {}): TierView => ({ name, readable: true, rewritable: true, multiRoom: true, state: tierState, ...extra });
const progress = () => ({ targeted: new Set<number>(), advanced: new Map<number, number>(), trimmed: new Map<number, number>() });

describe("planStep", () => {
	it("applies the op log first, to each rewritable tier below the head in turn", () => {
		const tiers = [view("hot", state(10)), view("recent", state(5)), view("cold", state(1), { rewritable: false })];
		expect(planStep({ tiers, published: 1, opsSeq: 2, ...progress() })).toEqual({ kind: "ops", tier: 1, after: 0 });
	});

	it("works bottom-up: target, copy, advance and trim each tier, then publishes", () => {
		const tiers = [view("hot", state(10, 20, 9)), view("cold", state(1, 1))];
		const snapshot = { tiers, published: 1, opsSeq: 0, ...progress() };
		expect(planStep(snapshot)).toEqual({ kind: "target", tier: 1 });
		snapshot.targeted.add(1);
		// The bottom tier has nothing to trim below its floor of 1... once noted as trimmed.
		expect(planStep(snapshot)).toEqual({ kind: "trim", tier: 1, below: 1 });
		snapshot.trimmed.set(1, 1);
		expect(planStep(snapshot)).toEqual({ kind: "target", tier: 0 });
		snapshot.targeted.add(0);
		expect(planStep(snapshot)).toEqual({ kind: "copy", from: 0, to: 1, start: 10, below: 20 });
		tiers[0].state.through = 19;
		expect(planStep(snapshot)).toEqual({ kind: "advance", tier: 0, floor: 20 });
		snapshot.advanced.set(0, 20);
		expect(planStep(snapshot)).toEqual({ kind: "trim", tier: 0, below: 20 });
		snapshot.trimmed.set(0, 20);
		expect(planStep(snapshot)).toEqual({ kind: "idle" });
	});

	it("never advances a floor past what the next tier holds, nor past the floor above", () => {
		const tiers = [view("hot", state(10, 50, 29)), view("recent", state(5, 40, 20)), view("cold", state(1))];
		const snapshot = { tiers, published: 1, opsSeq: 0, ...progress() };
		snapshot.targeted.add(0).add(1).add(2);
		snapshot.trimmed.set(2, 1);
		// recent may go to 21 (cold holds through 20), not 40.
		expect(planStep({ ...snapshot, tiers: [tiers[0], { ...tiers[1], state: { ...tiers[1].state, through: 39 } }, tiers[2]] })).toEqual({ kind: "advance", tier: 1, floor: 10 });
	});

	it("publishes the deepest readable tier's floor", () => {
		const tiers = [view("hot", state(10)), view("recent", state(5)), view("backup", state(2), { readable: false })];
		const snapshot = { tiers, published: 3, opsSeq: 0, ...progress() };
		for (const index of [0, 1, 2]) {
			snapshot.targeted.add(index);
			snapshot.trimmed.set(index, tiers[index].state.floor);
		}
		expect(planStep(snapshot)).toEqual({ kind: "publish", floor: 5 });
	});
});

describe("checkInvariants", () => {
	it("reports unordered floors, trims past copies, and a published floor too high or falling", () => {
		const tiers = [view("hot", state(10, 10, 5)), view("recent", state(12))];
		expect(checkInvariants(tiers, 13, { tiers: [view("hot", state(11)), view("recent", state(1))], published: 14 })).toEqual([
			"I1: recent's floor 12 is above hot's 10",
			"I2: hot's floor 10 passed what recent holds (through 5)",
			"I6: the published floor 13 is above 12, the deepest readable tier's",
			"I1: hot's floor fell from 11 to 10",
			"I6: the published floor fell from 14 to 13",
		]);
		expect(checkInvariants([view("hot", state(10)), view("recent", state(4))], 4)).toEqual([]);
	});
});

describe("planRead and mergePages", () => {
	const tiers = [view("hot", state(100)), view("recent", state(50)), view("cold", state(10), { multiRoom: false })];

	it("gives each tier the window between its floor and the floor above, none below the published floor", () => {
		const query = { roomIds: ["a"], lower: 1, upper: 200, forward: false, limit: 10 };
		expect(planRead(query, tiers, 20).map((part) => [part.tier, part.query.lower, part.query.upper])).toEqual([[0, 100, 200], [1, 50, 99], [2, 20, 49]]);
		expect(planRead({ ...query, forward: true }, tiers, 20).map((part) => part.tier)).toEqual([2, 1, 0]);
		expect(planRead(query, tiers, 20, { skipHead: true }).map((part) => part.tier)).toEqual([1, 2]);
	});

	it("stops a joined-rooms page at a tier that serves one room at a time", () => {
		expect(planRead({ roomIds: ["a", "b"], lower: 1, upper: 200, forward: false, limit: 10, joined: true }, tiers, 20).map((part) => part.tier)).toEqual([0, 1]);
	});

	it("merges by log ID, a move once, with the upper tier winning", () => {
		const record = (room: string, logId: number, json = "{}"): ChatRecord => ({ room_id: room, log_id: logId, commit_ms: logId, kind: "message", record_json: json });
		const merged = mergePages([
			{ tier: 1, records: [record("a", 5, "old"), record("a", 4), record("b", 4)] },
			{ tier: 0, records: [record("a", 5, "new"), record("a", 6)] },
		], { forward: false, limit: 2 });
		expect(merged.map((entry) => `${entry.room_id}${entry.log_id}${entry.record_json}`)).toEqual(["a6{}", "a5new"]);
		expect(mergePages([{ tier: 1, records: [record("a", 4), record("b", 4), record("a", 3)] }], { forward: true, limit: 2 }).length).toBe(3);
	});
});

describe("retentionFloor", () => {
	const entries = Array.from({ length: 10 }, (_, index) => ({ log_id: index + 1, commit_ms: (index + 1) * 1000 }));
	it("keeps the threshold's share of the count, newest first, counting only below the tier above", () => {
		expect(retentionFloor(entries, { records: 4, thresholdPercent: 100 }, { now: 0, below: Infinity })).toBe(7);
		expect(retentionFloor(entries, { records: 4, thresholdPercent: 50 }, { now: 0, below: Infinity })).toBe(9);
		expect(retentionFloor(entries, { records: 4, thresholdPercent: 100 }, { now: 0, below: 9 })).toBe(5);
		expect(retentionFloor(entries, { records: 20, thresholdPercent: 100 }, { now: 0, below: Infinity })).toBeUndefined();
	});
	it("drops by age, and holds back what is younger than the minimum age", () => {
		expect(retentionFloor(entries, { ageMs: 5_500, thresholdPercent: 100 }, { now: 10_000, below: Infinity })).toBe(5);
		expect(retentionFloor(entries, { records: 2, minAgeMs: 6_500, thresholdPercent: 100 }, { now: 10_000, below: Infinity })).toBe(4);
	});
});

/** A clock tests move by hand. */
class TestClock {
	constructor(public time = 1_000_000) {}
	now(): number { return this.time; }
}

/** A tier /purge does not reach: a memory tier without purge and rename, serving one room at a time. */
function appendOnly(name: string): HistoryTier & { inner: MemoryHistoryTier } {
	const inner = new MemoryHistoryTier(name);
	return {
		name, inner, multiRoom: false,
		append: (range) => inner.append(range), scan: (from, limit) => inner.scan(from, limit), read: (query) => inner.read(query),
		lookup: (ids) => inner.lookup(ids), stats: (context) => inner.stats(context), floorFor: (retention, context) => inner.floorFor(retention, context),
		trimBelow: (floor, max) => inner.trimBelow(floor, max),
	};
}

interface Composition {
	name: string;
	headRetention: Retention;
	stages: () => PipelineStage[];
	rewritableOnly: boolean;
}

const compositions: Composition[] = [
	{ name: "head only", headRetention: { records: 12, thresholdPercent: 100 }, stages: () => [], rewritableOnly: true },
	{ name: "head → recent → older (all rewritable)", headRetention: { records: 6, thresholdPercent: 100 }, rewritableOnly: true, stages: () => [
		{ tier: new MemoryHistoryTier("recent"), retention: { records: 8, thresholdPercent: 100 } },
		{ tier: new MemoryHistoryTier("older"), retention: { records: 10, thresholdPercent: 100 } },
	] },
	{ name: "head → recent → cold (cold append-only, kept forever)", headRetention: { records: 6, thresholdPercent: 80 }, rewritableOnly: false, stages: () => [
		{ tier: new MemoryHistoryTier("recent"), retention: { records: 8, thresholdPercent: 100 } },
		{ tier: appendOnly("cold"), retention: { thresholdPercent: 100 } },
	] },
	// Small segments (one per room per copied batch), trimmed by count.
	{ name: "head → recent (memory) → cold (blob over MemoryBlobStore)", headRetention: { records: 6, thresholdPercent: 80 }, rewritableOnly: false, stages: () => [
		{ tier: new MemoryHistoryTier("recent"), retention: { records: 8, thresholdPercent: 100 } },
		{ tier: new BlobHistoryTier({ name: "cold", store: new MemoryBlobStore(), index: new MemorySegmentIndex(), prefix: "history/model/", clock: { now: () => 0 } }), retention: { records: 30, thresholdPercent: 100 } },
	] },
];

function build(composition: Composition, options: { faults?: () => boolean } = {}) {
	const clock = new TestClock();
	const head = new MemoryHead("hot", clock);
	const stages = composition.stages();
	const states = new MemoryTierStateStore();
	const faulty = options.faults;
	const wrapped = faulty ? stages.map((stage) => ({ ...stage, tier: instrument(stage.tier, async (method, call) => {
		// "Wrote but reported failure" as often as "failed before writing".
		if (method !== "read" && method !== "stats" && faulty()) {
			if (faulty()) await call();
			throw new Error(`injected ${method} failure`);
		}
		return call();
	}) })) : stages;
	const pipeline = new HistoryPipeline({ head, headRetention: composition.headRetention, stages: wrapped, state: states, clock, batch: 3, trimBatch: 4 });
	return { clock, head, stages, pipeline };
}

/** Runs single steps until idle, checking the invariants after each. */
async function settle(pipeline: HistoryPipeline, limit = 2_000): Promise<{ failures: number }> {
	let previous = { tiers: await pipeline.views(), published: await pipeline.publishedFloor() };
	let failures = 0;
	for (let count = 0; count < limit; count += 1) {
		const { more, report } = await pipeline.cycle({ steps: 1 });
		const now = { tiers: await pipeline.views(), published: await pipeline.publishedFloor() };
		expect(checkInvariants(now.tiers, now.published, previous)).toEqual([]);
		previous = now;
		if (report.failure) failures += 1;
		else if (!more) return { failures };
	}
	throw new Error("the pipeline did not settle");
}

/** A room's whole history through the pipeline, paged backward `size` log IDs at a time. */
async function history(pipeline: HistoryPipeline, roomId: string, size: number): Promise<ChatRecord[]> {
	const out: ChatRecord[] = [];
	let upper = Number.MAX_SAFE_INTEGER;
	for (;;) {
		const page = await pipeline.read({ roomIds: [roomId], lower: 1, upper, forward: false, limit: size });
		if (!page.length) break;
		out.push(...page.filter((record) => record.room_id === roomId));
		upper = Math.min(...page.map((record) => record.log_id)) - 1;
	}
	return out.reverse();
}

describe("HistoryPipeline over memory tiers", () => {
	it("moves records down as each tier's retention allows, and serves them as one log", async () => {
		const { clock, head, stages, pipeline } = build(compositions[1]);
		const made: ChatRecord[] = [];
		for (let index = 0; index < 30; index += 1) {
			clock.time += 10;
			made.push(head.commit("general", "message", { message_id: `m${index}`, from: { user_id: "ada" }, body: { text: `${index}` } }));
		}
		await settle(pipeline);
		const views = await pipeline.views();
		// 6 in the head, 8 more in recent, 10 more in older: the 24 newest.
		expect(views.map((tier) => tier.state.floor)).toEqual([made[24].log_id, made[16].log_id, made[6].log_id]);
		expect(await pipeline.publishedFloor()).toBe(made[6].log_id);
		expect((await history(pipeline, "general", 5)).map((record) => record.log_id)).toEqual(made.slice(6).map((record) => record.log_id));
		// Each tier trimmed what is below its floor.
		expect(head.all().length).toBe(6);
		expect((stages[1].tier as MemoryHistoryTier).all()[0].log_id).toBe(made[6].log_id);
	});

	it("carries /purge to each rewritable tier, and stops at the first that is not", async () => {
		const { clock, head, stages, pipeline } = build(compositions[2]);
		for (let index = 0; index < 30; index += 1) {
			clock.time += 10;
			head.commit("general", "message", { message_id: `m${index}`, from: { user_id: index % 3 ? "ada" : "bob" }, body: { text: `${index}` } });
		}
		await settle(pipeline);
		const { reached } = await pipeline.purge(["bob"]);
		expect(reached).toEqual(["hot", "recent"]);
		const served = await history(pipeline, "general", 7);
		const cold = (stages[1].tier as ReturnType<typeof appendOnly>).inner;
		const recentFloor = (await pipeline.views())[1].state.floor;
		// bob's messages are gone where purge reached; the cold tier still serves its own.
		for (const record of served) {
			const from = (JSON.parse(record.record_json) as { from: { user_id: string } }).from.user_id;
			if (record.log_id >= recentFloor) expect(from).toBe("ada");
		}
		expect(cold.all().some((record) => record.record_json.includes("bob"))).toBe(true);
		expect(await head.ops()).toEqual([]);
	});

	it("applies an op a tier has yet to apply to pages read from it", async () => {
		const { clock, head, pipeline } = build(compositions[1]);
		for (let index = 0; index < 20; index += 1) {
			clock.time += 10;
			head.commit("general", "message", { message_id: `m${index}`, from: { user_id: index === 3 ? "eve" : "ada" }, body: { text: `${index}` } });
		}
		await settle(pipeline);
		// Purged at the head only: the tiers below have not applied it yet.
		await head.purge(["eve"]);
		expect((await history(pipeline, "general", 50)).some((record) => record.record_json.includes("eve"))).toBe(false);
		await settle(pipeline);
		expect(await head.ops()).toEqual([]);
	});

	it("records a stalled copy, alerts once, and catches up when the tier recovers", async () => {
		let failing = true;
		const composition = compositions[1];
		const { clock, head, pipeline } = build(composition, { faults: () => failing });
		for (let index = 0; index < 20; index += 1) {
			clock.time += 10;
			head.commit("general", "message", { message_id: `m${index}`, from: { user_id: "ada" }, body: { text: `${index}` } });
		}
		const first = await pipeline.cycle({ steps: 50 });
		expect(first.report.failure).toBeDefined();
		clock.time += 7 * 3_600_000;
		failing = false;
		// The head copies to recent, which works: the failing hop was recent → older (its floorFor failed first, at target).
		expect((await pipeline.stallsToAlert(6 * 3_600_000)).length).toBeLessThanOrEqual(1);
		await settle(pipeline);
		expect((await pipeline.views()).every((tier) => tier.state.stalledSince === undefined)).toBe(true);
	});
});

describe("HistoryPipeline upkeep", () => {
	it("forgets the op log when no tier below the head is rewritable", async () => {
		const clock = new TestClock();
		const head = new MemoryHead("hot", clock);
		const pipeline = new HistoryPipeline({ head, headRetention: { records: 5, thresholdPercent: 100 }, stages: [{ tier: appendOnly("cold"), retention: { thresholdPercent: 100 } }], state: new MemoryTierStateStore(), clock });
		head.commit("general", "message", { message_id: "m1", from: { user_id: "ada" } });
		await head.purge(["ada"]);
		expect((await head.ops()).length).toBe(1);
		await pipeline.cycle({ steps: 10 });
		expect(await head.ops()).toEqual([]);
	});

	it("notes a stall when the tier below fails at any step, not only at a copy", async () => {
		const clock = new TestClock();
		const head = new MemoryHead("hot", clock);
		let down = true;
		const recent = instrument(new MemoryHistoryTier("recent"), async (method, call) => {
			if (down && method !== "stats") throw new Error("D1 is down");
			return call();
		});
		const pipeline = new HistoryPipeline({ head, headRetention: { records: 2, thresholdPercent: 100 }, stages: [{ tier: recent, retention: { records: 4, thresholdPercent: 100 } }], state: new MemoryTierStateStore(), clock });
		for (let index = 0; index < 5; index += 1) {
			clock.time += 10;
			head.commit("general", "message", { message_id: `m${index}`, from: { user_id: "ada" } });
		}
		const failed = await pipeline.cycle({ steps: 10 });
		expect(failed.report.failure?.step.kind).toBe("target");
		expect((await pipeline.views())[0].state.stalledSince).toBe(clock.time);
		clock.time += 7 * 3_600_000;
		expect(await pipeline.stallsToAlert(6 * 3_600_000)).toEqual([{ from: "hot", to: "recent", since: clock.time - 7 * 3_600_000 }]);
		down = false;
		await settle(pipeline);
		expect((await pipeline.views())[0].state.stalledSince).toBeUndefined();
	});

	it("does not read a lower tier's count again while nothing above it changed", async () => {
		const clock = new TestClock();
		const head = new MemoryHead("hot", clock);
		let counts = 0;
		const recent = instrument(new MemoryHistoryTier("recent"), async (method, call) => {
			if (method === "floorFor") counts += 1;
			return call();
		});
		const pipeline = new HistoryPipeline({ head, headRetention: { records: 3, thresholdPercent: 100 }, stages: [{ tier: recent, retention: { records: 4, thresholdPercent: 100 } }], state: new MemoryTierStateStore(), clock });
		for (let index = 0; index < 10; index += 1) {
			clock.time += 10;
			head.commit("general", "message", { message_id: `m${index}`, from: { user_id: "ada" } });
		}
		await settle(pipeline);
		const settled = counts;
		for (let round = 0; round < 5; round += 1) await pipeline.cycle({ steps: 10 });
		expect(counts).toBe(settled);
		// New records moving down change what is above it: counted again.
		clock.time += 10;
		head.commit("general", "message", { message_id: "m-new", from: { user_id: "ada" } });
		await settle(pipeline);
		expect(counts).toBeGreaterThan(settled);
	});
});

/*
 * Model-based runs (fast-check): a command sequence of posts, reactions,
 * memberships, moves, pipeline cycles (some with injected tier faults),
 * settles, purges and renames, run against a real pipeline and the reference
 * Model. After every command, the invariants hold against the state before
 * it (checkInvariants), and every room's history, paged at the command's own
 * page size, equals the model's from the published floor on (I4). Once the
 * sequence ends and the pipeline settles, no tier holds a record below its
 * floor (I3). A failure shrinks to a minimal sequence, and fast-check prints
 * the seed and path that replay it (HISTORY_SEED and HISTORY_PATH replay
 * one here).
 */

/** What the commands know: the reference model and who and what can still be acted on. */
interface World {
	model: Model;
	users: string[];
	messages: Array<{ id: string; room: string; from: string }>;
	step: number;
	renamed: number;
	rewritableOnly: boolean;
}

/** The pipeline under test, and the fault pattern a faulty cycle draws from (none otherwise). */
interface Real {
	clock: TestClock;
	head: MemoryHead;
	pipeline: HistoryPipeline;
	faults: { pattern: boolean[]; at: number } | undefined;
	previous: { tiers: TierView[]; published: number };
}

const ROOMS = ["general", "random"] as const;

/** A command: advances the clock, acts, then checks the invariants and every room's history against the model. */
abstract class Step implements fc.AsyncCommand<World, Real> {
	constructor(readonly dt: number, readonly page: number) {}
	check(_world: Readonly<World>): boolean { return true; }
	abstract act(world: World, real: Real): Promise<void>;
	abstract label(): string;
	toString(): string { return `${this.label()} +${this.dt}ms /${this.page}`; }
	async run(world: World, real: Real): Promise<void> {
		world.step += 1;
		real.clock.time += this.dt;
		await this.act(world, real);
		await verify(world, real, this.page);
	}
}

class Post extends Step {
	constructor(dt: number, page: number, readonly room: number, readonly user: number) { super(dt, page); }
	label() { return `post(${ROOMS[this.room]}, user ${this.user})`; }
	async act(world: World, real: Real) {
		const room = ROOMS[this.room];
		const from = world.users[this.user % world.users.length];
		const id = `m${world.step}`;
		world.messages.push({ id, room, from });
		world.model.add(real.head.commit(room, "message", { message_id: id, from: { user_id: from }, body: { text: `${world.step}` } }));
	}
}

class React extends Step {
	constructor(dt: number, page: number, readonly message: number, readonly user: number) { super(dt, page); }
	check(world: Readonly<World>) { return world.messages.length > 0; }
	label() { return `react(message ${this.message}, user ${this.user})`; }
	async act(world: World, real: Real) {
		const message = world.messages[this.message % world.messages.length];
		world.model.add(real.head.commit(message.room, "reactions", { message_id: message.id, reactions: [{ from: { user_id: world.users[this.user % world.users.length] }, emojis: ["👍"] }] }));
	}
}

class Membership extends Step {
	constructor(dt: number, page: number, readonly room: number, readonly user: number, readonly joined: boolean) { super(dt, page); }
	label() { return `${this.joined ? "join" : "leave"}(${ROOMS[this.room]}, user ${this.user})`; }
	async act(world: World, real: Real) {
		world.model.add(real.head.commit(ROOMS[this.room], "membership", { members: [{ user: { user_id: world.users[this.user % world.users.length] }, joined: this.joined }] }));
	}
}

/** A move: one record logged in both rooms. */
class Move extends Step {
	constructor(dt: number, page: number, readonly message: number) { super(dt, page); }
	check(world: Readonly<World>) { return world.messages.length > 0; }
	label() { return `move(message ${this.message})`; }
	async act(world: World, real: Real) {
		const message = world.messages[this.message % world.messages.length];
		const to = ROOMS.find((room) => room !== message.room)!;
		const record = real.head.commit(to, "message", { message_id: message.id, from: { user_id: message.from }, prev_room_id: message.room }, { alsoIn: message.room });
		world.model.add(record, message.room);
		message.room = to;
	}
}

/**
 * Up to `steps` pipeline steps. With a fault pattern, each tier call below
 * the head draws from it in turn, until it runs out: a failure, and then
 * whether the call wrote before failing ("wrote but reported failure" as
 * well as "failed before writing").
 */
class Cycle extends Step {
	constructor(dt: number, page: number, readonly steps: number, readonly faults: boolean[] | undefined) { super(dt, page); }
	label() { return `cycle(${this.steps}${this.faults ? `, faults ${this.faults.map((fault) => (fault ? 1 : 0)).join("")}` : ""})`; }
	async act(_world: World, real: Real) {
		real.faults = this.faults && { pattern: this.faults, at: 0 };
		try {
			await real.pipeline.cycle({ steps: this.steps });
		} finally {
			real.faults = undefined;
		}
	}
}

class Settle extends Step {
	label() { return "settle"; }
	async act(_world: World, real: Real) {
		await settle(real.pipeline);
	}
}

/** /purge, once settled, so every tier holds exactly what it serves. A purged ID is retired: it never posts again, and no one acts on its messages. */
class Purge extends Step {
	constructor(dt: number, page: number, readonly user: number) { super(dt, page); }
	check(world: Readonly<World>) { return world.rewritableOnly; }
	label() { return `purge(user ${this.user})`; }
	async act(world: World, real: Real) {
		const index = this.user % world.users.length;
		const user = world.users[index];
		await settle(real.pipeline);
		await real.pipeline.purge([user]);
		world.model.apply({ op: "purge", userIds: [user], messageIds: [] }, await real.pipeline.publishedFloor());
		world.users[index] = `new${world.step}`;
		world.messages = world.messages.filter((message) => message.from !== user);
	}
}

class Rename extends Step {
	constructor(dt: number, page: number, readonly user: number) { super(dt, page); }
	check(world: Readonly<World>) { return world.rewritableOnly; }
	label() { return `rename(user ${this.user})`; }
	async act(world: World, real: Real) {
		const index = this.user % world.users.length;
		const from = world.users[index];
		const to = `${from}-${(world.renamed += 1)}`;
		world.users[index] = to;
		for (const message of world.messages) if (message.from === from) message.from = to;
		await settle(real.pipeline);
		await real.pipeline.rename(from, to);
		world.model.apply({ op: "rename", from, to }, await real.pipeline.publishedFloor());
	}
}

/** The invariants against the state before the command, and I4: every room's history equals the model's from the published floor on. */
async function verify(world: World, real: Real, page: number): Promise<void> {
	const now = { tiers: await real.pipeline.views(), published: await real.pipeline.publishedFloor() };
	expect(checkInvariants(now.tiers, now.published, real.previous)).toEqual([]);
	real.previous = now;
	for (const room of ROOMS) {
		const served = show(await history(real.pipeline, room, page));
		const expected = show(world.model.room(room, now.published));
		if (served.join("\n") !== expected.join("\n")) {
			throw new Error(`${room}, published ${now.published}, tiers ${JSON.stringify(now.tiers)}, head holds ${real.head.all().map((record) => record.log_id).join(",")}, lower hold ${JSON.stringify(await Promise.all(real.pipeline.tiers.slice(1).map(async (tier) => (await tier.scan(0, 1000)).records.map((record) => record.log_id + record.room_id))))}:\nserved, not expected:\n${served.filter((line) => !expected.includes(line)).join("\n")}\nexpected, not served:\n${expected.filter((line) => !served.includes(line)).join("\n")}`);
		}
	}
}

/** The commands, weighted as a busy room is: mostly posts and pipeline work, sometimes reactions, moves, purges and renames. */
function commandsFor(composition: Composition) {
	const dt = fc.integer({ min: 1, max: 5 });
	const page = fc.integer({ min: 1, max: 6 });
	const room = fc.integer({ min: 0, max: ROOMS.length - 1 });
	const user = fc.nat({ max: 3 });
	const message = fc.nat({ max: 1_000 });
	const faults = fc.array(fc.boolean(), { minLength: 1, maxLength: 24 });
	const weighted = [
		{ weight: 40, arbitrary: fc.tuple(dt, page, room, user).map(([d, p, r, u]) => new Post(d, p, r, u)) },
		{ weight: 15, arbitrary: fc.tuple(dt, page, message, user).map(([d, p, m, u]) => new React(d, p, m, u)) },
		{ weight: 7, arbitrary: fc.tuple(dt, page, room, user, fc.boolean()).map(([d, p, r, u, j]) => new Membership(d, p, r, u, j)) },
		{ weight: 6, arbitrary: fc.tuple(dt, page, message).map(([d, p, m]) => new Move(d, p, m)) },
		{ weight: 16, arbitrary: fc.tuple(dt, page, fc.integer({ min: 1, max: 8 })).map(([d, p, s]) => new Cycle(d, p, s, undefined)) },
		{ weight: 6, arbitrary: fc.tuple(dt, page, fc.integer({ min: 1, max: 8 }), faults).map(([d, p, s, f]) => new Cycle(d, p, s, f)) },
		{ weight: 4, arbitrary: fc.tuple(dt, page).map(([d, p]) => new Settle(d, p)) },
		...(composition.rewritableOnly ? [
			{ weight: 5, arbitrary: fc.tuple(dt, page, user).map(([d, p, u]) => new Purge(d, p, u)) },
			{ weight: 5, arbitrary: fc.tuple(dt, page, user).map(([d, p, u]) => new Rename(d, p, u)) },
		] : []),
	];
	return fc.commands([fc.oneof(...weighted)], { maxCommands: 120, size: "max" });
}

/**
 * fast-check's options: `numRuns`, or HISTORY_RUNS for a longer soak; a
 * failure's seed and path replay with HISTORY_SEED and HISTORY_PATH.
 */
function runOptions(numRuns: number): fc.Parameters<unknown> {
	const { HISTORY_SEED: seed, HISTORY_PATH: path, HISTORY_RUNS: runs } = env as unknown as Record<string, string | undefined>;
	return {
		numRuns: Number(runs) || numRuns,
		...(seed ? { seed: Number(seed), ...(path ? { path } : {}), endOnFailure: true } : {}),
	};
}

/** A soak (HISTORY_RUNS) takes longer than a test's default 5 s. */
const PROPERTY_TIMEOUT = (env as unknown as Record<string, string | undefined>).HISTORY_RUNS ? 3_600_000 : undefined;

describe("model-based runs", () => {
	for (const composition of compositions) {
		it(composition.name, async () => {
			await fc.assert(fc.asyncProperty(commandsFor(composition), async (commands) => {
				let real: Real | undefined;
				await fc.asyncModelRun(() => {
					const fault = () => {
						const faults = real?.faults;
						if (!faults) return false;
						return faults.at < faults.pattern.length ? faults.pattern[faults.at++] : false;
					};
					const built = build(composition, { faults: fault });
					real = { clock: built.clock, head: built.head, pipeline: built.pipeline, faults: undefined, previous: { tiers: [], published: 0 } };
					return {
						model: { model: new Model(), users: ["ada", "bob", "cy", "dee"], messages: [], step: 0, renamed: 0, rewritableOnly: composition.rewritableOnly },
						real,
					};
				}, commands);
				// I3, once settled: no tier holds a record below its floor.
				const { pipeline } = real!;
				await settle(pipeline);
				const views = await pipeline.views();
				for (const [index, tier] of pipeline.tiers.entries()) {
					const held = await tier.scan(0, 1);
					if (held.records.length) expect(held.records[0].log_id).toBeGreaterThanOrEqual(views[index].state.floor);
				}
			// Sequences average 58 commands (up to 120): 12 runs cover about as many steps as the 6 fixed 120-step seeds before.
			}), runOptions(12));
		}, PROPERTY_TIMEOUT);
	}
});

describe("fault injection", () => {
	it("loses nothing and duplicates nothing whatever fails", async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(fc.boolean(), { minLength: 1, maxLength: 120 }),
			fc.integer({ min: 10, max: 40 }),
			fc.integer({ min: 2, max: 9 }),
			async (pattern, count, every) => {
				let at = 0;
				const composition = compositions[1];
				const clean = build(composition);
				// Each tier call draws from the pattern in turn until it runs out; then calls work.
				const faulty = build(composition, { faults: () => (at < pattern.length ? pattern[at++] : false) });
				for (let index = 0; index < count; index += 1) {
					for (const run of [clean, faulty]) {
						run.clock.time += 10;
						run.head.commit(index % 2 ? "general" : "random", "message", { message_id: `m${index}`, from: { user_id: "ada" }, body: { text: `${index}` } });
					}
					if (index % every === every - 1) {
						await settle(clean.pipeline);
						await settle(faulty.pipeline);
					}
				}
				await settle(clean.pipeline);
				await settle(faulty.pipeline);
				for (const room of ROOMS) {
					expect(show(await history(faulty.pipeline, room, 4))).toEqual(show(await history(clean.pipeline, room, 4)));
				}
				expect((await faulty.pipeline.views()).map((tier) => tier.state.floor)).toEqual((await clean.pipeline.views()).map((tier) => tier.state.floor));
			},
		), runOptions(6));
	}, PROPERTY_TIMEOUT);
});

describe("model-based regressions", () => {
	// Found by the model runs: cy's message m1 is reacted to, then moved, and
	// trimmed until its first snapshot is gone. Its move snapshot is in
	// "recent", but the reactions made before the move are in "older". /purge of
	// cy found m1 as cy's only in "recent", so "older" kept the reactions on it
	// (HistoryPipeline.applyOps now amends the op for the tiers below).
	it("drops reactions below the tier that found a purged user's message", async () => {
		const built = build(compositions[1]);
		const real: Real = { clock: built.clock, head: built.head, pipeline: built.pipeline, faults: undefined, previous: { tiers: [], published: 0 } };
		const world: World = { model: new Model(), users: ["ada", "bob", "cy", "dee"], messages: [], step: 0, renamed: 0, rewritableOnly: true };
		const post = (user: number) => new Post(1, 1, 0, user);
		const react = () => new React(1, 1, 0, 0);
		const leave = () => new Membership(1, 1, 0, 0, false);
		const steps: Step[] = [
			post(2), post(0), leave(), react(), post(0), post(0), post(0), react(), react(), react(), post(0), react(),
			post(0), post(0), post(0), post(0), post(0), post(0), new Move(1, 1, 0), leave(), post(0), post(0), react(), post(0), post(0),
			new Purge(1, 1, 2),
		];
		for (const step of steps) await step.run(world, real);
	});
});
