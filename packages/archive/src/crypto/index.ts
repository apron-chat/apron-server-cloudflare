/*
 * @apron/archive/crypto: encrypted archives (backups). The whole public
 * surface; CRYPTO.md specifies the construction and its threat model.
 * core.ts holds every cryptographic step and is what to audit; stream.ts
 * and keys.ts are framing and lookup built on it.
 */

import { jsonlReader } from "../format.ts";
import type { ArchiveReader } from "../types.ts";
import { type BackupKeys, type DecryptionStatus, decryptArchive } from "./stream.ts";

export { ArchiveDecryptError, ArchiveKeyError, type BackupKey, deriveBackupKey, isEncryptedArchive } from "./core.ts";
export { type ArchiveEncryptor, type BackupKeys, type DecryptionStatus, decryptArchive, type EncryptOptions, encryptArchive } from "./stream.ts";
export { resolveKeys } from "./keys.ts";

/**
 * An archive reader over lines that may be an encrypted backup: decrypted
 * with the keys given (decryptArchive), and read as plain otherwise. Without
 * keys, an encrypted archive fails naming the key it needs.
 * `status.encrypted` says, once the header is read, whether it was decrypted
 * (and so authenticated) with one of them.
 */
export function openArchive(lines: AsyncIterable<string>, keys?: Pick<BackupKeys, "lookup">, status?: DecryptionStatus): ArchiveReader {
	return jsonlReader(decryptArchive(lines, keys ?? { lookup: async () => undefined }, status));
}
