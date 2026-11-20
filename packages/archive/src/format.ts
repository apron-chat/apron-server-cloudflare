/*
 * ARCHIVE.md v1 as JSON Lines (apron-web's ARCHIVE.md §1–§3).
 *
 * The writer turns a header, listings and ChatRecords into lines: the header
 * first, then parts. Records go out in their wire shape (`record_json`
 * parsed), sorted by log order and grouped by kind into `rooms`, `messages`,
 * `reactions` and `memberships` arrays. A part that would pass
 * `maxLineBytes` is split over several lines; a single entry larger than
 * that gets a line of its own. ARCHIVE.md lets a writer put records on as
 * many lines as it likes, and the order of records across lines does not
 * matter to a reader, which applies them by replay.
 *
 * The sink receives each line WITH its trailing "\n", so a sink can append
 * lines to a file or a BlobWriter as they come, and the concatenation of
 * every line is the file.
 *
 * The reader is tolerant as ARCHIVE.md §1 asks: it accepts "\r\n", skips
 * blank lines and lines that are not JSON objects, ignores unknown keys and
 * non-array values, and skips entries that are not valid records or
 * listings. Its header is the first object line, which must carry
 * `apron_archive: 1`. A record read back becomes a ChatRecord in the room
 * its wire shape names, with `log_id` and `commit_ms` both its `log_id`. A
 * move is one wire snapshot in an archive, so it reads back as one record,
 * in the destination room; the source room's copy that the server logged
 * is not re-created here.
 *
 * Everything here is pure apart from the sink and the line source given to
 * it: no clock, no storage.
 */

import { byLog, type ChatRecord, type RecordKind } from "./records.ts";
import type { ArchiveHeader, ArchivedRoom, ArchivedUser, ArchivePart, ArchiveReader, ArchiveWriter, RoomListing } from "./types.ts";

/** The default cap on one line's UTF-8 size, newline included: 256 KiB. */
export const MAX_LINE_BYTES = 256 * 1024;

/**
 * The longest line a reader takes, in UTF-8 bytes: 1 MiB. A writer puts an
 * entry larger than MAX_LINE_BYTES on a line of its own, and no record this
 * server keeps comes near this; a longer line fails the read.
 */
export const MAX_READ_LINE_BYTES = 1024 * 1024;

/** The archive key each record kind is written under, in the order a part lists them. */
export const RECORD_KEYS: Readonly<Record<RecordKind, string>> = {
	room: "rooms",
	message: "messages",
	reactions: "reactions",
	membership: "memberships",
};

const KIND_OF_KEY: ReadonlyMap<string, RecordKind> = new Map(Object.entries(RECORD_KEYS).map(([kind, key]) => [key, kind as RecordKind]));

/** The listing keys of a part (ARCHIVE.md §3). */
export const LISTING_KEYS = ["joined", "not_joined", "users"] as const;

