// Transitional (stage a): everything the old src/store.ts exported, from its new homes.
export { SqliteStore as Store } from "./sqlite-store";
export { ADMIN_USER_ID } from "../user-ids";
export { StoreError } from "../store-error";
export { MAX_TERMINAL_OUTPUT_JSON_BYTES } from "../content/output-ref";
export {
  ROOM_ID, MAX_PASSKEYS_PER_USER, DEFAULT_JOINED_ROOMS, PRIVATE_ROOM_PREFIX, isPrivateRoomId, MAX_READ_RECEIPT_MEMBERS, UNCLAIMED_ROLE,
  MODERATOR_ROLES, BOT_MODERATOR_ROLES, BOT_NAME_PATTERN, BOT_NAME_RULE, ROOM_CREATOR_ROLES, MAX_CREATED_ROOMS, MAX_LISTED_USER_ROOMS,
  MAX_ROLES_PER_USER, ROLE_PATTERN, MAX_PUSH_URL_BYTES, PUSH_ID_PATTERN, WAKE_SCOPES, JOINED_WAKE_ROLES, EMOJI_ROLES, MUTE_FOREVER,
  MAX_MUTE_SECONDS, MAX_ROOM_MUTES_PER_USER, seenStands, muteValue, nextRoomMuteEnd,
} from "../domain";
export { LIVE_ORPHAN_GRACE_MS, liveDeadline, liveHolds, terminalOutput } from "../live-text";
export { mergeExt } from "../content/user";
export { DEGRADE_SHARE, EXHAUSTED_SHARE } from "../budget";
export { SCHEMA_VERSION, UPGRADABLE_SCHEMA_VERSION } from "./schema";
export { defaultStoreConfig, type StoreConfig, type StoreLiveTextConfig } from "./config";
export {
  isPendingHistory, type LiveEntry, type PendingHistory, type LiveFinish, type TerminalStored, type StoredServerMetadata, type EmojiEntry,
  type EmojiEdit, type EmojiDraft, type UploadFinish, type UploadWrite, type Identity, type MessageSnapshot, type RoomRecord, type Broadcast,
  type StoreMutationInput, type StoreMutationResult, type StoreHistoryResult, type AccountingGuard, type OverrunNotice, type StatusInputRecord,
  type PushCandidate, type PushSubscriptionRecord, type ClaimedPush, type RoomNotesCheck,
} from "./types";
export { newTerminalOutputKey } from "./rows";
export {
  MOVE_REACTION_SETS_PER_POST, HISTORY_SCAN_BATCH, RESTORE_RECORDS_BATCH, RESTORE_ENTRIES_BATCH, RESTORE_ENTRIES_SINGLE, RESTORE_USERS_BATCH,
  RETIRED_SWEEP_BATCH, MAX_CARRIED_PASSKEYS, UPLOAD_WRITE_GRACE_MS, UPLOAD_SWEEP_BATCH,
} from "./limits";
export { STORAGE_UNAVAILABLE, OPERATION_PAUSED, TRIP_WINDOW_MS, BREAKER_OVERRUNS, BREAKER_WINDOW_MS, BREAKER_MS, DEGRADED, BREAKER_ALERT_ONLY } from "./accounting";
