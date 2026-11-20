import { env } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "./support/memory-blob-store";
import { MemoryChunkIndex } from "./support/memory-chunk-index";
import { ColdHistoryTier } from "../../src/history/cold/tier";
import { HISTORY_CODECS } from "../../src/history/config";
import { MemoryChainStateStore, MemoryHead, MemoryHistoryTier } from "./support/memory-tiers";
import { type ChainSnapshot, type ChainView, type TierView, checkInvariants, copyNow, mergePages, planRead, planStep } from "../../src/history/link";
import { type ChainStage, HistoryChain, instrument } from "../../src/history/chain";
import type { ChatRecord, Retention } from "../../src/history/records";
import { NOT_STALLED } from "../../src/history/stall";
import type { LinkState } from "../../src/history/tier";
import { Model, show } from "./model";

const tier = (name: string, floor: number, target = floor, rewrites = true): TierView => ({ name, floor, target, rewrites });
const link = (through: number, delivered = 0): LinkState => ({ through, delivered, stall: NOT_STALLED });
const round = () => ({ targeted: new Set<number>(), advanced: new Map<number, number>(), trimmed: new Map<number, number>(), waiting: new Map<number, number>(), oldest: 1 });

describe("planStep", () => {
	it("delivers rewrites down each link in order, bottom-up, a link only what the tier above holds", () => {
		const snapshot: ChainSnapshot & ReturnType<typeof round> = { tiers: [tier("hot", 10), tier("recent", 5), tier("cold", 1, 1, false)], links: [link(9), link(4)], published: 1, logged: 2, ...round() };
		for (const index of [0, 1, 2]) snapshot.targeted.add(index);
		snapshot.trimmed.set(2, 1);
		// The link into cold waits for recent to hold rewrite 1: the head's link delivers first.
		expect(planStep(snapshot)).toEqual({ kind: "deliver", link: 0, seq: 1 });
		snapshot.links = [link(9, 1), link(4)];
		expect(planStep(snapshot)).toEqual({ kind: "deliver", link: 1, seq: 1 });
	});

	it("copies only from a tier that holds every rewrite", () => {
		const snapshot: ChainSnapshot & ReturnType<typeof round> = { tiers: [tier("hot", 10, 10), tier("recent", 5, 8), tier("cold", 1)], links: [link(9, 1), link(4, 0)], published: 1, logged: 2, ...round() };
		for (const index of [0, 1, 2]) snapshot.targeted.add(index);
		snapshot.trimmed.set(2, 1);
		// recent has rewrite 1 of 2: no copy into cold, which waits for the head's link to deliver 2 first.
		expect(planStep(snapshot)).toEqual({ kind: "deliver", link: 1, seq: 1 });
		snapshot.links = [link(9, 1), link(4, 1)];
		expect(planStep(snapshot)).toEqual({ kind: "deliver", link: 0, seq: 2 });
		snapshot.links = [link(9, 2), link(4, 1)];
		expect(planStep(snapshot)).toEqual({ kind: "deliver", link: 1, seq: 2 });
		snapshot.links = [link(9, 2), link(4, 2)];
		expect(planStep(snapshot)).toEqual({ kind: "copy", link: 1, start: 5, below: 8 });
	});

	it("starts a new link at the oldest rewrite still logged, and acknowledges what the log no longer holds", () => {
		const snapshot: ChainSnapshot & ReturnType<typeof round> = { tiers: [tier("hot", 10), tier("recent", 5)], links: [link(9, 0)], published: 1, logged: 6, ...round(), oldest: 5 };
		snapshot.targeted.add(0);
		snapshot.targeted.add(1);
		// Rewrites 1 to 4 were delivered everywhere and dropped before this link had state: it starts at 5.
		expect(planStep(snapshot)).toEqual({ kind: "deliver", link: 0, seq: 5 });
		// Nothing left in the log (oldest is past what was logged): the step acknowledges up to what the head holds.
		snapshot.oldest = 7;
		expect(planStep(snapshot)).toEqual({ kind: "deliver", link: 0, seq: 6 });
	});

	it("leaves a waiting link until more arrives in the tier above it", () => {
		const snapshot: ChainSnapshot & ReturnType<typeof round> = { tiers: [tier("hot", 10, 10), tier("recent", 5, 8), tier("cold", 1)], links: [link(9), link(4)], published: 1, logged: 0, ...round() };
		for (const index of [0, 1, 2]) snapshot.targeted.add(index);
		snapshot.trimmed.set(2, 1);
		expect(planStep(snapshot)).toEqual({ kind: "copy", link: 1, start: 5, below: 8 });
		// The copy found less than a whole batch due: the link waits, recent keeps its floor, and the round moves up.
		snapshot.waiting.set(1, 9);
		expect(planStep(snapshot)).toEqual({ kind: "trim", tier: 1, below: 5 });
		snapshot.trimmed.set(1, 5);
		snapshot.trimmed.set(0, 10);
		expect(planStep(snapshot)).toEqual({ kind: "idle" });
		// Records arrived in recent (the head's link copied more): the link looks again.
		snapshot.links = [link(12), link(4)];
		expect(planStep(snapshot)).toEqual({ kind: "copy", link: 1, start: 5, below: 8 });
	});

	it("copies into a batched tier a whole batch at a time, unless the tier above is at its limit or has none by count", () => {
		const cases: Array<[Parameters<typeof copyNow>[0], boolean]> = [
			[{ pending: 10, batch: 10, held: 50, limit: 100 }, true],
			[{ pending: 9, batch: 10, held: 99, limit: 100 }, false],
			[{ pending: 9, batch: 10, held: 100, limit: 100 }, true],
			[{ pending: 1, batch: 10, held: 0 }, true],
			[{ pending: 1, batch: 10, held: 0, limit: 0 }, true],
		];
		for (const [input, expected] of cases) expect(copyNow(input)).toBe(expected);
	});

	it("works bottom-up: target, copy, advance and trim each tier, then publishes", () => {
		const snapshot: ChainSnapshot & ReturnType<typeof round> = { tiers: [tier("hot", 10, 20), tier("cold", 1)], links: [link(9)], published: 1, logged: 0, ...round() };
		expect(planStep(snapshot)).toEqual({ kind: "target", tier: 1 });
		snapshot.targeted.add(1);
		// The bottom tier has nothing to trim below its floor of 1... once noted as trimmed.
		expect(planStep(snapshot)).toEqual({ kind: "trim", tier: 1, below: 1 });
		snapshot.trimmed.set(1, 1);
		expect(planStep(snapshot)).toEqual({ kind: "target", tier: 0 });
		snapshot.targeted.add(0);
		expect(planStep(snapshot)).toEqual({ kind: "copy", link: 0, start: 10, below: 20 });
		snapshot.links = [link(19)];
		expect(planStep(snapshot)).toEqual({ kind: "advance", tier: 0, floor: 20 });
		snapshot.advanced.set(0, 20);
		expect(planStep(snapshot)).toEqual({ kind: "trim", tier: 0, below: 20 });
		snapshot.trimmed.set(0, 20);
		expect(planStep(snapshot)).toEqual({ kind: "idle" });
		// The deepest tier's floor rises: published before it trims.
		snapshot.tiers = [tier("hot", 20, 20), tier("cold", 5, 5)];
		expect(planStep(snapshot)).toEqual({ kind: "publish", floor: 5 });
	});
});

