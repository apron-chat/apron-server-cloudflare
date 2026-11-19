/*
 * Encrypted archives (src/crypto/): round trips, every kind of tampering
 * refused, key rotation, and the errors an operator sees, none of which
 * print key material. The secrets are test-only (the same values as the
 * server's HISTORY_BACKUP_KEY and HISTORY_BACKUP_KEY_OLD test bindings in
 * its vitest.config.ts), given directly, so this runs in any runtime.
 */

import { describe, expect, it } from "vitest";
import {
	ArchiveDecryptError,
	ArchiveKeyError,
	type DecryptionStatus,
	decryptArchive,
	deriveBackupKey,
	encryptArchive,
	isEncryptedArchive,
	resolveKeys,
} from "../src/crypto/index.ts";

/** Test-only secrets, as an environment holds them: 32 random bytes in base64 each, and a longer shared one. */
const env: Record<string, string> = {
	HISTORY_BACKUP_KEY: "eFGn4jFTKnrUqDnE5adM+1fdPYYD7RXuzs9/jUHnrvs=",
	HISTORY_BACKUP_KEY_OLD: "sBjpLIt1KHDasdiD+Y6qVIGfnT121t7aBmqRajoQQpo=",
	UPLOAD_SIGNING_KEY: "test-upload-signing-key-0123456789abcdef",
};
const secrets = env;
const CURRENT = secrets.HISTORY_BACKUP_KEY!;
const OLD = secrets.HISTORY_BACKUP_KEY_OLD!;

const ARCHIVE = [
	'{"apron_archive":1,"server":"demo.test","exported_at":"2026-11-19T00:00:00Z"}',
	'{"not_joined":[{"room_id":"lobby","title":"Lobby — ünïcode ✓"}],"users":[{"user_id":"ada"}]}',
	'{"messages":[{"room_id":"lobby","log_id":"1","text":"hello 🎉"}]}',
	"",
	'{"messages":[{"room_id":"lobby","log_id":"2","text":"a longer line, so the chunks split it in the middle of a character: ééééééé"}]}',
];

async function encrypt(lines: readonly string[], name: string, secret: string, chunkBytes?: number): Promise<string[]> {
	const out: string[] = [];
	const { key, fingerprint } = await deriveBackupKey(secret);
	const sink = encryptArchive(async (line) => void out.push(line), { name, key, fingerprint, chunkBytes });
	for (const line of lines) await sink(line);
	await sink.close();
	return out;
}

async function* from(lines: readonly string[]) {
	yield* lines;
}

async function decrypt(lines: readonly string[], keys = resolveKeys(env, ["HISTORY_BACKUP_KEY", "HISTORY_BACKUP_KEY_OLD"])): Promise<string[]> {
	const out: string[] = [];
	for await (const line of decryptArchive(from(lines), keys)) out.push(line);
	return out;
}

/** The error decrypt rejects with, checked to print no key material. */
async function failure(lines: readonly string[], keys?: ReturnType<typeof resolveKeys>): Promise<Error> {
	try {
		await decrypt(lines, keys);
	} catch (error) {
		const message = String((error as Error).message);
		for (const secret of [CURRENT, OLD]) expect(message).not.toContain(secret);
		return error as Error;
	}
	throw new Error("decryption did not fail");
}

function flipByte(line: string, at: number): string {
	const bytes = Uint8Array.from(atob(line), (c) => c.charCodeAt(0));
	bytes[at]! ^= 0x01;
	return btoa(String.fromCharCode(...bytes));
}

