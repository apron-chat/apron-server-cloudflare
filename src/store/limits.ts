/** Storage caps, batch sizes and read reservations: how much one operation may touch. */

import { CALIBRATED_THREAD_LIMIT, DEFAULT_LIMITS, listedThreads, listedThreadScale, MAX_MEMBERSHIPS_PER_USER, MAX_PRIVATE_ROOM_LIMIT, MAX_PUSHES_PER_MESSAGE } from "../budget";
import { MAX_USER_ROOMS, WAKE_SCOPES } from "../domain";

export const ROOM_TITLE = "General";
/** Title the demo supplies for a thread room created or saved without one. */
export const DEFAULT_THREAD_TITLE = "Thread";
/** Title the demo supplies for a top-level room created or saved without one. */
export const DEFAULT_ROOM_TITLE = "Room";
/** Private rooms a maintenance listing names, the most recently active. */
export const LISTED_PRIVATE_ROOMS = 2 * MAX_PRIVATE_ROOM_LIMIT;
/**
 * A join past MAX_MEMBERSHIPS_PER_USER (budget.ts) is refused, so the reads
 * of a user's own rooms (userRooms, their private rooms, a purge or rename
 * of them) stay bounded and reserved for (MAX_MEMBERSHIP_ROWS).
 */
export const MEMBERSHIP_LIMIT_MESSAGE = `A user may be in at most ${MAX_MEMBERSHIPS_PER_USER} rooms; leave one to join another`;
/** Most private rows a maintenance listing reads: the ones it names. */
export const PRIVATE_ROOM_ROWS = LISTED_PRIVATE_ROOMS;
/**
 * Most public rows a listing reads (listRooms) under a thread limit of
 * `maxThreads`: `general` and the top-level rooms (MAX_CREATED_ROOMS, well
 * within one thread scale), and the listedThreads threads it names.
 */
export function publicRoomRows(maxThreads: number): number {
  return listedThreadScale(maxThreads) + listedThreads(maxThreads) + 1;
}
/**
 * Reads for counting a kind's rooms created within the window
 * (recentRoomCount), or a user's among them: its range of
 * ROOM_CREATED_INDEX, which the caps keep within the ceilings (a room is
 * created, or restored inside the window, only while there is a slot), with
 * room for a window lengthened since, and index pages.
 */
export function roomCountReads(maxThreads: number): number {
  return 2 * Math.max(publicRoomRows(maxThreads), PRIVATE_ROOM_ROWS) + 16;
}
export const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;
export const DEDUP_TTL_MS = DEFAULT_LIMITS.dedupTtlSeconds * 1000;
export const MINUTE_MS = 60 * 1000;
/**
 * A limiter row's `updated_ms` moves only when a cached row is written
 * (limiter-cache.ts: every few charges), or another is a minute old or from
 * an earlier UTC day, so a busy principal rewrites its index entry rarely
 * rather than on every charge. Cleanup keeps rows touched within this long,
 * which must outlast any limiter's horizon (bucketHorizonMs) plus a minute.
 */
export const LIMITER_IDLE_MS = 60 * MINUTE_MS;

/** Embed kinds that carry live text (§4.8.3). */
export const LIVE_KINDS: ReadonlySet<string> = new Set(["terminal", "append"]);
/** Rows one live text's bookkeeping may write: the `_meta` row, three limiter rows and their counter. */
export const LIVE_WRITES = 16;

/**
 * A move re-logs the moved message's reaction sets and rewrites each one's
 * state row, about 4 written rows a set, so moving a message with many
 * reactors costs several posts' worth of writes. Each this many sets add
 * one post to the move's charge: a message with fewer reactors moves for one
 * post, and the most reacted-to (32 sets) for five.
 */
export const MOVE_REACTION_SETS_PER_POST = 8;
/** Log IDs one copy from this SQLite carries at most (historyScan). */
export const HISTORY_SCAN_BATCH = 100;
/** Index entries historyTarget reads past the cutoff at most, looking for the first record it keeps. */
export const HISTORY_TARGET_SCAN = 200;
/**
 * How soon after a cleanup started at the storage watermark another may
 * start while the database stays over it (cleanupDueAt): a pressure that
 * cleanup cannot relieve (what is past the count already gone, or waiting on
 * a failing copy below) is looked at again then, not at every alarm.
 */
export const PRESSURE_CLEANUP_RETRY_MS = 5 * 60_000;
/** Rewrites the log holds at most: a /purge or /rename past it waits for the links to catch up (retry_after). */
export const MAX_HISTORY_REWRITES = 200;
/** Removals (`removed:` markers) one resuming `room_list` announces at most. */
export const MAX_REMOVALS_RESENT = 256;
/**
 * The records one restoreRoom call takes at most (an import's batch): a
 * room with more is restored over several calls, oldest records first.
 */
export const RESTORE_RECORDS_BATCH = 256;
/** Reaction sets and members, together, one restoreRoom call's records hold at most. */
export const RESTORE_ENTRIES_BATCH = 1_024;
/** Reaction sets and members one restored record may hold when it is restored alone (restoreRoom). */
export const RESTORE_ENTRIES_SINGLE = 20_000;
/**
 * Stored records of the room a restoreRoom call reads again at most, when
 * some of its records are older than what the room already holds: past it
 * the call is refused, as a room's records are sent oldest first.
 */
