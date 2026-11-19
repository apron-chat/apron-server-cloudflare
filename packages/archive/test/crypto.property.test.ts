/*
 * Encrypted archives, by property (fast-check): the invariants CRYPTO.md
 * lists, each checked over generated archives, chunk sizes and tamperings
 * rather than hand-picked cases. crypto.test.ts keeps the worked examples
 * and the error messages.
 */

import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { ArchiveDecryptError, ArchiveKeyError, type BackupKey, decryptArchive, deriveBackupKey, encryptArchive } from "../src/crypto/index.ts";
import { collectArchive, jsonlReader, jsonlWriter, linesOf } from "../src/format.ts";
import { sceneArchives } from "./fixtures/scenes/index.ts";

const NAME = "BACKUP_KEY";
let key: BackupKey;
let other: BackupKey;

beforeAll(async () => {
	key = await deriveBackupKey("property-test-secret-0123456789abcdef", NAME);
	other = await deriveBackupKey("another-property-test-secret-0123456789", NAME);
});

async function encrypt(lines: readonly string[], chunkBytes: number, with_ = key): Promise<string[]> {
	const out: string[] = [];
	const sink = encryptArchive(async (line) => void out.push(line), { ...with_, name: NAME, chunkBytes });
	for (const line of lines) await sink(line);
	await sink.close();
	return out;
}

async function* from(lines: readonly string[]) {
	yield* lines;
}

/** Decrypts with `with_` as the key named NAME; null: no key at all. */
async function decrypt(lines: readonly string[], with_: BackupKey | null = key): Promise<string[]> {
	const out: string[] = [];
	for await (const line of decryptArchive(from(lines), { lookup: async (name) => (name === NAME && with_ ? with_ : undefined) })) out.push(line);
	return out;
}

/** The error decrypting rejects with, or undefined if it decrypts. */
async function failure(lines: readonly string[], with_: BackupKey | null = key): Promise<unknown> {
	try {
		await decrypt(lines, with_);
		return undefined;
	} catch (error) {
		return error;
	}
}

/** A plaintext line: any text without "\n" (multibyte and astral characters included). */
const line = fc.string({ unit: fc.oneof(fc.constantFrom("a", "é", "€", "😀", "\r", "\t", " ", "{", "\""), fc.string({ unit: "grapheme", minLength: 1, maxLength: 1 })), maxLength: 40 })
	.map((text) => text.replace(/\n/g, ""));
const lines = fc.array(line, { maxLength: 24 });
const chunkBytes = fc.integer({ min: 1, max: 64 });
/** An encrypted archive with at least `min` chunks, and what it holds. */
const sealed = (min: number) =>
	fc.tuple(fc.array(line.filter((text) => text !== ""), { minLength: 1, maxLength: 16 }), fc.integer({ min: 1, max: 24 }))
		.filter(([plain, size]) => Math.ceil(plain.reduce((n, text) => n + new TextEncoder().encode(`${text}\n`).byteLength, 0) / size) >= min);

const RUNS = { numRuns: 60 };