describe("checkInvariants", () => {
	it("reports unordered floors, trims past copies, rewrites out of order, and a published floor too high or falling", () => {
		const now: ChainView = { tiers: [tier("hot", 10), tier("recent", 12)], links: [link(5, 3)] };
		const before: ChainView = { tiers: [tier("hot", 11), tier("recent", 1)], links: [link(5, 4)] };
		expect(checkInvariants(now, 13, 2, { chain: before, published: 14 })).toEqual([
			"I1: recent's floor 12 is above hot's 10",
			"I2: hot's floor 10 passed what recent holds (through 5)",
			"I7: recent was delivered rewrite 3, past 2, what hot holds",
			"I6: the published floor 13 is above 12, the deepest tier's",
			"I1: hot's floor fell from 11 to 10",
			"I7: the link from hot went back from rewrite 4 to 3",
			"I6: the published floor fell from 14 to 13",
		]);
		expect(checkInvariants({ tiers: [tier("hot", 10), tier("recent", 4)], links: [link(9, 2)] }, 4, 2)).toEqual([]);
	});
});

// The model runs read through planRead and mergePages on every command; these
// cover what they cannot reach: tier windows never overlap there, so no two
// tiers' copies of a record meet in a merge.
describe("planRead and mergePages", () => {
	it("give each tier the window between its floor and the floor above, and merge by log ID, a move once, the upper tier winning", () => {
		const tiers = [tier("hot", 100), tier("recent", 50), tier("cold", 10)];
		const query = { roomIds: ["a"], lower: 1, upper: 200, forward: false, limit: 10 };
		expect(planRead(query, tiers, 20).map((part) => [part.tier, part.query.lower, part.query.upper])).toEqual([[0, 100, 200], [1, 50, 99], [2, 20, 49]]);
		expect(planRead({ ...query, forward: true }, tiers, 20).map((part) => part.tier)).toEqual([2, 1, 0]);
		expect(planRead(query, tiers, 20, { skipHead: true }).map((part) => part.tier)).toEqual([1, 2]);
		const record = (room: string, logId: number, json = "{}"): ChatRecord => ({ room_id: room, log_id: logId, commit_ms: logId, kind: "message", record_json: json });
		const merged = mergePages([
			{ tier: 1, records: [record("a", 5, "old"), record("a", 4), record("b", 4)] },
			{ tier: 0, records: [record("a", 5, "new"), record("a", 6)] },
		], { forward: false, limit: 2 });
		expect(merged.map((entry) => `${entry.room_id}${entry.log_id}${entry.record_json}`)).toEqual(["a6{}", "a5new"]);
		expect(mergePages([{ tier: 1, records: [record("a", 4), record("b", 4), record("a", 3)] }], { forward: true, limit: 2 }).length).toBe(3);
	});
});

