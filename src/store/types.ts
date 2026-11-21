/** The data the store's parts take and return, and the host interfaces it runs over (internal: src/store/index.ts exports the public ones). */

import type { LiveKind } from "../live-text";
import type { ChatRecord, HistoryQuery } from "../history/records";
import type { MembershipRecord, PendingUpload, ReactionsRecord } from "./rows";
import type { StatusChoice } from "../presence";
import type { RoomMute } from "../domain";

export type Tier = "anonymous" | "registered";

export interface SqlCursorLike<T = Record<string, unknown>> {
  toArray?: () => T[];
  one?: () => T;
  raw?: () => unknown[];
  rowsRead?: number;
  rowsWritten?: number;
  [Symbol.iterator]?: () => Iterator<T>;
}

export interface SqlStorageLike {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursorLike<T>;
}

interface DurableStorageLike {
  sql: SqlStorageLike;
  transactionSync?: <T>(closure: () => T) => T;
  setAlarm?: (time: number | Date) => Promise<void>;
  deleteAll?: () => Promise<void>;
  getAlarm?: () => Promise<number | null>;
}

export interface DurableStateLike {
  storage: DurableStorageLike;
}

export type DurableSqlStorageLike = DurableStorageLike;

export interface StoreClock {
  now(): number;
}

/**
 * A live text that is open (protocol §4.8.3): waiting for its `PUT`
 * (`pending`) or streaming (`live`). All of them are one `_meta` row
 * (META_LIVE_TEXTS), at most twice `concurrent` entries (startLiveText); the bytes themselves are
 * only in the object's memory while they stream.
 */
export interface LiveEntry {
  /** The write key its `write_url` signs: `l/<128 random bits>`. */
  key: string;
  /** The random segment of its `url`, `<publicOrigin>/live/<id>`. */
  id: string;
  kind: LiveKind;
  /** Who started it: the author of its message. */
  owner: string;
  /** The IP key it was started from. */
  ip: string;
  state: "pending" | "live";
  /** Until when its `write_url` may start the write. */
  writeExpiresMs: number;
  /** How long it may stream from its `PUT`: by the owner's role. */
  maxMs: number;
  /** What it keeps: a terminal's last bytes, or the bytes an append may add. */
  limit: number;
  /** When its `PUT` arrived. */
  startedMs?: number;
  embedId: string;
  /** Its message; absent until a command's write arrives and posts it. */
  messageId?: string;
  /** A command's message, posted when the write arrives (`/embed-terminal`, `/embed-append`). */
  post?: { roomId: string; title?: string; text?: string; replyTo?: string; identity: Identity };
}

/** What a finished live text published, if anything. */
/**
 * A history page that reaches below the hot floor (Store.historyAcrossTiers):
 * what it needs of the tiers below (HistoryChain.read), and the page
 * their records complete.
 */
export interface PendingHistory {
  below: HistoryQuery;
  assemble(rows: readonly ChatRecord[]): StoreHistoryResult;
}

/** Whether a history result still needs the tiers below. */
export function isPendingHistory(result: StoreHistoryResult | PendingHistory): result is PendingHistory {
  return "below" in result && "assemble" in result;
}

export interface LiveFinish {
  broadcasts: Broadcast[];
  /** The entry that ended, if it was still open. */
  entry?: LiveEntry;
  /** Whether the snapshot refers to the output the runtime stored in R2 (TerminalStored); if not, the runtime deletes it. */
  stored?: boolean;
}

/**
 * A finished terminal's output the runtime wrote to R2 before finishing it
 * (finishLiveText): its key (`f/<id>`, kept like an attached file) and the
 * output it holds, terminalOutput of what the text kept.
 */
export interface TerminalStored {
  key: string;
  output: string;
}

/**
 * The server's `title`, `description` and `avatar` (§3.1) as admins set them
 * with `/server`, each absent while its deployment variable applies.
 */
