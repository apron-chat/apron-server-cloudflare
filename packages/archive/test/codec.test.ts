import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	ARCHIVE_CODECS,
	type ArchiveCodec,
	archiveName,
	archiveSink,
	byteLimit,
	codecChain,
	codecNames,
	codecsFromName,
	decodeStream,
	encodedArchiveWriter,
	encodeStream,
	gzip,
	openArchive,
	readEncodedArchive,
	parseCodecNames,
} from "../src/codec.ts";
import { collectArchive, jsonlReader, linesOf } from "../src/format.ts";
import { sceneArchives } from "./fixtures/scenes/index.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A codec that XORs every byte with `key`: a second, order-sensitive codec for chains. */
function xor(key: number): ArchiveCodec {
	const transform = () => new TransformStream<Uint8Array, Uint8Array>({ transform: (chunk, controller) => controller.enqueue(chunk.map((byte) => byte ^ key)) });
	return { name: `xor${key}`, extension: `.x${key}`, authenticates: false, encoder: transform, decoder: transform };
}

/** Archives written through a sink (encodedArchiveWriter), collected as the bytes they become. */
async function written(chain: readonly ArchiveCodec[], fn: (writer: ReturnType<typeof encodedArchiveWriter>) => Promise<void>): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	const writer = encodedArchiveWriter(async (bytes) => { parts.push(bytes.slice()); }, chain);
	await fn(writer);
	await writer.close();
	return bytesOf(streamOf(parts));
}

