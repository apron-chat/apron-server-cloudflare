/*
 * Webhook storage (protocol §4.9.4, push kind `webhook`): each bot's
 * registrations (`webhooks`), and the day's call counters (rows of
 * `principal_limits`, through the core's limiter rows). Every registration
 * is also held in memory once read (`all`), so matching a message against
 * them reads no row; every write here refreshes that copy, and /purge and
 * /rename (sqlite-store.ts) drop it.
 */

import { WAKE_SCOPES } from "../domain";
import { WEBHOOK_LIMITS } from "../webhook";
import { StoreError } from "../store-error";
import { BOT_PREFIX } from "./limits";
import { dayCount, dayFor, integerColumn, parseJson, parseRoles, utf8Bytes } from "./rows";
import type { MessageSnapshot } from "./types";
import type { Sql, StoreCore } from "./core";
import { MAX_PUSH_URL_BYTES } from "../domain";
import { WEBHOOKS_DDL } from "./schema";

/** The states a webhook is in: the protocol's three, and `paused` by its bot's owner (shown as `failing`). */
export type WebhookState = "verifying" | "on" | "failing" | "paused";
export type WebhookFormat = "full" | "knock";

/** One webhook registration (protocol §4.9.4). */
export interface WebhookRecord {
  userId: string;
  /** The endpoint, as `new URL(url).href` spells it. */
  url: string;
  /** The endpoint ID its signatures carry: unique, with no `.`, kept while the registration is. */
  endpointId: string;
  /** The server's address the registering connection reached (§1), as each call's `server`. */
  server: string;
  /** Its WAKE_SCOPES bitmask, never 0. */
  wake: number;
  format: WebhookFormat;
  state: WebhookState;
  /** When it last failed and why, if it has. */
  error?: string;
  /** Calls given up in a row since the last that succeeded. */
  failures: number;
  createdMs: number;
  updatedMs: number;
}

interface RawWebhookRow {
  user_id: string;
  url: string;
  endpoint_id: string;
  server: string;
  wake: number;
  format: string;
  state: string;
  error: string;
  failures: number;
  created_ms: number;
  updated_ms: number;
}

const COLUMNS = "user_id, url, endpoint_id, server, wake, format, state, error, failures, created_ms, updated_ms";
/** Longest `error` kept, in bytes. */
const MAX_ERROR_BYTES = 200;
/** Limiter scope of the day's call counters: `global`, and `user:<user_id>` for each bot. */
export const WEBHOOK_CALL_SCOPE = "webhook";

function record(row: RawWebhookRow): WebhookRecord {
  const state = (["verifying", "on", "failing", "paused"] as const).find((value) => value === row.state) ?? "failing";
  return {
    userId: row.user_id, url: row.url, endpointId: row.endpoint_id, server: row.server, wake: integerColumn(row.wake),
    format: row.format === "knock" ? "knock" : "full", state, ...(row.error ? { error: row.error } : {}),
    failures: integerColumn(row.failures), createdMs: integerColumn(row.created_ms), updatedMs: integerColumn(row.updated_ms),
  };
}

function shortError(text: string): string {
  let cut = text;
  while (utf8Bytes(cut) > MAX_ERROR_BYTES) cut = [...cut].slice(0, -1).join("");
  return cut;
}

/**
 * Whether an account may hold a webhook: an owner's bot (`bot_<owner>`, an
 * identity of tier `bot`), or a registered user with the role `bot`. A
 * connection's tier is `registered` for both.
 */
export function webhookAccount(userId: string, tier: string, roles: readonly string[]): boolean {
  return tier === "bot" || (tier === "registered" && (userId.startsWith(BOT_PREFIX) || roles.includes("bot")));
}

/** Webhooks (protocol §4.9.4) over the store's core: the Webhooks part's implementation. */
export class WebhooksModule {
  /** Every registration, once read: what a message is matched against with no SQL. */
  private cache: WebhookRecord[] | undefined;

  /** Whether this instance has made sure the table exists (WEBHOOKS_DDL). */
  private tableReady = false;

  constructor(private readonly core: StoreCore) {}

  /**
   * Makes the table where an object made before it lacks it, once an
   * instance. Every query here runs after `all`, whose read finds whether it
   * is there, and so does /purge, which names the table.
   */
  ensureTable(sql: Sql): void {
    if (this.tableReady) return;
    sql.exec(WEBHOOKS_DDL);
    this.tableReady = true;
  }

  /** Forgets the copy in memory, after a write this module did not make (/purge, /rename). */
  invalidate(): void {
    this.cache = undefined;
  }

