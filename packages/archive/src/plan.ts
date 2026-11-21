/*
 * planImport: what importing an archive into a history would do, before
 * anything is written. The library decides what
 * the archive means: which records are content and which references, a
 * move's copy in the room it left, which records duplicate ones held (same
 * content at the same log ID), which collide (moved to the next free
 * millisecond), and what each archive user becomes. The target says what is
 * true there (ImportTarget: rooms, users, records held), and the options
 * what is allowed (user ID rules, caps, how far ahead a log ID may be).
 *
 * Planning works from an index (indexArchive): one pass over the archive's
 * lines keeps its listings and users, and of each record only what planning
 * needs (its log ID, room, kind, the user it names and a hash of its
 * content), 25 bytes a record however large the record. planFromIndex
 * makes the plan from that, and the plan selects each line's records to
 * write as the file is read again (recordLines, StreamPlan.select), so an
 * archive larger than memory is imported in two passes over it.
 * planImport does both for an archive held whole.
 *
 * The result is the remapped records and listings to write, the
 * placeholders to make, a report, and the plan's state, a JSON value from
 * which the same plan is made again (`resume`): a server keeps it while it
 * writes, so a retry after a failure finishes the same import.
 */

import { IdMap, nudgeLogIds, remapListing, remapRecord } from "./ids.ts";
import { type ChatRecord, byLog, canonicalJson } from "./records.ts";
import type { ArchivedRoom, ArchivedUser, ArchiveHeader, RoomListing } from "./types.ts";
import { type CollectedArchive, checkHeader, parseLine, parseLogId, partsOfLine } from "./format.ts";
import { contentKey, withBareUsers } from "./validate.ts";
import { replayRecords } from "./replay.ts";
import { type ArchiveLines, type LinePosition, type ScannedLine, type ScanStats, collectedSource } from "./stream.ts";

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
	/**
	 * The accounts there: those in use, and the most it may hold. Each new
	 * placeholder takes one, so an import that would make more than there
	 * is room for is refused before anything is written.
	 */
	accounts?(): Promise<{ used: number; limit: number }>;
	/**
	 * Why the target has no room for these new rooms (its caps on rooms),
	 * or undefined when it has: given the listings of the rooms the import
	 * would create there (IDs as the target's), so an import past a cap is
	 * refused before anything is written.
	 */
	roomCapacity?(rooms: readonly RoomListing[]): Promise<string | undefined>;
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

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** How a plan's log IDs stand: renumbered from a first new one (in order), or kept, with the ones that collided moved. */
export type ImportIds = { mode: "renumber"; base: number } | { mode: "original"; moved: Array<[number, number]> };

/** A plan's state, as JSON: what a retry needs to make the same plan again (`resume`). */
export interface ImportState {
	/** archiveIdentity of the archive. */
	archive: string;
	users: Record<string, UserTarget>;
	ids: ImportIds;
	/** The rooms it adds: each by its ID in the archive and at the target. */
	rooms: Array<{ archive: string; target: string }>;
}

/**
 * An ImportState as JSON for a journal, compact: a user that stays itself is
 * `"="` (a placeholder of its own ID) or `"@"` (matched to its own ID), so
 * an archive of many users keeps a journal a fraction of their number in
 * bytes. parseImportState reads it back.
 */
export function importStateJson(state: ImportState): string {
	const users = Object.fromEntries(Object.entries(state.users).map(([id, target]) => [
		id, "placeholder" in target && target.placeholder === id ? "=" : "matched" in target && target.matched === id ? "@" : target,
	]));
	return JSON.stringify({ ...state, users });
}

