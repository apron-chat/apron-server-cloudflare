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
import type { RawIdentityRow, RawLogState, RawMessageRow } from "./rows";
import type { SqlCursorLike, StoreClock } from "./types";

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
  /** Sets a `_meta` value; null deletes it. */
  writeMeta(key: string, value: string | null): void;
  /** An identity's row, or null. */
  identityRow(userId: string): RawIdentityRow | null;
  /** Whether a registered user holds one of `roles`. */
  holdsRole(userId: string, roles: readonly string[]): boolean;
  /** Whether `userId` is a member of `roomId` (a `memberships` row). */
  isMember(roomId: string, userId: string): boolean;
  /** The log's head and floor, read once and then kept. */
  logState(): RawLogState;
  /** A retained message's current state and snapshot, or null; below `floor`, null. */
  currentMessage(messageId: string, floor?: number): RawMessageRow | null;
  /** Refuses (or pauses on) a write that would grow the database past its targets by `additionalBytes`. */
  ensureGrowthCapacity(additionalBytes: number): void;
  /** A limiter row (`principal_limits`), from the cache or read. */
  limitRow(scope: string, principalKey: string, now: number): RawLimitRow;
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
  /** Refuses `feature` with `retry_after` while the server is degraded (DEGRADE_SHARE). */
  assertNotDegraded(feature: string, now: number): void;
  /** Adds a cache SqliteStore.transaction saves and puts back. */
  journal(journal: TransactionJournal): void;
}
