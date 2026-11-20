/*
 * History tiers below the head: the HistoryTier conformance suite on the
 * memory tier, the D1 tier (miniflare's local HISTORY_D1, a table per run)
 * and the cold tier over memory and miniflare's R2, with its codec chain and
 * without one; then what is particular to the cold tier's chunks: one a
 * copied range, a retried copy rewriting the same key, a range overlapping
 * chunks merged, reads skipping chunks without their rooms, a /purge or
 * /rename sweep over several steps (resumed from its cursor, repeated
 * without harm, rewriting only what changes), and trims by whole chunks.
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
import { type ChatRecord, type HistoryOp, toRange } from "../../src/history/records";
import type { BlobStore } from "../../src/history/storage/store";
import { describeHistoryTier, sampleLog, wireRecord } from "./conformance/history-tier";

const clock = { now: () => Date.UTC(2026, 10, 19, 12, 0, 0) };
const runner = { describe, it, expect };
const nonce = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");

function coldTier(options: { store?: BlobStore; index?: MemoryChunkIndex; prefix?: string; codecs?: typeof HISTORY_CODECS; opChunks?: number } = {}) {
	// The memory store's call log is what tests read; R2 is given only to the conformance suite.
	const store = (options.store ?? new MemoryBlobStore()) as MemoryBlobStore;
	const index = options.index ?? new MemoryChunkIndex();
	const prefix = options.prefix ?? "history/test/";
	const tier = new ColdHistoryTier({
		name: "cold", store, index, prefix, clock, codecs: options.codecs ?? HISTORY_CODECS, header: { server: "wss://test.example/" },
		...(options.opChunks === undefined ? {} : { opChunks: options.opChunks }),
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
const cy = { user_id: "cy", name: "Cy" };

/** A message of `from` in `roomId` at `logId`. */
function message(roomId: string, logId: number, from: { user_id: string; name: string }, fields: Record<string, unknown> = {}): ChatRecord {
	return wireRecord("message", roomId, logId, { message_id: `m${logId}`, from, ...fields });
}

/** A reaction set of `from` on message `messageId` in `roomId` at `logId`. */
function reaction(roomId: string, logId: number, messageId: string, from: { user_id: string; name: string }): ChatRecord {
	return wireRecord("reactions", roomId, logId, { message_id: messageId, reactions: [{ from, emojis: ["👍"] }] });
}

/**
 * Applies `op` a step at a time until done, amending a purge with what each
 * step found as the pipeline does; returns the cursors it went through and
 * the messages it found.
 */
async function sweep(tier: ColdHistoryTier, op: HistoryOp): Promise<{ cursors: string[]; found: string[] }> {
	const cursors: string[] = [];
	const found: string[] = [];
	let cursor: string | undefined;
	do {
		const current: HistoryOp = op.op === "purge" ? { ...op, messageIds: [...new Set([...op.messageIds, ...found])] } : op;
		cursor = await tier.applyOp(current, { cursor, found: async (ids) => { found.push(...ids); } });
		if (cursor !== undefined) cursors.push(cursor);
	} while (cursor !== undefined);
	return { cursors, found };
}

