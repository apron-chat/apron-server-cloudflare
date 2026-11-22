import { describe, expect, it } from "vitest";
import { exportArchive } from "../../src/history/archive/export";
import { type ArchivedUser, collectArchive, compareReplayed, gzip, jsonlReader, jsonlWriter, linesOf, replayRecords, writeArchiveToString } from "@apron/archive";
import { importArchive, place, restoreBatches } from "../../src/history/archive/import";
import { MemoryBlobStore } from "./support/memory-blob-store";
import { type BackupSettings, BackupStore, backupFamily, writeBackup } from "../../src/history/exports";
import { CODECS_METADATA } from "../../src/history/storage/encoding";
import { MemoryChunkIndex } from "./support/memory-chunk-index";
import { ColdHistoryTier } from "../../src/history/cold/tier";
import { HISTORY_CODECS } from "../../src/history/config";
import { NOT_STALLED } from "../../src/history/stall";
import { withoutOutputs } from "../../src/history/records";
import { MemoryChainStateStore, MemoryHead, MemoryHistoryTier } from "./support/memory-tiers";
import { type ChainStage, HistoryChain } from "../../src/history/chain";

class TestClock {
	constructor(public time = 1_000_000) {}
	now(): number { return this.time; }
}

type Composition = "head" | "head+recent" | "head+recent+cold";

function chainOf(composition: Composition, clock = new TestClock()) {
	const head = new MemoryHead("hot", clock);
	const stages: ChainStage[] = [];
	if (composition !== "head") stages.push({ tier: new MemoryHistoryTier("recent"), retention: { records: 8, thresholdPercent: 100 } });
	if (composition === "head+recent+cold") {
		stages.push({ tier: new ColdHistoryTier({ name: "cold", store: new MemoryBlobStore(), index: new MemoryChunkIndex(), codecs: HISTORY_CODECS, prefix: "history/test/", clock, chunkLogIds: 4 }), retention: { thresholdPercent: 100 } });
	}
	const chain = new HistoryChain({ head, headRetention: { records: 6, thresholdPercent: 100 }, stages, state: new MemoryChainStateStore(), clock, batch: 4 });
	return { head, chain, clock };
}

