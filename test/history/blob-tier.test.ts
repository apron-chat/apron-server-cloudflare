/*
 * The blob history tier (src/history/blob/tier.ts) and its segment index
 * (src/history/blob/segments.ts): the HistoryTier conformance suite on the
 * memory tier and on the blob tier over memory and over miniflare's R2, then
 * what is particular to segments: their keys, each one a valid ARCHIVE.md
 * file, the index rebuilt from a listing or kept in SQLite, a retried
 * append's merge and its crashes, and objects gone missing.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { collectArchive, compareReplayed, jsonlReader, linesOf, replayRecords } from "@apron/archive";
import { MemoryBlobStore } from "./support/memory-blob-store";
import { R2BlobStore } from "../../src/history/blob/r2";
import { type SegmentIndex, type SegmentRef, type SqlPort, SqlSegmentIndex, parseSegmentKey, rebuildSegmentIndex, segmentKey } from "../../src/history/blob/segments";
import type { BlobStore } from "../../src/history/blob/store";
import { BlobHistoryTier } from "../../src/history/blob/tier";
import { MemoryHistoryTier } from "./support/memory-tiers";
import { MemorySegmentIndex } from "./support/memory-segment-index";
import { type ChatRecord, byLog, toRange } from "../../src/history/records";
import { describeHistoryTier, sampleLog, wireRecord } from "./conformance/history-tier";

const clock = { now: () => Date.UTC(2026, 10, 19, 12, 0, 0) };
const runner = { describe, it, expect };
const nonce = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");

function blobTier(options: { store?: BlobStore; index?: SegmentIndex; prefix?: string; cacheBytes?: number } = {}) {
	const store = options.store ?? new MemoryBlobStore();
	const index = options.index ?? new MemorySegmentIndex();
	const prefix = options.prefix ?? "history/test/";
	const tier = new BlobHistoryTier({
		name: "cold", store, index, prefix, clock, header: { server: "wss://test.example/" },
		...(options.cacheBytes === undefined ? {} : { cacheBytes: options.cacheBytes }),
	});
	return { tier, store, index, prefix };
}

describeHistoryTier("MemoryHistoryTier", () => new MemoryHistoryTier("memory"), runner);
describeHistoryTier("BlobHistoryTier over MemoryBlobStore", () => blobTier().tier, runner);
describeHistoryTier("BlobHistoryTier over R2", () => {
	if (!env.HISTORY_BLOB) throw new Error("the HISTORY_BLOB R2 binding is missing from wrangler.toml");
	return blobTier({ store: new R2BlobStore(env.HISTORY_BLOB), prefix: `conformance/tier/${nonce()}/` }).tier;
}, runner);

/** Every record of a room through `read`, oldest first. */
async function roomRecords(tier: BlobHistoryTier, roomId: string): Promise<ChatRecord[]> {
	return tier.read({ roomIds: [roomId], lower: 1, upper: Number.MAX_SAFE_INTEGER, forward: true, limit: 10_000 });
}

/** A busy log: edits, reactions set and cleared, memberships, in one room. */
function busyLog(count: number, start = 5000): ChatRecord[] {
	const out: ChatRecord[] = [];
	let id = start;
	for (let index = 0; index < count; index += 1) {
		id += 1;
		const kind = index % 5;
		if (kind === 0 || kind === 3) out.push(wireRecord("message", "a", id));
		else if (kind === 1) out.push(wireRecord("message", "a", id, { message_id: String(id - 1), prev_log_id: String(id - 1), body: { text: `edit ${id}` } }));
		else if (kind === 2) out.push(wireRecord("reactions", "a", id, { message_id: String(id - 2), reactions: [{ from: { user_id: index % 4 ? "bob" : "carol" }, emojis: index % 3 ? ["👍"] : [] }] }));
		else out.push(wireRecord("membership", "a", id, { members: [{ user: { user_id: "dee" }, joined: index % 2 === 0 }] }));
	}
	return out;
}

describe("segment keys", () => {
	it("encode the room and the stretch, and parse back", () => {
		const key = segmentKey("history/srv/", { roomId: "private_12/x é", first: 42, last: 1724803200042 });
		expect(key).toBe("history/srv/private_12%2Fx%20%C3%A9/0000000000000042-0001724803200042.jsonl");
		expect(parseSegmentKey("history/srv/", key)).toEqual({ roomId: "private_12/x é", first: 42, last: 1724803200042 });
		for (const bad of [
			"history/other/a/0000000000000001-0000000000000002.jsonl",
			"history/srv/a/1-2.jsonl",
			"history/srv/a/0000000000000003-0000000000000002.jsonl",
			"history/srv/a/0000000000000000-0000000000000002.jsonl",
			"history/srv/a%2/0000000000000001-0000000000000002.jsonl",
			"history/srv/a b/0000000000000001-0000000000000002.jsonl",
			"history/srv/a/0000000000000001-0000000000000002.json",
		]) expect(parseSegmentKey("history/srv/", bad)).toBeNull();
	});
});