/** A clock tests move by hand. */
class TestClock {
	constructor(public time = 1_000_000) {}
	now(): number { return this.time; }
}

interface Composition {
	name: string;
	headRetention: Retention;
	stages: () => ChainStage[];
	/** The head's scan cap (HistoryTier.scanLimit), as the Store's: a copy gathers a larger batch over several scans. */
	headScanLimit?: number;
}

/** A cold tier over memory: chunks of `chunkLogIds` log IDs. It takes no rewrites. */
function cold(chunkLogIds: number): ColdHistoryTier {
	return new ColdHistoryTier({ name: "cold", store: new MemoryBlobStore(), index: new MemoryChunkIndex(), codecs: HISTORY_CODECS, prefix: "history/model/", clock: { now: () => 0 }, chunkLogIds });
}

const compositions: Composition[] = [
	{ name: "head only", headRetention: { records: 12, thresholdPercent: 100 }, stages: () => [] },
	{ name: "head → recent → older (memory, both take rewrites)", headRetention: { records: 6, thresholdPercent: 100 }, stages: () => [
		{ tier: new MemoryHistoryTier("recent"), retention: { records: 8, thresholdPercent: 100 } },
		{ tier: new MemoryHistoryTier("older"), retention: { records: 10, thresholdPercent: 100 } },
	] },
	{ name: "head → recent → cold (chunks, kept forever)", headRetention: { records: 6, thresholdPercent: 80 }, stages: () => [
		{ tier: new MemoryHistoryTier("recent"), retention: { records: 8, thresholdPercent: 100 } },
		{ tier: cold(4), retention: { thresholdPercent: 100 } },
	] },
	{ name: "head → recent → cold (chunks, trimmed by count)", headRetention: { records: 6, thresholdPercent: 80 }, stages: () => [
		{ tier: new MemoryHistoryTier("recent"), retention: { records: 8, thresholdPercent: 100 } },
		{ tier: cold(3), retention: { records: 30, thresholdPercent: 100 } },
	] },
	{ name: "head → cold (head scans capped below a chunk)", headRetention: { records: 6, thresholdPercent: 80 }, headScanLimit: 2, stages: () => [
		{ tier: cold(5), retention: { thresholdPercent: 100 } },
	] },
];

function build(composition: Composition, options: { faults?: () => boolean } = {}) {
	const clock = new TestClock();
	const head = new MemoryHead("hot", clock);
	if (composition.headScanLimit !== undefined) head.scanLimit = composition.headScanLimit;
	const stages = composition.stages();
	const faulty = options.faults;
	const wrapped = faulty ? stages.map((stage) => ({ ...stage, tier: instrument(stage.tier, async (method, call) => {
		// "Wrote but reported failure" as often as "failed before writing".
		if (method !== "read" && method !== "stats" && faulty()) {
			if (faulty()) await call();
			throw new Error(`injected ${method} failure`);
		}
		return call();
	}) })) : stages;
	const state = new MemoryChainStateStore();
	const chain = new HistoryChain({ head, headRetention: composition.headRetention, stages: wrapped, state, clock, batch: 3, trimBatch: 4 });
	return { clock, head, stages, chain, state };
}

/** The chain's state, and what the invariants need besides. */
async function observe(chain: HistoryChain) {
	return { chain: await chain.view(), published: await chain.publishedFloor(), logged: await chain.logged() };
}

/** Runs single steps until idle, checking the invariants after each. */
async function settle(chain: HistoryChain, limit = 2_000): Promise<{ failures: number }> {
	let previous = await observe(chain);
	let failures = 0;
	for (let count = 0; count < limit; count += 1) {
		const { more, report } = await chain.cycle({ steps: 1 });
		const now = await observe(chain);
		expect(checkInvariants(now.chain, now.published, now.logged, previous)).toEqual([]);
		previous = now;
		if (report.failure) failures += 1;
		else if (!more) return { failures };
	}
	throw new Error("the chain did not settle");
}

