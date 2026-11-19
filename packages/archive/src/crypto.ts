/*
 * Encrypted archives (PLAN §13.3): an ARCHIVE.md v1 file sealed with
 * AES-256-GCM in chunks, so a backup in a blob store is unreadable without
 * its key and is written and read as a stream.
 *
 * Keys are Wrangler secrets named by BACKUP_ENCRYPTION_KEY_NAME and
 * BACKUP_PREVIOUS_KEY_NAMES (in apron-server-cloudflare): any secret
 * of at least 32 characters of randomness, such as the server's own
 * UPLOAD_SIGNING_KEY, or one kept for backups alone (`openssl rand -base64
 * 32`). The encryption key is derived from a secret with HKDF-SHA-256
 * (no salt, info "apron history backup v1"), and each backup names the secret
 * it used and a fingerprint of the derived key (the first 8 bytes, hex, of its
 * SHA-256), so any listed key decrypts the backups made with it and a secret
 * re-set to another value is caught rather than misused.
 *
 * The format, one line each:
 *   - a plaintext JSON header: {"apron_archive_encrypted":1,"alg":"AES-256-GCM",
 *     "kdf":"HKDF-SHA-256","key":NAME,"fingerprint":HEX,"id":ID,"chunk_bytes":N},
 *     where ID is 16 random bytes in base64url, new for each backup;
 *   - then one line per chunk: base64 of nonce (12 bytes) ‖ ciphertext ‖ tag.
 * A chunk holds `chunk_bytes` of the plaintext file (the last one may hold
 * less), each with a fresh random nonce. Its additional authenticated data is
 * the backup's ID (UTF-8), its index (uint64, big-endian) and a final-chunk
 * flag byte, so a chunk moved, dropped, cut off, or spliced in from another
 * backup made with the same key fails to decrypt. A backup always ends with a
 * chunk flagged final, empty if the archive is, so truncation always shows.
 *
 * Decrypted, the chunks concatenate to the ordinary archive. Errors name the
 * secret and fingerprint involved, never key material. WebCrypto only: this
 * runs the same in the Worker and in Node.
 */

import { jsonlReader } from "./format.ts";
import type { ArchiveReader } from "./types.ts";

const HKDF_INFO = "apron history backup v1";
/** The shortest secret a backup key is derived from: 32 bytes of its text. */
const MIN_SECRET_BYTES = 32;
const ALG = "AES-256-GCM";
const KDF = "HKDF-SHA-256";
const NONCE_BYTES = 12;
/** Random bytes in each backup's ID. */
const ID_BYTES = 16;
const TAG_BYTES = 16;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
/** The largest chunk accepted, writing or reading: a corrupt or crafted header must not make a reader hold more. */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
/** The longest plaintext line a reader holds while it waits for the line's end (as format.ts MAX_READ_LINE_BYTES, in UTF-16 units). */
const MAX_PLAIN_LINE = 1024 * 1024;

/** What decryptingLines learned of its input, filled in once it has read the first line. */
export interface DecryptionStatus {
	/** Whether the input was an encrypted archive, decrypted (and so authenticated) with one of the keys given. */
	encrypted?: boolean;
}

const encoder = new TextEncoder();

/** A key the environment lacks, or one whose value is not the one a backup was made with, or is malformed. */
export class ArchiveKeyError extends Error {
	override name = "ArchiveKeyError";
}

/** An encrypted archive that cannot be read: tampered, truncated, or malformed. */
export class ArchiveDecryptError extends Error {
	override name = "ArchiveDecryptError";
}

/** A derived backup key and its fingerprint. */
export interface BackupKey {
	key: CryptoKey;
	/** The first 8 bytes, hex, of SHA-256 of the derived key. Safe to print. */
	fingerprint: string;
}

/** The backup keys an environment has, found by secret name. */
export interface BackupKeys {
	/** The secret names consulted, in order (newest first: the first encrypts new backups). */
	readonly names: readonly string[];
	/** The key for a secret, or undefined if the secret is not listed or not set. Rejects with ArchiveKeyError if it is set but malformed. */
	lookup(name: string): Promise<BackupKey | undefined>;
}

