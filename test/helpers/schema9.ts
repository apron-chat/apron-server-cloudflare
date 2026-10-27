/**
 * Schema 9 as code before schema 10 created it (src/store.ts at the last
 * schema 9 release, verbatim): rowid tables, each text or composite key a
 * separate index, `records` indexed by commit time too, and `message_state`
 * holding each message's latest snapshot.
 */
export const SCHEMA_9_DDL = `
  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
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
  );
  CREATE TABLE IF NOT EXISTS records (
    room_id TEXT NOT NULL,
    log_id INTEGER NOT NULL,
    commit_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (room_id, log_id)
  );
  CREATE INDEX IF NOT EXISTS records_log_idx ON records (log_id);
  CREATE INDEX IF NOT EXISTS records_retention_idx ON records (commit_ms, log_id);
  CREATE TABLE IF NOT EXISTS message_state (
    message_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    latest_log_id INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    author_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS message_state_latest_idx ON message_state (latest_log_id);
  CREATE TABLE IF NOT EXISTS reaction_state (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    log_id INTEGER NOT NULL,
    from_json TEXT NOT NULL,
    emojis_json TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS reaction_state_log_idx ON reaction_state (log_id);
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
  );
  CREATE TABLE IF NOT EXISTS uploads (
    upload_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    message_id TEXT,
    embed_id TEXT,
    state TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    content_type TEXT NOT NULL DEFAULT '',
    write_expires_ms INTEGER NOT NULL,
    expires_ms INTEGER NOT NULL,
    created_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS uploads_owner_idx ON uploads (owner_id);
  CREATE INDEX IF NOT EXISTS uploads_expiry_idx ON uploads (expires_ms);
  CREATE INDEX IF NOT EXISTS uploads_pending_idx ON uploads (state, write_expires_ms);
  CREATE INDEX IF NOT EXISTS uploads_message_idx ON uploads (message_id);
  CREATE TABLE IF NOT EXISTS memberships (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);
  CREATE TABLE IF NOT EXISTS credentials (
    credential_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    public_key_json TEXT NOT NULL,
    sign_count INTEGER NOT NULL,
    transports_json TEXT,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
  );
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
  );
  CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id, updated_ms);
  CREATE INDEX IF NOT EXISTS push_subscriptions_updated_idx ON push_subscriptions (updated_ms);
  CREATE INDEX IF NOT EXISTS push_subscriptions_waking_idx ON push_subscriptions (user_id, updated_ms) WHERE wake != 0;
  CREATE INDEX IF NOT EXISTS push_subscriptions_joined_idx ON push_subscriptions (updated_ms, user_id) WHERE (wake & 8) != 0;
  CREATE TABLE IF NOT EXISTS push_wakes (
    user_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    woken_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_id)
  );
  CREATE INDEX IF NOT EXISTS push_wakes_woken_idx ON push_wakes (woken_ms);
  CREATE TABLE IF NOT EXISTS user_status (
    user_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'online',
    mute_until_ms INTEGER
  );
  CREATE TABLE IF NOT EXISTS room_mutes (
    user_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    mute_until_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_id)
  );
  CREATE TABLE IF NOT EXISTS accepted_requests (
    user_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    result_json TEXT NOT NULL,
    transition_json TEXT,
    expires_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, request_id)
  );
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
  );
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
  );
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

/** The tables code keeps no rows of across a rebuild here. */
const KEPT_AS_IS = new Set(["log_state", "maintenance"]);

/**
 * Turns a fresh store's tables back into schema 9's, keeping their rows:
 * each table is renamed aside, schema 9 created anew, the columns both have
 * copied, and each message's latest snapshot copied back from `records`.
 */
export function toSchema9(sql: SqlStorage): void {
	const tables = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
		.toArray().map((row) => row.name).filter((name) => !KEPT_AS_IS.has(name));
	const columns = (table: string) => sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?) ORDER BY cid", table).toArray().map((row) => row.name);
	const indexes = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").toArray().map((row) => row.name);
	for (const index of indexes) sql.exec(`DROP INDEX ${index}`);
	for (const table of tables) sql.exec(`ALTER TABLE ${table} RENAME TO ${table}_v10`);
	for (const statement of SCHEMA_9_DDL.split(";").map((text) => text.trim()).filter(Boolean)) sql.exec(statement);
	for (const table of tables) {
		const kept = columns(`${table}_v10`);
		const shared = columns(table).filter((name) => kept.includes(name));
		if (table === "message_state") {
			sql.exec(`INSERT INTO message_state (message_id, room_id, latest_log_id, author_id, snapshot_json)
				SELECT m.message_id, m.room_id, m.latest_log_id, m.author_id, r.record_json
				FROM message_state_v10 m JOIN records_v10 r ON r.room_id = m.room_id AND r.log_id = m.latest_log_id`);
		} else if (shared.length > 0) {
			const list = shared.join(", ");
			sql.exec(`INSERT INTO ${table} (${list}) SELECT ${list} FROM ${table}_v10`);
		}
	}
	for (const table of tables) sql.exec(`DROP TABLE ${table}_v10`);
	sql.exec("UPDATE _meta SET value = '9' WHERE key = 'schema_version'");
	sql.exec("UPDATE maintenance SET schema_version = 9 WHERE id = 1");
}
