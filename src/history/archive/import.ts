/*
 * importArchive: reads an ARCHIVE.md v1 file (as
 * @apron/archive openArchive decodes it) into the chain.
 *
 * It plans first, writing nothing, with @apron/archive's planImport over
 * the chain (importTarget) and this server's user ID rules
 * (src/user-ids.ts): which rooms are new (rooms that exist here are skipped
 * whole), what each archive user becomes (an existing account
 * or an unclaimed placeholder), which records are duplicates of
 * records held here (skipped), which collide with a different record's log
 * ID (moved to the next free millisecond). This module adds where
 * each record goes: records older than the published floor are
 * dropped as expired; the rest go to the tier that serves their log ID, and
 * to each tier below it that already holds copies that far. A dry run stops
 * there and returns the plan's report. Then the plan's state is journaled
 * (so a retry finishes it), placeholders are made, and each new room is
 * restored at the head (with its records from the head's floor on), then
 * given the members its listing names (membersOf), and its older records
 * appended to the tiers below.
 */

import {
	type ArchiveReader, type ChatRecord, type CollectedArchive, type ImportReport, type ImportState, type ImportTarget, type Provenance, type RoomListing, archiveIdentity, collectArchive, importStateJson, parseImportState, planImport, utf8Length,
} from "@apron/archive";
import { withoutOutputRefs } from "../../content/output-ref";
import { USER_ID_RULES } from "../../user-ids";
import type { HistoryChain } from "../chain";
import type { ChainView } from "../link";
import { type Clock, toRange } from "../records";
import type { RestorePort } from "../tier";

export type { ImportReport };

export interface ImportOptions {
	/**
	 * How the archive's user IDs map to accounts here (@apron/archive PlanOptions.users):
	 * "auto" (default), "match" (verified archives only) or "new". An ID
	 * that cannot stand here (a guest's, a bot's, `~…`, and `admin` unless
	 * matched) becomes `imported-…` (USER_ID_RULES).
	 */
	users?: "auto" | "match" | "new";
	/**
	 * What the archive is known to be (@apron/archive readEncodedArchive):
	 * "verified" as one of this server's own (an authenticating codec read it
	 * whole) lets users be matched, since a file's `server` header is anyone's
	 * to write. Default "unverified"; no codec this server has authenticates.
	 */
	provenance?: Provenance;
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
	/**
	 * New placeholder accounts one import may make, besides the room the
	 * server has for accounts (RestorePort.accounts), which always bounds it.
	 */
	maxPlaceholders?: number;
	/** The largest journal, in UTF-8 bytes (default MAX_JOURNAL_BYTES). */
	maxJournalBytes?: number;
}

/** How far past the clock an imported log ID may be (`original` IDs): further, and the import is refused, as it would hold back every later commit. */
export const FUTURE_LOG_ID_MS = 5 * 60_000;
/**
 * The largest journal an import keeps, in UTF-8 bytes (the Store keeps it in
 * one `_meta` value, well under SQLite's 2 MB a value): about 50,000 users of
 * their own IDs (importStateJson), or 60,000 moved log IDs.
 */
export const MAX_JOURNAL_BYTES = 1024 * 1024;
/** Log IDs looked up a call. */
const LOOKUP_BATCH = 500;

/** The reaction sets and members a record holds (Store.restoreRoom counts them per call). */
function entriesOf(record: ChatRecord): number {
	if (record.kind !== "reactions" && record.kind !== "membership") return 0;
	const value = JSON.parse(record.record_json) as { reactions?: unknown[]; members?: unknown[] };
	return (value.reactions ?? value.members ?? []).length;
}

/**
 * The membership changes a new room's listing makes, once its records are
 * restored: the listing is the archive's snapshot of current state when it
 * was written, and its records are history. Every member it names is
 * joined; a member the import's own membership records name that a
 * complete listing leaves out (a hand-made file's disagreement) is removed.
 * A truncated listing (`member_count` above its members: MAX_LISTING_MEMBERS)
 * only adds: what it leaves out is unknown, not absent. A listing without
 * `members` (a third-party archive's) changes nothing: the records decide.
 */