/** A room's whole history through the chain, paged backward `size` log IDs at a time. */
async function history(chain: HistoryChain, roomId: string, size: number): Promise<ChatRecord[]> {
	const out: ChatRecord[] = [];
	let upper = Number.MAX_SAFE_INTEGER;
	for (;;) {
		const page = await chain.read({ roomIds: [roomId], lower: 1, upper, forward: false, limit: size });
		if (!page.length) break;
		out.push(...page.filter((record) => record.room_id === roomId));
		upper = Math.min(...page.map((record) => record.log_id)) - 1;
	}
	return out.reverse();
}

/**
 * What the tiers that take no rewrites hold of the history served, once
 * settled: the log IDs below the floor of the deepest tier that does. A
 * rewrite reaches them only as it is read (withKept).
 */
async function unreached(chain: HistoryChain): Promise<(record: ChatRecord) => boolean> {
	const view = await chain.view();
	const first = view.tiers.findIndex((each) => !each.rewrites);
	if (first < 0) return () => false;
	const above = view.tiers[first - 1].floor;
	return (record) => record.log_id < above;
}

describe("HistoryChain over memory tiers: retention and upkeep", () => {
	it("moves records down as each tier's retention allows, and serves them as one log", async () => {
		const { clock, head, stages, chain } = build(compositions[1]);
		const made: ChatRecord[] = [];
		for (let index = 0; index < 30; index += 1) {
			clock.time += 10;
			made.push(head.commit("general", "message", { message_id: `m${index}`, from: { user_id: "ada" }, body: { text: `${index}` } }));
		}
		await settle(chain);
		const view = await chain.view();
		// 6 in the head, 8 more in recent, 10 more in older: the 24 newest.
		expect(view.tiers.map((each) => each.floor)).toEqual([made[24].log_id, made[16].log_id, made[6].log_id]);
		expect(await chain.publishedFloor()).toBe(made[6].log_id);
		expect((await history(chain, "general", 5)).map((record) => record.log_id)).toEqual(made.slice(6).map((record) => record.log_id));
		// Each tier trimmed what is below its floor.
		expect(head.all().length).toBe(6);
		expect((stages[1].tier as MemoryHistoryTier).all()[0].log_id).toBe(made[6].log_id);
	});

	it("forgets the rewrite log when there is no tier below the head", async () => {
		const clock = new TestClock();
		const head = new MemoryHead("hot", clock);
		const chain = new HistoryChain({ head, headRetention: { records: 5, thresholdPercent: 100 }, stages: [], state: new MemoryChainStateStore(), clock });
		head.commit("general", "message", { message_id: "m1", from: { user_id: "ada" } });
		await head.purge(["ada"]);
		expect((await head.rewrites.list()).length).toBe(1);
		await chain.cycle({ steps: 10 });
		expect(await head.rewrites.list()).toEqual([]);
	});

	it("hides a purge from a page that was reading while the purge was delivered and dropped from the log", async () => {
		const clock = new TestClock();
		const head = new MemoryHead("hot", clock);
		let gate: Promise<void> | undefined;
		let open = () => {};
		let entered = () => {};
		const reading = new Promise<void>((resolve) => { entered = resolve; });
		// A read that has its records (from before the purge reached recent) and is held before it returns them.
		const recent = instrument(new MemoryHistoryTier("recent"), async (method, call) => {
			const result = await call();
			if (method === "read" && gate) {
				entered();
				await gate;
			}
			return result;
		});
		const chain = new HistoryChain({ head, headRetention: { records: 2, thresholdPercent: 100 }, stages: [{ tier: recent, retention: { records: 100, thresholdPercent: 100 } }], state: new MemoryChainStateStore(), clock });
		for (let index = 0; index < 6; index += 1) {
			clock.time += 10;
			head.commit("general", "message", { message_id: `m${index}`, from: { user_id: index % 2 ? "bob" : "ada" } });
		}
		await settle(chain);
		await head.purge(["ada"]);
		gate = new Promise<void>((resolve) => { open = resolve; });
		const page = chain.read({ roomIds: ["general"], lower: 0, upper: Number.MAX_SAFE_INTEGER, forward: true, limit: 100 }, { skipHead: true });
		await reading;
		// Meanwhile the purge reaches recent and leaves the log; then the page's read goes on.
		gate = undefined;
		await settle(chain);
		expect(await head.rewrites.list()).toEqual([]);
		open();
		expect((await page).filter((record) => record.record_json.includes('"ada"'))).toEqual([]);
	});

	it("notes a stall on the link when the tier below fails at any step, not only at a copy", async () => {
		const clock = new TestClock();
		const head = new MemoryHead("hot", clock);
		let down = true;
		const recent = instrument(new MemoryHistoryTier("recent"), async (method, call) => {
			if (down && method !== "stats") throw new Error("D1 is down");
			return call();
		});
		const chain = new HistoryChain({ head, headRetention: { records: 2, thresholdPercent: 100 }, stages: [{ tier: recent, retention: { records: 4, thresholdPercent: 100 } }], state: new MemoryChainStateStore(), clock });
		for (let index = 0; index < 5; index += 1) {
			clock.time += 10;
			head.commit("general", "message", { message_id: `m${index}`, from: { user_id: "ada" } });
		}
		const failed = await chain.cycle({ steps: 10 });
		expect(failed.report.failure?.step.kind).toBe("target");
		expect((await chain.view()).links[0].stall).toEqual({ kind: "stalled", since: clock.time, step: "target" });
		clock.time += 7 * 3_600_000;
		expect(await chain.stallsToAlert(6 * 3_600_000)).toEqual([{ from: "hot", to: "recent", since: clock.time - 7 * 3_600_000 }]);
		// Alerted once: not again while it lasts.
		clock.time += 3_600_000;
		expect(await chain.stallsToAlert(6 * 3_600_000)).toEqual([]);
		down = false;
		await settle(chain);
		expect((await chain.view()).links[0].stall).toEqual(NOT_STALLED);
	});

	it("does not read a lower tier's count again while nothing above it changed", async () => {
		const clock = new TestClock();
		const head = new MemoryHead("hot", clock);
		let counts = 0;
		const recent = instrument(new MemoryHistoryTier("recent"), async (method, call) => {
			if (method === "floorFor") counts += 1;
			return call();
		});
		const chain = new HistoryChain({ head, headRetention: { records: 3, thresholdPercent: 100 }, stages: [{ tier: recent, retention: { records: 4, thresholdPercent: 100 } }], state: new MemoryChainStateStore(), clock });
		for (let index = 0; index < 10; index += 1) {
			clock.time += 10;
			head.commit("general", "message", { message_id: `m${index}`, from: { user_id: "ada" } });
		}
		await settle(chain);
		const settled = counts;
		for (let index = 0; index < 5; index += 1) await chain.cycle({ steps: 10 });
		expect(counts).toBe(settled);
		// New records moving down change what is above it: counted again.
		clock.time += 10;
		head.commit("general", "message", { message_id: "m-new", from: { user_id: "ada" } });
		await settle(chain);
		expect(counts).toBeGreaterThan(settled);
	});
});