export const RESTORE_REPLAY_CAP = 1_024;
/** Records past a room's creation roomIsEmpty reads at most: joins and leaves alone (the importing admin's own join of `general`) leave a room an import may fill. */
export const EMPTY_ROOM_SCAN = 64;
/** How far past the clock a restored record's log ID or commit time may be (importArchive's FUTURE_LOG_ID_MS). */
export const RESTORE_FUTURE_MS = 5 * 60_000;
/** The users one restoreUsers call takes at most. */
export const RESTORE_USERS_BATCH = 200;
/** The longest avatar URL an imported user keeps. */
export const MAX_RESTORED_AVATAR_BYTES = 2_048;
/** Most removed rooms awaiting purge; cleanup removes no further room past it. Fixed, like MAX_USER_ROOMS: a larger backlog waits for the next run. */
export const MAX_PURGE_ROOMS = CALIBRATED_THREAD_LIMIT;
/**
 * Membership rows one user may hold: at most MAX_MEMBERSHIPS_PER_USER, and
 * those of removed rooms awaiting purge. What a purge or rename of them
 * moves, and the most a count of them reads (membershipCount).
 */
export const MAX_MEMBERSHIP_ROWS = MAX_MEMBERSHIPS_PER_USER + MAX_PURGE_ROOMS;
/** Reads for membershipCount(): its rows through the user index, and index pages. */
export const MEMBERSHIP_COUNT_READS = 8 + MAX_MEMBERSHIP_ROWS;
/**
 * Reads for privateRoomCounts() and the private cap: the private range of
 * the rooms table, twice (the creator's live rooms, and the active ones),
 * an index entry and a row each, and the creator's membership rows, live
 * and awaiting purge, with a room lookup each.
 */
export const PRIVATE_ROOM_COUNT_READS = 16 + 4 * PRIVATE_ROOM_ROWS + 2 * (MAX_USER_ROOMS + MAX_PURGE_ROOMS);
/**
 * Most retained records a budget-checked log scan (`/rename`) reserves for:
 * past it `/rename` is refused. At the paid plan's 30-day retention that is
 * an average of about 3,300 records a day (the demo kept about 115 a day in
 * November 2026), and a small share of the day's foreground reads. Counting reads one index entry per record, refunded past
 * what is found.
 */
export const RETAINED_SCAN_CAP = 100_000;
/** Accounts one idle prune removes at most (pruneIdleIdentities); the next alarm continues. */
export const IDLE_PRUNE_BATCH = 100;
/** A user's bot (`bot_<user_id>`, as the runtime names it): it goes with its owner, and its activity is theirs. */
export const BOT_PREFIX = "bot_";
/** A sign-in records an account's activity at most this often (noteActive). */
export const ACTIVITY_GRANULARITY_MS = 86_400_000;
/** Retired user ids freed at most per call (dueRetiredUserIds). */
export const RETIRED_SWEEP_BATCH = 500;
/** Idle prune batches a UTC day at most: a backlog spreads over days. */
export const IDLE_PRUNE_RUNS_PER_DAY = 10;
/** Rooms a full room notes total names to the admins, the largest first. */
export const ROOM_NOTES_NAMED = 3;
/**
 * Most passkeys a schema reset carries over (see resetStorage), most recently
 * used first; any beyond it are dropped with the rest of the object. It bounds
 * the reset's uncharged-for-capacity SQL work to a small share of a day's
 * writes, and so the identities that can survive a wipe.
 */
export const MAX_CARRIED_PASSKEYS = 100;
/**
 * How far past a retired id's marker the history floor must be before the
 * id is freed. Markers written before they held the log head held the
 * time, and log IDs are commit-time milliseconds that run ahead of the
 * clock only while commits come faster than one a millisecond.
 */
export const RETIRED_MARKER_MARGIN = 60 * 60 * 1000;
/**
 * How long past its write window a pending upload may still finish: the write
 * started in time and is still arriving. Expiry waits this long too.
 */
export const UPLOAD_WRITE_GRACE_MS = 60_000;
/** Pending uploads or expired upload rows one maintenance pass handles. */
export const UPLOAD_SWEEP_BATCH = 32;
/** Rows one upload's bookkeeping may write: its row and indexes, two limiter rows, and the byte count. */
export const UPLOAD_WRITES = 16;
/**
 * Most push subscriptions one user can hold under any valid policy: a
 * policy's `subscriptionsPerUser` is at most MAX_PUSHES_PER_MESSAGE, and
 * each registration evicts down to the policy in force. Reservations that
 * touch a user's subscriptions are sized by it.
 */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = MAX_PUSHES_PER_MESSAGE;
/**
 * Most `push_wakes` rows one user can hold: one per room they were woken
 * for, and wakes come only for messages in existing rooms (at most the
 * thread ceiling and `general`); rows of rooms removed since cleanup last
 * ran, at most the purge list, wait for it.
 */
export const MAX_PUSH_WAKES_PER_USER = MAX_MEMBERSHIP_ROWS;
/** A re-registration of an unchanged subscription younger than this writes nothing. */
export const PUSH_REFRESH_MS = 86_400_000;
/** `mentions` and `replies`, the default for a registration without `wake` (§4.9.4). */
export const DEFAULT_WAKE = WAKE_SCOPES.mentions | WAKE_SCOPES.replies;
/** Every scope: a registration's `wake` names some of these. */
export const ALL_WAKE = WAKE_SCOPES.mentions | WAKE_SCOPES.replies | WAKE_SCOPES.private | WAKE_SCOPES.joined;

/** Rows one guest-number block reservation may read and write, before control overhead. */
export const GUEST_NUMBER_BLOCK_COST = { reads: 8, writes: 8 } as const;

/**
 * How many pages of the log a history page of several rooms scans by log_id
 * before it reads each room's slice instead (Store.historyPageInternal).
 */
export const HISTORY_SCAN_PAGES = 4;
