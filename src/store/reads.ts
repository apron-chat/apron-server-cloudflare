/*
 * Read state: each registered user's read cursors (`read_cursors`), their
 * chosen status and unscoped mute (`user_status`), their room mutes
 * (`room_mutes`), their `seen` (in their identity row, through the core),
 * the presence toggle, and what a sign-in reads of them (statusInputs).
 * The Reads part, and the Accounts part's setStatus, setMute and
 * clearExpiredMutes, delegate here.
 */

import { MAX_PRIVATE_MEMBERSHIPS_PER_USER } from "../budget";
import { MAX_READ_RECEIPT_MEMBERS, MAX_ROOM_MUTES_PER_USER, MAX_USER_ROOMS, type RoomMute, isPrivateRoomId, nextRoomMuteEnd, seenStands } from "../domain";
import type { StatusChoice } from "../presence";
import { MAX_PURGE_ROOMS } from "./limits";
import { META_PRESENCE_ON, META_TOGGLE_PREFIX } from "./meta";
import { assertSeen, choiceColumn, idString, integerColumn, seenColumn } from "./rows";
import type { StatusInputRecord } from "./types";
import type { Sql, StoreCore } from "./core";
import type { PushModule } from "./push";

/** Read state over the store's core: the Reads part's implementation, and the status and mutes the Accounts part keeps. */
export class ReadsModule {
  constructor(private readonly core: StoreCore, private readonly pushes: PushModule) {}

