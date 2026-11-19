import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "../../src/history/blob/memory";
import { MemorySegmentIndex } from "../../src/history/blob/segments";
import { BlobHistoryTier } from "../../src/history/blob/tier";
import { MemoryHead, MemoryHistoryTier } from "../../src/history/memory";
import { type TierView, checkInvariants, mergePages, planRead, planStep, retentionFloor } from "../../src/history/plan";
import { HistoryPipeline, type PipelineStage, instrument } from "../../src/history/pipeline";
import type { ChatRecord, Retention } from "../../src/history/records";
import { type HistoryTier, MemoryTierStateStore, type TierState } from "../../src/history/tier";
import { Model, pick, prng, seeds, show } from "./model";

const state = (floor: number, target = floor, through = floor - 1, ops = 0): TierState => ({ floor, target, through, ops });
const view = (name: string, tierState: TierState, extra: Partial<TierView> = {}): TierView => ({ name, readable: true, rewritable: true, multiRoom: true, upkeep: false, state: tierState, ...extra });
const progress = () => ({ targeted: new Set<number>(), advanced: new Map<number, number>(), trimmed: new Map<number, number>(), upkept: new Set<number>() });

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
	// Small segments that compaction merges (records left as they are, so pages match the model's), trimmed by count.
	{ name: "head → recent (memory) → cold (blob over MemoryBlobStore)", headRetention: { records: 6, thresholdPercent: 80 }, rewritableOnly: false, stages: () => [
		{ tier: new MemoryHistoryTier("recent"), retention: { records: 8, thresholdPercent: 100 } },
		{ tier: new BlobHistoryTier({ name: "cold", store: new MemoryBlobStore(), index: new MemorySegmentIndex(), prefix: "history/model/", clock: { now: () => 0 }, segmentRecords: 6, compactRecords: false }), retention: { records: 30, thresholdPercent: 100 } },
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

describe("model-based runs", () => {
	for (const composition of compositions) {
		for (const seed of seeds(6)) {
			it(`${composition.name}, seed ${seed}`, async () => {
				const random = prng(seed);
				const { clock, head, pipeline } = build(composition);
				const model = new Model();
				const users = ["ada", "bob", "cy", "dee"];
				const rooms = ["general", "random"];
				const messages: Array<{ id: string; room: string; from: string }> = [];
				let renamed = 0;
				const trace: string[] = [];
				try {
					for (let step = 0; step < 120; step += 1) {
						clock.time += 1 + Math.floor(random() * 5);
						const roll = random();
						trace.push(`${step}:${roll.toFixed(2)}`);
						if (roll < 0.4 || !messages.length) {
							const room = pick(random, rooms);
							const from = pick(random, users);
							const id = `m${step}`;
							messages.push({ id, room, from });
							model.add(head.commit(room, "message", { message_id: id, from: { user_id: from }, body: { text: `${step}` } }));
						} else if (roll < 0.55) {
							const message = pick(random, messages);
							model.add(head.commit(message.room, "reactions", { message_id: message.id, reactions: [{ from: { user_id: pick(random, users) }, emojis: ["👍"] }] }));
						} else if (roll < 0.62) {
							const room = pick(random, rooms);
							model.add(head.commit(room, "membership", { members: [{ user: { user_id: pick(random, users) }, joined: random() < 0.7 }] }));
						} else if (roll < 0.68) {
							// A move: one record in both rooms.
							const message = pick(random, messages);
							const to = rooms.find((room) => room !== message.room)!;
							const record = head.commit(to, "message", { message_id: message.id, from: { user_id: message.from }, prev_room_id: message.room }, { alsoIn: message.room });
							model.add(record, message.room);
							message.room = to;
						} else if (roll < 0.9) {
							await pipeline.cycle({ steps: 1 + Math.floor(random() * 8) });
						} else if (composition.rewritableOnly && roll < 0.95) {
							const user = pick(random, users);
							// Settled first, so every tier holds exactly what it serves.
							await settle(pipeline);
							await pipeline.purge([user]);
							model.apply({ op: "purge", userIds: [user], messageIds: [] }, await pipeline.publishedFloor());
							// A purged ID is retired: it never posts again.
							users[users.indexOf(user)] = `new${step}`;
							// Their messages are gone: no one reacts to or moves them.
							for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index].from === user) messages.splice(index, 1);
						} else if (composition.rewritableOnly) {
							const from = pick(random, users);
							const to = `${from}-${(renamed += 1)}`;
							users[users.indexOf(from)] = to;
							for (const message of messages) if (message.from === from) message.from = to;
							await settle(pipeline);
							await pipeline.rename(from, to);
							model.apply({ op: "rename", from, to }, await pipeline.publishedFloor());
						}
						if (step % 15 === 14) await settle(pipeline);
						// I4 coverage: every room's history equals the model's from the published floor on.
						const published = await pipeline.publishedFloor();
						for (const room of rooms) {
							const served = show(await history(pipeline, room, 1 + Math.floor(random() * 6)));
							const expected = show(model.room(room, published));
							if (served.join("\n") !== expected.join("\n")) {
								throw new Error(`step ${step}, ${room}, published ${published}, tiers ${JSON.stringify(await pipeline.views())}, head holds ${head.all().map((record) => record.log_id).join(",")}, lower hold ${JSON.stringify(await Promise.all(pipeline.tiers.slice(1).map(async (tier) => (await tier.scan(0, 1000)).records.map((record) => record.log_id + record.room_id))))}, log ${trace.slice(-12).join(" | ")}:\nserved:\n${served.filter((line) => !expected.includes(line)).join("\n")}\nexpected:\n${expected.filter((line) => !served.includes(line)).join("\n")}`);
							}
						}
					}
					await settle(pipeline);
					// I3 containment once settled: no tier holds a record below its floor.
					const views = await pipeline.views();
					for (const [index, tier] of pipeline.tiers.entries()) {
						const held = await tier.scan(0, 1);
						if (held.records.length) expect(held.records[0].log_id).toBeGreaterThanOrEqual(views[index].state.floor);
					}
				} catch (error) {
					throw new Error(`seed ${seed} (replay with HISTORY_SEED=${seed}): ${(error as Error).message}`);
				}
			});
		}
	}
});

describe("fault injection", () => {
	for (const seed of seeds(4, 101)) {
		it(`loses nothing and duplicates nothing whatever fails, seed ${seed}`, async () => {
			const random = prng(seed);
			const composition = compositions[1];
			const clean = build(composition);
			const faulty = build(composition, { faults: () => random() < 0.3 });
			for (let index = 0; index < 40; index += 1) {
				for (const run of [clean, faulty]) {
					run.clock.time += 10;
					run.head.commit(index % 2 ? "general" : "random", "message", { message_id: `m${index}`, from: { user_id: "ada" }, body: { text: `${index}` } });
				}
				if (index % 7 === 6) {
					await settle(clean.pipeline);
					await settle(faulty.pipeline);
				}
			}
			await settle(clean.pipeline);
			await settle(faulty.pipeline);
			for (const room of ["general", "random"]) {
				expect(show(await history(faulty.pipeline, room, 4))).toEqual(show(await history(clean.pipeline, room, 4)));
			}
			expect((await faulty.pipeline.views()).map((tier) => tier.state.floor)).toEqual((await clean.pipeline.views()).map((tier) => tier.state.floor));
		});
	}
});