/*
 * Model-based runs (fast-check): a command sequence of posts, reactions,
 * memberships, moves, chain cycles (some with injected tier faults),
 * settles, purges and renames, run against a real chain and the reference
 * Model. After every command, the invariants hold against the state before
 * it (checkInvariants), and every room's history, paged at the command's own
 * page size, equals the model's from the published floor on (I4). Once the
 * sequence ends and the chain settles, no tier holds a record below its
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
}

/** The chain under test, and the fault pattern a faulty cycle draws from (none otherwise). */
interface Real {
	clock: TestClock;
	head: MemoryHead;
	chain: HistoryChain;
	faults: { pattern: boolean[]; at: number } | undefined;
	previous: Awaited<ReturnType<typeof observe>> | undefined;
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
 * Up to `steps` chain steps. With a fault pattern, each tier call below
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
			await real.chain.cycle({ steps: this.steps });
		} finally {
			real.faults = undefined;
		}
	}
}

class Settle extends Step {
	label() { return "settle"; }
	async act(_world: World, real: Real) {
		await settle(real.chain);
	}
}

/**
 * /purge, once settled, so every tier holds exactly what it serves, and
 * delivered down every link before the check. A tier that takes no
 * rewrites (the cold tier) keeps what it held of the purged user. A purged
 * ID is retired: it never posts again, and no one acts on its messages.
 */
class Purge extends Step {
	constructor(dt: number, page: number, readonly user: number) { super(dt, page); }
	label() { return `purge(user ${this.user})`; }
	async act(world: World, real: Real) {
		const index = this.user % world.users.length;
		const user = world.users[index];
		await settle(real.chain);
		const kept = await unreached(real.chain);
		await real.head.purge([user]);
		await settle(real.chain);
		world.model.apply({ user, into: null }, { floor: await real.chain.publishedFloor(), kept });
		world.users[index] = `new${world.step}`;
		world.messages = world.messages.filter((message) => message.from !== user);
	}
}

