/*
 * importArchive (PLAN §10.2–§10.6): reads an ARCHIVE.md v1 file (plain, or
 * encrypted with a key the environment has, §13.3) into the pipeline.
 *
 * It plans first, writing nothing: which rooms are new (rooms that exist
 * here are skipped whole, decision 6), what each archive user becomes (an
 * existing account or an unclaimed placeholder, §10.4), which records are
 * duplicates of records held here (skipped), which collide with a different
 * record's log ID (moved to the next free millisecond, §10.3), and where
 * each record goes (§10.5): records older than the published floor are
 * dropped as expired; the rest go to the tier that serves their log ID, and
 * to each tier below it that already holds copies that far. A dry run stops
 * there and returns the plan's report. Then placeholders are made, and each
 * new room is restored at the head (with its records from the head's floor
 * on) and its older records appended to the tiers below.
 */

import type { HistoryPipeline } from "../pipeline";
import type { TierView } from "../plan";
import { type ChatRecord, type Clock, byLog, canonicalJson, logIds, toRange } from "../records";
import { type BackupKeys, type DecryptionStatus, decryptingLines } from "./crypto";
import { namedUsers } from "./export";
import { type CollectedArchive, collectArchive, jsonlReader, parseLogId } from "./format";
import { ADMIN_USER_ID, IdMap, nudgeLogIds, placeholderBase, remapListing, remapRecord, restorableUserId } from "./ids";
import type { ArchivedRoom, ArchivedUser, ArchiveReader } from "./types";

