/*
 * The store's parts: what code outside src/store uses of it, one plain
 * noun each (src/store/index.ts assembles them into a Store). Each part is
 * a small object of its own, so a part's methods are named for what they
 * do there (`accounts.get`, `push.claim`), and a later change can move one
 * part's implementation out of SqliteStore without touching its callers.
 * The SQLite-backed parts delegate to SqliteStore (sqlite-parts.ts).
 */

import type { AccountUsageSnapshot } from "../account-usage";
import type { BudgetSnapshot, CostEstimate } from "../budget-ledger";
import type { StoredCredential, StoredIdentity } from "../domain";
import type { ChunkIndex } from "../history/cold/chunks";
import type { QueuedRewrite } from "../history/records";
import type { ChainStatePort } from "../history/state";
import type { ExportPort, HistoryHead, RestorePort } from "../history/tier";
import type { LiveKind } from "../live-text";
import type { StatusChoice } from "../presence";
import type { StoreConfig } from "./config";
import type {
  Broadcast, EmojiDraft, EmojiEdit, Identity, LiveEntry, LiveFinish, MessageSnapshot, OverrunNotice, PendingHistory, PendingUpload,
  PushCandidate, PushClaim, RoomMember, RoomNotesCheck, RoomRecord, StatusInputRecord, StoreCleanupResult, StoredServerMetadata,
  StoreHistoryQuery, StoreHistoryResult, StoreMutationInput, StoreMutationResult, TerminalStored, UploadFinish, UploadWrite,
} from "./types";

