/*
 * The store: all authoritative state of the Durable Object, behind the
 * one surface code outside src/store imports (this module).
 *
 * The surface
 * - openStore(ctx, config) opens it over the Durable Object's SQLite.
 * - A Store is its parts (parts.ts), one plain noun each: accounts,
 *   credentials, rooms, messages, reads, server, admission, meter, ops,
 *   lifecycle and history, always; push, uploads and liveText only where
 *   the deploy configures that feature. A caller depends on the parts it
 *   uses, and a part's methods are named for what they do there
 *   (`accounts.get`, `rooms.list`, `push.claim`). Each part is a small
 *   object (sqlite-parts.ts) delegating to the module that implements it.
 *
 * The implementation (all internal: only tests of internals import it)
 * - The core (core.ts, StoreCore): what every module runs over. A module
 *   gets SQL only inside a reservation, through the Sql handle the
 *   reservation's callback is given (its queries, a transaction, and the
 *   shared lookups), so an unmetered query is a type error; each
 *   reservation names its operation explicitly, for overruns and breakers
 *   (accounting.ts). The one deliberate unmetered read is the attack
 *   pause, read once as an instance starts (StoreCore.unmetered).
 * - The modules, each over the core and the modules it names in its
 *   constructor: push.ts (Web Push), reads.ts (read cursors, statuses,
 *   mutes, `seen`), admission.ts (limits and charges), uploads.ts
 *   (uploads, avatars, the server's metadata, emoji and toggles),
 *   live-text.ts, history-log.ts (history pages, the history chain's head
 *   and state, rewrites, the chunk index, the import journal) and
 *   room-caps.ts. Each owns its tables (schema.ts, TABLE_OWNERS).
 * - SqliteStore (sqlite-store.ts) is the core (accounting and metering,
 *   schema setup, upgrades and reset, transactions and the execution
 *   choke point), and what is one with it: the commit path (mutations,
 *   messages, reactions, rooms and memberships, identities and
 *   credentials, renames and purges, the log and its head), restore and
 *   import (which append to the log as commits do), and cleanup and the
 *   alarm (which manage their own reservations across transactions and
 *   prune every table).
 * - Around them: the schema and table owners (schema.ts), `_meta` keys
 *   (meta.ts), caps (limits.ts), accounting policy and operation names
 *   (accounting.ts), rows (rows.ts), configuration (config.ts), and the
 *   history ports over the store (history.ts).
 * - Domain rules the store applies (roles, name and ID patterns,
 *   user-facing caps, mutes) are not the store's: they live in
 *   src/domain.ts, src/live-text.ts and src/content/.
 *
 * Store methods are synchronous with respect to SQLite: a Durable Object
 * is single threaded, but requests interleave at every await, so callers
 * can make the reply/broadcast gate wait for a complete mutation before
 * exposing its result.
 */

export { openStore } from "./open";
export type {
  Accounts, Admission, Credentials, History, Lifecycle, LiveText, Messages, Meter, Ops, Push, Reads, Rooms, Server, Store, Uploads, Webhooks,
} from "./parts";
export type { WebhookFormat, WebhookRecord, WebhookState } from "./webhooks";
export { webhookAccount } from "./webhooks";
export type {
  AccountingGuard, Broadcast, ClaimedPush, EmojiDraft, EmojiEdit, EmojiEntry, Identity, LiveEntry, LiveFinish, MessageSnapshot, OverrunNotice,
  PendingHistory, PendingUpload, PushCandidate, PushClaim, PushSubscriptionRecord, RoomMember, RoomNotesCheck, RoomRecord, StatusInputRecord,
  StoreCleanupResult, StoredServerMetadata, StoreHistoryQuery, StoreHistoryResult, StoreMutationInput, StoreMutationResult, TerminalStored,
  UploadFinish, UploadWrite,
} from "./types";
export { isPendingHistory } from "./types";
export { defaultStoreConfig, type StoreConfig } from "./config";
export { StoreError } from "../store-error";
/** A refusal's `reason` while storage is unavailable (accounting closed on a storage failure). */
export { STORAGE_UNAVAILABLE } from "./accounting";
/** How many retired IDs one accounts.dueRetiredIds returns at most: as many means more are due. */
export { RETIRED_SWEEP_BATCH } from "./limits";
/** How many uploads one uploads.cleanup sweeps at most, and how long past its write expiry a pending upload is kept. */
export { UPLOAD_SWEEP_BATCH, UPLOAD_WRITE_GRACE_MS } from "./limits";
