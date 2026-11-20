/*
 * Segments of the blob tier (PLAN §5, §9): each one room's records over a
 * stretch of the log, stored as one complete ARCHIVE.md v1 file under a key
 * made of the room and the stretch, and listed in an index so reads need no
 * listing of the store.
 *
 * Keys are `${prefix}${encodeURIComponent(room)}/${pad16(first)}-${pad16(last)}.jsonl`:
 * a room's segments list in log order, and the key alone says what a segment
 * covers, so a lost index is rebuilt from a listing (rebuildSegmentIndex).
 *
 * The index is SqlSegmentIndex, over the Durable Object's SQLite through a
 * minimal SQL port (the tests have one in memory too). One index serves one
 * tier: a rebuild clears it first.
 */

import { collectArchive, jsonlReader, linesOf } from "@apron/archive";
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

/**
 * The most rows one index query reads (SqlSegmentIndex): every query is
 * bounded so, and the Store reserves for it (Store.segmentIndex). Where a
 * query could need more, it says what it leaves out.
 */
export const SEGMENT_QUERY_ROWS = 1_000;

/** Segments a room's query looks at below its range for one that reaches into it (find): segments of a room seldom overlap. */
export const STRADDLE_ROWS = 8;

/** Where a segment sits in a newest-first walk (`newest`), to continue after it. */
export type SegmentPosition = Pick<SegmentRef, "last" | "first" | "roomId">;

/**
 * Where segments are. The names are deterministic, so rebuildSegmentIndex
 * restores a lost index from a listing. Queries are bounded (SEGMENT_QUERY_ROWS): each
 * reads and returns at most that many segments, a room's at most that many
 * per room.
 */