export function membersOf(listing: RoomListing, records: readonly ChatRecord[]): { join: string[]; leave: string[] } | undefined {
	if (!Array.isArray(listing.members)) return undefined;
	const join = [...new Set(listing.members.map((member) => member.user_id).filter((id): id is string => typeof id === "string"))];
	const complete = !(typeof listing.member_count === "number" && listing.member_count > listing.members.length);
	if (!complete) return { join, leave: [] };
	const listed = new Set(join);
	const named = new Set<string>();
	for (const record of records) {
		if (record.kind !== "membership" || record.room_id !== listing.room_id) continue;
		const value = JSON.parse(record.record_json) as { members?: Array<{ user?: { user_id?: unknown } }> };
		for (const entry of value.members ?? []) if (typeof entry.user?.user_id === "string") named.add(entry.user.user_id);
	}
	return { join, leave: [...named].filter((id) => !listed.has(id)) };
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

/** planImport's target: the server's rooms and users (`restore`), and records across every tier of the chain. */
function importTarget(chain: HistoryChain, restore: RestorePort): ImportTarget {
	return {
		hasRoom: (roomId) => restore.hasRoom(roomId),
		roomIsEmpty: (roomId) => restore.roomIsEmpty(roomId),
		hasUser: (userId) => restore.hasUser(userId),
		isRetired: (userId) => restore.isRetired(userId),
		latest: () => restore.latest(),
		async lookup(ids) {
			const found: ChatRecord[] = [];
			for (let start = 0; start < ids.length; start += LOOKUP_BATCH) found.push(...await chain.lookup(ids.slice(start, start + LOOKUP_BATCH)));
			return found;
		},
		// Records as a client could have sent them (Store.restorableRecord).
		normalize: (record) => restore.normalize(record),
		// Placeholders count against the server's accounts (registeredIdentityCount).
		accounts: () => restore.accounts(),
	};
}

/**
 * Placement: the tiers a record of log ID `id` goes to, or none if
 * it is below the published floor: the head when it is past the head's
 * copy marker (else the next tier would never get it), otherwise the first
 * tier below, top-down, whose floor is at or below it; then each tier below
 * that whose copy from above already passed it, so none of them misses it
 * once the tier above lets it go.
 */
export function place(id: number, chain: Pick<ChainView, "tiers" | "links">, published: number): number[] {
	if (id < published) return [];
	const { tiers, links } = chain;
	let serving = links.length && links[0].through >= id ? tiers.findIndex((tier, index) => index > 0 && tier.floor <= id) : tiers.findIndex((tier) => tier.floor <= id);
	if (serving === -1) serving = tiers.length - 1;
	const out = [serving];
	for (let below = serving + 1; below < tiers.length && links[below - 1].through >= id; below += 1) out.push(below);
	return out;
}

/** Reads, plans (@apron/archive planImport) and, unless a dry run, writes an archive into the chain, through `restore`. */
export async function importArchive(chain: HistoryChain, restore: RestorePort, input: ArchiveReader | CollectedArchive, options: ImportOptions): Promise<ImportReport> {
	const archive = "parts" in input ? await collectArchive(input) : input;
	// An earlier run of this import that failed partway is finished with its
	// own plan (its journal), whatever this run asks. An unfinished import of
	// another archive stops this one, unless `restart` abandons it.
	let resume: ImportState | undefined;
	let abandoned: string[] | undefined;
	const saved = await restore.journal.get();
	if (saved) {
		const parsed = parseImportState(saved);
		const begun = parsed ? parsed.rooms.map((room) => room.target) : [];
		if (parsed && parsed.archive === archiveIdentity(archive)) resume = parsed;
		else if (options.restart) abandoned = begun;
		else if (!parsed) throw new Error("an earlier import's journal cannot be read: import with restart to abandon it");
		else throw new Error(`another import is unfinished${begun.length ? ` (rooms ${begun.join(", ")})` : ""}: run it again to finish it, or import this one with restart to abandon it`);
	}
	const plan = await planImport(archive, importTarget(chain, restore), {
		...(options.users ? { users: options.users } : {}),
		authenticated: options.provenance === "verified",
		...(options.userMap ? { userMap: options.userMap } : {}),
		...(options.ids ? { ids: options.ids } : {}),
		...(options.server !== undefined ? { server: options.server } : {}),
		now: () => options.clock.now(),
		userIds: USER_ID_RULES,
		...(options.maxPlaceholders !== undefined ? { maxPlaceholders: options.maxPlaceholders } : {}),
		futureMs: FUTURE_LOG_ID_MS,
		...(resume ? { resume } : {}),
		// An `output_ref` names this server's own storage: never taken from a file (Store.normalizedBody drops a client's).
		prepare: withoutOutputRefs,
	});
	const report: ImportReport = { ...plan.report, dryRun: Boolean(options.dryRun), ...(abandoned ? { abandoned } : {}) };

	// Placement.
	const view = await chain.view();
	const published = await chain.publishedFloor();
	const perTier: ChatRecord[][] = view.tiers.map(() => []);
	for (const record of plan.records) {
		const tiers = place(record.log_id, view, published);
		if (!tiers.length) {
			report.expired += 1;
			continue;
		}
		for (const index of tiers) perTier[index].push(record);
		report.records += 1;
		const range = report.logIdRange;
		report.logIdRange = { first: Math.min(range?.first ?? record.log_id, record.log_id), last: Math.max(range?.last ?? record.log_id, record.log_id) };
	}
	for (const [index, tier] of view.tiers.entries()) if (perTier[index].length) report.placed[tier.name] = perTier[index].length;

	// The journal, checked before anything is written: an import too large to
	// resume is refused whole.
	const journalText = importStateJson(plan.state);
	if (!resume && !report.refused && utf8Length(journalText) > (options.maxJournalBytes ?? MAX_JOURNAL_BYTES)) {
		const moved = plan.state.ids.mode === "original" ? plan.state.ids.moved.length : 0;
		report.refused = `this import maps ${Object.keys(report.users).length} users and moves ${moved} log IDs, too many to resume from if it fails: ${moved > Object.keys(report.users).length ? "import it with renumber" : "import it in parts"}`;
	}
	if (options.dryRun) return report;
	if (report.refused) throw new Error(report.refused);

	// Write, after noting the plan (a retry finishes it): placeholders, then
	// each room at the head, then the tiers below, oldest first. Every write
	// may be repeated without harm.
	if (!resume) await restore.journal.set(journalText);
	const batch = options.batch ?? 200;
	for (let start = 0; start < plan.placeholders.length; start += batch) await restore.restoreUsers(plan.placeholders.slice(start, start + batch));
	const context = { rooms: report.roomsAdded };
	for (const { room, listing } of plan.rooms) {
		const own = perTier[0].filter((record) => record.room_id === listing.room_id);
		const batches = restoreBatches(own, { records: batch, entries: options.entries ?? 1_000 });
		const results = [];
		if (!batches.length) results.push(await restore.restoreRoom({ ...room, listing }, [], context));
		for (const records of batches) results.push(await restore.restoreRoom({ ...room, listing }, records, context));
		for (const result of results) {
			report.collisions += result.collided ?? 0;
			report.rejected += result.rejected ?? 0;
		}
		// Then the members its listing names (records the room has in every tier count).
		const changes = membersOf(listing, plan.records);
		if (changes) {
			const per = options.entries ?? 1_000;
			const all = [...changes.join.map((id) => ({ id, join: true })), ...changes.leave.map((id) => ({ id, join: false }))];
			for (let start = 0; start < all.length; start += per) {
				const slice = all.slice(start, start + per);
				const result = await restore.restoreMembers(listing.room_id, { join: slice.filter((entry) => entry.join).map((entry) => entry.id), leave: slice.filter((entry) => !entry.join).map((entry) => entry.id) });
				report.membersJoined += result.joined;
				report.membersSkipped += result.skipped;
			}
		}
	}
	for (let index = 1; index < view.tiers.length; index += 1) {
		const tier = chain.tiers[index];
		for (let start = 0; start < perTier[index].length; start += batch) await tier.append(toRange(perTier[index].slice(start, start + batch)));
	}
	await restore.journal.set(null);
	return report;
}
