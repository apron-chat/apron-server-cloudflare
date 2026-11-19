# @apron/archive

Apron chat archives as a library: apron-web's `ARCHIVE.md` v1 (JSON Lines:
a header, then listings and `rooms` / `messages` / `reactions` /
`memberships` records as `room_list` and `history` give them), and what a
program needs to read, write, replay, renumber and encrypt them.

TypeScript with no runtime dependencies and no storage or platform code:
WebCrypto, `TextEncoder`, `ReadableStream` and `btoa` only, so it runs the
same in browsers, Cloudflare Workers and Node 20 or later. It lives in
apron-server-cloudflare as an npm workspace, shared with scene.apron.chat
and, later, apron-web.

## Installing

Published to npm as compiled ES modules with `.d.ts` declarations, so a
consumer needs no TypeScript settings of its own:

```sh
npm install @apron/archive
```

To release, bump `version` in `package.json`: when `main` has a version
npm doesn't, the `publish-archive` job in `.github/workflows/deploy.yml`
builds it (`npm run build -w @apron/archive`: `scripts/build.mjs` writes
`dist/` with a publishable `package.json`) and publishes `dist/` (with an
`NPM_TOKEN` secret). No tags. The workspace `package.json` stays `private`
and points at `src/`: this repository imports the sources directly. To try
a build elsewhere before a release, `npm pack packages/archive/dist`.

## Modules

Everything is exported from `@apron/archive`; each module is also its own
entry (`@apron/archive/format`, ...).

- `records.ts`: `ChatRecord` (one logged record: its room, log ID, commit
  time, kind and wire JSON), `byLog` ordering, `canonicalJson`,
  `namedUsers`, and what `/purge` and `/rename` do to a record
  (`purgedValue`, `renamedValue`, ...).
- `types.ts`: the ARCHIVE.md v1 types: header, room listing, archived user,
  parts, and the streaming `ArchiveWriter` / `ArchiveReader` interfaces.
- `format.ts`: the codec. `jsonlWriter` (lines to any async sink, parts
  split under a line cap), `jsonlReader` (tolerant, as ARCHIVE.md §1 asks),
  `linesOf` / `linesFromStream` (text or a byte stream to lines),
  `collectArchive` (a whole archive in memory), `wireToRecord` /
  `recordToWire`, `writeArchiveToString`.
- `replay.ts`: `replayRecords(records, listings?, users?)`, the current
  state records give (PROTOCOL §2.3), in any order and with duplicates:
  each room's latest room record or listing, each message's latest snapshot
  (tombstones included), each user's reaction set per message and
  membership per room, and the users. `reactions` and `members` are what a
  reader shows; `reactionSets` and `memberships` keep each user's latest
  entry as logged (cleared sets and leaves included), for a writer of
  state, as the server's import uses them. `compareReplayed` compares two
  replayed states (optionally through an ID mapping) and lists the
  differences: the oracle of round-trip tests.
- `ids.ts`: renumbering on import. `IdMap` (old to new log IDs and user
  IDs), `remapRecord` / `remapListing` / `remapUser` (every place an ID
  occurs), `nudgeLogIds` (colliding log IDs to the next free millisecond,
  order kept), `freeUserId`, and the user ID rules of an Apron server
  (`restorableUserId`, `placeholderBase`).
- `crypto.ts`: encrypted archives (backups). AES-256-GCM in chunks bound to
  the backup's random ID, the chunk's index and a final flag; the key
  derived from a named secret with HKDF-SHA-256 and identified by a
  fingerprint. `encryptingSink`, `decryptingLines`, `deriveBackupKey`,
  `resolveKeys` (keys by secret name from an environment object),
  `isEncryptedArchive`.

## Tests

`test/` holds the package's tests and real archives from scene.apron.chat
(`test/fixtures/scenes/`). They run with the repository's `npm test`
(Vitest), and import nothing of the server.
