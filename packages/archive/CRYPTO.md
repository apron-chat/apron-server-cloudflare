# Encrypted archives

How `@apron/archive/crypto` seals an ARCHIVE.md v1 file, what that
protects against and what it doesn't, and how to audit it. Every
cryptographic step is in `src/crypto/core.ts` (about 150 lines, WebCrypto
only). `stream.ts` frames chunks as lines and `keys.ts` looks secrets up by
name. Neither touches a key, a nonce or AES-GCM except through the core.

## Public surface

| Export | What |
|---|---|
| `deriveBackupKey(secret, name?)` | `BackupKey`: a non-extractable AES-256-GCM key and its fingerprint |
| `encryptArchive(sink, {key, fingerprint, name, chunkBytes?})` | A line sink: each call is one plaintext line (with or without its `"\n"`), then `close()` |
| `decryptArchive(lines, keys, status?)` | The plaintext lines, decrypting if the first non-blank line is an encrypted header, else passing a plain archive through |
| `openArchive(lines, keys?, status?)` | `decryptArchive` read as an `ArchiveReader` |
| `isEncryptedArchive(firstLine)` | Whether a line is an encrypted archive's header |
| `resolveKeys(env, names)` | `BackupKeys` by secret name from an environment object |
| `ArchiveKeyError`, `ArchiveDecryptError` | Wrong, missing or malformed key; tampered, truncated or malformed archive |

Nothing else is exported. Tests import `src/crypto/core.ts` directly.

## Construction

- **Key.** HKDF-SHA-256 over the secret's trimmed UTF-8 text. Empty salt,
  info `"apron history backup v1"`, 256 bits, imported as a
  non-extractable AES-GCM key. The secret must be at least 32 bytes
  (`openssl rand -base64 32`). The raw bits are hashed once for the
  fingerprint, then zeroed.
- **Fingerprint.** The first 8 bytes, as hex, of SHA-256 of the derived key
  bits. It identifies a key without revealing it, and catches a secret that
  was re-set under the same name.
- **Archive.** The plaintext is the archive's text, where every line ends
  in exactly one `"\n"`. It is cut into chunks of `chunk_bytes`, from 1 to
  4 MiB (1 MiB by default). Every chunk except the last is full. The last
  is flagged final and may be short, and is empty only if the archive is.
- **Chunk.** AES-256-GCM with a fresh random 96-bit nonce and a 128-bit
  tag. On the wire it is base64 of nonce ‖ ciphertext ‖ tag, one chunk per
  line.
- **Additional authenticated data** (AAD) of chunk *i*: the backup's ID (22
  ASCII bytes), then *i* as uint64 big-endian, then one byte, 1 if final
  and 0 if not. That is 31 bytes, fixed length, so the fields can't run
  together.
- **Header.** The first line, in plain JSON:
  `{"apron_archive_encrypted":1,"alg":"AES-256-GCM","kdf":"HKDF-SHA-256","key":NAME,"fingerprint":HEX16,"id":ID22,"chunk_bytes":N}`.
  `id` is 16 random bytes in base64url, new for each archive.

## Threat model

**Protects against:**
- **Reading a backup** without the secret. This covers whoever can read
  the bucket: a leaked R2 token, a misconfigured bucket, a copy left
  somewhere.
- **Undetected changes** to a backup: any edit, truncation, reordering,
  duplication, deletion of a chunk, or a chunk spliced in from another
  backup made with the same key. The importer acts on nothing until the
  whole file has authenticated (it plans first), so a tampered backup is
  refused as a whole.
- **Using the wrong key silently.** A key that doesn't match the header's
  fingerprint is refused before any chunk is tried.

**Does not protect against:**
- **Compromise of the Worker or its secrets.** The key is symmetric and
  lives in the Worker, which both writes and reads backups. Whoever has the
  secret can read every backup made with it, and can make new valid ones.
  Encrypting to a public key, so the Worker could write backups but not
  read them, would need a different design (for example age's X25519
  recipients).
- **A shared secret.** In production the key is derived from
  `UPLOAD_SIGNING_KEY`. HKDF's label keeps the two keys cryptographically
  separate, but leaking or rotating that one secret affects both uses. To
  rotate, set a new secret, name it in `BACKUP_ENCRYPTION_KEY_NAME`, and
  keep the old name in `BACKUP_PREVIOUS_KEY_NAMES`.
