/*
 * Backups: full ARCHIVE.md exports written to the history blob
 * store (HISTORY_BLOB) under `backups/`, keeping the newest BACKUP_KEEP of
 * each kind: `scheduled` (every BACKUP_EVERY) and `manual` (an admin's
 * `/history export`), on the same settings (src/config.ts).
 *
 * A backup goes through the codec chain it is given (history/config.ts,
 * HISTORY_CODECS) on its way to the store, and is named for it (`.jsonl`
 * and each codec's extension) and records it in its metadata
 * (storage/encoding.ts), so an import knows how to read it back. What the
 * chain does to the bytes is its own; an authenticating codec in it would
 * also make imports of this server's own backups verified (`users match`).
 *
 * The export streams into the store's writer (R2: a multipart upload), so
 * it is never held whole in memory; a failure aborts the upload, leaving
 * nothing behind.
 */

import { ARCHIVE_CODECS, type ArchiveCodec, type ArchiveHeader, archiveName, encodedArchiveWriter } from "@apron/archive";
import { type ExportOptions, type ExportReport, exportArchive } from "./archive/export";
import type { HistoryPipeline } from "./pipeline";
import type { Clock } from "./records";
import type { ExportPort } from "./tier";
import { storedOptions } from "./storage/encoding";
import type { BlobStore } from "./storage/store";

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

/** `2026-11-19T17:30:05.123Z` → `20261119-173005`: sorts in time order. */
export function exportStamp(now: number): string {
	return new Date(now).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

/** A backup's object key: `backups/<server>-<kind>-<date>.jsonl`, with the codecs' extensions. */
export function backupKey(kind: BackupKind, server: string, now: number, codecs: readonly ArchiveCodec[]): string {
	return archiveName(`${BACKUP_PREFIX}${server}-${kind}-${exportStamp(now)}`, codecs);
}

/**
 * One kind's backups: the prefix to list, and the pattern their keys match
 * whole (`.jsonl`, with known codecs' extensions), so the other kind,
 * another server's, or anything else under `backups/` is never taken for one.
 */
export function backupFamily(kind: BackupKind, server: string, registry: Readonly<Record<string, ArchiveCodec>> = ARCHIVE_CODECS): { prefix: string; pattern: RegExp } {
	const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const prefix = `${BACKUP_PREFIX}${server}-${kind}-`;
	const extensions = Object.values(registry).map((codec) => escape(codec.extension)).join("|");
	return { prefix, pattern: new RegExp(`^${escape(prefix)}\\d{8}-\\d{6}\\.jsonl${extensions ? `(?:${extensions})*` : ""}$`) };
}

export interface BackupResult extends ExportReport {
	key: string;
	deleted: string[];
}

/**
 * Writes one backup of the whole pipeline to `store`, through `codecs`,
 * then deletes this kind's backups past the newest `keep`.
 * A backup of this kind made in the same second (its key) fails it.
 */
export async function writeBackup(pipeline: HistoryPipeline, server: ExportPort, store: BlobStore, settings: BackupSettings, kind: BackupKind, options: { server: string; clock: Clock; codecs: readonly ArchiveCodec[]; roomIds?: string[]; header?: Partial<ArchiveHeader>; prepare?: ExportOptions["prepare"] }): Promise<BackupResult> {
	const now = options.clock.now();
	const key = backupKey(kind, options.server, now, options.codecs);
	// Keys are to the second: a second backup within it would replace the first.
	if ((await store.list(key, { limit: 1 })).keys.some((entry) => entry.key === key)) {
		throw new Error(`the backup ${key} exists already (another backup this second): try again in a moment`);
	}
	const writer = await store.writer(key, storedOptions(options.codecs));
	const archive = encodedArchiveWriter((bytes) => writer.write(bytes), options.codecs);
	let report: ExportReport;
	try {
		report = await exportArchive(pipeline, server, archive, {
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
