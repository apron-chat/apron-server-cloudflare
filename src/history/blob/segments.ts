/*
 * Segments of the blob tier (PLAN §5, §9): each one room's records over a
 * stretch of the log, stored as one complete ARCHIVE.md v1 file under a key
 * made of the room and the stretch, and listed in an index so reads need no
 * listing of the store.
 *
 * Keys are `${prefix}${encodeURIComponent(room)}/${pad16(first)}-${pad16(last)}.jsonl`:
 * a room's segments list in log order, and the key alone says what a segment
 * covers, so a lost index is rebuilt from a listing (`rebuild`).
 *
 * The index has two implementations: MemorySegmentIndex for tests and Node
 * scripts, and SqlSegmentIndex over the Durable Object's SQLite through a
 * minimal SQL port. One index serves one tier: `rebuild` clears it first.
 */

import { collectArchive, jsonlReader, linesOf } from "../archive/format";
import type { ChatRecord } from "../records";
import { byLog } from "../records";
import type { BlobStore } from "./store";

/** One segment: a room's records from `first` to `last` (inclusive), stored under `key`. */
export interface SegmentRef {
	roomId: string;
	first: number;
	last: number;
	key: string;
	/** Records it holds (one per log ID: a segment is one room's). */
	records: number;
	/** Its object's size in bytes. */
	bytes: number;
}

/** Where a segment sits in a scan's order, to continue after it. */
export interface SegmentCursor {
	first: number;
	roomId: string;
}

/** Where segments are. The names are deterministic, so `rebuild` restores a lost index from a listing. */
export interface SegmentIndex {
	/** The segments of `roomIds` overlapping `[lower, upper]`, by room, then first. */
	find(roomIds: readonly string[], lower: number, upper: number): Promise<SegmentRef[]>;
	/** Every room's segments overlapping `[lower, upper]`, by first, then room. */
	overlapping(lower: number, upper: number): Promise<SegmentRef[]>;
	/** At most `limit` segments ending at or after `from`, by first, then room, strictly after `cursor`. */
	after(from: number, limit: number, cursor?: SegmentCursor): Promise<SegmentRef[]>;
	/** The `limit` segments ending first: by last, then first, then room. */
	oldest(limit: number): Promise<SegmentRef[]>;
	/** A room's segments, by first. */
	forRoom(roomId: string): Promise<SegmentRef[]>;
	/** Every room with a segment, sorted. */
	rooms(): Promise<string[]>;
	/** Adds segments; one already indexed at the same room and first is replaced. */
	add(refs: readonly SegmentRef[]): Promise<void>;
	/** Removes segments, each only while the index still names it under the same key. */
	remove(refs: readonly SegmentRef[]): Promise<void>;
	/** Forgets every segment. */
	clear(): Promise<void>;
	/** Clears the index and adds every segment under `prefix` in `store`; returns how many. See rebuildSegmentIndex. */
	rebuild(store: BlobStore, prefix: string, options?: RebuildOptions): Promise<number>;
}

export interface RebuildOptions {
	/** Skips segments wholly below it (`last < floor`): objects a trim removed from the index but had yet to delete. */
	floor?: number;
	/** Reads each object to count its records (default true). Without it, `records` is 0 and retention by count sees nothing. */
	count?: boolean;
	/** Keeps the index as it is and adds only what it lacks (an admin's repair: a failure partway leaves it no worse). */
	keep?: boolean;
}

/** A log ID as 16 digits: every safe integer fits, and keys sort in log order. */
export function pad16(id: number): string {
	return String(id).padStart(16, "0");
}

/** A segment's key: `${prefix}${encodeURIComponent(room)}/${pad16(first)}-${pad16(last)}.jsonl`. */
export function segmentKey(prefix: string, ref: Pick<SegmentRef, "roomId" | "first" | "last">): string {
	return `${prefix}${encodeURIComponent(ref.roomId)}/${pad16(ref.first)}-${pad16(ref.last)}.jsonl`;
}

const KEY_PATTERN = /^([^/]+)\/(\d{16})-(\d{16})\.jsonl$/;

/** What a key names, or null for a key that segmentKey would not make (another prefix, another shape, a non-canonical room). */
export function parseSegmentKey(prefix: string, key: string): Pick<SegmentRef, "roomId" | "first" | "last"> | null {
	if (!key.startsWith(prefix)) return null;
	const match = KEY_PATTERN.exec(key.slice(prefix.length));
	if (!match) return null;
	let roomId: string;
	try {
		roomId = decodeURIComponent(match[1]);
	} catch {
		return null;
	}
	const first = Number(match[2]);
	const last = Number(match[3]);
	if (!roomId || encodeURIComponent(roomId) !== match[1] || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) return null;
	return { roomId, first, last };
}