  /** Every registration, at most WEBHOOK_LIMITS.perServer: from memory, else one range read. */
  all(now = this.core.clock.now()): readonly WebhookRecord[] {
    if (this.cache) return this.cache;
    this.core.ensureReady();
    const rows = this.core.reserved("webhooks", { reads: 8 + WEBHOOK_LIMITS.perServer, writes: 4 }, false, now, (sql) => {
      const read = () => sql.rows<RawWebhookRow>(`SELECT ${COLUMNS} FROM webhooks LIMIT ?`, WEBHOOK_LIMITS.perServer);
      if (this.tableReady) return read();
      // The read itself is the probe: only an object made before the table lacks it.
      try {
        const found = read();
        this.tableReady = true;
        return found;
      } catch (error) {
        if (!/no such table/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
      this.ensureTable(sql);
      return read();
    });
    this.cache = rows.map(record);
    return this.cache;
  }

  /** A user's registrations, from memory (all). */
  of(userId: string, now?: number): WebhookRecord[] {
    return this.all(now).filter((hook) => hook.userId === userId);
  }

  /**
   * `push_register` kind `webhook`: keeps the user's registration of `url`.
   * Only for accounts webhookAccount allows (`denied` otherwise), read from
   * the identity row. Registering a held `url` again keeps its `endpoint_id`
   * and changes its scopes, format and server; one `failing` is verified
   * again (`verifying`), one its owner paused stays paused. A new one starts
   * `verifying`, with a fresh `endpoint_id`, within WEBHOOK_LIMITS.perUser
   * for the user and perServer for the server (`denied` past either).
   * `verify` says whether the caller sends an endpoint verification now.
   */
  register(input: { userId: string; url: string; server: string; wake: number; format: WebhookFormat; endpointId: string; now?: number }): { hook: WebhookRecord; verify: boolean } {
    this.core.ensureReady();
    if (utf8Bytes(input.url) > MAX_PUSH_URL_BYTES) throw new StoreError("too_large", "url is too long");
    if (!Number.isInteger(input.wake) || input.wake <= 0 || (input.wake & ~(WAKE_SCOPES.mentions | WAKE_SCOPES.replies | WAKE_SCOPES.private | WAKE_SCOPES.joined)) !== 0) {
      throw new StoreError("invalid_params", "wake must select a scope this server supports for webhooks");
    }
    const now = input.now ?? this.core.clock.now();
    const all = this.all(now);
    const rows = WEBHOOK_LIMITS.perUser + 2;
    const result = this.core.reserved("registerWebhook", { reads: 16 + 2 * rows, writes: 16 + 4 * rows }, false, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      const identity = sql.identityRow(input.userId);
      if (!identity || !webhookAccount(identity.user_id, identity.tier, parseRoles(identity.roles_json))) {
        throw new StoreError("denied", "Only bots may register a webhook here");
      }
      const existing = sql.rows<RawWebhookRow>(`SELECT ${COLUMNS} FROM webhooks WHERE user_id = ? AND url = ? LIMIT 1`, input.userId, input.url)[0];
      if (!existing) {
        if (all.filter((hook) => hook.userId === input.userId).length >= WEBHOOK_LIMITS.perUser) {
          throw new StoreError("denied", `An account holds at most ${WEBHOOK_LIMITS.perUser} webhooks; unregister one first`);
        }
        if (all.length >= WEBHOOK_LIMITS.perServer) throw new StoreError("denied", "This server holds as many webhooks as it can");
        sql.ensureGrowthCapacity(2 * MAX_PUSH_URL_BYTES);
        sql.exec(
          `INSERT INTO webhooks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 'verifying', '', 0, ?, ?)`,
          input.userId, input.url, input.endpointId, input.server, input.wake, input.format, effective, effective,
        );
        return { row: { ...record({ user_id: input.userId, url: input.url, endpoint_id: input.endpointId, server: input.server, wake: input.wake, format: input.format, state: "verifying", error: "", failures: 0, created_ms: effective, updated_ms: effective }) }, verify: true };
      }
      const held = record(existing);
      const state: WebhookState = held.state === "failing" ? "verifying" : held.state;
      const changed = held.wake !== input.wake || held.format !== input.format || held.server !== input.server || state !== held.state;
      if (changed) {
        sql.exec(
          "UPDATE webhooks SET wake = ?, format = ?, server = ?, state = ?, error = CASE WHEN ? THEN '' ELSE error END, failures = CASE WHEN ? THEN 0 ELSE failures END, updated_ms = ? WHERE user_id = ? AND url = ?",
          input.wake, input.format, input.server, state, state !== held.state ? 1 : 0, state !== held.state ? 1 : 0, effective, input.userId, input.url,
        );
      }
      const row: WebhookRecord = { ...held, wake: input.wake, format: input.format, server: input.server, state, ...(changed ? { updatedMs: effective } : {}) };
      if (state !== held.state) {
        delete row.error;
        row.failures = 0;
      }
      return { row, verify: state === "verifying" };
    }));
    this.invalidate();
    return { hook: result.row, verify: result.verify };
  }

