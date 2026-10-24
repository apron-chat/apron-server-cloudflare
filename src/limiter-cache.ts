/*
 * The limiter-row cache: a user's or an IP's `principal_limits` row in a
 * minute-limited scope (CACHED_LIMIT_SCOPES), kept in memory and written at
 * most once a minute.
 *
 * Server-wide totals keep the deployment's bill bounded and stay written
 * through; a principal's own limits may be approximate. So a cached row
 * changes in memory and is written once LIMITER_FLUSH_MS has passed since it
 * last was, on a new UTC day, and on its first charge; past
 * LIMITER_CACHE_ROWS the least recently used row is written (if it must be)
 * and dropped. An eviction forgets at most the last minute of one
 * principal's charges. Inside a storage transaction every entry changed is
 * journaled first, so a rollback restores the cache with the rows.
 *
 * The store keeps the SQL: it reads and inserts rows and hands them over
 * (`loaded`, `created`), and the cache writes through its host.
 */

const MINUTE_MS = 60 * 1000;
const DAY_MS = 86_400_000;

/**
 * The minute-limited scopes whose per-principal rows (a user's, an IP's;
 * never `global`) are cached: server-wide counts, and every daily allowance
 * that is not a principal's, stay written through.
 */
export const CACHED_LIMIT_SCOPES: ReadonlySet<string> = new Set(["post", "history", "auth", "admission", "frames"]);
/** How long a cached limiter row may hold changes it has not written. */
export const LIMITER_FLUSH_MS = MINUTE_MS;
/** Cached limiter rows at most; past it the least recently used one is written (if it must be) and dropped. */
export const LIMITER_CACHE_ROWS = 256;

export interface RawLimitRow {
  scope: string;
  principal_key: string;
  /** The scope's rate limiter (limiter.ts): events outstanding as of `level_ms`, 0 when never charged. */
  level: number;
  level_ms: number;
  day: string;
  posts_day: number;
  registrations_day: number;
  uploads_day: number;
  updated_ms: number;
}

/** What the cache needs from the store: the one statement that writes a row. */
export interface LimiterCacheHost {
  /** Writes a row's counters, and `now` as its `updated_ms`. */
  write(row: RawLimitRow, now: number): void;
}

/** A row as cached: `dirty` when it holds changes not yet written, last written at `writtenMs`. */
interface Entry {
  row: RawLimitRow;
  writtenMs: number;
  dirty: boolean;
}

function idOf(scope: string, principalKey: string): string {
  return `${scope}\n${principalKey}`;
}

export class LimiterCache {
  /** Least recently used first. */
  private readonly entries = new Map<string, Entry>();
  /** Inside a transaction: each entry before the transaction first changed it, restored on rollback. */
  private journal: Map<string, Entry | undefined> | null = null;

  constructor(private readonly host: LimiterCacheHost, private readonly capacity = LIMITER_CACHE_ROWS) {}

  /** Whether `scope`'s row for `principalKey` is one the cache holds: a principal's in CACHED_LIMIT_SCOPES. */
  covers(scope: string, principalKey: string): boolean {
    return CACHED_LIMIT_SCOPES.has(scope) && principalKey !== "global";
  }

  get size(): number {
    return this.entries.size;
  }

  /** A copy of the cached row, which becomes the most recently used; undefined when it is not cached. */
  get(scope: string, principalKey: string): RawLimitRow | undefined {
    const id = idOf(scope, principalKey);
    const hit = this.entries.get(id);
    if (!hit) return undefined;
    this.entries.delete(id);
    this.entries.set(id, hit);
    return { ...hit.row };
  }

  /** A copy of the cached row as it stands, without counting a use. */
  peek(scope: string, principalKey: string): RawLimitRow | undefined {
    const hit = this.entries.get(idOf(scope, principalKey));
    return hit ? { ...hit.row } : undefined;
  }

  /** Caches a row just read from storage, as written at `now`. */
  loaded(row: RawLimitRow, now: number): void {
    if (!this.covers(row.scope, row.principal_key)) return;
    this.set(idOf(row.scope, row.principal_key), { row: { ...row }, writtenMs: now, dirty: false }, now);
  }

  /** Caches a row just inserted. Never written since: its first charge writes through, so it survives an eviction. */
  created(row: RawLimitRow, now: number): void {
    if (!this.covers(row.scope, row.principal_key)) return;
    this.set(idOf(row.scope, row.principal_key), { row: { ...row }, writtenMs: -Infinity, dirty: false }, now);
  }

  /**
   * Takes a covered row's new counters. They stay in memory while the row
   * was last written within LIMITER_FLUSH_MS and the same UTC day; otherwise
   * they are written now, `updated_ms` with them.
   */
  change(next: RawLimitRow, now: number): void {
    const id = idOf(next.scope, next.principal_key);
    const entry = this.entries.get(id);
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
    if (entry && now - entry.writtenMs < LIMITER_FLUSH_MS && entry.writtenMs >= dayStart) {
      this.set(id, { row: { ...next }, writtenMs: entry.writtenMs, dirty: true }, now);
      return;
    }
    this.host.write(next, now);
    this.set(id, { row: { ...next, updated_ms: now }, writtenMs: now, dirty: false }, now);
  }

  /** Writes what a cached row holds and has not written, and uncaches it: the store is about to change it in SQL. */
  writeOut(scope: string, principalKey: string, now: number): void {
    const id = idOf(scope, principalKey);
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.dirty) this.host.write(entry.row, now);
    this.remove(id);
  }

  /** Uncaches a row unwritten: the store deleted it. */
  drop(scope: string, principalKey: string): void {
    this.remove(idOf(scope, principalKey));
  }

  /** Uncaches a principal's row in every scope unwritten: the store deleted them. */
  dropPrincipal(principalKey: string): void {
    for (const scope of CACHED_LIMIT_SCOPES) this.remove(idOf(scope, principalKey));
  }

  /** Forgets every row unwritten: the storage they came from is gone. */
  clear(): void {
    this.entries.clear();
  }

  /** Starts journaling: a storage transaction has begun. */
  begin(): void {
    this.journal = new Map();
  }

  /** The transaction committed: what it changed stands. */
  commit(): void {
    this.journal = null;
  }

  /** The transaction rolled back, and with it every row it wrote: restores each entry it changed, evicted ones too. */
  rollback(): void {
    const journal = this.journal;
    this.journal = null;
    for (const [id, entry] of journal ?? []) {
      if (entry) this.entries.set(id, entry);
      else this.entries.delete(id);
    }
  }

  /** Sets an entry, as the most recently used, and drops the least recently used past the cap. */
  private set(id: string, entry: Entry, now: number): void {
    this.remove(id);
    this.entries.set(id, entry);
    while (this.entries.size > this.capacity) {
      const [oldest, dropped] = this.entries.entries().next().value as [string, Entry];
      if (dropped.dirty) this.host.write(dropped.row, now);
      this.remove(oldest);
    }
  }

  /** Deletes an entry, noting what it was for a rollback. */
  private remove(id: string): void {
    if (this.journal && !this.journal.has(id)) this.journal.set(id, this.entries.get(id));
    this.entries.delete(id);
  }
}
