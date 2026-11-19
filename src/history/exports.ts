/*
 * Backups (PLAN §13.2): full ARCHIVE.md exports written to a blob store,
 * optionally encrypted (§13.3), keeping the newest few. Scheduled by the
 * `HISTORY` config's `exports`, or run by an admin's `/history export`.
 * The export streams into the store's writer (R2: a multipart upload), so
 * it is never held whole in memory; a failure aborts the upload, leaving
 * nothing behind.
 */

import { type BackupKeys, encryptingSink } from "./archive/crypto";
import { type ExportOptions, type ExportReport, exportArchive } from "./archive/export";
import type { ArchiveHeader } from "./archive/types";
import { jsonlWriter } from "./archive/format";
import type { BlobStore } from "./blob/store";
import type { HistoryPipeline } from "./pipeline";
import type { Clock } from "./records";
import type { ExportSettings } from "./settings";

/** `2026-11-19T17:30:05.123Z` → `20261119-173005`: sorts in time order. */
export function exportStamp(now: number): string {
	return new Date(now).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

/** An export's object key: its template with `{server}`, `{name}` and `{date}` filled in, `.enc` added when encrypted. */
export function exportKey(settings: Pick<ExportSettings, "key" | "name" | "store" | "encrypt">, server: string, now: number): string {
	const name = settings.key.replaceAll("{server}", server).replaceAll("{name}", settings.name).replaceAll("{date}", exportStamp(now));
	return `${settings.store.prefix}${name}${settings.encrypt && !name.endsWith(".enc") ? ".enc" : ""}`;
}

/**
 * This export's backups: the store prefix to list, and the pattern its keys
 * match whole (the template with a date in place of `{date}`), so another
 * export, or anything else under the prefix, is never taken for one.
 */
export function exportFamily(settings: Pick<ExportSettings, "key" | "name" | "store" | "encrypt">, server: string): { prefix: string; pattern: RegExp } {
	const template = settings.key.replaceAll("{server}", server).replaceAll("{name}", settings.name);
	const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const [before, after] = [template.slice(0, template.indexOf("{date}")), template.slice(template.indexOf("{date}") + "{date}".length)];
	const suffix = settings.encrypt && !template.endsWith(".enc") ? ".enc" : "";
	return {
		prefix: `${settings.store.prefix}${before}`,
		pattern: new RegExp(`^${escape(settings.store.prefix + before)}\\d{8}-\\d{6}${escape(after + suffix)}$`),
	};
}

export interface BackupResult extends ExportReport {
	key: string;
	deleted: string[];
}

/**
 * Writes one backup of the whole pipeline to `store`, then deletes this
 * export's backups past the newest `keep`. With `encrypt`, the first listed
 * key secret encrypts it; a missing key fails before anything is written.
 */
export async function writeBackup(pipeline: HistoryPipeline, store: BlobStore, settings: ExportSettings, options: { server: string; clock: Clock; keys?: Pick<BackupKeys, "lookup">; roomIds?: string[]; header?: Partial<ArchiveHeader>; prepare?: ExportOptions["prepare"] }): Promise<BackupResult> {
	const now = options.clock.now();
	const key = exportKey(settings, options.server, now);
	let encryptWith: { name: string; key: CryptoKey; fingerprint: string } | undefined;
	if (settings.encrypt) {
		const name = settings.encrypt.keySecrets[0];
		const found = await options.keys?.lookup(name);
		if (!found) throw new Error(`the export ${settings.name} encrypts with ${name}, which is not set: set it with \`wrangler secret put ${name}\``);
		encryptWith = { name, ...found };
	}
	const writer = await store.writer(key, { contentType: encryptWith ? "application/octet-stream" : "application/jsonl" });
	let report: ExportReport;
	try {
		const plain = async (line: string) => writer.write(line.endsWith("\n") ? line : `${line}\n`);
		const sink = encryptWith ? encryptingSink(plain, encryptWith) : undefined;
		report = await exportArchive(pipeline, jsonlWriter(sink ?? plain), {
			clock: options.clock, header: { server: options.server, ...options.header }, ...(options.roomIds ? { roomIds: options.roomIds } : {}),
			...(options.prepare ? { prepare: options.prepare } : {}),
		});
		await sink?.close();
		await writer.close();
	} catch (error) {
		await writer.abort().catch(() => undefined);
		throw error;
	}
	// The newest `keep` of this export's backups stay; keys sort by date.
	const family = exportFamily(settings, options.server);
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