/** Registered identities: sign-up, lookup, renames and purges, roles, bots, idle pruning and retired IDs, and their status and mutes. */
export interface Accounts {
  /** A registered identity by `user_id`, or null. */
  get(userId: string): StoredIdentity | null;
  /** Whether an identity has this `user_id` now, one indexed read. */
  exists(userId: string): boolean;
  /** Whether `/purge` or the idle prune retired this `user_id`, not yet freed: one `_meta` read. */
  purged(userId: string): boolean;
  /** Whether `/purge` removed this `user_id` and what it left, not yet freed: one `_meta` read. */
  removed(userId: string): boolean;
  /** The `user_id`s `/purge` removed at or after log position `after`, not yet freed, at most `limit`. */
  removedSince(after: number, limit: number): string[];
  /**
   * Whether a `user_id` may not be issued: an identity has it, `/rename`
   * retired it, or `/purge` or the idle prune retired it and it is not yet
   * freed (dueRetiredUserIds). Registration picks ids with it.
   */
  idTaken(userId: string): boolean;
  /**
   * Registers an identity and its credential. The identity starts in the
   * given rooms that still exist (the guest's it replaces, or `general`), and
   * each start is a logged membership (§4.2.2), returned in `broadcasts` for
   * the caller to deliver to the rooms' members.
   */
  register(input: {
    userId: string;
    name: string;
    userHandle: string;
    credential: StoredCredential;
    now: number;
    ipKey: string;
    /** The rooms the new identity starts in, such as the guest's it replaces. */
    rooms?: readonly string[];
  }): StoredIdentity & { broadcasts: Broadcast[] };
  /**
   * `/invite-token`: a registered user with no passkey, who signs in with a
   * bearer token an admin hands out. The `user_id` must be free: no identity
   * has it and `/rename` never retired it. Charged as a registration, and
   * starts in `general` like any other identity.
   */
  createInvited(input: { userId: string; name: string; now: number; ipKey: string }): { broadcasts: Broadcast[] };
  /**
   * The admin user that `APRON_ADMIN_TOKEN` signs in as: a registered identity with
   * no credential, created on first use like a bot, against the same caps.
   * `created` is false when it already exists.
   */
  ensureAdmin(input: { userId: string; name: string; now: number; ipKey: string }): { created: boolean; broadcasts: Broadcast[] };
  /**
   * `/rename`: moves a registered user to a new `user_id`: the identity row,
   * its credential (so its passkey signs in as the new id), its stored
   * memberships, and its roles (a column of the row), and rewrites what they
   * left under the old id to the new one: the `from` of their logged message
   * snapshots and current messages (so they can still edit them), their
   * reaction sets, logged and current, and their logged membership changes,
   * keeping the recorded names; the rooms they created; their uploads; their push subscriptions, status and mutes;
   * their limiter windows; and their dedup rows. Nothing is announced: clients see the new id when they
   * load history again. Other users' `body.mentions`, sessions and the user's
   * bot stay under the old id. The old `user_id` is retired, never reissued.
   * Returns the user's name, joined rooms, and roles. A bot's is fixed.
   *
   * Finding the user's records scans the retained log, as `/purge` does; the
   * rewrite is then charged by what was found. Both steps run without
   * yielding, so nothing commits between them.
   */
  rename(input: { from: string; to: string; now?: number }): { name: string; avatar?: string; ext?: Record<string, unknown>; rooms: string[]; roles: string[] };
  /**
   * `/purge`: removes users and everything they left, silently, with no new
   * records: their message snapshots and current messages, with every
   * reaction set on those messages; their reaction sets elsewhere; their
   * memberships and membership records; their uploads; and their identity,
   * passkey, push subscription, status, mute, limiter and dedup rows. A logged record that
   * lists them beside others (a move's reaction sets) is rewritten without
   * them. Rooms they created stay, without a creator. Each purged identity's
   * `user_id` is retired (META_PURGED_PREFIX) until history has expired past
   * the log head, and with it anything that named it; sessions carry the user handle
   * they were issued under, so none carries over to a later account.
   * Removing the threads it leaves empty is the caller's (removeIfEmpty), as
   * it knows the connections still in them. Clients that already have their content
   * keep it until they load history again. Returns what went, and the R2
   * objects the caller deletes.
   */
  purge(input: { userIds: readonly string[]; now?: number }): { messages: number; reactions: number; deletedUploads: string[] };
  /**
   * Records that a user signed in (a passkey, a session resume, a token),
   * at most once per ACTIVITY_GRANULARITY_MS: the identity's `updated_ms`,
   * which the idle prune reads as activity whether or not user status keeps
   * `seen`. One conditional row update; never throws.
   */
  noteActive(userId: string, now?: number): void;
  /**
   * Removes up to IDLE_PRUNE_BATCH registered accounts inactive for
   * `idleAccountMs` (lastActiveSql: created, profile change or sign-in,
   * departure, passkey use, or their bot's activity), least recently active
   * first, in at most IDLE_PRUNE_RUNS_PER_DAY runs a UTC day, and none until
   * activity has been recorded for `idleAccountMs` (META_IDLE_ACTIVITY_SINCE). It never removes one of the `keptActiveAccounts`
   * most recently active, one with a role (admins, mods, friends), the admin
   * user, one `connected` now or whose bot is, one whose bot holds a role
   * of its own, or one with a live upload (its avatar or
   * files expire first). With each goes its bot. It removes their identity,
   * passkeys, memberships (lowering their rooms' member counts), read
   * cursors, status, mutes, push subscriptions and wakes, dedup and limiter
   * rows, and their rooms' creator; each `user_id` is retired until history
   * has expired past the log head (dueRetiredUserIds). What they posted
   * stays in history, under the name it was posted with, until it expires
   * like anything else. Maintenance work: it measures the rows first,
   * then reserves them, and a refusal leaves the rest for a later run.
   * Returns the removed ids (bots included), and whether more may remain.
   */
  pruneIdle(now?: number, connected?: ReadonlySet<string>): { pruned: string[]; more: boolean };
  /** Idle accounts pruned today and in all (pruneIdleIdentities), for `/status`: charged, never refused. */
  idlePruned(now?: number): { today: number; total: number };
  /**
   * The `user_id`s retired (`purged:<id>`, by `/purge` or the idle prune)
   * whose marker the history floor has passed, by RETIRED_MARKER_MARGIN, or
   * every one once the whole log has expired, at most RETIRED_SWEEP_BATCH:
   * nothing retained names them, so they may be freed. The log is the
   * clock: an id stays retired until the history that might name it is gone,
   * however long that takes. A marker from before markers kept their time
   * (`1`) starts at the log head. The caller revokes every token of each (and
   * of its bot) before freeRetiredUserIds frees it, so no token of the old
   * account can sign in to a new one under the id.
   */
  dueRetiredIds(now?: number): string[];
  /** Frees retired `user_id`s (dueRetiredUserIds), their tokens revoked: they may be issued again. */
  freeRetiredIds(userIds: readonly string[], now?: number): void;
  /**
   * Gives a user a role (`on`), takes it away, or with no `on` toggles it,
   * for `/role` and `/admin`. `changed` is false when there was nothing to
   * do. Roles are kept in the identity row, at most MAX_ROLES_PER_USER.
   * Only registered users and bots have roles; a bot is never an admin; and
   * `bot` is given to no admin and no user holding a passkey, since a bot
   * signs in with a token only. The roles a user has by what they are,
   * `admin` for the `admin` user and `bot` for an owner's bot (tier `bot`),
   * are not taken away.
   */
  setRole(input: { userId: string; role: string; on?: boolean; now?: number }): { changed: boolean; on: boolean; name: string; roles: string[] };
  /**
   * Registered users with `role`, by `user_id`, at most `limit`: one scan
   * of the identities, for an operator alert. Bots and the admin user are
   * identities too, so the reservation allows twice the registration cap.
   */
  withRole(role: string, limit: number, now?: number): string[];
  /**
   * Creates or renames a registered owner's bot (`/invite-bot`): an identity
   * with no credential, which signs in only with the bearer token the caller
   * keeps. A new bot counts as a registration against the same daily and
   * identity caps as a passkey, and starts in `general`, a logged membership
   * (§4.2.2) returned in `broadcasts`. An existing bot only takes the new name.
   */
  registerBot(input: { ownerId: string; botId: string; name: string; now: number; ipKey: string }): {
    userId: string; name: string; created: boolean; renamed: boolean; broadcasts: Broadcast[];
  };
  /**
   * Marks an account whose only role is `bot` active, when it signs in or
   * posts: its identity's `updated_ms`, which idleBots reads. Anyone else is
   * left as is.
   */
  markBotActive(userId: string, now?: number): void;
  /**
   * Marks an idle bot signed out (idleBots), once its rooms and tokens are
   * gone: `updated_ms` 0, a time nothing else writes, so the sweep skips it
   * until it is active again.
   */
  markBotSignedOut(userId: string, now?: number): void;
  /**
   * The daily idle bot sweep, once its `_meta` due time has passed: up to
   * `limit` accounts whose only role is `bot` and that have not been active
   * (markBotActive) since `before`, oldest first, and are not yet signed out
   * (markBotSignedOut), for the caller to sign out.
   * The next sweep is due `intervalMs` later, or at once after a full batch.
   * The first call only sets the first sweep `graceMs` out, so bots active
   * before this was recorded are not taken for idle. Null when not due.
   */
  idleBots(input: { now: number; before: number; limit: number; intervalMs: number; graceMs: number }): string[] | null;
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
  setStatus(input: { userId: string; choice: StatusChoice; now?: number; seenAt?: number }): { changed: boolean; seen?: number };
  /**
   * `status` `mute` without `room_id` (protocol §4.5) for a registered user:
   * until when they are muted, MUTE_FOREVER for `true`, or null to end it.
   * Whether the stored mute changed, and `untilMs`, the end it leaves,
   * absent when not muted. A mute is the user's, whichever connection set
   * it. It is kept in the user's `user_status` row, which goes once it holds
   * only defaults.
   */
  setMute(input: { userId: string; untilMs: number | null; now?: number }): { changed: boolean; untilMs?: number };
  /**
   * Clears mutes that ran out: an account's (`user_status`, deleted when
   * nothing else is left in it) and its rooms' (`room_mutes`). Otherwise
   * they stay until the user mutes again. Returns the rows changed.
   */
  clearExpiredMutes(now?: number): number;
}

