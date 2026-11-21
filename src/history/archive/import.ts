/*
 * importArchive: reads an ARCHIVE.md v1 file into the chain, in two passes
 * over it, holding neither the file nor its records.
 *
 * Pass 1 indexes it (@apron/archive indexArchive: a few bytes a record) and
 * plans from the index, writing nothing, with planFromIndex over the chain
 * (importTarget) and this server's user ID rules (src/user-ids.ts): which
 * rooms are new (rooms that exist here are skipped whole), what each
 * archive user becomes (an existing account or an unclaimed placeholder),
 * which records are duplicates of records held here (skipped), which
 * collide with a different record's log ID (moved to the next free
 * millisecond). This module adds where each record goes: records older
 * than the published floor are dropped as expired; the rest go to the tier
 * that serves their log ID, and to each tier below it that already holds
 * copies that far. A dry run stops there and returns the plan's report.
 *
 * Then the plan's state is journaled (so a retry finishes it) and
 * placeholders are made, and pass 2 reads the file again from its start,
 * writing each line's records as it goes: a room's at the head in calls of
 * at most `batch` records, the tiers' below in log order when the records
 * held reach a checkpoint, when every room's are written too and the line
 * reached is saved (RestorePort.progress). One run keeps the file open and
 * writes to its end; a run after a failure reads the file from its start
 * again, discarding the decoded bytes before the saved line without
 * parsing them, and goes on from there. Last, each new room is given the
 * members its listing names (membersOf).
 */

import {
	type ArchiveLines, type ArchiveReader, type ChatRecord, type CollectedArchive, type ImportReport, type ImportState, type ImportTarget, type Provenance, type RecordPosition, type RoomListing, type ScanStats, type StreamPlan,
	byLog, collectArchive, collectedSource, importStateJson, indexArchive, parseImportState, recordLines, planFromIndex, utf8Length,
} from "@apron/archive";
import { MAX_MEMBERSHIPS_PER_USER } from "../../budget";
import { withoutOutputRefs } from "../../content/output-ref";
import { USER_ID_RULES } from "../../user-ids";
import type { HistoryChain } from "../chain";
import type { ChainView } from "../link";
import { type Clock, toRange } from "../records";
import type { RestorePort, RestoreResult } from "../tier";

export type { ImportReport };

/** What an import reads: an archive that can be read twice (ArchiveLines), or one held whole. */
export type ImportInput = ArchiveLines | ArchiveReader | CollectedArchive;

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
	/** The most records an archive may hold (default MAX_IMPORT_RECORDS). */
	maxRecords?: number;
	/** Records held before every room's are written and the line reached is saved (default CHECKPOINT_RECORDS). */
	checkpoint?: number;
	/** Counts the decoded bytes pass 2 discarded to reach a saved line, and those it read. */
	stats?: ScanStats;
	/** The largest archive, decoded, written from memory when its rooms' records are out of log order (default MAX_SORTED_IMPORT_BYTES). */
	maxSortedBytes?: number;
}

/** How far past the clock an imported log ID may be (`original` IDs): further, and the import is refused, as it would hold back every later commit. */
export const FUTURE_LOG_ID_MS = 5 * 60_000;
/**
 * The largest journal an import keeps, in UTF-8 bytes (the Store keeps it in
 * one `_meta` value, well under SQLite's 2 MB a value): about 50,000 users of
 * their own IDs (importStateJson), or 60,000 moved log IDs.
 */
export const MAX_JOURNAL_BYTES = 1024 * 1024;
/**
 * The most records one import takes; an archive with more is refused
 * before anything is written. Measured (docs/configuration.md, Backups and
 * imports): 200,000 records (100 MiB decoded) index and plan within a
 * 16 MiB V8 heap and 12 MiB of typed arrays, about 31 bytes a record held
 * for the index and 24 for the plan, against the object's 128 MB isolate;
 * and their first pass takes about 6 seconds in workerd, which every run of
 * an import repeats, within an invocation's 30 seconds of CPU.
 */
export const MAX_IMPORT_RECORDS = 250_000;
/** Records pass 2 holds before it writes every room's and saves the line reached. */
export const CHECKPOINT_RECORDS = 2_000;
/** Bytes of records pass 2 holds, at most, before it writes them all. */
const CHECKPOINT_BYTES = 4 * 1024 * 1024;
/**
 * The largest archive, decoded, written from memory when a room's records
 * are not in log order in it (a writer's in one pass must be, as the head
 * restores a room's records oldest first): such a file is read whole and
 * its records sorted, as every import was before.
 */
export const MAX_SORTED_IMPORT_BYTES = 16 * 1024 * 1024;
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

/** planFromIndex's target: the server's rooms and users (`restore`), and records across every tier of the chain. */
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
		// New rooms count against the server's caps on rooms, as restoreRoom checks them.
		roomCapacity: (rooms) => restore.roomCapacity(rooms),
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

