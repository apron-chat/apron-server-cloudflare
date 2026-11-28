/** Keys of the `_meta` table, and the owners and scopes stored rows are named by. */



/** `_meta` key: the open live texts, a JSON array of LiveEntry, absent while there are none. */
export const META_LIVE_TEXTS = "live_texts";

export const META_EFFECTIVE_NOW = "effective_now_ms";
/**
 * Removed thread rooms whose membership rows cleanup has yet to purge, as a
 * JSON array. A room leaves the `rooms` table at once and its members are
 * purged in bounded batches; membership reads join `rooms`, so they never
 * see a purged room's rows.
 */
export const META_PURGE_ROOMS = "purge_rooms";
/**
 * `_meta` keys of the history chain (src/history/), all `history:`:
 * the published floor, below the hot floor while lower tiers hold the
 * records between them; the newest log ID the next tier holds a copy of
 * (cleanup's ceiling); a flag that the published floor rose and rooms may
 * have gone with it; the `/purge` and `/rename` the links have yet to
 * deliver down the chain, with the last number given; and each lower
 * tier's and each link's state.
 */
export const META_HISTORY_PUBLISHED = "history:published";
export const META_HISTORY_THROUGH = "history:head:through";
export const META_HISTORY_ROOMS_DUE = "history:rooms_due";
export const META_HISTORY_OPS = "history:ops";
export const META_HISTORY_OPS_SEQ = "history:ops_seq";
export const META_HISTORY_TIER = "history:tier:";
export const META_HISTORY_LINK = "history:link:";
/** `_meta` key prefix: the rewrites a tier that takes none keeps (src/history/state.ts, KeptRewrite). */
export const META_HISTORY_KEPT = "history:kept:";
/** Backups' schedule state (historyMetaNumber, setHistoryMeta), kept when tiers are off. */
export const META_HISTORY_EXPORT = "history:export:";
/** The running import's journal: its archive, user mapping and rooms still to finish (importArchive). */
export const META_HISTORY_IMPORT = "history:import";
/** How far the running import's writes got: the line of the archive to go on from (importArchive). */
export const META_HISTORY_IMPORT_PROGRESS = "history:import_progress";
export const META_ACCOUNTING_UNSAFE = "accounting_unsafe";
/**
 * Overruns are observed, not fatal (noteOverrun): this one `_meta` row holds
 * what they have set off. The UTC day and its overrun count, so the first of
 * a day is told; each operation's recent overruns, and its breaker's end.
 */
export const META_ACCOUNTING_GUARD = "accounting_guard";
/**
 * Storage pressure (ensureGrowthCapacity): `1` from when occupied storage
 * reaches the high-water mark until it falls to the low-water mark, during
 * which every growing operation is refused; `0` or absent otherwise.
 */
export const META_STORAGE_PRESSURE = "storage_pressure";
/** Throttle trips by trigger in hourly buckets over the last TRIP_WINDOW_MS (noteThrottleTrip). */
export const META_THROTTLE_TRIPS = "throttle_trips";
/** The server tier the runtime last announced to the admins (announcedTier). */
export const META_ANNOUNCED_TIER = "announced_tier";
/** Idle accounts pruned: today's count and the total (idlePruned). */
export const META_IDLE_PRUNED = "idle_pruned";
/**
 * Since when every kind of activity the idle prune reads has been recorded
 * (sign-ins, by noteActive, came with it): nothing is pruned until that is
 * `idleAccountMs` ago, so an account active before then by a way that left
 * no record (a session resume, a token, while invisible) is never taken for
 * idle. Absent before the first prune asks.
 */
export const META_IDLE_ACTIVITY_SINCE = "idle_activity_since";
/** Today's idle prune runs, and whether the day's prune is done (pruneIdleIdentities). */
export const META_IDLE_PRUNE_DAY = "idle_prune_day";
/** The runtime's attack pause: its UTC day, count that day, hold end, and why (attackPause). */
export const META_ATTACK_PAUSE = "attack_pause";
/** "1" while the admins have been told the database passed half its high-water mark (ApronDemoServer.maybeAlertStorage). */
export const META_STORAGE_ALERTED = "storage_alerted";
/** "1" while the admins have been told the room notes total is full (ApronDemoServer.maybeAlertRoomNotes). */
export const META_ROOM_NOTES_ALERTED = "room_notes_alerted";
export const META_ACCOUNT_USAGE = "account_usage_snapshot";
/** The highest guest number ever reserved (see reserveGuestNumbers); absent means none. */
export const META_GUEST_NUMBER_MARK = "guest_number_mark";

/**
 * `_meta` key prefix recording a `/rename`: `renamed:<old user_id>` holds the
 * new one, so the retired `user_id` is never reissued (protocol §3.3).
 */