/** Passkeys: the WebAuthn credentials and user handles identities sign in with. */
export interface Credentials {
  /** A passkey by credential ID, or null. */
  get(credentialId: string): StoredCredential | null;
  /**
   * Adds a passkey to a registered identity that is signed in (§4.10): a
   * registration on a connection already signed in adds to that account.
   * Bots sign in with their token and take none. At most
   * MAX_PASSKEYS_PER_USER per identity; a credential already registered
   * anywhere is `invalid_params`. Charged as a registration against the
   * per-IP and daily caps, which bound the rows this can write, but not
   * against the identity count. An identity without a passkey yet (an
   * invited user, or `admin`) takes `userHandle` as its WebAuthn user handle.
   */
  add(input: { userId: string; userHandle: string; credential: StoredCredential; now: number; ipKey: string }): { userId: string; name: string };
  /**
   * The WebAuthn user handle an identity's passkeys share: its stored one,
   * or, for an identity with none yet (an invited user), `candidate`, stored
   * now so concurrent ceremonies for it share one handle. One conditional
   * write at most.
   */
  ensureHandle(userId: string, candidate: string, now?: number): string | null;
  /** An identity's passkeys, oldest first: at most MAX_PASSKEYS_PER_USER, for `/passkeys`. */
  passkeys(userId: string, now?: number): Array<{ credentialId: string; createdMs: number; usedMs: number }>;
  /**
   * Removes one of an identity's passkeys, for `/passkeys remove`. Not the
   * last one, which would leave a passkey user no way back in once their
   * session ends. Returns whether it was removed.
   */
  removePasskey(input: { userId: string; credentialId: string; now?: number }): boolean;
  /**
   * Removes every passkey of an identity and clears its WebAuthn user
   * handle, for `/invite-reset`: the passkey sessions issued under the old
   * handle no longer resume, and a passkey registered later takes a new one.
   * Returns how many passkeys were removed.
   */
  resetAuth(input: { userId: string; now?: number }): number;
  /** The credential IDs of a user's passkeys. */
  idsForUser(userId: string): string[];
  /** Stores a passkey's signature counter after a sign-in. */
  updateCounter(credentialId: string, counter: number): void;
}

/** Rooms and memberships: lookups, listings and member lists, counts, and joining and leaving. */
export interface Rooms {
  /** One room's record, or null when the room does not exist. */
  get(roomId: string, now?: number): RoomRecord | null;
  /**
   * Every public room record, oldest first, for `room_list`, which adds the
   * caller's private rooms (privateRoomsOf). Maintenance callers (the
   * retention `room_update` `updated` listing, which goes to each room's
   * members) charge the maintenance budget, may list the private rooms too
   * (`withPrivate`), and may keep only rooms whose history_log_id differs
   * from what it was under an earlier retention floor.
   */
  list(now?: number, options?: { maintenance?: boolean; changedSinceFloor?: number; withPrivate?: boolean }): RoomRecord[];
  /**
   * The registered members of each room (§4.2.1), as `user_id` with the
   * current `name` (`""` when removed), live `avatar`, and `roles`, in
   * `user_id` order: at most `limit` per room, read from the room's
   * primary-key range with one identity lookup each. With `withStatus`, each
   * also carries the `status` it chose (`choice`), from its `user_status`
   * row, joined by primary key: a member without one costs nothing more;
   * and its `seen`, from the identity row read anyway.
   * Guests' memberships are not stored; the caller adds connected ones.
   *
   * With `memberCacheMs`, a room's rows are kept in memory that long and
   * reused, with no SQL and no reservation, until a write to `identities`,
   * `memberships` or `user_status` (see rawExec). Avatars are judged against
   * `now` on every call, so a reused row is never more out of date than a
   * fresh read.
   */
  members(roomIds: readonly string[], limit: number, now?: number, counts?: Map<string, number>, withStatus?: boolean): Map<string, RoomMember[]>;
  /** One registered member of a room, for `room_list` with `user_id` (§4.2.1), or null when they aren't one. */
  member(roomId: string, userId: string, now?: number, withStatus?: boolean): RoomMember | null;
  /**
   * The registered user who created a thread or private room with
   * `room_set`, who may remove its members (§4.2.2), kept beside the room's
   * client fields (`creator_id` in `fields_json`) but never in its record.
   * Undefined for `general`, a guest's room, an unknown room, and a public
   * top-level room: its creator was an admin or mod when they made it, and
   * gets no lasting power over its members from that, losing the role or not.
   */
  creator(roomId: string, now?: number): string | undefined;
  /**
   * `/status`: the public rooms (besides `general`) and private rooms
   * created within roomCreationWindowMs, which the caps count, and those
   * kept besides.
   */
  counts(now?: number): { public: { recent: number; older: number }; private: { recent: number; older: number } };
  /**
   * The private rooms a registered user is in, as room records, for their
   * listings: listRooms reads only the public ones. Their membership rows
   * through the user index, live and awaiting purge, joined with `rooms`,
   * which hides the latter.
   */
  privateOf(userId: string, now?: number): RoomRecord[];
  /**
   * The top-level rooms' IDs, `general` first, for `room_list`'s shortcut.
   * At most MAX_CREATED_ROOMS + 1, and they are never removed. No index
   * holds `parent_room_id`, so the scan reads every public row, threads
   * included, and the sort reads the top-level ones again: it is reserved
   * as the listing of every public room (roomListingReads), not by the rows
   * it returns.
   */
  topLevelIds(now?: number): string[];
  /**
   * Joins or leaves a room for a registered user. The posting limits charged
   * are the user's own, or `actorId`'s when someone else makes the change
   * (an admin's `/kick`); `ipKey` is the requesting connection's.
   */
  changeMembership(input: { userId: string; ipKey: string; roomId: string; join: boolean; now?: number; actorId?: string }): {
    rooms: string[]; changed: boolean; membership?: Broadcast; room?: RoomRecord;
  };
  /**
   * Charges a guest's join or leave that changes something as one post, to
   * the guest's (`anonymous:<ip>`), the IP's and the global posting limits
   * (chargePosting), so a posting refusal holds back every write (§6,
   * `ext:limits` `write`). A guest's rooms live in its connection, so
   * nothing else is stored; the caller changes them only once this returns.
   * The reservation covers the three limiter rows, each inserted on first
   * use, and is mostly credited back while the guest's and IP's rows are
   * cached (limiter-cache.ts).
   */
  chargeGuestMembership(input: { ipKey: string; now?: number }): void;
  /**
   * Removes a thread or private room that has emptied (§4.2.2): no registered member is
   * left in it, so the last to leave frees its slot instead of leaving it
   * until its log expires, whatever messages it holds. The caller checks
   * that no connection, a guest's included, is still in it. Its records and
   * messages stay until they expire, but currentMessage no longer finds the
   * messages, so they cannot be edited, moved, reacted to or replied to.
   * Returns whether the room was removed.
   */
  removeEmptyThread(roomId: string, now?: number): boolean;
  /**
   * How many registered members a room has (its row's `member_count`),
   * undefined for an unknown room: one primary-key read. Read receipts go
   * only to rooms of at most MAX_READ_RECEIPT_MEMBERS (roomReadCursors).
   */
  memberCount(roomId: string, now?: number): number | undefined;
}

