// The streaming import (importArchive's two passes) over memory tiers: a
// backup far past the old 16 MiB cap imports whole, and resumably, through
// failures midway through its writes and runs in new chains over the same
// storage, each going on from the line saved by decoding and discarding
// what comes before it; a foreign gzip file imports, by the same path, or
// from memory when its rooms' records are out of order.
import { describe, expect, it } from "vitest";
import { type ArchivedRoom, type ChatRecord, type ScanStats, writeArchiveToString } from "@apron/archive";
import { importArchive } from "../../src/history/archive/import";
import { BackupStore, MAX_IMPORT_BYTES } from "../../src/history/exports";
import { HISTORY_CODECS } from "../../src/history/config";
import { HistoryChain } from "../../src/history/chain";
import { MemoryBlobStore } from "./support/memory-blob-store";
import { MemoryChainStateStore, MemoryHead } from "./support/memory-tiers";

class TestClock {
	constructor(public time = 10_000_000_000) {}
	now(): number { return this.time; }
}

const ROOMS = ["lobby", "random", "ops", "quiet"];
const THREAD = "500";
const WORDS = "the of and to in is you that it was for on are as with his they at be this have from or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more".split(" ");

/** A big server's backup: rooms and a thread (of lobby), their records grouped by room, oldest first, as this server writes them. */
function bigRecords(count: number): ChatRecord[] {
	let seed = 7;
	const word = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return WORDS[seed % WORDS.length];
	};
	const rooms = [...ROOMS, THREAD];
	const out: ChatRecord[] = [];
	for (let at = 0; at < count; at += 1) {
		const roomId = rooms[at % rooms.length]!;
		const logId = 1_000 + at;
		const value = { room_id: roomId, log_id: String(logId), message_id: String(logId), from: { user_id: `user-${at % 40}`, name: `User ${at % 40}` }, body: { text: Array.from({ length: 90 }, word).join(" ") } };
		out.push({ room_id: roomId, log_id: logId, commit_ms: logId, kind: "message", record_json: JSON.stringify(value) });
	}
	// The thread's own records come first in the file, before its parent's.
	const order = [THREAD, ...ROOMS];
	return out.sort((a, b) => order.indexOf(a.room_id) - order.indexOf(b.room_id) || a.log_id - b.log_id);
}

function chainOf(head: MemoryHead, clock: TestClock): HistoryChain {
	return new HistoryChain({ head, headRetention: { records: 1_000_000_000, thresholdPercent: 100 }, stages: [], state: new MemoryChainStateStore(), clock, batch: 200 });
}

/** A head that fails its `nth` restoreRoom call from now on (none: 0), as a failing write or a day's spent budget would. */
function failing(head: MemoryHead): { at(nth: number): void; calls(): number; order: string[] } {
	const restoreRoom = head.restoreRoom.bind(head);
	let calls = 0;
	let failAt = 0;
	const order: string[] = [];
	head.restoreRoom = async (room: ArchivedRoom, records: readonly ChatRecord[]) => {
		calls += 1;
		if (failAt && calls === failAt) throw new Error("injected failure");
		if (!head.rooms_.has(room.listing.room_id)) order.push(room.listing.room_id);
		return restoreRoom(room, records);
	};
	return { at(nth) { failAt = nth ? calls + nth : 0; }, calls: () => calls, order };
}

