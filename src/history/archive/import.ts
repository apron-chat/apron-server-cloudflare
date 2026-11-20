/*
 * importArchive (PLAN §10.2–§10.6): reads an ARCHIVE.md v1 file (as
 * @apron/archive openArchive decodes it) into the pipeline.
 *
 * It plans first, writing nothing, with @apron/archive's planImport over
 * the pipeline (importTarget) and this server's user ID rules
 * (src/user-ids.ts): which rooms are new (rooms that exist here are skipped
 * whole, decision 6), what each archive user becomes (an existing account
 * or an unclaimed placeholder, §10.4), which records are duplicates of
 * records held here (skipped), which collide with a different record's log
 * ID (moved to the next free millisecond, §10.3). This module adds where
 * each record goes (§10.5): records older than the published floor are
 * dropped as expired; the rest go to the tier that serves their log ID, and
 * to each tier below it that already holds copies that far. A dry run stops
 * there and returns the plan's report. Then the plan's state is journaled
 * (so a retry finishes it), placeholders are made, and each new room is
 * restored at the head (with its records from the head's floor on) and its
 * older records appended to the tiers below.
 */

import {
	type ArchiveReader, type ChatRecord, type CollectedArchive, type ImportReport, type ImportState, type ImportTarget, archiveIdentity, collectArchive, planImport,
} from "@apron/archive";
import { USER_ID_RULES } from "../../user-ids";
import type { HistoryPipeline } from "../pipeline";
import type { TierView } from "../plan";
import { type Clock, toRange } from "../records";

export type { ImportReport };

export interface ImportOptions {
	/**
	 * How the archive's user IDs map to accounts here (§10.4, @apron/archive PlanOptions.users):
	 * "auto" (default), "match" (authenticated archives only) or "new". An ID
	 * that cannot stand here (a guest's, a bot's, `~…`, and `admin` unless
	 * matched) becomes `imported-…` (USER_ID_RULES).
	 */
	users?: "auto" | "match" | "new";
	/**
	 * Whether the archive is verified as one of this server's own (an
	 * authenticating codec read it to its end: @apron/archive openArchive,
	 * `verified`): only then may users be matched, since a file's `server`
	 * header is anyone's to write. A function is asked once the archive has
	 * been read whole. Default false; no codec this server has authenticates.
	 */
	authenticated?: boolean | (() => boolean);
	/** Per-user decisions overriding `users`: an existing account, or a placeholder ID. */
	userMap?: Record<string, { existing: string } | { placeholder: string }>;
	/** "original" (default) keeps log IDs, moving only collisions; "renumber" gives every record a new one at the head. */
	ids?: "original" | "renumber";
	/** Plan and report, writing nothing. */
	dryRun?: boolean;
	/** This server's name, compared with the archive's `server` for "auto". */
	server?: string;
	clock: Clock;
	/** Records per restoreRoom or append call (default 200). */
	batch?: number;
	/** Reaction sets and members per restoreRoom call (default 1,000; a record holding more goes alone). */
	entries?: number;
	/** Abandon an unfinished earlier import of another archive, and plan this one afresh. */
	restart?: boolean;
	/** New placeholder accounts one import may make (default MAX_IMPORT_PLACEHOLDERS). */
	maxPlaceholders?: number;
}

/** New placeholder accounts one import makes at most: past it, the import is refused before anything is written. */
export const MAX_IMPORT_PLACEHOLDERS = 2_000;
/** How far past the clock an imported log ID may be (`original` IDs): further, and the import is refused, as it would hold back every later commit. */
export const FUTURE_LOG_ID_MS = 5 * 60_000;
/** The largest journal an import keeps (Store.setHistoryImportJournal's cap). */
export const MAX_JOURNAL_BYTES = 256 * 1024;
/** Log IDs looked up a call. */
const LOOKUP_BATCH = 500;

/** The reaction sets and members a record holds (Store.restoreRoom counts them per call). */
function entriesOf(record: ChatRecord): number {
	if (record.kind !== "reactions" && record.kind !== "membership") return 0;
	const value = JSON.parse(record.record_json) as { reactions?: unknown[]; members?: unknown[] };
	return (value.reactions ?? value.members ?? []).length;
}