/** The log: mutations (posts, edits, reactions, room saves, `me`) and history pages. */
export interface Messages {
  /** Runtime adapter: commits a private copy of the request parameters. */
  mutate(input: StoreMutationInput): StoreMutationResult;
  /**
   * One accepted operation: dedup lookup, reservation, then one atomic
   * decision that rechecks quotas, allocates log IDs, writes every record and
   * current state, and records the result. Callers broadcast `broadcasts` in
   * order only after this returns.
   */
  commit(input: StoreMutationInput): StoreMutationResult;
  /**
   * The author of a retained message, for waking the user a reply answers
   * (protocol §4.9 `replies`): one indexed read of its current state. Null
   * for an unknown or expired message.
   */
  author(messageId: string, now?: number): string | null;
  /**
   * history, for a runtime with tiers below: a page that reaches below the
   * hot floor is a PendingHistory, which the runtime completes with the
   * records it asks of them (HistoryChain.read). Charged and checked as
   * history is, before they are read.
   */
  historyAcrossTiers(query: StoreHistoryQuery): StoreHistoryResult | PendingHistory;
}

/** Read cursors, room mutes and the inputs of `status` (protocol §4.5, §4.6). */
export interface Reads {
  /**
   * A registered user's read cursors (protocol §4.6): the `read_message_id`
   * kept for each room they joined that has one, by room. One range of the
   * user's rows, at most one a membership; none costs nothing.
   */
  cursors(userId: string, now?: number): Map<string, string>;
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
  saveCursors(input: { userId: string; cursors: ReadonlyArray<readonly [roomId: string, messageId: string]>; now?: number }): void;
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
  roomCursors(roomIds: readonly string[], except: string, now?: number): Map<string, Array<[userId: string, messageId: string]>>;
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
  settleSeen(input: { userId: string; at: number; now?: number }): number | undefined;
  /**
   * `status` `mute` with `room_id` (protocol §4.5) for a registered user:
   * until when `roomId` and its threads are muted, MUTE_FOREVER for `true`,
   * or null to end it. Kept in `room_mutes`, one row a room, at most
   * MAX_ROOM_MUTES_PER_USER a user: a mute of another room past that first
   * deletes the user's mutes that ran out, and is `refused` if that frees
   * none. Whether it changed anything, and `untilMs`, the end it leaves,
   * absent when not muted. A mute that ran out is deleted with no change.
   */
  setRoomMute(input: { userId: string; roomId: string; untilMs: number | null; now?: number }): { changed: boolean; untilMs?: number; refused?: true };
  /**
   * The room mutes of a user that ran out by `now` (protocol §4.5), deleted
   * here, so each is told once: their rooms, and when the next of those left
   * runs out (absent when none is timed). One range of the user's rows, at
   * most MAX_ROOM_MUTES_PER_USER, and a delete of the expired ones.
   */
  expireRoomMutes(userId: string, now?: number): { expired: string[]; next?: number };
  /**
   * The `presence` toggle (as toggle has it) and when presence was last
   * turned on with it (META_PRESENCE_ON), if ever, in one statement: two
   * primary-key lookups of `_meta`, of which a missing row reads nothing.
   */
  presenceToggle(now?: number): { on: boolean | undefined; since?: number };
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
  statusInputs(userId: string, now?: number): StatusInputRecord;
}

/** The server's own metadata, custom emoji catalog and runtime feature toggles. */
export interface Server {
  /**
   * The server's `title`, `description` and `avatar` as admins set them with
   * `/server`, each absent while its deployment variable applies. Read once
   * after a wake (three primary-key lookups of `_meta`), then kept in memory.
   */
  metadata(now?: number): StoredServerMetadata;
  /**
   * Sets the server's `title` or `description` (`/server title <text>`,
   * `/server description <text>`), or with undefined clears it, so its
   * deployment variable applies again. The caller validates the value.
   */
  setText(field: "title" | "description", value: string | undefined, now?: number): void;
  /**
   * Clears the server's avatar (`/server avatar` alone), so `SERVER_AVATAR`
   * applies again: forgets its URL and releases its upload, whose R2 object
   * the caller deletes. Returns whether one was set.
   */
  clearAvatar(now?: number): { changed: boolean; deletedUploads: string[] };
  /**
   * The custom emoji catalog (extension `ext:emoji`): its `catalog_url` on
   * the media origin and its keys, or null while it is empty or uploads are
   * not configured. Read once after a wake (one row), then kept in memory.
   */
  emojiCatalog(now?: number): { url: string; keys: ReadonlySet<string> } | null;
  /**
   * The catalog an edit leads to, changing nothing, so the caller can
   * publish it to R2 before commitEmoji makes it current: with an added
   * key's entry (its image's `url`, and `width` and `height` where the
   * write found them), or without a removed one. Null when the edit cannot
   * apply: a write that is not an emoji's, failed, came too late or is not
   * an image, or a new key past `maxEmoji` (finishUpload then releases
   * it), or a removed key the catalog lacks.
   */
  emojiDraft(edit: EmojiEdit, now?: number): EmojiDraft | null;
  /**
   * Makes a draft's catalog current, in one transaction with the edit: an
   * added key's upload is done. The catalog before this one becomes the
   * previous (META_EMOJI_PREVIOUS), and the image an add replaces or a
   * remove removes is `superseded`: both stay for clients that just read
   * the previous `catalog_url`. The catalog before that, and the images
   * superseded with it, are released. Returns whether it applied (a draft
   * whose catalog changed meanwhile, or whose write is no longer
   * acceptable, does not), and the R2 objects the caller deletes.
   */
  commitEmoji(draft: EmojiDraft, now?: number): { applied: boolean; deletedUploads: string[] };
  /** An admin's `/toggle` of a feature, or undefined while it follows the deployment's default. */
  toggle(feature: string, now?: number): boolean | undefined;
  /**
   * Sets or, with undefined, clears an admin's `/toggle` of a feature. With
   * `uploads` off, new upload embeds and `/avatar` are `denied`; writes
   * already started still finish. With `since`, presence was turned on
   * then: it is kept too (META_PRESENCE_ON), in the same reservation.
   */
  setToggle(feature: string, on: boolean | undefined, now?: number, since?: number): void;
  /**
   * Starts the server's avatar upload (§3.1, §4.8.7): `/server avatar` with
   * one `upload` embed, by an admin. Kept like a custom emoji: the server's
   * (SERVER_OWNER), never expiring, an avatar in size, and counted against
   * the admin's and the server's daily uploads and the stored-bytes cap.
   * The avatar is set when the write finishes (finishUpload). A server
   * part, not an uploads one, as `/server avatar` is offered whether or not
   * uploads are configured: without them it is refused (`unsupported`),
   * once reserved, as any upload start is.
   */
  startAvatarUpload(input: { userId: string; now?: number }): PendingUpload;
}