/** The archive as lines that can be read twice: an ArchiveLines as it is, an archive held whole as one. */
async function linesOf(input: ImportInput): Promise<ArchiveLines> {
	if ("lines" in input && typeof input.lines === "function") return input;
	if ("parts" in input) return collectedSource(await collectArchive(input));
	return collectedSource(input as CollectedArchive);
}

/** The saved position pass 2 goes on from (a line, its offset decoded, and the records before it), or none: from the start. */
function parseProgress(text: string | undefined): RecordPosition | undefined {
	if (!text) return undefined;
	try {
		const value = JSON.parse(text) as Partial<RecordPosition>;
		const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
		return count(value.line) && count(value.offset) && count(value.entry) ? { line: value.line, offset: value.offset, entry: value.entry } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Pass 1: the archive indexed and planned (an unfinished run of the same
 * import resumed with its journal). Apart from importArchive so the index,
 * once planned from, is no longer held.
 */
async function planArchive(chain: HistoryChain, restore: RestorePort, source: ArchiveLines, options: ImportOptions): Promise<{ plan: StreamPlan; bytes: number; resume?: ImportState; abandoned?: string[] }> {
	// An output_ref names this server's own storage: never taken from a file (Store.normalizedBody drops a client's).
	const index = await indexArchive(source, { prepare: withoutOutputRefs, normalize: (record) => restore.normalize(record), maxRecords: options.maxRecords ?? MAX_IMPORT_RECORDS });

	// An earlier run of this import that failed partway is finished with its
	// own plan (its journal), whatever this run asks. An unfinished import of
	// another archive stops this one, unless `restart` abandons it.
	let resume: ImportState | undefined;
	let abandoned: string[] | undefined;
	const saved = await restore.journal.get();
	if (saved) {
		const parsed = parseImportState(saved);
		const begun = parsed ? parsed.rooms.map((room) => room.target) : [];
		if (parsed && parsed.archive === index.identity) resume = parsed;
		else if (options.restart) abandoned = begun;
		else if (!parsed) throw new Error("an earlier import's journal cannot be read: import with restart to abandon it");
		else throw new Error(`another import is unfinished${begun.length ? ` (rooms ${begun.join(", ")})` : ""}: run it again to finish it, or import this one with restart to abandon it`);
	}
	const plan = await planFromIndex(index, source, importTarget(chain, restore), {
		...(options.users ? { users: options.users } : {}),
		authenticated: options.provenance === "verified",
		...(options.userMap ? { userMap: options.userMap } : {}),
		...(options.ids ? { ids: options.ids } : {}),
		...(options.server !== undefined ? { server: options.server } : {}),
		now: () => options.clock.now(),
		userIds: USER_ID_RULES,
		...(options.maxPlaceholders !== undefined ? { maxPlaceholders: options.maxPlaceholders } : {}),
		maxMembershipsPerUser: MAX_MEMBERSHIPS_PER_USER,
		futureMs: FUTURE_LOG_ID_MS,
		...(resume ? { resume } : {}),
		prepare: withoutOutputRefs,
	});
	return { plan, bytes: index.bytes, ...(resume ? { resume } : {}), ...(abandoned ? { abandoned } : {}) };
}

/** What the writes do at the head, per room (by its ID here): how many, the first one's place among all writes, and whether they come in log order. */
interface RoomWrites {
	head: number;
	firstHead: number;
	ordered: boolean;
	last: number;
}

/** Placement of the plan's writes (StreamPlan.written), counted into `report`, and what they do at the head per room. */
function placeWrites(plan: StreamPlan, view: ChainView, published: number, report: ImportReport): Map<string, RoomWrites> {
	const written = plan.written();
	const perRoom = written.rooms.map((): RoomWrites => ({ head: 0, firstHead: -1, ordered: true, last: 0 }));
	const placed = view.tiers.map(() => 0);
	for (let at = 0; at < written.logId.length; at += 1) {
		const id = written.logId[at]!;
		const tiers = place(id, view, published);
		if (!tiers.length) {
			report.expired += 1;
			continue;
		}
		for (const tier of tiers) placed[tier] += 1;
		report.records += 1;
		const range = report.logIdRange;
		report.logIdRange = { first: Math.min(range?.first ?? id, id), last: Math.max(range?.last ?? id, id) };
		if (tiers[0] !== 0) continue;
		const room = perRoom[written.room[at]!]!;
		if (room.head && id < room.last) room.ordered = false;
		if (!room.head) room.firstHead = at;
		room.head += 1;
		room.last = id;
	}
	for (const [at, tier] of view.tiers.entries()) if (placed[at]) report.placed[tier.name] = placed[at];
	const byRoom = new Map<string, RoomWrites>();
	for (const [at, roomId] of written.rooms.entries()) if (perRoom[at]!.head) byRoom.set(roomId, perRoom[at]!);
	return byRoom;
}

/** Reads, plans (@apron/archive indexArchive and planFromIndex) and, unless a dry run, writes an archive into the chain, through `restore`. */
export async function importArchive(chain: HistoryChain, restore: RestorePort, input: ImportInput, options: ImportOptions): Promise<ImportReport> {
	const source = await linesOf(input);
	const { plan, bytes, resume, abandoned } = await planArchive(chain, restore, source, options);
	const report: ImportReport = { ...plan.report, dryRun: Boolean(options.dryRun), ...(abandoned ? { abandoned } : {}) };

	// Placement, from the plan's writes (their rooms and log IDs here), and
	// whether each room's records at the head come oldest first.
	const view = await chain.view();
	const published = await chain.publishedFloor();
	const perRoom = placeWrites(plan, view, published, report);
	const unordered = [...perRoom].find(([, writes]) => !writes.ordered)?.[0];

	// The journal, checked before anything is written: an import too large to
	// resume is refused whole.
	const journalText = importStateJson(plan.state);
	if (!resume && !report.refused && utf8Length(journalText) > (options.maxJournalBytes ?? MAX_JOURNAL_BYTES)) {
		const moved = plan.state.ids.mode === "original" ? plan.state.ids.moved.length : 0;
		report.refused = `this import maps ${Object.keys(report.users).length} users and moves ${moved} log IDs, too many to resume from if it fails: ${moved > Object.keys(report.users).length ? "import it with renumber" : "import it in parts"}`;
	}
	const maxSorted = options.maxSortedBytes ?? MAX_SORTED_IMPORT_BYTES;
	if (!report.refused && unordered !== undefined && bytes > maxSorted) {
		const mib = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MiB`;
		report.refused = `the records of ${unordered} are not in log order in this archive, and at ${mib(bytes)} decoded it is too large to sort in memory (at most ${mib(maxSorted)}): write it with each room's records oldest first`;
	}
	if (options.dryRun) return report;
	if (report.refused) throw new Error(report.refused);

	// Write, after noting the plan (a retry finishes it): placeholders, then
	// the records, then the members. Every write may be repeated without harm.
	if (!resume) {
		await restore.progress.set(null);
		await restore.journal.set(journalText);
	}
	const batch = options.batch ?? 200;
	const entries = options.entries ?? 1_000;
	for (let start = 0; start < plan.placeholders.length; start += batch) await restore.restoreUsers(plan.placeholders.slice(start, start + batch));
	const context = { rooms: report.roomsAdded };
	const tally = (result: RestoreResult) => {
		report.collisions += result.collided ?? 0;
		report.rejected += result.rejected ?? 0;
		report.membersSkipped += result.membersSkipped ?? 0;
	};
	const writer = { chain, restore, plan, view, published, batch, entries, context, tally };
	if (unordered === undefined) await writeStreamed(source, writer, perRoom, options);
	else await writeSorted(source, writer);

	// Then the members each new room's listing names (records the room has in every tier count).
	for (const { listing } of plan.rooms) {
		const changes = membersOf(listing, plan.memberships);
		if (!changes) continue;
		const all = [...changes.join.map((id) => ({ id, join: true })), ...changes.leave.map((id) => ({ id, join: false }))];
		for (let start = 0; start < all.length; start += entries) {
			const slice = all.slice(start, start + entries);
			const result = await restore.restoreMembers(listing.room_id, { join: slice.filter((entry) => entry.join).map((entry) => entry.id), leave: slice.filter((entry) => !entry.join).map((entry) => entry.id) });
			report.membersJoined += result.joined;
			report.membersSkipped += result.skipped;
		}
	}
	await restore.progress.set(null);
	await restore.journal.set(null);
	return report;
}

/** What pass 2 writes with. */
interface Writer {
	chain: HistoryChain;
	restore: RestorePort;
	plan: StreamPlan;
	view: ChainView;
	published: number;
	batch: number;
	entries: number;
	context: { rooms: readonly string[] };
	tally(result: RestoreResult): void;
}

/**
 * Pass 2 over a file whose rooms' records come oldest first: each line's
 * records as they are read, a room's at the head once it holds a call's
 * worth, and every room's and tier's at each checkpoint, after which the
 * line reached is saved. A run that finds a saved line reads on from there.
 *
 * A room is made by its first call, with its records (Store.restoreRoom),
 * and a thread's parent must be made first. So a room with no records at
 * the head is made first, from its listing, as is the parent of a thread
 * whose records at the head start before its own; and a thread's call
 * writes its parent's held records first.
 */
async function writeStreamed(source: ArchiveLines, writer: Writer, perRoom: ReadonlyMap<string, RoomWrites>, options: ImportOptions): Promise<void> {
	const { chain, restore, plan, view, published, batch, entries, context, tally } = writer;
	const writesOf = (roomId: string) => perRoom.get(roomId);
	const byTarget = new Map(plan.rooms.map((one) => [one.listing.room_id, one]));
	const parentOf = (roomId: string) => {
		const parent = byTarget.get(roomId)?.listing.parent_room_id;
		return typeof parent === "string" && byTarget.has(parent) ? parent : undefined;
	};
	const early = new Set<string>();
	for (const { listing } of plan.rooms) {
		const own = writesOf(listing.room_id);
		if (!own?.head) early.add(listing.room_id);
		const parent = parentOf(listing.room_id);
		const theirs = parent === undefined ? undefined : writesOf(parent);
		if (parent !== undefined && own?.head && theirs?.head && theirs.firstHead > own.firstHead) early.add(parent);
	}
	for (const { room, listing } of plan.rooms) if (early.has(listing.room_id)) tally(await restore.restoreRoom({ ...room, listing }, [], context));

	// Records held: per new room for the head, per tier below.
	const held = new Map<string, { records: ChatRecord[]; entries: number }>();
	const lower: ChatRecord[][] = view.tiers.map(() => []);
	let heldRecords = 0;
	let heldBytes = 0;
	const flushRoom = async (roomId: string): Promise<void> => {
		const parent = parentOf(roomId);
		if (parent !== undefined && held.get(parent)?.records.length) await flushRoom(parent);
		const buffer = held.get(roomId);
		if (!buffer?.records.length) return;
		const { room, listing } = byTarget.get(roomId)!;
		const records = buffer.records;
		held.set(roomId, { records: [], entries: 0 });
		tally(await restore.restoreRoom({ ...room, listing }, records, context));
	};
	const flushAll = async (): Promise<void> => {
		for (const { listing } of plan.rooms) await flushRoom(listing.room_id);
		for (let tier = 1; tier < lower.length; tier += 1) {
			const records = lower[tier]!.sort(byLog);
			lower[tier] = [];
			for (let start = 0; start < records.length; start += batch) await chain.tiers[tier]!.append(toRange(records.slice(start, start + batch)));
		}
		heldRecords = 0;
		heldBytes = 0;
	};
	const checkpoint = options.checkpoint ?? CHECKPOINT_RECORDS;
	const from = parseProgress(await restore.progress.get());
	for await (const line of recordLines(source, from, options.stats)) {
		for (const record of plan.select(line)) {
			const tiers = place(record.log_id, view, published);
			for (const tier of tiers) {
				if (tier > 0) {
					lower[tier]!.push(record);
					continue;
				}
				const count = entriesOf(record);
				const buffer = held.get(record.room_id) ?? { records: [], entries: 0 };
				if (buffer.records.length && (buffer.records.length >= batch || buffer.entries + count > entries)) await flushRoom(record.room_id);
				const fresh = held.get(record.room_id) ?? { records: [], entries: 0 };
				fresh.records.push(record);
				fresh.entries += count;
				held.set(record.room_id, fresh);
			}
			if (tiers.length) {
				heldRecords += 1;
				heldBytes += record.record_json.length;
			}
		}
		if (heldRecords >= checkpoint || heldBytes >= CHECKPOINT_BYTES) {
			await flushAll();
			await restore.progress.set(JSON.stringify(line.next));
		}
	}
	await flushAll();
}

/**
 * Pass 2 over a file whose rooms' records are not in log order (at most
 * MAX_SORTED_IMPORT_BYTES decoded): its records are read whole and sorted,
 * then written room by room, top-level rooms first, and to the tiers below.
 */
async function writeSorted(source: ArchiveLines, writer: Writer): Promise<void> {
	const { chain, restore, plan, view, published, batch, entries, context, tally } = writer;
	const records: ChatRecord[] = [];
	for await (const line of recordLines(source)) records.push(...plan.select(line));
	records.sort(byLog);
	const perTier: ChatRecord[][] = view.tiers.map(() => []);
	for (const record of records) for (const tier of place(record.log_id, view, published)) perTier[tier]!.push(record);
	for (const { room, listing } of plan.rooms) {
		const own = perTier[0]!.filter((record) => record.room_id === listing.room_id);
		const batches = restoreBatches(own, { records: batch, entries });
		if (!batches.length) tally(await restore.restoreRoom({ ...room, listing }, [], context));
		for (const each of batches) tally(await restore.restoreRoom({ ...room, listing }, each, context));
	}
	for (let tier = 1; tier < view.tiers.length; tier += 1) {
		for (let start = 0; start < perTier[tier]!.length; start += batch) await chain.tiers[tier]!.append(toRange(perTier[tier]!.slice(start, start + batch)));
	}
}