  /**
   * Clears mutes that ran out: an account's (`user_status`, deleted when
   * nothing else is left in it) and its rooms' (`room_mutes`). Otherwise
   * they stay until the user mutes again. Returns the rows changed.
   */
  clearExpiredMutes(now = this.core.clock.now()): number {
    this.core.ensureReady();
    const cap = this.core.config.registeredAccounts;
    return this.core.reserved("clearExpiredMutes", { reads: 16 + 2 * cap + 2 * MAX_ROOM_MUTES_PER_USER * 64, writes: 16 + 4 * 1_000 }, true, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      let changed = 0;
      changed += sql.exec("UPDATE user_status SET mute_until_ms = NULL WHERE user_id IN (SELECT user_id FROM user_status WHERE mute_until_ms IS NOT NULL AND mute_until_ms <= ? LIMIT 1000)", effective).rowsWritten ?? 0;
      changed += sql.exec("DELETE FROM user_status WHERE user_id IN (SELECT user_id FROM user_status WHERE status = 'online' AND mute_until_ms IS NULL LIMIT 1000)").rowsWritten ?? 0;
      changed += sql.exec("DELETE FROM room_mutes WHERE (user_id, room_id) IN (SELECT user_id, room_id FROM room_mutes WHERE mute_until_ms <= ? LIMIT 1000)", effective).rowsWritten ?? 0;
      return changed;
    }), false);
  }

  /**
   * The `presence` toggle (as toggle has it) and when presence was last
   * turned on with it (META_PRESENCE_ON), if ever, in one statement: two
   * primary-key lookups of `_meta`, of which a missing row reads nothing.
   */
  presenceToggle(now = this.core.clock.now()): { on: boolean | undefined; since?: number } {
    this.core.ensureReady();
    return this.core.reserved("presenceToggle", { reads: 4 }, false, now, (sql) => {
      const rows = sql.rows<{ key: string; value: string }>("SELECT key, value FROM _meta WHERE key IN (?, ?)", META_TOGGLE_PREFIX + "presence", META_PRESENCE_ON);
      const value = rows.find((row) => row.key === META_TOGGLE_PREFIX + "presence")?.value;
      const since = Number(rows.find((row) => row.key === META_PRESENCE_ON)?.value);
      return { on: value === "on" ? true : value === "off" ? false : undefined, ...(Number.isSafeInteger(since) && since > 0 ? { since } : {}) };
    });
  }

  /**
   * `status` `mute` without `room_id` (protocol §4.5) for a registered user:
   * until when they are muted, MUTE_FOREVER for `true`, or null to end it.
   * Whether the stored mute changed, and `untilMs`, the end it leaves,
   * absent when not muted. A mute is the user's, whichever connection set
   * it. It is kept in the user's `user_status` row, which goes once it holds
   * only defaults.
   */
  setMute(input: { userId: string; untilMs: number | null; now?: number }): { changed: boolean; untilMs?: number } {
    this.core.ensureReady();
    const now = input.now ?? this.core.clock.now();
    return this.core.reserved("setMute", { reads: 16, writes: 16 }, false, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      if (!sql.identityRow(input.userId)) return { changed: false };
      const existing = this.userStatusRow(sql, input.userId);
      const stored = existing?.mute_until_ms ?? null;
      const before = stored !== null && stored > effective ? stored : null;
      if (input.untilMs === null || input.untilMs <= effective) {
        if (stored !== null) this.writeUserStatus(sql, input.userId, existing, { mute_until_ms: null });
        return { changed: before !== null };
      }
      if (before === input.untilMs) return { changed: false, untilMs: input.untilMs };
      this.writeUserStatus(sql, input.userId, existing, { mute_until_ms: input.untilMs });
      return { changed: true, untilMs: input.untilMs };
    }));
  }

  /**
   * `me` `status` (protocol §4.5) for a registered user: the value they
   * chose, kept in their `user_status` row with the mute. Whether it changed.
   * With `seenAt`, when choosing `invisible` shows them `offline` at that
   * time (§4.5.2), their `seen` is settled too, from the identity row this
   * reads anyway: the stored one if it stands (seenStands), else `seenAt`,
   * written (writeSeen) in the same reservation and transaction, so the two
   * cannot part. `seen` is what is stored after, absent for an unknown
   * user. Listings kept for reuse get it only once it is committed.
   */
  setStatus(input: { userId: string; choice: StatusChoice; now?: number; seenAt?: number }): { changed: boolean; seen?: number } {
    if (input.seenAt !== undefined) assertSeen(input.seenAt);
    this.core.ensureReady();
    const now = input.now ?? this.core.clock.now();
    let written: number | undefined;
    const result = this.core.reserved("setStatus", { reads: 16, writes: 16 }, false, now, (sql) => sql.transaction((): { changed: boolean; seen?: number } => {
      this.core.effectiveNow(now);
      const row = sql.identityRow(input.userId);
      if (!row) return { changed: false };
      let seen: number | undefined;
      if (input.seenAt !== undefined) {
        seen = seenColumn(row.seen_ms);
        if (!seenStands(seen, input.seenAt)) {
          sql.writeSeen(input.userId, input.seenAt);
          seen = written = input.seenAt;
        }
      }
      const existing = this.userStatusRow(sql, input.userId);
      if ((existing?.status ?? "online") === input.choice) return { changed: false, ...(seen !== undefined ? { seen } : {}) };
      this.writeUserStatus(sql, input.userId, existing, { status: input.choice });
      return { changed: true, ...(seen !== undefined ? { seen } : {}) };
    }));
    // Committed: listings kept for reuse may carry it now (a rollback leaves them as they were).
    if (written !== undefined) this.core.patchMemberSeen(input.userId, written);
    return result;
  }

  /** A user's `user_status` row, if any, with an expired mute left as stored. */
  private userStatusRow(sql: Sql, userId: string): { status: StatusChoice; mute_until_ms: number | null } | undefined {
    const row = sql.rows<{ status: string; mute_until_ms: number | null }>(
      "SELECT status, mute_until_ms FROM user_status WHERE user_id = ? LIMIT 1", userId,
    )[0];
    return row ? { status: choiceColumn(row.status), mute_until_ms: row.mute_until_ms === null ? null : integerColumn(row.mute_until_ms) } : undefined;
  }

  /** Writes a user's `user_status` row with `change` applied, deleting it once it holds only defaults. */
  private writeUserStatus(sql: Sql, userId: string, existing: { status: StatusChoice; mute_until_ms: number | null } | undefined, change: { status?: StatusChoice; mute_until_ms?: number | null }): void {
    const next = { status: existing?.status ?? "online", mute_until_ms: existing?.mute_until_ms ?? null, ...change };
    if (next.mute_until_ms === null && next.status === "online") {
      if (existing) sql.exec("DELETE FROM user_status WHERE user_id = ?", userId);
      return;
    }
    sql.exec(
      `INSERT INTO user_status (user_id, status, mute_until_ms) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET status = excluded.status, mute_until_ms = excluded.mute_until_ms`,
      userId, next.status, next.mute_until_ms,
    );
  }

  /**
   * `status` `mute` with `room_id` (protocol §4.5) for a registered user:
   * until when `roomId` and its threads are muted, MUTE_FOREVER for `true`,
   * or null to end it. Kept in `room_mutes`, one row a room, at most
   * MAX_ROOM_MUTES_PER_USER a user: a mute of another room past that first
   * deletes the user's mutes that ran out, and is `refused` if that frees
   * none. Whether it changed anything, and `untilMs`, the end it leaves,
   * absent when not muted. A mute that ran out is deleted with no change.
   */
  setRoomMute(input: { userId: string; roomId: string; untilMs: number | null; now?: number }): { changed: boolean; untilMs?: number; refused?: true } {
    this.core.ensureReady();
    const now = input.now ?? this.core.clock.now();
    // The row and its key; at the cap, two counts of the user's mutes and a
    // delete of those that ran out (a row and its key each), each at most
    // the cap.
    const cost = { reads: 24 + 4 * MAX_ROOM_MUTES_PER_USER, writes: 16 + 4 * MAX_ROOM_MUTES_PER_USER };
    return this.core.reserved("setRoomMute", cost, false, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      const row = sql.rows<{ mute_until_ms: number }>("SELECT mute_until_ms FROM room_mutes WHERE user_id = ? AND room_id = ? LIMIT 1", input.userId, input.roomId)[0];
      const stored = row ? integerColumn(row.mute_until_ms) : null;
      const before = stored !== null && stored > effective ? stored : null;
      if (input.untilMs === null || input.untilMs <= effective) {
        if (stored !== null) sql.exec("DELETE FROM room_mutes WHERE user_id = ? AND room_id = ?", input.userId, input.roomId);
        return { changed: before !== null };
      }
      if (before === input.untilMs) return { changed: false, untilMs: input.untilMs };
      if (stored === null) {
        if (!sql.identityRow(input.userId)) return { changed: false };
        const count = () => integerColumn(sql.rows<{ count: number }>("SELECT COUNT(*) AS count FROM room_mutes WHERE user_id = ?", input.userId)[0]?.count);
        if (count() >= MAX_ROOM_MUTES_PER_USER) {
          sql.exec("DELETE FROM room_mutes WHERE user_id = ? AND mute_until_ms <= ?", input.userId, effective);
          if (count() >= MAX_ROOM_MUTES_PER_USER) return { changed: false, refused: true };
        }
      }
      sql.exec(
        `INSERT INTO room_mutes (user_id, room_id, mute_until_ms) VALUES (?, ?, ?)
         ON CONFLICT (user_id, room_id) DO UPDATE SET mute_until_ms = excluded.mute_until_ms`,
        input.userId, input.roomId, input.untilMs,
      );
      return { changed: true, untilMs: input.untilMs };
    }));
  }

  /**
   * The room mutes of a user that ran out by `now` (protocol §4.5), deleted
   * here, so each is told once: their rooms, and when the next of those left
   * runs out (absent when none is timed). One range of the user's rows, at
   * most MAX_ROOM_MUTES_PER_USER, and a delete of the expired ones.
   */
  expireRoomMutes(userId: string, now = this.core.clock.now()): { expired: string[]; next?: number } {
    this.core.ensureReady();
    return this.core.reserved("expireRoomMutes", { reads: 16 + 2 * MAX_ROOM_MUTES_PER_USER, writes: 8 + 4 * MAX_ROOM_MUTES_PER_USER }, false, now, (sql) => sql.transaction(() => {
      const effective = this.core.effectiveNow(now);
      const rows = this.roomMuteRows(sql, userId);
      const expired = rows.filter((row) => row.untilMs <= effective).map((row) => row.roomId);
      if (expired.length) sql.exec("DELETE FROM room_mutes WHERE user_id = ? AND mute_until_ms <= ?", userId, effective);
      return { expired, ...nextRoomMuteEnd(rows.filter((row) => row.untilMs > effective)) };
    }));
  }

  /** A user's room mutes as stored, expired ones included, in `room_id` order. */
  private roomMuteRows(sql: Sql, userId: string): RoomMute[] {
    return sql.rows<{ room_id: string; mute_until_ms: number }>(
      "SELECT room_id, mute_until_ms FROM room_mutes WHERE user_id = ? ORDER BY room_id LIMIT ?", userId, MAX_ROOM_MUTES_PER_USER,
    ).map((row) => ({ roomId: row.room_id, untilMs: integerColumn(row.mute_until_ms) }));
  }

  /**
   * A registered user's stored `status` state (protocol §4.5), read once at
   * sign-in: the `status` they chose, their unscoped mute's end (absent when
   * not muted, MUTE_FOREVER for `true`) and their room mutes in effect. One
   * primary-key read and one range of the user's room mutes, at most
   * MAX_ROOM_MUTES_PER_USER rows; a missing row or range costs nothing.
   * Their `seen` is not read here: every sign-in reads their identity row
   * anyway (getIdentity), which carries it. Signing in brings them back, so
   * it also zeroes their `unread` (clearPushUnread), in the same
   * reservation: one more primary-key probe, written only when it held a count.
   */
  statusInputs(userId: string, now = this.core.clock.now()): StatusInputRecord {
    this.core.ensureReady();
    return this.core.reserved("statusInputs", { reads: 16 + 2 * MAX_ROOM_MUTES_PER_USER, writes: 8 }, false, now, (sql) => {
      if (this.core.config.push) this.pushes.zeroPushUnread(sql, userId);
      const effective = this.core.effectiveNow(now);
      const row = this.userStatusRow(sql, userId);
      const until = row?.mute_until_ms ?? 0;
      return {
        choice: row?.status ?? "online",
        ...(until > effective ? { muteUntil: until } : {}),
        roomMutes: this.roomMuteRows(sql, userId).filter((mute) => mute.untilMs > effective),
      };
    });
  }

  /**
   * A registered user's read cursors (protocol §4.6): the `read_message_id`
   * kept for each room they joined that has one, by room. One range of the
   * user's rows, at most one a membership; none costs nothing.
   */
  readCursors(userId: string, now = this.core.clock.now()): Map<string, string> {
    this.core.ensureReady();
    const rows = MAX_USER_ROOMS + MAX_PURGE_ROOMS;
    return this.core.reserved("readCursors", { reads: 8 + 2 * rows }, false, now, (sql) => new Map(sql.rows<{ room_id: string; message_id: number }>(
      "SELECT room_id, message_id FROM read_cursors WHERE user_id = ? LIMIT ?", userId, rows,
    ).map((row) => [row.room_id, idString(integerColumn(row.message_id))])));
  }

  /**
   * The read cursors of a private room's members (read receipts, protocol
   * §4.6), for the rooms of at most MAX_READ_RECEIPT_MEMBERS members: for
   * each, the members other than `except` (the lister) with a cursor kept
   * there and the `read_message_id` each read through, leaving out members
   * who chose `invisible`. A larger room is absent from the result; one with
   * no cursor to show is present, empty. Per room, a range of at most one
   * more membership than the limit, by key, then each member's cursor and
   * `user_status` row by primary key: bounded whatever the room's size.
   */
  roomReadCursors(roomIds: readonly string[], except: string, now = this.core.clock.now()): Map<string, Array<[userId: string, messageId: string]>> {
    const rooms = roomIds.filter(isPrivateRoomId).slice(0, MAX_PRIVATE_MEMBERSHIPS_PER_USER);
    const found = new Map<string, Array<[string, string]>>();
    if (!rooms.length) return found;
    this.core.ensureReady();
    const limit = MAX_READ_RECEIPT_MEMBERS;
    return this.core.reserved("roomReadCursors", { reads: 8 + rooms.length * (4 + (limit + 1) + 3 * limit) }, false, now, (sql) => {
      for (const roomId of rooms) {
        const members = sql.rows<{ user_id: string }>("SELECT user_id FROM memberships WHERE room_id = ? LIMIT ?", roomId, limit + 1);
        if (members.length > limit) continue;
        const rows = sql.rows<{ user_id: string; message_id: number }>(
          `SELECT read_cursors.user_id, read_cursors.message_id
           FROM (SELECT user_id FROM memberships WHERE room_id = ? AND user_id != ? LIMIT ?) AS members
           JOIN read_cursors ON read_cursors.user_id = members.user_id AND read_cursors.room_id = ?
           LEFT JOIN user_status ON user_status.user_id = members.user_id
           WHERE user_status.status IS NULL OR user_status.status != 'invisible'`,
          roomId, except, limit, roomId,
        );
        found.set(roomId, rows.map((row) => [row.user_id, idString(integerColumn(row.message_id))]));
      }
      return found;
    });
  }

  /**
   * Keeps a registered user's read cursors (protocol §4.6), each a room and
   * the `read_message_id` read through, in `read_cursors`: only in rooms
   * they are a member of, so a cursor goes with its membership (a leave,
   * an expired room, `/purge`) and the table holds at most one a
   * membership; and only forward, so cursors written from several
   * connections, in any order, keep the furthest. Each is a primary-key
   * probe of the membership (read alone, so member listings kept for reuse
   * stay valid) and an upsert: a new cursor writes its row and its room
   * index entry, a moved one its row, a cursor not past the kept one
   * nothing.
   */
  saveReadCursors(input: { userId: string; cursors: ReadonlyArray<readonly [roomId: string, messageId: string]>; now?: number }): void {
    const cursors = input.cursors.slice(0, MAX_USER_ROOMS);
    if (!cursors.length) return;
    this.core.ensureReady();
    const now = input.now ?? this.core.clock.now();
    this.core.reserved("saveReadCursors", { reads: 8 + 4 * cursors.length, writes: 8 + 4 * cursors.length }, false, now, (sql) => sql.transaction(() => {
      this.core.effectiveNow(now);
      for (const [roomId, messageId] of cursors) {
        if (!sql.isMember(roomId, input.userId)) continue;
        sql.exec(
          `INSERT INTO read_cursors (user_id, room_id, message_id) VALUES (?, ?, ?)
           ON CONFLICT (user_id, room_id) DO UPDATE SET message_id = excluded.message_id WHERE excluded.message_id > read_cursors.message_id`,
          input.userId, roomId, Number(messageId),
        );
      }
    }));
  }

  /**
   * Settles a registered user's `seen` (protocol §4.5.2) for a change of
   * the status others see of them to `offline` at `at` (epoch
   * milliseconds) that is not a chosen `invisible` (setStatus settles that
   * one with the choice): their last connection closing. The store decides,
   * so every caller agrees with what it holds, however stale the copy it
   * decided from (several tabs closing together, each handled as the last;
   * an eviction in between): the stored one if it stands (seenStands), with
   * no write, else `at`, written. Returns what is stored after, or
   * undefined for an unknown user.
   *
   * One conditional update of the identity row, which writes only where the
   * stored one does not stand (1 read, 1 write when it writes); where it
   * stands, or for an unknown user, a primary-key read of `seen_ms` follows
   * (2 reads, no write). Listings kept for reuse are patched in place, not
   * invalidated (patchMemberSeen).
   */
  settleSeen(input: { userId: string; at: number; now?: number }): number | undefined {
    assertSeen(input.at);
    this.core.ensureReady();
    const now = input.now ?? this.core.clock.now();
    return this.core.reserved("settleSeen", { reads: 8, writes: 8 }, false, now, (sql) => {
      this.core.effectiveNow(now);
      return sql.settleSeen(input.userId, input.at);
    });
  }
}
