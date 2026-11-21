/*
 * Durable storage for the public Apron demo: the SQLite implementation
 * behind the store's parts (src/store/index.ts, parts.ts). Code outside
 * src/store reaches it only through them (sqlite-parts.ts delegates each
 * part's methods here, by the names below).
 *
 * The worker deliberately keeps all authoritative state behind the store.  A
 * Durable Object is single threaded, but requests can still be interleaved at
 * every await in the websocket handler.  Store methods are synchronous with
 * respect to SQLite; callers can therefore make the reply/broadcast gate wait
 * for a complete mutation before exposing its result.
 */

import { defaultStoreConfig, type StoreConfig } from "./config";
import type {
  AccountingGuard, Broadcast, PendingUpload, PushClaim, RoomMember, StoreCleanupResult, StoreHistoryQuery, UploadPurpose,
  DurableSqlStorageLike, DurableStateLike, EmojiDraft, EmojiEdit, EmojiEntry, Identity, LiveEntry, LiveFinish, MessageSnapshot,
  MutationMethod, OverrunNotice, PendingHistory, PushCandidate, RoomNotesCheck, RoomRecord, SqlCursorLike, SqlStorageLike,
  StatusInputRecord, StoreClock, StoredServerMetadata, StoreHistoryResult, StoreMutationInput, StoreMutationResult, TerminalStored, Tier,
  UploadFinish, UploadWrite,
} from "./types";
import {
  assertSeen, bucketOf, bucketRow, canonicalize, type CarriedPasskey, changedExt, choiceColumn, cleanupSchedule, type CleanupSchedule,
  clientRoomFields, clone, type CommitContext, cursorRows, dayCount, dayFor, digestOperation, emojiObjectKey, ensureText, idString,
  integerColumn, isLiveEntry, isPlainObject, liveAvatar, liveUrl, type MemberCacheEntry, type MembershipRecord, type MetaCount, must,
  numericBigInt, numericId, parseJson, parseRoles, parseUserExt, positiveLimit, pushRecord, randomKey, type RawCredentialRow,
  type RawDedupRow, type RawIdentityRow, type RawLogState, type RawMaintenanceRow, type RawMemberRow, type RawMessageRow, type RawPushRow,
  type RawReactionRow, type RawRecordRow, type RawRoomRow, type RawUploadRow, type ReactionsRecord, type RecordKind, restoredAvatar,
  restoredEntries, restoredRecord, type RestoredRecord, roomHistoryFloor, roomHistoryLogId, roomIdList, seenColumn, settledMeta,
  statusColumns, storedCreator, terminalOutputBytes, utf8Bytes, windowDays,
} from "./rows";
import { LimiterCache, type RawLimitRow } from "../limiter-cache";
import {
  BUDGET_COLUMNS, type BudgetCost, type BudgetDelta, BudgetLedger, type BudgetSnapshot, type CostEstimate, type RawBudgetRow,
} from "../budget-ledger";
import {
  EMOJI_OWNER, META_ACCOUNT_USAGE, META_ACCOUNTING_GUARD, META_ACCOUNTING_UNSAFE, META_ANNOUNCED_TIER, META_ATTACK_PAUSE, META_BOT_SWEEP,
  META_EFFECTIVE_NOW, META_EMOJI_CATALOG, META_EMOJI_PREVIOUS, META_GUEST_NUMBER_MARK, META_HISTORY_EXPORT, META_HISTORY_IMPORT,
  META_HISTORY_IMPORT_PROGRESS, META_HISTORY_KEPT, META_HISTORY_LINK, META_HISTORY_OPS, META_HISTORY_OPS_SEQ, META_HISTORY_PUBLISHED,
  META_HISTORY_ROOMS_DUE, META_HISTORY_THROUGH, META_HISTORY_TIER, META_IDLE_ACTIVITY_SINCE, META_IDLE_PRUNE_DAY, META_IDLE_PRUNED,
  META_LIVE_TEXTS, META_PRESENCE_ON, META_PURGE_ROOMS, META_PURGED_PREFIX, META_RENAMED_PREFIX, META_ROOM_NOTES_ALERTED,
  META_SERVER_PREFIX, META_STORAGE_ALERTED, META_STORAGE_PRESSURE, META_THROTTLE_TRIPS, META_TOGGLE_PREFIX, META_UPLOAD_BYTES,
  PUSH_UNREAD_SCOPE, SERVER_FIELDS, SERVER_OWNER, USER_LIMIT_SCOPES,
} from "./meta";
import {
  ACCOUNTING_UNCERTAIN, BREAKER_ALERT_ONLY, BREAKER_EXEMPT, BREAKER_MS, BREAKER_OVERRUNS, BREAKER_WINDOW_MS, DEGRADED, emptyGuard,
  maintenanceDelta, OPERATION_PAUSED, OPERATION_WRAPPERS, parseGuard, STORAGE_UNAVAILABLE, TRIP_WINDOW_MS,
} from "./accounting";
import { SettledMeta } from "../settled-meta";
import type { ChunkIndex, ChunkRef } from "../history/cold/chunks";
import { contentPolicy, type ContentPolicy } from "../content/policy";
import {
  JOINED_WAKE_CONDITION, lastActiveSql, MEMBER_TABLES, privateRange, PUBLIC_ROOMS, ROOM_COLUMNS, ROOM_INDEX_DDL, roomKind,
  SCHEMA_10_COPIED_COLUMNS, SCHEMA_10_DROPPED_INDEXES, SCHEMA_9_INDEXES, SCHEMA_DDL, SCHEMA_VERSION, SEEN_COLUMN_PROBE,
  UPGRADABLE_SCHEMA_VERSION,
} from "./schema";
import {
  BOOTSTRAP_ROW_RESERVATION, DEGRADE_SHARE, listedThreads, listedThreadScale, MAX_MEMBERSHIPS_PER_USER, MAX_PRIVATE_MEMBERSHIPS_PER_USER, MAX_PUSH_CANDIDATES,
  MAX_PUSHES_PER_MESSAGE, SEEN_WRITE_GRANULARITY_MS, thresholdRecords,
} from "../budget";
import { type LimitCategory, limitData, StoreError } from "../store-error";
import {
  BOT_MODERATOR_ROLES, BOT_NAME_PATTERN, BOT_NAME_RULE, DEFAULT_JOINED_ROOMS, isPrivateRoomId, isProtocolId, JOINED_WAKE_ROLES,
  LIVE_TEXT_LONG_ROLES, MAX_CREATED_ROOMS, MAX_LISTED_USER_ROOMS, MAX_PASSKEYS_PER_USER, MAX_PUSH_URL_BYTES, MAX_READ_RECEIPT_MEMBERS, MAX_ROLES_PER_USER,
  MAX_ROOM_MUTES_PER_USER, MAX_USER_ROOMS, MODERATOR_ROLES, nextRoomMuteEnd, PRIVATE_ROOM_PREFIX, PUSH_ID_PATTERN, ROLE_PATTERN,
  ROOM_CREATOR_ROLES, ROOM_ID, type RoomMute, seenStands, type StoredCredential, type StoredIdentity, UNCLAIMED_ROLE, WAKE_SCOPES,
} from "../domain";
import { ADMIN_USER_ID, restorableUserId } from "../user-ids";
import {
  ACTIVITY_GRANULARITY_MS, ALL_WAKE, BOT_PREFIX, DEFAULT_ROOM_TITLE, DEFAULT_THREAD_TITLE, DEFAULT_WAKE, EMPTY_ROOM_SCAN,
  GUEST_NUMBER_BLOCK_COST, HISTORY_SCAN_BATCH, HISTORY_SCAN_PAGES, HISTORY_TARGET_SCAN, IDLE_PRUNE_BATCH, IDLE_PRUNE_RUNS_PER_DAY,
  LIMITER_IDLE_MS, LISTED_PRIVATE_ROOMS, LIVE_KINDS, LIVE_WRITES, MAX_CARRIED_PASSKEYS, MAX_HISTORY_REWRITES,
  MAX_MEMBERSHIP_ROWS, MAX_PURGE_ROOMS, MAX_PUSH_SUBSCRIPTIONS_PER_USER, MAX_PUSH_WAKES_PER_USER, MAX_SAFE_ID, MEMBERSHIP_COUNT_READS,
  MEMBERSHIP_LIMIT_MESSAGE, MINUTE_MS, MOVE_REACTION_SETS_PER_POST, PRESSURE_CLEANUP_RETRY_MS, PRIVATE_ROOM_COUNT_READS, PRIVATE_ROOM_ROWS,
  PUSH_REFRESH_MS, RESTORE_ENTRIES_BATCH, RESTORE_ENTRIES_SINGLE, RESTORE_FUTURE_MS, RESTORE_RECORDS_BATCH,
  RESTORE_REPLAY_CAP, RESTORE_USERS_BATCH, RETAINED_SCAN_CAP, RETIRED_MARKER_MARGIN, RETIRED_SWEEP_BATCH,
  ROOM_NOTES_NAMED, ROOM_TITLE, UPLOAD_SWEEP_BATCH, UPLOAD_WRITE_GRACE_MS, UPLOAD_WRITES,
} from "./limits";
import type { AccountUsageSnapshot } from "../account-usage";
import type { ChatRecord, HistoryQuery, QueuedRewrite, Rewrite } from "../history/records";
import { type ChainStatePort, MAX_KEPT_GROUPS } from "../history/state";
import {
  type ArchivedRoom, type ArchivedUser, parseLogId, type ReplayedMembership, replayRecords, roomClientFields, type RoomListing,
} from "@apron/archive";
import { clientUserExt, MAX_USER_EXT_BYTES, mergeExt, recordedUser, userExtFits } from "../content/user";
import { type Bucket, chargeBucket, type Rate } from "../limiter";
import { isEmptyBody, type MessageBody } from "../content/body";
import { hasAppend, messageContent, sharesText, withEditedBy } from "../content/snapshot";
import { liveResultEmbed, terminalOg, uploadResultEmbed, uploadTitle } from "../content/embeds";
import { keepAppend, keepLast, liveDeadline, liveHolds, type LiveKind, liveTextString, terminalOutput } from "../live-text";
import type { TerminalOutputRef } from "../content/output-ref";
import type { StatusChoice } from "../presence";
import { emojiIdentity, isEmojiKey } from "../content/emoji";

export class SqliteStore {
  readonly config: StoreConfig;
  readonly sql: SqlStorageLike;
  readonly clock: StoreClock;
  private readonly durableStorage?: DurableStateLike["storage"];
  private readonly transactionSync?: <T>(closure: () => T) => T;
  private initialized = false;
  /** Threads a listing names, the most recently active (listRooms, budget.ts listedThreads): older ones are read by their room_id, and exported (allRooms). */
  private get listedThreadCount(): number {
    return listedThreads(this.config.maxThreads);
  }
  /**
   * Most public rows a listing reads (listRooms): `general` and the top-level
   * rooms (MAX_CREATED_ROOMS, well within one thread scale), and the
   * listedThreadCount threads it names.
   */
  private get publicRoomRows(): number {
    return listedThreadScale(this.config.maxThreads) + this.listedThreadCount + 1;
  }
  /**
   * Most rooms one `room_list` names, whose members roomMembers fills in:
   * `general`, the created rooms, the listed threads and the caller's private
   * rooms, or a user's own listing (MAX_USER_ROOMS), whichever is more.
   */
  private get listedRoomBound(): number {
    return Math.max(MAX_USER_ROOMS, 1 + MAX_CREATED_ROOMS + this.listedThreadCount + this.config.maxPrivateMembershipsPerUser);
  }
  /**
   * Reads for counting a kind's rooms created within the window
   * (recentRoomCount), or a user's among them: its range of
   * ROOM_CREATED_INDEX, which the caps keep within the ceilings (a room is
   * created, or restored inside the window, only while there is a slot), with
   * room for a window lengthened since, and index pages.
   */
  private get roomCountReads(): number {
    return 2 * Math.max(this.publicRoomRows, PRIVATE_ROOM_ROWS) + 16;
  }
  /**
   * Reads for checkRoomFieldsTotal(): the rooms a listing names (listedRoomRows),
   * public and private, with slack for index pages.
   */
  private get roomFieldsTotalReads(): number {
    return 16 + 2 * (this.publicRoomRows + PRIVATE_ROOM_ROWS);
  }
  /** What the last room_set's total check saw, until taken (takeRoomNotesCheck). */
  private roomNotesCheck?: RoomNotesCheck;
  private inTransaction = false;
  /** Whether this wake's first cleanup made sure of the rooms' kind indexes (ensureRoomKindIndexes). */
  private roomKindIndexReady = false;
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
  /** The published floor as stored (META_HISTORY_PUBLISHED), 0 for none; read once a wake. */
  private publishedCache: number | undefined;
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
  /** The accounting marker (`0`, `1`, or `uncertain`), written only when it changes and never rolled back (persistSettled). */
  private readonly accountingMarker = settledMeta(META_ACCOUNTING_UNSAFE, "0");
  /** Set while an operator alert runs (alert): reservations are charged, never refused, even with accounting closed. */
  private alerting = false;
  /**
   * Called after each overrun, once the operation has unwound (noteOverrun),
   * so the runtime can tell the operators and re-evaluate the server's tier.
   */
  onOverrun?: (notice: OverrunNotice) => void;
  /**
   * Called, synchronously, as accounting overruns, closes on a storage
   * failure or reopens, for a metric, with what happened where known; it
   * must not touch storage.
   */
  onAccounting?: (change: "overrun" | "uncertain" | "recovered", message?: string) => void;
  /**
   * The principals the operation running now acts for (`user:<id>`,
   * `ip:<key>`), from the runtime; none for the server's own work (alarms,
   * sweeps). Overruns are logged with them.
   */
  actor?: () => readonly string[] | undefined;
  /** What overruns have set off, read on wake (META_ACCOUNTING_GUARD). */
  private guard: AccountingGuard = emptyGuard();
  /** The guard as stored, written only when it changes and never rolled back (persistSettled). */
  private readonly guardMarker = settledMeta(META_ACCOUNTING_GUARD, "");
  /** The storage-pressure latch, set on the way to a refusal and so never rolled back (persistSettled). */
  private readonly storagePressure = new SettledMeta(META_STORAGE_PRESSURE);
  /** Set while persistSettled writes, so a failure inside it does not re-enter it. */
  private persisting = false;
  /** Overruns' excess rows, charged once the operation's transaction has ended (persistSettled). */
  private overrunCharges: Array<{ day: string; delta: BudgetDelta }> = [];
  private deferredCleanupUntil = 0;
  /**
   * The earliest effective time a cleanup may start because the database is
   * at its storage watermark (cleanupDueAt), however far off the scheduled
   * one is: 0 until one has, then PRESSURE_CLEANUP_RETRY_MS after the last.
   * In memory: a new instance looks once at once.
   */
  private pressureCleanupAfter = 0;
  /** Set when a refusal at the watermark needs an earlier alarm than the one scheduled (takeAlarmChange). */
  private alarmChanged = false;
  /**
   * `next_cleanup_ms` as last read (maintenanceRow), and whether a cleanup
   * job was in progress then, so an alarm can tell whether cleanup is due
   * without a reservation (cleanupDue); forgotten at every write of the row,
   * which reads it again.
   */
  private cleanupDueCache?: CleanupSchedule;
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
  /** The cold tiers' chunk indexes, as loaded from this SQLite, by tier name (chunkIndex). */
  private readonly chunkIndexes = new Map<string, Map<number, ChunkRef>>();
  /** Whether the chunk table exists, this instance (chunkIndex). */
  private chunkTableReady = false;
  /** What this server takes as content, for a post and an import alike (content/policy.ts), from its limits. */
  readonly content: ContentPolicy;

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
    this.content = contentPolicy(this.config);
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
      this.accountingMarker.load(unsafeMarker || "0");
      this.guardMarker.load(this.metaValue(META_ACCOUNTING_GUARD));
      this.guard = parseGuard(this.guardMarker.persisted!);
      if (unsafeMarker === "1" || unsafeMarker === "true") {
        // The permanent overrun stop of earlier versions: overruns no longer
        // stop the server, so the marker is cleared (persistSettled,
        // with the next transaction) and its stop is not kept.
        console.warn(JSON.stringify({ event: "accounting_unsafe_retired" }));
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
  /**
   * Adds the rooms' kind indexes (ROOM_INDEX_DDL) to an object made before
   * them: once a wake, by the first cleanup (maintenance), never by a wake
   * itself, which writes nothing. The schema version stays, since the
   * indexes are additive (an older build ignores them and SQLite keeps them
   * as rooms change). Until they exist the queries that would use them scan
   * the table's key instead: the same rows, only read the slow way.
   */
  private ensureRoomKindIndexes(): void {
    if (this.roomKindIndexReady) return;
    for (const ddl of ROOM_INDEX_DDL) this.rawExec(ddl);
    this.roomKindIndexReady = true;
  }

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
    this.persistSettled();
    console.warn(JSON.stringify({ event: "accounting_uncertain_recovered", ...(charged ? { charged } : {}) }));
    try { this.onAccounting?.("recovered"); } catch { /* a metric never breaks recovery */ }
    return true;
  }

  /**
   * Throws while work is refused: while a storage failure leaves accounting
   * uncertain (until recoverUncertain succeeds), while the server is paused
   * after a huge overrun, and for an operation whose breaker is open. An
   * operator alert (alert) runs regardless. Every metered operation calls it
   * before it starts counting its rows, so recovery's own rows are never
   * charged to the operation that triggered it.
   */
  private assertAccounting(): void {
    // The retired permanent stop's marker (initialize) is cleared by the first operation after the wake.
    const marker = this.accountingMarker.persisted;
    if (marker === "1" || marker === "true") this.persistSettled();
    if (this.alerting) return;
    if (this.accountingUncertain && !this.recoverUncertain()) {
      throw new StoreError("internal_error", "storage is unavailable", { data: { reason: STORAGE_UNAVAILABLE } });
    }
  }

  /**
   * Refuses a foreground reservation whose operation's breaker is open, by
   * the name its reservation site carries (operationName). Maintenance work,
   * operator alerts and admin (`unchecked`) work are never refused, nor the
   * operations every request passes through (BREAKER_EXEMPT).
   */
  private assertBreaker(site: Error, now: number): void {
    let open = false;
    for (const end of Object.values(this.guard.breakers)) if (end > now) open = true;
    if (!open) return;
    const operation = this.operationName(site);
    const until = this.guard.breakers[operation];
    if (until === undefined || until <= now || BREAKER_EXEMPT.has(operation)) return;
    throw new StoreError("retry_after", "This action is paused after it used more storage than expected; try again later", {
      retryAfterMs: Math.max(1_000, until - now),
      data: { reason: OPERATION_PAUSED },
    });
  }

  /**
   * Where a reservation is made: a stack captured (not yet formatted) as it
   * starts, so an overrun noted later and a breaker checked at the start
   * name the same operation (operationName).
   */
  private captureSite(): Error {
    const errors = Error as unknown as { stackTraceLimit: number };
    const limit = errors.stackTraceLimit;
    errors.stackTraceLimit = 12;
    const site = new Error("reservation site");
    errors.stackTraceLimit = limit;
    return site;
  }

  /**
   * The SqliteStore method a reservation belongs to: the innermost method on its
   * site's stack that is not a wrapper (OPERATION_WRAPPERS). The stack is
   * formatted only here, for an overrun or while a breaker is open. A part's
   * function (sqlite-parts.ts) is no `…Store` method, so an operation keeps
   * its SqliteStore name whichever part called it.
   */
  private operationName(site: Error | undefined): string {
    for (const match of (site?.stack ?? "").matchAll(/at (?:async )?\w*Store\.(\w+)/g)) {
      if (!OPERATION_WRAPPERS.has(match[1])) return match[1];
    }
    return "unknown";
  }

  /** What overruns have set off now, for the runtime's tier and `/status`. */
  accountingGuard(now = this.clock.now()): { day: string; overruns: number; breakers: Record<string, number> } {
    const breakers: Record<string, number> = {};
    for (const [op, end] of Object.entries(this.guard.breakers)) if (end > now) breakers[op] = end;
    const today = dayFor(Math.max(this.lastEffectiveMs, now));
    return {
      day: today,
      overruns: this.guard.day === today ? this.guard.overruns : 0,
      breakers,
    };
  }

  /**
   * Records an overrun: an operation read or wrote more rows than it
   * reserved. Its excess is charged to the day's budget once its transaction
   * ends, so the ceilings stay true; it is logged and counted under the
   * operation's name, with whom it acted for, and the operation finishes.
   * Three of one foreground operation within an hour, or one whose excess
   * passes a hundredth of a day's SQL ceilings (an estimate that wrong may be
   * unbounded), open that operation's breaker for an hour.
   */
  private noteOverrun(reserved: BudgetCost, actualReads: number, actualWrites: number, excess: { reads: number; writes: number }): void {
    const operation = this.operationName(reserved.site);
    const now = Math.max(this.lastEffectiveMs, this.clock.now());
    const day = dayFor(now);
    const message = `${operation}: ${actualReads}/${reserved.reads} reads, ${actualWrites}/${reserved.writes} writes`;
    const maintenance = reserved.maintenance === true;
    const guard = this.guard;
    const firstToday = guard.day !== day;
    if (firstToday) {
      guard.day = day;
      guard.overruns = 0;
    }
    guard.overruns += 1;
    for (const [op, end] of Object.entries(guard.breakers)) if (end <= now) delete guard.breakers[op];
    for (const [op, times] of Object.entries(guard.recent)) {
      const kept = times.filter((time) => time > now - BREAKER_WINDOW_MS);
      if (kept.length) guard.recent[op] = kept;
      else delete guard.recent[op];
    }
    const huge = excess.reads > this.config.sqlReadsPerDay / 100 || excess.writes > this.config.sqlWritesPerDay / 100;
    let breaker = false;
    const essential = BREAKER_ALERT_ONLY.has(operation);
    if (!maintenance && !this.alerting && !BREAKER_EXEMPT.has(operation) && !essential) {
      const times = [...(guard.recent[operation] ?? []), now];
      if (huge || times.length >= BREAKER_OVERRUNS) {
        guard.breakers[operation] = now + BREAKER_MS;
        delete guard.recent[operation];
        breaker = true;
      } else {
        guard.recent[operation] = times;
      }
    }
    this.chargeOverrun(reserved, excess, day);
    const principals = [...new Set(this.actor?.() ?? [])];
    console.error(JSON.stringify({ event: "accounting_overrun", operation, message, principals, excess, breaker, huge }));
    try { this.onAccounting?.("overrun", message); } catch { /* a metric never breaks accounting */ }
    const notify = this.onOverrun;
    if (notify) {
      const notice: OverrunNotice = { operation, message, principals, maintenance, firstToday, breaker, huge, essential };
      queueMicrotask(() => { try { notify(notice); } catch { /* a notice never breaks accounting */ } });
    }
  }