describe("codecs", () => {
	it("round-trip any bytes exactly through gzip, and through chains decoded in reverse", async () => {
		const chunks = fc.array(fc.uint8Array({ maxLength: 2_000 }), { maxLength: 8 });
		await fc.assert(
			fc.asyncProperty(chunks, fc.subarray([gzip, xor(7), xor(90)]), async (input, chain) => {
				const plain = await bytesOf(streamOf(input));
				const encoded = await bytesOf(encodeStream(streamOf(input), chain));
				const decoded = await bytesOf(decodeStream(streamOf([encoded]), chain));
				expect(decoded).toEqual(plain);
			}),
			{ numRuns: 60 },
		);
	});

	it("round-trip any archive lines exactly through a writer and openArchive", async () => {
		const line = fc.string({ unit: "grapheme", maxLength: 40 }).map((text) => JSON.stringify({ text }));
		await fc.assert(
			fc.asyncProperty(fc.array(line, { maxLength: 30 }), fc.subarray([gzip, xor(3)]), async (lines, chain) => {
				const parts: Uint8Array[] = [];
				const sink = archiveSink(async (bytes) => { parts.push(bytes.slice()); }, chain);
				await sink.write('{"apron_archive":1}');
				// With or without its "\n": written with exactly one.
				for (const [index, text] of lines.entries()) await sink.write(index % 2 ? `${text}\n` : text);
				await sink.close();
				const decoded = decoder.decode(await bytesOf(decodeStream(streamOf(parts), chain)));
				expect(decoded).toBe(['{"apron_archive":1}', ...lines].map((text) => `${text}\n`).join(""));
			}),
			{ numRuns: 60 },
		);
	});

	it("read every scene back through gzip exactly as from its text", async () => {
		for (const [name, text] of Object.entries(sceneArchives)) {
			const plain = await collectArchive(jsonlReader(linesOf(text)));
			const bytes = await written([gzip], async (writer) => {
				await writer.header(plain.header);
				for (const room of plain.rooms) await writer.listing(room.joined ? { joined: [room.listing] } : { not_joined: [room.listing] });
				if (plain.users.length) await writer.listing({ users: plain.users });
				await writer.records(plain.records);
			});
			expect(bytes.byteLength, name).toBeLessThan(encoder.encode(text).byteLength);
			const back = await collectArchive(openArchive(streamOf([bytes]), { codecs: [gzip] }));
			expect(back.records, name).toEqual(plain.records);
			expect(back.users, name).toEqual(plain.users);
		}
	});

	it("fail on what is not gzip, is cut short, or decodes past its bound", async () => {
		const bytes = await written([gzip], async (writer) => {
			await writer.header({ apron_archive: 1 });
			await writer.listing({ not_joined: [{ room_id: "r", log_id: "1" }] });
		});
		await expect(collectArchive(openArchive(streamOf([encoder.encode("not gzip")]), { codecs: [gzip] }))).rejects.toThrow();
		await expect(collectArchive(openArchive(streamOf([bytes.slice(0, bytes.byteLength - 4)]), { codecs: [gzip] }))).rejects.toThrow();
		// Read without its codec, gzip is no archive.
		await expect(collectArchive(openArchive(streamOf([bytes])))).rejects.toThrow();
		// A small file may decode only so far.
		const big = await written([gzip], async (writer) => {
			await writer.header({ apron_archive: 1, padding: "x".repeat(200_000) });
		});
		expect(big.byteLength).toBeLessThan(2_000);
		await expect(collectArchive(openArchive(streamOf([big]), { codecs: [gzip], maxBytes: 100_000 }))).rejects.toThrow(/larger than 100000 bytes decoded/);
		const limited = await bytesOf(streamOf([new Uint8Array(10)]).pipeThrough(byteLimit(10)));
		expect(limited.byteLength).toBe(10);
	});

	it("verify only through an authenticating codec, and only once read to the end", async () => {
		const sealed: ArchiveCodec = { name: "sealed", extension: ".sealed", authenticates: true, encoder: () => new TransformStream(), decoder: () => new TransformStream() };
		const bytes = await written([gzip, sealed], async (writer) => {
			await writer.header({ apron_archive: 1 });
			await writer.listing({ not_joined: [{ room_id: "r", log_id: "1" }] });
		});
		const opened = await readEncodedArchive(streamOf([bytes]), { codecs: [gzip, sealed] });
		expect(opened.provenance).toBe("verified");
		expect(opened.archive.rooms).toHaveLength(1);
		const plain = await readEncodedArchive(streamOf([await written([gzip], async (writer) => { await writer.header({ apron_archive: 1 }); })]), { codecs: [gzip] });
		expect(plain.provenance).toBe("unverified");
		expect((await readEncodedArchive(streamOf([encoder.encode('{"apron_archive":1}\n')]))).provenance).toBe("unverified");
		// A damaged archive gives nothing to trust: it does not read at all.
		await expect(readEncodedArchive(streamOf([bytes.slice(0, bytes.length - 4)]), { codecs: [gzip, sealed] })).rejects.toThrow();
	});

	it("are named, recorded and found by name or extension; an unknown one is refused", () => {
		expect(ARCHIVE_CODECS.gzip).toBe(gzip);
		expect(codecChain(["gzip"])).toEqual([gzip]);
		expect(() => codecChain(["gzip", "rot13"])).toThrow('unknown archive codec "rot13"');
		expect(() => codecChain(["toString"])).toThrow('unknown archive codec "toString"');
		expect(codecNames([gzip, xor(1)])).toBe("gzip,xor1");
		expect(parseCodecNames(" gzip, xor1 ,")).toEqual(["gzip", "xor1"]);
		expect(parseCodecNames(undefined)).toEqual([]);
		expect(archiveName("backups/a", [gzip])).toBe("backups/a.jsonl.gz");
		expect(codecsFromName("backups/a.jsonl.gz")).toEqual([gzip]);
		expect(codecsFromName("backups/a.jsonl")).toEqual([]);
		expect(codecsFromName("notes.txt")).toBeUndefined();
		expect(() => codecsFromName("backups/a.jsonl.zst")).toThrow('unknown archive extension ".zst" in "backups/a.jsonl.zst"');
		expect(codecsFromName("a.jsonl.x5.gz", { gzip, x5: xor(5) })).toEqual([xor(5), gzip].map((codec) => expect.objectContaining({ name: codec.name })));
	});

	it("read lines given as lines, but not through codecs", async () => {
		const archive = await collectArchive(openArchive(linesOf('{"apron_archive":1}\n')));
		expect(archive.header).toEqual({ apron_archive: 1 });
		expect(() => openArchive(linesOf("{}"), { codecs: [gzip] })).toThrow(/from its bytes/);
	});
});