/**
 * A segment's records, from its ARCHIVE.md text. Each is given the
 * segment's room: a move is stored in both rooms' segments, but its wire
 * shape names only the destination. One record per log ID (the last read).
 */
export async function decodeSegment(roomId: string, text: string): Promise<ChatRecord[]> {
	const archive = await collectArchive(jsonlReader(linesOf(text)));
	const byId = new Map<number, ChatRecord>();
	for (const record of archive.records) byId.set(record.log_id, { ...record, room_id: roomId });
	return [...byId.values()].sort(byLog);
}

/**
 * Clears `index` and adds every segment key under `prefix`, reading each
 * object to count its records unless `count` is false. Keys that are not
 * segment keys are ignored. Returns how many segments were added.
 */
export async function rebuildSegmentIndex(index: SegmentIndex, store: BlobStore, prefix: string, options: RebuildOptions = {}): Promise<number> {
	if (!options.keep) await index.clear();
	let added = 0;
	let cursor: string | undefined;
	do {
		const page = await store.list(prefix, cursor === undefined ? {} : { cursor });
		const refs: SegmentRef[] = [];
		for (const { key, size } of page.keys) {
			const named = parseSegmentKey(prefix, key);
			if (!named || (options.floor !== undefined && named.last < options.floor)) continue;
			if (options.keep && (await index.find([named.roomId], named.first, named.last)).some((ref) => ref.key === key)) continue;
			let records = 0;
			if (options.count !== false) {
				const object = await store.get(key);
				if (!object) continue;
				records = (await decodeSegment(named.roomId, await object.text())).length;
			}
			refs.push({ ...named, key, records, bytes: size });
		}
		await index.add(refs);
		added += refs.length;
		cursor = page.cursor;
	} while (cursor !== undefined);
	return added;
}

const byFirst = (a: SegmentRef, b: SegmentRef) => a.first - b.first || (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0);
const byRoom = (a: SegmentRef, b: SegmentRef) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0) || a.first - b.first;
const byLast = (a: SegmentRef, b: SegmentRef) => a.last - b.last || byFirst(a, b);

/** A SegmentIndex in memory. */
export class MemorySegmentIndex implements SegmentIndex {
	private readonly refs = new Map<string, SegmentRef>();

	private static id(ref: Pick<SegmentRef, "roomId" | "first">): string {
		return `${ref.roomId}\u0000${ref.first}`;
	}

	/** Every segment, by first. */
	all(): SegmentRef[] {
		return [...this.refs.values()].map((ref) => ({ ...ref })).sort(byFirst);
	}

	async find(roomIds: readonly string[], lower: number, upper: number): Promise<SegmentRef[]> {
		const rooms = new Set(roomIds);
		return this.all().filter((ref) => rooms.has(ref.roomId) && ref.first <= upper && ref.last >= lower).sort(byRoom);
	}

	async overlapping(lower: number, upper: number): Promise<SegmentRef[]> {
		return this.all().filter((ref) => ref.first <= upper && ref.last >= lower);
	}

	async after(from: number, limit: number, cursor?: SegmentCursor): Promise<SegmentRef[]> {
		return this.all()
			.filter((ref) => ref.last >= from && (!cursor || ref.first > cursor.first || (ref.first === cursor.first && ref.roomId > cursor.roomId)))
			.slice(0, limit);
	}

	async oldest(limit: number): Promise<SegmentRef[]> {
		return this.all().sort(byLast).slice(0, limit);
	}

	async forRoom(roomId: string): Promise<SegmentRef[]> {
		return this.all().filter((ref) => ref.roomId === roomId);
	}

	async rooms(): Promise<string[]> {
		return [...new Set(this.all().map((ref) => ref.roomId))].sort();
	}

	async add(refs: readonly SegmentRef[]): Promise<void> {
		for (const ref of refs) this.refs.set(MemorySegmentIndex.id(ref), { ...ref });
	}

	async remove(refs: readonly SegmentRef[]): Promise<void> {
		for (const ref of refs) {
			const id = MemorySegmentIndex.id(ref);
			if (this.refs.get(id)?.key === ref.key) this.refs.delete(id);
		}
	}

	async clear(): Promise<void> {
		this.refs.clear();
	}

	rebuild(store: BlobStore, prefix: string, options?: RebuildOptions): Promise<number> {
		return rebuildSegmentIndex(this, store, prefix, options);
	}
}

/**
 * The SQL the index needs, synchronous as the Durable Object's SQLite is
 * (`ctx.storage.sql.exec(...).toArray()`). The Store wires its own
 * accounting in front of it.
 */