/** Keys that `extra` may not use: the header's, and every key a reader already understands. */
const RESERVED_KEYS = new Set<string>(["apron_archive", ...LISTING_KEYS, ...Object.values(RECORD_KEYS)]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The UTF-8 size of a string, without encoding it. Lone surrogates count as U+FFFD (3 bytes), as TextEncoder writes them. */
export function utf8Length(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}

/** A log ID from the wire: a decimal string (or, leniently, a number) for a positive safe integer; undefined otherwise. */
export function parseLogId(value: unknown): number | undefined {
	const id = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * A ChatRecord from one wire record of the given kind, or null when the
 * value is not a valid record (ARCHIVE.md §1: readers skip those). Every
 * record needs a `room_id` and a `log_id`; a message snapshot also needs a
 * `message_id` and `from.user_id`, a reaction record a `message_id` and a
 * `reactions` array, and a membership record a `members` array.
 */
export function wireToRecord(kind: RecordKind, value: unknown): ChatRecord | null {
	if (!isObject(value)) return null;
	const roomId = value.room_id;
	const logId = parseLogId(value.log_id);
	if (typeof roomId !== "string" || !roomId || logId === undefined) return null;
	if (kind === "message" && (typeof value.message_id !== "string" || !isObject(value.from) || typeof value.from.user_id !== "string")) return null;
	if (kind === "reactions" && (typeof value.message_id !== "string" || !Array.isArray(value.reactions))) return null;
	if (kind === "membership" && !Array.isArray(value.members)) return null;
	return { room_id: roomId, log_id: logId, commit_ms: logId, kind, record_json: JSON.stringify(value) };
}

/**
 * A stored record's wire shape: its `record_json` parsed, with `room_id` and
 * `log_id` filled in from the record when the JSON lacks them (stored
 * records always carry both; a move's copy in its source room keeps the
 * destination its JSON names).
 */
export function recordToWire(record: ChatRecord): JsonObject {
	const value = JSON.parse(record.record_json) as JsonObject;
	if (value.room_id === undefined) value.room_id = record.room_id;
	if (value.log_id === undefined) value.log_id = String(record.log_id);
	return value;
}

export interface JsonlWriterOptions {
	/** The cap on one line's UTF-8 size, newline included. Default MAX_LINE_BYTES. */
	maxLineBytes?: number;
}

/**
 * An ArchiveWriter that hands each line, ending in "\n", to `sink`, in
 * order, awaiting each. `header` must come first and once; `close` checks
 * that it came, and writes nothing (every line has gone out already).
 * Records of one `records` call that are identical (a move's copies, one per
 * room) are written once.
 */
export function jsonlWriter(sink: (line: string) => Promise<void>, options: JsonlWriterOptions = {}): ArchiveWriter {
	const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
	let started = false;
	let closed = false;

	const ready = (what: string) => {
		if (closed) throw new Error(`archive writer: ${what} after close`);
		if (!started) throw new Error(`archive writer: ${what} before the header`);
	};

	/**
	 * Writes entries, each under its key, as few lines as the cap allows. The
	 * entries keep their order within each key; keys appear in the order of
	 * their first entry on each line.
	 */
	const writeEntries = async (entries: Iterable<[key: string, value: unknown]>) => {
		let part = new Map<string, string[]>();
		// "{}" and "\n".
		let bytes = 3;
		const flush = async () => {
			if (!part.size) return;
			const fields = [...part].map(([key, values]) => `${JSON.stringify(key)}:[${values.join(",")}]`);
			await sink(`{${fields.join(",")}}\n`);
			part = new Map();
			bytes = 3;
		};
		for (const [key, value] of entries) {
			const json = JSON.stringify(value);
			const values = part.get(key);
			// A new key costs its name, quotes, colon, brackets and a comma; a value in a key costs a comma.
			const cost = utf8Length(json) + (values ? 1 : utf8Length(JSON.stringify(key)) + 4);
			if (part.size && bytes + cost > maxLineBytes) {
				await flush();
				part.set(key, [json]);
				bytes += utf8Length(json) + utf8Length(JSON.stringify(key)) + 4;
			} else {
				if (values) values.push(json);
				else part.set(key, [json]);
				bytes += cost;
			}
		}
		await flush();
	};

	return {
		async header(header) {
			if (closed) throw new Error("archive writer: header after close");
			if (started) throw new Error("archive writer: header written twice");
			if (header.apron_archive !== 1) throw new Error("archive writer: the header must carry apron_archive: 1");
			started = true;
			await sink(`${JSON.stringify(header)}\n`);
		},
		async listing(part) {
			ready("listing");
			const entries: Array<[string, unknown]> = [];
			for (const key of LISTING_KEYS) for (const value of part[key] ?? []) entries.push([key, value]);
			await writeEntries(entries);
		},
		async records(records) {
			ready("records");
			const seen = new Set<string>();
			const entries: Array<[string, unknown]> = [];
			for (const record of [...records].sort(byLog)) {
				const key = RECORD_KEYS[record.kind as RecordKind];
				if (!key) throw new Error(`archive writer: record ${record.log_id} in ${record.room_id} has unknown kind ${JSON.stringify(record.kind)}`);
				const identity = `${record.kind}\u0000${record.log_id}\u0000${record.record_json}`;
				if (seen.has(identity)) continue;
				seen.add(identity);
				entries.push([key, recordToWire(record)]);
			}
			await writeEntries(entries);
		},
		async extra(key, values) {
			ready("extra");
			if (RESERVED_KEYS.has(key)) throw new Error(`archive writer: ${JSON.stringify(key)} is not an extra key`);
			await writeEntries(values.map((value) => [key, value]));
		},
		async close() {
			if (!started) throw new Error("archive writer: closed without a header");
			closed = true;
		},
	};
}

/** The object a line holds, or undefined for a blank line, a line that is not JSON, or JSON that is not an object. */
function parseLine(line: string): JsonObject | undefined {
	const text = line.trim();
	if (!text || text[0] !== "{") return undefined;
	try {
		const value: unknown = JSON.parse(text);
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** The valid entries of a listing array: rooms need a string `room_id`, users a string `user_id`. */
function listingEntries<T>(value: unknown, idKey: "room_id" | "user_id"): T[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => isObject(entry) && typeof entry[idKey] === "string" && entry[idKey] !== "") as T[];
}

/**
 * The parts one line holds, in this order: its listing, its records, then
 * each unknown key with an array (`extra`) or object (`field`: an
 * extension's section) value. Other unknown values, such as a `history`
 * result's `more` and `first_log_id`, are ignored.
 */
export function partsOfLine(line: JsonObject): ArchivePart[] {
	const parts: ArchivePart[] = [];
	if (LISTING_KEYS.some((key) => Array.isArray(line[key]))) {
		parts.push({
			kind: "listing",
			joined: listingEntries<RoomListing>(line.joined, "room_id"),
			not_joined: listingEntries<RoomListing>(line.not_joined, "room_id"),
			users: listingEntries<ArchivedUser>(line.users, "user_id"),
		});
	}
	const records: ChatRecord[] = [];
	let hasRecords = false;
	for (const [key, kind] of KIND_OF_KEY) {
		const values = line[key];
		if (!Array.isArray(values)) continue;
		hasRecords = true;
		for (const value of values) {
			const record = wireToRecord(kind, value);
			if (record) records.push(record);
		}
	}
	if (hasRecords) parts.push({ kind: "records", records: records.sort(byLog) });
	for (const [key, value] of Object.entries(line)) {
		if (RESERVED_KEYS.has(key)) continue;
		if (Array.isArray(value)) parts.push({ kind: "extra", key, values: value });
		else if (isObject(value)) parts.push({ kind: "field", key, value });
	}
	return parts;
}

/** Throws for a line over MAX_READ_LINE_BYTES. */
function checkLineLength(line: string, lineNumber: number): void {
	if (line.length > MAX_READ_LINE_BYTES || (line.length > MAX_READ_LINE_BYTES / 3 && utf8Length(line) > MAX_READ_LINE_BYTES)) {
		throw new Error(`archive line ${lineNumber} is longer than ${MAX_READ_LINE_BYTES} bytes`);
	}
}

/** The header, from the first JSON object line (undefined when there is none); throws unless it carries `apron_archive: 1`. */
function checkHeader(first: JsonObject | undefined, lineNumber: number): ArchiveHeader {
	if (!first) throw new Error("not an Apron archive: no JSON object line");
	if (first.apron_archive !== 1) {
		throw new Error(first.apron_archive === undefined
			? `not an Apron archive: line ${lineNumber} has no apron_archive`
			: `unsupported Apron archive version ${JSON.stringify(first.apron_archive)} (this reader knows 1)`);
	}
	return first as ArchiveHeader;
}

/**
 * An ArchiveReader over lines (with or without their "\n" or "\r\n"); a
 * line over MAX_READ_LINE_BYTES fails the read. It
 * reads the source once: `header()` may be called any number of times, and
 * `parts()` once, which reads the header first if it has not been read.
 */
export function jsonlReader(lines: AsyncIterable<string>): ArchiveReader {
	let iterator: AsyncIterator<string> | undefined;
	let header: Promise<ArchiveHeader> | undefined;
	let lineNumber = 0;
	let partsTaken = false;

	const next = async (): Promise<JsonObject | undefined> => {
		iterator ??= lines[Symbol.asyncIterator]();
		for (;;) {
			const step = await iterator.next();
			if (step.done) return undefined;
			lineNumber++;
			checkLineLength(step.value, lineNumber);
			const value = parseLine(step.value);
			if (value) return value;
		}
	};

	const readHeader = () => header ??= (async () => checkHeader(await next(), lineNumber))();

	return {
		header: readHeader,
		parts() {
			if (partsTaken) throw new Error("archive reader: parts() can be read once");
			partsTaken = true;
			return (async function* () {
				await readHeader();
				for (let line = await next(); line; line = await next()) yield* partsOfLine(line);
			})();
		},
	};
}

/** The lines of a string, without their "\n" (a "\r" before it is left for the reader). */
export async function* linesOf(text: string): AsyncIterable<string> {
	let start = 0;
	for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
		yield text.slice(start, end);
		start = end + 1;
	}
	if (start < text.length) yield text.slice(start);
}

/**
 * The lines of a UTF-8 byte stream, decoded across chunk boundaries, without
 * their "\n". A line longer than `maxLine` UTF-16 units (default 8 Mi; the
 * reader's own cap, MAX_READ_LINE_BYTES, is smaller) fails, so a file
 * without line breaks is never held whole.
 */
export async function* linesFromStream(stream: ReadableStream<Uint8Array>, maxLine = 8 * 1024 * 1024): AsyncIterable<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			let end = buffer.indexOf("\n");
			while (end !== -1) {
				yield buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				end = buffer.indexOf("\n");
			}
			if (buffer.length > maxLine) throw new Error(`archive line longer than ${maxLine} characters`);
			if (done) break;
		}
		if (buffer) yield buffer;
	} finally {
		reader.releaseLock();
	}
}