describe("backup keys", () => {
	it("derives a fingerprint as the first 8 bytes of SHA-256 of the HKDF output", async () => {
		// The secret's text is HKDF's input, as it is.
		const material = new TextEncoder().encode(CURRENT);
		const hkdf = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveBits"]);
		const bits = await crypto.subtle.deriveBits(
			{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("apron history backup v1") },
			hkdf,
			256,
		);
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bits));
		const expected = [...digest.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
		const { fingerprint, key } = await deriveBackupKey(CURRENT);
		expect(fingerprint).toBe(expected);
		expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
		expect(key.extractable).toBe(false);
		expect((await deriveBackupKey(OLD)).fingerprint).not.toBe(fingerprint);
	});

	it("derives from a secret shared with another use, such as UPLOAD_SIGNING_KEY", async () => {
		const keys = resolveKeys(env, ["UPLOAD_SIGNING_KEY"]);
		const key = await keys.lookup("UPLOAD_SIGNING_KEY");
		expect(key?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
		const encrypted = await encrypt(ARCHIVE, "UPLOAD_SIGNING_KEY", env.UPLOAD_SIGNING_KEY, 64);
		expect(await decrypt(encrypted, keys)).toEqual(ARCHIVE);
	});

	it("refuses a secret shorter than 32 characters, without printing it", async () => {
		for (const bad of [btoa("too short"), "x".repeat(31), "   ", ""]) {
			const error = await deriveBackupKey(bad, "HISTORY_BACKUP_KEY").catch((e: Error) => e);
			expect(error).toBeInstanceOf(ArchiveKeyError);
			expect((error as Error).message).toMatch(/^the secret HISTORY_BACKUP_KEY must be at least 32 characters of randomness/);
			if (bad.trim()) expect((error as Error).message).not.toContain(bad);
		}
		const keys = resolveKeys({ BAD: btoa("short secret value") }, ["BAD"]);
		const error = await keys.lookup("BAD").catch((e: Error) => e);
		expect(error).toBeInstanceOf(ArchiveKeyError);
		expect((error as Error).message).toContain("the secret BAD");
		expect((error as Error).message).not.toContain(btoa("short secret value"));
	});

	it("finds only listed, set secrets", async () => {
		const keys = resolveKeys({ ...secrets, EMPTY: "" }, ["HISTORY_BACKUP_KEY", "EMPTY", "UNSET"]);
		expect(keys.names).toEqual(["HISTORY_BACKUP_KEY", "EMPTY", "UNSET"]);
		expect((await keys.lookup("HISTORY_BACKUP_KEY"))?.fingerprint).toBe((await deriveBackupKey(CURRENT)).fingerprint);
		expect(await keys.lookup("HISTORY_BACKUP_KEY_OLD")).toBeUndefined();
		expect(await keys.lookup("EMPTY")).toBeUndefined();
		expect(await keys.lookup("UNSET")).toBeUndefined();
	});
});