/** Admission control: the per-IP and daily limits on sign-ins, guests, frames and connections, throttle trips and the attack pause. */
export interface Admission {
  /** Charges a sign-in or registration attempt to its IP's limit; `retry_after` past it. */
  reserveAuthAttempt(input: { ipKey: string; now: number }): void;
  /**
   * Durably reserve the next `count` guest numbers and return them as the
   * half-open range [first, limit). The stored high-water mark advances by
   * `count` in one write, so numbers handed out from the range are never
   * reissued, even after a restart, eviction, or hibernation wake loses the
   * caller's in-memory range: the next call reserves past it, leaving a gap.
   * Synchronous, like every Store call, so callers in one object cannot
   * interleave two reservations.
   */
  reserveGuestNumbers(count: number, now?: number): { first: number; limit: number };
  /** Charges processed frames to the daily ceiling and the IP's limit; `retry_after` past either. */
  reserveFrames(input: { ipKey: string; now: number; count?: number }): void;
  /** Charges a connection's admission to the daily ceiling and the IP's limit; `retry_after` past either. */
  reserveConnection(input: { ipKey: string; now: number }): void;
  /**
   * Advisory capacity check: no SQL, reservations, or durable clock updates,
   * but the ledger's write when recovering from a storage failure.
   */
  checkConnectionBudget(now?: number): void;
  /**
   * Counts one throttle trip (a long refusal a user ran into, told to them
   * once: ApronDemoServer.noteTrip) under `trigger`, in hourly buckets kept
   * for TRIP_WINDOW_MS. Charged but never refused: counting a refusal must
   * not itself be refused.
   */
  noteThrottleTrip(trigger: string, now?: number): void;
  /** Throttle trips by trigger over the last TRIP_WINDOW_MS (noteThrottleTrip), most first. */
  throttleTrips(now?: number): Array<[trigger: string, count: number]>;
  /**
   * The runtime's attack pause record (ApronDemoServer.pauseForAttack), or ""
   * before any. Read once as an instance starts, uncharged like the usage
   * snapshot, so a paused server's refusals cost no SQL.
   */
  attackPause(): string;
  /** Records an attack pause (attackPause): charged, never refused. */
  setAttackPause(value: string, now?: number): void;
}

/**
 * Metering for the runtime's own storage work outside SQLite (Durable
 * Object key-value storage): a bounded operation is reserved against the
 * day's budget before its first await, so a concurrent request cannot spend
 * the same allowance. KV work has no SQL cursor to reconcile; callers must
 * supply a conservative bound for the complete operation.
 */
export interface Meter {
  /** Reserves `cost` against the foreground budget (refused past it), then runs `fn`. */
  foreground<T>(cost: CostEstimate, fn: () => Promise<T>, now?: number): Promise<T>;
  /** Reserves `cost` against the maintenance budget (refused past it), then runs `fn`. */
  maintenance<T>(cost: CostEstimate, fn: () => Promise<T>, now?: number): Promise<T>;
}