describe("BlobHistoryTier segments", () => {
	it("are each a complete ARCHIVE.md file that renders to the room's records", async () => {
		const { tier, store, index } = blobTier();
		const log = sampleLog();
		await tier.append(toRange(log));
		const refs = (index as MemorySegmentIndex).all();
		expect(refs.map((ref) => [ref.roomId, ref.first, ref.last, ref.records])).toEqual([["a", 1001, 1011, 8], ["b", 1002, 1012, 5]]);
		for (const ref of refs) {
			const object = await store.get(ref.key);
			expect(object?.size).toBe(ref.bytes);
			const archive = await collectArchive(jsonlReader(linesOf(await object!.text())));
			expect(archive.header).toEqual({ apron_archive: 1, server: "wss://test.example/", exported_at: "2026-11-19T12:00:00.000Z" });
			expect(archive.rooms).toEqual([{ joined: false, listing: { room_id: ref.roomId, log_id: String(ref.first), title: `Room ${ref.roomId}`, history_log_id: String(ref.first), latest_log_id: String(ref.last) } }]);
			expect(archive.users.map((user) => user.user_id).sort()).toEqual(ref.roomId === "a" ? ["ada", "bob"] : ["ada"]);
			const own = log.filter((record) => record.room_id === ref.roomId);
			expect(compareReplayed(replayRecords(archive.records, archive.rooms, archive.users), replayRecords(own, archive.rooms, archive.users))).toEqual({ equal: true, differences: [] });
			// Read back through the tier, each record is in the segment's room, a move's copy included.
			expect(await roomRecords(tier, ref.roomId)).toEqual(own);
		}
		expect(store instanceof MemoryBlobStore && store.contentType(refs[0].key)).toBe("application/jsonl");
	});

	it("merge a retried append that overlaps them, and keep an exact repeat in place", async () => {
		const { tier, store, index } = blobTier();
		const log = busyLog(12);
		await tier.append(toRange(log.slice(0, 6)));
		const [first] = (index as MemorySegmentIndex).all();
		await tier.append(toRange(log.slice(0, 6)));
		expect((index as MemorySegmentIndex).all()).toEqual([first]);
		await tier.append(toRange(log.slice(3, 12)));
		const after = (index as MemorySegmentIndex).all();
		expect(after.map((ref) => [ref.first, ref.last, ref.records])).toEqual([[log[0].log_id, log[11].log_id, 12]]);
		expect(await store.get(first.key)).toBeNull();
		expect(await roomRecords(tier, "a")).toEqual(log);
	});

	it("are cached once read", async () => {
		const { tier, store, index } = blobTier();
		await tier.append(toRange(busyLog(10)));
		const memory = store as MemoryBlobStore;
		await roomRecords(tier, "a");
		const gets = memory.calls.filter((call) => call.method === "get").length;
		await roomRecords(tier, "a");
		expect(memory.calls.filter((call) => call.method === "get").length).toBe(gets);
		// Without a cache, every read fetches.
		const uncached = blobTier({ store, index, cacheBytes: 0 }).tier;
		await roomRecords(uncached, "a");
		await roomRecords(uncached, "a");
		expect(memory.calls.filter((call) => call.method === "get").length).toBe(gets + 2);
	});

	it("fetch only what a page needs", async () => {
		const { tier, store } = blobTier();
		const log = busyLog(40);
		for (let index = 0; index < 40; index += 4) await tier.append(toRange(log.slice(index, index + 4)));
		const memory = store as MemoryBlobStore;
		const before = memory.calls.filter((call) => call.method === "get").length;
		const page = await tier.read({ roomIds: ["a"], lower: 1, upper: Number.MAX_SAFE_INTEGER, forward: false, limit: 3 });
		expect(page).toEqual(log.slice(-3).reverse());
		// Ten segments; the newest holds the page, and at most a parallel batch is fetched.
		expect(memory.calls.filter((call) => call.method === "get").length - before).toBeLessThanOrEqual(4);
	});

	it("tolerate a missing object: it reads as empty and leaves the index", async () => {
		const { tier, store, index } = blobTier();
		const log = busyLog(9);
		for (let i = 0; i < 9; i += 3) await tier.append(toRange(log.slice(i, i + 3)));
		const middle = (index as MemorySegmentIndex).all()[1];
		await store.delete([middle.key]);
		expect(await roomRecords(tier, "a")).toEqual([...log.slice(0, 3), ...log.slice(6)]);
		expect((index as MemorySegmentIndex).all().map((ref) => ref.key)).not.toContain(middle.key);
		expect((await tier.scan(0, 100)).records).toEqual([...log.slice(0, 3), ...log.slice(6)]);
	});

	it("restore a lost index from the store's listing", async () => {
		const { tier, store, prefix } = blobTier();
		const log = sampleLog();
		for (let i = 0; i < log.length; i += 3) await tier.append(toRange(log.slice(i, i + 3)));
		await store.put(`${prefix}not-a-segment.txt`, "x");
		const before = await tier.stats();
		const rebuilt = blobTier({ store, prefix });
		expect((await rebuilt.tier.scan(0, 100)).records).toEqual([]);
		expect(await rebuilt.tier.rebuildIndex()).toBe((tier.index as MemorySegmentIndex).all().length);
		expect((rebuilt.index as MemorySegmentIndex).all()).toEqual((tier.index as MemorySegmentIndex).all());
		expect((await rebuilt.tier.scan(0, 100)).records).toEqual(log);
		expect(await rebuilt.tier.stats()).toEqual(before);
		// Below a floor (objects a crashed trim left), segments are skipped; uncounted ones carry no records.
		expect(await rebuilt.tier.rebuildIndex({ floor: 1007, count: false })).toBe((tier.index as MemorySegmentIndex).all().filter((ref) => ref.last >= 1007).length);
		expect((rebuilt.index as MemorySegmentIndex).all().every((ref) => ref.records === 0 && ref.last >= 1007)).toBe(true);
	});

	it("fall on segment boundaries for retention, and a floor that cuts one rewrites it", async () => {
		const { tier, index } = blobTier();
		const log = busyLog(10, 0);
		await tier.append(toRange(log.slice(0, 5)));
		await tier.append(toRange(log.slice(5)));
		// Keeping 3 keeps the whole newest segment of 5.
		expect(await tier.floorFor({ records: 3, thresholdPercent: 100 }, { now: 0, below: Infinity })).toBe(6);
		expect(await tier.floorFor({ records: 7, thresholdPercent: 100 }, { now: 0, below: Infinity })).toBeUndefined();
		// Retention by size too.
		expect(await tier.floorFor({ bytes: 10, thresholdPercent: 100 }, { now: 0, below: Infinity })).toBe(6);
		// A segment of another room straddling 6 lowers the floor to its first, 4, which a's first segment straddles in turn: nothing can go.
		await tier.append(toRange([wireRecord("message", "b", 4), wireRecord("message", "b", 8)]));
		expect(await tier.floorFor({ records: 3, thresholdPercent: 100 }, { now: 0, below: Infinity })).toBeUndefined();
		expect(await tier.floorFor({ records: 3, thresholdPercent: 100 }, { now: 0, below: 6 })).toBeUndefined();
		// The pipeline may still ask for a floor inside a segment.
		expect(await tier.trimBelow(3, 100)).toBe(2);
		expect((await tier.scan(0, 1)).records[0].log_id).toBe(3);
		expect((index as MemorySegmentIndex).all().map((ref) => [ref.roomId, ref.first, ref.last])).toEqual([["a", 3, 5], ["b", 4, 8], ["a", 6, 10]]);
		expect(await roomRecords(tier, "a")).toEqual(log.slice(2));
		expect(await tier.trimBelow(3, 100)).toBe(0);
	});
});