  /** Queues `excess` rows to charge to the reservation's day and kind, once its transaction ends (persistSettled). */
  private chargeOverrun(reserved: BudgetCost, excess: { reads: number; writes: number }, day: string): void {
    if (!excess.reads && !excess.writes) return;
    this.overrunCharges.push({
      day: reserved.day ?? day,
      delta: reserved.maintenance
        ? maintenanceDelta(excess)
        : { reads_reserved: excess.reads, writes_reserved: excess.writes, foreground_reads: excess.reads, foreground_writes: excess.writes },
    });
    this.persistSettled();
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
   * overrun guard (breakers) is not carried. Callers must hold the object's input gate (the runtime uses
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
    this.publishedCache = undefined;
    this.accountingUncertain = false;
    this.lostOnWake = false;
    this.accountingMarker.load("0");
    this.guard = emptyGuard();
    this.guardMarker.load("");
    this.storagePressure.forget();
    this.overrunCharges = [];
    this.lastEffectiveMs = 0;
    this.cleanupDueCache = undefined;
    this.limiters.clear();
    this.scheduledAlarmAt = undefined;
    this.initialize();
    if (guestNumberMark > 0) {
      // Guest numbers outlive the wipe, so none is ever reissued. Like the
      // budget row, this is one uncharged control write.
      this.writeMeta(META_GUEST_NUMBER_MARK, String(guestNumberMark));
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
      this.writeMeta("identity_count", String(integerColumn(count?.count)));
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
    this.publishedCache = undefined;
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
        this.persistSettled();
        return result;
      } catch (error) {
        this.inTransaction = false;
        this.persistSettled();
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
      this.persistSettled();
      return result;
    } catch (error) {
      this.inTransaction = false;
      this.persistSettled();
      throw error;
    }
  }

  /**
   * Writes the values a rollback must not erase (SettledMeta) when they
   * changed: the overrun guard, the storage-pressure latch and the
   * accounting marker (`uncertain` after a storage failure, `0` once clear),
   * and charges the excess of overruns. Runs after any enclosing native
   * transaction has ended, committed or rolled back, and at once outside one.
   */
  private persistSettled(): void {
    // A storage failure while writing here marks accounting uncertain, which
    // comes back here: the outer call finishes, the inner one does nothing.
    if (this.inTransaction || this.persisting) return;
    this.persisting = true;
    try {
      this.persistSettledState();
    } finally {
      this.persisting = false;
    }
  }

  /** Sets a SettledMeta value, written now outside a transaction, else once the transaction has ended. */
  private settle(meta: SettledMeta, value: string): void {
    meta.set(value);
    this.persistSettled();
  }

  private persistSettledState(): void {
    // A failed write keeps the in-memory value; the next transaction tries again.
    const write = (key: string, value: string) => this.writeMeta(key, value);
    this.guardMarker.set(this.guard.day || Object.keys(this.guard.breakers).length || Object.keys(this.guard.recent).length
      ? JSON.stringify(this.guard) : "");
    this.guardMarker.flush(write);
    while (this.overrunCharges.length) {
      const charge = this.overrunCharges[0];
      try {
        this.ledger.chargeUnchecked(charge.day, charge.delta);
      } catch {
        break; // Kept for the next transaction to charge.
      }
      this.overrunCharges.shift();
    }
    this.storagePressure.flush(write);
    // A native storage failure may also prevent the marker write; the next transaction tries it again.
    this.accountingMarker.set(this.accountingUncertain ? ACCOUNTING_UNCERTAIN : "0");
    this.accountingMarker.flush(write);
  }

  /**
   * Closes accounting after a storage failure, until storage works again
   * (recoverUncertain), and logs why once.
   */
  private markAccountingUnsafe(kind: "uncertain", error?: unknown): void {
    if (!this.accountingUncertain) {
      const message = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
      console.error(JSON.stringify({ event: "accounting_closed", kind, message }));
      try { this.onAccounting?.(kind, message); } catch { /* a metric never breaks the stop */ }
    }
    this.accountingUncertain = true;
    this.persistSettled();
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
    const site = this.captureSite();
    if (!maintenance && !unchecked && !this.alerting) this.assertBreaker(site, now);
    const cost = this.ledger.reserve(costInput, Math.max(Math.trunc(now), this.lastEffectiveMs), now, maintenance, unchecked || this.alerting);
    cost.site = site;
    this.countReservation(cost);
    return cost;
  }