export const META_RENAMED_PREFIX = "renamed:";
/**
 * `_meta` key prefix recording a `/purge` or an idle prune: `purged:<user_id>`
 * retires the id, so a passkey session still held for it (sessions are
 * found by token, not by user) can never sign in as a later user given it.
 * Its value is the log head when it was retired, raised when a move or an
 * editor's save logs the account's content again (noteRetiredRelog): the
 * id is freed once history has expired past it (dueRetiredUserIds).
 */
export const META_PURGED_PREFIX = "purged:";
/**
 * `_meta` key prefix recording that `/purge` removed a user and what they
 * left: `removed:<user_id>` holds the log head then. Nothing is logged under
 * the id again, so another `/purge` of it only announces the removal again,
 * and a client resuming from a position before it is told (src/index.ts).
 * Freed with its `purged:` marker (freeRetiredUserIds).
 */
export const META_REMOVED_PREFIX = "removed:";
/**
 * `_meta` key prefix of the newest removals by position, for a resuming
 * `room_list`: `removed_at:<log position, 16 digits>:<user_id>`, empty, at
 * most REMOVED_RING of them. Dropping an older one raises META_REMOVED_FLOOR.
 */
export const META_REMOVED_AT_PREFIX = "removed_at:";
/** `_meta` key: the position of the newest removal dropped from `removed_at:`; absent while none was. */
export const META_REMOVED_FLOOR = "removed_floor";
/** `_meta` key: when the daily idle bot sweep (idleBots) is next due. */
export const META_BOT_SWEEP = "bot_sweep_ms";

/** The limiter scopes keyed by a registered user (`user:<user_id>`), which `/rename` moves. */
export const USER_LIMIT_SCOPES = ["post", "history", "upload", "push", "push_recipient", "push_joined_recipient"] as const;
/**
 * `_meta` key prefix for an admin's `/toggle`: `toggle:<feature>` holds `on`
 * or `off`, and is absent while the feature follows the deployment's default.
 */
export const META_TOGGLE_PREFIX = "toggle:";
/**
 * `_meta` key: when an admin last turned presence on with `/toggle`
 * (epoch milliseconds), when the status others see of every user changed
 * from `""` and so, for each user then shown `offline`, when that began
 * (protocol §4.5.2 `seen`; see ApronDemoServer.seenFloor). Written once per
 * toggle; code before it ignores the row.
 */
export const META_PRESENCE_ON = "presence_on_ms";
/** Bytes all live uploads hold, pending writes at their largest (see startUpload). */
export const META_UPLOAD_BYTES = "upload_bytes";
/**
 * `_meta` key: the custom emoji catalog (extension `ext:emoji`), the JSON
 * object exactly as published, absent while it is empty. Its R2 key, and
 * so `catalog_url`, is `e/c/<SHA-256 of the JSON>.json` (emojiObjectKey).
 */
export const META_EMOJI_CATALOG = "emoji_catalog";
/**
 * `_meta` key: the R2 key of the catalog the current one replaced, kept so
 * that clients that just read the old `catalog_url` can still fetch it, and
 * deleted at the next change. The images only it refers to are kept as long
 * (upload state `superseded`).
 */
export const META_EMOJI_PREVIOUS = "emoji_catalog_previous";
/**
 * The owner of custom emoji uploads: the server, not the admin who added
 * one, so `/purge` and `/rename` of that admin leave the catalog alone. No
 * user can hold an id starting with `~`.
 */
export const EMOJI_OWNER = "~emoji";
/**
 * The owner of the server's avatar upload (`/server avatar`), for the same
 * reason: it stays across `/purge` and `/rename` of the admin who set it.
 */
export const SERVER_OWNER = "~server";
/**
 * `_meta` key prefix for the server's `title`, `description` and `avatar`
 * (§3.1) as admins set them with `/server`: `server:<field>` holds the value
 * (the avatar's URL on the media origin), absent while the deployment
 * variable applies. Code before it ignores the rows.
 */
export const META_SERVER_PREFIX = "server:";
export const SERVER_FIELDS = ["title", "description", "avatar"] as const;
/**
 * Where a user's `unread` (protocol §4.9.3) is kept: the `uploads_day` of
 * their `push_recipient` counter, which every push claimed for them reads
 * and writes anyway, so counting costs a claim no row. It counts the
 * pushes claimed for them since they were last back (Store.clearPushUnread):
 * each for a message from someone else that came while nobody attended them,
 * so it never counts more messages than they have not seen, and is often
 * fewer: a message coalesced away, or pushed for `joined` alone, counts
 * none, and held wakes released together count one. Only the current UTC
 * day's count stands, as with the counter's own (cleanup deletes the row
 * after it).
 */
export const PUSH_UNREAD_SCOPE = "push_recipient";
