/** Raw row shapes and the helpers that parse, check and build them. */

import { outputRef } from "../content/output-ref";
import type { StoreLiveTextConfig } from "./config";
import type { RoomMember, UploadPurpose, Identity, LiveEntry, PushSubscriptionRecord, SqlCursorLike } from "./types";
import type { RawLimitRow } from "../limiter-cache";
import type { Bucket } from "../limiter";
import { MAX_ROLES_PER_USER, ROLE_PATTERN } from "../domain";
// @ts-expect-error Workers' nodejs_compat runtime supplies this module; the
// worker type package intentionally omits Node's full module declarations.
import { createHash } from "node:crypto";
import { isStatusChoice, type StatusChoice } from "../presence";
import { StoreError } from "../store-error";
import { MAX_RESTORED_AVATAR_BYTES, MAX_SAFE_ID } from "./limits";
import { clientUserExt } from "../content/user";
import { validateRecord, type ValidRecord } from "@apron/archive";
import type { ChatRecord } from "../history/records";
import { boundedText, type Verdict } from "../content/verdict";
import { SettledMeta } from "../settled-meta";

/** The key of an R2 object for a terminal's output, an attached file's kind. */
export function newTerminalOutputKey(): string {
  return `f/${randomKey()}`;
}

/** What a record's stored terminal outputs add to it once put back, beyond their refs: for a history page's byte budget. */
export function terminalOutputBytes(record: unknown): number {
  const embeds = isPlainObject(record) && isPlainObject(record.body) ? record.body.embeds : undefined;
  if (!Array.isArray(embeds)) return 0;
  return embeds.reduce<number>((total, embed) => total + (outputRef(embed)?.bytes ?? -16) + 16, 0);
}



/** A live text's `url` (§4.8.5), which its embed carries once its write starts. */
export function liveUrl(live: Pick<StoreLiveTextConfig, "publicOrigin">, entry: Pick<LiveEntry, "id">): string {
  return `${live.publicOrigin}/live/${entry.id}`;
}

export function isLiveEntry(value: unknown): value is LiveEntry {
  if (!isPlainObject(value)) return false;
  return typeof value.key === "string" && /^l\/[A-Za-z0-9_-]{22}$/.test(value.key) && typeof value.id === "string" &&
    (value.kind === "terminal" || value.kind === "append") && typeof value.owner === "string" && typeof value.ip === "string" &&
    (value.state === "pending" || value.state === "live") && Number.isSafeInteger(value.writeExpiresMs) &&
    Number.isSafeInteger(value.maxMs) && Number.isSafeInteger(value.limit) && typeof value.embedId === "string";
}

/** One logged reaction change (protocol §4.7). */
export interface ReactionsRecord {
  log_id: string;
  message_id: string;
  room_id: string;
  reactions: Array<{ from: Identity; emojis: string[] }>;
}

/** A room row's client fields (`title`, `description`, `ext`): its stored fields without the creator. */
export function clientRoomFields(fieldsJson: string): Record<string, unknown> {
  const { creator_id: _creator, ...fields } = parseJson<Record<string, unknown>>(fieldsJson, {});
  void _creator;
  return fields;
}

/** The `creator_id` kept in a room row's `fields_json`, if any (Store.roomCreator). */
export function storedCreator(fieldsJson: string): string | undefined {
  const creator = parseJson<{ creator_id?: unknown }>(fieldsJson, {}).creator_id;
  return typeof creator === "string" ? creator : undefined;
}

/** One logged membership change of a registered user (protocol §4.2.2). */
export interface MembershipRecord {
  log_id: string;
  room_id: string;
  members: Array<{ user: Identity; joined: boolean }>;
}

export type RecordKind = "room" | "message" | "reactions" | "membership";



export interface RawLogState {
  last_log_id: number;
  history_floor: number;
  last_commit_ms: number;
}

