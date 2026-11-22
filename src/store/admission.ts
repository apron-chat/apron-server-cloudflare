/*
 * Admission control: the per-principal limits kept in `principal_limits`
 * (through the core's cached limiter rows) that posting, events,
 * registrations, sign-in attempts, guest numbers, frames and connections are
 * charged to, the throttle trips counted for `/status`, and the attack pause.
 * The Admission part (sqlite-parts.ts) delegates here; the commit path
 * charges through chargePosting, chargeEvent and chargeRegistration.
 */

import { type Bucket, type Rate, chargeBucket } from "../limiter";
import { type LimitCategory, StoreError, limitData } from "../store-error";
import { TRIP_WINDOW_MS } from "./accounting";
import { GUEST_NUMBER_BLOCK_COST, MAX_SAFE_ID } from "./limits";
import { META_ATTACK_PAUSE, META_GUEST_NUMBER_MARK, META_THROTTLE_TRIPS } from "./meta";
import { bucketOf, bucketRow, dayCount, dayFor, integerColumn } from "./rows";
import type { Tier } from "./types";
import type { Sql, StoreCore } from "./core";

/** Admission control over the store's core: the Admission part's implementation, and the charges the commit path makes. */
export class AdmissionModule {
  constructor(private readonly core: StoreCore) {}

  /**
   * Counts one throttle trip (a long refusal a user ran into, told to them
   * once: ApronDemoServer.noteTrip) under `trigger`, in hourly buckets kept
   * for TRIP_WINDOW_MS. Charged but never refused: counting a refusal must
   * not itself be refused.
   */
  noteThrottleTrip(trigger: string, now = this.core.clock.now()): void {
    this.core.ensureReady();
    this.core.alert(() => this.core.reserved("noteThrottleTrip", { reads: 4, writes: 4 }, false, now, (sql) => {
      const buckets = this.tripBuckets(sql, now);
      const hour = String(Math.floor(now / 3_600_000) * 3_600_000);
      const bucket = buckets[hour] ??= {};
      // Bounded: a trigger is a reason or a short slug, and the window is a day of hours.
      if (bucket[trigger] !== undefined || Object.keys(bucket).length < 64) bucket[trigger] = (bucket[trigger] ?? 0) + 1;
      sql.writeMeta(META_THROTTLE_TRIPS, JSON.stringify(buckets));
    }, true));
  }

  /** Throttle trips by trigger over the last TRIP_WINDOW_MS (noteThrottleTrip), most first. */
  throttleTrips(now = this.core.clock.now()): Array<[trigger: string, count: number]> {
    this.core.ensureReady();
    return this.core.alert(() => this.core.reserved("throttleTrips", { reads: 4 }, false, now, (sql) => {
      const totals = new Map<string, number>();
      for (const bucket of Object.values(this.tripBuckets(sql, now))) {
        for (const [trigger, count] of Object.entries(bucket)) totals.set(trigger, (totals.get(trigger) ?? 0) + count);
      }
      return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    }, true));
  }

