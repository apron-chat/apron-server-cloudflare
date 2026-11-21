/*
 * The core the store's implementation modules run over (push.ts, …):
 * what SqliteStore keeps for all of them, so a module depends on these few
 * members rather than on SqliteStore. SqliteStore makes the one StoreCore
 * (SqliteStore.core) and the modules over it.
 *
 * SQL only inside a reservation, structurally: the core hands out no query
 * method. A reservation (`reserved`) gives its callback a Sql handle, and a
 * module queries only through that handle, so an unmetered query is a type
 * error. The handle's queries go through SqliteStore's one execution choke
 * point (rawExec, rawRows): the reservation's observed reads and writes,
 * and member listings made stale by a write.
 */

import type { CostEstimate } from "../budget-ledger";
import type { RawLimitRow } from "../limiter-cache";
import type { StoreConfig } from "./config";
import type { RawIdentityRow, RawLogState, RawMaintenanceRow, RawMessageRow, RawRoomRow } from "./rows";
import type { Broadcast, LiveEntry, MessageSnapshot, SqlCursorLike, StoreClock, StoreMutationInput, StoreMutationResult } from "./types";

/**
 * What a reservation's callback may do with SQLite: its own queries, a
 * transaction, and the lookups and writes the modules share. Valid only
 * while the reservation runs.
 */
export interface Sql {
  /** A query's rows, all read (rawRows): counted as the rows SQLite read. */
  rows<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): T[];
  /** A statement (rawExec): counted as the rows SQLite read and wrote. */
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursorLike<T>;
  /** Runs `fn` in one transaction (SqliteStore.transaction): rolled back, with the caches it changed, if it throws. */
  transaction<T>(fn: () => T): T;
  /** A `_meta` value, `""` when absent. */
  metaValue(key: string): string;
  /** A `_meta` value as a whole number, 0 when absent or not one. */
  metaNumber(key: string): number;
  /** A JSON `_meta` record as `decode` makes it, `fallback` when absent, unreadable or refused. */
  metaJson<T>(key: string, decode: (value: unknown) => T | undefined, fallback: T): T;
  /** The `_meta` entries with keys from `start` up to `end`, in key order, at most `limit`. */
  metaRange(start: string, end: string, limit: number): Array<[string, string]>;
  /** Sets a `_meta` value; null deletes it. */
  writeMeta(key: string, value: string | null): void;
  /** An identity's row, or null. */
  identityRow(userId: string): RawIdentityRow | null;
  /** Whether a registered user holds one of `roles`. */
  holdsRole(userId: string, roles: readonly string[]): boolean;
  /** Whether a registered user holds any role but `unclaimed`. */
  holdsAnyRole(userId: string): boolean;
  /** Whether `userId` is a member of `roomId` (a `memberships` row). */
  isMember(roomId: string, userId: string): boolean;
  /** The log's head and floor, read once and then kept. */
  logState(): RawLogState;
  /** The floor below which records may leave this SQLite: the hot floor, or with tiers, what every link has copied. */
  publishedFloor(): number;
  /** A room's row, or null. */
  roomRow(roomId: string): RawRoomRow | null;
  /** The maintenance row: cleanup's schedule and cursor. */
  maintenanceRow(): RawMaintenanceRow;
  /** A retained message's current state and snapshot, or null; below `floor`, null. */
  currentMessage(messageId: string, floor?: number): RawMessageRow | null;
  /** Writes a user's `seen` (protocol §4.5.2) without making reused member listings stale (core.patchMemberSeen updates them once committed). */
  writeSeen(userId: string, seen: number): void;
  /** Settles a user's `seen` at `at` where the stored one does not stand (SqliteStore.settleSeen): what is stored after, undefined for an unknown user. */
  settleSeen(userId: string, at: number): number | undefined;
  /** A retained message's current snapshot and one of its embeds, or null where either is gone (or the message is deleted). */
  retainedEmbed(messageId: string, embedId: string): { message: RawMessageRow; snapshot: MessageSnapshot; embed: Record<string, unknown> } | null;
  /** A room the user may see (a private one only to its members), or null. */
  visibleRoomRow(roomId: string, userId: string): RawRoomRow | null;
  /** A `reply_to`-style reference checked as a post's is (SqliteStore.messageReference): the message ID, or undefined without one; refuses a bad one. */
  messageReference(value: unknown, field: string, floor: number, options: { viewer: string; roomId: string; self?: string; unchanged?: string }): string | undefined;
  /** Posts a live text command's message as its write is claimed: one commit of the log (the commit path's commitMessage). */
  commitLivePost(input: StoreMutationInput, effective: number, entry: LiveEntry): StoreMutationResult;
  /**
   * Commits a new snapshot of `message` with embed `embedId` replaced (or
   * removed, with null) and, with `text`, its text: the commit path's log
   * append. Its broadcast.
   */
  rewriteEmbed(message: RawMessageRow, snapshot: MessageSnapshot, embedId: string, replacement: Record<string, unknown> | null, now: number, text?: string): Broadcast[];
  /** Refuses (or pauses on) a write that would grow the database past its targets by `additionalBytes`. */
  ensureGrowthCapacity(additionalBytes: number): void;
  /** A limiter row (`principal_limits`), from the cache or read. */
  limitRow(scope: string, principalKey: string, now: number): RawLimitRow;
  /** A limiter row held in the cache, without reading it. */
  peekLimitRow(scope: string, principalKey: string): RawLimitRow | undefined;
  /** Writes a limiter row's changes, through the cache. */
  updateLimitRow(row: RawLimitRow, updates: Partial<RawLimitRow>, now: number, weight?: number): void;
}

/** A cache a transaction must put back when it rolls back (SqliteStore.transaction). */
export interface TransactionJournal {
  begin(): void;
  commit(): void;
  rollback(): void;
}

export interface StoreCore {
  readonly config: StoreConfig;
  readonly clock: StoreClock;
  /** Initializes the schema once, before a module's first work. */
  ensureReady(): void;
  /** The store's clock as it runs: never behind a time it has used (`now` truncated). */
  effectiveNow(candidate: number): number;
  /**
   * Runs `fn` under a reservation of `cost`, named `operation` for overruns
   * and breakers (accounting.ts), then settles it. `fn` gets the Sql handle;
   * it may set `unused.history` to give back history pages it reserved and
   * did not serve.
   */
  reserved<T>(operation: string, cost: CostEstimate, maintenance: boolean, now: number, fn: (sql: Sql, unused: { history: number }) => T, unchecked?: boolean): T;
  /**
   * Runs `fn` with the Sql handle and no reservation: for the few reads that
   * were never metered (each says why at its call), and nothing else.
   * Every use is listed in src/store/index.ts.
   */
  unmetered<T>(fn: (sql: Sql) => T): T;
  /** Whether the server is degraded now: a daily share past DEGRADE_SHARE (no SQL). */
  degraded(now: number): boolean;
  /** Sets a committed `seen` in the member listings kept for reuse (no SQL). */
  patchMemberSeen(userId: string, seen: number): void;
  /** Runs `fn` as an operator alert's storage work: charged, never refused (SqliteStore.alert). */
  alert<T>(fn: () => T): T;
  /** Whether an operator alert's work is running now. */
  readonly alerting: boolean;
  /** Refuses `feature` with `retry_after` while the server is degraded (DEGRADE_SHARE). */
  assertNotDegraded(feature: string, now: number): void;
  /** Adds a cache SqliteStore.transaction saves and puts back. */
  journal(journal: TransactionJournal): void;
}