export interface RawRoomRow {
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

export interface RawRecordRow {
  room_id: string;
  log_id: number;
  kind: string;
  record_json: string;
}

export interface RawMessageRow {
  message_id: string;
  room_id: string;
  latest_log_id: number;
  snapshot_json: string;
  author_id: string;
}

export interface RawReactionRow {
  message_id: string;
  user_id: string;
  log_id: number;
  from_json: string;
  emojis_json: string;
}

/** Allocation and room bookkeeping for one committed operation. */
export interface CommitContext {
  state: RawLogState;
  commitMs: number;
  /** Greatest log_id appended to each existing room during this commit. */
  touched: Map<string, number>;
  /** Registered members each room gained (or, negative, lost) in this commit's memberships. */
  members?: Map<string, number>;
  /** Posts this commit costs past the one every mutation is charged: a move's re-logged reaction sets (MOVE_REACTION_SETS_PER_POST). */
  extraPosts?: number;
}

export interface RawDedupRow {
  user_id: string;
  request_id: string;
  digest: string;
  result_json: string;
  transition_json: string | null;
  expires_ms: number;
}

export interface RawCredentialRow {
  credential_id: string;
  user_id: string;
  public_key_json: string;
  sign_count: number;
  transports_json: string | null;
  created_ms: number;
  updated_ms: number;
}

/** A passkey a schema reset carries over, with its identity (see readCarriedPasskeys). */
export interface CarriedPasskey extends RawCredentialRow {
  user_handle: string;
  name: string;
  tier: string;
  identity_created_ms: number;
  identity_updated_ms: number;
  in_general: number;
  roles_json: string;
}

export interface RawIdentityRow {
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

export interface RawUploadRow {
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
  /** Read only where needed (cleanupUploads). */
  created_ms?: number;
}

/** A limiter row's token bucket (limiter.ts). */
export function bucketOf(row: RawLimitRow): Bucket {
  return { level: Number(row.level) || 0, at: integerColumn(row.level_ms) };
}

export function bucketRow(bucket: Bucket): Pick<RawLimitRow, "level" | "level_ms"> {
  return { level: bucket.level, level_ms: bucket.at };
}

export interface RawMaintenanceRow {
  id: number;
  next_cleanup_ms: number;
  cleanup_cutoff_ms: number | null;
  cleanup_cursor: number | null;
  schema_version: number;
}

/** When cleanup is scheduled, and whether a job is in progress (a cursor and cutoff are set): what cleanupDueAt reads. */
export interface CleanupSchedule {
  next: number;
  jobInProgress: boolean;
}

export function cleanupSchedule(row: Pick<RawMaintenanceRow, "next_cleanup_ms" | "cleanup_cursor" | "cleanup_cutoff_ms">): CleanupSchedule {
  return { next: row.next_cleanup_ms, jobInProgress: row.cleanup_cursor !== null && row.cleanup_cutoff_ms !== null };
}
/** A duration as a refusal names it: whole days (`30 days`), else hours. */
export function windowDays(ms: number): string {
  const days = ms / 86_400_000;
  if (Number.isInteger(days)) return days === 1 ? "1 day" : `${days} days`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** An identity row's `roles_json`, keeping only well-formed role names. */
export function parseRoles(json: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(json ?? "", []);
  if (!Array.isArray(parsed)) return [];
  const roles: string[] = [];
  for (const role of parsed) {
    if (typeof role === "string" && ROLE_PATTERN.test(role) && !roles.includes(role) && roles.length < MAX_ROLES_PER_USER) roles.push(role);
  }
  return roles;
}

/** The R2 key a catalog's JSON is published at: named by its SHA-256, so a new catalog has a new `catalog_url`. */
export function emojiObjectKey(json: string): string {
  return `e/c/${createHash("sha256").update(json).digest("hex")}.json`;
}


/** One `roomMembers` row, with the chosen status and `seen` when asked for. */
export interface RawMemberRow {
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
export function statusColumns(row: RawMemberRow): Pick<RoomMember, "choice" | "seen"> {
  const seen = seenColumn(row.seen_ms);
  return { choice: choiceColumn(row.status), ...(seen !== undefined ? { seen } : {}) };
}

/** Refuses a `seen` that is not positive epoch milliseconds. */
export function assertSeen(seen: number): void {
  if (!Number.isSafeInteger(seen) || seen <= 0) throw new StoreError("invalid_params", "invalid seen");
}

/** A stored `seen_ms` as epoch milliseconds, or undefined for none (0). */
export function seenColumn(value: unknown): number | undefined {
  const seen = integerColumn(value);
  return seen > 0 ? seen : undefined;
}

/** A stored `status` choice: `online` when there is no row, and `""` for a value this server no longer knows. */
export function choiceColumn(value: unknown): StatusChoice {
  if (value === null || value === undefined) return "online";
  return isStatusChoice(value) ? value : "";
}

/** A room's member rows as read, kept for reuse (Store.roomMembers). */
export interface MemberCacheEntry {
  at: number;
  generation: number;
  perRoom: number;
  withStatus: boolean;
  rows: RawMemberRow[];
  /** Whether `count` was read for a full page (asked for with `counts`). */
  counted: boolean;
  count?: number;
}

export type RawPushRow = { url: string; p256dh: string; auth: string; push_id: string | null; wake: number };

export function pushRecord(row: RawPushRow, userId: string): PushSubscriptionRecord {
  return { url: row.url, userId, p256dh: row.p256dh, auth: row.auth, ...(row.push_id !== null ? { pushId: row.push_id } : {}) };
}


export function numericId(value: string, field = "id"): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new StoreError("invalid_params", `${field} must be a decimal string`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || String(number) !== value.replace(/^0+(?=\d)/, "")) {
    throw new StoreError("invalid_params", `${field} is outside the supported range`);
  }
  return number;
}

export function numericBigInt(value: bigint, field = "id"): string {
  if (typeof value !== "bigint" || value < 0n || value > BigInt(MAX_SAFE_ID)) {
    throw new StoreError("invalid_params", `${field} is outside the supported range`);
  }
  return value.toString();
}

export function idString(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_ID) {
    throw new StoreError("internal_error", "identifier range exhausted");
  }
  return String(value);
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseJson<T>(value: string, fallback?: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    if (fallback !== undefined) return fallback;
    throw new StoreError("internal_error", "corrupt persisted JSON");
  }
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The keys of a user's `ext` that a write changed (protocol §4.13), as a
 * `user` notification carries them: each new or replaced value, and `""`
 * for each key it cleared. Undefined when nothing changed.
 */
export function changedExt(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const changed = new Map<string, unknown>();
  for (const [key, value] of Object.entries(after ?? {})) {
    if (!before || !Object.hasOwn(before, key) || canonicalize(before[key]) !== canonicalize(value)) changed.set(key, value);
  }
  for (const key of Object.keys(before ?? {})) if (!after || !Object.hasOwn(after, key)) changed.set(key, "");
  return changed.size ? Object.fromEntries(changed) : undefined;
}

/** An identity row's `ext_json`: its object without server-owned keys, or undefined when empty or unreadable. */
export function parseUserExt(json: string | null | undefined): Record<string, unknown> | undefined {
  if (!json) return undefined;
  const parsed = parseJson<unknown>(json, null);
  return isPlainObject(parsed) && Object.keys(parsed).length ? clientUserExt(parsed) : undefined;
}

export function dayFor(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function positiveLimit(value: number | undefined, defaultValue: number, max: number): number {
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
export function canonicalize(value: unknown): string {
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

export function digestOperation(method: string, params: unknown): string {
  return createHash("sha256").update(canonicalize({ method, params }), "utf8").digest("hex");
}

export function cursorRows<T>(cursor: SqlCursorLike<T>): T[] {
  if (typeof cursor.toArray === "function") return cursor.toArray();
  if (typeof cursor[Symbol.iterator] === "function") return Array.from(cursor as Iterable<T>);
  if (typeof cursor.one === "function") {
    try { return [cursor.one()]; } catch { return []; }
  }
  return [];
}

/** The per-day counts of a limiter row (`principal_limits`), each meaning "so far on the row's `day`". */
type DayColumn = "posts_day" | "registrations_day" | "uploads_day";

/**
 * A limiter row's count for `day`: its stored count if the row is that
 * day's, else 0, since a row's day counts start over lazily, when the next
 * event writes it. Every read of a day count goes through here, so none can
 * forget the rollover; a missing row counts 0.
 */
export function dayCount(row: { day: string } & Partial<Record<DayColumn, unknown>> | null | undefined, column: DayColumn, day: string): number {
  return row && row.day === day ? integerColumn(row[column]) : 0;
}

export function integerColumn(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

/**
 * A room's inclusive history lower bound. It is the server-wide retention
 * floor F, raised to the room's creation record. It never decreases: F is
 * monotonic, and a room reports null (effective bound latest + 1) only while
 * F > latest, so any later record in the room is at least F.
 */
export function roomHistoryFloor(room: Pick<RawRoomRow, "created_log_id">, floor: number): number {
  return Math.max(floor, room.created_log_id);
}

export function roomHistoryLogId(room: Pick<RawRoomRow, "created_log_id" | "latest_log_id">, floor: number): string | null {
  const lower = roomHistoryFloor(room, floor);
  return lower <= room.latest_log_id ? idString(lower) : null;
}

/** A stored list of room IDs, dropping anything malformed. */
export function roomIdList(value: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(value || "[]", []);
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 64))];
}

/** An imported user's avatar: a plain `https:` URL without credentials, of bounded length, or undefined. */
export function restoredAvatar(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || utf8Bytes(value) > MAX_RESTORED_AVATAR_BYTES) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

/** One record restoreRoom takes, checked (@apron/archive validateRecord), with its parsed wire value. */
export type RestoredRecord = ValidRecord;

/** An archived record of `roomId`, checked as restoreRoom stores it (validateRecord). Throws otherwise. */
export function restoredRecord(roomId: string, record: ChatRecord): RestoredRecord {
  const checked = validateRecord(record, roomId);
  if ("problem" in checked) throw new StoreError("invalid_params", `Record ${String(record?.log_id)} of ${roomId} ${checked.problem}`.slice(0, 200));
  return checked.record;
}

/** The reaction sets and members a restored record holds (RESTORE_ENTRIES_BATCH). */
export function restoredEntries(record: RestoredRecord): number {
  if (record.kind === "reactions") return (record.value.reactions as unknown[]).length;
  if (record.kind === "membership") return (record.value.members as unknown[]).length;
  return 0;
}

/** An identity's avatar while it has not expired (protocol §4.8.7). */
export function liveAvatar(row: { avatar_url: string | null; avatar_expires_ms: number | null }, now: number): string | undefined {
  return row.avatar_url && (row.avatar_expires_ms ?? 0) > now ? row.avatar_url : undefined;
}

/** An unguessable object key segment (protocol §4.8.2): 128 random bits, base64url. */
export function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function ensureText(value: unknown, field: string, maxBytes: number): string {
  return must(boundedText(value, field, maxBytes));
}

/** A content check's value, or its refusal thrown as the StoreError a request answers with (content/policy.ts). */
export function must<T>(verdict: Verdict<T>): T {
  if (!verdict.ok) throw new StoreError(verdict.code, verdict.message);
  return verdict.value;
}

/** The counts kept in `_meta` instead of counted by a scan; changed only by Store.adjustCount. */
export type MetaCount = "identity_count" | "thread_count" | "private_count" | "principal_limit_count";

/** A SettledMeta that starts out known to hold `initial`, as a freshly bootstrapped store does. */
export function settledMeta(key: string, initial: string): SettledMeta {
  const meta = new SettledMeta(key);
  meta.load(initial);
  return meta;
}
