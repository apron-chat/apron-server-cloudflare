/*
 * History tiers below the head: the HistoryTier conformance suite on the
 * memory tier, the D1 tier (miniflare's local HISTORY_D1, a table per run)
 * and the cold tier over memory and miniflare's R2, with its codec chain and
 * without one; then what is particular to the cold tier's chunks: one a
 * copied range, a retried copy rewriting the same key, a range overlapping
 * chunks merged, reads skipping chunks without their rooms, and trims by
 * whole chunks. It takes no rewrites: its chunks are written once.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { collectArchive, jsonlReader, linesOf } from "@apron/archive";
import { MemoryBlobStore } from "./support/memory-blob-store";
import { MemoryChunkIndex } from "./support/memory-chunk-index";
import { MemoryHistoryTier } from "./support/memory-tiers";
import { R2BlobStore } from "../../src/history/storage/r2";
import { ColdHistoryTier } from "../../src/history/cold/tier";
import { D1HistoryTier } from "../../src/history/d1";
import { HISTORY_CODECS } from "../../src/history/config";
import { type ChatRecord, toRange } from "../../src/history/records";
import type { BlobStore } from "../../src/history/storage/store";
import type { HistoryTier } from "../../src/history/tier";
import { describeHistoryTier, sampleLog, wireRecord } from "./conformance/history-tier";

const clock = { now: () => Date.UTC(2026, 10, 19, 12, 0, 0) };
const runner = { describe, it, expect };
const nonce = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");

function coldTier(options: { store?: BlobStore; index?: MemoryChunkIndex; prefix?: string; codecs?: typeof HISTORY_CODECS; chunkLogIds?: number } = {}) {
	// The memory store's call log is what tests read; R2 is given only to the conformance suite.
	const store = (options.store ?? new MemoryBlobStore()) as MemoryBlobStore;
	const index = options.index ?? new MemoryChunkIndex();
	const prefix = options.prefix ?? "history/test/";
	const tier = new ColdHistoryTier({
		name: "cold", store, index, prefix, clock, codecs: options.codecs ?? HISTORY_CODECS, header: { server: "wss://test.example/" },
		...(options.chunkLogIds ? { chunkLogIds: options.chunkLogIds } : {}),
	});
	return { tier, store, index, prefix };
}

describeHistoryTier("MemoryHistoryTier", () => new MemoryHistoryTier("memory"), runner);
let d1Tables = 0;
describeHistoryTier("D1HistoryTier", () => new D1HistoryTier("recent", env.HISTORY_D1!, { table: `conformance_${Date.now()}_${(d1Tables += 1)}` }), runner);
describeHistoryTier("ColdHistoryTier over MemoryBlobStore", () => coldTier().tier, runner);
describeHistoryTier("ColdHistoryTier over MemoryBlobStore, no codecs", () => coldTier({ codecs: [] }).tier, runner);
describeHistoryTier("ColdHistoryTier over R2", () => coldTier({ store: new R2BlobStore(env.HISTORY_BLOB!), prefix: `history/conformance-${nonce()}/` }).tier, runner);

const ada = { user_id: "ada", name: "Ada" };

/** A message of `from` in `roomId` at `logId`. */
function message(roomId: string, logId: number, from: { user_id: string; name: string }, fields: Record<string, unknown> = {}): ChatRecord {
	return wireRecord("message", roomId, logId, { message_id: `m${logId}`, from, ...fields });
}