describe("BlobHistoryTier crashes", () => {
	it("survive one during a retried append's merge: reads de-duplicate, and the next retry cleans up", async () => {
		const store = new MemoryBlobStore();
		const inner = new MemorySegmentIndex();
		let failRemove = true;
		const index: SegmentIndex = Object.assign(Object.create(inner) as MemorySegmentIndex, {
			remove: async (refs: readonly SegmentRef[]) => {
				if (failRemove) throw new Error("crash");
				return inner.remove(refs);
			},
		});
		const { tier } = blobTier({ store, index });
		const log = busyLog(12);
		for (let i = 0; i < 12; i += 4) await tier.append(toRange(log.slice(i, i + 4)));
		const originals = inner.all().map((ref) => ref.key);
		await expect(tier.append(toRange(log))).rejects.toThrow("crash");
		// The merged segment replaced the first one's row; the others overlap it.
		expect(inner.all().map((ref) => [ref.first, ref.last])).toEqual([[log[0].log_id, log[11].log_id], [log[4].log_id, log[7].log_id], [log[8].log_id, log[11].log_id]]);
		expect(await roomRecords(tier, "a")).toEqual(log);
		expect((await tier.scan(0, 100)).records).toEqual(log);
		expect(await tier.read({ roomIds: ["a"], lower: 1, upper: Number.MAX_SAFE_INTEGER, forward: false, limit: 5 })).toEqual(log.slice(-5).reverse());
		expect(await tier.lookup([log[5].log_id])).toEqual([log[5]]);
		expect((await tier.stats()).records).toBeGreaterThan(12);
		failRemove = false;
		await tier.append(toRange(log));
		expect(inner.all().map((ref) => [ref.first, ref.last, ref.records])).toEqual([[log[0].log_id, log[11].log_id, 12]]);
		expect(await roomRecords(tier, "a")).toEqual(log);
		// Left: the merged segment, and the first original's object, whose index row the merged one replaced
		// before the crash: unindexed, so no read sees it (a rebuild with the tier's floor would).
		const listed = await store.list("history/test/");
		expect(listed.keys.map((entry) => entry.key)).toEqual([originals[0], inner.all()[0].key].sort());
	});
});

