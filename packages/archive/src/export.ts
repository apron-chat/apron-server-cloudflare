/*
 * exportArchive: a history as one ARCHIVE.md v1 file, from any source of
 * rooms, users and records (ArchiveSource): a server's storage, a client's
 * `room_list` and `history` pages, another archive.
 *
 * The file: a header (no `you`: an export of a history is no one's view),
 * one listing part with every room as `not_joined`, then each room's
 * records in log order, a page at a time, each page preceded by the users
 * it names that no earlier part did. Nothing past a page is held in memory.
 * A move is logged in both rooms, and each may serve it in its history,
 * naming the room it went to: it is written once, the first time it comes.
 */

import { type ChatRecord, namedUsers } from "./records.ts";
import type { ArchiveHeader, ArchivedRoom, ArchivedUser, ArchiveWriter } from "./types.ts";

/** Where an export reads a history from. */
export interface ArchiveSource {
	/** Every room, as a listing (`room_list`'s shape) with its members. */
	rooms(): Promise<ArchivedRoom[]>;
	/** These users' profiles, as far as they are known. */
	users(userIds: readonly string[]): Promise<ArchivedUser[]>;
	/** One room's records from its floor on, oldest first, a page at a time. */
	records(roomId: string): AsyncIterable<ChatRecord[]>;
	/** The log ID history starts at, for every room: no listing's `history_log_id` is below it. */
	floor?(): Promise<number>;
}

export interface ExportOptions {
	/** Only these rooms (default: every room). */
	roomIds?: readonly string[];
	/** Private rooms too (default true); without them, their records stay out. */
	privateRooms?: boolean;
	/** Header fields: `server` above all, and `media`. */
	header?: Partial<ArchiveHeader>;
	/** The header's `exported_at` (default: now). */
	exportedAt?: string;
	/** Makes a page's records what clients would get (a server puts back what it keeps elsewhere, say). */
	prepare?(records: ChatRecord[]): Promise<ChatRecord[]>;
}

export interface ExportReport {
	rooms: number;
	users: number;
	records: number;
	sections: string[];
}

/** A private room (PROTOCOL §4.2.4): marked so in its listing, or of ID `private_<log id>`. */
export function isPrivateRoom(room: ArchivedRoom): boolean {
	return room.listing.private === true || room.listing.room_id.startsWith("private_");
}

/**
 * Whether a record is a move written already: a moved message's snapshot (it
 * names `prev_room_id`) at a log ID and room already written, as the history
 * of the room it left and of the room it went to both serve it.
 */
function repeatedMove(record: ChatRecord, written: Set<string>): boolean {
	if (record.kind !== "message" || !record.record_json.includes("prev_room_id")) return false;
	let value: { room_id?: unknown; prev_room_id?: unknown };
	try {
		value = JSON.parse(record.record_json) as typeof value;
	} catch {
		return false;
	}
	if (typeof value.prev_room_id !== "string") return false;
	const key = `${record.log_id}\u0000${String(value.room_id)}`;
	if (written.has(key)) return true;
	written.add(key);
	return false;
}

/** Writes a history's parts: rooms, the users they name, and their records. */
async function writeHistory(source: ArchiveSource, out: ArchiveWriter, options: ExportOptions): Promise<{ rooms: number; users: number; records: number }> {
	const all = await source.rooms();
	const wanted = options.roomIds ? new Set(options.roomIds) : undefined;
	const rooms = all.filter((room) => (!wanted || wanted.has(room.listing.room_id)) && (options.privateRooms !== false || !isPrivateRoom(room)));
	const floor = source.floor ? await source.floor() : undefined;
	const listings = rooms.map((room) => {
		// History starts where the room's listing says, never below the
		// source's floor. A listing's `log_id` is its latest room record, not
		// its creation: a retitle must not hide the records before it.
		const listed = room.listing.history_log_id;
		if (listed === null) return { ...room.listing, history_log_id: null };
		if (floor === undefined) return room.listing;
		const start = typeof listed === "string" && /^\d{1,16}$/.test(listed) ? Math.max(floor, Number(listed)) : floor;
		return { ...room.listing, history_log_id: String(start) };
	});
	const named = new Set<string>();
	for (const listing of listings) for (const member of listing.members ?? []) named.add(member.user_id);
	const listed = new Set<string>();
	const userPart = async (ids: Iterable<string>) => {
		const fresh = [...new Set(ids)].filter((id) => !listed.has(id));
		if (!fresh.length) return [];
		for (const id of fresh) listed.add(id);
		return source.users(fresh);
	};
	await out.listing({ not_joined: listings, users: await userPart(named) });
	let records = 0;
	const moves = new Set<string>();
	for (const room of rooms) {
		for await (const read of source.records(room.listing.room_id)) {
			const page = (options.prepare ? await options.prepare(read) : read).filter((record) => !repeatedMove(record, moves));
			if (!page.length) continue;
			const users = await userPart(page.flatMap(namedUsers));
			if (users.length) await out.listing({ users });
			await out.records(page);
			records += page.length;
		}
	}
	return { rooms: rooms.length, users: listed.size, records };
}

/** Writes a history as one ARCHIVE.md v1 file. The writer is closed at the end. */
export async function exportArchive(source: ArchiveSource, out: ArchiveWriter, options: ExportOptions = {}): Promise<ExportReport> {
	await out.header({ ...options.header, apron_archive: 1, exported_at: options.exportedAt ?? new Date().toISOString() });
	const written = await writeHistory(source, out, options);
	await out.close();
	return { ...written, sections: ["history"] };
}
