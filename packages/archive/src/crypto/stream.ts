/*
 * Encrypted archives as streams of lines, built on the core (core.ts): the
 * writer gathers plaintext into chunks and seals each, the reader opens them
 * in order. This file handles framing only (base64 lines, chunk boundaries,
 * line splitting); every cryptographic step is a core call.
 */

import {
	ArchiveDecryptError,
	ArchiveKeyError,
	type BackupKey,
	isEncryptedArchive,
	NONCE_BYTES,
	newHeader,
	openChunk,
	parseHeader,
	sealChunk,
	TAG_BYTES,
} from "./core.ts";

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
/** The longest plaintext line a reader holds while it waits for the line's end (as format.ts MAX_READ_LINE_BYTES, in UTF-16 units). */
const MAX_PLAIN_LINE = 1024 * 1024;

/** The backup keys an environment has, found by secret name. */
export interface BackupKeys {
	/** The secret names consulted, in order (newest first: the first encrypts new backups). */
	readonly names: readonly string[];
	/** The key for a secret, or undefined if the secret is not listed or not set. Rejects with ArchiveKeyError if it is set but malformed. */
	lookup(name: string): Promise<BackupKey | undefined>;
}

/** What decryptArchive learned of its input, filled in once it has read the first line. */
export interface DecryptionStatus {
	/** Whether the input was an encrypted archive, decrypted (and so authenticated) with one of the keys given. */
	encrypted?: boolean;
}

/** A line sink that encrypts: call it with each plaintext line, then `close` once. */
export interface ArchiveEncryptor {
	(line: string): Promise<void>;
	close(): Promise<void>;
}