async function settle(chain: HistoryChain): Promise<void> {
	for (let count = 0; count < 500; count += 1) if (!(await chain.cycle({ steps: 50 })).more) return;
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

async function exported(chain: HistoryChain, clock: TestClock, options: { server?: string } = {}): Promise<string> {
	const lines: string[] = [];
	await exportArchive(chain, chain.head as MemoryHead, jsonlWriter(async (line) => { lines.push(line); }), { clock, header: { server: options.server ?? "source.test" }, prepare: withoutOutputs });
	return lines.join("");
}

async function stateOf(text: string) {
	const archive = await collectArchive(jsonlReader(linesOf(text)));
	return replayRecords(archive.records, archive.rooms, archive.users);
}

describe("export and import", () => {
	for (const from of ["head", "head+recent", "head+recent+cold"] as const) {
		for (const to of ["head", "head+recent+cold"] as const) {
			it(`round-trips ${from} → ${to}, replayed state equal`, async () => {
				const source = chainOf(from);
				populate(source.head, source.clock);
				await settle(source.chain);
				const first = await exported(source.chain, source.clock);
				const target = chainOf(to, new TestClock(5_000_000));
				const report = await importArchive(target.chain, target.head, jsonlReader(linesOf(first)), { clock: target.clock, server: "target.test" });
				expect(report.roomsAdded.sort()).toEqual(["general", "random"]);
				expect(report.expired).toBe(0);
				// With a tier that keeps everything, upkeep loses nothing; SQLite alone would expire by its count.
				if (to === "head+recent+cold") await settle(target.chain);
				const second = await exported(target.chain, target.clock);
				const comparison = compareReplayed(await stateOf(first), await stateOf(second));
				expect(comparison.differences).toEqual([]);
			});
		}
	}

	// The cold tier keeps what it holds, but a /purge or /rename it was
	// delivered goes with every export of it: a backup restored brings back
	// neither the purged user nor a renamed user's old ID.
	it("exports none of a purged user's records and only renamed users' new IDs, though the cold tier still holds them", async () => {
		const source = chainOf("head+recent+cold");
		populate(source.head, source.clock);
		for (let index = 0; index < 12; index += 1) {
			source.clock.time += 7;
			source.head.commit("general", "message", { message_id: `later-${index}`, from: { user_id: "ada" }, body: { format: "plain", text: `later ${index}` } });
		}
		await settle(source.chain);
		const cold = source.chain.tiers[2];
		const held = (await cold.scan(0, 1_000)).records;
		const coldText = JSON.stringify(held);
		expect(held.some((record) => record.record_json.includes('"user_id":"bob"'))).toBe(true);
		await source.head.purge(["bob"]);
		await source.head.rename("ada", "ada-2");
		await settle(source.chain);
		await source.head.rename("ada-2", "ada-3");
		await settle(source.chain);
		// Still held as it was.
		expect(JSON.stringify((await cold.scan(0, 1_000)).records)).toBe(coldText);
		const text = await exported(source.chain, source.clock);
		const archive = await collectArchive(jsonlReader(linesOf(text)));
		const named = new Set(archive.records.flatMap((record) => [...record.record_json.matchAll(/"user_id":"([^"]+)"/g)].map((match) => match[1])));
		expect(named.has("bob")).toBe(false);
		expect(named.has("ada")).toBe(false);
		expect(named.has("ada-2")).toBe(false);
		expect(named.has("ada-3")).toBe(true);
		expect(archive.users.map((user) => user.user_id)).not.toContain("bob");
		// No reaction set is left on a message of bob's, whichever tier holds it.
		const bobs = new Set(held.filter((record) => record.kind === "message" && record.record_json.includes('"user_id":"bob"')).map((record) => (JSON.parse(record.record_json) as { message_id: string }).message_id));
		expect(bobs.size).toBeGreaterThan(0);
		for (const record of archive.records) {
			if (record.kind === "reactions") expect(bobs.has((JSON.parse(record.record_json) as { message_id: string }).message_id)).toBe(false);
		}
		// Imported, it makes no account for bob or the old IDs.
		const target = chainOf("head+recent+cold", new TestClock(5_000_000));
		const report = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock });
		expect(Object.keys(report.users).sort()).toEqual(["ada-3"]);
	});

	it("adds nothing when the same archive is imported again", async () => {
		const source = chainOf("head");
		populate(source.head, source.clock);
		const text = await exported(source.chain, source.clock);
		const target = chainOf("head+recent", new TestClock(5_000_000));
		const first = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock });
		expect(first.records).toBeGreaterThan(0);
		const again = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock });
		expect(again).toMatchObject({ roomsAdded: [], records: 0 });
		expect(again.roomsSkipped.sort()).toEqual(["general", "random"]);
	});

	it("skips a move's duplicate in a room that exists, and nudges records whose log IDs another record holds", async () => {
		const source = chainOf("head");
		populate(source.head, source.clock);
		const text = await exported(source.chain, source.clock);
		// The same clock: the target's own records sit on the same log IDs.
		const target = chainOf("head");
		for (let index = 0; index < 30; index += 1) {
			target.clock.time += 7;
			target.head.commit("lobby", "message", { message_id: `own-${index}`, from: { user_id: "zed" }, body: { text: "mine" } });
		}
		const report = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock });
		expect(Object.keys(report.remapped.logIds).length).toBeGreaterThan(0);
		// Nudged IDs are free, and in the same order.
		const moved = Object.entries(report.remapped.logIds).map(([from, to]) => [Number(from), Number(to)]);
		for (const [from, to] of moved) expect(to).toBeGreaterThan(from);
		const lobby = target.head.all().filter((record) => record.room_id === "lobby");
		expect(lobby.length).toBe(30);
		// Through the map, what was exported is what is here.
		const back = await exported(target.chain, target.clock);
		const backState = await stateOf(back);
		backState.rooms.delete("lobby");
		for (const [id, message] of [...backState.messages]) if (message.room_id === "lobby") backState.messages.delete(id);
		backState.members.delete("lobby");
		backState.users.delete("zed");
		const comparison = compareReplayed(await stateOf(text), backState, { idMap: { logId: (id) => report.remapped.logIds[id] ?? id } });
		expect(comparison.differences).toEqual([]);
	});

	it("maps users: a foreign archive's to new placeholders, one's own to the accounts that exist, never with the archive's roles", async () => {
		const source = chainOf("head");
		populate(source.head, source.clock);
		source.head.people.set("bob", { user_id: "bob", name: "Bob", roles: ["admin"] } as ArchivedUser);
		const text = await exported(source.chain, source.clock, { server: "here.test" });
		expect(text).toContain('"admin"');
		const target = chainOf("head", new TestClock(5_000_000));
		target.head.people.set("ada", { user_id: "ada", name: "Our Ada" });
		target.head.retired.add("bob");
		const foreign = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, server: "elsewhere.test", dryRun: true });
		expect(foreign.users).toEqual({ ada: { placeholder: "ada-2" }, bob: { placeholder: "bob-2" } });
		expect(foreign.dryRun).toBe(true);
		expect(target.head.all()).toEqual([]);
		// Matched only when the archive is authenticated (verified by an authenticating codec).
		const own = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, server: "here.test", dryRun: true, provenance: "verified" });
		expect(own.users).toEqual({ ada: { matched: "ada" }, bob: { placeholder: "bob-2" } });
		const chosen = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, userMap: { bob: { placeholder: "robert" }, ada: { existing: "ada" } } });
		expect(chosen.users).toEqual({ ada: { matched: "ada" }, bob: { placeholder: "robert" } });
		// Placeholders carry the unclaimed role, never the archive's roles (bob's admin).
		expect(target.head.people.get("robert")?.roles).toEqual(["unclaimed"]);
		expect(target.head.all().some((record) => record.record_json.includes('"user_id":"robert"'))).toBe(true);
		expect(target.head.all().some((record) => record.record_json.includes('"user_id":"bob"'))).toBe(false);
	});

	it("drops records older than the published floor, and places the rest in the tier that serves them", async () => {
		const tiers = { tiers: [{ floor: 100, target: 100 }, { floor: 50, target: 50 }, { floor: 20, target: 20 }].map((tier, index) => ({ ...tier, name: `t${index}`, rewrites: true })), links: [{ through: 120, delivered: 0, stall: NOT_STALLED }, { through: 70, delivered: 0, stall: NOT_STALLED }] };
		expect(place(10, tiers, 20)).toEqual([]);
		expect(place(30, tiers, 20)).toEqual([2]);
		expect(place(60, tiers, 20)).toEqual([1, 2]);
		expect(place(80, tiers, 20)).toEqual([1]);
		// At or below the head's copy marker: the tier below holds it, as it will once the head lets it go.
		expect(place(110, tiers, 20)).toEqual([1]);
		expect(place(130, tiers, 20)).toEqual([0]);
	});

	it("reads a gzip backup back through the codecs its metadata records, which verify nothing", async () => {
		const source = chainOf("head");
		populate(source.head, source.clock);
		const store = new MemoryBlobStore();
		const { key } = await writeBackup(source.chain, source.head, new BackupStore(store, HISTORY_CODECS), { keep: 14, privateRooms: true }, "manual", { server: "srv", clock: { now: () => Date.UTC(2026, 10, 19, 12) }, prepare: withoutOutputs });
		expect(key).toBe("backups/srv-manual-20261119-120000.jsonl.gz");
		expect(store.contentType(key)).toBe("application/octet-stream");
		const object = (await store.get(key))!;
		expect(object.metadata).toEqual({ [CODECS_METADATA]: "gzip" });
		const bytes = new Uint8Array(await new Response(await object.stream()).arrayBuffer());
		// gzip's magic number: compressed, not plain JSON Lines.
		expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
		const opened = (await new BackupStore(store, HISTORY_CODECS).open(key, 1_000_000))!;
		expect(opened.provenance).toBe("unverified");
		const target = chainOf("head", new TestClock(5_000_000));
		const report = await importArchive(target.chain, target.head, opened.archive, { clock: target.clock, provenance: opened.provenance });
		expect(report.roomsAdded.sort()).toEqual(["general", "random"]);
		const plain = await exported(source.chain, source.clock);
		expect(compareReplayed(await stateOf(plain), await stateOf(await exported(target.chain, target.clock))).differences).toEqual([]);
	});

	it("restores in calls bounded by records and by reaction sets and members, a large record alone", () => {
		const record = (logId: number, entries: number) => ({ room_id: "r", log_id: logId, commit_ms: logId, kind: "reactions", record_json: JSON.stringify({ message_id: "m", reactions: Array.from({ length: entries }, (_, index) => ({ from: { user_id: `u${index}` }, emojis: ["x"] })) }) });
		const batches = restoreBatches([record(1, 400), record(2, 400), record(3, 400), record(4, 5_000), record(5, 1)], { records: 200, entries: 1_000 });
		expect(batches.map((batch) => batch.map((entry) => entry.log_id))).toEqual([[1, 2], [3], [4], [5]]);
	});

	it("fills a room that holds nothing past its creation, and keeps a move out of the room it left when the room it went to is skipped", async () => {
		const source = chainOf("head");
		populate(source.head, source.clock);
		const text = await exported(source.chain, source.clock);
		const target = chainOf("head", new TestClock(5_000_000));
		// `general` exists, empty, as on a new server; `random`, where a message moved to, holds this server's own.
		target.head.rooms_.set("general", { listing: { room_id: "general" }, joined: false });
		target.head.commit("random", "message", { message_id: "own", from: { user_id: "zed" } });
		const report = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock });
		expect(report.roomsAdded).toEqual(["general"]);
		expect(report.roomsSkipped).toEqual(["random"]);
		const state = await stateOf(await exported(target.chain, target.clock));
		const moved = [...state.messages.values()].find((message) => message.body && JSON.stringify(message.body).includes("moved"));
		// Its last snapshot in general says it is in random now: general does not show it.
		expect(moved?.room_id).toBe("random");
	});

	it("keeps the newest backups of each kind, pruning only that kind's, and refuses a second of a kind within a second", async () => {
		const settings: BackupSettings = { keep: 2, privateRooms: true };
		const family = backupFamily("scheduled", "srv");
		expect(family.pattern.test("backups/srv-scheduled-20261119-120000.jsonl.gz")).toBe(true);
		expect(family.pattern.test("backups/srv-scheduled-20261119-120000.jsonl")).toBe(true);
		expect(family.pattern.test("backups/srv-manual-20261119-120000.jsonl")).toBe(false);
		expect(family.pattern.test("backups/srv-scheduled-20261119-120000.jsonl.bak")).toBe(false);
		expect(backupFamily("scheduled", "a.b").pattern.test("backups/axb-scheduled-20261119-120000.jsonl")).toBe(false);
		const store = new MemoryBlobStore();
		await store.put("backups/notes.txt", "keep me");
		await store.put("backups/other-scheduled-20261101-000000.jsonl", "another server's");
		const source = chainOf("head");
		populate(source.head, source.clock);
		for (let day = 0; day < 3; day += 1) {
			for (const kind of ["scheduled", "manual"] as const) await writeBackup(source.chain, source.head, new BackupStore(store, HISTORY_CODECS), settings, kind, { server: "srv", clock: { now: () => Date.UTC(2026, 10, 19 + day) }, prepare: withoutOutputs });
		}
		// A second one of a kind within the same second is refused; a second on, it is written.
		const backup = (at: number) => writeBackup(source.chain, source.head, new BackupStore(store, HISTORY_CODECS), settings, "manual", { server: "srv", clock: { now: () => at }, prepare: withoutOutputs });
		await expect(backup(Date.UTC(2026, 10, 21) + 500)).rejects.toThrow(/exists already/);
		await backup(Date.UTC(2026, 10, 21, 0, 0, 1));
		const keys = (await store.list("backups/")).keys.map((entry) => entry.key);
		expect(keys).toEqual([
			"backups/notes.txt",
			"backups/other-scheduled-20261101-000000.jsonl",
			"backups/srv-manual-20261121-000000.jsonl.gz", "backups/srv-manual-20261121-000001.jsonl.gz",
			"backups/srv-scheduled-20261120-000000.jsonl.gz", "backups/srv-scheduled-20261121-000000.jsonl.gz",
		]);
	});

	it("imports a room's stretch only: records of unlisted rooms or below history_log_id are references; output_ref is dropped", async () => {
		const message = (room: string, logId: number, extra: Record<string, unknown> = {}) => JSON.stringify({ message_id: String(logId), log_id: String(logId), room_id: room, from: { user_id: "ada" }, body: { text: `m${logId}`, ...extra } });
		const text = await writeArchiveToString(async (writer) => {
			await writer.header({ apron_archive: 1, server: "wss://elsewhere.test/" });
			await writer.listing({ not_joined: [{ room_id: "lobby", log_id: "100", history_log_id: "100", latest_log_id: "150" }] });
			await writer.records([
				{ room_id: "lobby", log_id: 50, commit_ms: 50, kind: "message", record_json: message("lobby", 50) },
				{ room_id: "lobby", log_id: 150, commit_ms: 150, kind: "message", record_json: message("lobby", 150, { embeds: [{ kind: "terminal", output_ref: { key: "f/AAAAAAAAAAAAAAAAAAAAAA", bytes: 3 } }] }) },
				{ room_id: "elsewhere", log_id: 120, commit_ms: 120, kind: "message", record_json: message("elsewhere", 120) },
			]);
		});
		const target = chainOf("head", new TestClock(1));
		const report = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock });
		expect(report).toMatchObject({ roomsAdded: ["lobby"], records: 1, references: 2 });
		const stored = target.head.all().filter((record) => record.kind === "message");
		expect(stored.map((record) => record.log_id)).toEqual([150]);
		expect(stored[0].record_json).not.toContain("output_ref");
	});

	it("refuses log IDs past the clock unless renumbered, renumbering at the head with the room's bounds from its records, and reports the range", async () => {
		const message = (logId: number) => JSON.stringify({ message_id: String(logId), log_id: String(logId), room_id: "lobby", from: { user_id: "zed" }, body: { text: `m${logId}` } });
		const archive = (latest: string, records: number[]) => writeArchiveToString(async (writer) => {
			await writer.header({ apron_archive: 1, server: "wss://elsewhere.test/" });
			await writer.listing({ not_joined: [{ room_id: "lobby", log_id: "100", latest_log_id: latest }] });
			await writer.records(records.map((logId) => ({ room_id: "lobby", log_id: logId, commit_ms: logId, kind: "message", record_json: message(logId) })));
		});
		const target = chainOf("head+recent", new TestClock(1_000_000));
		// A listing's head far in the future, or a record past the clock and five minutes.
		for (const text of [await archive(String(Number.MAX_SAFE_INTEGER), [100, 200]), await archive("200", [100, 200, 1_000_000 + 5 * 60_000 + 1])]) {
			await expect(importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock })).rejects.toThrow(/later than this server's clock: import it with renumber/);
			await expect(importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, dryRun: true })).rejects.toThrow(/renumber/);
			expect(target.head.all()).toEqual([]);
			expect(await target.head.journal.get()).toBeUndefined();
		}
		// Within the clock's five minutes, the IDs are kept, and the range is reported.
		const near = await importArchive(target.chain, target.head, jsonlReader(linesOf(await archive("200", [100, 200]))), { clock: target.clock, dryRun: true });
		expect(near.logIdRange).toEqual({ first: 100, last: 200 });
		// Renumbered, the records take IDs at the clock, and the listing's head is theirs, not the file's.
		const text = await archive(String(Number.MAX_SAFE_INTEGER), [100, 200, 9_000_000_000_000]);
		const dry = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, ids: "renumber", dryRun: true });
		expect(dry.logIdRange).toEqual({ first: 1_000_000, last: 1_000_002 });
		const renumbered = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, ids: "renumber" });
		// At the head, whatever tiers lie below.
		expect(renumbered.placed).toEqual({ hot: 3 });
		expect(target.head.rooms_.get("lobby")?.listing).toMatchObject({ log_id: "1000000", latest_log_id: "1000002", history_log_id: "1000000" });
		expect(Math.max(...target.head.all().map((record) => record.log_id))).toBe(1_000_002);
	});

	it("never takes an ID that cannot stand here, nor matches users from a file this server did not seal, and caps the placeholders an import makes", async () => {
		const message = (logId: number, from: Record<string, unknown>) => ({ room_id: "lobby", log_id: logId, commit_ms: logId, kind: "message", record_json: JSON.stringify({ message_id: String(logId), log_id: String(logId), room_id: "lobby", from, body: { text: `m${logId}` } }) });
		const text = await writeArchiveToString(async (writer) => {
			// Claims to be this server: unsealed, the header proves nothing.
			await writer.header({ apron_archive: 1, server: "wss://here.test/" });
			await writer.listing({ not_joined: [{ room_id: "lobby", log_id: "10" }], users: [{ user_id: "admin", name: "Root", roles: ["admin"] }] });
			await writer.records([
				message(10, { user_id: "admin", name: "Root", roles: ["admin"] }),
				message(11, { user_id: "~private", name: "Server" }),
				message(12, { user_id: "guest_7" }),
				message(13, { user_id: "bot_ada", tier: "bot" }),
				message(14, { user_id: "ada", name: "Ada", roles: ["mod"], tier: "registered" }),
			]);
		});
		const target = chainOf("head", new TestClock(1_000_000));
		target.head.people.set("admin", { user_id: "admin", name: "Admin" });
		target.head.people.set("ada", { user_id: "ada", name: "Our Ada" });
		const report = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, server: "wss://here.test/", dryRun: true });
		expect(report.users).toEqual({
			"admin": { placeholder: "imported-admin" }, "~private": { placeholder: "imported-private" }, "guest_7": { placeholder: "imported-guest_7" },
			"bot_ada": { placeholder: "imported-bot_ada" }, "ada": { placeholder: "ada-2" },
		});
		expect(report.placeholders).toBe(5);
		// Capped: a dry run says it would be refused; the import is, before writing anything.
		const capped = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, dryRun: true, maxPlaceholders: 4 });
		expect(capped.refused).toMatch(/5 placeholder accounts, more than the 4/);
		await expect(importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, maxPlaceholders: 4 })).rejects.toThrow(/more than the 4/);
		expect(target.head.all()).toEqual([]);
		// Authenticated (one of this server's backups), `admin` and `ada` are matched; the others never are.
		const sealed = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, server: "wss://here.test/", provenance: "verified" });
		expect(sealed.users).toMatchObject({ admin: { matched: "admin" }, ada: { matched: "ada" }, guest_7: { placeholder: "imported-guest_7" } });
		// Recorded users keep their ID and name only.
		const froms = target.head.all().filter((record) => record.kind === "message").map((record) => JSON.parse(record.record_json).from);
		expect(froms).toEqual([
			{ user_id: "admin", name: "Root" }, { user_id: "imported-private", name: "Server" }, { user_id: "imported-guest_7" }, { user_id: "imported-bot_ada" }, { user_id: "ada", name: "Ada" },
		]);
		expect(target.head.people.get("imported-private")?.roles).toEqual(["unclaimed"]);
	});

	it("drops records the head says no client could have sent, and counts them", async () => {
		const source = chainOf("head");
		populate(source.head, source.clock);
		const text = await exported(source.chain, source.clock);
		const target = chainOf("head", new TestClock(5_000_000));
		target.head.normalizer = (record) => record.record_json.includes("hello 4") ? null : record;
		const report = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock });
		expect(report.rejected).toBe(1);
		expect(target.head.all().some((record) => record.record_json.includes("hello 4"))).toBe(false);
		expect(target.head.all().some((record) => record.record_json.includes("hello 5"))).toBe(true);
	});

	it("journals a renumbered import by its first ID, and refuses one in original IDs too large to resume before writing", async () => {
		// More moved IDs than a journal capped at 16 KiB holds (about 1,500), and
		// far fewer than the real cap (MAX_JOURNAL_BYTES, 1 MiB) holds: the cap
		// is an option, so the test stays small.
		const many = 2_000;
		const maxJournalBytes = 16 * 1024;
		const message = (logId: number) => ({ room_id: "lobby", log_id: logId, commit_ms: logId, kind: "message", record_json: JSON.stringify({ message_id: String(logId), log_id: String(logId), room_id: "lobby", from: { user_id: "zed" }, body: { text: "x" } }) });
		const records = Array.from({ length: many }, (_, index) => message(1_000 + index));
		const text = await writeArchiveToString(async (writer) => {
			await writer.header({ apron_archive: 1 });
			await writer.listing({ not_joined: [{ room_id: "lobby", log_id: "1000" }] });
			await writer.records(records);
		});
		// Every ID taken here by another record: each would move.
		const target = chainOf("head", new TestClock(100_000));
		for (const record of records) target.head.records.set(`${record.log_id}\u0000elsewhere`, { ...record, room_id: "elsewhere", record_json: record.record_json.replace('"x"', '"other"') });
		const dry = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, dryRun: true, maxJournalBytes });
		expect(dry.refused).toMatch(new RegExp(`moves ${many} log IDs, too many to resume from if it fails: import it with renumber`));
		// Under the real cap, the same import's journal fits.
		expect((await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, dryRun: true })).refused).toBeUndefined();
		await expect(importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, maxJournalBytes })).rejects.toThrow(/import it with renumber/);
		expect(await target.head.journal.get()).toBeUndefined();
		// Renumbered: the journal holds the first ID, not every one, and a failed run resumes with the same IDs.
		const journals: string[] = [];
		const setJournal = target.head.journal.set;
		target.head.journal.set = async (value) => {
			if (value) journals.push(value);
			return setJournal(value);
		};
		const append = target.head.append.bind(target.head);
		let fail = true;
		target.head.append = async (range) => {
			if (fail && range.records.some((record) => record.room_id === "lobby")) {
				fail = false;
				throw new Error("the budget ran out");
			}
			return append(range);
		};
		await expect(importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, ids: "renumber", batch: 256 })).rejects.toThrow(/budget/);
		expect(journals[0].length).toBeLessThan(1_000);
		expect(JSON.parse(journals[0])).toMatchObject({ ids: { mode: "renumber", base: 100_000 } });
		const again = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock });
		expect(again.resumed).toBe(true);
		expect(again.logIdRange).toEqual({ first: 100_000, last: 100_000 + many - 1 });
		expect(target.head.all().filter((record) => record.room_id === "lobby")).toHaveLength(many);
	});

	// The account cap the import is bounded by is the server's own: 2,500
	// users import in bounded batches, and a failure partway is finished by
	// running it again.
	it("imports thousands of users in batches and resumably, and refuses more than the server has room for", async () => {
		const users = Array.from({ length: 2_500 }, (_, index) => `user${index}`);
		const text = await writeArchiveToString(async (writer) => {
			await writer.header({ apron_archive: 1, server: "wss://elsewhere.test/" });
			await writer.listing({ not_joined: [{ room_id: "crowd", log_id: "1000" }], users: users.map((user_id) => ({ user_id, name: user_id })) });
			await writer.records(users.map((user, index) => ({ room_id: "crowd", log_id: 1_001 + index, commit_ms: 1_001 + index, kind: "message", record_json: JSON.stringify({ message_id: `m${index}`, log_id: String(1_001 + index), room_id: "crowd", from: { user_id: user }, body: { text: "hi" } }) })));
		});
		// Too little room: the dry run says how much there is, and nothing is written.
		const small = chainOf("head", new TestClock(5_000_000));
		small.head.accountLimit = 2_000;
		small.head.people.set("admin", { user_id: "admin" });
		const dry = await importArchive(small.chain, small.head, jsonlReader(linesOf(text)), { clock: small.clock, dryRun: true });
		expect(dry.accounts).toEqual({ used: 1, limit: 2_000 });
		expect(dry.refused).toBe("this archive would make 2500 placeholder accounts, but there is room for 1999 more (1 of 2000 accounts are in use)");
		await expect(importArchive(small.chain, small.head, jsonlReader(linesOf(text)), { clock: small.clock })).rejects.toThrow(/room for 1999 more/);
		expect(small.head.people.size).toBe(1);
		// Room enough: placeholders in batches of 200; the run fails partway, and runs again to the end.
		const target = chainOf("head", new TestClock(5_000_000));
		target.head.accountLimit = 5_000;
		const batches: number[] = [];
		const restoreUsers = target.head.restoreUsers.bind(target.head);
		let fail = true;
		target.head.restoreUsers = async (batch) => {
			batches.push(batch.length);
			if (fail && batches.length === 4) {
				fail = false;
				throw new Error("the budget ran out");
			}
			return restoreUsers(batch);
		};
		await expect(importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock })).rejects.toThrow(/budget/);
		expect(target.head.people.size).toBe(600);
		const journal = await target.head.journal.get();
		expect(journal).toBeDefined();
		expect(journal!.length).toBeLessThan(2_500 * 16);
		const again = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock });
		expect(again.resumed).toBe(true);
		expect(Math.max(...batches)).toBe(200);
		expect(target.head.people.size).toBe(2_500);
		expect(target.head.all().filter((record) => record.room_id === "crowd")).toHaveLength(2_500);
		expect(await target.head.journal.get()).toBeUndefined();
	});

	it("finishes a failed import when run again, whatever restart says, with the same users and log IDs; abandons another's only with restart, naming its rooms", async () => {
		const source = chainOf("head");
		populate(source.head, source.clock);
		const text = await exported(source.chain, source.clock);
		const target = chainOf("head", new TestClock(5_000_000));
		target.head.people.set("ada", { user_id: "ada", name: "Our Ada" });
		const restore = target.head.restoreRoom.bind(target.head);
		let calls = 0;
		target.head.restoreRoom = async (room, records) => {
			calls += 1;
			if (calls === 2) throw new Error("the budget ran out");
			return restore(room, records);
		};
		await expect(importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock })).rejects.toThrow(/budget/);
		expect(await target.head.journal.get()).toBeDefined();
		// Another archive waits for this one.
		const other = chainOf("head", new TestClock(7_000_000));
		other.head.commit("lobby", "message", { message_id: "m", from: { user_id: "zed" }, body: { text: "a" } });
		other.head.commit("hall", "message", { message_id: "n", from: { user_id: "zed" }, body: { text: "b" } });
		const otherText = await exported(other.chain, other.clock, { server: "other.test" });
		await expect(importArchive(target.chain, target.head, jsonlReader(linesOf(otherText)), { clock: target.clock })).rejects.toThrow(/another import is unfinished/);
		// The same archive, even with restart: resumed, so the room it began is finished, not skipped.
		const again = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, restart: true });
		expect(again).toMatchObject({ resumed: true, roomsAdded: ["general", "random"], roomsSkipped: [] });
		expect(again.abandoned).toBeUndefined();
		expect(again.users).toEqual({ ada: { placeholder: "ada-2" }, bob: { placeholder: "bob" } });
		expect(await target.head.journal.get()).toBeUndefined();
		expect(compareReplayed(await stateOf(text), await stateOf(await exported(target.chain, target.clock)), { idMap: { userId: (id) => id === "ada" ? "ada-2" : id } }).differences.filter((line) => !line.startsWith("user "))).toEqual([]);
		// Another archive's unfinished import: refused, or with restart abandoned, its rooms named.
		calls = 0;
		await expect(importArchive(target.chain, target.head, jsonlReader(linesOf(otherText)), { clock: new TestClock(8_000_000) })).rejects.toThrow(/budget/);
		await expect(importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock })).rejects.toThrow(/another import is unfinished \(rooms hall, lobby\)/);
		const abandoned = await importArchive(target.chain, target.head, jsonlReader(linesOf(text)), { clock: target.clock, restart: true, dryRun: true });
		expect(abandoned.abandoned).toEqual(["hall", "lobby"]);
		expect(abandoned.resumed).toBe(false);
	});
	it("leaves private rooms out of a backup where BACKUP_PRIVATE_ROOMS is false", async () => {
		const source = chainOf("head");
		populate(source.head, source.clock);
		source.clock.time += 7;
		source.head.commit("private_123", "message", { message_id: "secret", from: { user_id: "ada" }, body: { text: "between us" } });
		source.head.rooms_.set("private_123", { listing: { room_id: "private_123", private: true }, joined: false });
		const store = new MemoryBlobStore();
		const lines = async (privateRooms: boolean) => {
			const settings: BackupSettings = { keep: 14, privateRooms };
			const { key } = await writeBackup(source.chain, source.head, new BackupStore(store, HISTORY_CODECS), settings, privateRooms ? "scheduled" : "manual", { server: "srv", clock: source.clock, prepare: withoutOutputs });
			return new Response((await (await store.get(key))!.stream()).pipeThrough(gzip.decoder())).text();
		};
		expect(await lines(true)).toContain("between us");
		const without = await lines(false);
		expect(without).not.toContain("between us");
		expect(without).not.toContain("private_123");
		expect(without).toContain("hello 0");
	});
});
