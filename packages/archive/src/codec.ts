/*
 * Codecs: what an archive's bytes go through between the writer and where
 * they are stored, and back. A codec is a pair of standard WHATWG Streams
 * TransformStreams over bytes, the interface CompressionStream and
 * DecompressionStream already implement, so a chain composes with
 * `pipeThrough` and runs the same in Workers, browsers and Node.
 *
 * `gzip` is the one codec here. Encryption or signing can be added later as
 * codecs of their own, composed after it:
 *
 *   stream.pipeThrough(gzip.encoder()).pipeThrough(encrypt.encoder())
 *
 * and decoded in reverse. A codec that authenticates (`authenticates:
 * true`) must error its decoder's stream on any failure, a truncated end
 * included, so that an archive read to its end through it is verified: that
 * is the one fact a reader may trust more on (see readEncodedArchive, `provenance`).
 */

import { type CollectedArchive, collectArchive, jsonlReader, jsonlWriter, type JsonlWriterOptions, linesFromStream, MAX_READ_LINE_BYTES } from "./format.ts";
import type { ArchiveReader, ArchiveWriter } from "./types.ts";

export interface ArchiveCodec {
	/** The codec's name, recorded with what it encoded (like HTTP's Content-Encoding), e.g. "gzip". */
	readonly name: string;
	/** Appended to a stored archive's name, e.g. ".gz". */
	readonly extension: string;
	/**
	 * Whether a decode that runs to its end proves the archive is this
	 * deployment's own, unaltered. Its decoder must then error the stream on
	 * any failure, truncation included.
	 */
	readonly authenticates: boolean;
	/** A fresh encoder: plain bytes in, encoded bytes out. */
	encoder(): TransformStream<Uint8Array, Uint8Array>;
	/** A fresh decoder: encoded bytes in, plain bytes out. */
	decoder(): TransformStream<Uint8Array, Uint8Array>;
}

/** gzip (RFC 1952) through the platform's CompressionStream. Compresses; authenticates nothing. */
export const gzip: ArchiveCodec = {
	name: "gzip",
	extension: ".gz",
	authenticates: false,
	encoder: () => new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
	decoder: () => new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
};

/** The codecs this library knows, by name. A reader is given its own registry to know others. */
export const ARCHIVE_CODECS: Readonly<Record<string, ArchiveCodec>> = Object.freeze({ gzip });

/** The codecs `names` lists, in order; an unknown name is refused, never skipped. */
export function codecChain(names: readonly string[], registry: Readonly<Record<string, ArchiveCodec>> = ARCHIVE_CODECS): ArchiveCodec[] {
	return names.map((name) => {
		const codec = Object.hasOwn(registry, name) ? registry[name] : undefined;
		if (!codec) throw new Error(`unknown archive codec ${JSON.stringify(name)}`);
		return codec;
	});
}

/** A chain's names as stored with what it encoded: comma-separated, in encoding order ("" for none). */
export function codecNames(chain: readonly ArchiveCodec[]): string {
	return chain.map((codec) => codec.name).join(",");
}

/** The names a stored list holds (codecNames' inverse). */
export function parseCodecNames(text: string | undefined): string[] {
	return (text ?? "").split(",").map((name) => name.trim()).filter(Boolean);
}

/**
 * The codecs a stored archive's name says it went through, from its
 * extensions after `.jsonl` (`x.jsonl.gz`: gzip); undefined where the name
 * says nothing (no `.jsonl`), and an unknown extension is refused.
 */
export function codecsFromName(name: string, registry: Readonly<Record<string, ArchiveCodec>> = ARCHIVE_CODECS): ArchiveCodec[] | undefined {
	const at = name.lastIndexOf(".jsonl");
	if (at < 0) return undefined;
	const rest = name.slice(at + ".jsonl".length);
	const chain: ArchiveCodec[] = [];
	for (const extension of rest.split(".").filter(Boolean).map((part) => `.${part}`)) {
		const codec = Object.values(registry).find((entry) => entry.extension === extension);
		if (!codec) throw new Error(`unknown archive extension ${JSON.stringify(extension)} in ${JSON.stringify(name)}`);
		chain.push(codec);
	}
	return chain;
}

/** The name a stored archive gets: `base` with `.jsonl` and each codec's extension. */
export function archiveName(base: string, chain: readonly ArchiveCodec[]): string {
	return `${base}.jsonl${chain.map((codec) => codec.extension).join("")}`;
}

/**
 * `stream` through `transform`: what `pipeThrough` does, pumped by hand so
 * that every promise of the pipe is handled. A failure still errors the
 * readable side, which is where a reader sees it, and cancels the source;
 * through pipeThrough, workerd also reports a failing transform's close (a
 * truncated gzip stream) as an unhandled rejection.
 */
function through(stream: ReadableStream<Uint8Array>, transform: TransformStream<Uint8Array, Uint8Array>): ReadableStream<Uint8Array> {
	const writer = transform.writable.getWriter();
	writer.closed.catch(() => undefined);
	const reader = stream.getReader();
	void (async () => {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				await writer.write(value);
			}
			await writer.close();
		} catch (error) {
			await writer.abort(error).catch(() => undefined);
			await reader.cancel(error).catch(() => undefined);
		}
	})();
	return transform.readable;
}

