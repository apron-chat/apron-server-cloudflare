import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config";
import { MemoryChunkIndex } from "./support/memory-chunk-index";
import { type HistoryLimits, WORKER_BLOB_STORES, blobStoreOf, buildHistoryPipeline, hasLowerTiers } from "../../src/history/config";
import type { StorePort } from "../../src/history/store-head";
import { MemoryBlobStore, memoryBlobStores } from "./support/memory-blob-store";

const LIMITS: HistoryLimits = { retentionRecords: 5_000, retentionSeconds: 0, minRetentionSeconds: 0, historyD1Records: 100_000, historyColdRecords: 0, cleanupThresholdPercent: 80 };
const clock = { now: () => 0 };
const store = {} as StorePort;

describe("history tiers from bindings", () => {
	it("builds SQLite, then D1, then the cold tier, each where it is bound", async () => {
		const index = () => new MemoryChunkIndex();
		const names = (pipeline: ReturnType<typeof buildHistoryPipeline>) => pipeline?.tiers.map((tier) => tier.name);
		expect(buildHistoryPipeline({ env: {}, limits: LIMITS, store, clock, chunkIndex: index })).toBeUndefined();
		expect(names(buildHistoryPipeline({ env: { HISTORY_D1: env.HISTORY_D1 }, limits: LIMITS, store, clock, chunkIndex: index }))).toEqual(["hot", "recent"]);
		// No count for D1 turns it off: D1 cannot keep everything.
		expect(buildHistoryPipeline({ env: { HISTORY_D1: env.HISTORY_D1 }, limits: { ...LIMITS, historyD1Records: 0 }, store, clock })).toBeUndefined();
		const memory = { blobStores: memoryBlobStores(new MemoryBlobStore()), blobProvider: "memory" };
		const all = buildHistoryPipeline({ env: { HISTORY_D1: env.HISTORY_D1 }, limits: LIMITS, store, clock, chunkIndex: index, ...memory });
		expect(names(all)).toEqual(["hot", "recent", "cold"]);
		expect(names(buildHistoryPipeline({ env: {}, limits: LIMITS, store, clock, chunkIndex: index, ...memory }))).toEqual(["hot", "cold"]);
		// The cold tier keeps everything at 0, else LIMIT_HISTORY_COLD_RECORDS.
		const kept = async (historyColdRecords: number) => {
			const pipeline = buildHistoryPipeline({ env: {}, limits: { ...LIMITS, historyColdRecords }, store, clock, chunkIndex: index, ...memory })!;
			return (pipeline as unknown as { retentions: Array<{ records?: number }> }).retentions[1].records;
		};
		expect(await kept(0)).toBeUndefined();
		expect(await kept(1_000_000)).toBe(1_000_000);
		expect(hasLowerTiers({}, LIMITS)).toBe(false);
		expect(hasLowerTiers({ HISTORY_BLOB: env.HISTORY_BLOB }, LIMITS)).toBe(true);
		expect(hasLowerTiers({}, LIMITS, memory)).toBe(true);
	});

	it("takes blob stores only from the registry it is given: the Worker's has r2 alone", () => {
		expect(Object.keys(WORKER_BLOB_STORES)).toEqual(["r2"]);
		expect(blobStoreOf({})).toBeUndefined();
		expect(blobStoreOf({ HISTORY_BLOB: env.HISTORY_BLOB })).toBeDefined();
		expect(() => blobStoreOf({}, { blobProvider: "memory" })).toThrow("no blob store provider memory is registered here (r2)");
		expect(() => buildHistoryPipeline({ env: {}, limits: LIMITS, store, clock, chunkIndex: () => new MemoryChunkIndex(), blobProvider: "fs" })).toThrow(/no blob store provider fs/);
	});
});

describe("backup vars", () => {
	const config = (vars: Record<string, string> = {}) => loadConfig({ NODE_ENV: "test", ...vars } as never);

	it("default to backups on demand, 14 kept, private rooms included", () => {
		expect(config().backups).toEqual({ keep: 14, privateRooms: true });
		expect(config({ BACKUP_EVERY: "" }).backups).toEqual(config().backups);
	});

	it("parse a schedule, a count and the private rooms switch", () => {
		const backups = config({ BACKUP_EVERY: "6h", BACKUP_KEEP: "3", BACKUP_PRIVATE_ROOMS: "false" }).backups;
		expect(backups).toEqual({ everySeconds: 21_600, keep: 3, privateRooms: false });
		expect(["45s", "30m", "1d"].map((every) => config({ BACKUP_EVERY: every }).backups.everySeconds)).toEqual([45, 1_800, 86_400]);
	});

	it("refuse what they cannot use, naming the var", () => {
		for (const [vars, message] of [
			[{ BACKUP_EVERY: "1 week" }, /BACKUP_EVERY must be a duration/],
			[{ BACKUP_EVERY: "0h" }, /BACKUP_EVERY must be a duration/],
			[{ BACKUP_KEEP: "0" }, /BACKUP_KEEP must be a whole number from 1 to 1000/],
			[{ BACKUP_KEEP: "many" }, /BACKUP_KEEP/],
			[{ BACKUP_PRIVATE_ROOMS: "no" }, /BACKUP_PRIVATE_ROOMS must be true or false/],
		] as const) {
			expect(() => config(vars), JSON.stringify(vars)).toThrow(ConfigError);
			expect(() => config(vars), JSON.stringify(vars)).toThrow(message);
		}
	});
});