  /** The stored trip buckets still inside the window. */
  private tripBuckets(sql: Sql, now: number): Record<string, Record<string, number>> {
    // An unreadable record starts the window afresh.
    return sql.metaJson(META_THROTTLE_TRIPS, (stored) => {
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

  /**
   * The runtime's attack pause record (ApronDemoServer.pauseForAttack), or ""
   * before any. Read once as an instance starts, uncharged like the usage
   * snapshot, so a paused server's refusals cost no SQL.
   */
  attackPause(): string {
    this.core.ensureReady();
    return this.core.unmetered((sql) => sql.metaValue(META_ATTACK_PAUSE) ?? "");
  }

  /** Records an attack pause (attackPause): charged, never refused. */
  setAttackPause(value: string, now = this.core.clock.now()): void {
    this.core.ensureReady();
    this.core.alert(() => this.core.reserved("setAttackPause", { reads: 4, writes: 4 }, false, now, (sql) => {
      sql.writeMeta(META_ATTACK_PAUSE, value);
    }, true));
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
  chargePosting(sql: Sql, input: { userId: string; tier: Tier; ipKey: string; now: number; weight?: number; uncategorized?: boolean }): void {
    const { userId, tier, ipKey, now } = input;
    const weight = Math.max(1, input.weight ?? 1);
    const trusted = tier === "registered" && sql.holdsAnyRole(userId);
    const perUser = trusted
      ? { minute: this.core.config.trustedPostsPerMinute, day: this.core.config.trustedPostsPerDay }
      : tier === "registered"
        ? { minute: this.core.config.registeredPostsPerMinute, day: this.core.config.registeredPostsPerDay }
        : { minute: this.core.config.guestPostsPerMinute, day: this.core.config.guestPostsPerDay };
    const perIp = trusted
      ? { minute: Math.max(this.core.config.ipPostsPerMinute, this.core.config.trustedPostsPerMinute), day: Math.max(this.core.config.ipPostsPerDay, this.core.config.trustedPostsPerDay) }
      : { minute: this.core.config.ipPostsPerMinute, day: this.core.config.ipPostsPerDay };
    const principal = tier === "registered" ? `user:${userId}` : `anonymous:${ipKey}`;
    const rows = [
      sql.limitRow("post", principal, now),
      sql.limitRow("post", `ip:${ipKey}`, now),
      sql.limitRow("post", "global", now),
    ];
    const daily = dayFor(now);
    let retryAfterMs = 0;
    let reason = "Posting limit reached";
    const charged: Bucket[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const allowance = index === 0 ? perUser.minute : index === 1 ? perIp.minute : this.core.config.globalPostsPerMinute;
      const dailyAllowance = index === 0 ? perUser.day : index === 1 ? perIp.day : this.core.config.globalPostsPerDay;
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
      sql.updateLimitRow(row, { ...bucketRow(charged[index]), day: daily, posts_day: dailyCount }, now, weight);
    }
  }

  /**
   * Charges one event to a principal's `scope` limiter at `rate`, and, with
   * `perDay`, to its count for the UTC day (kept in `posts_day`; the scope
   * separates it from posts), or neither when either is full. A refusal
   * names `category`, if any, as `ext.limits` (limitData).
   */
  chargeEvent(sql: Sql, scope: string, principalKey: string, now: number, rate: Rate, message: string, perDay?: { limit: number; message: string }, category?: LimitCategory): void {
    const data = category ? limitData(category) : undefined;
    const row = sql.limitRow(scope, principalKey, now);
    const day = dayFor(now);
    const count = dayCount(row, "posts_day", day);
    if (perDay && count >= perDay.limit) {
      throw new StoreError("retry_after", perDay.message, { retryAfterMs: Math.max(1000, 86_400_000 - now % 86_400_000), data });
    }
    const charged = chargeBucket(bucketOf(row), now, rate);
    if ("retryAfterMs" in charged) throw new StoreError("retry_after", message, { retryAfterMs: Math.max(1000, charged.retryAfterMs), data });
    sql.updateLimitRow(row, perDay ? { ...bucketRow(charged.bucket), day, posts_day: count + 1 } : bucketRow(charged.bucket), now);
  }

  reserveAuthAttempt(input: { ipKey: string; now: number }): void {
    this.core.ensureReady();
    // Frames are reserved by reserveFrames at the websocket boundary.  Keep
    // the auth operation's SQL reservation separate so one frame is not
    // charged twice.
    this.core.reserved("reserveAuthAttempt", { ...this.core.config.authCost, frames: 0, reads: Math.max(32, this.core.config.authCost.reads ?? 0), writes: Math.max(16, this.core.config.authCost.writes ?? 0) }, false, input.now, (sql) => {
      const effective = this.core.effectiveNow(input.now);
      sql.transaction(() => {
        this.chargeEvent(sql, "auth", `ip:${input.ipKey}`, effective, { perMinute: this.core.config.authAttemptsPerIpMinute }, "Authentication attempts limited");
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
  reserveGuestNumbers(count: number, now = this.core.clock.now()): { first: number; limit: number } {
    this.core.ensureReady();
    if (!Number.isSafeInteger(count) || count <= 0) throw new StoreError("invalid_params", "guest number block must be a positive safe integer");
    return this.core.reserved("reserveGuestNumbers", GUEST_NUMBER_BLOCK_COST, false, now, (sql) => sql.transaction(() => {
      const mark = sql.metaNumber(META_GUEST_NUMBER_MARK);
      if (mark > MAX_SAFE_ID - count - 1) throw new StoreError("internal_error", "guest numbers are exhausted");
      sql.writeMeta(META_GUEST_NUMBER_MARK, String(mark + count));
      return { first: mark + 1, limit: mark + count + 1 };
    }));
  }

  reserveFrames(input: { ipKey: string; now: number; count?: number }): void {
    this.core.ensureReady();
    const count = Math.max(1, Math.floor(input.count ?? 1));
    if (count > this.core.config.framesPerIpMinute || count > this.core.config.processedFramesPerDay) {
      throw new StoreError("invalid_params", "frame reservation is too large");
    }
    this.core.reserved("reserveFrames", { reads: 16 + count * 4, writes: 16, frames: count }, false, input.now, (sql) => {
      const effective = this.core.effectiveNow(input.now);
      sql.transaction(() => {
        const row = sql.limitRow("frames", `ip:${input.ipKey}`, effective);
        const charged = chargeBucket(bucketOf(row), effective, { perMinute: this.core.config.framesPerIpMinute }, count);
        if ("retryAfterMs" in charged) {
          throw new StoreError("retry_after", "Frame rate limit reached", { retryAfterMs: Math.max(1000, charged.retryAfterMs) });
        }
        sql.updateLimitRow(row, bucketRow(charged.bucket), effective, count);
        const global = sql.limitRow("frames", "global", effective);
        const day = dayFor(effective);
        const globalCount = dayCount(global, "posts_day", day);
        // An admin's frames (alert) are counted but never refused, so `/status` answers on a spent day.
        if (!this.core.alerting && globalCount + count > this.core.config.processedFramesPerDay) {
          throw new StoreError("retry_after", "Daily frame budget exhausted", { retryAfterMs: Math.max(1_000, 86_400_000 - effective % 86_400_000), data: { reason: "frame_budget" } });
        }
        sql.updateLimitRow(global, { day, posts_day: globalCount + count }, effective);
      });
    });
  }

  chargeRegistration(sql: Sql, ipKey: string, now: number): void {
    const day = dayFor(now);
    const ip = sql.limitRow("registration", `ip:${ipKey}`, now);
    const global = sql.limitRow("registration", "global", now);
    const ipCount = dayCount(ip, "registrations_day", day);
    const globalCount = dayCount(global, "registrations_day", day);
    const retryAfterMs = Math.max(1, 86_400_000 - now % 86_400_000);
    if (ipCount >= this.core.config.registrationsPerIpDay) {
      throw new StoreError("retry_after", "Registration limit reached for this network", { retryAfterMs });
    }
    if (globalCount >= this.core.config.registrationsPerDay) {
      throw new StoreError("retry_after", "Registration limit reached", { retryAfterMs });
    }
    sql.updateLimitRow(ip, { day, registrations_day: ipCount + 1 }, now);
    sql.updateLimitRow(global, { day, registrations_day: globalCount + 1 }, now);
  }

  reserveConnection(input: { ipKey: string; now: number }): void {
    this.core.ensureReady();
    if (!this.core.config.admissionEnabled) throw new StoreError("denied", "Demo admission is closed");
    this.core.reserved("reserveConnection", { reads: 64, writes: 32, admissions: 1 }, false, input.now, (sql) => {
      const now = this.core.effectiveNow(input.now);
      sql.transaction(() => {
        this.chargeEvent(sql, "admission", `ip:${input.ipKey}`, now, { perMinute: this.core.config.connectionAdmissionsPerIpMinute }, "Connection admission limit reached");
        const day = dayFor(now);
        // The daily admission ceiling is global. The per-IP control above is a
        // rolling minute gate; using it as a daily counter would make a quiet
        // IP permanently consume global capacity independently.
        const global = sql.limitRow("admission", "global", now);
        const admissions = dayCount(global, "posts_day", day);
        // Until the UTC day ends, when the counts reset.
        const untilReset = Math.max(1_000, 86_400_000 - now % 86_400_000);
        if (admissions >= this.core.config.connectionAdmissionsPerDay) throw new StoreError("retry_after", "Connection admission limit reached", { retryAfterMs: untilReset });
        sql.updateLimitRow(global, { day, posts_day: admissions + 1 }, now);
        // Live connection caps are authoritative in ctx.getWebSockets(), which
        // includes closing sockets and survives object hibernation.  Durable
        // open counters become stale after a lost close and can permanently
        // deny admission, so only the durable admission/day and frame budget
        // controls are maintained here.
        const frames = sql.limitRow("frames", "global", now);
        const frameCount = dayCount(frames, "posts_day", day);
        if (frameCount >= this.core.config.processedFramesPerDay) {
          throw new StoreError("retry_after", "Daily frame budget exhausted", { retryAfterMs: untilReset, data: { reason: "frame_budget" } });
        }
      });
    });
  }

  /**
   * A principal's count for its UTC day in a limiter scope (`posts_day`, which
   * scopes other than posts reuse), as the store holds it: a cached row
   * (limiter-cache.ts) may not be written yet. Zero for none.
   */
  limiterDay(scope: string, principalKey: string, now = this.core.clock.now()): { day: string; posts_day: number } {
    this.core.ensureReady();
    return this.core.reserved("limiterDay", { reads: 8 }, false, now, (sql) => {
      const row = sql.peekLimitRow(scope, principalKey) ?? sql.rows<{ day: string; posts_day: number }>(
        "SELECT day, posts_day FROM principal_limits WHERE scope = ? AND principal_key = ? LIMIT 1", scope, principalKey,
      )[0];
      return { day: row?.day ?? dayFor(this.core.effectiveNow(now)), posts_day: integerColumn(row?.posts_day) };
    });
  }
}
