/*
 * Backups (PLAN §13.2): full ARCHIVE.md exports written to the history blob
 * store (HISTORY_BLOB) under `backups/`, encrypted where
 * BACKUP_ENCRYPTION_KEY_NAME names a secret (§13.3), keeping the newest
 * BACKUP_KEEP of each kind: `scheduled` (every BACKUP_EVERY) and `manual`
 * (an admin's `/history export`), on the same settings (src/config.ts).
 * The export streams into the store's writer (R2: a multipart upload), so
 * it is never held whole in memory; a failure aborts the upload, leaving
 * nothing behind.
 */

import { type ArchiveHeader, jsonlWriter } from "@apron/archive";
import { type BackupKeys, encryptArchive } from "@apron/archive/crypto";
import { type ExportOptions, type ExportReport, exportArchive } from "./archive/export";
import type { BlobStore } from "./blob/store";
import type { HistoryPipeline } from "./pipeline";
import type { Clock } from "./records";

/** The backup settings (the BACKUP_* and IMPORT_PLAINTEXT vars, parsed by src/config.ts). */
export interface BackupSettings {
	/** How often the scheduled backup runs, in seconds; undefined: on demand only (`/history export`). */
	everySeconds?: number;
	/** How many backup files of each kind are kept, newest first. */
	keep: number;
	/** Whether private rooms are backed up. */
	privateRooms: boolean;
	/** The secret the backup key is derived from; undefined: backups are not encrypted. */
	encryptionKeyName?: string;
	/** Older secrets, only for reading backups made before a rotation. */
	previousKeyNames: readonly string[];
	/** Whether `/history import` takes a file that is not encrypted. */
	importPlaintext: boolean;
}

/** A scheduled backup, or one an admin asked for. */
export type BackupKind = "scheduled" | "manual";

/** Where backups live in the history blob store. */
export const BACKUP_PREFIX = "backups/";

/** Every backup key secret the settings name: the one backups are encrypted with, then those kept for reading old ones (§13.3). */
export function backupKeyNames(settings: Pick<BackupSettings, "encryptionKeyName" | "previousKeyNames">): string[] {
	return [...new Set([...(settings.encryptionKeyName ? [settings.encryptionKeyName] : []), ...settings.previousKeyNames])];
}

/** `2026-11-19T17:30:05.123Z` → `20261119-173005`: sorts in time order. */
export function exportStamp(now: number): string {
	return new Date(now).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

/** A backup's object key: `backups/<server>-<kind>-<date>.jsonl`, `.enc` added when encrypted. */
export function backupKey(settings: Pick<BackupSettings, "encryptionKeyName">, kind: BackupKind, server: string, now: number): string {
	return `${BACKUP_PREFIX}${server}-${kind}-${exportStamp(now)}.jsonl${settings.encryptionKeyName ? ".enc" : ""}`;
}

/**
 * One kind's backups: the prefix to list, and the pattern their keys match
 * whole (encrypted or not), so the other kind, another server's, or
 * anything else under `backups/` is never taken for one.
 */
export function backupFamily(kind: BackupKind, server: string): { prefix: string; pattern: RegExp } {
	const prefix = `${BACKUP_PREFIX}${server}-${kind}-`;
	const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return { prefix, pattern: new RegExp(`^${escaped}\\d{8}-\\d{6}\\.jsonl(?:\\.enc)?$`) };
}

export interface BackupResult extends ExportReport {
	key: string;
	deleted: string[];
}

/**
 * Writes one backup of the whole pipeline to `store`, then deletes this
 * kind's backups past the newest `keep`. With an encryption key name, that
 * secret's key encrypts it; a missing secret fails before anything is
 * written (never a plain backup instead), as does a backup of this kind
 * made in the same second (its key).
 */
export async function writeBackup(pipeline: HistoryPipeline, store: BlobStore, settings: BackupSettings, kind: BackupKind, options: { server: string; clock: Clock; keys?: Pick<BackupKeys, "lookup">; roomIds?: string[]; header?: Partial<ArchiveHeader>; prepare?: ExportOptions["prepare"] }): Promise<BackupResult> {
	const now = options.clock.now();
	const key = backupKey(settings, kind, options.server, now);
	let encryptWith: { name: string; key: CryptoKey; fingerprint: string } | undefined;
	if (settings.encryptionKeyName) {
		const name = settings.encryptionKeyName;
		const found = await options.keys?.lookup(name);
		if (!found) throw new Error(`backups are encrypted with ${name} (BACKUP_ENCRYPTION_KEY_NAME), which is not set: set it with \`wrangler secret put ${name}\``);
		encryptWith = { name, ...found };
	}
	// Keys are to the second: a second backup within it would replace the first.
	if ((await store.list(key, { limit: 1 })).keys.some((entry) => entry.key === key)) {
		throw new Error(`the backup ${key} exists already (another backup this second): try again in a moment`);
	}
	const writer = await store.writer(key, { contentType: encryptWith ? "application/octet-stream" : "application/jsonl" });
	let report: ExportReport;
	try {
		const plain = async (line: string) => writer.write(line.endsWith("\n") ? line : `${line}\n`);
		const sink = encryptWith ? encryptArchive(plain, encryptWith) : undefined;
		report = await exportArchive(pipeline, jsonlWriter(sink ?? plain), {
			clock: options.clock, header: { server: options.server, ...options.header }, ...(options.roomIds ? { roomIds: options.roomIds } : {}),
			privateRooms: settings.privateRooms,
			...(options.prepare ? { prepare: options.prepare } : {}),
		});
		await sink?.close();
		await writer.close();
	} catch (error) {
		await writer.abort().catch(() => undefined);
		throw error;
	}
	// The newest `keep` of this kind's backups stay; keys sort by date.
	const family = backupFamily(kind, options.server);
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await store.list(family.prefix, { limit: 1_000, ...(cursor ? { cursor } : {}) });
		keys.push(...page.keys.map((entry) => entry.key).filter((entry) => family.pattern.test(entry)));
		cursor = page.cursor;
	} while (cursor);
	keys.sort();
	const deleted = keys.length > settings.keep ? keys.slice(0, keys.length - settings.keep) : [];
	if (deleted.length) await store.delete(deleted);
	return { ...report, key, deleted };
}