/** Records in calls of at most `records` records and `entries` entries; a record over `entries` goes alone. */
export function restoreBatches(records: readonly ChatRecord[], limits: { records: number; entries: number }): ChatRecord[][] {
	const out: ChatRecord[][] = [];
	let batch: ChatRecord[] = [];
	let entries = 0;
	for (const record of records) {
		const count = entriesOf(record);
		if (batch.length && (batch.length >= limits.records || entries + count > limits.entries)) {
			out.push(batch);
			batch = [];
			entries = 0;
		}
		batch.push(record);
		entries += count;
	}
	if (batch.length) out.push(batch);
	return out;
}

/** A message record without any embed's `output_ref`: it names this server's own storage, never taken from a file (Store.normalizedBody drops a client's). */
function withoutOutputRefs(record: ChatRecord): ChatRecord {
	if (record.kind !== "message" || !record.record_json.includes('"output_ref"')) return record;
	const value = JSON.parse(record.record_json) as { body?: { embeds?: unknown[] } };
	if (!Array.isArray(value.body?.embeds)) return record;
	value.body.embeds = value.body.embeds.map((embed) => {
		if (!embed || typeof embed !== "object" || !("output_ref" in embed)) return embed;
		const { output_ref: _ref, ...rest } = embed as Record<string, unknown>;
		return rest;
	});
	return { ...record, record_json: JSON.stringify(value) };
}

/** The pipeline as planImport's target: its head's rooms and users, and records across every tier. */
function importTarget(pipeline: HistoryPipeline): ImportTarget {
	const head = pipeline.head;
	return {
		hasRoom: (roomId) => head.hasRoom(roomId),
		...(head.roomIsEmpty ? { roomIsEmpty: (roomId: string) => head.roomIsEmpty!(roomId) } : {}),
		hasUser: (userId) => head.hasUser(userId),
		...(head.isRetired ? { isRetired: (userId: string) => head.isRetired!(userId) } : {}),
		...(head.latest ? { latest: () => head.latest!() } : {}),
		async lookup(ids) {
			const found: ChatRecord[] = [];
			for (let start = 0; start < ids.length; start += LOOKUP_BATCH) found.push(...await pipeline.lookup(ids.slice(start, start + LOOKUP_BATCH)));
			return found;
		},
		// Records as a client could have sent them (Store.restorableRecord).
		...(head.normalizeRecord ? { normalize: (record: ChatRecord) => head.normalizeRecord!(record) } : {}),
	};
}

/**
 * Placement (§10.5): the tiers a record of log ID `id` goes to, or none if
 * it is below the published floor: the head when it is past the head's
 * copy marker (else the next tier would never get it), otherwise the first
 * tier below, top-down, whose floor is at or below it; then each tier below
 * that whose copy from above already passed it, so none of them misses it
 * once the tier above lets it go.
 */
export function place(id: number, tiers: readonly Pick<TierView, "state">[], published: number): number[] {
	if (id < published) return [];
	let serving = tiers.length > 1 && tiers[0].state.through >= id ? tiers.findIndex((tier, index) => index > 0 && tier.state.floor <= id) : tiers.findIndex((tier) => tier.state.floor <= id);
	if (serving === -1) serving = tiers.length - 1;
	const out = [serving];
	for (let below = serving + 1; below < tiers.length && tiers[below - 1].state.through >= id; below += 1) out.push(below);
	return out;
}