export interface SegmentIndex {
	/**
	 * The segments of `roomIds` overlapping `[lower, upper]`, by room, then
	 * first: per room, at most `limit` (default SEGMENT_QUERY_ROWS) from the
	 * range's start (`forward`, the default) or its end, and the few starting
	 * below `lower` that reach into it.
	 */
	find(roomIds: readonly string[], lower: number, upper: number, options?: { forward?: boolean; limit?: number }): Promise<SegmentRef[]>;
	/**
	 * Segments overlapping `[lower, upper]`, by first, then room: of the
	 * SEGMENT_QUERY_ROWS segments ending first at or after `lower`, those
	 * starting at or before `upper` (so a long segment ending far past many
	 * others may be left out of a wide range).
	 */
	overlapping(lower: number, upper: number): Promise<SegmentRef[]>;
	/** At most `limit` segments wholly below `below` (`last < below`), newest first: by last, first and room, descending, strictly after `after`. */
	newest(below: number, limit: number, after?: SegmentPosition): Promise<SegmentRef[]>;
	/** At most `limit` segments starting below `floor`, by first, then room. */
	startingBelow(floor: number, limit: number): Promise<SegmentRef[]>;
	/** The lowest `first` of a segment wholly below `below`, looking at the SEGMENT_QUERY_ROWS lowest-starting segments; undefined if none of them is. */
	lowestBelow(below: number): Promise<number | undefined>;
	/** The lowest `first` of a segment straddling `floor` (`first < floor <= last`), looking at the SEGMENT_QUERY_ROWS segments starting nearest below it; undefined for none. */
	straddling(floor: number): Promise<number | undefined>;
	/** At most `limit` segments ending at or after `from`, by first, then room, strictly after `cursor`. */
	after(from: number, limit: number, cursor?: SegmentCursor): Promise<SegmentRef[]>;
	/** The `limit` segments ending first: by last, then first, then room. */
	oldest(limit: number): Promise<SegmentRef[]>;
	/** A room's segments, by first: at most SEGMENT_QUERY_ROWS, the first. */
	forRoom(roomId: string): Promise<SegmentRef[]>;
	/** Rooms with a segment, sorted: those of the first SEGMENT_QUERY_ROWS segments by room. */
	rooms(): Promise<string[]>;
	/** Adds segments; one already indexed at the same room and first is replaced. */
	add(refs: readonly SegmentRef[]): Promise<void>;
	/** Removes segments, each only while the index still names it under the same key. */
	remove(refs: readonly SegmentRef[]): Promise<void>;
	/** Forgets every segment. */
	clear(): Promise<void>;
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
		// In the orders queries walk (by last, by first), so a bounded query reads only what it returns.
		`CREATE INDEX IF NOT EXISTS ${table}_by_last ON ${table} ("last", "first", room_id)`,
		`CREATE INDEX IF NOT EXISTS ${table}_by_first ON ${table} ("first", room_id)`,
	];
}

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

	/** One value of an aggregate over a bounded subquery. */
	private value(sql: string, ...binds: unknown[]): number | undefined {
		const value = this.sql.rows<{ value: number | null }>(sql, ...binds)[0]?.value;
		return value === null || value === undefined ? undefined : Number(value);
	}

	async find(roomIds: readonly string[], lower: number, upper: number, options: { forward?: boolean; limit?: number } = {}): Promise<SegmentRef[]> {
		const limit = Math.min(options.limit ?? SEGMENT_QUERY_ROWS, SEGMENT_QUERY_ROWS);
		const out: SegmentRef[] = [];
		// One room at a time, by its primary key (room, first): each query reads what it returns.
		for (const roomId of [...new Set(roomIds)].sort()) {
			// Those starting below `lower` that reach into the range (few: a room's segments seldom overlap), then those starting in it.
			const straddling = this.sql.rows<SegmentRow>(
				`SELECT * FROM (SELECT ${COLUMNS} FROM ${this.table} WHERE room_id = ? AND "first" < ? ORDER BY "first" DESC LIMIT ?) WHERE last >= ? ORDER BY first`,
				roomId, lower, STRADDLE_ROWS, lower,
			).map(refOf);
			const inside = options.forward === false
				? this.select(`WHERE room_id = ? AND "first" >= ? AND "first" <= ?`, `"first" DESC LIMIT ?`, roomId, lower, upper, limit).reverse()
				: this.select(`WHERE room_id = ? AND "first" >= ? AND "first" <= ?`, `"first" LIMIT ?`, roomId, lower, upper, limit);
			out.push(...straddling, ...inside);
		}
		return out;
	}

	async overlapping(lower: number, upper: number): Promise<SegmentRef[]> {
		return this.sql.rows<SegmentRow>(
			`SELECT * FROM (SELECT ${COLUMNS} FROM ${this.table} WHERE "last" >= ? ORDER BY "last" LIMIT ?) WHERE first <= ? ORDER BY first, room_id`,
			lower, SEGMENT_QUERY_ROWS, upper,
		).map(refOf);
	}

	async newest(below: number, limit: number, after?: SegmentPosition): Promise<SegmentRef[]> {
		const bounded = Math.min(limit, SEGMENT_QUERY_ROWS);
		if (!after) return this.select(`WHERE "last" < ?`, `"last" DESC, "first" DESC, room_id DESC LIMIT ?`, below, bounded);
		// One range on the index (last <= the cursor's), the tie on `last` settled by first and room.
		return this.select(
			`WHERE "last" <= ? AND ("last" < ? OR "first" < ? OR ("first" = ? AND room_id < ?))`, `"last" DESC, "first" DESC, room_id DESC LIMIT ?`,
			Math.min(below - 1, after.last), after.last, after.first, after.first, after.roomId, bounded,
		);
	}

	async startingBelow(floor: number, limit: number): Promise<SegmentRef[]> {
		return this.select(`WHERE "first" < ?`, `"first", room_id LIMIT ?`, floor, Math.min(limit, SEGMENT_QUERY_ROWS));
	}

	async lowestBelow(below: number): Promise<number | undefined> {
		return this.value(`SELECT MIN(f) AS value FROM (SELECT "first" AS f, "last" AS l FROM ${this.table} ORDER BY "first" LIMIT ?) WHERE l < ?`, SEGMENT_QUERY_ROWS, below);
	}

	async straddling(floor: number): Promise<number | undefined> {
		return this.value(`SELECT MIN(f) AS value FROM (SELECT "first" AS f, "last" AS l FROM ${this.table} WHERE "first" < ? ORDER BY "first" DESC LIMIT ?) WHERE l >= ?`, floor, SEGMENT_QUERY_ROWS, floor);
	}

	async after(from: number, limit: number, cursor?: SegmentCursor): Promise<SegmentRef[]> {
		// Those starting before `from` that reach it (few), then those starting
		// from it on, by the index on first: no query walks segments wholly below `from`.
		const bounded = Math.min(limit, SEGMENT_QUERY_ROWS);
		const straddling = this.sql.rows<SegmentRow>(
			`SELECT * FROM (SELECT ${COLUMNS} FROM ${this.table} WHERE "first" < ? ORDER BY "first" DESC LIMIT ?) WHERE last >= ?`,
			from, SEGMENT_QUERY_ROWS, from,
		).map(refOf);
		const rest = cursor
			? this.select(`WHERE "first" >= ? AND ("first" > ? OR ("first" = ? AND room_id > ?))`, `"first", room_id LIMIT ?`, from, cursor.first, cursor.first, cursor.roomId, bounded)
			: this.select(`WHERE "first" >= ?`, `"first", room_id LIMIT ?`, from, bounded);
		const past = (ref: SegmentRef) => !cursor || ref.first > cursor.first || (ref.first === cursor.first && ref.roomId > cursor.roomId);
		return [...straddling.filter(past), ...rest].sort(byFirst).slice(0, bounded);
	}

	async oldest(limit: number): Promise<SegmentRef[]> {
		return this.select("", `"last", "first", room_id LIMIT ?`, Math.min(limit, SEGMENT_QUERY_ROWS));
	}

	async forRoom(roomId: string): Promise<SegmentRef[]> {
		return this.select("WHERE room_id = ?", `"first" LIMIT ?`, roomId, SEGMENT_QUERY_ROWS);
	}

	async rooms(): Promise<string[]> {
		return this.sql.rows<{ room_id: string }>(`SELECT DISTINCT room_id FROM (SELECT room_id FROM ${this.table} ORDER BY room_id LIMIT ?) ORDER BY room_id`, SEGMENT_QUERY_ROWS).map((row) => row.room_id);
	}

	async add(refs: readonly SegmentRef[]): Promise<void> {
		for (const ref of refs) {
			this.sql.run(`INSERT OR REPLACE INTO ${this.table} (room_id, "first", "last", key, records, bytes) VALUES (?, ?, ?, ?, ?, ?)`, ref.roomId, ref.first, ref.last, ref.key, ref.records, ref.bytes);
		}
	}

	async remove(refs: readonly SegmentRef[]): Promise<void> {
		for (const ref of refs) this.sql.run(`DELETE FROM ${this.table} WHERE room_id = ? AND "first" = ? AND key = ?`, ref.roomId, ref.first, ref.key);
	}

	/** Forgets every segment, a bounded page at a time. */
	async clear(): Promise<void> {
		for (;;) {
			const page = this.select("", `room_id, "first" LIMIT ?`, SEGMENT_QUERY_ROWS);
			if (!page.length) return;
			await this.remove(page);
		}
	}

}