/** Runs `fn` against a writer whose lines are collected, closes it, and returns the file. */
export async function writeArchiveToString(fn: (writer: ArchiveWriter) => Promise<void>, options?: JsonlWriterOptions): Promise<string> {
	const lines: string[] = [];
	const writer = jsonlWriter(async (line) => {
		lines.push(line);
	}, options);
	await fn(writer);
	await writer.close();
	return lines.join("");
}

/** A whole archive read into memory: what replayRecords takes, plus the header and the extra parts. */
export interface CollectedArchive {
	header: ArchiveHeader;
	/** Every listing in file order (a later listing of a room replaces an earlier one). */
	rooms: ArchivedRoom[];
	/** Every user object in file order (a later object of a user replaces an earlier one). */
	users: ArchivedUser[];
	/** Every record, sorted by log order. */
	records: ChatRecord[];
	extras: Array<{ key: string; values: unknown[] }>;
	/** Unknown keys with object values (extensions' sections), in file order. */
	fields: Array<{ key: string; value: JsonObject }>;
}

function collectPart(out: CollectedArchive, part: ArchivePart): void {
	if (part.kind === "listing") {
		for (const listing of part.joined) out.rooms.push({ listing, joined: true });
		for (const listing of part.not_joined) out.rooms.push({ listing, joined: false });
		out.users.push(...part.users);
	} else if (part.kind === "records") out.records.push(...part.records);
	else if (part.kind === "extra") out.extras.push({ key: part.key, values: part.values });
	else out.fields.push({ key: part.key, value: part.value });
}

