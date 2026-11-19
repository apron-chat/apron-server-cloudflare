import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { backupKeyNames, historyLimits, parseDuration, parseHistorySettings, parseSize } from "../../src/history/settings";

const full = {
	schedule: { every: "1d", batch: 50, threshold_percent: 80 },
	alerts: { stall_after: "6h" },
	tiers: [
		{ name: "hot", kind: "sqlite", retention: { records: 5_000, min_age: "3d" } },
		{ name: "recent", kind: "d1", binding: "HISTORY_D1", retention: { records: 100_000 } },
		{ name: "cold", kind: "blob", store: { provider: "r2", binding: "HISTORY_BLOB", prefix: "history/" }, retention: {}, segments: { records: 1_000, bytes: "1MB", compact: "final" }, cache: { bytes: "8MiB" } },
	],
	exports: [{ name: "nightly", every: "1d", store: { provider: "r2", binding: "HISTORY_BLOB", prefix: "backups/" }, keep: 14, encrypt: { key_secrets: ["HISTORY_BACKUP_KEY"] } }],
	import: { users: "auto", key_secrets: ["HISTORY_BACKUP_KEY_OLD"] },
};

describe("HISTORY settings", () => {
	it("parses durations and sizes", () => {
		expect([parseDuration("45s", "x"), parseDuration("30m", "x"), parseDuration("6h", "x"), parseDuration("3d", "x"), parseDuration(90, "x")]).toEqual([45, 1_800, 21_600, 259_200, 90]);
		expect([parseSize("512KB", "x"), parseSize("1MB", "x"), parseSize("8MiB", "x"), parseSize(10, "x")]).toEqual([512_000, 1_000_000, 8_388_608, 10]);
		expect(() => parseDuration("3 weeks", "x")).toThrow(/duration/);
		expect(() => parseSize("big", "x")).toThrow(/size/);
	});

	it("parses a full config, from a table or JSON text", () => {
		const settings = parseHistorySettings(full);
		expect(parseHistorySettings(JSON.stringify(full))).toEqual(settings);
		expect(settings.tiers.map((tier) => `${tier.name}:${tier.kind}`)).toEqual(["hot:sqlite", "recent:d1", "cold:blob"]);
		expect(settings.tiers[2]).toMatchObject({ readable: true, segments: { records: 1_000, bytes: 1_000_000, compact: true }, cacheBytes: 8_388_608, store: { provider: "r2", binding: "HISTORY_BLOB", prefix: "history/" } });
		expect(settings.exports[0]).toMatchObject({ name: "nightly", everySeconds: 86_400, keep: 14, compact: true, key: "{server}-{name}-{date}.jsonl", encrypt: { keySecrets: ["HISTORY_BACKUP_KEY"] } });
		expect(settings.alerts.stallAfterSeconds).toBe(21_600);
		expect(backupKeyNames(settings)).toEqual(["HISTORY_BACKUP_KEY", "HISTORY_BACKUP_KEY_OLD"]);
		expect(historyLimits(settings)).toEqual({ retentionRecords: 5_000, retentionSeconds: 0, minRetentionSeconds: 259_200, archiveRecords: 100_000, cleanupThresholdPercent: 80, cleanupSeconds: 86_400 });
	});

	it("refuses what it cannot build, naming the setting", () => {
		const bad = (change: (config: typeof full) => unknown) => () => parseHistorySettings(change(structuredClone(full)));
		expect(bad((config) => ({ ...config, tiers: config.tiers.slice(1) }))).toThrow(/tiers\[0\] must be the SQLite tier/);
		expect(bad((config) => ({ ...config, tiers: [config.tiers[0], config.tiers[0]] }))).toThrow(/only the first tier may be SQLite/);
		expect(bad((config) => ({ ...config, tiers: [config.tiers[0], { ...config.tiers[1], retention: {} }] }))).toThrow(/D1 cannot keep everything/);
		expect(bad((config) => ({ ...config, tiers: [{ ...config.tiers[0], retention: {} }] }))).toThrow(/SQLite cannot keep everything/);
		expect(bad((config) => ({ ...config, tiers: [config.tiers[0], { ...config.tiers[2], store: { provider: "s3" } }] }))).toThrow(/provider/);
		expect(bad((config) => ({ ...config, tiers: [config.tiers[0], { ...config.tiers[1], name: "hot" }] }))).toThrow(/two tiers are named hot/);
		expect(bad((config) => ({ ...config, extra: true }))).toThrow(/HISTORY.extra is not a setting/);
		expect(bad((config) => ({ ...config, exports: [{ ...config.exports[0], key: "backup.jsonl" }] }))).toThrow(/\{date\}/);
		expect(bad((config) => ({ ...config, exports: [{ ...config.exports[0], encrypt: { key_secrets: ["lower"] } }] }))).toThrow(/key_secrets\[0\]/);
		expect(() => parseHistorySettings("{not json")).toThrow(/TOML table or JSON/);
	});

	it("sets history's limits at startup, and refuses LIMIT_* vars for them too", () => {
		const config = loadConfig({ NODE_ENV: "test", HISTORY: JSON.stringify(full) } as never);
		expect(config.history?.tiers.length).toBe(3);
		expect(config.limits).toMatchObject({ retentionRecords: 5_000, minRetentionSeconds: 259_200, archiveRecords: 100_000, cleanupThresholdPercent: 80 });
		expect(() => loadConfig({ NODE_ENV: "test", HISTORY: JSON.stringify(full), LIMIT_RETENTION_RECORDS: "10" } as never)).toThrow(/remove LIMIT_RETENTION_RECORDS/);
		expect(() => loadConfig({ NODE_ENV: "test", HISTORY: JSON.stringify({ tiers: [] }) } as never)).toThrow(/HISTORY: tiers/);
	});
});
