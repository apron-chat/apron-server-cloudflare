/*
 * History as this store keeps it: pages of the log for `history`
 * (historyImpl and its paging), the head's records, floors and target for
 * the history chain (src/history; the adapters are history.ts), the chain's
 * state in `_meta`, the queue of `/purge` and `/rename` rewrites the tiers
 * below apply, the cold tier's chunk index (`history_chunks`), and the
 * import journal. The log itself is the commit path's (sqlite-store.ts);
 * this module reads it.
 */

import { ROOM_ID } from "../domain";
import type { ChunkIndex, ChunkRef } from "../history/cold/chunks";
import type { ChatRecord, HistoryQuery, QueuedRewrite, Rewrite } from "../history/records";
import { type ChainStatePort, MAX_KEPT_GROUPS } from "../history/state";
import { StoreError } from "../store-error";
import { HISTORY_SCAN_BATCH, HISTORY_SCAN_PAGES, HISTORY_TARGET_SCAN, MAX_HISTORY_REWRITES, RETAINED_SCAN_CAP } from "./limits";
import { META_HISTORY_EXPORT, META_HISTORY_IMPORT, META_HISTORY_IMPORT_PROGRESS, META_HISTORY_KEPT, META_HISTORY_LINK, META_HISTORY_OPS, META_HISTORY_OPS_SEQ, META_HISTORY_THROUGH, META_HISTORY_TIER } from "./meta";
import { type MembershipRecord, type RawRecordRow, type RawRoomRow, type ReactionsRecord, clone, idString, integerColumn, numericBigInt, numericId, parseJson, positiveLimit, roomHistoryFloor, roomHistoryLogId, terminalOutputBytes, utf8Bytes } from "./rows";
import type { MessageSnapshot, PendingHistory, RoomRecord, StoreHistoryQuery, StoreHistoryResult } from "./types";
import type { Sql, StoreCore } from "./core";
import type { AdmissionModule } from "./admission";

/** History over the store's core: history pages (the Messages part's), the head and state the history chain runs over, and the History part's bookkeeping. */
export class HistoryModule {
  constructor(private readonly core: StoreCore, private readonly admission: AdmissionModule) {
    // A transaction that rolls back may have written state these caches hold: they are read again.
    core.journal({ begin: () => {}, commit: () => {}, rollback: () => this.forgetState() });
  }

  /**
   * The history chain's state and rewrite queue, kept in memory: this
   * instance is their only writer (cleanup forgets them when tiers are off,
   * and a reset wipes them, each calling forgetState). Each is read once, under its
   * reservation, then from memory, and every write here updates it once
   * written; a rollback forgets them all. So a history cycle's snapshots,
   * one a step, read no SQL and reserve nothing once the state is known.
   * Each answer from memory is still refused where its reservation would
   * have been (StoreCore.checkMaintenance, with the cost it reserved): with
   * accounting closed or the maintenance budget spent, a cycle stops at its
   * first snapshot, before it asks any tier below for anything.
   * `_meta` values by key (undefined: absent), groups of kept rewrites by
   * prefix, the copy marker, the queue (META_HISTORY_OPS) and the newest
   * rewrite's number (META_HISTORY_OPS_SEQ).
   */
  private readonly stateValues = new Map<string, string | undefined>();
  private readonly stateEntries = new Map<string, Array<[string, string]>>();
  private copyMarkerCache: number | undefined;
  /** Whether every tier and link state key was read at once (loadChainState): a key not in stateValues is then absent. */
  private stateLoaded = false;
  private queueCache: QueuedRewrite[] | undefined;
  private loggedCache: number | undefined;

