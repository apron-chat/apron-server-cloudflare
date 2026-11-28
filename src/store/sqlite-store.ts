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
import type { Sql, StoreCore, TransactionJournal } from "./core";
import { RoomCapsModule } from "./room-caps";
import { HistoryModule } from "./history-log";
import { LiveTextModule } from "./live-text";
import { UploadsModule } from "./uploads";
import { ReadsModule } from "./reads";
import { AdmissionModule } from "./admission";
import { PushModule } from "./push";
import type {
  AccountingGuard, Broadcast, PendingUpload, RoomMember, StoreCleanupResult, DurableSqlStorageLike, DurableStateLike, Identity, LiveEntry,
  MessageSnapshot, MutationMethod, OverrunNotice, RoomNotesCheck, RoomRecord, SqlCursorLike, SqlStorageLike, StoreClock, StoreMutationInput,
  StoreMutationResult, Tier,
} from "./types";
import {
  canonicalize, type CarriedPasskey, changedExt, cleanupSchedule, type CleanupSchedule, clientRoomFields, clone, type CommitContext,
  cursorRows, dayCount, dayFor, digestOperation, ensureText, idString, integerColumn, isPlainObject, liveAvatar, liveUrl,
  type MemberCacheEntry, type MembershipRecord, type MetaCount, must, parseJson, parseRoles, parseUserExt, type RawCredentialRow,
  type RawDedupRow, type RawIdentityRow, type RawLogState, type RawMaintenanceRow, type RawMemberRow, type RawMessageRow,
  type RawReactionRow, type RawRoomRow, type RawUploadRow, type ReactionsRecord, type RecordKind, restoredAvatar, restoredEntries,
  restoredRecord, type RestoredRecord, roomHistoryLogId, roomIdList, seenColumn, settledMeta, statusColumns, storedCreator, utf8Bytes,
  windowDays,
} from "./rows";
import { LimiterCache, type RawLimitRow } from "../limiter-cache";
import {
  BUDGET_COLUMNS, type BudgetCost, type BudgetDelta, BudgetLedger, type BudgetSnapshot, type CostEstimate, type RawBudgetRow,
} from "../budget-ledger";
import {
  META_ACCOUNT_USAGE, META_ACCOUNTING_GUARD, META_ACCOUNTING_UNSAFE, META_ANNOUNCED_TIER, META_BOT_SWEEP, META_EFFECTIVE_NOW,
  META_GUEST_NUMBER_MARK, META_HISTORY_EXPORT, META_HISTORY_IMPORT, META_HISTORY_IMPORT_PROGRESS, META_HISTORY_PUBLISHED,
  META_HISTORY_ROOMS_DUE, META_HISTORY_THROUGH, META_IDLE_ACTIVITY_SINCE, META_IDLE_PRUNE_DAY, META_IDLE_PRUNED, META_PURGE_ROOMS,
  META_PURGED_PREFIX, META_REMOVED_AT_PREFIX, META_REMOVED_FLOOR, META_REMOVED_PREFIX, META_RENAMED_PREFIX, META_ROOM_NOTES_ALERTED, META_STORAGE_ALERTED, META_STORAGE_PRESSURE, USER_LIMIT_SCOPES,
} from "./meta";
import {
  ACCOUNTING_UNCERTAIN, BREAKER_ALERT_ONLY, BREAKER_EXEMPT, BREAKER_MS, BREAKER_OVERRUNS, BREAKER_WINDOW_MS, DEGRADED, emptyGuard,
  maintenanceDelta, OPERATION_PAUSED, parseGuard, STORAGE_UNAVAILABLE,
} from "./accounting";
import { SettledMeta } from "../settled-meta";
import { contentPolicy, type ContentPolicy } from "../content/policy";
import {
  lastActiveSql, MEMBER_TABLES, privateRange, PUBLIC_ROOMS, ROOM_COLUMNS, ROOM_INDEX_DDL, roomKind, SCHEMA_10_COPIED_COLUMNS,
  SCHEMA_10_DROPPED_INDEXES, SCHEMA_9_INDEXES, SCHEMA_DDL, SCHEMA_VERSION, SEEN_COLUMN_PROBE, UPGRADABLE_SCHEMA_VERSION,
} from "./schema";
import {
  BOOTSTRAP_ROW_RESERVATION, DEGRADE_SHARE, listedThreads, MAX_MEMBERSHIPS_PER_USER, MAX_PRIVATE_MEMBERSHIPS_PER_USER,
  SEEN_WRITE_GRANULARITY_MS, thresholdRecords,
} from "../budget";
import { EMPTY_MESSAGE, StoreError } from "../store-error";
import {
  BOT_MODERATOR_ROLES, BOT_NAME_PATTERN, BOT_NAME_RULE, DEFAULT_JOINED_ROOMS, isPrivateRoomId, isProtocolId, MAX_CREATED_ROOMS,
  MAX_LISTED_USER_ROOMS, MAX_PASSKEYS_PER_USER, MAX_ROLES_PER_USER, MAX_ROOM_MUTES_PER_USER, MAX_USER_ROOMS, MODERATOR_ROLES,
  PRIVATE_ROOM_PREFIX, ROLE_PATTERN, ROOM_CREATOR_ROLES, ROOM_ID, type StoredCredential, type StoredIdentity, UNCLAIMED_ROLE,
} from "../domain";
import { ADMIN_USER_ID, restorableUserId } from "../user-ids";
import {
  ACTIVITY_GRANULARITY_MS, BOT_PREFIX, DEFAULT_ROOM_TITLE, DEFAULT_THREAD_TITLE, EMPTY_ROOM_SCAN, IDLE_PRUNE_BATCH, IDLE_PRUNE_RUNS_PER_DAY,
  LIMITER_IDLE_MS, LISTED_PRIVATE_ROOMS, LIVE_KINDS, LIVE_WRITES, MAX_CARRIED_PASSKEYS, MAX_MEMBERSHIP_ROWS, MAX_PURGE_ROOMS,
  MAX_PUSH_SUBSCRIPTIONS_PER_USER, MAX_PUSH_WAKES_PER_USER, MAX_SAFE_ID, MEMBERSHIP_COUNT_READS, MEMBERSHIP_LIMIT_MESSAGE, MINUTE_MS,
  MOVE_REACTION_SETS_PER_POST, PRESSURE_CLEANUP_RETRY_MS, PRIVATE_ROOM_COUNT_READS, PRIVATE_ROOM_ROWS, publicRoomRows,
  RESTORE_ENTRIES_BATCH, RESTORE_ENTRIES_SINGLE, RESTORE_FUTURE_MS, RESTORE_RECORDS_BATCH, RESTORE_REPLAY_CAP, RESTORE_USERS_BATCH,
  REMOVED_RING, RETAINED_SCAN_CAP, RETIRED_MARKER_MARGIN, RETIRED_SWEEP_BATCH, roomCountReads, ROOM_NOTES_NAMED, ROOM_TITLE, UPLOAD_WRITES,
} from "./limits";
import type { AccountUsageSnapshot } from "../account-usage";
import type { ChatRecord } from "../history/records";
import {
  type ArchivedRoom, type ArchivedUser, parseLogId, type ReplayedMembership, replayRecords, roomClientFields, type RoomListing,
} from "@apron/archive";
import { clientUserExt, MAX_USER_EXT_BYTES, mergeExt, recordedUser, userExtFits } from "../content/user";
import { isEmptyBody, type MessageBody } from "../content/body";
import { hasAppend, messageContent, sharesText, withEditedBy } from "../content/snapshot";
import { liveResultEmbed, terminalOg, uploadResultEmbed, uploadTitle } from "../content/embeds";
import type { LiveKind } from "../live-text";
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
  /** Most public rows a listing reads (limits.ts publicRoomRows). */
  private get publicRoomRows(): number {
    return publicRoomRows(this.config.maxThreads);
  }
  /**
   * Most rooms one `room_list` names, whose members roomMembers fills in:
   * `general`, the created rooms, the listed threads and the caller's private
   * rooms, or a user's own listing (MAX_USER_ROOMS), whichever is more.
   */
  private get listedRoomBound(): number {
    return Math.max(MAX_USER_ROOMS, 1 + MAX_CREATED_ROOMS + this.listedThreadCount + this.config.maxPrivateMembershipsPerUser);
  }
  /** Reads for counting a kind's rooms created within the window (limits.ts roomCountReads). */
  private get roomCountReads(): number {
    return roomCountReads(this.config.maxThreads);
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

  /** The rooms one roomMembers call read, when nothing is kept. */
  private readonly uncachedMembers = new Map<string, MemberCacheEntry>();

  /** What this server takes as content, for a post and an import alike (content/policy.ts), from its limits. */
  readonly content: ContentPolicy;
  /** The caches the modules keep that a transaction puts back as it rolls back (StoreCore.journal). */
  private readonly journals: TransactionJournal[] = [];
  /** What a reservation's callback queries through (core.ts): this store's metered SQL and shared lookups. */
  private readonly sqlHandle: Sql = {
    rows: (query, ...bindings) => this.rawRows(query, ...bindings),
    exec: (query, ...bindings) => this.rawExec(query, ...bindings),
    transaction: (fn) => this.transaction(fn),
    metaValue: (key) => this.metaValue(key),
    metaNumber: (key) => this.metaNumber(key),
    writeMeta: (key, value) => this.writeMeta(key, value),
    metaJson: (key, decode, fallback) => this.metaJson(key, decode, fallback),
    holdsAnyRole: (userId) => this.holdsAnyRole(userId),
    peekLimitRow: (scope, key) => this.limiters.peek(scope, key),
    identityRow: (userId) => this.identityRow(userId),
    holdsRole: (userId, roles) => this.holdsRole(userId, roles),
    isMember: (roomId, userId) => this.isMember(roomId, userId),
    logState: () => this.logState(),
    currentMessage: (messageId, floor) => this.currentMessage(messageId, floor),
    ensureGrowthCapacity: (bytes) => this.ensureGrowthCapacity(bytes),
    writeSeen: (userId, seen) => this.writeSeen(userId, seen),
    metaRange: (start, end, limit) => this.metaRange(start, end, limit),
    publishedFloor: () => this.publishedFloor(),
    roomRow: (roomId) => this.roomRow(roomId),
    maintenanceRow: () => this.maintenanceRow(),
    retainedEmbed: (messageId, embedId) => this.retainedEmbed(messageId, embedId),
    visibleRoomRow: (roomId, userId) => this.visibleRoomRow(roomId, userId),
    messageReference: (value, field, floor, options) => this.messageReference(value, field, floor, options),
    commitLivePost: (input, effective, entry) => this.commitLivePost(input, effective, entry),
    rewriteEmbed: (message, snapshot, embedId, replacement, now, text) => this.rewriteEmbed(message, snapshot, embedId, replacement, now, text),
    settleSeen: (userId, at) => this.settleSeenRow(userId, at),
    limitRow: (scope, key, now) => this.limitRow(scope, key, now),
    updateLimitRow: (row, updates, now, weight) => this.updateLimitRow(row, updates, now, weight),
  };
  /** The core the implementation modules run over (core.ts). */
  readonly core: StoreCore = this.makeCore();
  /** Room caps: the counts of rooms and memberships a creation, join or restore is checked against (room-caps.ts). */
  readonly caps: RoomCapsModule;
  /** History: pages of the log, the head's records and floors, the chain's state, rewrite log, chunk index and import journal (history-log.ts). */
  readonly historyLog: HistoryModule;
  /** Open live texts: their start, claim, finish and expiry (live-text.ts). */
  readonly live: LiveTextModule;
  /** Uploads in R2, avatars, the server's metadata, custom emoji and toggles (uploads.ts). */
  readonly uploads: UploadsModule;
  /** Read cursors, user statuses and mutes, room mutes, `seen` and the presence toggle (reads.ts). */
  readonly readState: ReadsModule;
  /** Rate limits and admission: the posting, event and registration charges, frames, connections, throttle trips, the attack pause (admission.ts). */
  readonly admission: AdmissionModule;
  /** Web Push registrations, wakes and claims (push.ts). */
  readonly pushes: PushModule;

  private makeCore(): StoreCore {
    // The getters read the store's config and clock as they are now (a test may replace them).
    const store = this;
    return {
      get config() { return store.config; },
      get clock() { return store.clock; },
      get alerting() { return store.alerting; },
      alert: (fn) => this.alert(fn),
      unmetered: (fn) => fn(this.sqlHandle),
      patchMemberSeen: (userId, seen) => this.patchMemberSeen(userId, seen),
      degraded: (now) => this.degraded(now),
      knownFloors: () => this.knownFloors(),
      ensureReady: () => this.ensureReady(),
      effectiveNow: (candidate) => this.effectiveNow(candidate),
      checkMaintenance: (cost, now) => this.checkMaintenance(cost, now),
      reserved: (operation, cost, maintenance, now, fn, unchecked) => this.reserved(operation, cost, maintenance, now, (unused) => fn(this.sqlHandle, unused), unchecked),
      assertNotDegraded: (feature, now) => this.assertNotDegraded(feature, now),
      journal: (journal) => { this.journals.push(journal); },
    };
  }

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
    this.pushes = new PushModule(this.core);
    this.admission = new AdmissionModule(this.core);
    this.readState = new ReadsModule(this.core, this.pushes);
    this.uploads = new UploadsModule(this.core);
    this.live = new LiveTextModule(this.core, this.admission, this.uploads);
    this.historyLog = new HistoryModule(this.core, this.admission);
    this.caps = new RoomCapsModule(this.core);
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
   * the name its reservation carries. Maintenance work,
   * operator alerts and admin (`unchecked`) work are never refused, nor the
   * operations every request passes through (BREAKER_EXEMPT).
   */
  private assertBreaker(operation: string, now: number): void {
    let open = false;
    for (const end of Object.values(this.guard.breakers)) if (end > now) open = true;
    if (!open) return;
    const until = this.guard.breakers[operation];
    if (until === undefined || until <= now || BREAKER_EXEMPT.has(operation)) return;
    throw new StoreError("retry_after", "This action is paused after it used more storage than expected; try again later", {
      retryAfterMs: Math.max(1_000, until - now),
      data: { reason: OPERATION_PAUSED },
    });
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
    const operation = reserved.operation ?? "unknown";
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
    this.uploads.emojiCache = null;
    this.historyLog.forgetState();
    this.historyLog.forgetChunkIndexes();
    this.live.liveCache = undefined;
    this.uploads.serverCache = null;
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
    for (const journal of this.journals) journal.begin();
    const logCache = this.logCache;
    try {
      const result = this.transactionInner(fn);
      this.limiters.commit();
      for (const journal of this.journals) journal.commit();
      return result;
    } catch (error) {
      // The rows the transaction wrote are rolled back: so are the cached ones
      // it changed, the log head its commit kept (finishCommit), and the
      // modules' caches (journal: the open live texts it saved).
      this.limiters.rollback();
      for (const journal of this.journals) journal.rollback();
      this.logCache = logCache;
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
   * `operation` names it, for overruns and breakers (accounting.ts).
   */
  private reserveCost(operation: string, costInput: CostEstimate, maintenance = false, now = this.clock.now(), unchecked = false): BudgetCost {
    this.ensureReady();
    this.assertAccounting();
    if (!maintenance && !unchecked && !this.alerting) this.assertBreaker(operation, now);
    const cost = this.ledger.reserve(costInput, Math.max(Math.trunc(now), this.lastEffectiveMs), now, maintenance, unchecked || this.alerting);
    cost.operation = operation;
    this.countReservation(cost);
    return cost;
  }

  /**
   * Refuses as reserved and reserveCost would refuse a maintenance
   * reservation of `costInput` (closed accounting, a spent maintenance
   * budget: a maintenance reservation has no breaker), reserving nothing
   * (StoreCore.checkMaintenance). With no budget row cached yet (after a
   * wake, a start or a reset), the ledger can't answer from memory, so this
   * makes the (empty) maintenance reservation itself, which reads the row
   * and refuses exactly as the reservation it stands for would.
   */
  private checkMaintenance(costInput: CostEstimate, now: number): void {
    this.ensureReady();
    this.assertAccounting();
    if (this.alerting) return;
    if (this.ledger.checkReservation(costInput, Math.max(Math.trunc(now), this.lastEffectiveMs), true)) return;
    this.reserved("unknown", costInput, true, now, () => undefined);
  }

  /** Spend the maintenance control gap when ordinary work is exhausted. */
  private reserveMaintenanceControl(operation: string, costInput: CostEstimate, now: number): BudgetCost {
    this.ensureReady();
    this.assertAccounting();
    const cost = this.ledger.reserveControl(costInput, Math.max(Math.trunc(now), this.lastEffectiveMs));
    cost.operation = operation;
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
    return this.reserved("usersWithRole", { reads: 2 * this.config.registeredAccounts + 64 }, false, now, () =>
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
    const reserved = this.reserveCost("unknown", cost, kind === "maintenance", now);
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
    this.reserveCost("unknown", cost, kind === "maintenance", now);
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
  private reserved<T>(operation: string, cost: CostEstimate, maintenance: boolean, now: number, fn: (unused: { history: number }) => T, unchecked = false): T {
    this.assertAccounting();
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    const reservation = this.reserveCost(operation, cost, maintenance, now, unchecked);
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
    this.reserved("persistAccountUsageSnapshot", { reads: 8, writes: 8 }, true, now, () => {
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
    return this.alert(() => this.reserved("status", { reads: 16 }, false, now, () => {
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

  /** The server tier last announced to the admins (the runtime's record), or "" before any. */
  announcedTier(now = this.clock.now()): string {
    this.ensureReady();
    return this.alert(() => this.reserved("announcedTier", { reads: 4 }, false, now, () => this.metaValue(META_ANNOUNCED_TIER), true));
  }

  /** Records the server tier just announced (announcedTier): charged, never refused. */
  setAnnouncedTier(value: string, now = this.clock.now()): void {
    this.ensureReady();
    this.alert(() => this.reserved("setAnnouncedTier", { reads: 4, writes: 4 }, false, now, () => {
      this.writeMeta(META_ANNOUNCED_TIER, value);
    }, true));
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
    this.alert(() => this.reserved("setStorageAlerted", { reads: 4, writes: 4 }, false, now, () => {
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
    this.alert(() => this.reserved("setRoomNotesAlerted", { reads: 4, writes: 4 }, false, now, () => {
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
    return this.reserved("listRooms", { reads: this.roomListingReads() + (withPrivate ? 4 * PRIVATE_ROOM_ROWS : 0) }, options.maintenance === true, now, () => {
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
    return this.reserved("allRooms", { reads: 32 + 2 * rows }, true, now, () => {
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
    return this.reserved("getRoom", { reads: 16 }, false, now, () => {
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
    return this.reserved("privateRoomsOf", { reads: 16 + 3 * (MAX_USER_ROOMS + MAX_PURGE_ROOMS) }, false, now, () => {
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
    return this.reserved("roomCreator", { reads: 16 }, false, now, () => {
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
    return this.reserved("logBounds", { reads: 8 }, false, this.clock.now(), () => {
      const state = this.logState();
      return { latest_log_id: idString(state.last_log_id), history_floor: idString(this.publishedFloor()) };
    });
  }

  /** The floors historyFloors reports, where the log head and the published floor are both in memory already: no SQL. */
  private knownFloors(): { hot: number; published: number; latest: number } | undefined {
    if (!this.logCache || (this.config.tiered && this.publishedCache === undefined)) return undefined;
    return { hot: this.logCache.history_floor, published: this.publishedFloor(), latest: this.logCache.last_log_id };
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
   * Raises the published floor (HistoryHead.publish), never past the hot
   * floor: history starts there from now on. Rooms whose whole log is below
   * it go on the next cleanup, made due now.
   */
  publishHistoryFloor(floor: number, now = this.clock.now()): void {
    this.ensureReady();
    if (!this.config.tiered) return;
    this.reserved("publishHistoryFloor", { reads: 16, writes: 8 }, true, now, () => {
      const published = Math.min(floor, this.logState().history_floor);
      if (published <= this.publishedFloor()) return;
      this.writeMeta(META_HISTORY_PUBLISHED, String(published));
      this.publishedCache = published;
      this.writeMeta(META_HISTORY_ROOMS_DUE, "1");
      this.cleanupDueCache = undefined;
      this.rawExec("UPDATE maintenance SET next_cleanup_ms = MIN(next_cleanup_ms, ?) WHERE id = 1", this.effectiveNow(now));
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
    this.reserved("dropReactionsOn", { reads: 64 + 2 * records, writes: 64 + 4 * records }, true, now, () => this.transaction(() => {
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
    return this.reserved("isRetiredUserId", { reads: 8 }, true, now, () => this.retiredUserId(userId));
  }

  /**
   * Whether `/purge` or the idle prune retired this `user_id` (`purged:`) and
   * it is not yet freed: no identity has it, and what is still logged under
   * it is its own. One `_meta` read.
   */
  purgedUserId(userId: string, now = this.clock.now()): boolean {
    this.ensureReady();
    return this.reserved("purgedUserId", { reads: 4 }, true, now, () => this.metaValue(META_PURGED_PREFIX + userId) !== "");
  }

  /**
   * Whether `/purge` removed this `user_id` and what it left (`removed:`),
   * not yet freed: nothing is logged under it since. One `_meta` read.
   */
  removedUserId(userId: string, now = this.clock.now()): boolean {
    this.ensureReady();
    return this.reserved("removedUserId", { reads: 4 }, true, now, () => this.metaValue(META_REMOVED_PREFIX + userId) !== "");
  }

  /**
   * The `user_id`s `/purge` removed at or after log position `after` and not
   * yet freed, oldest first, at most `limit`. At: a purge logs nothing, so its
   * marker is the head a client saw everything up to; told again, a removal
   * changes nothing. Above the floor of the newest REMOVED_RING (`removed_at:`),
   * a range read of what it returns; at or below it, where some were dropped
   * from those, every `removed:` marker is read: only a client away across
   * that many purges pays for it.
   */
  removedSince(after: number, limit: number, now = this.clock.now()): string[] {
    this.ensureReady();
    const floor = this.metaValue(META_REMOVED_FLOOR);
    if (floor === "" || after > Number(floor)) {
      return this.reserved("removedSince", { reads: 16 + REMOVED_RING }, true, now, () => this.rawRows<{ key: string }>(
        "SELECT key FROM _meta WHERE key >= ? AND key < ? ORDER BY key LIMIT ?", removedAtKey(after, ""), META_REMOVED_AT_PREFIX.slice(0, -1) + ";", limit,
      ).map((row) => row.key.slice(row.key.indexOf(":", META_REMOVED_AT_PREFIX.length) + 1)));
    }
    const end = META_REMOVED_PREFIX.slice(0, -1) + ";";
    return this.reserved("removedSinceAll", { reads: 16 + limit }, true, now, () => this.rawRows<{ key: string }>(
      "SELECT key FROM _meta WHERE key >= ? AND key < ? AND CAST(value AS INTEGER) >= ? ORDER BY CAST(value AS INTEGER), key LIMIT ?", META_REMOVED_PREFIX, end, after, limit,
    ).map((row) => row.key.slice(META_REMOVED_PREFIX.length)));
  }

  /** Keeps the newest REMOVED_RING `removed_at:` keys, raising META_REMOVED_FLOOR to the newest it drops. In a transaction. */
  private trimRemovedRing(): void {
    const dropped = this.rawRows<{ key: string }>(
      "SELECT key FROM _meta WHERE key >= ? AND key < ? ORDER BY key DESC LIMIT -1 OFFSET ?", META_REMOVED_AT_PREFIX, META_REMOVED_AT_PREFIX.slice(0, -1) + ";", REMOVED_RING,
    ).map((row) => row.key);
    if (!dropped.length) return;
    for (const key of dropped) this.rawExec("DELETE FROM _meta WHERE key = ?", key);
    const newest = Number(dropped[0].slice(META_REMOVED_AT_PREFIX.length, META_REMOVED_AT_PREFIX.length + 16));
    const floor = this.metaValue(META_REMOVED_FLOOR);
    if (floor === "" || newest > Number(floor)) this.writeMeta(META_REMOVED_FLOOR, String(newest));
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
    return this.reserved("exportMembers", { reads: 8 + max }, true, now, () => {
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
    return this.reserved("restoreMembers", cost, true, now, () => this.transaction(() => {
      if (!this.roomRow(roomId)) throw new StoreError("invalid_params", `No room ${roomId} to restore members into`.slice(0, 200));
      const member = (userId: string) => this.rawRows("SELECT 1 FROM memberships WHERE room_id = ? AND user_id = ? LIMIT 1", roomId, userId).length > 0;
      let joined = 0;
      let left = 0;
      let skipped = 0;
      for (const userId of new Set(changes.join)) {
        if (member(userId)) continue;
        if (!this.identityRow(userId) || this.caps.membershipCount(this.sqlHandle, userId) >= MAX_MEMBERSHIPS_PER_USER ||
          (isPrivate && this.caps.privateMembershipCount(this.sqlHandle, userId) >= this.config.maxPrivateMembershipsPerUser)) {
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
    return this.reserved("restoreUsers", { reads: 32 + 8 * unique.size, writes: 16 + 8 * unique.size }, true, now, () => this.transaction(() => {
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
    const probe = this.reserved("restoreRoom", { reads: 48 + 4 * batch.length + 2 * (RESTORE_REPLAY_CAP + 1) }, true, now, () => {
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
    return this.reserved("restoreRoom", cost, true, now, () => this.transaction(() => {
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
        const old = createdLogId < this.caps.creationCutoff(effective);
        const slot = (kind: "public" | "private"): boolean => old || this.caps.roomSlotFree(this.sqlHandle, kind, effective);
        if (isPrivate) {
          if (parentRoomId !== null) throw new StoreError("invalid_params", "A private room cannot be a thread on this server");
          if (this.config.maxPrivateRooms === 0) throw new StoreError("unsupported", "Private rooms are not supported on this server");
          if (!slot("private")) throw new StoreError("denied", this.caps.privateRoomLimitMessage());
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
          if (this.caps.membershipCount(this.sqlHandle, userId) >= MAX_MEMBERSHIPS_PER_USER ||
            (isPrivate && this.caps.privateMembershipCount(this.sqlHandle, userId) >= this.config.maxPrivateMembershipsPerUser)) {
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
   * Whether a room exists with nothing logged past its creation: the seeded
   * `general` of a new server, which an import may fill (restoreRoom merges).
   */
  roomIsEmpty(roomId: string, now = this.clock.now()): boolean {
    this.ensureReady();
    return this.reserved("roomIsEmpty", { reads: 8 + EMPTY_ROOM_SCAN }, true, now, () => {
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
    return this.reserved("identityExists", { reads: 4 }, false, this.clock.now(), () => this.identityRow(userId) !== null);
  }

  /**
   * Whether a `user_id` may not be issued: an identity has it, `/rename`
   * retired it, or `/purge` or the idle prune retired it and it is not yet
   * freed (dueRetiredUserIds). Registration picks ids with it.
   */
  userIdTaken(userId: string): boolean {
    this.ensureReady();
    return this.reserved("userIdTaken", { reads: 8 }, false, this.clock.now(), () => this.idTaken(userId));
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
    const found = this.reserved("renameIdentity", { reads: 64 + 8 * records + 2 * (MAX_PUSH_SUBSCRIPTIONS_PER_USER + MAX_PUSH_WAKES_PER_USER + 1 + MAX_ROOM_MUTES_PER_USER) + 2 * (this.caps.roomRowCount(this.sqlHandle) + MAX_PURGE_ROOMS) }, false, now, () => {
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
    return this.reserved("renameIdentity", cost, false, now, () => this.transaction(() => {
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
      this.historyLog.queueHistoryRewrites(this.sqlHandle, [{ user: from, into: to }]);
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
    return this.reserved("retainedRecords", { reads: 16 + cap + 1 }, false, now, () => {
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
   * it knows the connections still in them, as is telling the clients connected
   * to forget them (§3.3.3). Returns what went, and the R2 objects the caller
   * deletes.
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
    const uploadsPerOwner = Math.max(...ids.map((id) => this.uploads.uploadsPerOwner(id)));
    // Per user: memberships (live and awaiting a room purge), a day's dedup
    // rows, limiter rows, push subscriptions, credential and identity; each
    // deletion also updates its indexes.
    const perUser = 64 + 8 * MAX_MEMBERSHIP_ROWS + 4 * Math.max(this.config.registeredPostsPerDay, this.config.trustedPostsPerDay) + 4 * uploadsPerOwner +
      4 * (MAX_PUSH_SUBSCRIPTIONS_PER_USER + MAX_PUSH_WAKES_PER_USER + 1 + MAX_ROOM_MUTES_PER_USER);
    // Every room row is read for its creator, and each one theirs rewritten.
    const roomRows = this.caps.roomRowCount(this.sqlHandle) + MAX_PURGE_ROOMS;
    const cost = { reads: 64 + 5 * records + 2 * roomRows + ids.length * perUser, writes: 64 + 4 * records + 2 * roomRows + ids.length * perUser };
    return this.reserved("purgeUsers", cost, false, now, () => this.transaction(() => {
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
      this.historyLog.queueHistoryRewrites(this.sqlHandle, ids.map((user) => ({ user, into: null, messages })));
      const uploads = this.rawRows<RawUploadRow>(
        `SELECT upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms
         FROM uploads INDEXED BY uploads_owner_idx WHERE owner_id IN (${marks})`,
        ...ids,
      );
      const deletedUploads = this.uploads.releaseUploadRows(this.sqlHandle, uploads);
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
      // Removed for good, and announced as such: those with an identity, and
      // ids a purge or the idle prune retired before (what the idle prune kept is gone now).
      const removed = ids.filter((id) => retired.includes(id) || this.metaValue(META_PURGED_PREFIX + id) !== "");
      for (const userId of retired) this.writeMeta(META_PURGED_PREFIX + userId, String(this.logState().last_log_id));
      const position = this.logState().last_log_id;
      for (const userId of removed) {
        this.writeMeta(META_REMOVED_PREFIX + userId, String(position));
        this.writeMeta(removedAtKey(position, userId), "");
      }
      if (removed.length) this.trimRemovedRing();
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
      this.reserved("noteActive", { reads: 4, writes: 4 }, false, now, () => {
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
    const state = this.reserved("pruneIdleIdentities", { reads: 8, writes: 4 }, true, now, () => {
      const since = Number(this.metaValue(META_IDLE_ACTIVITY_SINCE));
      if (!Number.isFinite(since) || since <= 0) {
        this.writeMeta(META_IDLE_ACTIVITY_SINCE, String(now));
        return { ...progress(), waiting: true };
      }
      return { ...progress(), waiting: now - since < this.config.idleAccountMs };
    }, false);
    if (state.waiting || state.done || state.runs >= IDLE_PRUNE_RUNS_PER_DAY) return { pruned: [], more: false };
    const record = (done: boolean) => this.reserved("pruneIdleIdentities", { reads: 4, writes: 4 }, true, now, () => {
      const current = progress();
      this.writeMeta(META_IDLE_PRUNE_DAY,
        JSON.stringify({ day: today, runs: current.runs + 1, done: done || current.runs + 1 >= IDLE_PRUNE_RUNS_PER_DAY }));
    }, false);
    const cutoff = now - this.config.idleAccountMs;
    // Ranking reads every identity twice, each with its passkeys and a bot
    // lookup; bots and the admin are identities beyond the cap.
    const perIdentity = 2 * (3 + MAX_PASSKEYS_PER_USER);
    const found = this.reserved("pruneIdleIdentities", { reads: 64 + perIdentity * (2 * this.config.registeredAccounts + 1) + 16 * IDLE_PRUNE_BATCH }, true, now, () => {
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
    const roomRows = this.caps.roomRowCount(this.sqlHandle) + MAX_PURGE_ROOMS;
    const cost = {
      reads: 64 + 2 * found.rows + 2 * roomRows + 2 * limiterRows + 4 * ids.length,
      writes: 64 + 4 * found.rows + 2 * roomRows + 2 * limiterRows + 8 * ids.length,
    };
    try {
      this.reserved("pruneIdleIdentities", cost, true, now, () => this.transaction(() => {
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
    return this.alert(() => this.reserved("idlePruned", { reads: 4 }, false, now, () => {
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
    return this.reserved("dueRetiredUserIds", { reads: 16 + 4 * this.config.registeredAccounts, writes: 8 + 4 * RETIRED_SWEEP_BATCH }, true, now, () => this.transaction(() => {
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
    this.reserved("freeRetiredUserIds", { reads: 8 + 2 * userIds.length, writes: 8 + 4 * userIds.length }, true, now, () => {
      this.rawExec("DELETE FROM _meta WHERE key IN (SELECT ? || value FROM json_each(?))", META_PURGED_PREFIX, JSON.stringify(userIds));
      for (const userId of userIds) {
        const position = this.metaValue(META_REMOVED_PREFIX + userId);
        if (position !== "") this.rawExec("DELETE FROM _meta WHERE key = ?", removedAtKey(Number(position), userId));
      }
      this.rawExec("DELETE FROM _meta WHERE key IN (SELECT ? || value FROM json_each(?))", META_REMOVED_PREFIX, JSON.stringify(userIds));
    }, false);
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
    return this.reserved("getIdentity", { reads: 16 + this.userRoomsReads() }, false, this.clock.now(), () => {
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
      this.reserved("roomMembers", { reads: 8 + missing.length * (4 + (withStatus ? 3 : 2) * perRoom) }, false, now, () => {
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
    return this.reserved("roomMember", { reads: 8 + (withStatus ? 3 : 2) }, false, now, () => {
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
    return this.reserved("getCredential", { reads: 8 }, false, this.clock.now(), () => this.credentialValue(credentialId));
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
    return this.reserved("countIdentities", { reads: 8 }, false, this.clock.now(), () => this.metaNumber("identity_count"));
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
    return this.reserved("restoreRoomCapacity", { reads: 24 + MAX_CREATED_ROOMS + listings.length + 2 * this.roomCountReads }, true, now, () => {
      const privates = listings.filter((listing) => isPrivateRoomId(listing.room_id));
      const publics = listings.filter((listing) => !isPrivateRoomId(listing.room_id));
      const topLevel = publics.filter((listing) => typeof listing.parent_room_id !== "string");
      // A room created before roomCreationWindowMs takes no slot (restoreRoom):
      // its creation is the lowest of its listing's log_id and history_log_id,
      // and of its records, which planning has not read, so without the
      // listing's it counts: the import never finds a cap mid-write.
      const cutoff = this.caps.creationCutoff(now);
      const recent = (listing: RoomListing): boolean => {
        const known = [parseLogId(listing.log_id), parseLogId(listing.history_log_id)].filter((logId): logId is number => logId !== undefined);
        return !known.length || Math.min(...known) >= cutoff;
      };
      if (privates.length) {
        if (this.config.maxPrivateRooms === 0) return "this archive has private rooms, and private rooms are not supported on this server";
        const used = this.caps.recentRoomCount(this.sqlHandle, "private", now);
        const adding = privates.filter(recent).length;
        if (used + adding > this.config.maxPrivateRooms) return `this archive would add ${adding} recently created private rooms, but there is room for ${Math.max(0, this.config.maxPrivateRooms - used)} more (${used} of ${this.config.maxPrivateRooms})`;
      }
      if (topLevel.length) {
        const used = this.rawRows(`SELECT room_id FROM rooms WHERE ${roomKind(0)} LIMIT ?`, MAX_CREATED_ROOMS + 2).length;
        // restoreRoom refuses a top-level room once more than MAX_CREATED_ROOMS are here before it.
        if (used + topLevel.length - 1 > MAX_CREATED_ROOMS) return `this archive would add ${topLevel.length} top-level rooms, but there is room for ${Math.max(0, MAX_CREATED_ROOMS + 1 - used)} more (room_limit)`;
      }
      if (publics.length) {
        const used = this.caps.recentRoomCount(this.sqlHandle, "public", now);
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
    return this.reserved("accountCapacity", { reads: 8 }, true, now, () => ({ used: this.metaNumber("identity_count"), limit: this.config.registeredAccounts }));
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
    const reservation = this.reserveCost("registerIdentity", { reads: 128 + 6 * starting.length, writes: 64 + 8 * starting.length, registrations: 1 }, false, input.now);
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
        this.admission.chargeRegistration(this.sqlHandle, input.ipKey, effective);
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
    const reservation = this.reserveCost("addCredential", { reads: 96, writes: 48, registrations: 1 }, false, input.now);
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
        this.admission.chargeRegistration(this.sqlHandle, input.ipKey, effective);
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
    return this.reserved("ensureUserHandle", { reads: 8, writes: 8 }, false, now, () => this.transaction(() => {
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
    return this.reserved("passkeys", { reads: 8 + 2 * MAX_PASSKEYS_PER_USER }, false, now, () => this.rawRows<{ credential_id: string; created_ms: number; updated_ms: number }>(
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
    return this.reserved("removePasskey", { reads: 8 + 2 * MAX_PASSKEYS_PER_USER, writes: 16 }, false, input.now ?? this.clock.now(), () => this.transaction(() => {
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
   * handle, for `/invite-reset`: the passkey sessions issued under the old
   * handle no longer resume, and a passkey registered later takes a new one.
   * Returns how many passkeys were removed.
   */
  resetAuth(input: { userId: string; now?: number }): number {
    this.ensureReady();
    const now = input.now ?? this.clock.now();
    return this.reserved("resetAuth", { reads: 16 + 2 * MAX_PASSKEYS_PER_USER, writes: 16 + 4 * MAX_PASSKEYS_PER_USER }, false, now, () => this.transaction(() => {
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
    return this.reserved("credentialIdsForUser", { reads: 32 }, false, this.clock.now(), () => {
      const rows = this.rawRows<{ credential_id: string }>("SELECT credential_id FROM credentials WHERE user_id = ? ORDER BY credential_id LIMIT 16", userId);
      return rows.map((row) => row.credential_id);
    });
  }

  updateCredentialCounter(credentialId: string, counter: number): void {
    if (!Number.isSafeInteger(counter) || counter < 0) throw new StoreError("invalid_params", "invalid credential counter");
    this.ensureReady();
    this.reserved("updateCredentialCounter", { reads: 8, writes: 8 }, false, this.clock.now(), () => {
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

  /** The `_meta` entries with keys from `start` up to `end`, in key order, at most `limit`. */
  private metaRange(start: string, end: string, limit: number): Array<[string, string]> {
    return this.rawRows<{ key: string; value: string }>(
      "SELECT key, value FROM _meta WHERE key >= ? AND key < ? ORDER BY key LIMIT ?", start, end, limit,
    ).map((row) => [row.key, row.value] as [string, string]);
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
    return this.reserved("topLevelRoomIds", { reads: this.roomListingReads() }, false, now, () => this.rawRows<{ room_id: string }>(
      `SELECT room_id FROM rooms WHERE ${roomKind(0)} ORDER BY created_log_id ASC LIMIT ?`, MAX_CREATED_ROOMS + 1,
    ).map((row) => row.room_id));
  }

  private identityForMessage(input: StoreMutationInput): Identity {
    const name = typeof input.identity.name === "string" ? input.identity.name : undefined;
    return { user_id: input.identity.user_id, ...(name ? { name } : {}) };
  }

  /** A new message with no text and no embeds, which is `invalid_params` (§3.5.1). */
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
    const existing = this.reserved("registerBot", { reads: 16 }, false, input.now, () => {
      const owner = this.identityRow(input.ownerId);
      // A bot, an owner's or one made by `/role … bot`, owns no bot of its own.
      if (!owner || owner.tier !== "registered" || parseRoles(owner.roles_json).includes("bot")) throw new StoreError("denied", "Only registered users may invite a bot");
      return this.identityRow(input.botId);
    });
    if (existing) {
      if (existing.tier !== "bot") throw new StoreError("internal_error", "bot identity is taken");
      const renamed = existing.name !== input.name;
      if (renamed) {
        this.reserved("registerBot", { reads: 8, writes: 8 }, false, input.now, () => {
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
    return this.reserved("setRole", { reads: 12, writes: 4 }, false, input.now ?? this.clock.now(), () => this.transaction(() => {
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
    this.reserved("markBotActive", { reads: 4, writes: 4 }, false, now, () => {
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
    this.reserved("markBotSignedOut", { reads: 4, writes: 4 }, true, now, () => {
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
    const { due, identities } = this.reserved("idleBots", { reads: 4 }, true, input.now, () => ({
      due: this.metaValue(META_BOT_SWEEP), identities: this.metaNumber("identity_count"),
    }));
    if (due !== "" && this.effectiveNow(input.now) < Number(due)) return null;
    // A scan of every identity row, the sort reading each idle bot's again,
    // and the next due time.
    return this.reserved("idleBots", { reads: 16 + 2 * identities, writes: 4 }, true, input.now, () => {
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
    const existing = this.reserved("ensureAdminUser", { reads: 8 }, false, input.now, () => this.identityRow(input.userId));
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
    if (this.reserved("createInvitedIdentity", { reads: 8 }, false, input.now, () => this.idTaken(input.userId))) {
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
    const reservation = this.reserveCost("createKeylessIdentity", { reads: 128, writes: 72, registrations: 1 }, false, input.now);
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
        if (!alerting) this.admission.chargeRegistration(this.sqlHandle, input.ipKey, effective);
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
    const reserved = this.reserveCost("changeMembership", { reads: 64 + (privateJoin ? 2 : 1) * this.userRoomsReads() + (input.join ? MEMBERSHIP_COUNT_READS : 0), writes: 64, posts: 1 }, false, operationNow);
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
        if (privateJoin && this.caps.privateMembershipCount(this.sqlHandle, input.userId) >= this.config.maxPrivateMembershipsPerUser) {
          throw new StoreError("denied", `${input.userId} is in as many private rooms as anyone may be, so cannot be added to another`.slice(0, 200));
        }
        if (input.join && this.caps.membershipCount(this.sqlHandle, input.userId) >= MAX_MEMBERSHIPS_PER_USER) throw new StoreError("denied", MEMBERSHIP_LIMIT_MESSAGE);
        this.admission.chargePosting(this.sqlHandle, { userId: input.actorId ?? input.userId, tier: "registered", ipKey: input.ipKey, now: effective });
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
    this.reserved("chargeGuestMembership", { reads: 32, writes: 32, posts: 1 }, false, operationNow, () => {
      const effective = this.effectiveNow(operationNow);
      this.transaction(() => this.admission.chargePosting(this.sqlHandle, { userId: "", tier: "anonymous", ipKey: input.ipKey, now: effective }));
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
    return this.reserved("removeEmptyThread", { reads: 16, writes: 8 }, false, now, () => this.transaction(() => {
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
   * A live text command's message, posted as its write is claimed
   * (claimLiveText, live-text.ts, through the Sql handle's commitLivePost):
   * one commit of the log at `effective`, its new live embed `entry`'s.
   */
  private commitLivePost(input: StoreMutationInput, effective: number, entry: LiveEntry): StoreMutationResult {
    const state = this.logState();
    const startLogId = state.last_log_id;
    const context: CommitContext = { state, commitMs: Math.max(effective, state.last_commit_ms), touched: new Map() };
    const committed = this.commitMessage(input, context, state.history_floor, entry);
    this.finishCommit(context, startLogId);
    return committed;
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
      if (this.config.uploads) deletedUploads = this.uploads.releaseUploadRows(this.sqlHandle, this.uploads.messageUploads(this.sqlHandle, messageId, identified.removed));
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
          entry = this.live.startLiveText(this.sqlHandle, kind, input, now, { messageId, embedId: id, text });
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
      const upload = this.uploads.startUpload(this.sqlHandle, "file", userId, now, { messageId, embedId: id });
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
    const liveEnded = endedIds.length ? this.live.dropLiveTexts(this.sqlHandle, (entry) => entry.messageId === messageId && endedIds.includes(entry.embedId)) : [];
    return { embeds: identified, writes, uploads, removed, liveStarted, liveEnded };
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
   * The author of a retained message, for waking the user a reply answers
   * (protocol §4.9 `replies`): one indexed read of its current state. Null
   * for an unknown or expired message.
   */
  messageAuthor(messageId: string, now = this.clock.now()): string | null {
    this.ensureReady();
    return this.reserved("messageAuthor", { reads: 8 }, false, now, () => this.currentMessage(messageId, this.logState().history_floor)?.author_id ?? null);
  }

  /**
   * How many registered members a room has (its row's `member_count`),
   * undefined for an unknown room: one primary-key read. Read receipts go
   * only to rooms of at most MAX_READ_RECEIPT_MEMBERS (roomReadCursors).
   */
  roomMemberCount(roomId: string, now = this.clock.now()): number | undefined {
    this.ensureReady();
    return this.reserved("roomMemberCount", { reads: 8 + 2 }, false, now, () => {
      const row = this.rawRows<{ member_count: number }>("SELECT member_count FROM rooms WHERE room_id = ? LIMIT 1", roomId)[0];
      return row ? integerColumn(row.member_count) : undefined;
    });
  }

  /** settleSeen's statements, in its reservation: `seen` written where the stored one does not stand, and what is stored after. */
  private settleSeenRow(userId: string, at: number): number | undefined {
    // Written only where the stored one does not stand (seenStands, in SQL).
    const cursor = this.sql.exec(
      "UPDATE identities SET seen_ms = ? WHERE user_id = ? AND (seen_ms <= 0 OR seen_ms > ? OR seen_ms < ?)",
      at, userId, at, at - SEEN_WRITE_GRANULARITY_MS,
    );
    this.observed.reads += Math.max(0, cursor.rowsRead ?? 0);
    this.observed.writes += Math.max(0, cursor.rowsWritten ?? 1);
    if ((cursor.rowsWritten ?? 0) > 0) {
      this.patchMemberSeen(userId, at);
      return at;
    }
    // It stands (or the user is unknown; or the SQL adapter does not
    // report rows written, which this read covers too): what is stored.
    const row = this.rawRows<{ seen_ms: number }>("SELECT seen_ms FROM identities WHERE user_id = ? LIMIT 1", userId)[0];
    const stored = row ? seenColumn(row.seen_ms) : undefined;
    if (stored === at) this.patchMemberSeen(userId, at);
    return stored;
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
      if (isEmojiKey(emoji) && !currentSet.includes(emoji) && !this.uploads.loadEmojiCatalog(this.sqlHandle).keys.has(emoji)) {
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
    // A save merges into the room's client fields (§4.2.4): a field it leaves
    // out keeps its value, and an empty one clears it.
    const stored = existing ? parseJson<Record<string, unknown>>(existing.fields_json, {}) : {};
    const keptTitle = existing && titleParam === undefined && typeof stored.title === "string" ? stored.title : undefined;
    const title = keptTitle ?? (typeof titleParam === "string" && titleParam.trim() !== "" ? titleParam : fallbackTitle);
    const description = existing && descriptionParam === undefined
      ? (typeof stored.description === "string" ? stored.description : undefined)
      : typeof descriptionParam === "string" && descriptionParam.trim() !== "" ? descriptionParam : undefined;
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
      if (registered && this.caps.membershipCount(this.sqlHandle, input.userId) >= MAX_MEMBERSHIPS_PER_USER) throw new StoreError("denied", MEMBERSHIP_LIMIT_MESSAGE);
      if (makePrivate) {
        const counts = this.caps.privateRoomCounts(this.sqlHandle, input.userId, this.caps.creationCutoff(context.commitMs));
        if (counts.memberships >= this.config.maxPrivateMembershipsPerUser) {
          throw new StoreError("denied", `You are in ${counts.memberships} private rooms, the most at once; leave one to start another`);
        }
        // So one account cannot take every slot by starting rooms and leaving them to others.
        if (counts.created >= this.config.maxPrivateRoomsPerUser) {
          throw new StoreError("denied", this.config.roomCreationWindowMs > 0
            ? `You can start at most ${this.config.maxPrivateRoomsPerUser} private rooms in ${windowDays(this.config.roomCreationWindowMs)}; try again later`
            : `You can have started at most ${this.config.maxPrivateRoomsPerUser} private rooms at once; one stops counting when everyone has left it`);
        }
        if (!this.caps.roomSlotFree(this.sqlHandle, "private", context.commitMs)) throw new StoreError("denied", this.caps.privateRoomLimitMessage());
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
        if (registered && !this.holdsAnyRole(input.userId) && this.caps.recentThreadsCreatedBy(this.sqlHandle, input.userId, this.caps.creationCutoff(context.commitMs)) >= this.config.maxThreadsPerUser) {
          throw new StoreError("denied", this.config.roomCreationWindowMs > 0
            ? `You can start at most ${this.config.maxThreadsPerUser} threads in ${windowDays(this.config.roomCreationWindowMs)}; try again later`
            : `You can have at most ${this.config.maxThreadsPerUser} threads at once; one stops counting when everyone has left it`);
        }
      }
      const counter = makePrivate ? "private_count" : "thread_count";
      if (!makePrivate && !this.caps.roomSlotFree(this.sqlHandle, "public", context.commitMs)) throw new StoreError("denied", "thread_limit");
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
      // A save merges into the client fields; the creator stays.
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
      const live = this.config.liveText ? this.live.liveTexts(this.sqlHandle) : [];
      stored.embeds = stored.embeds.map((embed: unknown) => {
        if (!isPlainObject(embed) || !isPlainObject(embed.write) || typeof embed.write.key !== "string") return embed;
        const key = embed.write.key;
        if (key.startsWith("l/")) {
          if (live.some((entry) => entry.key === key && entry.state === "pending" && entry.writeExpiresMs >= now)) return embed;
        } else {
          const upload = this.uploads.uploadRow(this.sqlHandle, key);
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
      // Refused (§3.5.1): nothing is logged, charged, or recorded. The room is
      // checked first, so a hidden room answers as a missing one does.
      return this.reserved("commitMutation", { reads: 8 }, false, operationNow, () => {
        const roomId = input.params.room_id === undefined ? ROOM_ID : input.params.room_id;
        if (typeof roomId !== "string" || !this.visibleRoomRow(roomId, input.userId)) throw new StoreError("invalid_params", "unknown room");
        throw new StoreError("invalid_params", EMPTY_MESSAGE);
      });
    }
    const digest = input.digest ?? digestOperation(method, input.params);
    // A retry lookup is deliberately cheaper than a full mutation reserve.
    // Accepted retries must remain available even when posting/storage
    // capacity is exhausted, while still paying their bounded SQL lookup.
    let effective = operationNow;
    if (input.requestId !== undefined) {
      const lookup = this.reserved("commitMutation", { reads: 8 + 4 * this.config.maxEmbeds, writes: 8 }, false, operationNow, () => {
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
    const reserved = this.reserveCost("commitMutation", mutationCost, false, operationNow);
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
        if (!input.system) this.admission.chargePosting(this.sqlHandle, { userId: input.userId, tier, ipKey: input.ipKey, now: effective, uncategorized: method === "me" });
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
          if (context.extraPosts && !input.system) this.admission.chargePosting(this.sqlHandle, { userId: input.userId, tier, ipKey: input.ipKey, now: effective, weight: context.extraPosts });
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

  /** The withheld control rows can persist one deferral and its reset alarm. */
  private deferCleanup(effective: number): void {
    const nextDue = Math.max(effective + 1000, (Math.floor(effective / 86_400_000) + 1) * 86_400_000);
    if (this.deferredCleanupUntil >= nextDue) return;
    this.assertAccounting();
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    const reserved = this.reserveMaintenanceControl("deferCleanup", { reads: 8, writes: 8 }, effective);
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
      return this.reserved("cleanupDue", { reads: 4 }, true, now, () =>
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
      gate = this.reserved("runCleanup", { reads: 24 + this.retentionCountReads(), writes: 2 }, true, now, () => {
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
    try { reserved = this.reserveCost("runCleanup", this.config.cleanupCost, true, effective); }
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
        if (stale.length) this.historyLog.forgetState();
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
    try { reserved = this.reserveCost("scheduleAlarm", { reads: 16, writes: 4 }, true, now); }
    catch (error) {
      if (!(error instanceof StoreError) || error.code !== "retry_after") throw error;
      // Eight of the withheld control rows defer cleanup; 24 remain to install
      // its reset alarm even after ordinary maintenance is exhausted.
      reserved = this.reserveMaintenanceControl("scheduleAlarm", { reads: 24, writes: 24 }, now);
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

/** The `removed_at:` key of a removal at log position `position`, which sorts by position. */
function removedAtKey(position: number, userId: string): string {
  return `${META_REMOVED_AT_PREFIX}${String(position).padStart(16, "0")}:${userId}`;
}
