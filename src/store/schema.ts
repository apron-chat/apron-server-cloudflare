/** The SQLite schema: its version, DDL and upgrade tables, and the SQL fragments queries share. */

import { BOT_PREFIX } from "./limits";
import { WAKE_SCOPES } from "../domain";

/**
 * Schema 11 stores the server-wide log (room records, flat message
 * snapshots, reaction sets, and registered users' memberships), a
 * `memberships` table of registered users' joined rooms, indexed both ways,
 * with each room's count of them, the `uploads` held in R2 with each
 * identity's avatar, each identity's roles, `ext` and `seen` in its row, and
 * the `push_subscriptions`, `push_wakes`, `user_status`, `room_mutes` and
 * `read_cursors` tables, with each limiter row's token bucket (limiter.ts)
 * and each day's count of history pages (SCHEMA_DDL). Schemas 9, 8 and 7
 * are upgraded in place (see upgradeFromSchema9(), upgradeFromSchema8() and
 * upgradeFromSchema7()); stored data from any other schema version is not
 * migrated: the object is wiped and started fresh (see resetStorage()). An
 * absent `_meta` row reads as its initial value, so adding one needs no new
 * version. A schema 9 object from code before the identities' `seen_ms`
 * column gains it before its upgrade (ensureSeenColumn()); one from code
 * before `push_subscriptions_joined_idx` gains that with the rebuild.
 */
export const SCHEMA_VERSION = 11;
/** The oldest schema upgraded in place rather than reset; each one from it up to SCHEMA_VERSION is. */
export const UPGRADABLE_SCHEMA_VERSION = 7;
/**
 * SQL conditions on `room_id` for the private rooms, one range of the key's
 * index, and the public ones, the ranges either side of it. A public scan
 * reads no private row, so it stays within the thread ceiling it was
 * calibrated for, and a private one within the private ceiling.
 */
export const privateRange = (column: string) => `${column} >= 'private_' AND ${column} < 'private\`'`;
const PRIVATE_ROOMS = privateRange("room_id");
export const PUBLIC_ROOMS = "(room_id < 'private_' OR room_id >= 'private`')";
/**
 * Each room's kind, as an expression the rooms table is indexed by
 * (ROOM_INDEX_DDL): 0 a top-level public room (`general` included), 1 a
 * thread, 2 a private room. Rooms are kept until their whole log has left
 * every tier, which with a cold tier that keeps everything is never, so
 * nothing that counts or lists rooms may scan a whole range of the table's
 * key. With the creation log ID, the index makes each kind's rooms created
 * within roomCreationWindowMs one range (recentRoomCount: what the caps
 * count); with the head, each kind's most recently active rooms one range
 * (listedRoomRows). Queries must spell the expression exactly so (roomKind)
 * for SQLite's planner to use the indexes; they name no INDEXED BY, so they
 * still run where these are not yet made.
 */
const ROOM_KIND = "(CASE WHEN room_id >= 'private_' AND room_id < 'private`' THEN 2 WHEN parent_room_id IS NULL THEN 0 ELSE 1 END)";
export const roomKind = (kind: 0 | 1 | 2) => `${ROOM_KIND} = ${kind}`;
/**
 * The rooms table's indexes by kind (ROOM_KIND): by head, for listings, and
 * by creation, for the caps. Additive: made by SCHEMA_DDL in a new object
 * and by the first cleanup of an older one (ensureRoomKindIndexes).
 */
const ROOM_HEAD_INDEX = "rooms_kind_head_idx";
const ROOM_CREATED_INDEX = "rooms_kind_created_idx";
export const ROOM_INDEX_DDL = [
  `CREATE INDEX IF NOT EXISTS ${ROOM_HEAD_INDEX} ON rooms (${ROOM_KIND}, latest_log_id)`,
  `CREATE INDEX IF NOT EXISTS ${ROOM_CREATED_INDEX} ON rooms (${ROOM_KIND}, created_log_id)`,
];

export const ROOM_COLUMNS = "room_id, parent_room_id, created_log_id, record_log_id, latest_log_id, fields_json, created_ms, updated_ms, member_count";
/**
 * An account's last activity, as SQL over `identities` row `alias`: its
 * creation, profile changes and sign-ins (`updated_ms`, noteActive), its
 * last departure (`seen_ms`), a passkey's last use, and its bot's last
 * activity (`updated_ms` of `bot_<user_id>`; a signed-out bot's is 0).
 */
