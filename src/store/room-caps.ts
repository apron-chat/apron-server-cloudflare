/*
 * Room caps: the rooms of each kind created within the creation window
 * (by the kind-and-creation index, ROOM_KIND), a user's threads and private
 * rooms, a user's memberships, and whether a slot is free, which the commit
 * path (room_set, joins) and a restore check before they add one. Counted,
 * never scanned whole: each read is one range of an index.
 */

import { ROOM_ID } from "../domain";
import { MAX_MEMBERSHIP_ROWS, roomCountReads } from "./limits";
import { integerColumn, windowDays } from "./rows";
import { privateRange, roomKind } from "./schema";
import type { Sql, StoreCore } from "./core";

/** Room caps over the store's core: what the commit path and restore count rooms and memberships by, and the Rooms part's counts. */
export class RoomCapsModule {
  constructor(private readonly core: StoreCore) {}

  /**
   * The creation log ID (a commit time) from which a room counts against
   * the thread and private-room caps (roomCreationWindowMs): 0, which every
   * room is at or past, when every room that exists counts.
   */
  creationCutoff(now: number): number {
    return this.core.config.roomCreationWindowMs > 0 ? Math.max(0, now - this.core.config.roomCreationWindowMs) : 0;
  }

  /** Rows the rooms table holds (`general`, the public rooms counted by thread_count, the private ones): what a scan of every room reads. */
  roomRowCount(sql: Sql): number {
    return 1 + sql.lobbyRoomIds().length + sql.metaNumber("thread_count") + sql.metaNumber("private_count");
  }

  /**
   * The rooms counted against a cap (roomCountReads): those created within
   * roomCreationWindowMs. `public`, the top-level rooms and threads besides
   * `general`, against maxThreads; `private`, the private rooms, against
   * maxPrivateRooms. Each a range of ROOM_CREATED_INDEX.
   */
  recentRoomCount(sql: Sql, kind: "public" | "private", now: number): number {
    const cutoff = this.creationCutoff(now);
    const count = (query: string, ...bindings: unknown[]) => integerColumn(sql.rows<{ count: number }>(query, ...bindings)[0]?.count);
    if (kind === "private") return count(`SELECT COUNT(*) AS count FROM rooms WHERE ${roomKind(2)} AND created_log_id >= ?`, cutoff);
    // `general` and every lobby room are outside the caps (the one plain
    // comparison where the object never had a lobby).
    const lobbies = sql.lobbyRoomIds();
    const topLevel = lobbies.length
      ? count(`SELECT COUNT(*) AS count FROM rooms WHERE ${roomKind(0)} AND created_log_id >= ? AND room_id NOT IN (SELECT value FROM json_each(?))`, cutoff, JSON.stringify([ROOM_ID, ...lobbies]))
      : count(`SELECT COUNT(*) AS count FROM rooms WHERE ${roomKind(0)} AND created_log_id >= ? AND room_id != ?`, cutoff, ROOM_ID);
    return topLevel +
      count(`SELECT COUNT(*) AS count FROM rooms WHERE ${roomKind(1)} AND created_log_id >= ?`, cutoff);
  }

  /** Whether a room of `kind` may be created (or restored as created within the window): fewer were created within it than the cap. */
  roomSlotFree(sql: Sql, kind: "public" | "private", now: number): boolean {
    const cap = kind === "public" ? this.core.config.maxThreads : this.core.config.maxPrivateRooms;
    return this.recentRoomCount(sql, kind, now) < cap;
  }

  /** The refusal when the private-room cap is full. */
  privateRoomLimitMessage(): string {
    return this.core.config.roomCreationWindowMs > 0
      ? `This server starts at most ${this.core.config.maxPrivateRooms} private rooms in ${windowDays(this.core.config.roomCreationWindowMs)}; try again later`
      : "The demo holds as many private rooms as it can; one frees up when everyone has left it";
  }

  /**
   * `/status`: the public rooms (besides `general`) and private rooms
   * created within roomCreationWindowMs, which the caps count, and those
   * kept besides.
   */
  roomCounts(now = this.core.clock.now()): { public: { recent: number; older: number }; private: { recent: number; older: number } } {
    this.core.ensureReady();
    return this.core.reserved("roomCounts", { reads: 16 + 2 * roomCountReads(this.core.config.maxThreads) }, false, now, (sql) => {
      const publicRecent = this.recentRoomCount(sql, "public", now);
      const privateRecent = this.recentRoomCount(sql, "private", now);
      return {
        public: { recent: publicRecent, older: Math.max(0, sql.metaNumber("thread_count") - publicRecent) },
        private: { recent: privateRecent, older: Math.max(0, sql.metaNumber("private_count") - privateRecent) },
      };
    });
  }

  /**
   * The rooms a registered user is a member of, through the user index,
   * those awaiting purge included: at most MAX_MEMBERSHIP_ROWS rows read
   * (MEMBERSHIP_COUNT_READS), the count stopping there.
   */
  membershipCount(sql: Sql, userId: string): number {
    return integerColumn(sql.rows<{ count: number }>(
      "SELECT COUNT(*) AS count FROM (SELECT 1 FROM memberships INDEXED BY memberships_user_idx WHERE user_id = ? LIMIT ?)", userId, MAX_MEMBERSHIP_ROWS,
    )[0]?.count);
  }

  /** Thread rooms `userId` created within roomCreationWindowMs (`cutoff`): ROOM_CREATED_INDEX's range of them, the creator read from each row. */
  recentThreadsCreatedBy(sql: Sql, userId: string, cutoff: number): number {
    return integerColumn(sql.rows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM rooms WHERE ${roomKind(1)} AND created_log_id >= ? AND json_extract(fields_json, '$.creator_id') = ?`,
      cutoff, userId,
    )[0]?.count);
  }

  /**
   * For a private room's creation (PRIVATE_ROOM_COUNT_READS): the private
   * rooms `userId` created within roomCreationWindowMs (`cutoff`), as
   * recentThreadsCreatedBy counts threads; and the private rooms they are
   * in, from their memberships.
   */
  privateRoomCounts(sql: Sql, userId: string, cutoff: number): { created: number; memberships: number } {
    const created = integerColumn(sql.rows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM rooms WHERE ${roomKind(2)} AND created_log_id >= ? AND json_extract(fields_json, '$.creator_id') = ?`,
      cutoff, userId,
    )[0]?.count);
    return { created, memberships: this.privateMembershipCount(sql, userId) };
  }

  /**
   * The private rooms a registered user is in. Their membership rows,
   * through the user index, joined with `rooms` so the rows of a removed
   * room awaiting purge do not count: at most MAX_MEMBERSHIP_ROWS rows, and
   * a room lookup each.
   */
  privateMembershipCount(sql: Sql, userId: string): number {
    return integerColumn(sql.rows<{ count: number }>(
      `SELECT COUNT(*) AS count FROM memberships m INDEXED BY memberships_user_idx
       JOIN rooms r ON r.room_id = m.room_id
       WHERE m.user_id = ? AND ${privateRange("m.room_id")}`,
      userId,
    )[0]?.count);
  }
}
