/*
 * The store: all authoritative state of the Durable Object, behind the
 * one surface code outside src/store imports (this module).
 *
 * - openStore(ctx, config) opens it over the Durable Object's SQLite.
 * - A Store is its parts (parts.ts), one plain noun each: accounts,
 *   credentials, rooms, messages, reads, server, admission, meter, ops,
 *   lifecycle and history, always; push, uploads and liveText only where
 *   the deploy configures that feature. A caller depends on the parts it
 *   uses, and a part's methods are named for what they do there
 *   (`accounts.get`, `rooms.list`, `push.claim`).
 * - The implementation is SqliteStore (sqlite-store.ts), with its schema
 *   (schema.ts), `_meta` keys (meta.ts), caps (limits.ts), accounting
 *   policy (accounting.ts), rows (rows.ts) and configuration (config.ts).
 *   Each part is a small object delegating to it (sqlite-parts.ts); the
 *   history ports are adapters over it (history.ts). All of these are
 *   internal: only tests of SqliteStore's internals import them.
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
  Accounts, Admission, Credentials, History, Lifecycle, LiveText, Messages, Meter, Ops, Push, Reads, Rooms, Server, Store, Uploads,
} from "./parts";
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