/** Reads, plans (@apron/archive planImport) and, unless a dry run, writes an archive into the pipeline. */
export async function importArchive(pipeline: HistoryPipeline, input: ArchiveReader | CollectedArchive, options: ImportOptions): Promise<ImportReport> {
	const archive = "parts" in input ? await collectArchive(input) : input;
	const head = pipeline.head;
	// An earlier run of this import that failed partway is finished with its
	// own plan (its journal), whatever this run asks. An unfinished import of
	// another archive stops this one, unless `restart` abandons it.
	let resume: ImportState | undefined;
	let abandoned: string[] | undefined;
	const saved = head.journal ? await head.journal() : undefined;
	if (saved) {
		const parsed = JSON.parse(saved) as ImportState;
		const begun = parsed.targetRooms;
		if (parsed.archive === archiveIdentity(archive)) resume = parsed;
		else if (options.restart) abandoned = begun;
		else throw new Error(`another import is unfinished${begun.length ? ` (rooms ${begun.join(", ")})` : ""}: run it again to finish it, or import this one with restart to abandon it`);
	}
	const plan = await planImport(archive, importTarget(pipeline), {
		...(options.users ? { users: options.users } : {}),
		authenticated: typeof options.authenticated === "function" ? options.authenticated() : options.authenticated === true,
		...(options.userMap ? { userMap: options.userMap } : {}),
		...(options.ids ? { ids: options.ids } : {}),
		...(options.server !== undefined ? { server: options.server } : {}),
		now: () => options.clock.now(),
		userIds: USER_ID_RULES,
		maxPlaceholders: options.maxPlaceholders ?? MAX_IMPORT_PLACEHOLDERS,
		futureMs: FUTURE_LOG_ID_MS,
		...(resume ? { resume } : {}),
		prepare: withoutOutputRefs,
	});
	const report: ImportReport = { ...plan.report, dryRun: Boolean(options.dryRun), ...(abandoned ? { abandoned } : {}) };

	// Placement (§10.5).
	const views = await pipeline.views();
	const published = await pipeline.publishedFloor();
	const perTier: ChatRecord[][] = views.map(() => []);
	for (const record of plan.records) {
		const tiers = place(record.log_id, views, published);
		if (!tiers.length) {
			report.expired += 1;
			continue;
		}
		for (const index of tiers) perTier[index].push(record);
		report.records += 1;
		const range = report.logIdRange;
		report.logIdRange = { first: Math.min(range?.first ?? record.log_id, record.log_id), last: Math.max(range?.last ?? record.log_id, record.log_id) };
	}
	for (const [index, view] of views.entries()) if (perTier[index].length) report.placed[view.name] = perTier[index].length;

	// The journal, checked before anything is written: an import too large to
	// resume is refused whole.
	const journalText = JSON.stringify(plan.state);
	if (!resume && !report.refused && journalText.length > MAX_JOURNAL_BYTES) {
		report.refused = `this import maps ${Object.keys(report.users).length} users and moves ${plan.map.logIds.size} log IDs, too many to resume from if it fails: import it with renumber, or in parts`;
	}
	if (options.dryRun) return report;
	if (report.refused) throw new Error(report.refused);

	// Write, after noting the plan (a retry finishes it): placeholders, then
	// each room at the head, then the tiers below, oldest first. Every write
	// may be repeated without harm.
	if (!resume && head.setJournal) await head.setJournal(journalText);
	const batch = options.batch ?? 200;
	for (let start = 0; start < plan.placeholders.length; start += batch) await head.restoreUsers(plan.placeholders.slice(start, start + batch));
	const context = { rooms: report.roomsAdded };
	for (const { room, listing } of plan.rooms) {
		const own = perTier[0].filter((record) => record.room_id === listing.room_id);
		const batches = restoreBatches(own, { records: batch, entries: options.entries ?? 1_000 });
		const results = [];
		if (!batches.length) results.push(await head.restoreRoom({ ...room, listing }, [], context));
		for (const records of batches) results.push(await head.restoreRoom({ ...room, listing }, records, context));
		for (const result of results) {
			report.collisions += result?.collided ?? 0;
			report.rejected += result?.rejected ?? 0;
		}
	}
	for (let index = 1; index < views.length; index += 1) {
		const tier = pipeline.tiers[index];
		for (let start = 0; start < perTier[index].length; start += batch) await tier.append(toRange(perTier[index].slice(start, start + batch)));
	}
	await head.setJournal?.(null);
	return report;
}