  /** Spend the maintenance control gap when ordinary work is exhausted. */
  private reserveMaintenanceControl(costInput: CostEstimate, now: number): BudgetCost {
    this.ensureReady();
    this.assertAccounting();
    const cost = this.ledger.reserveControl(costInput, Math.max(Math.trunc(now), this.lastEffectiveMs));
    cost.site = this.captureSite();
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
    return this.reserved({ reads: 2 * this.config.registeredAccounts + 64 }, false, now, () =>
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
      // predicted: the overrun is charged and noted (assertReservation).
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
    if (actualReads <= reserved.reads && actualWrites <= reserved.writes) return;
    // An overrun is observed: charged, logged, and the operation finishes
    // (noteOverrun). A reservation checked again (in a later transaction, or
    // as it settles) is noted once; only rows past what was charged are added.
    const excess = { reads: Math.max(0, actualReads - reserved.reads), writes: Math.max(0, actualWrites - reserved.writes) };
    const charged = reserved.overrun;
    reserved.overrun = { reads: Math.max(excess.reads, charged?.reads ?? 0), writes: Math.max(excess.writes, charged?.writes ?? 0) };
    if (!charged) {
      this.noteOverrun(reserved, actualReads, actualWrites, excess);
      return;
    }
    const day = dayFor(Math.max(this.lastEffectiveMs, this.clock.now()));
    this.chargeOverrun(reserved, { reads: Math.max(0, excess.reads - charged.reads), writes: Math.max(0, excess.writes - charged.writes) }, day);
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

  /**
   * `uncertain`: a storage failure has not cleared yet, so work is refused.
   * `unsafe` is always false: nothing latches the server any more.
   */
  accountingStatus(): { unsafe: boolean; uncertain: boolean; database_bytes: number | null } {
    return { unsafe: false, uncertain: this.accountingUncertain, database_bytes: this.databaseSize() };
  }

  accountUsageSnapshot(): AccountUsageSnapshot | null {
    this.ensureReady();
    return this.metaJson<AccountUsageSnapshot | null>(META_ACCOUNT_USAGE, (value) => {
      const parsed = value as Partial<AccountUsageSnapshot>;
      const sampledAt = parsed.sampledAt;
      if (typeof parsed.day !== "string" || typeof sampledAt !== "number" || !Number.isSafeInteger(sampledAt) || sampledAt < 0 ||
        ["workerRequests", "durableObjectRequests", "durableObjectDurationGbSeconds", "sqlRowsRead", "sqlRowsWritten", "storedBytes"].some(key => {
          const value = parsed[key as keyof AccountUsageSnapshot];
          return typeof value !== "number" || !Number.isFinite(value) || value < 0;
        }) || typeof parsed.stop !== "boolean") return undefined;
      return parsed as AccountUsageSnapshot;
    }, null);
  }

  persistAccountUsageSnapshot(snapshot: AccountUsageSnapshot, now = this.clock.now()): void {
    this.ensureReady();
    this.reserved({ reads: 8, writes: 8 }, true, now, () => {
      this.writeMeta(META_ACCOUNT_USAGE, JSON.stringify(snapshot));
    });
  }

  budget(now = this.clock.now()): BudgetSnapshot {
    this.ensureReady();
    return this.budgetValue(now);
  }

  /** Today's reservations and the identity count, for `/status`. */
  /**
   * `/status`'s figures: today's budget row, the registered users, the
   * database size, and the enforced daily counters (each `global` limiter
   * row's count today). An admin's view of why work is refused, so it is
   * charged but never refused (unchecked), even while the server is paused.
   */
  status(now = this.clock.now()): { budget: BudgetSnapshot; identities: number; databaseBytes: number | null; counts: { frames: number; admissions: number; posts: number } } {
    this.ensureReady();
    return this.alert(() => this.reserved({ reads: 16 }, false, now, () => {
      const day = dayFor(this.effectiveNow(now));
      const rows = this.rawRows<{ scope: string; day: string; posts_day: number }>(
        "SELECT scope, day, posts_day FROM principal_limits WHERE principal_key = 'global' AND scope IN ('frames', 'admission', 'post')",
      );
      const today = (scope: string) => dayCount(rows.find((row) => row.scope === scope), "posts_day", day);
      return {
        budget: this.budgetValue(now),
        identities: this.metaNumber("identity_count"),
        databaseBytes: this.databaseSize(),
        counts: { frames: today("frames"), admissions: today("admission"), posts: today("post") },
      };
    }, true));
  }

  /**
   * Today's foreground SQL and frames as shares of their daily ceilings,
   * from the budget row this object holds in memory: no SQL, so the runtime
   * may ask on every event. Null before today's first reservation here.
   */
  budgetShares(now = this.clock.now()): { day: string; reads: number; writes: number; frames: number } | null {
    const day = dayFor(Math.max(this.lastEffectiveMs, now));
    const budget = this.initialized ? this.ledger.cachedSnapshot(day) : null;
    if (!budget) return null;
    const share = (used: number, limit: number) => (limit > 0 ? used / limit : 0);
    return {
      day,
      reads: share(budget.foreground_reads, this.config.foregroundReadsPerDay),
      writes: share(budget.foreground_writes, this.config.foregroundWritesPerDay),
      frames: share(budget.frames, this.config.processedFramesPerDay),
    };
  }

  /**
   * Refuses `feature` while today's foreground SQL or frames have reached
   * DEGRADE_SHARE of their ceiling (budgetShares), until UTC midnight.
   */
  private assertNotDegraded(feature: string, now: number): void {
    if (!this.degraded(now)) return;
    throw new StoreError("retry_after", `${feature} is off while the server is busy; try after the daily reset`, {
      retryAfterMs: Math.max(1_000, 86_400_000 - (now % 86_400_000)),
      data: { reason: DEGRADED },
    });
  }

  /** Whether today's foreground SQL or frames have reached DEGRADE_SHARE of their ceiling. */
  private degraded(now: number): boolean {
    const shares = this.budgetShares(now);
    return Boolean(shares && Math.max(shares.reads, shares.writes, shares.frames) >= DEGRADE_SHARE);
  }

  /**
   * Counts one throttle trip (a long refusal a user ran into, told to them
   * once: ApronDemoServer.noteTrip) under `trigger`, in hourly buckets kept
   * for TRIP_WINDOW_MS. Charged but never refused: counting a refusal must
   * not itself be refused.
   */
  noteThrottleTrip(trigger: string, now = this.clock.now()): void {
    this.ensureReady();
    this.alert(() => this.reserved({ reads: 4, writes: 4 }, false, now, () => {
      const buckets = this.tripBuckets(now);
      const hour = String(Math.floor(now / 3_600_000) * 3_600_000);
      const bucket = buckets[hour] ??= {};
      // Bounded: a trigger is a reason or a short slug, and the window is a day of hours.
      if (bucket[trigger] !== undefined || Object.keys(bucket).length < 64) bucket[trigger] = (bucket[trigger] ?? 0) + 1;
      this.writeMeta(META_THROTTLE_TRIPS, JSON.stringify(buckets));
    }, true));
  }

  /** Throttle trips by trigger over the last TRIP_WINDOW_MS (noteThrottleTrip), most first. */
  throttleTrips(now = this.clock.now()): Array<[trigger: string, count: number]> {
    this.ensureReady();
    return this.alert(() => this.reserved({ reads: 4 }, false, now, () => {
      const totals = new Map<string, number>();
      for (const bucket of Object.values(this.tripBuckets(now))) {
        for (const [trigger, count] of Object.entries(bucket)) totals.set(trigger, (totals.get(trigger) ?? 0) + count);
      }
      return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    }, true));
  }

  /** The stored trip buckets still inside the window. */
  private tripBuckets(now: number): Record<string, Record<string, number>> {
    // An unreadable record starts the window afresh.
    return this.metaJson(META_THROTTLE_TRIPS, (stored) => {
      const kept: Record<string, Record<string, number>> = {};
      for (const [hour, bucket] of Object.entries(stored as Record<string, unknown>)) {
        if (Number(hour) <= now - TRIP_WINDOW_MS || !bucket || typeof bucket !== "object") continue;
        const counts: Record<string, number> = {};
        for (const [trigger, count] of Object.entries(bucket)) if (Number.isSafeInteger(count) && (count as number) > 0) counts[trigger] = count as number;
        kept[hour] = counts;
      }
      return kept;
    }, {});
  }

  /** The server tier last announced to the admins (the runtime's record), or "" before any. */
  announcedTier(now = this.clock.now()): string {
    this.ensureReady();
    return this.alert(() => this.reserved({ reads: 4 }, false, now, () => this.metaValue(META_ANNOUNCED_TIER), true));
  }

  /** Records the server tier just announced (announcedTier): charged, never refused. */
  setAnnouncedTier(value: string, now = this.clock.now()): void {
    this.ensureReady();
    this.alert(() => this.reserved({ reads: 4, writes: 4 }, false, now, () => {
      this.writeMeta(META_ANNOUNCED_TIER, value);
    }, true));
  }

  /**
   * The runtime's attack pause record (ApronDemoServer.pauseForAttack), or ""
   * before any. Read once as an instance starts, uncharged like the usage
   * snapshot, so a paused server's refusals cost no SQL.
   */
  attackPause(): string {
    this.ensureReady();
    return this.metaValue(META_ATTACK_PAUSE) ?? "";
  }

  /**
   * Whether the admins have been told the database passed half its
   * high-water mark (ApronDemoServer.maybeAlertStorage). Read once as an
   * instance needs it, uncharged like attackPause.
   */
  storageAlerted(): boolean {
    this.ensureReady();
    return this.metaValue(META_STORAGE_ALERTED) === "1";
  }

  /** Records whether that alert stands (storageAlerted): charged, never refused, written only when it flips. */
  setStorageAlerted(alerted: boolean, now = this.clock.now()): void {
    this.ensureReady();
    this.alert(() => this.reserved({ reads: 4, writes: 4 }, false, now, () => {
      this.writeMeta(META_STORAGE_ALERTED, alerted ? "1" : "0");
    }, true));
  }

  /**
   * Whether the admins have been told the room notes total is full
   * (ApronDemoServer.maybeAlertRoomNotes). Read once as an instance needs
   * it, uncharged like storageAlerted.
   */
  roomNotesAlerted(): boolean {
    this.ensureReady();
    return this.metaValue(META_ROOM_NOTES_ALERTED) === "1";
  }

  /** Records whether that alert stands (roomNotesAlerted): charged, never refused, written only when it flips. */
  setRoomNotesAlerted(alerted: boolean, now = this.clock.now()): void {
    this.ensureReady();
    this.alert(() => this.reserved({ reads: 4, writes: 4 }, false, now, () => {
      this.writeMeta(META_ROOM_NOTES_ALERTED, alerted ? "1" : "0");
    }, true));
  }

  /**
   * What the last room_set's total check saw (checkRoomFieldsTotal), then
   * forgotten: the total of what rooms hold past roomMetadataMinBytes, with
   * this save's room, and on a refusal `full` with the public rooms holding
   * the most past it. Undefined when that save ran no check (it did not grow
   * its room past the minimum). Kept outside the transaction, which a
   * refusal rolls back, so the caller can tell the admins.
   */
  takeRoomNotesCheck(): RoomNotesCheck | undefined {
    const check = this.roomNotesCheck;
    this.roomNotesCheck = undefined;
    return check;
  }

  /** Records an attack pause (attackPause): charged, never refused. */
  setAttackPause(value: string, now = this.clock.now()): void {
    this.ensureReady();
    this.alert(() => this.reserved({ reads: 4, writes: 4 }, false, now, () => {
      this.writeMeta(META_ATTACK_PAUSE, value);
    }, true));
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
    // The latch is a SettledMeta: it is set on the way to a refusal, whose
    // throw would roll a plain write back with the caller's transaction.
    const paused = this.storagePressure.value((key) => this.metaValue(key)) === "1";
    // Cover snapshot copies, indexed inserts/splits and control rows before
    // entering the transaction. The post-write target check also runs before
    // commit; one unexpectedly large operation cannot cross the hard target.
    const growthAllowance = Math.max(1024 * 1024, Math.max(0, additionalBytes) * 16);
    if (size >= this.config.storageHighWaterBytes || size + growthAllowance > this.config.storageHardTargetBytes) {
      if (!paused) this.settle(this.storagePressure, "1");
      throw this.pressureRefusal();
    }
    if (paused) {
      if (size > this.config.storageLowWaterBytes) throw this.pressureRefusal();
      this.settle(this.storagePressure, "0");
    }
  }

  /**
   * A refusal at the storage watermark. Cleanup starts at once for it
   * (cleanupDueAt), moving what is past the count down: so the runtime is
   * told to bring its alarm forward (takeAlarmChange) when the one scheduled
   * is later, and the client to retry once that cleanup has had time to run.
   */
  private pressureRefusal(): StoreError {
    const startAt = Math.max(this.lastEffectiveMs, this.pressureCleanupAfter);
    if (this.scheduledAlarmAt === undefined || this.scheduledAlarmAt > startAt) {
      this.scheduledAlarmAt = undefined;
      this.alarmChanged = true;
    }
    return new StoreError("retry_after", "Demo capacity reached", { retryAfterMs: PRESSURE_CLEANUP_RETRY_MS });
  }

  /** Whether a refusal at the storage watermark needs the alarm brought forward; clears the flag. */
  takeAlarmChange(): boolean {
    const changed = this.alarmChanged;
    this.alarmChanged = false;
    return changed;
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
    return 32 + 4 * this.publicRoomRows;
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
    return this.reserved({ reads: this.roomListingReads() + (withPrivate ? 4 * PRIVATE_ROOM_ROWS : 0) }, options.maintenance === true, now, () => {
      const floor = this.publishedFloor();
      const rows = this.listedRoomRows(withPrivate);
      const since = options.changedSinceFloor;
      return rows
        .filter((row) => since === undefined || roomHistoryLogId(row, since) !== roomHistoryLogId(row, floor))
        .map((row) => this.roomRecord(row, floor));
    });
  }

  /**
   * The rooms a listing names, oldest first: every top-level public room
   * (`general` and those created, at most MAX_CREATED_ROOMS), and the
   * listedThreadCount threads most recently active; `withPrivate`, the
   * LISTED_PRIVATE_ROOMS private rooms most recently active. Rooms are kept
   * until their log has left every tier, so the threads and private rooms
   * are each a bounded range of ROOM_HEAD_INDEX, newest head first, however
   * many the table holds; an older one is read by its room_id (getRoom), and
   * exported (allRooms).
   */
  private listedRoomRows(withPrivate: boolean): RawRoomRow[] {
    const newest = (kind: 0 | 1 | 2, limit: number) => this.rawRows<RawRoomRow>(
      `SELECT ${ROOM_COLUMNS} FROM rooms WHERE ${roomKind(kind)} ORDER BY latest_log_id DESC LIMIT ?`, limit,
    );
    const rows = [...newest(0, MAX_CREATED_ROOMS + 1), ...newest(1, this.listedThreadCount)];
    if (withPrivate) rows.push(...newest(2, LISTED_PRIVATE_ROOMS));
    return rows.sort((a, b) => integerColumn(a.created_log_id) - integerColumn(b.created_log_id) || (a.room_id < b.room_id ? -1 : 1));
  }

  /**
   * Every room, those no listing names included, oldest first, for an export (a
   * history job, charged to maintenance): the one listing that names every
   * room, read in pages of the key, as many rows as the table holds.
   */
  allRooms(now = this.clock.now()): RoomRecord[] {
    this.ensureReady();
    const rows = 1 + this.metaNumber("thread_count") + this.metaNumber("private_count");
    return this.reserved({ reads: 32 + 2 * rows }, true, now, () => {
      const floor = this.publishedFloor();
      const found: RawRoomRow[] = [];
      let after = "";
      for (;;) {
        const page = this.rawRows<RawRoomRow>(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE room_id > ? ORDER BY room_id LIMIT 500`, after);
        found.push(...page);
        if (page.length < 500) break;
        after = page[page.length - 1].room_id;
      }
      return found
        .sort((a, b) => integerColumn(a.created_log_id) - integerColumn(b.created_log_id) || (a.room_id < b.room_id ? -1 : 1))
        .map((row) => this.roomRecord(row, floor));
    });
  }

  /** One room's record, or null when the room does not exist. */
  getRoom(roomId: string, now = this.clock.now()): RoomRecord | null {
    this.ensureReady();
    return this.reserved({ reads: 16 }, false, now, () => {
      const row = this.roomRow(roomId);
      if (!row) return null;
      return this.roomRecord(row, this.publishedFloor());
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
      const floor = this.publishedFloor();
      return this.rawRows<RawRoomRow>(
        `SELECT ${ROOM_COLUMNS.split(", ").map((column) => `r.${column}`).join(", ")}
         FROM memberships m INDEXED BY memberships_user_idx JOIN rooms r ON r.room_id = m.room_id
         WHERE m.user_id = ? AND ${privateRange("m.room_id")} LIMIT ?`,
        userId, MAX_PRIVATE_MEMBERSHIPS_PER_USER,
      ).map((row) => this.roomRecord(row, floor));
    });
  }

  /**
   * The registered user who created a thread or private room with
   * `room_set`, who may remove its members (§4.2.2), kept beside the room's
   * client fields (`creator_id` in `fields_json`) but never in its record.
   * Undefined for `general`, a guest's room, an unknown room, and a public
   * top-level room: its creator was an admin or mod when they made it, and
   * gets no lasting power over its members from that, losing the role or not.
   */
  roomCreator(roomId: string, now = this.clock.now()): string | undefined {
    this.ensureReady();
    return this.reserved({ reads: 16 }, false, now, () => {
      const row = this.roomRow(roomId);
      if (!row || (row.parent_room_id === null && !isPrivateRoomId(row.room_id))) return undefined;
      return storedCreator(row.fields_json);
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
      return { latest_log_id: idString(state.last_log_id), history_floor: idString(this.publishedFloor()) };
    });
  }

  /**
   * The published history floor F: history starts here (§4.3), rooms whose
   * whole log is below it are gone, and retired ids are freed past it. It is
   * the hot floor (log_state.history_floor), below which this SQLite keeps
   * no record, unless tiers below hold the records between them (`tiered`):
   * then META_HISTORY_PUBLISHED, which the history chain raises
   * (publishHistoryFloor), never past the hot floor.
   */
  private publishedFloor(): number {
    const hot = this.logState().history_floor;
    if (!this.config.tiered) return hot;
    this.publishedCache ??= this.metaNumber(META_HISTORY_PUBLISHED);
    return this.publishedCache > 0 ? Math.min(this.publishedCache, hot) : hot;
  }

  /**
   * The records the hot log holds from the hot floor on, for `/status`:
   * counted up to RETAINED_SCAN_CAP (one index entry each, refunded past
   * what is found), and that cap and one more past it.
   */
  hotRecords(now = this.clock.now()): number {
    this.ensureReady();
    return this.reserved({ reads: 16 + RETAINED_SCAN_CAP + 1 }, false, now, () => integerColumn(this.rawRows<{ count: number }>(
      "SELECT COUNT(*) AS count FROM (SELECT 1 FROM records INDEXED BY records_log_idx WHERE log_id >= ? LIMIT ?)",
      this.logState().history_floor, RETAINED_SCAN_CAP + 1,
    )[0]?.count));
  }

  /**
   * The hot floor, the published floor (publishedFloor) and the log head
   * (the last log ID issued, `latest`), for the history chain: an import
   * that renumbers its records places them past the head.
   */
  historyFloors(now = this.clock.now()): { hot: number; published: number; latest: number } {
    this.ensureReady();
    return this.reserved({ reads: 8 }, true, now, () => {
      const state = this.logState();
      return { hot: state.history_floor, published: this.publishedFloor(), latest: state.last_log_id };
    });
  }

  /**
   * The head's target (HistoryHead.floorFor): while a cleanup job runs, the
   * log ID of the first record its pinned cutoff keeps, below which records
   * are copied down before cleanup removes them. A log ID is never below its
   * commit time, so every record before the cutoff's own log ID has expired;
   * past it, at most HISTORY_TARGET_SCAN entries are read, and if none is
   * kept the last read is a target low enough. Undefined without a job.
   */
  historyTarget(now = this.clock.now()): number | undefined {
    this.ensureReady();
    if (!this.config.tiered) return undefined;
    return this.reserved({ reads: 24 + HISTORY_TARGET_SCAN }, true, now, () => {
      const maintenance = this.maintenanceRow();
      if (maintenance.cleanup_cursor === null || maintenance.cleanup_cutoff_ms === null) return undefined;
      const cutoff = maintenance.cleanup_cutoff_ms;
      const state = this.logState();
      const rows = this.rawRows<{ log_id: number; commit_ms: number }>(
        "SELECT log_id, commit_ms FROM records INDEXED BY records_log_idx WHERE log_id >= ? ORDER BY log_id LIMIT ?",
        Math.max(state.history_floor, cutoff), HISTORY_TARGET_SCAN,
      );
      const kept = rows.find((row) => integerColumn(row.commit_ms) >= cutoff);
      if (kept) return integerColumn(kept.log_id);
      if (rows.length === HISTORY_TARGET_SCAN) return integerColumn(rows[rows.length - 1].log_id);
      return state.last_log_id + 1;
    });
  }

  /**
   * Records from `from` on, oldest first: those of at most `limit` distinct
   * log IDs, every room's copy of each (HistoryHead.scan, for the copy down).
   */
  /** The most log IDs historyScan returns at once (HistoryTier.scanLimit): a copy gathers a larger batch over several scans. */
  readonly historyScanLimit = HISTORY_SCAN_BATCH;

  historyScan(from: number, limit = HISTORY_SCAN_BATCH, now = this.clock.now()): ChatRecord[] {
    this.ensureReady();
    const capped = Math.max(0, Math.min(limit, HISTORY_SCAN_BATCH));
    return this.reserved({ reads: 24 + 6 * capped }, true, now, () => this.rawRows<ChatRecord>(
      `SELECT room_id, log_id, commit_ms, kind, record_json FROM records WHERE log_id IN (
         SELECT DISTINCT log_id FROM records INDEXED BY records_log_idx WHERE log_id >= ? ORDER BY log_id LIMIT ?)
       ORDER BY log_id, room_id`, from, capped,
    ).map((row) => ({ ...row, log_id: integerColumn(row.log_id), commit_ms: integerColumn(row.commit_ms) })));
  }

  /**
   * The records of `roomIds` in a window, as HistoryTier.read gives them
   * (the first `limit` distinct log IDs nearest the page's start), outside
   * the history quota: for exports and the chain's own reads.
   */
  historyRecords(query: HistoryQuery, now = this.clock.now()): ChatRecord[] {
    this.ensureReady();
    const limit = Math.max(0, Math.min(query.limit, 1_000));
    if (!query.roomIds.length || query.lower > query.upper || !limit) return [];
    if (query.roomIds.length === 1) {
      // One room (exports page room by room): its own key range, a page at most.
      return this.reserved({ reads: 24 + limit + 1 }, true, now, () => this.rawRows<ChatRecord>(
        `SELECT room_id, log_id, commit_ms, kind, record_json FROM records
         WHERE room_id = ? AND log_id >= ? AND log_id <= ? ORDER BY log_id ${query.forward ? "ASC" : "DESC"} LIMIT ?`,
        query.roomIds[0], Math.max(query.lower, this.logState().history_floor), query.upper, limit,
      ).map((row) => ({ ...row, log_id: integerColumn(row.log_id), commit_ms: integerColumn(row.commit_ms) })));
    }
    return this.reserved({ reads: 24 + 4 * limit * Math.min(query.roomIds.length, 8) }, true, now, () => this.rawRows<ChatRecord>(
      `SELECT room_id, log_id, commit_ms, kind, record_json FROM records
       WHERE room_id IN (SELECT value FROM json_each(?)) AND log_id IN (
         SELECT DISTINCT log_id FROM records
         WHERE room_id IN (SELECT value FROM json_each(?)) AND log_id >= ? AND log_id <= ?
         ORDER BY log_id ${query.forward ? "ASC" : "DESC"} LIMIT ?)
       ORDER BY log_id ${query.forward ? "ASC" : "DESC"}`,
      JSON.stringify(query.roomIds), JSON.stringify(query.roomIds), Math.max(query.lower, this.logState().history_floor), query.upper, limit,
    ).map((row) => ({ ...row, log_id: integerColumn(row.log_id), commit_ms: integerColumn(row.commit_ms) })));
  }

  /** The records with these log IDs, any room (import's duplicate check). */
  historyLookup(logIds: readonly number[], now = this.clock.now()): ChatRecord[] {
    this.ensureReady();
    const ids = [...new Set(logIds)].slice(0, 1_000);
    if (!ids.length) return [];
    return this.reserved({ reads: 24 + 4 * ids.length }, true, now, () => this.rawRows<ChatRecord>(
      "SELECT room_id, log_id, commit_ms, kind, record_json FROM records WHERE log_id IN (SELECT value FROM json_each(?)) ORDER BY log_id, room_id",
      JSON.stringify(ids),
    ).map((row) => ({ ...row, log_id: integerColumn(row.log_id), commit_ms: integerColumn(row.commit_ms) })));
  }

  /**
   * The history chain's state, as plain values (src/history/state.ts keeps
   * its rules): values under `history:tier:`, `history:link:` and
   * `history:kept:` (at most MAX_KEPT_GROUPS read a call), the hot
   * and published floors, and the copy marker, which cleanup stops at
   * (runCleanup).
   */
  historyStatePort(): ChainStatePort {
    const owned = (key: string) => {
      if (!key.startsWith(META_HISTORY_TIER) && !key.startsWith(META_HISTORY_LINK) && !key.startsWith(META_HISTORY_KEPT)) throw new Error(`not a history chain state key: ${key}`);
      return key;
    };
    return {
      value: (key) => {
        this.ensureReady();
        return this.reserved({ reads: 4 }, true, this.clock.now(), () => this.metaValue(owned(key)) || undefined);
      },
      setValue: (key, value) => {
        this.ensureReady();
        if (!this.config.tiered) return;
        this.reserved({ reads: 4, writes: 4 }, true, this.clock.now(), () => this.writeMeta(owned(key), value));
      },
      hotFloor: () => this.historyFloors().hot,
      publishedFloor: () => this.historyFloors().published,
      copyMarker: () => {
        this.ensureReady();
        return this.reserved({ reads: 4 }, true, this.clock.now(), () => this.metaNumber(META_HISTORY_THROUGH));
      },
      raiseCopyMarker: (through) => {
        this.ensureReady();
        if (!this.config.tiered) return;
        this.reserved({ reads: 4, writes: 4 }, true, this.clock.now(), () => {
          if (through > this.metaNumber(META_HISTORY_THROUGH)) this.writeMeta(META_HISTORY_THROUGH, String(through));
        });
      },
      entries: (prefix) => {
        this.ensureReady();
        const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
        return this.reserved({ reads: 16 + MAX_KEPT_GROUPS }, true, this.clock.now(), () => this.rawRows<{ key: string; value: string }>(
          "SELECT key, value FROM _meta WHERE key >= ? AND key < ? ORDER BY key LIMIT ?", owned(prefix), end, MAX_KEPT_GROUPS,
        ).map((row) => [row.key, row.value] as [string, string]));
      },
    };
  }

  /**
   * Raises the published floor (HistoryHead.publish), never past the hot
   * floor: history starts there from now on. Rooms whose whole log is below
   * it go on the next cleanup, made due now.
   */
  publishHistoryFloor(floor: number, now = this.clock.now()): void {
    this.ensureReady();
    if (!this.config.tiered) return;
    this.reserved({ reads: 16, writes: 8 }, true, now, () => {
      const published = Math.min(floor, this.logState().history_floor);
      if (published <= this.publishedFloor()) return;
      this.writeMeta(META_HISTORY_PUBLISHED, String(published));
      this.publishedCache = published;
      this.writeMeta(META_HISTORY_ROOMS_DUE, "1");
      this.cleanupDueCache = undefined;
      this.rawExec("UPDATE maintenance SET next_cleanup_ms = MIN(next_cleanup_ms, ?) WHERE id = 1", this.effectiveNow(now));
    });
  }

  /** The `/purge` and `/rename` some link has yet to deliver, oldest first. */
  historyRewrites(now = this.clock.now()): QueuedRewrite[] {
    this.ensureReady();
    if (!this.config.tiered) return [];
    return this.reserved({ reads: 4 }, true, now, () => this.queuedRewrites());
  }

  /** The newest rewrite's number ever given (0: none), delivered or not. */
  historyRewritesLogged(now = this.clock.now()): number {
    this.ensureReady();
    return this.reserved({ reads: 4 }, true, now, () => this.metaNumber(META_HISTORY_OPS_SEQ));
  }

  private queuedRewrites(): QueuedRewrite[] {
    return this.metaJson(META_HISTORY_OPS, (value) => Array.isArray(value) ? value as QueuedRewrite[] : undefined, []);
  }

  /** Adds `messageIds` to queued purge `seq` (RewriteLog.amend): messages of its user a tier below found. */
  amendHistoryPurge(seq: number, messageIds: readonly string[], now = this.clock.now()): void {
    this.ensureReady();
    if (!messageIds.length) return;
    this.reserved({ reads: 4, writes: 4 }, true, now, () => {
      const next = this.queuedRewrites().map((entry) => entry.seq === seq && entry.rewrite.into === null ? { seq, rewrite: { ...entry.rewrite, messages: [...new Set([...(entry.rewrite.messages ?? []), ...messageIds])] } } : entry);
      this.writeMeta(META_HISTORY_OPS, JSON.stringify(next));
    });
  }

  /** Forgets the rewrites through `seq`, once every link delivered them. */
  dropHistoryRewrites(seq: number, now = this.clock.now()): void {
    this.ensureReady();
    this.reserved({ reads: 4, writes: 4 }, true, now, () => {
      const kept = this.queuedRewrites().filter((entry) => entry.seq > seq);
      this.writeMeta(META_HISTORY_OPS, kept.length ? JSON.stringify(kept) : null);
    });
  }

  /**
   * Deletes the hot log's reaction sets on `messageIds`, messages of purged
   * users that only a tier below held (a rewrite's `found`, chain.ts): /purge found no current
   * message for them, so their newer reaction records were left. Scans the
   * retained log for them, as /purge does.
   */
  dropReactionsOn(messageIds: readonly string[], now = this.clock.now()): void {
    this.ensureReady();
    if (!messageIds.length) return;
    const list = JSON.stringify([...new Set(messageIds)]);
    const records = this.retainedRecords(now, true);
    this.reserved({ reads: 64 + 2 * records, writes: 64 + 4 * records }, true, now, () => this.transaction(() => {
      const rows = this.rawRows<{ room_id: string; log_id: number }>(
        "SELECT room_id, log_id FROM records WHERE kind = 'reactions' AND json_extract(record_json, '$.message_id') IN (SELECT value FROM json_each(?))", list,
      );
      for (const row of rows) this.rewriteRecord(row, null);
      this.rawExec("DELETE FROM reaction_state WHERE message_id IN (SELECT value FROM json_each(?))", list);
    }), true);
  }

  /**
   * Whether `userId` is retired and may not be issued again:
   * `/rename` moved its account away (`renamed:`, for good), or `/purge` or
   * the idle prune removed it and it is not yet freed (`purged:`,
   * dueRetiredUserIds). An ID an identity holds now is not retired.
   */
  isRetiredUserId(userId: string, now = this.clock.now()): boolean {
    this.ensureReady();
    return this.reserved({ reads: 8 }, true, now, () => this.retiredUserId(userId));
  }

  private retiredUserId(userId: string): boolean {
    return this.metaValue(META_RENAMED_PREFIX + userId) !== "" || this.metaValue(META_PURGED_PREFIX + userId) !== "";
  }

  /**
   * Export: a room's current members (registered: guests' memberships are
   * not stored), in user ID order, at most `limit`, and how many it has in
   * all. Charged to maintenance.
   */
  exportMembers(roomId: string, limit: number, now = this.clock.now()): { members: string[]; count: number } {
    this.ensureReady();
    const max = Math.max(0, Math.floor(limit));
    return this.reserved({ reads: 8 + max }, true, now, () => {
      const members = max ? this.rawRows<{ user_id: string }>("SELECT user_id FROM memberships WHERE room_id = ? ORDER BY user_id LIMIT ?", roomId, max).map((row) => row.user_id) : [];
      // A full page may be truncated: the room row's count (one read) says how many there are.
      const count = members.length < max ? members.length : Math.max(members.length, integerColumn(this.rawRows<{ member_count: number }>("SELECT member_count FROM rooms WHERE room_id = ? LIMIT 1", roomId)[0]?.member_count));
      return { members, count };
    });
  }

  /**
   * Import: a new room's members as its listing gives them (the archive's
   * snapshot of current state when it was written; its membership records
   * are history): `join` are joined where they are not, with no membership
   * record made (as a membership is kept after its record leaves the log),
   * and `leave` (members the import's own records joined that a complete
   * listing leaves out) are removed. Joins only for identities here, within
   * MAX_MEMBERSHIPS_PER_USER, and in a private room within
   * maxPrivateMembershipsPerUser; the others are counted as `skipped`. At most RESTORE_ENTRIES_BATCH users a call;
   * charged to maintenance. Repeating a call changes nothing.
   */
  restoreMembers(roomId: string, changes: { join: readonly string[]; leave: readonly string[] }, now = this.clock.now()): { joined: number; left: number; skipped: number } {
    this.ensureReady();
    const size = changes.join.length + changes.leave.length;
    if (size > RESTORE_ENTRIES_BATCH) throw new StoreError("invalid_params", `At most ${RESTORE_ENTRIES_BATCH} members are restored a call`);
    const isPrivate = isPrivateRoomId(roomId);
    // Per join, the user's memberships counted against MAX_MEMBERSHIPS_PER_USER (and for a private room, their private rooms).
    const cost = { reads: 16 + 4 * size + changes.join.length * (MEMBERSHIP_COUNT_READS + (isPrivate ? this.userRoomsReads() : 0)), writes: 8 + 3 * size };
    return this.reserved(cost, true, now, () => this.transaction(() => {
      if (!this.roomRow(roomId)) throw new StoreError("invalid_params", `No room ${roomId} to restore members into`.slice(0, 200));
      const member = (userId: string) => this.rawRows("SELECT 1 FROM memberships WHERE room_id = ? AND user_id = ? LIMIT 1", roomId, userId).length > 0;
      let joined = 0;
      let left = 0;
      let skipped = 0;
      for (const userId of new Set(changes.join)) {
        if (member(userId)) continue;
        if (!this.identityRow(userId) || this.membershipCount(userId) >= MAX_MEMBERSHIPS_PER_USER ||
          (isPrivate && this.privateMembershipCount(userId) >= this.config.maxPrivateMembershipsPerUser)) {
          skipped += 1;
          continue;
        }
        this.rawExec("INSERT INTO memberships (room_id, user_id) VALUES (?, ?)", roomId, userId);
        joined += 1;
      }
      for (const userId of new Set(changes.leave)) {
        if (!member(userId)) continue;
        this.rawExec("DELETE FROM memberships WHERE room_id = ? AND user_id = ?", roomId, userId);
        this.rawExec("DELETE FROM read_cursors WHERE user_id = ? AND room_id = ?", userId, roomId);
        left += 1;
      }
      if (joined || left) this.rawExec("UPDATE rooms SET member_count = MAX(0, member_count + ?) WHERE room_id = ?", joined - left, roomId);
      return { joined, left, skipped };
    }));
  }

  /**
   * Import: makes each archived user that has no identity here
   * and whose ID is not retired a placeholder account, as
   * createInvitedIdentity makes an account without a credential: the
   * archive's name (else the user ID), its avatar if a plain `https:` URL,
   * its `ext` if it fits as a `me` write's would (else none), and the one
   * role `unclaimed` (UNCLAIMED_ROLE); the archive's roles are not imported,
   * as roles grant powers here. A placeholder joins no room by itself: its
   * memberships come with the rooms' records (restoreRoom) and listings
   * (restoreMembers). IDs a guest or
   * an owner's bot has, or that an admin could not issue, are skipped.
   * Each placeholder counts against registeredAccounts; a call that
   * would pass it is refused whole, before anything is written. At most
   * RESTORE_USERS_BATCH users a call; charged to maintenance, so a day's
   * exhausted budget refuses it with `retry_after`, and a retry skips what
   * an earlier call created. Returns the IDs created, in order.
   */
  restoreUsers(users: readonly ArchivedUser[], now = this.clock.now()): string[] {
    this.ensureReady();
    if (users.length > RESTORE_USERS_BATCH) throw new StoreError("invalid_params", `At most ${RESTORE_USERS_BATCH} users are restored a call`);
    const unique = new Map<string, ArchivedUser>();
    for (const user of users) if (restorableUserId(user?.user_id) && !unique.has(user.user_id)) unique.set(user.user_id, user);
    if (!unique.size) return [];
    this.ensureGrowthCapacity(unique.size * 2_048);
    // Per user, its identity row and two retired markers, then the row and its index pages written.
    return this.reserved({ reads: 32 + 8 * unique.size, writes: 16 + 8 * unique.size }, true, now, () => this.transaction(() => {
      const fresh = [...unique.values()].filter((user) => !this.identityRow(user.user_id) && !this.retiredUserId(user.user_id));
      if (!fresh.length) return [];
      const count = this.metaNumber("identity_count");
      if (count + fresh.length > this.config.registeredAccounts) {
        throw new StoreError("denied", `registration_closed: ${fresh.length} new users would pass this server's ${this.config.registeredAccounts} accounts (it has ${count})`.slice(0, 200));
      }
      const effective = this.effectiveNow(now);
      for (const user of fresh) {
        const avatar = restoredAvatar(user.avatar);
        const ext = isPlainObject(user.ext) ? clientUserExt(clone(user.ext)) : undefined;
        const kept = ext && Object.keys(ext).length && userExtFits(ext) ? ext : undefined;
        this.rawExec(
          `INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms, avatar_url, avatar_expires_ms, roles_json, ext_json)
           VALUES (?, '', ?, 'registered', ?, ?, ?, ?, ?, ?)`,
          user.user_id, this.restoredName(user), effective, effective,
          // An imported avatar is no upload of this server's, so nothing expires it.
          avatar ?? "", avatar ? MAX_SAFE_ID : 0, JSON.stringify([UNCLAIMED_ROLE]), kept ? JSON.stringify(kept) : "",
        );
      }
      this.adjustCount("identity_count", fresh.length);
      return fresh.map((user) => user.user_id);
    }));
  }

  /** An imported user's name: the archive's, if it is one this server takes, else the user ID, cut to the name limits. */
  private restoredName(user: ArchivedUser): string {
    const name = user.name;
    if (typeof name === "string" && name.trim() !== "" && utf8Bytes(name) <= this.config.maxNameBytes && [...name].length <= this.config.maxNameCodePoints) return name;
    const points = [...user.user_id].slice(0, this.config.maxNameCodePoints);
    while (utf8Bytes(points.join("")) > this.config.maxNameBytes) points.pop();
    return points.join("");
  }

  /**
   * Import: adds a room that is new here, with the
   * records of it that belong in this SQLite (the hot log), and rebuilds the
   * current state they give, as if they had been committed here.
   *
   * The first call creates the room row: its parent from the listing or its
   * room record, its creation at the lowest of the listing's `log_id` and
   * `history_log_id` and the records' log IDs (so history reads every record
   * restored, here or in the tiers below), its record and fields from its
   * latest room record or else the listing, and its head at the greatest log
   * ID known; a room with no records here (all in the tiers below) is made
   * from its listing alone. It counts against the server's caps as a room
   * created by `room_set` does (maxThreads and the created top-level rooms,
   * or maxPrivateRooms), and a thread's parent must be a public top-level
   * room here already; a cap passed refuses the call.
   *
   * A room that exists is merged into: so a room's records may come over
   * several calls, each at most RESTORE_RECORDS_BATCH records and
   * RESTORE_ENTRIES_BATCH reaction sets and members, and a call repeated
   * stores nothing twice (records are keyed by room and log ID) and changes
   * nothing. Deciding which rooms are new is the importer's (`hasRoom`
   * before the first call): this never refuses an existing room, but it
   * does refuse one whose listing names another parent.
   *
   * Every record must be at or above the hot floor and, with tiers below,
   * past the copy marker (`through`), or the call is refused: older records
   * go to the tiers below. The new records are stored, and the
   * state of every message, reaction set and membership they name is
   * replayed from them and the room's later records (@apron/archive's
   * replayRecords, the one definition of what a record does to current
   * state; this writes the rows it yields): each message's state
   * points at its latest snapshot, unless another author's message holds
   * its ID, or one in a room this import does not add (`options.rooms`, the
   * rooms it adds besides this one), or the snapshot names such a room (a
   * collision the planner nudges away; skipped here, with its reaction
   * sets, and counted as `collided`); each user's latest reaction set
   * stands, an empty one removing theirs; and each user's latest membership
   * stands, joins only for users who have an identity here (and room in
   * their private rooms, for a private room). A room's records should come
   * oldest first; new records older than ones already stored make it read
   * the stored ones after them again, at most RESTORE_REPLAY_CAP, past
   * which the call is refused. The log head is raised to the greatest log
   * ID and commit time restored, so later commits take greater IDs; never
   * by the listing, whose `latest_log_id` counts only up to the log head.
   * A record or listing log ID more than five minutes past the clock
   * refuses the call (it would hold back every later commit), and a record
   * no client could have sent (restorableRecord) is dropped and counted as
   * `rejected`; the others are stored as restorableRecord gives them.
   *
   * Charged to maintenance, so a day's exhausted budget refuses a call with
   * `retry_after`, to be repeated later.
   */
  restoreRoom(room: ArchivedRoom, records: readonly ChatRecord[], now = this.clock.now(), options: { rooms?: readonly string[] } = {}): { created: boolean; stored: number; collided?: number; rejected?: number; membersSkipped?: number } {
    this.ensureReady();
    const listing = room?.listing;
    const roomId = listing?.room_id;
    if (!isProtocolId(roomId) || utf8Bytes(roomId) > 256) throw new StoreError("invalid_params", "A restored room needs a valid room_id");
    if (records.length > RESTORE_RECORDS_BATCH) throw new StoreError("invalid_params", `At most ${RESTORE_RECORDS_BATCH} records are restored a call`);
    // Log IDs past the clock would hold back every later commit: refused, as the importer refuses them.
    const horizon = now + RESTORE_FUTURE_MS;
    for (const value of [listing.log_id, listing.history_log_id]) {
      const logId = parseLogId(value);
      if (logId !== undefined && logId > horizon) throw new StoreError("invalid_params", `The listing of ${roomId} names log ID ${logId}, later than this server's clock`.slice(0, 200));
    }
    const checked = records.map((record) => restoredRecord(roomId, record));
    const late = checked.find((record) => record.log_id > horizon || record.commit_ms > horizon);
    if (late) throw new StoreError("invalid_params", `Record ${late.log_id} of ${roomId} is later than this server's clock`.slice(0, 200));
    // Only what a client could have sent (content.record, as a post is checked): anything else is dropped and counted.
    let rejected = 0;
    const batch = checked.flatMap((record) => {
      const normalized = this.content.record({ room_id: roomId, log_id: record.log_id, commit_ms: record.commit_ms, kind: record.kind, record_json: record.record_json });
      if (!normalized.ok) {
        rejected += 1;
        return [];
      }
      return normalized.value.record_json === record.record_json ? [record] : [restoredRecord(roomId, normalized.value)];
    }).sort((a, b) => a.log_id - b.log_id);
    // The rooms a message here may already be in and still be this one: this room, and the others this import adds.
    const importRooms = new Set([roomId, ...(options.rooms ?? [])]);
    if (batch.some((record, index) => index > 0 && record.log_id === batch[index - 1].log_id)) throw new StoreError("invalid_params", "Two restored records share a log_id");
    // One record alone may hold more (an archive its writer compacted folds a room's memberships into one), up to RESTORE_ENTRIES_SINGLE.
    const entries = batch.reduce((sum, record) => sum + restoredEntries(record), 0);
    if (entries > (batch.length === 1 ? RESTORE_ENTRIES_SINGLE : RESTORE_ENTRIES_BATCH)) {
      throw new StoreError("invalid_params", `A call restores at most ${RESTORE_ENTRIES_BATCH} reaction sets and members, or one record of at most ${RESTORE_ENTRIES_SINGLE}`);
    }
    const listingLog = parseLogId(listing.log_id);
    const listingLatest = parseLogId(listing.latest_log_id);
    const listingHistory = parseLogId(listing.history_log_id);
    const listingParent = typeof listing.parent_room_id === "string" ? listing.parent_room_id : undefined;
    // First the reads: the floors, which records are stored already, and,
    // when new ones are older than the room's newest, the stored ones after
    // them, from which their state is replayed.
    const probe = this.reserved({ reads: 48 + 4 * batch.length + 2 * (RESTORE_REPLAY_CAP + 1) }, true, now, () => {
      const state = this.logState();
      const through = this.config.tiered ? this.metaNumber(META_HISTORY_THROUGH) : 0;
      const below = batch.find((record) => record.log_id < state.history_floor || record.log_id <= through);
      if (below) {
        throw new StoreError("invalid_params", `Record ${below.log_id} is older than this server's hot history (from ${Math.max(state.history_floor, through + 1)}): it belongs in a tier below`.slice(0, 200));
      }
      const stored = new Set(batch.length ? this.rawRows<{ log_id: number }>(
        "SELECT log_id FROM records WHERE room_id = ? AND log_id IN (SELECT value FROM json_each(?))", roomId, JSON.stringify(batch.map((record) => record.log_id)),
      ).map((row) => integerColumn(row.log_id)) : []);
      const fresh = batch.filter((record) => !stored.has(record.log_id));
      const newest = integerColumn(this.rawRows<{ log_id: number }>("SELECT log_id FROM records WHERE room_id = ? ORDER BY log_id DESC LIMIT 1", roomId)[0]?.log_id);
      if (!fresh.length || fresh[0].log_id > newest) return { fresh, replay: [] as RestoredRecord[] };
      const rows = this.rawRows<ChatRecord>(
        "SELECT room_id, log_id, commit_ms, kind, record_json FROM records WHERE room_id = ? AND log_id > ? ORDER BY log_id LIMIT ?",
        roomId, fresh[0].log_id, RESTORE_REPLAY_CAP + 1,
      );
      if (rows.length > RESTORE_REPLAY_CAP) throw new StoreError("invalid_params", "Too many of the room's records are newer than these: restore a room's records oldest first");
      const replay = rows.map((row): ChatRecord => ({
        room_id: roomId, log_id: integerColumn(row.log_id), commit_ms: integerColumn(row.commit_ms), kind: row.kind, record_json: row.record_json,
      }));
      return { fresh, replay };
    });
    const { fresh } = probe;
    // The current state the room's records give (@apron/archive's replay):
    // each message's latest snapshot, each user's latest reaction set on each
    // message (an empty one removing it), each user's latest membership
    // change, and the latest room record. Only rows it names are written.
    const replayed = replayRecords([...fresh, ...probe.replay]);
    const latestRoom = replayed.rooms.get(roomId);
    const memberships = replayed.memberships.get(roomId) ?? new Map<string, ReplayedMembership>();
    const reactionSets = [...replayed.reactionSets].flatMap(([messageId, sets]) => [...sets].map(([userId, set]) => ({ messageId, userId, ...set })));
    const isPrivate = isPrivateRoomId(roomId);
    // The users the new records name, whose retired markers they raise (noteRetiredRelog).
    const named = new Set<string>();
    for (const record of fresh) {
      const value = record.value;
      if (record.kind === "message") named.add((value.from as Identity).user_id);
      for (const set of record.kind === "reactions" ? value.reactions as Array<{ from: Identity }> : []) named.add(set.from.user_id);
      for (const member of record.kind === "membership" ? value.members as Array<{ user: Identity }> : []) named.add(member.user.user_id);
    }
    const keys = replayed.messages.size + reactionSets.length + memberships.size;
    // The room row, its parent, the caps and the rooms' fields total; per
    // record its row and index entry; per message, reaction set and member
    // its state row read and written (a member's identity too, and for a
    // private room their private rooms); and the log head.
    const cost = {
      reads: 128 + EMPTY_ROOM_SCAN + this.roomFieldsTotalReads + MAX_CREATED_ROOMS + this.roomCountReads + 4 * fresh.length + 8 * keys + 4 * named.size +
        memberships.size * (MEMBERSHIP_COUNT_READS + (isPrivate ? this.userRoomsReads() : 0)),
      writes: 64 + 6 * fresh.length + 8 * keys + 2 * named.size,
    };
    if (fresh.length) this.ensureGrowthCapacity(2 * fresh.reduce((sum, record) => sum + utf8Bytes(record.record_json), 0) + 1_024);
    return this.reserved(cost, true, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      let row = this.roomRow(roomId);
      const created = row === null;
      if (!row) {
        const parentRoomId = listingParent ?? (typeof latestRoom?.fields.parent_room_id === "string" ? latestRoom.fields.parent_room_id : null);
        const known = [listingLog, listingHistory, batch[0]?.log_id].filter((logId): logId is number => logId !== undefined);
        if (!known.length) throw new StoreError("invalid_params", "A restored room needs records or its listing's log_id");
        const createdLogId = Math.min(...known);
        const recordLogId = Math.max(createdLogId, listingLog ?? 0, latestRoom?.log_id ?? 0);
        const fields = latestRoom && latestRoom.log_id >= (listingLog ?? 0) ? roomClientFields(latestRoom.fields) : roomClientFields(listing);
        // A room created before roomCreationWindowMs takes no slot: the caps
        // count the rooms started within it (roomSlotFree).
        const old = createdLogId < this.creationCutoff(effective);
        const slot = (kind: "public" | "private"): boolean => old || this.roomSlotFree(kind, effective);
        if (isPrivate) {
          if (parentRoomId !== null) throw new StoreError("invalid_params", "A private room cannot be a thread on this server");
          if (this.config.maxPrivateRooms === 0) throw new StoreError("unsupported", "Private rooms are not supported on this server");
          if (!slot("private")) throw new StoreError("denied", this.privateRoomLimitMessage());
        } else {
          if (parentRoomId !== null) {
            const parent = this.roomRow(parentRoomId);
            if (!parent || parent.parent_room_id !== null || isPrivateRoomId(parent.room_id)) {
              throw new StoreError("invalid_params", `A thread's parent must be a public top-level room here: restore ${parentRoomId} first`.slice(0, 200));
            }
          } else if (this.rawRows(`SELECT room_id FROM rooms WHERE ${roomKind(0)} LIMIT ?`, MAX_CREATED_ROOMS + 1).length > MAX_CREATED_ROOMS) {
            throw new StoreError("denied", "room_limit");
          }
          if (!slot("public")) throw new StoreError("denied", "thread_limit");
        }
        this.checkRoomFields(fields);
        this.checkRoomFieldsTotal(fields);
        const createdMs = batch.length ? Math.min(...batch.map((record) => record.commit_ms)) : effective;
        row = {
          room_id: roomId, parent_room_id: parentRoomId, created_log_id: createdLogId, record_log_id: recordLogId, latest_log_id: recordLogId,
          fields_json: JSON.stringify(fields), created_ms: createdMs, updated_ms: effective, member_count: 0,
        };
        this.rawExec(
          `INSERT INTO rooms (${ROOM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          row.room_id, row.parent_room_id, row.created_log_id, row.record_log_id, row.latest_log_id, row.fields_json, row.created_ms, row.updated_ms,
        );
        this.adjustCount(isPrivate ? "private_count" : "thread_count", 1);
      } else {
        if (listingParent !== undefined && listingParent !== row.parent_room_id) throw new StoreError("invalid_params", `The room ${roomId} here has another parent`.slice(0, 200));
        // The latest room record among the new ones alone: the replay above also reads the room's own records.
        const imported = fresh.some((record) => record.kind === "room") ? replayRecords(fresh).rooms.get(roomId) : undefined;
        const own = imported && imported.log_id < row.record_log_id ? this.emptyRoomOwnRecord(row) : undefined;
        if (imported && own !== undefined) {
          // An empty room the import fills (a fresh server's `general`): the
          // archive's room record stands for it, and the room's own, which
          // says only what a new server made, goes. Kept, it would be the
          // room's latest record, and a round trip would add one each time.
          const fields = roomClientFields(imported.fields);
          this.checkRoomFields(fields);
          this.rawExec("DELETE FROM records WHERE room_id = ? AND log_id = ? AND kind = 'room'", roomId, own);
          // Its head is what is left of it (joins after it), raised below by the records restored.
          const left = integerColumn(this.rawRows<{ latest: number }>("SELECT COALESCE(MAX(log_id), 0) AS latest FROM records WHERE room_id = ?", roomId)[0]?.latest);
          this.rawExec("UPDATE rooms SET latest_log_id = ? WHERE room_id = ?", left, roomId);
          const creator = storedCreator(row.fields_json);
          row = { ...row, latest_log_id: left, record_log_id: imported.log_id, fields_json: JSON.stringify(creator === undefined ? fields : { ...fields, creator_id: creator }) };
        } else if (latestRoom && latestRoom.log_id >= row.record_log_id) {
          const fields = roomClientFields(latestRoom.fields);
          this.checkRoomFields(fields);
          // The client fields are replaced; a creator kept beside them stays.
          const creator = storedCreator(row.fields_json);
          row = { ...row, record_log_id: latestRoom.log_id, fields_json: JSON.stringify(creator === undefined ? fields : { ...fields, creator_id: creator }) };
        }
      }
      for (const record of fresh) {
        this.rawExec(
          "INSERT OR IGNORE INTO records (room_id, log_id, commit_ms, kind, record_json) VALUES (?, ?, ?, ?, ?)",
          roomId, record.log_id, record.commit_ms, record.kind, record.record_json,
        );
      }
      // Messages: the latest snapshot, unless the state row is newer or another message's.
      const collided = new Set<string>();
      for (const [messageId, message] of replayed.messages) {
        // Where the message is now: the room its snapshot names (a move's copy
        // in the room it left names where it went), if that is a room this
        // import adds; never a room here the import does not add.
        if (!importRooms.has(message.room_id)) {
          collided.add(messageId);
          continue;
        }
        const existing = this.rawRows<{ room_id: string; latest_log_id: number; author_id: string }>(
          "SELECT room_id, latest_log_id, author_id FROM message_state WHERE message_id = ? LIMIT 1", messageId,
        )[0];
        if (existing) {
          // The same message only in this room or another this import adds, by
          // the same author; anything else is another message here.
          if (existing.author_id !== message.from.user_id || !importRooms.has(existing.room_id)) {
            collided.add(messageId);
            continue;
          }
          if (integerColumn(existing.latest_log_id) >= message.log_id) continue;
        }
        this.rawExec(
          `INSERT INTO message_state (message_id, room_id, latest_log_id, author_id) VALUES (?, ?, ?, ?)
           ON CONFLICT (message_id) DO UPDATE SET room_id = excluded.room_id, latest_log_id = excluded.latest_log_id`,
          messageId, message.room_id, message.log_id, message.from.user_id,
        );
      }
      // Reaction sets: the latest of each user on each message, unless the state row is newer.
      for (const set of reactionSets) {
        if (collided.has(set.messageId)) continue;
        const existing = this.rawRows<{ log_id: number }>(
          "SELECT log_id FROM reaction_state WHERE message_id = ? AND user_id = ? LIMIT 1", set.messageId, set.userId,
        )[0];
        const storedLogId = existing ? integerColumn(existing.log_id) : undefined;
        if (set.emojis.length) {
          if (storedLogId !== undefined && storedLogId > set.log_id) continue;
          this.rawExec(
            `INSERT INTO reaction_state (message_id, user_id, log_id, from_json, emojis_json) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (message_id, user_id) DO UPDATE SET
               log_id = excluded.log_id, from_json = excluded.from_json, emojis_json = excluded.emojis_json`,
            set.messageId, set.userId, set.log_id, JSON.stringify(set.from), JSON.stringify(set.emojis),
          );
        } else if (storedLogId !== undefined && storedLogId < set.log_id) {
          this.rawExec("DELETE FROM reaction_state WHERE message_id = ? AND user_id = ?", set.messageId, set.userId);
        }
      }
      // Memberships: each user's latest change, joins only for identities
      // here, within MAX_MEMBERSHIPS_PER_USER and the private-room cap (those
      // two counted as `membersSkipped`).
      let members = 0;
      let membersSkipped = 0;
      for (const [userId, { joined }] of memberships) {
        const member = this.rawRows("SELECT 1 FROM memberships WHERE room_id = ? AND user_id = ? LIMIT 1", roomId, userId).length > 0;
        if (joined && !member) {
          if (!this.identityRow(userId)) continue;
          if (this.membershipCount(userId) >= MAX_MEMBERSHIPS_PER_USER ||
            (isPrivate && this.privateMembershipCount(userId) >= this.config.maxPrivateMembershipsPerUser)) {
            membersSkipped += 1;
            continue;
          }
          this.rawExec("INSERT INTO memberships (room_id, user_id) VALUES (?, ?)", roomId, userId);
          members += 1;
        } else if (!joined && member) {
          this.rawExec("DELETE FROM memberships WHERE room_id = ? AND user_id = ?", roomId, userId);
          this.rawExec("DELETE FROM read_cursors WHERE user_id = ? AND room_id = ?", userId, roomId);
          members -= 1;
        }
      }
      const newest = fresh.length ? fresh[fresh.length - 1].log_id : 0;
      // A listing's head counts only as far as records known here reach: the
      // log head, raised below by the records stored, never by a listing.
      const state = this.logState();
      const known = Math.max(state.last_log_id, newest);
      const latest = Math.max(row.latest_log_id, newest, Math.min(listingLatest ?? 0, known));
      const createdLogId = fresh.length ? Math.min(row.created_log_id, fresh[0].log_id) : row.created_log_id;
      this.rawExec(
        "UPDATE rooms SET created_log_id = ?, record_log_id = ?, latest_log_id = MAX(latest_log_id, ?), fields_json = ?, member_count = MAX(0, member_count + ?), updated_ms = ? WHERE room_id = ?",
        createdLogId, row.record_log_id, latest, row.fields_json, members, effective, roomId,
      );
      if (fresh.length) this.noteRetiredRelog([...named], newest);
      // The log head: later commits take greater log IDs than any record restored.
      const commitMs = fresh.reduce((max, record) => Math.max(max, record.commit_ms), 0);
      if (newest > state.last_log_id || commitMs > state.last_commit_ms) {
        this.rawExec("UPDATE log_state SET last_log_id = MAX(last_log_id, ?), last_commit_ms = MAX(last_commit_ms, ?) WHERE id = 1", newest, commitMs);
        this.logCache = { ...state, last_log_id: Math.max(state.last_log_id, newest), last_commit_ms: Math.max(state.last_commit_ms, commitMs) };
      }
      return { created, stored: fresh.length, ...(collided.size ? { collided: collided.size } : {}), ...(rejected ? { rejected } : {}), ...(membersSkipped ? { membersSkipped } : {}) };
    }));
  }

  /**
   * A cold tier's chunk index (ChunkIndex), in this SQLite: one row a chunk
   * in `history_chunks`, keyed by tier name and the chunk's first log ID,
   * created on first use. The rows are read once a wake (a chunk holds
   * about 10,000 log IDs, so they are few) and kept in memory (this object
   * is the only writer); each read and write is charged to maintenance.
   */
  chunkIndex(tier: string): ChunkIndex {
    const prepare = () => {
      this.ensureReady();
      if (this.chunkTableReady) return;
      this.reserved({ reads: 8, writes: 8 }, true, this.clock.now(), () => {
        this.rawExec("CREATE TABLE IF NOT EXISTS history_chunks (tier TEXT NOT NULL, first INTEGER NOT NULL, ref TEXT NOT NULL, PRIMARY KEY (tier, first)) WITHOUT ROWID");
      });
      this.chunkTableReady = true;
    };
    const loaded = (): Map<number, ChunkRef> => {
      const cached = this.chunkIndexes.get(tier);
      if (cached) return cached;
      prepare();
      // Charged for the rows there are: a count first, then the rows.
      const count = this.reserved({ reads: 24 }, true, this.clock.now(), () => Number(this.rawRows<{ count: number }>("SELECT COUNT(*) AS count FROM history_chunks WHERE tier = ?", tier)[0]?.count ?? 0));
      const rows = this.reserved({ reads: 24 + count }, true, this.clock.now(), () => this.rawRows<{ first: number; ref: string }>("SELECT first, ref FROM history_chunks WHERE tier = ?", tier));
      const refs = new Map(rows.map((row) => [Number(row.first), JSON.parse(row.ref) as ChunkRef]));
      this.chunkIndexes.set(tier, refs);
      return refs;
    };
    return {
      list: async () => [...loaded().values()].map((ref) => ({ ...ref })),
      update: async ({ put = [], remove = [] }) => {
        const refs = loaded();
        this.reserved({ reads: 8 + put.length + remove.length, writes: 2 * (put.length + remove.length) }, true, this.clock.now(), () => {
          for (const first of remove) this.rawExec("DELETE FROM history_chunks WHERE tier = ? AND first = ?", tier, first);
          for (const ref of put) this.rawExec("INSERT OR REPLACE INTO history_chunks (tier, first, ref) VALUES (?, ?, ?)", tier, ref.first, JSON.stringify(ref));
        });
        for (const first of remove) refs.delete(first);
        for (const ref of put) refs.set(ref.first, { ...ref });
      },
    };
  }

  /** A backup schedule's number in `_meta` (a key under `history:export:`), 0 when absent. */
  historyMetaNumber(key: string, now = this.clock.now()): number {
    this.ensureReady();
    if (!key.startsWith(META_HISTORY_EXPORT)) throw new Error(`not a history export key: ${key}`);
    return this.reserved({ reads: 4 }, true, now, () => this.metaNumber(key));
  }

  /** The running import's journal (`history:import`, RestorePort.journal): what a retry needs to finish it. */
  historyImportJournal(now = this.clock.now()): string | undefined {
    this.ensureReady();
    return this.reserved({ reads: 4 }, true, now, () => this.metaValue(META_HISTORY_IMPORT) || undefined);
  }

  /** Writes or clears the running import's journal (its size is the importer's to bound: MAX_JOURNAL_BYTES). */
  setHistoryImportJournal(value: string | null, now = this.clock.now()): void {
    this.ensureReady();
    this.reserved({ reads: 4, writes: 4 + Math.ceil((value?.length ?? 0) / 4_096) }, true, now, () => this.writeMeta(META_HISTORY_IMPORT, value));
  }

  /** How far the running import's writes got (`history:import_progress`, RestorePort.progress): a small JSON value. */
  historyImportProgress(now = this.clock.now()): string | undefined {
    this.ensureReady();
    return this.reserved({ reads: 4 }, true, now, () => this.metaValue(META_HISTORY_IMPORT_PROGRESS) || undefined);
  }

  /** Writes or clears the running import's progress. */
  setHistoryImportProgress(value: string | null, now = this.clock.now()): void {
    this.ensureReady();
    this.reserved({ reads: 4, writes: 4 }, true, now, () => this.writeMeta(META_HISTORY_IMPORT_PROGRESS, value));
  }

  /**
   * Whether a room exists with nothing logged past its creation: the seeded
   * `general` of a new server, which an import may fill (restoreRoom merges).
   */
  roomIsEmpty(roomId: string, now = this.clock.now()): boolean {
    this.ensureReady();
    return this.reserved({ reads: 8 + EMPTY_ROOM_SCAN }, true, now, () => {
      const room = this.rawRows<{ created_log_id: number; latest_log_id: number }>("SELECT created_log_id, latest_log_id FROM rooms WHERE room_id = ? LIMIT 1", roomId)[0];
      if (room === undefined) return false;
      if (integerColumn(room.latest_log_id) <= integerColumn(room.created_log_id)) return true;
      // Joins and leaves alone leave it empty: the admin who runs the import
      // joined `general` by signing in. Only the first EMPTY_ROOM_SCAN records
      // past its creation are looked at; a room with more is taken as in use.
      const later = this.rawRows<{ kind: string }>("SELECT kind FROM records WHERE room_id = ? AND log_id > ? ORDER BY log_id LIMIT ?", roomId, integerColumn(room.created_log_id), EMPTY_ROOM_SCAN);
      return later.length < EMPTY_ROOM_SCAN && later.every((row) => row.kind === "membership");
    });
  }

  /**
   * The log ID of an empty room's own room record, which an import filling
   * the room replaces (restoreRoom): the room's creation is its only room
   * record and nothing but joins and leaves follows it (as roomIsEmpty), and
   * it is not yet copied below (past the copy marker), so no tier below
   * holds a copy. Undefined otherwise.
   */
  private emptyRoomOwnRecord(row: RawRoomRow): number | undefined {
    const created = integerColumn(row.created_log_id);
    if (integerColumn(row.record_log_id) !== created) return undefined;
    if (this.config.tiered && created <= this.metaNumber(META_HISTORY_THROUGH)) return undefined;
    const own = this.rawRows<{ kind: string }>("SELECT kind FROM records WHERE room_id = ? AND log_id = ? LIMIT 1", row.room_id, created)[0];
    if (own?.kind !== "room") return undefined;
    const later = this.rawRows<{ kind: string }>("SELECT kind FROM records WHERE room_id = ? AND log_id > ? ORDER BY log_id LIMIT ?", row.room_id, created, EMPTY_ROOM_SCAN);
    return later.length < EMPTY_ROOM_SCAN && later.every((record) => record.kind === "membership") ? created : undefined;
  }

  /** Writes a backup schedule's value in `_meta` (a key under `history:export:`), or removes it for null. */
  setHistoryMeta(key: string, value: string | null, now = this.clock.now()): void {
    this.ensureReady();
    if (!key.startsWith(META_HISTORY_EXPORT)) throw new Error(`not a history export key: ${key}`);
    this.reserved({ reads: 4, writes: 4 }, true, now, () => this.writeMeta(key, value));
  }

  /**
   * Queues what a `/purge` or `/rename` did here for the links to deliver
   * down the chain (historyRewrites), within the operation's transaction,
   * numbered in order. A full log refuses the operation: the links must
   * catch up first.
   */
  private queueHistoryRewrites(rewrites: readonly Rewrite[]): void {
    if (!this.config.tiered || !rewrites.length) return;
    const queued = this.queuedRewrites();
    if (queued.length + rewrites.length > MAX_HISTORY_REWRITES) throw new StoreError("retry_after", "older history has yet to catch up with earlier changes");
    let seq = this.metaNumber(META_HISTORY_OPS_SEQ);
    const added = rewrites.map((rewrite) => ({ seq: (seq += 1), rewrite }));
    this.writeMeta(META_HISTORY_OPS_SEQ, String(seq));
    this.writeMeta(META_HISTORY_OPS, JSON.stringify([...queued, ...added]));
  }

  private identityRow(userId: string): RawIdentityRow | null {
    const rows = this.rawRows<RawIdentityRow>(
      "SELECT user_id, user_handle, name, tier, created_ms, updated_ms, avatar_url, avatar_expires_ms, roles_json, ext_json, seen_ms FROM identities WHERE user_id = ? LIMIT 1",
      userId,
    );
    return rows[0] ?? null;
  }

  /**
   * A registered user's joined rooms, oldest room first: the MAX_USER_ROOMS
   * newest by room_id, read in the user index's own order, so however many
   * rooms the user is in (rooms are kept for good) the read stops there.
   * Room IDs order the private rooms (a user is in at most
   * maxPrivateMembershipsPerUser) and `general` before the others, which are
   * log IDs: the newest rooms by creation. The user's top-level rooms (at
   * most MAX_CREATED_ROOMS + 1, the oldest IDs) are always among them, read
   * apart from the kind index, and so is `include`, a room just joined
   * however old: a connection is delivered to the rooms listed here. An
   * older thread is still theirs, read by its room_id. The join with `rooms`
   * hides memberships of removed rooms awaiting purge. At most
   * MAX_LISTED_USER_ROOMS.
   */
  private userRooms(userId: string, include?: string): string[] {
    const rows = this.rawRows<{ room_id: string; created_log_id: number }>(
      `SELECT m.room_id AS room_id, r.created_log_id AS created_log_id FROM memberships m INDEXED BY memberships_user_idx
       JOIN rooms r ON r.room_id = m.room_id
       WHERE m.user_id = ? ORDER BY m.room_id DESC LIMIT ?`,
      userId, MAX_USER_ROOMS,
    );
    // The top-level rooms by the kind index, each looked up in memberships by its key.
    rows.push(...this.rawRows<{ room_id: string; created_log_id: number }>(
      `SELECT t.room_id AS room_id, t.created_log_id AS created_log_id FROM (
         SELECT room_id, created_log_id FROM rooms WHERE ${roomKind(0)} LIMIT ?
       ) t JOIN memberships m ON m.room_id = t.room_id AND m.user_id = ?`,
      MAX_CREATED_ROOMS + 1, userId,
    ));
    if (include !== undefined) {
      rows.push(...this.rawRows<{ room_id: string; created_log_id: number }>(
        `SELECT r.room_id AS room_id, r.created_log_id AS created_log_id FROM memberships m
         JOIN rooms r ON r.room_id = m.room_id WHERE m.room_id = ? AND m.user_id = ? LIMIT 1`,
        include, userId,
      ));
    }
    const rooms = new Map(rows.map((row) => [row.room_id, integerColumn(row.created_log_id)]));
    return [...rooms].sort((a, b) => a[1] - b[1]).map(([roomId]) => roomId);
  }

  /**
   * Reads for userRooms(): at most MAX_USER_ROOMS of the user's membership
   * rows, and those awaiting purge it passes on the way, each an index entry
   * and a room lookup (measured: three reads a row); the top-level rooms,
   * each an index entry and a membership lookup; and a room just joined.
   */
  private userRoomsReads(): number {
    return 16 + 3 * (MAX_USER_ROOMS + MAX_PURGE_ROOMS) + 3 * (MAX_CREATED_ROOMS + 1);
  }

  /** Whether an identity has this `user_id` now, one indexed read. */
  identityExists(userId: string): boolean {
    this.ensureReady();
    return this.reserved({ reads: 4 }, false, this.clock.now(), () => this.identityRow(userId) !== null);
  }

  /**
   * Whether a `user_id` may not be issued: an identity has it, `/rename`
   * retired it, or `/purge` or the idle prune retired it and it is not yet
   * freed (dueRetiredUserIds). Registration picks ids with it.
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
    const found = this.reserved({ reads: 64 + 8 * records + 2 * (MAX_PUSH_SUBSCRIPTIONS_PER_USER + MAX_PUSH_WAKES_PER_USER + 1 + MAX_ROOM_MUTES_PER_USER) + 2 * (this.roomRowCount() + MAX_PURGE_ROOMS) }, false, now, () => {
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
    const membershipRows = MAX_MEMBERSHIP_ROWS;
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
      this.queueHistoryRewrites([{ user: from, into: to }]);
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
      this.writeMeta(META_RENAMED_PREFIX + from, to);
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
   * user's day is `uploadsPerUserDay`, and their live texts' starts, each of
   * which may keep a terminal's output. The server's own avatar uploads
   * (SERVER_OWNER) are charged to the admins who start them, so only the
   * server-wide `uploadsPerDay` bounds them. A scan of an owner's rows by
   * `uploads_owner_idx` reads up to this many, whatever its other conditions
   * and LIMIT, since the index holds only `owner_id`.
   */
  private uploadsPerOwner(owner: string): number {
    const policy = this.config.uploads;
    if (!policy) return 0;
    // A user's finished terminals may each keep their output as a file too (storeTerminalOutput).
    const perDay = owner === SERVER_OWNER ? policy.uploadsPerDay : policy.uploadsPerUserDay + (this.config.liveText?.startsPerUserDay ?? 0);
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
   * `user_id` is retired (META_PURGED_PREFIX) until history has expired past
   * the log head, and with it anything that named it; sessions carry the user handle
   * they were issued under, so none carries over to a later account.
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
    const perUser = 64 + 8 * MAX_MEMBERSHIP_ROWS + 4 * Math.max(this.config.registeredPostsPerDay, this.config.trustedPostsPerDay) + 4 * uploadsPerOwner +
      4 * (MAX_PUSH_SUBSCRIPTIONS_PER_USER + MAX_PUSH_WAKES_PER_USER + 1 + MAX_ROOM_MUTES_PER_USER);
    // Every room row is read for its creator, and each one theirs rewritten.
    const roomRows = this.roomRowCount() + MAX_PURGE_ROOMS;
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
      // The tiers below do the same to what they hold, as the links deliver it (src/history/chain.ts).
      this.queueHistoryRewrites(ids.map((user) => ({ user, into: null, messages })));
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
        this.adjustCount("principal_limit_count", -limiters);
      }
      for (const id of ids) this.limiters.dropPrincipal(`user:${id}`);
      for (const userId of retired) this.writeMeta(META_PURGED_PREFIX + userId, String(this.logState().last_log_id));
      if (identities) this.adjustCount("identity_count", -identities);
      return { messages: messages.length, reactions: integerColumn(reactions), deletedUploads };
    }), true);
  }

  /**
   * Records that a user signed in (a passkey, a session resume, a token),
   * at most once per ACTIVITY_GRANULARITY_MS: the identity's `updated_ms`,
   * which the idle prune reads as activity whether or not user status keeps
   * `seen`. One conditional row update; never throws.
   */
  noteActive(userId: string, now = this.clock.now()): void {
    try {
      this.ensureReady();
      this.reserved({ reads: 4, writes: 4 }, false, now, () => {
        const effective = this.effectiveNow(now);
        this.rawExec("UPDATE identities SET updated_ms = ? WHERE user_id = ? AND updated_ms < ? AND updated_ms > 0", effective, userId, effective - ACTIVITY_GRANULARITY_MS);
      });
    } catch { /* a refused or failed write only leaves the day unrecorded */ }
  }

  /**
   * Removes up to IDLE_PRUNE_BATCH registered accounts inactive for
   * `idleAccountMs` (lastActiveSql: created, profile change or sign-in,
   * departure, passkey use, or their bot's activity), least recently active
   * first, in at most IDLE_PRUNE_RUNS_PER_DAY runs a UTC day, and none until
   * activity has been recorded for `idleAccountMs` (META_IDLE_ACTIVITY_SINCE). It never removes one of the `keptActiveAccounts`
   * most recently active, one with a role (admins, mods, friends), the admin
   * user, one `connected` now or whose bot is, one whose bot holds a role
   * of its own, or one with a live upload (its avatar or
   * files expire first). With each goes its bot. It removes their identity,
   * passkeys, memberships (lowering their rooms' member counts), read
   * cursors, status, mutes, push subscriptions and wakes, dedup and limiter
   * rows, and their rooms' creator; each `user_id` is retired until history
   * has expired past the log head (dueRetiredUserIds). What they posted
   * stays in history, under the name it was posted with, until it expires
   * like anything else. Maintenance work: it measures the rows first,
   * then reserves them, and a refusal leaves the rest for a later run.
   * Returns the removed ids (bots included), and whether more may remain.
   */
  pruneIdleIdentities(now = this.clock.now(), connected: ReadonlySet<string> = new Set()): { pruned: string[]; more: boolean } {
    this.ensureReady();
    const today = dayFor(now);
    // Today's runs (one batch each) and whether the day is done: at most
    // IDLE_PRUNE_RUNS_PER_DAY, so a backlog spreads over days rather than
    // spending the day's maintenance reads on scans.
    // Another day's record, or none readable, is a day afresh.
    const progress = (): { day: string; runs: number; done: boolean } => this.metaJson(META_IDLE_PRUNE_DAY, (stored) => {
      const value = stored as { day?: unknown; runs?: unknown; done?: unknown };
      return value.day === today ? { day: today, runs: integerColumn(value.runs), done: value.done === true } : undefined;
    }, { day: today, runs: 0, done: false });
    const state = this.reserved({ reads: 8, writes: 4 }, true, now, () => {
      const since = Number(this.metaValue(META_IDLE_ACTIVITY_SINCE));
      if (!Number.isFinite(since) || since <= 0) {
        this.writeMeta(META_IDLE_ACTIVITY_SINCE, String(now));
        return { ...progress(), waiting: true };
      }
      return { ...progress(), waiting: now - since < this.config.idleAccountMs };
    }, false);
    if (state.waiting || state.done || state.runs >= IDLE_PRUNE_RUNS_PER_DAY) return { pruned: [], more: false };
    const record = (done: boolean) => this.reserved({ reads: 4, writes: 4 }, true, now, () => {
      const current = progress();
      this.writeMeta(META_IDLE_PRUNE_DAY,
        JSON.stringify({ day: today, runs: current.runs + 1, done: done || current.runs + 1 >= IDLE_PRUNE_RUNS_PER_DAY }));
    }, false);
    const cutoff = now - this.config.idleAccountMs;
    // Ranking reads every identity twice, each with its passkeys and a bot
    // lookup; bots and the admin are identities beyond the cap.
    const perIdentity = 2 * (3 + MAX_PASSKEYS_PER_USER);
    const found = this.reserved({ reads: 64 + perIdentity * (2 * this.config.registeredAccounts + 1) + 16 * IDLE_PRUNE_BATCH }, true, now, () => {
      const candidates = this.rawRows<{ user_id: string }>(
        `SELECT i.user_id FROM identities i
         WHERE i.roles_json = '[]' AND i.user_id != ? AND ${lastActiveSql("i")} < ?
           AND NOT EXISTS (SELECT 1 FROM uploads u INDEXED BY uploads_owner_idx WHERE u.owner_id = i.user_id)
           AND NOT EXISTS (SELECT 1 FROM identities b WHERE b.user_id = '${BOT_PREFIX}' || i.user_id AND b.roles_json != '["bot"]')
           AND i.user_id NOT IN (SELECT k.user_id FROM identities k WHERE k.roles_json = '[]' ORDER BY ${lastActiveSql("k")} DESC LIMIT ?)
         ORDER BY ${lastActiveSql("i")} LIMIT ?`,
        ADMIN_USER_ID, cutoff, this.config.keptActiveAccounts, IDLE_PRUNE_BATCH + connected.size,
      ).map((row) => row.user_id)
        // Never one connected now, nor the owner of a bot connected now.
        .filter((id) => !connected.has(id) && !connected.has(BOT_PREFIX + id))
        .slice(0, IDLE_PRUNE_BATCH);
      if (!candidates.length) return { ids: [] as string[], rows: 0, full: false };
      // Every list is bound as one JSON parameter: SQLite takes at most 100.
      const bots = this.rawRows<{ user_id: string }>(
        "SELECT user_id FROM identities WHERE user_id IN (SELECT value FROM json_each(?))",
        JSON.stringify(candidates.map((id) => BOT_PREFIX + id)),
      ).map((row) => row.user_id);
      const ids = [...candidates, ...bots];
      const list = JSON.stringify(ids);
      let rows = 0;
      for (const table of ["memberships", "read_cursors", "credentials", "push_subscriptions", "push_wakes", "user_status", "room_mutes", "accepted_requests"]) {
        rows += integerColumn(this.rawRows<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id IN (SELECT value FROM json_each(?))`, list)[0]?.count);
      }
      return { ids, rows, full: candidates.length === IDLE_PRUNE_BATCH };
    }, false);
    if (!found.ids.length) {
      record(true);
      return { pruned: [], more: false };
    }
    const ids = found.ids;
    const list = JSON.stringify(ids);
    // Each row deleted (and its index entries), the rooms rescanned for counts
    // and creators, limiter rows, and the identity rows and their markers.
    const limiterRows = ids.length * USER_LIMIT_SCOPES.length;
    const roomRows = this.roomRowCount() + MAX_PURGE_ROOMS;
    const cost = {
      reads: 64 + 2 * found.rows + 2 * roomRows + 2 * limiterRows + 4 * ids.length,
      writes: 64 + 4 * found.rows + 2 * roomRows + 2 * limiterRows + 8 * ids.length,
    };
    try {
      this.reserved(cost, true, now, () => this.transaction(() => {
        this.rawExec(
          `UPDATE rooms SET member_count = MAX(0, member_count - (SELECT COUNT(*) FROM memberships m WHERE m.room_id = rooms.room_id AND m.user_id IN (SELECT value FROM json_each(?))))
           WHERE room_id IN (SELECT room_id FROM memberships INDEXED BY memberships_user_idx WHERE user_id IN (SELECT value FROM json_each(?)))`,
          list, list,
        );
        this.rawExec("UPDATE rooms SET fields_json = json_remove(fields_json, '$.creator_id') WHERE json_extract(fields_json, '$.creator_id') IN (SELECT value FROM json_each(?))", list);
        for (const table of ["memberships", "read_cursors", "credentials", "push_subscriptions", "push_wakes", "user_status", "room_mutes", "accepted_requests", "identities"]) {
          this.rawExec(`DELETE FROM ${table} WHERE user_id IN (SELECT value FROM json_each(?))`, list);
        }
        const limiterWhere = `scope IN (${USER_LIMIT_SCOPES.map(() => "?").join(", ")}) AND principal_key IN (SELECT value FROM json_each(?))`;
        const limiterKeys = [...USER_LIMIT_SCOPES, JSON.stringify(ids.map((id) => `user:${id}`))];
        const limiters = integerColumn(this.rawRows<{ count: number }>(`SELECT COUNT(*) AS count FROM principal_limits WHERE ${limiterWhere}`, ...limiterKeys)[0]?.count);
        if (limiters) {
          this.rawExec(`DELETE FROM principal_limits WHERE ${limiterWhere}`, ...limiterKeys);
          this.adjustCount("principal_limit_count", -limiters);
        }
        for (const id of ids) this.limiters.dropPrincipal(`user:${id}`);
        for (const id of ids) this.writeMeta(META_PURGED_PREFIX + id, String(this.logState().last_log_id));
        this.adjustCount("identity_count", -ids.length);
        const day = dayFor(now);
        const previous = this.idlePrunedRaw();
        const counts = { day, today: (previous.day === day ? previous.today : 0) + ids.length, total: previous.total + ids.length };
        this.writeMeta(META_IDLE_PRUNED, JSON.stringify(counts));
      }), false);
    } catch (error) {
      // A batch the day's budget refuses would be refused at every hourly
      // retry, each rescanning every identity: the day is done instead.
      if (error instanceof StoreError && error.code === "retry_after") {
        try { record(true); } catch { /* retried in an hour */ }
        return { pruned: [], more: false };
      }
      throw error;
    }
    console.log(JSON.stringify({ event: "idle_accounts_pruned", count: ids.length }));
    // Committed: a failure to record progress only means one more run.
    try { record(!found.full); } catch { /* counted again next time */ }
    return { pruned: ids, more: found.full };
  }

