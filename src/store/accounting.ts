/** Accounting and breaker policy: refusal reasons, which operations a breaker spares, and the guard's stored form. */

import type { AccountingGuard } from "./types";
import type { BudgetDelta } from "../budget-ledger";

/** The accounting marker's value after a storage failure (markAccountingUnsafe), cleared without an operator. */
export const ACCOUNTING_UNCERTAIN = "uncertain";
/** `data.reason` of the internal error a storage failure raises (assertAccounting), which the socket layer words for people. */
export const STORAGE_UNAVAILABLE = "storage_unavailable";
/** `data.reason` of the `retry_after` an operation gets while its breaker is open (assertAccounting). */
export const OPERATION_PAUSED = "operation_paused";
/** How far back `/status` counts throttle trips (throttleTrips). */
export const TRIP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Overruns of one operation within BREAKER_WINDOW_MS that open its breaker. */
export const BREAKER_OVERRUNS = 3;
export const BREAKER_WINDOW_MS = 60 * 60 * 1000;
/** How long an open breaker refuses its operation. */
export const BREAKER_MS = 60 * 60 * 1000;
/** `data.reason` of the `retry_after` a feature the degraded tier turns off gets. */
export const DEGRADED = "degraded";

export function emptyGuard(): AccountingGuard {
  return { day: "", overruns: 0, breakers: {}, recent: {} };
}

export function parseGuard(raw: string): AccountingGuard {
  const guard = emptyGuard();
  try {
    const value = JSON.parse(raw) as Partial<AccountingGuard>;
    if (typeof value.day === "string") guard.day = value.day;
    if (Number.isSafeInteger(value.overruns)) guard.overruns = value.overruns!;
    for (const [op, end] of Object.entries(value.breakers ?? {})) if (Number.isFinite(end)) guard.breakers[op] = end;
    for (const [op, times] of Object.entries(value.recent ?? {})) if (Array.isArray(times)) guard.recent[op] = times.filter((time) => Number.isFinite(time));
  } catch {
    // An unreadable row starts clean: nothing it held is a stop.
  }
  return guard;
}

/**
 * Operation names. Each reservation names its operation explicitly
 * (SqliteStore.reserveCost's `operation`), and overrun logs, breaker keys and
 * the sets below are keyed by that name: the SqliteStore method that makes
 * the reservation, which for code moved to a module is the method it moved
 * from. History pages reserve as `history` (the name BREAKER_ALERT_ONLY
 * lists), where the stack once named them `historyImpl`. The metering entry
 * points the runtime calls (withMeter, withMeterAsync, the meter part), and
 * the history chain's state and cold chunk index closures, reserve as
 * `unknown`. test/store/operation-names.test.ts pins a representative set,
 * and that every name in the sets below is one a reservation uses.
 */
/**
 * Operations every request or connection passes through, which a breaker
 * never refuses: refusing them would refuse everything (an overrun in one is
 * still charged, logged and told).
 */
export const BREAKER_EXEMPT = new Set(["reserveFrames", "reserveConnection", "getRoom", "unknown"]);
/**
 * Operations people cannot use the server without: signing in and
 * registering, and the room list, members and history a client loads first.
 * An overrun of one never opens a breaker; it is told to the admins at most
 * once an hour instead (OverrunNotice.essential), and its excess is charged.
 */
export const BREAKER_ALERT_ONLY: ReadonlySet<string> = new Set([
  "reserveAuthAttempt", "registerIdentity", "addCredential", "getCredential", "getIdentity", "updateCredentialCounter",
  "listRooms", "roomMembers", "history",
]);

/** Uncharged maintenance work's addition to a day's budget row. */
export function maintenanceDelta(cost: { reads: number; writes: number }): BudgetDelta {
  return { reads_reserved: cost.reads, writes_reserved: cost.writes, maintenance_reads: cost.reads, maintenance_writes: cost.writes };
}
