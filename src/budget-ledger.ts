/*
 * The daily budget ledger: one `resource_budgets` row per UTC day, counting
 * the SQL rows (and frames, admissions, posts, registrations, history pages) reserved that
 * day, and an in-memory copy of today's row.
 *
 * The copy is authoritative until the day ends: a Durable Object runs one
 * synchronous operation at a time, so a reservation checks the copy and a
 * refused one runs no SQL at all. Every change goes to the row first and the
 * copy after, through `apply`.
 */

import { MAINTENANCE_CONTROL_RESERVE } from "./budget";
import { StoreError } from "./store-error";

export interface CostEstimate {
  reads?: number;
  writes?: number;
  frames?: number;
  admissions?: number;
  posts?: number;
  registrations?: number;
  /** History pages, counted against `historyRequestsPerDay`. */
  history?: number;
}

export interface BudgetCost {
  reads: number;
  writes: number;
  frames: number;
  admissions: number;
  posts: number;
  registrations: number;
  history: number;
  /** Set on a reservation charged to a day's budget row, so its unused part can be refunded. */
  day?: string;
  maintenance?: boolean;
}

export interface BudgetSnapshot extends BudgetCost {
  day: string;
  foreground_reads: number;
  foreground_writes: number;
  maintenance_reads: number;
  maintenance_writes: number;
}

export const BUDGET_COLUMNS = [
  "reads_reserved", "writes_reserved", "frames_reserved", "admissions_reserved", "posts_reserved",
  "registrations_reserved", "history_reserved", "foreground_reads", "foreground_writes", "maintenance_reads", "maintenance_writes",
] as const;

export type BudgetColumn = typeof BUDGET_COLUMNS[number];

export type RawBudgetRow = { day: string } & Record<BudgetColumn, number>;

/** An amount to add to some of a day's counters; negative to credit. */
export type BudgetDelta = Partial<Record<BudgetColumn, number>>;

/** The daily ceilings a reservation is checked against. */
export interface LedgerLimits {
  sqlReadsPerDay: number;
  sqlWritesPerDay: number;
  foregroundReadsPerDay: number;
  foregroundWritesPerDay: number;
  maintenanceReadsPerDay: number;
  maintenanceWritesPerDay: number;
  /** History pages the whole server serves a day. */
  historyRequestsPerDay: number;
}

/** What the ledger needs from the store: its metered SQL, its effective clock, and its accounting latch. */
export interface LedgerHost {
  exec(query: string, ...bindings: unknown[]): { rowsWritten?: number };
  rows<T>(query: string, ...bindings: unknown[]): T[];
  /** Persists the monotonic effective clock once a reservation is accepted. */
  advanceClock(now: number): void;
  /** Latches accounting unsafe after a failure that leaves the ledger uncertain. */
  markUnsafe(): void;
}

// Keep a small durable control reserve inside the maintenance allocation.
// When a batch cannot be admitted, these rows are still enough to move the
// persisted cleanup deadline to the next UTC budget reset.  Without this gap,
// an exhausted maintenance budget would leave a due timestamp behind and an
// alarm would wake the object continuously.
export const MAINTENANCE_CONTROL_READS = MAINTENANCE_CONTROL_RESERVE;
export const MAINTENANCE_CONTROL_WRITES = MAINTENANCE_CONTROL_RESERVE;

// A budget row is retained for the active UTC day only.  Rollover pruning is
// deliberately a tiny bounded operation: old rows are bookkeeping, and a
// busy object may have accumulated more than one day while it was asleep.
// Keep enough reservation headroom for the bounded DELETE and its index work.
const BUDGET_PRUNE_RESERVATION_READS = 8;
const BUDGET_PRUNE_RESERVATION_WRITES = 8;
const BUDGET_PRUNE_BATCH = 4;

/** What crediting back a reservation's unused part costs: one indexed row update. */
const REFUND_READS = 1;
const REFUND_WRITES = 1;

