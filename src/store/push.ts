/*
 * Web Push storage: users' registrations (`push_subscriptions`), when
 * each was last woken for each room (`push_wakes`), and the day's push
 * counters and `unread` (rows of `principal_limits`, through the core's
 * limiter rows). The Push part (sqlite-parts.ts) delegates here.
 */

import { MAX_PUSHES_PER_MESSAGE, MAX_PUSH_CANDIDATES } from "../budget";
import { JOINED_WAKE_ROLES, MAX_PUSH_URL_BYTES, PUSH_ID_PATTERN, WAKE_SCOPES, isPrivateRoomId } from "../domain";
import type { RawLimitRow } from "../limiter-cache";
import { StoreError } from "../store-error";
import { ALL_WAKE, DEFAULT_WAKE, MAX_PUSH_SUBSCRIPTIONS_PER_USER, PUSH_REFRESH_MS } from "./limits";
import { PUSH_UNREAD_SCOPE } from "./meta";
import { type RawPushRow, dayCount, dayFor, integerColumn, parseJson, parseRoles, pushRecord, utf8Bytes } from "./rows";
import { JOINED_WAKE_CONDITION } from "./schema";
import type { MessageSnapshot, PushCandidate, PushClaim } from "./types";
import type { Sql, StoreCore } from "./core";

/** Web Push (protocol §4.9) over the store's core: the Push part's implementation. */
export class PushModule {
  constructor(private readonly core: StoreCore) {}

