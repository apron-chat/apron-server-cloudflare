import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encryptingSink, resolveKeys } from "../../src/history/archive/crypto";
import { exportArchive } from "../../src/history/archive/export";
import { collectArchive, jsonlReader, jsonlWriter, linesOf } from "../../src/history/archive/format";
import { archiveReader, importArchive, place } from "../../src/history/archive/import";
import type { ArchivedUser } from "../../src/history/archive/types";
import { MemoryBlobStore } from "../../src/history/blob/memory";
import { MemorySegmentIndex } from "../../src/history/blob/segments";
import { BlobHistoryTier } from "../../src/history/blob/tier";
import { MemoryHead, MemoryHistoryTier } from "../../src/history/memory";
import { HistoryPipeline, type PipelineStage } from "../../src/history/pipeline";
import { compareRenderedState, renderedState } from "../../src/history/render";
import { MemoryTierStateStore } from "../../src/history/tier";
import { sceneArchives } from "../fixtures/archives";

class TestClock {
	constructor(public time = 1_000_000) {}
	now(): number { return this.time; }
}

type Composition = "head" | "head+recent" | "head+recent+cold";

function pipelineOf(composition: Composition, clock = new TestClock()) {
	const head = new MemoryHead("hot", clock);
	const stages: PipelineStage[] = [];
	if (composition !== "head") stages.push({ tier: new MemoryHistoryTier("recent"), retention: { records: 8, thresholdPercent: 100 } });
	if (composition === "head+recent+cold") {
		stages.push({ tier: new BlobHistoryTier({ name: "cold", store: new MemoryBlobStore(), index: new MemorySegmentIndex(), prefix: "history/test/", clock, segmentRecords: 5, compactRecords: false }), retention: { thresholdPercent: 100 } });
	}
	const pipeline = new HistoryPipeline({ head, headRetention: { records: 6, thresholdPercent: 100 }, stages, state: new MemoryTierStateStore(), clock, batch: 4 });
	return { head, pipeline, clock };
}

async function settle(pipeline: HistoryPipeline): Promise<void> {
	for (let count = 0; count < 500; count += 1) if (!(await pipeline.cycle({ steps: 50 })).more) return;
	throw new Error("did not settle");
}

/** A small server's life: two rooms, edits, a delete, reactions, a move, memberships, a thread. */
function populate(head: MemoryHead, clock: TestClock): void {
	head.people.set("ada", { user_id: "ada", name: "Ada" });
	head.people.set("bob", { user_id: "bob", name: "Bob" });
	const tick = () => { clock.time += 7; };
	const room = (id: string, title: string) => { tick(); head.commit(id, "room", { title }); };
	room("general", "General");
	room("random", "Random");
	const messages: string[] = [];
	for (let index = 0; index < 18; index += 1) {
		tick();
		const roomId = index % 3 ? "general" : "random";
		const record = head.commit(roomId, "message", { message_id: "", from: { user_id: index % 2 ? "ada" : "bob", name: "x" }, body: { format: "plain", text: `hello ${index}` } });
		// A message's ID is its creation log ID.
		const json = JSON.parse(record.record_json) as Record<string, unknown>;
		json.message_id = String(record.log_id);
		head.records.set(`${record.log_id}\u0000${roomId}`, { ...record, record_json: JSON.stringify(json) });
		messages.push(String(record.log_id));
	}
	tick();
	head.commit("general", "message", { message_id: messages[1], from: { user_id: "ada" }, body: { format: "plain", text: "edited" }, prev_log_id: messages[1] });
	tick();
	head.commit("general", "message", { message_id: messages[2], from: { user_id: "bob" }, deleted: true, prev_log_id: messages[2] });
	tick();
	head.commit("random", "reactions", { message_id: messages[0], reactions: [{ from: { user_id: "ada" }, emojis: ["👍"] }] });
	tick();
	head.commit("general", "membership", { members: [{ user: { user_id: "ada" }, joined: true }, { user: { user_id: "bob" }, joined: true }] });
	tick();
	head.commit("random", "message", { message_id: messages[4], from: { user_id: "bob" }, body: { format: "plain", text: "moved" }, prev_room_id: "general", prev_log_id: messages[4] }, { alsoIn: "general" });
	tick();
	head.commit("general", "membership", { members: [{ user: { user_id: "bob" }, joined: false }] });
}

async function exported(pipeline: HistoryPipeline, clock: TestClock, options: { compact?: boolean; server?: string } = {}): Promise<string> {
	const lines: string[] = [];
	await exportArchive(pipeline, jsonlWriter(async (line) => { lines.push(line); }), { clock, compact: options.compact, header: { server: options.server ?? "source.test" } });
	return lines.join("");
}

async function stateOf(text: string) {
	const archive = await collectArchive(jsonlReader(linesOf(text)));
	return renderedState(archive.records, archive.rooms, archive.users);
}

