/*
 * Chunks of the cold tier: the log of every room over a stretch of log
 * IDs, stored as one complete ARCHIVE.md v1 file (a header, then its
 * records) through a codec chain, and listed in a ChunkIndex.
 *
 * A move is two records with one log ID, one per room, and one wire
 * snapshot naming the destination: an archive holds the snapshot once and
 * reads it back in the destination room. So a chunk also carries, as an
 * extension line `copies` (which ARCHIVE.md readers ignore), the rooms each
 * such log ID is stored in, and decoding gives one record per room again.
 */

import { type ArchiveCodec, type ArchiveHeader, archiveName, encodedArchiveWriter, namedUsers, openArchive } from "@apron/archive";
import { type ChatRecord, byLog } from "../records";
import { storedChain, storedOptions } from "../storage/encoding";
import type { BlobStore } from "../storage/store";

/** One chunk, as the index lists it. */
export interface ChunkRef {
	/** The lowest log ID it covers: its identity in the index. */
	first: number;
	/** The highest log ID it covers. */
	last: number;
	/** Its object's key in the store. */
	key: string;
	/** Records it holds (each room's copy of a move counts). */
	records: number;
	/** Its stored size in bytes. */
	bytes: number;
	/** Rooms with a record in it, sorted: reads skip chunks without theirs. */
	rooms: string[];
	/** Users its records name (namedUsers), sorted: /purge and /rename skip chunks without theirs. */
	users: string[];
}

/**
 * Where the chunks are: a getter and a setter over storage the caller owns
 * (the Durable Object's SQLite in the Worker, memory in tests). One chunk is
 * one entry, so the index grows by entries, a small one per chunk.
 */
export interface ChunkIndex {
	/** Every chunk, in any order. */
	list(): Promise<ChunkRef[]>;
	/** Removes chunks (by `first`), then adds or replaces chunks (by `first`), as one change. */
	update(change: { put?: readonly ChunkRef[]; remove?: readonly number[] }): Promise<void>;
}

/** The extension line naming the rooms of log IDs not stored in their wire snapshot's room alone. */
const COPIES = "copies";

/** A log ID as 16 digits: every safe integer fits, and keys sort in log order. */
export function pad16(id: number): string {
	return String(id).padStart(16, "0");
}

/** A chunk's key: `<prefix><16-digit first>.jsonl`, with the codecs' extensions. */
export function chunkKey(prefix: string, first: number, codecs: readonly ArchiveCodec[]): string {
	return archiveName(`${prefix}${pad16(first)}`, codecs);
}

/** Records keyed by log ID and room, the last given winning, in log order. */
export function uniqueRecords(records: Iterable<ChatRecord>): ChatRecord[] {
	const byKey = new Map<string, ChatRecord>();
	for (const record of records) byKey.set(`${record.log_id}\u0000${record.room_id}`, record);
	return [...byKey.values()].sort(byLog);
}

/** What the index says of a chunk of `records` covering `[first, last]` under `key`. */
export function chunkRef(key: string, records: readonly ChatRecord[], bounds: { first: number; last: number }, bytes: number): ChunkRef {
	return {
		first: bounds.first, last: bounds.last, key, records: records.length, bytes,
		rooms: [...new Set(records.map((record) => record.room_id))].sort(),
		users: [...new Set(records.flatMap(namedUsers))].sort(),
	};
}

/** Log IDs whose records are not all in their wire snapshot's room: the rooms each is stored in. */
function copiesOf(records: readonly ChatRecord[]): Array<{ log_id: string; rooms: string[] }> {
	const rooms = new Map<number, { wire: string; stored: string[] }>();
	for (const record of records) {
		const wire = (JSON.parse(record.record_json) as { room_id?: unknown }).room_id;
		const entry = rooms.get(record.log_id) ?? { wire: typeof wire === "string" ? wire : record.room_id, stored: [] };
		entry.stored.push(record.room_id);
		rooms.set(record.log_id, entry);
	}
	return [...rooms].filter(([, entry]) => entry.stored.length !== 1 || entry.stored[0] !== entry.wire).map(([id, entry]) => ({ log_id: String(id), rooms: entry.stored.sort() }));
}

/** Writes `records` (sorted, unique) as one chunk under `key`; returns its stored size in bytes. */
export async function writeChunk(store: BlobStore, key: string, records: readonly ChatRecord[], codecs: readonly ArchiveCodec[], header: ArchiveHeader): Promise<number> {
	const writer = await store.writer(key, storedOptions(codecs));
	let bytes = 0;
	const archive = encodedArchiveWriter(async (chunk) => {
		bytes += chunk.byteLength;
		await writer.write(chunk);
	}, codecs);
	try {
		await archive.header(header);
		await archive.records(records);
		const copies = copiesOf(records);
		if (copies.length) await archive.extra(COPIES, copies);
		await archive.close();
		await writer.close();
	} catch (error) {
		await archive.abort(error);
		await writer.abort().catch(() => undefined);
		throw error;
	}
	return bytes;
}

/** A chunk's records, in log order, one per room and log ID; empty if its object is gone. */
export async function readChunk(store: BlobStore, key: string): Promise<ChatRecord[]> {
	const object = await store.get(key);
	if (!object) return [];
	const archive = openArchive(await object.stream(), { codecs: storedChain(key, object) });
	await archive.header();
	const records: ChatRecord[] = [];
	const copies = new Map<number, string[]>();
	for await (const part of archive.parts()) {
		if (part.kind === "records") records.push(...part.records);
		else if (part.kind === "extra" && part.key === COPIES) {
			for (const entry of part.values as Array<{ log_id?: unknown; rooms?: unknown }>) {
				if (typeof entry?.log_id === "string" && Array.isArray(entry.rooms)) copies.set(Number(entry.log_id), entry.rooms.filter((room): room is string => typeof room === "string"));
			}
		}
	}
	if (!copies.size) return uniqueRecords(records);
	return uniqueRecords(records.flatMap((record) => {
		const rooms = copies.get(record.log_id);
		return rooms ? rooms.map((room) => ({ ...record, room_id: room })) : [record];
	}));
}