export interface SqlPort {
	rows<T>(sql: string, ...binds: unknown[]): T[];
	run(sql: string, ...binds: unknown[]): void;
}

/** The default table. */
export const SEGMENT_TABLE = "history_segments";

/** The statements that create an index table (idempotent). Additive: older code ignores the table, and a missing one reads as empty. */
export function segmentSchema(table = SEGMENT_TABLE): string[] {
	checkTable(table);
	return [
		`CREATE TABLE IF NOT EXISTS ${table} (room_id TEXT NOT NULL, "first" INTEGER NOT NULL, "last" INTEGER NOT NULL, key TEXT NOT NULL, records INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (room_id, "first")) WITHOUT ROWID`,
		`CREATE INDEX IF NOT EXISTS ${table}_last ON ${table} ("last")`,
	];
}

/** The statements for the default table. */
export const SEGMENT_SCHEMA: readonly string[] = segmentSchema();

function checkTable(table: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`invalid segment table name ${JSON.stringify(table)}`);
}

interface SegmentRow {
	room_id: string;
	first: number;
	last: number;
	key: string;
	records: number;
	bytes: number;
}

const COLUMNS = `room_id, "first" AS first, "last" AS last, key, records, bytes`;

function refOf(row: SegmentRow): SegmentRef {
	return { roomId: row.room_id, first: Number(row.first), last: Number(row.last), key: row.key, records: Number(row.records), bytes: Number(row.bytes) };
}

/**
 * A SegmentIndex in SQLite (PLAN §9: the head's database). Call
 * `ensureSchema` once before use. `table` lets several blob tiers share one
 * database, one table each.
 */
export class SqlSegmentIndex implements SegmentIndex {
	readonly table: string;

	constructor(private readonly sql: SqlPort, options: { table?: string } = {}) {
		this.table = options.table ?? SEGMENT_TABLE;
		checkTable(this.table);
	}

	ensureSchema(): void {
		for (const statement of segmentSchema(this.table)) this.sql.run(statement);
	}

	private select(where: string, order: string, ...binds: unknown[]): SegmentRef[] {
		return this.sql.rows<SegmentRow>(`SELECT ${COLUMNS} FROM ${this.table} ${where} ORDER BY ${order}`, ...binds).map(refOf);
	}

	async find(roomIds: readonly string[], lower: number, upper: number): Promise<SegmentRef[]> {
		if (!roomIds.length) return [];
		return this.select(`WHERE room_id IN (SELECT value FROM json_each(?)) AND "first" <= ? AND "last" >= ?`, `room_id, "first"`, JSON.stringify(roomIds), upper, lower);
	}

	async overlapping(lower: number, upper: number): Promise<SegmentRef[]> {
		return this.select(`WHERE "first" <= ? AND "last" >= ?`, `"first", room_id`, upper, lower);
	}

	async after(from: number, limit: number, cursor?: SegmentCursor): Promise<SegmentRef[]> {
		if (!cursor) return this.select(`WHERE "last" >= ?`, `"first", room_id LIMIT ?`, from, limit);
		return this.select(`WHERE "last" >= ? AND ("first" > ? OR ("first" = ? AND room_id > ?))`, `"first", room_id LIMIT ?`, from, cursor.first, cursor.first, cursor.roomId, limit);
	}

	async oldest(limit: number): Promise<SegmentRef[]> {
		return this.select("", `"last", "first", room_id LIMIT ?`, limit);
	}

	async forRoom(roomId: string): Promise<SegmentRef[]> {
		return this.select("WHERE room_id = ?", `"first"`, roomId);
	}

	async rooms(): Promise<string[]> {
		return this.sql.rows<{ room_id: string }>(`SELECT DISTINCT room_id FROM ${this.table} ORDER BY room_id`).map((row) => row.room_id);
	}

	async add(refs: readonly SegmentRef[]): Promise<void> {
		for (const ref of refs) {
			this.sql.run(`INSERT OR REPLACE INTO ${this.table} (room_id, "first", "last", key, records, bytes) VALUES (?, ?, ?, ?, ?, ?)`, ref.roomId, ref.first, ref.last, ref.key, ref.records, ref.bytes);
		}
	}

	async remove(refs: readonly SegmentRef[]): Promise<void> {
		for (const ref of refs) this.sql.run(`DELETE FROM ${this.table} WHERE room_id = ? AND "first" = ? AND key = ?`, ref.roomId, ref.first, ref.key);
	}

	async clear(): Promise<void> {
		this.sql.run(`DELETE FROM ${this.table}`);
	}

	rebuild(store: BlobStore, prefix: string, options?: RebuildOptions): Promise<number> {
		return rebuildSegmentIndex(this, store, prefix, options);
	}
}
