// Archives read as lines, from the start or from a line further on (stream.ts),
// and their records numbered as an index numbers them (plan.ts recordLines).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { encodeStream, gzip } from "../src/codec.ts";
import { type ScannedLine, type ScanStats, collectedSource, encodedSource, scanLines, textSource } from "../src/stream.ts";
import { indexArchive, recordLines } from "../src/plan.ts";
import { readArchive } from "../src/format.ts";

const encoder = new TextEncoder();

/** A stream of `text`'s bytes, cut into the given chunk sizes (the last chunk takes the rest). */
function chunked(text: string, sizes: readonly number[] = []): ReadableStream<Uint8Array> {
	const bytes = encoder.encode(text);
	const chunks: Uint8Array[] = [];
	let at = 0;
	for (const size of sizes) {
		if (at >= bytes.length) break;
		chunks.push(bytes.subarray(at, at + size));
		at += size;
	}
	if (at < bytes.length) chunks.push(bytes.subarray(at));
	return new ReadableStream({
		pull(controller) {
			const next = chunks.shift();
			if (next) controller.enqueue(next);
			else controller.close();
		},
	});
}

async function all<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) out.push(item);
	return out;
}

describe("scanLines", () => {
	it("gives each line with its ordinal and offsets however the bytes are cut, and from any line the same rest, the bytes before it skipped", async () => {
		const line = fc.string({ unit: "grapheme", maxLength: 12 }).filter((text) => !text.includes("\n"));
		await fc.assert(fc.asyncProperty(fc.array(line, { maxLength: 8 }), fc.boolean(), fc.array(fc.integer({ min: 1, max: 7 }), { maxLength: 20 }), async (texts, trailing, sizes) => {
			const text = texts.join("\n") + (trailing && texts.length ? "\n" : "");
			const lines = await all(scanLines(chunked(text, sizes)));
			// A last empty line (no bytes after the final "\n") is no line.
			const expected = text === "" ? [] : (trailing ? texts : texts.filter((_, at) => at < texts.length - 1 || texts[at] !== ""));
			expect(lines.map((one) => one.text)).toEqual(expected);
			const bytes = encoder.encode(text);
			for (const [at, one] of lines.entries()) {
				expect(one.line).toBe(at);
				expect(new TextDecoder().decode(bytes.subarray(one.offset, one.end)).replace(/\n$/, "")).toBe(one.text);
			}
			for (const from of lines) {
				const stats: ScanStats = { skipped: 0, scanned: 0 };
				const rest = await all(scanLines(chunked(text, sizes), { from: { line: from.line, offset: from.offset }, stats }));
				expect(rest).toEqual(lines.slice(from.line));
				expect(stats).toEqual({ skipped: from.offset, scanned: bytes.length - from.offset });
			}
		}), { numRuns: 200 });
	});

	it("fails a line longer than maxLine, or a stream past maxBytes counting what it skipped", async () => {
		await expect(all(scanLines(chunked("short\nmuch too long\n", [3, 3, 3]), { maxLine: 8 }))).rejects.toThrow("archive line 2 is longer than 8 bytes");
		await expect(all(scanLines(chunked("x".repeat(20)), { maxLine: 8 }))).rejects.toThrow("archive line 1 is longer than 8 bytes");
		await expect(all(scanLines(chunked("aaaa\nbbbb\ncccc\n"), { maxBytes: 12, from: { line: 2, offset: 10 } }))).rejects.toThrow("larger than 12 bytes");
		expect(await all(scanLines(chunked("aaaa\nbbbb\n"), { maxBytes: 10 }))).toHaveLength(2);
	});

	it("cancels what is left when its reader stops early", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) { controller.enqueue(encoder.encode("line\n")); },
			cancel() { cancelled = true; },
		});
		for await (const one of scanLines(stream)) if (one.line === 2) break;
		expect(cancelled).toBe(true);
	});
});

describe("encodedSource", () => {
	it("reads a gzip-encoded archive again from its start each time, and from a line by decoding and discarding what comes before it", async () => {
		const text = Array.from({ length: 500 }, (_, at) => JSON.stringify({ n: at, pad: "x".repeat(at % 50) })).join("\n");
		const encoded = new Uint8Array(await new Response(encodeStream(chunked(text), [gzip])).arrayBuffer());
		let opened = 0;
		const source = encodedSource(async () => {
			opened += 1;
			return new Response(encoded).body!;
		}, { codecs: [gzip] });
		const lines = await all(source.lines());
		expect(lines).toHaveLength(500);
		const from = lines[321]!;
		const stats: ScanStats = { skipped: 0, scanned: 0 };
		const rest: ScannedLine[] = await all(source.lines({ line: from.line, offset: from.offset }, stats));
		expect(rest).toEqual(lines.slice(321));
		expect(stats.skipped).toBe(from.offset);
		expect(opened).toBe(2);
		// A decoded bound counts the bytes skipped too.
		await expect(all(encodedSource(async () => new Response(encoded).body!, { codecs: [gzip], maxBytes: 1_000 }).lines(from))).rejects.toThrow("larger than 1000 bytes");
	});
});

describe("recordLines", () => {
	const text = [
		JSON.stringify({ apron_archive: 1 }),
		JSON.stringify({ not_joined: [{ room_id: "a" }] }),
		"",
		JSON.stringify({ messages: [{ room_id: "a", log_id: "3", message_id: "3", from: { user_id: "ada" } }, { room_id: "a", log_id: "2", message_id: "2", from: { user_id: "ada" } }] }),
		"garbage",
		JSON.stringify({ rooms: [{ room_id: "a", log_id: "1" }], memberships: [{ room_id: "a", log_id: "4", members: [] }] }),
		JSON.stringify({ messages: [{ room_id: "a", log_id: "5" }] }),
		JSON.stringify({ messages: [{ room_id: "a", log_id: "6", message_id: "6", from: { user_id: "bob" } }] }),
	].join("\n");

	it("numbers records in file order as indexArchive does, each line's in partsOfLine's order, and goes on from any line's next position", async () => {
		const source = textSource(text);
		const lines = await all(recordLines(source));
		expect(lines.map((line) => [line.entry, line.records.map((record) => record.log_id)])).toEqual([
			[0, []], [0, []], [0, []], [0, [2, 3]], [2, []], [2, [1, 4]], [4, []], [4, [6]],
		]);
		const index = await indexArchive(source);
		expect(Array.from(index.logId)).toEqual([2, 3, 1, 4, 6]);
		for (const [at, line] of lines.entries()) {
			const rest = await all(recordLines(source, line.next));
			expect(rest).toEqual(lines.slice(at + 1));
		}
	});

	it("takes a collected archive's records as its columns say, whatever their JSON names", async () => {
		const archive = readArchive(text);
		const moved = { ...archive, records: archive.records.map((record) => ({ ...record, room_id: "b", record_json: record.record_json })) };
		const lines = await all(recordLines(collectedSource(moved)));
		expect(lines.flatMap((line) => line.records.map((record) => record.room_id))).toEqual(["b", "b", "b", "b", "b"]);
	});
});
