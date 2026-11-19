import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config";
import { MemorySegmentIndex } from "../../src/history/blob/segments";
import { type HistoryLimits, WORKER_BLOB_STORES, blobStoreOf, buildHistoryPipeline, hasLowerTiers } from "../../src/history/config";
import { backupKeyNames } from "../../src/history/exports";
import type { StorePort } from "../../src/history/store-head";
import { MemoryBlobStore, memoryBlobStores } from "./support/memory-blob-store";

const LIMITS: HistoryLimits = { retentionRecords: 5_000, retentionSeconds: 0, minRetentionSeconds: 0, historyD1Records: 100_000, historyBlobRecords: 0, cleanupThresholdPercent: 80 };
const clock = { now: () => 0 };
const store = {} as StorePort;

describe("history tiers from bindings", () => {
	it("builds SQLite, then D1, then the blob tier, each where it is bound", async () => {
		const index = () => new MemorySegmentIndex();
		const names = (pipeline: ReturnType<typeof buildHistoryPipeline>) => pipeline?.tiers.map((tier) => tier.name);
		expect(buildHistoryPipeline({ env: {}, limits: LIMITS, store, clock, segmentIndex: index })).toBeUndefined();
		expect(names(buildHistoryPipeline({ env: { HISTORY_D1: env.HISTORY_D1 }, limits: LIMITS, store, clock, segmentIndex: index }))).toEqual(["hot", "recent"]);
		// No count for D1 turns it off: D1 cannot keep everything.
		expect(buildHistoryPipeline({ env: { HISTORY_D1: env.HISTORY_D1 }, limits: { ...LIMITS, historyD1Records: 0 }, store, clock })).toBeUndefined();
		const memory = { blobStores: memoryBlobStores(new MemoryBlobStore()), blobProvider: "memory" };
		const all = buildHistoryPipeline({ env: { HISTORY_D1: env.HISTORY_D1 }, limits: LIMITS, store, clock, segmentIndex: index, ...memory });
		expect(names(all)).toEqual(["hot", "recent", "cold"]);
		expect(names(buildHistoryPipeline({ env: {}, limits: LIMITS, store, clock, segmentIndex: index, ...memory }))).toEqual(["hot", "cold"]);
		// The blob tier keeps everything at 0, else LIMIT_HISTORY_BLOB_RECORDS.
		const kept = async (historyBlobRecords: number) => {
			const pipeline = buildHistoryPipeline({ env: {}, limits: { ...LIMITS, historyBlobRecords }, store, clock, segmentIndex: index, ...memory })!;
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
		expect(() => buildHistoryPipeline({ env: {}, limits: LIMITS, store, clock, segmentIndex: () => new MemorySegmentIndex(), blobProvider: "fs" })).toThrow(/no blob store provider fs/);
	});
});

describe("backup vars", () => {
	const config = (vars: Record<string, string> = {}) => loadConfig({ NODE_ENV: "test", ...vars } as never);

	it("default to backups on demand, 14 kept, private rooms included, unencrypted, plain imports taken", () => {
		expect(config().backups).toEqual({ keep: 14, privateRooms: true, previousKeyNames: [], importPlaintext: true });
		expect(config({ BACKUP_EVERY: "", BACKUP_ENCRYPTION_KEY_NAME: "" }).backups).toEqual(config().backups);
	});

	it("parse a schedule, a count, the private rooms switch and key names", () => {
		const backups = config({
			BACKUP_EVERY: "6h", BACKUP_KEEP: "3", BACKUP_PRIVATE_ROOMS: "false",
			BACKUP_ENCRYPTION_KEY_NAME: "HISTORY_BACKUP_KEY", BACKUP_PREVIOUS_KEY_NAMES: "OLD_KEY, OLDER_KEY,HISTORY_BACKUP_KEY",
		}).backups;
		expect(backups).toEqual({
			everySeconds: 21_600, keep: 3, privateRooms: false, encryptionKeyName: "HISTORY_BACKUP_KEY",
			previousKeyNames: ["OLD_KEY", "OLDER_KEY", "HISTORY_BACKUP_KEY"], importPlaintext: false,
		});
		expect(backupKeyNames(backups)).toEqual(["HISTORY_BACKUP_KEY", "OLD_KEY", "OLDER_KEY"]);
		expect(["45s", "30m", "1d"].map((every) => config({ BACKUP_EVERY: every }).backups.everySeconds)).toEqual([45, 1_800, 86_400]);
	});

	it("import only encrypted files where backups are encrypted, unless IMPORT_PLAINTEXT says otherwise", () => {
		expect(config({ BACKUP_ENCRYPTION_KEY_NAME: "K" }).backups.importPlaintext).toBe(false);
		expect(config({ BACKUP_ENCRYPTION_KEY_NAME: "K", IMPORT_PLAINTEXT: "true" }).backups.importPlaintext).toBe(true);
		expect(config({ IMPORT_PLAINTEXT: "false" }).backups.importPlaintext).toBe(false);
	});

	it("refuse what they cannot use, naming the var", () => {
		for (const [vars, message] of [
			[{ BACKUP_EVERY: "1 week" }, /BACKUP_EVERY must be a duration/],
			[{ BACKUP_EVERY: "0h" }, /BACKUP_EVERY must be a duration/],
			[{ BACKUP_KEEP: "0" }, /BACKUP_KEEP must be a whole number from 1 to 1000/],
			[{ BACKUP_KEEP: "many" }, /BACKUP_KEEP/],
			[{ BACKUP_PRIVATE_ROOMS: "no" }, /BACKUP_PRIVATE_ROOMS must be true or false/],
			[{ IMPORT_PLAINTEXT: "yes" }, /IMPORT_PLAINTEXT must be true or false/],
			[{ BACKUP_ENCRYPTION_KEY_NAME: "lower" }, /BACKUP_ENCRYPTION_KEY_NAME must name secrets/],
			[{ BACKUP_PREVIOUS_KEY_NAMES: "OK,not-ok" }, /BACKUP_PREVIOUS_KEY_NAMES must name secrets/],
		] as const) {
			expect(() => config(vars), JSON.stringify(vars)).toThrow(ConfigError);
			expect(() => config(vars), JSON.stringify(vars)).toThrow(message);
		}
	});
});

it("refuses a leftover HISTORY table rather than ignore it", async () => {
	const { loadConfig } = await import("../../src/config");
	expect(() => loadConfig({ NODE_ENV: "test", HISTORY: "{}" } as never)).toThrow(/HISTORY is no longer read/);
});
