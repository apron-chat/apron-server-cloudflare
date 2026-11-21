/*
 * Archives read as a stream of lines, from the start or from a line
 * further on, without holding the file: what an import of a file larger
 * than memory reads it through, twice (plan.ts indexArchive, then the
 * writes).
 *
 * A line is known by its ordinal (0 for the first line of the decoded
 * file, blank lines counted) and the byte offset of its start in the
 * decoded bytes. Reading from a line (`from`) decodes the file from its
 * start and discards the decoded bytes before that offset: counted, never
 * split into lines or parsed. Codecs such as gzip can only be decoded from
 * their start, and a reader that keeps one stream open for as long as it
 * has work pays that only when it starts again.
 */

import { type ArchiveCodec, decodeStream } from "./codec.ts";
import { MAX_READ_LINE_BYTES, RECORD_KEYS, recordToWire } from "./format.ts";
import type { ChatRecord, RecordKind } from "./records.ts";
import type { ArchivedRoom, ArchiveHeader } from "./types.ts";

/** Where a line starts: its ordinal and the byte offset of its first byte, decoded. */
export interface LinePosition {
	line: number;
	offset: number;
}

/** One decoded line (without its "\n"), where it starts, and the offset just past it. */
export interface ScannedLine {
	text: string;
	line: number;
	offset: number;
	/** The offset of the next line's start. */
	end: number;
}

export interface ScanStats {
	/** Decoded bytes discarded to reach `from`. */
	skipped: number;
	/** Decoded bytes split into lines. */
	scanned: number;
}

const NEWLINE = 0x0a;

/**
 * The lines of a decoded byte stream, with their ordinals and offsets.
 * From `from` (a line's start, as an earlier scan gave it), the bytes
 * before its offset are counted and dropped. A line longer than `maxLine`
 * bytes, or a stream longer than `maxBytes` (skipped bytes included), fails
 * the scan. A last line without its "\n" is a line too, unless empty.
 */
export async function* scanLines(stream: ReadableStream<Uint8Array>, options: { from?: LinePosition; maxLine?: number; maxBytes?: number; stats?: ScanStats } = {}): AsyncIterable<ScannedLine> {
	const maxLine = options.maxLine ?? MAX_READ_LINE_BYTES;
	const stats = options.stats ?? { skipped: 0, scanned: 0 };
	const skip = options.from?.offset ?? 0;
	let line = options.from?.line ?? 0;
	// The decoded offset of the next byte the reader hands over.
	let position = 0;
	// The current line's bytes so far, and the offset it starts at.
	let pending: Uint8Array[] = [];
	let pendingBytes = 0;
	let start = skip;
	const decoder = new TextDecoder("utf-8");
	const text = (last: Uint8Array): string => {
		if (!pending.length) return decoder.decode(last);
		const joined = new Uint8Array(pendingBytes + last.byteLength);
		let at = 0;
		for (const piece of pending) {
			joined.set(piece, at);
			at += piece.byteLength;
		}
		joined.set(last, at);
		pending = [];
		pendingBytes = 0;
		return decoder.decode(joined);
	};
	const reader = stream.getReader();
	let finished = false;
	try {
		for (;;) {
			const step = await reader.read();
			if (step.done) {
				finished = true;
				break;
			}
			let chunk = step.value;
			const chunkStart = position;
			position += chunk.byteLength;
			if (options.maxBytes !== undefined && position > options.maxBytes) throw new Error(`archive is larger than ${options.maxBytes} bytes decoded`);
			if (position <= skip) {
				stats.skipped += chunk.byteLength;
				continue;
			}
			if (chunkStart < skip) {
				stats.skipped += skip - chunkStart;
				chunk = chunk.subarray(skip - chunkStart);
			}
			stats.scanned += chunk.byteLength;
			// Offset of chunk[0].
			let base = position - chunk.byteLength;
			for (let at = chunk.indexOf(NEWLINE); at !== -1; at = chunk.indexOf(NEWLINE)) {
				if (pendingBytes + at > maxLine) throw new Error(`archive line ${line + 1} is longer than ${maxLine} bytes`);
				const end = base + at + 1;
				yield { text: text(chunk.subarray(0, at)), line, offset: start, end };
				line += 1;
				start = end;
				chunk = chunk.subarray(at + 1);
				base = end;
			}
			if (chunk.byteLength) {
				pendingBytes += chunk.byteLength;
				if (pendingBytes > maxLine) throw new Error(`archive line ${line + 1} is longer than ${maxLine} bytes`);
				pending.push(chunk.slice());
			}
		}
		if (pendingBytes) yield { text: text(new Uint8Array(0)), line, offset: start, end: position };
	} finally {
		// A reader that stops early (or fails) cancels the rest: nothing is decoded for nobody.
		if (!finished) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/** An archive that can be read as lines any number of times, from its start or from a line (scanLines). */
export interface ArchiveLines {
	lines(from?: LinePosition, stats?: ScanStats): AsyncIterable<ScannedLine>;
}

/**
 * An archive stored encoded: `open` gives its bytes from the start (each
 * read opens it again), decoded through `codecs`, bounded to `maxBytes`
 * decoded when given.
 */
export function encodedSource(open: () => Promise<ReadableStream<Uint8Array>>, options: { codecs?: readonly ArchiveCodec[]; maxBytes?: number } = {}): ArchiveLines {
	return {
		async *lines(from, stats) {
			const decoded = decodeStream(await open(), options.codecs ?? []);
			yield* scanLines(decoded, { ...(from ? { from } : {}), ...(stats ? { stats } : {}), ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}) });
		},
	};
}

/** An archive held as text. */
export function textSource(text: string): ArchiveLines {
	const bytes = new TextEncoder().encode(text);
	return encodedSource(async () => new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	}));
}

/**
 * An archive held whole (collectArchive) as a source: its header, then a
 * line per listing and a line per record, each record kept as it is (none
 * merged or dropped as a writer would), so a plan over it sees what the
 * collected archive holds.
 */
export function collectedSource(archive: { header: ArchiveHeader; rooms: readonly ArchivedRoom[]; users: readonly unknown[]; records: readonly ChatRecord[] }): ArchiveLines {
	const lines: string[] = [JSON.stringify(archive.header)];
	for (const room of archive.rooms) lines.push(JSON.stringify(room.joined ? { joined: [room.listing] } : { not_joined: [room.listing] }));
	if (archive.users.length) lines.push(JSON.stringify({ users: archive.users }));
	for (const record of archive.records) {
		const key = RECORD_KEYS[record.kind as RecordKind];
		// Its room and log ID as the collected record has them, whatever its JSON names.
		if (key) lines.push(JSON.stringify({ [key]: [{ ...recordToWire(record), room_id: record.room_id, log_id: String(record.log_id) }] }));
	}
	return textSource(`${lines.join("\n")}\n`);
}