const SELECT_ROW = `SELECT day, ${BUDGET_COLUMNS.join(", ")} FROM resource_budgets WHERE day = ? LIMIT 1`;
/** A row from before schema 9, which a reset carries: no history count yet. */
const SELECT_ROW_BEFORE_HISTORY = `SELECT day, ${BUDGET_COLUMNS.map((column) => column === "history_reserved" ? "0 AS history_reserved" : column).join(", ")} FROM resource_budgets WHERE day = ? LIMIT 1`;

function dayFor(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function untilNextDay(ms: number): number {
  return Math.max(1000, 86_400_000 - (ms % 86_400_000));
}

function isRetryAfter(error: unknown): boolean {
  return error instanceof StoreError && error.code === "retry_after";
}

export function normalizeCost(cost: CostEstimate = {}): BudgetCost {
  return {
    reads: Math.max(0, Math.ceil(cost.reads ?? 0)),
    writes: Math.max(0, Math.ceil(cost.writes ?? 0)),
    frames: Math.max(0, Math.ceil(cost.frames ?? 0)),
    admissions: Math.max(0, Math.ceil(cost.admissions ?? 0)),
    posts: Math.max(0, Math.ceil(cost.posts ?? 0)),
    registrations: Math.max(0, Math.ceil(cost.registrations ?? 0)),
    history: Math.max(0, Math.ceil(cost.history ?? 0)),
  };
}

export class BudgetLedger {
  private cachedDay: string | null = null;
  private cached: RawBudgetRow | null = null;
  private stopLoggedDay: string | null = null;
  /** Set until the first reservation after a wake or a day's first read, which pays for that read. */
  private handoverPending = false;
  /** UTC day for which this object has already attempted bounded row pruning. */
  private prunedDay: string | null = null;

  constructor(private readonly host: LedgerHost, private readonly limits: LedgerLimits) {}

  /** A day's row, or null when it has none; never creates one. */
  readRow(day: string): RawBudgetRow | null {
    let rows: RawBudgetRow[];
    try {
      rows = this.host.rows<RawBudgetRow>(SELECT_ROW, day);
    } catch (error) {
      if (!/no such column/i.test(error instanceof Error ? error.message : String(error))) throw error;
      rows = this.host.rows<RawBudgetRow>(SELECT_ROW_BEFORE_HISTORY, day);
    }
    return rows.length ? { ...rows[0] } : null;
  }

  /**
   * On a wake of an existing schema: today's row, if any, read once. The
   * first reservation pays for that read, and pruning waits for the next
   * UTC rollover so this read stays the only work a hibernation wake does.
   */
  wake(day: string): void {
    const row = this.readRow(day);
    if (row) this.install(day, row);
    this.handoverPending = true;
    this.prunedDay = day;
  }

  /** On a fresh schema: nothing cached, and no pruning until the day after `day`. */
  start(day: string): void {
    this.forget();
    this.handoverPending = true;
    this.prunedDay = day;
  }

  /**
   * Adds to a day's counters without a capacity check, creating its row as
   * needed: the one-time bootstrap, an in-place upgrade, or a reset's carry,
   * none of which an exhausted budget may block. The next reservation reads
   * the row again.
   */
  addUnchecked(day: string, delta: BudgetDelta): void {
    // Every counter defaults to 0, so a new row names only its day: the same
    // statement serves the schema an in-place upgrade starts from.
    this.host.exec("INSERT OR IGNORE INTO resource_budgets (day) VALUES (?)", day);
    this.update(day, delta);
    this.forget();
  }

  /** A day's counters, creating its row if it has none. */
  snapshot(day: string): BudgetSnapshot {
    const row = this.rowFor(day);
    return {
      day,
      reads: row.reads_reserved,
      writes: row.writes_reserved,
      frames: row.frames_reserved,
      admissions: row.admissions_reserved,
      posts: row.posts_reserved,
      registrations: row.registrations_reserved,
      history: row.history_reserved,
      foreground_reads: row.foreground_reads,
      foreground_writes: row.foreground_writes,
      maintenance_reads: row.maintenance_reads,
      maintenance_writes: row.maintenance_writes,
    };
  }

  /**
   * Whether an admission at `at` would be refused, from the cached row only:
   * no SQL. Before a day's first reservation nothing is cached, so a previous
   * day's exhausted allowance never shows in a new day's answer.
   */
  checkConnection(at: number): void {
    const day = dayFor(at);
    if (!this.cached || this.cachedDay !== day) return;
    this.check(this.reservationCost({ reads: 64, writes: 32, admissions: 1 }, day), false, at);
  }

  /**
   * Reserves `input` plus the reservation's own bookkeeping from the day of
   * `at`, foreground or maintenance, after checking it fits (unless
   * `unchecked`: an admin command is charged but not refused). Then it
   * advances the effective clock to `now` and prunes old rows on a new day.
   * Any failure but a refusal latches accounting unsafe, so a stale copy can
   * never grant the same allowance twice.
   */
  reserve(input: CostEstimate, at: number, now: number, maintenance: boolean, unchecked: boolean): BudgetCost {
    const day = dayFor(at);
    try {
      const row = this.today(day);
      const pruning = this.prunedDay !== day;
      const cost = this.reservationCost(input, day);
      if (!unchecked) this.check(cost, maintenance, at);
      this.apply(day, row, {
        reads_reserved: cost.reads,
        writes_reserved: cost.writes,
        frames_reserved: cost.frames,
        admissions_reserved: cost.admissions,
        posts_reserved: cost.posts,
        registrations_reserved: cost.registrations,
        history_reserved: cost.history,
        foreground_reads: maintenance ? 0 : cost.reads,
        foreground_writes: maintenance ? 0 : cost.writes,
        maintenance_reads: maintenance ? cost.reads : 0,
        maintenance_writes: maintenance ? cost.writes : 0,
      }, "budget reservation did not update durable state");
      this.handoverPending = false;
      // Persist the monotonic effective clock only after the cached capacity
      // check has accepted the reservation; rejected floods therefore do not
      // issue an uncharged meta write.
      this.host.advanceClock(now);
      if (pruning) this.prune(day);
      return { ...cost, day, maintenance };
    } catch (error) {
      if (!isRetryAfter(error)) this.host.markUnsafe();
      throw error;
    }
  }

  /**
   * Spends the maintenance control reserve when ordinary maintenance is
   * exhausted: checked against the whole maintenance allocation, with no
   * bookkeeping overhead and no refund.
   */
  reserveControl(input: CostEstimate, at: number): BudgetCost {
    const day = dayFor(at);
    try {
      const row = this.today(day);
      const cost = normalizeCost(input);
      const reads = Math.max(1, cost.reads);
      const writes = Math.max(1, cost.writes);
      if (row.maintenance_reads + reads > this.limits.maintenanceReadsPerDay ||
          row.maintenance_writes + writes > this.limits.maintenanceWritesPerDay ||
          row.reads_reserved + reads > this.limits.sqlReadsPerDay ||
          row.writes_reserved + writes > this.limits.sqlWritesPerDay) {
        throw new StoreError("retry_after", "Maintenance control budget exhausted", { retryAfterMs: untilNextDay(at) });
      }
      this.apply(day, row, {
        reads_reserved: reads,
        writes_reserved: writes,
        maintenance_reads: reads,
        maintenance_writes: writes,
      }, "maintenance reservation did not update durable state");
      this.handoverPending = false;
      return { reads, writes, frames: cost.frames, admissions: cost.admissions, posts: cost.posts, registrations: cost.registrations, history: cost.history };
    } catch (error) {
      if (!isRetryAfter(error)) this.host.markUnsafe();
      throw error;
    }
  }

  /**
   * Credits back what a finished reservation did not use, so the day's budget
   * counts the SQL actually done. The reservation still gated the work up
   * front, so no request can exceed what the ceiling allowed it. The credit is
   * one row update, paid from the reservation it returns: an operation is
   * charged its observed rows plus that one. `unused` gives back history
   * pages a refused request reserved, in the same update.
   */
  refund(reserved: BudgetCost, actualReads: number, actualWrites: number, unused?: { history: number }): void {
    const row = this.cached;
    if (!reserved.day || !row || this.cachedDay !== reserved.day) return;
    const reads = reserved.reads - actualReads - REFUND_READS;
    const writes = reserved.writes - actualWrites - REFUND_WRITES;
    const history = Math.min(reserved.history, Math.max(0, unused?.history ?? 0));
    if (reads <= 0 && writes <= 0 && history === 0) return;
    const creditReads = Math.max(0, reads);
    const creditWrites = Math.max(0, writes);
    const maintenance = reserved.maintenance === true;
    try {
      this.apply(reserved.day, row, {
        ...(history ? { history_reserved: -history } : {}),
        reads_reserved: -creditReads,
        writes_reserved: -creditWrites,
        foreground_reads: maintenance ? 0 : -creditReads,
        foreground_writes: maintenance ? 0 : -creditWrites,
        maintenance_reads: maintenance ? -creditReads : 0,
        maintenance_writes: maintenance ? -creditWrites : 0,
      });
    } catch {
      // A failed credit only leaves the day over-charged, which is safe.
    }
  }

  /** Forgets the cached row; the next reservation reads it again. */
  forget(): void {
    this.cachedDay = null;
    this.cached = null;
  }

  /** The cached row for `day`, reading (and creating) it on a wake or a new day. */
  private today(day: string): RawBudgetRow {
    if (this.cachedDay !== day || !this.cached) {
      // This is the one bounded wake/day rollover read. Once loaded, the
      // synchronous DO serialization makes the cache authoritative until
      // the next day, so repeated denied work performs no SQL at all.
      this.install(day, this.rowFor(day));
      this.handoverPending = true;
    }
    return this.cached!;
  }

  private rowFor(day: string): RawBudgetRow {
    const row = this.readRow(day);
    if (row) return row;
    this.host.exec("INSERT INTO resource_budgets (day) VALUES (?)", day);
    return { day, ...Object.fromEntries(BUDGET_COLUMNS.map((column) => [column, 0])) } as RawBudgetRow;
  }

  private install(day: string, row: RawBudgetRow): void {
    this.cachedDay = day;
    this.cached = { ...row };
  }

  /** Adds `delta` to `day`'s row, then to the cached copy of it, `row`. */
  private apply(day: string, row: RawBudgetRow, delta: BudgetDelta, failure?: string): void {
    const cursor = this.update(day, delta);
    if (failure !== undefined && cursor.rowsWritten !== undefined && cursor.rowsWritten < 1) {
      throw new StoreError("internal_error", failure);
    }
    const next: RawBudgetRow = { ...row, day };
    for (const [column, amount] of Object.entries(delta) as [BudgetColumn, number][]) next[column] += amount;
    this.install(day, next);
  }

  /** The one statement that changes a day's counters: one indexed row update, naming only the counters that change. */
  private update(day: string, delta: BudgetDelta): { rowsWritten?: number } {
    const changed = (Object.keys(delta) as BudgetColumn[]).filter((column) => delta[column]);
    // A delta of all zeros still touches the row, so `apply` can confirm it exists.
    const columns = changed.length ? changed : ["reads_reserved" as const];
    return this.host.exec(
      `UPDATE resource_budgets SET ${columns.map((column) => `${column} = ${column} + ?`).join(", ")} WHERE day = ?`,
      // `|| 0` binds a zero credit (-0) as the integer 0.
      ...columns.map((column) => delta[column] || 0),
      day,
    );
  }

  private reservationCost(input: CostEstimate, day: string): BudgetCost {
    const cost = normalizeCost(input);
    // A reservation includes its own bounded control work: effective-clock
    // read/write, budget-row lookup/creation, and the durable counter update.
    // Keep fixed headroom in every class so read-only callers still pay for
    // the bookkeeping writes they cause.
    cost.reads = Math.max(1, cost.reads + 8);
    cost.writes = Math.max(1, cost.writes + 8);
    if (this.handoverPending) {
      cost.reads += 8;
      cost.writes += 8;
    }
    if (this.prunedDay !== day) {
      cost.reads += BUDGET_PRUNE_RESERVATION_READS;
      cost.writes += BUDGET_PRUNE_RESERVATION_WRITES;
    }
    return cost;
  }

  private check(cost: BudgetCost, maintenance: boolean, at: number): void {
    const row = this.cached!;
    const limits = this.limits;
    if (cost.history > 0 && row.history_reserved + cost.history > limits.historyRequestsPerDay) {
      // A refusal like any other: no SQL, and the SQL budget stays for everything else.
      throw new StoreError("retry_after", "History is busy until the daily reset", { retryAfterMs: untilNextDay(at) });
    }
    const readCeiling = maintenance ? limits.sqlReadsPerDay : limits.foregroundReadsPerDay;
    const writeCeiling = maintenance ? limits.sqlWritesPerDay : limits.foregroundWritesPerDay;
    const reserveReads = maintenance ? limits.maintenanceReadsPerDay - MAINTENANCE_CONTROL_READS : 0;
    const reserveWrites = maintenance ? limits.maintenanceWritesPerDay - MAINTENANCE_CONTROL_WRITES : 0;
    if (row.reads_reserved + cost.reads > limits.sqlReadsPerDay || (!maintenance && row.foreground_reads + cost.reads > readCeiling) ||
        (maintenance && row.maintenance_reads + cost.reads > reserveReads) ||
        row.writes_reserved + cost.writes > limits.sqlWritesPerDay || (!maintenance && row.foreground_writes + cost.writes > writeCeiling) ||
        (maintenance && row.maintenance_writes + cost.writes > reserveWrites)) {
      const day = dayFor(at);
      if (this.stopLoggedDay !== day) {
        this.stopLoggedDay = day;
        console.warn(JSON.stringify({ event: "daily_budget_exhausted", ...row,
          requested_reads: cost.reads, requested_writes: cost.writes, maintenance,
          foreground_read_limit: limits.foregroundReadsPerDay,
          foreground_write_limit: limits.foregroundWritesPerDay,
          total_read_limit: limits.sqlReadsPerDay, total_write_limit: limits.sqlWritesPerDay }));
      }
      throw new StoreError("retry_after", maintenance ? "Maintenance budget exhausted" : "Demo capacity reached", {
        retryAfterMs: untilNextDay(at),
        data: { reason: "daily_budget" },
      });
    }
  }

  /** Remove a bounded prefix of stale UTC budget rows after day rollover. */
  private prune(activeDay: string): void {
    if (this.prunedDay === activeDay) return;
    // Mark the attempt before issuing SQL. A platform error must not make
    // every subsequent request repeat the same maintenance work; the durable
    // reservation remains charged and a later object/day can retry it.
    this.prunedDay = activeDay;
    // Retain the immediately previous day for bounded operator inspection and
    // crash/restart diagnostics. It cannot replenish the active day's lease,
    // because a reservation always keys authority by the current UTC day.
    const activeStart = Date.parse(`${activeDay}T00:00:00.000Z`);
    const pruneBefore = Number.isFinite(activeStart)
      ? new Date(activeStart - 86_400_000).toISOString().slice(0, 10)
      : activeDay;
    this.host.exec(
      `DELETE FROM resource_budgets
       WHERE day IN (
         SELECT day FROM resource_budgets
         WHERE day < ? ORDER BY day ASC LIMIT ?
       )`,
      pruneBefore,
      BUDGET_PRUNE_BATCH,
    );
  }
}