export function lastActiveSql(alias: string): string {
  return `MAX(${alias}.created_ms, ${alias}.updated_ms, ${alias}.seen_ms,
    COALESCE((SELECT MAX(c.updated_ms) FROM credentials c INDEXED BY credentials_user_idx WHERE c.user_id = ${alias}.user_id), 0),
    COALESCE((SELECT b.updated_ms FROM identities b WHERE b.user_id = '${BOT_PREFIX}' || ${alias}.user_id), 0))`;
}
/** The tables a member listing reads (Store.roomMembers); a write to one invalidates reused listings. */
export const MEMBER_TABLES = /\b(identities|memberships|user_status)\b/;
/** Store.ensureSeenColumn's probe: reads no row, and fails to compile where `seen_ms` is missing. */
export const SEEN_COLUMN_PROBE = "SELECT seen_ms FROM identities LIMIT 0";
/** Registrations that keep `joined`, the partial index's condition (push_subscriptions_joined_idx), spelled once so every query matches it. */
export const JOINED_WAKE_CONDITION = `(wake & ${WAKE_SCOPES.joined}) != 0`;

/**
 * Webhook registrations (protocol §4.9.4, push kind `webhook`; webhooks.ts),
 * keyed by user and endpoint, with each one's `endpoint_id`, the server
 * address its calls name, its scopes, format, state and last error. At most
 * WEBHOOK_LIMITS.perServer rows, all read at once, so no index. Additive,
 * without a new schema version (a rollback to code without it keeps every
 * other table, and ignores this one): in SCHEMA_DDL for a new object, and
 * made by the first use of an older one (WebhooksModule.ensureTable).
 */
export const WEBHOOKS_DDL = `CREATE TABLE IF NOT EXISTS webhooks (
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    server TEXT NOT NULL,
    wake INTEGER NOT NULL,
    format TEXT NOT NULL,
    state TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    failures INTEGER NOT NULL DEFAULT 0,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, url)
  ) WITHOUT ROWID`;

/** The indexes of schema 9's tables that schema 10 rebuilds (upgradeFromSchema9), dropped before the rebuild creates its own. */
export const SCHEMA_9_INDEXES = [
  "records_log_idx", "records_retention_idx", "message_state_latest_idx", "reaction_state_log_idx",
  "uploads_owner_idx", "uploads_expiry_idx", "uploads_pending_idx", "uploads_message_idx", "memberships_user_idx",
  "credentials_user_idx", "push_subscriptions_user_idx", "push_subscriptions_updated_idx", "push_subscriptions_waking_idx",
  "push_subscriptions_joined_idx", "push_wakes_woken_idx", "accepted_requests_expiry_idx", "principal_limits_updated_idx",
];

/** The indexes of schema 10 that schema 11 drops (upgradeFromSchema10): no query reads them any more. */
export const SCHEMA_10_DROPPED_INDEXES = ["message_state_latest_idx", "reaction_state_log_idx", "push_subscriptions_user_idx", "push_subscriptions_waking_idx"];

/** Each table schema 10 rebuilds as `WITHOUT ROWID` (upgradeFromSchema9), with the columns its rows keep in the current schema. */
export const SCHEMA_10_COPIED_COLUMNS: Record<string, readonly string[]> = {
  _meta: ["key", "value"],
  rooms: ["room_id", "parent_room_id", "created_log_id", "record_log_id", "latest_log_id", "fields_json", "created_ms", "updated_ms", "member_count"],
  records: ["room_id", "log_id", "commit_ms", "kind", "record_json"],
  message_state: ["message_id", "room_id", "latest_log_id", "author_id"],
  reaction_state: ["message_id", "user_id", "log_id", "from_json", "emojis_json"],
  identities: ["user_id", "user_handle", "name", "tier", "created_ms", "updated_ms", "avatar_url", "avatar_expires_ms", "roles_json", "ext_json", "seen_ms"],
  uploads: ["upload_key", "owner_id", "purpose", "message_id", "embed_id", "state", "bytes", "write_expires_ms", "expires_ms", "created_ms"],
  memberships: ["room_id", "user_id"],
  credentials: ["credential_id", "user_id", "public_key_json", "sign_count", "transports_json", "created_ms", "updated_ms"],
  push_subscriptions: ["user_id", "url", "p256dh", "auth", "push_id", "wake", "created_ms", "updated_ms"],
  push_wakes: ["user_id", "room_id", "woken_ms"],
  user_status: ["user_id", "status", "mute_until_ms"],
  room_mutes: ["user_id", "room_id", "mute_until_ms"],
  accepted_requests: ["user_id", "request_id", "digest", "result_json", "transition_json", "expires_ms"],
  resource_budgets: ["day", "reads_reserved", "writes_reserved", "frames_reserved", "admissions_reserved", "posts_reserved", "registrations_reserved", "history_reserved", "effective_ms", "foreground_reads", "foreground_writes", "maintenance_reads", "maintenance_writes"],
  principal_limits: ["scope", "principal_key", "level", "level_ms", "day", "posts_day", "registrations_day", "uploads_day", "updated_ms"],
};

