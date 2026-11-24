/*
 * The scene round trip: an archive imported into a fresh server through the
 * real import path (BackupStore.open → importArchive over the server's
 * chain and Store), exported through the real export path (writeBackup:
 * the chain, the export port, the codec chain), and that export imported
 * into a second fresh server and exported again.
 *
 * Each server is its own Durable Object (a fresh name), with its own
 * SQLite; the backup store is the shared local R2 bucket (HISTORY_BLOB).
 * Every object a trip writes is kept under `roundtrip/<run>/`, apart from
 * the server's own backups/ (one per second, so two servers exporting in
 * the same second would collide).
 */

import { env, runInDurableObject } from "cloudflare:test";
import { type ChatRecord, type CollectedArchive, type CompareIdMap, IdMap, type ImportReport, type ReplayedState, collectArchive, jsonlReader, linesOf, replayRecords, withBareUsers } from "@apron/archive";
import { importArchive } from "../../../src/history/archive/import";
import { type BackupStore, type BackupResult, type BackupSettings, writeBackup } from "../../../src/history/exports";
import type { HistoryChain } from "../../../src/history/chain";
import type { Store } from "../../../src/store";
import type { PublicRecord } from "../../../src/history/records";

/** The runtime's parts a trip drives (private members, reached as the tests reach them elsewhere). */
type Runtime = {
	store: Store;
	archiveChain(): HistoryChain;
	backupStore(): BackupStore;
	archiveHeader(): { server: string; media: string[] };
	writeBackup(backups: BackupStore, kind: "manual"): Promise<BackupResult>;
	config: { serverHost: string; backups: BackupSettings };
	exportRecords(records: ChatRecord[]): Promise<PublicRecord[]>;
};

const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/** One archive as a trip reads it: its text, parsed, and the state it gives. */
export interface Snapshot {
	text: string;
	archive: CollectedArchive;
	state: ReplayedState;
}

export async function snapshot(text: string): Promise<Snapshot> {
	const archive = await collectArchive(jsonlReader(linesOf(text)));
	return { text, archive, state: replayRecords(archive.records, archive.rooms, archive.users) };
}

/** The ID map an import's report gives (what each archive log ID and user became), for compareReplayed. */
export function idMapOf(report: ImportReport): CompareIdMap {
	const map = new IdMap(
		new Map(Object.entries(report.remapped.logIds).map(([from, to]) => [Number(from), Number(to)])),
		new Map(Object.entries(report.remapped.users)),
	);
	return { logId: (id) => map.logIdString(id), userId: (id) => map.userId(id), roomId: (id) => map.roomId(id) };
}

/** Imports the object at `key` into server `name` as `/history import <key>` does (users auto, IDs original). */
export async function importInto(name: string, key: string): Promise<ImportReport> {
	return runInDurableObject(env.DEMO.getByName(name), async (instance) => {
		const runtime = instance as unknown as Runtime;
		const opened = await runtime.backupStore().open(key, MAX_IMPORT_BYTES);
		if (!opened) throw new Error(`no object ${key}`);
		return importArchive(runtime.archiveChain(), runtime.store.history.restore(), opened.archive, {
			clock: { now: Date.now }, server: runtime.archiveHeader().server,
			provenance: opened.provenance, users: "auto", ids: "original",
		});
	});
}

/**
 * Exports server `name` as `/history export` does, then moves the backup
 * to `keep` (the same encoding, its codec metadata kept) and returns its
 * decoded text. `maxMembers` exports with a smaller member cap (writeBackup
 * called as the runtime calls it, with that option); otherwise the
 * runtime's own path.
 */
export async function exportFrom(name: string, keep: string, options: { maxMembers?: number; report?: (result: BackupResult) => void } = {}): Promise<string> {
	const result = await runInDurableObject(env.DEMO.getByName(name), (instance) => {
		const runtime = instance as unknown as Runtime;
		if (options.maxMembers === undefined) return runtime.writeBackup(runtime.backupStore(), "manual");
		return writeBackup(runtime.archiveChain(), runtime.store.history.export(), runtime.backupStore(), runtime.config.backups, "manual", {
			server: runtime.config.serverHost, clock: { now: Date.now }, header: runtime.archiveHeader(), prepare: (records) => runtime.exportRecords(records), maxMembers: options.maxMembers,
		});
	});
	options.report?.(result);
	const bucket = env.HISTORY_BLOB!;
	const object = await bucket.get(result.key);
	if (!object) throw new Error(`no backup at ${result.key}`);
	const bytes = new Uint8Array(await object.arrayBuffer());
	await bucket.put(keep, bytes, { customMetadata: object.customMetadata, httpMetadata: object.httpMetadata });
	await bucket.delete(result.key);
	const codecs = object.customMetadata?.codecs ?? "";
	if (codecs !== "gzip") throw new Error(`unexpected codecs ${JSON.stringify(codecs)} on ${result.key}`);
	return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

export interface RoundTrip {
	scene: Snapshot;
	first: { report: ImportReport; export: Snapshot };
	second: { report: ImportReport; export: Snapshot };
}

/**
 * `records` as server `name` takes them on import: recorded users made
 * bare, then its content policy (RestorePort.normalize); null where the
 * policy refuses one.
 */
export async function normalizeIn(name: string, records: readonly ChatRecord[]): Promise<Array<ChatRecord | null>> {
	return runInDurableObject(env.DEMO.getByName(name), (instance) => {
		const restore = (instance as unknown as Runtime).store.history.restore();
		return records.map((record) => restore.normalize(withBareUsers(record)));
	});
}

/** The whole trip for one archive's text, under a run name unique to the caller. */
export async function roundTrip(run: string, text: string, options: { maxMembers?: number } = {}): Promise<RoundTrip> {
	const bucket = env.HISTORY_BLOB!;
	const sceneKey = `roundtrip/${run}/scene.jsonl`;
	await bucket.put(sceneKey, text);
	const firstReport = await importInto(`roundtrip-${run}-a`, sceneKey);
	const firstText = await exportFrom(`roundtrip-${run}-a`, `roundtrip/${run}/export-1.jsonl.gz`, options);
	const secondReport = await importInto(`roundtrip-${run}-b`, `roundtrip/${run}/export-1.jsonl.gz`);
	const secondText = await exportFrom(`roundtrip-${run}-b`, `roundtrip/${run}/export-2.jsonl.gz`, options);
	return {
		scene: await snapshot(text),
		first: { report: firstReport, export: await snapshot(firstText) },
		second: { report: secondReport, export: await snapshot(secondText) },
	};
}