export interface ImportOptions {
	/** Rooms that exist here are skipped whole (decision 6); the only mode for now. */
	existingRooms?: "skip";
	/**
	 * How the archive's user IDs map to accounts here (§10.4):
	 * - "auto" (default): "match" if the archive is authenticated (`authenticated`) and its `server` header is this server, else "new".
	 * - "match": an ID that exists here IS that user; IDs missing here become placeholders. Authenticated archives only.
	 * - "new": every archive user becomes a new placeholder; an ID taken here, or retired, gets a free one (`ada-2`).
	 * An ID that cannot stand here (a guest's, a bot's, `~…`, and `admin` unless matched) becomes `imported-…` (placeholderBase).
	 */
	users?: "auto" | "match" | "new";
	/**
	 * Whether the archive was decrypted with one of this server's backup
	 * keys, so it is one of this server's backups (crypto.ts
	 * DecryptionStatus): only then may users be matched, since a plain file's
	 * `server` header is anyone's to write. Default false.
	 */
	authenticated?: boolean;
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

export interface ImportReport {
	roomsAdded: string[];
	roomsSkipped: string[];
	/** Each archive user and what it became. */
	users: Record<string, { matched: string } | { placeholder: string }>;
	/** New placeholder accounts this import makes (an unfinished run's included). */
	placeholders: number;
	/** Records imported (a move's copy in each room counted once per room). */
	records: number;
	/** The log IDs the imported records take here, lowest and highest. */
	logIdRange?: { first: number; last: number };
	duplicates: number;
	expired: number;
	/** Records dropped as no client could have sent them: a body a post could not have, a record too large, a user no account could be. */
	rejected: number;
	/** Messages whose ID another message here holds already: imported as records, their current state left as it is. */
	collisions: number;
	/** Records the file holds only as references (ARCHIVE.md §3.1): of rooms it does not list, or below a room's `history_log_id`. */
	references: number;
	/** Log and message IDs that moved (§10.3), and user IDs that changed (§10.4). */
	remapped: { logIds: Record<string, string>; users: Record<string, string> };
	/** Records placed per tier. */
	placed: Record<string, number>;
	dryRun: boolean;
	/** This run finished an earlier one that failed partway (its journal). */
	resumed: boolean;
	/** With `restart`: the rooms an abandoned import of another archive had begun, left as far as it got. */
	abandoned?: string[];
	/** Why this import would be refused (a dry run reports it rather than failing). */
	refused?: string;
}

/**
 * What an import that has begun writing keeps in the head (HistoryHead.journal),
 * so that running it again after a failure finishes it rather than skipping
 * the rooms it had begun: which archive, its user mapping and log ID
 * mapping (`renumber`: the first new ID, the rest following from it;
 * otherwise the IDs that moved), the rooms it adds, and their IDs here.
 * Cleared once the import finishes.
 */
interface ImportJournal {
	archive: string;
	users: ImportReport["users"];
	moved: Array<[number, number]>;
	renumber?: number;
	rooms: string[];
	targetRooms?: string[];
}

/** An archive's identity for the journal: its header and the extent of its records. */
function archiveIdentity(archive: CollectedArchive): string {
	const records = archive.records;
	return canonicalJson({ header: archive.header, records: records.length, first: records[0]?.log_id ?? null, last: records[records.length - 1]?.log_id ?? null });
}

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

/**
 * An archive reader over lines that may be an encrypted backup (§13.3): it
 * is decrypted chunk by chunk with the keys given, and read as plain
 * otherwise. Without keys, an encrypted archive fails naming the key it
 * needs. `status.encrypted` says, once the header is read, whether it was
 * decrypted (and so authenticated) with one of them.
 */
export function archiveReader(lines: AsyncIterable<string>, keys?: Pick<BackupKeys, "lookup">, status?: DecryptionStatus): ArchiveReader {
	return jsonlReader(decryptingLines(lines, keys ?? { lookup: async () => undefined }, status));
}

/** A recorded user as a client's record holds one: `user_id` and a `name` if a string, nothing else (no roles, no tier). */
function bareUser(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const user = value as { user_id?: unknown; name?: unknown };
	return { user_id: user.user_id, ...(typeof user.name === "string" && user.name !== "" ? { name: user.name } : {}) };
}

/** A record with every recorded user (`from`, reaction sets' `from`, members' `user`) made bare (bareUser); the same record when nothing changed. */
export function withBareUsers(record: ChatRecord): ChatRecord {
	const value = JSON.parse(record.record_json) as Record<string, unknown>;
	if ("from" in value) value.from = bareUser(value.from);
	if (Array.isArray(value.reactions)) value.reactions = value.reactions.map((set: unknown) => set && typeof set === "object" && !Array.isArray(set) ? { ...set, from: bareUser((set as { from?: unknown }).from) } : set);
	if (Array.isArray(value.members)) value.members = value.members.map((member: unknown) => member && typeof member === "object" && !Array.isArray(member) ? { ...member, user: bareUser((member as { user?: unknown }).user) } : member);
	const json = JSON.stringify(value);
	return json === record.record_json ? record : { ...record, record_json: json };
}

/** A record's content for duplicate detection: everything but where it is (room, previous room) and its log ID's spelling. */
function contentKey(record: ChatRecord): string {
	const { room_id: _room, prev_room_id: _prev, log_id: _log, ...rest } = JSON.parse(record.record_json) as Record<string, unknown>;
	return `${record.kind}\u0000${canonicalJson(rest)}`;
}

/** A message record without any embed's `output_ref`. */
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

/** Looks up existing records in batches, by log ID. */
async function existing(pipeline: HistoryPipeline, ids: readonly number[]): Promise<Map<number, ChatRecord[]>> {
	const found = new Map<number, ChatRecord[]>();
	for (let start = 0; start < ids.length; start += 500) {
		for (const record of await pipeline.lookup(ids.slice(start, start + 500))) {
			found.set(record.log_id, [...(found.get(record.log_id) ?? []), record]);
		}
	}
	return found;
}

/** A free user ID for `base`: itself, else `base-2`, `base-3`, ... (taken: an account, a retired ID, or one this import gives). */
async function freeId(base: string, taken: (id: string) => Promise<boolean>): Promise<string> {
	if (!(await taken(base))) return base;
	for (let suffix = 2; ; suffix += 1) {
		const candidate = `${base}-${suffix}`;
		if (!(await taken(candidate))) return candidate;
	}
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

/** Reads, plans and (unless a dry run) writes an archive into the pipeline. */
export async function importArchive(pipeline: HistoryPipeline, input: ArchiveReader | CollectedArchive, options: ImportOptions): Promise<ImportReport> {
	const archive = "parts" in input ? await collectArchive(input) : input;
	const head = pipeline.head;
	const authenticated = options.authenticated === true;
	const report: ImportReport = {
		roomsAdded: [], roomsSkipped: [], users: {}, placeholders: 0, records: 0, duplicates: 0, expired: 0, rejected: 0, collisions: 0, references: 0,
		remapped: { logIds: {}, users: {} }, placed: {}, dryRun: Boolean(options.dryRun), resumed: false,
	};
	// An earlier run of this import that failed partway is finished with its
	// own plan, whatever this run asks. An unfinished import of another
	// archive stops this one, unless `restart` abandons it.
	const identity = archiveIdentity(archive);
	let journal: ImportJournal | undefined;
	const saved = head.journal ? await head.journal() : undefined;
	if (saved) {
		const parsed = JSON.parse(saved) as ImportJournal;
		const begun = parsed.targetRooms ?? parsed.rooms ?? [];
		if (parsed.archive === identity) {
			journal = parsed;
			report.resumed = true;
		} else if (options.restart) {
			report.abandoned = begun;
		} else {
			throw new Error(`another import is unfinished${begun.length ? ` (rooms ${begun.join(", ")})` : ""}: run it again to finish it, or import this one with restart to abandon it`);
		}
	}
	const renumber = journal ? journal.renumber !== undefined : options.ids === "renumber";

	// Users may be matched to accounts here only from an archive this server
	// sealed: a plain file's `server` header is anyone's to write.
	if (options.users === "match" && !authenticated && !journal) {
		throw new Error("users match takes only a backup encrypted with one of this server's keys; this file is not one: import it with new");
	}
	const mode = journal ? undefined : options.users === "match" || options.users === "new" ? options.users
		: authenticated && archive.header.server !== undefined && archive.header.server === options.server ? "match" : "new";

	// Log IDs past the clock would hold back every later commit (the log head
	// only rises): an import keeping its IDs refuses them before planning.
	if (!renumber) {
		const horizon = options.clock.now() + FUTURE_LOG_ID_MS;
		const future = archive.records.find((record) => record.log_id > horizon)?.log_id
			?? archive.rooms.flatMap((room) => [room.listing.log_id, room.listing.latest_log_id, room.listing.history_log_id].map(parseLogId)).find((id) => id !== undefined && id > horizon);
		if (future !== undefined) {
			throw new Error(`this archive holds log ID ${future}, later than this server's clock: import it with renumber, which gives its records new log IDs`);
		}
	}

	// Rooms: the listed ones (a later listing replaces an earlier one). A
	// record of a room the file does not list, or below its room's
	// `history_log_id` (all of them where it is null), is a reference
	// (ARCHIVE.md §3.1), there for a `reply_to`: not imported.
	const rooms = new Map<string, ArchivedRoom>();
	for (const room of archive.rooms) rooms.set(room.listing.room_id, room);
	const stretchStart = (roomId: string): number | undefined => {
		const listed = rooms.get(roomId)?.listing.history_log_id;
		return listed === null ? Number.POSITIVE_INFINITY : listed === undefined ? undefined : Number(listed);
	};
	const inStretch = archive.records.filter((record) => {
		if (!rooms.has(record.room_id)) return false;
		const start = stretchStart(record.room_id);
		return start === undefined || record.log_id >= start;
	});
	report.references = archive.records.length - inStretch.length;
	// New rooms: those absent here, a room with nothing logged past its
	// creation (a new server's `general`), and those an unfinished run began.
	const fresh = new Set<string>();
	for (const roomId of [...rooms.keys()].sort()) {
		if (journal ? journal.rooms.includes(roomId) : !(await head.hasRoom(roomId)) || (head.roomIsEmpty ? await head.roomIsEmpty(roomId) : false)) fresh.add(roomId);
		else report.roomsSkipped.push(roomId);
	}
	// A move is read back once, in the room it moved to: its copy in the room
	// it left is made again when that room is new, whether or not the room it
	// went to is (else the message would show where it was before).
	const all = [...inStretch];
	const held = new Set(all.map((record) => `${record.log_id}\u0000${record.room_id}`));
	for (const record of inStretch) {
		if (record.kind !== "message") continue;
		const previous = (JSON.parse(record.record_json) as { prev_room_id?: string }).prev_room_id;
		if (previous && previous !== record.room_id && fresh.has(previous) && !held.has(`${record.log_id}\u0000${previous}`)) {
			all.push({ ...record, room_id: previous });
			held.add(`${record.log_id}\u0000${previous}`);
		}
	}
	// An embed's `output_ref` names this server's own storage: never taken from a file, as a client's is dropped (Store.normalizedBody).
	let records = all.filter((record) => fresh.has(record.room_id)).map(withoutOutputRefs).sort(byLog);
	// Renumbered, the records' IDs follow from the first new one and their
	// order alone (the journal keeps only that first), so they are fixed now,
	// before anything is dropped.
	const numbered = logIds(records).sort((a, b) => a - b);
	// Records as a client could have sent them (Store.restorableRecord): bare
	// recorded users, a body a post could have, within a snapshot's size.
	records = records.flatMap((record) => {
		const normalized = head.normalizeRecord ? head.normalizeRecord(withBareUsers(record)) : withBareUsers(record);
		if (normalized) return [normalized];
		report.rejected += 1;
		return [];
	});
	// A room's bounds: from its records, so its history starts and ends where
	// they do, whatever its listing says of its head.
	for (const roomId of fresh) {
		const own = records.filter((record) => record.room_id === roomId);
		if (!own.length) continue;
		const room = rooms.get(roomId)!;
		const listing = { ...room.listing };
		if (listing.log_id === undefined) listing.log_id = String(own[0].log_id);
		listing.latest_log_id = String(own[own.length - 1].log_id);
		rooms.set(roomId, { ...room, listing });
	}

	// Users (§10.4).
	const profiles = new Map<string, ArchivedUser>();
	for (const user of archive.users) profiles.set(user.user_id, { ...profiles.get(user.user_id), ...user });
	const ids = new Set<string>([...archive.users.map((user) => user.user_id), ...records.flatMap(namedUsers)]);
	for (const roomId of fresh) for (const member of rooms.get(roomId)!.listing.members ?? []) ids.add(member.user_id);
	const given = new Set<string>();
	const exists = async (id: string) => await head.hasUser(id);
	const retired = async (id: string) => head.isRetired ? head.isRetired(id) : false;
	const taken = async (id: string) => given.has(id) || await exists(id) || await retired(id);
	const users = new Map<string, string>();
	const placeholders: ArchivedUser[] = [];
	const addPlaceholder = (id: string, placeholder: string) => {
		given.add(placeholder);
		const { roles: _roles, ...rest } = profiles.get(id) ?? { user_id: id };
		placeholders.push({ ...rest, user_id: placeholder });
	};
	for (const id of [...ids].sort()) {
		const planned = journal?.users[id];
		if (planned) {
			// The unfinished run's mapping stands: its placeholders may exist already.
			report.users[id] = planned;
			const mapped = "matched" in planned ? planned.matched : planned.placeholder;
			if ("placeholder" in planned) addPlaceholder(id, planned.placeholder);
			users.set(id, mapped);
			if (mapped !== id) report.remapped.users[id] = mapped;
			continue;
		}
		const override = options.userMap?.[id];
		let target: { matched: string } | { placeholder: string };
		if (override && "existing" in override) {
			if (!(await exists(override.existing))) throw new Error(`userMap sends ${id} to ${override.existing}, which is no account here`);
			target = { matched: override.existing };
		} else if (override && "placeholder" in override) {
			if (!restorableUserId(override.placeholder)) throw new Error(`userMap gives ${id} the placeholder ${override.placeholder}, which no account here could be`);
			if (await taken(override.placeholder)) throw new Error(`userMap gives ${id} the placeholder ${override.placeholder}, which is taken`);
			target = { placeholder: override.placeholder };
		} else if (mode === "match" && (restorableUserId(id) || id === ADMIN_USER_ID) && await exists(id)) {
			target = { matched: id };
		} else {
			// An ID that cannot stand here (a guest's, a bot's, `~…`, `admin`) gets one that can.
			target = { placeholder: await freeId(restorableUserId(id) ? id : placeholderBase(id), taken) };
		}
		report.users[id] = target;
		const mapped = "matched" in target ? target.matched : target.placeholder;
		if ("placeholder" in target) addPlaceholder(id, target.placeholder);
		users.set(id, mapped);
		if (mapped !== id) report.remapped.users[id] = mapped;
	}
	report.placeholders = placeholders.length;
	const maxPlaceholders = options.maxPlaceholders ?? MAX_IMPORT_PLACEHOLDERS;
	if (!journal && placeholders.length > maxPlaceholders) {
		report.refused = `this archive would make ${placeholders.length} placeholder accounts, more than the ${maxPlaceholders} one import may make`;
	}

	// Log IDs (§10.3).
	const imported = logIds(records).sort((a, b) => a - b);
	const moved = new Map<number, number>();
	let renumberBase: number | undefined;
	if (renumber) {
		// Every record a new ID at the head: the first new one, then in order.
		renumberBase = journal?.renumber ?? Math.max(options.clock.now(), (head.latest ? await head.latest() : 0) + 1);
		for (const [index, id] of numbered.entries()) moved.set(id, renumberBase + index);
	} else if (journal) {
		// The unfinished run's log IDs stand: what it wrote is there under them.
		for (const [from, to] of journal.moved) moved.set(from, to);
	} else {
		const userMap = new IdMap(new Map(), users);
		const known = await existing(pipeline, imported);
		const duplicate = new Set<string>();
		const byId = new Map<number, ChatRecord[]>();
		for (const record of records) byId.set(record.log_id, [...(byId.get(record.log_id) ?? []), record]);
		for (const id of imported) {
			const here = known.get(id);
			if (!here) continue;
			const held = new Set(here.map(contentKey));
			for (const record of byId.get(id) ?? []) {
				// The same record as before, under this import's user mapping or none
				// (an earlier import's): a duplicate. Any other is a collision, moved below.
				if (held.has(contentKey(record)) || held.has(contentKey(remapRecord(record, userMap)))) duplicate.add(`${id}\u0000${record.room_id}`);
			}
		}
		report.duplicates = duplicate.size;
		records = records.filter((record) => !duplicate.has(`${record.log_id}\u0000${record.room_id}`));
		// Nudge the collisions and whatever they would cross, looking up each
		// place they land, until every one is free.
		const remaining = [...new Set(logIds(records))].sort((a, b) => a - b);
		const occupied = new Set(known.keys());
		for (let round = 0; ; round += 1) {
			const plan = nudgeLogIds(remaining, (id) => occupied.has(id));
			const more = await existing(pipeline, [...plan.values()].filter((id) => !occupied.has(id)));
			if (!more.size) {
				for (const [from, to] of plan) moved.set(from, to);
				break;
			}
			for (const id of more.keys()) occupied.add(id);
			if (round >= 32) throw new Error("could not find free log IDs for the colliding records");
		}
	}
	const map = new IdMap(moved, users);
	const kept = new Set(imported);
	for (const [from, to] of moved) if (kept.has(from)) report.remapped.logIds[String(from)] = String(to);
	records = records.map((record) => remapRecord(record, map)).sort(byLog);

	// Placement (§10.5).
	const views = await pipeline.views();
	const published = await pipeline.publishedFloor();
	const perTier: ChatRecord[][] = views.map(() => []);
	for (const record of records) {
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
	const freshRooms = [...fresh];
	report.roomsAdded = freshRooms.map((roomId) => map.roomId(roomId));

	// Renumbered, a room's listing keeps no log ID of its own: its bounds are
	// its records' new ones, and a room without records takes the next ID
	// after them (in room order, so a retry gives the same).
	const listingOf = (roomId: string, index: number) => {
		const listing = remapListing({ ...rooms.get(roomId)!.listing }, map);
		if (renumberBase === undefined) return listing;
		const target = map.roomId(roomId);
		const own = records.filter((record) => record.room_id === target);
		const first = own.length ? own[0].log_id : renumberBase + numbered.length + index;
		const last = own.length ? own[own.length - 1].log_id : first;
		return { ...listing, log_id: String(first), latest_log_id: String(last), history_log_id: listing.history_log_id === null && !own.length ? null : String(first) };
	};

	// The journal, checked before anything is written: an import too large to
	// resume is refused whole.
	const plan: ImportJournal = {
		archive: identity, users: report.users, moved: renumber ? [] : [...moved], ...(renumberBase !== undefined ? { renumber: renumberBase } : {}),
		rooms: freshRooms, targetRooms: report.roomsAdded,
	};
	const journalText = JSON.stringify(plan);
	if (!journal && !report.refused && journalText.length > MAX_JOURNAL_BYTES) {
		report.refused = `this import maps ${Object.keys(report.users).length} users and moves ${moved.size} log IDs, too many to resume from if it fails: import it with renumber, or in parts`;
	}
	if (options.dryRun) return report;
	if (report.refused) throw new Error(report.refused);

	// Write, after noting the plan (a retry finishes it): placeholders, then
	// each room at the head, then the tiers below, oldest first. Every write
	// may be repeated without harm.
	if (!journal && head.setJournal) await head.setJournal(journalText);
	const batch = options.batch ?? 200;
	for (let start = 0; start < placeholders.length; start += batch) await head.restoreUsers(placeholders.slice(start, start + batch));
	const context = { rooms: report.roomsAdded };
	for (const [index, roomId] of freshRooms.entries()) {
		const room = rooms.get(roomId)!;
		const listing = listingOf(roomId, index);
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