/**
 * Schema 8: the server-wide log with membership records, and each registered
 * identity's joined rooms as `memberships` rows, by room (the primary key, for
 * member listings) and by user (for a user's rooms), counted in each room's
 * `member_count`. Guests' memberships live in their connection only, like the
 * guest identity itself, and are not logged. `uploads` lists the objects
 * written to R2 (protocol §4.8.3): attached files by message and embed, and
 * avatars, by owner, expiry, and pending write. `push_subscriptions` holds
 * registered users' Web Push registrations (protocol §4.9), keyed by user
 * and endpoint, indexed by user and registration time and by registration
 * time (for expiry), and by user and registration time for those that wake
 * for messages (a partial index, so a wake reads only those). `push_wakes`
 * keeps when each user was last woken for each room, for coalescing.
 * `user_status` keeps each registered user's `status` state (protocol
 * §4.5): the `status` they chose with `me` and until when their unscoped
 * mute lasts, one row while either differs from the default (`online`, not
 * muted). `room_mutes` keeps their room mutes, keyed by user and room, at
 * most MAX_ROOM_MUTES_PER_USER a user. Each identity's `seen_ms` (protocol
 * §4.5.2 `seen`, 0 for none) is when the status others see of the user last
 * became `offline`, in the row a member listing reads anyway; it is the
 * last column, added to an older schema 9 object without a new version
 * (ensureSeenColumn()).
 *
 * Schema 10 (upgradeFromSchema9): every table keyed by text or by more than
 * one column is `WITHOUT ROWID`, so its key is the table rather than a
 * second index each insert writes. `records` is indexed by `log_id` only:
 * commit times follow log order, so retention walks that index.
 * `message_state` points at each message's latest record rather than
 * holding a copy of it. `log_state` is written by retention only; each
 * commit's head is the newest record, which `logState()` reads and keeps.
 * `read_cursors` keeps each registered user's `read_message_id` (protocol
 * §4.6) for each room they joined, keyed by user and room, at most one a
 * membership (saveReadCursors), deleted with it.
 *
 * Schema 11 (upgradeFromSchema10): message and reaction state is deleted
 * with the record it points at, so neither table is indexed by log ID; a
 * user's push registrations are their primary-key range, so only expiry
 * and the moderators' `joined` registrations are indexed; and uploads no
 * longer keep their content type, which nothing read.
 */