/** An ImportState from its JSON (a journal, importStateJson), or undefined for text that is not one. */
export function parseImportState(text: string): ImportState | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isObject(value) || typeof value.archive !== "string" || !isObject(value.users) || !isObject(value.ids) || !Array.isArray(value.rooms)) return undefined;
	const users: Record<string, UserTarget> = {};
	for (const [id, target] of Object.entries(value.users)) {
		if (target === "=") users[id] = { placeholder: id };
		else if (target === "@") users[id] = { matched: id };
		else if (isObject(target) && (typeof target.placeholder === "string" || typeof target.matched === "string")) users[id] = target as UserTarget;
		else return undefined;
	}
	value.users = users;
	const ids = value.ids;
	const idsOk = (ids.mode === "renumber" && typeof ids.base === "number") || (ids.mode === "original" && Array.isArray(ids.moved) && ids.moved.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((id) => typeof id === "number")));
	const roomsOk = value.rooms.every((room) => isObject(room) && typeof room.archive === "string" && typeof room.target === "string");
	return idsOk && roomsOk ? value as unknown as ImportState : undefined;
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
	/**
	 * Rooms one user may be a member of (default: no cap): an import that
	 * would make anyone a member of more of the rooms it adds, by their
	 * listings and membership records, is refused. Its users are new
	 * placeholders (`match` aside), so these are all their rooms.
	 */
	maxMembershipsPerUser?: number;
	/** How far past `now` an `original` log ID may be (default 5 minutes): further, and the plan throws. */
	futureMs?: number;
	/** The state of an earlier run of this plan that stopped partway: its decisions stand. */
	resume?: ImportState;
	/** Applied to each content record first (dropping what the target must never take from a file, say). */
	prepare?(record: ChatRecord): ChatRecord;
	/** The most records an archive may hold (default: no cap): indexing one with more fails (indexArchive). */
	maxRecords?: number;
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
	/** Members a new room's listing names that were joined there with no membership record (the writer's count). */
	membersJoined: number;
	/** Members not joined there: a listed one with no account, or a join (listed or recorded) a cap of the target's refused (the writer's count). */
	membersSkipped: number;
	/** Records the file holds only as references (ARCHIVE.md §3.1). */
	references: number;
	/**
	 * Log (and so message) IDs moved off records held there, and user IDs
	 * that changed. A renumbered import lists no log IDs: every one is new,
	 * in the archive's order, from logIdRange's first (the plan's IdMap maps them).
	 */
	remapped: { logIds: Record<string, string>; users: Record<string, string> };
	/** Records placed per tier. */
	placed: Record<string, number>;
	dryRun: boolean;
	/** This run finished an earlier one that failed partway. */
	resumed: boolean;
	/** The rooms an abandoned import of another archive had begun, left as far as it got. */
	abandoned?: string[];
	/** The target's accounts before this import, where it says (ImportTarget.accounts): `placeholders` must fit in `limit - used`. */
	accounts?: { used: number; limit: number };
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

