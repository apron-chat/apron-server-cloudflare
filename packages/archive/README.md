# @apron/archive

Apron chat archives as a library: apron-web's `ARCHIVE.md` v1 (JSON Lines:
a header, then listings and `rooms` / `messages` / `reactions` /
`memberships` records as `room_list` and `history` give them), and what a
program needs to read, write, validate, plan imports of, replay, renumber
and compress them.

TypeScript with no runtime dependencies and no storage or platform code:
`TextEncoder`, `ReadableStream` / `TransformStream` and `CompressionStream`
only, so it runs the same in browsers, Cloudflare Workers and Node 20 or
later. It lives in
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

The line between the library and a server that uses it: the library says
what a record, an archive, a duplicate, a move, a reference or a collision
means; the server says what is true there (`ImportTarget`,
`ArchiveSource`: its rooms, users and records) and what is allowed there
(`UserIdRules`, caps, its own body rules in `ImportTarget.normalize`).

- `records.ts`: `ChatRecord` (one logged record: its room, log ID, commit
  time, kind and wire JSON), `byLog` ordering, `canonicalJson`,
  `namedUsers`, and what `/purge` and `/rename` do to a record
  (`purgedValue`, `renamedValue`, ...).
- `types.ts`: the ARCHIVE.md v1 types: header, room listing, archived user,
  parts, and the streaming `ArchiveWriter` / `ArchiveReader` interfaces.
- `format.ts`: the codec. `jsonlWriter` (lines to any async sink, parts
  split under a line cap), `jsonlReader` (tolerant, as ARCHIVE.md §1 asks),
  `readArchive` (the same, synchronous, from text), `linesOf` /
  `linesFromStream` (text or a byte stream to lines), `collectArchive` (a
  whole archive in memory), `wireToRecord` / `recordToWire`,
  `writeArchiveToString`.
- `validate.ts`: what makes a record valid and a client's.
  `validateRecord` (each kind's shape, or what is wrong with it),
  `withBareUsers` / `clientUser` / `withClientUsers` (recorded users as a
  client sends them, within a server's `NameLimits`), `roomClientFields`,
  `contentKey` (a record's identity for duplicates), `splitReferences`
  (content and references, ARCHIVE.md §3.1), `archiveIdentity`.
- `plan.ts`: `planImport(archive, target, options)`, what importing an
  archive into a history would do, writing nothing: new and skipped rooms,
  a move's copy in the room it left, user mapping (match, new, overrides,
  free IDs, placeholders under `UserIdRules`), duplicates and collisions
  (looked up through the target, nudged to free log IDs), renumbering, and
  the remapped records and listings. Returns a report and a JSON `state`
  from which a retry makes the same plan (`resume`).
- `export.ts`: `exportArchive(source, writer, options)`, a history as one
  archive from any `ArchiveSource` (rooms, users, paged records, a floor):
  listings, users before the page that names them first, private rooms
  left out on request, `history_log_id` clamped to the floor.
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
  order kept), `freeUserId`. Which IDs may hold an account is a server's
  rule, passed to `planImport` as `UserIdRules`.
- `codec.ts`: what an archive's bytes go through between a writer and
  where they are stored, and back. An `ArchiveCodec` is a pair of standard
  WHATWG Streams `TransformStream`s over bytes (`encoder()`,
  `decoder()`), so chains compose with `pipeThrough`: `encodeStream`
  applies a chain in order, `decodeStream` in reverse. `gzip` (through
  `CompressionStream`) is the one codec here; `ARCHIVE_CODECS` /
  `codecChain` find codecs by name (an unknown one is refused), and
  `codecNames` / `codecsFromName` / `archiveName` record a chain with what
  it encoded (metadata, `x.jsonl.gz`). `encodedArchiveWriter` writes an
  archive through a chain to any byte sink; `openArchive(bytes, { codecs,
  maxBytes })` reads one back (decoded size bounded), or reads lines.
  Encryption or signing can be added as codecs of their own after gzip
  (`stream.pipeThrough(gzip.encoder()).pipeThrough(encrypt.encoder())`).
  A codec that `authenticates` must error its decoder on any damage, a
  truncated end included; `openArchive(...).verified()` is then true once
  the archive has been read to its end through it, the one fact a reader
  (an import matching users) may trust more on.

## Tests

`test/` holds the package's tests and real archives from scene.apron.chat
(`test/fixtures/scenes/`). They run with the repository's `npm test`
(Vitest), and import nothing of the server.