export interface StoredServerMetadata {
  title?: string;
  description?: string;
  avatar?: string;
}

/** One custom emoji in the catalog (extension `ext:emoji`), as published. */
export interface EmojiEntry {
  url: string;
  width?: number;
  height?: number;
}

/** A catalog edit: a finished `/emoji add` write, or `/emoji remove`. */
export type EmojiEdit = { add: UploadWrite } | { remove: string };

/**
 * The catalog an emoji edit leads to, worked out before anything changes
 * (emojiDraft): its JSON, exactly as published, and the R2 key the caller
 * writes it to before commitEmoji, or null for an empty catalog, which is
 * not published.
 */
export interface EmojiDraft {
  edit: EmojiEdit;
  json: string;
  key: string | null;
  entries: Record<string, EmojiEntry>;
}

/** What finishUpload did: the snapshot to broadcast, or the avatar set, and R2 objects to delete. */
export interface UploadFinish {
  accepted: boolean;
  broadcasts: Broadcast[];
  avatar?: { userId: string; url: string };
  /** The server's new avatar URL (`/server avatar`). */
  serverAvatar?: string;
  deletedUploads: string[];
}

/** A finished write, as the Worker saw it. */
export interface UploadWrite {
  key: string;
  ok: boolean;
  bytes?: number;
  contentType?: string;
  width?: number;
  height?: number;
}

export interface Identity {
  user_id: string;
  name?: string;
  tier?: Tier;
}

/** A flat, self-describing message snapshot (protocol §3.5). */
export interface MessageSnapshot {
  message_id: string;
  log_id: string;
  room_id: string;
  from: Identity;
  body?: Record<string, unknown>;
  reply_to?: { message_id: string };
  deleted?: boolean;
  ext?: Record<string, unknown>;
  /** The previous snapshot's log_id (section 2); absent on creation. */
  prev_log_id?: string;
  /** The previous snapshot's room, when a move changed it (section 2). */
  prev_room_id?: string;
}

/** A room record plus this server's delivery fields (protocol §4.2). */
export interface RoomRecord {
  room_id: string;
  log_id: string;
  parent_room_id?: string;
  /** Present on a private room only (§4.2.4, PRIVATE_ROOM_PREFIX). */
  private?: true;
  title?: string;
  /** What the room is about, CommonMark by convention (§4.2). */
  description?: string;
  ext?: Record<string, unknown>;
  latest_log_id: string;
  history_log_id: string | null;
}

/**
 * A committed record, in log order, ready to deliver as a notification to the
 * members of `rooms`: its room, and for a move both rooms (§3.4, §4.3.1).
 */
export interface Broadcast {
  /** A membership record is delivered in `room_update` `memberships` (§4.2.3), not as its own notification. */
  method: "message" | "reactions" | "membership";
  params: Record<string, unknown>;
  rooms: string[];
}

export type MutationMethod = "message" | "room_set" | "reactions" | "me";

export interface StoreMutationInput {
  userId: string;
  tier?: Tier;
  ipKey: string;
  requestId?: string;
  method?: MutationMethod | string;
  now?: number;
  /** The complete request parameters; saves replace every client field. */
  params: Record<string, unknown>;
  identity: Identity;
  digest?: string;
  /** An operator alert the server posts itself (Store.alert): no posting limits or storage high-water apply. */
  system?: boolean;
}