describe("encrypted archives, by property", () => {
	it("round-trips exactly: the lines written, whether or not each ends in \\n, for any chunk size", async () => {
		await fc.assert(fc.asyncProperty(lines, fc.array(fc.boolean(), { minLength: 24, maxLength: 24 }), chunkBytes, async (plain, newline, size) => {
			const written = plain.map((text, i) => (newline[i] ? `${text}\n` : text));
			const encrypted = await encrypt(written, size);
			expect(await decrypt(encrypted)).toEqual(plain);
		}), { numRuns: 120 });
	});

	it("seals every chunk but the last full, and the last final (empty only for an empty archive)", async () => {
		await fc.assert(fc.asyncProperty(lines, chunkBytes, async (plain, size) => {
			const encrypted = await encrypt(plain, size);
			const bytes = plain.reduce((n, text) => n + new TextEncoder().encode(`${text}\n`).byteLength, 0);
			expect(encrypted.length - 1).toBe(Math.max(1, Math.ceil(bytes / size)));
		}), RUNS);
	});

	it("refuses every truncation", async () => {
		await fc.assert(fc.asyncProperty(sealed(1), fc.nat(), async ([plain, size], cut) => {
			const encrypted = await encrypt(plain, size);
			const kept = 1 + (cut % (encrypted.length - 1));
			expect(await failure(encrypted.slice(0, kept))).toBeInstanceOf(ArchiveDecryptError);
		}), RUNS);
	});

	it("refuses chunks dropped, duplicated or reordered", async () => {
		await fc.assert(fc.asyncProperty(sealed(2), fc.nat(), fc.nat(), fc.constantFrom("drop", "duplicate", "swap"), async ([plain, size], a, b, how) => {
			const encrypted = await encrypt(plain, size);
			const chunks = encrypted.slice(1);
			const i = a % chunks.length;
			let j = b % chunks.length;
			if (j === i) j = (i + 1) % chunks.length;
			const changed = [...chunks];
			if (how === "drop") changed.splice(i, 1);
			else if (how === "duplicate") changed.splice(i, 0, chunks[i]!);
			else [changed[i], changed[j]] = [changed[j]!, changed[i]!];
			expect(await failure([encrypted[0]!, ...changed])).toBeInstanceOf(ArchiveDecryptError);
		}), RUNS);
	});

	it("refuses a chunk spliced in from another backup made with the same key", async () => {
		await fc.assert(fc.asyncProperty(sealed(1), fc.nat(), async ([plain, size], at) => {
			const a = await encrypt(plain, size);
			const b = await encrypt(plain, size);
			const i = 1 + (at % (a.length - 1));
			const spliced = [...a];
			spliced[i] = b[i]!;
			expect(await failure(spliced)).toBeInstanceOf(ArchiveDecryptError);
		}), RUNS);
	});

	it("refuses any single bit flipped in a chunk's nonce, ciphertext or tag", async () => {
		await fc.assert(fc.asyncProperty(sealed(1), fc.nat(), fc.nat(), fc.integer({ min: 0, max: 7 }), async ([plain, size], at, byte, bit) => {
			const encrypted = await encrypt(plain, size);
			const i = 1 + (at % (encrypted.length - 1));
			const raw = Uint8Array.from(atob(encrypted[i]!), (c) => c.charCodeAt(0));
			raw[byte % raw.length]! ^= 1 << bit;
			const flipped = [...encrypted];
			flipped[i] = btoa(String.fromCharCode(...raw));
			expect(await failure(flipped)).toBeInstanceOf(ArchiveDecryptError);
		}), RUNS);
	});

	it("refuses another key, or none, with ArchiveKeyError", async () => {
		await fc.assert(fc.asyncProperty(lines, chunkBytes, fc.boolean(), async (plain, size, none) => {
			const encrypted = await encrypt(plain, size);
			expect(await failure(encrypted, none ? null : other)).toBeInstanceOf(ArchiveKeyError);
		}), RUNS);
	});

	it("fails, or decrypts to the same lines, whatever is changed in the header", async () => {
		const field = fc.constantFrom("apron_archive_encrypted", "alg", "kdf", "key", "fingerprint", "id", "chunk_bytes", "extra");
		const value = fc.oneof(fc.string({ maxLength: 24 }), fc.integer({ min: -2, max: 5 * 1024 * 1024 }), fc.constant(null), fc.constant(2));
		await fc.assert(fc.asyncProperty(sealed(1), field, value, async ([plain, size], name, replacement) => {
			const encrypted = await encrypt(plain, size);
			const header = { ...JSON.parse(encrypted[0]!), [name]: replacement };
			const result = await decrypt([JSON.stringify(header), ...encrypted.slice(1)]).then((out) => ({ out }), (error: unknown) => ({ error }));
			if ("out" in result) expect(result.out).toEqual(plain);
			else expect(result.error instanceof ArchiveDecryptError || result.error instanceof ArchiveKeyError).toBe(true);
		}), { numRuns: 120 });
	});

	it("decrypts to the plain archive's exact text: jsonlWriter, encrypted, decrypted, read, as the plain path (every scene)", async () => {
		const scenes = Object.values(sceneArchives);
		await fc.assert(fc.asyncProperty(fc.constantFrom(...scenes), fc.integer({ min: 1, max: 4096 }), async (text, size) => {
			const archive = await collectArchive(jsonlReader(linesOf(text)));
			const write = async (sink: (line: string) => Promise<void>) => {
				const writer = jsonlWriter(sink);
				await writer.header(archive.header);
				await writer.listing({
					joined: archive.rooms.filter((room) => room.joined).map((room) => room.listing),
					not_joined: archive.rooms.filter((room) => !room.joined).map((room) => room.listing),
					users: archive.users,
				});
				await writer.records(archive.records);
				await writer.close();
			};
			const plain: string[] = [];
			await write(async (line) => void plain.push(line));
			const encrypted: string[] = [];
			const sink = encryptArchive(async (line) => void encrypted.push(line), { ...key, name: NAME, chunkBytes: size });
			await write(sink);
			await sink.close();
			const decrypted = await decrypt(encrypted);
			// Byte for byte: no line gains or loses a "\n".
			expect(decrypted.map((text) => `${text}\n`).join("")).toBe(plain.map((text) => (text.endsWith("\n") ? text : `${text}\n`)).join(""));
			expect(await collectArchive(jsonlReader(from(decrypted)))).toEqual(await collectArchive(jsonlReader(from(plain))));
		}), { numRuns: 20 });
	});
});