/** `stream` through each codec's encoder, in order. */
export function encodeStream(stream: ReadableStream<Uint8Array>, chain: readonly ArchiveCodec[]): ReadableStream<Uint8Array> {
	return chain.reduce((out, codec) => through(out, codec.encoder()), stream);
}

/** `stream` through each codec's decoder, last encoder first. */
export function decodeStream(stream: ReadableStream<Uint8Array>, chain: readonly ArchiveCodec[]): ReadableStream<Uint8Array> {
	return [...chain].reverse().reduce((out, codec) => through(out, codec.decoder()), stream);
}

/** A stream that errors once more than `maxBytes` have passed: a decoder's output is bounded however small its input. */
export function byteLimit(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
	let seen = 0;
	return new TransformStream({
		transform(chunk, controller) {
			seen += chunk.byteLength;
			if (seen > maxBytes) throw new Error(`archive is larger than ${maxBytes} bytes decoded`);
			controller.enqueue(chunk);
		},
	});
}

/** A line sink whose lines are encoded through a codec chain into `write`: close it, or abort it, once. */
export interface ArchiveSink {
	/** One archive line, with or without its "\n"; written with exactly one. */
	write(line: string): Promise<void>;
	close(): Promise<void>;
	abort(reason?: unknown): Promise<void>;
}

/**
 * A sink for jsonlWriter's lines that encodes them through `chain` and hands
 * the encoded bytes to `write` (a store's writer), keeping its
 * backpressure: a `write` waits until `write` has taken what came before.
 */
export function archiveSink(write: (bytes: Uint8Array) => Promise<void>, chain: readonly ArchiveCodec[]): ArchiveSink {
	const input = new TransformStream<Uint8Array, Uint8Array>();
	const piped = encodeStream(input.readable, chain).pipeTo(new WritableStream({ write: (bytes) => write(bytes) }));
	// Awaited by close and abort; a failure before then surfaces on the next write.
	piped.catch(() => undefined);
	const writer = input.writable.getWriter();
	const encoder = new TextEncoder();
	return {
		write: (line) => writer.write(encoder.encode(line.endsWith("\n") ? line : `${line}\n`)),
		close: async () => {
			await writer.close();
			await piped;
		},
		abort: async (reason) => {
			await writer.abort(reason).catch(() => undefined);
			await piped.catch(() => undefined);
		},
	};
}

/** An ArchiveWriter (jsonlWriter) whose file goes through `chain` into `write`; `close` flushes the chain. */
export function encodedArchiveWriter(write: (bytes: Uint8Array) => Promise<void>, chain: readonly ArchiveCodec[], options?: JsonlWriterOptions): ArchiveWriter & { abort(reason?: unknown): Promise<void> } {
	const sink = archiveSink(write, chain);
	const writer = jsonlWriter((line) => sink.write(line), options);
	return {
		...writer,
		close: async () => {
			await writer.close();
			await sink.close();
		},
		abort: (reason) => sink.abort(reason),
	};
}

export interface OpenArchiveOptions {
	/** The codecs the bytes went through, in encoding order; none by default. */
	codecs?: readonly ArchiveCodec[];
	/** The most bytes read after decoding (a small compressed file can decode to a great deal); unbounded by default. */
	maxBytes?: number;
}

/** Whether an archive was read through an authenticating codec to its end (readEncodedArchive): the one fact a reader may trust more on. */
export type Provenance = "verified" | "unverified";

/** An archive read whole, and what it is known to be. */
export interface OpenedArchive {
	archive: CollectedArchive;
	provenance: Provenance;
}

/**
 * Reads an archive from its stored bytes, decoded through `codecs`, or
 * from its lines (no codecs). The decoded bytes are split into lines with
 * the reader's line cap, then read as jsonlReader reads them.
 */
export function openArchive(source: ReadableStream<Uint8Array> | AsyncIterable<string>, options: OpenArchiveOptions = {}): ArchiveReader {
	const chain = options.codecs ?? [];
	let lines: AsyncIterable<string>;
	if (source instanceof ReadableStream) {
		let decoded = decodeStream(source, chain);
		if (options.maxBytes !== undefined) decoded = through(decoded, byteLimit(options.maxBytes));
		lines = linesFromStream(decoded, MAX_READ_LINE_BYTES);
	} else {
		if (chain.length) throw new Error("an archive read through codecs is read from its bytes, not its lines");
		lines = source;
	}
	return jsonlReader(lines);
}

/**
 * Reads a whole archive from its stored bytes (openArchive), and says what
 * it is: "verified" when a codec in the chain authenticates, as it then has
 * read every byte without an error (an authenticating decoder errors on
 * any damage, a truncated end included); "unverified" otherwise. Decided
 * once, after the whole read: nothing reads as verified before its end.
 */
export async function readEncodedArchive(source: ReadableStream<Uint8Array>, options: OpenArchiveOptions = {}): Promise<OpenedArchive> {
	const archive = await collectArchive(openArchive(source, options));
	return { archive, provenance: (options.codecs ?? []).some((codec) => codec.authenticates) ? "verified" : "unverified" };
}