export interface StoreMutationResult {
  result: Record<string, unknown>;
  /** Records committed by this operation, in ascending log order. */
  broadcasts: Broadcast[];
  /** The saved message snapshot, for message operations. */
  message?: MessageSnapshot;
  /** The saved room record, for `room_set`. */
  room?: RoomRecord;
  /** Uploads this operation started; their `write_url`s go in the result (§4.8.3). */
  uploads?: PendingUpload[];
  /** R2 objects to delete: uploads whose embed or message this operation removed. */
  deletedUploads?: string[];
  /** Live texts this operation started (§4.8.3); their `write_url`s go in the result. */
  liveStarted?: LiveEntry[];
  /** Live texts this operation ended by removing their embed or message (§4.8.3, `edit`), by write key. */
  liveEnded?: string[];
  /** Whether `room_set` created the room, which joins its creator (§4.2.4). */
  created?: boolean;
  /** The creator's logged membership, for a registered creator (§4.2.4). */
  membership?: Broadcast;
  /** An accepted retry: the original result, with no new records. */
  deduplicated?: boolean;
  /** For `me`: the user's `ext` after the write, and the keys it changed (§4.13). */
  profile?: { ext?: Record<string, unknown>; changed?: Record<string, unknown> };
}

/** A history page (§4.3): each array is omitted when empty, and the bounds with it. */
export interface StoreHistoryResult {
  rooms?: RoomRecord[];
  messages?: MessageSnapshot[];
  reactions?: ReactionsRecord[];
  memberships?: MembershipRecord[];
  first_log_id?: string;
  last_log_id?: string;
  more: boolean;
  latest_log_id: string;
  history_log_id: string | null;
}

/** What overruns have set off (META_ACCOUNTING_GUARD). */
export interface AccountingGuard {
  day: string;
  /** Overruns this UTC day. */
  overruns: number;
  /** Open breakers: operation name to when it closes. */
  breakers: Record<string, number>;
  /** Each operation's overruns within BREAKER_WINDOW_MS, oldest first. */
  recent: Record<string, number[]>;
}

/** An overrun, as the runtime is told of it (Store.onOverrun). */
export interface OverrunNotice {
  operation: string;
  message: string;
  principals: readonly string[];
  maintenance: boolean;
  /** The day's first overrun. */
  firstToday: boolean;
  /** It opened its operation's breaker. */
  breaker: boolean;
  /** Its excess passed a hundredth of a day's SQL ceilings, which opens the breaker at once. */
  huge: boolean;
  /** An essential operation (BREAKER_ALERT_ONLY): no breaker, the admins are told instead. */
  essential: boolean;
}

/**
 * A user's stored `status` state (protocol §4.5), read once at sign-in:
 * the `status` they chose with `me`, until when their unscoped mute lasts
 * (absent when not muted), and their room mutes in effect, in `room_id`
 * order. Their `seen` (§4.5.2) comes with the identity row the sign-in
 * reads anyway (getIdentity), not from here.
 */
export interface StatusInputRecord {
  choice: StatusChoice;
  muteUntil?: number;
  roomMutes: RoomMute[];
}

/** A user a message may wake, and why: a bitmask of WAKE_SCOPES. */
export interface PushCandidate {
  userId: string;
  reasons: number;
}

/**
 * A user's Web Push registration (protocol §4.9, kind `webpush`): its
 * endpoint, the browser's keys, and the client's `push_id`, which every push
 * to it carries. A registration is the user's: two users may register the
 * same endpoint.
 */
export interface PushSubscriptionRecord {
  url: string;
  userId: string;
  p256dh: string;
  auth: string;
  pushId?: string;
}

/**
 * A registration a wake claimed, with the scopes it is pushed for: what it
 * wakes for among why its user qualified, and its user's `unread` count
 * (protocol §4.9.3) when the push carries one.
 */
export type ClaimedPush = PushSubscriptionRecord & { reasons: number; unread?: number };

/** What a room_set's total check saw (Store.takeRoomNotesCheck). */
export interface RoomNotesCheck {
  /** What rooms hold past roomMetadataMinBytes, together: with the save, or on a refusal as they are. */
  total: number;
  /** The save was refused: the total was past roomMetadataTotalBytes. */
  full?: true;
  /** On a refusal, the public rooms holding the most past the minimum. */
  rooms?: Array<{ room_id: string; title?: string; bytes: number }>;
}