describe("ColdHistoryTier chunks", () => {
	it("makes one chunk a copied range, keyed by its first log ID through the codecs, an ARCHIVE.md file", async () => {
		const { tier, store, index } = coldTier({ codecs: [] });
		const log = sampleLog();
		await tier.append(toRange(log));
		const [ref] = await index.list();
		expect(ref).toMatchObject({ first: 1001, last: 1012, key: "history/test/0000000000001001.jsonl", records: log.length, rooms: ["a", "b"], users: ["ada", "bob"] });
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

describe("ColdHistoryTier /purge and /rename", () => {
	/** cy's message at 10, edited at 21 and moved at 31; ada's reactions on it at 22 and 40; chunks of a few log IDs each. */
	async function populated(opChunks: number) {
		const built = coldTier({ opChunks });
		const { tier } = built;
		await tier.append(toRange([message("a", 10, cy), message("a", 11, ada)]));
		await tier.append(toRange([message("a", 20, ada), message("a", 21, cy, { message_id: "m10", body: { text: "edited" } }), reaction("a", 22, "m10", ada)]));
		const move = message("b", 31, cy, { message_id: "m10", prev_room_id: "a" });
		await tier.append(toRange([message("a", 30, ada), { ...move, room_id: "a" }, move]));
		await tier.append(toRange([reaction("b", 40, "m10", ada), reaction("a", 41, "m11", cy), message("a", 42, ada)]));
		await tier.append(toRange([message("a", 50, ada)]));
		return built;
	}

	it("sweeps a purge a chunk a step, telling the messages it finds before rewriting, and rewriting only what changes", async () => {
		const { tier, store, index } = await populated(1);
		const untouched = (await index.list()).find((ref) => ref.first === 50)!;
		const { cursors, found } = await sweep(tier, { op: "purge", userIds: ["cy"], messageIds: [] });
		expect(cursors.length).toBe(4);
		expect(found).toEqual(["m10"]);
		const left = (await tier.scan(0, 100)).records;
		// cy's snapshots (the message, its edit, both copies of its move), reactions on it, and cy's own reaction set: gone.
		expect(left.map((record) => `${record.room_id}${record.log_id}`)).toEqual(["a11", "a20", "a30", "a42", "a50"]);
		expect(left.some((record) => record.record_json.includes('"cy"'))).toBe(false);
		expect((await index.list()).every((ref) => !ref.users.includes("cy"))).toBe(true);
		// The chunk naming no one of cy's was neither rewritten nor relisted.
		expect(store.calls.filter((call) => call.key === untouched.key && call.method === "writer").length).toBe(1);
		expect((await index.list()).find((ref) => ref.first === 50)).toEqual(untouched);
	});

	it("starts a purge at the first chunk naming its users, or at the oldest when it names messages", async () => {
		const { tier, store } = await populated(1);
		const gets = () => store.calls.filter((call) => call.method === "get").length;
		// dee is named nowhere: nothing to read, nothing to do.
		const before = gets();
		expect(await tier.applyOp({ op: "purge", userIds: ["dee"], messageIds: [] }, { found: async () => undefined })).toBeUndefined();
		expect(gets()).toBe(before);
		// Reactions on a message found above can be in any chunk: from the oldest, then every chunk after.
		const { cursors } = await sweep(tier, { op: "purge", userIds: [], messageIds: ["m11"] });
		expect(cursors.length).toBe(4);
		expect((await tier.scan(0, 100)).records.some((record) => record.kind === "reactions" && record.record_json.includes('"m11"'))).toBe(false);
	});

	it("resumes from its cursor, and repeats a step without harm, after a crash at any point of it", async () => {
		const clean = await populated(2);
		await sweep(clean.tier, { op: "purge", userIds: ["cy"], messageIds: [] });
		const expected = (await clean.tier.scan(0, 100)).records;
		// The index fails its next update, once: the chunk was written, its listing not.
		const crashed = await populated(2);
		const update = crashed.index.update.bind(crashed.index);
		let failures = 1;
		crashed.index.update = async (change) => {
			if (failures-- > 0) throw new Error("crash");
			return update(change);
		};
		const op: HistoryOp = { op: "purge", userIds: ["cy"], messageIds: [] };
		const found: string[] = [];
		await expect(crashed.tier.applyOp(op, { found: async (ids) => { found.push(...ids); } })).rejects.toThrow("crash");
		// The pipeline amended the op with what was found before the crash: the retry starts afresh with it.
		const amended: HistoryOp = { ...op, messageIds: found };
		let cursor = await crashed.tier.applyOp(amended, { found: async () => undefined });
		cursor = await crashed.tier.applyOp(amended, { cursor, found: async () => undefined });
		// The same step again changes nothing.
		const again = await crashed.tier.applyOp(amended, { cursor, found: async () => undefined });
		expect(again).toBe(await crashed.tier.applyOp(amended, { cursor, found: async () => undefined }));
		await sweep(crashed.tier, amended);
		expect((await crashed.tier.scan(0, 100)).records).toEqual(expected);
		expect((await crashed.index.list()).map((ref) => [ref.first, ref.records, ref.users])).toEqual((await clean.index.list()).map((ref) => [ref.first, ref.records, ref.users]));
	});

	it("renames only in the chunks naming the user", async () => {
		const { tier, store, index } = await populated(1);
		const naming = (await index.list()).filter((ref) => ref.users.includes("cy")).map((ref) => ref.key);
		const writesBefore = store.calls.filter((call) => call.method === "writer").length;
		const { cursors } = await sweep(tier, { op: "rename", from: "cy", to: "cyril" });
		expect(cursors.length).toBe(naming.length - 1);
		expect(store.calls.filter((call) => call.method === "writer").map((call) => call.key).slice(writesBefore)).toEqual(naming);
		const records = (await tier.scan(0, 100)).records;
		expect(records.some((record) => record.record_json.includes('"cy"'))).toBe(false);
		// The message, its edit, both copies of its move, and cy's reaction set.
		expect(records.filter((record) => record.record_json.includes('"cyril"')).length).toBe(5);
		expect((await index.list()).flatMap((ref) => ref.users).includes("cy")).toBe(false);
	});
});
