/*
 * planImport: what importing an archive into a history would do, before
 * anything is written (PLAN §10.2–§10.4, §10.6). The library decides what
 * the archive means: which records are content and which references, a
 * move's copy in the room it left, which records duplicate ones held (same
 * content at the same log ID), which collide (moved to the next free
 * millisecond), and what each archive user becomes. The target says what is
 * true there (ImportTarget: rooms, users, records held), and the options
 * what is allowed (user ID rules, caps, how far ahead a log ID may be).
 *
 * The result is the remapped records and listings to write, the
 * placeholders to make, a report, and the plan's state, a JSON value from
 * which the same plan is made again (`resume`): a server keeps it while it
 * writes, so a retry after a failure finishes the same import.
 */

import { IdMap, nudgeLogIds, remapListing, remapRecord } from "./ids.ts";
import { type ChatRecord, byLog, logIds, namedUsers } from "./records.ts";
import type { ArchivedRoom, ArchivedUser, RoomListing } from "./types.ts";
import { type CollectedArchive, parseLogId } from "./format.ts";
import { archiveIdentity, contentKey, splitReferences, withBareUsers } from "./validate.ts";

/** What is true where an archive is imported to. */
export interface ImportTarget {
	hasRoom(roomId: string): Promise<boolean>;
	/** A room that exists with nothing logged past its creation (a new server's `general`), which an import may fill. */
	roomIsEmpty?(roomId: string): Promise<boolean>;
	hasUser(userId: string): Promise<boolean>;
	/** A user ID that may not be given again (purged or renamed away). */
	isRetired?(userId: string): Promise<boolean>;
	/** The newest log ID given there (renumbering starts after it). */
	latest?(): Promise<number>;
	/** The records held at these log IDs, in any room. */
	lookup(logIds: readonly number[]): Promise<ChatRecord[]>;
	/**
	 * A record as the target would take it from a client, or null when none
	 * could have sent it (the target's own rules: body normalization, size
	 * caps). It gets the record with its recorded users bare (withBareUsers).
	 * Library validation does not replace it.
	 */
	normalize?(record: ChatRecord): ChatRecord | null;
}

/** Which archive user IDs may stand at the target as themselves. */
export interface UserIdRules {
	/** May be an account there, matched or as a placeholder. */
	restorable(userId: string): boolean;
	/** May be matched to an existing account (default: restorable). */
	matchable?(userId: string): boolean;
	/** The ID a user whose ID cannot stand there starts from (freeUserId adds `-2`, ...). */
	placeholderBase(userId: string): string;
}

/** Any ID of protocol shape may stand; others start from `imported-…`. */
export const defaultUserIdRules: UserIdRules = {
	restorable: (userId) => /^[^\s\p{Cc}~][^\s\p{Cc}]*$/u.test(userId),
	placeholderBase: (userId) => `imported-${userId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+/, "").slice(0, 40).replace(/[-_]+$/, "") || "user"}`,
};

/** What an archive user becomes: an existing account, or a new placeholder. */
export type UserTarget = { matched: string } | { placeholder: string };

/** A plan's state, as JSON: what a retry needs to make the same plan again (`resume`). */
export interface ImportState {
	/** archiveIdentity of the archive. */
	archive: string;
	users: Record<string, UserTarget>;
	/** Log IDs that moved (not with `renumber`). */
	moved: Array<[number, number]>;
	/** Renumbered: the first new log ID (the rest follow in order). */
	renumber?: number;
	/** The rooms it adds, by their IDs in the archive. */
	rooms: string[];
	/** The same rooms, by their IDs at the target. */
	targetRooms: string[];
}

export interface PlanOptions {
	/**
	 * How the archive's user IDs map to accounts at the target:
	 * - "auto" (default): "match" if the archive is authenticated and its `server` header is `server`, else "new".
	 * - "match": an ID that exists there IS that user; IDs missing there become placeholders. Authenticated archives only.
	 * - "new": every archive user becomes a new placeholder; an ID taken there, or retired, gets a free one (`ada-2`).
	 */
	users?: "auto" | "match" | "new";
	/** The archive is known to be the target's own (verified by an authenticating codec, openArchive): only then may users be matched. */
	authenticated?: boolean;
	/** Per-user decisions overriding `users`: an existing account, or a placeholder ID. */
	userMap?: Record<string, { existing: string } | { placeholder: string }>;
	/** "original" (default) keeps log IDs, moving only collisions; "renumber" gives every record a new one after the target's latest. */
	ids?: "original" | "renumber";
	/** The target's name, compared with the archive's `server` for "auto". */
	server?: string;
	/** The target's clock, in milliseconds. */
	now(): number;
	/** Which IDs may stand as themselves (default defaultUserIdRules). */
	userIds?: UserIdRules;
	/** New placeholders one import may make (default: no cap); past it, the report says why it would be refused. */
	maxPlaceholders?: number;
	/** How far past `now` an `original` log ID may be (default 5 minutes): further, and the plan throws. */
	futureMs?: number;
	/** The state of an earlier run of this plan that stopped partway: its decisions stand. */
	resume?: ImportState;
	/** Applied to each content record first (dropping what the target must never take from a file, say). */
	prepare?(record: ChatRecord): ChatRecord;
}