/** Reads a whole archive. For tests and small files: an export can be tens of MB. */
export async function collectArchive(reader: ArchiveReader): Promise<CollectedArchive> {
	const out: CollectedArchive = { header: await reader.header(), rooms: [], users: [], records: [], extras: [], fields: [] };
	for await (const part of reader.parts()) collectPart(out, part);
	out.records.sort(byLog);
	return out;
}

/**
 * A whole archive from its text, synchronously: what collectArchive gives
 * for `jsonlReader(linesOf(text))`, by the same rules (header, line cap,
 * tolerance). For build steps and tests that hold the file already.
 */
export function readArchive(text: string): CollectedArchive {
	const lines = text.split("\n");
	let lineNumber = 0;
	let header: ArchiveHeader | undefined;
	const out: Omit<CollectedArchive, "header"> = { rooms: [], users: [], records: [], extras: [], fields: [] };
	for (const line of lines) {
		lineNumber++;
		checkLineLength(line, lineNumber);
		const value = parseLine(line);
		if (!value) continue;
		if (!header) header = checkHeader(value, lineNumber);
		else for (const part of partsOfLine(value)) collectPart(out as CollectedArchive, part);
	}
	out.records.sort(byLog);
	return { header: checkHeader(header, lineNumber), ...out };
}
