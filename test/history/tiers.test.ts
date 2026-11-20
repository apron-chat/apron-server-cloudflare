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

function coldTier(options: { store?: BlobStore; index?: MemoryChunkIndex; prefix?: string; codecs?: typeof HISTORY_CODECS } = {}) {
	// The memory store's call log is what tests read; R2 is given only to the conformance suite.
	const store = (options.store ?? new MemoryBlobStore()) as MemoryBlobStore;
	const index = options.index ?? new MemoryChunkIndex();
	const prefix = options.prefix ?? "history/test/";
	const tier = new ColdHistoryTier({
		name: "cold", store, index, prefix, clock, codecs: options.codecs ?? HISTORY_CODECS, header: { server: "wss://test.example/" },
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
	it("makes one chunk a copied range, keyed by its first log ID through the codecs, an ARCHIVE.md file", async () => {
		const { tier, store, index } = coldTier({ codecs: [] });
		const log = sampleLog();
		await tier.append(toRange(log));
		const [ref] = await index.list();
		expect(ref).toMatchObject({ first: 1001, last: 1012, key: "history/test/0000000000001001.jsonl", records: log.length, rooms: ["a", "b"] });
		// Written once, only trimmed: it takes no /purge or /rename.
		expect((tier as HistoryTier).rewrite).toBeUndefined();
		// Without codecs, the object is the archive itself: apron-web can open it.
		const archive = await collectArchive(jsonlReader(linesOf(await (await store.get(ref.key))!.text())));
		expect(archive.header).toMatchObject({ apron_archive: 1, server: "wss://test.example/" });
		// The move is held once, in its destination, and named in both rooms by the `copies` line.
		expect(archive.extras).toEqual([{ key: "copies", values: [{ log_id: "1008", rooms: ["a", "b"] }] }]);
		expect((await tier.scan(0, 100)).records).toEqual(log);
	});

	it("stores chunks through its codec chain, and reads them back through what each records", async () => {
		const { tier, store, index } = coldTier();
		await tier.append(toRange(sampleLog()));
		const [ref] = await index.list();
		expect(ref.key).toBe(`history/test/0000000000001001.jsonl${HISTORY_CODECS.map((codec) => codec.extension).join("")}`);
		expect((await store.get(ref.key))!.metadata).toEqual({ codecs: HISTORY_CODECS.map((codec) => codec.name).join(",") });
		expect((await tier.scan(0, 100)).records).toEqual(sampleLog());
	});

	it("rewrites the same key when a copy is retried, and merges a range overlapping chunks into one", async () => {
		const { tier, store, index } = coldTier();
		const log = sampleLog();
		const first = log.filter((record) => record.log_id <= 1004);
		const second = log.filter((record) => record.log_id > 1004 && record.log_id <= 1008);
		await tier.append(toRange(first));
		await tier.append(toRange(first));
		await tier.append(toRange(second));
		expect((await index.list()).map((ref) => [ref.first, ref.last])).toEqual([[1001, 1004], [1005, 1008]]);
		// A retry over a source that changed since reaches past both: one chunk, at the first one's key.
		await tier.append(toRange(log.filter((record) => record.log_id >= 1003)));
		const refs = await index.list();
		expect(refs.map((ref) => [ref.first, ref.last])).toEqual([[1001, 1012]]);
		expect((await store.list("history/test/")).keys.map((entry) => entry.key)).toEqual([refs[0].key]);
		expect((await tier.scan(0, 100)).records).toEqual(log);
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