describe("ColdHistoryTier chunks", () => {
	it("makes one chunk a copied range, keyed by its first log ID through its codec chain, an ARCHIVE.md file, read back through what it records", async () => {
		for (const codecs of [[], HISTORY_CODECS]) {
			const { tier, store, index } = coldTier({ codecs });
			const log = sampleLog();
			await tier.append(toRange(log));
			const [ref] = await index.list();
			expect(ref).toMatchObject({ first: 1001, last: 1012, key: `history/test/0000000000001001.jsonl${codecs.map((codec) => codec.extension).join("")}`, records: log.length, rooms: ["a", "b"] });
			expect((await tier.scan(0, 100)).records).toEqual(log);
			if (codecs.length) {
				expect((await store.get(ref.key))!.metadata).toEqual({ codecs: codecs.map((codec) => codec.name).join(",") });
				continue;
			}
			// Written once, only trimmed: it takes no /purge or /rename.
			expect((tier as HistoryTier).rewrite).toBeUndefined();
			// Without codecs, the object is the archive itself: apron-web can open it.
			const archive = await collectArchive(jsonlReader(linesOf(await (await store.get(ref.key))!.text())));
			expect(archive.header).toMatchObject({ apron_archive: 1, server: "wss://test.example/" });
			// The move is held once, in its destination, and named in both rooms by the `copies` line.
			expect(archive.extras).toEqual([{ key: "copies", values: [{ log_id: "1008", rooms: ["a", "b"] }] }]);
		}
	});

	it("reads chunks written under an earlier server name by their own keys, and writes new ones under the new name", async () => {
		// A server renamed (as one named by a parent-domain RP ID moving to its own host): the same store and index.
		const before = coldTier({ prefix: "history/apron.chat/" });
		const log = sampleLog();
		const older = log.filter((record) => record.log_id <= 1006);
		await before.tier.append(toRange(older));
		const { tier, store, index } = coldTier({ store: before.store, index: before.index, prefix: "history/server.apron.chat/" });
		expect((await tier.scan(0, 100)).records).toEqual(older);
		await tier.append(toRange(log.filter((record) => record.log_id > 1006)));
		expect((await tier.scan(0, 100)).records).toEqual(log);
		const keys = (await index.list()).sort((a, b) => a.first - b.first).map((ref) => ref.key);
		expect(keys).toEqual(["history/apron.chat/0000000000001001.jsonl.gz", "history/server.apron.chat/0000000000001007.jsonl.gz"]);
		// Trimmed by its own key too.
		await tier.trimBelow(1007, 100);
		expect((await store.list("history/apron.chat/")).keys).toEqual([]);
		expect((await tier.scan(0, 100)).records).toEqual(log.filter((record) => record.log_id > 1006));
	});

	it("rewrites the same key when a copy is retried, and splits a range overlapping chunks at their bounds", async () => {
		const { tier, store, index } = coldTier();
		const log = sampleLog();
		const first = log.filter((record) => record.log_id <= 1004);
		const second = log.filter((record) => record.log_id > 1004 && record.log_id <= 1008);
		await tier.append(toRange(first));
		await tier.append(toRange(first));
		await tier.append(toRange(second));
		expect((await index.list()).map((ref) => [ref.first, ref.last])).toEqual([[1001, 1004], [1005, 1008]]);
		// A retry over a source that changed since reaches past both: merged into each where it falls, the rest a new chunk.
		await tier.append(toRange(log.filter((record) => record.log_id >= 1003)));
		const refs = (await index.list()).sort((a, b) => a.first - b.first);
		expect(refs.map((ref) => [ref.first, ref.last])).toEqual([[1001, 1004], [1005, 1008], [1009, 1012]]);
		expect((await store.list("history/test/")).keys.map((entry) => entry.key).sort()).toEqual(refs.map((ref) => ref.key).sort());
		expect((await tier.scan(0, 100)).records).toEqual(log);
	});

	it("takes an import landing among many chunks into each one apart, at most a chunk's worth each", async () => {
		const { tier, store, index } = coldTier({ chunkLogIds: 4 });
		// Twenty chunks of four log IDs each, 10 apart: 1000..1003, 1010..1013, ...
		const copied = Array.from({ length: 20 }, (_, chunk) => Array.from({ length: 4 }, (_, at) => message("a", 1000 + chunk * 10 + at, ada)));
		for (const chunk of copied) await tier.append(toRange(chunk));
		const before = (await index.list()).sort((a, b) => a.first - b.first).map((ref) => [ref.first, ref.last]);
		expect(before).toHaveLength(20);
		// A sparse import: one record inside each chunk's stretch, and one in each gap between them.
		const imported = [
			...Array.from({ length: 20 }, (_, chunk) => message("b", 1000 + chunk * 10 + 2, ada)),
			...Array.from({ length: 19 }, (_, chunk) => message("b", 1000 + chunk * 10 + 6, ada)),
		];
		const gets = store.calls.filter((call) => call.method === "get").length;
		await tier.append(toRange(imported));
		const refs = (await index.list()).sort((a, b) => a.first - b.first);
		// Every chunk keeps its bounds; the gaps' records are new chunks inside their gaps; none overlap.
		for (const [first, last] of before) expect(refs.some((ref) => ref.first === first && ref.last === last)).toBe(true);
		for (const [at, ref] of refs.entries()) if (at > 0) expect(ref.first).toBeGreaterThan(refs[at - 1].last);
		expect(refs).toHaveLength(39);
		// Each listed chunk was read once, not all at once into one merged chunk.
		expect(store.calls.filter((call) => call.method === "get").length - gets).toBeLessThanOrEqual(20);
		const all = (await tier.scan(0, 1_000)).records;
		expect(all).toHaveLength(80 + 39);
	});

	it("splits a chunk merged past a chunk's worth, inside its own stretch", async () => {
		const { tier, index } = coldTier({ chunkLogIds: 4 });
		await tier.append(toRange([1000, 1001, 1002, 1020].map((id) => message("a", id, ada))));
		await tier.append(toRange([1030, 1031].map((id) => message("a", id, ada))));
		// Twelve more log IDs inside the first chunk's stretch.
		await tier.append(toRange(Array.from({ length: 12 }, (_, at) => message("b", 1003 + at, ada))));
		const refs = (await index.list()).sort((a, b) => a.first - b.first);
		expect(refs[0].first).toBe(1000);
		expect(refs.find((ref) => ref.first === 1030)?.last).toBe(1031);
		const inFirst = refs.filter((ref) => ref.last <= 1020);
		expect(inFirst[inFirst.length - 1].last).toBe(1020);
		for (const ref of inFirst) expect(ref.records).toBeLessThanOrEqual(4);
		for (const [at, ref] of refs.entries()) if (at > 0) expect(ref.first).toBeGreaterThan(refs[at - 1].last);
		expect((await tier.scan(0, 100)).records.map((record) => record.log_id)).toEqual([1000, 1001, 1002, ...Array.from({ length: 12 }, (_, at) => 1003 + at), 1020, 1030, 1031]);
	});

	it("reads only the chunks that hold one of a page's rooms", async () => {
		const { tier, store } = coldTier();
		await tier.append(toRange([message("a", 10, ada), message("a", 11, ada)]));
		await tier.append(toRange([message("b", 20, ada)]));
		await tier.append(toRange([message("a", 30, ada)]));
		const gets = () => store.calls.filter((call) => call.method === "get").map((call) => call.key);
		const page = await tier.read({ roomIds: ["b"], lower: 1, upper: 100, forward: false, limit: 10 });
		expect(page.map((record) => record.log_id)).toEqual([20]);
		expect(gets()).toEqual(["history/test/0000000000000020.jsonl.gz"]);
		// A page stops once full: the oldest chunk is not read for the newest record of room a.
		const newest = await tier.read({ roomIds: ["a"], lower: 1, upper: 100, forward: false, limit: 1 });
		expect(newest.map((record) => record.log_id)).toEqual([30]);
		expect(gets()).not.toContain("history/test/0000000000000010.jsonl.gz");
	});

	it("trims whole chunks, and rewrites one a floor cuts under its key", async () => {
		const { tier, index, store } = coldTier();
		await tier.append(toRange([message("a", 10, ada), message("a", 11, ada)]));
		await tier.append(toRange([message("a", 20, ada), message("a", 21, ada), message("a", 22, ada)]));
		expect(await tier.trimBelow(12, 100)).toBe(2);
		expect(await tier.trimBelow(21, 100)).toBe(1);
		const [ref] = await index.list();
		expect([ref.first, ref.last, ref.records, ref.key]).toEqual([21, 22, 2, "history/test/0000000000000020.jsonl.gz"]);
		expect((await store.list("history/test/")).keys.map((entry) => entry.key)).toEqual([ref.key]);
		expect((await tier.scan(0, 100)).records.map((record) => record.log_id)).toEqual([21, 22]);
	});
});
