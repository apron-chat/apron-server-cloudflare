/*
 * The `HISTORY` config (PLAN §13.1): one structured var composing the
 * history pipeline, parsed and validated here at startup (src/config.ts)
 * and, from wrangler.production.toml, by `npm run budget:check` before a
 * deploy (scripts/budget.mjs, wranglerHistory). Wrangler `[vars]` may be TOML tables,
 * which reach the Worker as JSON objects; a JSON string is accepted too.
 *
 *   [vars.HISTORY]
 *   schedule = { every = "1d", batch = 100, threshold_percent = 80 }
 *   alerts = { stall_after = "6h" }
 *   [[vars.HISTORY.tiers]]           # newest first; the first is SQLite
 *   name = "hot"
 *   kind = "sqlite"
 *   retention = { records = 5_000, min_age = "3d" }
 *   [[vars.HISTORY.tiers]]
 *   name = "recent"
 *   kind = "d1"
 *   binding = "HISTORY_D1"
 *   retention = { records = 100_000 }
 *   [[vars.HISTORY.tiers]]
 *   name = "cold"
 *   kind = "blob"
 *   store = { provider = "r2", binding = "HISTORY_BLOB", prefix = "history/" }
 *   [[vars.HISTORY.exports]]
 *   name = "nightly"
 *   every = "1d"
 *   store = { provider = "r2", binding = "HISTORY_BLOB", prefix = "backups/" }
 *   keep = 14
 *   encrypt = { key_secrets = ["HISTORY_BACKUP_KEY"] }
 *   [vars.HISTORY.import]
 *   users = "auto"
 *   key_secrets = ["HISTORY_BACKUP_KEY_2025"]
 *
 * Durations take "45s", "30m", "6h", "3d" (or seconds as a number); sizes
 * "512KB", "1MB", "8MiB" (or bytes). This module is pure and loads nothing
 * else of the pipeline, so Node scripts can import it.
 */

export class HistoryConfigError extends Error {
	constructor(message: string) {
		super(`HISTORY: ${message}`);
		this.name = "HistoryConfigError";
	}
}

export interface RetentionSettings {
	records?: number;
	bytes?: number;
	ageSeconds?: number;
	minAgeSeconds?: number;
	thresholdPercent?: number;
}

export type BlobStoreSettings =
	| { provider: "r2"; binding: string; prefix: string }
	| { provider: "memory"; prefix: string }
	| { provider: "fs"; directory: string; prefix: string };

export type TierSettings =
	| { name: string; kind: "sqlite"; retention: RetentionSettings }
	| { name: string; kind: "d1"; binding: string; retention: RetentionSettings }
	| {
		name: string; kind: "blob"; store: BlobStoreSettings; retention: RetentionSettings; readable: boolean;
		cacheBytes: number;
	};

export interface ExportSettings {
	name: string;
	/** How often it runs on its own; absent, only on demand (`/history export`). */
	everySeconds?: number;
	/** Whether private rooms are exported (default true). */
	privateRooms: boolean;
	store: BlobStoreSettings;
	/** The object key, with `{server}`, `{name}` and `{date}` (UTC, YYYYMMDD-HHMMSS) filled in. */
	key: string;
	keep: number;
	encrypt?: { keySecrets: string[] };
}

export interface HistorySettings {
	schedule: { everySeconds?: number; batch: number; thresholdPercent?: number };
	alerts: { stallAfterSeconds: number };
	tiers: TierSettings[];
	exports: ExportSettings[];
	import: { users: "auto" | "match" | "new"; ids: "original" | "renumber"; keySecrets: string[] };
}

/** The LIMIT_* vars the `HISTORY` config replaces: setting both is an error, so it is never ambiguous which wins. */
export const HISTORY_LIMIT_VARS = [
	"LIMIT_RETENTION_RECORDS", "LIMIT_RETENTION_SECONDS", "LIMIT_MIN_RETENTION_SECONDS", "LIMIT_ARCHIVE_RECORDS", "LIMIT_CLEANUP_THRESHOLD_PERCENT",
] as const;

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const BINDING = /^[A-Z][A-Z0-9_]*$/;
const SECRET = /^[A-Z][A-Z0-9_]*$/;
const DURATION_UNITS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400 };
const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1_000, mb: 1_000_000, gb: 1_000_000_000, kib: 1_024, mib: 1_048_576, gib: 1_073_741_824 };