/** Operations: accounting and its guard, budgets, the database's size, alerts and the operator flags kept in storage, and the hooks the runtime observes them by. */
export interface Ops {
  /** The configuration the store runs with: the deploy's limits, as asStoreConfig gave them, over the defaults. */
  readonly config: StoreConfig;
  /**
   * Called after each overrun, once the operation has unwound, so the
   * runtime can tell the operators and re-evaluate the server's tier.
   */
  onOverrun?: (notice: OverrunNotice) => void;
  /**
   * Called, synchronously, as accounting overruns, closes on a storage
   * failure or reopens, for a metric, with what happened where known; it
   * must not touch storage.
   */
  onAccounting?: (change: "overrun" | "uncertain" | "recovered", message?: string) => void;
  /**
   * The principals the operation running now acts for (`user:<id>`,
   * `ip:<key>`), from the runtime; none for the server's own work (alarms,
   * sweeps). Overruns are logged with them.
   */
  actor?: () => readonly string[] | undefined;
  /**
   * `uncertain`: a storage failure has not cleared yet, so work is refused.
   * `unsafe` is always false: nothing latches the server any more.
   */
  accountingStatus(): { unsafe: boolean; uncertain: boolean; database_bytes: number | null };
  /** What overruns have set off now, for the runtime's tier and `/status`. */
  accountingGuard(now?: number): { day: string; overruns: number; breakers: Record<string, number> };
  /** The Cloudflare account usage last persisted (account-usage.ts), or null. */
  accountUsageSnapshot(): AccountUsageSnapshot | null;
  /** Keeps the account usage snapshot, so a restart starts from it. */
  persistAccountUsageSnapshot(snapshot: AccountUsageSnapshot, now?: number): void;
  /**
   * `/status`'s figures: today's budget row, the registered users, the
   * database size, and the enforced daily counters (each `global` limiter
   * row's count today). An admin's view of why work is refused, so it is
   * charged but never refused (unchecked), even while the server is paused.
   */
  status(now?: number): { budget: BudgetSnapshot; identities: number; databaseBytes: number | null; counts: { frames: number; admissions: number; posts: number } };
  /**
   * Today's foreground SQL and frames as shares of their daily ceilings,
   * from the budget row this object holds in memory: no SQL, so the runtime
   * may ask on every event. Null before today's first reservation here.
   */
  budgetShares(now?: number): { day: string; reads: number; writes: number; frames: number } | null;
  /** The SQLite database's size in bytes, where the platform reports it. */
  databaseSize(): number | null;
  /**
   * Runs an operator alert's storage work (ApronDemoServer.notifyAdmins):
   * its reservations are charged but never refused, by an exhausted budget or
   * by closed accounting, so the operators still hear of the stop that closed
   * it. Mutations it makes should pass `system`.
   */
  alert<T>(fn: () => T): T;
  /** The server tier last announced to the admins (the runtime's record), or "" before any. */
  announcedTier(now?: number): string;
  /** Records the server tier just announced (announcedTier): charged, never refused. */
  setAnnouncedTier(value: string, now?: number): void;
  /**
   * Whether the admins have been told the database passed half its
   * high-water mark (ApronDemoServer.maybeAlertStorage). Read once as an
   * instance needs it, uncharged like attackPause.
   */
  storageAlerted(): boolean;
  /** Records whether that alert stands (storageAlerted): charged, never refused, written only when it flips. */
  setStorageAlerted(alerted: boolean, now?: number): void;
  /**
   * Whether the admins have been told the room notes total is full
   * (ApronDemoServer.maybeAlertRoomNotes). Read once as an instance needs
   * it, uncharged like storageAlerted.
   */
  roomNotesAlerted(): boolean;
  /** Records whether that alert stands (roomNotesAlerted): charged, never refused, written only when it flips. */
  setRoomNotesAlerted(alerted: boolean, now?: number): void;
  /**
   * What the last room_set's total check saw (checkRoomFieldsTotal), then
   * forgotten: the total of what rooms hold past roomMetadataMinBytes, with
   * this save's room, and on a refusal `full` with the public rooms holding
   * the most past it. Undefined when that save ran no check (it did not grow
   * its room past the minimum). Kept outside the transaction, which a
   * refusal rolls back, so the caller can tell the admins.
   */
  takeRoomNotesCheck(): RoomNotesCheck | undefined;
}

/** Schema setup and reset, the alarm, and the cleanup it runs. */
export interface Lifecycle {
  /** Initializes schema once. Calling this on every hibernation wake is safe. */
  initialize(): void;
  /** Whether stored data is from a schema that is not upgraded in place (resetStorage wipes it). */
  requiresReset(): boolean;
  /**
   * Wipe every SQLite table and key-value entry (chat, rooms, passkey
   * sessions, bot tokens, limiter windows) and initialize a fresh schema.
   * Used whenever the stored schema version differs from this code's, in
   * either direction; there is no data migration.
   *
   * Registered passkeys survive: up to MAX_CARRIED_PASSKEYS of the most
   * recently used are read before the wipe and written back, with their
   * identities (same `user_id`, name, and WebAuthn user handle) and their
   * `general` membership, so users sign in again with the passkey they have
   * rather than deleting it and registering anew. The rows the carry reads
   * and writes are charged to the day's maintenance reservation below, with their roles
   * (but `bot`, which no passkey holder has). Not their avatar, `ext` or
   * `seen` (`seen_ms` starts at 0, none recorded, so a carried user is
   * listed `offline` without `seen` until they next go offline). Older
   * passkeys past the cap, bots, and every session are dropped.
   *
   * The guest-number high-water mark is carried over, so a guest ID is never
   * reissued across a reset (a wipe does not restart guests at `guest_1`).
   * Besides those, only the current UTC day's resource reservations are carried
   * over, when the old schema's budget row is readable, so a deploy cannot replenish the
   * daily SQL allowance the platform has already metered. The fresh schema's
   * bootstrap reservation is added to that row without a capacity check, so
   * the reset itself can never fail on, or be blocked by, an exhausted budget;
   * an exhausted day simply stays exhausted until UTC midnight. The
   * overrun guard (breakers) is not carried. Callers must hold the object's input gate (the runtime uses
   * blockConcurrencyWhile) so no request observes the empty storage.
   */
  resetStorage(): Promise<void>;
  /** Sets the Durable Object's alarm to the earliest of cleanup, the store's own deadlines and `socketDeadline`. */
  scheduleAlarm(socketDeadline?: number, now?: number): Promise<void>;
  /**
   * The object's alarm fired. The runtime deletes it once the handler
   * returns, so the alarm this instance last set (scheduledAlarmAt, which
   * lets scheduleAlarm skip a call that would not move it) is no longer set:
   * forgotten here, on every alarm, so the next scheduleAlarm sets one.
   */
  alarmFired(): void;
  /** Whether a refusal at the storage watermark needs the alarm brought forward; clears the flag. */
  takeAlarmChange(): boolean;
  /** Whether a cleanup run is due now. */
  cleanupDue(now?: number): boolean;
  /**
   * With tiers below (`tiered`), records leave this SQLite only once the
   * next tier holds them (the history chain copies them and marks
   * META_HISTORY_THROUGH): the hot floor stops at the last copied, and the
   * job waits `copyWaitMs` (a second by default; the runtime lengthens it
   * while the tier fails) for the next copy. The published floor
   * (publishedFloor) stays where it was, below the hot floor, until the
   * chain raises it (publishHistoryFloor); rooms go when their whole log
   * is below it.
   */
  runCleanup(now?: number, options?: { copyWaitMs?: number }): StoreCleanupResult;
}