/** /rename, once settled; pages read before its links deliver it have it applied. */
class Rename extends Step {
	constructor(dt: number, page: number, readonly user: number) { super(dt, page); }
	label() { return `rename(user ${this.user})`; }
	async act(world: World, real: Real) {
		const index = this.user % world.users.length;
		const from = world.users[index];
		const to = `${from}-${(world.renamed += 1)}`;
		world.users[index] = to;
		for (const message of world.messages) if (message.from === from) message.from = to;
		await settle(real.chain);
		const kept = await unreached(real.chain);
		await real.head.rename(from, to);
		world.model.apply({ user: from, into: to }, { floor: await real.chain.publishedFloor(), kept });
	}
}

/** The invariants against the state before the command, and I4: every room's history equals the model's from the published floor on. */
async function verify(world: World, real: Real, page: number): Promise<void> {
	const now = await observe(real.chain);
	expect(checkInvariants(now.chain, now.published, now.logged, real.previous)).toEqual([]);
	real.previous = now;
	for (const room of ROOMS) {
		const served = show(await history(real.chain, room, page));
		const expected = show(world.model.room(room, now.published));
		if (served.join("\n") !== expected.join("\n")) {
			throw new Error(`${room}, published ${now.published}, chain ${JSON.stringify(now.chain)}, head holds ${real.head.all().map((record) => record.log_id).join(",")}, lower hold ${JSON.stringify(await Promise.all(real.chain.tiers.slice(1).map(async (each) => (await each.scan(0, 1000)).records.map((record) => record.log_id + record.room_id))))}:\nserved, not expected:\n${served.filter((line) => !expected.includes(line)).join("\n")}\nexpected, not served:\n${expected.filter((line) => !served.includes(line)).join("\n")}`);
		}
	}
}

/** The commands, weighted as a busy room is: mostly posts and chain work, sometimes reactions, moves, purges and renames. */
function commands() {
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
		{ weight: 5, arbitrary: fc.tuple(dt, page, user).map(([d, p, u]) => new Purge(d, p, u)) },
		{ weight: 5, arbitrary: fc.tuple(dt, page, user).map(([d, p, u]) => new Rename(d, p, u)) },
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

/** head → recent → cold, with the cold tier's chunk index to read chunk sizes from. */
function batched(recent: Retention, chunk: number) {
	const clock = new TestClock();
	const head = new MemoryHead("hot", clock);
	const index = new MemoryChunkIndex();
	const coldTier = new ColdHistoryTier({ name: "cold", store: new MemoryBlobStore(), index, codecs: HISTORY_CODECS, prefix: "history/batched/", clock: { now: () => 0 }, chunkLogIds: chunk });
	const chain = new HistoryChain({
		head, headRetention: { records: 4, thresholdPercent: 100 }, state: new MemoryChainStateStore(), clock, batch: 3, trimBatch: 50,
		stages: [{ tier: new MemoryHistoryTier("recent"), retention: recent }, { tier: coldTier, retention: { thresholdPercent: 100 } }],
	});
	let posted = 0;
	const post = (count: number) => {
		for (let index = 0; index < count; index += 1, posted += 1) {
			clock.time += 10;
			head.commit(ROOMS[posted % ROOMS.length], "message", { message_id: `m${posted}`, from: { user_id: "ada" }, body: { text: `${posted}` } });
		}
	};
	/** What recent serves (below the head's floor): what it holds against its limit. */
	const held = async () => (await chain.stats())[1].stats.records;
	const chunks = async () => (await index.list()).map((ref) => ref.records);
	return { chain, post, held, chunks };
}

describe("copies into the cold tier", () => {
	it("cuts whole chunks in steady state, and the tier above holds at most its limit and one chunk", async () => {
		// recent keeps 10 of 20: 10 records of room before its limit, more than a chunk of 5.
		const { chain, post, held, chunks } = batched({ records: 20, thresholdPercent: 50 }, 5);
		for (let count = 0; count < 200; count += 1) {
			post(1);
			await settle(chain);
			expect(await held()).toBeLessThanOrEqual(20 + 5);
		}
		const sizes = await chunks();
		expect(sizes.length).toBeGreaterThan(30);
		expect(sizes.every((size) => size === 5)).toBe(true);
	});

	it("never lets the tier above pass its limit and one chunk, whatever arrives at once", async () => {
		await fc.assert(fc.asyncProperty(
			fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 40 }),
			fc.integer({ min: 2, max: 12 }),
			async (bursts, chunk) => {
				const { chain, post, held, chunks } = batched({ records: 16, thresholdPercent: 50 }, chunk);
				for (const burst of bursts) {
					post(burst);
					await settle(chain);
					// At rest: within its limit and one chunk.
					expect(await held()).toBeLessThanOrEqual(16 + chunk);
				}
				// A chunk is never more than a batch; a short one only where recent was at its limit.
				expect((await chunks()).every((size) => size >= 1 && size <= chunk)).toBe(true);
			},
		), runOptions(20));
	}, PROPERTY_TIMEOUT);
});