type Raw = Record<string, unknown>;

function object(value: unknown, where: string): Raw {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistoryConfigError(`${where} must be a table`);
	return value as Raw;
}

function only(raw: Raw, where: string, keys: readonly string[]): void {
	for (const key of Object.keys(raw)) if (!keys.includes(key)) throw new HistoryConfigError(`${where}.${key} is not a setting`);
}

function integer(value: unknown, where: string, options: { min?: number; max?: number } = {}): number {
	const number = typeof value === "string" && value.trim() !== "" ? Number(value.replace(/_/g, "")) : value;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number < (options.min ?? 0) || number > (options.max ?? Number.MAX_SAFE_INTEGER)) {
		throw new HistoryConfigError(`${where} must be a whole number${options.min !== undefined ? ` from ${options.min}` : ""}${options.max !== undefined ? ` to ${options.max}` : ""}`);
	}
	return number;
}

/** A duration in seconds: "45s", "30m", "6h", "3d", or a number of seconds. */
export function parseDuration(value: unknown, where: string): number {
	if (typeof value === "number") return integer(value, where);
	const match = typeof value === "string" ? /^\s*(\d+)\s*([smhd])\s*$/i.exec(value) : null;
	if (!match) throw new HistoryConfigError(`${where} must be a duration such as "6h" or "3d"`);
	return Number(match[1]) * DURATION_UNITS[match[2].toLowerCase()];
}

/** A size in bytes: "512KB", "1MB", "8MiB", or a number of bytes. */
export function parseSize(value: unknown, where: string): number {
	if (typeof value === "number") return integer(value, where);
	const match = typeof value === "string" ? /^\s*(\d+(?:\.\d+)?)\s*([kmg]i?b|b)\s*$/i.exec(value) : null;
	if (!match) throw new HistoryConfigError(`${where} must be a size such as "1MB"`);
	return Math.floor(Number(match[1]) * SIZE_UNITS[match[2].toLowerCase()]);
}

function text(value: unknown, where: string, pattern?: RegExp): string {
	if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) throw new HistoryConfigError(`${where} must be ${pattern ? `a name matching ${pattern}` : "text"}`);
	return value;
}

function secrets(value: unknown, where: string): string[] {
	if (!Array.isArray(value) || !value.length) throw new HistoryConfigError(`${where} must list secret names`);
	return value.map((name, index) => text(name, `${where}[${index}]`, SECRET));
}

function retention(value: unknown, where: string): RetentionSettings {
	const raw = object(value, where);
	only(raw, where, ["records", "bytes", "age", "min_age", "threshold_percent"]);
	return {
		...(raw.records !== undefined ? { records: integer(raw.records, `${where}.records`, { min: 1 }) } : {}),
		...(raw.bytes !== undefined ? { bytes: parseSize(raw.bytes, `${where}.bytes`) } : {}),
		...(raw.age !== undefined ? { ageSeconds: parseDuration(raw.age, `${where}.age`) } : {}),
		...(raw.min_age !== undefined ? { minAgeSeconds: parseDuration(raw.min_age, `${where}.min_age`) } : {}),
		...(raw.threshold_percent !== undefined ? { thresholdPercent: integer(raw.threshold_percent, `${where}.threshold_percent`, { min: 1, max: 100 }) } : {}),
	};
}

function blobStore(value: unknown, where: string): BlobStoreSettings {
	const raw = object(value, where);
	const prefix = raw.prefix === undefined ? "" : text(raw.prefix, `${where}.prefix`);
	if (prefix && !prefix.endsWith("/")) throw new HistoryConfigError(`${where}.prefix must end in "/"`);
	switch (raw.provider) {
		case "r2":
			only(raw, where, ["provider", "binding", "prefix"]);
			return { provider: "r2", binding: text(raw.binding, `${where}.binding`, BINDING), prefix };
		case "memory":
			only(raw, where, ["provider", "prefix"]);
			return { provider: "memory", prefix };
		case "fs":
			only(raw, where, ["provider", "directory", "prefix"]);
			return { provider: "fs", directory: text(raw.directory, `${where}.directory`), prefix };
		default:
			throw new HistoryConfigError(`${where}.provider must be "r2", "memory" or "fs"`);
	}
}

