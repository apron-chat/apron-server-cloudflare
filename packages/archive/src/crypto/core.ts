/*
 * The audited core of encrypted archives (CRYPTO.md): key derivation, the
 * header, the additional authenticated data, and sealing and opening one
 * chunk. Pure functions over WebCrypto: no streams, lines, base64 or
 * environment. Everything else in crypto/ is built on these, and only these
 * touch keys, nonces or AES-GCM. Errors never include key material.
 */

export const HKDF_INFO = "apron history backup v1";
/** The shortest secret a backup key is derived from: 32 bytes of its trimmed text. */
export const MIN_SECRET_BYTES = 32;
export const ALG = "AES-256-GCM";
export const KDF = "HKDF-SHA-256";
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
/** Random bytes in a backup's ID: 22 characters of base64url. */
const ID_BYTES = 16;
/** The largest chunk accepted, writing or reading: a crafted header must not make a reader hold more. */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

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
	/** AES-256-GCM, not extractable. */
	key: CryptoKey;
	/** The first 8 bytes, hex, of SHA-256 of the derived key. Safe to print. */
	fingerprint: string;
}

/** The plaintext first line of an encrypted archive. Only `id` is authenticated (in every chunk's AAD); the rest can only make decryption fail. */
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

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const validChunkBytes = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && n <= MAX_CHUNK_BYTES;

/**
 * The AES-256-GCM key for a secret: HKDF-SHA-256 over the secret's trimmed
 * UTF-8 text, no salt, info HKDF_INFO, 256 bits. A secret shared with another
 * use gets a key of its own under this label. `name` only labels errors.
 */
export async function deriveBackupKey(secret: string, name?: string): Promise<BackupKey> {
	const material = encoder.encode(secret.trim());
	if (material.byteLength < MIN_SECRET_BYTES) {
		const label = name ? `the secret ${name}` : "a backup key";
		throw new ArchiveKeyError(`${label} must be at least ${MIN_SECRET_BYTES} characters of randomness (make one with \`openssl rand -base64 32\`); its value is shorter`);
	}
	const hkdf = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveBits"]);
	// The raw bits are needed once, for the fingerprint; the key made from them is not extractable.
	const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(HKDF_INFO) }, hkdf, 256));
	const key = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bits));
	bits.fill(0);
	return { key, fingerprint: hex(digest.subarray(0, 8)) };
}

/** A new backup's header, with a fresh random ID. */
export function newHeader(name: string, fingerprint: string, chunkBytes: number): EncryptedArchiveHeader {
	if (!validChunkBytes(chunkBytes)) throw new RangeError(`chunkBytes must be a whole number from 1 to ${MAX_CHUNK_BYTES}`);
	if (!name) throw new RangeError("an encrypted archive needs the name of its key's secret");
	if (!/^[0-9a-f]{16}$/.test(fingerprint)) throw new RangeError("a backup key's fingerprint is 16 hex digits");
	const id = base64Url(crypto.getRandomValues(new Uint8Array(ID_BYTES)));
	return { apron_archive_encrypted: 1, alg: ALG, kdf: KDF, key: name, fingerprint, id, chunk_bytes: chunkBytes };
}

/** A line as a JSON object, or undefined (a leading BOM and surrounding whitespace allowed). */
function jsonObject(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line.replace(/^﻿/, "").trim());
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** Whether a first line is an encrypted archive's header, of any version. */
export function isEncryptedArchive(line: string): boolean {
	const value = jsonObject(line);
	return value !== undefined && "apron_archive_encrypted" in value;
}

/** An encrypted archive's header, checked field by field. Throws ArchiveDecryptError for any other line. */
export function parseHeader(line: string): EncryptedArchiveHeader {
	const h = jsonObject(line);
	if (!h || !("apron_archive_encrypted" in h)) throw new ArchiveDecryptError("this is not an encrypted archive's header");
	if (h.apron_archive_encrypted !== 1) throw new ArchiveDecryptError(`this backup is encrypted in format ${JSON.stringify(h.apron_archive_encrypted)}, which this server cannot read`);
	if (h.alg !== ALG || h.kdf !== KDF) throw new ArchiveDecryptError(`this backup is encrypted with ${JSON.stringify(h.alg)} and ${JSON.stringify(h.kdf)}; this server reads only ${ALG} with ${KDF}`);
	const valid = typeof h.key === "string" && h.key !== "" && typeof h.fingerprint === "string" && /^[0-9a-f]{16}$/.test(h.fingerprint)
		&& typeof h.id === "string" && /^[A-Za-z0-9_-]{22}$/.test(h.id) && validChunkBytes(h.chunk_bytes);
	if (!valid) throw new ArchiveDecryptError("this backup's encryption header is malformed (key, fingerprint, id or chunk_bytes)");
	return { apron_archive_encrypted: 1, alg: ALG, kdf: KDF, key: h.key as string, fingerprint: h.fingerprint as string, id: h.id as string, chunk_bytes: h.chunk_bytes as number };
}

/**
 * Additional authenticated data of a chunk: the backup's ID (UTF-8, always
 * 22 bytes, so the parts cannot run together), the chunk's index (uint64,
 * big-endian), then 1 if it is the final chunk, else 0.
 */
export function additionalData(id: string, index: number, final: boolean): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw new RangeError("a backup ID is 22 base64url characters");
	if (!Number.isSafeInteger(index) || index < 0) throw new RangeError("a chunk index is a whole number from 0");
	const aad = new Uint8Array(22 + 9);
	aad.set(encoder.encode(id));
	const view = new DataView(aad.buffer, 22);
	view.setUint32(0, Math.floor(index / 0x100000000));
	view.setUint32(4, index >>> 0);
	aad[30] = final ? 1 : 0;
	return aad;
}

/** Seals a chunk of at most `header.chunk_bytes` plaintext: nonce (fresh, random) ‖ ciphertext ‖ tag. */
export async function sealChunk(key: CryptoKey, header: EncryptedArchiveHeader, index: number, final: boolean, plaintext: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	if (plaintext.byteLength > header.chunk_bytes) throw new RangeError("a chunk holds at most chunk_bytes of plaintext");
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: additionalData(header.id, index, final) }, key, plaintext));
	const out = new Uint8Array(NONCE_BYTES + sealed.byteLength);
	out.set(nonce);
	out.set(sealed, NONCE_BYTES);
	return out;
}

/** A sealed chunk's plaintext if it authenticates at this index and finality under `key`, else undefined. */
export async function openChunk(key: CryptoKey, header: EncryptedArchiveHeader, index: number, final: boolean, sealed: Uint8Array<ArrayBuffer>): Promise<Uint8Array | undefined> {
	if (sealed.byteLength < NONCE_BYTES + TAG_BYTES || sealed.byteLength > NONCE_BYTES + header.chunk_bytes + TAG_BYTES) return undefined;
	try {
		const iv = sealed.subarray(0, NONCE_BYTES);
		return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: additionalData(header.id, index, final) }, key, sealed.subarray(NONCE_BYTES)));
	} catch {
		return undefined;
	}
}