describe("SqlSegmentIndex", () => {
	it("keeps segments in the Durable Object's SQLite, and serves a blob tier", async () => {
		await runInDurableObject(env.DEMO.getByName(`segments-${crypto.randomUUID()}`), async (_instance, state) => {
			const port: SqlPort = {
				rows: <T>(sql: string, ...binds: unknown[]) => state.storage.sql.exec(sql, ...binds).toArray() as T[],
				run: (sql: string, ...binds: unknown[]) => void state.storage.sql.exec(sql, ...binds),
			};
			const index = new SqlSegmentIndex(port);
			index.ensureSchema();
			index.ensureSchema();
			const ref = (roomId: string, first: number, last: number, key = `${roomId}-${first}-${last}`): SegmentRef => ({ roomId, first, last, key, records: last - first + 1, bytes: 10 });
			await index.add([ref("b", 5, 9), ref("a", 1, 4), ref("a", 10, 20), ref("c", 3, 30)]);
			expect((await index.find(["a", "c"], 4, 10)).map((r) => r.key)).toEqual(["a-1-4", "a-10-20", "c-3-30"]);
			expect((await index.overlapping(9, 9)).map((r) => r.key)).toEqual(["c-3-30", "b-5-9"]);
			expect((await index.after(5, 2)).map((r) => r.key)).toEqual(["c-3-30", "b-5-9"]);
			expect((await index.after(5, 2, { first: 5, roomId: "b" })).map((r) => r.key)).toEqual(["a-10-20"]);
			expect((await index.oldest(2)).map((r) => r.key)).toEqual(["a-1-4", "b-5-9"]);
			expect(await index.forRoom("a")).toEqual([ref("a", 1, 4), ref("a", 10, 20)]);
			expect(await index.rooms()).toEqual(["a", "b", "c"]);
			// Replaced at the same room and first; removed only under the same key.
			await index.add([ref("a", 1, 6)]);
			await index.remove([ref("a", 1, 4)]);
			expect((await index.forRoom("a")).map((r) => r.key)).toEqual(["a-1-6", "a-10-20"]);
			await index.remove([ref("a", 1, 6)]);
			expect((await index.forRoom("a")).map((r) => r.key)).toEqual(["a-10-20"]);
			await index.clear();
			expect(await index.rooms()).toEqual([]);

			// A blob tier over it, and its index rebuilt into another table.
			const store = new MemoryBlobStore();
			const { tier } = blobTier({ store, index });
			const log = busyLog(20);
			for (let i = 0; i < 20; i += 4) await tier.append(toRange(log.slice(i, i + 4)));
			expect(await roomRecords(tier, "a")).toEqual(log);
			const other = new SqlSegmentIndex(port, { table: "history_segments_backup" });
			other.ensureSchema();
			expect(await rebuildSegmentIndex(other, store, "history/test/")).toBe((await index.forRoom("a")).length);
			expect(await other.forRoom("a")).toEqual(await index.forRoom("a"));
			expect(() => new SqlSegmentIndex(port, { table: "bad name" })).toThrow(/invalid segment table/);
		});
	});
});

describe("BlobHistoryTier ordering", () => {
	it("scans across rooms in log order, every room's copy, through many segments", async () => {
		const { tier } = blobTier();
		const log: ChatRecord[] = [];
		for (let id = 1; id <= 80; id += 1) log.push(wireRecord("message", id % 3 ? "a" : id % 2 ? "b" : "c", id));
		for (let i = 0; i < 80; i += 7) await tier.append(toRange(log.slice(i, i + 7)));
		const sorted = [...log].sort(byLog);
		for (const [from, limit] of [[0, 50], [13, 9], [40, 100]] as const) {
			expect((await tier.scan(from, limit)).records).toEqual(sorted.filter((record) => record.log_id >= from).slice(0, limit));
		}
	});
});