  private idlePrunedRaw(): { day: string; today: number; total: number } {
    return this.metaJson(META_IDLE_PRUNED, (stored) => {
      const value = stored as { day?: unknown; today?: unknown; total?: unknown };
      return { day: typeof value.day === "string" ? value.day : "", today: integerColumn(value.today), total: integerColumn(value.total) };
    }, { day: "", today: 0, total: 0 });
  }

  /** Idle accounts pruned today and in all (pruneIdleIdentities), for `/status`: charged, never refused. */
  idlePruned(now = this.clock.now()): { today: number; total: number } {
    this.ensureReady();
    return this.alert(() => this.reserved({ reads: 4 }, false, now, () => {
      const record = this.idlePrunedRaw();
      return { today: record.day === dayFor(now) ? record.today : 0, total: record.total };
    }, true));
  }

  /**
   * The `user_id`s retired (`purged:<id>`, by `/purge` or the idle prune)
   * whose marker the history floor has passed, by RETIRED_MARKER_MARGIN, or
   * every one once the whole log has expired, at most RETIRED_SWEEP_BATCH:
   * nothing retained names them, so they may be freed. The log is the
   * clock: an id stays retired until the history that might name it is gone,
   * however long that takes. A marker from before markers kept their time
   * (`1`) starts at the log head. The caller revokes every token of each (and
   * of its bot) before freeRetiredUserIds frees it, so no token of the old
   * account can sign in to a new one under the id.
   */
  dueRetiredUserIds(now = this.clock.now()): string[] {
    this.ensureReady();
    const end = META_PURGED_PREFIX.slice(0, -1) + ";";
    return this.reserved({ reads: 16 + 4 * this.config.registeredAccounts, writes: 8 + 4 * RETIRED_SWEEP_BATCH }, true, now, () => this.transaction(() => {
      const state = this.logState();
      const legacy = this.rawRows<{ key: string }>(
        "SELECT key FROM _meta WHERE key >= ? AND key < ? AND CAST(value AS INTEGER) <= 1 LIMIT ?", META_PURGED_PREFIX, end, RETIRED_SWEEP_BATCH,
      );
      for (const row of legacy) this.rawExec("UPDATE _meta SET value = ? WHERE key = ?", String(state.last_log_id), row.key);
      // The published floor: records in the tiers below may still name them.
      const floor = this.publishedFloor();
      const below = floor > state.last_log_id ? Number.MAX_SAFE_INTEGER : floor - RETIRED_MARKER_MARGIN;
      return this.rawRows<{ key: string }>(
        "SELECT key FROM _meta WHERE key >= ? AND key < ? AND CAST(value AS INTEGER) > 1 AND CAST(value AS INTEGER) < ? ORDER BY CAST(value AS INTEGER) LIMIT ?",
        META_PURGED_PREFIX, end, below, RETIRED_SWEEP_BATCH,
      ).map((row) => row.key.slice(META_PURGED_PREFIX.length));
    }), false);
  }