/** The plaintext first line of an encrypted archive. */
export interface EncryptedArchiveHeader {
	apron_archive_encrypted: 1;
	alg: typeof ALG;
	kdf: typeof KDF;
	/** The name of the secret the backup was made with. */
	key: string;
	fingerprint: string;
	/** 16 random bytes, base64url: binds each chunk to this backup. */
	id: string;
	chunk_bytes: number;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
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

function toBase64Url(bytes: Uint8Array): string {
	return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The AES-256-GCM key for a secret and its fingerprint. The secret's text
 * (trimmed) is HKDF's input as it is, so a secret shared with another use
 * (UPLOAD_SIGNING_KEY) gives a key of its own under this label. `name` only
 * labels the error for a short secret, which never includes the value.
 */
export async function deriveBackupKey(secret: string, name?: string): Promise<BackupKey> {
	const material = encoder.encode(secret.trim());
	if (material.byteLength < MIN_SECRET_BYTES) {
		const label = name ? `the secret ${name}` : "a backup key";
		throw new ArchiveKeyError(`${label} must be at least ${MIN_SECRET_BYTES} characters of randomness (make one with \`openssl rand -base64 32\`); its value is shorter`);
	}
	const hkdf = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveBits"]);
	// Derive the raw bits first: the fingerprint is a hash of them, and the
	// CryptoKey made from them is not extractable.
	const bits = new Uint8Array(
		await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(HKDF_INFO) }, hkdf, 256),
	);
	const key = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bits));
	bits.fill(0);
	return { key, fingerprint: hex(digest.subarray(0, 8)) };
}

/**
 * The backup keys among `env`'s secrets, by name: only the names listed are
 * consulted (the BACKUP_*_KEY_NAME(S) vars name them), and each is derived once,
 * when first asked for. A listed secret that is unset reads as absent.
 */
export function resolveKeys(env: object, names: readonly string[]): BackupKeys {
	const values = env as Record<string, unknown>;
	const listed = [...names];
	const derived = new Map<string, Promise<BackupKey>>();
	return {
		names: listed,
		lookup: async (name) => {
			if (!listed.includes(name)) return undefined;
			const value = values[name];
			if (typeof value !== "string" || value.trim() === "") return undefined;
			let key = derived.get(name);
			if (!key) {
				key = deriveBackupKey(value, name);
				derived.set(name, key);
			}
			return key;
		},
	};
}

/** Whether an archive's first line is an encrypted archive's header (of any version). */
export function isEncryptedArchive(firstLine: string): boolean {
	const parsed = parseJsonObject(firstLine);
	return parsed !== undefined && "apron_archive_encrypted" in parsed;
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(line.replace(/^﻿/, "").trim());
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Additional authenticated data: the backup's ID (UTF-8, always 22
 * characters, so the parts cannot run together), the chunk's index (uint64,
 * big-endian), then 1 if final, else 0.
 */
