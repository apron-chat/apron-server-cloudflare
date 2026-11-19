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
import { type BackupKeys, decryptingLines } from "./crypto";
import { namedUsers } from "./export";
import { type CollectedArchive, collectArchive, jsonlReader } from "./format";
import { IdMap, nudgeLogIds, remapListing, remapRecord } from "./ids";
import type { ArchivedRoom, ArchivedUser, ArchiveReader } from "./types";

export interface ImportOptions {
	/** Rooms that exist here are skipped whole (decision 6); the only mode for now. */
	existingRooms?: "skip";
	/**
	 * How the archive's user IDs map to accounts here (§10.4):
	 * - "auto" (default): "match" if the archive's `server` header is this server, else "new".
	 * - "match": an ID that exists here IS that user; IDs missing here become placeholders.
	 * - "new": every archive user becomes a new placeholder; an ID taken here, or retired, gets a free one (`ada-2`).
	 */
	users?: "auto" | "match" | "new";
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
	/** Drop an unfinished earlier import's journal and plan afresh. */
	restart?: boolean;
}

export interface ImportReport {
	roomsAdded: string[];
	roomsSkipped: string[];
	/** Each archive user and what it became. */
	users: Record<string, { matched: string } | { placeholder: string }>;
	/** Records imported (a move's copy in each room counted once per room). */
	records: number;
	duplicates: number;
	expired: number;
	/** Log and message IDs that moved (§10.3), and user IDs that changed (§10.4). */
	remapped: { logIds: Record<string, string>; users: Record<string, string> };
	/** Records placed per tier. */
	placed: Record<string, number>;
	dryRun: boolean;
	/** This run finished an earlier one that failed partway (its journal). */
	resumed: boolean;
}

/**
 * What an import that has begun writing keeps in the head (HistoryHead.journal),
 * so that running it again after a failure finishes it rather than skipping
 * the rooms it had begun: which archive, its user and log ID mapping, and the
 * rooms it adds. Cleared once the import finishes.
 */