describe("encrypted archives", () => {
	it("writes the plaintext header, then base64 chunks, and round-trips", async () => {
		const encrypted = await encrypt(ARCHIVE, "HISTORY_BACKUP_KEY", CURRENT, 64);
		const { fingerprint } = await deriveBackupKey(CURRENT);
		const id = JSON.parse(encrypted[0]!).id;
		expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(encrypted[0]).toBe(
			`{"apron_archive_encrypted":1,"alg":"AES-256-GCM","kdf":"HKDF-SHA-256","key":"HISTORY_BACKUP_KEY","fingerprint":"${fingerprint}","id":"${id}","chunk_bytes":64}`,
		);
		expect(isEncryptedArchive(encrypted[0]!)).toBe(true);
		const plaintextBytes = new TextEncoder().encode(ARCHIVE.map((line) => `${line}\n`).join("")).byteLength;
		expect(encrypted.length - 1).toBe(Math.ceil(plaintextBytes / 64));
		for (const chunk of encrypted.slice(1)) expect(chunk).toMatch(/^[A-Za-z0-9+/]+=*$/);
		// No plaintext shows through.
		expect(encrypted.join("\n")).not.toContain("lobby");
		expect(await decrypt(encrypted)).toEqual(ARCHIVE);
	});

	it("says whether its input was decrypted, and refuses a header's chunk_bytes past 4 MiB", async () => {
		const read = async (lines: readonly string[]) => {
			const status: DecryptionStatus = {};
			const out: string[] = [];
			for await (const line of decryptArchive(from(lines), resolveKeys(env, ["HISTORY_BACKUP_KEY"]), status)) out.push(line);
			return { out, status };
		};
		const encrypted = await encrypt(ARCHIVE, "HISTORY_BACKUP_KEY", CURRENT, 64);
		expect((await read(encrypted)).status).toEqual({ encrypted: true });
		expect((await read(ARCHIVE)).status).toEqual({ encrypted: false });
		const header = JSON.parse(encrypted[0]!);
		const large = [JSON.stringify({ ...header, chunk_bytes: 4 * 1024 * 1024 + 1 }), ...encrypted.slice(1)];
		await expect(read(large)).rejects.toThrow(/chunk_bytes/);
		expect(() => encryptArchive(async () => {}, { name: "K", key: {} as CryptoKey, fingerprint: "0".repeat(16), chunkBytes: 4 * 1024 * 1024 + 1 })).toThrow(RangeError);
	});

	it("uses the default 1 MiB chunks and a fresh nonce each time", async () => {
		const big = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ messages: [{ log_id: String(i), text: "x".repeat(500) }] }));
		const encrypted = await encrypt(big, "HISTORY_BACKUP_KEY", CURRENT);
		expect(JSON.parse(encrypted[0]!).chunk_bytes).toBe(1024 * 1024);
		expect(encrypted.length).toBe(3);
		expect(await decrypt(encrypted)).toEqual(big);
		const again = await encrypt(ARCHIVE, "HISTORY_BACKUP_KEY", CURRENT);
		const once = await encrypt(ARCHIVE, "HISTORY_BACKUP_KEY", CURRENT);
		// The same key and settings, but each backup has its own ID.
		expect(JSON.parse(again[0]!)).toMatchObject({ ...JSON.parse(once[0]!), id: expect.any(String) });
		expect(JSON.parse(again[0]!).id).not.toBe(JSON.parse(once[0]!).id);
		expect(again[1]).not.toBe(once[1]);
	});

	it("seals an empty archive as a header and one empty final chunk", async () => {
		const encrypted = await encrypt([], "HISTORY_BACKUP_KEY", CURRENT);
		expect(encrypted.length).toBe(2);
		expect(await decrypt(encrypted)).toEqual([]);
	});

	it("keeps lines in order when the caller does not wait for each", async () => {
		const out: string[] = [];
		const { key, fingerprint } = await deriveBackupKey(CURRENT);
		const sink = encryptArchive(async (line) => void out.push(line), { name: "HISTORY_BACKUP_KEY", key, fingerprint, chunkBytes: 16 });
		await Promise.all([...ARCHIVE.map((line) => sink(line)), sink.close()]);
		expect(await decrypt(out)).toEqual(ARCHIVE);
		await expect(sink("late")).rejects.toThrow(/already closed/);
	});

	it("skips blank lines and \\r line ends around the header and chunks", async () => {
		const encrypted = await encrypt(ARCHIVE, "HISTORY_BACKUP_KEY", CURRENT, 50);
		const loose = ["", "  ", ...encrypted.flatMap((line) => [`${line}\r`, ""])];
		expect(await decrypt(loose)).toEqual(ARCHIVE);
	});

	it("rejects a flipped byte in a chunk's nonce, ciphertext or tag", async () => {
		const encrypted = await encrypt(ARCHIVE, "HISTORY_BACKUP_KEY", CURRENT, 64);
		const length = atob(encrypted[2]!).length;
		for (const at of [0, 11, 12, 20, length - 1]) {
			const tampered = [...encrypted];
			tampered[2] = flipByte(tampered[2]!, at);
			const error = await failure(tampered);
			expect(error).toBeInstanceOf(ArchiveDecryptError);
			expect(error.message).toBe("chunk 2 (line 3) failed authentication");
		}
	});

	it("rejects a dropped chunk", async () => {
		const encrypted = await encrypt(ARCHIVE, "HISTORY_BACKUP_KEY", CURRENT, 64);
		expect(encrypted.length).toBeGreaterThan(4);
		const dropped = [...encrypted.slice(0, 2), ...encrypted.slice(3)];
		const error = await failure(dropped);
		expect(error).toBeInstanceOf(ArchiveDecryptError);
		expect(error.message).toMatch(/^chunk 2 \(line 3\) failed authentication/);
	});

	it("rejects two chunks swapped", async () => {
		const encrypted = await encrypt(ARCHIVE, "HISTORY_BACKUP_KEY", CURRENT, 64);
		const swapped = [...encrypted];
		[swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
		const error = await failure(swapped);
		expect(error).toBeInstanceOf(ArchiveDecryptError);
		expect(error.message).toMatch(/^chunk 1 \(line 2\) failed authentication/);
	});

	it("rejects a backup whose last chunk is missing, or that has no chunks", async () => {
		const encrypted = await encrypt(ARCHIVE, "HISTORY_BACKUP_KEY", CURRENT, 64);
		const truncated = encrypted.slice(0, -1);
		const error = await failure(truncated);
		expect(error).toBeInstanceOf(ArchiveDecryptError);
		expect(error.message).toBe(`this backup was truncated: it ends at chunk ${truncated.length - 1} (line ${truncated.length}), which is not its final chunk`);
		const headerOnly = await failure(encrypted.slice(0, 1));
		expect(headerOnly.message).toBe("this backup was truncated: it has no chunks after its header");
	});

	it("rejects chunks after the final one, and a final chunk moved earlier", async () => {
		const encrypted = await encrypt(ARCHIVE, "HISTORY_BACKUP_KEY", CURRENT, 64);
		const extended = await failure([...encrypted, encrypted[1]!]);
		expect(extended.message).toMatch(/failed authentication: it is the final chunk, but more follows/);
		// A chunk that is not base64 is refused by position.
		const garbled = await failure([...encrypted.slice(0, 2), "!!!", ...encrypted.slice(2)]);
		expect(garbled.message).toMatch(/^chunk 2 \(line 3\) is not a sealed chunk/);
	});

	it("rejects a chunk spliced in from another backup made with the same key at the same position", async () => {
		// Each backup has its own random ID in every chunk's additional data, so
		// a chunk from another backup fails even at the same index.
		const a = await encrypt(ARCHIVE, "HISTORY_BACKUP_KEY", CURRENT, 64);
		const b = await encrypt(ARCHIVE.map((line) => line.toUpperCase()), "HISTORY_BACKUP_KEY", CURRENT, 64);
		expect(JSON.parse(a[0]!).id).not.toBe(JSON.parse(b[0]!).id);
		const spliced = [a[0]!, a[1]!, b[2]!, ...a.slice(3)];
		const error = await failure(spliced);
		expect(error).toBeInstanceOf(ArchiveDecryptError);
		expect(error.message).toBe("chunk 2 (line 3) failed authentication");
		// So does a whole body moved under another backup's header.
		const moved = await failure([b[0]!, ...a.slice(1)]);
		expect(moved.message).toBe("chunk 1 (line 2) failed authentication");
	});

	it("decrypts a backup made with an older listed key", async () => {
		const encrypted = await encrypt(ARCHIVE, "HISTORY_BACKUP_KEY_OLD", OLD, 64);
		expect(await decrypt(encrypted)).toEqual(ARCHIVE);
	});

	it("names the secret and fingerprint a backup needs when its key is not listed", async () => {
		const encrypted = await encrypt(ARCHIVE, "HISTORY_BACKUP_KEY_OLD", OLD, 64);
		const { fingerprint } = await deriveBackupKey(OLD);
		const error = await failure(encrypted, resolveKeys(env, ["HISTORY_BACKUP_KEY"]));
		expect(error).toBeInstanceOf(ArchiveKeyError);
		expect(error.message).toBe(
			`this backup needs HISTORY_BACKUP_KEY_OLD (fingerprint ${fingerprint}); set it with \`wrangler secret put\`, list it in BACKUP_PREVIOUS_KEY_NAMES, and import again`,
		);
		// Listed but unset reads the same.
		const unset = await failure(encrypted, resolveKeys({}, ["HISTORY_BACKUP_KEY_OLD"]));
		expect(unset.message).toMatch(/^this backup needs HISTORY_BACKUP_KEY_OLD/);
	});

	it("refuses a secret re-set to another value, by fingerprint", async () => {
		// Made when HISTORY_BACKUP_KEY held what is now OLD's value.
		const encrypted = await encrypt(ARCHIVE, "HISTORY_BACKUP_KEY", OLD, 64);
		const error = await failure(encrypted);
		expect(error).toBeInstanceOf(ArchiveKeyError);
		expect(error.message).toMatch(/^the key HISTORY_BACKUP_KEY does not match this backup's fingerprint/);
		// An edited header fingerprint is refused the same way.
		const header = JSON.parse(encrypted[0]!);
		const edited = [JSON.stringify({ ...header, fingerprint: "0".repeat(16) }), ...encrypted.slice(1)];
		expect((await failure(edited, resolveKeys({ HISTORY_BACKUP_KEY: OLD }, ["HISTORY_BACKUP_KEY"]))).message).toMatch(/does not match this backup's fingerprint/);
	});

	it("refuses an unknown format version or a malformed header", async () => {
		const unknown = await failure(['{"apron_archive_encrypted":2,"alg":"AES-256-GCM"}', "AAAA"]);
		expect(unknown).toBeInstanceOf(ArchiveDecryptError);
		expect(unknown.message).toMatch(/format 2/);
		const malformed = await failure(['{"apron_archive_encrypted":1,"alg":"AES-256-GCM","kdf":"HKDF-SHA-256","key":"K"}']);
		expect(malformed.message).toMatch(/header is malformed/);
		const encrypted = await encrypt(ARCHIVE, "HISTORY_BACKUP_KEY", CURRENT, 64);
		const { id: _id, ...withoutId } = JSON.parse(encrypted[0]!);
		const noId = await failure([JSON.stringify(withoutId), ...encrypted.slice(1)]);
		expect(noId.message).toMatch(/header is malformed/);
	});

	it("passes a plain archive through unchanged", async () => {
		const plain = ["", ...ARCHIVE, "not json", "  "];
		expect(isEncryptedArchive(ARCHIVE[0]!)).toBe(false);
		expect(isEncryptedArchive("not json")).toBe(false);
		expect(isEncryptedArchive("[1]")).toBe(false);
		expect(await decrypt(plain, resolveKeys({}, []))).toEqual(plain);
		expect(await decrypt([], resolveKeys({}, []))).toEqual([]);
		expect(await decrypt(["", " "], resolveKeys({}, []))).toEqual(["", " "]);
	});
});

describe("the core's additional authenticated data", () => {
	it("is the ID's 22 bytes, the index as uint64 big-endian, then the final flag (CRYPTO.md)", async () => {
		const { additionalData } = await import("../src/crypto/core.ts");
		const id = "ABCDEFGHIJKLMNOPQRSTUV";
		const aad = additionalData(id, 0x0102030405, true);
		expect([...aad]).toEqual([...new TextEncoder().encode(id), 0, 0, 0, 1, 2, 3, 4, 5, 1]);
		expect(additionalData(id, 0, false).at(-1)).toBe(0);
		expect(() => additionalData("short", 0, false)).toThrow(RangeError);
		expect(() => additionalData(id, -1, false)).toThrow(RangeError);
	});
});