/** History: this store as the history chain's head and state, the ports exports and imports go through, and the history bookkeeping `/history` reads. */
export interface History {
  /**
   * This store as the history chain's head, named `name` (HistoryHead): its
   * records are made by commit, and trimmed by its own cleanup, below the
   * copy marker and on its own schedule.
   */
  head(name: string): HistoryHead;
  /** Where the history chain keeps its state (links, kept groups, the op log): this store's `_meta`. */
  state(): ChainStatePort;
  /** What an import writes through. */
  restore(): RestorePort;
  /** The rooms and users an export carries. */
  export(): ExportPort;
  /**
   * The records the hot log holds from the hot floor on, for `/status`:
   * counted up to RETAINED_SCAN_CAP (one index entry each, refunded past
   * what is found), and that cap and one more past it.
   */
  hotRecords(now?: number): number;
  /** The `/purge` and `/rename` some link has yet to deliver, oldest first. */
  rewrites(now?: number): QueuedRewrite[];
  /** A backup schedule's number in `_meta` (a key under `history:export:`), 0 when absent. */
  metaNumber(key: string, now?: number): number;
  /** Writes a backup schedule's value in `_meta` (a key under `history:export:`), or removes it for null. */
  setMeta(key: string, value: string | null, now?: number): void;
  /** The running import's journal (`history:import`, RestorePort.journal): what a retry needs to finish it. */
  importJournal(now?: number): string | undefined;
  /**
   * A cold tier's chunk index (ChunkIndex), in this SQLite: one row a chunk
   * in `history_chunks`, keyed by tier name and the chunk's first log ID,
   * created on first use. The rows are read once a wake (a chunk holds
   * about 10,000 log IDs, so they are few) and kept in memory (this object
   * is the only writer); each read and write is charged to maintenance.
   */
  chunkIndex(tier: string): ChunkIndex;
}

/** Web Push registrations, wakes and claims (protocol §4.9). Present only where push is configured. */
export interface Push {
  /**
   * `push_register` (protocol §4.9, kind `webpush`): keeps a registered
   * user's registration of the endpoint `url`, with its `push_id` and the
   * `wake` scopes it wakes for (a WAKE_SCOPES bitmask, DEFAULT_WAKE when not
   * given; `joined` is kept only for a user holding one of
   * JOINED_WAKE_ROLES, and dropped for anyone else, as a scope this server
   * does not offer them). Registrations are the user's own: registering a `url` the user
   * holds again replaces its keys, `push_id` (removing one now absent) and
   * scopes, and two
   * users may register the same `url`. A user past `subscriptionsPerUser`
   * loses the least recently registered of the others. Clients register on
   * every connection, so an unchanged registration (keys, `push_id`, scopes)
   * registered again within a day writes nothing; one not registered for
   * `pushExpiryDays` is skipped by wakes and deleted by cleanup.
   */
  register(input: { userId: string; url: string; p256dh: string; auth: string; pushId?: string; wake?: number; now?: number }): void;
  /** `push_unregister` (protocol §4.9): removes the user's own registration of `url`, if any. */
  remove(input: { userId: string; url: string; now?: number }): void;
  /**
   * The users who may wake for `joined` (§4.9.4): those with a live
   * registration that kept it (JOINED_WAKE_ROLES), most recently registered
   * first, at most MAX_PUSH_CANDIDATES. One range of
   * `push_subscriptions_joined_idx`, which only their registrations are in,
   * of at most `subscriptionsPerUser` rows a user; claimPushes checks each
   * one's role and membership again, as either may have changed since.
   */
  joinedWakers(now?: number): string[];
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
  claim(input: { senderId: string; roomId: string; candidates: readonly PushCandidate[]; allowed?: (url: string) => boolean; now?: number; alert?: boolean }): PushClaim;
  /**
   * Zeroes a user's `unread` (PUSH_UNREAD_SCOPE) when they come back: end
   * `idle`, move a read cursor, or send from a connection not idle (a
   * sign-in zeroes it with statusInputs).
   * One primary-key probe of their recipient counter, written only when it
   * held a count; the caller runs it only when a push counted it up since
   * the user was last back, so it seldom runs.
   */
  clearUnread(userId: string, now?: number): void;
  /**
   * Removes all of a user's push registrations, when what they signed in
   * with is revoked (`/passkeys remove`, a bot's new token): a device that
   * held it should not keep getting their messages.
   */
  clearSubscriptions(userId: string, now?: number): void;
  /**
   * Forgets the registrations whose push service said they are gone (404
   * or 410): each the user's registration of the endpoint, if it still has
   * the keys that were pushed to, so a fresh registration of it stays.
   * Other users' registrations of the same endpoint are left to their own
   * pushes and to expiry.
   */
  forgetSubscriptions(gone: ReadonlyArray<{ userId: string; url: string; p256dh: string }>, now?: number): void;
  /**
   * A message as it is now, for a push held until its user went idle
   * (protocol §4.9): null when unknown or expired. One metered lookup.
   */
  message(messageId: string, now?: number): MessageSnapshot | null;
  /** Pushes sent today, for `/status`. */
  sentToday(now?: number): number;
}