  /**
   * Raises to `logId` the marker of each retired id in `userIds`: a move or
   * an editor's save has logged what they left again, so the id stays retired
   * until that record expires too. One read a user; a write for each retired.
   */
  private noteRetiredRelog(userIds: readonly string[], logId: number): void {
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    this.rawExec(
      "UPDATE _meta SET value = ? WHERE key IN (SELECT ? || value FROM json_each(?)) AND CAST(value AS INTEGER) < ?",
      String(logId), META_PURGED_PREFIX, JSON.stringify(ids), logId,
    );
  }

  /** Frees retired `user_id`s (dueRetiredUserIds), their tokens revoked: they may be issued again. */
  freeRetiredUserIds(userIds: readonly string[], now = this.clock.now()): void {
    if (!userIds.length) return;
    this.ensureReady();
    this.reserved({ reads: 8 + 2 * userIds.length, writes: 8 + 4 * userIds.length }, true, now, () => {
      this.rawExec("DELETE FROM _meta WHERE key IN (SELECT ? || value FROM json_each(?))", META_PURGED_PREFIX, JSON.stringify(userIds));
    }, false);
  }

  /**
   * Clears mutes that ran out: an account's (`user_status`, deleted when
   * nothing else is left in it) and its rooms' (`room_mutes`). Otherwise
   * they stay until the user mutes again. Returns the rows changed.
   */
  clearExpiredMutes(now = this.clock.now()): number {
    this.ensureReady();
    const cap = this.config.registeredAccounts;
    return this.reserved({ reads: 16 + 2 * cap + 2 * MAX_ROOM_MUTES_PER_USER * 64, writes: 16 + 4 * 1_000 }, true, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      let changed = 0;
      changed += this.rawExec("UPDATE user_status SET mute_until_ms = NULL WHERE user_id IN (SELECT user_id FROM user_status WHERE mute_until_ms IS NOT NULL AND mute_until_ms <= ? LIMIT 1000)", effective).rowsWritten ?? 0;
      changed += this.rawExec("DELETE FROM user_status WHERE user_id IN (SELECT user_id FROM user_status WHERE status = 'online' AND mute_until_ms IS NULL LIMIT 1000)").rowsWritten ?? 0;
      changed += this.rawExec("DELETE FROM room_mutes WHERE (user_id, room_id) IN (SELECT user_id, room_id FROM room_mutes WHERE mute_until_ms <= ? LIMIT 1000)", effective).rowsWritten ?? 0;
      return changed;
    }), false);
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
        createdMs: integerColumn(row.created_ms),
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
    const ids = [...new Set(roomIds)].slice(0, this.listedRoomBound);
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
        if (this.memberCache.size > 2 * this.listedRoomBound) this.memberCache.clear();
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

  /** The accounts in use and the most there may be (registeredAccounts): an import's placeholders must fit (restoreUsers). */
  /**
   * Import (planning): why there is no room here for these new rooms, or
   * undefined. The same caps restoreRoom checks room by room, for all of
   * them at once, so an import past one is refused before it writes: the
   * private rooms (maxPrivateRooms), the public top-level rooms
   * (MAX_CREATED_ROOMS), the public rooms in all (maxThreads), and a
   * thread's parent, a public top-level room here or among them.
   */
  restoreRoomCapacity(listings: readonly RoomListing[], now = this.clock.now()): string | undefined {
    this.ensureReady();
    return this.reserved({ reads: 24 + MAX_CREATED_ROOMS + listings.length + 2 * this.roomCountReads }, true, now, () => {
      const privates = listings.filter((listing) => isPrivateRoomId(listing.room_id));
      const publics = listings.filter((listing) => !isPrivateRoomId(listing.room_id));
      const topLevel = publics.filter((listing) => typeof listing.parent_room_id !== "string");
      // A room created before roomCreationWindowMs takes no slot (restoreRoom):
      // its creation is the lowest of its listing's log_id and history_log_id,
      // and of its records, which planning has not read, so without the
      // listing's it counts: the import never finds a cap mid-write.
      const cutoff = this.creationCutoff(now);
      const recent = (listing: RoomListing): boolean => {
        const known = [parseLogId(listing.log_id), parseLogId(listing.history_log_id)].filter((logId): logId is number => logId !== undefined);
        return !known.length || Math.min(...known) >= cutoff;
      };
      if (privates.length) {
        if (this.config.maxPrivateRooms === 0) return "this archive has private rooms, and private rooms are not supported on this server";
        const used = this.recentRoomCount("private", now);
        const adding = privates.filter(recent).length;
        if (used + adding > this.config.maxPrivateRooms) return `this archive would add ${adding} recently created private rooms, but there is room for ${Math.max(0, this.config.maxPrivateRooms - used)} more (${used} of ${this.config.maxPrivateRooms})`;
      }
      if (topLevel.length) {
        const used = this.rawRows(`SELECT room_id FROM rooms WHERE ${roomKind(0)} LIMIT ?`, MAX_CREATED_ROOMS + 2).length;
        // restoreRoom refuses a top-level room once more than MAX_CREATED_ROOMS are here before it.
        if (used + topLevel.length - 1 > MAX_CREATED_ROOMS) return `this archive would add ${topLevel.length} top-level rooms, but there is room for ${Math.max(0, MAX_CREATED_ROOMS + 1 - used)} more (room_limit)`;
      }
      if (publics.length) {
        const used = this.recentRoomCount("public", now);
        const adding = publics.filter(recent).length;
        if (used + adding > this.config.maxThreads) return `this archive would add ${adding} recently created public rooms and threads, but there is room for ${Math.max(0, this.config.maxThreads - used)} more (thread_limit, ${used} of ${this.config.maxThreads})`;
      }
      const newTop = new Set(topLevel.map((listing) => listing.room_id));
      for (const listing of publics) {
        const parent = listing.parent_room_id;
        if (typeof parent !== "string" || newTop.has(parent)) continue;
        const row = this.roomRow(parent);
        if (!row || row.parent_room_id !== null || isPrivateRoomId(row.room_id)) return `thread ${listing.room_id}'s parent ${parent} is neither a public top-level room here nor in this archive`.slice(0, 200);
      }
      return undefined;
    });
  }

  accountCapacity(now = this.clock.now()): { used: number; limit: number } {
    this.ensureReady();
    return this.reserved({ reads: 8 }, true, now, () => ({ used: this.metaNumber("identity_count"), limit: this.config.registeredAccounts }));
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
    this.adjustCount("principal_limit_count", 1);
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
        : { minute: this.config.guestPostsPerMinute, day: this.config.guestPostsPerDay };
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
      const count = dayCount(row, "posts_day", daily);
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
      const dailyCount = dayCount(row, "posts_day", daily) + weight;
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
    const count = dayCount(row, "posts_day", day);
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
      this.writeMeta(META_GUEST_NUMBER_MARK, String(mark + count));
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
        const globalCount = dayCount(global, "posts_day", day);
        // An admin's frames (alert) are counted but never refused, so `/status` answers on a spent day.
        if (!this.alerting && globalCount + count > this.config.processedFramesPerDay) {
          throw new StoreError("retry_after", "Daily frame budget exhausted", { retryAfterMs: Math.max(1_000, 86_400_000 - effective % 86_400_000), data: { reason: "frame_budget" } });
        }
        this.updateLimitRow(global, { day, posts_day: globalCount + count }, effective);
      });
    });
  }

  private chargeRegistration(ipKey: string, now: number): void {
    const day = dayFor(now);
    const ip = this.limitRow("registration", `ip:${ipKey}`, now);
    const global = this.limitRow("registration", "global", now);
    const ipCount = dayCount(ip, "registrations_day", day);
    const globalCount = dayCount(global, "registrations_day", day);
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
    // The starting rooms (a guest's, carried over), at most what a
    // connection's attachment carries (MAX_LISTED_USER_ROOMS), and reserved
    // for by how many there are. Each is looked up by its key in the rooms
    // table (2 reads), and one that exists is joined: a membership row and a
    // logged membership record (2 reads, 6 writes). Measured at exactly that
    // (test/accounting.integration.test.ts); reserved at 6 reads and 8 writes
    // a room, with the identity and credential rows besides.
    const starting = [...new Set(input.rooms ?? DEFAULT_JOINED_ROOMS)].slice(0, MAX_LISTED_USER_ROOMS);
    const reservation = this.reserveCost({ reads: 128 + 6 * starting.length, writes: 64 + 8 * starting.length, registrations: 1 }, false, input.now);
    try {
      if (!input.userId || !input.userHandle || !input.ipKey) throw new StoreError("invalid_params", "registration identity is incomplete");
      ensureText(input.name, "name", this.config.maxNameBytes);
      if ([...input.name].length > this.config.maxNameCodePoints) throw new StoreError("too_large", "name is too long");
      ensureText(credential.credentialId, "credential_id", 16 * 1024);
      ensureText(credential.publicKey, "public_key", 16 * 1024);
      if (this.identityRow(input.userId)) throw new StoreError("invalid_params", "identity already exists");
      if (this.credentialValue(credential.credentialId)) throw new StoreError("denied", "credential is already registered");
      if (this.metaNumber("identity_count") >= this.config.registeredAccounts) {
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
        if (this.metaNumber("identity_count") >= this.config.registeredAccounts) throw new StoreError("denied", "registration_closed");
        this.chargeRegistration(input.ipKey, effective);
        const joined = this.existingRooms(starting);
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
        this.adjustCount("identity_count", 1);
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
        const admissions = dayCount(global, "posts_day", day);
        // Until the UTC day ends, when the counts reset.
        const untilReset = Math.max(1_000, 86_400_000 - now % 86_400_000);
        if (admissions >= this.config.connectionAdmissionsPerDay) throw new StoreError("retry_after", "Connection admission limit reached", { retryAfterMs: untilReset });
        this.updateLimitRow(global, { day, posts_day: admissions + 1 }, now);
        // Live connection caps are authoritative in ctx.getWebSockets(), which
        // includes closing sockets and survives object hibernation.  Durable
        // open counters become stale after a lost close and can permanently
        // deny admission, so only the durable admission/day and frame budget
        // controls are maintained here.
        const frames = this.limitRow("frames", "global", now);
        const frameCount = dayCount(frames, "posts_day", day);
        if (frameCount >= this.config.processedFramesPerDay) {
          throw new StoreError("retry_after", "Daily frame budget exhausted", { retryAfterMs: untilReset, data: { reason: "frame_budget" } });
        }
      });
    });
  }

  /**
   * Writes one `_meta` value, or removes its row for `null`: every plain
   * `_meta` write goes through here. (A value a refusal must leave behind is
   * a SettledMeta instead, written by persistSettled.)
   */
  private writeMeta(key: string, value: string | null): void {
    if (value === null) this.rawExec("DELETE FROM _meta WHERE key = ?", key);
    else this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", key, value);
  }

  /**
   * Adds `delta` to one of the denormalised counts (MetaCount), never below
   * 0, writing the row back if it is missing (an operator's edit): every
   * change to a count goes through here, so each is kept the same way, and
   * a missing row reads, and is rewritten, as 0 plus the change.
   */
  private adjustCount(key: MetaCount, delta: number): number {
    const next = Math.max(0, this.metaNumber(key) + delta);
    this.writeMeta(key, String(next));
    return next;
  }

  /**
   * A JSON `_meta` record, as `decode` makes it from what parses: one that
   * is absent, does not parse, or that `decode` refuses (returning
   * undefined, or throwing) reads as `fallback`. Every JSON record in
   * `_meta` is read through here, so none can throw on a bad row.
   */
  private metaJson<T>(key: string, decode: (value: unknown) => T | undefined, fallback: T): T {
    const raw = this.metaValue(key);
    if (!raw) return fallback;
    try {
      const value = JSON.parse(raw) as unknown;
      return value !== null && typeof value === "object" ? decode(value) ?? fallback : fallback;
    } catch {
      return fallback;
    }
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
    this.cleanupDueCache = cleanupSchedule(rows[0]);
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
   * An embed of a message still retained, for a write that ends in its
   * message (an upload's, a live text's) to rewrite (rewriteEmbed): the
   * message's current snapshot, unless it is deleted or below the
   * retention floor, and its embed `embedId`. A message cleanup has
   * expired but not yet deleted is gone here too: rewriting it would
   * append a fresh record and make it current again.
   */
  private retainedEmbed(messageId: string, embedId: string): { message: RawMessageRow; snapshot: MessageSnapshot; embed: Record<string, unknown> } | null {
    const message = this.currentMessage(messageId, this.logState().history_floor);
    const snapshot = message ? parseJson<MessageSnapshot>(message.snapshot_json) : null;
    if (!message || !snapshot || snapshot.deleted || !Array.isArray(snapshot.body?.embeds)) return null;
    const embed = (snapshot.body.embeds as Record<string, unknown>[]).find((candidate) => candidate.embed_id === embedId);
    return embed ? { message, snapshot, embed } : null;
  }

  /**
   * A current message `userId` may see: currentMessage, less one in a
   * private room they are not in, which reads as unknown (§5.3).
   */
  private visibleMessage(messageId: string, userId: string, floor?: number): RawMessageRow | null {
    const row = this.currentMessage(messageId, floor);
    return row && isPrivateRoomId(row.room_id) && !this.isMember(row.room_id, userId) ? null : row;
  }

  /**
   * Whether a user may move others' messages, from the identity row: a
   * registered user with a moderator role (MODERATOR_ROLES), or an owner's
   * bot with one it acts on (BOT_MODERATOR_ROLES).
   */
  private isModerator(userId: string): boolean {
    const identity = this.identityRow(userId);
    if (!identity) return false;
    const roles = identity.tier === "registered" ? MODERATOR_ROLES : identity.tier === "bot" ? BOT_MODERATOR_ROLES : [];
    return parseRoles(identity.roles_json).some((role) => roles.includes(role));
  }

  /**
   * Whether a registered user holds any role, from the identity row: only an
   * admin gives roles, so this is who posts under the trusted limits
   * (chargePosting). `friend` is the role that grants that alone, for
   * someone an admin trusts without moderating powers. An owner's bot (tier
   * `bot`) never counts, nor does `unclaimed` (UNCLAIMED_ROLE): an import
   * gives it, not an admin.
   */
  private holdsAnyRole(userId: string): boolean {
    const identity = this.identityRow(userId);
    return identity?.tier === "registered" && parseRoles(identity.roles_json).some((role) => role !== UNCLAIMED_ROLE);
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
      `SELECT room_id FROM rooms WHERE ${roomKind(0)} ORDER BY created_log_id ASC LIMIT ?`, MAX_CREATED_ROOMS + 1,
    ).map((row) => row.room_id));
  }

  private identityForMessage(input: StoreMutationInput): Identity {
    const name = typeof input.identity.name === "string" ? input.identity.name : undefined;
    return { user_id: input.identity.user_id, ...(name ? { name } : {}) };
  }

  /** A new message with no text and no embeds, which is neither logged nor broadcast (§3.5). */
  private emptyNewMessage(params: Record<string, unknown>): boolean {
    if (params.message_id !== undefined || (params.deleted !== undefined && params.deleted !== false) || !isPlainObject(params.body)) return false;
    return isEmptyBody(must(this.content.body(params.body)));
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
      // A bot, an owner's or one made by `/role … bot`, owns no bot of its own.
      if (!owner || owner.tier !== "registered" || parseRoles(owner.roles_json).includes("bot")) throw new StoreError("denied", "Only registered users may invite a bot");
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
      this.writeMeta(META_BOT_SWEEP, String(next));
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
      if (!alerting && this.metaNumber("identity_count") >= this.config.registeredAccounts) throw new StoreError("denied", "registration_closed");
      if (!alerting) this.ensureGrowthCapacity(this.config.maxSnapshotBytes);
      const effective = this.effectiveNow(input.now);
      return this.transaction(() => {
        if (this.identityRow(input.userId)) throw new StoreError("invalid_params", "identity already exists");
        if (!alerting && this.metaNumber("identity_count") >= this.config.registeredAccounts) throw new StoreError("denied", "registration_closed");
        if (!alerting) this.chargeRegistration(input.ipKey, effective);
        this.rawExec(
          "INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms, roles_json) VALUES (?, '', ?, ?, ?, ?, ?)",
          input.userId, input.name, input.tier, effective, effective, JSON.stringify(input.roles ?? []),
        );
        this.adjustCount("identity_count", 1);
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
   * A key lookup each; a private room is never among them, as nobody starts
   * in one (only a member adds others).
   */
  private existingRooms(ids: readonly string[]): string[] {
    const wanted = [...new Set(ids)];
    const known = new Set(this.rawRows<{ room_id: string }>(`SELECT room_id FROM rooms WHERE ${PUBLIC_ROOMS} AND room_id IN (SELECT value FROM json_each(?))`, JSON.stringify(wanted)).map((row) => row.room_id));
    return wanted.filter((id) => known.has(id));
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
    // A join also counts the user's memberships against MAX_MEMBERSHIPS_PER_USER.
    const reserved = this.reserveCost({ reads: 64 + (privateJoin ? 2 : 1) * this.userRoomsReads() + (input.join ? MEMBERSHIP_COUNT_READS : 0), writes: 64, posts: 1 }, false, operationNow);
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
        if (member === input.join) return { rooms: this.userRooms(input.userId, input.join ? input.roomId : undefined), changed: false };
        if (privateJoin && this.privateMembershipCount(input.userId) >= this.config.maxPrivateMembershipsPerUser) {
          throw new StoreError("denied", `${input.userId} is in as many private rooms as anyone may be, so cannot be added to another`.slice(0, 200));
        }
        if (input.join && this.membershipCount(input.userId) >= MAX_MEMBERSHIPS_PER_USER) throw new StoreError("denied", MEMBERSHIP_LIMIT_MESSAGE);
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
        const record = this.roomRecord(updated, this.publishedFloor());
        const rooms = this.userRooms(input.userId, input.join ? input.roomId : undefined);
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
      this.adjustCount(isPrivate ? "private_count" : "thread_count", -1);
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
    const previous = current ? parseJson<MessageSnapshot>(current.snapshot_json) : null;
    // A save of someone else's message in its own room may change only the
    // text that its sender shares with the users it mentions (ext:editors).
    const editor = current !== null && current.author_id !== input.userId && current.room_id === roomId && sharesText(previous!, input.userId);
    if (editor) {
      if (params.deleted !== undefined && params.deleted !== false) throw new StoreError("denied", "Only the original author may delete this message");
      // Live text is still writing into body.text (§4.8.5).
      if (hasAppend(previous!)) throw new StoreError("denied", "The message's text is still being written");
    }
    // Someone else's message may otherwise only be moved, and only by a moderator (MODERATOR_ROLES, BOT_MODERATOR_ROLES).
    const moving = current !== null && current.author_id !== input.userId && !editor;
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
    // An editor's save keeps the reply.
    const replyId = editor ? previous!.reply_to?.message_id : this.messageReference(params.reply_to, "reply_to", floor, {
      viewer: input.userId,
      roomId,
      ...(typeof messageIdParam === "string" ? { self: messageIdParam } : {}),
      ...(previous?.reply_to ? { unchanged: previous.reply_to.message_id } : {}),
    });
    let body: Record<string, unknown> | undefined;
    if (!deleted) {
      if (params.body === undefined) throw new StoreError("invalid_params", "message body is required");
      // An editor's save keeps every other field of the body.
      body = editor ? must(this.content.sharedText(previous!.body, params.body)) : must(this.content.body(params.body));
      // Emptied, a message whose last embed then fails or ends with nothing is a tombstone (rewriteEmbed): only its sender deletes it.
      if (editor && body.text === "") throw new StoreError("invalid_params", "Only the sender may empty this message's text");
      if (isEmptyBody(body as MessageBody)) throw new StoreError("invalid_params", "message cannot be empty");
    }
    // A save merges `ext` into the current snapshot's (§4.13); a tombstone carries none (§4.4),
    // so a creation, or a save of a tombstone, merges into an empty `ext`.
    // An editor's save keeps ext too, and edited_by names who saved a
    // snapshot when not its sender (ext:editors); requests do not set it.
    // A moderator's move changes no content, so it keeps the edited_by of the text it moves.
    const write = editor ? undefined : this.optionalExt(params.ext);
    const merged = deleted ? undefined : mergeExt(previous?.ext, write);
    const ext = moving ? merged : withEditedBy(merged, editor ? input.userId : undefined);
    const from = previous ? previous.from : this.identityForMessage(input);
    if (!from || typeof from.user_id !== "string") throw new StoreError("internal_error", "message author is missing");

    const logId = this.allocateLogId(context);
    const messageId = previous ? previous.message_id : idString(logId);
    let uploads: PendingUpload[] = [];
    let deletedUploads: string[] = [];
    let writes: Record<string, unknown>[] = [];
    let liveStarted: LiveEntry[] = [];
    let liveEnded: string[] = [];
    // An editor's save keeps the embeds as they are stored: it starts no upload or live text, and releases none (ext:editors).
    if ((this.config.uploads || this.config.liveText) && !editor) {
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
    must(this.content.snapshot(snapshot));
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
    const relogged: string[] = [];
    let relogLogId = logId;
    if (editor || moving) {
      relogged.push(from.user_id);
      const editedBy = isPlainObject(ext?.editors) ? (ext.editors as Record<string, unknown>).edited_by : undefined;
      if (typeof editedBy === "string") relogged.push(editedBy);
    }
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
        relogged.push(...rows.map((row) => row.user_id));
        relogLogId = reactionLogId;
      }
    }
    // Someone else's content logged again names its author, its last
    // editor and, moved, its reactors, any of whom may have been removed
    // since: their ids stay retired until these records expire too.
    if (relogged.length) this.noteRetiredRelog(relogged, relogLogId);
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
          // The server owns `url`, `output`, and a terminal's `og` (§4.8.1, §4.8.2); a terminal takes a new title.
          const { title: _title, og: _og, ...owned } = before;
          void _title;
          void _og;
          if (before.kind !== "terminal") return owned;
          const title = uploadTitle(fields.title);
          return { ...owned, ...(title ? { title } : {}), og: terminalOg(title) };
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
          ...(kind === "terminal" ? { og: terminalOg(title) } : {}),
        };
      }
      if (fields.kind !== "upload" || !this.config.uploads) return { embed_id: id, ...fields };
      const upload = this.startUpload("file", userId, now, { messageId, embedId: id });
      uploads.push(upload);
      writes.push(uploadResultEmbed(upload));
      const title = uploadTitle(fields.title);
      return { embed_id: id, kind: "upload", ...(title ? { title } : {}) };
    });
    // An upload's file, or a finished terminal's output kept in R2 (storeTerminalOutput).
    const removed = [...earlier.values()]
      .filter((embed) => (embed.kind === "upload" || embed.output_ref !== undefined) && !kept.has(embed.embed_id as string))
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
    this.assertNotDegraded("Uploading", now);
    // The server's avatar is an avatar in size.
    const maxBytes = purpose === "file" ? policy.maxFileBytes : purpose === "emoji" ? policy.maxEmojiBytes : policy.maxAvatarBytes;
    const day = dayFor(now);
    const rows = [this.limitRow("upload", `user:${userId}`, now), this.limitRow("upload", "global", now)];
    const counts = rows.map((row) => dayCount(row, "uploads_day", day));
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

  /**
   * Records a terminal's output stored in R2 (publishLiveText) as an attached
   * file of its message and embed: written, kept `fileRetentionSeconds`,
   * and released with them, so removing the embed, deleting the message or
   * purging its owner deletes it, and the bucket's lifecycle rule for `f/`
   * catches what is left. Counts toward `storedBytesCap`, not the upload
   * counts; undefined, keeping the output in the snapshot, when uploads are
   * off or the cap is reached.
   */
  private storeTerminalOutput(stored: TerminalStored, entry: LiveEntry, now: number): TerminalOutputRef | undefined {
    const policy = this.config.uploads;
    if (!policy || !entry.messageId || !/^f\/[A-Za-z0-9_-]{22}$/.test(stored.key)) return undefined;
    const bytes = utf8Bytes(stored.output);
    const total = this.metaNumber(META_UPLOAD_BYTES);
    if (total + bytes > policy.storedBytesCap) return undefined;
    this.setUploadBytes(total + bytes);
    this.rawExec(
      `INSERT INTO uploads (upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms, created_ms)
       VALUES (?, ?, 'file', ?, ?, 'done', ?, ?, ?, ?)`,
      stored.key, entry.owner, entry.messageId, entry.embedId, bytes, now, now + policy.fileRetentionSeconds * 1_000, now,
    );
    return { key: stored.key, bytes: utf8Bytes(JSON.stringify(stored.output)) };
  }

  private setUploadBytes(bytes: number): void {
    this.writeMeta(META_UPLOAD_BYTES, String(Math.max(0, bytes)));
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
      this.liveCache = this.metaJson(META_LIVE_TEXTS, (value) => Array.isArray(value) ? value.filter(isLiveEntry) : undefined, []);
    }
    // Callers change what they get before they save it.
    return clone(this.liveCache) as LiveEntry[];
  }

  private saveLiveTexts(entries: readonly LiveEntry[]): void {
    this.writeMeta(META_LIVE_TEXTS, entries.length ? JSON.stringify(entries) : null);
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
   * unexpired pending writes included; at most `concurrent` server-wide (liveHolds); and the
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
    this.assertNotDegraded("Live text", now);
    // A command's write that never came leaves nothing to publish: it goes now.
    const entries = this.liveTexts().filter((entry) => entry.post === undefined || entry.writeExpiresMs >= now);
    // Only a text that can still stream holds a slot (liveHolds). One whose
    // write_url expired stays listed until the alarm ends its message
    // (expireLiveTexts), but no longer counts against its owner or the server;
    // the list itself stays bounded, at twice the concurrent texts.
    const holding = entries.filter((entry) => liveHolds(entry, now));
    if (holding.some((entry) => entry.owner === input.userId)) {
      throw new StoreError("denied", "You already have a live text open; finish it, or let its write_url expire, before you start another");
    }
    if (holding.length >= policy.concurrent || entries.length >= 2 * policy.concurrent) {
      const soonest = Math.min(...(holding.length ? holding : entries).map(liveDeadline));
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
          const found = this.retainedEmbed(entry.messageId, entry.embedId);
          if (found) {
            this.ensureGrowthCapacity(this.config.maxSnapshotBytes);
            broadcasts = this.rewriteEmbed(found.message, found.snapshot, entry.embedId, { ...found.embed, url: liveUrl(this.config.liveText!, entry) }, effective);
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
  finishLiveText(key: string, kept: Uint8Array | null, now = this.clock.now(), stored?: TerminalStored): LiveFinish {
    this.ensureReady();
    if (!this.config.liveText) return { broadcasts: [] };
    // A stored output adds its upload row and the stored-bytes count.
    return this.reserved({ reads: 96 + (stored ? 16 : 0), writes: 64 + LIVE_WRITES + (stored ? 16 : 0) }, true, now, () => this.transaction(() => {
      const effective = this.effectiveNow(now);
      const entries = this.liveTexts();
      const entry = entries.find((candidate) => candidate.key === key);
      if (!entry) return { broadcasts: [] };
      this.saveLiveTexts(entries.filter((candidate) => candidate !== entry));
      const published = { stored: false };
      const broadcasts = this.publishLiveText(entry, kept, effective, stored, published);
      return { entry, broadcasts, stored: published.stored };
    }));
  }

  /**
   * Ends the live texts that fell due: a write that never came by its
   * window's end (its message, if posted, loses the embed), and a text
   * marked streaming that `streaming` (the runtime's own) does not hold:
   * the object that streamed it was evicted or redeployed and its bytes are
   * gone, so its embed is removed. Maintenance work, bounded by twice
   * `concurrent` entries (startLiveText), which its reservation covers; `next` is when the next one falls due.
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

  /**
   * The snapshot that ends a live text (finishLiveText). A terminal's output
   * the runtime stored in R2 (`stored`) is kept there, the snapshot holding
   * a TerminalOutputRef to it and its upload row counting its bytes like an
   * attached file's, while uploads are on and their stored-bytes cap allows;
   * otherwise in the snapshot, as `output`.
   */
  private publishLiveText(entry: LiveEntry, kept: Uint8Array | null, now: number, stored?: TerminalStored, published?: { stored: boolean }): Broadcast[] {
    if (!entry.messageId) return [];
    const found = this.retainedEmbed(entry.messageId, entry.embedId);
    if (!found) return [];
    const { message, snapshot, embed } = found;
    // What the entry keeps, whatever the caller held: the last part of a terminal, the first of an append.
    if (entry.kind === "terminal") {
      const output = terminalOutput(keepLast(kept ?? new Uint8Array(0), entry.limit));
      // Its `url` ends with the text: the output is the embed's now (§4.8.6).
      const { url: _url, ...rest } = embed;
      void _url;
      if (!output) return this.rewriteEmbed(message, snapshot, entry.embedId, null, now);
      const ref = stored && stored.output === output ? this.storeTerminalOutput(stored, entry, now) : undefined;
      if (ref && published) published.stored = true;
      return this.rewriteEmbed(message, snapshot, entry.embedId, ref ? { ...rest, output_ref: ref } : { ...rest, output }, now);
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
      this.writeMeta(META_TOGGLE_PREFIX + feature, on === undefined ? null : on ? "on" : "off");
      if (since !== undefined) this.writeMeta(META_PRESENCE_ON, String(since));
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
      this.writeMeta(META_SERVER_PREFIX + field, null);
      delete stored[field];
    } else {
      this.writeMeta(META_SERVER_PREFIX + field, value);
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
  private loadEmojiCatalog(): NonNullable<SqliteStore["emojiCache"]> {
    if (this.emojiCache) return this.emojiCache;
    const json = this.metaValue(META_EMOJI_CATALOG);
    const parsed = json ? parseJson<unknown>(json, null) : null;
    const entries = isPlainObject(parsed) ? parsed as Record<string, EmojiEntry> : {};
    this.emojiCache = this.emojiCacheFor(Object.keys(entries).length ? json : "", entries);
    return this.emojiCache;
  }

  private emojiCacheFor(json: string, entries: Record<string, EmojiEntry>): NonNullable<SqliteStore["emojiCache"]> {
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
      this.writeMeta(META_EMOJI_CATALOG, draft.json || null);
      // The catalog before this one stays until the next change; the one
      // before that goes now.
      const previous = this.metaValue(META_EMOJI_PREVIOUS);
      if (previous && previous !== draft.key && previous !== before.key) deletedUploads.push(previous);
      if (before.key && before.key !== draft.key) this.writeMeta(META_EMOJI_PREVIOUS, before.key);
      else if (previous) this.writeMeta(META_EMOJI_PREVIOUS, null);
      return deletedUploads;
    }));
    if (!result) return { applied: false, deletedUploads: [] };
    this.emojiCache = this.emojiCacheFor(draft.json, draft.entries);
    return { applied: true, deletedUploads: result };
  }

  /**
   * Finishes a write exactly once (protocol §4.8.3). A file's message gets a
   * new snapshot, with the embed completed (`url`, and `og.image` or, for a
   * voice clip, `og.audio` describing it; a text file gets neither) or, for a
   * failed write, without it; an avatar becomes its owner's.
   * A write that is not pending, came too late, or whose embed or message is
   * gone is not accepted, and its object is the caller's to delete.
   */
  /** Who owns an upload (`owner_id`: a user, or SERVER_OWNER or EMOJI_OWNER), or undefined for an unknown key: one row by primary key. */
  uploadOwner(key: string, now = this.clock.now()): string | undefined {
    this.ensureReady();
    return this.reserved({ reads: 4 }, false, now, () => this.uploadRow(key)?.owner_id);
  }

  finishUpload(write: UploadWrite, now = this.clock.now()): UploadFinish {
    this.ensureReady();
    // A user's or the server's avatar write scans its owner's uploads for the
    // one it replaces, so the reservation is sized by the owner, read first.
    const owner = this.uploadOwner(write.key, now) ?? "";
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
        const count = dayCount(global, "uploads_day", day);
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
    const found = row.message_id && row.embed_id ? this.retainedEmbed(row.message_id, row.embed_id) : null;
    if (!found) return { accepted: false, broadcasts: [], deletedUploads: this.releaseUploadRows([row]) };
    const { message, snapshot, embed } = found;
    let replacement: Record<string, unknown> | null = null;
    let deletedUploads: string[] = [];
    if (ok) {
      this.completeUploadRow(row, write.bytes!);
      const size = write.width && write.height ? { width: write.width, height: write.height } : {};
      // A text file has no media to preview: its embed is its title and url.
      const media = write.contentType!.startsWith("audio/") ? { audio: { url, type: write.contentType } } : write.contentType!.startsWith("image/") ? { image: { url, type: write.contentType, ...size } } : {};
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
    // A tombstone carries no body and no ext (§4.4).
    if (nextText === "" && !embeds.length) {
      next.deleted = true;
      delete next.ext;
    } else {
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
   * Forgets uploads past their expiry plus the lifecycle lag, freeing their
   * bytes, and returns their keys for the caller to delete from R2 (a
   * bucket lifecycle rule may already have); an expired avatar leaves its
   * owner. Maintenance work, a bounded batch per call.
   *
   * An attached file's expiry is fixed when it is uploaded, so a longer
   * `fileRetentionSeconds` would not reach files uploaded before it: their
   * messages would outlive them. A written file that the current setting
   * still keeps, and whose message is still kept, is given that expiry
   * instead of being forgotten. Retention cleanup removes a message without
   * releasing its uploads, so a file whose message is gone is not kept on.
   */
  cleanupUploads(now = this.clock.now()): { count: number; deleted: string[] } {
    this.ensureReady();
    const policy = this.config.uploads;
    if (!policy) return { count: 0, deleted: [] };
    // Five reads a row: the four of its release, or the message lookup of an extension.
    return this.reserved({ reads: 16 + 5 * UPLOAD_SWEEP_BATCH, writes: 8 + 12 * UPLOAD_SWEEP_BATCH }, true, now, () => this.transaction(() => {
      const rows = this.rawRows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms, created_ms
         FROM uploads INDEXED BY uploads_expiry_idx WHERE expires_ms < ? ORDER BY expires_ms LIMIT ?`,
        this.effectiveNow(now) - policy.lifecycleLagSeconds * 1_000, UPLOAD_SWEEP_BATCH,
      );
      const expired: RawUploadRow[] = [];
      for (const row of rows) {
        const kept = row.purpose === "file" && row.state === "done" && row.message_id ? integerColumn(row.created_ms) + policy.fileRetentionSeconds * 1_000 : 0;
        const messageKept = kept > row.expires_ms
          && this.rawRows<{ found: number }>("SELECT 1 AS found FROM message_state WHERE message_id = ? LIMIT 1", row.message_id).length > 0;
        if (messageKept) this.rawExec("UPDATE uploads SET expires_ms = ? WHERE upload_key = ?", kept, row.upload_key);
        else expired.push(row);
      }
      for (const row of expired) {
        if (row.purpose !== "avatar") continue;
        this.rawExec(
          "UPDATE identities SET avatar_url = '', avatar_expires_ms = 0 WHERE user_id = ? AND avatar_url = ?",
          row.owner_id, `${policy.mediaOrigin}/${row.upload_key}`,
        );
      }
      // The caller deletes them from R2 as well (deleteMedia), so expired files
      // go even where the bucket has no lifecycle rule; custom emoji and the
      // server's avatar never expire here.
      return { count: rows.length, deleted: this.releaseUploadRows(expired) };
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
   * thread's parent, which lets only `mentions` through, as in other chat
   * apps; one woken for this room within `coalesceSeconds` is
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
   * window and the allowances, though it is counted against them; the
   * unscoped mute or `dnd` still silences it (§4.9), and a room's mute lets
   * it through, as it mentions them.
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
        let rows = this.rawRows<RawPushRow>(
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
        // A room's mute lets a mention through, as in other chat apps, and nothing else.
        if (roomMuted.length) {
          why &= WAKE_SCOPES.mentions;
          rows = rows.filter((row) => (integerColumn(row.wake) & why) !== 0);
          if (!rows.length) continue;
        }
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
          const charged = dayCount(sender, "posts_day", day);
          counters = { server, sender, sent: dayCount(server, "posts_day", day), charged, chargedBefore: charged };
        }
        const recipientScope = joinedOnly ? "push_joined_recipient" : PUSH_UNREAD_SCOPE;
        const recipient = this.rawRows<{ day: string; posts_day: number; uploads_day: number }>(
          "SELECT day, posts_day, uploads_day FROM principal_limits WHERE scope = ? AND principal_key = ? LIMIT 1", recipientScope, `user:${userId}`,
        )[0];
        const received = dayCount(recipient, "posts_day", day);
        // The same row's `uploads_day` is the user's `unread` (PUSH_UNREAD_SCOPE). A push for `joined` alone
        // counts none, nor does an operator alert, which goes to admins attended or not.
        const unread = !joinedOnly && !input.alert ? dayCount(recipient, "uploads_day", day) + 1 : undefined;
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
      return dayCount(rows[0], "posts_day", dayFor(this.effectiveNow(now)));
    });
  }

  /** Replace the caller's reaction set on one message (§4.7). */
  private commitReactions(input: StoreMutationInput, context: CommitContext, floor: number): StoreMutationResult {
    const params = input.params;
    const messageIdParam = params.message_id;
    if (typeof messageIdParam !== "string" || messageIdParam.length === 0) throw new StoreError("invalid_params", "message_id must be a non-empty string");
    const emojis = must(this.content.emojis(params.emojis));
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
   * merging `ext` into the current one (§4.13).
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
    // deployment's privateRooms is always positive (loadConfig), so only tests use it.
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
    // `ext` merges into the room's current one (§4.13, §4.2.4); the size check runs on the result.
    const roomFields = (stored: unknown): Record<string, unknown> => {
      const ext = mergeExt(stored, write);
      return { ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}), ...(ext ? { ext } : {}) };
    };

    let row: RawRoomRow;
    let logId: number;
    if (roomIdParam === undefined) {
      const parentId = params.parent_room_id;
      let parentRoomId: string | null = null;
      // Creating a room joins its registered creator.
      if (registered && this.membershipCount(input.userId) >= MAX_MEMBERSHIPS_PER_USER) throw new StoreError("denied", MEMBERSHIP_LIMIT_MESSAGE);
      if (makePrivate) {
        const counts = this.privateRoomCounts(input.userId, this.creationCutoff(context.commitMs));
        if (counts.memberships >= this.config.maxPrivateMembershipsPerUser) {
          throw new StoreError("denied", `You are in ${counts.memberships} private rooms, the most at once; leave one to start another`);
        }
        // So one account cannot take every slot by starting rooms and leaving them to others.
        if (counts.created >= this.config.maxPrivateRoomsPerUser) {
          throw new StoreError("denied", this.config.roomCreationWindowMs > 0
            ? `You can start at most ${this.config.maxPrivateRoomsPerUser} private rooms in ${windowDays(this.config.roomCreationWindowMs)}; try again later`
            : `You can have started at most ${this.config.maxPrivateRoomsPerUser} private rooms at once; one stops counting when everyone has left it`);
        }
        if (!this.roomSlotFree("private", context.commitMs)) throw new StoreError("denied", this.privateRoomLimitMessage());
      } else if (parentId === undefined) {
        if (!registered || !this.holdsRole(input.userId, ROOM_CREATOR_ROLES)) throw new StoreError("denied", "Only an admin or mod may create a room; others may create threads");
        const rooms = this.rawRows(`SELECT room_id FROM rooms WHERE ${roomKind(0)} LIMIT ?`, MAX_CREATED_ROOMS + 1).length;
        if (rooms > MAX_CREATED_ROOMS) throw new StoreError("denied", "room_limit");
      } else {
        if (typeof parentId !== "string" || parentId.length === 0) throw new StoreError("invalid_params", "parent_room_id must be a non-empty string");
        const parent = this.visibleRoomRow(parentId, input.userId);
        if (!parent) throw new StoreError("invalid_params", "unknown parent_room_id");
        if (parent.parent_room_id !== null) throw new StoreError("denied", "Threads cannot be nested on this demo");
        if (isPrivateRoomId(parentId)) throw new StoreError("denied", "A private room has no threads on this demo");
        parentRoomId = parentId;
        // So one account cannot take every slot: the threads a registered user
        // started within roomCreationWindowMs. A user holding any role (one an
        // admin gave, as for the trusted posting limits) is held only to the
        // server's maxThreads: a moderator re-threading starts many.
        if (registered && !this.holdsAnyRole(input.userId) && this.recentThreadsCreatedBy(input.userId, this.creationCutoff(context.commitMs)) >= this.config.maxThreadsPerUser) {
          throw new StoreError("denied", this.config.roomCreationWindowMs > 0
            ? `You can start at most ${this.config.maxThreadsPerUser} threads in ${windowDays(this.config.roomCreationWindowMs)}; try again later`
            : `You can have at most ${this.config.maxThreadsPerUser} threads at once; one stops counting when everyone has left it`);
        }
      }
      const counter = makePrivate ? "private_count" : "thread_count";
      if (!makePrivate && !this.roomSlotFree("public", context.commitMs)) throw new StoreError("denied", "thread_limit");
      const fields = roomFields(undefined);
      this.checkRoomFields(fields);
      this.checkRoomFieldsTotal(fields);
      logId = this.allocateLogId(context);
      const roomId = (makePrivate ? PRIVATE_ROOM_PREFIX : "") + idString(logId);
      // A registered creator is kept with the fields, outside the client's
      // size limit and the room record, so they can remove members (§4.2.2).
      const fieldsJson = JSON.stringify(registered ? { ...fields, creator_id: input.userId } : fields);
      this.rawExec(
        `INSERT INTO rooms (${ROOM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        roomId, parentRoomId, logId, logId, logId, fieldsJson, context.commitMs, context.commitMs,
      );
      this.adjustCount(counter, 1);
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
      this.checkRoomFieldsTotal(fields, existing);
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

  /**
   * The creation log ID (a commit time) from which a room counts against
   * the thread and private-room caps (roomCreationWindowMs): 0, which every
   * room is at or past, when every room that exists counts.
   */
  private creationCutoff(now: number): number {
    return this.config.roomCreationWindowMs > 0 ? Math.max(0, now - this.config.roomCreationWindowMs) : 0;
  }

  /** Rows the rooms table holds (`general`, the public rooms counted by thread_count, the private ones): what a scan of every room reads. */
  private roomRowCount(): number {
    return 1 + this.metaNumber("thread_count") + this.metaNumber("private_count");
  }

  /**
   * The rooms counted against a cap (roomCountReads): those created within
   * roomCreationWindowMs. `public`, the top-level rooms and threads besides
   * `general`, against maxThreads; `private`, the private rooms, against
   * maxPrivateRooms. Each a range of ROOM_CREATED_INDEX.
   */
  private recentRoomCount(kind: "public" | "private", now: number): number {
    const cutoff = this.creationCutoff(now);
    const count = (sql: string, ...bindings: unknown[]) => integerColumn(this.rawRows<{ count: number }>(sql, ...bindings)[0]?.count);
    if (kind === "private") return count(`SELECT COUNT(*) AS count FROM rooms WHERE ${roomKind(2)} AND created_log_id >= ?`, cutoff);
    return count(`SELECT COUNT(*) AS count FROM rooms WHERE ${roomKind(0)} AND created_log_id >= ? AND room_id != ?`, cutoff, ROOM_ID) +
      count(`SELECT COUNT(*) AS count FROM rooms WHERE ${roomKind(1)} AND created_log_id >= ?`, cutoff);
  }

  /** Whether a room of `kind` may be created (or restored as created within the window): fewer were created within it than the cap. */
  private roomSlotFree(kind: "public" | "private", now: number): boolean {
    const cap = kind === "public" ? this.config.maxThreads : this.config.maxPrivateRooms;
    return this.recentRoomCount(kind, now) < cap;
  }

  /** The refusal when the private-room cap is full. */
  private privateRoomLimitMessage(): string {
    return this.config.roomCreationWindowMs > 0
      ? `This server starts at most ${this.config.maxPrivateRooms} private rooms in ${windowDays(this.config.roomCreationWindowMs)}; try again later`
      : "The demo holds as many private rooms as it can; one frees up when everyone has left it";
  }

  /**
   * `/status`: the public rooms (besides `general`) and private rooms
   * created within roomCreationWindowMs, which the caps count, and those
   * kept besides.
   */
  roomCounts(now = this.clock.now()): { public: { recent: number; older: number }; private: { recent: number; older: number } } {
    this.ensureReady();
    return this.reserved({ reads: 16 + 2 * this.roomCountReads }, false, now, () => {
      const publicRecent = this.recentRoomCount("public", now);
      const privateRecent = this.recentRoomCount("private", now);
      return {
        public: { recent: publicRecent, older: Math.max(0, this.metaNumber("thread_count") - publicRecent) },
        private: { recent: privateRecent, older: Math.max(0, this.metaNumber("private_count") - privateRecent) },
      };
    });
  }

  /**
   * The rooms a registered user is a member of, through the user index,
   * those awaiting purge included: at most MAX_MEMBERSHIP_ROWS rows read
   * (MEMBERSHIP_COUNT_READS), the count stopping there.
   */
  private membershipCount(userId: string): number {
    return integerColumn(this.rawRows<{ count: number }>(
      "SELECT COUNT(*) AS count FROM (SELECT 1 FROM memberships INDEXED BY memberships_user_idx WHERE user_id = ? LIMIT ?)", userId, MAX_MEMBERSHIP_ROWS,
    )[0]?.count);
  }

  /** Thread rooms `userId` created within roomCreationWindowMs (`cutoff`): ROOM_CREATED_INDEX's range of them, the creator read from each row. */
  private recentThreadsCreatedBy(userId: string, cutoff: number): number {
    return integerColumn(this.rawRows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM rooms WHERE ${roomKind(1)} AND created_log_id >= ? AND json_extract(fields_json, '$.creator_id') = ?`,
      cutoff, userId,
    )[0]?.count);
  }

  /**
   * For a private room's creation (PRIVATE_ROOM_COUNT_READS): the private
   * rooms `userId` created within roomCreationWindowMs (`cutoff`), as
   * recentThreadsCreatedBy counts threads; and the private rooms they are
   * in, from their memberships.
   */
  private privateRoomCounts(userId: string, cutoff: number): { created: number; memberships: number } {
    const created = integerColumn(this.rawRows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM rooms WHERE ${roomKind(2)} AND created_log_id >= ? AND json_extract(fields_json, '$.creator_id') = ?`,
      cutoff, userId,
    )[0]?.count);
    return { created, memberships: this.privateMembershipCount(userId) };
  }

  /**
   * The private rooms a registered user is in. Their membership rows,
   * through the user index, joined with `rooms` so the rows of a removed
   * room awaiting purge do not count: at most MAX_MEMBERSHIP_ROWS rows, and
   * a room lookup each.
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

  /** A room's client fields (`title`, `description`, `ext`) fit roomMetadataBytes serialized. */
  private checkRoomFields(fields: Record<string, unknown>): void {
    must(this.content.roomFields(fields));
  }

  /**
   * Every room's client fields past roomMetadataMinBytes, together, with
   * `fields` in place of the `existing` room's (or added, for a new room),
   * fit roomMetadataTotalBytes serialized, so a listing of every room stays
   * bounded. A room within roomMetadataMinBytes, or a save that does not
   * grow its room's excess, is never refused: a full total stops only long
   * room notes, and rooms can still shrink while the total is past a
   * lowered limit. One scan of the capped rooms table
   * (roomFieldsTotalReads), only for a save that grows its excess.
   */
  private checkRoomFieldsTotal(fields: Record<string, unknown>, existing?: RawRoomRow): void {
    const floor = this.config.roomMetadataMinBytes;
    const excess = (bytes: number) => Math.max(0, bytes - floor);
    const added = excess(utf8Bytes(JSON.stringify(fields)));
    const before = existing ? excess(utf8Bytes(JSON.stringify(clientRoomFields(existing.fields_json)))) : 0;
    if (added === 0 || added <= before) return;
    // The rooms a listing names (listedRoomRows) past the minimum, with what
    // each holds past it: older rooms, which no listing names, never reach one.
    const rows = this.listedRoomRows(true)
      .filter((row) => row.room_id !== existing?.room_id)
      .map((row) => {
        const stored = clientRoomFields(row.fields_json);
        return { room_id: row.room_id, title: stored.title, excess: excess(utf8Bytes(JSON.stringify(stored))) };
      })
      .filter((row) => row.excess > 0);
    const others = rows.reduce((sum, row) => sum + integerColumn(row.excess), 0);
    if (others + added <= this.config.roomMetadataTotalBytes) {
      this.roomNotesCheck = { total: others + added };
      return;
    }
    // Private rooms are never named: the alert is a post in `general`.
    const rooms = rows.filter((row) => !isPrivateRoomId(row.room_id))
      .map((row) => ({ room_id: row.room_id, ...(typeof row.title === "string" ? { title: row.title } : {}), bytes: integerColumn(row.excess) }))
      .sort((a, b) => b.bytes - a.bytes || a.room_id.localeCompare(b.room_id))
      .slice(0, ROOM_NOTES_NAMED);
    this.roomNotesCheck = { total: others + before, full: true, rooms };
    throw new StoreError("too_large", `Long room descriptions together are at this server's limit; keep this one within ${Math.floor(floor / 1024 * 10) / 10} KiB, or shorten another room's`);
  }

  /**
   * A `me` profile write (§3.3) of a registered user: `name`, where `""`
   * removes it (a bot's must contain "bot": BOT_NAME_PATTERN), and `ext`, but for the keys the server owns
   * (SERVER_USER_EXT_KEYS), merged into the stored one (§4.13) and at most
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
    const bot = existing.tier === "bot" || parseRoles(existing.roles_json).includes("bot");
    if (typeof name === "string" && bot && !BOT_NAME_PATTERN.test(name)) throw new StoreError("denied", BOT_NAME_RULE);
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
        if (typeof roomId !== "string" || !this.visibleRoomRow(roomId, input.userId)) throw new StoreError("invalid_params", "unknown room");
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
    // Creating a thread reads the public rooms created within the window
    // twice (the creator's, and all of them against the cap), and joins its
    // creator, counting their memberships.
    const roomScan = (!creating ? 0 : (input.params.private === true ? PRIVATE_ROOM_COUNT_READS : 2 * this.roomCountReads + MAX_CREATED_ROOMS + 2) + MEMBERSHIP_COUNT_READS) +
      (method === "room_set" ? this.roomFieldsTotalReads : 0);
    // A move or an editor's save also raises the retired markers of the
    // users it logs again (noteRetiredRelog): its author, last editor and
    // reactors, each a key lookup and a row of the list it reads them from.
    const relogReads = mayMove ? 2 * (this.config.reactionUsersPerMessage + 2) + 4 : 0;
    const mutationCost = {
      ...this.config.mutationCost,
      reads: Math.max(256, this.config.mutationCost.reads ?? 0) + roomScan + relogReads,
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
            // A room exists, and is counted, until its records leave the tiers below too.
            : method === "room_set" ? this.commitRoom(input, context, this.publishedFloor(), tier === "registered")
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
    return this.historyImpl(query, false) as StoreHistoryResult;
  }

  /**
   * history, for a runtime with tiers below: a page that reaches below the
   * hot floor is a PendingHistory, which the runtime completes with the
   * records it asks of them (HistoryChain.read). Charged and checked as
   * history is, before they are read.
   */
  historyAcrossTiers(query: StoreHistoryQuery): StoreHistoryResult | PendingHistory {
    return this.historyImpl(query, true);
  }

  private historyImpl(query: StoreHistoryQuery, allowTiers: boolean): StoreHistoryResult | PendingHistory {
    this.ensureReady();
    const operationNow = query.now ?? this.clock.now();
    const charged = Boolean(query.userId && query.ipKey);
    // `before` alone pages back from the head: how far back it starts, in
    // records past `before`, decides whether a guest may have it and whether
    // the degraded tier counts it as older history. The newest page is
    // neither: its `before` is the head, give or take the records since.
    const backward = query.before !== undefined && query.after === undefined;
    const limit = this.historyLimit(query);
    // The degraded tier lets through a page within two pages of the head: a
    // room viewed without joining knows its head only from a listing.
    const newestReach = 2 * limit;
    const guestReach = Math.max(this.config.guestHistoryDepth, limit);
    const depthCap = Math.max(newestReach, query.guest ? guestReach : 0);
    return this.reserved({
      ...this.config.historyCost,
      // Measuring a backward page reads the rooms again (a private one's
      // membership too) and at most `depthCap` records and one more a room.
      reads: this.historyReads(query) + (backward ? depthCap + 3 * this.historyRoomCount(query) : 0),
      // A page writes only its two limiter rows and the budget row: about 20
      // rows for a first request, which creates both limiter rows.
      writes: Math.max(32, this.config.historyCost.writes ?? 0),
      history: charged ? 1 : 0,
    }, false, operationNow, (unused) => {
      // A page refused once measured read rows to find out: it stays charged,
      // to the user's and IP's limiters and the server's count, so refusals
      // cost what a page does and cannot be repeated for free.
      let measuredRefusal: StoreError | undefined;
      try {
        const now = this.effectiveNow(operationNow);
        // Scrolling back, the costliest reads, is the history the degraded
        // tier turns off (today's budget is in memory), and a guest's
        // reaches only `guestHistoryDepth` records back: past that, older
        // pages are for accounts. A page near the head is the newest, open
        // to everyone in every tier.
        const degraded = query.before !== undefined && this.degraded(operationNow);
        if (degraded && !backward) this.assertNotDegraded("Loading older history", operationNow);
        const page = this.transaction(() => {
          if (charged && !query.guest) {
            this.chargeEvent("history", `user:${query.userId}`, now,
              { perMinute: this.config.historyRequestsPerUserMinute, burst: this.config.historyBurstPerUser },
              "History request limit reached",
              { limit: this.config.historyRequestsPerUserDay, message: "Daily history limit reached" }, "read");
          }
          if (charged) {
            this.chargeEvent("history", `ip:${query.ipKey}`, now,
              { perMinute: this.config.historyRequestsPerIpMinute, burst: this.config.historyBurstPerIp },
              "History request limit reached",
              { limit: this.config.historyRequestsPerIpDay, message: "Daily history limit reached for this network" }, "read");
          }
          if (backward && (query.guest || degraded)) {
            const depth = this.recordsAfter(query, depthCap);
            try {
              if (degraded && depth >= newestReach) this.assertNotDegraded("Loading older history", operationNow);
              if (query.guest && depth >= guestReach) throw new StoreError("denied", "Sign in to load older history");
            } catch (error) {
              // Returned rather than thrown, so the transaction keeps the charges.
              measuredRefusal = error as StoreError;
              return undefined;
            }
          }
          return this.historyPageInternal({ ...query, now }, allowTiers);
        });
        if (measuredRefusal) throw measuredRefusal;
        return page!;
      } catch (error) {
        // No page was served, and the rollback undid the user's and IP's charges: the server-wide count goes back too.
        if (error !== measuredRefusal) unused.history = 1;
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
      return this.transaction(() => this.historyPageInternal({ ...query, now }) as StoreHistoryResult);
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
    const limit = this.historyLimit(query);
    // The scan of the log reads an index entry and a row for each record.
    return Math.max(single, 64 + 2 * HISTORY_SCAN_PAGES * (limit + 1) + new Set(query.roomIds).size * (limit + 3));
  }

  private historyLimit(query: StoreHistoryQuery): number {
    return query.limit !== undefined && Number.isInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, this.config.maxHistoryLimit) : this.config.historyPageSize;
  }

  /** The rooms a history query names: one, or its distinct `roomIds`. */
  private historyRoomCount(query: StoreHistoryQuery): number {
    return query.roomId === undefined && query.roomIds !== undefined ? new Set(query.roomIds).size : 1;
  }

  /** The rooms whose log a history query reads, the requester's visible ones (see historyPageInternal). */
  private historySources(query: StoreHistoryQuery): { multiple: boolean; sources: RawRoomRow[] } {
    const multiple = query.roomId === undefined && query.roomIds !== undefined;
    const roomIds = multiple ? [...new Set(query.roomIds)] : [query.roomId === undefined ? ROOM_ID : query.roomId];
    for (const roomId of roomIds) {
      if (typeof roomId !== "string" || roomId.length === 0) throw new StoreError("invalid_params", "room_id must be a non-empty string");
    }
    // A requester's private room only if they are in it; internal pages, with no requester, see every room.
    const visible = (roomId: string) => query.userId === undefined ? this.roomRow(roomId) : this.visibleRoomRow(roomId, query.userId);
    return { multiple, sources: roomIds.map(visible).filter((room): room is RawRoomRow => room !== null) };
  }

  /**
   * How many records the query's rooms hold past its `before`, counted up to
   * `cap`: how far back from the head a page that ends there starts. At most
   * `cap` rows and one a room are read.
   */
  private recordsAfter(query: StoreHistoryQuery, cap: number): number {
    const before = this.historyBound(query.before, "before");
    if (before === undefined) return 0;
    // Records below the hot floor are in the tiers below, where they are not
    // counted: a page whose stretch after `before` reaches below the hot
    // floor, in a room whose history goes there, counts as `cap` deep.
    const hot = this.logState().history_floor;
    const published = this.config.tiered ? this.publishedFloor() : hot;
    let total = 0;
    for (const room of this.historySources(query).sources) {
      if (total >= cap || before >= room.latest_log_id) continue;
      if (Math.max(before + 1, roomHistoryFloor(room, published)) < hot) return cap;
      total += this.rawRows<{ count: number }>(
        "SELECT COUNT(*) AS count FROM (SELECT 1 FROM records WHERE room_id = ? AND log_id > ? LIMIT ?)",
        room.room_id, before, cap - total,
      )[0]?.count ?? 0;
    }
    return total;
  }

  private historyBound(value: string | bigint | undefined, field: string): number | undefined {
    if (value === undefined) return undefined;
    return numericId(typeof value === "bigint" ? numericBigInt(value, field) : value, field);
  }

  private historyPageInternal(query: StoreHistoryQuery, allowTiers = false): StoreHistoryResult | PendingHistory {
    const { multiple, sources } = this.historySources(query);
    if (!multiple && !sources.length) throw new StoreError("invalid_params", "unknown room");
    // History starts at the published floor; the hot log holds records from
    // the hot floor on, and the tiers below those between them.
    const floor = this.publishedFloor();
    const hot = this.logState().history_floor;
    const after = this.historyBound(query.after, "after");
    const before = this.historyBound(query.before, "before");
    const limit = positiveLimit(query.limit, this.config.historyPageSize, this.config.maxHistoryLimit);
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
    // The hot log's part of each window.
    const hotWindows = new Map([...windows].filter(([, window]) => window.upper >= hot).map(([roomId, window]) => [roomId, { lower: Math.max(window.lower, hot), upper: window.upper }]));
    const roomSlice = (roomId: string, window: { lower: number; upper: number }) => this.rawRows<RawRecordRow>(
      `SELECT room_id, log_id, kind, record_json FROM records
       WHERE room_id = ? AND log_id >= ? AND log_id <= ?
       ORDER BY log_id ${forward ? "ASC" : "DESC"} LIMIT ?`,
      roomId, window.lower, window.upper, limit + 1,
    );
    if (!hotWindows.size) {
      // Nothing of the window is in the hot log.
    } else if (!multiple || hotWindows.size <= 1) {
      for (const [roomId, window] of hotWindows) for (const row of roomSlice(roomId, window)) take(row);
    } else {
      // Several rooms: first the log itself, by log_id across every room, at
      // most HISTORY_SCAN_PAGES pages of it. That is the cheapest read when
      // these rooms hold most of the log; when they hold little of it, each
      // room's slice is read instead, a page and one more at most.
      const lower = Math.min(...[...hotWindows.values()].map((window) => window.lower));
      const upper = Math.max(...[...hotWindows.values()].map((window) => window.upper));
      const scanned = this.rawRows<RawRecordRow>(
        `SELECT room_id, log_id, kind, record_json FROM records INDEXED BY records_log_idx
         WHERE log_id >= ? AND log_id <= ?
         ORDER BY log_id ${forward ? "ASC" : "DESC"} LIMIT ?`,
        lower, upper, HISTORY_SCAN_PAGES * (limit + 1),
      );
      for (const row of scanned) take(row);
      if (byLogId.size <= limit && scanned.length === HISTORY_SCAN_PAGES * (limit + 1)) {
        byLogId.clear();
        for (const [roomId, window] of hotWindows) for (const row of roomSlice(roomId, window)) take(row);
      }
    }
    // The tiers' part: below the hot floor. A forward page starts there;
    // a backward one reaches it when the hot log has less than a page.
    const lowered = [...windows].filter(([, window]) => window.lower < hot);
    if (allowTiers && this.config.tiered && lowered.length && (forward || byLogId.size <= limit)) {
      const below: HistoryQuery = {
        roomIds: lowered.map(([roomId]) => roomId),
        lower: Math.min(...lowered.map(([, window]) => window.lower)),
        upper: Math.min(hot - 1, Math.max(...lowered.map(([, window]) => window.upper))),
        forward,
        limit: limit + 1,
      };
      return { below, assemble: (rows) => {
        for (const row of rows) take(row);
        return assemble();
      } };
    }
    return assemble();
    function assemble(): StoreHistoryResult {
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
        // A stored terminal's output is put back before the page is sent.
        const entryBytes = utf8Bytes(JSON.stringify(value)) + terminalOutputBytes(value);
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
  }

  /** The withheld control rows can persist one deferral and its reset alarm. */
  private deferCleanup(effective: number): void {
    const nextDue = Math.max(effective + 1000, (Math.floor(effective / 86_400_000) + 1) * 86_400_000);
    if (this.deferredCleanupUntil >= nextDue) return;
    this.assertAccounting();
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    const reserved = this.reserveMaintenanceControl({ reads: 8, writes: 8 }, effective);
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
      // The published floor rose (publishHistoryFloor): rooms may have gone with it.
      (this.config.tiered && this.metaValue(META_HISTORY_ROOMS_DUE) !== "") ||
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
    if (this.cleanupDueCache !== undefined) return this.cleanupDueAt(this.cleanupDueCache) <= Math.max(Math.trunc(now), this.lastEffectiveMs);
    try {
      return this.reserved({ reads: 4 }, true, now, () =>
        this.cleanupDueAt(cleanupSchedule(this.maintenanceRow())) <= this.effectiveNow(now));
    } catch {
      return true;
    }
  }

  /**
   * When cleanup is next due, given the scheduled `next_cleanup_ms`: that,
   * or sooner while the database is at its storage watermark (a refusal set
   * the storagePressure latch), no sooner than PRESSURE_CLEANUP_RETRY_MS
   * after the last cleanup the pressure started; never before a deferral for
   * an exhausted budget ends (deferredCleanupUntil). The watermark only
   * brings a job's start forward: while one is in progress its own
   * `next_cleanup_ms` (its next batch, or its wait on a copy below) is when
   * it is due, since runCleanup continues a job only then, and an earlier
   * alarm would find nothing to do and be set again at once. The latch is
   * read only as already loaded (a refusal loads it), so this reads nothing.
   */
  private cleanupDueAt(schedule: CleanupSchedule): number {
    const pressed = this.storagePressure.known === "1" && !schedule.jobInProgress ? Math.min(schedule.next, this.pressureCleanupAfter) : schedule.next;
    return Math.max(pressed, this.deferredCleanupUntil);
  }

  /**
   * The commit time before which records have expired (section 9): those
   * past the latest `historyHotRecords`, and any `retentionMs` old. Commit times are nondecreasing in log order, so the
   * count ends at a time too, the commit time of the Nth newest record. A
   * move's record is stored in both of its rooms and counts twice. 0 when
   * nothing has expired. Reads up to `historyHotRecords` index entries
   * (retentionCountReads).
   */
  private retentionCutoff(effective: number): number {
    const byAge = this.config.retentionMs > 0 ? effective - this.config.retentionMs : 0;
    const keep = this.keptHotRecords();
    if (keep <= 0) return Math.max(0, byAge);
    // The index alone finds the Nth newest record; one lookup reads its commit time.
    const nth = this.rawRows<{ log_id: number }>(
      "SELECT log_id FROM records INDEXED BY records_log_idx ORDER BY log_id DESC LIMIT 1 OFFSET ?", keep - 1,
    );
    const commit = nth.length ? this.rawRows<{ commit_ms: number }>(
      "SELECT commit_ms FROM records INDEXED BY records_log_idx WHERE log_id = ? LIMIT 1", nth[0].log_id,
    ) : [];
    const byCount = commit.length ? integerColumn(commit[0].commit_ms) : 0;
    return Math.max(0, byAge, byCount);
  }

  /** The reads retentionCutoff may take. */
  private retentionCountReads(): number {
    const keep = this.keptHotRecords();
    return keep > 0 ? keep + 4 : 0;
  }

  /** The records cleanup keeps in the hot log: `cleanupThresholdPercent` of `historyHotRecords`, 0 without a count. */
  private keptHotRecords(): number {
    return thresholdRecords(this.config.historyHotRecords, this.config.cleanupThresholdPercent);
  }

  /**
   * With tiers below (`tiered`), records leave this SQLite only once the
   * next tier holds them (the history chain copies them and marks
   * META_HISTORY_THROUGH): the hot floor stops at the last copied, and the
   * job waits `copyWaitMs` (a second by default; the runtime lengthens it
   * while the tier fails) for the next copy. The published floor
   * (publishedFloor) stays where it was, below the hot floor, until the
   * chain raises it (publishHistoryFloor); rooms go when their whole log
   * is below it.
   */
  runCleanup(now = this.clock.now(), options: { copyWaitMs?: number } = {}): StoreCleanupResult {
    this.ensureReady();
    // An alarm may have fired, and cleanup may establish an earlier continuation.
    this.scheduledAlarmAt = undefined;
    // A challenge deadline is not an hourly cleanup. Its cheap due check must
    // not consume the reservation for a complete deletion batch.
    let gate: { maintenance: RawMaintenanceRow; state: RawLogState; effective: number; published: number; cutoff?: number; pressed?: boolean };
    try {
      gate = this.reserved({ reads: 24 + this.retentionCountReads(), writes: 2 }, true, now, () => {
        const maintenance = this.maintenanceRow();
        const state = this.logState();
        const effective = this.effectiveNow(now);
        const published = this.publishedFloor();
        // A non-null cursor marks a job whose last batch reported more work
        // (including expired thread rooms, which the cheap probes below do not
        // cover). Continue it rather than letting the idle check end it.
        const jobInProgress = maintenance.cleanup_cursor !== null && maintenance.cleanup_cutoff_ms !== null;
        if (!jobInProgress && effective >= this.cleanupDueAt(cleanupSchedule(maintenance))) {
          // Started by the storage watermark before the scheduled time: the
          // next such start waits a while (a start that finds no work leaves
          // the schedule as it was; a job sets the next from its own end).
          const pressed = effective < Math.max(maintenance.next_cleanup_ms, this.deferredCleanupUntil);
          if (pressed) this.pressureCleanupAfter = effective + PRESSURE_CLEANUP_RETRY_MS;
          const cutoff = this.retentionCutoff(effective);
          // Idle hours must not burn a full deletion reservation.
          if (!this.cleanupHasWork(state.history_floor, cutoff, effective, this.limiterCutoff(effective))) {
            if (pressed) return { maintenance, state, effective, published };
            maintenance.next_cleanup_ms = effective + this.config.cleanupIntervalMs;
            this.rawExec("UPDATE maintenance SET next_cleanup_ms = ?, cleanup_cutoff_ms = NULL, cleanup_cursor = NULL WHERE id = 1", maintenance.next_cleanup_ms);
            this.cleanupDueCache = undefined;
          }
          return { maintenance, state, effective, published, cutoff, pressed };
        }
        return { maintenance, state, effective, published };
      });
    } catch (error) {
      if (error instanceof StoreError && error.code === "retry_after") this.deferCleanup(Math.max(now, this.lastEffectiveMs));
      throw error;
    }
    const { maintenance, state, effective } = gate;
    const previousFloor = state.history_floor;
    const previousPublished = gate.published;
    // A start the watermark made is due now, whatever the schedule says.
    const due = gate.pressed ? effective : Math.max(maintenance.next_cleanup_ms, this.deferredCleanupUntil);
    const empty = (nextDue: number): StoreCleanupResult => ({
      history_floor: idString(previousPublished), previous_floor: idString(previousPublished), latest_id: idString(state.last_log_id),
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
    // A job's retention cutoff is fixed until all of its bounded batches
    // finish; a new job's is the one the due check just found.
    const cutoff = maintenance.cleanup_cursor !== null && maintenance.cleanup_cutoff_ms !== null
      ? maintenance.cleanup_cutoff_ms : gate.cutoff ?? this.retentionCutoff(effective);
    const batch = Math.min(100, this.config.cleanupBatch);
    let floor = previousFloor;
    let published = previousPublished;
    // With tiers below, records leave this SQLite only once the next holds them.
    let ceiling = Number.MAX_SAFE_INTEGER;
    // Commit the server-wide coverage boundary/job before physical deletion.
    // A failed deletion leaves logically expired rows hidden and an
    // idempotent job. Commit times are nondecreasing in log order, so the
    // expired set is always a prefix of the one server-wide log.
    this.transaction(() => {
      this.ensureRoomKindIndexes();
      const pending = this.rawRows<{ log_id: number }>(
        "SELECT log_id FROM records INDEXED BY records_log_idx WHERE log_id < ? ORDER BY log_id LIMIT 1", floor,
      );
      // The expired records are the prefix of the log from the floor on whose commit time is before the cutoff.
      const oldest = pending.length ? [] : this.rawRows<{ log_id: number; commit_ms: number }>(
        `SELECT log_id, commit_ms FROM records INDEXED BY records_log_idx
         WHERE log_id >= ? ORDER BY log_id LIMIT ?`, floor, batch,
      );
      if (this.config.tiered) ceiling = this.metaNumber(META_HISTORY_THROUGH);
      const fresh = oldest.findIndex((row) => integerColumn(row.commit_ms) >= cutoff || row.log_id > ceiling);
      const expired = fresh === -1 ? oldest : oldest.slice(0, fresh);
      if (expired.length) floor = Math.max(floor, expired[expired.length - 1].log_id + 1);
      if (this.config.tiered) {
        // The tiers below hold what is between the published floor and the
        // hot one, until their retention lets the chain publish a higher one.
        published = Math.min(previousPublished, floor);
        if (published !== this.metaNumber(META_HISTORY_PUBLISHED)) this.writeMeta(META_HISTORY_PUBLISHED, String(published));
        this.publishedCache = published;
      } else {
        published = floor;
        // Tiers turned off forget their floors, queue and state: turned on
        // again, they start at the hot floor, and what they held below is trimmed.
        // Backups' schedule (`history:export:`, setHistoryMeta) is no tier's state, and stays.
        const stale = this.rawRows<{ key: string }>(
          `SELECT key FROM _meta WHERE key >= 'history:' AND key < 'history;' AND NOT (key >= '${META_HISTORY_EXPORT}' AND key < '${META_HISTORY_EXPORT.slice(0, -1)};') AND key <> '${META_HISTORY_IMPORT}' AND key <> '${META_HISTORY_IMPORT_PROGRESS}' LIMIT 64`,
        );
        for (const row of stale) this.writeMeta(row.key, null);
        this.publishedCache = undefined;
      }
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
      // Below the published floor: a room's records in the tiers below keep it.
      const threads = remaining > 0 && purge.length < MAX_PURGE_ROOMS ? this.rawRows<{ room_id: string }>(
        `SELECT room_id FROM rooms WHERE ${roomKind(1)} AND latest_log_id < ? ORDER BY latest_log_id LIMIT ?`, published, Math.min(remaining, MAX_PURGE_ROOMS - purge.length),
      ) : [];
      const roomCapacity = Math.min(remaining - threads.length, MAX_PURGE_ROOMS - purge.length - threads.length);
      const privates = roomCapacity > 0 ? this.rawRows<{ room_id: string }>(
        `SELECT room_id FROM rooms WHERE ${roomKind(2)} AND latest_log_id < ? ORDER BY latest_log_id LIMIT ?`, published, roomCapacity,
      ) : [];
      const rooms = [...threads, ...privates];
      for (const row of rooms) this.rawExec("DELETE FROM rooms WHERE room_id = ?", row.room_id);
      if (threads.length) this.adjustCount("thread_count", -threads.length);
      if (privates.length) this.adjustCount("private_count", -privates.length);
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
        this.writeMeta(META_PURGE_ROOMS, JSON.stringify(purge));
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
      if (deletedLimiters) this.adjustCount("principal_limit_count", -deletedLimiters);
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
        this.rawRows(`SELECT room_id FROM rooms WHERE ${roomKind(1)} AND latest_log_id < ? LIMIT 1`, published).length > 0 ||
        this.rawRows(`SELECT room_id FROM rooms WHERE ${roomKind(2)} AND latest_log_id < ? LIMIT 1`, published).length > 0;
      // Waiting for the tier below to copy the next expired records: no
      // sooner than the runtime can (copyWaitMs).
      const waiting = hasMore && this.config.tiered && this.rawRows<{ log_id: number; commit_ms: number }>(
        "SELECT log_id, commit_ms FROM records INDEXED BY records_log_idx WHERE log_id >= ? ORDER BY log_id LIMIT 1", floor,
      ).some((row) => integerColumn(row.commit_ms) < cutoff && row.log_id > this.metaNumber(META_HISTORY_THROUGH));
      // The rooms the published floor left behind are gone once a job ends.
      if (!hasMore && this.config.tiered && this.metaValue(META_HISTORY_ROOMS_DUE) !== "") this.writeMeta(META_HISTORY_ROOMS_DUE, null);
      const nextDue = effective + (!hasMore ? this.config.cleanupIntervalMs : waiting ? Math.max(1000, options.copyWaitMs ?? 1000) : 1000);
      this.rawExec("UPDATE maintenance SET next_cleanup_ms = ?, cleanup_cutoff_ms = ?, cleanup_cursor = ? WHERE id = 1", nextDue, hasMore ? cutoff : null, hasMore ? floor : null);
      this.cleanupDueCache = undefined;
      this.assertReservation(reserved, beforeReads, beforeWrites);
      const deleted = records.length + messages + reactions + rooms.length + memberships + requests.length + limiters.length + subscriptions.length + wakes.length;
      return {
        history_floor: idString(published), previous_floor: idString(previousPublished), latest_id: idString(state.last_log_id),
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
  /**
   * The object's alarm fired. The runtime deletes it once the handler
   * returns, so the alarm this instance last set (scheduledAlarmAt, which
   * lets scheduleAlarm skip a call that would not move it) is no longer set:
   * forgotten here, on every alarm, so the next scheduleAlarm sets one.
   */
  alarmFired(): void {
    this.scheduledAlarmAt = undefined;
  }

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
      // Eight of the withheld control rows defer cleanup; 24 remain to install
      // its reset alarm even after ordinary maintenance is exhausted.
      reserved = this.reserveMaintenanceControl({ reads: 24, writes: 24 }, now);
    }
    const effective = Math.max(Math.trunc(now), this.lastEffectiveMs);
    const maintenance = this.maintenanceRow();
    const cleanupDue = this.cleanupDueAt(cleanupSchedule(maintenance));
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