function tier(value: unknown, index: number): TierSettings {
	const where = `tiers[${index}]`;
	const raw = object(value, where);
	const name = text(raw.name, `${where}.name`, NAME);
	const kept = retention(raw.retention, `${where}.retention`);
	switch (raw.kind) {
		case "sqlite":
			only(raw, where, ["name", "kind", "retention"]);
			if (kept.records === undefined && kept.ageSeconds === undefined) throw new HistoryConfigError(`${where}.retention needs records or age: SQLite cannot keep everything`);
			if (kept.bytes !== undefined) throw new HistoryConfigError(`${where}.retention.bytes is not supported for SQLite`);
			return { name, kind: "sqlite", retention: kept };
		case "d1":
			only(raw, where, ["name", "kind", "binding", "retention"]);
			if (kept.records === undefined) throw new HistoryConfigError(`${where}.retention needs records: D1 cannot keep everything`);
			if (kept.bytes !== undefined || kept.minAgeSeconds !== undefined) throw new HistoryConfigError(`${where}.retention takes records and age only`);
			return { name, kind: "d1", binding: text(raw.binding, `${where}.binding`, BINDING), retention: kept };
		case "blob": {
			only(raw, where, ["name", "kind", "store", "retention", "cache", "readable"]);
			const cache = object(raw.cache, `${where}.cache`);
			only(cache, `${where}.cache`, ["bytes"]);
			if (raw.readable !== undefined && typeof raw.readable !== "boolean") throw new HistoryConfigError(`${where}.readable must be true or false`);
			return {
				name, kind: "blob", store: blobStore(raw.store, `${where}.store`), retention: kept, readable: raw.readable !== false,
				cacheBytes: cache.bytes === undefined ? 8 * 1_048_576 : parseSize(cache.bytes, `${where}.cache.bytes`),
			};
		}
		default:
			throw new HistoryConfigError(`${where}.kind must be "sqlite", "d1" or "blob"`);
	}
}

function exported(value: unknown, index: number): ExportSettings {
	const where = `exports[${index}]`;
	const raw = object(value, where);
	only(raw, where, ["name", "every", "store", "key", "keep", "encrypt", "private_rooms"]);
	if (raw.private_rooms !== undefined && typeof raw.private_rooms !== "boolean") throw new HistoryConfigError(`${where}.private_rooms must be true or false`);
	const encrypt = raw.encrypt === undefined ? undefined : object(raw.encrypt, `${where}.encrypt`);
	if (encrypt) only(encrypt, `${where}.encrypt`, ["key_secrets"]);
	const key = raw.key === undefined ? "{server}-{name}-{date}.jsonl" : text(raw.key, `${where}.key`);
	if (!key.includes("{date}")) throw new HistoryConfigError(`${where}.key must include {date}, so exports do not overwrite each other`);
	return {
		name: text(raw.name, `${where}.name`, NAME),
		...(raw.every !== undefined ? { everySeconds: parseDuration(raw.every, `${where}.every`) } : {}),
		privateRooms: raw.private_rooms !== false,
		store: blobStore(raw.store, `${where}.store`),
		key,
		keep: raw.keep === undefined ? 14 : integer(raw.keep, `${where}.keep`, { min: 1, max: 1_000 }),
		...(encrypt ? { encrypt: { keySecrets: secrets(encrypt.key_secrets, `${where}.encrypt.key_secrets`) } } : {}),
	};
}

