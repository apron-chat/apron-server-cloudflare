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

import { ARCHIVE_CODECS, type ArchiveCodec, type ArchiveHeader, type ArchiveWriter, archiveName, encodedArchiveWriter, type OpenedArchive, readEncodedArchive } from "@apron/archive";
import { type ExportOptions, type ExportReport, exportArchive } from "./archive/export";
import type { HistoryPipeline } from "./pipeline";
import type { Clock } from "./records";
import type { ExportPort } from "./tier";
import { storedChain, storedOptions } from "./storage/encoding";
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
 * Backups in a blob store: written through the codec chain this store is
 * made with (history/config.ts HISTORY_CODECS), named and recorded for it,
 * and read back through what each records. Callers name kinds and keys,
 * never codecs or content types.
 */
export class BackupStore {
	constructor(private readonly blobs: BlobStore, private readonly codecs: readonly ArchiveCodec[]) {}

	/** A backup's key: `backups/<server>-<kind>-<date>.jsonl`, with the chain's extensions. */
	key(kind: BackupKind, server: string, now: number): string {
		return backupKey(kind, server, now, this.codecs);
	}

	/**
	 * Writes one archive under `key` with `fill`, through the chain, streamed
	 * into the store (R2: a multipart upload); a failure aborts it, leaving
	 * nothing. A key taken already (a backup this second) fails it.
	 */
	async write<T>(key: string, fill: (archive: ArchiveWriter) => Promise<T>): Promise<T> {
		// Keys are to the second: a second backup within it would replace the first.
		if ((await this.blobs.list(key, { limit: 1 })).keys.some((entry) => entry.key === key)) {
			throw new Error(`the backup ${key} exists already (another backup this second): try again in a moment`);
		}
		const writer = await this.blobs.writer(key, storedOptions(this.codecs));
		const archive = encodedArchiveWriter((bytes) => writer.write(bytes), this.codecs);
		try {
			const result = await fill(archive);
			await writer.close();
			return result;
		} catch (error) {
			await archive.abort(error);
			await writer.abort().catch(() => undefined);
			throw error;
		}
	}

	/** Deletes `kind`'s backups of `server` past the newest `keep` (keys sort by date); returns the keys deleted. */
	async prune(kind: BackupKind, server: string, keep: number): Promise<string[]> {
		const family = backupFamily(kind, server);
		const keys: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.blobs.list(family.prefix, { limit: 1_000, ...(cursor ? { cursor } : {}) });
			keys.push(...page.keys.map((entry) => entry.key).filter((entry) => family.pattern.test(entry)));
			cursor = page.cursor;
		} while (cursor);
		keys.sort();
		const deleted = keys.length > keep ? keys.slice(0, keys.length - keep) : [];
		if (deleted.length) await this.blobs.delete(deleted);
		return deleted;
	}

	/**
	 * Reads the archive under `key` whole, through the codecs it records (or
	 * its name says), bounded to `maxBytes` stored and decoded, and says what
	 * it is (`provenance`); undefined if there is none. A codec it names that
	 * this server lacks fails it.
	 */
	async open(key: string, maxBytes: number): Promise<OpenedArchive | undefined> {
		const object = await this.blobs.get(key);
		if (!object) return undefined;
		// Read whole before anything is written (an import plans first): bounded, so a file cannot exhaust the object's memory.
		if (object.size > maxBytes) throw new Error(`${key} is ${object.size} bytes; an import reads at most ${maxBytes}`);
		return readEncodedArchive(await object.stream(), { codecs: storedChain(key, object), maxBytes });
	}
}

/**
 * Writes one backup of the whole pipeline (its records, `server`'s rooms
 * and users) to `backups`, then deletes this kind's backups past the
 * newest `keep`.
 */
export async function writeBackup(pipeline: HistoryPipeline, server: ExportPort, backups: BackupStore, settings: BackupSettings, kind: BackupKind, options: { server: string; clock: Clock; roomIds?: string[]; header?: Partial<ArchiveHeader>; prepare?: ExportOptions["prepare"] }): Promise<BackupResult> {
	const key = backups.key(kind, options.server, options.clock.now());
	const report = await backups.write(key, (archive) => exportArchive(pipeline, server, archive, {
		clock: options.clock, header: { server: options.server, ...options.header }, ...(options.roomIds ? { roomIds: options.roomIds } : {}),
		privateRooms: settings.privateRooms,
		...(options.prepare ? { prepare: options.prepare } : {}),
	}));
	return { ...report, key, deleted: await backups.prune(kind, options.server, settings.keep) };
}