  /** `push_unregister`: removes the user's registration of `url`, if any; whether one went. No SQL when none is held. */
  remove(input: { userId: string; url: string; now?: number }): boolean {
    const now = input.now ?? this.core.clock.now();
    if (!this.all(now).some((hook) => hook.userId === input.userId && hook.url === input.url)) return false;
    this.core.reserved("removeWebhook", { reads: 8, writes: 8 }, false, now, (sql) => {
      sql.exec("DELETE FROM webhooks WHERE user_id = ? AND url = ?", input.userId, input.url);
    });
    this.invalidate();
    return true;
  }

  /** Removes a registration by its endpoint, as a 410 asks (§4.9.1), or as its bot's owner does. */
  forget(input: { userId: string; endpointId: string; now?: number }): boolean {
    const now = input.now ?? this.core.clock.now();
    const hook = this.all(now).find((entry) => entry.userId === input.userId && entry.endpointId === input.endpointId);
    if (!hook) return false;
    this.core.reserved("forgetWebhook", { reads: 8, writes: 8 }, false, now, (sql) => {
      sql.exec("DELETE FROM webhooks WHERE user_id = ? AND url = ? AND endpoint_id = ?", hook.userId, hook.url, hook.endpointId);
    });
    this.invalidate();
    return true;
  }

  /**
   * Sets a registration's state and `error` (absent clears it), and its
   * count of failures, only while it is still the same registration (its
   * `endpoint_id`), so a call that ends after a re-registration or removal
   * changes nothing. One primary-key write; none when nothing changes.
   */
  update(input: { userId: string; endpointId: string; state?: WebhookState; error?: string | null; failures?: number; now?: number }): WebhookRecord | undefined {
    const now = input.now ?? this.core.clock.now();
    const hook = this.all(now).find((entry) => entry.userId === input.userId && entry.endpointId === input.endpointId);
    if (!hook) return undefined;
    const state = input.state ?? hook.state;
    const error = input.error === undefined ? hook.error ?? "" : input.error === null ? "" : shortError(input.error);
    const failures = input.failures ?? hook.failures;
    if (state === hook.state && error === (hook.error ?? "") && failures === hook.failures) return hook;
    this.core.reserved("updateWebhook", { reads: 8, writes: 8 }, false, now, (sql) => {
      sql.exec(
        "UPDATE webhooks SET state = ?, error = ?, failures = ?, updated_ms = ? WHERE user_id = ? AND url = ? AND endpoint_id = ?",
        state, error, failures, this.core.effectiveNow(now), hook.userId, hook.url, hook.endpointId,
      );
    });
    this.invalidate();
    return { ...hook, state, failures, ...(error ? { error } : {}) };
  }

  /**
   * Charges one call to the server's `callsPerDay` and the bot's
   * `callsPerUserDay` (WEBHOOK_LIMITS), as it is made, delivered or not:
   * whether it may go. Two limiter rows, written only when it may.
   */
  chargeCall(userId: string, now = this.core.clock.now()): boolean {
    this.core.ensureReady();
    return this.core.reserved("chargeWebhookCall", { reads: 16, writes: 16 }, false, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      const day = dayFor(effective);
      const server = sql.limitRow(WEBHOOK_CALL_SCOPE, "global", effective);
      const bot = sql.limitRow(WEBHOOK_CALL_SCOPE, `user:${userId}`, effective);
      const sent = dayCount(server, "posts_day", day);
      const received = dayCount(bot, "posts_day", day);
      if (sent >= WEBHOOK_LIMITS.callsPerDay || received >= WEBHOOK_LIMITS.callsPerUserDay) return false;
      sql.updateLimitRow(server, { day, posts_day: sent + 1 }, effective);
      sql.updateLimitRow(bot, { day, posts_day: received + 1 }, effective);
      return true;
    }));
  }

  /**
   * A message as it is now, for a call's `reply_to` (protocol §4.9.4: the
   * replied-to message as a full snapshot): null when unknown, expired or
   * deleted. One metered lookup.
   */
  message(messageId: string, now = this.core.clock.now()): MessageSnapshot | null {
    this.core.ensureReady();
    return this.core.reserved("webhookMessage", { reads: 8 }, false, now, (sql) => {
      const row = sql.currentMessage(messageId, sql.logState().history_floor);
      const snapshot = row ? parseJson<MessageSnapshot>(row.snapshot_json) : null;
      return snapshot && !snapshot.deleted ? snapshot : null;
    });
  }

  /** Calls made today, for `/status`. */
  callsToday(now = this.core.clock.now()): number {
    this.core.ensureReady();
    return this.core.reserved("webhookCallsToday", { reads: 8 }, false, now, (sql) => {
      const row = sql.rows<{ day: string; posts_day: number }>(
        "SELECT day, posts_day FROM principal_limits WHERE scope = ? AND principal_key = ? LIMIT 1", WEBHOOK_CALL_SCOPE, "global",
      )[0];
      return dayCount(row, "posts_day", dayFor(this.core.effectiveNow(now)));
    });
  }
}