/** Parses and validates a `HISTORY` var (a table, or JSON text). */
export function parseHistorySettings(value: unknown): HistorySettings {
	let raw: unknown = value;
	if (typeof value === "string") {
		try {
			raw = JSON.parse(value);
		} catch {
			throw new HistoryConfigError("must be a TOML table or JSON");
		}
	}
	const root = object(raw, "HISTORY");
	only(root, "HISTORY", ["schedule", "alerts", "tiers", "exports", "import"]);
	const schedule = object(root.schedule, "schedule");
	only(schedule, "schedule", ["every", "batch", "threshold_percent"]);
	const alerts = object(root.alerts, "alerts");
	only(alerts, "alerts", ["stall_after"]);
	const imports = object(root.import, "import");
	only(imports, "import", ["users", "ids", "key_secrets"]);
	if (!Array.isArray(root.tiers) || !root.tiers.length) throw new HistoryConfigError("tiers must list at least the SQLite tier");
	const tiers = root.tiers.map(tier);
	if (tiers[0].kind !== "sqlite") throw new HistoryConfigError("tiers[0] must be the SQLite tier (kind = \"sqlite\")");
	if (tiers.slice(1).some((entry) => entry.kind === "sqlite")) throw new HistoryConfigError("only the first tier may be SQLite");
	const names = new Set<string>();
	for (const entry of tiers) {
		if (names.has(entry.name)) throw new HistoryConfigError(`two tiers are named ${entry.name}`);
		names.add(entry.name);
	}
	if (tiers.filter((entry) => entry.kind === "d1").length > 1) throw new HistoryConfigError("at most one D1 tier");
	const exports = Array.isArray(root.exports) ? root.exports.map(exported) : root.exports === undefined ? [] : (() => { throw new HistoryConfigError("exports must be a list"); })();
	const exportNames = new Set<string>();
	for (const entry of exports) {
		if (exportNames.has(entry.name)) throw new HistoryConfigError(`two exports are named ${entry.name}`);
		exportNames.add(entry.name);
	}
	const users = imports.users ?? "auto";
	if (users !== "auto" && users !== "match" && users !== "new") throw new HistoryConfigError("import.users must be \"auto\", \"match\" or \"new\"");
	const ids = imports.ids ?? "original";
	if (ids !== "original" && ids !== "renumber") throw new HistoryConfigError("import.ids must be \"original\" or \"renumber\"");
	return {
		schedule: {
			...(schedule.every !== undefined ? { everySeconds: parseDuration(schedule.every, "schedule.every") } : {}),
			batch: schedule.batch === undefined ? 100 : integer(schedule.batch, "schedule.batch", { min: 1, max: 100 }),
			...(schedule.threshold_percent !== undefined ? { thresholdPercent: integer(schedule.threshold_percent, "schedule.threshold_percent", { min: 1, max: 100 }) } : {}),
		},
		alerts: { stallAfterSeconds: alerts.stall_after === undefined ? 6 * 3_600 : parseDuration(alerts.stall_after, "alerts.stall_after") },
		tiers,
		exports,
		import: { users, ids, keySecrets: imports.key_secrets === undefined ? [] : secrets(imports.key_secrets, "import.key_secrets") },
	};
}

/** Every backup key secret a config names: those exports encrypt with, then those kept only for reading old backups (§13.3). */
export function backupKeyNames(settings: HistorySettings): string[] {
	return [...new Set([...settings.exports.flatMap((entry) => entry.encrypt?.keySecrets ?? []), ...settings.import.keySecrets])];
}

/**
 * The limits a `HISTORY` config sets, in the LIMIT_* terms the Store and
 * /status use: SQLite's retention, the D1 tier's count, the threshold, and
 * the cleanup interval.
 */
export function historyLimits(settings: HistorySettings): { retentionRecords: number; retentionSeconds: number; minRetentionSeconds?: number; archiveRecords: number; cleanupThresholdPercent?: number; cleanupSeconds?: number } {
	const head = settings.tiers[0].retention;
	const d1 = settings.tiers.find((entry) => entry.kind === "d1");
	const threshold = settings.schedule.thresholdPercent ?? head.thresholdPercent;
	return {
		retentionRecords: head.records ?? 0,
		retentionSeconds: head.ageSeconds ?? 0,
		...(head.minAgeSeconds !== undefined ? { minRetentionSeconds: head.minAgeSeconds } : {}),
		archiveRecords: d1?.retention.records ?? 0,
		...(threshold !== undefined ? { cleanupThresholdPercent: threshold } : {}),
		...(settings.schedule.everySeconds !== undefined ? { cleanupSeconds: settings.schedule.everySeconds } : {}),
	};
}