describe("export and import", () => {
	for (const from of ["head", "head+recent", "head+recent+cold"] as const) {
		for (const to of ["head", "head+recent+cold"] as const) {
			it(`round-trips ${from} → ${to}, rendered state equal`, async () => {
				const source = pipelineOf(from);
				populate(source.head, source.clock);
				await settle(source.pipeline);
				const first = await exported(source.pipeline, source.clock);
				const target = pipelineOf(to, new TestClock(5_000_000));
				const report = await importArchive(target.pipeline, jsonlReader(linesOf(first)), { clock: target.clock, server: "target.test" });
				expect(report.roomsAdded.sort()).toEqual(["general", "random"]);
				expect(report.expired).toBe(0);
				// With a tier that keeps everything, upkeep loses nothing; SQLite alone would expire by its count.
				if (to === "head+recent+cold") await settle(target.pipeline);
				const second = await exported(target.pipeline, target.clock);
				const comparison = compareRenderedState(await stateOf(first), await stateOf(second));
				expect(comparison.differences).toEqual([]);
			});
		}
	}

	it("keeps rendered state through compaction", async () => {
		const source = pipelineOf("head+recent");
		populate(source.head, source.clock);
		await settle(source.pipeline);
		const plain = await exported(source.pipeline, source.clock);
		const compacted = await exported(source.pipeline, source.clock, { compact: true });
		expect(compacted.length).toBeLessThan(plain.length);
		expect(compareRenderedState(await stateOf(plain), await stateOf(compacted)).differences).toEqual([]);
	});

	it("adds nothing when the same archive is imported again", async () => {
		const source = pipelineOf("head");
		populate(source.head, source.clock);
		const text = await exported(source.pipeline, source.clock);
		const target = pipelineOf("head+recent", new TestClock(5_000_000));
		const first = await importArchive(target.pipeline, jsonlReader(linesOf(text)), { clock: target.clock });
		expect(first.records).toBeGreaterThan(0);
		const again = await importArchive(target.pipeline, jsonlReader(linesOf(text)), { clock: target.clock });
		expect(again).toMatchObject({ roomsAdded: [], records: 0 });
		expect(again.roomsSkipped.sort()).toEqual(["general", "random"]);
	});

	it("skips a move's duplicate in a room that exists, and nudges records whose log IDs another record holds", async () => {
		const source = pipelineOf("head");
		populate(source.head, source.clock);
		const text = await exported(source.pipeline, source.clock);
		// The same clock: the target's own records sit on the same log IDs.
		const target = pipelineOf("head");
		for (let index = 0; index < 30; index += 1) {
			target.clock.time += 7;
			target.head.commit("lobby", "message", { message_id: `own-${index}`, from: { user_id: "zed" }, body: { text: "mine" } });
		}
		const report = await importArchive(target.pipeline, jsonlReader(linesOf(text)), { clock: target.clock });
		expect(Object.keys(report.remapped.logIds).length).toBeGreaterThan(0);
		// Nudged IDs are free, and in the same order.
		const moved = Object.entries(report.remapped.logIds).map(([from, to]) => [Number(from), Number(to)]);
		for (const [from, to] of moved) expect(to).toBeGreaterThan(from);
		const lobby = target.head.all().filter((record) => record.room_id === "lobby");
		expect(lobby.length).toBe(30);
		// Through the map, what was exported is what is here.
		const back = await exported(target.pipeline, target.clock);
		const backState = await stateOf(back);
		backState.rooms.delete("lobby");
		for (const [id, message] of [...backState.messages]) if (message.room_id === "lobby") backState.messages.delete(id);
		backState.members.delete("lobby");
		backState.users.delete("zed");
		const comparison = compareRenderedState(await stateOf(text), backState, { idMap: { logId: (id) => report.remapped.logIds[id] ?? id } });
		expect(comparison.differences).toEqual([]);
	});

	it("maps users: a foreign archive's to new placeholders, one's own to the accounts that exist", async () => {
		const source = pipelineOf("head");
		populate(source.head, source.clock);
		const text = await exported(source.pipeline, source.clock, { server: "here.test" });
		const target = pipelineOf("head", new TestClock(5_000_000));
		target.head.people.set("ada", { user_id: "ada", name: "Our Ada" });
		target.head.retired.add("bob");
		const foreign = await importArchive(target.pipeline, jsonlReader(linesOf(text)), { clock: target.clock, server: "elsewhere.test", dryRun: true });
		expect(foreign.users).toEqual({ ada: { placeholder: "ada-2" }, bob: { placeholder: "bob-2" } });
		expect(foreign.dryRun).toBe(true);
		expect(target.head.all()).toEqual([]);
		const own = await importArchive(target.pipeline, jsonlReader(linesOf(text)), { clock: target.clock, server: "here.test", dryRun: true });
		expect(own.users).toEqual({ ada: { matched: "ada" }, bob: { placeholder: "bob-2" } });
		const chosen = await importArchive(target.pipeline, jsonlReader(linesOf(text)), { clock: target.clock, userMap: { bob: { placeholder: "robert" }, ada: { existing: "ada" } } });
		expect(chosen.users).toEqual({ ada: { matched: "ada" }, bob: { placeholder: "robert" } });
		// Placeholders carry the unclaimed role, not the archive's roles.
		expect(target.head.people.get("robert")?.roles).toEqual(["unclaimed"]);
		expect(target.head.all().some((record) => record.record_json.includes('"user_id":"robert"'))).toBe(true);
		expect(target.head.all().some((record) => record.record_json.includes('"user_id":"bob"'))).toBe(false);
	});

	it("drops records older than the published floor, and places the rest in the tier that serves them", async () => {
		const tiers = [{ state: { floor: 100, target: 100, through: 120, ops: 0 } }, { state: { floor: 50, target: 50, through: 70, ops: 0 } }, { state: { floor: 20, target: 20, through: 0, ops: 0 } }];
		expect(place(10, tiers, 20)).toEqual([]);
		expect(place(30, tiers, 20)).toEqual([2]);
		expect(place(60, tiers, 20)).toEqual([1, 2]);
		expect(place(80, tiers, 20)).toEqual([1]);
		// At or below the head's copy marker: the tier below holds it, as it will once the head lets it go.
		expect(place(110, tiers, 20)).toEqual([1]);
		expect(place(130, tiers, 20)).toEqual([0]);
	});

	it("imports every scene from scene.apron.chat to the scene's own rendered state", async () => {
		for (const [name, text] of Object.entries(sceneArchives)) {
			const target = pipelineOf("head+recent+cold", new TestClock(1));
			const report = await importArchive(target.pipeline, jsonlReader(linesOf(text)), { clock: target.clock });
			expect(report.expired, name).toBe(0);
			await settle(target.pipeline);
			const back = await exported(target.pipeline, target.clock);
			const scene = await collectArchive(jsonlReader(linesOf(text)));
			const comparison = compareRenderedState(renderedState(scene.records, scene.rooms, scene.users), await stateOf(back));
			// Users carry over by name; rooms and messages exactly.
			expect(comparison.differences.filter((line) => !line.startsWith("user ")), name).toEqual([]);
		}
	});

	it("reads an encrypted backup with the key the environment has, and names the key it lacks", async () => {
		const source = pipelineOf("head");
		populate(source.head, source.clock);
		const keys = resolveKeys(env, ["HISTORY_BACKUP_KEY", "HISTORY_BACKUP_KEY_OLD"]);
		const key = (await keys.lookup("HISTORY_BACKUP_KEY"))!;
		const lines: string[] = [];
		const sink = encryptingSink(async (line) => { lines.push(line); }, { ...key, name: "HISTORY_BACKUP_KEY", chunkBytes: 512 });
		await exportArchive(source.pipeline, jsonlWriter(sink), { clock: source.clock, header: { server: "source.test" } });
		await sink.close();
		// The encrypting sink hands on lines without their newline.
		const encrypted = lines.map((line) => line.endsWith("\n") ? line : `${line}\n`).join("");
		expect(encrypted).not.toContain("hello");
		const target = pipelineOf("head", new TestClock(5_000_000));
		const report = await importArchive(target.pipeline, archiveReader(linesOf(encrypted), keys), { clock: target.clock });
		expect(report.roomsAdded.sort()).toEqual(["general", "random"]);
		const plain = await exported(source.pipeline, source.clock);
		expect(compareRenderedState(await stateOf(plain), await stateOf(await exported(target.pipeline, target.clock))).differences).toEqual([]);
		const keyless = pipelineOf("head", new TestClock(5_000_000));
		await expect(importArchive(keyless.pipeline, archiveReader(linesOf(encrypted)), { clock: keyless.clock })).rejects.toThrow(/needs HISTORY_BACKUP_KEY/);
		expect(keyless.head.all()).toEqual([]);
	});

	it("renumbers at the head when asked", async () => {
		const source = pipelineOf("head");
		populate(source.head, source.clock);
		const text = await exported(source.pipeline, source.clock);
		const target = pipelineOf("head+recent", new TestClock(9_000_000));
		target.head.commit("lobby", "message", { message_id: "x", from: { user_id: "zed" } });
		const report = await importArchive(target.pipeline, jsonlReader(linesOf(text)), { clock: target.clock, ids: "renumber" });
		const ids = Object.values(report.remapped.logIds).map(Number);
		expect(Math.min(...ids)).toBeGreaterThan(9_000_000);
		expect(report.placed).toEqual({ hot: report.records });
	});

	it("does not import the archive's roles", async () => {
		const source = pipelineOf("head");
		populate(source.head, source.clock);
		source.head.people.set("ada", { user_id: "ada", name: "Ada", roles: ["admin"] } as ArchivedUser);
		const text = await exported(source.pipeline, source.clock);
		expect(text).toContain('"admin"');
		const target = pipelineOf("head", new TestClock(5_000_000));
		await importArchive(target.pipeline, jsonlReader(linesOf(text)), { clock: target.clock });
		expect(target.head.people.get("ada")?.roles).toEqual(["unclaimed"]);
	});
});