/** Uploads held in R2: pending writes, their completion and expiry, and avatars (protocol §4.8.3, §4.8.7). Present only where uploads are configured. */
export interface Uploads {
  /** A new R2 key for a terminal's output, an attached file's kind (the runtime writes it to MEDIA). */
  terminalOutputKey(): string;
  /**
   * Starts an avatar upload (protocol §4.8.7): `/avatar` with one `upload`
   * embed. The avatar is set when the write finishes (finishUpload).
   */
  startAvatar(input: { userId: string; now?: number }): PendingUpload;
  /**
   * Starts a custom emoji upload (extension `ext:emoji`): `/emoji add
   * :name:` with one `upload` embed, by a holder of one of EMOJI_ROLES. The
   * upload row keeps the key in `message_id`, and is the server's
   * (EMOJI_OWNER); it counts
   * against the user's and the server's daily uploads and the stored-bytes
   * cap like any other. The catalog changes when the write finishes
   * (emojiDraft, commitEmoji). A new key past `maxEmoji` is `denied`.
   */
  startEmoji(input: { userId: string; key: string; now?: number }): PendingUpload;
  /** Who owns an upload (`owner_id`: a user, or SERVER_OWNER or EMOJI_OWNER), or undefined for an unknown key: one row by primary key. */
  owner(key: string, now?: number): string | undefined;
  /** Records a finished (or failed) R2 write of a pending upload, and what it publishes. */
  finish(write: UploadWrite, now?: number): UploadFinish;
  /**
   * Claims a pending upload's write for the one request that arrived in its
   * window, before any byte reaches R2: a `write_url` used again is refused,
   * so it cannot overwrite a finished upload. The claim is charged to the
   * server's daily upload count (`uploadsPerDay`); past it, `"closed"`, and
   * the upload stays pending until it is written after the daily reset or
   * its window closes.
   */
  claim(key: string, now?: number): boolean | "closed";
  /**
   * Fails pending uploads whose write never came (protocol §4.8.3): their
   * messages get a snapshot without the embed. Maintenance work, a bounded
   * batch per call; `next` is when the next one falls due.
   */
  expirePending(now?: number): { broadcasts: Broadcast[]; deletedUploads: string[]; next?: number };
  /**
   * When the earliest pending upload's write runs out, grace included, or
   * undefined with none pending: one indexed read, for an alarm that woke
   * without knowing (ApronDemoServer.alarmWorkDue).
   */
  nextDeadline(now?: number): number | undefined;
  /**
   * Forgets uploads past their expiry plus the lifecycle lag, freeing their
   * bytes, and returns their keys for the caller to delete from R2 (a
   * bucket lifecycle rule may already have); an expired avatar leaves its
   * owner. Maintenance work, a bounded batch per call.
   *
   * An attached file's expiry is fixed when it is uploaded, so a longer
   * `fileRetentionSeconds` would not reach files uploaded before it: their
   * messages would outlive them. A written file that the current setting
   * still keeps, and whose message is still kept, is given that expiry
   * instead of being forgotten. Retention cleanup removes a message without
   * releasing its uploads, so a file whose message is gone is not kept on.
   */
  cleanup(now?: number): { count: number; deleted: string[] };
  /**
   * A user's avatar key when it is due to be written again: live, and within
   * `avatarRefreshSeconds` of its expiry.
   */
  avatarRefreshDue(userId: string, now?: number): string | null;
  /** Restarts an avatar's expiry after its object was written again. */
  renewAvatar(input: { userId: string; key: string; now?: number }): void;
  /** Removes a user's avatar (`me` with `avatar: ""`, §3.3); returns whether one was set and the keys to delete. */
  clearAvatar(input: { userId: string; now?: number }): { changed: boolean; deletedUploads: string[] };
}

/** Live text (protocol §4.8.3): open texts, their start, claim, finish and expiry. Present only where a live text policy is configured. */
export interface LiveText {
  /**
   * The open live texts: one `_meta` row read the first time after a wake,
   * then from memory, since every change goes through this instance
   * (liveCache), so a reader's `GET` of an ended text costs no SQL.
   */
  open(now?: number): LiveEntry[];
  /**
   * `/embed-terminal [<title>]` and `/embed-append [<markdown>]`: a live text
   * whose message is posted when its write arrives (claimLiveText), from
   * `userId`, in `roomId`, replying to `replyTo`. Everything is checked and
   * charged now, its post included (the posting limits), so the write
   * cannot be refused for them later.
   */
  start(input: { userId: string; ipKey: string; identity: Identity; kind: LiveKind; roomId: string; title?: string; text?: string; replyTo?: string; now?: number }): LiveEntry;
  /**
   * The write of a live text arrived (§4.8.3): a pending one within its
   * window starts streaming, once. A command's message is posted now, with
   * the embed's `url`; a message's is republished with it (§4.8.5). Null
   * when the write cannot start: unknown, used, or expired. A command's
   * message that can no longer be posted (its room or reply gone) throws,
   * and its text is forgotten.
   */
  claim(key: string, now?: number): { entry: LiveEntry; broadcasts: Broadcast[]; message?: MessageSnapshot } | null;
  /**
   * Ends a live text exactly once (§4.8.3) and publishes what it kept: a
   * terminal's message gets its embed with `output` (§4.8.6), and an
   * append's the kept text, after its edits, appended to `body.text` and
   * its embed removed (§4.8.5); with nothing kept, the embed is removed (a
   * message left with nothing is a tombstone). A text already ended, or whose message or
   * embed is gone, publishes nothing. Finishing work already admitted, it is
   * charged as maintenance, so an exhausted foreground budget cannot lose it.
   */
  finish(key: string, kept: Uint8Array | null, now?: number, stored?: TerminalStored): LiveFinish;
  /**
   * Ends the live texts that fell due: a write that never came by its
   * window's end (its message, if posted, loses the embed), and a text
   * marked streaming that `streaming` (the runtime's own) does not hold:
   * the object that streamed it was evicted or redeployed and its bytes are
   * gone, so its embed is removed. Maintenance work, bounded by twice
   * `concurrent` entries (startLiveText), which its reservation covers; `next` is when the next one falls due.
   */
  expire(streaming: ReadonlySet<string>, now?: number): { broadcasts: Broadcast[]; ended: LiveEntry[]; next?: number };
}

/**
 * The store, as code outside src/store sees it: its parts. `push`,
 * `uploads` and `liveText` are present only where the deploy configures
 * them (openStore); the others always are.
 */
export interface Store {
  readonly accounts: Accounts;
  readonly credentials: Credentials;
  readonly rooms: Rooms;
  readonly messages: Messages;
  readonly reads: Reads;
  readonly server: Server;
  readonly admission: Admission;
  readonly meter: Meter;
  readonly ops: Ops;
  readonly lifecycle: Lifecycle;
  readonly history: History;
  /** Present where push is configured (VAPID keys and the plan's PUSH_POLICY). */
  readonly push?: Push;
  /** Present where uploads are configured (MEDIA, its origins, the signing key and the plan's UPLOAD_POLICY). */
  readonly uploads?: Uploads;
  /** Present where live text is configured (the plan's LIVE_TEXT_POLICY and the deployment's origin and key). */
  readonly liveText?: LiveText;
}