function additionalData(id: string, index: number, final: boolean): Uint8Array<ArrayBuffer> {
	const idBytes = encoder.encode(id);
	const aad = new Uint8Array(idBytes.byteLength + 9);
	aad.set(idBytes);
	const view = new DataView(aad.buffer, idBytes.byteLength);
	view.setUint32(0, Math.floor(index / 0x100000000));
	view.setUint32(4, index >>> 0);
	aad[idBytes.byteLength + 8] = final ? 1 : 0;
	return aad;
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

/** A line sink that encrypts: call it with each plaintext line, then `close` once. */
export interface EncryptingSink {
	(line: string): Promise<void>;
	close(): Promise<void>;
}

export interface EncryptOptions extends BackupKey {
	/** The secret's name, recorded in the header so import can find the key. */
	name: string;
	/** Plaintext bytes per chunk. Default 1 MiB. */
	chunkBytes?: number;
}

/**
 * Encrypts an archive written line by line (as jsonlWriter writes it) into
 * `sink`: the header line first, then a chunk line each time a chunk's worth
 * of plaintext has gathered, and on `close` the final chunk. Each plaintext
 * line is taken as ending in "\n". Calls are queued, so lines keep their order
 * even if a caller does not wait for each.
 */
export function encryptingSink(sink: (line: string) => Promise<void>, options: EncryptOptions): EncryptingSink {
	const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
	if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) {
		throw new RangeError(`chunkBytes must be a whole number from 1 to ${MAX_CHUNK_BYTES}`);
	}
	if (!options.name) throw new RangeError("an encrypted archive needs the name of its key's secret");
	const header: EncryptedArchiveHeader = {
		apron_archive_encrypted: 1,
		alg: ALG,
		kdf: KDF,
		key: options.name,
		fingerprint: options.fingerprint,
		id: toBase64Url(crypto.getRandomValues(new Uint8Array(ID_BYTES))),
		chunk_bytes: chunkBytes,
	};
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
		const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
		const sealed = new Uint8Array(
			await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: additionalData(header.id, index, final) }, options.key, plaintext),
		);
		index += 1;
		const line = new Uint8Array(NONCE_BYTES + sealed.byteLength);
		line.set(nonce);
		line.set(sealed, NONCE_BYTES);
		await sink(toBase64(line));
	};

	const write = (line: string) =>
		enqueue(async () => {
			if (closed) throw new Error("the encrypted archive is already closed");
			await start();
			const bytes = encoder.encode(`${line}\n`);
			pending.push(bytes);
			pendingBytes += bytes.byteLength;
			// Seal a chunk only when more than a chunk is waiting: what is left
			// at close becomes the final chunk, never empty unless the archive is.
			while (pendingBytes > chunkBytes) {
				await seal(take(pending, chunkBytes), false);
				pendingBytes -= chunkBytes;
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

function parseHeader(line: string): EncryptedArchiveHeader {
	const parsed = parseJsonObject(line)!;
	if (parsed.apron_archive_encrypted !== 1) {
		throw new ArchiveDecryptError(`this backup is encrypted in format ${JSON.stringify(parsed.apron_archive_encrypted)}, which this server cannot read`);
	}
	if (parsed.alg !== ALG || parsed.kdf !== KDF) {
		throw new ArchiveDecryptError(`this backup is encrypted with ${JSON.stringify(parsed.alg)} and ${JSON.stringify(parsed.kdf)}; this server reads only ${ALG} with ${KDF}`);
	}
	if (
		typeof parsed.key !== "string" ||
		parsed.key === "" ||
		typeof parsed.fingerprint !== "string" ||
		!/^[0-9a-f]{16}$/.test(parsed.fingerprint) ||
		typeof parsed.id !== "string" ||
		!/^[A-Za-z0-9_-]{22}$/.test(parsed.id) ||
		typeof parsed.chunk_bytes !== "number" ||
		!Number.isSafeInteger(parsed.chunk_bytes) ||
		parsed.chunk_bytes < 1 ||
		parsed.chunk_bytes > MAX_CHUNK_BYTES
	) {
		throw new ArchiveDecryptError("this backup's encryption header is malformed (key, fingerprint, id or chunk_bytes)");
	}
	return parsed as unknown as EncryptedArchiveHeader;
}

/** Whether a chunk decrypts with the given flag: its plaintext, or undefined. */
async function unseal(key: CryptoKey, id: string, sealed: Uint8Array<ArrayBuffer>, index: number, final: boolean): Promise<Uint8Array | undefined> {
	try {
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: sealed.subarray(0, NONCE_BYTES), additionalData: additionalData(id, index, final) },
			key,
			sealed.subarray(NONCE_BYTES),
		);
		return new Uint8Array(plaintext);
	} catch {
		return undefined;
	}
}

/**
 * The plaintext lines of an archive, decrypting it if its first non-blank
 * line is an encrypted archive's header; a plain archive's lines pass through
 * unchanged. The key is the one the header names, looked up in `keys` and
 * confirmed by fingerprint. Lines come out as chunks are verified, so a
 * consumer must not act on them until the iteration ends without error
 * (import plans first, PLAN §10.2): a cut-off backup is detected only at its
 * end. Rejects with ArchiveKeyError or ArchiveDecryptError.
 */
export async function* decryptingLines(lines: AsyncIterable<string>, keys: Pick<BackupKeys, "lookup">, status: DecryptionStatus = {}): AsyncGenerator<string, void, undefined> {
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
	const decoder = new TextDecoder();
	let carry = "";
	/** The chunk seen last, held until the next line shows whether it is the final one. */
	let held: { sealed: Uint8Array<ArrayBuffer>; index: number; line: number } | undefined;
	let index = 0;

	const decrypt = async (chunk: { sealed: Uint8Array<ArrayBuffer>; index: number; line: number }, final: boolean): Promise<Uint8Array> => {
		const where = `chunk ${chunk.index + 1} (line ${chunk.line})`;
		const plaintext = await unseal(found.key, header.id, chunk.sealed, chunk.index, final);
		if (plaintext) return plaintext;
		// Tell the two ways a chunk in the wrong place shows, for a clearer message.
		if (final && (await unseal(found.key, header.id, chunk.sealed, chunk.index, false))) {
			throw new ArchiveDecryptError(`this backup was truncated: it ends at ${where}, which is not its final chunk`);
		}
		if (!final && (await unseal(found.key, header.id, chunk.sealed, chunk.index, true))) {
			throw new ArchiveDecryptError(`${where} failed authentication: it is the final chunk, but more follows`);
		}
		throw new ArchiveDecryptError(`${where} failed authentication`);
	};
	const plainLines = function* (bytes: Uint8Array, end: boolean) {
		carry += decoder.decode(bytes, { stream: !end });
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
		if (held) yield* plainLines(await decrypt(held, false), false);
		held = { sealed, index, line: lineNumber };
		index += 1;
	}
	if (!held) throw new ArchiveDecryptError("this backup was truncated: it has no chunks after its header");
	yield* plainLines(await decrypt(held, true), true);
}

/**
 * An archive reader over lines that may be an encrypted backup: decrypted
 * chunk by chunk with the keys given (decryptingLines), and read as plain
 * otherwise. Without keys, an encrypted archive fails naming the key it
 * needs. `status.encrypted` says, once the header is read, whether it was
 * decrypted (and so authenticated) with one of them.
 */
export function openArchive(lines: AsyncIterable<string>, keys?: Pick<BackupKeys, "lookup">, status?: DecryptionStatus): ArchiveReader {
	return jsonlReader(decryptingLines(lines, keys ?? { lookup: async () => undefined }, status));
}