- **Weak secrets.** There is no key stretching: the secret must already be
  random (32+ characters). A password would be guessable offline.
- **Metadata.** The key's name, the fingerprint, `chunk_bytes`, the number
  of chunks (and so roughly the archive's size) and the time of writing
  are all visible.
- **Unauthenticated header fields.** Only `id` is authenticated, through
  every chunk's AAD. Changing any other field either makes decryption fail
  (wrong format, algorithm, key name or fingerprint, or `chunk_bytes`
  smaller than a chunk) or makes no difference to the plaintext (a larger
  valid `chunk_bytes`, or an added field). It can never change what
  decrypts.
- **Rollback.** An older, genuine backup made with the same key decrypts
  fine. Choosing which backup to restore is the operator's call.

**Limits:**
- **Nonces.** With random 96-bit nonces, a key stays safe for up to 2³²
  chunks, about 4 PiB at 1 MiB chunks. Daily backups don't come close.
- **Size.** `chunk_bytes` is capped at 4 MiB, so a crafted header can't
  make a reader hold more. A reader also refuses a plaintext line longer
  than 1 Mi characters.

## Invariants and where they are tested

These are property tests in `test/crypto.property.test.ts` (fast-check)
unless the table says otherwise. The worked examples and error messages
are in `test/crypto.test.ts`.

| # | Invariant | Test |
|---|---|---|
| 1 | Decrypting returns exactly the lines written, whether or not each ends in `"\n"`, for any chunk size and any text (multibyte, astral, `\r`, empty lines) | "round-trips exactly" |
| 2 | The decrypted bytes equal the plain archive's bytes, from `jsonlWriter` through to the reader, for every scene fixture | "decrypts to the plain archive's exact text" |
| 3 | Every chunk but the last is full; there is exactly one final chunk; an empty archive has one empty final chunk | "seals every chunk but the last full…" and crypto.test.ts "seals an empty archive…" |
| 4 | Any truncation, including no chunks at all, fails | "refuses every truncation" |
| 5 | Dropping, duplicating or reordering chunks fails | "refuses chunks dropped, duplicated or reordered" |
| 6 | A chunk spliced in from another backup made with the same key, at the same index, fails | "refuses a chunk spliced in…" |
| 7 | Flipping any single bit in a chunk's nonce, ciphertext or tag fails | "refuses any single bit flipped…" |
| 8 | Another key, or none, fails with `ArchiveKeyError` before any chunk is tried | "refuses another key, or none" |
| 9 | Any change to the header fails, or gives the same plaintext | "fails, or decrypts to the same lines, whatever is changed in the header" |
| 9a | The AAD is exactly ID (22 bytes) ‖ uint64 BE index ‖ final byte | crypto.test.ts "the core's additional authenticated data" (known answer) |
| 10 | The fingerprint is the first 8 bytes of SHA-256 of the HKDF output with the documented parameters | crypto.test.ts "derives a fingerprint…" |
| 11 | A secret under 32 bytes is refused, and no error includes key material | crypto.test.ts "refuses a secret shorter…" and the `failure()` checks |
| 12 | Decryption emits nothing from a chunk until that chunk has authenticated | by construction (`stream.ts`: a chunk is held until the next line shows whether it is final, then opened, then emitted); 4 and 5 cover the consequences |

## Audit checklist

1. **Key derivation and the AEAD:** read `core.ts` alone. Check
   - the HKDF parameters, AES-GCM key size, nonce size and source, AAD
     layout, and the chunk size bounds;
   - that `openChunk` returns nothing on any failure, and `sealChunk`
     refuses oversize plaintext;
   - that nothing exports raw key bits.
2. **`stream.ts` uses only the core:**
   - it never calls `crypto.subtle` (`grep subtle src/crypto/stream.ts`
     finds nothing);
   - the chunk index increments by one per chunk, and only the last chunk
     is opened as final;
   - plaintext is emitted only after `openChunk` succeeds;
   - the decoder is fatal UTF-8.
3. **Exports:** `src/crypto/index.ts` exports only the surface above.
4. **Tests:** run `npx vitest run packages/archive`, and the properties
   with more runs (raise `numRuns` locally) before a release.