/** What an import did, or (planned) would do. The plan fills what planning knows; the writer the rest. */
export interface ImportReport {
	roomsAdded: string[];
	roomsSkipped: string[];
	/** Each archive user and what it became. */
	users: Record<string, UserTarget>;
	/** New placeholder accounts this import makes (an unfinished run's included). */
	placeholders: number;
	/** Records imported (a move's copy in each room counted once per room). */
	records: number;
	/** The log IDs the imported records take there, lowest and highest. */
	logIdRange?: { first: number; last: number };
	duplicates: number;
	expired: number;
	/** Records dropped as no client could have sent them (ImportTarget.normalize). */
	rejected: number;
	/** Messages whose ID another message there holds already: imported as records, their current state left as it is. */
	collisions: number;
	/** Records the file holds only as references (ARCHIVE.md §3.1). */
	references: number;
	/** Log and message IDs that moved, and user IDs that changed. */
	remapped: { logIds: Record<string, string>; users: Record<string, string> };
	/** Records placed per tier. */
	placed: Record<string, number>;
	dryRun: boolean;
	/** This run finished an earlier one that failed partway. */
	resumed: boolean;
	/** The rooms an abandoned import of another archive had begun, left as far as it got. */
	abandoned?: string[];
	/** Why this import would be refused. */
	refused?: string;
}

/** A planned import: what to write, and how. */
export interface ImportPlan {
	report: ImportReport;
	/** The rooms it adds, by their IDs in the archive, in order; each with its listing remapped (`listing`). */
	rooms: Array<{ roomId: string; room: ArchivedRoom; listing: RoomListing }>;
	/** Placeholder accounts to make, with their profiles. */
	placeholders: ArchivedUser[];
	/** Every record to write, remapped, in log order. */
	records: ChatRecord[];
	map: IdMap;
	state: ImportState;
}

/** An async free user ID for `base`: itself, else `base-2`, `base-3`, ... */
async function freeUserIdAsync(base: string, taken: (id: string) => Promise<boolean>): Promise<string> {
	if (!(await taken(base))) return base;
	for (let suffix = 2; ; suffix += 1) {
		const candidate = `${base}-${suffix}`;
		if (!(await taken(candidate))) return candidate;
	}
}

/** Records held at these log IDs, by log ID. */
async function held(target: ImportTarget, ids: readonly number[]): Promise<Map<number, ChatRecord[]>> {
	const found = new Map<number, ChatRecord[]>();
	if (!ids.length) return found;
	for (const record of await target.lookup(ids)) found.set(record.log_id, [...(found.get(record.log_id) ?? []), record]);
	return found;
}