describe("model-based runs", () => {
	for (const composition of compositions) {
		it(composition.name, async () => {
			await fc.assert(fc.asyncProperty(commands(), async (sequence) => {
				let real: Real | undefined;
				await fc.asyncModelRun(() => {
					const fault = () => {
						const faults = real?.faults;
						if (!faults) return false;
						return faults.at < faults.pattern.length ? faults.pattern[faults.at++] : false;
					};
					const built = build(composition, { faults: fault });
					real = { clock: built.clock, head: built.head, chain: built.chain, faults: undefined, previous: undefined };
					return {
						model: { model: new Model(), users: ["ada", "bob", "cy", "dee"], messages: [], step: 0, renamed: 0 },
						real,
					};
				}, sequence);
				// I3, once settled: no tier holds a record below its floor.
				const { chain } = real!;
				await settle(chain);
				const view = await chain.view();
				for (const [index, each] of chain.tiers.entries()) {
					const held = await each.scan(0, 1);
					if (held.records.length) expect(held.records[0].log_id).toBeGreaterThanOrEqual(view.tiers[index].floor);
				}
			// Sequences average 58 commands (up to 120): 12 runs cover about as many steps as 6 fixed 120-step seeds.
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
						await settle(clean.chain);
						await settle(faulty.chain);
					}
				}
				await settle(clean.chain);
				await settle(faulty.chain);
				for (const room of ROOMS) {
					expect(show(await history(faulty.chain, room, 4))).toEqual(show(await history(clean.chain, room, 4)));
				}
				expect((await faulty.chain.view()).tiers.map((each) => each.floor)).toEqual((await clean.chain.view()).tiers.map((each) => each.floor));
			},
		), runOptions(6));
	}, PROPERTY_TIMEOUT);
});

