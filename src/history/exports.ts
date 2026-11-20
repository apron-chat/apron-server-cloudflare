/*
 * Backups (PLAN §13.2): full ARCHIVE.md exports written to the history blob
 * store (HISTORY_BLOB) under `backups/`, keeping the newest BACKUP_KEEP of
 * each kind: `scheduled` (every BACKUP_EVERY) and `manual` (an admin's
 * `/history export`), on the same settings (src/config.ts).
 *
 * A backup goes through BACKUP_CODECS (@apron/archive codecs: gzip) on its
 * way to the store, and is named for them (`.jsonl.gz`) and records them in
 * its metadata (`codecs`), so an import knows how to read it back. Backups
 * are not encrypted: what keeps them private is the bucket. Encryption can
 * be added later as a codec after gzip in BACKUP_CODECS (a TransformStream
 * pair, composed with pipeThrough); an authenticating one would also make
 * imports of this server's own backups verified (`users match`).
 *
 * The export streams into the store's writer (R2: a multipart upload), so
 * it is never held whole in memory; a failure aborts the upload, leaving
 * nothing behind.
 */

import { type ArchiveCodec, type ArchiveHeader, archiveName, codecNames, encodedArchiveWriter, gzip } from "@apron/archive";
import { type ExportOptions, type ExportReport, exportArchive } from "./archive/export";
import type { BlobStore } from "./blob/store";
import type { HistoryPipeline } from "./pipeline";
import type { Clock } from "./records";

/** The backup settings (the BACKUP_* vars, parsed by src/config.ts). */
export interface BackupSettings {
	/** How often the scheduled backup runs, in seconds; undefined: on demand only (`/history export`). */
	everySeconds?: number;
	/** How many backup files of each kind are kept, newest first. */
	keep: number;
	/** Whether private rooms are backed up. */
	privateRooms: boolean;
}

/** A scheduled backup, or one an admin asked for. */
export type BackupKind = "scheduled" | "manual";

/** Where backups live in the history blob store. */
export const BACKUP_PREFIX = "backups/";

/** The codecs every backup goes through, in order. */
export const BACKUP_CODECS: readonly ArchiveCodec[] = [gzip];

/** The metadata key a stored archive's codec chain is recorded under (comma-separated names, in encoding order). */
export const CODECS_METADATA = "codecs";

/** `2026-11-19T17:30:05.123Z` → `20261119-173005`: sorts in time order. */
export function exportStamp(now: number): string {
	return new Date(now).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

/** A backup's object key: `backups/<server>-<kind>-<date>.jsonl.gz` (with BACKUP_CODECS' extensions). */
export function backupKey(kind: BackupKind, server: string, now: number): string {
	return archiveName(`${BACKUP_PREFIX}${server}-${kind}-${exportStamp(now)}`, BACKUP_CODECS);
}

/**
 * One kind's backups: the prefix to list, and the pattern their keys match
 * whole (`.jsonl`, compressed or not), so the other kind, another server's,
 * or anything else under `backups/` is never taken for one.
 */
export function backupFamily(kind: BackupKind, server: string): { prefix: string; pattern: RegExp } {
	const prefix = `${BACKUP_PREFIX}${server}-${kind}-`;
	const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return { prefix, pattern: new RegExp(`^${escaped}\\d{8}-\\d{6}\\.jsonl(?:\\.gz)?$`) };
}

export interface BackupResult extends ExportReport {
	key: string;
	deleted: string[];
}

/**
 * Writes one backup of the whole pipeline to `store`, through
 * BACKUP_CODECS, then deletes this kind's backups past the newest `keep`.
 * A backup of this kind made in the same second (its key) fails it.
 */
export async function writeBackup(pipeline: HistoryPipeline, store: BlobStore, settings: BackupSettings, kind: BackupKind, options: { server: string; clock: Clock; roomIds?: string[]; header?: Partial<ArchiveHeader>; prepare?: ExportOptions["prepare"] }): Promise<BackupResult> {
	const now = options.clock.now();
	const key = backupKey(kind, options.server, now);
	// Keys are to the second: a second backup within it would replace the first.
	if ((await store.list(key, { limit: 1 })).keys.some((entry) => entry.key === key)) {
		throw new Error(`the backup ${key} exists already (another backup this second): try again in a moment`);
	}
	const writer = await store.writer(key, { contentType: "application/gzip", metadata: { [CODECS_METADATA]: codecNames(BACKUP_CODECS) } });
	const archive = encodedArchiveWriter((bytes) => writer.write(bytes), BACKUP_CODECS);
	let report: ExportReport;
	try {
		report = await exportArchive(pipeline, archive, {
			clock: options.clock, header: { server: options.server, ...options.header }, ...(options.roomIds ? { roomIds: options.roomIds } : {}),
			privateRooms: settings.privateRooms,
			...(options.prepare ? { prepare: options.prepare } : {}),
		});
		await writer.close();
	} catch (error) {
		await archive.abort(error);
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