  /**
   * Reads the chain's state at once, under one reservation, the first time a
   * snapshot needs any of it: every tier's and link's value (a few: one a
   * tier), the copy marker and the newest rewrite's number. A cycle plans
   * each step from a snapshot of all of these, so reading them one at a time
   * would reserve, and settle, once each.
   */
  private loadChainState(): void {
    if (this.stateLoaded) return;
    const range = (prefix: string) => [prefix, prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)] as const;
    const limit = 64;
    this.core.reserved("unknown", { reads: 16 + 2 * (8 + limit) }, true, this.core.clock.now(), (sql) => {
      const tiers = sql.metaRange(...range(META_HISTORY_TIER), limit);
      const links = sql.metaRange(...range(META_HISTORY_LINK), limit);
      this.copyMarkerCache ??= sql.metaNumber(META_HISTORY_THROUGH);
      this.loggedCache ??= sql.metaNumber(META_HISTORY_OPS_SEQ);
      for (const [key, value] of [...tiers, ...links]) if (!this.stateValues.has(key)) this.stateValues.set(key, value || undefined);
      // A range cut at its limit (never, with a tier a key) leaves the rest to be read one at a time.
      this.stateLoaded = tiers.length < limit && links.length < limit;
    });
  }

  /** Forgets the history state kept in memory (above): read again on next need. */
  forgetState(): void {
    this.stateValues.clear();
    this.stateEntries.clear();
    this.copyMarkerCache = undefined;
    this.stateLoaded = false;
    this.queueCache = undefined;
    this.loggedCache = undefined;
  }

  /** The cold tiers' chunk indexes, as loaded from this SQLite, by tier name (chunkIndex). */
  private readonly chunkIndexes = new Map<string, Map<number, ChunkRef>>();

  /** Whether the chunk table exists, this instance (chunkIndex). */
  private chunkTableReady = false;

  /** Forgets the chunk indexes loaded and that their table exists: after a reset wiped them (SqliteStore.resetStorage). */
  forgetChunkIndexes(): void {
    this.chunkIndexes.clear();
    this.chunkTableReady = false;
  }

  /**
   * The records the hot log holds from the hot floor on, for `/status`:
   * counted up to RETAINED_SCAN_CAP (one index entry each, refunded past
   * what is found), and that cap and one more past it.
   */
  hotRecords(now = this.core.clock.now()): number {
    this.core.ensureReady();
    return this.core.reserved("hotRecords", { reads: 16 + RETAINED_SCAN_CAP + 1 }, false, now, (sql) => integerColumn(sql.rows<{ count: number }>(
      "SELECT COUNT(*) AS count FROM (SELECT 1 FROM records INDEXED BY records_log_idx WHERE log_id >= ? LIMIT ?)",
      sql.logState().history_floor, RETAINED_SCAN_CAP + 1,
    )[0]?.count));
  }

  /**
   * The hot floor, the published floor (publishedFloor) and the log head
   * (the last log ID issued, `latest`), for the history chain: an import
   * that renumbers its records places them past the head.
   */
  historyFloors(now = this.core.clock.now()): { hot: number; published: number; latest: number } {
    this.core.ensureReady();
    // The log head and the published floor are kept in memory once read (SqliteStore's logState and publishedFloor).
    const known = this.core.knownFloors();
    if (known) {
      // Refused where the reservation below would be.
      this.core.checkMaintenance({ reads: 8 }, now);
      return known;
    }
    return this.core.reserved("historyFloors", { reads: 8 }, true, now, (sql) => {
      const state = sql.logState();
      return { hot: state.history_floor, published: sql.publishedFloor(), latest: state.last_log_id };
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
  historyTarget(now = this.core.clock.now()): number | undefined {
    this.core.ensureReady();
    if (!this.core.config.tiered) return undefined;
    return this.core.reserved("historyTarget", { reads: 24 + HISTORY_TARGET_SCAN }, true, now, (sql) => {
      const maintenance = sql.maintenanceRow();
      if (maintenance.cleanup_cursor === null || maintenance.cleanup_cutoff_ms === null) return undefined;
      const cutoff = maintenance.cleanup_cutoff_ms;
      const state = sql.logState();
      const rows = sql.rows<{ log_id: number; commit_ms: number }>(
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

  historyScan(from: number, limit = HISTORY_SCAN_BATCH, now = this.core.clock.now()): ChatRecord[] {
    this.core.ensureReady();
    const capped = Math.max(0, Math.min(limit, HISTORY_SCAN_BATCH));
    return this.core.reserved("historyScan", { reads: 24 + 6 * capped }, true, now, (sql) => sql.rows<ChatRecord>(
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
  historyRecords(query: HistoryQuery, now = this.core.clock.now()): ChatRecord[] {
    this.core.ensureReady();
    const limit = Math.max(0, Math.min(query.limit, 1_000));
    if (!query.roomIds.length || query.lower > query.upper || !limit) return [];
    if (query.roomIds.length === 1) {
      // One room (exports page room by room): its own key range, a page at most.
      return this.core.reserved("historyRecords", { reads: 24 + limit + 1 }, true, now, (sql) => sql.rows<ChatRecord>(
        `SELECT room_id, log_id, commit_ms, kind, record_json FROM records
         WHERE room_id = ? AND log_id >= ? AND log_id <= ? ORDER BY log_id ${query.forward ? "ASC" : "DESC"} LIMIT ?`,
        query.roomIds[0], Math.max(query.lower, sql.logState().history_floor), query.upper, limit,
      ).map((row) => ({ ...row, log_id: integerColumn(row.log_id), commit_ms: integerColumn(row.commit_ms) })));
    }
    return this.core.reserved("historyRecords", { reads: 24 + 4 * limit * Math.min(query.roomIds.length, 8) }, true, now, (sql) => sql.rows<ChatRecord>(
      `SELECT room_id, log_id, commit_ms, kind, record_json FROM records
       WHERE room_id IN (SELECT value FROM json_each(?)) AND log_id IN (
         SELECT DISTINCT log_id FROM records
         WHERE room_id IN (SELECT value FROM json_each(?)) AND log_id >= ? AND log_id <= ?
         ORDER BY log_id ${query.forward ? "ASC" : "DESC"} LIMIT ?)
       ORDER BY log_id ${query.forward ? "ASC" : "DESC"}`,
      JSON.stringify(query.roomIds), JSON.stringify(query.roomIds), Math.max(query.lower, sql.logState().history_floor), query.upper, limit,
    ).map((row) => ({ ...row, log_id: integerColumn(row.log_id), commit_ms: integerColumn(row.commit_ms) })));
  }

  /** The records with these log IDs, any room (import's duplicate check). */
  historyLookup(logIds: readonly number[], now = this.core.clock.now()): ChatRecord[] {
    this.core.ensureReady();
    const ids = [...new Set(logIds)].slice(0, 1_000);
    if (!ids.length) return [];
    return this.core.reserved("historyLookup", { reads: 24 + 4 * ids.length }, true, now, (sql) => sql.rows<ChatRecord>(
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
    // Its functions run when the history chain calls them, outside any store
    // operation: their reservations are named `unknown` (accounting.ts).
    const owned = (key: string) => {
      if (!key.startsWith(META_HISTORY_TIER) && !key.startsWith(META_HISTORY_LINK) && !key.startsWith(META_HISTORY_KEPT)) throw new Error(`not a history chain state key: ${key}`);
      return key;
    };
    // Each function's answer from memory is refused where the reservation it
    // made before the state was kept would be (StoreCore.checkMaintenance).
    const check = (cost: { reads: number; writes?: number }) => this.core.checkMaintenance(cost, this.core.clock.now());
    return {
      value: (key) => {
        this.core.ensureReady();
        owned(key);
        check({ reads: 4 });
        if (!key.startsWith(META_HISTORY_KEPT)) this.loadChainState();
        if (this.stateValues.has(key)) return this.stateValues.get(key);
        if (this.stateLoaded && !key.startsWith(META_HISTORY_KEPT)) return undefined;
        const value = this.core.reserved("unknown", { reads: 4 }, true, this.core.clock.now(), (sql) => sql.metaValue(owned(key)) || undefined);
        this.stateValues.set(key, value);
        return value;
      },
      setValue: (key, value) => {
        this.core.ensureReady();
        if (!this.core.config.tiered) return;
        this.core.reserved("unknown", { reads: 4, writes: 4 }, true, this.core.clock.now(), (sql) => {
          sql.writeMeta(owned(key), value);
          // Kept as written at once: the write stands even if settling the reservation then fails.
          this.stateValues.set(key, value || undefined);
          for (const prefix of [...this.stateEntries.keys()]) if (key.startsWith(prefix)) this.stateEntries.delete(prefix);
        });
      },
      hotFloor: () => this.historyFloors().hot,
      publishedFloor: () => this.historyFloors().published,
      copyMarker: () => {
        this.core.ensureReady();
        check({ reads: 4 });
        this.loadChainState();
        this.copyMarkerCache ??= this.core.reserved("unknown", { reads: 4 }, true, this.core.clock.now(), (sql) => sql.metaNumber(META_HISTORY_THROUGH));
        return this.copyMarkerCache;
      },
      raiseCopyMarker: (through) => {
        this.core.ensureReady();
        if (!this.core.config.tiered) return;
        // Never lowered: a marker known to be there already needs no write.
        if (this.copyMarkerCache !== undefined && through <= this.copyMarkerCache) {
          check({ reads: 4, writes: 4 });
          return;
        }
        this.core.reserved("unknown", { reads: 4, writes: 4 }, true, this.core.clock.now(), (sql) => {
          const stored = sql.metaNumber(META_HISTORY_THROUGH);
          if (through > stored) sql.writeMeta(META_HISTORY_THROUGH, String(through));
          // Kept as written at once, as setValue's.
          this.copyMarkerCache = Math.max(stored, through);
        });
      },
      entries: (prefix) => {
        this.core.ensureReady();
        owned(prefix);
        check({ reads: 16 + MAX_KEPT_GROUPS });
        const known = this.stateEntries.get(prefix);
        if (known) return known.map(([key, value]) => [key, value] as [string, string]);
        const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
        const entries = this.core.reserved("unknown", { reads: 16 + MAX_KEPT_GROUPS }, true, this.core.clock.now(), (sql) => sql.metaRange(owned(prefix), end, MAX_KEPT_GROUPS));
        this.stateEntries.set(prefix, entries.map(([key, value]) => [key, value] as [string, string]));
        return entries;
      },
    };
  }

  /** The `/purge` and `/rename` some link has yet to deliver, oldest first. */
  historyRewrites(now = this.core.clock.now()): QueuedRewrite[] {
    this.core.ensureReady();
    if (!this.core.config.tiered) return [];
    // Refused from memory where the reservation would be (historyStatePort).
    this.core.checkMaintenance({ reads: 4 }, now);
    this.queueCache ??= this.core.reserved("historyRewrites", { reads: 4 }, true, now, (sql) => this.queuedRewrites(sql));
    return clone(this.queueCache);
  }

  /** The newest rewrite's number ever given (0: none), delivered or not. */
  historyRewritesLogged(now = this.core.clock.now()): number {
    this.core.ensureReady();
    this.core.checkMaintenance({ reads: 4 }, now);
    this.loadChainState();
    this.loggedCache ??= this.core.reserved("historyRewritesLogged", { reads: 4 }, true, now, (sql) => sql.metaNumber(META_HISTORY_OPS_SEQ));
    return this.loggedCache;
  }

  private queuedRewrites(sql: Sql): QueuedRewrite[] {
    return sql.metaJson(META_HISTORY_OPS, (value) => Array.isArray(value) ? value as QueuedRewrite[] : undefined, []);
  }

  /** Adds `messageIds` to queued purge `seq` (RewriteLog.amend): messages of its user a tier below found. */
  amendHistoryPurge(seq: number, messageIds: readonly string[], now = this.core.clock.now()): void {
    this.core.ensureReady();
    if (!messageIds.length) return;
    this.core.reserved("amendHistoryPurge", { reads: 4, writes: 4 }, true, now, (sql) => {
      const next = this.queuedRewrites(sql).map((entry) => entry.seq === seq && entry.rewrite.into === null ? { seq, rewrite: { ...entry.rewrite, messages: [...new Set([...(entry.rewrite.messages ?? []), ...messageIds])] } } : entry);
      sql.writeMeta(META_HISTORY_OPS, JSON.stringify(next));
      this.queueCache = clone(next);
    });
  }

  /** Forgets the rewrites through `seq`, once every link delivered them. */
  dropHistoryRewrites(seq: number, now = this.core.clock.now()): void {
    this.core.ensureReady();
    this.core.reserved("dropHistoryRewrites", { reads: 4, writes: 4 }, true, now, (sql) => {
      const kept = this.queuedRewrites(sql).filter((entry) => entry.seq > seq);
      sql.writeMeta(META_HISTORY_OPS, kept.length ? JSON.stringify(kept) : null);
      this.queueCache = clone(kept);
    });
  }

  /**
   * A cold tier's chunk index (ChunkIndex), in this SQLite: one row a chunk
   * in `history_chunks`, keyed by tier name and the chunk's first log ID,
   * created on first use. The rows are read once a wake (a chunk holds
   * about 10,000 log IDs, so they are few) and kept in memory (this object
   * is the only writer); each read and write is charged to maintenance.
   */
  chunkIndex(tier: string): ChunkIndex {
    // As historyStatePort's: run by the cold tier, so named `unknown`.
    const loaded = (): Map<number, ChunkRef> => {
      const cached = this.chunkIndexes.get(tier);
      if (cached) return cached;
      this.core.ensureReady();
      // Charged for the rows there are: a count first (with, once a wake, the
      // table made where it is missing), then the rows.
      const count = this.core.reserved("unknown", { reads: 32, writes: 8 }, true, this.core.clock.now(), (sql) => {
        if (!this.chunkTableReady) sql.exec("CREATE TABLE IF NOT EXISTS history_chunks (tier TEXT NOT NULL, first INTEGER NOT NULL, ref TEXT NOT NULL, PRIMARY KEY (tier, first)) WITHOUT ROWID");
        return Number(sql.rows<{ count: number }>("SELECT COUNT(*) AS count FROM history_chunks WHERE tier = ?", tier)[0]?.count ?? 0);
      });
      this.chunkTableReady = true;
      const rows = this.core.reserved("unknown", { reads: 24 + count }, true, this.core.clock.now(), (sql) => sql.rows<{ first: number; ref: string }>("SELECT first, ref FROM history_chunks WHERE tier = ?", tier));
      const refs = new Map(rows.map((row) => [Number(row.first), JSON.parse(row.ref) as ChunkRef]));
      this.chunkIndexes.set(tier, refs);
      return refs;
    };
    return {
      list: async () => [...loaded().values()].map((ref) => ({ ...ref })),
      update: async ({ put = [], remove = [] }) => {
        const refs = loaded();
        this.core.reserved("unknown", { reads: 8 + put.length + remove.length, writes: 2 * (put.length + remove.length) }, true, this.core.clock.now(), (sql) => {
          for (const first of remove) sql.exec("DELETE FROM history_chunks WHERE tier = ? AND first = ?", tier, first);
          for (const ref of put) sql.exec("INSERT OR REPLACE INTO history_chunks (tier, first, ref) VALUES (?, ?, ?)", tier, ref.first, JSON.stringify(ref));
        });
        for (const first of remove) refs.delete(first);
        for (const ref of put) refs.set(ref.first, { ...ref });
      },
    };
  }

  /** A backup schedule's number in `_meta` (a key under `history:export:`), 0 when absent. */
  historyMetaNumber(key: string, now = this.core.clock.now()): number {
    this.core.ensureReady();
    if (!key.startsWith(META_HISTORY_EXPORT)) throw new Error(`not a history export key: ${key}`);
    return this.core.reserved("historyMetaNumber", { reads: 4 }, true, now, (sql) => sql.metaNumber(key));
  }

  /** The running import's journal (`history:import`, RestorePort.journal): what a retry needs to finish it. */
  historyImportJournal(now = this.core.clock.now()): string | undefined {
    this.core.ensureReady();
    return this.core.reserved("historyImportJournal", { reads: 4 }, true, now, (sql) => sql.metaValue(META_HISTORY_IMPORT) || undefined);
  }

  /** Writes or clears the running import's journal (its size is the importer's to bound: MAX_JOURNAL_BYTES). */
  setHistoryImportJournal(value: string | null, now = this.core.clock.now()): void {
    this.core.ensureReady();
    this.core.reserved("setHistoryImportJournal", { reads: 4, writes: 4 + Math.ceil((value?.length ?? 0) / 4_096) }, true, now, (sql) => sql.writeMeta(META_HISTORY_IMPORT, value));
  }

  /** How far the running import's writes got (`history:import_progress`, RestorePort.progress): a small JSON value. */
  historyImportProgress(now = this.core.clock.now()): string | undefined {
    this.core.ensureReady();
    return this.core.reserved("historyImportProgress", { reads: 4 }, true, now, (sql) => sql.metaValue(META_HISTORY_IMPORT_PROGRESS) || undefined);
  }

  /** Writes or clears the running import's progress. */
  setHistoryImportProgress(value: string | null, now = this.core.clock.now()): void {
    this.core.ensureReady();
    this.core.reserved("setHistoryImportProgress", { reads: 4, writes: 4 }, true, now, (sql) => sql.writeMeta(META_HISTORY_IMPORT_PROGRESS, value));
  }

  /** Writes a backup schedule's value in `_meta` (a key under `history:export:`), or removes it for null. */
  setHistoryMeta(key: string, value: string | null, now = this.core.clock.now()): void {
    this.core.ensureReady();
    if (!key.startsWith(META_HISTORY_EXPORT)) throw new Error(`not a history export key: ${key}`);
    this.core.reserved("setHistoryMeta", { reads: 4, writes: 4 }, true, now, (sql) => sql.writeMeta(key, value));
  }

  /**
   * Queues what a `/purge` or `/rename` did here for the links to deliver
   * down the chain (historyRewrites), within the operation's transaction,
   * numbered in order. A full log refuses the operation: the links must
   * catch up first.
   */
  queueHistoryRewrites(sql: Sql, rewrites: readonly Rewrite[]): void {
    if (!this.core.config.tiered || !rewrites.length) return;
    const queued = this.queuedRewrites(sql);
    if (queued.length + rewrites.length > MAX_HISTORY_REWRITES) throw new StoreError("retry_after", "older history has yet to catch up with earlier changes");
    let seq = sql.metaNumber(META_HISTORY_OPS_SEQ);
    const added = rewrites.map((rewrite) => ({ seq: (seq += 1), rewrite }));
    sql.writeMeta(META_HISTORY_OPS_SEQ, String(seq));
    sql.writeMeta(META_HISTORY_OPS, JSON.stringify([...queued, ...added]));
    this.loggedCache = seq;
    this.queueCache = clone([...queued, ...added]);
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
    this.core.ensureReady();
    const operationNow = query.now ?? this.core.clock.now();
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
    const guestReach = Math.max(this.core.config.guestHistoryDepth, limit);
    const depthCap = Math.max(newestReach, query.guest ? guestReach : 0);
    return this.core.reserved("history", {
      ...this.core.config.historyCost,
      // Measuring a backward page reads the rooms again (a private one's
      // membership too) and at most `depthCap` records and one more a room.
      reads: this.historyReads(query) + (backward ? depthCap + 3 * this.historyRoomCount(query) : 0),
      // A page writes only its two limiter rows and the budget row: about 20
      // rows for a first request, which creates both limiter rows.
      writes: Math.max(32, this.core.config.historyCost.writes ?? 0),
      history: charged ? 1 : 0,
    }, false, operationNow, (sql, unused) => {
      // A page refused once measured read rows to find out: it stays charged,
      // to the user's and IP's limiters and the server's count, so refusals
      // cost what a page does and cannot be repeated for free.
      let measuredRefusal: StoreError | undefined;
      try {
        const now = this.core.effectiveNow(operationNow);
        // Scrolling back, the costliest reads, is the history the degraded
        // tier turns off (today's budget is in memory), and a guest's
        // reaches only `guestHistoryDepth` records back: past that, older
        // pages are for accounts. A page near the head is the newest, open
        // to everyone in every tier.
        const degraded = query.before !== undefined && this.core.degraded(operationNow);
        if (degraded && !backward) this.core.assertNotDegraded("Loading older history", operationNow);
        const page = sql.transaction(() => {
          if (charged && !query.guest) {
            this.admission.chargeEvent(sql, "history", `user:${query.userId}`, now,
              { perMinute: this.core.config.historyRequestsPerUserMinute, burst: this.core.config.historyBurstPerUser },
              "History request limit reached",
              { limit: this.core.config.historyRequestsPerUserDay, message: "Daily history limit reached" }, "read");
          }
          if (charged) {
            this.admission.chargeEvent(sql, "history", `ip:${query.ipKey}`, now,
              { perMinute: this.core.config.historyRequestsPerIpMinute, burst: this.core.config.historyBurstPerIp },
              "History request limit reached",
              { limit: this.core.config.historyRequestsPerIpDay, message: "Daily history limit reached for this network" }, "read");
          }
          if (backward && (query.guest || degraded)) {
            const depth = this.recordsAfter(sql, query, depthCap);
            try {
              if (degraded && depth >= newestReach) this.core.assertNotDegraded("Loading older history", operationNow);
              if (query.guest && depth >= guestReach) throw new StoreError("denied", "Sign in to load older history");
            } catch (error) {
              // Returned rather than thrown, so the transaction keeps the charges.
              measuredRefusal = error as StoreError;
              return undefined;
            }
          }
          return this.historyPageInternal(sql, { ...query, now }, allowTiers);
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
    this.core.ensureReady();
    const operationNow = query.now ?? this.core.clock.now();
    return this.core.reserved("historyPage", {
      ...this.core.config.historyCost,
      reads: this.historyReads(query),
      writes: Math.max(32, this.core.config.historyCost.writes ?? 0),
    }, false, operationNow, (sql) => {
      const now = this.core.effectiveNow(operationNow);
      return sql.transaction(() => this.historyPageInternal(sql, { ...query, now }) as StoreHistoryResult);
    });
  }

  /**
   * The rows a history page may read: one room's page, or for several rooms
   * each one's row and at most a page and one more of its records, besides
   * the limiter and budget rows.
   */
  private historyReads(query: StoreHistoryQuery): number {
    const single = Math.max(256, this.core.config.historyCost.reads ?? 0);
    if (query.roomId !== undefined || !query.roomIds) return single;
    const limit = this.historyLimit(query);
    // The scan of the log reads an index entry and a row for each record.
    return Math.max(single, 64 + 2 * HISTORY_SCAN_PAGES * (limit + 1) + new Set(query.roomIds).size * (limit + 3));
  }

  private historyLimit(query: StoreHistoryQuery): number {
    return query.limit !== undefined && Number.isInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, this.core.config.maxHistoryLimit) : this.core.config.historyPageSize;
  }

  /** The rooms a history query names: one, or its distinct `roomIds`. */
  private historyRoomCount(query: StoreHistoryQuery): number {
    return query.roomId === undefined && query.roomIds !== undefined ? new Set(query.roomIds).size : 1;
  }

  /** The rooms whose log a history query reads, the requester's visible ones (see historyPageInternal). */
  private historySources(sql: Sql, query: StoreHistoryQuery): { multiple: boolean; sources: RawRoomRow[] } {
    const multiple = query.roomId === undefined && query.roomIds !== undefined;
    const roomIds = multiple ? [...new Set(query.roomIds)] : [query.roomId === undefined ? ROOM_ID : query.roomId];
    for (const roomId of roomIds) {
      if (typeof roomId !== "string" || roomId.length === 0) throw new StoreError("invalid_params", "room_id must be a non-empty string");
    }
    // A requester's private room only if they are in it; internal pages, with no requester, see every room.
    const visible = (roomId: string) => query.userId === undefined ? sql.roomRow(roomId) : sql.visibleRoomRow(roomId, query.userId);
    return { multiple, sources: roomIds.map(visible).filter((room): room is RawRoomRow => room !== null) };
  }

  /**
   * How many records the query's rooms hold past its `before`, counted up to
   * `cap`: how far back from the head a page that ends there starts. At most
   * `cap` rows and one a room are read.
   */
  private recordsAfter(sql: Sql, query: StoreHistoryQuery, cap: number): number {
    const before = this.historyBound(query.before, "before");
    if (before === undefined) return 0;
    // Records below the hot floor are in the tiers below, where they are not
    // counted: a page whose stretch after `before` reaches below the hot
    // floor, in a room whose history goes there, counts as `cap` deep.
    const hot = sql.logState().history_floor;
    const published = this.core.config.tiered ? sql.publishedFloor() : hot;
    let total = 0;
    for (const room of this.historySources(sql, query).sources) {
      if (total >= cap || before >= room.latest_log_id) continue;
      if (Math.max(before + 1, roomHistoryFloor(room, published)) < hot) return cap;
      total += sql.rows<{ count: number }>(
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

  private historyPageInternal(sql: Sql, query: StoreHistoryQuery, allowTiers = false): StoreHistoryResult | PendingHistory {
    const { multiple, sources } = this.historySources(sql, query);
    if (!multiple && !sources.length) throw new StoreError("invalid_params", "unknown room");
    // History starts at the published floor; the hot log holds records from
    // the hot floor on, and the tiers below those between them.
    const floor = sql.publishedFloor();
    const hot = sql.logState().history_floor;
    const after = this.historyBound(query.after, "after");
    const before = this.historyBound(query.before, "before");
    const limit = positiveLimit(query.limit, this.core.config.historyPageSize, this.core.config.maxHistoryLimit);
    const maxBytes = Math.min(query.maxBytes ?? this.core.config.maxHistoryResponseBytes, this.core.config.maxHistoryResponseBytes);
    // One room's log starts at its creation or the retention floor. The
    // joined rooms' log together (§4.3.3) starts where the server's does, at
    // the default room's creation or the floor, whichever rooms they are, so
    // its lower bound never moves back with a join, nor ahead with a leave.
    // Its head is the greatest of theirs; with nothing retrievable, such as
    // in no rooms, it is empty and ends just before its start.
    const lowerBound = multiple ? Math.max(floor, sql.roomRow(ROOM_ID)?.created_log_id ?? 1) : roomHistoryFloor(sources[0], floor);
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
    const roomSlice = (roomId: string, window: { lower: number; upper: number }) => sql.rows<RawRecordRow>(
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
      const scanned = sql.rows<RawRecordRow>(
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
    if (allowTiers && this.core.config.tiered && lowered.length && (forward || byLogId.size <= limit)) {
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
}