export const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS log_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_log_id INTEGER NOT NULL,
    history_floor INTEGER NOT NULL,
    last_commit_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    room_id TEXT PRIMARY KEY,
    parent_room_id TEXT,
    created_log_id INTEGER NOT NULL,
    record_log_id INTEGER NOT NULL,
    latest_log_id INTEGER NOT NULL,
    fields_json TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    member_count INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  ${ROOM_INDEX_DDL.join(";\n  ")};
  CREATE TABLE IF NOT EXISTS records (
    room_id TEXT NOT NULL,
    log_id INTEGER NOT NULL,
    commit_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (room_id, log_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS records_log_idx ON records (log_id);
  CREATE TABLE IF NOT EXISTS message_state (
    message_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    latest_log_id INTEGER NOT NULL,
    author_id TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS reaction_state (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    log_id INTEGER NOT NULL,
    from_json TEXT NOT NULL,
    emojis_json TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS identities (
    user_id TEXT PRIMARY KEY,
    user_handle TEXT NOT NULL,
    name TEXT NOT NULL,
    tier TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    avatar_url TEXT NOT NULL DEFAULT '',
    avatar_expires_ms INTEGER NOT NULL DEFAULT 0,
    roles_json TEXT NOT NULL DEFAULT '[]',
    ext_json TEXT NOT NULL DEFAULT '',
    seen_ms INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS uploads (
    upload_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    message_id TEXT,
    embed_id TEXT,
    state TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    write_expires_ms INTEGER NOT NULL,
    expires_ms INTEGER NOT NULL,
    created_ms INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS uploads_owner_idx ON uploads (owner_id);
  CREATE INDEX IF NOT EXISTS uploads_expiry_idx ON uploads (expires_ms);
  CREATE INDEX IF NOT EXISTS uploads_pending_idx ON uploads (state, write_expires_ms);
  CREATE INDEX IF NOT EXISTS uploads_message_idx ON uploads (message_id);
  CREATE TABLE IF NOT EXISTS memberships (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);
  CREATE TABLE IF NOT EXISTS read_cursors (
    user_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS credentials (
    credential_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    public_key_json TEXT NOT NULL,
    sign_count INTEGER NOT NULL,
    transports_json TEXT,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS credentials_user_idx ON credentials (user_id);
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    push_id TEXT,
    wake INTEGER NOT NULL DEFAULT 3,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, url)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS push_subscriptions_updated_idx ON push_subscriptions (updated_ms);
  CREATE INDEX IF NOT EXISTS push_subscriptions_joined_idx ON push_subscriptions (updated_ms, user_id) WHERE ${JOINED_WAKE_CONDITION};
  CREATE TABLE IF NOT EXISTS push_wakes (
    user_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    woken_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS push_wakes_woken_idx ON push_wakes (woken_ms);
  ${WEBHOOKS_DDL};
  CREATE TABLE IF NOT EXISTS user_status (
    user_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'online',
    mute_until_ms INTEGER
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS room_mutes (
    user_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    mute_until_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS accepted_requests (
    user_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    result_json TEXT NOT NULL,
    transition_json TEXT,
    expires_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, request_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS accepted_requests_expiry_idx
    ON accepted_requests (expires_ms);
  CREATE TABLE IF NOT EXISTS resource_budgets (
    day TEXT PRIMARY KEY,
    reads_reserved INTEGER NOT NULL DEFAULT 0,
    writes_reserved INTEGER NOT NULL DEFAULT 0,
    frames_reserved INTEGER NOT NULL DEFAULT 0,
    admissions_reserved INTEGER NOT NULL DEFAULT 0,
    posts_reserved INTEGER NOT NULL DEFAULT 0,
    registrations_reserved INTEGER NOT NULL DEFAULT 0,
    history_reserved INTEGER NOT NULL DEFAULT 0,
    effective_ms INTEGER NOT NULL DEFAULT 0,
    foreground_reads INTEGER NOT NULL DEFAULT 0,
    foreground_writes INTEGER NOT NULL DEFAULT 0,
    maintenance_reads INTEGER NOT NULL DEFAULT 0,
    maintenance_writes INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS principal_limits (
    scope TEXT NOT NULL,
    principal_key TEXT NOT NULL,
    level REAL NOT NULL DEFAULT 0,
    level_ms INTEGER NOT NULL DEFAULT 0,
    day TEXT NOT NULL,
    posts_day INTEGER NOT NULL DEFAULT 0,
    registrations_day INTEGER NOT NULL DEFAULT 0,
    uploads_day INTEGER NOT NULL DEFAULT 0,
    updated_ms INTEGER NOT NULL,
    PRIMARY KEY (scope, principal_key)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS principal_limits_updated_idx
    ON principal_limits (updated_ms);
  CREATE TABLE IF NOT EXISTS maintenance (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_cleanup_ms INTEGER NOT NULL,
    cleanup_cutoff_ms INTEGER,
    cleanup_cursor INTEGER,
    schema_version INTEGER NOT NULL
  );
`;

/**
 * The module that owns each table: the one file in src/store whose SQL may
 * name it (besides this one's DDL), checked by
 * test/store/table-ownership.test.ts, which lists the few exceptions.
 * sqlite-store.ts owns the log and the core's tables: it is the commit
 * path, accounting, schema and cleanup.
 */
export const TABLE_OWNERS: Readonly<Record<string, string>> = {
  _meta: "sqlite-store.ts",
  accepted_requests: "sqlite-store.ts",
  credentials: "sqlite-store.ts",
  identities: "sqlite-store.ts",
  log_state: "sqlite-store.ts",
  maintenance: "sqlite-store.ts",
  memberships: "sqlite-store.ts",
  message_state: "sqlite-store.ts",
  principal_limits: "sqlite-store.ts",
  reaction_state: "sqlite-store.ts",
  records: "sqlite-store.ts",
  resource_budgets: "sqlite-store.ts",
  rooms: "sqlite-store.ts",
  push_subscriptions: "push.ts",
  push_wakes: "push.ts",
  webhooks: "webhooks.ts",
  read_cursors: "reads.ts",
  room_mutes: "reads.ts",
  user_status: "reads.ts",
  uploads: "uploads.ts",
  history_chunks: "history-log.ts",
};