  /**
   * `push_register` (protocol §4.9, kind `webpush`): keeps a registered
   * user's registration of the endpoint `url`, with its `push_id` and the
   * `wake` scopes it wakes for (a WAKE_SCOPES bitmask, DEFAULT_WAKE when not
   * given; `joined` is kept only for a user holding one of
   * JOINED_WAKE_ROLES, and dropped for anyone else, as a scope this server
   * does not offer them; one left with no scope is `invalid_params`). Registrations are the user's own: registering a `url` the user
   * holds again replaces its keys, `push_id` (removing one now absent) and
   * scopes, and two
   * users may register the same `url`. A user past `subscriptionsPerUser`
   * loses the least recently registered of the others. Clients register on
   * every connection, so an unchanged registration (keys, `push_id`, scopes)
   * registered again within a day writes nothing; one not registered for
   * `pushExpiryDays` is skipped by wakes and deleted by cleanup.
   */
  registerPushSubscription(input: { userId: string; url: string; p256dh: string; auth: string; pushId?: string; wake?: number; now?: number }): void {
    this.core.ensureReady();
    const policy = this.core.config.push;
    if (!policy) throw new StoreError("unsupported", "Push is not available here");
    if (utf8Bytes(input.url) > MAX_PUSH_URL_BYTES) throw new StoreError("too_large", "url is too long");
    if (input.pushId !== undefined && !PUSH_ID_PATTERN.test(input.pushId)) throw new StoreError("invalid_params", "push_id must be 1 to 64 letters, digits, _ or -");
    const requested = input.wake ?? DEFAULT_WAKE;
    if (!Number.isInteger(requested) || requested < 0 || (requested & ~ALL_WAKE) !== 0) throw new StoreError("invalid_params", "wake must name known scopes");
    const now = input.now ?? this.core.clock.now();
    // The row and the user's index range; each eviction rewrites a row and
    // its index entries, four for one that keeps `joined`.
    const rows = MAX_PUSH_SUBSCRIPTIONS_PER_USER + 2;
    return this.core.reserved("registerPushSubscription", { reads: 32 + 2 * rows, writes: 32 + 6 * rows }, false, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      const identity = sql.identityRow(input.userId);
      if (!identity) throw new StoreError("denied", "Sign in to receive push notifications");
      const moderator = identity.tier === "registered" && parseRoles(identity.roles_json).some((role) => JOINED_WAKE_ROLES.includes(role));
      const wake = moderator ? requested : requested & ~WAKE_SCOPES.joined;
      // A wake that selects no scope this server supports for the user is refused (protocol §4.9.2).
      if (wake === 0) throw new StoreError("invalid_params", "wake selects no scope this server supports for webpush");
      const pushId = input.pushId ?? null;
      const existing = sql.rows<{ p256dh: string; auth: string; push_id: string | null; wake: number; updated_ms: number }>(
        "SELECT p256dh, auth, push_id, wake, updated_ms FROM push_subscriptions WHERE user_id = ? AND url = ? LIMIT 1",
        input.userId, input.url,
      )[0];
      if (existing && existing.p256dh === input.p256dh && existing.auth === input.auth && existing.push_id === pushId && integerColumn(existing.wake) === wake &&
          effective - integerColumn(existing.updated_ms) < PUSH_REFRESH_MS) return;
      if (!existing) sql.ensureGrowthCapacity(2 * MAX_PUSH_URL_BYTES);
      sql.exec(
        `INSERT INTO push_subscriptions (user_id, url, p256dh, auth, push_id, wake, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, url) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, push_id = excluded.push_id, wake = excluded.wake, updated_ms = excluded.updated_ms`,
        input.userId, input.url, input.p256dh, input.auth, pushId, wake, effective, effective,
      );
      // The new one never goes, even when it shares its millisecond with others.
      sql.exec(
        `DELETE FROM push_subscriptions WHERE user_id = ? AND url IN (
           SELECT url FROM push_subscriptions
           WHERE user_id = ? AND url <> ? ORDER BY updated_ms DESC LIMIT -1 OFFSET ?)`,
        input.userId, input.userId, input.url, policy.subscriptionsPerUser - 1,
      );
    }));
  }

  /** `push_unregister` (protocol §4.9): removes the user's own registration of `url`, if any. */
  removePushSubscription(input: { userId: string; url: string; now?: number }): void {
    this.core.ensureReady();
    const now = input.now ?? this.core.clock.now();
    this.core.reserved("removePushSubscription", { reads: 16, writes: 16 }, false, now, (sql) => {
      sql.exec("DELETE FROM push_subscriptions WHERE user_id = ? AND url = ?", input.userId, input.url);
    });
  }

  /**
   * The users who may wake for `joined` (§4.9.2): those with a live
   * registration that kept it (JOINED_WAKE_ROLES), most recently registered
   * first, at most MAX_PUSH_CANDIDATES. One range of
   * `push_subscriptions_joined_idx`, which only their registrations are in,
   * of at most `subscriptionsPerUser` rows a user; claimPushes checks each
   * one's role and membership again, as either may have changed since.
   */
  joinedWakers(now = this.core.clock.now()): string[] {
    this.core.ensureReady();
    const policy = this.core.config.push;
    if (!policy) return [];
    const rows = MAX_PUSH_CANDIDATES * policy.subscriptionsPerUser;
    return this.core.reserved("joinedWakers", { reads: 8 + rows }, false, now, (sql) => {
      const live = this.core.effectiveNow(now) - policy.pushExpiryDays * 86_400_000;
      const found = sql.rows<{ user_id: string }>(
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
    this.core.ensureReady();
    const policy = this.core.config.push;
    const reasons = new Map<string, number>();
    for (const candidate of input.candidates) reasons.set(candidate.userId, (reasons.get(candidate.userId) ?? 0) | candidate.reasons);
    const candidates = [...reasons.keys()].slice(0, MAX_PUSH_CANDIDATES);
    const claim: PushClaim = { subscriptions: [], skipped: 0 };
    if (!policy || !candidates.length) return claim;
    const now = input.now ?? this.core.clock.now();
    // Each candidate's status row, live index range, two room mute probes,
    // wake row, recipient counter, in a private room membership row and, for
    // `joined`, identity row and two membership probes; the room's parent, read once; the
    // server's and sender's counters; and for each woken user a wake row and
    // the recipient counter, created on a user's first push of the day.
    const cost = { reads: 56 + candidates.length * (32 + 2 * policy.subscriptionsPerUser), writes: 32 + 12 * policy.wakesPerMessage };
    return this.core.reserved("claimPushes", cost, false, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      const day = dayFor(effective);
      const live = effective - policy.pushExpiryDays * 86_400_000;
      let counters: { server: RawLimitRow; sender: RawLimitRow; sent: number; charged: number; chargedBefore: number } | undefined;
      // The rooms a room mute silences this message by: its room and, for a
      // thread, the parent (protocol §4.5), read once a candidate needs it.
      // The same rooms make it a message in a room one joined (`joined`).
      let scopes: string[] | undefined;
      const roomScopes = () => scopes ??= [input.roomId, ...sql.rows<{ parent_room_id: string | null }>("SELECT parent_room_id FROM rooms WHERE room_id = ? LIMIT 1", input.roomId)
        .flatMap((row) => row.parent_room_id === null ? [] : [row.parent_room_id])];
      let woken = 0;
      for (const userId of candidates) {
        if (woken >= policy.wakesPerMessage) break;
        // A private room's message wakes only who is in it when it goes, however they were chosen.
        if (isPrivateRoomId(input.roomId) && !sql.isMember(input.roomId, userId)) continue;
        // A muted or `dnd` user gets no pushes (protocol §4.9, §4.5) and takes no wake.
        const status = sql.rows<{ status: string; mute_until_ms: number | null }>("SELECT status, mute_until_ms FROM user_status WHERE user_id = ? LIMIT 1", userId)[0];
        if (status && (status.status === "dnd" || (status.mute_until_ms != null && integerColumn(status.mute_until_ms) > effective))) continue;
        // `joined` only for a moderator in the room (or the thread's parent), as they are now.
        let why = reasons.get(userId)!;
        if (why & WAKE_SCOPES.joined && !(sql.holdsRole(userId, JOINED_WAKE_ROLES) && roomScopes().some((roomId) => sql.isMember(roomId, userId)))) {
          why &= ~WAKE_SCOPES.joined;
          if (!why) continue;
        }
        // Filtered after the bounded read, so the read stays one primary-key
        // range of the user's registrations, at most `subscriptionsPerUser`,
        // whatever the scopes.
        let rows = sql.rows<RawPushRow>(
          `SELECT url, p256dh, auth, push_id, wake FROM push_subscriptions
           WHERE user_id = ? AND wake != 0 AND updated_ms >= ? ORDER BY updated_ms DESC LIMIT ?`,
          userId, live, policy.subscriptionsPerUser,
        ).filter((row) => (integerColumn(row.wake) & why) !== 0 && (input.allowed?.(row.url) ?? true));
        if (!rows.length) continue;
        const rooms = roomScopes();
        const roomMuted = sql.rows<{ mute_until_ms: number }>(
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
        const last = sql.rows<{ woken_ms: number }>("SELECT woken_ms FROM push_wakes WHERE user_id = ? AND room_id = ? LIMIT 1", userId, input.roomId)[0];
        const window = joinedOnly ? policy.joinedCoalesceSeconds : policy.coalesceSeconds;
        // An operator alert is never held back by the window or the allowances below.
        if (!input.alert && last && effective - integerColumn(last.woken_ms) < window * 1_000) continue;
        // The counters are read once a user is found to wake, so a message
        // that wakes no one writes nothing. Reuse posts_day as the counts; the
        // scope separates them.
        if (!counters) {
          const server = sql.limitRow("push", "global", effective);
          const sender = sql.limitRow("push", `user:${input.senderId}`, effective);
          const charged = dayCount(sender, "posts_day", day);
          counters = { server, sender, sent: dayCount(server, "posts_day", day), charged, chargedBefore: charged };
        }
        const recipientScope = joinedOnly ? "push_joined_recipient" : PUSH_UNREAD_SCOPE;
        const recipient = sql.rows<{ day: string; posts_day: number; uploads_day: number }>(
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
        sql.updateLimitRow(sql.limitRow(recipientScope, `user:${userId}`, effective), { day, posts_day: received + allowed, ...(unread !== undefined ? { uploads_day: unread } : {}) }, effective);
        sql.exec(
          "INSERT INTO push_wakes (user_id, room_id, woken_ms) VALUES (?, ?, ?) ON CONFLICT (user_id, room_id) DO UPDATE SET woken_ms = excluded.woken_ms",
          userId, input.roomId, effective,
        );
      }
      if (counters && woken) {
        sql.updateLimitRow(counters.server, { day, posts_day: counters.sent }, effective);
        // Untouched when only `joined` pushes went, which no sender is charged for.
        if (counters.charged !== counters.chargedBefore) sql.updateLimitRow(counters.sender, { day, posts_day: counters.charged }, effective);
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
  clearPushUnread(userId: string, now = this.core.clock.now()): void {
    this.core.ensureReady();
    if (!this.core.config.push) return;
    this.core.reserved("clearPushUnread", { reads: 8, writes: 8 }, false, now, (sql) => this.zeroPushUnread(sql, userId));
  }

  /** Read first: an update is charged a write even when it changes nothing (rawExec), and most find none. */
  zeroPushUnread(sql: Sql, userId: string): void {
    const key = `user:${userId}`;
    const row = sql.rows<{ uploads_day: number }>(
      "SELECT uploads_day FROM principal_limits WHERE scope = ? AND principal_key = ? LIMIT 1", PUSH_UNREAD_SCOPE, key,
    )[0];
    if (row && integerColumn(row.uploads_day) !== 0) {
      sql.exec("UPDATE principal_limits SET uploads_day = 0 WHERE scope = ? AND principal_key = ?", PUSH_UNREAD_SCOPE, key);
    }
  }

  /**
   * Removes all of a user's push registrations, when what they signed in
   * with is revoked (`/passkeys remove`, a bot's new token): a device that
   * held it should not keep getting their messages.
   */
  clearPushSubscriptions(userId: string, now = this.core.clock.now()): void {
    this.core.ensureReady();
    this.core.reserved("clearPushSubscriptions", { reads: 8 + 2 * MAX_PUSH_SUBSCRIPTIONS_PER_USER, writes: 8 + 6 * MAX_PUSH_SUBSCRIPTIONS_PER_USER }, false, now, (sql) => {
      sql.exec("DELETE FROM push_subscriptions WHERE user_id = ?", userId);
    });
  }

  /**
   * Forgets the registrations whose push service said they are gone (404
   * or 410): each the user's registration of the endpoint, if it still has
   * the keys that were pushed to, so a fresh registration of it stays.
   * Other users' registrations of the same endpoint are left to their own
   * pushes and to expiry.
   */
  forgetPushSubscriptions(gone: ReadonlyArray<{ userId: string; url: string; p256dh: string }>, now = this.core.clock.now()): void {
    this.core.ensureReady();
    const rows = gone.slice(0, MAX_PUSHES_PER_MESSAGE);
    if (!rows.length) return;
    // One primary-key row each, whatever other users hold the same endpoint:
    // a delete by endpoint alone would touch every user's row for it, which
    // anyone can multiply by registering one endpoint from many accounts.
    this.core.reserved("forgetPushSubscriptions", { reads: 8 + 4 * rows.length, writes: 8 + 6 * rows.length }, false, now, (sql) => sql.transaction(() => {
      for (const row of rows) {
        sql.exec("DELETE FROM push_subscriptions WHERE user_id = ? AND url = ? AND p256dh = ?", row.userId, row.url, row.p256dh);
      }
    }));
  }

  /**
   * A message as it is now, for a push held until its user went idle
   * (protocol §4.9): null when unknown or expired. One metered lookup.
   */
  pushedMessage(messageId: string, now = this.core.clock.now()): MessageSnapshot | null {
    this.core.ensureReady();
    return this.core.reserved("pushedMessage", { reads: 8 }, false, now, (sql) => {
      const row = sql.currentMessage(messageId, sql.logState().history_floor);
      return row ? parseJson<MessageSnapshot>(row.snapshot_json) : null;
    });
  }

  /** Pushes sent today, for `/status`. */
  pushesToday(now = this.core.clock.now()): number {
    this.core.ensureReady();
    return this.core.reserved("pushesToday", { reads: 8 }, false, now, (sql) => {
      const rows = sql.rows<{ day: string; posts_day: number }>(
        "SELECT day, posts_day FROM principal_limits WHERE scope = ? AND principal_key = ? LIMIT 1",
        "push",
        "global",
      );
      return dayCount(rows[0], "posts_day", dayFor(this.core.effectiveNow(now)));
    });
  }
}
