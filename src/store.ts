/*
 * Durable storage for the public Apron demo.
 *
 * The worker deliberately keeps all authoritative state behind this module.  A
 * Durable Object is single threaded, but requests can still be interleaved at
 * every await in the websocket handler.  Store methods are synchronous with
 * respect to SQLite; callers can therefore make the reply/broadcast gate wait
 * for a complete mutation before exposing its result.
 */

import {
  BOOTSTRAP_ROW_RESERVATION,
  DEFAULT_LIMITS,
  MAX_EMOJI_BYTES,
  MAX_PUSH_CANDIDATES,
  MAX_PUSHES_PER_MESSAGE,
  MAX_PRIVATE_MEMBERSHIPS_PER_USER,
  MAX_PRIVATE_ROOM_LIMIT,
  MAX_THREAD_LIMIT,
  SEEN_WRITE_GRANULARITY_MS,
  type LiveTextPolicy,
  type PushPolicy,
  type UploadPolicy,
} from "./budget";
import { hostListAllowed } from "./config";
import { keepAppend, keepLast, liveTextString, type LiveKind } from "./live-text";
import type { AccountUsageSnapshot } from "./account-usage";
import {
  BudgetLedger,
  MAINTENANCE_CONTROL_READS,
  MAINTENANCE_CONTROL_WRITES,
  BUDGET_COLUMNS,
  type BudgetCost,
  type BudgetDelta,
  type BudgetSnapshot,
  type CostEstimate,
  type RawBudgetRow,
} from "./budget-ledger";
import { StoreError, limitData, type LimitCategory } from "./store-error";
import { bucketHorizonMs, chargeBucket, type Bucket, type Rate } from "./limiter";
import { LimiterCache, type RawLimitRow } from "./limiter-cache";
import { isStatusChoice, type StatusChoice } from "./presence";
import { isProtocolId, type StoredCredential, type StoredIdentity } from "./domain.js";
// @ts-expect-error Workers' nodejs_compat runtime supplies this module; the
// worker type package intentionally omits Node's full module declarations.
import { createHash } from "node:crypto";
import { emojiIdentity, isEmojiKey, qualifyEmoji } from "./emoji";

/** The seeded, permanent top-level room. */
export const ROOM_ID = "general";
const ROOM_TITLE = "General";
/**
 * Schema 11 stores the server-wide log (room records, flat message
 * snapshots, reaction sets, and registered users' memberships), a
 * `memberships` table of registered users' joined rooms, indexed both ways,
 * with each room's count of them, the `uploads` held in R2 with each
 * identity's avatar, each identity's roles, `ext` and `seen` in its row, and
 * the `push_subscriptions`, `push_wakes`, `user_status`, `room_mutes` and
 * `read_cursors` tables, with each limiter row's token bucket (limiter.ts)
 * and each day's count of history pages (SCHEMA_DDL). Schemas 9, 8 and 7
 * are upgraded in place (see upgradeFromSchema9(), upgradeFromSchema8() and
 * upgradeFromSchema7()); stored data from any other schema version is not
 * migrated: the object is wiped and started fresh (see resetStorage()). An
 * absent `_meta` row reads as its initial value, so adding one needs no new
 * version. A schema 9 object from code before the identities' `seen_ms`
 * column gains it before its upgrade (ensureSeenColumn()); one from code
 * before `push_subscriptions_joined_idx` gains that with the rebuild.
 */
export const SCHEMA_VERSION = 11;
/** The oldest schema upgraded in place rather than reset; each one from it up to SCHEMA_VERSION is. */
export const UPGRADABLE_SCHEMA_VERSION = 7;
/**
 * The registered user `APRON_ADMIN_TOKEN` signs in as, always an admin. It
 * never holds a passkey, so deleting the token turns it off completely.
 */
export const ADMIN_USER_ID = "admin";
/** Passkeys one registered identity may hold (§4.10: a registration while signed in adds one). */
export const MAX_PASSKEYS_PER_USER = 8;
/** Rooms a new identity has joined: the permanent top-level room (§3.4). */
export const DEFAULT_JOINED_ROOMS: readonly string[] = [ROOM_ID];
/** Title the demo supplies for a thread room created or saved without one. */
const DEFAULT_THREAD_TITLE = "Thread";
/** Title the demo supplies for a top-level room created or saved without one. */
const DEFAULT_ROOM_TITLE = "Room";
/**
 * Prefix of a private room's `room_id` (§4.2.4): `private_<log id>`. A
 * private room is visible only to its members, who alone may add others;
 * nobody joins one by themselves. The ID is opaque to clients, which go by
 * the record's `private: true`; here it tells a private room apart without
 * a read, and keeps private rooms in a range of the rooms table's key that
 * the public scans never touch (PUBLIC_ROOMS).
 */
export const PRIVATE_ROOM_PREFIX = "private_";
/** Whether `roomId` names a private room (PRIVATE_ROOM_PREFIX). */
export function isPrivateRoomId(roomId: string): boolean {
  return roomId.startsWith(PRIVATE_ROOM_PREFIX);
}
/**
 * SQL conditions on `room_id` for the private rooms, one range of the key's
 * index, and the public ones, the ranges either side of it. A public scan
 * reads no private row, so it stays within the thread ceiling it was
 * calibrated for, and a private one within the private ceiling.
 */
const privateRange = (column: string) => `${column} >= 'private_' AND ${column} < 'private\`'`;
const PRIVATE_ROOMS = privateRange("room_id");
const PUBLIC_ROOMS = "(room_id < 'private_' OR room_id >= 'private`')";
/** Most rows the rooms table holds: `general`, the thread ceiling (created top-level rooms count against it), and the private rooms. */
const MAX_ROOM_ROWS = MAX_THREAD_LIMIT + 1 + MAX_PRIVATE_ROOM_LIMIT;
/** Most rooms one registered user can be in: every public room, and their share of private ones. */
const MAX_USER_ROOMS = MAX_THREAD_LIMIT + 1 + MAX_PRIVATE_MEMBERSHIPS_PER_USER;
/** The most members a private room may have for its members to see each other's read cursors (read receipts). */
export const MAX_READ_RECEIPT_MEMBERS = 10;
const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;
export const RETENTION_MS = DEFAULT_LIMITS.retentionSeconds * 1000;
const DEDUP_TTL_MS = DEFAULT_LIMITS.dedupTtlSeconds * 1000;
const MINUTE_MS = 60 * 1000;
/**
 * A limiter row's `updated_ms` moves only when a cached row is written
 * (limiter-cache.ts: every few charges), or another is a minute old or from
 * an earlier UTC day, so a busy principal rewrites its index entry rarely
 * rather than on every charge. Cleanup keeps rows touched within this long,
 * which must outlast any limiter's horizon (bucketHorizonMs) plus a minute.
 */
const LIMITER_IDLE_MS = 60 * MINUTE_MS;

type Tier = "anonymous" | "registered";

export { StoreError };

interface SqlCursorLike<T = Record<string, unknown>> {
  toArray?: () => T[];
  one?: () => T;
  raw?: () => unknown[];
  rowsRead?: number;
  rowsWritten?: number;
  [Symbol.iterator]?: () => Iterator<T>;
}

interface SqlStorageLike {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursorLike<T>;
}

interface DurableStorageLike {
  sql: SqlStorageLike;
  transactionSync?: <T>(closure: () => T) => T;
  setAlarm?: (time: number | Date) => Promise<void>;
  deleteAll?: () => Promise<void>;
  getAlarm?: () => Promise<number | null>;
}

interface DurableStateLike {
  storage: DurableStorageLike;
}

type DurableSqlStorageLike = DurableStorageLike;

interface StoreClock {
  now(): number;
}

export interface StoreConfig {
  retentionMs: number;
  dedupTtlMs: number;
  cleanupIntervalMs: number;
  cleanupBatch: number;
  maxSnapshotBytes: number;
  maxTextBytes: number;
  maxNameBytes: number;
  maxNameCodePoints: number;
  maxEmbeds: number;
  /** Thread rooms (rooms with a parent) that may exist at once. */
  maxThreads: number;
  /** Live thread rooms one registered user may have created (`creator_id`) at once. */
  maxThreadsPerUser: number;
  /** Serialized client fields of one room record. */
  maxThreadMetadataBytes: number;
  /** Private rooms (§4.2.4) that may exist at once, beside the threads. */
  maxPrivateRooms: number;
  /** Live private rooms one registered user may have created (`creator_id`) at once. */
  maxPrivateRoomsPerUser: number;
  /** Private rooms one registered user may be a member of at once. */
  maxPrivateMembershipsPerUser: number;
  reactionUsersPerMessage: number;
  reactionEmojisPerUser: number;
  maxHistoryLimit: number;
  historyDefaultLimit: number;
  maxHistoryResponseBytes: number;
  historyRequestsPerUserMinute: number;
  historyRequestsPerIpMinute: number;
  historyBurstPerUser: number;
  historyBurstPerIp: number;
  historyRequestsPerUserDay: number;
  historyRequestsPerIpDay: number;
  historyRequestsPerDay: number;
  anonymousPostsPerMinute: number;
  anonymousPostsPerDay: number;
  registeredPostsPerMinute: number;
  registeredPostsPerDay: number;
  /** A trusted user's posts (a registered user holding any role, which only an admin gives), in place of the registered limits; also their IP's allowance, when larger. */
  trustedPostsPerMinute: number;
  trustedPostsPerDay: number;
  ipPostsPerMinute: number;
  ipPostsPerDay: number;
  globalPostsPerMinute: number;
  globalPostsPerDay: number;
  registrationsPerIpDay: number;
  registrationsPerDay: number;
  registeredIdentityCount: number;
  authAttemptsPerIpMinute: number;
  framesPerIpMinute: number;
  processedFramesPerDay: number;
  connectionAdmissionsPerIpMinute: number;
  connectionAdmissionsPerDay: number;
  principalLimitCap: number;
  sqlReadsPerDay: number;
  sqlWritesPerDay: number;
  foregroundReadsPerDay: number;
  foregroundWritesPerDay: number;
  maintenanceReadsPerDay: number;
  maintenanceWritesPerDay: number;
  /** Occupied SQLite bytes at which foreground growth is suspended. */
  storageHighWaterBytes: number;
  /** Hard target including control data and cleanup headroom. */
  storageHardTargetBytes: number;
  /** Effective occupied bytes below which growth may resume. */
  storageLowWaterBytes: number;
  /** Optional operator switch. */
  admissionEnabled: boolean;
  /** Clears a persisted accounting stop once per value (recoverAccounting). */
  accountingRecovery?: string;
  /**
   * The hosts whose `og` media (`image`, `video`, `audio`) are kept
   * (`OG_MEDIA_HOSTS`): exact hosts, `*.host` for subdomains, or `"*"` for
   * any. Every viewer's client loads a kept URL, so only hosts whose access
   * logs a sender cannot read belong here; this server hosts and proxies no
   * media of its own (§4.8.1). Empty: none are kept.
   */
  ogMediaHosts: readonly string[] | "*";
  /**
   * How long a room's member rows may be reused (roomMembers); any write to
   * what they were read from ends it sooner. 0 or absent: never reused.
   */
  memberCacheMs?: number;
  /** Conservative row-cost estimate for one foreground mutation. */
  mutationCost: CostEstimate;
  /** Conservative row-cost estimate for one history read. */
  historyCost: CostEstimate;
  /** Conservative row-cost estimate for one auth attempt. */
  authCost: CostEstimate;
  /** Conservative row-cost estimate for one maintenance batch. */
  cleanupCost: CostEstimate;
  /**
   * Uploads (protocol §4.8.3), or null without them: the plan's policy and
   * the public origin its R2 objects are served from.
   */
  uploads: StoreUploadConfig | null;
  /** Web Push (protocol §4.9), or null without it: the plan's push policy. */
  push: PushPolicy | null;
  /**
   * Live text (protocol §4.8.3, `embed:terminal` and `embed:append`), or
   * null without it: the plan's policy, the origin live `url`s are served
   * from, and whether it is on while no admin toggled it.
   */
  liveText?: StoreLiveTextConfig | null;
}

export interface StoreLiveTextConfig extends LiveTextPolicy {
  /** This Worker's public origin, where a live text's `url` points; no trailing slash. */
  publicOrigin: string;
  /** On unless an admin turned it off with `/toggle livetext` (or on, when this is false). */
  enabled: boolean;
}

/**
 * A live text that is open (protocol §4.8.3): waiting for its `PUT`
 * (`pending`) or streaming (`live`). All of them are one `_meta` row
 * (META_LIVE_TEXTS), at most `concurrent` entries; the bytes themselves are
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
export interface LiveFinish {
  broadcasts: Broadcast[];
  /** The entry that ended, if it was still open. */
  entry?: LiveEntry;
}

interface StoreUploadConfig extends UploadPolicy {
  /** Where the bucket serves objects, such as `https://media.apron.chat`; no trailing slash. */
  mediaOrigin: string;
}

/** An upload waiting for its write (protocol §4.8.3): what its `write_url` signs. */
interface PendingUpload {
  /** The R2 object key: `f/<id>` for an attached file, `a/<id>` for an avatar, `e/<id>` for a custom emoji or the server's avatar. */
  key: string;
  purpose: UploadPurpose;
  embedId: string;
  maxBytes: number;
  writeExpiresMs: number;
}

/**
 * What an upload is for: an attached `file`, a user's `avatar`, a custom
 * `emoji`, or the server's own avatar (`server`, `/server avatar`).
 */
type UploadPurpose = "file" | "avatar" | "emoji" | "server";

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

/**
 * A new upload as a result lists it (§4.8.3), with `write` in place of the
 * `write_url` the runtime signs from it. Kept in the stored result, so a
 * retry signs the same URL.
 */
export function uploadResultEmbed(upload: PendingUpload): Record<string, unknown> {
  return {
    embed_id: upload.embedId,
    kind: "upload",
    write: { key: upload.key, max_bytes: upload.maxBytes, expires_ms: upload.writeExpiresMs },
  };
}

/**
 * A new live text as a result lists it (§4.8.3), with `write` in place of
 * the `write_url` the runtime signs from it, as for an upload.
 */
export function liveResultEmbed(entry: LiveEntry, policy: Pick<LiveTextPolicy, "maxInputBytes">): Record<string, unknown> {
  return {
    embed_id: entry.embedId,
    kind: entry.kind,
    write: { key: entry.key, max_bytes: liveInputLimit(entry, policy), expires_ms: entry.writeExpiresMs },
  };
}

/**
 * The most bytes a write may send: for an append, the bytes it keeps (its
 * `limit`), so edits never let it stream more than an append without them;
 * for a terminal, `maxInputBytes`.
 */
export function liveInputLimit(entry: Pick<LiveEntry, "kind" | "limit">, policy: Pick<LiveTextPolicy, "maxInputBytes">): number {
  return entry.kind === "append" ? Math.min(entry.limit, policy.maxInputBytes) : policy.maxInputBytes;
}

/**
 * When an open live text falls due: its `write_url`'s expiry while it
 * waits, and its time limit plus LIVE_ORPHAN_GRACE_MS while it streams.
 */
export function liveDeadline(entry: LiveEntry): number {
  return entry.state === "pending" ? entry.writeExpiresMs : (entry.startedMs ?? 0) + entry.maxMs + LIVE_ORPHAN_GRACE_MS;
}

/** Roles whose holders stream for `moderatorMaxSeconds` rather than `maxSeconds`. */
const LIVE_TEXT_LONG_ROLES: readonly string[] = ["admin", "mod"];

/** A live text's `url` (§4.8.5), which its embed carries once its write starts. */
function liveUrl(live: Pick<StoreLiveTextConfig, "publicOrigin">, entry: Pick<LiveEntry, "id">): string {
  return `${live.publicOrigin}/live/${entry.id}`;
}

/** What a terminal's `og` says it is, as it goes: waiting for its writer, live, then finished. */
const TERMINAL_DESCRIPTIONS = {
  waiting: "A terminal, waiting for its program's output.",
  live: "Live terminal output. Open it to watch.",
  finished: "Terminal output.",
} as const;

/**
 * A terminal embed's `og` (protocol §4.8.6): what it is, for a client that
 * doesn't render terminal embeds and shows it as the card its `og`
 * describes, which opens its `url`. Titled as the embed is.
 */
export function terminalOg(title: unknown, state: keyof typeof TERMINAL_DESCRIPTIONS): { title: string; description: string } {
  return { title: typeof title === "string" && title ? boundTitle(title) : "Terminal", description: TERMINAL_DESCRIPTIONS[state] };
}

/** At most this many code points of a terminal's title go in its `og` and the viewer's link. */
export const MAX_TERMINAL_TITLE = 200;

/** A terminal's title cut to `MAX_TERMINAL_TITLE` code points. */
export function boundTitle(title: string): string {
  return title.length <= MAX_TERMINAL_TITLE ? title : Array.from(title).slice(0, MAX_TERMINAL_TITLE).join("");
}

function isLiveEntry(value: unknown): value is LiveEntry {
  if (!isPlainObject(value)) return false;
  return typeof value.key === "string" && /^l\/[A-Za-z0-9_-]{22}$/.test(value.key) && typeof value.id === "string" &&
    (value.kind === "terminal" || value.kind === "append") && typeof value.owner === "string" && typeof value.ip === "string" &&
    (value.state === "pending" || value.state === "live") && Number.isSafeInteger(value.writeExpiresMs) &&
    Number.isSafeInteger(value.maxMs) && Number.isSafeInteger(value.limit) && typeof value.embedId === "string";
}

/** A snapshot without the server's finished terminal `output`s, for the client size policy. */
function withoutOutputs(snapshot: MessageSnapshot): MessageSnapshot {
  const embeds = snapshot.body?.embeds;
  if (!Array.isArray(embeds) || !embeds.some((embed) => isPlainObject(embed) && embed.output !== undefined)) return snapshot;
  return { ...snapshot, body: { ...snapshot.body, embeds: embeds.map((embed) => {
    if (!isPlainObject(embed) || embed.output === undefined) return embed;
    const { output: _output, ...rest } = embed;
    void _output;
    return rest;
  }) } };
}

/**
 * A finished terminal's `output` (§4.8.6): the kept bytes as text, cut
 * further with keep_last while their JSON passes
 * MAX_TERMINAL_OUTPUT_JSON_BYTES.
 */
function terminalOutput(bytes: Uint8Array): string {
  let kept = bytes;
  for (;;) {
    const text = liveTextString(kept);
    if (utf8Bytes(JSON.stringify(text)) <= MAX_TERMINAL_OUTPUT_JSON_BYTES) return text;
    kept = keepLast(kept, Math.floor(kept.length * 3 / 4));
  }
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

const DEFAULT_CONFIG: StoreConfig = {
  retentionMs: RETENTION_MS,
  dedupTtlMs: DEDUP_TTL_MS,
  cleanupIntervalMs: DEFAULT_LIMITS.cleanupSeconds * 1000,
  cleanupBatch: DEFAULT_LIMITS.cleanupBatch,
  maxSnapshotBytes: DEFAULT_LIMITS.maxSnapshotBytes,
  maxTextBytes: DEFAULT_LIMITS.maxTextBytes,
  maxNameBytes: DEFAULT_LIMITS.maxNameBytes,
  maxNameCodePoints: DEFAULT_LIMITS.maxNameCodePoints,
  maxEmbeds: DEFAULT_LIMITS.maxEmbeds,
  maxThreads: DEFAULT_LIMITS.threadLimit,
  maxThreadsPerUser: DEFAULT_LIMITS.threadsPerUser,
  maxThreadMetadataBytes: DEFAULT_LIMITS.threadMetadataBytes,
  maxPrivateRooms: DEFAULT_LIMITS.privateRoomLimit,
  maxPrivateRoomsPerUser: DEFAULT_LIMITS.privateRoomsPerUser,
  maxPrivateMembershipsPerUser: DEFAULT_LIMITS.privateMembershipsPerUser,
  reactionUsersPerMessage: DEFAULT_LIMITS.reactionUsersPerMessage,
  reactionEmojisPerUser: DEFAULT_LIMITS.reactionEmojisPerUser,
  maxHistoryLimit: DEFAULT_LIMITS.historyMaxLimit,
  historyDefaultLimit: DEFAULT_LIMITS.historyDefaultLimit,
  maxHistoryResponseBytes: DEFAULT_LIMITS.historyMaxResponseBytes,
  historyRequestsPerUserMinute: DEFAULT_LIMITS.historyRequestsPerUserMinute,
  historyRequestsPerIpMinute: DEFAULT_LIMITS.historyRequestsPerIpMinute,
  historyBurstPerUser: DEFAULT_LIMITS.historyBurstPerUser,
  historyBurstPerIp: DEFAULT_LIMITS.historyBurstPerIp,
  historyRequestsPerUserDay: DEFAULT_LIMITS.historyRequestsPerUserDay,
  historyRequestsPerIpDay: DEFAULT_LIMITS.historyRequestsPerIpDay,
  historyRequestsPerDay: DEFAULT_LIMITS.historyRequestsPerDay,
  anonymousPostsPerMinute: DEFAULT_LIMITS.anonymousPostsPerMinute,
  anonymousPostsPerDay: DEFAULT_LIMITS.anonymousPostsPerDay,
  registeredPostsPerMinute: DEFAULT_LIMITS.registeredPostsPerMinute,
  registeredPostsPerDay: DEFAULT_LIMITS.registeredPostsPerDay,
  trustedPostsPerMinute: DEFAULT_LIMITS.trustedPostsPerMinute,
  trustedPostsPerDay: DEFAULT_LIMITS.trustedPostsPerDay,
  ipPostsPerMinute: DEFAULT_LIMITS.ipPostsPerMinute,
  ipPostsPerDay: DEFAULT_LIMITS.ipPostsPerDay,
  globalPostsPerMinute: DEFAULT_LIMITS.globalPostsPerMinute,
  globalPostsPerDay: DEFAULT_LIMITS.globalPostsPerDay,
  registrationsPerIpDay: DEFAULT_LIMITS.registrationsPerIpDay,
  registrationsPerDay: DEFAULT_LIMITS.registrationsPerDay,
  registeredIdentityCount: DEFAULT_LIMITS.registeredIdentityCount,
  authAttemptsPerIpMinute: DEFAULT_LIMITS.authAttemptsPerIpMinute,
  framesPerIpMinute: DEFAULT_LIMITS.framesPerIpMinute,
  processedFramesPerDay: DEFAULT_LIMITS.processedFramesPerDay,
  connectionAdmissionsPerIpMinute: DEFAULT_LIMITS.connectionAdmissionsPerIpMinute,
  connectionAdmissionsPerDay: DEFAULT_LIMITS.connectionAdmissionsPerDay,
  principalLimitCap: DEFAULT_LIMITS.limiterRecordCap,
  sqlReadsPerDay: DEFAULT_LIMITS.sqlReadsPerDay,
  sqlWritesPerDay: DEFAULT_LIMITS.sqlWritesPerDay,
  foregroundReadsPerDay: DEFAULT_LIMITS.foregroundReadsPerDay,
  foregroundWritesPerDay: DEFAULT_LIMITS.foregroundWritesPerDay,
  maintenanceReadsPerDay: DEFAULT_LIMITS.maintenanceReadsPerDay,
  maintenanceWritesPerDay: DEFAULT_LIMITS.maintenanceWritesPerDay,
  storageHighWaterBytes: DEFAULT_LIMITS.databaseHighWaterBytes,
  storageHardTargetBytes: DEFAULT_LIMITS.databaseHardTargetBytes,
  storageLowWaterBytes: DEFAULT_LIMITS.databaseResumeLowWaterBytes,
  admissionEnabled: true,
  ogMediaHosts: [],
  uploads: null,
  push: null,
  // These bounds include the reservation row and worst-case indexed control
  // updates for one accepted operation; calibrated workloads may lower them
  // only after observing cursor counts.
  mutationCost: { reads: 64, writes: 64, posts: 1 },
  historyCost: { reads: 64 },
  authCost: { reads: 24, writes: 8, frames: 1 },
  // A batch also scans the private range for expired rooms, twice, at up to
  // two reads a row (its key's index entry and the row).
  cleanupCost: { reads: 1024 + 4 * MAX_PRIVATE_ROOM_LIMIT, writes: 1024 },
};

export function defaultStoreConfig(overrides: Partial<StoreConfig> = {}): StoreConfig {
  const merged = { ...DEFAULT_CONFIG, ...overrides };
  if (merged.retentionMs <= 0 || merged.dedupTtlMs <= 0) {
    throw new Error("retention and dedup TTL must be positive");
  }
  if (merged.maxSnapshotBytes <= 0 || merged.maxTextBytes <= 0) {
    throw new Error("snapshot and text limits must be positive");
  }
  if (merged.historyDefaultLimit <= 0 || merged.maxHistoryLimit < merged.historyDefaultLimit) {
    throw new Error("history limits are inconsistent");
  }
  // A limiter row idle for LIMITER_IDLE_MS is removed, so no limiter may still matter by then.
  const rates: Rate[] = [
    { perMinute: merged.historyRequestsPerUserMinute, burst: merged.historyBurstPerUser },
    { perMinute: merged.historyRequestsPerIpMinute, burst: merged.historyBurstPerIp },
  ];
  if (rates.some((rate) => !(rate.perMinute > 0) || !((rate.burst ?? 0) >= 1) || bucketHorizonMs(rate) > LIMITER_IDLE_MS - MINUTE_MS)) {
    throw new Error("history bursts must be at least one request and spent within the limiter idle time");
  }
  if (merged.storageLowWaterBytes >= merged.storageHighWaterBytes ||
      merged.storageHighWaterBytes >= merged.storageHardTargetBytes) {
    throw new Error("storage watermarks are inconsistent");
  }
  if (merged.foregroundReadsPerDay > merged.sqlReadsPerDay ||
      merged.maintenanceReadsPerDay > merged.sqlReadsPerDay ||
      merged.foregroundWritesPerDay > merged.sqlWritesPerDay ||
      merged.maintenanceWritesPerDay > merged.sqlWritesPerDay) {
    throw new Error("foreground/maintenance budgets exceed daily ceilings");
  }
  if (merged.maintenanceReadsPerDay <= MAINTENANCE_CONTROL_READS ||
      merged.maintenanceWritesPerDay <= MAINTENANCE_CONTROL_WRITES) {
    throw new Error("maintenance budgets must leave control reserve");
  }
  if (merged.cleanupBatch <= 0 || merged.cleanupBatch > 100) {
    throw new Error("cleanup batch must be between 1 and 100");
  }
  return merged;
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

/** One logged reaction change (protocol §4.7). */
interface ReactionsRecord {
  log_id: string;
  message_id: string;
  room_id: string;
  reactions: Array<{ from: Identity; emojis: string[] }>;
}

/** The `creator_id` kept in a room row's `fields_json`, if any (Store.roomCreator). */
function storedCreator(fieldsJson: string): string | undefined {
  const creator = parseJson<{ creator_id?: unknown }>(fieldsJson, {}).creator_id;
  return typeof creator === "string" ? creator : undefined;
}

/** One logged membership change of a registered user (protocol §4.2.2). */
interface MembershipRecord {
  log_id: string;
  room_id: string;
  members: Array<{ user: Identity; joined: boolean }>;
}

type RecordKind = "room" | "message" | "reactions" | "membership";

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

type MutationMethod = "message" | "room_set" | "reactions" | "me";

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

/** Embed kinds that carry live text (§4.8.3). */
const LIVE_KINDS: ReadonlySet<string> = new Set(["terminal", "append"]);
/** `_meta` key: the open live texts, a JSON array of LiveEntry, absent while there are none. */
const META_LIVE_TEXTS = "live_texts";
/**
 * How long past its time limit a text marked `live` may stay open before the
 * alarm ends it as lost: the object that streamed it was evicted or
 * redeployed, so its bytes are gone (finishLiveText with nothing kept).
 */
export const LIVE_ORPHAN_GRACE_MS = 30_000;
/**
 * The largest finished terminal `output`, in bytes of JSON: a control
 * character escapes to six (`\u001b`), so the kept bytes are cut further when
 * escaping would pass it, and one record always fits a history response.
 */
export const MAX_TERMINAL_OUTPUT_JSON_BYTES = 128 * 1024;
/** Rows one live text's bookkeeping may write: the `_meta` row, three limiter rows and their counter. */
const LIVE_WRITES = 16;

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
  /** For `me`: the user's `ext` after the write, and the keys it changed (§4.12). */
  profile?: { ext?: Record<string, unknown>; changed?: Record<string, unknown> };
}

interface StoreHistoryQuery {
  /** One room's log (§4.3.1); omitted, the log of `roomIds`. */
  roomId?: string;
  /**
   * Without `roomId`, the log of these rooms together (§4.3): the rooms whose
   * deliveries the requesting connection receives. Unknown ones, and private
   * ones the requester is not in, are left out. Omitted, the default room.
   */
  roomIds?: readonly string[];
  after?: string | bigint;
  before?: string | bigint;
  limit?: number;
  now?: number;
  /** Request identity for history quota accounting. */
  userId?: string;
  ipKey?: string;
  maxBytes?: number;
}

/** A history page (§4.3): each array is omitted when empty, and the bounds with it. */
interface StoreHistoryResult {
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

interface StoreCleanupResult {
  /** The internal server-wide retention floor F after this run. */
  history_floor: string;
  /** F before this run; rooms' history_log_id changed when these differ. */
  previous_floor: string;
  /** The server-wide log head. */
  latest_id: string;
  deleted_records: number;
  deleted_messages: number;
  deleted_reactions: number;
  /** Membership rows of removed thread rooms purged by this run. */
  deleted_memberships: number;
  deleted_requests: number;
  deleted_limiters: number;
  /** Thread rooms whose entire log expired; announce them as removed. */
  removed_rooms: string[];
  next_due_ms: number;
  did_work: boolean;
}

interface RawLogState {
  last_log_id: number;
  history_floor: number;
  last_commit_ms: number;
}

interface RawRoomRow {
  room_id: string;
  parent_room_id: string | null;
  created_log_id: number;
  record_log_id: number;
  latest_log_id: number;
  fields_json: string;
  created_ms: number;
  updated_ms: number;
  /** Registered members stored in `memberships`; guests' live in their connections. */
  member_count: number;
}

interface RawRecordRow {
  room_id: string;
  log_id: number;
  kind: string;
  record_json: string;
}

interface RawMessageRow {
  message_id: string;
  room_id: string;
  latest_log_id: number;
  snapshot_json: string;
  author_id: string;
}

interface RawReactionRow {
  message_id: string;
  user_id: string;
  log_id: number;
  from_json: string;
  emojis_json: string;
}

/** Allocation and room bookkeeping for one committed operation. */
interface CommitContext {
  state: RawLogState;
  commitMs: number;
  /** Greatest log_id appended to each existing room during this commit. */
  touched: Map<string, number>;
  /** Registered members each room gained (or, negative, lost) in this commit's memberships. */
  members?: Map<string, number>;
  /** Posts this commit costs past the one every mutation is charged: a move's re-logged reaction sets (MOVE_REACTION_SETS_PER_POST). */
  extraPosts?: number;
}

/**
 * A move re-logs the moved message's reaction sets and rewrites each one's
 * state row, about 4 written rows a set, so moving a message with many
 * reactors costs several posts' worth of writes. Each this many sets add
 * one post to the move's charge: a message with fewer reactors moves for one
 * post, and the most reacted-to (32 sets) for five.
 */
export const MOVE_REACTION_SETS_PER_POST = 8;

const ROOM_COLUMNS = "room_id, parent_room_id, created_log_id, record_log_id, latest_log_id, fields_json, created_ms, updated_ms, member_count";

interface RawDedupRow {
  user_id: string;
  request_id: string;
  digest: string;
  result_json: string;
  transition_json: string | null;
  expires_ms: number;
}

interface RawCredentialRow {
  credential_id: string;
  user_id: string;
  public_key_json: string;
  sign_count: number;
  transports_json: string | null;
  created_ms: number;
  updated_ms: number;
}

/** A passkey a schema reset carries over, with its identity (see readCarriedPasskeys). */
interface CarriedPasskey extends RawCredentialRow {
  user_handle: string;
  name: string;
  tier: string;
  identity_created_ms: number;
  identity_updated_ms: number;
  in_general: number;
  roles_json: string;
}

interface RawIdentityRow {
  user_id: string;
  user_handle: string;
  name: string;
  tier: string;
  created_ms: number;
  updated_ms: number;
  avatar_url: string;
  avatar_expires_ms: number;
  roles_json: string;
  ext_json: string;
  seen_ms: number;
}

interface RawUploadRow {
  upload_key: string;
  owner_id: string;
  purpose: UploadPurpose;
  message_id: string | null;
  embed_id: string | null;
  /**
   * `pending` until the Worker claims the write, `writing` while it stores
   * it, then `done`. A custom emoji's image that a catalog change replaced
   * or removed is `superseded`: kept, with its bytes, while the previous
   * catalog refers to it (commitEmoji).
   */
  state: "pending" | "writing" | "done" | "superseded";
  bytes: number;
  write_expires_ms: number;
  expires_ms: number;
}

/** A limiter row's token bucket (limiter.ts). */
function bucketOf(row: RawLimitRow): Bucket {
  return { level: Number(row.level) || 0, at: integerColumn(row.level_ms) };
}

function bucketRow(bucket: Bucket): Pick<RawLimitRow, "level" | "level_ms"> {
  return { level: bucket.level, level_ms: bucket.at };
}

interface RawMaintenanceRow {
  id: number;
  next_cleanup_ms: number;
  cleanup_cutoff_ms: number | null;
  cleanup_cursor: number | null;
  schema_version: number;
}

const META_EFFECTIVE_NOW = "effective_now_ms";
/**
 * Removed thread rooms whose membership rows cleanup has yet to purge, as a
 * JSON array. A room leaves the `rooms` table at once and its members are
 * purged in bounded batches; membership reads join `rooms`, so they never
 * see a purged room's rows.
 */
const META_PURGE_ROOMS = "purge_rooms";
/** Most removed rooms awaiting purge; cleanup removes no further room past it. */
const MAX_PURGE_ROOMS = MAX_THREAD_LIMIT;
/**
 * Reads for privateRoomCounts(): the private range of the rooms table for
 * the creator's live rooms, an index entry and a row each, and the
 * creator's membership rows, live and awaiting purge, with a room lookup each.
 */
const PRIVATE_ROOM_COUNT_READS = 16 + 2 * MAX_PRIVATE_ROOM_LIMIT + 2 * (MAX_USER_ROOMS + MAX_PURGE_ROOMS);
/**
 * Most retained records a budget-checked log scan (`/rename`) reserves for:
 * above a week of the paid plan's posts, and a small share of the day's
 * foreground reads. Counting reads one index entry per record, refunded past
 * what is found.
 */
const RETAINED_SCAN_CAP = 100_000;
const META_ACCOUNTING_UNSAFE = "accounting_unsafe";
/** The last `accountingRecovery` value that cleared the stop, so each clears it once. */
const META_ACCOUNTING_RECOVERY = "accounting_recovery";
/** The accounting marker's value after a storage failure (markAccountingUnsafe), cleared without an operator. */
const ACCOUNTING_UNCERTAIN = "uncertain";
/** `data.reason` of the internal errors closed accounting raises (assertAccounting), which the socket layer words for people. */
export const ACCOUNTING_OVERRUN = "accounting_overrun";
export const STORAGE_UNAVAILABLE = "storage_unavailable";
const META_ACCOUNT_USAGE = "account_usage_snapshot";
/** The highest guest number ever reserved (see reserveGuestNumbers); absent means none. */
const META_GUEST_NUMBER_MARK = "guest_number_mark";
/**
 * Most passkeys a schema reset carries over (see resetStorage), most recently
 * used first; any beyond it are dropped with the rest of the object. It bounds
 * the reset's uncharged-for-capacity SQL work to a small share of a day's
 * writes, and so the identities that can survive a wipe.
 */
export const MAX_CARRIED_PASSKEYS = 100;
/**
 * Moderator roles. A registered user holding one may move other users'
 * messages (§4.4): a `message` save of someone else's message that changes
 * only its `room_id`, such as into a thread or back out to its parent room.
 * `threader` grants that alone, for someone who tidies conversations into
 * threads; creating threads and saving any thread's title and description
 * are open to every participant already (commitRoom). Their posts count
 * against the trusted posting limits, not the registered ones
 * (chargePosting), since a move is one post per message.
 */
export const MODERATOR_ROLES: readonly string[] = ["admin", "mod", "threader"];
/**
 * Roles whose registered holders may create top-level rooms beside
 * `general`, and save their client fields (§4.2.4); only `admin` may save
 * `general`'s. Such rooms are
 * permanent, as `general` is: they neither expire nor go when emptied.
 */
export const ROOM_CREATOR_ROLES: readonly string[] = ["admin", "mod"];
/**
 * Most top-level rooms created besides `general`. They also count against
 * the thread ceiling (`maxThreads`), which bounds the rooms table, and,
 * being permanent, this keeps them from taking all of its slots.
 */
export const MAX_CREATED_ROOMS = 16;
/** Most roles one user holds, so the column stays small. */
export const MAX_ROLES_PER_USER = 8;
/**
 * Largest serialized `ext` a user keeps (protocol §4.12), after a write's
 * merge: room for an extension's few fields, such as a bridge's nick or a
 * time zone. Every connection of the user carries it in its attachment, and
 * every listing that shows the user carries it in `users`.
 */
export const MAX_USER_EXT_BYTES = 512;
/** A role name: lowercase letters, digits, `_` or `-`, starting with a letter. */
export const ROLE_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;

/** An identity row's `roles_json`, keeping only well-formed role names. */
function parseRoles(json: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(json ?? "", []);
  if (!Array.isArray(parsed)) return [];
  const roles: string[] = [];
  for (const role of parsed) {
    if (typeof role === "string" && ROLE_PATTERN.test(role) && !roles.includes(role) && roles.length < MAX_ROLES_PER_USER) roles.push(role);
  }
  return roles;
}

/**
 * `_meta` key prefix recording a `/rename`: `renamed:<old user_id>` holds the
 * new one, so the retired `user_id` is never reissued (protocol §3.3).
 */
const META_RENAMED_PREFIX = "renamed:";
/**
 * `_meta` key prefix recording a `/purge`: `purged:<user_id>` retires the
 * id, never reissued, so a passkey session still held for it (sessions are
 * found by token, not by user) can never sign in as a later user given it.
 */
const META_PURGED_PREFIX = "purged:";
/** `_meta` key: when the daily idle bot sweep (idleBots) is next due. */
const META_BOT_SWEEP = "bot_sweep_ms";

/** The limiter scopes keyed by a registered user (`user:<user_id>`), which `/rename` moves. */
const USER_LIMIT_SCOPES = ["post", "history", "upload", "push", "push_recipient", "push_joined_recipient"] as const;
/**
 * `_meta` key prefix for an admin's `/toggle`: `toggle:<feature>` holds `on`
 * or `off`, and is absent while the feature follows the deployment's default.
 */
const META_TOGGLE_PREFIX = "toggle:";
/**
 * `_meta` key: when an admin last turned presence on with `/toggle`
 * (epoch milliseconds), when the status others see of every user changed
 * from `""` and so, for each user then shown `offline`, when that began
 * (protocol §4.5.2 `seen`; see ApronDemoServer.seenFloor). Written once per
 * toggle; code before it ignores the row.
 */
const META_PRESENCE_ON = "presence_on_ms";
/** Bytes all live uploads hold, pending writes at their largest (see startUpload). */
const META_UPLOAD_BYTES = "upload_bytes";
/**
 * `_meta` key: the custom emoji catalog (extension `ext:emoji`), the JSON
 * object exactly as published, absent while it is empty. Its R2 key, and
 * so `catalog_url`, is `e/c/<SHA-256 of the JSON>.json` (emojiObjectKey).
 */
const META_EMOJI_CATALOG = "emoji_catalog";
/**
 * `_meta` key: the R2 key of the catalog the current one replaced, kept so
 * that clients that just read the old `catalog_url` can still fetch it, and
 * deleted at the next change. The images only it refers to are kept as long
 * (upload state `superseded`).
 */
const META_EMOJI_PREVIOUS = "emoji_catalog_previous";
/**
 * The owner of custom emoji uploads: the server, not the admin who added
 * one, so `/purge` and `/rename` of that admin leave the catalog alone. No
 * user can hold an id starting with `~`.
 */
const EMOJI_OWNER = "~emoji";
/**
 * The owner of the server's avatar upload (`/server avatar`), for the same
 * reason: it stays across `/purge` and `/rename` of the admin who set it.
 */
const SERVER_OWNER = "~server";
/**
 * `_meta` key prefix for the server's `title`, `description` and `avatar`
 * (§3.1) as admins set them with `/server`: `server:<field>` holds the value
 * (the avatar's URL on the media origin), absent while the deployment
 * variable applies. Code before it ignores the rows.
 */
const META_SERVER_PREFIX = "server:";
const SERVER_FIELDS = ["title", "description", "avatar"] as const;

/** The R2 key a catalog's JSON is published at: named by its SHA-256, so a new catalog has a new `catalog_url`. */
function emojiObjectKey(json: string): string {
  return `e/c/${createHash("sha256").update(json).digest("hex")}.json`;
}
/**
 * How long past its write window a pending upload may still finish: the write
 * started in time and is still arriving. Expiry waits this long too.
 */
export const UPLOAD_WRITE_GRACE_MS = 60_000;
/** Pending uploads or expired upload rows one maintenance pass handles. */
export const UPLOAD_SWEEP_BATCH = 32;
/** Rows one upload's bookkeeping may write: its row and indexes, two limiter rows, and the byte count. */
const UPLOAD_WRITES = 16;
/**
 * Most push subscriptions one user can hold under any valid policy: a
 * policy's `subscriptionsPerUser` is at most MAX_PUSHES_PER_MESSAGE, and
 * each registration evicts down to the policy in force. Reservations that
 * touch a user's subscriptions are sized by it.
 */
const MAX_PUSH_SUBSCRIPTIONS_PER_USER = MAX_PUSHES_PER_MESSAGE;
/** The tables a member listing reads (Store.roomMembers); a write to one invalidates reused listings. */
const MEMBER_TABLES = /\b(identities|memberships|user_status)\b/;
/** Store.ensureSeenColumn's probe: reads no row, and fails to compile where `seen_ms` is missing. */
const SEEN_COLUMN_PROBE = "SELECT seen_ms FROM identities LIMIT 0";
/**
 * Most `push_wakes` rows one user can hold: one per room they were woken
 * for, and wakes come only for messages in existing rooms (at most the
 * thread ceiling and `general`); rows of rooms removed since cleanup last
 * ran, at most the purge list, wait for it.
 */
const MAX_PUSH_WAKES_PER_USER = MAX_USER_ROOMS + MAX_PURGE_ROOMS;
/**
 * Where a user's `unread` (protocol §4.9.3) is kept: the `uploads_day` of
 * their `push_recipient` counter, which every push claimed for them reads
 * and writes anyway, so counting costs a claim no row. It counts the
 * pushes claimed for them since they were last back (Store.clearPushUnread):
 * each for a message from someone else that came while nobody attended them,
 * so it never counts more messages than they have not seen, and is often
 * fewer: a message coalesced away, or pushed for `joined` alone, counts
 * none, and held wakes released together count one. Only the current UTC
 * day's count stands, as with the counter's own (cleanup deletes the row
 * after it).
 */
const PUSH_UNREAD_SCOPE = "push_recipient";
/**
 * Longest push endpoint URL kept (protocol §4.9). Browsers' are a few
 * hundred bytes; a tighter bound keeps each row small, so sybil accounts
 * cannot fill storage with registrations.
 */
export const MAX_PUSH_URL_BYTES = 512;
/** A re-registration of an unchanged subscription younger than this writes nothing. */
const PUSH_REFRESH_MS = 86_400_000;

/** A registration's `push_id` (protocol §4.9): 1 to 64 letters, digits, `_` or `-`. */
export const PUSH_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The wake scopes this server implements (protocol §4.9), each a bit of a
 * registration's `wake` column: `mentions` (messages whose `mentions` list
 * the user), `replies` (replies to the user's messages), `private`
 * (messages in the private rooms the user is in; they have no threads) and
 * `joined` (messages in the rooms the user joined, and their threads; for
 * JOINED_WAKE_ROLES only).
 */
export const WAKE_SCOPES = { mentions: 1, replies: 2, private: 4, joined: 8 } as const;
/** `mentions` and `replies`, the default for a registration without `wake` (§4.9.4). */
const DEFAULT_WAKE = WAKE_SCOPES.mentions | WAKE_SCOPES.replies;
/** Every scope: a registration's `wake` names some of these. */
const ALL_WAKE = WAKE_SCOPES.mentions | WAKE_SCOPES.replies | WAKE_SCOPES.private | WAKE_SCOPES.joined;
/**
 * The roles that may wake for `joined` (§4.9.4), every message in a room
 * they joined: a registered user holding one keeps the scope when they
 * register, and only they are woken for it. Others' registrations drop it,
 * so the few who keep it are all a message's `joined` wake reads.
 */
export const JOINED_WAKE_ROLES: readonly string[] = ["admin", "mod"];
/**
 * The roles whose registered holders may add, replace and remove custom
 * emoji with `/emoji` (extension `ext:emoji`). Their images are the
 * server's (EMOJI_OWNER), so they stay when the user who added them is
 * purged or renamed.
 */
export const EMOJI_ROLES: readonly string[] = ["admin", "mod", "friend"];
/** Registrations that keep `joined`, the partial index's condition (push_subscriptions_joined_idx), spelled once so every query matches it. */
const JOINED_WAKE_CONDITION = `(wake & ${WAKE_SCOPES.joined}) != 0`;

/** A `user_status` or `room_mutes` row's `mute_until_ms` for a mute that lasts until changed (`mute: true`). */
export const MUTE_FOREVER = Number.MAX_SAFE_INTEGER;
/** The longest timed mute: a year; longer ones are cut to it. */
export const MAX_MUTE_SECONDS = 365 * 86_400;
/**
 * Most room mutes one user keeps (protocol §4.5 `status` with `room_id`):
 * past it, a mute of another room is declined. It bounds what a sign-in
 * reads to tell the mutes in effect, and what a wake claim's probes can find.
 */
export const MAX_ROOM_MUTES_PER_USER = 100;

/** One of a user's room mutes: the room, and until when (MUTE_FOREVER for `true`). */
interface RoomMute {
  roomId: string;
  untilMs: number;
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

/**
 * A registered room member as listings carry it, with the `status` they
 * chose and their `seen` (absent when none is recorded) when asked for.
 */
interface RoomMember {
  user_id: string;
  name: string;
  avatar?: string;
  roles: string[];
  ext?: Record<string, unknown>;
  choice?: StatusChoice;
  seen?: number;
}

/** One `roomMembers` row, with the chosen status and `seen` when asked for. */
interface RawMemberRow {
  user_id: string;
  name: string | null;
  avatar_url: string | null;
  avatar_expires_ms: number | null;
  roles_json: string | null;
  ext_json: string | null;
  status?: string | null;
  seen_ms?: number | null;
}

/** A member row's chosen status and `seen`, as RoomMember carries them. */
function statusColumns(row: RawMemberRow): Pick<RoomMember, "choice" | "seen"> {
  const seen = seenColumn(row.seen_ms);
  return { choice: choiceColumn(row.status), ...(seen !== undefined ? { seen } : {}) };
}

/** Refuses a `seen` that is not positive epoch milliseconds. */
function assertSeen(seen: number): void {
  if (!Number.isSafeInteger(seen) || seen <= 0) throw new StoreError("invalid_params", "invalid seen");
}

/**
 * Whether a stored `seen` (protocol §4.5.2) stands for a change to `offline`
 * at `at`: it is no more than SEEN_WRITE_GRANULARITY_MS before it (and not
 * after it), so it is carried again rather than written.
 */
export function seenStands(stored: number | undefined, at: number): boolean {
  return stored !== undefined && stored > 0 && stored <= at && at - stored <= SEEN_WRITE_GRANULARITY_MS;
}

/** A stored `seen_ms` as epoch milliseconds, or undefined for none (0). */
function seenColumn(value: unknown): number | undefined {
  const seen = integerColumn(value);
  return seen > 0 ? seen : undefined;
}

/** A stored `status` choice: `online` when there is no row, and `""` for a value this server no longer knows. */
function choiceColumn(value: unknown): StatusChoice {
  if (value === null || value === undefined) return "online";
  return isStatusChoice(value) ? value : "";
}

/** A room mute's stored end as `status` `mute` carries it (§4.5): `true`, else the seconds left, rounded up. */
export function muteValue(untilMs: number, effective: number): number | true {
  return untilMs >= MUTE_FOREVER ? true : Math.max(1, Math.ceil((untilMs - effective) / 1_000));
}

/** When the first of `mutes` that is timed runs out, as `{next}`, or `{}` when none is. */
export function nextRoomMuteEnd(mutes: readonly RoomMute[]): { next?: number } {
  const timed = mutes.filter((mute) => mute.untilMs < MUTE_FOREVER).map((mute) => mute.untilMs);
  return timed.length ? { next: Math.min(...timed) } : {};
}

/** A room's member rows as read, kept for reuse (Store.roomMembers). */
interface MemberCacheEntry {
  at: number;
  generation: number;
  perRoom: number;
  withStatus: boolean;
  rows: RawMemberRow[];
  /** Whether `count` was read for a full page (asked for with `counts`). */
  counted: boolean;
  count?: number;
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

type RawPushRow = { url: string; p256dh: string; auth: string; push_id: string | null; wake: number };

function pushRecord(row: RawPushRow, userId: string): PushSubscriptionRecord {
  return { url: row.url, userId, p256dh: row.p256dh, auth: row.auth, ...(row.push_id !== null ? { pushId: row.push_id } : {}) };
}

/**
 * A registration a wake claimed, with the scopes it is pushed for: what it
 * wakes for among why its user qualified, and its user's `unread` count
 * (protocol §4.9.3) when the push carries one.
 */
export type ClaimedPush = PushSubscriptionRecord & { reasons: number; unread?: number };

/** What a message's wake claimed (Store.claimPushes). */
interface PushClaim {
  subscriptions: ClaimedPush[];
  /** Subscriptions left out by the daily server or sender allowance. */
  skipped: number;
}

/** Rows one guest-number block reservation may read and write, before control overhead. */
const GUEST_NUMBER_BLOCK_COST = { reads: 8, writes: 8 } as const;

function numericId(value: string, field = "id"): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new StoreError("invalid_params", `${field} must be a decimal string`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || String(number) !== value.replace(/^0+(?=\d)/, "")) {
    throw new StoreError("invalid_params", `${field} is outside the supported range`);
  }
  return number;
}

function numericBigInt(value: bigint, field = "id"): string {
  if (typeof value !== "bigint" || value < 0n || value > BigInt(MAX_SAFE_ID)) {
    throw new StoreError("invalid_params", `${field} is outside the supported range`);
  }
  return value.toString();
}

function idString(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_ID) {
    throw new StoreError("internal_error", "identifier range exhausted");
  }
  return String(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseJson<T>(value: string, fallback?: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    if (fallback !== undefined) return fallback;
    throw new StoreError("internal_error", "corrupt persisted JSON");
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** An empty value (`""`, `[]`, `{}`), which clears a key in a merge (protocol §3.3, §4.12). */
function emptyValue(value: unknown): boolean {
  return value === "" || (Array.isArray(value) && value.length === 0) || (isPlainObject(value) && Object.keys(value).length === 0);
}

/**
 * Merges a write's `ext` into the stored one, one level deep (protocol §4.12):
 * each key the write carries replaces the stored value whole, a key whose
 * value is empty (`""`, `[]`, `{}`) is removed, and keys it leaves out stay.
 * `null` is an ordinary value. Without a write, or with `{}`, the stored
 * `ext` is unchanged. Undefined when nothing is left. Built from entries, so
 * a `"__proto__"` key is an ordinary own key, never a prototype.
 */
export function mergeExt(stored: unknown, write: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const merged = new Map<string, unknown>(isPlainObject(stored) ? Object.entries(stored) : []);
  for (const [key, value] of Object.entries(write ?? {})) {
    if (emptyValue(value)) merged.delete(key);
    else merged.set(key, value);
  }
  return merged.size ? clone(Object.fromEntries(merged)) : undefined;
}

/**
 * The keys of a user's `ext` that a write changed (protocol §4.12), as a
 * `user` notification carries them: each new or replaced value, and `""`
 * for each key it cleared. Undefined when nothing changed.
 */
function changedExt(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const changed = new Map<string, unknown>();
  for (const [key, value] of Object.entries(after ?? {})) {
    if (!before || !Object.hasOwn(before, key) || canonicalize(before[key]) !== canonicalize(value)) changed.set(key, value);
  }
  for (const key of Object.keys(before ?? {})) if (!after || !Object.hasOwn(after, key)) changed.set(key, "");
  return changed.size ? Object.fromEntries(changed) : undefined;
}

/**
 * Keys of a user's `ext` that the server owns: `permissions` (extension
 * `ext:permissions`), which only the user's own `you` carries. A `me` write
 * of one is ignored, like `roles`, and one stored before is never read.
 */
const SERVER_USER_EXT_KEYS: readonly string[] = ["permissions"];

/** A user's `ext` without the keys the server owns (SERVER_USER_EXT_KEYS), or undefined when nothing is left. */
export function clientUserExt(ext: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!ext || !SERVER_USER_EXT_KEYS.some((key) => Object.hasOwn(ext, key))) return ext;
  const kept = Object.fromEntries(Object.entries(ext).filter(([key]) => !SERVER_USER_EXT_KEYS.includes(key)));
  return Object.keys(kept).length ? kept : undefined;
}

/** An identity row's `ext_json`: its object without server-owned keys, or undefined when empty or unreadable. */
function parseUserExt(json: string | null | undefined): Record<string, unknown> | undefined {
  if (!json) return undefined;
  const parsed = parseJson<unknown>(json, null);
  return isPlainObject(parsed) && Object.keys(parsed).length ? clientUserExt(parsed) : undefined;
}

/** Whether a user's merged `ext` fits MAX_USER_EXT_BYTES. */
export function userExtFits(ext: Record<string, unknown> | undefined): boolean {
  return ext === undefined || utf8Bytes(JSON.stringify(ext)) <= MAX_USER_EXT_BYTES;
}

function dayFor(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Uncharged maintenance work's addition to a day's budget row. */
function maintenanceDelta(cost: { reads: number; writes: number }): BudgetDelta {
  return { reads_reserved: cost.reads, writes_reserved: cost.writes, maintenance_reads: cost.reads, maintenance_writes: cost.writes };
}

/**
 * How many pages of the log a history page of several rooms scans by log_id
 * before it reads each room's slice instead (Store.historyPageInternal).
 */
const HISTORY_SCAN_PAGES = 4;

function positiveLimit(value: number | undefined, defaultValue: number, max: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value <= 0) {
    throw new StoreError("invalid_params", "limit must be a positive integer");
  }
  return Math.min(value, max);
}

function jsonObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StoreError("invalid_params", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Canonical JSON used by mutation deduplication.  Object keys are sorted at
 * every level, arrays retain order, and JSON types remain distinct.  Callers
 * pass only method and params: other envelope keys are not the operation.
 */
function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StoreError("invalid_params", "non-finite JSON number");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(String(value));
  if (typeof value === "undefined") return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
  }
  throw new StoreError("invalid_params", "unsupported value in request");
}


/** A snapshot's content, which only its author changes: what a save keeps besides `room_id` and the server's links. */
function messageContent(snapshot: MessageSnapshot): Record<string, unknown> {
  return { body: snapshot.body, reply_to: snapshot.reply_to, deleted: snapshot.deleted === true, ext: snapshot.ext };
}

function digestOperation(method: string, params: unknown): string {
  return createHash("sha256").update(canonicalize({ method, params }), "utf8").digest("hex");
}

function cursorRows<T>(cursor: SqlCursorLike<T>): T[] {
  if (typeof cursor.toArray === "function") return cursor.toArray();
  if (typeof cursor[Symbol.iterator] === "function") return Array.from(cursor as Iterable<T>);
  if (typeof cursor.one === "function") {
    try { return [cursor.one()]; } catch { return []; }
  }
  return [];
}

function integerColumn(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

/**
 * A room's inclusive history lower bound. It is the server-wide retention
 * floor F, raised to the room's creation record. It never decreases: F is
 * monotonic, and a room reports null (effective bound latest + 1) only while
 * F > latest, so any later record in the room is at least F.
 */
function roomHistoryFloor(room: Pick<RawRoomRow, "created_log_id">, floor: number): number {
  return Math.max(floor, room.created_log_id);
}

function roomHistoryLogId(room: Pick<RawRoomRow, "created_log_id" | "latest_log_id">, floor: number): string | null {
  const lower = roomHistoryFloor(room, floor);
  return lower <= room.latest_log_id ? idString(lower) : null;
}

/** A stored list of room IDs, dropping anything malformed. */
function roomIdList(value: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(value || "[]", []);
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 64))];
}

/** A membership's recorded user (§3.3): `user_id` and a non-empty `name`. */
function recordedUser(userId: string, name: string | null | undefined): Identity {
  return { user_id: userId, ...(name ? { name } : {}) };
}

/**
 * The text an embed's `og` may carry, with its longest kept length in code
 * points. Clients build `og` themselves (such as link previews), and the
 * server has the last word on it (§4.8.1): it keeps these fields as one line
 * of plain text and drops the rest. Media are kept only from `ogMediaHosts`.
 */
const OG_TEXT_FIELDS: Record<string, number> = { title: 256, description: 512, site_name: 128 };
const OG_MEDIA_FIELDS = ["image", "video", "audio"] as const;
const OG_MEDIA_URL_BYTES = 2_048;
const OG_MEDIA_TYPE_BYTES = 128;
const OG_MEDIA_ALT_CODE_POINTS = 512;
const OG_MEDIA_MAX_DIMENSION = 16_384;

/** Control, bidirectional override, and line or paragraph separator characters. */
const OG_UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** `value` as one line of plain text of at most `max` code points, or undefined when empty. */
/** An identity's avatar while it has not expired (protocol §4.8.7). */
function liveAvatar(row: { avatar_url: string | null; avatar_expires_ms: number | null }, now: number): string | undefined {
  return row.avatar_url && (row.avatar_expires_ms ?? 0) > now ? row.avatar_url : undefined;
}

/** An upload embed's `title`: its sender's single line of text, bounded like `og.title`. */
function uploadTitle(value: unknown): string | undefined {
  return ogLine(value, OG_TEXT_FIELDS.title);
}

/** An unguessable object key segment (protocol §4.8.2): 128 random bits, base64url. */
function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function ogLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(OG_UNSAFE_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  const points = [...line];
  if (!points.length) return undefined;
  return points.length > max ? `${points.slice(0, max - 1).join("").trimEnd()}…` : line;
}

/**
 * An `og` media object with an absolute `https:` `url` on one of `hosts`,
 * without credentials or a port, and bounded details; or undefined.
 */
function ogMedia(value: unknown, hosts: readonly string[] | "*"): Record<string, unknown> | undefined {
  if (!isPlainObject(value) || typeof value.url !== "string" || utf8Bytes(value.url) > OG_MEDIA_URL_BYTES) return undefined;
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  if (!hostListAllowed(hosts, url.hostname)) return undefined;
  const media: Record<string, unknown> = { url: url.href };
  if (typeof value.type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(value.type) && value.type.length <= OG_MEDIA_TYPE_BYTES) media.type = value.type;
  for (const field of ["width", "height"] as const) {
    const size = value[field];
    if (Number.isInteger(size) && (size as number) > 0 && (size as number) <= OG_MEDIA_MAX_DIMENSION) media[field] = size;
  }
  const alt = ogLine(value.alt, OG_MEDIA_ALT_CODE_POINTS);
  if (alt) media.alt = alt;
  return media;
}

/**
 * `embed` with its `og` reduced to kept text fields, plus media on one of
 * `mediaHosts`, or without `og` when nothing is left.
 */
function withCleanOg(embed: Record<string, unknown>, mediaHosts: readonly string[] | "*"): Record<string, unknown> {
  if (embed.og === undefined) return embed;
  const { og, ...rest } = embed;
  const clean: Record<string, unknown> = {};
  if (isPlainObject(og)) {
    for (const [field, max] of Object.entries(OG_TEXT_FIELDS)) {
      const line = ogLine(og[field], max);
      if (line) clean[field] = line;
    }
    if (mediaHosts === "*" || mediaHosts.length) {
      for (const field of OG_MEDIA_FIELDS) {
        const media = ogMedia(og[field], mediaHosts);
        if (media) clean[field] = media;
      }
    }
  }
  return Object.keys(clean).length ? { ...rest, og: clean } : rest;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function ensureText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string") throw new StoreError("invalid_params", `${field} must be a string`);
  if (utf8Bytes(value) > maxBytes) throw new StoreError("too_large", `${field} is too large`);
  return value;
}

/** The indexes of schema 9's tables that schema 10 rebuilds (upgradeFromSchema9), dropped before the rebuild creates its own. */
const SCHEMA_9_INDEXES = [
  "records_log_idx", "records_retention_idx", "message_state_latest_idx", "reaction_state_log_idx",
  "uploads_owner_idx", "uploads_expiry_idx", "uploads_pending_idx", "uploads_message_idx", "memberships_user_idx",
  "credentials_user_idx", "push_subscriptions_user_idx", "push_subscriptions_updated_idx", "push_subscriptions_waking_idx",
  "push_subscriptions_joined_idx", "push_wakes_woken_idx", "accepted_requests_expiry_idx", "principal_limits_updated_idx",
];

/** The indexes of schema 10 that schema 11 drops (upgradeFromSchema10): no query reads them any more. */
const SCHEMA_10_DROPPED_INDEXES = ["message_state_latest_idx", "reaction_state_log_idx", "push_subscriptions_user_idx", "push_subscriptions_waking_idx"];

/** Each table schema 10 rebuilds as `WITHOUT ROWID` (upgradeFromSchema9), with the columns its rows keep in the current schema. */
const SCHEMA_10_COPIED_COLUMNS: Record<string, readonly string[]> = {
  _meta: ["key", "value"],
  rooms: ["room_id", "parent_room_id", "created_log_id", "record_log_id", "latest_log_id", "fields_json", "created_ms", "updated_ms", "member_count"],
  records: ["room_id", "log_id", "commit_ms", "kind", "record_json"],
  message_state: ["message_id", "room_id", "latest_log_id", "author_id"],
  reaction_state: ["message_id", "user_id", "log_id", "from_json", "emojis_json"],
  identities: ["user_id", "user_handle", "name", "tier", "created_ms", "updated_ms", "avatar_url", "avatar_expires_ms", "roles_json", "ext_json", "seen_ms"],
  uploads: ["upload_key", "owner_id", "purpose", "message_id", "embed_id", "state", "bytes", "write_expires_ms", "expires_ms", "created_ms"],
  memberships: ["room_id", "user_id"],
  credentials: ["credential_id", "user_id", "public_key_json", "sign_count", "transports_json", "created_ms", "updated_ms"],
  push_subscriptions: ["user_id", "url", "p256dh", "auth", "push_id", "wake", "created_ms", "updated_ms"],
  push_wakes: ["user_id", "room_id", "woken_ms"],
  user_status: ["user_id", "status", "mute_until_ms"],
  room_mutes: ["user_id", "room_id", "mute_until_ms"],
  accepted_requests: ["user_id", "request_id", "digest", "result_json", "transition_json", "expires_ms"],
  resource_budgets: ["day", "reads_reserved", "writes_reserved", "frames_reserved", "admissions_reserved", "posts_reserved", "registrations_reserved", "history_reserved", "effective_ms", "foreground_reads", "foreground_writes", "maintenance_reads", "maintenance_writes"],
  principal_limits: ["scope", "principal_key", "level", "level_ms", "day", "posts_day", "registrations_day", "uploads_day", "updated_ms"],
};

/**
 * Schema 8: the server-wide log with membership records, and each registered
 * identity's joined rooms as `memberships` rows, by room (the primary key, for
 * member listings) and by user (for a user's rooms), counted in each room's
 * `member_count`. Guests' memberships live in their connection only, like the
 * guest identity itself, and are not logged. `uploads` lists the objects
 * written to R2 (protocol §4.8.3): attached files by message and embed, and
 * avatars, by owner, expiry, and pending write. `push_subscriptions` holds
 * registered users' Web Push registrations (protocol §4.9), keyed by user
 * and endpoint, indexed by user and registration time and by registration
 * time (for expiry), and by user and registration time for those that wake
 * for messages (a partial index, so a wake reads only those). `push_wakes`
 * keeps when each user was last woken for each room, for coalescing.
 * `user_status` keeps each registered user's `status` state (protocol
 * §4.5): the `status` they chose with `me` and until when their unscoped
 * mute lasts, one row while either differs from the default (`online`, not
 * muted). `room_mutes` keeps their room mutes, keyed by user and room, at
 * most MAX_ROOM_MUTES_PER_USER a user. Each identity's `seen_ms` (protocol
 * §4.5.2 `seen`, 0 for none) is when the status others see of the user last
 * became `offline`, in the row a member listing reads anyway; it is the
 * last column, added to an older schema 9 object without a new version
 * (ensureSeenColumn()).
 *
 * Schema 10 (upgradeFromSchema9): every table keyed by text or by more than
 * one column is `WITHOUT ROWID`, so its key is the table rather than a
 * second index each insert writes. `records` is indexed by `log_id` only:
 * commit times follow log order, so retention walks that index.
 * `message_state` points at each message's latest record rather than
 * holding a copy of it. `log_state` is written by retention only; each
 * commit's head is the newest record, which `logState()` reads and keeps.
 * `read_cursors` keeps each registered user's `read_message_id` (protocol
 * §4.6) for each room they joined, keyed by user and room, at most one a
 * membership (saveReadCursors), deleted with it.
 *
 * Schema 11 (upgradeFromSchema10): message and reaction state is deleted
 * with the record it points at, so neither table is indexed by log ID; a
 * user's push registrations are their primary-key range, so only expiry
 * and the moderators' `joined` registrations are indexed; and uploads no
 * longer keep their content type, which nothing read.
 */
const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS log_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_log_id INTEGER NOT NULL,
    history_floor INTEGER NOT NULL,
    last_commit_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    room_id TEXT PRIMARY KEY,
    parent_room_id TEXT,
    created_log_id INTEGER NOT NULL,
    record_log_id INTEGER NOT NULL,
    latest_log_id INTEGER NOT NULL,
    fields_json TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    member_count INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS records (
    room_id TEXT NOT NULL,
    log_id INTEGER NOT NULL,
    commit_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (room_id, log_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS records_log_idx ON records (log_id);
  CREATE TABLE IF NOT EXISTS message_state (
    message_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    latest_log_id INTEGER NOT NULL,
    author_id TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS reaction_state (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    log_id INTEGER NOT NULL,
    from_json TEXT NOT NULL,
    emojis_json TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS identities (
    user_id TEXT PRIMARY KEY,
    user_handle TEXT NOT NULL,
    name TEXT NOT NULL,
    tier TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    avatar_url TEXT NOT NULL DEFAULT '',
    avatar_expires_ms INTEGER NOT NULL DEFAULT 0,
    roles_json TEXT NOT NULL DEFAULT '[]',
    ext_json TEXT NOT NULL DEFAULT '',
    seen_ms INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS uploads (
    upload_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    message_id TEXT,
    embed_id TEXT,
    state TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    write_expires_ms INTEGER NOT NULL,
    expires_ms INTEGER NOT NULL,
    created_ms INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS uploads_owner_idx ON uploads (owner_id);
  CREATE INDEX IF NOT EXISTS uploads_expiry_idx ON uploads (expires_ms);
  CREATE INDEX IF NOT EXISTS uploads_pending_idx ON uploads (state, write_expires_ms);
  CREATE INDEX IF NOT EXISTS uploads_message_idx ON uploads (message_id);
  CREATE TABLE IF NOT EXISTS memberships (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);
  CREATE TABLE IF NOT EXISTS read_cursors (
    user_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS credentials (
    credential_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    public_key_json TEXT NOT NULL,
    sign_count INTEGER NOT NULL,
    transports_json TEXT,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS credentials_user_idx ON credentials (user_id);
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    push_id TEXT,
    wake INTEGER NOT NULL DEFAULT 3,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, url)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS push_subscriptions_updated_idx ON push_subscriptions (updated_ms);
  CREATE INDEX IF NOT EXISTS push_subscriptions_joined_idx ON push_subscriptions (updated_ms, user_id) WHERE ${JOINED_WAKE_CONDITION};
  CREATE TABLE IF NOT EXISTS push_wakes (
    user_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    woken_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS push_wakes_woken_idx ON push_wakes (woken_ms);
  CREATE TABLE IF NOT EXISTS user_status (
    user_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'online',
    mute_until_ms INTEGER
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS room_mutes (
    user_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    mute_until_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS accepted_requests (
    user_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    result_json TEXT NOT NULL,
    transition_json TEXT,
    expires_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, request_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS accepted_requests_expiry_idx
    ON accepted_requests (expires_ms);
  CREATE TABLE IF NOT EXISTS resource_budgets (
    day TEXT PRIMARY KEY,
    reads_reserved INTEGER NOT NULL DEFAULT 0,
    writes_reserved INTEGER NOT NULL DEFAULT 0,
    frames_reserved INTEGER NOT NULL DEFAULT 0,
    admissions_reserved INTEGER NOT NULL DEFAULT 0,
    posts_reserved INTEGER NOT NULL DEFAULT 0,
    registrations_reserved INTEGER NOT NULL DEFAULT 0,
    history_reserved INTEGER NOT NULL DEFAULT 0,
    effective_ms INTEGER NOT NULL DEFAULT 0,
    foreground_reads INTEGER NOT NULL DEFAULT 0,
    foreground_writes INTEGER NOT NULL DEFAULT 0,
    maintenance_reads INTEGER NOT NULL DEFAULT 0,
    maintenance_writes INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS principal_limits (
    scope TEXT NOT NULL,
    principal_key TEXT NOT NULL,
    level REAL NOT NULL DEFAULT 0,
    level_ms INTEGER NOT NULL DEFAULT 0,
    day TEXT NOT NULL,
    posts_day INTEGER NOT NULL DEFAULT 0,
    registrations_day INTEGER NOT NULL DEFAULT 0,
    uploads_day INTEGER NOT NULL DEFAULT 0,
    updated_ms INTEGER NOT NULL,
    PRIMARY KEY (scope, principal_key)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS principal_limits_updated_idx
    ON principal_limits (updated_ms);
  CREATE TABLE IF NOT EXISTS maintenance (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_cleanup_ms INTEGER NOT NULL,
    cleanup_cutoff_ms INTEGER,
    cleanup_cursor INTEGER,
    schema_version INTEGER NOT NULL
  );
`;

export class Store {
  readonly config: StoreConfig;
  readonly sql: SqlStorageLike;
  readonly clock: StoreClock;
  private readonly durableStorage?: DurableStateLike["storage"];
  private readonly transactionSync?: <T>(closure: () => T) => T;
  private initialized = false;
  private inTransaction = false;
  private observed = {
    reads: 0,
    writes: 0,
    operations: 0,
    reservedReads: 0,
    reservedWrites: 0,
  };
  private lastEffectiveMs = 0;
  /**
   * The log's state (logState), kept here rather than written on every
   * commit: the last log_id and commit time are those of the newest record,
   * read once a wake, and are written with the history floor when cleanup
   * moves it, which keeps them where every record they covered is gone.
   */
  private logCache: RawLogState | null = null;
  /**
   * The open live texts (META_LIVE_TEXTS) as last read or saved, undefined
   * until read: every change goes through this instance, and a rolled-back
   * transaction restores it.
   */
  private liveCache: LiveEntry[] | undefined;
  /** Principals' limiter rows, written every few charges (limiter-cache.ts). */
  private readonly limiters = new LimiterCache({ write: (row, now) => this.writeLimitRow(row, now, true) });
  /** The daily budget rows and today's cached copy (budget-ledger.ts), over this store's metered SQL. */
  private readonly ledger: BudgetLedger;
  /**
   * A reservation overran its estimate (assertReservation): the cost model
   * is wrong, so nothing runs until an operator clears the persisted stop
   * (recoverAccounting) or storage is reset.
   */
  private accountingUnsafe = false;
  /**
   * A ledger read or write failed, as storage does in a platform outage, so
   * the budget row may lag the cached copy. Work is refused only until a
   * later flush writes what is staged (recoverUncertain); an eviction
   * meanwhile is covered on the next wake (lostOnWake).
   */
  private accountingUncertain = false;
  /**
   * The marker said `uncertain` on this wake: the instance before this one
   * left staged changes unwritten, which recoverUncertain charges for before
   * it reopens.
   */
  private lostOnWake = false;
  /** The accounting marker as last read or written (`0`, `1`, or `uncertain`), so it is written only when it changes. */
  private accountingMarker = "0";
  /** Set while an operator alert runs (alert): reservations are charged, never refused, even with accounting closed. */
  private alerting = false;
  /**
   * Called once an overrun closes accounting, after the failing operation
   * has unwound, so the operators hear of it (ApronDemoServer.notify).
   */
  onOverrun?: () => void;
  /** Called, synchronously, as accounting closes or reopens, for a metric; it must not touch storage. */
  onAccounting?: (change: "overrun" | "uncertain" | "recovered") => void;
  private deferredCleanupUntil = 0;
  /**
   * `next_cleanup_ms` as last read (maintenanceRow), so an alarm can tell
   * whether cleanup is due without a reservation (cleanupDue); forgotten at
   * every write of it, which reads it again.
   */
  private cleanupDueCache?: number;
  private scheduledAlarmAt?: number;
  /** Bumped by every write to a table member listings read (MEMBER_TABLES). */
  private memberGeneration = 0;
  /** Member listings kept for reuse, by room (roomMembers, `memberCacheMs`). */
  private readonly memberCache = new Map<string, MemberCacheEntry>();
  /**
   * The custom emoji catalog (META_EMOJI_CATALOG), read on first need after
   * a wake (one row) and replaced on every edit, so a reaction's key is
   * checked against it with no read.
   */
  private emojiCache: { key: string | null; json: string; entries: Record<string, EmojiEntry>; keys: ReadonlySet<string> } | null = null;
  /** The server's stored `title`, `description` and `avatar` (`/server`), read once and kept with every change. */
  private serverCache: StoredServerMetadata | null = null;
  /** The rooms one roomMembers call read, when nothing is kept. */
  private readonly uncachedMembers = new Map<string, MemberCacheEntry>();

  constructor(
    storageOrState: unknown,
    config: Partial<StoreConfig> = {},
    clock: StoreClock | (() => number) = { now: () => Date.now() },
  ) {
    const candidate = storageOrState as SqlStorageLike | DurableStateLike | DurableSqlStorageLike;
    if (candidate && typeof candidate === "object" && "exec" in candidate) {
      this.durableStorage = undefined;
      this.sql = candidate as SqlStorageLike;
    } else if (candidate && typeof candidate === "object" && "storage" in candidate) {
      const state = candidate as DurableStateLike;
      this.durableStorage = state.storage;
      this.sql = state.storage.sql;
    } else {
      const storage = candidate as DurableSqlStorageLike;
      this.durableStorage = storage;
      this.sql = storage.sql;
    }
    this.transactionSync = this.durableStorage?.transactionSync?.bind(this.durableStorage);
    this.config = defaultStoreConfig(config);
    this.clock = typeof clock === "function" ? { now: clock } : clock;
    this.ledger = new BudgetLedger({
      exec: (query, ...bindings) => this.rawExec(query, ...bindings),
      rows: <T>(query: string, ...bindings: unknown[]) => this.rawRows<T>(query, ...bindings),
      advanceClock: (now) => { this.effectiveNow(now); },
      clock: () => this.lastEffectiveMs,
      inTransaction: () => this.inTransaction,
      markUnsafe: (error) => this.markAccountingUnsafe("uncertain", error),
    }, this.config);
  }

  /** Initializes schema once. Calling this on every hibernation wake is safe. */
  initialize(): void {
    if (this.initialized) return;
    // DDL is deliberately one initialization batch. The schema version marker
    // is checked before DDL so a wake/restart does not rewrite schema state.
    let version = this.readSchemaVersion();
    if (version === 7) {
      this.upgradeFromSchema7();
      version = 8;
    }
    if (version === 8) {
      this.upgradeFromSchema8();
      version = 9;
    }
    if (version === 9) {
      this.ensureSeenColumn();
      this.upgradeFromSchema9();
      version = SCHEMA_VERSION;
    }
    if (version === 10) {
      this.upgradeFromSchema10();
      version = SCHEMA_VERSION;
    }
    if (version !== 0 && version !== SCHEMA_VERSION) throw new Error(`storage schema ${version} requires resetStorage()`);
    if (version === SCHEMA_VERSION) {
      this.lastEffectiveMs = Math.max(this.lastEffectiveMs, this.storedEffectiveMs());
      const unsafeMarker = this.metaValue(META_ACCOUNTING_UNSAFE).trim().toLowerCase();
      this.accountingMarker = unsafeMarker || "0";
      if ((unsafeMarker === "1" || unsafeMarker === "true") && !this.recoverAccounting()) {
        this.accountingUnsafe = true;
      } else if (unsafeMarker === ACCOUNTING_UNCERTAIN) {
        // Charged and cleared by the first operation, not here: a wake writes nothing.
        this.accountingUncertain = true;
        this.lostOnWake = true;
      }
      // Schema/effective-clock handover reads are charged to the first
      // durable reservation after a wake. No schema rows are rewritten here.
      this.ledger.wake(dayFor(Math.max(this.lastEffectiveMs, this.clock.now())));
      this.initialized = true;
      return;
    }
    const now = this.transaction(() => {
      this.rawScript(SCHEMA_DDL);
      const now = this.effectiveNow(this.clock.now());
      this.bootstrapSchema(now);
      // Charge the one-time schema/bootstrap work to the maintenance reserve.
      // This marker is written only during a schema-version transition, never
      // on hibernation wakes or ordinary constructor calls.
      const startupCost = { reads: BOOTSTRAP_ROW_RESERVATION, writes: BOOTSTRAP_ROW_RESERVATION };
      this.ledger.addUnchecked(dayFor(now), maintenanceDelta(startupCost));
      this.observed.reservedReads += startupCost.reads;
      this.observed.reservedWrites += startupCost.writes;
      return now;
    });
    this.ledger.start(dayFor(Math.max(this.lastEffectiveMs, now, this.clock.now())));
    this.initialized = true;
  }

  /** Seed control rows and the permanent `general` room in a new object. */
  private bootstrapSchema(now: number): void {
    this.rawExec(
      "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?), ('effective_now_ms', ?), ('identity_count', '0'), ('thread_count', '0'), ('principal_limit_count', '0'), ('budget_stop_day', ''), ('accounting_unsafe', '0')",
      String(SCHEMA_VERSION),
      String(now),
    );
    this.rawExec(
      "INSERT OR REPLACE INTO maintenance (id, next_cleanup_ms, cleanup_cutoff_ms, cleanup_cursor, schema_version) VALUES (1, ?, NULL, NULL, ?)",
      now + this.config.cleanupIntervalMs,
      SCHEMA_VERSION,
    );
    this.seedGeneralRoom({ last_log_id: 0, history_floor: 1, last_commit_ms: 0 }, now);
  }

  /** True when the object holds data from another schema version that is not upgraded in place. */
  requiresReset(): boolean {
    const version = this.readSchemaVersion();
    return version !== 0 && (version < UPGRADABLE_SCHEMA_VERSION || version > SCHEMA_VERSION);
  }

  /**
   * Upgrades a schema 7 object to schema 8 in place, once, in one
   * transaction: it creates the empty `push_subscriptions`, `push_wakes`,
   * `user_status` and `room_mutes` tables and their indexes, adds the
   * identities' empty `ext_json` column, and changes nothing else. The rows
   * it reads and writes are measured and charged to the day's maintenance
   * reservation without a capacity check (finishUpgrade).
   */
  private upgradeFromSchema7(): void {
    const start = { reads: this.observed.reads, writes: this.observed.writes };
    const effective = Number(this.metaValue(META_EFFECTIVE_NOW));
    const day = dayFor(Math.max(Number.isSafeInteger(effective) ? effective : 0, this.clock.now()));
    this.transaction(() => {
      this.rawScript(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          user_id TEXT NOT NULL,
          url TEXT NOT NULL,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          push_id TEXT,
          wake INTEGER NOT NULL DEFAULT 3,
          created_ms INTEGER NOT NULL,
          updated_ms INTEGER NOT NULL,
          PRIMARY KEY (user_id, url)
        );
        CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id, updated_ms);
        CREATE INDEX IF NOT EXISTS push_subscriptions_updated_idx ON push_subscriptions (updated_ms);
        CREATE INDEX IF NOT EXISTS push_subscriptions_waking_idx ON push_subscriptions (user_id, updated_ms) WHERE wake != 0;
        CREATE TABLE IF NOT EXISTS push_wakes (
          user_id TEXT NOT NULL,
          room_id TEXT NOT NULL,
          woken_ms INTEGER NOT NULL,
          PRIMARY KEY (user_id, room_id)
        );
        CREATE INDEX IF NOT EXISTS push_wakes_woken_idx ON push_wakes (woken_ms);
        CREATE TABLE IF NOT EXISTS user_status (
          user_id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'online',
          mute_until_ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS room_mutes (
          user_id TEXT NOT NULL,
          room_id TEXT NOT NULL,
          mute_until_ms INTEGER NOT NULL,
          PRIMARY KEY (user_id, room_id)
        );
        ALTER TABLE identities ADD COLUMN ext_json TEXT NOT NULL DEFAULT ''
      `);
      this.finishUpgrade(8, start, day);
    });
    console.warn(JSON.stringify({ event: "storage_schema_upgraded", from: 7, to: 8 }));
  }

  /**
   * Upgrades a schema 8 object to schema 9 in place, once, in one
   * transaction: each limiter row gains one token bucket, starting empty, so
   * every rolling minute starts over once; its day counts are kept. Its four
   * timestamp lists (`*_events_json`, defaulting to '[]') stay, never read
   * again, as every insert names its columns: dropping a column rewrites the
   * whole table, four times up to `principalLimitCap` rows, where adding one
   * rewrites none. Each day's budget row gains its count of history pages, 0,
   * and the effective clock it now carries (budget-ledger.ts: flush), 0 until
   * its next write. Charged like upgradeFromSchema7 (finishUpgrade).
   */
  private upgradeFromSchema8(): void {
    const start = { reads: this.observed.reads, writes: this.observed.writes };
    const effective = Number(this.metaValue(META_EFFECTIVE_NOW));
    const day = dayFor(Math.max(Number.isSafeInteger(effective) ? effective : 0, this.clock.now()));
    this.transaction(() => {
      this.rawScript(`
        ALTER TABLE principal_limits ADD COLUMN level REAL NOT NULL DEFAULT 0;
        ALTER TABLE principal_limits ADD COLUMN level_ms INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE resource_budgets ADD COLUMN history_reserved INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE resource_budgets ADD COLUMN effective_ms INTEGER NOT NULL DEFAULT 0
      `);
      this.finishUpgrade(9, start, day);
    });
    console.warn(JSON.stringify({ event: "storage_schema_upgraded", from: 8, to: 9 }));
  }

  /**
   * Upgrades a schema 9 object to the current schema in place, once, in one
   * transaction (it creates SCHEMA_DDL, so schema 11's own upgrade has
   * nothing left to do), rebuilding every table keyed by text, or by more than one
   * column, as a `WITHOUT ROWID` table: SQLite otherwise keeps such a key as
   * a separate index, so each insert wrote one more row. `records` loses its
   * index by commit time, which repeated its index by `log_id` (commit times
   * are nondecreasing in log order), and `message_state` its copy of each
   * message's latest snapshot, read from `records` by its latest `log_id`
   * instead. `read_cursors` is new and empty. The limiter rows' four
   * timestamp lists, unread since schema 9, go with the rebuild, and so does
   * the state below the history floor (dropExpiredState).
   *
   * Each old table is renamed aside, the schema created anew, its rows copied
   * by column and the old table dropped. The rows this reads and writes, once,
   * are logged and not charged to the day's budget (as a carried passkey is
   * not): a rebuild of every retained row must not hold back the day's posts
   * nor its maintenance, and the account's own usage, which the deployment's
   * budget guard reads, still counts it.
   */
  private upgradeFromSchema9(): void {
    const start = { reads: this.observed.reads, writes: this.observed.writes };
    this.transaction(() => {
      // While schema 9's expiry indexes can find them: the rebuilt tables have none.
      this.dropExpiredState();
      for (const index of SCHEMA_9_INDEXES) this.rawExec(`DROP INDEX IF EXISTS ${index}`);
      for (const table of Object.keys(SCHEMA_10_COPIED_COLUMNS)) this.rawExec(`ALTER TABLE ${table} RENAME TO ${table}_v9`);
      this.rawScript(SCHEMA_DDL);
      for (const [table, columns] of Object.entries(SCHEMA_10_COPIED_COLUMNS)) {
        const list = columns.join(", ");
        this.rawExec(`INSERT INTO ${table} (${list}) SELECT ${list} FROM ${table}_v9`);
        this.rawExec(`DROP TABLE ${table}_v9`);
      }
      this.rawExec("UPDATE _meta SET value = ? WHERE key = 'schema_version'", String(SCHEMA_VERSION));
      this.rawExec("UPDATE maintenance SET schema_version = ? WHERE id = 1", SCHEMA_VERSION);
      this.cleanupDueCache = undefined;
    });
    console.warn(JSON.stringify({
      event: "storage_schema_upgraded", from: 9, to: SCHEMA_VERSION,
      rows_read: this.observed.reads - start.reads, rows_written: this.observed.writes - start.writes,
    }));
  }

  /**
   * Upgrades a schema 10 object to schema 11 in place, once, in one
   * transaction: it drops the indexes cleanup no longer reads, which every
   * write kept, and the uploads' `content_type`, which nothing read.
   * Message and reaction state now goes with the record it points at
   * (runCleanup), so the state rows already below the history floor, which
   * the dropped indexes found, are deleted first. Dropping a column
   * rewrites the uploads table, at most the uploads cap of rows. Charged
   * like upgradeFromSchema8 (finishUpgrade).
   */
  private upgradeFromSchema10(): void {
    const start = { reads: this.observed.reads, writes: this.observed.writes };
    const effective = Number(this.metaValue(META_EFFECTIVE_NOW));
    const day = dayFor(Math.max(Number.isSafeInteger(effective) ? effective : 0, this.clock.now()));
    this.transaction(() => {
      this.dropExpiredState();
      for (const index of SCHEMA_10_DROPPED_INDEXES) this.rawExec(`DROP INDEX IF EXISTS ${index}`);
      this.rawExec("ALTER TABLE uploads DROP COLUMN content_type");
      this.finishUpgrade(SCHEMA_VERSION, start, day);
    });
    console.warn(JSON.stringify({ event: "storage_schema_upgraded", from: 10, to: SCHEMA_VERSION }));
  }

  /**
   * Deletes the message and reaction state below the history floor, by the
   * schema 9 and 10 indexes on their latest log IDs: what cleanup left
   * when a batch ran out before them. From schema 11 state goes with its
   * record, so none is left below the floor.
   */
  private dropExpiredState(): void {
    const floor = this.logState().history_floor;
    this.rawExec("DELETE FROM message_state WHERE latest_log_id < ?", floor);
    this.rawExec("DELETE FROM reaction_state WHERE log_id < ?", floor);
  }

  /**
   * Adds the identities' `seen_ms` column (protocol §4.5.2 `seen`, 0 for
   * none recorded) where a schema 9 object made by earlier code lacks it,
   * once, in one transaction, without a new schema version: adding a column
   * rewrites no row, and code before it names every identities column it
   * reads or writes, so redeploying that code keeps everything and a later
   * wake finds the column still there. Only a schema 9 object's wake probes
   * for it, before its upgrade, with a statement that reads no row (it fails
   * to compile without the column), charged as one read to the wake's
   * handover allowance. The addition is
   * charged like upgradeFromSchema7 (chargeUpgrade), and fails closed the
   * same way.
   */
  private ensureSeenColumn(): void {
    try {
      this.rawRows(SEEN_COLUMN_PROBE);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/no such column/i.test(message)) throw error;
    }
    const start = { reads: this.observed.reads, writes: this.observed.writes };
    const effective = Number(this.metaValue(META_EFFECTIVE_NOW));
    const day = dayFor(Math.max(Number.isSafeInteger(effective) ? effective : 0, this.clock.now()));
    this.transaction(() => {
      this.rawExec("ALTER TABLE identities ADD COLUMN seen_ms INTEGER NOT NULL DEFAULT 0");
      this.chargeUpgrade(start, day);
    });
    console.warn(JSON.stringify({ event: "storage_column_added", table: "identities", column: "seen_ms" }));
  }

  /**
   * Ends an in-place upgrade's transaction: marks the new schema version and
   * charges what it did (chargeUpgrade).
   */
  private finishUpgrade(version: number, start: { reads: number; writes: number }, day: string): void {
    this.rawExec("UPDATE _meta SET value = ? WHERE key = 'schema_version'", String(version));
    this.rawExec("UPDATE maintenance SET schema_version = ? WHERE id = 1", version);
    this.cleanupDueCache = undefined;
    this.chargeUpgrade(start, day);
  }

  /**
   * Clears a persisted accounting stop when the operator sets
   * `accountingRecovery` to a value that has not cleared it before, and
   * records that value, so a stop latched later stays until the operator
   * picks a new one. Today's budget row is kept: what the failure that
   * latched the stop left unwritten is not charged. The rows this reads and
   * writes are charged like an in-place upgrade.
   */
  private recoverAccounting(): boolean {
    const recovery = this.config.accountingRecovery;
    if (!recovery) return false;
    const start = { reads: this.observed.reads, writes: this.observed.writes };
    if (this.metaValue(META_ACCOUNTING_RECOVERY) === recovery) return false;
    const day = dayFor(Math.max(this.lastEffectiveMs, this.clock.now()));
    // Written below, so the write after the transaction (persistAccountingMarker)
    // does not repeat it; a failed transaction fails initialize, which reads it again.
    this.accountingMarker = "0";
    this.transaction(() => {
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, '0'), (?, ?)", META_ACCOUNTING_UNSAFE, META_ACCOUNTING_RECOVERY, recovery);
      this.chargeUpgrade(start, day);
    });
    console.warn(JSON.stringify({ event: "accounting_unsafe_cleared", recovery }));
    return true;
  }

  /**
   * Clears accounting a storage failure left uncertain once what the ledger
   * staged is written (budget-ledger.ts: flush), so the budget row and its
   * copy agree again. After a wake that found the marker (lostOnWake), what
   * the lost instance left unwritten cannot be known, so a hundredth of the
   * day's SQL ceilings is charged to the maintenance reservation in its
   * place, more than an ordinary operation reserves; the app's own ceilings
   * sit inside the account's allowances, which the budget guard enforces
   * from Cloudflare's own counts. True once clear; false while storage still
   * fails.
   */
  private recoverUncertain(): boolean {
    if (this.inTransaction) return false;
    const start = { reads: this.observed.reads, writes: this.observed.writes };
    const day = dayFor(Math.max(this.lastEffectiveMs, this.clock.now()));
    let charged: { reads: number; writes: number } | undefined;
    try {
      if (this.lostOnWake) {
        charged = { reads: Math.ceil(this.config.sqlReadsPerDay / 100), writes: Math.ceil(this.config.sqlWritesPerDay / 100) };
        this.ledger.addUnchecked(day, maintenanceDelta(charged));
        // Charged once, even if what follows fails and recovery is tried again.
        this.lostOnWake = false;
      }
      this.ledger.flush();
      if (this.ledger.hasStaged()) return false;
      // Nothing was staged when a read failed: read the budget row, so a read
      // that still fails is not taken for recovery.
      this.rawRows("SELECT day FROM resource_budgets WHERE day = ? LIMIT 1", day);
      // The rows recovery took, charged as an in-place upgrade's are: callers
      // recover before they count their own (assertAccounting).
      this.chargeUpgrade(start, day);
    } catch {
      return false;
    }
    this.accountingUncertain = false;
    this.persistAccountingMarker();
    console.warn(JSON.stringify({ event: "accounting_uncertain_recovered", ...(charged ? { charged } : {}) }));
    try { this.onAccounting?.("recovered"); } catch { /* a metric never breaks recovery */ }
    return true;
  }

  /**
   * Throws while accounting is closed: for good after an overrun, and after
   * a storage failure until recoverUncertain succeeds. An operator alert
   * (alert) runs regardless. Every metered operation calls it before it
   * starts counting its rows, so recovery's own rows are never charged to
   * the operation that triggered it.
   */
  private assertAccounting(): void {
    if (this.alerting) return;
    if (this.accountingUnsafe) {
      throw new StoreError("internal_error", "storage accounting is unsafe; admission is closed", { data: { reason: ACCOUNTING_OVERRUN } });
    }
    if (this.accountingUncertain && !this.recoverUncertain()) {
      throw new StoreError("internal_error", "storage is unavailable", { data: { reason: STORAGE_UNAVAILABLE } });
    }
  }

  /**
   * Charges the rows an in-place upgrade read and wrote (measured from
   * `start`) to the day's maintenance reservation without a capacity check,
   * like a reset's passkey carry, so an upgrade cannot be blocked by an
   * exhausted budget.
   */
  private chargeUpgrade(start: { reads: number; writes: number }, day: string): void {
    const cost = { reads: this.observed.reads - start.reads, writes: this.observed.writes - start.writes + 2 };
    this.ledger.addUnchecked(day, maintenanceDelta(cost));
    this.observed.reservedReads += cost.reads;
    this.observed.reservedWrites += cost.writes;
  }

  /**
   * Wipe every SQLite table and key-value entry (chat, rooms, passkey
   * sessions, bot tokens, limiter windows) and initialize a fresh schema.
   * Used whenever the stored schema version differs from this code's, in
   * either direction; there is no data migration.
   *
   * Registered passkeys survive: up to MAX_CARRIED_PASSKEYS of the most
   * recently used are read before the wipe and written back, with their
   * identities (same `user_id`, name, and WebAuthn user handle) and their
   * `general` membership, so users sign in again with the passkey they have
   * rather than deleting it and registering anew. The rows the carry reads
   * and writes are charged to the day's maintenance reservation below, with their roles
   * (but `bot`, which no passkey holder has). Not their avatar, `ext` or
   * `seen` (`seen_ms` starts at 0, none recorded, so a carried user is
   * listed `offline` without `seen` until they next go offline). Older
   * passkeys past the cap, bots, and every session are dropped.
   *
   * The guest-number high-water mark is carried over, so a guest ID is never
   * reissued across a reset (a wipe does not restart guests at `guest_1`).
   * Besides those, only the current UTC day's resource reservations are carried
   * over, when the old schema's budget row is readable, so a deploy cannot replenish the
   * daily SQL allowance the platform has already metered. The fresh schema's
   * bootstrap reservation is added to that row without a capacity check, so
   * the reset itself can never fail on, or be blocked by, an exhausted budget;
   * an exhausted day simply stays exhausted until UTC midnight. The
   * accounting-unsafe latch is not carried: a reset is the operator's recovery
   * path for it. Callers must hold the object's input gate (the runtime uses
   * blockConcurrencyWhile) so no request observes the empty storage.
   */
  async resetStorage(): Promise<void> {
    const deleteAll = this.durableStorage?.deleteAll;
    if (typeof deleteAll !== "function") throw new Error("storage reset requires deleteAll()");
    const day = dayFor(Math.max(this.clock.now(), this.lastEffectiveMs));
    let carried: RawBudgetRow | null = null;
    try {
      carried = this.ledger.readRow(day);
    } catch {
      // An unreadable old budget table carries nothing.
    }
    let guestNumberMark = 0;
    try {
      guestNumberMark = this.metaNumber(META_GUEST_NUMBER_MARK);
    } catch {
      // An unreadable old meta table carries no guest numbers.
    }
    // The carry's reads and writes are measured, not estimated: finding the
    // most recent passkeys reads every credential and its identity.
    const carryStart = { reads: this.observed.reads, writes: this.observed.writes };
    const passkeys = this.readCarriedPasskeys();
    const carryReads = this.observed.reads - carryStart.reads;
    await deleteAll.call(this.durableStorage);
    this.memberGeneration += 1;
    this.memberCache.clear();
    this.emojiCache = null;
    this.serverCache = null;
    this.initialized = false;
    this.logCache = null;
    this.accountingUnsafe = false;
    this.accountingUncertain = false;
    this.lostOnWake = false;
    this.accountingMarker = "0";
    this.lastEffectiveMs = 0;
    this.cleanupDueCache = undefined;
    this.limiters.clear();
    this.scheduledAlarmAt = undefined;
    this.initialize();
    if (guestNumberMark > 0) {
      // Guest numbers outlive the wipe, so none is ever reissued. Like the
      // budget row, this is one uncharged control write.
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_GUEST_NUMBER_MARK, String(guestNumberMark));
    }
    const writeStart = { reads: this.observed.reads, writes: this.observed.writes };
    if (passkeys.length) this.writeCarriedPasskeys(passkeys);
    const carryCost = {
      reads: carryReads + this.observed.reads - writeStart.reads,
      writes: this.observed.writes - writeStart.writes,
    };
    if (!carried && !carryCost.reads && !carryCost.writes) return;
    // The carry is maintenance work, charged like the bootstrap: added
    // without a capacity check, so it cannot block the reset.
    const charge = maintenanceDelta(carryCost);
    const delta: BudgetDelta = {};
    for (const column of BUDGET_COLUMNS) {
      delta[column] = (carried ? Math.max(0, integerColumn(carried[column])) : 0) + (charge[column] ?? 0);
    }
    this.observed.reservedReads += carryCost.reads;
    this.observed.reservedWrites += carryCost.writes;
    this.transaction(() => this.ledger.addUnchecked(day, delta));
  }

  /**
   * The registered passkeys a reset keeps, with their identities and whether
   * each had joined `general`: at most MAX_CARRIED_PASSKEYS, most recently
   * used (signed in or registered) first. Read from the old schema by column
   * name, so a schema change that alters these tables must keep them readable
   * here or accept that the reset drops them; an unreadable table carries none.
   */
  private readCarriedPasskeys(): CarriedPasskey[] {
    try {
      return this.rawRows<CarriedPasskey>(
        `SELECT c.credential_id, c.user_id, c.public_key_json, c.sign_count, c.transports_json,
            c.created_ms, c.updated_ms, i.user_handle, i.name, i.tier, i.roles_json,
            i.created_ms AS identity_created_ms, i.updated_ms AS identity_updated_ms,
            EXISTS (SELECT 1 FROM memberships m WHERE m.room_id = ? AND m.user_id = c.user_id) AS in_general
         FROM credentials c JOIN identities i ON i.user_id = c.user_id
         WHERE i.tier = 'registered' AND i.user_id <> ?
         ORDER BY c.updated_ms DESC, c.credential_id LIMIT ?`,
        // `admin` holds no passkey; should one exist, a reset does not carry it.
        ROOM_ID, ADMIN_USER_ID, MAX_CARRIED_PASSKEYS,
      );
    } catch {
      // An unreadable old schema carries nothing.
      return [];
    }
  }

  /**
   * Restore carried passkeys into a fresh schema: the identity, its
   * credential, and its `general` membership. The membership row is restored
   * without a log record, like the rest of the old log it is not replayed;
   * member listings read the table. Other rooms did not survive the wipe.
   */
  private writeCarriedPasskeys(passkeys: readonly CarriedPasskey[]): void {
    this.transaction(() => {
      for (const row of passkeys) {
        // A passkey holder is never a bot, so a stray `bot` role is not carried.
        const roles = parseRoles(row.roles_json).filter((role) => role !== "bot");
        this.rawExec(
          "INSERT OR IGNORE INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms, roles_json) VALUES (?, ?, ?, 'registered', ?, ?, ?)",
          row.user_id, row.user_handle, row.name, row.identity_created_ms, row.identity_updated_ms, JSON.stringify(roles),
        );
        this.rawExec(
          `INSERT OR IGNORE INTO credentials
           (credential_id, user_id, public_key_json, sign_count, transports_json, created_ms, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          row.credential_id, row.user_id, row.public_key_json, row.sign_count, row.transports_json, row.created_ms, row.updated_ms,
        );
        if (row.in_general) this.rawExec("INSERT OR IGNORE INTO memberships (room_id, user_id) VALUES (?, ?)", ROOM_ID, row.user_id);
      }
      if (passkeys.some((row) => row.in_general)) {
        this.rawExec("UPDATE rooms SET member_count = (SELECT COUNT(*) FROM memberships WHERE room_id = ?) WHERE room_id = ?", ROOM_ID, ROOM_ID);
      }
      const count = this.rawRows<{ count: number }>("SELECT COUNT(*) AS count FROM identities")[0];
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('identity_count', ?)", String(integerColumn(count?.count)));
    });
  }

  /** Log the `general` room's creation record as the next server record. */
  private seedGeneralRoom(state: RawLogState, now: number): void {
    const context: CommitContext = { state: { ...state }, commitMs: Math.max(now, state.last_commit_ms), touched: new Map() };
    const logId = this.allocateLogId(context);
    const record = { room_id: ROOM_ID, log_id: idString(logId), title: ROOM_TITLE };
    this.rawExec(
      `INSERT INTO rooms (${ROOM_COLUMNS}) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 0)`,
      ROOM_ID, logId, logId, logId, JSON.stringify({ title: ROOM_TITLE }), context.commitMs, context.commitMs,
    );
    this.rawExec(
      "INSERT INTO records (room_id, log_id, commit_ms, kind, record_json) VALUES (?, ?, ?, 'room', ?)",
      ROOM_ID, logId, context.commitMs, JSON.stringify(record),
    );
    this.rawExec(
      "INSERT INTO log_state (id, last_log_id, history_floor, last_commit_ms) VALUES (1, ?, ?, ?)",
      logId,
      state.history_floor,
      context.commitMs,
    );
    this.logCache = null;
  }

  private readSchemaVersion(): number {
    try {
      const rows = this.rawRows<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version' LIMIT 1");
      return rows.length ? integerColumn(rows[0].value) : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such table|no such column|does not exist/i.test(message)) return 0;
      throw error;
    }
  }

  private ensureReady(): void {
    if (!this.initialized) this.initialize();
  }

  private metaValue(key: string): string {
    const rows = this.rawRows<{ value: string }>("SELECT value FROM _meta WHERE key = ? LIMIT 1", key);
    return rows[0]?.value ?? "";
  }

  private rawExec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursorLike<T> {
    const cursor = this.sql.exec<T>(query, ...bindings);
    const lower = query.trim().toLowerCase();
    if (lower.startsWith("select") || lower.startsWith("pragma") || lower.startsWith("with")) {
      // Do not materialize here: SqlStorageCursor is single-use. rawRows()
      // consumes it exactly once and records the actual count.
      this.observed.reads += Math.max(1, cursor.rowsRead ?? 1);
    } else {
      this.observed.reads += Math.max(0, cursor.rowsRead ?? 0);
      this.observed.writes += Math.max(1, cursor.rowsWritten ?? 1);
      // Reused member listings are stale once anything they read is written
      // (`seen` is written by writeSeen, whose callers update them instead,
      // once it is committed: patchMemberSeen).
      if (MEMBER_TABLES.test(lower)) this.memberGeneration += 1;
    }
    return cursor;
  }

  private rawScript(script: string): void {
    // Cloudflare's cursor executes one statement per call. Keeping the schema
    // text as one readable migration while dispatching each statement avoids
    // relying on a multi-statement extension in local adapters.
    for (const statement of script.split(";")) {
      const query = statement.trim();
      if (query) this.rawExec(query);
    }
  }

  private rawRows<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): T[] {
    const cursor = this.sql.exec<T>(query, ...bindings);
    const rows = cursorRows(cursor);
    this.observed.reads += Math.max(1, cursor.rowsRead ?? rows.length);
    return rows;
  }

  private transaction<T>(fn: () => T): T {
    // A nested call is refused by transactionInner, and must not disturb the outer journal.
    if (this.inTransaction) return this.transactionInner(fn);
    this.limiters.begin();
    const logCache = this.logCache;
    const liveCache = this.liveCache;
    try {
      const result = this.transactionInner(fn);
      this.limiters.commit();
      return result;
    } catch (error) {
      // The rows the transaction wrote are rolled back: so are the cached ones
      // it changed, the log head its commit kept (finishCommit), and the open
      // live texts it saved.
      this.limiters.rollback();
      this.logCache = logCache;
      this.liveCache = liveCache;
      throw error;
    }
  }

  private transactionInner<T>(fn: () => T): T {
    if (this.transactionSync && !this.inTransaction) {
      // Track the native transaction explicitly.  An accounting assertion can
      // fire before the callback returns; its marker must be written only
      // after transactionSync has rolled the user mutation back.
      this.inTransaction = true;
      try {
        const result = this.transactionSync(fn);
        this.inTransaction = false;
        this.persistAccountingMarker();
        return result;
      } catch (error) {
        this.inTransaction = false;
        this.persistAccountingMarker();
        throw error;
      }
    }
    // The native Workers SQL API forbids issuing BEGIN/COMMIT through
    // sql.exec. A SQL-only adapter is provided for pure unit tests; it runs
    // synchronously and leaves transaction atomicity to that adapter.
    if (this.inTransaction) throw new Error("nested storage transaction");
    this.inTransaction = true;
    try {
      const result = fn();
      this.inTransaction = false;
      this.persistAccountingMarker();
      return result;
    } catch (error) {
      this.inTransaction = false;
      this.persistAccountingMarker();
      throw error;
    }
  }

  /**
   * Writes the accounting marker when it changed: `1` after an overrun,
   * `uncertain` after a storage failure, `0` once clear. It is written after
   * any enclosing native transaction has rolled back, so a rollback cannot
   * erase the only durable stop.
   */
  private persistAccountingMarker(): void {
    if (this.inTransaction) return;
    const value = this.accountingUnsafe ? "1" : this.accountingUncertain ? ACCOUNTING_UNCERTAIN : "0";
    if (value === this.accountingMarker) return;
    try {
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_ACCOUNTING_UNSAFE, value);
      this.accountingMarker = value;
    } catch {
      // The in-memory latch remains closed. A native storage failure may also
      // prevent the marker write; callers still fail closed for this object,
      // and the next transaction tries the write again.
    }
  }

  /**
   * Closes accounting: for good on an `overrun` (an authority failure, not
   * an operation-local error), until storage works again on `uncertain`.
   * The first overrun tells the operators (onOverrun), once the failing
   * operation has unwound.
   */
  private markAccountingUnsafe(kind: "overrun" | "uncertain", error?: unknown): void {
    // Once a closing, with what failed: the one record of why the server refuses.
    if (kind === "overrun" ? !this.accountingUnsafe : !this.accountingUncertain) {
      console.error(JSON.stringify({ event: "accounting_closed", kind, message: error instanceof Error ? error.message : error === undefined ? undefined : String(error) }));
      try { this.onAccounting?.(kind); } catch { /* a metric never breaks the stop */ }
    }
    if (kind === "uncertain") {
      this.accountingUncertain = true;
      this.persistAccountingMarker();
      return;
    }
    const first = !this.accountingUnsafe;
    this.accountingUnsafe = true;
    this.persistAccountingMarker();
    const notify = this.onOverrun;
    if (first && notify) queueMicrotask(() => { try { notify(); } catch { /* a notice never breaks the stop */ } });
  }

  /**
   * Return the monotonic effective clock used for retention and quotas: never
   * less than any value it returned before, here or (through what the store
   * loaded on wake) before the last eviction. It is written with the budget
   * row each operation settles (budget-ledger.ts: flush), not on its own, so
   * an eviction can lose only the operation in flight's advance; commit times
   * stay nondecreasing through the log's own `last_commit_ms` regardless.
   */
  private effectiveNow(candidate: number): number {
    if (!Number.isFinite(candidate) || candidate < 0) throw new StoreError("internal_error", "invalid server clock");
    this.lastEffectiveMs = Math.max(this.lastEffectiveMs, Math.trunc(candidate));
    return this.lastEffectiveMs;
  }

  /** The effective clock as stored: the `_meta` value schemas before 9 wrote, or the greatest a budget row carries. */
  private storedEffectiveMs(): number {
    const meta = Number(this.metaValue(META_EFFECTIVE_NOW));
    let budget = 0;
    try {
      budget = integerColumn(this.rawRows<{ effective: number | null }>("SELECT MAX(effective_ms) AS effective FROM resource_budgets")[0]?.effective);
    } catch {
      // Before the upgrade adds the column.
    }
    return Math.max(Number.isSafeInteger(meta) && meta >= 0 ? meta : 0, budget);
  }

  /**
   * Advisory capacity check: no SQL, reservations, or durable clock updates,
   * but the ledger's write when recovering from a storage failure.
   */
  checkConnectionBudget(now = this.clock.now()): void {
    this.ensureReady();
    this.assertAccounting();
    if (!this.config.admissionEnabled) throw new StoreError("denied", "Demo admission is closed");
    this.ledger.checkConnection(Math.max(Math.trunc(now), this.lastEffectiveMs));
  }

  /**
   * Reserves an operation's bounded cost from today's budget before it runs
   * (budget-ledger.ts), refusing it with `retry_after` past a ceiling. An
   * admin command passes `unchecked`: it is charged but not refused.
   */
  private reserveCost(costInput: CostEstimate, maintenance = false, now = this.clock.now(), unchecked = false): BudgetCost {
    this.ensureReady();
    this.assertAccounting();
    const cost = this.ledger.reserve(costInput, Math.max(Math.trunc(now), this.lastEffectiveMs), now, maintenance, unchecked || this.alerting);
    this.countReservation(cost);
    return cost;
  }

  /** Spend the maintenance control gap when ordinary work is exhausted. */
  private reserveMaintenanceControl(costInput: CostEstimate, now: number): BudgetCost {
    this.ensureReady();
    this.assertAccounting();
    const cost = this.ledger.reserveControl(costInput, Math.max(Math.trunc(now), this.lastEffectiveMs));
    this.countReservation(cost);
    return cost;
  }

  private countReservation(cost: BudgetCost): void {
    this.observed.operations += 1;
    this.observed.reservedReads += cost.reads;
    this.observed.reservedWrites += cost.writes;
  }

  /**
   * Runs an operator alert's storage work (ApronDemoServer.notifyAdmins):
   * its reservations are charged but never refused, by an exhausted budget or
   * by closed accounting, so the operators still hear of the stop that closed
   * it. Mutations it makes should pass `system`.
   */
  alert<T>(fn: () => T): T {
    const was = this.alerting;
    this.alerting = true;
    try {
      return fn();
    } finally {
      this.alerting = was;
    }
  }

  /**
   * Registered users with `role`, by `user_id`, at most `limit`: one scan
   * of the identities, for an operator alert. Bots and the admin user are
   * identities too, so the reservation allows twice the registration cap.
   */
  usersWithRole(role: string, limit: number, now = this.clock.now()): string[] {
    return this.reserved({ reads: 2 * this.config.registeredIdentityCount + 64 }, false, now, () =>
      this.rawRows<{ user_id: string; roles_json: string }>("SELECT user_id, roles_json FROM identities WHERE roles_json LIKE ?", `%${JSON.stringify(role)}%`)
        .filter((row) => parseRoles(row.roles_json).includes(role))
        .map((row) => row.user_id)
        .sort()
        .slice(0, limit));
  }

  /** Explicit boundary for runtime operations that do their own SQL. */
  withMeter<T>(kind: "foreground" | "maintenance", cost: CostEstimate, fn: () => T, now = this.clock.now()): T {
    this.assertAccounting();
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    const reserved = this.reserveCost(cost, kind === "maintenance", now);
    try {
      return fn();
    } finally {
      // A platform cursor can reveal more rows than a static estimate
      // predicted. Keep accepted state durable, latch accounting unsafe, and
      // fail closed so an underestimated operation cannot continue.
      this.settleReservation(reserved, beforeReads, beforeWrites);
    }
  }

  /**
   * Meter a bounded operation which awaits storage outside SQLite (for
   * example, Durable Object key-value storage).  The reservation is made
   * before the first await, so a concurrent request cannot spend the same
   * daily allowance.  KV work has no SQL cursor to reconcile; callers must
   * supply a conservative bound for the complete operation.
   */
  async withMeterAsync<T>(kind: "foreground" | "maintenance", cost: CostEstimate, fn: () => Promise<T>, now = this.clock.now()): Promise<T> {
    // The callback may yield while another input-gated operation performs
    // SQLite work. Do not compare shared observed counters across the await:
    // this reservation already charges the complete bounded external work.
    // Nothing settles it, so it is written now (its bookkeeping rows pay for
    // that), not left staged for a later operation an eviction may not reach.
    this.reserveCost(cost, kind === "maintenance", now);
    this.ledger.flush();
    return await fn();
  }

  private assertReservation(reserved: BudgetCost, beforeReads: number, beforeWrites: number): void {
    const actualReads = this.observed.reads - beforeReads;
    const actualWrites = this.observed.writes - beforeWrites;
    if (actualReads > reserved.reads || actualWrites > reserved.writes) {
      // Set the latch before throwing. If this assertion is inside a native
      // transaction, transaction() persists it after rollback; outside a
      // transaction it is durable immediately.
      this.markAccountingUnsafe("overrun", `storage cost exceeded its reservation: ${actualReads}/${reserved.reads} reads, ${actualWrites}/${reserved.writes} writes`);
      throw new StoreError("internal_error", "storage cost exceeded its reservation", {
        data: {
          reserved_reads: reserved.reads,
          reserved_writes: reserved.writes,
          actual_reads: actualReads,
          actual_writes: actualWrites,
        },
      });
    }
  }

  /** The final check on a finished operation: assert it stayed within its reservation, then refund the rest. */
  private settleReservation(reserved: BudgetCost, beforeReads: number, beforeWrites: number, unused?: { history: number }): void {
    this.assertReservation(reserved, beforeReads, beforeWrites);
    this.ledger.refund(reserved, this.observed.reads - beforeReads, this.observed.writes - beforeWrites, unused);
  }

  /**
   * Runs `fn` under a reservation of `cost`, then settles it. `fn` may set
   * `unused.history` to give back history pages it reserved and did not
   * serve, whether it returns or throws.
   */
  private reserved<T>(cost: CostEstimate, maintenance: boolean, now: number, fn: (unused: { history: number }) => T, unchecked = false): T {
    this.assertAccounting();
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    const reservation = this.reserveCost(cost, maintenance, now, unchecked);
    const unused = { history: 0 };
    try {
      return fn(unused);
    } finally {
      this.settleReservation(reservation, beforeReads, beforeWrites, unused);
    }
  }

  accountingStatus(): { unsafe: boolean; uncertain: boolean; database_bytes: number | null } {
    return { unsafe: this.accountingUnsafe, uncertain: this.accountingUncertain, database_bytes: this.databaseSize() };
  }

  accountUsageSnapshot(): AccountUsageSnapshot | null {
    this.ensureReady();
    const raw = this.metaValue(META_ACCOUNT_USAGE);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<AccountUsageSnapshot>;
      const sampledAt = parsed.sampledAt;
      if (typeof parsed.day !== "string" || typeof sampledAt !== "number" || !Number.isSafeInteger(sampledAt) || sampledAt < 0 ||
        ["workerRequests", "durableObjectRequests", "durableObjectDurationGbSeconds", "sqlRowsRead", "sqlRowsWritten", "storedBytes"].some(key => {
          const value = parsed[key as keyof AccountUsageSnapshot];
          return typeof value !== "number" || !Number.isFinite(value) || value < 0;
        }) || typeof parsed.stop !== "boolean") return null;
      return parsed as AccountUsageSnapshot;
    } catch {
      return null;
    }
  }

  persistAccountUsageSnapshot(snapshot: AccountUsageSnapshot, now = this.clock.now()): void {
    this.ensureReady();
    this.reserved({ reads: 8, writes: 8 }, true, now, () => {
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_ACCOUNT_USAGE, JSON.stringify(snapshot));
    });
  }

  budget(now = this.clock.now()): BudgetSnapshot {
    this.ensureReady();
    return this.budgetValue(now);
  }

  /** Today's reservations and the identity count, for `/status`. */
  status(now = this.clock.now()): { budget: BudgetSnapshot; identities: number; databaseBytes: number | null } {
    this.ensureReady();
    return this.reserved({ reads: 8 }, false, now, () => ({
      budget: this.budgetValue(now),
      identities: this.metaNumber("identity_count"),
      databaseBytes: this.databaseSize(),
    }));
  }

  private budgetValue(now: number): BudgetSnapshot {
    return this.ledger.snapshot(dayFor(this.effectiveNow(now)));
  }

  storageAccounting(): {
    reads: number;
    writes: number;
    operations: number;
    reservedReads: number;
    reservedWrites: number;
  } {
    return { ...this.observed };
  }

  databaseSize(): number | null {
    const sql = this.durableStorage?.sql as unknown as { databaseSize?: unknown } | undefined;
    return typeof sql?.databaseSize === "number" && Number.isFinite(sql.databaseSize) ? sql.databaseSize : null;
  }

  private ensureGrowthCapacity(additionalBytes: number): void {
    const size = this.databaseSize();
    if (size === null) throw new StoreError("internal_error", "Storage capacity unavailable");
    // workerd's databaseSize subtracts freelist pages, so this is occupied
    // SQLite space, including indexes, rather than the filesystem's high-water
    // size. No unbounded COUNT/SUM scan or VACUUM is needed to observe reuse.
    const paused = this.metaValue("storage_pressure") === "1";
    // Cover snapshot copies, indexed inserts/splits and control rows before
    // entering the transaction. The post-write target check also runs before
    // commit; one unexpectedly large operation cannot cross the hard target.
    const growthAllowance = Math.max(1024 * 1024, Math.max(0, additionalBytes) * 16);
    if (size >= this.config.storageHighWaterBytes || size + growthAllowance > this.config.storageHardTargetBytes) {
      if (!paused) this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('storage_pressure', '1')");
      throw new StoreError("retry_after", "Demo capacity reached", { retryAfterMs: this.config.cleanupIntervalMs });
    }
    if (paused) {
      if (size > this.config.storageLowWaterBytes) throw new StoreError("retry_after", "Demo capacity reached", { retryAfterMs: this.config.cleanupIntervalMs });
      this.rawExec("UPDATE _meta SET value = '0' WHERE key = 'storage_pressure'");
    }
  }

  private assertStorageTarget(): void {
    const size = this.databaseSize();
    if (size === null || size > this.config.storageHardTargetBytes) {
      throw new StoreError("retry_after", "Demo capacity reached", { retryAfterMs: this.config.cleanupIntervalMs });
    }
  }

  private logState(): RawLogState {
    if (!this.logCache) {
      const rows = this.rawRows<RawLogState>(
        "SELECT last_log_id, history_floor, last_commit_ms FROM log_state WHERE id = 1 LIMIT 1",
      );
      if (!rows.length) throw new StoreError("internal_error", "log state is missing");
      // The stored state is as of the last cleanup; the newest record, which no cleanup has reached, is newer.
      const newest = this.rawRows<{ log_id: number; commit_ms: number }>(
        "SELECT log_id, commit_ms FROM records INDEXED BY records_log_idx ORDER BY log_id DESC LIMIT 1",
      )[0];
      this.logCache = {
        last_log_id: Math.max(integerColumn(rows[0].last_log_id), newest ? integerColumn(newest.log_id) : 0),
        history_floor: integerColumn(rows[0].history_floor),
        last_commit_ms: Math.max(integerColumn(rows[0].last_commit_ms), newest ? integerColumn(newest.commit_ms) : 0),
      };
    }
    return { ...this.logCache };
  }

  private roomRow(roomId: string): RawRoomRow | null {
    const rows = this.rawRows<RawRoomRow>(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE room_id = ? LIMIT 1`, roomId);
    return rows[0] ?? null;
  }

  /** The complete room record with this server's delivery fields. */
  private roomRecord(row: RawRoomRow, floor: number): RoomRecord {
    const fields = parseJson<{ title?: unknown; description?: unknown; ext?: unknown }>(row.fields_json, {});
    const record: Record<string, unknown> = { room_id: row.room_id, log_id: idString(row.record_log_id) };
    if (row.parent_room_id !== null) record.parent_room_id = row.parent_room_id;
    // Sent only on a room kept private (§4.2.4), so a client can check it before posting.
    if (isPrivateRoomId(row.room_id)) record.private = true;
    if (typeof fields.title === "string") record.title = fields.title;
    if (typeof fields.description === "string") record.description = fields.description;
    if (isPlainObject(fields.ext)) record.ext = fields.ext;
    record.latest_log_id = idString(row.latest_log_id);
    record.history_log_id = roomHistoryLogId(row, floor);
    return record as unknown as RoomRecord;
  }

  /** Reads reserved for listing every room, bounded by the calibrated thread cap. */
  private roomListingReads(): number {
    // One room row per room, with slack for index pages;
    // test/accounting.integration.test.ts measures the cap.
    return 32 + 4 * (MAX_THREAD_LIMIT + 1);
  }

  /**
   * Every public room record, oldest first, for `room_list`, which adds the
   * caller's private rooms (privateRoomsOf). Maintenance callers (the
   * retention `room_update` `updated` listing, which goes to each room's
   * members) charge the maintenance budget, may list the private rooms too
   * (`withPrivate`), and may keep only rooms whose history_log_id differs
   * from what it was under an earlier retention floor.
   */
  listRooms(now = this.clock.now(), options: { maintenance?: boolean; changedSinceFloor?: number; withPrivate?: boolean } = {}): RoomRecord[] {
    this.ensureReady();
    const withPrivate = options.withPrivate === true;
    return this.reserved({ reads: this.roomListingReads() + (withPrivate ? 4 * MAX_PRIVATE_ROOM_LIMIT : 0) }, options.maintenance === true, now, () => {
      const floor = this.logState().history_floor;
      // The public range is capped at `general` plus the calibrated thread
      // ceiling, which created top-level rooms count against too, so this
      // ordered scan is bounded by that cap; the private range by its own.
      const rows = this.rawRows<RawRoomRow>(
        `SELECT ${ROOM_COLUMNS} FROM rooms WHERE ${PUBLIC_ROOMS} ORDER BY created_log_id ASC LIMIT ?`,
        MAX_THREAD_LIMIT + 1,
      );
      if (withPrivate) rows.push(...this.rawRows<RawRoomRow>(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE ${PRIVATE_ROOMS} LIMIT ?`, MAX_PRIVATE_ROOM_LIMIT));
      const since = options.changedSinceFloor;
      return rows
        .filter((row) => since === undefined || roomHistoryLogId(row, since) !== roomHistoryLogId(row, floor))
        .map((row) => this.roomRecord(row, floor));
    });
  }

  /** One room's record, or null when the room does not exist. */
  getRoom(roomId: string, now = this.clock.now()): RoomRecord | null {
    this.ensureReady();
    return this.reserved({ reads: 16 }, false, now, () => {
      const row = this.roomRow(roomId);
      if (!row) return null;
      return this.roomRecord(row, this.logState().history_floor);
    });
  }

  /**
   * The private rooms a registered user is in, as room records, for their
   * listings: listRooms reads only the public ones. Their membership rows
   * through the user index, live and awaiting purge, joined with `rooms`,
   * which hides the latter.
   */
  privateRoomsOf(userId: string, now = this.clock.now()): RoomRecord[] {
    this.ensureReady();
    return this.reserved({ reads: 16 + 3 * (MAX_USER_ROOMS + MAX_PURGE_ROOMS) }, false, now, () => {
      const floor = this.logState().history_floor;
      return this.rawRows<RawRoomRow>(
        `SELECT ${ROOM_COLUMNS.split(", ").map((column) => `r.${column}`).join(", ")}
         FROM memberships m INDEXED BY memberships_user_idx JOIN rooms r ON r.room_id = m.room_id
         WHERE m.user_id = ? AND ${privateRange("m.room_id")} LIMIT ?`,
        userId, MAX_PRIVATE_MEMBERSHIPS_PER_USER,
      ).map((row) => this.roomRecord(row, floor));
    });
  }

  /**
   * The registered user who created a room with `room_set`, kept beside the
   * room's client fields (`creator_id` in `fields_json`) but never in its
   * record, or undefined for `general`, a guest's room, or an unknown room.
   */
  roomCreator(roomId: string, now = this.clock.now()): string | undefined {
    this.ensureReady();
    return this.reserved({ reads: 16 }, false, now, () => {
      const row = this.roomRow(roomId);
      return row ? storedCreator(row.fields_json) : undefined;
    });
  }

  /** The room record for `general` (or another room); throws when missing. */
  getRoomState(roomId = ROOM_ID): RoomRecord {
    const room = this.getRoom(roomId);
    if (!room) throw new StoreError("invalid_params", "unknown room");
    return room;
  }

  /** The server-wide log head and retention floor. */
  logBounds(): { latest_log_id: string; history_floor: string } {
    this.ensureReady();
    return this.reserved({ reads: 8 }, false, this.clock.now(), () => {
      const state = this.logState();
      return { latest_log_id: idString(state.last_log_id), history_floor: idString(state.history_floor) };
    });
  }

  private identityRow(userId: string): RawIdentityRow | null {
    const rows = this.rawRows<RawIdentityRow>(
      "SELECT user_id, user_handle, name, tier, created_ms, updated_ms, avatar_url, avatar_expires_ms, roles_json, ext_json, seen_ms FROM identities WHERE user_id = ? LIMIT 1",
      userId,
    );
    return rows[0] ?? null;
  }

  /**
   * A registered user's joined rooms, oldest room first. The user index holds
   * at most one row per existing room plus rows of removed rooms awaiting
   * purge, both capped, and the join with `rooms` hides the latter.
   */
  private userRooms(userId: string): string[] {
    return this.rawRows<{ room_id: string }>(
      `SELECT m.room_id FROM memberships m INDEXED BY memberships_user_idx
       JOIN rooms r ON r.room_id = m.room_id
       WHERE m.user_id = ? ORDER BY r.created_log_id LIMIT ?`,
      userId, MAX_USER_ROOMS,
    ).map((row) => row.room_id);
  }

  /** Reads for userRooms(): the user's membership rows, live and awaiting purge, and a room lookup each. */
  private userRoomsReads(): number {
    return 8 + 2 * (MAX_USER_ROOMS + MAX_PURGE_ROOMS);
  }

  /** Whether an identity has this `user_id` now, one indexed read. */
  identityExists(userId: string): boolean {
    this.ensureReady();
    return this.reserved({ reads: 4 }, false, this.clock.now(), () => this.identityRow(userId) !== null);
  }

  /**
   * Whether a `user_id` may not be issued: an identity has it, or `/rename`
   * or `/purge` retired it. Registration picks ids with it.
   */
  userIdTaken(userId: string): boolean {
    this.ensureReady();
    return this.reserved({ reads: 8 }, false, this.clock.now(), () => this.idTaken(userId));
  }

  private idTaken(userId: string): boolean {
    return this.identityRow(userId) !== null || this.metaValue(META_RENAMED_PREFIX + userId) !== "" || this.metaValue(META_PURGED_PREFIX + userId) !== "";
  }

  /**
   * `/rename`: moves a registered user to a new `user_id`: the identity row,
   * its credential (so its passkey signs in as the new id), its stored
   * memberships, and its roles (a column of the row), and rewrites what they
   * left under the old id to the new one: the `from` of their logged message
   * snapshots and current messages (so they can still edit them), their
   * reaction sets, logged and current, and their logged membership changes,
   * keeping the recorded names; the rooms they created; their uploads; their push subscriptions, status and mutes;
   * their limiter windows; and their dedup rows. Nothing is announced: clients see the new id when they
   * load history again. Other users' `body.mentions`, sessions and the user's
   * bot stay under the old id. The old `user_id` is retired, never reissued.
   * Returns the user's name, joined rooms, and roles. A bot's is fixed.
   *
   * Finding the user's records scans the retained log, as `/purge` does; the
   * rewrite is then charged by what was found. Both steps run without
   * yielding, so nothing commits between them.
   */
  renameIdentity(input: { from: string; to: string; now?: number }): { name: string; avatar?: string; ext?: Record<string, unknown>; rooms: string[]; roles: string[] } {
    this.ensureReady();
    const now = input.now ?? this.clock.now();
    const { from, to } = input;
    const records = this.retainedRecords(now);
    const found = this.reserved({ reads: 64 + 8 * records + 2 * (MAX_PUSH_SUBSCRIPTIONS_PER_USER + MAX_PUSH_WAKES_PER_USER + 1 + MAX_ROOM_MUTES_PER_USER) + 2 * (MAX_ROOM_ROWS + MAX_PURGE_ROOMS) }, false, now, () => {
      const identity = this.identityRow(from);
      if (!identity || identity.tier !== "registered") throw new StoreError("invalid_params", `No registered user has the user_id ${from}`.slice(0, 200));
      if (parseRoles(identity.roles_json).includes("bot")) throw new StoreError("denied", "A bot's user_id is fixed");
      if (this.idTaken(to)) throw new StoreError("invalid_params", `The user_id ${to} is taken`.slice(0, 200));
      const count = (sql: string) => integerColumn(this.rawRows<{ count: number }>(sql, from)[0]?.count);
      return {
        identity,
        records: this.rawRows<{ room_id: string; log_id: number; kind: RecordKind; record_json: string }>(
          `SELECT room_id, log_id, kind, record_json FROM records WHERE
             (kind = 'message' AND json_extract(record_json, '$.from.user_id') = ?1)
             OR (kind = 'reactions' AND EXISTS (SELECT 1 FROM json_each(record_json, '$.reactions') WHERE json_extract(value, '$.from.user_id') = ?1))
             OR (kind = 'membership' AND EXISTS (SELECT 1 FROM json_each(record_json, '$.members') WHERE json_extract(value, '$.user.user_id') = ?1))`,
          from,
        ),
        messages: this.rawRows<{ message_id: string }>("SELECT message_id FROM message_state WHERE author_id = ?", from),
        reactions: this.rawRows<{ message_id: string; from_json: string }>("SELECT message_id, from_json FROM reaction_state WHERE user_id = ?", from),
        // Every room row is read: the creator is kept in its JSON, unindexed.
        created: this.rawRows<{ room_id: string; fields_json: string }>("SELECT room_id, fields_json FROM rooms WHERE json_extract(fields_json, '$.creator_id') = ?", from),
        uploads: count("SELECT COUNT(*) AS count FROM uploads INDEXED BY uploads_owner_idx WHERE owner_id = ?"),
        pushes: count("SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?") +
          count("SELECT COUNT(*) AS count FROM push_wakes WHERE user_id = ?") +
          count("SELECT COUNT(*) AS count FROM user_status WHERE user_id = ?") +
          count("SELECT COUNT(*) AS count FROM room_mutes WHERE user_id = ?"),
        requests: count("SELECT COUNT(*) AS count FROM accepted_requests WHERE user_id = ?"),
      };
    });
    const membershipRows = MAX_USER_ROOMS + MAX_PURGE_ROOMS;
    // Moving a row keyed or indexed by the user_id reads its index entry and
    // row and rewrites both (measured: about 2 reads and 3 writes each);
    // rewriting a record's JSON in place is one write.
    // Memberships, and as many read cursors at most.
    const moved = 2 * membershipRows + found.reactions.length + found.uploads + found.pushes + found.requests + USER_LIMIT_SCOPES.length;
    const rewritten = found.records.length + found.messages.length + found.created.length;
    const cost = { reads: 64 + 4 * moved + 2 * rewritten + this.userRoomsReads(), writes: 32 + 4 * moved + 2 * rewritten };
    return this.reserved(cost, false, now, () => this.transaction(() => {
      const renamed = (user: Identity): Identity => user.user_id === from ? { ...user, user_id: to } : user;
      this.rawExec("UPDATE identities SET user_id = ?, updated_ms = ? WHERE user_id = ?", to, this.effectiveNow(now), from);
      this.rawExec("UPDATE credentials SET user_id = ? WHERE user_id = ?", to, from);
      this.rawExec("UPDATE memberships SET user_id = ? WHERE user_id = ?", to, from);
      this.rawExec("UPDATE read_cursors SET user_id = ? WHERE user_id = ?", to, from);
      for (const row of found.created) {
        this.rawExec("UPDATE rooms SET fields_json = ? WHERE room_id = ?", JSON.stringify({ ...parseJson<Record<string, unknown>>(row.fields_json, {}), creator_id: to }), row.room_id);
      }
      for (const row of found.records) {
        const record = parseJson<Record<string, unknown>>(row.record_json);
        if (row.kind === "message") {
          const message = record as unknown as MessageSnapshot;
          this.rewriteRecord(row, JSON.stringify({ ...message, from: renamed(message.from) }));
        } else if (row.kind === "reactions") {
          const reactions = record as unknown as ReactionsRecord;
          this.rewriteRecord(row, JSON.stringify({ ...reactions, reactions: reactions.reactions.map((set) => ({ ...set, from: renamed(set.from) })) }));
        } else {
          const membership = record as unknown as MembershipRecord;
          this.rewriteRecord(row, JSON.stringify({ ...membership, members: membership.members.map((member) => ({ ...member, user: renamed(member.user) })) }));
        }
      }
      // A message's current snapshot is its latest record, renamed above.
      for (const row of found.messages) this.rawExec("UPDATE message_state SET author_id = ? WHERE message_id = ?", to, row.message_id);
      for (const row of found.reactions) {
        this.rawExec(
          "UPDATE reaction_state SET user_id = ?, from_json = ? WHERE message_id = ? AND user_id = ?",
          to, JSON.stringify(renamed(parseJson<Identity>(row.from_json))), row.message_id, from,
        );
      }
      if (found.uploads) this.rawExec("UPDATE uploads SET owner_id = ? WHERE owner_id = ?", to, from);
      if (found.pushes) {
        this.rawExec("UPDATE push_subscriptions SET user_id = ? WHERE user_id = ?", to, from);
        this.rawExec("UPDATE push_wakes SET user_id = ? WHERE user_id = ?", to, from);
        this.rawExec("UPDATE user_status SET user_id = ? WHERE user_id = ?", to, from);
        this.rawExec("UPDATE room_mutes SET user_id = ? WHERE user_id = ?", to, from);
      }
      if (found.requests) this.rawExec("UPDATE accepted_requests SET user_id = ? WHERE user_id = ?", to, from);
      // The rows move in SQL: write what their cached copies hold first, and uncache them.
      for (const scope of USER_LIMIT_SCOPES) this.limiters.writeOut(scope, `user:${from}`, now);
      for (const scope of USER_LIMIT_SCOPES) {
        this.rawExec("UPDATE principal_limits SET principal_key = ? WHERE scope = ? AND principal_key = ?", `user:${to}`, scope, `user:${from}`);
      }
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_RENAMED_PREFIX + from, to);
      const avatar = liveAvatar(found.identity, now);
      const ext = parseUserExt(found.identity.ext_json);
      return { name: found.identity.name, ...(avatar ? { avatar } : {}), ...(ext ? { ext } : {}), rooms: this.userRooms(to), roles: parseRoles(found.identity.roles_json) };
    }));
  }

  /**
   * How many records are retained, counted on the log index. Scans of the
   * log reserve reads by it. A log id is a commit time, not a sequence, so
   * the id range says nothing about the count. Past RETAINED_SCAN_CAP rows
   * the scan is refused rather than reserved. `unchecked` (an admin command
   * not held to the day's budget) counts up to what the database can hold.
   */
  private retainedRecords(now: number, unchecked = false): number {
    // Each record is a row and an index entry, well over 64 bytes.
    const cap = unchecked ? Math.ceil(this.config.storageHardTargetBytes / 64) : RETAINED_SCAN_CAP;
    return this.reserved({ reads: 16 + cap + 1 }, false, now, () => {
      const count = integerColumn(this.rawRows<{ count: number }>(
        "SELECT COUNT(*) AS count FROM (SELECT 1 FROM records INDEXED BY records_log_idx LIMIT ?)",
        cap + 1,
      )[0]?.count);
      if (count > cap) {
        throw new StoreError("retry_after", "History is too large to scan; try after cleanup", { retryAfterMs: this.config.cleanupIntervalMs });
      }
      return count;
    }, unchecked);
  }

  /**
   * The most upload rows `owner` can hold: a day's uploads for every day the
   * longest-kept kind stays, with the lifecycle's lag, and one more day. A
   * user's day is `uploadsPerUserDay`. The server's own avatar uploads
   * (SERVER_OWNER) are charged to the admins who start them, so only the
   * server-wide `uploadsPerDay` bounds them. A scan of an owner's rows by
   * `uploads_owner_idx` reads up to this many, whatever its other conditions
   * and LIMIT, since the index holds only `owner_id`.
   */
  private uploadsPerOwner(owner: string): number {
    const policy = this.config.uploads;
    if (!policy) return 0;
    const perDay = owner === SERVER_OWNER ? policy.uploadsPerDay : policy.uploadsPerUserDay;
    const keptSeconds = Math.max(policy.fileRetentionSeconds, policy.avatarRetentionSeconds) + policy.lifecycleLagSeconds;
    return perDay * (Math.ceil(keptSeconds / 86_400) + 1);
  }

  /**
   * `/purge`: removes users and everything they left, silently, with no new
   * records: their message snapshots and current messages, with every
   * reaction set on those messages; their reaction sets elsewhere; their
   * memberships and membership records; their uploads; and their identity,
   * passkey, push subscription, status, mute, limiter and dedup rows. A logged record that
   * lists them beside others (a move's reaction sets) is rewritten without
   * them. Rooms they created stay, without a creator. Each purged identity's
   * `user_id` is retired (META_PURGED_PREFIX), never reissued, so neither a
   * session still held for it nor a room it created carries over to anyone.
   * Removing the threads it leaves empty is the caller's (removeIfEmpty), as
   * it knows the connections still in them. Clients that already have their content
   * keep it until they load history again. Returns what went, and the R2
   * objects the caller deletes.
   */
  purgeUsers(input: { userIds: readonly string[]; now?: number }): { messages: number; reactions: number; deletedUploads: string[] } {
    this.ensureReady();
    const now = input.now ?? this.clock.now();
    const ids = [...new Set(input.userIds)].filter((id) => id.length > 0).slice(0, 4);
    if (!ids.length) return { messages: 0, reactions: 0, deletedUploads: [] };
    const marks = ids.map(() => "?").join(", ");
    // The scans below read at most this many rows each. Only an admin can
    // purge, so it is charged to the day's budget but never refused by it.
    const records = this.retainedRecords(now, true);
    // The most any one of them holds: purged ids are users, never SERVER_OWNER.
    const uploadsPerOwner = Math.max(...ids.map((id) => this.uploadsPerOwner(id)));
    // Per user: memberships (live and awaiting a room purge), a day's dedup
    // rows, limiter rows, push subscriptions, credential and identity; each
    // deletion also updates its indexes.
    const perUser = 64 + 8 * (MAX_USER_ROOMS + MAX_PURGE_ROOMS) + 4 * Math.max(this.config.registeredPostsPerDay, this.config.trustedPostsPerDay) + 4 * uploadsPerOwner +
      4 * (MAX_PUSH_SUBSCRIPTIONS_PER_USER + MAX_PUSH_WAKES_PER_USER + 1 + MAX_ROOM_MUTES_PER_USER);
    // Every room row is read for its creator, and each one theirs rewritten.
    const roomRows = MAX_ROOM_ROWS + MAX_PURGE_ROOMS;
    const cost = { reads: 64 + 5 * records + 2 * roomRows + ids.length * perUser, writes: 64 + 4 * records + 2 * roomRows + ids.length * perUser };
    return this.reserved(cost, false, now, () => this.transaction(() => {
      // Their records may be the newest.
      this.writeLogHead();
      const messages = this.rawRows<{ message_id: string }>(`SELECT message_id FROM message_state WHERE author_id IN (${marks})`, ...ids)
        .map((row) => row.message_id);
      const messageMarks = messages.map(() => "?").join(", ");
      const purgedMessage = messages.length ? `json_extract(record_json, '$.message_id') IN (${messageMarks})` : "0";
      const reactionRecords = this.rawRows<{ room_id: string; log_id: number; record_json: string }>(
        `SELECT room_id, log_id, record_json FROM records WHERE kind = 'reactions' AND (${purgedMessage} OR EXISTS (
           SELECT 1 FROM json_each(record_json, '$.reactions') WHERE json_extract(value, '$.from.user_id') IN (${marks})))`,
        ...messages, ...ids,
      );
      for (const row of reactionRecords) {
        const record = parseJson<ReactionsRecord>(row.record_json);
        const reactions = messages.includes(record.message_id) ? [] : record.reactions.filter((set) => !ids.includes(set.from.user_id));
        this.rewriteRecord(row, reactions.length ? JSON.stringify({ ...record, reactions }) : null);
      }
      this.rawExec(`DELETE FROM records WHERE kind = 'message' AND json_extract(record_json, '$.from.user_id') IN (${marks})`, ...ids);
      const membershipRecords = this.rawRows<{ room_id: string; log_id: number; record_json: string }>(
        `SELECT room_id, log_id, record_json FROM records WHERE kind = 'membership' AND EXISTS (
           SELECT 1 FROM json_each(record_json, '$.members') WHERE json_extract(value, '$.user.user_id') IN (${marks}))`,
        ...ids,
      );
      for (const row of membershipRecords) {
        const record = parseJson<MembershipRecord>(row.record_json);
        const members = record.members.filter((member) => !ids.includes(member.user.user_id));
        this.rewriteRecord(row, members.length ? JSON.stringify({ ...record, members }) : null);
      }
      const reactions = this.rawRows<{ count: number }>(
        `SELECT COUNT(*) AS count FROM reaction_state WHERE user_id IN (${marks})`, ...ids,
      )[0]?.count ?? 0;
      this.rawExec(`DELETE FROM reaction_state WHERE user_id IN (${marks})`, ...ids);
      if (messages.length) this.rawExec(`DELETE FROM reaction_state WHERE message_id IN (${messageMarks})`, ...messages);
      this.rawExec(`DELETE FROM message_state WHERE author_id IN (${marks})`, ...ids);
      const uploads = this.rawRows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
         FROM uploads INDEXED BY uploads_owner_idx WHERE owner_id IN (${marks})`,
        ...ids,
      );
      const deletedUploads = this.releaseUploadRows(uploads);
      const retired = this.rawRows<{ user_id: string }>(`SELECT user_id FROM identities WHERE user_id IN (${marks})`, ...ids).map((row) => row.user_id);
      const identities = retired.length;
      // Their rooms' member counts drop by the memberships deleted below.
      this.rawExec(
        `UPDATE rooms SET member_count = MAX(0, member_count - (SELECT COUNT(*) FROM memberships m WHERE m.room_id = rooms.room_id AND m.user_id IN (${marks})))
         WHERE room_id IN (SELECT room_id FROM memberships INDEXED BY memberships_user_idx WHERE user_id IN (${marks}))`,
        ...ids, ...ids,
      );
      this.rawExec(`UPDATE rooms SET fields_json = json_remove(fields_json, '$.creator_id') WHERE json_extract(fields_json, '$.creator_id') IN (${marks})`, ...ids);
      for (const table of ["memberships", "read_cursors", "credentials", "push_subscriptions", "push_wakes", "user_status", "room_mutes", "accepted_requests", "identities"]) {
        this.rawExec(`DELETE FROM ${table} WHERE user_id IN (${marks})`, ...ids);
      }
      // Their limiter rows, by primary key, and the count the cap reads lowered by as many.
      const limiterWhere = `scope IN (${USER_LIMIT_SCOPES.map(() => "?").join(", ")}) AND principal_key IN (${marks})`;
      const limiterKeys = [...USER_LIMIT_SCOPES, ...ids.map((id) => `user:${id}`)];
      const limiters = integerColumn(this.rawRows<{ count: number }>(`SELECT COUNT(*) AS count FROM principal_limits WHERE ${limiterWhere}`, ...limiterKeys)[0]?.count);
      if (limiters) {
        this.rawExec(`DELETE FROM principal_limits WHERE ${limiterWhere}`, ...limiterKeys);
        this.rawExec("UPDATE _meta SET value = ? WHERE key = 'principal_limit_count'", String(Math.max(0, this.metaNumber("principal_limit_count") - limiters)));
      }
      for (const id of ids) this.limiters.dropPrincipal(`user:${id}`);
      for (const userId of retired) this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, '1')", META_PURGED_PREFIX + userId);
      if (identities) this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('identity_count', ?)", String(Math.max(0, this.metaNumber("identity_count") - identities)));
      return { messages: messages.length, reactions: integerColumn(reactions), deletedUploads };
    }), true);
  }

  /**
   * Writes the log's head as kept here (logCache) to `log_state`, with
   * `floor` as its history floor if given, before records are deleted:
   * otherwise the newest record, which a later wake reads the head from,
   * may be one of them, and log IDs already issued would be issued again.
   */
  private writeLogHead(floor?: number): RawLogState {
    const head = this.logState();
    this.rawExec("UPDATE log_state SET history_floor = ?, last_log_id = MAX(last_log_id, ?), last_commit_ms = MAX(last_commit_ms, ?) WHERE id = 1",
      floor ?? head.history_floor, head.last_log_id, head.last_commit_ms);
    return head;
  }

  /** Replaces one logged record's JSON, or deletes the record when `json` is null. */
  private rewriteRecord(row: { room_id: string; log_id: number }, json: string | null): void {
    if (json === null) this.rawExec("DELETE FROM records WHERE room_id = ? AND log_id = ?", row.room_id, row.log_id);
    else this.rawExec("UPDATE records SET record_json = ? WHERE room_id = ? AND log_id = ?", json, row.room_id, row.log_id);
  }

  getIdentity(userId: string): StoredIdentity | null {
    this.ensureReady();
    return this.reserved({ reads: 16 + this.userRoomsReads() }, false, this.clock.now(), () => {
      const row = this.identityRow(userId);
      if (!row) return null;
      const count = this.rawRows<{ count: number }>("SELECT COUNT(*) AS count FROM credentials WHERE user_id = ? LIMIT 1", userId)[0];
      const credentialCount = integerColumn(count?.count);
      const avatar = liveAvatar(row, this.clock.now());
      const ext = parseUserExt(row.ext_json);
      const seen = seenColumn(row.seen_ms);
      return {
        userId: row.user_id,
        name: row.name,
        userHandle: row.user_handle,
        credentialCount,
        rooms: this.userRooms(userId),
        roles: parseRoles(row.roles_json),
        ...(avatar ? { avatar } : {}),
        ...(ext ? { ext } : {}),
        ...(seen !== undefined ? { seen } : {}),
      };
    });
  }

  /**
   * The registered members of each room (§4.2.1), as `user_id` with the
   * current `name` (`""` when removed), live `avatar`, and `roles`, in
   * `user_id` order: at most `limit` per room, read from the room's
   * primary-key range with one identity lookup each. With `withStatus`, each
   * also carries the `status` it chose (`choice`), from its `user_status`
   * row, joined by primary key: a member without one costs nothing more;
   * and its `seen`, from the identity row read anyway.
   * Guests' memberships are not stored; the caller adds connected ones.
   *
   * With `memberCacheMs`, a room's rows are kept in memory that long and
   * reused, with no SQL and no reservation, until a write to `identities`,
   * `memberships` or `user_status` (see rawExec). Avatars are judged against
   * `now` on every call, so a reused row is never more out of date than a
   * fresh read.
   */
  roomMembers(
    roomIds: readonly string[], limit: number, now = this.clock.now(),
    /** Filled, for each room whose listing reached `limit`, with its count of registered members. */
    counts?: Map<string, number>,
    withStatus = false,
  ): Map<string, RoomMember[]> {
    this.ensureReady();
    // A listing holds the public rooms and the caller's private ones.
    const ids = [...new Set(roomIds)].slice(0, MAX_USER_ROOMS);
    const perRoom = Math.max(0, Math.floor(limit));
    const members = new Map<string, RoomMember[]>();
    if (!ids.length || perRoom === 0) return members;
    const ttl = this.config.memberCacheMs ?? 0;
    const cached = (roomId: string) => {
      const entry = this.memberCache.get(roomId);
      return entry && entry.generation === this.memberGeneration && entry.perRoom === perRoom && entry.withStatus === withStatus &&
        (entry.counted || !counts) && now >= entry.at && now - entry.at < ttl ? entry : undefined;
    };
    const missing = ids.filter((roomId) => !cached(roomId));
    if (missing.length) {
      // Each member's status adds its `user_status` row, when it has one:
      // measured at one more read a member at worst.
      this.reserved({ reads: 8 + missing.length * (4 + (withStatus ? 3 : 2) * perRoom) }, false, now, () => {
        const generation = this.memberGeneration;
        if (this.memberCache.size > 2 * MAX_USER_ROOMS) this.memberCache.clear();
        for (const roomId of missing) {
          const rows = this.rawRows<RawMemberRow>(
            withStatus
              ? `SELECT m.user_id, i.name, i.avatar_url, i.avatar_expires_ms, i.roles_json, i.ext_json, i.seen_ms, s.status
                 FROM memberships m LEFT JOIN identities i ON i.user_id = m.user_id LEFT JOIN user_status s ON s.user_id = m.user_id
                 WHERE m.room_id = ? ORDER BY m.user_id LIMIT ?`
              : `SELECT m.user_id, i.name, i.avatar_url, i.avatar_expires_ms, i.roles_json, i.ext_json FROM memberships m LEFT JOIN identities i ON i.user_id = m.user_id
                 WHERE m.room_id = ? ORDER BY m.user_id LIMIT ?`,
            roomId, perRoom,
          );
          // A full page may be truncated: the room row's count, one read, says.
          let count: number | undefined;
          if (counts && rows.length >= perRoom) {
            const row = this.rawRows<{ member_count: number }>("SELECT member_count FROM rooms WHERE room_id = ? LIMIT 1", roomId)[0];
            if (row) count = Math.max(rows.length, integerColumn(row.member_count));
          }
          const entry = { at: now, generation, perRoom, withStatus, rows, counted: counts !== undefined, ...(count !== undefined ? { count } : {}) };
          if (ttl > 0) this.memberCache.set(roomId, entry);
          else this.uncachedMembers.set(roomId, entry);
        }
      });
    }
    for (const roomId of ids) {
      const entry = cached(roomId) ?? this.uncachedMembers.get(roomId);
      if (!entry) continue;
      if (entry.rows.length) {
        members.set(roomId, entry.rows.map((row) => {
          const avatar = liveAvatar(row, now);
          const ext = parseUserExt(row.ext_json);
          return {
            user_id: row.user_id, name: row.name ?? "", ...(avatar ? { avatar } : {}), roles: parseRoles(row.roles_json),
            ...(ext ? { ext } : {}),
            ...(withStatus ? statusColumns(row) : {}),
          };
        }));
      }
      if (counts && entry.count !== undefined) counts.set(roomId, entry.count);
    }
    this.uncachedMembers.clear();
    return members;
  }

  /** One registered member of a room, for `room_list` with `user_id` (§4.2.1), or null when they aren't one. */
  roomMember(roomId: string, userId: string, now = this.clock.now(), withStatus = false): RoomMember | null {
    this.ensureReady();
    return this.reserved({ reads: 8 + (withStatus ? 3 : 2) }, false, now, () => {
      const row = this.rawRows<RawMemberRow>(
        withStatus
          ? `SELECT m.user_id, i.name, i.avatar_url, i.avatar_expires_ms, i.roles_json, i.ext_json, i.seen_ms, s.status
             FROM memberships m LEFT JOIN identities i ON i.user_id = m.user_id LEFT JOIN user_status s ON s.user_id = m.user_id
             WHERE m.room_id = ? AND m.user_id = ? LIMIT 1`
          : `SELECT m.user_id, i.name, i.avatar_url, i.avatar_expires_ms, i.roles_json, i.ext_json FROM memberships m LEFT JOIN identities i ON i.user_id = m.user_id
             WHERE m.room_id = ? AND m.user_id = ? LIMIT 1`,
        roomId, userId,
      )[0];
      if (!row) return null;
      const avatar = liveAvatar(row, now);
      const ext = parseUserExt(row.ext_json);
      return {
        user_id: row.user_id, name: row.name ?? "", ...(avatar ? { avatar } : {}), roles: parseRoles(row.roles_json),
        ...(ext ? { ext } : {}),
        ...(withStatus ? statusColumns(row) : {}),
      };
    });
  }

  getCredential(credentialId: string): StoredCredential | null {
    this.ensureReady();
    return this.reserved({ reads: 8 }, false, this.clock.now(), () => this.credentialValue(credentialId));
  }

  private credentialValue(credentialId: string): StoredCredential | null {
    const rows = this.rawRows<RawCredentialRow>(
      "SELECT credential_id, user_id, public_key_json, sign_count, transports_json FROM credentials WHERE credential_id = ? LIMIT 1",
      credentialId,
    );
    if (!rows.length) return null;
    const row = rows[0];
    const metadata = parseJson<Record<string, unknown>>(row.public_key_json);
    return {
      credentialId: row.credential_id,
      userId: row.user_id,
      publicKey: typeof metadata.publicKey === "string" ? metadata.publicKey : row.public_key_json,
      counter: row.sign_count,
      ...(Array.isArray(metadata.transports) ? { transports: metadata.transports.filter((item): item is string => typeof item === "string") } : {}),
      ...(typeof metadata.deviceType === "string" ? { deviceType: metadata.deviceType } : {}),
      ...(typeof metadata.backedUp === "boolean" ? { backedUp: metadata.backedUp } : {}),
    };
  }

  countIdentities(): number {
    this.ensureReady();
    return this.reserved({ reads: 8 }, false, this.clock.now(), () => this.metaNumber("identity_count"));
  }

  private dedupRow(userId: string, requestId: string, now: number): RawDedupRow | null {
    const rows = this.rawRows<RawDedupRow>(
      "SELECT user_id, request_id, digest, result_json, transition_json, expires_ms FROM accepted_requests WHERE user_id = ? AND request_id = ? AND expires_ms > ? LIMIT 1",
      userId,
      requestId,
      now,
    );
    return rows[0] ?? null;
  }

  private parseEventList(value: string | null | undefined): number[] {
    const parsed = parseJson<unknown[]>(value ?? "[]", []);
    return parsed.filter((item): item is number => typeof item === "number" && Number.isSafeInteger(item));
  }

  private limitRow(scope: string, principalKey: string, now: number): RawLimitRow {
    const hit = this.limiters.get(scope, principalKey);
    if (hit) return hit;
    const rows = this.rawRows<RawLimitRow>(
      `SELECT scope, principal_key, level, level_ms, day, posts_day, registrations_day, uploads_day, updated_ms
       FROM principal_limits WHERE scope = ? AND principal_key = ? LIMIT 1`,
      scope,
      principalKey,
    );
    if (rows.length) {
      this.limiters.loaded(rows[0], now);
      return rows[0];
    }
    if (this.metaNumber("principal_limit_count") >= this.config.principalLimitCap) {
      throw new StoreError("retry_after", "Demo capacity reached", { retryAfterMs: 60_000 });
    }
    this.ensureGrowthCapacity(4096);
    const day = dayFor(now);
    this.rawExec(
      `INSERT INTO principal_limits (scope, principal_key, level, level_ms, day, posts_day, registrations_day, updated_ms)
       VALUES (?, ?, 0, 0, ?, 0, 0, ?)`,
      scope,
      principalKey,
      day,
      now,
    );
    const count = String(this.metaNumber("principal_limit_count") + 1);
    // Every schema seeds the count; one missing (an operator's edit) is written back, so the cap still applies.
    if (this.rawExec("UPDATE _meta SET value = ? WHERE key = 'principal_limit_count'", count).rowsWritten === 0) {
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('principal_limit_count', ?)", count);
    }
    const row: RawLimitRow = {
      scope,
      principal_key: principalKey,
      level: 0,
      level_ms: 0,
      day,
      posts_day: 0,
      registrations_day: 0,
      uploads_day: 0,
      updated_ms: now,
    };
    this.limiters.loaded(row, now);
    return row;
  }

  private writeLimitRow(next: RawLimitRow, now: number, touch: boolean): void {
    this.rawExec(
      `UPDATE principal_limits SET level = ?, level_ms = ?, day = ?, posts_day = ?, registrations_day = ?, uploads_day = ?${touch ? ", updated_ms = ?" : ""}
       WHERE scope = ? AND principal_key = ?`,
      next.level,
      next.level_ms,
      next.day,
      next.posts_day,
      next.registrations_day,
      next.uploads_day,
      ...(touch ? [now] : []),
      next.scope,
      next.principal_key,
    );
  }

  /**
   * Changes a limiter row's counters, charging `weight` events. A cached row
   * (limiter-cache.ts) changes in memory and is written once a minute or
   * every few events. Another is written now;
   * its `updated_ms`, which cleanup finds idle rows by, moves only when it is
   * a minute old or from an earlier UTC day, sparing its index entry
   * otherwise (LIMITER_IDLE_MS).
   */
  private updateLimitRow(row: RawLimitRow, updates: Partial<RawLimitRow>, now: number, weight = 1): void {
    const next = { ...row, ...updates };
    if (this.limiters.covers(row.scope, row.principal_key)) {
      this.limiters.change(next, now, weight);
      return;
    }
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    this.writeLimitRow(next, now, row.updated_ms < now - MINUTE_MS || row.updated_ms < dayStart);
  }

  /**
   * Charges `weight` posts (one by default) to the poster's, the IP's and
   * the global windows, or none when any of them lacks room for all of
   * them. A trusted user, registered and holding any role (`friend`,
   * MODERATOR_ROLES, or any label: only an admin gives roles; one identity
   * read), is held to the trusted limits instead of the registered ones,
   * and their IP to the larger of its own and those, so the IP's limits
   * don't undercut them (moving a long conversation into a thread is one
   * post per message, and more for one with many reactors:
   * MOVE_REACTION_SETS_PER_POST). An owner's bot (tier `bot`) is never
   * trusted. The global limits hold for everyone. A refusal names the
   * `write` category (extension `ext:limits`), unless `uncategorized`: a
   * `me` request, which the `write` row does not list.
   */
  private chargePosting(input: { userId: string; tier: Tier; ipKey: string; now: number; weight?: number; uncategorized?: boolean }): void {
    const { userId, tier, ipKey, now } = input;
    const weight = Math.max(1, input.weight ?? 1);
    const trusted = tier === "registered" && this.holdsAnyRole(userId);
    const perUser = trusted
      ? { minute: this.config.trustedPostsPerMinute, day: this.config.trustedPostsPerDay }
      : tier === "registered"
        ? { minute: this.config.registeredPostsPerMinute, day: this.config.registeredPostsPerDay }
        : { minute: this.config.anonymousPostsPerMinute, day: this.config.anonymousPostsPerDay };
    const perIp = trusted
      ? { minute: Math.max(this.config.ipPostsPerMinute, this.config.trustedPostsPerMinute), day: Math.max(this.config.ipPostsPerDay, this.config.trustedPostsPerDay) }
      : { minute: this.config.ipPostsPerMinute, day: this.config.ipPostsPerDay };
    const principal = tier === "registered" ? `user:${userId}` : `anonymous:${ipKey}`;
    const rows = [
      this.limitRow("post", principal, now),
      this.limitRow("post", `ip:${ipKey}`, now),
      this.limitRow("post", "global", now),
    ];
    const daily = dayFor(now);
    let retryAfterMs = 0;
    let reason = "Posting limit reached";
    const charged: Bucket[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const allowance = index === 0 ? perUser.minute : index === 1 ? perIp.minute : this.config.globalPostsPerMinute;
      const dailyAllowance = index === 0 ? perUser.day : index === 1 ? perIp.day : this.config.globalPostsPerDay;
      const minute = chargeBucket(bucketOf(row), now, { perMinute: allowance }, weight);
      if ("retryAfterMs" in minute) {
        const retry = Math.max(1, minute.retryAfterMs);
        if (retry > retryAfterMs) {
          retryAfterMs = retry;
          reason = index === 0 && tier === "anonymous" ? "Guest posting limit reached" : "Posting limit reached";
        }
      } else {
        charged.push(minute.bucket);
      }
      const count = row.day === daily ? row.posts_day : 0;
      if (count + weight > dailyAllowance) {
        const retry = Math.max(1, 86_400_000 - now % 86_400_000);
        if (retry > retryAfterMs) {
          retryAfterMs = retry;
          reason = index === 2 ? "Daily posting limit reached for the server" : "Daily posting limit reached";
        }
      }
    }
    if (retryAfterMs > 0) throw new StoreError("retry_after", reason, { retryAfterMs, ...(input.uncategorized ? {} : { data: limitData("write") }) });
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const dailyCount = (row.day === daily ? row.posts_day : 0) + weight;
      this.updateLimitRow(row, { ...bucketRow(charged[index]), day: daily, posts_day: dailyCount }, now, weight);
    }
  }

  /**
   * Charges one event to a principal's `scope` limiter at `rate`, and, with
   * `perDay`, to its count for the UTC day (kept in `posts_day`; the scope
   * separates it from posts), or neither when either is full. A refusal
   * names `category`, if any, as `ext.limits` (limitData).
   */
  private chargeEvent(scope: string, principalKey: string, now: number, rate: Rate, message: string, perDay?: { limit: number; message: string }, category?: LimitCategory): void {
    const data = category ? limitData(category) : undefined;
    const row = this.limitRow(scope, principalKey, now);
    const day = dayFor(now);
    const count = row.day === day ? row.posts_day : 0;
    if (perDay && count >= perDay.limit) {
      throw new StoreError("retry_after", perDay.message, { retryAfterMs: Math.max(1000, 86_400_000 - now % 86_400_000), data });
    }
    const charged = chargeBucket(bucketOf(row), now, rate);
    if ("retryAfterMs" in charged) throw new StoreError("retry_after", message, { retryAfterMs: Math.max(1000, charged.retryAfterMs), data });
    this.updateLimitRow(row, perDay ? { ...bucketRow(charged.bucket), day, posts_day: count + 1 } : bucketRow(charged.bucket), now);
  }

  reserveAuthAttempt(input: { ipKey: string; now: number }): void {
    this.ensureReady();
    // Frames are reserved by reserveFrames at the websocket boundary.  Keep
    // the auth operation's SQL reservation separate so one frame is not
    // charged twice.
    this.reserved({ ...this.config.authCost, frames: 0, reads: Math.max(32, this.config.authCost.reads ?? 0), writes: Math.max(16, this.config.authCost.writes ?? 0) }, false, input.now, () => {
      const effective = this.effectiveNow(input.now);
      this.transaction(() => {
        this.chargeEvent("auth", `ip:${input.ipKey}`, effective, { perMinute: this.config.authAttemptsPerIpMinute }, "Authentication attempts limited");
      });
    });
  }

  /**
   * Durably reserve the next `count` guest numbers and return them as the
   * half-open range [first, limit). The stored high-water mark advances by
   * `count` in one write, so numbers handed out from the range are never
   * reissued, even after a restart, eviction, or hibernation wake loses the
   * caller's in-memory range: the next call reserves past it, leaving a gap.
   * Synchronous, like every Store call, so callers in one object cannot
   * interleave two reservations.
   */
  reserveGuestNumbers(count: number, now = this.clock.now()): { first: number; limit: number } {
    this.ensureReady();
    if (!Number.isSafeInteger(count) || count <= 0) throw new StoreError("invalid_params", "guest number block must be a positive safe integer");
    return this.reserved(GUEST_NUMBER_BLOCK_COST, false, now, () => this.transaction(() => {
      const mark = this.metaNumber(META_GUEST_NUMBER_MARK);
      if (mark > MAX_SAFE_ID - count - 1) throw new StoreError("internal_error", "guest numbers are exhausted");
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_GUEST_NUMBER_MARK, String(mark + count));
      return { first: mark + 1, limit: mark + count + 1 };
    }));
  }

  reserveFrames(input: { ipKey: string; now: number; count?: number }): void {
    this.ensureReady();
    const count = Math.max(1, Math.floor(input.count ?? 1));
    if (count > this.config.framesPerIpMinute || count > this.config.processedFramesPerDay) {
      throw new StoreError("invalid_params", "frame reservation is too large");
    }
    this.reserved({ reads: 16 + count * 4, writes: 16, frames: count }, false, input.now, () => {
      const effective = this.effectiveNow(input.now);
      this.transaction(() => {
        const row = this.limitRow("frames", `ip:${input.ipKey}`, effective);
        const charged = chargeBucket(bucketOf(row), effective, { perMinute: this.config.framesPerIpMinute }, count);
        if ("retryAfterMs" in charged) {
          throw new StoreError("retry_after", "Frame rate limit reached", { retryAfterMs: Math.max(1000, charged.retryAfterMs) });
        }
        this.updateLimitRow(row, bucketRow(charged.bucket), effective, count);
        const global = this.limitRow("frames", "global", effective);
        const day = dayFor(effective);
        const globalCount = global.day === day ? global.posts_day : 0;
        if (globalCount + count > this.config.processedFramesPerDay) {
          throw new StoreError("retry_after", "Daily frame budget exhausted", { retryAfterMs: 86_400_000, data: { reason: "frame_budget" } });
        }
        this.updateLimitRow(global, { day, posts_day: globalCount + count }, effective);
      });
    });
  }

  private chargeRegistration(ipKey: string, now: number): void {
    const day = dayFor(now);
    const ip = this.limitRow("registration", `ip:${ipKey}`, now);
    const global = this.limitRow("registration", "global", now);
    const ipCount = ip.day === day ? ip.registrations_day : 0;
    const globalCount = global.day === day ? global.registrations_day : 0;
    const retryAfterMs = Math.max(1, 86_400_000 - now % 86_400_000);
    if (ipCount >= this.config.registrationsPerIpDay) {
      throw new StoreError("retry_after", "Registration limit reached for this network", { retryAfterMs });
    }
    if (globalCount >= this.config.registrationsPerDay) {
      throw new StoreError("retry_after", "Registration limit reached", { retryAfterMs });
    }
    this.updateLimitRow(ip, { day, registrations_day: ipCount + 1 }, now);
    this.updateLimitRow(global, { day, registrations_day: globalCount + 1 }, now);
  }

  /**
   * Registers an identity and its credential. The identity starts in the
   * given rooms that still exist (the guest's it replaces, or `general`), and
   * each start is a logged membership (§4.2.2), returned in `broadcasts` for
   * the caller to deliver to the rooms' members.
   */
  registerIdentity(input: {
    userId: string;
    name: string;
    userHandle: string;
    credential: StoredCredential;
    now: number;
    ipKey: string;
    /** The rooms the new identity starts in, such as the guest's it replaces. */
    rooms?: readonly string[];
  }): StoredIdentity & { broadcasts: Broadcast[] } {
    this.ensureReady();
    const { credential } = input;
    this.assertAccounting();
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    // The starting rooms are checked against the capped rooms table, and each
    // one takes a membership row and a logged membership record.
    const rooms = MAX_THREAD_LIMIT + 1;
    const reservation = this.reserveCost({ reads: 128 + 2 * rooms, writes: 64 + 8 * rooms, registrations: 1 }, false, input.now);
    try {
      if (!input.userId || !input.userHandle || !input.ipKey) throw new StoreError("invalid_params", "registration identity is incomplete");
      ensureText(input.name, "name", this.config.maxNameBytes);
      if ([...input.name].length > this.config.maxNameCodePoints) throw new StoreError("too_large", "name is too long");
      ensureText(credential.credentialId, "credential_id", 16 * 1024);
      ensureText(credential.publicKey, "public_key", 16 * 1024);
      if (this.identityRow(input.userId)) throw new StoreError("invalid_params", "identity already exists");
      if (this.credentialValue(credential.credentialId)) throw new StoreError("denied", "credential is already registered");
      if (this.metaNumber("identity_count") >= this.config.registeredIdentityCount) {
        throw new StoreError("denied", "registration_closed");
      }
      this.ensureGrowthCapacity(this.config.maxSnapshotBytes);
      const effective = this.effectiveNow(input.now);
      return this.transaction(() => {
        const beforeCommit = <T>(value: T): T => {
          this.assertStorageTarget();
          this.assertReservation(reservation, beforeReads, beforeWrites);
          return value;
        };
        // Recheck all persistent caps in the transaction immediately before the
        // credential is made usable; concurrent verification cannot overrun caps.
        if (this.idTaken(input.userId)) throw new StoreError("invalid_params", "identity already exists");
        if (this.credentialValue(credential.credentialId)) throw new StoreError("denied", "credential is already registered");
        if (this.metaNumber("identity_count") >= this.config.registeredIdentityCount) throw new StoreError("denied", "registration_closed");
        this.chargeRegistration(input.ipKey, effective);
        const joined = this.existingRooms(input.rooms ?? DEFAULT_JOINED_ROOMS);
        const publicKeyMetadata = JSON.stringify({
          publicKey: credential.publicKey,
          ...(credential.transports ? { transports: credential.transports } : {}),
          ...(credential.deviceType ? { deviceType: credential.deviceType } : {}),
          ...(credential.backedUp !== undefined ? { backedUp: credential.backedUp } : {}),
        });
        this.rawExec(
          "INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms) VALUES (?, ?, ?, 'registered', ?, ?)",
          input.userId,
          input.userHandle,
          input.name,
          effective,
          effective,
        );
        this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('identity_count', ?)", String(this.metaNumber("identity_count") + 1));
        this.rawExec(
          `INSERT INTO credentials
           (credential_id, user_id, public_key_json, sign_count, transports_json, created_ms, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          credential.credentialId,
          input.userId,
          publicKeyMetadata,
          Math.max(0, Math.floor(credential.counter)),
          credential.transports ? JSON.stringify(credential.transports) : null,
          effective,
          effective,
        );
        const broadcasts: Broadcast[] = [];
        if (joined.length) {
          const state = this.logState();
          const startLogId = state.last_log_id;
          const context: CommitContext = { state, commitMs: Math.max(effective, state.last_commit_ms), touched: new Map() };
          const user = recordedUser(input.userId, input.name);
          for (const roomId of joined) {
            this.rawExec("INSERT OR IGNORE INTO memberships (room_id, user_id) VALUES (?, ?)", roomId, input.userId);
            broadcasts.push(this.logMembership(context, roomId, user, true));
          }
          this.finishCommit(context, startLogId);
        }
        return beforeCommit({
          userId: input.userId,
          name: input.name,
          userHandle: input.userHandle,
          credentialCount: 1,
          rooms: joined,
          roles: [],
          broadcasts,
        });
      });
    } finally {
      this.settleReservation(reservation, beforeReads, beforeWrites);
    }
  }

  /**
   * Adds a passkey to a registered identity that is signed in (§4.10): a
   * registration on a connection already signed in adds to that account.
   * Bots sign in with their token and take none. At most
   * MAX_PASSKEYS_PER_USER per identity; a credential already registered
   * anywhere is `invalid_params`. Charged as a registration against the
   * per-IP and daily caps, which bound the rows this can write, but not
   * against the identity count. An identity without a passkey yet (an
   * invited user, or `admin`) takes `userHandle` as its WebAuthn user handle.
   */
  addCredential(input: { userId: string; userHandle: string; credential: StoredCredential; now: number; ipKey: string }): { userId: string; name: string } {
    this.ensureReady();
    const { credential } = input;
    this.assertAccounting();
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    const reservation = this.reserveCost({ reads: 96, writes: 48, registrations: 1 }, false, input.now);
    try {
      ensureText(credential.credentialId, "credential_id", 16 * 1024);
      ensureText(credential.publicKey, "public_key", 16 * 1024);
      this.ensureGrowthCapacity(this.config.maxSnapshotBytes);
      const effective = this.effectiveNow(input.now);
      return this.transaction(() => {
        const identity = this.identityRow(input.userId);
        if (!identity || identity.tier !== "registered" || parseRoles(identity.roles_json).includes("bot")) throw new StoreError("denied", "Only a registered user can add a passkey");
        if (identity.user_id === ADMIN_USER_ID) throw new StoreError("denied", "The admin user signs in with APRON_ADMIN_TOKEN only");
        if (this.credentialValue(credential.credentialId)) throw new StoreError("denied", "credential is already registered");
        const count = integerColumn(this.rawRows<{ count: number }>(
          "SELECT COUNT(*) AS count FROM (SELECT 1 FROM credentials WHERE user_id = ? LIMIT ?)", input.userId, MAX_PASSKEYS_PER_USER,
        )[0]?.count);
        if (count >= MAX_PASSKEYS_PER_USER) throw new StoreError("denied", `An account holds at most ${MAX_PASSKEYS_PER_USER} passkeys`);
        this.chargeRegistration(input.ipKey, effective);
        this.rawExec(
          `INSERT INTO credentials
           (credential_id, user_id, public_key_json, sign_count, transports_json, created_ms, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          credential.credentialId,
          input.userId,
          JSON.stringify({
            publicKey: credential.publicKey,
            ...(credential.transports ? { transports: credential.transports } : {}),
            ...(credential.deviceType ? { deviceType: credential.deviceType } : {}),
            ...(credential.backedUp !== undefined ? { backedUp: credential.backedUp } : {}),
          }),
          Math.max(0, Math.floor(credential.counter)),
          credential.transports ? JSON.stringify(credential.transports) : null,
          effective,
          effective,
        );
        if (!identity.user_handle) this.rawExec("UPDATE identities SET user_handle = ?, updated_ms = ? WHERE user_id = ?", input.userHandle, effective, input.userId);
        this.assertStorageTarget();
        this.assertReservation(reservation, beforeReads, beforeWrites);
        return { userId: identity.user_id, name: identity.name };
      });
    } finally {
      this.settleReservation(reservation, beforeReads, beforeWrites);
    }
  }

  /**
   * The WebAuthn user handle an identity's passkeys share: its stored one,
   * or, for an identity with none yet (an invited user), `candidate`, stored
   * now so concurrent ceremonies for it share one handle. One conditional
   * write at most.
   */
  ensureUserHandle(userId: string, candidate: string, now = this.clock.now()): string | null {
    this.ensureReady();
    return this.reserved({ reads: 8, writes: 8 }, false, now, () => this.transaction(() => {
      const identity = this.identityRow(userId);
      if (!identity) return null;
      if (identity.user_handle) return identity.user_handle;
      this.rawExec("UPDATE identities SET user_handle = ?, updated_ms = ? WHERE user_id = ? AND user_handle = ''", candidate, this.effectiveNow(now), userId);
      return candidate;
    }));
  }

  /** An identity's passkeys, oldest first: at most MAX_PASSKEYS_PER_USER, for `/passkeys`. */
  passkeys(userId: string, now = this.clock.now()): Array<{ credentialId: string; createdMs: number; usedMs: number }> {
    this.ensureReady();
    return this.reserved({ reads: 8 + 2 * MAX_PASSKEYS_PER_USER }, false, now, () => this.rawRows<{ credential_id: string; created_ms: number; updated_ms: number }>(
      "SELECT credential_id, created_ms, updated_ms FROM credentials INDEXED BY credentials_user_idx WHERE user_id = ? ORDER BY created_ms, credential_id LIMIT ?",
      userId, MAX_PASSKEYS_PER_USER,
    ).map((row) => ({ credentialId: row.credential_id, createdMs: row.created_ms, usedMs: row.updated_ms })));
  }

  /**
   * Removes one of an identity's passkeys, for `/passkeys remove`. Not the
   * last one, which would leave a passkey user no way back in once their
   * session ends. Returns whether it was removed.
   */
  removePasskey(input: { userId: string; credentialId: string; now?: number }): boolean {
    this.ensureReady();
    return this.reserved({ reads: 8 + 2 * MAX_PASSKEYS_PER_USER, writes: 16 }, false, input.now ?? this.clock.now(), () => this.transaction(() => {
      const count = integerColumn(this.rawRows<{ count: number }>(
        "SELECT COUNT(*) AS count FROM (SELECT 1 FROM credentials WHERE user_id = ? LIMIT ?)", input.userId, MAX_PASSKEYS_PER_USER + 1,
      )[0]?.count);
      if (!this.rawRows("SELECT 1 FROM credentials WHERE credential_id = ? AND user_id = ? LIMIT 1", input.credentialId, input.userId).length) return false;
      if (count <= 1) throw new StoreError("denied", "You can't remove your only passkey");
      this.rawExec("DELETE FROM credentials WHERE credential_id = ? AND user_id = ?", input.credentialId, input.userId);
      return true;
    }));
  }

  /**
   * Removes every passkey of an identity and clears its WebAuthn user
   * handle, for `/invite-purge`: the passkey sessions issued under the old
   * handle no longer resume, and a passkey registered later takes a new one.
   * Returns how many passkeys were removed.
   */
  resetAuth(input: { userId: string; now?: number }): number {
    this.ensureReady();
    const now = input.now ?? this.clock.now();
    return this.reserved({ reads: 16 + 2 * MAX_PASSKEYS_PER_USER, writes: 16 + 4 * MAX_PASSKEYS_PER_USER }, false, now, () => this.transaction(() => {
      const count = integerColumn(this.rawRows<{ count: number }>(
        "SELECT COUNT(*) AS count FROM (SELECT 1 FROM credentials WHERE user_id = ? LIMIT ?)", input.userId, MAX_PASSKEYS_PER_USER,
      )[0]?.count);
      if (count) this.rawExec("DELETE FROM credentials WHERE user_id = ?", input.userId);
      this.rawExec("UPDATE identities SET user_handle = '', updated_ms = ? WHERE user_id = ? AND user_handle != ''", this.effectiveNow(now), input.userId);
      return count;
    }));
  }

  credentialIdsForUser(userId: string): string[] {
    this.ensureReady();
    return this.reserved({ reads: 32 }, false, this.clock.now(), () => {
      const rows = this.rawRows<{ credential_id: string }>("SELECT credential_id FROM credentials WHERE user_id = ? ORDER BY credential_id LIMIT 16", userId);
      return rows.map((row) => row.credential_id);
    });
  }

  updateCredentialCounter(credentialId: string, counter: number): void {
    if (!Number.isSafeInteger(counter) || counter < 0) throw new StoreError("invalid_params", "invalid credential counter");
    this.ensureReady();
    this.reserved({ reads: 8, writes: 8 }, false, this.clock.now(), () => {
      const now = this.effectiveNow(this.clock.now());
      this.rawExec(
        "UPDATE credentials SET sign_count = CASE WHEN sign_count < ? THEN ? ELSE sign_count END, updated_ms = ? WHERE credential_id = ?",
        counter,
        counter,
        now,
        credentialId,
      );
    });
  }

  reserveConnection(input: { ipKey: string; now: number }): void {
    this.ensureReady();
    if (!this.config.admissionEnabled) throw new StoreError("denied", "Demo admission is closed");
    this.reserved({ reads: 64, writes: 32, admissions: 1 }, false, input.now, () => {
      const now = this.effectiveNow(input.now);
      this.transaction(() => {
        this.chargeEvent("admission", `ip:${input.ipKey}`, now, { perMinute: this.config.connectionAdmissionsPerIpMinute }, "Connection admission limit reached");
        const day = dayFor(now);
        // The daily admission ceiling is global. The per-IP control above is a
        // rolling minute gate; using it as a daily counter would make a quiet
        // IP permanently consume global capacity independently.
        const global = this.limitRow("admission", "global", now);
        const admissions = global.day === day ? global.posts_day : 0;
        if (admissions >= this.config.connectionAdmissionsPerDay) throw new StoreError("retry_after", "Connection admission limit reached", { retryAfterMs: 86_400_000 });
        this.updateLimitRow(global, { day, posts_day: admissions + 1 }, now);
        // Live connection caps are authoritative in ctx.getWebSockets(), which
        // includes closing sockets and survives object hibernation.  Durable
        // open counters become stale after a lost close and can permanently
        // deny admission, so only the durable admission/day and frame budget
        // controls are maintained here.
        const frames = this.limitRow("frames", "global", now);
        const frameCount = frames.day === day ? frames.posts_day : 0;
        if (frameCount >= this.config.processedFramesPerDay) {
          throw new StoreError("retry_after", "Daily frame budget exhausted", { retryAfterMs: 86_400_000, data: { reason: "frame_budget" } });
        }
      });
    });
  }

  private metaNumber(key: string): number {
    const rows = this.rawRows<{ value: string }>("SELECT value FROM _meta WHERE key = ? LIMIT 1", key);
    return rows.length && /^\d+$/.test(rows[0].value) ? Number(rows[0].value) : 0;
  }

  private maintenanceRow(): RawMaintenanceRow {
    const rows = this.rawRows<RawMaintenanceRow>(
      "SELECT id, next_cleanup_ms, cleanup_cutoff_ms, cleanup_cursor, schema_version FROM maintenance WHERE id = 1 LIMIT 1",
    );
    if (!rows.length) throw new StoreError("internal_error", "maintenance state is missing");
    this.cleanupDueCache = rows[0].next_cleanup_ms;
    return rows[0];
  }

  private currentMessage(messageId: string, floor?: number): RawMessageRow | null {
    // A message in a thread removed while it was still retained (removeEmptyThread) is gone with it.
    const rows = this.rawRows<RawMessageRow>(
      // The current snapshot is the message's latest record, in the room it is in.
      `SELECT m.message_id, m.room_id, m.latest_log_id, rec.record_json AS snapshot_json, m.author_id
       FROM message_state m JOIN rooms r ON r.room_id = m.room_id
       JOIN records rec ON rec.room_id = m.room_id AND rec.log_id = m.latest_log_id
       WHERE m.message_id = ? LIMIT 1`,
      messageId,
    );
    if (!rows.length) return null;
    if (floor !== undefined && rows[0].latest_log_id < floor) return null;
    return rows[0];
  }

  /**
   * A current message `userId` may see: currentMessage, less one in a
   * private room they are not in, which reads as unknown (§5.3).
   */
  private visibleMessage(messageId: string, userId: string, floor?: number): RawMessageRow | null {
    const row = this.currentMessage(messageId, floor);
    return row && isPrivateRoomId(row.room_id) && !this.isMember(row.room_id, userId) ? null : row;
  }

  /** Whether a registered user holds a moderator role (MODERATOR_ROLES), from the identity row. */
  private isModerator(userId: string): boolean {
    return this.holdsRole(userId, MODERATOR_ROLES);
  }

  /**
   * Whether a registered user holds any role, from the identity row: only an
   * admin gives roles, so this is who posts under the trusted limits
   * (chargePosting). `friend` is the role that grants that alone, for
   * someone an admin trusts without moderating powers. An owner's bot (tier
   * `bot`) never counts.
   */
  private holdsAnyRole(userId: string): boolean {
    const identity = this.identityRow(userId);
    return identity?.tier === "registered" && parseRoles(identity.roles_json).length > 0;
  }

  /** Whether a registered user holds one of `roles`, from the identity row. */
  private holdsRole(userId: string, roles: readonly string[]): boolean {
    const identity = this.identityRow(userId);
    return identity?.tier === "registered" && parseRoles(identity.roles_json).some((role) => roles.includes(role));
  }

  /**
   * The top-level rooms' IDs, `general` first, for `room_list`'s shortcut.
   * At most MAX_CREATED_ROOMS + 1, and they are never removed. No index
   * holds `parent_room_id`, so the scan reads every public row, threads
   * included, and the sort reads the top-level ones again: it is reserved
   * as the listing of every public room (roomListingReads), not by the rows
   * it returns.
   */
  topLevelRoomIds(now = this.clock.now()): string[] {
    this.ensureReady();
    return this.reserved({ reads: this.roomListingReads() }, false, now, () => this.rawRows<{ room_id: string }>(
      `SELECT room_id FROM rooms WHERE ${PUBLIC_ROOMS} AND parent_room_id IS NULL ORDER BY created_log_id ASC LIMIT ?`, MAX_CREATED_ROOMS + 1,
    ).map((row) => row.room_id));
  }

  private identityForMessage(input: StoreMutationInput): Identity {
    const name = typeof input.identity.name === "string" ? input.identity.name : undefined;
    return { user_id: input.identity.user_id, ...(name ? { name } : {}) };
  }

  private normalizedBody(value: unknown): Record<string, unknown> {
    const body = jsonObject(value, "body");
    const text = body.text === undefined ? "" : ensureText(body.text, "body.text", this.config.maxTextBytes);
    // The protocol defaults an omitted format to plain text.
    const format = body.format === undefined ? "plain" : body.format;
    if (format !== "plain" && format !== "markdown") throw new StoreError("invalid_params", "body.format is invalid");
    const embeds = body.embeds === undefined ? [] : body.embeds;
    if (!Array.isArray(embeds)) throw new StoreError("invalid_params", "body.embeds must be an array");
    // A count limit this server sets: denied (§1.1).
    if (embeds.length > this.config.maxEmbeds) throw new StoreError("denied", `A message has at most ${this.config.maxEmbeds} embeds`);
    for (const embed of embeds) {
      if (!isPlainObject(embed) || typeof embed.kind !== "string" || embed.kind.length === 0) {
        throw new StoreError("invalid_params", "body.embeds must be objects with a kind");
      }
    }
    // Who a message mentions is the list its sender gives (§3.5); the server
    // never reads mentions out of text. Duplicates collapse.
    let mentions: string[] | undefined;
    if (body.mentions !== undefined) {
      if (!Array.isArray(body.mentions)) throw new StoreError("invalid_params", "body.mentions must be an array of user_id strings");
      const unique = new Set<string>();
      for (const item of body.mentions) {
        // Mentions are user_ids (§2.4): a string that cannot be one makes the
        // whole message, new or edited, invalid.
        if (!isProtocolId(item)) {
          throw new StoreError("invalid_params", "body.mentions must be an array of user_id strings");
        }
        if (utf8Bytes(item) > 256) throw new StoreError("too_large", "a mentioned user_id is too long");
        unique.add(item);
      }
      mentions = [...unique];
    }
    return { ...clone(body), text, format, embeds: (clone(embeds) as Record<string, unknown>[]).map((embed) => withCleanOg(embed, this.config.ogMediaHosts)), ...(mentions ? { mentions } : {}) };
  }

  /** A new message with no text and no embeds, which is neither logged nor broadcast (§3.5). */
  private emptyNewMessage(params: Record<string, unknown>): boolean {
    if (params.message_id !== undefined || (params.deleted !== undefined && params.deleted !== false) || !isPlainObject(params.body)) return false;
    const body = this.normalizedBody(params.body);
    return body.text === "" && (body.embeds as unknown[]).length === 0;
  }

  /**
   * Creates or renames a registered owner's bot (`/invite-bot`): an identity
   * with no credential, which signs in only with the bearer token the caller
   * keeps. A new bot counts as a registration against the same daily and
   * identity caps as a passkey, and starts in `general`, a logged membership
   * (§4.2.2) returned in `broadcasts`. An existing bot only takes the new name.
   */
  registerBot(input: { ownerId: string; botId: string; name: string; now: number; ipKey: string }): {
    userId: string; name: string; created: boolean; renamed: boolean; broadcasts: Broadcast[];
  } {
    this.ensureReady();
    ensureText(input.name, "name", this.config.maxNameBytes);
    if ([...input.name].length > this.config.maxNameCodePoints) throw new StoreError("too_large", "name is too long");
    const existing = this.reserved({ reads: 16 }, false, input.now, () => {
      const owner = this.identityRow(input.ownerId);
      if (!owner || owner.tier !== "registered") throw new StoreError("denied", "Only registered users may invite a bot");
      return this.identityRow(input.botId);
    });
    if (existing) {
      if (existing.tier !== "bot") throw new StoreError("internal_error", "bot identity is taken");
      const renamed = existing.name !== input.name;
      if (renamed) {
        this.reserved({ reads: 8, writes: 8 }, false, input.now, () => {
          this.rawExec("UPDATE identities SET name = ?, updated_ms = ? WHERE user_id = ?", input.name, this.effectiveNow(input.now), input.botId);
        });
      }
      return { userId: input.botId, name: input.name, created: false, renamed, broadcasts: [] };
    }
    const created = this.createKeylessIdentity({ userId: input.botId, name: input.name, tier: "bot", roles: ["bot"], now: input.now, ipKey: input.ipKey });
    return { userId: input.botId, name: input.name, created: true, renamed: false, broadcasts: created.broadcasts };
  }

  /**
   * Gives a user a role (`on`), takes it away, or with no `on` toggles it,
   * for `/role` and `/admin`. `changed` is false when there was nothing to
   * do. Roles are kept in the identity row, at most MAX_ROLES_PER_USER.
   * Only registered users and bots have roles; a bot is never an admin; and
   * `bot` is given to no admin and no user holding a passkey, since a bot
   * signs in with a token only. The roles a user has by what they are,
   * `admin` for the `admin` user and `bot` for an owner's bot (tier `bot`),
   * are not taken away.
   */
  setRole(input: { userId: string; role: string; on?: boolean; now?: number }): { changed: boolean; on: boolean; name: string; roles: string[] } {
    this.ensureReady();
    if (!ROLE_PATTERN.test(input.role)) throw new StoreError("invalid_params", "A role is 1 to 24 lowercase letters, digits, _ or -, starting with a letter");
    return this.reserved({ reads: 12, writes: 4 }, false, input.now ?? this.clock.now(), () => this.transaction(() => {
      const identity = this.identityRow(input.userId);
      if (!identity || (identity.tier !== "registered" && identity.tier !== "bot")) throw new StoreError("invalid_params", "No registered user has that user_id");
      const held = parseRoles(identity.roles_json);
      const on = input.on ?? !held.includes(input.role);
      const unchanged = { changed: false, on, name: identity.name, roles: held };
      if (!on) {
        if (!held.includes(input.role)) return unchanged;
        if (input.role === "admin" && identity.user_id === ADMIN_USER_ID) throw new StoreError("denied", "The admin user is always an admin");
        if (input.role === "bot" && identity.tier === "bot") throw new StoreError("denied", "An owner's bot is always a bot");
        return this.writeRoles(identity, held.filter((role) => role !== input.role), on);
      }
      if (held.includes(input.role)) return unchanged;
      if (input.role === "admin" && held.includes("bot")) throw new StoreError("denied", "A bot can't be an admin");
      if (input.role === "bot") {
        if (held.includes("admin")) throw new StoreError("denied", "An admin can't be a bot; take away admin first");
        if (this.rawRows("SELECT 1 FROM credentials WHERE user_id = ? LIMIT 1", input.userId).length) {
          throw new StoreError("denied", "A bot signs in with a token and holds no passkey; this user has one");
        }
      }
      if (held.length >= MAX_ROLES_PER_USER) throw new StoreError("denied", `A user has at most ${MAX_ROLES_PER_USER} roles`);
      return this.writeRoles(identity, [...held, input.role], on);
    }));
  }

  private writeRoles(identity: RawIdentityRow, roles: string[], on: boolean): { changed: boolean; on: boolean; name: string; roles: string[] } {
    // `updated_ms` too, so a user just made a bot is not idle (idleBots).
    this.rawExec("UPDATE identities SET roles_json = ?, updated_ms = ? WHERE user_id = ?", JSON.stringify(roles), this.effectiveNow(this.clock.now()), identity.user_id);
    return { changed: true, on, name: identity.name, roles };
  }

  /**
   * Marks an account whose only role is `bot` active, when it signs in or
   * posts: its identity's `updated_ms`, which idleBots reads. Anyone else is
   * left as is.
   */
  markBotActive(userId: string, now = this.clock.now()): void {
    this.ensureReady();
    this.reserved({ reads: 4, writes: 4 }, false, now, () => {
      this.rawExec(`UPDATE identities SET updated_ms = ? WHERE user_id = ? AND roles_json = '["bot"]'`, this.effectiveNow(now), userId);
    });
  }

  /**
   * Marks an idle bot signed out (idleBots), once its rooms and tokens are
   * gone: `updated_ms` 0, a time nothing else writes, so the sweep skips it
   * until it is active again.
   */
  markBotSignedOut(userId: string, now = this.clock.now()): void {
    this.ensureReady();
    this.reserved({ reads: 4, writes: 4 }, true, now, () => {
      this.rawExec(`UPDATE identities SET updated_ms = 0 WHERE user_id = ? AND roles_json = '["bot"]'`, userId);
    });
  }

  /**
   * The daily idle bot sweep, once its `_meta` due time has passed: up to
   * `limit` accounts whose only role is `bot` and that have not been active
   * (markBotActive) since `before`, oldest first, and are not yet signed out
   * (markBotSignedOut), for the caller to sign out.
   * The next sweep is due `intervalMs` later, or at once after a full batch.
   * The first call only sets the first sweep `graceMs` out, so bots active
   * before this was recorded are not taken for idle. Null when not due.
   */
  idleBots(input: { now: number; before: number; limit: number; intervalMs: number; graceMs: number }): string[] | null {
    this.ensureReady();
    const { due, identities } = this.reserved({ reads: 4 }, true, input.now, () => ({
      due: this.metaValue(META_BOT_SWEEP), identities: this.metaNumber("identity_count"),
    }));
    if (due !== "" && this.effectiveNow(input.now) < Number(due)) return null;
    // A scan of every identity row, the sort reading each idle bot's again,
    // and the next due time.
    return this.reserved({ reads: 16 + 2 * identities, writes: 4 }, true, input.now, () => {
      const effective = this.effectiveNow(input.now);
      const idle = due === "" ? [] : this.rawRows<{ user_id: string }>(
        `SELECT user_id FROM identities WHERE roles_json = '["bot"]' AND updated_ms > 0 AND updated_ms < ? ORDER BY updated_ms LIMIT ?`, input.before, input.limit,
      ).map((row) => row.user_id);
      const next = due === "" ? effective + input.graceMs : idle.length >= input.limit ? effective : effective + input.intervalMs;
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_BOT_SWEEP, String(next));
      return idle;
    });
  }

  /**
   * The admin user that `APRON_ADMIN_TOKEN` signs in as: a registered identity with
   * no credential, created on first use like a bot, against the same caps.
   * `created` is false when it already exists.
   */
  ensureAdminUser(input: { userId: string; name: string; now: number; ipKey: string }): { created: boolean; broadcasts: Broadcast[] } {
    this.ensureReady();
    const existing = this.reserved({ reads: 8 }, false, input.now, () => this.identityRow(input.userId));
    if (existing) {
      if (existing.tier !== "registered") throw new StoreError("internal_error", "admin user identity is taken");
      return { created: false, broadcasts: [] };
    }
    return { created: true, broadcasts: this.createKeylessIdentity({ ...input, tier: "registered", roles: ["admin"] }).broadcasts };
  }

  /**
   * `/invite-token`: a registered user with no passkey, who signs in with a
   * bearer token an admin hands out. The `user_id` must be free: no identity
   * has it and `/rename` never retired it. Charged as a registration, and
   * starts in `general` like any other identity.
   */
  createInvitedIdentity(input: { userId: string; name: string; now: number; ipKey: string }): { broadcasts: Broadcast[] } {
    this.ensureReady();
    if (this.reserved({ reads: 8 }, false, input.now, () => this.idTaken(input.userId))) {
      throw new StoreError("invalid_params", `The user_id ${input.userId} is taken`.slice(0, 200));
    }
    return this.createKeylessIdentity({ ...input, tier: "registered" });
  }

  /**
   * Inserts an identity that signs in by bearer token rather than a
   * credential, charged as a registration, and starts it in `general` with a
   * logged membership (§4.2.2) returned in `broadcasts`.
   */
  private createKeylessIdentity(input: { userId: string; name: string; tier: "bot" | "registered"; roles?: string[]; now: number; ipKey: string }): { broadcasts: Broadcast[] } {
    ensureText(input.name, "name", this.config.maxNameBytes);
    if ([...input.name].length > this.config.maxNameCodePoints) throw new StoreError("too_large", "name is too long");
    this.assertAccounting();
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    // The limiter and meta rows, the identity row, and one membership row and
    // logged record in `general`.
    const reservation = this.reserveCost({ reads: 128, writes: 72, registrations: 1 }, false, input.now);
    // An operator alert creating the admin user it posts as (alert) is not
    // held to the registration cap, limits, or storage high-water.
    const alerting = this.alerting;
    try {
      if (!alerting && this.metaNumber("identity_count") >= this.config.registeredIdentityCount) throw new StoreError("denied", "registration_closed");
      if (!alerting) this.ensureGrowthCapacity(this.config.maxSnapshotBytes);
      const effective = this.effectiveNow(input.now);
      return this.transaction(() => {
        if (this.identityRow(input.userId)) throw new StoreError("invalid_params", "identity already exists");
        if (!alerting && this.metaNumber("identity_count") >= this.config.registeredIdentityCount) throw new StoreError("denied", "registration_closed");
        if (!alerting) this.chargeRegistration(input.ipKey, effective);
        this.rawExec(
          "INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms, roles_json) VALUES (?, '', ?, ?, ?, ?, ?)",
          input.userId, input.name, input.tier, effective, effective, JSON.stringify(input.roles ?? []),
        );
        this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('identity_count', ?)", String(this.metaNumber("identity_count") + 1));
        const broadcasts: Broadcast[] = [];
        const joined = this.existingRooms(DEFAULT_JOINED_ROOMS);
        if (joined.length) {
          const state = this.logState();
          const startLogId = state.last_log_id;
          const context: CommitContext = { state, commitMs: Math.max(effective, state.last_commit_ms), touched: new Map() };
          for (const roomId of joined) {
            this.rawExec("INSERT OR IGNORE INTO memberships (room_id, user_id) VALUES (?, ?)", roomId, input.userId);
            broadcasts.push(this.logMembership(context, roomId, recordedUser(input.userId, input.name), true));
          }
          this.finishCommit(context, startLogId);
        }
        this.assertStorageTarget();
        this.assertReservation(reservation, beforeReads, beforeWrites);
        return { broadcasts };
      });
    } finally {
      this.settleReservation(reservation, beforeReads, beforeWrites);
    }
  }

  /**
   * The given public room IDs that still exist, once each and in order.
   * Reads the capped public range of the rooms table; a private room is
   * never among them, as nobody starts in one (only a member adds others).
   */
  private existingRooms(ids: readonly string[]): string[] {
    const known = new Set(this.rawRows<{ room_id: string }>(`SELECT room_id FROM rooms WHERE ${PUBLIC_ROOMS} LIMIT ?`, MAX_THREAD_LIMIT + 1).map((row) => row.room_id));
    return [...new Set(ids)].filter((id) => known.has(id));
  }

  /**
   * Logs one registered user's membership change in a room (§4.2.2): a live
   * record carries one entry, with the user as a recorded object. It advances
   * the room's head like any record. Returns it for delivery to the room's
   * members before and after the change.
   */
  private logMembership(context: CommitContext, roomId: string, user: Identity, joined: boolean): Broadcast {
    // Every logged change is a stored join or leave: finishCommit counts it
    // in the room's member_count with the head update it writes anyway.
    context.members ??= new Map();
    context.members.set(roomId, (context.members.get(roomId) ?? 0) + (joined ? 1 : -1));
    const logId = this.allocateLogId(context);
    const record: MembershipRecord = { log_id: idString(logId), room_id: roomId, members: [{ user: clone(user), joined }] };
    this.appendRecord(context, [roomId], "membership", logId, JSON.stringify(record));
    return { method: "membership", params: clone(record) as unknown as Record<string, unknown>, rooms: [roomId] };
  }

  /**
   * Joins or leaves one room for a registered identity, whose rooms last
   * across connections (§4.2.2). Guests' rooms live in their connection and
   * are not logged; a guest's change counts as a post too
   * (chargeGuestMembership). A change is one `memberships` row and one logged
   * membership record, and counts as a post; joining or leaving where nothing
   * would change writes nothing. Returns the identity's rooms, the logged
   * record, and the room's record after it.
   */
  /**
   * Joins or leaves a room for a registered user. The posting limits charged
   * are the user's own, or `actorId`'s when someone else makes the change
   * (an admin's `/kick`); `ipKey` is the requesting connection's.
   */
  changeMembership(input: { userId: string; ipKey: string; roomId: string; join: boolean; now?: number; actorId?: string }): {
    rooms: string[]; changed: boolean; membership?: Broadcast; room?: RoomRecord;
  } {
    this.ensureReady();
    const operationNow = input.now ?? this.clock.now();
    this.assertAccounting();
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    // The three posting limiter rows, the identity and membership rows, the
    // room record, and the user's rooms; a join of a private room also counts
    // the private rooms the user is in, through the same membership rows.
    const privateJoin = input.join && isPrivateRoomId(input.roomId);
    const reserved = this.reserveCost({ reads: 64 + (privateJoin ? 2 : 1) * this.userRoomsReads(), writes: 64, posts: 1 }, false, operationNow);
    try {
      const effective = this.effectiveNow(operationNow);
      if (input.join) this.ensureGrowthCapacity(1024);
      return this.transaction(() => {
        const identity = this.identityRow(input.userId);
        if (!identity) throw new StoreError("denied", "Only registered identities keep rooms");
        // Only a private room's members see it, and only they add others to
        // it: nobody joins one by themselves (PRIVATE_ROOM_PREFIX).
        const room = privateJoin ? this.visibleRoomRow(input.roomId, input.actorId ?? input.userId) : this.roomRow(input.roomId);
        if (!room) throw new StoreError("invalid_params", "Unknown room");
        const member = this.rawRows("SELECT user_id FROM memberships WHERE room_id = ? AND user_id = ? LIMIT 1", input.roomId, input.userId).length > 0;
        if (member === input.join) return { rooms: this.userRooms(input.userId), changed: false };
        if (privateJoin && this.privateMembershipCount(input.userId) >= this.config.maxPrivateMembershipsPerUser) {
          throw new StoreError("denied", `${input.userId} is in as many private rooms as anyone may be, so cannot be added to another`.slice(0, 200));
        }
        this.chargePosting({ userId: input.actorId ?? input.userId, tier: "registered", ipKey: input.ipKey, now: effective });
        if (input.join) this.rawExec("INSERT INTO memberships (room_id, user_id) VALUES (?, ?)", input.roomId, input.userId);
        else {
          this.rawExec("DELETE FROM memberships WHERE room_id = ? AND user_id = ?", input.roomId, input.userId);
          this.rawExec("DELETE FROM read_cursors WHERE user_id = ? AND room_id = ?", input.userId, input.roomId);
        }
        const state = this.logState();
        const startLogId = state.last_log_id;
        const context: CommitContext = { state, commitMs: Math.max(effective, state.last_commit_ms), touched: new Map() };
        const membership = this.logMembership(context, input.roomId, recordedUser(input.userId, identity.name), input.join);
        this.finishCommit(context, startLogId);
        const updated = { ...room, latest_log_id: Math.max(room.latest_log_id, context.state.last_log_id) };
        const record = this.roomRecord(updated, state.history_floor);
        const rooms = this.userRooms(input.userId);
        this.assertStorageTarget();
        this.assertReservation(reserved, beforeReads, beforeWrites);
        return { rooms, changed: true, membership, room: record };
      });
    } finally {
      this.settleReservation(reserved, beforeReads, beforeWrites);
    }
  }

  /**
   * Charges a guest's join or leave that changes something as one post, to
   * the guest's (`anonymous:<ip>`), the IP's and the global posting limits
   * (chargePosting), so a posting refusal holds back every write (§6,
   * `ext:limits` `write`). A guest's rooms live in its connection, so
   * nothing else is stored; the caller changes them only once this returns.
   * The reservation covers the three limiter rows, each inserted on first
   * use, and is mostly credited back while the guest's and IP's rows are
   * cached (limiter-cache.ts).
   */
  chargeGuestMembership(input: { ipKey: string; now?: number }): void {
    this.ensureReady();
    const operationNow = input.now ?? this.clock.now();
    this.reserved({ reads: 32, writes: 32, posts: 1 }, false, operationNow, () => {
      const effective = this.effectiveNow(operationNow);
      this.transaction(() => this.chargePosting({ userId: "", tier: "anonymous", ipKey: input.ipKey, now: effective }));
    });
  }

  /**
   * Removes a thread or private room that has emptied (§4.2.2): no registered member is
   * left in it, so the last to leave frees its slot instead of leaving it
   * until its log expires, whatever messages it holds. The caller checks
   * that no connection, a guest's included, is still in it. Its records and
   * messages stay until they expire, but currentMessage no longer finds the
   * messages, so they cannot be edited, moved, reacted to or replied to.
   * Returns whether the room was removed.
   */
  removeEmptyThread(roomId: string, now = this.clock.now()): boolean {
    this.ensureReady();
    return this.reserved({ reads: 16, writes: 8 }, false, now, () => this.transaction(() => {
      const room = this.roomRow(roomId);
      // A private room goes the same way, freeing its slot among the private ones.
      const isPrivate = room !== null && isPrivateRoomId(room.room_id);
      if (!room || (room.parent_room_id === null && !isPrivate)) return false;
      if (this.rawRows("SELECT user_id FROM memberships WHERE room_id = ? LIMIT 1", roomId).length) return false;
      this.rawExec("DELETE FROM rooms WHERE room_id = ?", roomId);
      const counter = isPrivate ? "private_count" : "thread_count";
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", counter, String(Math.max(0, this.metaNumber(counter) - 1)));
      return true;
    }));
  }

  private optionalExt(value: unknown, field = "ext"): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) throw new StoreError("invalid_params", `${field} must be an object`);
    return clone(value);
  }

  /**
   * Validate a bare message reference (`reply_to`). Only the
   * `message_id` is kept. A new reference must name a retained message the
   * `viewer` may see; a save that resubmits its current reference unchanged
   * is accepted even after the target has expired, so old replies remain
   * editable. A message in a private room is answered only in that room
   * (`roomId`), so a reply elsewhere never points into it.
   */
  private messageReference(value: unknown, field: string, floor: number, options: { viewer: string; roomId: string; self?: string; unchanged?: string }): string | undefined {
    if (value === undefined) return undefined;
    if (!isPlainObject(value) || typeof value.message_id !== "string" || value.message_id.length === 0) {
      throw new StoreError("invalid_params", `${field}.message_id must be a non-empty string`);
    }
    const messageId = ensureText(value.message_id, `${field}.message_id`, 256);
    if (options.self !== undefined && messageId === options.self) throw new StoreError("invalid_params", `${field} cannot name the message itself`);
    if (messageId !== options.unchanged) {
      const target = this.visibleMessage(messageId, options.viewer, floor);
      if (!target) throw new StoreError("invalid_params", `${field} names an unknown or expired message`);
      if (isPrivateRoomId(target.room_id) && target.room_id !== options.roomId) throw new StoreError("denied", `${field} names a message in a private room; reply there instead`);
    }
    return messageId;
  }

  private allocateLogId(context: CommitContext): number {
    const state = context.state;
    const candidate = Math.max(Math.trunc(context.commitMs), state.last_log_id + 1, state.history_floor);
    if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > MAX_SAFE_ID) throw new StoreError("internal_error", "log identifier range exhausted");
    state.last_log_id = candidate;
    return candidate;
  }

  /** Append one record to each room whose log it belongs to. */
  private appendRecord(context: CommitContext, roomIds: string[], kind: RecordKind, logId: number, json: string): void {
    for (const roomId of roomIds) {
      this.rawExec(
        "INSERT INTO records (room_id, log_id, commit_ms, kind, record_json) VALUES (?, ?, ?, ?, ?)",
        roomId, logId, context.commitMs, kind, json,
      );
      context.touched.set(roomId, Math.max(context.touched.get(roomId) ?? 0, logId));
    }
  }

  /** Advance each touched room's head and the server-wide head. */
  private finishCommit(context: CommitContext, startLogId: number): void {
    if (context.state.last_log_id === startLogId) return;
    for (const [roomId, logId] of context.touched) {
      const members = context.members?.get(roomId) ?? 0;
      if (members === 0) this.rawExec("UPDATE rooms SET latest_log_id = MAX(latest_log_id, ?) WHERE room_id = ?", logId, roomId);
      else this.rawExec("UPDATE rooms SET latest_log_id = MAX(latest_log_id, ?), member_count = MAX(0, member_count + ?) WHERE room_id = ?", logId, members, roomId);
    }
    // Kept here, not written: the records just appended say as much (logCache).
    this.logCache = {
      ...this.logState(),
      last_log_id: context.state.last_log_id,
      last_commit_ms: Math.max(context.commitMs, context.state.last_commit_ms),
    };
  }

  /**
   * Create, save, delete, restore, or move a message (section 3.5, §4.4).
   * With `liveClaim`, the message a command's live text posts when its write
   * arrives (claimLiveText): its new live embed is that text's.
   */
  private commitMessage(input: StoreMutationInput, context: CommitContext, floor: number, liveClaim?: LiveEntry): StoreMutationResult {
    const params = input.params;
    if (params.log_id !== undefined) throw new StoreError("invalid_params", "log_id is server assigned");
    // Without room_id a message goes to the default room (§3.5).
    const roomId = params.room_id === undefined ? ROOM_ID : params.room_id;
    if (typeof roomId !== "string" || roomId.length === 0) throw new StoreError("invalid_params", "room_id must be a non-empty string");
    const messageIdParam = params.message_id;
    if (messageIdParam !== undefined && typeof messageIdParam !== "string") throw new StoreError("invalid_params", "message_id must be a string");
    const current = messageIdParam === undefined ? null : this.visibleMessage(ensureText(messageIdParam, "message_id", 256), input.userId, floor);
    if (messageIdParam !== undefined && !current) throw new StoreError("invalid_params", "unknown or expired message");
    // Someone else's message may only be moved, and only by a moderator (MODERATOR_ROLES).
    const moving = current !== null && current.author_id !== input.userId;
    if (moving && (current.room_id === roomId || !this.isModerator(input.userId))) throw new StoreError("denied", "Only the original author may edit this message");
    // Posting needs no join, except in a private room, which only its members see.
    if (!this.visibleRoomRow(roomId, input.userId)) throw new StoreError("invalid_params", "unknown room");
    // A private room's messages stay in it, and no other room's come in.
    if (current !== null && current.room_id !== roomId && (isPrivateRoomId(current.room_id) || isPrivateRoomId(roomId))) {
      throw new StoreError("denied", "Messages cannot be moved into or out of a private room");
    }
    const deleted = params.deleted === undefined ? false : params.deleted;
    if (typeof deleted !== "boolean") throw new StoreError("invalid_params", "deleted must be boolean");
    if (!current && deleted) throw new StoreError("invalid_params", "a message cannot be created deleted");
    const previous = current ? parseJson<MessageSnapshot>(current.snapshot_json) : null;
    const replyId = this.messageReference(params.reply_to, "reply_to", floor, {
      viewer: input.userId,
      roomId,
      ...(typeof messageIdParam === "string" ? { self: messageIdParam } : {}),
      ...(previous?.reply_to ? { unchanged: previous.reply_to.message_id } : {}),
    });
    let body: Record<string, unknown> | undefined;
    if (!deleted) {
      if (params.body === undefined) throw new StoreError("invalid_params", "message body is required");
      body = this.normalizedBody(params.body);
      if (body.text === "" && (body.embeds as unknown[]).length === 0) throw new StoreError("invalid_params", "message cannot be empty");
    }
    // A save merges `ext` into the current snapshot's (§4.12); a tombstone carries none (§4.4),
    // so a creation, or a save of a tombstone, merges into an empty `ext`.
    const write = this.optionalExt(params.ext);
    const ext = deleted ? undefined : mergeExt(previous?.ext, write);
    const from = previous ? previous.from : this.identityForMessage(input);
    if (!from || typeof from.user_id !== "string") throw new StoreError("internal_error", "message author is missing");

    const logId = this.allocateLogId(context);
    const messageId = previous ? previous.message_id : idString(logId);
    let uploads: PendingUpload[] = [];
    let deletedUploads: string[] = [];
    let writes: Record<string, unknown>[] = [];
    let liveStarted: LiveEntry[] = [];
    let liveEnded: string[] = [];
    if (this.config.uploads || this.config.liveText) {
      const identified = this.identifyEmbeds(body ? body.embeds as Record<string, unknown>[] : [], previous, input, messageId, logId, context.commitMs, typeof body?.text === "string" ? body.text : "", liveClaim);
      if (body) body.embeds = identified.embeds;
      uploads = identified.uploads;
      writes = identified.writes;
      liveStarted = identified.liveStarted;
      liveEnded = identified.liveEnded;
      if (this.config.uploads) deletedUploads = this.releaseUploadRows(this.messageUploads(messageId, identified.removed));
    }
    // Deletion omits the body and ext from the tombstone; the other client
    // fields keep replacement semantics, so omitted fields are removed.
    const snapshot: MessageSnapshot = { message_id: messageId, log_id: idString(logId), room_id: roomId, from: clone(from) };
    if (body) snapshot.body = body;
    if (replyId !== undefined) snapshot.reply_to = { message_id: replyId };
    if (deleted) snapshot.deleted = true;
    if (ext) snapshot.ext = ext;
    // A moderator's save keeps the author's content as it was: the client fields
    // the client resubmits, and an `ext` it merges into nothing new.
    if (moving && canonicalize(messageContent(snapshot)) !== canonicalize(messageContent(previous!))) {
      throw new StoreError("denied", "An admin, mod or threader may move someone else's message but not change it");
    }
    // The size policy bounds client content, the merged ext included; the server's prev_log_id and
    // prev_room_id links are added after it, and a finished terminal's `output` is the server's too.
    if (utf8Bytes(JSON.stringify(withoutOutputs(snapshot))) > this.config.maxSnapshotBytes) throw new StoreError("too_large", "message snapshot is too large");
    const moved = current !== null && current.room_id !== roomId;
    if (current) snapshot.prev_log_id = idString(current.latest_log_id);
    // After a move the previous snapshot is in the source room's log (§4.3.1).
    if (moved) snapshot.prev_room_id = current.room_id;
    const json = JSON.stringify(snapshot);

    // A move belongs to the source and destination logs (§4.3.1).
    this.appendRecord(context, moved ? [current.room_id, roomId] : [roomId], "message", logId, json);
    this.rawExec(
      `INSERT INTO message_state (message_id, room_id, latest_log_id, author_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (message_id) DO UPDATE SET
         room_id = excluded.room_id,
         latest_log_id = excluded.latest_log_id`,
      messageId, roomId, logId, from.user_id,
    );
    const broadcasts: Broadcast[] = [{
      method: "message", params: clone(snapshot) as unknown as Record<string, unknown>, rooms: moved ? [current.room_id, roomId] : [roomId],
    }];
    if (moved) {
      // Reactions follow a moved message: one record in the destination with
      // every retained non-empty set. The per-message cap bounds this read.
      const rows = this.rawRows<RawReactionRow>(
        `SELECT message_id, user_id, log_id, from_json, emojis_json FROM reaction_state
         WHERE message_id = ? AND log_id >= ? ORDER BY log_id, user_id LIMIT ?`,
        messageId, floor, this.config.reactionUsersPerMessage,
      );
      if (rows.length) {
        context.extraPosts = Math.floor(rows.length / MOVE_REACTION_SETS_PER_POST);
        const reactionLogId = this.allocateLogId(context);
        const record: ReactionsRecord = {
          log_id: idString(reactionLogId),
          message_id: messageId,
          room_id: roomId,
          reactions: rows.map((row) => ({ from: parseJson<Identity>(row.from_json), emojis: parseJson<string[]>(row.emojis_json) })),
        };
        this.appendRecord(context, [roomId], "reactions", reactionLogId, JSON.stringify(record));
        // The sets' latest record is now the moved copy; retention follows it.
        this.rawExec("UPDATE reaction_state SET log_id = ? WHERE message_id = ? AND log_id >= ?", reactionLogId, messageId, floor);
        broadcasts.push({ method: "reactions", params: clone(record) as unknown as Record<string, unknown>, rooms: [roomId] });
      }
    }
    // New uploads' writes go in the result, in request order (§4.8.3); the
    // runtime signs each into a `write_url`, so a retry gets the same URLs.
    const result: Record<string, unknown> = { message_id: messageId };
    if (writes.length) result.embeds = writes;
    return { result, broadcasts, message: snapshot, uploads, deletedUploads, liveStarted, liveEnded };
  }

  /**
   * Embed identity (protocol §4.8.2) on a server with `embed:upload` or live
   * text: every embed gets an `embed_id`. One sent back with its `embed_id`
   * keeps what the server owns from the previous snapshot: an upload keeps
   * its `url` and `og` and takes only a new `title`; a live text keeps its
   * `url` (and a finished terminal its `output`) and takes only a new
   * `title`. One without is new: a new `upload` starts a pending write, and a
   * new `terminal` or `append` a live text (startLiveText). Returns the
   * embeds; the writes the result lists, in request order (§4.8.3); the
   * uploads and live texts started; the previous upload embeds the save left
   * out, whose content goes with them; and the live texts it ended.
   */
  private identifyEmbeds(
    embeds: readonly Record<string, unknown>[],
    previous: MessageSnapshot | null,
    input: StoreMutationInput,
    messageId: string,
    logId: number,
    now: number,
    text: string,
    liveClaim?: LiveEntry,
  ): { embeds: Record<string, unknown>[]; writes: Record<string, unknown>[]; uploads: PendingUpload[]; removed: string[]; liveStarted: LiveEntry[]; liveEnded: string[] } {
    const userId = input.userId;
    const earlier = new Map<string, Record<string, unknown>>();
    const previousEmbeds = previous?.body?.embeds;
    if (Array.isArray(previousEmbeds)) {
      for (const embed of previousEmbeds) if (isPlainObject(embed) && typeof embed.embed_id === "string") earlier.set(embed.embed_id, embed);
    }
    const live = this.config.liveText ?? null;
    const isLive = (kind: unknown) => !!live && typeof kind === "string" && LIVE_KINDS.has(kind);
    // §4.8.5: a message has at most one append, a protocol rule; and a user has one live text open at a time.
    const appends = embeds.filter((embed) => embed.embed_id === undefined ? embed.kind === "append" && isLive(embed.kind) : earlier.get(embed.embed_id as string)?.kind === "append");
    if (appends.length > 1) throw new StoreError("invalid_params", "A message has at most one append embed");
    const fresh = embeds.filter((embed) => embed.embed_id === undefined && isLive(embed.kind));
    if (fresh.length > 1) throw new StoreError("denied", "A message can start one live text (terminal or append) at a time");
    const kept = new Set<string>();
    const uploads: PendingUpload[] = [];
    const writes: Record<string, unknown>[] = [];
    const liveStarted: LiveEntry[] = [];
    const identified = embeds.map((embed, index) => {
      const { embed_id: embedId, ...fields } = embed;
      if (embedId !== undefined) {
        const before = typeof embedId === "string" && !kept.has(embedId) ? earlier.get(embedId) : undefined;
        if (!before || (fields.kind === "upload") !== (before.kind === "upload") || ((isLive(fields.kind) || isLive(before.kind)) && fields.kind !== before.kind)) {
          throw new StoreError("invalid_params", "unknown embed_id");
        }
        kept.add(embedId as string);
        if (isLive(before.kind)) {
          // The server owns `url`, `output`, and a terminal's `og` (§4.8.2, §4.8.6); a terminal takes a new title.
          const { title: _title, og: _og, ...owned } = before;
          void _title;
          void _og;
          if (before.kind !== "terminal") return owned;
          const title = uploadTitle(fields.title);
          const state = owned.output !== undefined ? "finished" : owned.url !== undefined ? "live" : "waiting";
          return { ...owned, ...(title ? { title } : {}), og: terminalOg(title, state) };
        }
        if (before.kind !== "upload" || !this.config.uploads) return { embed_id: embedId, ...fields };
        const title = uploadTitle(fields.title);
        return { ...before, ...(title ? { title } : {}) };
      }
      const id = liveClaim && isLive(fields.kind) ? liveClaim.embedId : `embed_${idString(logId)}_${index}`;
      if (isLive(fields.kind)) {
        const kind = fields.kind as LiveKind;
        const title = kind === "terminal" ? uploadTitle(fields.title) : undefined;
        let entry: LiveEntry;
        if (liveClaim) entry = liveClaim;
        else {
          entry = this.startLiveText(kind, input, now, { messageId, embedId: id, text });
          liveStarted.push(entry);
          writes.push(liveResultEmbed(entry, live!));
        }
        // Its `url` waits for the write (§4.8.5): a command's message is posted with it then, and a message's republished.
        return {
          embed_id: id, kind, ...(title ? { title } : {}), ...(liveClaim ? { url: liveUrl(live!, entry) } : {}),
          ...(kind === "terminal" ? { og: terminalOg(title, liveClaim ? "live" : "waiting") } : {}),
        };
      }
      if (fields.kind !== "upload" || !this.config.uploads) return { embed_id: id, ...fields };
      const upload = this.startUpload("file", userId, now, { messageId, embedId: id });
      uploads.push(upload);
      writes.push(uploadResultEmbed(upload));
      const title = uploadTitle(fields.title);
      return { embed_id: id, kind: "upload", ...(title ? { title } : {}) };
    });
    const removed = [...earlier.values()]
      .filter((embed) => embed.kind === "upload" && !kept.has(embed.embed_id as string))
      .map((embed) => embed.embed_id as string);
    // A save that leaves out a live text's embed (or deletes its message) ends it early (§4.8.3).
    const endedIds = [...earlier.values()].filter((embed) => isLive(embed.kind) && !kept.has(embed.embed_id as string)).map((embed) => embed.embed_id as string);
    const liveEnded = endedIds.length ? this.dropLiveTexts((entry) => entry.messageId === messageId && endedIds.includes(entry.embedId)) : [];
    return { embeds: identified, writes, uploads, removed, liveStarted, liveEnded };
  }

  /**
   * Starts an upload (protocol §4.8.3) for a registered user: charges the
   * user's daily upload count, and reserves the largest size against the
   * stored-bytes cap until the write reports its size. The server's daily
   * count is only checked here: it is charged when a write is claimed
   * (claimUpload), so uploads started and never written cannot close
   * uploads for everyone.
   */
  private startUpload(purpose: UploadPurpose, userId: string, now: number, link: { messageId?: string; embedId: string }, owner = userId): PendingUpload {
    const policy = this.config.uploads;
    if (!policy) throw new StoreError("unsupported", "Uploads are not available here");
    if (!this.identityRow(userId)) throw new StoreError("denied", "Sign in with a passkey to upload");
    if (this.metaValue(META_TOGGLE_PREFIX + "uploads") === "off") throw new StoreError("denied", "Uploads are turned off here");
    // The server's avatar is an avatar in size.
    const maxBytes = purpose === "file" ? policy.maxFileBytes : purpose === "emoji" ? policy.maxEmojiBytes : policy.maxAvatarBytes;
    const day = dayFor(now);
    const rows = [this.limitRow("upload", `user:${userId}`, now), this.limitRow("upload", "global", now)];
    const counts = rows.map((row) => (row.day === day ? row.uploads_day : 0));
    const untilReset = Math.max(1, 86_400_000 - now % 86_400_000);
    if (counts[1] >= policy.uploadsPerDay) throw new StoreError("retry_after", "Daily upload limit reached for the server", { retryAfterMs: untilReset, data: limitData("upload") });
    if (counts[0] >= policy.uploadsPerUserDay) throw new StoreError("retry_after", "Daily upload limit reached", { retryAfterMs: untilReset, data: limitData("upload") });
    const stored = this.metaNumber(META_UPLOAD_BYTES);
    if (stored + maxBytes > policy.storedBytesCap) {
      throw new StoreError("retry_after", "Upload storage is full", { retryAfterMs: 3_600_000, data: limitData("upload") });
    }
    this.updateLimitRow(rows[0], { day, uploads_day: counts[0] + 1 }, now);
    this.setUploadBytes(stored + maxBytes);
    // The server's avatar is kept like a custom emoji, under `e/`, which the
    // bucket's lifecycle rules leave alone.
    const kept = purpose === "emoji" || purpose === "server";
    const key = `${purpose === "file" ? "f" : kept ? "e" : "a"}/${randomKey()}`;
    const writeExpiresMs = now + policy.writeWindowSeconds * 1_000;
    // Custom emoji and the server's avatar never expire: they go when an
    // admin removes or replaces them.
    const expiresMs = kept ? Number.MAX_SAFE_INTEGER : now + (purpose === "file" ? policy.fileRetentionSeconds : policy.avatarRetentionSeconds) * 1_000;
    this.rawExec(
      `INSERT INTO uploads (upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms, created_ms)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      key, owner, purpose, link.messageId ?? null, link.embedId, maxBytes, writeExpiresMs, expiresMs, now,
    );
    return { key, purpose, embedId: link.embedId, maxBytes, writeExpiresMs };
  }

  private setUploadBytes(bytes: number): void {
    this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_UPLOAD_BYTES, String(Math.max(0, bytes)));
  }

  private uploadRow(key: string): RawUploadRow | null {
    return this.rawRows<RawUploadRow>(
      `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
       FROM uploads WHERE upload_key = ? LIMIT 1`,
      key,
    )[0] ?? null;
  }

  /** A message's uploads, all of them or those of some embeds. Bounded by the embeds a message may carry. */
  private messageUploads(messageId: string, embedIds?: readonly string[]): RawUploadRow[] {
    if (embedIds && !embedIds.length) return [];
    const rows = this.rawRows<RawUploadRow>(
      `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
       FROM uploads INDEXED BY uploads_message_idx WHERE message_id = ? LIMIT ?`,
      messageId, 4 * this.config.maxEmbeds,
    );
    return embedIds ? rows.filter((row) => row.embed_id !== null && embedIds.includes(row.embed_id)) : rows;
  }

  /** Forgets uploads and frees their bytes; returns their keys, whose R2 objects the caller deletes. */
  private releaseUploadRows(rows: readonly RawUploadRow[]): string[] {
    if (!rows.length) return [];
    let freed = 0;
    for (const row of rows) {
      this.rawExec("DELETE FROM uploads WHERE upload_key = ?", row.upload_key);
      freed += row.bytes;
    }
    this.setUploadBytes(this.metaNumber(META_UPLOAD_BYTES) - freed);
    return rows.map((row) => row.upload_key);
  }

  /** Marks a pending upload written, counting its real size in place of the largest. */
  private completeUploadRow(row: RawUploadRow, bytes: number): void {
    this.rawExec("UPDATE uploads SET state = 'done', bytes = ? WHERE upload_key = ?", bytes, row.upload_key);
    this.setUploadBytes(this.metaNumber(META_UPLOAD_BYTES) - row.bytes + bytes);
  }

  /** The open live texts (META_LIVE_TEXTS): one `_meta` row, absent while there are none. */
  private liveTexts(): LiveEntry[] {
    if (!this.liveCache) {
      const raw = this.metaValue(META_LIVE_TEXTS);
      const parsed = raw ? parseJson<unknown>(raw, []) : [];
      this.liveCache = Array.isArray(parsed) ? parsed.filter(isLiveEntry) : [];
    }
    // Callers change what they get before they save it.
    return clone(this.liveCache) as LiveEntry[];
  }

  private saveLiveTexts(entries: readonly LiveEntry[]): void {
    if (entries.length) this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_LIVE_TEXTS, JSON.stringify(entries));
    else this.rawExec("DELETE FROM _meta WHERE key = ?", META_LIVE_TEXTS);
    this.liveCache = clone(entries) as LiveEntry[];
  }

  /** Forgets the open live texts `match` picks, publishing nothing; returns their write keys. */
  private dropLiveTexts(match: (entry: LiveEntry) => boolean): string[] {
    const entries = this.liveTexts();
    const gone = entries.filter(match);
    if (gone.length) this.saveLiveTexts(entries.filter((entry) => !match(entry)));
    return gone.map((entry) => entry.key);
  }

  /** Live text: configured, and on unless an admin turned it off (or on, against the default). */
  private liveTextOn(): boolean {
    const live = this.config.liveText;
    if (!live) return false;
    const value = this.metaValue(META_TOGGLE_PREFIX + "livetext");
    return value === "on" ? true : value === "off" ? false : live.enabled;
  }

  /**
   * Starts a live text (§4.8.3) within the policy: one open text per user,
   * pending writes included; at most `concurrent` server-wide; and the
   * user's (a guest's: their IP's), the IP's and the server's starts,
   * charged as `live` limiter rows (a burst, then a rate, and a count a UTC
   * day). Its time limit is the owner's: `moderatorMaxSeconds` for an
   * `admin` or `mod`, else `maxSeconds`. An append may add what the message
   * text limit leaves of `text`, at most `appendMaxBytes`.
   */
  private startLiveText(kind: LiveKind, input: Pick<StoreMutationInput, "userId" | "ipKey">, now: number, link: { messageId?: string; embedId: string; text: string; post?: LiveEntry["post"] }): LiveEntry {
    const policy = this.config.liveText;
    if (!policy) throw new StoreError("unsupported", "Live text is not available here");
    if (!this.liveTextOn()) throw new StoreError("denied", "Live text is turned off here");
    // A command's write that never came leaves nothing to publish: it goes now.
    const entries = this.liveTexts().filter((entry) => entry.post === undefined || entry.writeExpiresMs >= now);
    if (entries.some((entry) => entry.owner === input.userId)) {
      throw new StoreError("denied", "You already have a live text open; finish it, or let its write_url expire, before you start another");
    }
    if (entries.length >= policy.concurrent) {
      const soonest = Math.min(...entries.map(liveDeadline));
      throw new StoreError("retry_after", "Live text is busy on this server; try again shortly", { retryAfterMs: Math.max(1_000, soonest - now) });
    }
    const limit = kind === "terminal" ? policy.terminalKeepBytes : Math.min(policy.appendMaxBytes, this.config.maxTextBytes - utf8Bytes(link.text));
    if (limit <= 0) throw new StoreError("too_large", "The message text leaves no room to append to");
    const registered = this.identityRow(input.userId) !== null;
    const principal = registered ? `user:${input.userId}` : `anonymous:${input.ipKey}`;
    const window = policy.startWindowMinutes;
    this.chargeEvent("live", principal, now, { perMinute: policy.startsPerUser / window, burst: policy.startsPerUser }, "Live text limit reached",
      { limit: policy.startsPerUserDay, message: "Daily live text limit reached" });
    this.chargeEvent("live", `ip:${input.ipKey}`, now, { perMinute: policy.startsPerIp / window, burst: policy.startsPerIp }, "Live text limit reached");
    this.chargeEvent("live", "global", now, { perMinute: policy.startsPerDay }, "Daily live text limit reached for the server",
      { limit: policy.startsPerDay, message: "Daily live text limit reached for the server" });
    const long = registered && this.holdsRole(input.userId, LIVE_TEXT_LONG_ROLES);
    const entry: LiveEntry = {
      key: `l/${randomKey()}`,
      id: randomKey(),
      kind,
      owner: input.userId,
      ip: input.ipKey,
      state: "pending",
      writeExpiresMs: now + policy.writeWindowSeconds * 1_000,
      maxMs: (long ? policy.moderatorMaxSeconds : policy.maxSeconds) * 1_000,
      limit,
      embedId: link.embedId,
      ...(link.messageId !== undefined ? { messageId: link.messageId } : {}),
      ...(link.post ? { post: link.post } : {}),
    };
    this.saveLiveTexts([...entries, entry]);
    return entry;
  }

  /**
   * The open live texts: one `_meta` row read the first time after a wake,
   * then from memory, since every change goes through this instance
   * (liveCache), so a reader's `GET` of an ended text costs no SQL.
   */
  openLiveTexts(now = this.clock.now()): LiveEntry[] {
    this.ensureReady();
    if (!this.config.liveText) return [];
    if (this.liveCache) return this.liveTexts();
    return this.reserved({ reads: 4 }, false, now, () => this.liveTexts());
  }

  /**
   * `/embed-terminal [title]` and `/embed-append [markdown]`: a live text
   * whose message is posted when its write arrives (claimLiveText), from
   * `userId`, in `roomId`, replying to `replyTo`. Everything is checked and
   * charged now, its post included (the posting limits), so the write
   * cannot be refused for them later.
   */
  startLiveCommand(input: { userId: string; ipKey: string; identity: Identity; kind: LiveKind; roomId: string; title?: string; text?: string; replyTo?: string; now?: number }): LiveEntry {
    this.ensureReady();
    const now = input.now ?? this.clock.now();
    return this.reserved({ reads: 64, writes: 48 + LIVE_WRITES }, false, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      if (!this.visibleRoomRow(input.roomId, input.userId)) throw new StoreError("invalid_params", "unknown room");
      const text = ensureText(input.text ?? "", "body.text", this.config.maxTextBytes);
      const replyTo = input.replyTo === undefined ? undefined
        : this.messageReference({ message_id: input.replyTo }, "reply_to", this.logState().history_floor, { viewer: input.userId, roomId: input.roomId });
      const title = input.kind === "terminal" ? uploadTitle(input.title) : undefined;
      const tier: Tier = this.identityRow(input.userId) ? "registered" : "anonymous";
      this.chargePosting({ userId: input.userId, tier, ipKey: input.ipKey, now: effective });
      return this.startLiveText(input.kind, input, effective, {
        embedId: `embed_${randomKey()}`,
        text,
        post: { roomId: input.roomId, ...(title ? { title } : {}), ...(text ? { text } : {}), ...(replyTo ? { replyTo } : {}), identity: clone(input.identity) },
      });
    }));
  }

  /**
   * The write of a live text arrived (§4.8.3): a pending one within its
   * window starts streaming, once. A command's message is posted now, with
   * the embed's `url`; a message's is republished with it (§4.8.5). Null
   * when the write cannot start: unknown, used, or expired. A command's
   * message that can no longer be posted (its room or reply gone) throws,
   * and its text is forgotten.
   */
  claimLiveText(key: string, now = this.clock.now()): { entry: LiveEntry; broadcasts: Broadcast[]; message?: MessageSnapshot } | null {
    this.ensureReady();
    if (!this.config.liveText) return null;
    try {
      return this.reserved({ reads: 256, writes: 96 + LIVE_WRITES }, false, now, () => this.transaction(() => {
        const effective = this.effectiveNow(now);
        const entries = this.liveTexts();
        const entry = entries.find((candidate) => candidate.key === key);
        if (!entry || entry.state !== "pending" || effective > entry.writeExpiresMs) return null;
        let broadcasts: Broadcast[] = [];
        let message: MessageSnapshot | undefined;
        if (entry.post) {
          this.ensureGrowthCapacity(this.config.maxSnapshotBytes);
          const post = entry.post;
          const state = this.logState();
          const startLogId = state.last_log_id;
          const context: CommitContext = { state, commitMs: Math.max(effective, state.last_commit_ms), touched: new Map() };
          const params: Record<string, unknown> = {
            room_id: post.roomId,
            body: {
              text: post.text ?? "",
              ...(entry.kind === "append" ? { format: "markdown" } : {}),
              embeds: [{ kind: entry.kind, ...(post.title ? { title: post.title } : {}) }],
            },
            ...(post.replyTo ? { reply_to: { message_id: post.replyTo } } : {}),
          };
          const committed = this.commitMessage({ userId: entry.owner, ipKey: entry.ip, params, identity: post.identity }, context, state.history_floor, entry);
          this.finishCommit(context, startLogId);
          broadcasts = committed.broadcasts;
          message = committed.message;
          entry.messageId = message!.message_id;
          delete entry.post;
        } else if (entry.messageId) {
          const current = this.currentMessage(entry.messageId);
          const snapshot = current ? parseJson<MessageSnapshot>(current.snapshot_json) : null;
          const embeds = snapshot && !snapshot.deleted && Array.isArray(snapshot.body?.embeds) ? snapshot.body.embeds as Record<string, unknown>[] : [];
          const embed = embeds.find((candidate) => candidate.embed_id === entry.embedId);
          if (current && snapshot && embed) {
            this.ensureGrowthCapacity(this.config.maxSnapshotBytes);
            const og = entry.kind === "terminal" ? { og: terminalOg(embed.title, "live") } : {};
            broadcasts = this.rewriteEmbed(current, snapshot, entry.embedId, { ...embed, url: liveUrl(this.config.liveText!, entry), ...og }, effective);
          }
        }
        entry.state = "live";
        entry.startedMs = effective;
        this.saveLiveTexts(entries);
        return { entry, broadcasts, ...(message ? { message } : {}) };
      }));
    } catch (error) {
      // A message that cannot be posted any more will not be later either.
      if (error instanceof StoreError && ["invalid_params", "denied", "too_large"].includes(error.code)) {
        this.reserved({ reads: 4, writes: 4 }, true, now, () => this.transaction(() => this.dropLiveTexts((entry) => entry.key === key)));
      }
      throw error;
    }
  }

  /**
   * Ends a live text exactly once (§4.8.3) and publishes what it kept: a
   * terminal's message gets its embed with `output` (§4.8.6), and an
   * append's the kept text, after its edits, appended to `body.text` and
   * its embed removed (§4.8.5); with nothing kept, the embed is removed (a
   * message left with nothing is a tombstone). A text already ended, or whose message or
   * embed is gone, publishes nothing. Finishing work already admitted, it is
   * charged as maintenance, so an exhausted foreground budget cannot lose it.
   */
  finishLiveText(key: string, kept: Uint8Array | null, now = this.clock.now()): LiveFinish {
    this.ensureReady();
    if (!this.config.liveText) return { broadcasts: [] };
    return this.reserved({ reads: 96, writes: 64 + LIVE_WRITES }, true, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      const entries = this.liveTexts();
      const entry = entries.find((candidate) => candidate.key === key);
      if (!entry) return { broadcasts: [] };
      this.saveLiveTexts(entries.filter((candidate) => candidate !== entry));
      return { entry, broadcasts: this.publishLiveText(entry, kept, effective) };
    }));
  }

  /**
   * Ends the live texts that fell due: a write that never came by its
   * window's end (its message, if posted, loses the embed), and a text
   * marked streaming that `streaming` (the runtime's own) does not hold:
   * the object that streamed it was evicted or redeployed and its bytes are
   * gone, so its embed is removed. Maintenance work, bounded by `concurrent`
   * entries; `next` is when the next one falls due.
   */
  expireLiveTexts(streaming: ReadonlySet<string>, now = this.clock.now()): { broadcasts: Broadcast[]; ended: LiveEntry[]; next?: number } {
    this.ensureReady();
    if (!this.config.liveText) return { broadcasts: [], ended: [] };
    // Known to be none: nothing to read or reserve, so the alarm pays nothing for the feature.
    if (this.liveCache?.length === 0) return { broadcasts: [], ended: [] };
    return this.reserved({ reads: 32 + 64 * this.config.liveText.concurrent, writes: 8 + 32 * this.config.liveText.concurrent }, true, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      const entries = this.liveTexts();
      const due = entries.filter((entry) => entry.state === "pending" ? effective > entry.writeExpiresMs : !streaming.has(entry.key));
      const remaining = entries.filter((entry) => !due.includes(entry));
      const next = remaining.length ? Math.min(...remaining.map(liveDeadline)) : undefined;
      if (!due.length) return { broadcasts: [], ended: [], ...(next !== undefined ? { next } : {}) };
      this.saveLiveTexts(remaining);
      const broadcasts = due.flatMap((entry) => this.publishLiveText(entry, null, effective));
      return { broadcasts, ended: due, ...(next !== undefined ? { next } : {}) };
    }));
  }

  /** The snapshot that ends a live text (finishLiveText). */
  private publishLiveText(entry: LiveEntry, kept: Uint8Array | null, now: number): Broadcast[] {
    if (!entry.messageId) return [];
    const message = this.currentMessage(entry.messageId);
    const snapshot = message ? parseJson<MessageSnapshot>(message.snapshot_json) : null;
    const embeds = snapshot && !snapshot.deleted && Array.isArray(snapshot.body?.embeds) ? snapshot.body.embeds as Record<string, unknown>[] : [];
    const embed = embeds.find((candidate) => candidate.embed_id === entry.embedId);
    if (!message || !snapshot || !embed) return [];
    // What the entry keeps, whatever the caller held: the last part of a terminal, the first of an append.
    if (entry.kind === "terminal") {
      const output = terminalOutput(keepLast(kept ?? new Uint8Array(0), entry.limit));
      // Its `url` ends with the text: the output is the embed's now (§4.8.6).
      const { url: _url, ...rest } = embed;
      void _url;
      return this.rewriteEmbed(message, snapshot, entry.embedId, output ? { ...rest, output, og: terminalOg(rest.title, "finished") } : null, now);
    }
    const base = typeof snapshot.body?.text === "string" ? snapshot.body.text : "";
    // A save may have lengthened the text while it streamed: the body stays within the text limit.
    // The edits (§4.8.5) apply to the appended text only, never to `base`.
    const room = Math.max(0, this.config.maxTextBytes - utf8Bytes(base));
    const added = keepAppend(kept ?? new Uint8Array(0), Math.min(entry.limit, room));
    return this.rewriteEmbed(message, snapshot, entry.embedId, null, now, base + liveTextString(added));
  }

  /** An admin's `/toggle` of a feature, or undefined while it follows the deployment's default. */
  toggle(feature: string, now = this.clock.now()): boolean | undefined {
    this.ensureReady();
    return this.reserved({ reads: 4 }, false, now, () => {
      const value = this.metaValue(META_TOGGLE_PREFIX + feature);
      return value === "on" ? true : value === "off" ? false : undefined;
    });
  }

  /**
   * The `presence` toggle (as toggle has it) and when presence was last
   * turned on with it (META_PRESENCE_ON), if ever, in one statement: two
   * primary-key lookups of `_meta`, of which a missing row reads nothing.
   */
  presenceToggle(now = this.clock.now()): { on: boolean | undefined; since?: number } {
    this.ensureReady();
    return this.reserved({ reads: 4 }, false, now, () => {
      const rows = this.rawRows<{ key: string; value: string }>("SELECT key, value FROM _meta WHERE key IN (?, ?)", META_TOGGLE_PREFIX + "presence", META_PRESENCE_ON);
      const value = rows.find((row) => row.key === META_TOGGLE_PREFIX + "presence")?.value;
      const since = Number(rows.find((row) => row.key === META_PRESENCE_ON)?.value);
      return { on: value === "on" ? true : value === "off" ? false : undefined, ...(Number.isSafeInteger(since) && since > 0 ? { since } : {}) };
    });
  }

  /**
   * Sets or, with undefined, clears an admin's `/toggle` of a feature. With
   * `uploads` off, new upload embeds and `/avatar` are `denied`; writes
   * already started still finish. With `since`, presence was turned on
   * then: it is kept too (META_PRESENCE_ON), in the same reservation.
   */
  setToggle(feature: string, on: boolean | undefined, now = this.clock.now(), since?: number): void {
    this.ensureReady();
    this.reserved({ reads: 4, writes: 8 }, false, now, () => this.transaction(() => {
      if (on === undefined) this.rawExec("DELETE FROM _meta WHERE key = ?", META_TOGGLE_PREFIX + feature);
      else this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_TOGGLE_PREFIX + feature, on ? "on" : "off");
      if (since !== undefined) this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_PRESENCE_ON, String(since));
    }));
  }

  /**
   * Starts an avatar upload (protocol §4.8.7): `/avatar` with one `upload`
   * embed. The avatar is set when the write finishes (finishUpload).
   */
  startAvatarUpload(input: { userId: string; now?: number }): PendingUpload {
    this.ensureReady();
    const now = input.now ?? this.clock.now();
    return this.reserved({ reads: 32, writes: UPLOAD_WRITES + 8 }, false, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      return this.startUpload("avatar", input.userId, effective, { embedId: `embed_${randomKey()}` });
    }));
  }

  /**
   * Starts a custom emoji upload (extension `ext:emoji`): `/emoji add
   * :name:` with one `upload` embed, by a holder of one of EMOJI_ROLES. The
   * upload row keeps the key in `message_id`, and is the server's
   * (EMOJI_OWNER); it counts
   * against the user's and the server's daily uploads and the stored-bytes
   * cap like any other. The catalog changes when the write finishes
   * (emojiDraft, commitEmoji). A new key past `maxEmoji` is `denied`.
   */
  startEmojiUpload(input: { userId: string; key: string; now?: number }): PendingUpload {
    this.ensureReady();
    const now = input.now ?? this.clock.now();
    return this.reserved({ reads: 32, writes: UPLOAD_WRITES + 8 }, false, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      const catalog = this.loadEmojiCatalog();
      const most = this.config.uploads?.maxEmoji ?? 0;
      if (!catalog.keys.has(input.key) && catalog.keys.size >= most) throw new StoreError("denied", `This server keeps at most ${most} custom emoji; remove one first`);
      return this.startUpload("emoji", input.userId, effective, { messageId: input.key, embedId: `embed_${randomKey()}` }, EMOJI_OWNER);
    }));
  }

  /**
   * Starts the server's avatar upload (§3.1, §4.8.7): `/server avatar` with
   * one `upload` embed, by an admin. Kept like a custom emoji: the server's
   * (SERVER_OWNER), never expiring, an avatar in size, and counted against
   * the admin's and the server's daily uploads and the stored-bytes cap.
   * The avatar is set when the write finishes (finishUpload).
   */
  startServerAvatarUpload(input: { userId: string; now?: number }): PendingUpload {
    this.ensureReady();
    const now = input.now ?? this.clock.now();
    return this.reserved({ reads: 32, writes: UPLOAD_WRITES + 8 }, false, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      return this.startUpload("server", input.userId, effective, { embedId: `embed_${randomKey()}` }, SERVER_OWNER);
    }));
  }

  /**
   * The server's `title`, `description` and `avatar` as admins set them with
   * `/server`, each absent while its deployment variable applies. Read once
   * after a wake (three primary-key lookups of `_meta`), then kept in memory.
   */
  serverMetadata(now = this.clock.now()): StoredServerMetadata {
    this.ensureReady();
    return { ...(this.serverCache ?? this.reserved({ reads: 4 }, false, now, () => this.loadServerMetadata())) };
  }

  /** The cached server metadata, read from its `_meta` rows on first need; the caller holds a reservation. */
  private loadServerMetadata(): StoredServerMetadata {
    if (this.serverCache) return this.serverCache;
    const rows = this.rawRows<{ key: string; value: string }>(
      "SELECT key, value FROM _meta WHERE key IN (?, ?, ?)",
      ...SERVER_FIELDS.map((field) => META_SERVER_PREFIX + field),
    );
    const stored: StoredServerMetadata = {};
    for (const field of SERVER_FIELDS) {
      const value = rows.find((row) => row.key === META_SERVER_PREFIX + field)?.value;
      if (value) stored[field] = value;
    }
    this.serverCache = stored;
    return stored;
  }

  /** Keeps one stored server field, or with undefined forgets it; the caller holds a reservation. */
  private writeServerField(field: (typeof SERVER_FIELDS)[number], value: string | undefined): void {
    const stored = { ...this.loadServerMetadata() };
    if (value === undefined) {
      this.rawExec("DELETE FROM _meta WHERE key = ?", META_SERVER_PREFIX + field);
      delete stored[field];
    } else {
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_SERVER_PREFIX + field, value);
      stored[field] = value;
    }
    this.serverCache = stored;
  }

  /**
   * Sets the server's `title` or `description` (`/server title <text>`,
   * `/server description <text>`), or with undefined clears it, so its
   * deployment variable applies again. The caller validates the value.
   */
  setServerText(field: "title" | "description", value: string | undefined, now = this.clock.now()): void {
    this.ensureReady();
    this.reserved({ reads: 8, writes: 8 }, false, now, () => this.transaction(() => this.writeServerField(field, value)));
  }

  /**
   * Clears the server's avatar (`/server avatar` alone), so `SERVER_AVATAR`
   * applies again: forgets its URL and releases its upload, whose R2 object
   * the caller deletes. Returns whether one was set.
   */
  clearServerAvatar(now = this.clock.now()): { changed: boolean; deletedUploads: string[] } {
    this.ensureReady();
    // Its upload is found by a scan of every upload the server owns (uploadsPerOwner).
    return this.reserved({ reads: 32 + this.uploadsPerOwner(SERVER_OWNER), writes: 32 }, false, now, () => this.transaction(() => {
      const changed = this.loadServerMetadata().avatar !== undefined;
      if (changed) this.writeServerField("avatar", undefined);
      const rows = this.rawRows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
         FROM uploads INDEXED BY uploads_owner_idx WHERE owner_id = ? AND purpose = 'server' AND state = 'done' LIMIT 8`,
        SERVER_OWNER,
      );
      return { changed, deletedUploads: this.releaseUploadRows(rows) };
    }));
  }

  /**
   * The custom emoji catalog (extension `ext:emoji`): its `catalog_url` on
   * the media origin and its keys, or null while it is empty or uploads are
   * not configured. Read once after a wake (one row), then kept in memory.
   */
  emojiCatalog(now = this.clock.now()): { url: string; keys: ReadonlySet<string> } | null {
    this.ensureReady();
    const origin = this.config.uploads?.mediaOrigin;
    if (!origin) return null;
    const catalog = this.emojiCache ?? this.reserved({ reads: 4 }, false, now, () => this.loadEmojiCatalog());
    return catalog.key ? { url: `${origin}/${catalog.key}`, keys: catalog.keys } : null;
  }

  /** The cached catalog, read from META_EMOJI_CATALOG on first need; the caller holds a reservation. */
  private loadEmojiCatalog(): NonNullable<Store["emojiCache"]> {
    if (this.emojiCache) return this.emojiCache;
    const json = this.metaValue(META_EMOJI_CATALOG);
    const parsed = json ? parseJson<unknown>(json, null) : null;
    const entries = isPlainObject(parsed) ? parsed as Record<string, EmojiEntry> : {};
    this.emojiCache = this.emojiCacheFor(Object.keys(entries).length ? json : "", entries);
    return this.emojiCache;
  }

  private emojiCacheFor(json: string, entries: Record<string, EmojiEntry>): NonNullable<Store["emojiCache"]> {
    return { key: json ? emojiObjectKey(json) : null, json, entries, keys: new Set(Object.keys(entries)) };
  }

  /**
   * The catalog an edit leads to, changing nothing, so the caller can
   * publish it to R2 before commitEmoji makes it current: with an added
   * key's entry (its image's `url`, and `width` and `height` where the
   * write found them), or without a removed one. Null when the edit cannot
   * apply: a write that is not an emoji's, failed, came too late or is not
   * an image, or a new key past `maxEmoji` (finishUpload then releases
   * it), or a removed key the catalog lacks.
   */
  emojiDraft(edit: EmojiEdit, now = this.clock.now()): EmojiDraft | null {
    this.ensureReady();
    const origin = this.config.uploads?.mediaOrigin;
    if (!origin) return null;
    return this.reserved({ reads: 16 }, false, now, () => {
      const catalog = this.loadEmojiCatalog();
      let entries: Record<string, EmojiEntry>;
      if ("add" in edit) {
        const write = edit.add;
        const row = this.uploadRow(write.key);
        if (!row || row.purpose !== "emoji" || !row.message_id || !this.emojiWriteAccepted(row, write, this.effectiveNow(now))) return null;
        if (!catalog.keys.has(row.message_id) && catalog.keys.size >= (this.config.uploads?.maxEmoji ?? 0)) return null;
        const entry: EmojiEntry = { url: `${origin}/${row.upload_key}`, ...(write.width && write.height ? { width: write.width, height: write.height } : {}) };
        entries = { ...catalog.entries, [row.message_id]: entry };
      } else {
        if (!catalog.keys.has(edit.remove)) return null;
        entries = Object.fromEntries(Object.entries(catalog.entries).filter(([key]) => key !== edit.remove));
      }
      const json = Object.keys(entries).length ? JSON.stringify(entries) : "";
      return { edit, json, key: json ? emojiObjectKey(json) : null, entries };
    });
  }

  /** Whether a finished write may become a custom emoji: still writing, in time, an image within its size. */
  private emojiWriteAccepted(row: RawUploadRow, write: UploadWrite, now: number): boolean {
    return row.state === "writing" && now <= row.write_expires_ms + UPLOAD_WRITE_GRACE_MS &&
      write.ok && typeof write.bytes === "number" && write.bytes > 0 && write.bytes <= row.bytes && !!write.contentType?.startsWith("image/");
  }

  /**
   * Makes a draft's catalog current, in one transaction with the edit: an
   * added key's upload is done. The catalog before this one becomes the
   * previous (META_EMOJI_PREVIOUS), and the image an add replaces or a
   * remove removes is `superseded`: both stay for clients that just read
   * the previous `catalog_url`. The catalog before that, and the images
   * superseded with it, are released. Returns whether it applied (a draft
   * whose catalog changed meanwhile, or whose write is no longer
   * acceptable, does not), and the R2 objects the caller deletes.
   */
  commitEmoji(draft: EmojiDraft, now = this.clock.now()): { applied: boolean; deletedUploads: string[] } {
    this.ensureReady();
    const most = this.config.uploads?.maxEmoji ?? 0;
    const result = this.reserved({ reads: 96, writes: 96 + UPLOAD_WRITES }, false, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      const before = this.loadEmojiCatalog();
      // Everything is checked before anything is written.
      const write = "add" in draft.edit ? draft.edit.add : null;
      const row = write ? this.uploadRow(write.key) : null;
      const name = row ? row.message_id : "remove" in draft.edit ? draft.edit.remove : null;
      if (!name || (write && (!row || row.purpose !== "emoji" || !this.emojiWriteAccepted(row, write, effective)))) return null;
      if (row && draft.entries[name]?.url !== `${this.config.uploads?.mediaOrigin}/${row.upload_key}`) return null;
      if (row && !before.keys.has(name) && before.keys.size >= most) return null;
      // The draft must have been made from the catalog as it still is.
      const expected: Record<string, EmojiEntry> = { ...before.entries };
      if (row) expected[name] = draft.entries[name];
      else delete expected[name];
      if (JSON.stringify(expected) !== (draft.json || "{}")) return null;
      if (row) this.completeUploadRow(row, write!.bytes!);
      // The images the last change superseded, which only the previous
      // catalog refers to, go with it: at most the 8 one change supersedes.
      // An image is never referred to again once superseded, since an add
      // always brings a new upload, so this holds even when the catalog
      // returns to the previous one (an add, then a remove of that key).
      const superseded = this.rawRows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
         FROM uploads INDEXED BY uploads_pending_idx WHERE state = 'superseded' LIMIT 16`,
      );
      const deletedUploads = this.releaseUploadRows(superseded);
      // The image this change replaces or removes stays, with its bytes,
      // while the catalog before this one does.
      const replaced = this.rawRows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
         FROM uploads INDEXED BY uploads_message_idx WHERE message_id = ? AND purpose = 'emoji' AND state = 'done' LIMIT 8`,
        name,
      ).filter((candidate) => candidate.upload_key !== row?.upload_key);
      for (const candidate of replaced) this.rawExec("UPDATE uploads SET state = 'superseded' WHERE upload_key = ?", candidate.upload_key);
      if (draft.json) this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_EMOJI_CATALOG, draft.json);
      else this.rawExec("DELETE FROM _meta WHERE key = ?", META_EMOJI_CATALOG);
      // The catalog before this one stays until the next change; the one
      // before that goes now.
      const previous = this.metaValue(META_EMOJI_PREVIOUS);
      if (previous && previous !== draft.key && previous !== before.key) deletedUploads.push(previous);
      if (before.key && before.key !== draft.key) this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_EMOJI_PREVIOUS, before.key);
      else if (previous) this.rawExec("DELETE FROM _meta WHERE key = ?", META_EMOJI_PREVIOUS);
      return deletedUploads;
    }));
    if (!result) return { applied: false, deletedUploads: [] };
    this.emojiCache = this.emojiCacheFor(draft.json, draft.entries);
    return { applied: true, deletedUploads: result };
  }

  /**
   * Finishes a write exactly once (protocol §4.8.3). A file's message gets a
   * new snapshot, with the embed completed (`url`, and `og.image` or, for a
   * voice clip, `og.audio` describing it) or, for a failed write, without it; an avatar becomes its owner's.
   * A write that is not pending, came too late, or whose embed or message is
   * gone is not accepted, and its object is the caller's to delete.
   */
  finishUpload(write: UploadWrite, now = this.clock.now()): UploadFinish {
    this.ensureReady();
    // A user's or the server's avatar write scans its owner's uploads for the
    // one it replaces, so the reservation is sized by the owner, read first.
    const owner = this.reserved({ reads: 4 }, false, now, () => this.uploadRow(write.key)?.owner_id ?? "");
    return this.reserved({ reads: 96 + this.uploadsPerOwner(owner), writes: 64 + UPLOAD_WRITES }, false, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      const row = this.uploadRow(write.key);
      if (!row || row.state !== "writing" || effective > row.write_expires_ms + UPLOAD_WRITE_GRACE_MS) {
        return { accepted: false, broadcasts: [], deletedUploads: [] };
      }
      return this.completeUpload(row, write, effective);
    }));
  }

  /**
   * Claims a pending upload's write for the one request that arrived in its
   * window, before any byte reaches R2: a `write_url` used again is refused,
   * so it cannot overwrite a finished upload. The claim is charged to the
   * server's daily upload count (`uploadsPerDay`); past it, `"closed"`, and
   * the upload stays pending until it is written after the daily reset or
   * its window closes.
   */
  claimUpload(key: string, now = this.clock.now()): boolean | "closed" {
    this.ensureReady();
    return this.reserved({ reads: 16, writes: 16 }, false, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      const row = this.uploadRow(key);
      if (!row || row.state !== "pending" || effective > row.write_expires_ms) return false;
      const policy = this.config.uploads;
      if (policy) {
        const day = dayFor(effective);
        const global = this.limitRow("upload", "global", effective);
        const count = global.day === day ? global.uploads_day : 0;
        if (count >= policy.uploadsPerDay) return "closed";
        this.updateLimitRow(global, { day, uploads_day: count + 1 }, effective);
      }
      this.rawExec("UPDATE uploads SET state = 'writing' WHERE upload_key = ?", key);
      return true;
    }));
  }

  private completeUpload(row: RawUploadRow, write: UploadWrite, now: number): UploadFinish {
    const ok = write.ok && typeof write.bytes === "number" && write.bytes > 0 && write.bytes <= row.bytes && !!write.contentType;
    const url = `${this.config.uploads?.mediaOrigin ?? ""}/${row.upload_key}`;
    // A custom emoji's write is accepted only through emojiDraft and
    // commitEmoji, which publish the catalog first; here it fails.
    if (row.purpose === "emoji") return { accepted: false, broadcasts: [], deletedUploads: this.releaseUploadRows([row]) };
    if (row.purpose === "avatar") {
      const identity = this.identityRow(row.owner_id);
      if (!ok || !identity || !write.contentType!.startsWith("image/")) return { accepted: false, broadcasts: [], deletedUploads: this.releaseUploadRows([row]) };
      this.completeUploadRow(row, write.bytes!);
      const replaced = this.rawRows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
         FROM uploads INDEXED BY uploads_owner_idx WHERE owner_id = ? AND purpose = 'avatar' AND state = 'done' AND upload_key <> ? LIMIT 8`,
        row.owner_id, row.upload_key,
      );
      this.rawExec("UPDATE identities SET avatar_url = ?, avatar_expires_ms = ?, updated_ms = ? WHERE user_id = ?", url, row.expires_ms, now, row.owner_id);
      return { accepted: true, broadcasts: [], avatar: { userId: row.owner_id, url }, deletedUploads: this.releaseUploadRows(replaced) };
    }
    if (row.purpose === "server") {
      if (!ok || !write.contentType!.startsWith("image/")) return { accepted: false, broadcasts: [], deletedUploads: this.releaseUploadRows([row]) };
      this.completeUploadRow(row, write.bytes!);
      // The avatar it replaces goes at once, as a user's does.
      const replaced = this.rawRows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
         FROM uploads INDEXED BY uploads_owner_idx WHERE owner_id = ? AND purpose = 'server' AND state = 'done' AND upload_key <> ? LIMIT 8`,
        SERVER_OWNER, row.upload_key,
      );
      this.writeServerField("avatar", url);
      return { accepted: true, broadcasts: [], serverAvatar: url, deletedUploads: this.releaseUploadRows(replaced) };
    }
    const message = row.message_id ? this.currentMessage(row.message_id) : null;
    const snapshot = message ? parseJson<MessageSnapshot>(message.snapshot_json) : null;
    const embeds = snapshot && !snapshot.deleted && Array.isArray(snapshot.body?.embeds) ? snapshot.body.embeds as Record<string, unknown>[] : [];
    const embed = embeds.find((candidate) => candidate.embed_id === row.embed_id);
    if (!message || !snapshot || !embed) return { accepted: false, broadcasts: [], deletedUploads: this.releaseUploadRows([row]) };
    let replacement: Record<string, unknown> | null = null;
    let deletedUploads: string[] = [];
    if (ok) {
      this.completeUploadRow(row, write.bytes!);
      const size = write.width && write.height ? { width: write.width, height: write.height } : {};
      const media = write.contentType!.startsWith("audio/") ? { audio: { url, type: write.contentType } } : { image: { url, type: write.contentType, ...size } };
      replacement = { ...embed, url, og: { ...(typeof embed.title === "string" ? { title: embed.title } : {}), ...media } };
    } else deletedUploads = this.releaseUploadRows([row]);
    return { accepted: ok, broadcasts: this.rewriteEmbed(message, snapshot, row.embed_id!, replacement, now), deletedUploads };
  }

  /**
   * A server-made snapshot of a message with one embed replaced, or removed
   * when `replacement` is null. A message left with no text and no embeds is
   * a tombstone, like a deletion.
   */
  private rewriteEmbed(message: RawMessageRow, snapshot: MessageSnapshot, embedId: string, replacement: Record<string, unknown> | null, now: number, text?: string): Broadcast[] {
    const state = this.logState();
    const startLogId = state.last_log_id;
    const context: CommitContext = { state, commitMs: Math.max(now, state.last_commit_ms), touched: new Map() };
    const logId = this.allocateLogId(context);
    const embeds = (snapshot.body?.embeds as Record<string, unknown>[]).flatMap((embed) => (embed.embed_id === embedId ? (replacement ? [replacement] : []) : [embed]));
    const { prev_room_id: _moved, body: previousBody, ...rest } = snapshot;
    const next: MessageSnapshot = { ...rest, log_id: idString(logId), prev_log_id: idString(message.latest_log_id) };
    const nextText = text ?? previousBody?.text;
    if (nextText === "" && !embeds.length) next.deleted = true;
    else {
      next.body = { ...previousBody, ...(text !== undefined ? { text } : {}), embeds };
      // An append that moved into the text leaves an ordinary message (§4.8.5).
      if (text !== undefined && !embeds.length) delete next.body.embeds;
    }
    const json = JSON.stringify(next);
    this.appendRecord(context, [message.room_id], "message", logId, json);
    this.rawExec("UPDATE message_state SET latest_log_id = ? WHERE message_id = ?", logId, message.message_id);
    this.finishCommit(context, startLogId);
    return [{ method: "message", params: clone(next) as unknown as Record<string, unknown>, rooms: [message.room_id] }];
  }

  /**
   * Fails pending uploads whose write never came (protocol §4.8.3): their
   * messages get a snapshot without the embed. Maintenance work, a bounded
   * batch per call; `next` is when the next one falls due.
   */
  expirePendingUploads(now = this.clock.now()): { broadcasts: Broadcast[]; deletedUploads: string[]; next?: number } {
    this.ensureReady();
    const done = { broadcasts: [] as Broadcast[], deletedUploads: [] as string[] };
    if (!this.config.uploads) return done;
    const due = this.reserved({ reads: 16 + UPLOAD_SWEEP_BATCH }, true, now, () => this.rawRows<RawUploadRow>(
      `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
       FROM uploads INDEXED BY uploads_pending_idx WHERE state IN ('pending', 'writing') AND write_expires_ms < ?
       ORDER BY write_expires_ms LIMIT ?`,
      this.effectiveNow(now) - UPLOAD_WRITE_GRACE_MS, UPLOAD_SWEEP_BATCH,
    ));
    for (const row of due) {
      const finished = this.reserved({ reads: 96, writes: 64 + UPLOAD_WRITES }, true, now, () => this.transaction(() => {
        const current = this.uploadRow(row.upload_key);
        return current && current.state !== "done" ? this.completeUpload(current, { key: row.upload_key, ok: false }, this.effectiveNow(now)) : null;
      }));
      if (!finished) continue;
      done.broadcasts.push(...finished.broadcasts);
      done.deletedUploads.push(...finished.deletedUploads);
    }
    const next = this.reserved({ reads: 8 }, true, now, () => this.rawRows<{ due: number | null }>(
      "SELECT MIN(write_expires_ms) AS due FROM uploads INDEXED BY uploads_pending_idx WHERE state IN ('pending', 'writing')",
    )[0]?.due);
    return typeof next === "number" ? { ...done, next: next + UPLOAD_WRITE_GRACE_MS } : done;
  }

  /**
   * When the earliest pending upload's write runs out, grace included, or
   * undefined with none pending: one indexed read, for an alarm that woke
   * without knowing (ApronDemoServer.alarmWorkDue).
   */
  nextUploadDeadline(now = this.clock.now()): number | undefined {
    this.ensureReady();
    if (!this.config.uploads) return undefined;
    const next = this.reserved({ reads: 8 }, true, now, () => this.rawRows<{ due: number | null }>(
      "SELECT MIN(write_expires_ms) AS due FROM uploads INDEXED BY uploads_pending_idx WHERE state IN ('pending', 'writing')",
    )[0]?.due);
    return typeof next === "number" ? next + UPLOAD_WRITE_GRACE_MS : undefined;
  }

  /**
   * Forgets uploads past their expiry plus the lifecycle lag, when R2 has
   * deleted them, freeing their bytes; an expired avatar leaves its owner.
   * Maintenance work, a bounded batch per call.
   */
  cleanupUploads(now = this.clock.now()): number {
    this.ensureReady();
    const policy = this.config.uploads;
    if (!policy) return 0;
    return this.reserved({ reads: 16 + 4 * UPLOAD_SWEEP_BATCH, writes: 8 + 12 * UPLOAD_SWEEP_BATCH }, true, now, () => this.transaction(() => {
      const rows = this.rawRows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
         FROM uploads INDEXED BY uploads_expiry_idx WHERE expires_ms < ? ORDER BY expires_ms LIMIT ?`,
        this.effectiveNow(now) - policy.lifecycleLagSeconds * 1_000, UPLOAD_SWEEP_BATCH,
      );
      for (const row of rows) {
        if (row.purpose !== "avatar") continue;
        this.rawExec(
          "UPDATE identities SET avatar_url = '', avatar_expires_ms = 0 WHERE user_id = ? AND avatar_url = ?",
          row.owner_id, `${policy.mediaOrigin}/${row.upload_key}`,
        );
      }
      this.releaseUploadRows(rows);
      return rows.length;
    }));
  }

  /**
   * A user's avatar key when it is due to be written again: live, and within
   * `avatarRefreshSeconds` of its expiry.
   */
  avatarRefreshDue(userId: string, now = this.clock.now()): string | null {
    this.ensureReady();
    const policy = this.config.uploads;
    if (!policy) return null;
    return this.reserved({ reads: 8 }, false, now, () => {
      const row = this.identityRow(userId);
      const prefix = `${policy.mediaOrigin}/`;
      if (!row?.avatar_url.startsWith(prefix) || row.avatar_expires_ms <= now) return null;
      return row.avatar_expires_ms - now <= policy.avatarRefreshSeconds * 1_000 ? row.avatar_url.slice(prefix.length) : null;
    });
  }

  /** Restarts an avatar's expiry after its object was written again. */
  renewAvatar(input: { userId: string; key: string; now?: number }): void {
    this.ensureReady();
    const policy = this.config.uploads;
    if (!policy) return;
    const now = input.now ?? this.clock.now();
    this.reserved({ reads: 16, writes: 16 }, false, now, () => this.transaction(() => {
      const expires = this.effectiveNow(now) + policy.avatarRetentionSeconds * 1_000;
      this.rawExec("UPDATE uploads SET expires_ms = ? WHERE upload_key = ? AND owner_id = ?", expires, input.key, input.userId);
      this.rawExec(
        "UPDATE identities SET avatar_expires_ms = ? WHERE user_id = ? AND avatar_url = ?",
        expires, input.userId, `${policy.mediaOrigin}/${input.key}`,
      );
    }));
  }

  /** Removes a user's avatar (`me` with `avatar: ""`, §3.3); returns whether one was set and the keys to delete. */
  clearAvatar(input: { userId: string; now?: number }): { changed: boolean; deletedUploads: string[] } {
    this.ensureReady();
    const now = input.now ?? this.clock.now();
    // The avatar's upload is found by a scan of every upload the user owns (uploadsPerOwner).
    return this.reserved({ reads: 32 + this.uploadsPerOwner(input.userId), writes: 32 }, false, now, () => this.transaction(() => {
      const identity = this.identityRow(input.userId);
      const rows = this.rawRows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
         FROM uploads INDEXED BY uploads_owner_idx WHERE owner_id = ? AND purpose = 'avatar' AND state = 'done' LIMIT 8`,
        input.userId,
      );
      const changed = !!identity?.avatar_url;
      if (changed) this.rawExec("UPDATE identities SET avatar_url = '', avatar_expires_ms = 0, updated_ms = ? WHERE user_id = ?", this.effectiveNow(now), input.userId);
      return { changed, deletedUploads: this.releaseUploadRows(rows) };
    }));
  }

  /**
   * `push_register` (protocol §4.9, kind `webpush`): keeps a registered
   * user's registration of the endpoint `url`, with its `push_id` and the
   * `wake` scopes it wakes for (a WAKE_SCOPES bitmask, DEFAULT_WAKE when not
   * given; `joined` is kept only for a user holding one of
   * JOINED_WAKE_ROLES, and dropped for anyone else, as a scope this server
   * does not offer them). Registrations are the user's own: registering a `url` the user
   * holds again replaces its keys, `push_id` (removing one now absent) and
   * scopes, and two
   * users may register the same `url`. A user past `subscriptionsPerUser`
   * loses the least recently registered of the others. Clients register on
   * every connection, so an unchanged registration (keys, `push_id`, scopes)
   * registered again within a day writes nothing; one not registered for
   * `pushExpiryDays` is skipped by wakes and deleted by cleanup.
   */
  registerPushSubscription(input: { userId: string; url: string; p256dh: string; auth: string; pushId?: string; wake?: number; now?: number }): void {
    this.ensureReady();
    const policy = this.config.push;
    if (!policy) throw new StoreError("unsupported", "Push is not available here");
    if (utf8Bytes(input.url) > MAX_PUSH_URL_BYTES) throw new StoreError("too_large", "url is too long");
    if (input.pushId !== undefined && !PUSH_ID_PATTERN.test(input.pushId)) throw new StoreError("invalid_params", "push_id must be 1 to 64 letters, digits, _ or -");
    const requested = input.wake ?? DEFAULT_WAKE;
    if (!Number.isInteger(requested) || requested < 0 || (requested & ~ALL_WAKE) !== 0) throw new StoreError("invalid_params", "wake must name known scopes");
    const now = input.now ?? this.clock.now();
    // The row and the user's index range; each eviction rewrites a row and
    // its index entries, four for one that keeps `joined`.
    const rows = MAX_PUSH_SUBSCRIPTIONS_PER_USER + 2;
    return this.reserved({ reads: 32 + 2 * rows, writes: 32 + 6 * rows }, false, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      const identity = this.identityRow(input.userId);
      if (!identity) throw new StoreError("denied", "Sign in to receive push notifications");
      const moderator = identity.tier === "registered" && parseRoles(identity.roles_json).some((role) => JOINED_WAKE_ROLES.includes(role));
      const wake = moderator ? requested : requested & ~WAKE_SCOPES.joined;
      const pushId = input.pushId ?? null;
      const existing = this.rawRows<{ p256dh: string; auth: string; push_id: string | null; wake: number; updated_ms: number }>(
        "SELECT p256dh, auth, push_id, wake, updated_ms FROM push_subscriptions WHERE user_id = ? AND url = ? LIMIT 1",
        input.userId, input.url,
      )[0];
      if (existing && existing.p256dh === input.p256dh && existing.auth === input.auth && existing.push_id === pushId && integerColumn(existing.wake) === wake &&
          effective - integerColumn(existing.updated_ms) < PUSH_REFRESH_MS) return;
      if (!existing) this.ensureGrowthCapacity(2 * MAX_PUSH_URL_BYTES);
      this.rawExec(
        `INSERT INTO push_subscriptions (user_id, url, p256dh, auth, push_id, wake, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, url) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, push_id = excluded.push_id, wake = excluded.wake, updated_ms = excluded.updated_ms`,
        input.userId, input.url, input.p256dh, input.auth, pushId, wake, effective, effective,
      );
      // The new one never goes, even when it shares its millisecond with others.
      this.rawExec(
        `DELETE FROM push_subscriptions WHERE user_id = ? AND url IN (
           SELECT url FROM push_subscriptions
           WHERE user_id = ? AND url <> ? ORDER BY updated_ms DESC LIMIT -1 OFFSET ?)`,
        input.userId, input.userId, input.url, policy.subscriptionsPerUser - 1,
      );
    }));
  }

  /** `push_unregister` (protocol §4.9): removes the user's own registration of `url`, if any. */
  removePushSubscription(input: { userId: string; url: string; now?: number }): void {
    this.ensureReady();
    const now = input.now ?? this.clock.now();
    this.reserved({ reads: 16, writes: 16 }, false, now, () => {
      this.rawExec("DELETE FROM push_subscriptions WHERE user_id = ? AND url = ?", input.userId, input.url);
    });
  }

  /**
   * The users who may wake for `joined` (§4.9.4): those with a live
   * registration that kept it (JOINED_WAKE_ROLES), most recently registered
   * first, at most MAX_PUSH_CANDIDATES. One range of
   * `push_subscriptions_joined_idx`, which only their registrations are in,
   * of at most `subscriptionsPerUser` rows a user; claimPushes checks each
   * one's role and membership again, as either may have changed since.
   */
  joinedWakers(now = this.clock.now()): string[] {
    this.ensureReady();
    const policy = this.config.push;
    if (!policy) return [];
    const rows = MAX_PUSH_CANDIDATES * policy.subscriptionsPerUser;
    return this.reserved({ reads: 8 + rows }, false, now, () => {
      const live = this.effectiveNow(now) - policy.pushExpiryDays * 86_400_000;
      const found = this.rawRows<{ user_id: string }>(
        `SELECT user_id FROM push_subscriptions INDEXED BY push_subscriptions_joined_idx
         WHERE ${JOINED_WAKE_CONDITION} AND updated_ms >= ? ORDER BY updated_ms DESC LIMIT ?`,
        live, rows,
      );
      return [...new Set(found.map((row) => row.user_id))].slice(0, MAX_PUSH_CANDIDATES);
    });
  }

  /**
   * The registrations a new message in `roomId` pushes to (protocol §4.9).
   * `candidates` are the users the caller found unattended among those the
   * message mentions or replies to, each with the scopes it qualifies under,
   * at most MAX_PUSH_CANDIDATES. Each is looked up in turn: `joined` counts
   * only for a registered user holding one of JOINED_WAKE_ROLES who is a
   * member of the room or, for a thread, of its parent (an identity read
   * and up to two membership probes, for those considered for it); then only its
   * unexpired registrations whose `wake` includes one of those scopes count,
   * and one with none is passed over without taking a wake; so is one that a
   * mute or a `dnd` status silences (protocol §4.9: a silenced push
   * goes only to `badge` registrations, which this server does not have):
   * its unscoped mute, or its mute of the room or, for a thread, of the
   * thread's parent; one woken for this room within `coalesceSeconds` is
   * passed over too; the rest are woken, up to
   * `wakesPerMessage` users, on each of their registrations (most recently
   * registered first). Pushes are charged as they are claimed, delivered
   * or not, to the sender's `pushesPerSenderDay`, the recipient's
   * `pushesPerRecipientDay` and the server's `pushesPerDay`; past any of
   * them, what is left is `skipped`. A user pushed only for `joined` is
   * charged instead to their `joinedPushesPerRecipientDay` and the server's
   * allowance, not the sender's, and coalesced by `joinedCoalesceSeconds`.
   * Each user woken for anything but `joined` alone has their `unread`
   * (PUSH_UNREAD_SCOPE) counted up by one in the recipient counter the claim
   * reads and writes anyway, and every registration claimed for them carries
   * it; a push for `joined` alone, or an operator alert, carries none.
   * A sender is charged for a push that
   * fails too, so registrations that always fail cannot let one sender
   * spend the server's day. With
   * `allowed`, a registration whose endpoint it refuses (PUSH_HOSTS) is
   * passed over before it counts. Each woken user's time for the room is kept for coalescing.
   * Each claimed registration carries the scopes it is pushed for. An
   * operator `alert` (ApronDemoServer.notifyAdmins) skips the coalescing
   * window and the allowances, though it is counted against them; a mute
   * or `dnd` still silences it (§4.9).
   */
  claimPushes(input: { senderId: string; roomId: string; candidates: readonly PushCandidate[]; allowed?: (url: string) => boolean; now?: number; alert?: boolean }): PushClaim {
    this.ensureReady();
    const policy = this.config.push;
    const reasons = new Map<string, number>();
    for (const candidate of input.candidates) reasons.set(candidate.userId, (reasons.get(candidate.userId) ?? 0) | candidate.reasons);
    const candidates = [...reasons.keys()].slice(0, MAX_PUSH_CANDIDATES);
    const claim: PushClaim = { subscriptions: [], skipped: 0 };
    if (!policy || !candidates.length) return claim;
    const now = input.now ?? this.clock.now();
    // Each candidate's status row, live index range, two room mute probes,
    // wake row, recipient counter, in a private room membership row and, for
    // `joined`, identity row and two membership probes; the room's parent, read once; the
    // server's and sender's counters; and for each woken user a wake row and
    // the recipient counter, created on a user's first push of the day.
    const cost = { reads: 56 + candidates.length * (32 + 2 * policy.subscriptionsPerUser), writes: 32 + 12 * policy.wakesPerMessage };
    return this.reserved(cost, false, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      const day = dayFor(effective);
      const live = effective - policy.pushExpiryDays * 86_400_000;
      let counters: { server: RawLimitRow; sender: RawLimitRow; sent: number; charged: number; chargedBefore: number } | undefined;
      // The rooms a room mute silences this message by: its room and, for a
      // thread, the parent (protocol §4.5), read once a candidate needs it.
      // The same rooms make it a message in a room one joined (`joined`).
      let scopes: string[] | undefined;
      const roomScopes = () => scopes ??= [input.roomId, ...this.rawRows<{ parent_room_id: string | null }>("SELECT parent_room_id FROM rooms WHERE room_id = ? LIMIT 1", input.roomId)
        .flatMap((row) => row.parent_room_id === null ? [] : [row.parent_room_id])];
      let woken = 0;
      for (const userId of candidates) {
        if (woken >= policy.wakesPerMessage) break;
        // A private room's message wakes only who is in it when it goes, however they were chosen.
        if (isPrivateRoomId(input.roomId) && !this.isMember(input.roomId, userId)) continue;
        // A muted or `dnd` user gets no pushes (protocol §4.9, §4.5) and takes no wake.
        const status = this.rawRows<{ status: string; mute_until_ms: number | null }>("SELECT status, mute_until_ms FROM user_status WHERE user_id = ? LIMIT 1", userId)[0];
        if (status && (status.status === "dnd" || (status.mute_until_ms != null && integerColumn(status.mute_until_ms) > effective))) continue;
        // `joined` only for a moderator in the room (or the thread's parent), as they are now.
        let why = reasons.get(userId)!;
        if (why & WAKE_SCOPES.joined && !(this.holdsRole(userId, JOINED_WAKE_ROLES) && roomScopes().some((roomId) => this.isMember(roomId, userId)))) {
          why &= ~WAKE_SCOPES.joined;
          if (!why) continue;
        }
        // Filtered after the bounded read, so the read stays one primary-key
        // range of the user's registrations, at most `subscriptionsPerUser`,
        // whatever the scopes.
        const rows = this.rawRows<RawPushRow>(
          `SELECT url, p256dh, auth, push_id, wake FROM push_subscriptions
           WHERE user_id = ? AND wake != 0 AND updated_ms >= ? ORDER BY updated_ms DESC LIMIT ?`,
          userId, live, policy.subscriptionsPerUser,
        ).filter((row) => (integerColumn(row.wake) & why) !== 0 && (input.allowed?.(row.url) ?? true));
        if (!rows.length) continue;
        const rooms = roomScopes();
        const roomMuted = this.rawRows<{ mute_until_ms: number }>(
          `SELECT mute_until_ms FROM room_mutes WHERE user_id = ? AND room_id IN (${rooms.map(() => "?").join(", ")}) AND mute_until_ms > ? LIMIT 1`,
          userId, ...rooms, effective,
        );
        if (roomMuted.length) continue;
        // Pushed only for `joined`: its own window and recipient allowance, and no sender's.
        const joinedOnly = rows.every((row) => (integerColumn(row.wake) & why) === WAKE_SCOPES.joined);
        const last = this.rawRows<{ woken_ms: number }>("SELECT woken_ms FROM push_wakes WHERE user_id = ? AND room_id = ? LIMIT 1", userId, input.roomId)[0];
        const window = joinedOnly ? policy.joinedCoalesceSeconds : policy.coalesceSeconds;
        // An operator alert is never held back by the window or the allowances below.
        if (!input.alert && last && effective - integerColumn(last.woken_ms) < window * 1_000) continue;
        // The counters are read once a user is found to wake, so a message
        // that wakes no one writes nothing. Reuse posts_day as the counts; the
        // scope separates them.
        if (!counters) {
          const server = this.limitRow("push", "global", effective);
          const sender = this.limitRow("push", `user:${input.senderId}`, effective);
          const charged = sender.day === day ? integerColumn(sender.posts_day) : 0;
          counters = { server, sender, sent: server.day === day ? integerColumn(server.posts_day) : 0, charged, chargedBefore: charged };
        }
        const recipientScope = joinedOnly ? "push_joined_recipient" : PUSH_UNREAD_SCOPE;
        const recipient = this.rawRows<{ day: string; posts_day: number; uploads_day: number }>(
          "SELECT day, posts_day, uploads_day FROM principal_limits WHERE scope = ? AND principal_key = ? LIMIT 1", recipientScope, `user:${userId}`,
        )[0];
        const received = recipient?.day === day ? integerColumn(recipient.posts_day) : 0;
        // The same row's `uploads_day` is the user's `unread` (PUSH_UNREAD_SCOPE). A push for `joined` alone
        // counts none, nor does an operator alert, which goes to admins attended or not.
        const unread = !joinedOnly && !input.alert ? (recipient?.day === day ? integerColumn(recipient.uploads_day) : 0) + 1 : undefined;
        const allowed = input.alert ? rows.length : Math.max(0, Math.min(
          rows.length,
          policy.pushesPerDay - counters.sent,
          (joinedOnly ? policy.joinedPushesPerRecipientDay : policy.pushesPerRecipientDay) - received,
          joinedOnly ? Infinity : policy.pushesPerSenderDay - counters.charged,
        ));
        claim.skipped += rows.length - allowed;
        if (!allowed) continue;
        for (const row of rows.slice(0, allowed)) claim.subscriptions.push({ ...pushRecord(row, userId), reasons: integerColumn(row.wake) & why, ...(unread !== undefined ? { unread } : {}) });
        counters.sent += allowed;
        if (!joinedOnly) counters.charged += allowed;
        woken += 1;
        this.updateLimitRow(this.limitRow(recipientScope, `user:${userId}`, effective), { day, posts_day: received + allowed, ...(unread !== undefined ? { uploads_day: unread } : {}) }, effective);
        this.rawExec(
          "INSERT INTO push_wakes (user_id, room_id, woken_ms) VALUES (?, ?, ?) ON CONFLICT (user_id, room_id) DO UPDATE SET woken_ms = excluded.woken_ms",
          userId, input.roomId, effective,
        );
      }
      if (counters && woken) {
        this.updateLimitRow(counters.server, { day, posts_day: counters.sent }, effective);
        // Untouched when only `joined` pushes went, which no sender is charged for.
        if (counters.charged !== counters.chargedBefore) this.updateLimitRow(counters.sender, { day, posts_day: counters.charged }, effective);
      }
      return claim;
    }));
  }

  /**
   * Zeroes a user's `unread` (PUSH_UNREAD_SCOPE) when they come back: end
   * `idle`, move a read cursor, or send from a connection not idle (a
   * sign-in zeroes it with statusInputs).
   * One primary-key probe of their recipient counter, written only when it
   * held a count; the caller runs it only when a push counted it up since
   * the user was last back, so it seldom runs.
   */
  clearPushUnread(userId: string, now = this.clock.now()): void {
    this.ensureReady();
    if (!this.config.push) return;
    this.reserved({ reads: 8, writes: 8 }, false, now, () => this.zeroPushUnread(userId));
  }

  /** Read first: an update is charged a write even when it changes nothing (rawExec), and most find none. */
  private zeroPushUnread(userId: string): void {
    const key = `user:${userId}`;
    const row = this.rawRows<{ uploads_day: number }>(
      "SELECT uploads_day FROM principal_limits WHERE scope = ? AND principal_key = ? LIMIT 1", PUSH_UNREAD_SCOPE, key,
    )[0];
    if (row && integerColumn(row.uploads_day) !== 0) {
      this.rawExec("UPDATE principal_limits SET uploads_day = 0 WHERE scope = ? AND principal_key = ?", PUSH_UNREAD_SCOPE, key);
    }
  }

  /**
   * Removes all of a user's push registrations, when what they signed in
   * with is revoked (`/passkeys remove`, a bot's new token): a device that
   * held it should not keep getting their messages.
   */
  clearPushSubscriptions(userId: string, now = this.clock.now()): void {
    this.ensureReady();
    this.reserved({ reads: 8 + 2 * MAX_PUSH_SUBSCRIPTIONS_PER_USER, writes: 8 + 6 * MAX_PUSH_SUBSCRIPTIONS_PER_USER }, false, now, () => {
      this.rawExec("DELETE FROM push_subscriptions WHERE user_id = ?", userId);
    });
  }

  /**
   * Forgets the registrations whose push service said they are gone (404
   * or 410): each the user's registration of the endpoint, if it still has
   * the keys that were pushed to, so a fresh registration of it stays.
   * Other users' registrations of the same endpoint are left to their own
   * pushes and to expiry.
   */
  forgetPushSubscriptions(gone: ReadonlyArray<{ userId: string; url: string; p256dh: string }>, now = this.clock.now()): void {
    this.ensureReady();
    const rows = gone.slice(0, MAX_PUSHES_PER_MESSAGE);
    if (!rows.length) return;
    // One primary-key row each, whatever other users hold the same endpoint:
    // a delete by endpoint alone would touch every user's row for it, which
    // anyone can multiply by registering one endpoint from many accounts.
    this.reserved({ reads: 8 + 4 * rows.length, writes: 8 + 6 * rows.length }, false, now, () => this.transaction(() => {
      for (const row of rows) {
        this.rawExec("DELETE FROM push_subscriptions WHERE user_id = ? AND url = ? AND p256dh = ?", row.userId, row.url, row.p256dh);
      }
    }));
  }

  /**
   * The author of a retained message, for waking the user a reply answers
   * (protocol §4.9 `replies`): one indexed read of its current state. Null
   * for an unknown or expired message.
   */
  messageAuthor(messageId: string, now = this.clock.now()): string | null {
    this.ensureReady();
    return this.reserved({ reads: 8 }, false, now, () => this.currentMessage(messageId, this.logState().history_floor)?.author_id ?? null);
  }

  /**
   * A live embed's title as its message has it now, for the terminal viewer
   * that a browser opening its `url` goes to (protocol §4.8.5): one metered
   * lookup. Undefined without one.
   */
  liveEmbedTitle(messageId: string, embedId: string, now = this.clock.now()): string | undefined {
    const snapshot = this.pushedMessage(messageId, now);
    const embeds = snapshot && Array.isArray(snapshot.body?.embeds) ? snapshot.body.embeds : [];
    const embed = embeds.find((candidate) => isPlainObject(candidate) && candidate.embed_id === embedId);
    return isPlainObject(embed) && typeof embed.title === "string" && embed.title ? embed.title : undefined;
  }

  /**
   * A message as it is now, for a push held until its user went idle
   * (protocol §4.9): null when unknown or expired. One metered lookup.
   */
  pushedMessage(messageId: string, now = this.clock.now()): MessageSnapshot | null {
    this.ensureReady();
    return this.reserved({ reads: 8 }, false, now, () => {
      const row = this.currentMessage(messageId, this.logState().history_floor);
      return row ? parseJson<MessageSnapshot>(row.snapshot_json) : null;
    });
  }

  /**
   * `status` `mute` without `room_id` (protocol §4.5) for a registered user:
   * until when they are muted, MUTE_FOREVER for `true`, or null to end it.
   * Whether the stored mute changed, and `untilMs`, the end it leaves,
   * absent when not muted. A mute is the user's, whichever connection set
   * it. It is kept in the user's `user_status` row, which goes once it holds
   * only defaults.
   */
  setMute(input: { userId: string; untilMs: number | null; now?: number }): { changed: boolean; untilMs?: number } {
    this.ensureReady();
    const now = input.now ?? this.clock.now();
    return this.reserved({ reads: 16, writes: 16 }, false, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      if (!this.identityRow(input.userId)) return { changed: false };
      const existing = this.userStatusRow(input.userId);
      const stored = existing?.mute_until_ms ?? null;
      const before = stored !== null && stored > effective ? stored : null;
      if (input.untilMs === null || input.untilMs <= effective) {
        if (stored !== null) this.writeUserStatus(input.userId, existing, { mute_until_ms: null });
        return { changed: before !== null };
      }
      if (before === input.untilMs) return { changed: false, untilMs: input.untilMs };
      this.writeUserStatus(input.userId, existing, { mute_until_ms: input.untilMs });
      return { changed: true, untilMs: input.untilMs };
    }));
  }

  /**
   * `me` `status` (protocol §4.5) for a registered user: the value they
   * chose, kept in their `user_status` row with the mute. Whether it changed.
   * With `seenAt`, when choosing `invisible` shows them `offline` at that
   * time (§4.5.2), their `seen` is settled too, from the identity row this
   * reads anyway: the stored one if it stands (seenStands), else `seenAt`,
   * written (writeSeen) in the same reservation and transaction, so the two
   * cannot part. `seen` is what is stored after, absent for an unknown
   * user. Listings kept for reuse get it only once it is committed.
   */
  setStatus(input: { userId: string; choice: StatusChoice; now?: number; seenAt?: number }): { changed: boolean; seen?: number } {
    if (input.seenAt !== undefined) assertSeen(input.seenAt);
    this.ensureReady();
    const now = input.now ?? this.clock.now();
    let written: number | undefined;
    const result = this.reserved({ reads: 16, writes: 16 }, false, now, () => this.transaction((): { changed: boolean; seen?: number } => {
      this.effectiveNow(now);
      const row = this.identityRow(input.userId);
      if (!row) return { changed: false };
      let seen: number | undefined;
      if (input.seenAt !== undefined) {
        seen = seenColumn(row.seen_ms);
        if (!seenStands(seen, input.seenAt)) {
          this.writeSeen(input.userId, input.seenAt);
          seen = written = input.seenAt;
        }
      }
      const existing = this.userStatusRow(input.userId);
      if ((existing?.status ?? "online") === input.choice) return { changed: false, ...(seen !== undefined ? { seen } : {}) };
      this.writeUserStatus(input.userId, existing, { status: input.choice });
      return { changed: true, ...(seen !== undefined ? { seen } : {}) };
    }));
    // Committed: listings kept for reuse may carry it now (a rollback leaves them as they were).
    if (written !== undefined) this.patchMemberSeen(input.userId, written);
    return result;
  }

  /** A user's `user_status` row, if any, with an expired mute left as stored. */
  private userStatusRow(userId: string): { status: StatusChoice; mute_until_ms: number | null } | undefined {
    const row = this.rawRows<{ status: string; mute_until_ms: number | null }>(
      "SELECT status, mute_until_ms FROM user_status WHERE user_id = ? LIMIT 1", userId,
    )[0];
    return row ? { status: choiceColumn(row.status), mute_until_ms: row.mute_until_ms === null ? null : integerColumn(row.mute_until_ms) } : undefined;
  }

  /** Writes a user's `user_status` row with `change` applied, deleting it once it holds only defaults. */
  private writeUserStatus(userId: string, existing: { status: StatusChoice; mute_until_ms: number | null } | undefined, change: { status?: StatusChoice; mute_until_ms?: number | null }): void {
    const next = { status: existing?.status ?? "online", mute_until_ms: existing?.mute_until_ms ?? null, ...change };
    if (next.mute_until_ms === null && next.status === "online") {
      if (existing) this.rawExec("DELETE FROM user_status WHERE user_id = ?", userId);
      return;
    }
    this.rawExec(
      `INSERT INTO user_status (user_id, status, mute_until_ms) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET status = excluded.status, mute_until_ms = excluded.mute_until_ms`,
      userId, next.status, next.mute_until_ms,
    );
  }

  /**
   * `status` `mute` with `room_id` (protocol §4.5) for a registered user:
   * until when `roomId` and its threads are muted, MUTE_FOREVER for `true`,
   * or null to end it. Kept in `room_mutes`, one row a room, at most
   * MAX_ROOM_MUTES_PER_USER a user: a mute of another room past that first
   * deletes the user's mutes that ran out, and is `refused` if that frees
   * none. Whether it changed anything, and `untilMs`, the end it leaves,
   * absent when not muted. A mute that ran out is deleted with no change.
   */
  setRoomMute(input: { userId: string; roomId: string; untilMs: number | null; now?: number }): { changed: boolean; untilMs?: number; refused?: true } {
    this.ensureReady();
    const now = input.now ?? this.clock.now();
    // The row and its key; at the cap, two counts of the user's mutes and a
    // delete of those that ran out (a row and its key each), each at most
    // the cap.
    const cost = { reads: 24 + 4 * MAX_ROOM_MUTES_PER_USER, writes: 16 + 4 * MAX_ROOM_MUTES_PER_USER };
    return this.reserved(cost, false, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      const row = this.rawRows<{ mute_until_ms: number }>("SELECT mute_until_ms FROM room_mutes WHERE user_id = ? AND room_id = ? LIMIT 1", input.userId, input.roomId)[0];
      const stored = row ? integerColumn(row.mute_until_ms) : null;
      const before = stored !== null && stored > effective ? stored : null;
      if (input.untilMs === null || input.untilMs <= effective) {
        if (stored !== null) this.rawExec("DELETE FROM room_mutes WHERE user_id = ? AND room_id = ?", input.userId, input.roomId);
        return { changed: before !== null };
      }
      if (before === input.untilMs) return { changed: false, untilMs: input.untilMs };
      if (stored === null) {
        if (!this.identityRow(input.userId)) return { changed: false };
        const count = () => integerColumn(this.rawRows<{ count: number }>("SELECT COUNT(*) AS count FROM room_mutes WHERE user_id = ?", input.userId)[0]?.count);
        if (count() >= MAX_ROOM_MUTES_PER_USER) {
          this.rawExec("DELETE FROM room_mutes WHERE user_id = ? AND mute_until_ms <= ?", input.userId, effective);
          if (count() >= MAX_ROOM_MUTES_PER_USER) return { changed: false, refused: true };
        }
      }
      this.rawExec(
        `INSERT INTO room_mutes (user_id, room_id, mute_until_ms) VALUES (?, ?, ?)
         ON CONFLICT (user_id, room_id) DO UPDATE SET mute_until_ms = excluded.mute_until_ms`,
        input.userId, input.roomId, input.untilMs,
      );
      return { changed: true, untilMs: input.untilMs };
    }));
  }

  /**
   * The room mutes of a user that ran out by `now` (protocol §4.5), deleted
   * here, so each is told once: their rooms, and when the next of those left
   * runs out (absent when none is timed). One range of the user's rows, at
   * most MAX_ROOM_MUTES_PER_USER, and a delete of the expired ones.
   */
  expireRoomMutes(userId: string, now = this.clock.now()): { expired: string[]; next?: number } {
    this.ensureReady();
    return this.reserved({ reads: 16 + 2 * MAX_ROOM_MUTES_PER_USER, writes: 8 + 4 * MAX_ROOM_MUTES_PER_USER }, false, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      const rows = this.roomMuteRows(userId);
      const expired = rows.filter((row) => row.untilMs <= effective).map((row) => row.roomId);
      if (expired.length) this.rawExec("DELETE FROM room_mutes WHERE user_id = ? AND mute_until_ms <= ?", userId, effective);
      return { expired, ...nextRoomMuteEnd(rows.filter((row) => row.untilMs > effective)) };
    }));
  }

  /** A user's room mutes as stored, expired ones included, in `room_id` order. */
  private roomMuteRows(userId: string): RoomMute[] {
    return this.rawRows<{ room_id: string; mute_until_ms: number }>(
      "SELECT room_id, mute_until_ms FROM room_mutes WHERE user_id = ? ORDER BY room_id LIMIT ?", userId, MAX_ROOM_MUTES_PER_USER,
    ).map((row) => ({ roomId: row.room_id, untilMs: integerColumn(row.mute_until_ms) }));
  }

  /**
   * A registered user's stored `status` state (protocol §4.5), read once at
   * sign-in: the `status` they chose, their unscoped mute's end (absent when
   * not muted, MUTE_FOREVER for `true`) and their room mutes in effect. One
   * primary-key read and one range of the user's room mutes, at most
   * MAX_ROOM_MUTES_PER_USER rows; a missing row or range costs nothing.
   * Their `seen` is not read here: every sign-in reads their identity row
   * anyway (getIdentity), which carries it. Signing in brings them back, so
   * it also zeroes their `unread` (clearPushUnread), in the same
   * reservation: one more primary-key probe, written only when it held a count.
   */
  statusInputs(userId: string, now = this.clock.now()): StatusInputRecord {
    this.ensureReady();
    return this.reserved({ reads: 16 + 2 * MAX_ROOM_MUTES_PER_USER, writes: 8 }, false, now, () => {
      if (this.config.push) this.zeroPushUnread(userId);
      const effective = this.effectiveNow(now);
      const row = this.userStatusRow(userId);
      const until = row?.mute_until_ms ?? 0;
      return {
        choice: row?.status ?? "online",
        ...(until > effective ? { muteUntil: until } : {}),
        roomMutes: this.roomMuteRows(userId).filter((mute) => mute.untilMs > effective),
      };
    });
  }

  /**
   * A registered user's read cursors (protocol §4.6): the `read_message_id`
   * kept for each room they joined that has one, by room. One range of the
   * user's rows, at most one a membership; none costs nothing.
   */
  readCursors(userId: string, now = this.clock.now()): Map<string, string> {
    this.ensureReady();
    const rows = MAX_USER_ROOMS + MAX_PURGE_ROOMS;
    return this.reserved({ reads: 8 + 2 * rows }, false, now, () => new Map(this.rawRows<{ room_id: string; message_id: number }>(
      "SELECT room_id, message_id FROM read_cursors WHERE user_id = ? LIMIT ?", userId, rows,
    ).map((row) => [row.room_id, idString(integerColumn(row.message_id))])));
  }

  /**
   * The read cursors of a private room's members (read receipts, protocol
   * §4.6), for the rooms of at most MAX_READ_RECEIPT_MEMBERS members: for
   * each, the members other than `except` (the lister) with a cursor kept
   * there and the `read_message_id` each read through, leaving out members
   * who chose `invisible`. A larger room is absent from the result; one with
   * no cursor to show is present, empty. Per room, a range of at most one
   * more membership than the limit, by key, then each member's cursor and
   * `user_status` row by primary key: bounded whatever the room's size.
   */
  roomReadCursors(roomIds: readonly string[], except: string, now = this.clock.now()): Map<string, Array<[userId: string, messageId: string]>> {
    const rooms = roomIds.filter(isPrivateRoomId).slice(0, MAX_PRIVATE_MEMBERSHIPS_PER_USER);
    const found = new Map<string, Array<[string, string]>>();
    if (!rooms.length) return found;
    this.ensureReady();
    const limit = MAX_READ_RECEIPT_MEMBERS;
    return this.reserved({ reads: 8 + rooms.length * (4 + (limit + 1) + 3 * limit) }, false, now, () => {
      for (const roomId of rooms) {
        const members = this.rawRows<{ user_id: string }>("SELECT user_id FROM memberships WHERE room_id = ? LIMIT ?", roomId, limit + 1);
        if (members.length > limit) continue;
        const rows = this.rawRows<{ user_id: string; message_id: number }>(
          `SELECT read_cursors.user_id, read_cursors.message_id
           FROM (SELECT user_id FROM memberships WHERE room_id = ? AND user_id != ? LIMIT ?) AS members
           JOIN read_cursors ON read_cursors.user_id = members.user_id AND read_cursors.room_id = ?
           LEFT JOIN user_status ON user_status.user_id = members.user_id
           WHERE user_status.status IS NULL OR user_status.status != 'invisible'`,
          roomId, except, limit, roomId,
        );
        found.set(roomId, rows.map((row) => [row.user_id, idString(integerColumn(row.message_id))]));
      }
      return found;
    });
  }

  /**
   * How many registered members a room has (its row's `member_count`),
   * undefined for an unknown room: one primary-key read. Read receipts go
   * only to rooms of at most MAX_READ_RECEIPT_MEMBERS (roomReadCursors).
   */
  roomMemberCount(roomId: string, now = this.clock.now()): number | undefined {
    this.ensureReady();
    return this.reserved({ reads: 8 + 2 }, false, now, () => {
      const row = this.rawRows<{ member_count: number }>("SELECT member_count FROM rooms WHERE room_id = ? LIMIT 1", roomId)[0];
      return row ? integerColumn(row.member_count) : undefined;
    });
  }

  /**
   * Keeps a registered user's read cursors (protocol §4.6), each a room and
   * the `read_message_id` read through, in `read_cursors`: only in rooms
   * they are a member of, so a cursor goes with its membership (a leave,
   * an expired room, `/purge`) and the table holds at most one a
   * membership; and only forward, so cursors written from several
   * connections, in any order, keep the furthest. Each is a primary-key
   * probe of the membership (read alone, so member listings kept for reuse
   * stay valid) and an upsert: a new cursor writes its row and its room
   * index entry, a moved one its row, a cursor not past the kept one
   * nothing.
   */
  saveReadCursors(input: { userId: string; cursors: ReadonlyArray<readonly [roomId: string, messageId: string]>; now?: number }): void {
    const cursors = input.cursors.slice(0, MAX_USER_ROOMS);
    if (!cursors.length) return;
    this.ensureReady();
    const now = input.now ?? this.clock.now();
    this.reserved({ reads: 8 + 4 * cursors.length, writes: 8 + 4 * cursors.length }, false, now, () => this.transaction(() => {
      this.effectiveNow(now);
      for (const [roomId, messageId] of cursors) {
        if (!this.rawRows("SELECT 1 FROM memberships WHERE room_id = ? AND user_id = ? LIMIT 1", roomId, input.userId).length) continue;
        this.rawExec(
          `INSERT INTO read_cursors (user_id, room_id, message_id) VALUES (?, ?, ?)
           ON CONFLICT (user_id, room_id) DO UPDATE SET message_id = excluded.message_id WHERE excluded.message_id > read_cursors.message_id`,
          input.userId, roomId, Number(messageId),
        );
      }
    }));
  }

  /**
   * Settles a registered user's `seen` (protocol §4.5.2) for a change of
   * the status others see of them to `offline` at `at` (epoch
   * milliseconds) that is not a chosen `invisible` (setStatus settles that
   * one with the choice): their last connection closing. The store decides,
   * so every caller agrees with what it holds, however stale the copy it
   * decided from (several tabs closing together, each handled as the last;
   * an eviction in between): the stored one if it stands (seenStands), with
   * no write, else `at`, written. Returns what is stored after, or
   * undefined for an unknown user.
   *
   * One conditional update of the identity row, which writes only where the
   * stored one does not stand (1 read, 1 write when it writes); where it
   * stands, or for an unknown user, a primary-key read of `seen_ms` follows
   * (2 reads, no write). Listings kept for reuse are patched in place, not
   * invalidated (patchMemberSeen).
   */
  settleSeen(input: { userId: string; at: number; now?: number }): number | undefined {
    assertSeen(input.at);
    this.ensureReady();
    const now = input.now ?? this.clock.now();
    return this.reserved({ reads: 8, writes: 8 }, false, now, () => {
      this.effectiveNow(now);
      const at = input.at;
      // Written only where the stored one does not stand (seenStands, in SQL).
      const cursor = this.sql.exec(
        "UPDATE identities SET seen_ms = ? WHERE user_id = ? AND (seen_ms <= 0 OR seen_ms > ? OR seen_ms < ?)",
        at, input.userId, at, at - SEEN_WRITE_GRANULARITY_MS,
      );
      this.observed.reads += Math.max(0, cursor.rowsRead ?? 0);
      this.observed.writes += Math.max(0, cursor.rowsWritten ?? 1);
      if ((cursor.rowsWritten ?? 0) > 0) {
        this.patchMemberSeen(input.userId, at);
        return at;
      }
      // It stands (or the user is unknown; or the SQL adapter does not
      // report rows written, which this read covers too): what is stored.
      const row = this.rawRows<{ seen_ms: number }>("SELECT seen_ms FROM identities WHERE user_id = ? LIMIT 1", input.userId)[0];
      const stored = row ? seenColumn(row.seen_ms) : undefined;
      if (stored === at) this.patchMemberSeen(input.userId, at);
      return stored;
    });
  }

  /**
   * Writes a user's `seen` into their identity row, which a member listing
   * reads anyway. Unlike other writes to the tables listings read
   * (rawExec), this one does not invalidate the listings kept for reuse:
   * the caller patches them once it is committed (patchMemberSeen). Charged
   * the rows SQLite reports, so an unknown user's, which matches no row,
   * costs none.
   */
  private writeSeen(userId: string, seen: number): void {
    const cursor = this.sql.exec("UPDATE identities SET seen_ms = ? WHERE user_id = ?", seen, userId);
    this.observed.reads += Math.max(0, cursor.rowsRead ?? 0);
    this.observed.writes += Math.max(0, cursor.rowsWritten ?? 1);
  }

  /** Sets a committed `seen` in the listings kept for reuse, which stay valid. */
  private patchMemberSeen(userId: string, seen: number): void {
    for (const entry of this.memberCache.values()) {
      for (const row of entry.rows) if (row.user_id === userId && row.seen_ms !== undefined) row.seen_ms = seen;
    }
  }

  /**
   * A principal's count for its UTC day in a limiter scope (`posts_day`, which
   * scopes other than posts reuse), as the store holds it: a cached row
   * (limiter-cache.ts) may not be written yet. Zero for none.
   */
  limiterDay(scope: string, principalKey: string, now = this.clock.now()): { day: string; posts_day: number } {
    this.ensureReady();
    return this.reserved({ reads: 8 }, false, now, () => {
      const row = this.limiters.peek(scope, principalKey) ?? this.rawRows<{ day: string; posts_day: number }>(
        "SELECT day, posts_day FROM principal_limits WHERE scope = ? AND principal_key = ? LIMIT 1", scope, principalKey,
      )[0];
      return { day: row?.day ?? dayFor(this.effectiveNow(now)), posts_day: integerColumn(row?.posts_day) };
    });
  }

  /** Pushes sent today, for `/status`. */
  pushesToday(now = this.clock.now()): number {
    this.ensureReady();
    return this.reserved({ reads: 8 }, false, now, () => {
      const rows = this.rawRows<{ day: string; posts_day: number }>(
        "SELECT day, posts_day FROM principal_limits WHERE scope = ? AND principal_key = ? LIMIT 1",
        "push",
        "global",
      );
      return rows.length && rows[0].day === dayFor(this.effectiveNow(now)) ? integerColumn(rows[0].posts_day) : 0;
    });
  }

  /**
   * Normalize a reaction set (§4.7): strings, bounded, each emoji sequence
   * fully qualified (qualifyEmoji), and duplicates collapsed, entries that
   * differ only in U+FE0F included. Custom emoji keys (extension
   * `ext:emoji`) are checked against the catalog by commitReactions.
   */
  private normalizedEmojis(value: unknown): string[] {
    if (!Array.isArray(value)) throw new StoreError("invalid_params", "emojis must be an array");
    const emojis: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
      if (typeof item !== "string" || item.length === 0) throw new StoreError("invalid_params", "each emoji must be a non-empty string");
      // eslint-disable-next-line no-control-regex
      if (utf8Bytes(item) > MAX_EMOJI_BYTES) throw new StoreError("too_large", "emoji is too long");
      if (/[\u0000-\u001f\u007f]/.test(item)) throw new StoreError("invalid_params", "emoji is not a single sequence");
      const entry = isEmojiKey(item) ? item : qualifyEmoji(item);
      const identity = emojiIdentity(entry);
      if (seen.has(identity)) continue;
      seen.add(identity);
      emojis.push(entry);
    }
    // A count limit this server sets: denied (§1.1).
    if (emojis.length > this.config.reactionEmojisPerUser) throw new StoreError("denied", `A reaction set holds at most ${this.config.reactionEmojisPerUser} emoji`);
    return emojis;
  }

  /** Replace the caller's reaction set on one message (§4.7). */
  private commitReactions(input: StoreMutationInput, context: CommitContext, floor: number): StoreMutationResult {
    const params = input.params;
    const messageIdParam = params.message_id;
    if (typeof messageIdParam !== "string" || messageIdParam.length === 0) throw new StoreError("invalid_params", "message_id must be a non-empty string");
    const emojis = this.normalizedEmojis(params.emojis);
    const message = this.visibleMessage(ensureText(messageIdParam, "message_id", 256), input.userId, floor);
    if (!message) throw new StoreError("invalid_params", "unknown or expired message");
    const snapshot = parseJson<MessageSnapshot>(message.snapshot_json);
    // Clients hide a tombstone's reactions; the demo stores no new ones.
    if (snapshot.deleted === true && emojis.length) throw new StoreError("denied", "cannot react to a deleted message");
    const existing = this.rawRows<RawReactionRow>(
      "SELECT message_id, user_id, log_id, from_json, emojis_json FROM reaction_state WHERE message_id = ? AND user_id = ? LIMIT 1",
      message.message_id, input.userId,
    )[0];
    const currentSet = existing && existing.log_id >= floor ? parseJson<string[]>(existing.emojis_json, []) : [];
    // A custom emoji key (extension `ext:emoji`) must be in the catalog, or
    // already in the user's current set on this message: a request carries
    // the whole set, so a removed emoji must not stop the user from changing
    // their other reactions. Only a key not already in the set reads the catalog.
    for (const emoji of emojis) {
      if (isEmojiKey(emoji) && !currentSet.includes(emoji) && !this.loadEmojiCatalog().keys.has(emoji)) {
        throw new StoreError("invalid_params", `${emoji} is not a custom emoji here`.slice(0, 200));
      }
    }
    // An unchanged set produces no record (§4.7 permits no change); entries
    // that differ only in U+FE0F are the same.
    const current = new Set(currentSet.map(emojiIdentity));
    if (current.size === emojis.length && emojis.every((emoji) => current.has(emojiIdentity(emoji)))) {
      return { result: {}, broadcasts: [] };
    }
    if (!existing && emojis.length) {
      // Count every stored set, including logically expired ones awaiting
      // cleanup, so the move-time read of this message stays within its cap.
      const count = integerColumn(this.rawRows<{ count: number }>(
        "SELECT COUNT(*) AS count FROM (SELECT 1 FROM reaction_state WHERE message_id = ? LIMIT ?)",
        message.message_id, this.config.reactionUsersPerMessage,
      )[0]?.count);
      if (count >= this.config.reactionUsersPerMessage) throw new StoreError("denied", "reaction limit reached for this message");
    }
    const logId = this.allocateLogId(context);
    const from = this.identityForMessage(input);
    const record: ReactionsRecord = {
      log_id: idString(logId),
      message_id: message.message_id,
      room_id: message.room_id,
      reactions: [{ from, emojis }],
    };
    this.appendRecord(context, [message.room_id], "reactions", logId, JSON.stringify(record));
    if (emojis.length) {
      this.rawExec(
        `INSERT INTO reaction_state (message_id, user_id, log_id, from_json, emojis_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (message_id, user_id) DO UPDATE SET
           log_id = excluded.log_id, from_json = excluded.from_json, emojis_json = excluded.emojis_json`,
        message.message_id, input.userId, logId, JSON.stringify(from), JSON.stringify(emojis),
      );
    } else if (existing) {
      this.rawExec("DELETE FROM reaction_state WHERE message_id = ? AND user_id = ?", message.message_id, input.userId);
    }
    return { result: {}, broadcasts: [{ method: "reactions", params: clone(record) as unknown as Record<string, unknown>, rooms: [message.room_id] }] };
  }

  /**
   * `room_set`: create a room or thread, or replace one's client fields (§4.2.4),
   * merging `ext` into the current one (§4.12).
   * Demo policy: anyone may create a thread under a public top-level room and
   * save any public thread; only an admin or mod (ROOM_CREATOR_ROLES) may
   * create a public top-level room or save one. Threads cannot be nested, and
   * the permanent `general` room is fixed. Every public room created counts
   * against maxThreads, which bounds the rooms table's public range.
   * A registered user may also create a private room with `private: true`
   * (PRIVATE_ROOM_PREFIX): top-level, without a title unless given one, and
   * counted against maxPrivateRooms, their maxPrivateRoomsPerUser and
   * maxPrivateMembershipsPerUser instead. Its members, and only they, may
   * save it; it has no threads. To anyone else it does not exist.
   */
  private commitRoom(input: StoreMutationInput, context: CommitContext, floor: number, registered: boolean): StoreMutationResult {
    const params = input.params;
    const roomIdParam = params.room_id;
    if (roomIdParam !== undefined && (typeof roomIdParam !== "string" || roomIdParam.length === 0)) throw new StoreError("invalid_params", "room_id must be a non-empty string");
    if (params.private !== undefined && typeof params.private !== "boolean") throw new StoreError("invalid_params", "private must be a boolean");
    // `private` is fixed at creation; on a save it is ignored like parent_room_id.
    const makePrivate = roomIdParam === undefined && params.private === true;
    // A store without private rooms (maxPrivateRooms 0) says so, as §4.2.4 requires. A
    // deployment's privateRoomLimit is always positive (loadConfig), so only tests use it.
    if (makePrivate && this.config.maxPrivateRooms === 0) throw new StoreError("unsupported", "Private rooms are not supported on this server");
    if (makePrivate && !registered) throw new StoreError("denied", "Sign in to start a private room");
    if (makePrivate && params.parent_room_id !== undefined) throw new StoreError("denied", "A private room cannot be a thread on this demo");
    const titleParam = params.title;
    if (titleParam !== undefined && typeof titleParam !== "string") throw new StoreError("invalid_params", "title must be a string");
    const descriptionParam = params.description;
    if (descriptionParam !== undefined && typeof descriptionParam !== "string") throw new StoreError("invalid_params", "description must be a string");
    const write = this.optionalExt(params.ext);
    // A private room someone is not in is unknown to them, as one that does not exist.
    const existing = roomIdParam === undefined ? undefined : this.visibleRoomRow(roomIdParam, input.userId);
    const isPrivate = makePrivate || (existing ? isPrivateRoomId(existing.room_id) : false);
    // Threads always carry a title so clients that ignore parent_room_id
    // still render them (§4.2), and so do public top-level rooms. A private
    // room may go without one: clients name it after its members. An empty
    // description is no description.
    const topLevel = existing === undefined ? params.parent_room_id === undefined : existing?.parent_room_id === null;
    const fallbackTitle = isPrivate ? undefined : existing?.room_id === ROOM_ID ? ROOM_TITLE : topLevel ? DEFAULT_ROOM_TITLE : DEFAULT_THREAD_TITLE;
    const title = typeof titleParam === "string" && titleParam.trim() !== "" ? titleParam : fallbackTitle;
    const description = typeof descriptionParam === "string" && descriptionParam.trim() !== "" ? descriptionParam : undefined;
    // `ext` merges into the room's current one (§4.12, §4.2.4); the size check runs on the result.
    const roomFields = (stored: unknown): Record<string, unknown> => {
      const ext = mergeExt(stored, write);
      return { ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}), ...(ext ? { ext } : {}) };
    };

    let row: RawRoomRow;
    let logId: number;
    if (roomIdParam === undefined) {
      const parentId = params.parent_room_id;
      let parentRoomId: string | null = null;
      if (makePrivate) {
        const counts = this.privateRoomCounts(input.userId, floor);
        if (counts.memberships >= this.config.maxPrivateMembershipsPerUser) {
          throw new StoreError("denied", `You are in ${counts.memberships} private rooms, the most at once; leave one to start another`);
        }
        // So one account cannot take every slot by starting rooms and leaving them to others.
        if (counts.created >= this.config.maxPrivateRoomsPerUser) {
          throw new StoreError("denied", `You can have started at most ${this.config.maxPrivateRoomsPerUser} private rooms at once; one stops counting when everyone has left it or its history expires`);
        }
        if (this.metaNumber("private_count") >= this.config.maxPrivateRooms) throw new StoreError("denied", "The demo holds as many private rooms as it can; one frees up when everyone has left it or its history expires");
      } else if (parentId === undefined) {
        if (!registered || !this.holdsRole(input.userId, ROOM_CREATOR_ROLES)) throw new StoreError("denied", "Only an admin or mod may create a room; others may create threads");
        const rooms = this.rawRows(`SELECT room_id FROM rooms WHERE ${PUBLIC_ROOMS} AND parent_room_id IS NULL LIMIT ?`, MAX_CREATED_ROOMS + 1).length;
        if (rooms > MAX_CREATED_ROOMS) throw new StoreError("denied", "room_limit");
      } else {
        if (typeof parentId !== "string" || parentId.length === 0) throw new StoreError("invalid_params", "parent_room_id must be a non-empty string");
        const parent = this.visibleRoomRow(parentId, input.userId);
        if (!parent) throw new StoreError("invalid_params", "unknown parent_room_id");
        if (parent.parent_room_id !== null) throw new StoreError("denied", "Threads cannot be nested on this demo");
        if (isPrivateRoomId(parentId)) throw new StoreError("denied", "A private room has no threads on this demo");
        parentRoomId = parentId;
        // So one account cannot take every slot: the threads a registered user
        // created that are still live, read from the capped rooms table. A
        // thread removed when emptied, or whose log expired (still a row until
        // cleanup), no longer counts.
        if (registered && this.liveThreadsCreatedBy(input.userId, floor) >= this.config.maxThreadsPerUser) {
          throw new StoreError("denied", `You can have at most ${this.config.maxThreadsPerUser} threads at once; one stops counting when everyone has left it or its history expires`);
        }
      }
      const counter = makePrivate ? "private_count" : "thread_count";
      if (!makePrivate && this.metaNumber(counter) >= this.config.maxThreads) throw new StoreError("denied", "thread_limit");
      const fields = roomFields(undefined);
      this.checkRoomFields(fields);
      logId = this.allocateLogId(context);
      const roomId = (makePrivate ? PRIVATE_ROOM_PREFIX : "") + idString(logId);
      // A registered creator is kept with the fields, outside the client's
      // size limit and the room record, so they can remove members (§4.2.2).
      const fieldsJson = JSON.stringify(registered ? { ...fields, creator_id: input.userId } : fields);
      this.rawExec(
        `INSERT INTO rooms (${ROOM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        roomId, parentRoomId, logId, logId, logId, fieldsJson, context.commitMs, context.commitMs,
      );
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", counter, String(this.metaNumber(counter) + 1));
      row = {
        room_id: roomId, parent_room_id: parentRoomId, created_log_id: logId, record_log_id: logId, latest_log_id: logId,
        fields_json: fieldsJson, created_ms: context.commitMs, updated_ms: context.commitMs, member_count: 0,
      };
    } else {
      if (!existing) throw new StoreError("invalid_params", "unknown room");
      if (existing.room_id === ROOM_ID) {
        if (!registered || !this.holdsRole(input.userId, ["admin"])) throw new StoreError("denied", "Only an admin may edit the general room");
      } else if (existing.parent_room_id === null && !isPrivate && (!registered || !this.holdsRole(input.userId, ROOM_CREATOR_ROLES))) {
        throw new StoreError("denied", "Only an admin or mod may edit a room; anyone may edit a thread");
      }
      // parent_room_id is fixed at creation; a submitted value is ignored.
      const fields = roomFields(parseJson<{ ext?: unknown }>(existing.fields_json, {}).ext);
      this.checkRoomFields(fields);
      logId = this.allocateLogId(context);
      // A save replaces the client fields; the creator stays.
      const creator = storedCreator(existing.fields_json);
      const fieldsJson = JSON.stringify(creator === undefined ? fields : { ...fields, creator_id: creator });
      this.rawExec(
        "UPDATE rooms SET record_log_id = ?, latest_log_id = ?, fields_json = ?, updated_ms = ? WHERE room_id = ?",
        logId, logId, fieldsJson, context.commitMs, existing.room_id,
      );
      row = { ...existing, record_log_id: logId, latest_log_id: logId, fields_json: fieldsJson, updated_ms: context.commitMs };
    }
    const created = roomIdParam === undefined;
    // Delivery fields describe a client's view and are not logged.
    const { latest_log_id: _latest, history_log_id: _history, ...logged } = this.roomRecord(row, floor);
    void _latest; void _history;
    this.rawExec(
      "INSERT INTO records (room_id, log_id, commit_ms, kind, record_json) VALUES (?, ?, ?, 'room', ?)",
      row.room_id, logId, context.commitMs, JSON.stringify(logged),
    );
    // Creating a room joins its creator (§4.2.4). A registered creator keeps
    // the room, and the join is logged after the room record; a guest's lives
    // in its connection.
    let membership: Broadcast | undefined;
    if (created && registered) {
      this.rawExec("INSERT OR IGNORE INTO memberships (room_id, user_id) VALUES (?, ?)", row.room_id, input.userId);
      membership = this.logMembership(context, row.room_id, recordedUser(input.userId, input.identity.name), true);
      row = { ...row, latest_log_id: Number(membership.params.log_id) };
      // The new room's head is the membership; finishCommit writes it.
      context.touched.set(row.room_id, row.latest_log_id);
    }
    const record = this.roomRecord(row, floor);
    // Room records are not broadcast: the caller sends room_update (§4.2.3).
    return { result: { room_id: row.room_id }, broadcasts: [], room: record, created, ...(membership ? { membership } : {}) };
  }

  /** Thread rooms `userId` created that are still live: not removed, and with a retained log. One scan of the capped rooms table's public range. */
  private liveThreadsCreatedBy(userId: string, floor: number): number {
    return integerColumn(this.rawRows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM rooms WHERE ${PUBLIC_ROOMS} AND parent_room_id IS NOT NULL AND latest_log_id >= ? AND json_extract(fields_json, '$.creator_id') = ?`,
      floor, userId,
    )[0]?.count);
  }

  /**
   * For a private room's creation (PRIVATE_ROOM_COUNT_READS): the live
   * private rooms `userId` created, as liveThreadsCreatedBy counts threads,
   * from the capped private range; and the private rooms they are in, from
   * their memberships.
   */
  private privateRoomCounts(userId: string, floor: number): { created: number; memberships: number } {
    const created = integerColumn(this.rawRows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM rooms WHERE ${PRIVATE_ROOMS} AND latest_log_id >= ? AND json_extract(fields_json, '$.creator_id') = ?`,
      floor, userId,
    )[0]?.count);
    return { created, memberships: this.privateMembershipCount(userId) };
  }

  /**
   * The private rooms a registered user is in. Their membership rows,
   * through the user index, joined with `rooms` so the rows of a removed
   * room awaiting purge do not count: at most MAX_USER_ROOMS and
   * MAX_PURGE_ROOMS rows, and a room lookup each.
   */
  private privateMembershipCount(userId: string): number {
    return integerColumn(this.rawRows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM memberships m INDEXED BY memberships_user_idx
       JOIN rooms r ON r.room_id = m.room_id
       WHERE m.user_id = ? AND ${privateRange("m.room_id")}`,
      userId,
    )[0]?.count);
  }

  /** Whether a registered user has a membership row in `roomId`. */
  private isMember(roomId: string, userId: string): boolean {
    return this.rawRows("SELECT 1 FROM memberships WHERE room_id = ? AND user_id = ? LIMIT 1", roomId, userId).length > 0;
  }

  /**
   * The room, if `userId` may see it: any public room, and a private one
   * only to its members. To anyone else a private room reads as absent, so
   * every path answers as it does for a room that does not exist (§5.3).
   */
  private visibleRoomRow(roomId: string, userId: string): RawRoomRow | null {
    const row = this.roomRow(roomId);
    if (!row || !isPrivateRoomId(row.room_id)) return row;
    return this.isMember(row.room_id, userId) ? row : null;
  }


  /** A room's client fields (`title`, `description`, `ext`) fit maxThreadMetadataBytes serialized. */
  private checkRoomFields(fields: Record<string, unknown>): void {
    if (utf8Bytes(JSON.stringify(fields)) > this.config.maxThreadMetadataBytes) throw new StoreError("too_large", "room metadata is too large");
  }

  /**
   * A `me` profile write (§3.3) of a registered user: `name`, where `""`
   * removes it, and `ext`, but for the keys the server owns
   * (SERVER_USER_EXT_KEYS), merged into the stored one (§4.12) and at most
   * MAX_USER_EXT_BYTES after the merge. One identity row update, or none
   * when neither changes. `profile` has the user's whole `ext` after the
   * write and the keys it changed (changedExt).
   */
  private commitMeMutation(input: StoreMutationInput, now: number): StoreMutationResult {
    const name = input.params.name;
    if (name !== undefined) {
      if (typeof name !== "string") throw new StoreError("invalid_params", "name must be a string");
      ensureText(name, "name", this.config.maxNameBytes);
      if ([...name].length > this.config.maxNameCodePoints) throw new StoreError("too_large", "name is too long");
    }
    const write = clientUserExt(this.optionalExt(input.params.ext));
    const existing = this.identityRow(input.userId);
    if (!existing) throw new StoreError("denied", "Only registered users may change their profile");
    const before = parseUserExt(existing.ext_json);
    const ext = mergeExt(before, write);
    if (!userExtFits(ext)) throw new StoreError("too_large", `ext is at most ${MAX_USER_EXT_BYTES} bytes`);
    const changed = changedExt(before, ext);
    if (name !== undefined || changed) {
      this.rawExec(
        "UPDATE identities SET name = ?, ext_json = ?, updated_ms = ? WHERE user_id = ?",
        name ?? existing.name, ext ? JSON.stringify(ext) : "", now, input.userId,
      );
    }
    return { result: {}, broadcasts: [], profile: { ...(ext ? { ext } : {}), ...(changed ? { changed } : {}) } };
  }

  private commitStoredResult(
    userId: string,
    requestId: string | undefined,
    digest: string,
    result: Record<string, unknown>,
    expiresAt: number,
  ): void {
    if (requestId === undefined) return;
    this.rawExec(
      `INSERT INTO accepted_requests
       (user_id, request_id, digest, result_json, transition_json, expires_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, request_id) DO UPDATE SET
         digest = excluded.digest,
         result_json = excluded.result_json,
         transition_json = excluded.transition_json,
         expires_ms = excluded.expires_ms
       WHERE accepted_requests.expires_ms <= ?`,
      userId,
      requestId,
      digest,
      JSON.stringify(result),
      // The original result is sufficient for a retry response: retries are
      // never rebroadcast, so no record copy is retained here.
      null,
      expiresAt,
      expiresAt,
    );
  }

  /**
   * An accepted retry (§1.2): not executed or broadcast again, and its result
   * reflects the current state. The stored results name what the operation
   * made (`message_id`, `room_id`), which stays true, except an upload's
   * write grant: once its write has been claimed, finished, or has expired,
   * the retry's result leaves the grant out, so no stale `write_url` is
   * signed. One indexed read per upload embed (at most `maxEmbeds`).
   */
  private deduplicatedCommit(row: RawDedupRow, digest: string, now: number): StoreMutationResult {
    // The digest covers the method and params, so a matching row is the same operation.
    if (row.digest !== digest) throw new StoreError("invalid_params", "request ID was already used for a different operation");
    const stored = parseJson<Record<string, unknown>>(row.result_json, {});
    // Rows stored before this version name their method; they expire within the dedup TTL.
    delete stored.__method;
    if (Array.isArray(stored.embeds)) {
      const live = this.config.liveText ? this.liveTexts() : [];
      stored.embeds = stored.embeds.map((embed: unknown) => {
        if (!isPlainObject(embed) || !isPlainObject(embed.write) || typeof embed.write.key !== "string") return embed;
        const key = embed.write.key;
        if (key.startsWith("l/")) {
          if (live.some((entry) => entry.key === key && entry.state === "pending" && entry.writeExpiresMs >= now)) return embed;
        } else {
          const upload = this.uploadRow(key);
          if (upload && upload.state === "pending" && upload.write_expires_ms >= now) return embed;
        }
        const { write: _write, ...rest } = embed;
        void _write;
        return rest;
      });
    }
    return { result: stored, broadcasts: [], deduplicated: true };
  }

  private mutationMethod(method: string | undefined): MutationMethod {
    if (method === undefined || method === "message") return "message";
    if (method === "room_set" || method === "reactions" || method === "me") return method;
    throw new StoreError("unsupported", "Unsupported mutation");
  }

  /**
   * One accepted operation: dedup lookup, reservation, then one atomic
   * decision that rechecks quotas, allocates log IDs, writes every record and
   * current state, and records the result. Callers broadcast `broadcasts` in
   * order only after this returns.
   */
  commitMutation(input: StoreMutationInput): StoreMutationResult {
    this.ensureReady();
    if (!input.userId || !input.ipKey) throw new StoreError("denied", "authentication required");
    if (input.requestId !== undefined) {
      if (typeof input.requestId !== "string" || utf8Bytes(input.requestId) > 128) throw new StoreError("invalid_params", "invalid request ID");
    }
    const method = this.mutationMethod(input.method);
    const operationNow = input.now ?? this.clock.now();
    if (method === "message" && this.emptyNewMessage(input.params)) {
      // Nothing is logged, charged, or recorded; only the room is checked.
      return this.reserved({ reads: 8 }, false, operationNow, () => {
        const roomId = input.params.room_id === undefined ? ROOM_ID : input.params.room_id;
        if (typeof roomId !== "string" || !this.roomRow(roomId)) throw new StoreError("invalid_params", "unknown room");
        return { result: {}, broadcasts: [] };
      });
    }
    const digest = input.digest ?? digestOperation(method, input.params);
    // A retry lookup is deliberately cheaper than a full mutation reserve.
    // Accepted retries must remain available even when posting/storage
    // capacity is exhausted, while still paying their bounded SQL lookup.
    let effective = operationNow;
    if (input.requestId !== undefined) {
      const lookup = this.reserved({ reads: 8 + 4 * this.config.maxEmbeds, writes: 8 }, false, operationNow, () => {
        const lookupNow = this.effectiveNow(operationNow);
        const row = this.dedupRow(input.userId, input.requestId!, lookupNow);
        return { now: lookupNow, row, replay: row ? this.deduplicatedCommit(row, digest, lookupNow) : null };
      });
      effective = lookup.now;
      if (lookup.replay) return lookup.replay;
    }
    // Conservative floors for the three posting limiter rows, dedup row,
    // records, current state, and room/log bookkeeping. An edit may be a move,
    // which also re-logs the message's capped reaction sets (measured at 158
    // writes); every other mutation measured at most 37. Unused rows are
    // credited back, so the floor only decides admission near the ceiling.
    const mayMove = method === "message" && typeof input.params.message_id === "string";
    // Each embed may start or release an upload (§4.8.3).
    const uploadWrites = method !== "message" ? 0 : (this.config.uploads ? this.config.maxEmbeds * UPLOAD_WRITES : 0) + (this.config.liveText ? LIVE_WRITES : 0);
    // A thread's creation counts its creator's live threads: a scan of the
    // rooms table, capped at the thread ceiling and the created rooms. A
    // private room's counts the private range and the creator's memberships
    // (privateRoomCounts). Any mutation may check a private room's membership.
    const creating = method === "room_set" && input.params.room_id === undefined;
    const roomScan = !creating ? 0 : input.params.private === true ? PRIVATE_ROOM_COUNT_READS : MAX_THREAD_LIMIT + MAX_CREATED_ROOMS + 2;
    const mutationCost = {
      ...this.config.mutationCost,
      reads: Math.max(256, this.config.mutationCost.reads ?? 0) + roomScan,
      writes: Math.max(mayMove ? 256 : 96, this.config.mutationCost.writes ?? 0) + uploadWrites,
    };
    this.assertAccounting();
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    const reserved = this.reserveCost(mutationCost, false, operationNow);
    try {
      effective = this.effectiveNow(operationNow);
      // An operator alert is one small message: storage high-water does not hold it back.
      if (!input.system) this.ensureGrowthCapacity(this.config.maxSnapshotBytes);
      return this.transaction(() => {
        const beforeCommit = <T>(value: T): T => {
          // Assert while transactionSync's closure is still open.  If an
          // observed cursor exceeds the reservation, throwing here rolls back
          // the accepted mutation before any result can be broadcast.
          this.assertStorageTarget();
          this.assertReservation(reserved, beforeReads, beforeWrites);
          return value;
        };
        const tier: Tier = this.identityRow(input.userId) ? "registered" : "anonymous";
        if (!input.system) this.chargePosting({ userId: input.userId, tier, ipKey: input.ipKey, now: effective, uncategorized: method === "me" });
        let committed: StoreMutationResult;
        if (method === "me") {
          committed = this.commitMeMutation(input, effective);
        } else {
          const state = this.logState();
          const startLogId = state.last_log_id;
          const context: CommitContext = { state, commitMs: Math.max(effective, state.last_commit_ms), touched: new Map() };
          const floor = state.history_floor;
          committed = method === "message" ? this.commitMessage(input, context, floor)
            : method === "room_set" ? this.commitRoom(input, context, floor, tier === "registered")
            : this.commitReactions(input, context, floor);
          // Within the transaction: a move its sender cannot pay for is refused whole.
          if (context.extraPosts && !input.system) this.chargePosting({ userId: input.userId, tier, ipKey: input.ipKey, now: effective, weight: context.extraPosts });
          this.finishCommit(context, startLogId);
        }
        this.commitStoredResult(input.userId, input.requestId, digest, committed.result, effective + this.config.dedupTtlMs);
        return beforeCommit(committed);
      });
    } finally {
      this.settleReservation(reserved, beforeReads, beforeWrites);
    }
  }

  /** Runtime adapter: commits a private copy of the request parameters. */
  mutate(input: StoreMutationInput): StoreMutationResult {
    return this.commitMutation({ ...input, params: clone(input.params) });
  }

  /**
   * History with the history quota charged (§4.3): the user's and the IP's
   * limiters (a burst, then a rate a minute, and a count a day, one row each)
   * and the server's count a day, kept on the day's budget row, which every
   * reservation updates anyway. A request that serves no page (refused by the
   * user's or IP's limits, or an unknown room or bad bounds, whose rollback
   * undoes their charges) gives its server count back, so such requests
   * cannot use up everyone's history for the day.
   */
  history(query: StoreHistoryQuery): StoreHistoryResult {
    this.ensureReady();
    const operationNow = query.now ?? this.clock.now();
    const charged = Boolean(query.userId && query.ipKey);
    return this.reserved({
      ...this.config.historyCost,
      reads: this.historyReads(query),
      // A page writes only its two limiter rows and the budget row: about 20
      // rows for a first request, which creates both limiter rows.
      writes: Math.max(32, this.config.historyCost.writes ?? 0),
      history: charged ? 1 : 0,
    }, false, operationNow, (unused) => {
      try {
        const now = this.effectiveNow(operationNow);
        return this.transaction(() => {
          if (charged) {
            this.chargeEvent("history", `user:${query.userId}`, now,
              { perMinute: this.config.historyRequestsPerUserMinute, burst: this.config.historyBurstPerUser },
              "History request limit reached",
              { limit: this.config.historyRequestsPerUserDay, message: "Daily history limit reached" }, "read");
            this.chargeEvent("history", `ip:${query.ipKey}`, now,
              { perMinute: this.config.historyRequestsPerIpMinute, burst: this.config.historyBurstPerIp },
              "History request limit reached",
              { limit: this.config.historyRequestsPerIpDay, message: "Daily history limit reached for this network" }, "read");
          }
          return this.historyPageInternal({ ...query, now });
        });
      } catch (error) {
        // No page was served, and the rollback undid the user's and IP's charges: the server-wide count goes back too.
        unused.history = 1;
        throw error;
      }
    });
  }

  /** History without quota bookkeeping, for internal and calibration use. */
  historyPage(query: StoreHistoryQuery): StoreHistoryResult {
    this.ensureReady();
    const operationNow = query.now ?? this.clock.now();
    return this.reserved({
      ...this.config.historyCost,
      reads: this.historyReads(query),
      writes: Math.max(32, this.config.historyCost.writes ?? 0),
    }, false, operationNow, () => {
      const now = this.effectiveNow(operationNow);
      return this.transaction(() => this.historyPageInternal({ ...query, now }));
    });
  }

  /**
   * The rows a history page may read: one room's page, or for several rooms
   * each one's row and at most a page and one more of its records, besides
   * the limiter and budget rows.
   */
  private historyReads(query: StoreHistoryQuery): number {
    const single = Math.max(256, this.config.historyCost.reads ?? 0);
    if (query.roomId !== undefined || !query.roomIds) return single;
    const limit = query.limit !== undefined && Number.isInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, this.config.maxHistoryLimit) : this.config.historyDefaultLimit;
    // The scan of the log reads an index entry and a row for each record.
    return Math.max(single, 64 + 2 * HISTORY_SCAN_PAGES * (limit + 1) + new Set(query.roomIds).size * (limit + 3));
  }

  private historyBound(value: string | bigint | undefined, field: string): number | undefined {
    if (value === undefined) return undefined;
    return numericId(typeof value === "bigint" ? numericBigInt(value, field) : value, field);
  }

  private historyPageInternal(query: StoreHistoryQuery): StoreHistoryResult {
    const multiple = query.roomId === undefined && query.roomIds !== undefined;
    const roomIds = multiple ? [...new Set(query.roomIds)] : [query.roomId === undefined ? ROOM_ID : query.roomId];
    for (const roomId of roomIds) {
      if (typeof roomId !== "string" || roomId.length === 0) throw new StoreError("invalid_params", "room_id must be a non-empty string");
    }
    // A requester's private room only if they are in it; internal pages, with no requester, see every room.
    const visible = (roomId: string) => query.userId === undefined ? this.roomRow(roomId) : this.visibleRoomRow(roomId, query.userId);
    const sources = roomIds.map(visible).filter((room): room is RawRoomRow => room !== null);
    if (!multiple && !sources.length) throw new StoreError("invalid_params", "unknown room");
    const floor = this.logState().history_floor;
    const after = this.historyBound(query.after, "after");
    const before = this.historyBound(query.before, "before");
    const limit = positiveLimit(query.limit, this.config.historyDefaultLimit, this.config.maxHistoryLimit);
    const maxBytes = Math.min(query.maxBytes ?? this.config.maxHistoryResponseBytes, this.config.maxHistoryResponseBytes);
    // One room's log starts at its creation or the retention floor. The
    // joined rooms' log together (§4.3.3) starts where the server's does, at
    // the default room's creation or the floor, whichever rooms they are, so
    // its lower bound never moves back with a join, nor ahead with a leave.
    // Its head is the greatest of theirs; with nothing retrievable, such as
    // in no rooms, it is empty and ends just before its start.
    const lowerBound = multiple ? Math.max(floor, this.roomRow(ROOM_ID)?.created_log_id ?? 1) : roomHistoryFloor(sources[0], floor);
    let head = sources.reduce((greatest, room) => Math.max(greatest, room.latest_log_id), 0);
    if (multiple && head < lowerBound) head = lowerBound - 1;
    const latestLogId = idString(head);
    const historyLogId = lowerBound <= head ? idString(lowerBound) : null;
    // An empty slice has neither bound and omits every array (§4.3.2).
    const empty = (): StoreHistoryResult => ({ more: false, latest_log_id: latestLogId, history_log_id: historyLogId });
    const forward = after !== undefined;
    // One contiguous slice of the log across every record kind; the limit
    // counts records of any kind (§4.3.2). Each room's slice is read from its
    // own key range, a page and one more at most, and a room with nothing in
    // the window is not read at all: the slices merge by log_id. A moved
    // message's snapshot is in both rooms' logs, and once in theirs together.
    // A window bounded to one log_id (after == before) in one room is that
    // record in this room's log only: a moved message's earlier snapshot is
    // fetched from the room its prev_room_id names.
    const windows = new Map<string, { lower: number; upper: number }>();
    for (const room of sources) {
      const lower = Math.max(roomHistoryFloor(room, floor), after ?? 0);
      const upper = Math.min(room.latest_log_id, before ?? room.latest_log_id);
      if (lower <= upper && roomHistoryLogId(room, floor) !== null) windows.set(room.room_id, { lower, upper });
    }
    const order = (a: RawRecordRow, b: RawRecordRow) => forward ? a.log_id - b.log_id : b.log_id - a.log_id;
    const byLogId = new Map<number, RawRecordRow>();
    const take = (row: RawRecordRow) => {
      const window = windows.get(row.room_id);
      if (window && row.log_id >= window.lower && row.log_id <= window.upper && !byLogId.has(row.log_id)) byLogId.set(row.log_id, row);
    };
    const roomSlice = (roomId: string, window: { lower: number; upper: number }) => this.rawRows<RawRecordRow>(
      `SELECT room_id, log_id, kind, record_json FROM records
       WHERE room_id = ? AND log_id >= ? AND log_id <= ?
       ORDER BY log_id ${forward ? "ASC" : "DESC"} LIMIT ?`,
      roomId, window.lower, window.upper, limit + 1,
    );
    if (!multiple || windows.size <= 1) {
      for (const [roomId, window] of windows) for (const row of roomSlice(roomId, window)) take(row);
    } else {
      // Several rooms: first the log itself, by log_id across every room, at
      // most HISTORY_SCAN_PAGES pages of it. That is the cheapest read when
      // these rooms hold most of the log; when they hold little of it, each
      // room's slice is read instead, a page and one more at most.
      const lower = Math.min(...[...windows.values()].map((window) => window.lower));
      const upper = Math.max(...[...windows.values()].map((window) => window.upper));
      const scanned = this.rawRows<RawRecordRow>(
        `SELECT room_id, log_id, kind, record_json FROM records INDEXED BY records_log_idx
         WHERE log_id >= ? AND log_id <= ?
         ORDER BY log_id ${forward ? "ASC" : "DESC"} LIMIT ?`,
        lower, upper, HISTORY_SCAN_PAGES * (limit + 1),
      );
      for (const row of scanned) take(row);
      if (byLogId.size <= limit && scanned.length === HISTORY_SCAN_PAGES * (limit + 1)) {
        byLogId.clear();
        for (const [roomId, window] of windows) for (const row of roomSlice(roomId, window)) take(row);
      }
    }
    const rows = [...byLogId.values()].sort(order).slice(0, limit + 1);
    if (rows.length === 0) return empty();
    const roomFields = new Map(sources.map((room) => [room.room_id, { latest_log_id: idString(room.latest_log_id), history_log_id: roomHistoryLogId(room, floor) }]));
    // The runtime wraps this result in a reply.  Reserve a fixed
    // envelope allowance for id/result keys, decimal IDs, commas and
    // first/last/more fields.  An empty page is always valid even when a
    // caller supplies a tiny maxBytes value, so apply this allowance only
    // while considering a non-empty entry.
    // A 128-byte request ID can require 768 JSON bytes when escaped.
    const responseOverhead = 1024;
    let bytes = utf8Bytes(JSON.stringify({
      rooms: [], messages: [], reactions: [], memberships: [], first_log_id: latestLogId, last_log_id: latestLogId,
      more: false, latest_log_id: latestLogId, history_log_id: historyLogId,
    }));
    let stoppedForBytes = false;
    const selected: Array<{ logId: number; kind: string; value: Record<string, unknown> }> = [];
    for (const row of rows.slice(0, limit + 1)) {
      const value = parseJson<Record<string, unknown>>(row.record_json);
      // Room records carry this client's delivery fields, as `room_list` and `room_update` records do.
      if (row.kind === "room") Object.assign(value, roomFields.get(row.room_id));
      const entryBytes = utf8Bytes(JSON.stringify(value));
      if (entryBytes + bytes + responseOverhead + 1 > maxBytes) {
        if (selected.length === 0) throw new StoreError("too_large", "history record exceeds response budget");
        stoppedForBytes = true;
        break;
      }
      selected.push({ logId: row.log_id, kind: row.kind, value });
      bytes += entryBytes + 1;
      if (selected.length >= limit) break;
    }
    const more = stoppedForBytes || rows.length > selected.length;
    if (!forward) selected.reverse();
    if (!selected.length) return empty();
    const rooms: RoomRecord[] = [];
    const messages: MessageSnapshot[] = [];
    const reactions: ReactionsRecord[] = [];
    const membership: MembershipRecord[] = [];
    for (const record of selected) {
      if (record.kind === "room") rooms.push(record.value as unknown as RoomRecord);
      else if (record.kind === "reactions") reactions.push(record.value as unknown as ReactionsRecord);
      else if (record.kind === "membership") membership.push(record.value as unknown as MembershipRecord);
      else messages.push(record.value as unknown as MessageSnapshot);
    }
    // Records keep the user objects they were logged with; history carries no `users` (§3.3).
    return {
      ...(rooms.length ? { rooms } : {}),
      ...(messages.length ? { messages } : {}),
      ...(reactions.length ? { reactions } : {}),
      ...(membership.length ? { memberships: membership } : {}),
      first_log_id: idString(selected[0].logId),
      last_log_id: idString(selected[selected.length - 1].logId),
      more,
      latest_log_id: latestLogId,
      history_log_id: historyLogId,
    };
  }

  /** The withheld control rows can persist one deferral and its reset alarm. */
  private deferCleanup(effective: number): void {
    const nextDue = Math.max(effective + 1000, (Math.floor(effective / 86_400_000) + 1) * 86_400_000);
    if (this.deferredCleanupUntil >= nextDue) return;
    this.assertAccounting();
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    const reserved = this.reserveMaintenanceControl({ reads: 2, writes: 2 }, effective);
    this.rawExec("UPDATE maintenance SET next_cleanup_ms = ? WHERE id = 1", nextDue);
    this.cleanupDueCache = undefined;
    this.deferredCleanupUntil = nextDue;
    this.assertReservation(reserved, beforeReads, beforeWrites);
  }

  /**
   * Indexed existence checks, each reading at most one row, and the list of
   * removed rooms whose memberships await purge. Thread-room expiry is not
   * probed here: it can only become due when a job advances the floor, and
   * that job keeps running until its own continuation check is clear.
   */
  private cleanupHasWork(floor: number, cutoff: number, effective: number, limiterCutoff: number): boolean {
    return roomIdList(this.metaValue(META_PURGE_ROOMS)).length > 0 ||
      this.rawRows("SELECT log_id FROM records INDEXED BY records_log_idx WHERE log_id < ? ORDER BY log_id LIMIT 1", floor).length > 0 ||
      // Commit times are nondecreasing in log order, so the oldest record from the floor on says whether any expired.
      this.rawRows<{ commit_ms: number }>("SELECT commit_ms FROM records INDEXED BY records_log_idx WHERE log_id >= ? ORDER BY log_id LIMIT 1", floor)
        .some((row) => integerColumn(row.commit_ms) < cutoff) ||
      this.rawRows("SELECT user_id FROM accepted_requests WHERE expires_ms <= ? ORDER BY expires_ms LIMIT 1", effective).length > 0 ||
      this.rawRows("SELECT scope FROM principal_limits WHERE updated_ms < ? ORDER BY updated_ms LIMIT 1", limiterCutoff).length > 0 ||
      this.rawRows("SELECT user_id FROM push_subscriptions INDEXED BY push_subscriptions_updated_idx WHERE updated_ms < ? ORDER BY updated_ms LIMIT 1", this.pushCutoffs(effective).subscriptions).length > 0 ||
      this.rawRows("SELECT user_id FROM push_wakes INDEXED BY push_wakes_woken_idx WHERE woken_ms < ? ORDER BY woken_ms LIMIT 1", this.pushCutoffs(effective).wakes).length > 0;
  }

  /**
   * Before when push registrations have expired (not registered again for
   * `pushExpiryDays`) and wake times no longer coalesce anything. Without
   * push, registrations are kept for when it returns, and wake times all go.
   */
  private pushCutoffs(effective: number): { subscriptions: number; wakes: number } {
    const policy = this.config.push;
    return {
      subscriptions: policy ? effective - policy.pushExpiryDays * 86_400_000 : 0,
      wakes: effective - (policy ? Math.max(policy.coalesceSeconds, policy.joinedCoalesceSeconds) * 1_000 : 0),
    };
  }

  private limiterCutoff(effective: number): number {
    // Principal authority is independent of chat retention: keep the current
    // UTC day's counters and every limiter still within its horizon.
    return Math.min(Math.floor(effective / 86_400_000) * 86_400_000, effective - LIMITER_IDLE_MS);
  }

  /**
   * Whether cleanup is due by `now`, for an alarm deciding whether to run it
   * (ApronDemoServer.alarmWorkDue): from the cached `next_cleanup_ms` when
   * there is one, else one read of the maintenance row. A read that fails
   * counts as due, so the alarm runs its full work.
   */
  /** Forgets the cached `next_cleanup_ms` after a write the store did not make (a test, an operator's SQL). */
  forgetCleanupDue(): void {
    this.cleanupDueCache = undefined;
  }

  cleanupDue(now = this.clock.now()): boolean {
    if (this.cleanupDueCache !== undefined) return Math.max(this.cleanupDueCache, this.deferredCleanupUntil) <= Math.max(Math.trunc(now), this.lastEffectiveMs);
    try {
      return this.reserved({ reads: 4 }, true, now, () =>
        Math.max(this.maintenanceRow().next_cleanup_ms, this.deferredCleanupUntil) <= this.effectiveNow(now));
    } catch {
      return true;
    }
  }

  runCleanup(now = this.clock.now()): StoreCleanupResult {
    this.ensureReady();
    // An alarm may have fired, and cleanup may establish an earlier continuation.
    this.scheduledAlarmAt = undefined;
    // A challenge deadline is not an hourly cleanup. Its cheap due check must
    // not consume the reservation for a complete deletion batch.
    let gate: { maintenance: RawMaintenanceRow; state: RawLogState; effective: number };
    try {
      gate = this.reserved({ reads: 18, writes: 2 }, true, now, () => {
        const maintenance = this.maintenanceRow();
        const state = this.logState();
        const effective = this.effectiveNow(now);
        // A non-null cursor marks a job whose last batch reported more work
        // (including expired thread rooms, which the cheap probes below do not
        // cover). Continue it rather than letting the idle check end it.
        const jobInProgress = maintenance.cleanup_cursor !== null && maintenance.cleanup_cutoff_ms !== null;
        if (!jobInProgress && effective >= Math.max(maintenance.next_cleanup_ms, this.deferredCleanupUntil)) {
          const cutoff = effective - this.config.retentionMs;
          // Idle hours must not burn a full deletion reservation.
          if (!this.cleanupHasWork(state.history_floor, cutoff, effective, this.limiterCutoff(effective))) {
            maintenance.next_cleanup_ms = effective + this.config.cleanupIntervalMs;
            this.rawExec("UPDATE maintenance SET next_cleanup_ms = ?, cleanup_cutoff_ms = NULL, cleanup_cursor = NULL WHERE id = 1", maintenance.next_cleanup_ms);
            this.cleanupDueCache = undefined;
          }
        }
        return { maintenance, state, effective };
      });
    } catch (error) {
      if (error instanceof StoreError && error.code === "retry_after") this.deferCleanup(Math.max(now, this.lastEffectiveMs));
      throw error;
    }
    const { maintenance, state, effective } = gate;
    const previousFloor = state.history_floor;
    const due = Math.max(maintenance.next_cleanup_ms, this.deferredCleanupUntil);
    const empty = (nextDue: number): StoreCleanupResult => ({
      history_floor: idString(previousFloor), previous_floor: idString(previousFloor), latest_id: idString(state.last_log_id),
      deleted_records: 0, deleted_messages: 0, deleted_reactions: 0, deleted_memberships: 0, deleted_requests: 0, deleted_limiters: 0,
      removed_rooms: [], next_due_ms: nextDue, did_work: false,
    });
    if (effective < due) return empty(due);
    this.assertAccounting();
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    let reserved: BudgetCost;
    try { reserved = this.reserveCost(this.config.cleanupCost, true, effective); }
    catch (error) {
      if (error instanceof StoreError && error.code === "retry_after") {
        this.deferCleanup(effective);
        return empty(this.deferredCleanupUntil);
      }
      throw error;
    }
    // A job's retention cutoff is fixed until all of its bounded batches finish.
    const cutoff = maintenance.cleanup_cursor !== null && maintenance.cleanup_cutoff_ms !== null
      ? maintenance.cleanup_cutoff_ms : effective - this.config.retentionMs;
    const batch = Math.min(100, this.config.cleanupBatch);
    let floor = previousFloor;
    // Commit the server-wide coverage boundary/job before physical deletion.
    // A failed deletion leaves logically expired rows hidden and an
    // idempotent job. Commit times are nondecreasing in log order, so the
    // expired set is always a prefix of the one server-wide log.
    this.transaction(() => {
      const pending = this.rawRows<{ log_id: number }>(
        "SELECT log_id FROM records INDEXED BY records_log_idx WHERE log_id < ? ORDER BY log_id LIMIT 1", floor,
      );
      // The expired records are the prefix of the log from the floor on whose commit time is before the cutoff.
      const oldest = pending.length ? [] : this.rawRows<{ log_id: number; commit_ms: number }>(
        `SELECT log_id, commit_ms FROM records INDEXED BY records_log_idx
         WHERE log_id >= ? ORDER BY log_id LIMIT ?`, floor, batch,
      );
      const fresh = oldest.findIndex((row) => integerColumn(row.commit_ms) >= cutoff);
      const expired = fresh === -1 ? oldest : oldest.slice(0, fresh);
      if (expired.length) floor = Math.max(floor, expired[expired.length - 1].log_id + 1);
      const head = this.writeLogHead(floor);
      this.rawExec("UPDATE maintenance SET cleanup_cutoff_ms = ?, cleanup_cursor = ?, next_cleanup_ms = ? WHERE id = 1", cutoff, floor, effective + 1000);
      this.cleanupDueCache = undefined;
      this.assertReservation(reserved, beforeReads, beforeWrites);
      this.logCache = { ...head, history_floor: floor };
    });
    const result = this.transaction(() => {
      let remaining = batch;
      const expiring = this.rawRows<{ room_id: string; log_id: number; kind: string; message_id: string | null; reactions_json: string | null }>(
        `SELECT room_id, log_id, kind, json_extract(record_json, '$.message_id') AS message_id,
           CASE WHEN kind = 'reactions' THEN record_json END AS reactions_json
         FROM records INDEXED BY records_log_idx WHERE log_id < ? ORDER BY log_id LIMIT ?`, floor, remaining,
      );
      // Current state survives while its latest record is retained, so it
      // goes with that record: a message's state row with its latest
      // snapshot, and each reaction set with the record that logged it, by
      // its whole primary key (the users the record names), so a delete
      // reads and writes at most the row it removes. A move's record is
      // stored in both rooms, so the second finds the rows gone. Each state
      // row counts against the batch with its record: a record whose state
      // would not fit waits for the next batch, below the floor already.
      const records: typeof expiring = [];
      let messages = 0;
      let reactions = 0;
      for (const row of expiring) {
        const users = row.kind === "reactions" && row.message_id !== null && row.reactions_json !== null
          ? parseJson<ReactionsRecord>(row.reactions_json).reactions.map((set) => set.from.user_id)
          : [];
        const state = row.message_id === null ? 0 : row.kind === "message" ? 1 : users.length;
        if (records.length > 0 && 1 + state > remaining) break;
        this.rawExec("DELETE FROM records WHERE room_id = ? AND log_id = ?", row.room_id, row.log_id);
        records.push(row);
        remaining -= 1 + state;
        if (row.message_id === null) continue;
        if (row.kind === "message") {
          if (this.rawExec("DELETE FROM message_state WHERE message_id = ? AND latest_log_id = ?", row.message_id, row.log_id).rowsWritten) messages += 1;
        } else {
          for (const userId of users) {
            if (this.rawExec("DELETE FROM reaction_state WHERE message_id = ? AND user_id = ? AND log_id = ?", row.message_id, userId, row.log_id).rowsWritten) reactions += 1;
          }
        }
      }
      remaining = Math.max(0, remaining);
      // A thread or private room whose entire log (creation record included)
      // has been discarded leaves the visible set. No message, reaction, or
      // membership can still be current in it: each touches the room's head
      // when committed. The rooms table's public and private ranges are each
      // capped, bounding these scans. Its registered members' rows are purged
      // below, in batches; until then the join with `rooms` hides them.
      let purge = roomIdList(this.metaValue(META_PURGE_ROOMS));
      const threads = remaining > 0 && purge.length < MAX_PURGE_ROOMS ? this.rawRows<{ room_id: string }>(
        `SELECT room_id FROM rooms WHERE ${PUBLIC_ROOMS} AND parent_room_id IS NOT NULL AND latest_log_id < ? ORDER BY created_log_id LIMIT ?`, floor, Math.min(remaining, MAX_PURGE_ROOMS - purge.length),
      ) : [];
      const roomCapacity = Math.min(remaining - threads.length, MAX_PURGE_ROOMS - purge.length - threads.length);
      // In key order, which is creation order: the IDs carry log IDs of one length.
      const privates = roomCapacity > 0 ? this.rawRows<{ room_id: string }>(
        `SELECT room_id FROM rooms WHERE ${PRIVATE_ROOMS} AND latest_log_id < ? ORDER BY room_id LIMIT ?`, floor, roomCapacity,
      ) : [];
      const rooms = [...threads, ...privates];
      for (const row of rooms) this.rawExec("DELETE FROM rooms WHERE room_id = ? AND latest_log_id < ?", row.room_id, floor);
      if (threads.length) this.rawExec("UPDATE _meta SET value = ? WHERE key = 'thread_count'", String(Math.max(0, this.metaNumber("thread_count") - threads.length)));
      if (privates.length) this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('private_count', ?)", String(Math.max(0, this.metaNumber("private_count") - privates.length)));
      remaining -= rooms.length;
      const purgeBefore = purge.length;
      purge = [...purge, ...rooms.map((row) => row.room_id)];
      let memberships = 0;
      while (purge.length && remaining > 0) {
        const roomId = purge[0];
        const members = this.rawRows<{ user_id: string }>("SELECT user_id FROM memberships WHERE room_id = ? LIMIT ?", roomId, remaining + 1);
        const batchRows = members.slice(0, remaining);
        // Each member's read cursor goes with the membership (saveReadCursors keeps none without one).
        for (const row of batchRows) {
          this.rawExec("DELETE FROM memberships WHERE room_id = ? AND user_id = ?", roomId, row.user_id);
          this.rawExec("DELETE FROM read_cursors WHERE user_id = ? AND room_id = ?", row.user_id, roomId);
        }
        memberships += batchRows.length;
        remaining -= batchRows.length;
        if (members.length > batchRows.length) break;
        purge.shift();
      }
      if (rooms.length || purge.length !== purgeBefore) {
        this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_PURGE_ROOMS, JSON.stringify(purge));
      }
      const requests = remaining > 0 ? this.rawRows<{ user_id: string; request_id: string }>(
        "SELECT user_id, request_id FROM accepted_requests WHERE expires_ms <= ? ORDER BY expires_ms LIMIT ?", effective, remaining,
      ) : [];
      for (const row of requests) this.rawExec("DELETE FROM accepted_requests WHERE user_id = ? AND request_id = ?", row.user_id, row.request_id);
      remaining -= requests.length;
      const limiterCutoff = this.limiterCutoff(effective);
      const limiters = remaining > 0 ? this.rawRows<{ scope: string; principal_key: string }>(
        "SELECT scope, principal_key FROM principal_limits WHERE updated_ms < ? ORDER BY updated_ms LIMIT ?", limiterCutoff, remaining,
      ) : [];
      // A cached copy of a row idle in SQL may hold changes it has not
      // written. The cache writes a row's first change after reading it, so
      // they came within a minute of its `updated_ms`, on that day, and no
      // longer count; one made since the cutoff might, and is written instead
      // of deleted (limiter-cache.ts: keepIfChanged).
      let deletedLimiters = 0;
      for (const row of limiters) {
        if (this.limiters.keepIfChanged(row.scope, row.principal_key, limiterCutoff, effective)) continue;
        this.rawExec("DELETE FROM principal_limits WHERE scope = ? AND principal_key = ?", row.scope, row.principal_key);
        deletedLimiters += 1;
      }
      if (deletedLimiters) this.rawExec("UPDATE _meta SET value = ? WHERE key = 'principal_limit_count'", String(Math.max(0, this.metaNumber("principal_limit_count") - deletedLimiters)));
      remaining -= limiters.length;
      // Expired push registrations and wake times past coalescing (protocol §4.9).
      const pushCutoffs = this.pushCutoffs(effective);
      const subscriptions = remaining > 0 ? this.rawRows<{ user_id: string; url: string }>(
        "SELECT user_id, url FROM push_subscriptions INDEXED BY push_subscriptions_updated_idx WHERE updated_ms < ? ORDER BY updated_ms LIMIT ?", pushCutoffs.subscriptions, remaining,
      ) : [];
      for (const row of subscriptions) this.rawExec("DELETE FROM push_subscriptions WHERE user_id = ? AND url = ?", row.user_id, row.url);
      remaining -= subscriptions.length;
      const wakes = remaining > 0 ? this.rawRows<{ user_id: string; room_id: string }>(
        "SELECT user_id, room_id FROM push_wakes INDEXED BY push_wakes_woken_idx WHERE woken_ms < ? ORDER BY woken_ms LIMIT ?", pushCutoffs.wakes, remaining,
      ) : [];
      for (const row of wakes) this.rawExec("DELETE FROM push_wakes WHERE user_id = ? AND room_id = ?", row.user_id, row.room_id);
      const hasMore = this.cleanupHasWork(floor, cutoff, effective, limiterCutoff) ||
        this.rawRows(`SELECT room_id FROM rooms WHERE ${PUBLIC_ROOMS} AND parent_room_id IS NOT NULL AND latest_log_id < ? LIMIT 1`, floor).length > 0 ||
        this.rawRows(`SELECT room_id FROM rooms WHERE ${PRIVATE_ROOMS} AND latest_log_id < ? LIMIT 1`, floor).length > 0;
      const nextDue = effective + (hasMore ? 1000 : this.config.cleanupIntervalMs);
      this.rawExec("UPDATE maintenance SET next_cleanup_ms = ?, cleanup_cutoff_ms = ?, cleanup_cursor = ? WHERE id = 1", nextDue, hasMore ? cutoff : null, hasMore ? floor : null);
      this.cleanupDueCache = undefined;
      this.assertReservation(reserved, beforeReads, beforeWrites);
      const deleted = records.length + messages + reactions + rooms.length + memberships + requests.length + limiters.length + subscriptions.length + wakes.length;
      return {
        history_floor: idString(floor), previous_floor: idString(previousFloor), latest_id: idString(state.last_log_id),
        deleted_records: records.length, deleted_messages: messages, deleted_reactions: reactions,
        deleted_memberships: memberships, deleted_requests: requests.length, deleted_limiters: deletedLimiters,
        removed_rooms: rooms.map((row) => row.room_id),
        next_due_ms: nextDue,
        did_work: floor !== previousFloor || deleted > 0,
      };
    });
    // Refunded after the transaction commits, so a rollback cannot leave a credit behind.
    this.ledger.refund(reserved, this.observed.reads - beforeReads, this.observed.writes - beforeWrites);
    return result;
  }

  /**
   * Schedule the earliest active socket deadline and persisted cleanup task.
   * Socket deadlines live in bounded hibernation attachments, so this method
   * deliberately does not create one durable row per connection.
   */
  async scheduleAlarm(socketDeadline?: number, now = this.clock.now()): Promise<void> {
    this.ensureReady();
    const candidateTime = Math.max(Math.trunc(now), this.lastEffectiveMs);
    if (this.scheduledAlarmAt !== undefined && this.scheduledAlarmAt > candidateTime &&
        (socketDeadline === undefined || this.scheduledAlarmAt <= socketDeadline)) return;
    this.assertAccounting();
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    let reserved: BudgetCost;
    try { reserved = this.reserveCost({ reads: 16, writes: 4 }, true, now); }
    catch (error) {
      if (!(error instanceof StoreError) || error.code !== "retry_after") throw error;
      // Two of the eight withheld control rows defer cleanup; six remain to
      // install its reset alarm even after ordinary maintenance is exhausted.
      reserved = this.reserveMaintenanceControl({ reads: 6, writes: 6 }, now);
    }
    const effective = Math.max(Math.trunc(now), this.lastEffectiveMs);
    const maintenance = this.maintenanceRow();
    const cleanupDue = Math.max(maintenance.next_cleanup_ms, this.deferredCleanupUntil);
    const dueAt = Math.max(effective, socketDeadline === undefined ? cleanupDue : Math.min(cleanupDue, socketDeadline));
    const getAlarm = this.durableStorage?.getAlarm;
    const setAlarm = this.durableStorage?.setAlarm;
    if (typeof getAlarm !== "function" || typeof setAlarm !== "function") throw new StoreError("internal_error", "Alarm storage unavailable");
    // Capture this call's SQL before awaiting: another socket can complete
    // cryptography meanwhile. Its separately metered SQL must not be counted
    // again against this alarm's reservation.
    let actualReads = this.observed.reads - beforeReads;
    let actualWrites = this.observed.writes - beforeWrites;
    try {
      // Native alarm methods expose no cursor. Reserve conservative hidden
      // control-row costs even when the native call fails.
      actualReads += 2; this.observed.reads += 2;
      const existing = await getAlarm.call(this.durableStorage);
      if (existing !== null && Number.isFinite(existing) && existing > effective && existing <= dueAt) {
        this.scheduledAlarmAt = existing;
        return;
      }
      actualReads += 2; actualWrites += 2;
      this.observed.reads += 2; this.observed.writes += 2;
      await setAlarm.call(this.durableStorage, dueAt);
      this.scheduledAlarmAt = dueAt;
    } finally {
      this.settleReservation(reserved, this.observed.reads - actualReads, this.observed.writes - actualWrites);
    }
  }
}