describe("model-based regressions", () => {
	// Found by the model runs: cy's message m1 is reacted to, then moved, and
	// trimmed until its first snapshot is gone. Its move snapshot is in
	// "recent", but the reactions made before the move are in "older". /purge of
	// cy found m1 as cy's only in "recent", so "older" kept the reactions on it
	// (the link now carries the messages a tier finds to the tiers below it).
	it("drops reactions below the tier that found a purged user's message", async () => {
		const built = build(compositions[1]);
		const real: Real = { clock: built.clock, head: built.head, chain: built.chain, faults: undefined, previous: undefined };
		const world: World = { model: new Model(), users: ["ada", "bob", "cy", "dee"], messages: [], step: 0, renamed: 0 };
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

	// Found by the model runs: a page read from a tier a /purge had yet to
	// reach held only the purged user's message, which the pending rewrite
	// then dropped: an empty page, taken for the end of history, so an older
	// message in the same tier stopped being served (HistoryChain.readPart
	// now reads on).
	it("reads on past records a pending rewrite drops, rather than ending history early", async () => {
		const clock = new TestClock();
		const head = new MemoryHead("hot", clock);
		const chain = new HistoryChain({ head, headRetention: { records: 2, thresholdPercent: 100 }, stages: [{ tier: new MemoryHistoryTier("recent"), retention: { thresholdPercent: 100 } }], state: new MemoryChainStateStore(), clock });
		const commit = (room: string, id: string, from: string) => {
			clock.time += 1;
			return head.commit(room, "message", { message_id: id, from: { user_id: from }, body: { text: id } });
		};
		const ada = commit("random", "m1", "ada");
		commit("random", "m2", "dee");
		for (const id of ["g1", "g2", "g3"]) commit("general", id, "ada");
		await settle(chain);
		// Both random messages left the head for recent.
		expect(head.all().some((record) => record.room_id === "random")).toBe(false);
		await head.purge(["dee"]);
		// Not delivered yet: recent still holds dee's message, and pages drop it.
		expect((await chain.view()).links[0].delivered).toBe(0);
		expect((await history(chain, "random", 1)).map((record) => record.log_id)).toEqual([ada.log_id]);
	});

	// A tier that takes no rewrites (the cold tier) keeps what it holds as it
	// was, and keeps the rewrites it is delivered: the log empties, the tiers
	// above lose the purged user's records, and every read of the cold tier
	// applies the kept rewrites, so nothing served names the purged user.
	it("keeps the rewrites a tier that takes none was delivered, and applies them on every read", async () => {
		const { clock, head, stages, chain, state } = build(compositions[2]);
		const model = new Model();
		for (let index = 0; index < 30; index += 1) {
			clock.time += 1;
			model.add(head.commit("general", "message", { message_id: `m${index}`, from: { user_id: index % 3 ? "ada" : "cy" }, body: { text: `${index}` } }));
		}
		await settle(chain);
		const coldTier = stages[1].tier as ColdHistoryTier;
		const recent = stages[0].tier as MemoryHistoryTier;
		const namesCy = async (each: { scan(from: number, limit: number): Promise<{ records: ChatRecord[] }> }) => (await each.scan(0, 1_000)).records.some((record) => record.record_json.includes('"cy"'));
		expect(await namesCy(coldTier)).toBe(true);
		expect(await namesCy(recent)).toBe(true);
		const kept = await unreached(chain);
		await head.purge(["cy"]);
		await settle(chain);
		expect(await namesCy(recent)).toBe(false);
		// Still in the cold tier's chunks, but kept as a rewrite and applied on every read.
		expect(await namesCy(coldTier)).toBe(true);
		expect(await head.rewrites.list()).toEqual([]);
		expect((await chain.view()).links.map((each) => each.delivered)).toEqual([1, 1]);
		expect((await state.kept("cold")).flatMap((group) => group.rewrites.map((rewrite) => rewrite.user))).toEqual(["cy"]);
		model.apply({ user: "cy", into: null }, { floor: await chain.publishedFloor(), kept });
		const served = await history(chain, "general", 3);
		expect(served.some((record) => record.record_json.includes('"cy"'))).toBe(false);
		expect(show(served)).toEqual(show(model.room("general", await chain.publishedFloor())));
		// A rename after it is kept too, after the purge, and follows a chain of renames.
		await head.rename("ada", "ada-2");
		await settle(chain);
		await head.rename("ada-2", "ada-3");
		await settle(chain);
		expect((await state.kept("cold")).flatMap((group) => group.rewrites.map((rewrite) => `${rewrite.user}>${rewrite.into}`))).toEqual(["cy>null", "ada>ada-2", "ada-2>ada-3"]);
		// Delivered while the cold tier held the same records: one group, not one a rewrite.
		expect(await state.kept("cold")).toHaveLength(1);
		const renamed = await history(chain, "general", 4);
		expect(renamed.some((record) => record.record_json.includes('"ada"') || record.record_json.includes('"ada-2"'))).toBe(false);
		expect(renamed.filter((record) => record.record_json.includes('"ada-3"')).length).toBe(20);
	});

	// Rewrites delivered while the cold tier holds the same records are kept
	// as one group: however many /purge and /rename it takes, its kept
	// rewrites stay few, delivery never stalls on their number, and reads
	// stay correct.
	it("keeps hundreds of purges and renames delivered to an unchanged cold tier as one group", async () => {
		const { clock, head, chain, state } = build(compositions[2]);
		for (let index = 0; index < 30; index += 1) {
			clock.time += 1;
			head.commit("general", "message", { message_id: `m${index}`, from: { user_id: index % 3 ? "ada" : "cy" }, body: { text: `${index}` } });
		}
		await settle(chain);
		const cold = (await chain.view()).tiers[2];
		expect(cold.floor).toBeGreaterThan(0);
		for (let index = 0; index < 600; index += 1) {
			if (index % 2) await head.purge([`gone${index}`]);
			else await head.rename(`old${index}`, `new${index}`);
			if (index % 100 === 99) await settle(chain);
		}
		await head.purge(["cy"]);
		await settle(chain);
		const kept = await state.kept("cold");
		expect(kept.flatMap((group) => group.rewrites)).toHaveLength(601);
		expect(kept).toHaveLength(1);
		expect(await head.rewrites.list()).toEqual([]);
		const served = await history(chain, "general", 5);
		expect(served.some((record) => record.record_json.includes('"cy"'))).toBe(false);
		expect(served.filter((record) => record.kind === "message")).toHaveLength(20);
	});

	// A kept rewrite reaches only what the cold tier held when it was
	// delivered: it is forgotten once the tier's floor passes that, and a
	// later user given the purged ID is not hidden by it.
	it("forgets a kept rewrite once the cold tier trims past what it held then", async () => {
		const { clock, head, chain, state } = build(compositions[3]);
		const post = (index: number, from: string) => {
			clock.time += 1;
			return head.commit("general", "message", { message_id: `m${index}`, from: { user_id: from }, body: { text: `${index}` } });
		};
		for (let index = 0; index < 20; index += 1) post(index, index % 2 ? "ada" : "cy");
		await settle(chain);
		await head.purge(["cy"]);
		await settle(chain);
		const [entry] = await state.kept("cold");
		expect(entry.rewrites.map((rewrite) => rewrite.user)).toEqual(["cy"]);
		// Enough later posts that the cold tier (30 records, by count) trims past the purge's reach.
		for (let index = 20; index < 120; index += 1) post(index, "ada");
		await settle(chain);
		expect((await chain.view()).tiers[2].floor).toBeGreaterThan(entry.through);
		expect(await state.kept("cold")).toEqual([]);
	});
});