interface ImportJournal {
	archive: string;
	users: ImportReport["users"];
	moved: Array<[number, number]>;
	rooms: string[];
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
 * otherwise. Without keys, an encrypted archive fails naming the key it needs.
 */
export function archiveReader(lines: AsyncIterable<string>, keys?: Pick<BackupKeys, "lookup">): ArchiveReader {
	return jsonlReader(decryptingLines(lines, keys ?? { lookup: async () => undefined }));
}

/** A record's content for duplicate detection: everything but where it is (room, previous room) and its log ID's spelling. */
function contentKey(record: ChatRecord): string {
	const { room_id: _room, prev_room_id: _prev, log_id: _log, ...rest } = JSON.parse(record.record_json) as Record<string, unknown>;
	return `${record.kind}\u0000${canonicalJson(rest)}`;
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
	const report: ImportReport = {
		roomsAdded: [], roomsSkipped: [], users: {}, records: 0, duplicates: 0, expired: 0,
		remapped: { logIds: {}, users: {} }, placed: {}, dryRun: Boolean(options.dryRun), resumed: false,
	};
	// An earlier run of this import that failed partway is finished with its own plan.
	const identity = archiveIdentity(archive);
	let journal: ImportJournal | undefined;
	const saved = head.journal ? await head.journal() : undefined;
	if (saved && options.restart && !options.dryRun) await head.setJournal?.(null);
	else if (saved) {
		const parsed = JSON.parse(saved) as ImportJournal;
		if (parsed.archive !== identity) throw new Error("another import is unfinished: run it again to finish it, or import this one with restart to drop it");
		journal = parsed;
		report.resumed = true;
	}

	// Rooms: the listed ones, and any that only records name.
	const rooms = new Map<string, ArchivedRoom>();
	for (const room of archive.rooms) rooms.set(room.listing.room_id, room);
	for (const record of archive.records) if (!rooms.has(record.room_id)) rooms.set(record.room_id, { listing: { room_id: record.room_id }, joined: false });
	// New rooms: those absent here, a room with nothing logged past its
	// creation (a new server's `general`), and those an unfinished run began.
	const fresh = new Set<string>();
	for (const roomId of rooms.keys()) {
		if (journal ? journal.rooms.includes(roomId) : !(await head.hasRoom(roomId)) || (head.roomIsEmpty ? await head.roomIsEmpty(roomId) : false)) fresh.add(roomId);
		else report.roomsSkipped.push(roomId);
	}
	// A move is read back once, in the room it moved to: its copy in the room
	// it left is made again when that room is new, whether or not the room it
	// went to is (else the message would show where it was before).
	const all = [...archive.records];
	const held = new Set(all.map((record) => `${record.log_id}\u0000${record.room_id}`));
	for (const record of archive.records) {
		if (record.kind !== "message") continue;
		const previous = (JSON.parse(record.record_json) as { prev_room_id?: string }).prev_room_id;
		if (previous && previous !== record.room_id && fresh.has(previous) && !held.has(`${record.log_id}\u0000${previous}`)) {
			all.push({ ...record, room_id: previous });
			held.add(`${record.log_id}\u0000${previous}`);
		}
	}
	let records = all.filter((record) => fresh.has(record.room_id)).sort(byLog);
	// A room's bounds where its listing lacks them: from its records, so its history starts and ends where they do.
	for (const roomId of fresh) {
		const own = records.filter((record) => record.room_id === roomId);
		if (!own.length) continue;
		const room = rooms.get(roomId)!;
		const listing = { ...room.listing };
		if (listing.log_id === undefined) listing.log_id = String(own[0].log_id);
		if (listing.latest_log_id === undefined || Number(listing.latest_log_id) < own[own.length - 1].log_id) listing.latest_log_id = String(own[own.length - 1].log_id);
		rooms.set(roomId, { ...room, listing });
	}

	// Users (§10.4).
	const mode = options.users === "match" || options.users === "new" ? options.users
		: archive.header.server !== undefined && archive.header.server === options.server ? "match" : "new";
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
	for (const id of [...ids].sort()) {
		const planned = journal?.users[id];
		if (planned) {
			// The unfinished run's mapping stands: its placeholders may exist already.
			report.users[id] = planned;
			const mapped = "matched" in planned ? planned.matched : planned.placeholder;
			if ("placeholder" in planned) {
				given.add(planned.placeholder);
				const { roles: _roles, ...rest } = profiles.get(id) ?? { user_id: id };
				placeholders.push({ ...rest, user_id: planned.placeholder });
			}
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
			if (await taken(override.placeholder)) throw new Error(`userMap gives ${id} the placeholder ${override.placeholder}, which is taken`);
			target = { placeholder: override.placeholder };
		} else if (mode === "match" && await exists(id)) {
			target = { matched: id };
		} else {
			target = { placeholder: await freeId(id, taken) };
		}
		report.users[id] = target;
		const mapped = "matched" in target ? target.matched : target.placeholder;
		if ("placeholder" in target) {
			given.add(target.placeholder);
			const profile = profiles.get(id) ?? { user_id: id };
			const { roles: _roles, ...rest } = profile;
			placeholders.push({ ...rest, user_id: target.placeholder });
		}
		users.set(id, mapped);
		if (mapped !== id) report.remapped.users[id] = mapped;
	}

	// Log IDs (§10.3).
	const imported = logIds(records).sort((a, b) => a - b);
	const moved = new Map<number, number>();
	if (journal) {
		// The unfinished run's log IDs stand: what it wrote is there under them.
		for (const [from, to] of journal.moved) moved.set(from, to);
	} else if (options.ids === "renumber") {
		let next = Math.max(options.clock.now(), (head.latest ? await head.latest() : 0) + 1);
		for (const id of imported) moved.set(id, next++);
	} else {
		const userMap = new IdMap(new Map(), users);
		const known = await existing(pipeline, imported);
		const duplicate = new Set<string>();
		for (const id of imported) {
			const here = known.get(id);
			if (!here) continue;
			const held = new Set(here.map(contentKey));
			for (const record of records.filter((entry) => entry.log_id === id)) {
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
	for (const [from, to] of moved) report.remapped.logIds[String(from)] = String(to);
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
	}
	for (const [index, view] of views.entries()) if (perTier[index].length) report.placed[view.name] = perTier[index].length;
	report.roomsAdded = [...fresh].map((roomId) => map.roomId(roomId));
	if (options.dryRun) return report;

	// Write, after noting the plan (a retry finishes it): placeholders, then
	// each room at the head, then the tiers below, oldest first. Every write
	// may be repeated without harm.
	if (!journal && head.setJournal) {
		await head.setJournal(JSON.stringify({ archive: identity, users: report.users, moved: [...moved], rooms: [...fresh] } satisfies ImportJournal));
	}
	const batch = options.batch ?? 200;
	for (let start = 0; start < placeholders.length; start += batch) await head.restoreUsers(placeholders.slice(start, start + batch));
	for (const roomId of fresh) {
		const room = rooms.get(roomId)!;
		const listing = remapListing({ ...room.listing }, map);
		const own = perTier[0].filter((record) => record.room_id === listing.room_id);
		const batches = restoreBatches(own, { records: batch, entries: options.entries ?? 1_000 });
		if (!batches.length) await head.restoreRoom({ ...room, listing }, []);
		for (const records of batches) await head.restoreRoom({ ...room, listing }, records);
	}
	for (let index = 1; index < views.length; index += 1) {
		const tier = pipeline.tiers[index];
		for (let start = 0; start < perTier[index].length; start += batch) await tier.append(toRange(perTier[index].slice(start, start + batch)));
	}
	await head.setJournal?.(null);
	return report;
}