/** A 53-bit hash of a string (cyrb53): two records at one log ID with the same content key hash alike. */
function hash53(text: string): number {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

type TypedArray = Float64Array | Uint32Array | Int32Array | Uint8Array;

/** A typed array that grows as it is appended to. */
class Column<T extends TypedArray> {
	private data: T;
	private readonly make: (size: number) => T;
	length = 0;
	constructor(make: (size: number) => T, size = 1024) {
		this.make = make;
		this.data = make(size);
	}
	push(value: number): void {
		if (this.length === this.data.length) {
			const next = this.make(Math.ceil(this.data.length * 1.5));
			next.set(this.data as never);
			this.data = next;
		}
		this.data[this.length++] = value;
	}
	/** The values, the spare capacity dropped. */
	trim(): T {
		return this.data.slice(0, this.length) as T;
	}
}

/** The kinds a record may be, as an index stores them; a rejected record has REJECTED set. */
const KINDS = ["room", "message", "reactions", "membership"] as const;
const MESSAGE = 1;
const REJECTED = 0x80;
/** A record naming no user (ArchiveIndex.user). */
const NO_USER = 0xffffffff;

/**
 * An archive's index (indexArchive): its header and identity, its listings
 * and users as a CollectedArchive keeps them, and per record, in columns,
 * only what planning needs: log ID, room, kind (with whether it was
 * rejected), a hash of its content key and the user it names, 25 bytes a
 * record. Records are numbered in file order (entries, as recordLines
 * numbers them); the few that name more than one user, that moved from
 * another room, or that are memberships (kept whole, as normalized, since
 * member counts and listings are checked against them) are kept aside.
 */
export interface ArchiveIndex {
	header: ArchiveHeader;
	/** archiveIdentity of the archive. */
	identity: string;
	/** The last listing of each room. */
	rooms: Map<string, ArchivedRoom>;
	/** Each user's profile, later objects merged over earlier ones. */
	profiles: Map<string, ArchivedUser>;
	/** Records indexed. */
	entries: number;
	roomNames: string[];
	userNames: string[];
	logId: Float64Array;
	room: Uint32Array;
	kind: Uint8Array;
	key: Float64Array;
	/** The user each names (an index into userNames), or NO_USER; one naming more has them all in `moreUsers`. */
	user: Uint32Array;
	moreUsers: Map<number, Uint32Array>;
	/** The room each moved message left (an index into roomNames), by entry. */
	moved: Map<number, number>;
	/** Membership records as normalized, by entry. */
	memberships: Map<number, ChatRecord>;
	/** Decoded bytes read. */
	bytes: number;
}

export interface IndexOptions {
	/** Applied to each record before it is normalized (PlanOptions.prepare). */
	prepare?(record: ChatRecord): ChatRecord;
	/** The target's normalization (ImportTarget.normalize). */
	normalize?(record: ChatRecord): ChatRecord | null;
	/** The most records indexed: an archive with more fails the index. */
	maxRecords?: number;
	stats?: ScanStats;
}

/** A record as a plan reads it: prepared, its users bare, normalized as the target would; null if refused. */
function normalized(record: ChatRecord, options: Pick<IndexOptions, "prepare" | "normalize">): ChatRecord | null {
	const prepared = options.prepare ? options.prepare(record) : record;
	return options.normalize ? options.normalize(withBareUsers(prepared)) : withBareUsers(prepared);
}

interface NamedValue {
	from?: { user_id?: unknown };
	reactions?: Array<{ from?: { user_id?: unknown } }>;
	members?: Array<{ user?: { user_id?: unknown } }>;
}

/** The users a parsed record value names (namedUsers, without parsing it again). */
function namedIn(value: NamedValue): string[] {
	const ids = [
		value.from?.user_id,
		...(Array.isArray(value.reactions) ? value.reactions : []).map((set) => set?.from?.user_id),
		...(Array.isArray(value.members) ? value.members : []).map((member) => member?.user?.user_id),
	];
	return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

type JsonObjectLike = Record<string, unknown>;

/** The records part of a line's object, or none. */
function recordsOf(value: JsonObjectLike | undefined): ChatRecord[] {
	if (!value) return [];
	for (const part of partsOfLine(value)) if (part.kind === "records") return part.records;
	return [];
}

/** Where to read an archive's records again from: a line's start, and the number of records before it. */
export interface RecordPosition extends LinePosition {
	entry: number;
}

/** One line's records (partsOfLine's order), the first one's number (`entry`), and where the next line starts. */
export interface RecordLine {
	records: ChatRecord[];
	entry: number;
	next: RecordPosition;
}

/** An archive's lines, parsed, the first object line marked as its header (or none, read from a position past it). */
async function* objectLines(source: ArchiveLines, from: LinePosition | undefined, stats: ScanStats | undefined): AsyncIterable<{ scanned: ScannedLine; value: JsonObjectLike | undefined; header: boolean }> {
	let seen = from !== undefined;
	for await (const scanned of source.lines(from, stats)) {
		const value = parseLine(scanned.text);
		const header = value !== undefined && !seen;
		if (header) seen = true;
		yield { scanned, value, header };
	}
}

/**
 * An archive's records, line by line, numbered as indexArchive numbers
 * them: from the start, or from a position an earlier read gave
 * (`next`), discarding the decoded bytes before it unparsed.
 */
export async function* recordLines(source: ArchiveLines, from?: RecordPosition, stats?: ScanStats): AsyncIterable<RecordLine> {
	let entry = from?.entry ?? 0;
	for await (const { scanned, value, header } of objectLines(source, from, stats)) {
		const records = header ? [] : recordsOf(value);
		const first = entry;
		entry += records.length;
		yield { records, entry: first, next: { line: scanned.line + 1, offset: scanned.end, entry } };
	}
}

/** Indexes an archive in one pass over its lines (see ArchiveIndex). Throws for a file that is no archive, or holds more than `maxRecords` records. */
export async function indexArchive(source: ArchiveLines, options: IndexOptions = {}): Promise<ArchiveIndex> {
	let header: ArchiveHeader | undefined;
	const rooms = new Map<string, ArchivedRoom>();
	const profiles = new Map<string, ArchivedUser>();
	const names = () => {
		const list: string[] = [];
		const at = new Map<string, number>();
		return {
			list,
			of(id: string): number {
				let found = at.get(id);
				if (found === undefined) {
					found = list.length;
					list.push(id);
					at.set(id, found);
				}
				return found;
			},
		};
	};
	const roomNames = names();
	const userNames = names();
	const logId = new Column((n) => new Float64Array(n));
	const room = new Column((n) => new Uint32Array(n));
	const kind = new Column((n) => new Uint8Array(n));
	const key = new Column((n) => new Float64Array(n));
	const user = new Column((n) => new Uint32Array(n));
	const moreUsers = new Map<number, Uint32Array>();
	const moved = new Map<number, number>();
	const memberships = new Map<number, ChatRecord>();
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	let bytes = 0;
	for await (const { scanned, value, header: isHeader } of objectLines(source, undefined, options.stats)) {
		bytes = scanned.end;
		if (isHeader) {
			header = checkHeader(value, scanned.line + 1);
			continue;
		}
		if (!value) continue;
		for (const part of partsOfLine(value)) {
			if (part.kind === "listing") {
				for (const listing of part.joined) rooms.set(listing.room_id, { listing, joined: true });
				for (const listing of part.not_joined) rooms.set(listing.room_id, { listing, joined: false });
				for (const one of part.users) profiles.set(one.user_id, { ...profiles.get(one.user_id), ...one });
				continue;
			}
			if (part.kind !== "records") continue;
			for (const record of part.records) {
				const entry = logId.length;
				if (options.maxRecords !== undefined && entry >= options.maxRecords) throw new Error(`this archive holds more than ${options.maxRecords} records, more than one import takes`);
				first = Math.min(first, record.log_id);
				last = Math.max(last, record.log_id);
				logId.push(record.log_id);
				room.push(roomNames.of(record.room_id));
				if (record.kind === "message" && record.record_json.includes('"prev_room_id"')) {
					const from = (JSON.parse(record.record_json) as { prev_room_id?: unknown }).prev_room_id;
					if (typeof from === "string") moved.set(entry, roomNames.of(from));
				}
				const kindAt = KINDS.indexOf(record.kind as typeof KINDS[number]);
				const plain = normalized(record, options);
				if (!plain) {
					kind.push(kindAt | REJECTED);
					key.push(0);
					user.push(NO_USER);
					continue;
				}
				kind.push(kindAt);
				// Its content key (contentKey) and the users it names (namedUsers), from one parse.
				const { room_id: _room, prev_room_id: _prev, log_id: _log, ...rest } = JSON.parse(plain.record_json) as Record<string, unknown> & NamedValue;
				key.push(hash53(`${plain.kind}\u0000${canonicalJson(rest)}`));
				const named = [...new Set(namedIn(rest))].map((id) => userNames.of(id));
				user.push(named.length ? named[0]! : NO_USER);
				if (named.length > 1) moreUsers.set(entry, Uint32Array.from(named));
				if (record.kind === "membership") memberships.set(entry, plain);
			}
		}
	}
	const top = header ?? checkHeader(undefined, 0);
	const entries = logId.length;
	return {
		header: top,
		identity: canonicalJson({ header: top, records: entries, first: entries ? first : null, last: entries ? last : null }),
		rooms, profiles, entries, roomNames: roomNames.list, userNames: userNames.list,
		logId: logId.trim(), room: room.trim(), kind: kind.trim(), key: key.trim(), user: user.trim(), moreUsers, moved, memberships, bytes,
	};
}

/**
 * A plan made from an index (planFromIndex): ImportPlan without its
 * records, which `select` gives line by line as the archive is read again.
 */
export interface StreamPlan {
	report: ImportReport;
	rooms: ImportPlan["rooms"];
	placeholders: ArchivedUser[];
	map: IdMap;
	state: ImportState;
	/** Records it writes. */
	writes: number;
	/**
	 * Each write, in the order `select` gives them: its room (an index into
	 * `rooms`, the room IDs there) and its log ID there. What a writer
	 * places, counts and orders before reading the archive again.
	 */
	written(): { rooms: readonly string[]; room: Uint32Array; logId: Float64Array };
	/** The membership records it writes, remapped: what a new room's listing is checked against (the writer's membersOf). */
	memberships: ChatRecord[];
	/**
	 * The records to write from one line (recordLines): its records and the
	 * first one's number, prepared, normalized and remapped. Lines come in
	 * file order; any may be passed over (a writer resuming further on).
	 */
	select(line: Pick<RecordLine, "records" | "entry">): ChatRecord[];
}

/** Sorted numbers without repeats. */
function distinct(sorted: ArrayLike<number>): number[] {
	const out: number[] = [];
	for (let at = 0; at < sorted.length; at += 1) if (!at || sorted[at] !== sorted[at - 1]) out.push(sorted[at]!);
	return out;
}

/** Whether sorted `values` holds `value`. */
function holds(values: readonly number[], value: number): boolean {
	let low = 0;
	let high = values.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if (values[middle] === value) return true;
		if (values[middle]! < value) low = middle + 1;
		else high = middle - 1;
	}
	return false;
}

/**
 * Plans importing the archive `index` indexes into `target`, writing
 * nothing (see planImport). `source` is the same archive: read again only
 * to compare, under this import's user mapping, records held at the same
 * log IDs.
 */
export async function planFromIndex(index: ArchiveIndex, source: ArchiveLines, target: ImportTarget, options: PlanOptions): Promise<StreamPlan> {
	const resume = options.resume;
	const rules = options.userIds ?? defaultUserIdRules;
	const matchable = rules.matchable ?? rules.restorable;
	const authenticated = options.authenticated === true;
	const report: ImportReport = {
		roomsAdded: [], roomsSkipped: [], users: {}, placeholders: 0, records: 0, duplicates: 0, expired: 0, rejected: 0, collisions: 0, membersJoined: 0, membersSkipped: 0, references: 0,
		remapped: { logIds: {}, users: {} }, placed: {}, dryRun: false, resumed: Boolean(resume),
	};
	const renumber = resume ? resume.ids.mode === "renumber" : options.ids === "renumber";
	const { logId, room, kind, roomNames, userNames } = index;
	const nameOf = (at: number) => roomNames[at]!;
	const normalizing = { ...(options.prepare ? { prepare: options.prepare } : {}), ...(target.normalize ? { normalize: (one: ChatRecord) => target.normalize!(one) } : {}) };

	// Users may be matched to accounts only from an archive the target
	// sealed: a plain file's `server` header is anyone's to write.
	if (options.users === "match" && !authenticated && !resume) {
		throw new Error("users match needs an archive verified as this server's own, by an authenticating codec, and none verified this one: import it with new");
	}
	const mode = resume ? undefined : options.users === "match" || options.users === "new" ? options.users
		: authenticated && index.header.server !== undefined && index.header.server === options.server ? "match" : "new";

	// Log IDs past the clock would hold back every later commit (a log head
	// only rises): a plan keeping its IDs refuses them.
	if (!renumber) {
		const horizon = options.now() + (options.futureMs ?? 5 * 60_000);
		let future: number | undefined;
		for (let entry = 0; entry < index.entries; entry += 1) if (logId[entry]! > horizon && (future === undefined || logId[entry]! < future)) future = logId[entry]!;
		future ??= [...index.rooms.values()].flatMap((one) => [one.listing.log_id, one.listing.latest_log_id, one.listing.history_log_id].map(parseLogId)).find((id) => id !== undefined && id > horizon);
		if (future !== undefined) {
			throw new Error(`this archive holds log ID ${future}, later than this server's clock: import it with renumber, which gives its records new log IDs`);
		}
	}

	// Rooms by name order, to sort by without comparing strings.
	const rank = new Uint32Array(roomNames.length);
	for (const [at, roomAt] of roomNames.map((_, roomAt) => roomAt).sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0)).entries()) rank[roomAt] = at;

	// Entries in log order (byLog), ties in file order.
	const order = new Uint32Array(index.entries);
	for (let entry = 0; entry < index.entries; entry += 1) order[entry] = entry;
	order.sort((a, b) => logId[a]! - logId[b]! || rank[room[a]!]! - rank[room[b]!]! || a - b);

	// A record repeated (a move a writer took from both rooms' histories,
	// each naming the room it went to) is read once: the last one stands. A
	// record of a room the file does not list, or below its room's
	// `history_log_id`, is a reference (ARCHIVE.md §3.1), there for a `reply_to`.
	const rooms = new Map(index.rooms);
	const startOf = roomNames.map((name) => {
		const listed = rooms.get(name);
		if (!listed) return Number.POSITIVE_INFINITY;
		const history = listed.listing.history_log_id;
		return history === null ? Number.POSITIVE_INFINITY : history === undefined ? Number.NEGATIVE_INFINITY : Number(history);
	});
	const content = new Uint32Array(index.entries);
	let contents = 0;
	for (let at = 0; at < order.length; at += 1) {
		const entry = order[at]!;
		const next = order[at + 1];
		if (next !== undefined && logId[next] === logId[entry] && room[next] === room[entry]) continue;
		if (logId[entry]! >= startOf[room[entry]!]!) content[contents++] = entry;
		else report.references += 1;
	}

	// New rooms: those absent, a room with nothing logged past its creation,
	// and those an unfinished run began. Rooms that exist are skipped whole.
	const fresh = new Set<string>();
	for (const roomId of [...rooms.keys()].sort()) {
		if (resume ? resume.rooms.some((one) => one.archive === roomId) : !(await target.hasRoom(roomId)) || (target.roomIsEmpty ? await target.roomIsEmpty(roomId) : false)) fresh.add(roomId);
		else report.roomsSkipped.push(roomId);
	}
	const isFresh = roomNames.map((name) => fresh.has(name));

	// Items: a record to write in a room, its own or (a move) its copy in the
	// room it left. A move is read back once, in the room it moved to: its
	// copy in the room it left is made again when that room is new, whether
	// or not the room it went to is (else the message would show where it was
	// before).
	const present = new Map<number, Set<number>>();
	for (const entry of index.moved.keys()) present.set(logId[entry]!, new Set());
	const ownEntries: number[] = [];
	for (let at = 0; at < contents; at += 1) {
		const entry = content[at]!;
		present.get(logId[entry]!)?.add(room[entry]!);
		if (isFresh[room[entry]!]) ownEntries.push(entry);
	}
	const copyEntries: number[] = [];
	const copyRooms: number[] = [];
	for (let at = 0; at < contents; at += 1) {
		const entry = content[at]!;
		const from = index.moved.get(entry);
		if (from === undefined || from === room[entry] || (kind[entry]! & ~REJECTED) !== MESSAGE || !isFresh[from]) continue;
		const there = present.get(logId[entry]!)!;
		if (there.has(from)) continue;
		there.add(from);
		copyEntries.push(entry);
		copyRooms.push(from);
	}
	// In log order (byLog): the copies merged in among the room's own, which are in it already.
	const total = ownEntries.length + copyEntries.length;
	const itemEntry = new Uint32Array(total);
	const itemRoom = new Uint32Array(total);
	{
		const copies = copyEntries.map((_, at) => at).sort((a, b) => logId[copyEntries[a]!]! - logId[copyEntries[b]!]! || rank[copyRooms[a]!]! - rank[copyRooms[b]!]!);
		let own = 0;
		let copy = 0;
		for (let at = 0; at < total; at += 1) {
			const ownEntry = ownEntries[own];
			const copyAt = copies[copy];
			const takeCopy = copyAt !== undefined && (ownEntry === undefined || logId[copyEntries[copyAt]!]! - logId[ownEntry]! < 0 || (logId[copyEntries[copyAt]!] === logId[ownEntry] && rank[copyRooms[copyAt]!]! < rank[room[ownEntry]!]!));
			if (takeCopy) {
				itemEntry[at] = copyEntries[copyAt]!;
				itemRoom[at] = copyRooms[copyAt]!;
				copy += 1;
			} else {
				itemEntry[at] = ownEntry!;
				itemRoom[at] = room[ownEntry!]!;
				own += 1;
			}
		}
	}
	const itemLog = (item: number) => logId[itemEntry[item]!]!;
	// Renumbered, the records' IDs follow from the first new one and their
	// order alone (the state keeps only that first), so they are fixed now,
	// before anything is dropped.
	const numbered = distinct(Float64Array.from(itemEntry, (entry) => logId[entry]!));
	// Records as a client could have sent them.
	let kept: Uint32Array;
	{
		const out = new Uint32Array(total);
		let count = 0;
		for (let item = 0; item < total; item += 1) {
			if (kind[itemEntry[item]!]! & REJECTED) report.rejected += 1;
			else out[count++] = item;
		}
		kept = out.slice(0, count);
	}
	// A room's bounds: from its records, so its history starts and ends where
	// they do, whatever its listing says of its head.
	const bounds = new Map<string, { first: number; last: number }>();
	for (const item of kept) {
		const name = nameOf(itemRoom[item]!);
		const found = bounds.get(name);
		if (!found) bounds.set(name, { first: itemLog(item), last: itemLog(item) });
		else found.last = itemLog(item);
	}
	for (const [roomId, { first, last }] of bounds) {
		const one = rooms.get(roomId)!;
		const listing = { ...one.listing };
		if (listing.log_id === undefined) listing.log_id = String(first);
		listing.latest_log_id = String(last);
		rooms.set(roomId, { ...one, listing });
	}
	const usersOf = (entry: number): string[] => {
		const more = index.moreUsers.get(entry);
		if (more) return Array.from(more, (at) => userNames[at]!);
		const one = index.user[entry]!;
		return one === NO_USER ? [] : [userNames[one]!];
	};

	// Users: those the import uses, as a record names them or a new room's
	// listing lists them as members. A user the file only lists (a scene's
	// reader, say) gets no account: nothing here would show it.
	const ids = new Set<string>();
	for (const item of kept) for (const one of usersOf(itemEntry[item]!)) ids.add(one);
	for (const roomId of fresh) for (const member of rooms.get(roomId)!.listing.members ?? []) ids.add(member.user_id);
	const given = new Set<string>();
	const exists = async (id: string) => await target.hasUser(id);
	const retired = async (id: string) => (target.isRetired ? target.isRetired(id) : false);
	const taken = async (id: string) => given.has(id) || await exists(id) || await retired(id);
	const users = new Map<string, string>();
	const placeholders: ArchivedUser[] = [];
	const addPlaceholder = (id: string, placeholder: string) => {
		given.add(placeholder);
		const { roles: _roles, ...rest } = index.profiles.get(id) ?? { user_id: id };
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
	if (target.accounts) report.accounts = await target.accounts();
	if (!resume && report.accounts && placeholders.length > report.accounts.limit - report.accounts.used) {
		const { used, limit } = report.accounts;
		report.refused = `this archive would make ${placeholders.length} placeholder accounts, but there is room for ${Math.max(0, limit - used)} more (${used} of ${limit} accounts are in use)`;
	} else if (!resume && options.maxPlaceholders !== undefined && placeholders.length > options.maxPlaceholders) {
		report.refused = `this archive would make ${placeholders.length} placeholder accounts, more than the ${options.maxPlaceholders} one import may make`;
	}
	// Membership records of the items kept, in their rooms (a membership record is no move: its room is its own).
	const membershipsKept = () => Array.from(kept).flatMap((item) => {
		const record = index.memberships.get(itemEntry[item]!);
		return record ? [{ ...record, room_id: nameOf(itemRoom[item]!) }] : [];
	});
	const maxMemberships = options.maxMembershipsPerUser;
	if (!resume && !report.refused && maxMemberships !== undefined) {
		const counts = new Map<string, number>();
		for (const members of replayRecords(membershipsKept(), [...fresh].map((roomId) => rooms.get(roomId)!)).members.values()) {
			for (const userId of members) counts.set(userId, (counts.get(userId) ?? 0) + 1);
		}
		const over = [...counts].find(([, count]) => count > maxMemberships);
		if (over) report.refused = `this archive would make ${over[0]} a member of ${over[1]} rooms, more than the ${maxMemberships} anyone may be in`.slice(0, 300);
	}

	// Log IDs.
	const imported = distinct(Float64Array.from(kept, itemLog));
	const moved = new Map<number, number>();
	let renumberBase: number | undefined;
	if (renumber) {
		// Every record a new ID after the target's latest, in order (IdMap.renumbered).
		renumberBase = resume?.ids.mode === "renumber" ? resume.ids.base : Math.max(options.now(), (target.latest ? await target.latest() : 0) + 1);
	} else if (resume) {
		// The unfinished run's log IDs stand: what it wrote is there under them.
		if (resume.ids.mode === "original") for (const [from, to] of resume.ids.moved) moved.set(from, to);
	} else {
		const userMap = new IdMap(new Map(), users);
		const known = await held(target, imported);
		const heldKeys = new Map<number, Set<number>>();
		for (const [id, here] of known) heldKeys.set(id, new Set(here.map((record) => hash53(contentKey(record)))));
		// The same record as before, under this import's user mapping or none
		// (an earlier import's): a duplicate. Any other is a collision, moved below.
		const duplicate = new Set<number>();
		const recheck = new Map<number, number[]>();
		for (const item of kept) {
			const entry = itemEntry[item]!;
			const keys = heldKeys.get(logId[entry]!);
			if (!keys) continue;
			if (keys.has(index.key[entry]!)) duplicate.add(item);
			else if (usersOf(entry).some((one) => users.get(one) !== one)) recheck.set(entry, [...(recheck.get(entry) ?? []), item]);
		}
		if (recheck.size) {
			// Under the user mapping: those few records read again.
			const lastEntry = Math.max(...recheck.keys());
			for await (const line of recordLines(source)) {
				if (line.entry > lastEntry) break;
				for (const [at, record] of line.records.entries()) {
					const items = recheck.get(line.entry + at);
					if (!items) continue;
					const plain = normalized(record, normalizing);
					if (plain && heldKeys.get(record.log_id)!.has(hash53(contentKey(remapRecord(plain, userMap))))) for (const item of items) duplicate.add(item);
				}
			}
		}
		report.duplicates = duplicate.size;
		if (duplicate.size) kept = kept.filter((item) => !duplicate.has(item));
		// Nudge the collisions and whatever they would cross, looking up each
		// place they land, until every one is free.
		const remaining = distinct(Float64Array.from(kept, itemLog));
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
	// The log IDs moved off others' are reported; renumbered, every one is new, and none is listed (logIdRange has them).
	const map = new IdMap(moved, users, renumberBase !== undefined ? { ids: numbered, base: renumberBase } : undefined);
	for (const [from, to] of moved) if (holds(imported, from)) report.remapped.logIds[String(from)] = String(to);
	// Top-level rooms before threads, each in name order: a thread's parent
	// must exist where it is restored, and a thread names it.
	const parentOf = (roomId: string) => rooms.get(roomId)!.listing.parent_room_id;
	const freshRooms = [...fresh].sort((a, b) => Number(typeof parentOf(a) === "string") - Number(typeof parentOf(b) === "string") || (a < b ? -1 : a > b ? 1 : 0));
	report.roomsAdded = freshRooms.map((roomId) => map.roomId(roomId));
	// The rooms it would create there (not those it fills) must fit the target's caps on rooms.
	if (!resume && !report.refused && target.roomCapacity) {
		const created: RoomListing[] = [];
		for (const roomId of freshRooms) if (!(await target.hasRoom(roomId))) created.push(remapListing({ ...rooms.get(roomId)!.listing }, map));
		const refused = created.length ? await target.roomCapacity(created) : undefined;
		if (refused) report.refused = refused;
	}

	// Renumbered, a room's listing keeps no log ID of its own: its bounds are
	// its records' new ones, and a room without records takes the next ID
	// after them (in room order, so a retry gives the same).
	const newBounds = new Map<string, { first: number; last: number }>();
	for (const item of kept) {
		const name = nameOf(itemRoom[item]!);
		const id = map.logId(itemLog(item));
		const found = newBounds.get(name);
		if (!found) newBounds.set(name, { first: id, last: id });
		else {
			found.first = Math.min(found.first, id);
			found.last = Math.max(found.last, id);
		}
	}
	const listingOf = (roomId: string, at: number): RoomListing => {
		const listing = remapListing({ ...rooms.get(roomId)!.listing }, map);
		if (renumberBase === undefined) return listing;
		const own = newBounds.get(roomId);
		const first = own ? own.first : renumberBase + numbered.length + at;
		const last = own ? own.last : first;
		return { ...listing, log_id: String(first), latest_log_id: String(last), history_log_id: listing.history_log_id === null && !own ? null : String(first) };
	};

	const state: ImportState = {
		archive: index.identity, users: report.users,
		ids: renumberBase !== undefined ? { mode: "renumber", base: renumberBase } : { mode: "original", moved: [...moved] },
		rooms: freshRooms.map((roomId, at) => ({ archive: roomId, target: report.roomsAdded[at]! })),
	};

	// What to write, in file order: by entry (a move's copy beside its record).
	const writeOrder = Array.from(kept).sort((a, b) => itemEntry[a]! - itemEntry[b]! || a - b);
	const writes = {
		entry: Uint32Array.from(writeOrder, (item) => itemEntry[item]!),
		room: Uint32Array.from(writeOrder, (item) => itemRoom[item]!),
		logId: Float64Array.from(writeOrder, itemLog),
	};
	return {
		report,
		rooms: freshRooms.map((roomId, at) => ({ roomId, room: rooms.get(roomId)!, listing: listingOf(roomId, at) })),
		placeholders,
		map,
		state,
		writes: writes.entry.length,
		...writing(writes, roomNames, normalizing, map),
		memberships: membershipsKept().map((record) => remapRecord(record, map)),
	};
}

/**
 * StreamPlan.written and select over the writes (by entry, then room):
 * made apart from planFromIndex, so a plan holds these and not the index
 * and the arrays it was made with.
 */
function writing(writes: { entry: Uint32Array; room: Uint32Array; logId: Float64Array }, roomNames: readonly string[], normalizing: Pick<IndexOptions, "prepare" | "normalize">, map: IdMap): Pick<StreamPlan, "written" | "select"> {
	let cursor = 0;
	return {
		written: () => ({ rooms: roomNames.map((name) => map.roomId(name)), room: writes.room, logId: writes.logId.map((id) => map.logId(id)) }),
		select({ records, entry }) {
			while (cursor < writes.entry.length && writes.entry[cursor]! < entry) cursor += 1;
			const out: ChatRecord[] = [];
			for (; cursor < writes.entry.length && writes.entry[cursor]! < entry + records.length; cursor += 1) {
				const record = records[writes.entry[cursor]! - entry];
				if (!record || record.log_id !== writes.logId[cursor]) throw new Error(`the archive is not the one planned (record ${writes.entry[cursor]! + 1})`);
				const name = roomNames[writes.room[cursor]!]!;
				const plain = normalized(name === record.room_id ? record : { ...record, room_id: name }, normalizing);
				if (plain) out.push(remapRecord(plain, map));
			}
			return out;
		},
	};
}

/** Plans importing `archive` into `target`, writing nothing. Throws for an import that cannot be planned. */
export async function planImport(archive: CollectedArchive, target: ImportTarget, options: PlanOptions): Promise<ImportPlan> {
	const source = collectedSource(archive);
	const index = await indexArchive(source, {
		...(options.prepare ? { prepare: options.prepare } : {}),
		...(target.normalize ? { normalize: (record: ChatRecord) => target.normalize!(record) } : {}),
		...(options.maxRecords !== undefined ? { maxRecords: options.maxRecords } : {}),
	});
	const plan = await planFromIndex(index, source, target, options);
	const records: ChatRecord[] = [];
	for await (const line of recordLines(source)) records.push(...plan.select(line));
	records.sort(byLog);
	return { report: plan.report, rooms: plan.rooms, placeholders: plan.placeholders, records, map: plan.map, state: plan.state };
}