/** Plans importing `archive` into `target`, writing nothing. Throws for an import that cannot be planned. */
export async function planImport(archive: CollectedArchive, target: ImportTarget, options: PlanOptions): Promise<ImportPlan> {
	const resume = options.resume;
	const rules = options.userIds ?? defaultUserIdRules;
	const matchable = rules.matchable ?? rules.restorable;
	const authenticated = options.authenticated === true;
	const report: ImportReport = {
		roomsAdded: [], roomsSkipped: [], users: {}, placeholders: 0, records: 0, duplicates: 0, expired: 0, rejected: 0, collisions: 0, references: 0,
		remapped: { logIds: {}, users: {} }, placed: {}, dryRun: false, resumed: Boolean(resume),
	};
	const renumber = resume ? resume.renumber !== undefined : options.ids === "renumber";

	// Users may be matched to accounts only from an archive the target
	// sealed: a plain file's `server` header is anyone's to write.
	if (options.users === "match" && !authenticated && !resume) {
		throw new Error("users match needs an archive verified as this server's own, by an authenticating codec, and none verified this one: import it with new");
	}
	const mode = resume ? undefined : options.users === "match" || options.users === "new" ? options.users
		: authenticated && archive.header.server !== undefined && archive.header.server === options.server ? "match" : "new";

	// Log IDs past the clock would hold back every later commit (a log head
	// only rises): a plan keeping its IDs refuses them.
	if (!renumber) {
		const horizon = options.now() + (options.futureMs ?? 5 * 60_000);
		const future = archive.records.find((record) => record.log_id > horizon)?.log_id
			?? archive.rooms.flatMap((room) => [room.listing.log_id, room.listing.latest_log_id, room.listing.history_log_id].map(parseLogId)).find((id) => id !== undefined && id > horizon);
		if (future !== undefined) {
			throw new Error(`this archive holds log ID ${future}, later than this server's clock: import it with renumber, which gives its records new log IDs`);
		}
	}

	const { rooms, content, references } = splitReferences(archive);
	report.references = references.length;
	// New rooms: those absent, a room with nothing logged past its creation,
	// and those an unfinished run began. Rooms that exist are skipped whole.
	const fresh = new Set<string>();
	for (const roomId of [...rooms.keys()].sort()) {
		if (resume ? resume.rooms.includes(roomId) : !(await target.hasRoom(roomId)) || (target.roomIsEmpty ? await target.roomIsEmpty(roomId) : false)) fresh.add(roomId);
		else report.roomsSkipped.push(roomId);
	}
	// A move is read back once, in the room it moved to: its copy in the room
	// it left is made again when that room is new, whether or not the room it
	// went to is (else the message would show where it was before).
	const all = [...content];
	const copies = new Set(all.map((record) => `${record.log_id}\u0000${record.room_id}`));
	for (const record of content) {
		if (record.kind !== "message") continue;
		const previous = (JSON.parse(record.record_json) as { prev_room_id?: string }).prev_room_id;
		if (previous && previous !== record.room_id && fresh.has(previous) && !copies.has(`${record.log_id}\u0000${previous}`)) {
			all.push({ ...record, room_id: previous });
			copies.add(`${record.log_id}\u0000${previous}`);
		}
	}
	let records = all.filter((record) => fresh.has(record.room_id)).map((record) => (options.prepare ? options.prepare(record) : record)).sort(byLog);
	// Renumbered, the records' IDs follow from the first new one and their
	// order alone (the state keeps only that first), so they are fixed now,
	// before anything is dropped.
	const numbered = logIds(records).sort((a, b) => a - b);
	// Records as a client could have sent them.
	records = records.flatMap((record) => {
		const normalized = target.normalize ? target.normalize(withBareUsers(record)) : withBareUsers(record);
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
		if (listing.log_id === undefined) listing.log_id = String(own[0]!.log_id);
		listing.latest_log_id = String(own[own.length - 1]!.log_id);
		rooms.set(roomId, { ...room, listing });
	}

	// Users (§10.4).
	const profiles = new Map<string, ArchivedUser>();
	for (const user of archive.users) profiles.set(user.user_id, { ...profiles.get(user.user_id), ...user });
	const ids = new Set<string>([...archive.users.map((user) => user.user_id), ...records.flatMap(namedUsers)]);
	for (const roomId of fresh) for (const member of rooms.get(roomId)!.listing.members ?? []) ids.add(member.user_id);
	const given = new Set<string>();
	const exists = async (id: string) => await target.hasUser(id);
	const retired = async (id: string) => (target.isRetired ? target.isRetired(id) : false);
	const taken = async (id: string) => given.has(id) || await exists(id) || await retired(id);
	const users = new Map<string, string>();
	const placeholders: ArchivedUser[] = [];
	const addPlaceholder = (id: string, placeholder: string) => {
		given.add(placeholder);
		const { roles: _roles, ...rest } = profiles.get(id) ?? { user_id: id };
		placeholders.push({ ...rest, user_id: placeholder });
	};
	for (const id of [...ids].sort()) {
		const planned = resume?.users[id];
		let decided: UserTarget;
		if (planned) {
			// The unfinished run's mapping stands: its placeholders may exist already.
			decided = planned;
		} else {
			const override = options.userMap?.[id];
			if (override && "existing" in override) {
				if (!(await exists(override.existing))) throw new Error(`userMap sends ${id} to ${override.existing}, which is no account here`);
				decided = { matched: override.existing };
			} else if (override && "placeholder" in override) {
				if (!rules.restorable(override.placeholder)) throw new Error(`userMap gives ${id} the placeholder ${override.placeholder}, which no account here could be`);
				if (await taken(override.placeholder)) throw new Error(`userMap gives ${id} the placeholder ${override.placeholder}, which is taken`);
				decided = { placeholder: override.placeholder };
			} else if (mode === "match" && matchable(id) && await exists(id)) {
				decided = { matched: id };
			} else {
				// An ID that cannot stand there gets one that can.
				decided = { placeholder: await freeUserIdAsync(rules.restorable(id) ? id : rules.placeholderBase(id), taken) };
			}
		}
		report.users[id] = decided;
		const mapped = "matched" in decided ? decided.matched : decided.placeholder;
		if ("placeholder" in decided) addPlaceholder(id, decided.placeholder);
		users.set(id, mapped);
		if (mapped !== id) report.remapped.users[id] = mapped;
	}
	report.placeholders = placeholders.length;
	if (!resume && options.maxPlaceholders !== undefined && placeholders.length > options.maxPlaceholders) {
		report.refused = `this archive would make ${placeholders.length} placeholder accounts, more than the ${options.maxPlaceholders} one import may make`;
	}

	// Log IDs (§10.3).
	const imported = logIds(records).sort((a, b) => a - b);
	const moved = new Map<number, number>();
	let renumberBase: number | undefined;
	if (renumber) {
		// Every record a new ID after the target's latest, in order.
		renumberBase = resume?.renumber ?? Math.max(options.now(), (target.latest ? await target.latest() : 0) + 1);
		for (const [index, id] of numbered.entries()) moved.set(id, renumberBase + index);
	} else if (resume) {
		// The unfinished run's log IDs stand: what it wrote is there under them.
		for (const [from, to] of resume.moved) moved.set(from, to);
	} else {
		const userMap = new IdMap(new Map(), users);
		const known = await held(target, imported);
		const duplicate = new Set<string>();
		const byId = new Map<number, ChatRecord[]>();
		for (const record of records) byId.set(record.log_id, [...(byId.get(record.log_id) ?? []), record]);
		for (const id of imported) {
			const here = known.get(id);
			if (!here) continue;
			const keys = new Set(here.map(contentKey));
			for (const record of byId.get(id) ?? []) {
				// The same record as before, under this import's user mapping or none
				// (an earlier import's): a duplicate. Any other is a collision, moved below.
				if (keys.has(contentKey(record)) || keys.has(contentKey(remapRecord(record, userMap)))) duplicate.add(`${id}\u0000${record.room_id}`);
			}
		}
		report.duplicates = duplicate.size;
		records = records.filter((record) => !duplicate.has(`${record.log_id}\u0000${record.room_id}`));
		// Nudge the collisions and whatever they would cross, looking up each
		// place they land, until every one is free.
		const remaining = [...new Set(logIds(records))].sort((a, b) => a - b);
		const occupied = new Set(known.keys());
		for (let round = 0; ; round += 1) {
			const nudged = nudgeLogIds(remaining, (id) => occupied.has(id));
			const more = await held(target, [...nudged.values()].filter((id) => !occupied.has(id)));
			if (!more.size) {
				for (const [from, to] of nudged) moved.set(from, to);
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
	const freshRooms = [...fresh];
	report.roomsAdded = freshRooms.map((roomId) => map.roomId(roomId));

	// Renumbered, a room's listing keeps no log ID of its own: its bounds are
	// its records' new ones, and a room without records takes the next ID
	// after them (in room order, so a retry gives the same).
	const listingOf = (roomId: string, index: number): RoomListing => {
		const listing = remapListing({ ...rooms.get(roomId)!.listing }, map);
		if (renumberBase === undefined) return listing;
		const there = map.roomId(roomId);
		const own = records.filter((record) => record.room_id === there);
		const first = own.length ? own[0]!.log_id : renumberBase + numbered.length + index;
		const last = own.length ? own[own.length - 1]!.log_id : first;
		return { ...listing, log_id: String(first), latest_log_id: String(last), history_log_id: listing.history_log_id === null && !own.length ? null : String(first) };
	};

	const state: ImportState = {
		archive: archiveIdentity(archive), users: report.users, moved: renumber ? [] : [...moved], ...(renumberBase !== undefined ? { renumber: renumberBase } : {}),
		rooms: freshRooms, targetRooms: report.roomsAdded,
	};
	return {
		report,
		rooms: freshRooms.map((roomId, index) => ({ roomId, room: rooms.get(roomId)!, listing: listingOf(roomId, index) })),
		placeholders,
		records,
		map,
		state,
	};
}