describe("streaming import", () => {
	it("imports a backup far past 16 MiB whole, through failures midway and runs in new chains, going on from the line saved", { timeout: 120_000 }, async () => {
		const clock = new TestClock();
		const records = bigRecords(42_000);
		const backups = new BackupStore(new MemoryBlobStore(), HISTORY_CODECS);
		const { decodedBytes } = await backups.write("backups/big-manual-20261121-000000.jsonl.gz", async (archive) => {
			await archive.header({ apron_archive: 1, server: "wss://elsewhere.test/" });
			await archive.listing({ not_joined: [...ROOMS.map((room_id) => ({ room_id, log_id: "900", members: [{ user_id: "user-1" }] })), { room_id: THREAD, parent_room_id: "lobby", log_id: "950" }] });
			// A room's records at a time (the writer sorts each call's by log ID), many to a line.
			for (const roomId of [THREAD, ...ROOMS]) await archive.records(records.filter((record) => record.room_id === roomId));
			await archive.close();
		});
		expect(decodedBytes).toBeGreaterThan(20 * 1024 * 1024);
		expect(decodedBytes).toBeLessThan(MAX_IMPORT_BYTES);
		const key = "backups/big-manual-20261121-000000.jsonl.gz";
		const open = async () => (await backups.source(key, MAX_IMPORT_BYTES))!.source;

		// Uninterrupted, for comparison.
		const reference = new MemoryHead("hot", clock);
		const whole = await importArchive(chainOf(reference, clock), reference, await open(), { clock });
		expect(whole).toMatchObject({ records: 42_000, roomsAdded: [...ROOMS, THREAD].sort((a, b) => Number(a === THREAD) - Number(b === THREAD) || (a < b ? -1 : 1)) });

		// Interrupted twice, each run in a new chain and source over the same head (its storage).
		const head = new MemoryHead("hot", clock);
		const faults = failing(head);
		faults.at(40);
		const first: ScanStats = { skipped: 0, scanned: 0 };
		await expect(importArchive(chainOf(head, clock), head, await open(), { clock, stats: first })).rejects.toThrow("injected failure");
		expect(head.journalText).toBeDefined();
		const saved = JSON.parse(head.progressText!) as { line: number; offset: number; entry: number };
		expect(saved.entry).toBeGreaterThan(0);
		expect(first.skipped).toBe(0);
		// The thread's records come first in the file: its parent was made first, from its listing.
		expect(faults.order.slice(0, 2)).toEqual(["lobby", THREAD]);

		faults.at(60);
		const second: ScanStats = { skipped: 0, scanned: 0 };
		await expect(importArchive(chainOf(head, clock), head, await open(), { clock, stats: second })).rejects.toThrow("injected failure");
		// It decoded and discarded the bytes before the saved line, and read on from there.
		expect(second.skipped).toBe(saved.offset);
		const later = JSON.parse(head.progressText!) as { offset: number; entry: number };
		expect(later.entry).toBeGreaterThan(saved.entry);

		faults.at(0);
		const third: ScanStats = { skipped: 0, scanned: 0 };
		const done = await importArchive(chainOf(head, clock), head, await open(), { clock, stats: third });
		expect(third.skipped).toBe(later.offset);
		expect(third.skipped + third.scanned).toBe(decodedBytes);
		expect(done).toMatchObject({ resumed: true, records: 42_000 });
		expect(head.journalText).toBeUndefined();
		expect(head.progressText).toBeUndefined();
		expect(head.all()).toEqual(reference.all());
		expect(head.members_).toEqual(reference.members_);
		expect([...head.rooms_.keys()].sort()).toEqual([...reference.rooms_.keys()].sort());
		// A run writes batch after batch from one open stream: the three read the file's bytes about once over, not once per batch.
		expect(first.scanned + second.scanned + third.scanned).toBeLessThan(2 * decodedBytes);
	});

	it("imports a foreign gzip file by the same path, and one whose rooms' records are out of order from memory, or refuses it past what it sorts", async () => {
		const clock = new TestClock();
		const message = (room: string, logId: number, text: string): ChatRecord => ({ room_id: room, log_id: logId, commit_ms: logId, kind: "message", record_json: JSON.stringify({ room_id: room, log_id: String(logId), message_id: String(logId), from: { user_id: "ada", name: "Ada" }, body: { text } }) });
		const textOf = (records: ChatRecord[]) => writeArchiveToString(async (writer) => {
			await writer.header({ apron_archive: 1 });
			await writer.listing({ not_joined: [{ room_id: "a" }, { room_id: "b" }] });
			// One record a line, in the order given.
			for (const record of records) await writer.records([record]);
		});
		// Gzipped by something else (one gzip member, no metadata): its name says how to read it.
		const store = new MemoryBlobStore();
		const backups = new BackupStore(store, HISTORY_CODECS);
		const ordered = [message("b", 20, "b1"), message("b", 21, "b2"), message("a", 10, "a1"), message("a", 30, "a2")];
		const shuffled = [ordered[1]!, ordered[3]!, ordered[0]!, ordered[2]!];
		for (const [name, records] of [["ordered", ordered], ["shuffled", shuffled]] as const) {
			const gzipped = new Response(new Response(await textOf(records)).body!.pipeThrough(new CompressionStream("gzip")));
			const writer = await store.writer(`backups/${name}.jsonl.gz`);
			await writer.write(new Uint8Array(await gzipped.arrayBuffer()));
			await writer.close();
		}
		for (const name of ["ordered", "shuffled"]) {
			const head = new MemoryHead("hot", clock);
			const opened = (await backups.source(`backups/${name}.jsonl.gz`, MAX_IMPORT_BYTES))!;
			expect(opened.provenance).toBe("unverified");
			const report = await importArchive(chainOf(head, clock), head, opened.source, { clock });
			expect(report).toMatchObject({ records: 4, roomsAdded: ["a", "b"] });
			expect(head.all().map((record) => [record.room_id, record.log_id])).toEqual([["a", 10], ["b", 20], ["b", 21], ["a", 30]]);
		}
		// Out of order and larger than it sorts in memory: refused, dry run or not, before anything is written.
		const head = new MemoryHead("hot", clock);
		const opened = (await backups.source("backups/shuffled.jsonl.gz", MAX_IMPORT_BYTES))!;
		const dry = await importArchive(chainOf(head, clock), head, opened.source, { clock, dryRun: true, maxSortedBytes: 100 });
		expect(dry.refused).toMatch(/the records of [ab] are not in log order in this archive, and at 0\.0 MiB decoded it is too large to sort in memory/);
		await expect(importArchive(chainOf(head, clock), head, opened.source, { clock, maxSortedBytes: 100 })).rejects.toThrow(/not in log order/);
		expect(head.all()).toEqual([]);
		expect(head.journalText).toBeUndefined();
	});

	it("refuses an archive past the records one import takes, before anything is written", async () => {
		const clock = new TestClock();
		const head = new MemoryHead("hot", clock);
		const text = await writeArchiveToString(async (writer) => {
			await writer.header({ apron_archive: 1 });
			await writer.listing({ not_joined: [{ room_id: "a" }] });
			await writer.records(bigRecords(30).map((record) => ({ ...record, room_id: "a", record_json: record.record_json.replace(/"room_id":"[^"]*"/, '"room_id":"a"') })));
		});
		const { readArchive } = await import("@apron/archive");
		await expect(importArchive(chainOf(head, clock), head, readArchive(text), { clock, maxRecords: 29, dryRun: true })).rejects.toThrow("this archive holds more than 29 records, more than one import takes");
		expect(head.all()).toEqual([]);
	});
});