export interface EncryptOptions extends BackupKey {
	/** The secret's name, recorded in the header so a reader can find the key. */
	name: string;
	/** Plaintext bytes per chunk, 1 to 4 MiB. Default 1 MiB. */
	chunkBytes?: number;
}

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** Undefined if `text` is not base64. */
function fromBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
	let binary: string;
	try {
		binary = atob(text);
	} catch {
		return undefined;
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Joins `chunks` and returns their first `bytes`, leaving the rest in `chunks`. */
function take(chunks: Uint8Array[], bytes: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(bytes);
	let offset = 0;
	while (offset < bytes) {
		const chunk = chunks[0]!;
		const wanted = bytes - offset;
		if (chunk.byteLength <= wanted) {
			out.set(chunk, offset);
			offset += chunk.byteLength;
			chunks.shift();
		} else {
			out.set(chunk.subarray(0, wanted), offset);
			offset += wanted;
			chunks[0] = chunk.subarray(wanted);
		}
	}
	return out;
}

/**
 * Encrypts an archive written line by line into `sink`: the header line
 * first, then a chunk line each time a chunk's worth of plaintext has
 * gathered, and on `close` the final chunk (empty if the archive is). Each
 * call is one plaintext line, with or without its "\n" (as jsonlWriter gives
 * it): exactly one "\n" ends it in the plaintext, so decryptArchive gives back
 * the lines written, and the decrypted bytes are the plain archive's. Calls
 * are queued, so lines keep their order even if a caller does not wait.
 */
export function encryptArchive(sink: (line: string) => Promise<void>, options: EncryptOptions): ArchiveEncryptor {
	const header = newHeader(options.name, options.fingerprint, options.chunkBytes ?? DEFAULT_CHUNK_BYTES);
	const pending: Uint8Array[] = [];
	let pendingBytes = 0;
	let started = false;
	let closed = false;
	let index = 0;
	let queue: Promise<unknown> = Promise.resolve();

	const enqueue = (step: () => Promise<void>): Promise<void> => {
		const run = queue.then(step);
		queue = run.catch(() => {});
		return run;
	};
	const start = async () => {
		if (started) return;
		started = true;
		await sink(JSON.stringify(header));
	};
	const seal = async (plaintext: Uint8Array<ArrayBuffer>, final: boolean) => {
		const sealed = await sealChunk(options.key, header, index, final, plaintext);
		index += 1;
		await sink(toBase64(sealed));
	};

	const write = (line: string) =>
		enqueue(async () => {
			if (closed) throw new Error("the encrypted archive is already closed");
			await start();
			const bytes = encoder.encode(line.endsWith("\n") ? line : `${line}\n`);
			pending.push(bytes);
			pendingBytes += bytes.byteLength;
			// Seal a chunk only when more than a chunk is waiting: what is left at
			// close becomes the final chunk, never empty unless the archive is.
			while (pendingBytes > header.chunk_bytes) {
				await seal(take(pending, header.chunk_bytes), false);
				pendingBytes -= header.chunk_bytes;
			}
		});
	const close = () =>
		enqueue(async () => {
			if (closed) throw new Error("the encrypted archive is already closed");
			closed = true;
			await start();
			await seal(take(pending, pendingBytes), true);
			pendingBytes = 0;
		});
	return Object.assign(write, { close });
}

/**
 * The plaintext lines of an archive, decrypting it if its first non-blank
 * line is an encrypted archive's header; a plain archive's lines pass through
 * unchanged. The key is the one the header names, looked up in `keys` and
 * confirmed by fingerprint. Lines come out as chunks are verified, so a
 * consumer must not act on them until the iteration ends without error: a
 * cut-off backup is detected only at its end. Rejects with ArchiveKeyError or
 * ArchiveDecryptError.
 */
export async function* decryptArchive(lines: AsyncIterable<string>, keys: Pick<BackupKeys, "lookup">, status: DecryptionStatus = {}): AsyncGenerator<string, void, undefined> {
	const input = lines[Symbol.asyncIterator]();
	const leading: string[] = [];
	let first: string | undefined;
	let lineNumber = 0;
	for (;;) {
		const next = await input.next();
		if (next.done) break;
		lineNumber += 1;
		if (next.value.trim() === "") {
			leading.push(next.value);
			continue;
		}
		first = next.value;
		break;
	}

	if (first === undefined || !isEncryptedArchive(first)) {
		status.encrypted = false;
		yield* leading;
		if (first === undefined) return;
		yield first;
		for (;;) {
			const next = await input.next();
			if (next.done) return;
			yield next.value;
		}
	}

	const header = parseHeader(first);
	const found = await keys.lookup(header.key);
	if (!found) {
		throw new ArchiveKeyError(
			`this backup needs ${header.key} (fingerprint ${header.fingerprint}); set it with \`wrangler secret put\`, list it in BACKUP_PREVIOUS_KEY_NAMES, and import again`,
		);
	}
	if (found.fingerprint !== header.fingerprint) {
		throw new ArchiveKeyError(
			`the key ${header.key} does not match this backup's fingerprint (${header.fingerprint}): the secret was re-set since the backup was made; restore the value it had then to import it`,
		);
	}

	// Every chunk is authenticated before a line of it comes out: what comes out is the key holder's.
	status.encrypted = true;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let carry = "";
	/** The chunk seen last, held until the next line shows whether it is the final one. */
	let held: { sealed: Uint8Array<ArrayBuffer>; index: number; line: number } | undefined;
	let index = 0;

	const open = async (chunk: { sealed: Uint8Array<ArrayBuffer>; index: number; line: number }, final: boolean): Promise<Uint8Array> => {
		const where = `chunk ${chunk.index + 1} (line ${chunk.line})`;
		const plaintext = await openChunk(found.key, header, chunk.index, final, chunk.sealed);
		if (plaintext) return plaintext;
		// Tell the two ways a chunk in the wrong place shows, for a clearer message.
		if (final && (await openChunk(found.key, header, chunk.index, false, chunk.sealed))) {
			throw new ArchiveDecryptError(`this backup was truncated: it ends at ${where}, which is not its final chunk`);
		}
		if (!final && (await openChunk(found.key, header, chunk.index, true, chunk.sealed))) {
			throw new ArchiveDecryptError(`${where} failed authentication: it is the final chunk, but more follows`);
		}
		throw new ArchiveDecryptError(`${where} failed authentication`);
	};
	const plainLines = function* (bytes: Uint8Array, end: boolean) {
		try {
			carry += decoder.decode(bytes, { stream: !end });
		} catch {
			throw new ArchiveDecryptError("this backup's plaintext is not UTF-8");
		}
		const parts = carry.split("\n");
		carry = parts.pop()!;
		if (carry.length > MAX_PLAIN_LINE) throw new ArchiveDecryptError(`this backup holds a line longer than ${MAX_PLAIN_LINE} characters`);
		yield* parts;
		if (end && carry !== "") yield carry;
	};

	for (;;) {
		const next = await input.next();
		if (next.done) break;
		lineNumber += 1;
		const text = next.value.trim();
		if (text === "") continue;
		const sealed = fromBase64(text);
		if (!sealed || sealed.byteLength < NONCE_BYTES + TAG_BYTES) {
			throw new ArchiveDecryptError(`chunk ${index + 1} (line ${lineNumber}) is not a sealed chunk (base64 of nonce, ciphertext and tag)`);
		}
		if (sealed.byteLength > NONCE_BYTES + header.chunk_bytes + TAG_BYTES) {
			throw new ArchiveDecryptError(`chunk ${index + 1} (line ${lineNumber}) is larger than the header's chunk_bytes`);
		}
		if (held) yield* plainLines(await open(held, false), false);
		held = { sealed, index, line: lineNumber };
		index += 1;
	}
	if (!held) throw new ArchiveDecryptError("this backup was truncated: it has no chunks after its header");
	yield* plainLines(await open(held, true), true);
}
