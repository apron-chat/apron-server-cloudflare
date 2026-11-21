import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MemoryChunkIndex } from "./support/memory-chunk-index";
import { type BlobStoreChoice, type HistoryEnv, type ChainStore, type HistoryLimits, WORKER_BLOB_STORES, blobStoreOf, buildHistoryChain, d1Off, historyLayout, layoutTiered } from "../../src/history/config";
import { MemoryBlobStore, memoryBlobStores } from "./support/memory-blob-store";
import { withStore } from "../helpers/store";

const LIMITS: HistoryLimits = { historyHotRecords: 5_000, historyMaxAgeSeconds: 0, historyD1Records: 100_000, historyColdRecords: 0, cleanupThresholdPercent: 80 };
const clock = { now: () => 0 };
const store = { head: (name: string) => ({ name }), state: () => ({}) } as unknown as ChainStore;
/** The chain for these bindings and limits, as the Worker builds it: the layout first. */
const build = (envOf: HistoryEnv, limits: HistoryLimits, options: BlobStoreChoice & { chunkIndex?: () => MemoryChunkIndex } = {}) =>
	buildHistoryChain({ layout: historyLayout(envOf, limits, options), limits, store, clock, ...(options.chunkIndex ? { chunkIndex: options.chunkIndex } : {}) });

describe("history tiers from bindings", () => {
	it("builds SQLite, then D1, then the cold tier, each where it is bound", async () => {
		const index = () => new MemoryChunkIndex();
		const names = (chain: ReturnType<typeof buildHistoryChain>) => chain?.tiers.map((tier) => tier.name);
		expect(build({}, LIMITS, { chunkIndex: index })).toBeUndefined();
		expect(names(build({ HISTORY_D1: env.HISTORY_D1 }, LIMITS, { chunkIndex: index }))).toEqual(["hot", "recent"]);
		// No count for D1 turns it off: D1 cannot keep everything.
		expect(build({ HISTORY_D1: env.HISTORY_D1 }, { ...LIMITS, historyD1Records: 0 })).toBeUndefined();
		const memory = { blobStores: memoryBlobStores(new MemoryBlobStore()), blobProvider: "memory" };
		const all = build({ HISTORY_D1: env.HISTORY_D1 }, LIMITS, { chunkIndex: index, ...memory });
		expect(names(all)).toEqual(["hot", "recent", "cold"]);
		expect(names(build({}, LIMITS, { chunkIndex: index, ...memory }))).toEqual(["hot", "cold"]);
		// The cold tier keeps everything at 0, else LIMIT_HISTORY_COLD_RECORDS.
		const kept = (historyColdRecords: number) => withStore(`history-config-cold-${historyColdRecords}`, {}, async (real) => {
			const limits = { ...LIMITS, historyColdRecords };
			const chain = buildHistoryChain({ layout: historyLayout({}, limits, memory), limits, store: real.history, clock, chunkIndex: (tier) => real.history.chunkIndex(tier) })!;
			return (await chain.stats())[1].retention.records;
		});
		expect(await kept(0)).toBeUndefined();
		expect(await kept(1_000_000)).toBe(1_000_000);
		expect(layoutTiered(historyLayout({}, LIMITS))).toBe(false);
		expect(layoutTiered(historyLayout({ HISTORY_BLOB: env.HISTORY_BLOB }, LIMITS))).toBe(true);
		expect(layoutTiered(historyLayout({}, LIMITS, memory))).toBe(true);
		// Why D1 is off: no binding, or no count to keep there.
		expect(d1Off({}, LIMITS)).toBe("unbound");
		expect(d1Off({ HISTORY_D1: env.HISTORY_D1 }, { historyD1Records: 0 })).toBe("disabled");
		expect(d1Off({ HISTORY_D1: env.HISTORY_D1 }, LIMITS)).toBeUndefined();
	});

	it("takes blob stores only from the registry it is given: the Worker's has r2 alone", () => {
		expect(Object.keys(WORKER_BLOB_STORES)).toEqual(["r2"]);
		expect(blobStoreOf({})).toBeUndefined();
		expect(blobStoreOf({ HISTORY_BLOB: env.HISTORY_BLOB })).toBeDefined();
		expect(() => blobStoreOf({}, { blobProvider: "memory" })).toThrow("no blob store provider memory is registered here (r2)");
		expect(() => build({}, LIMITS, { chunkIndex: () => new MemoryChunkIndex(), blobProvider: "fs" })).toThrow(/no blob store provider fs/);
	});
});
