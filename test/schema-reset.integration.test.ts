import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BOOTSTRAP_ROW_RESERVATION } from '../src/budget';
import { MAX_CARRIED_PASSKEYS, SCHEMA_VERSION, Store, UPGRADABLE_SCHEMA_VERSION, defaultStoreConfig } from '../src/store';
import { toSchema10, toSchema9 } from './helpers/schema9';
import { messagesOf, pushSubscriptionsOf } from './helpers/store';

type Runtime = { store: Store };

// Schema 7 is upgraded in place (below); older and newer schemas are reset.
for (const storedVersion of [UPGRADABLE_SCHEMA_VERSION - 1, SCHEMA_VERSION + 1]) {
	it(`resets populated storage at schema ${storedVersion} to a fresh schema ${SCHEMA_VERSION} store`, async () => {
		const stub = env.DEMO.getByName(`schema-reset-${storedVersion}-${crypto.randomUUID()}`);
		const day = new Date().toISOString().slice(0, 10);
		const before = await runInDurableObject(stub, async (instance, state) => {
			const { store } = instance as unknown as Runtime;
			store.registerIdentity({
				userId: 'user_before_reset', name: 'Before', userHandle: 'handle', now: Date.now(), ipKey: 'reset-ip',
				credential: { credentialId: 'cred-before', userId: 'user_before_reset', publicKey: 'AAAA', counter: 0 },
			});
			store.mutate({
				userId: 'user_before_reset', ipKey: 'reset-ip', requestId: 'before', method: 'message', now: Date.now(),
				identity: { user_id: 'user_before_reset' }, params: { room_id: 'general', body: { text: 'discarded' } },
			});
			// A second passkey user who left `general`, and a bot (no passkey).
			store.registerIdentity({
				userId: 'user_left_general', name: 'Leaver', userHandle: 'handle-2', now: Date.now(), ipKey: 'reset-ip-3', rooms: [],
				credential: { credentialId: 'cred-left', userId: 'user_left_general', publicKey: 'BBBB', counter: 7 },
			});
			state.storage.sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms) VALUES ('bot_x', '', 'Bot', 'bot', 1, 1)");
			// Should `admin` ever hold a passkey, a reset does not carry it.
			state.storage.sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms) VALUES ('admin', 'admin-handle', 'Admin', 'registered', 1, 1)");
			state.storage.sql.exec("INSERT INTO credentials (credential_id, user_id, public_key_json, sign_count, transports_json, created_ms, updated_ms) VALUES ('cred-admin', 'admin', '{\"publicKey\":\"AAAA\"}', 0, NULL, ?, ?)", Date.now() + 5_000, Date.now() + 5_000);
			state.storage.sql.exec(`UPDATE identities SET roles_json = '["admin","friend"]', ext_json = '{"tz":"UTC"}' WHERE user_id = 'user_before_reset'`);
			await state.storage.put('session:stale', { v: 1, userId: 'user_before_reset', origin: 'http://localhost:5173', expiresMs: Date.now() + 60_000 });
			state.storage.sql.exec("UPDATE _meta SET value = ? WHERE key = 'schema_version'", String(storedVersion));
			state.storage.sql.exec("UPDATE _meta SET value = '1' WHERE key = 'accounting_unsafe'");
			return state.storage.sql.exec<{ reads_reserved: number; writes_reserved: number }>(
				'SELECT reads_reserved, writes_reserved FROM resource_budgets WHERE day = ?', day,
			).one();
		});

		// The next constructor sees the mismatched version and wipes the object.
		await evictDurableObject(stub);
		await runInDurableObject(stub, async (instance, state) => {
			const { store } = instance as unknown as Runtime;
			const sql = state.storage.sql;
			expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'").one().value).toBe(String(SCHEMA_VERSION));
			// Passkeys and their identities survive the wipe; the bot does not.
			expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM identities').one().n).toBe(2);
			expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'identity_count'").one().value).toBe('2');
			expect(store.getCredential('cred-before')).toMatchObject({ credentialId: 'cred-before', userId: 'user_before_reset', publicKey: 'AAAA', counter: 0 });
			expect(store.getCredential('cred-left')).toMatchObject({ userId: 'user_left_general', publicKey: 'BBBB', counter: 7 });
			expect(store.getIdentity('bot_x')).toBeNull();
			expect(store.getCredential('cred-admin')).toBeNull();
			expect(store.getIdentity('admin')).toBeNull();
			// Users whose passkeys were carried keep their roles, but not their ext.
			expect(store.getIdentity('user_before_reset')?.roles).toEqual(['admin', 'friend']);
			expect(store.getIdentity('user_left_general')?.roles).toEqual([]);
			expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM message_state').one().n).toBe(0);
			expect((await state.storage.list({ prefix: 'session:' })).size).toBe(0);
			const general = store.getRoomState();
			expect(general).toEqual({ room_id: 'general', log_id: general.log_id, title: 'General', latest_log_id: general.log_id, history_log_id: general.log_id });
			expect(store.listRooms()).toEqual([general]);
			expect(store.getIdentity('user_before_reset')).toEqual({
				userId: 'user_before_reset', name: 'Before', userHandle: 'handle', credentialCount: 1, rooms: ['general'],
				roles: ['admin', 'friend'],
			});
			expect(store.getIdentity('user_left_general')?.rooms).toEqual([]);
			// The accounting latch does not survive, so the fresh store is usable.
			const budget = sql.exec<{ reads_reserved: number; writes_reserved: number }>(
				'SELECT reads_reserved, writes_reserved FROM resource_budgets WHERE day = ?', day,
			).one();
			// The day's metered reservations survive, plus the bootstrap charge
			// and the rows the passkey carry read and wrote.
			expect(budget.reads_reserved).toBeGreaterThan(before.reads_reserved + BOOTSTRAP_ROW_RESERVATION);
			expect(budget.writes_reserved).toBeGreaterThan(before.writes_reserved + BOOTSTRAP_ROW_RESERVATION);
			expect(store.accountingStatus().unsafe).toBe(false);
			const posted = store.mutate({
				userId: 'guest_after', ipKey: 'reset-ip-2', requestId: 'after', method: 'message', now: Date.now(),
				identity: { user_id: 'guest_after' }, params: { room_id: 'general', body: { text: 'fresh' } },
			});
			expect(BigInt(posted.message!.log_id)).toBeGreaterThan(BigInt(general.log_id));
		});

		// A later wake keeps the fresh schema without resetting again.
		await evictDurableObject(stub);
		await runInDurableObject(stub, (instance) => {
			expect((instance as unknown as Runtime).store.getRoomState().latest_log_id).not.toBe(undefined);
			expect((instance as unknown as Runtime).store.requiresReset()).toBe(false);
		});
	});
}

it(`carries at most ${MAX_CARRIED_PASSKEYS} passkeys across a reset, most recently used first`, async () => {
	const stub = env.DEMO.getByName(`schema-reset-cap-${crypto.randomUUID()}`);
	await runInDurableObject(stub, (_instance, state) => {
		const sql = state.storage.sql;
		// Passkey N was last used at time N, so passkey 0 is the least recent.
		for (let n = 0; n <= MAX_CARRIED_PASSKEYS; n++) {
			sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms) VALUES (?, ?, ?, 'registered', ?, ?)", `user_${n}`, `h${n}`, `U${n}`, n, n);
			sql.exec('INSERT INTO credentials (credential_id, user_id, public_key_json, sign_count, transports_json, created_ms, updated_ms) VALUES (?, ?, ?, 0, NULL, ?, ?)', `cred_${n}`, `user_${n}`, '{"publicKey":"AAAA"}', n, n);
		}
		sql.exec("UPDATE _meta SET value = ? WHERE key = 'schema_version'", String(SCHEMA_VERSION + 1));
	});
	await evictDurableObject(stub);
	await runInDurableObject(stub, (instance, state) => {
		const { store } = instance as unknown as Runtime;
		expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM credentials').one().n).toBe(MAX_CARRIED_PASSKEYS);
		expect(store.getCredential('cred_0')).toBeNull();
		expect(store.getCredential('cred_1')?.userId).toBe('user_1');
		expect(store.getCredential(`cred_${MAX_CARRIED_PASSKEYS}`)?.userId).toBe(`user_${MAX_CARRIED_PASSKEYS}`);
		expect(store.getIdentity('user_0')).toBeNull();
	});
});

/** Turns a fresh store back into schema 9 as code before `seen` made it, without `seen_ms`. */
function withoutSeen(sql: SqlStorage): void {
	toSchema9(sql);
	sql.exec('ALTER TABLE identities DROP COLUMN seen_ms');
}

/** Turns a fresh store's tables back into schema 8's: timestamp lists on limiter rows, no history count on budget rows. */
function toSchema8(sql: SqlStorage): void {
	withoutSeen(sql);
	sql.exec('ALTER TABLE principal_limits DROP COLUMN level');
	sql.exec('ALTER TABLE principal_limits DROP COLUMN level_ms');
	for (const lane of ['post', 'auth', 'history', 'admission']) {
		sql.exec(`ALTER TABLE principal_limits ADD COLUMN ${lane}_events_json TEXT NOT NULL DEFAULT '[]'`);
	}
	sql.exec('ALTER TABLE resource_budgets DROP COLUMN history_reserved');
	sql.exec('ALTER TABLE resource_budgets DROP COLUMN effective_ms');
	sql.exec("UPDATE _meta SET value = '8' WHERE key = 'schema_version'");
	sql.exec('UPDATE maintenance SET schema_version = 8 WHERE id = 1');
}

const identityColumns = (sql: SqlStorage) => sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('identities') ORDER BY cid").toArray().map((row) => row.name);
const readsReserved = (sql: SqlStorage) => sql.exec<{ reads_reserved: number }>('SELECT reads_reserved FROM resource_budgets ORDER BY day DESC LIMIT 1').one().reads_reserved;
const writesReserved = (sql: SqlStorage) => sql.exec<{ writes_reserved: number }>('SELECT writes_reserved FROM resource_budgets ORDER BY day DESC LIMIT 1').one().writes_reserved;

it('adds seen to a schema 9 store from code before it, charged, as it rebuilds the store as schema 10, not charged', async () => {
	const stub = env.DEMO.getByName(`schema-seen-${crypto.randomUUID()}`);
	const now = Date.now();
	const before = await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		store.registerIdentity({
			userId: 'kept_user', name: 'Kept', userHandle: 'handle-kept_user', now, ipKey: 'ip-kept_user',
			credential: { credentialId: 'cred-kept_user', userId: 'kept_user', publicKey: 'AAAA', counter: 0 },
		});
		store.setStatus({ userId: 'kept_user', choice: 'dnd', now });
		const head = store.getRoomState().latest_log_id;
		// Last: the current code never runs against these tables.
		withoutSeen(sql);
		// The probe's error without the column, as the store matches it.
		expect(() => sql.exec('SELECT seen_ms FROM identities LIMIT 0')).toThrow(/no such column/i);
		// Identities: adding the column must not cost more with them.
		for (let index = 0; index < 10_000; index++) {
			sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms) VALUES (?, ?, ?, 'registered', ?, ?)", `filler_${index}`, `hf${index}`, `F${index}`, now, now);
		}
		return { head, writes: writesReserved(sql), reads: readsReserved(sql) };
	});

	await evictDurableObject(stub);
	const added = await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		expect(store.requiresReset()).toBe(false);
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'").one().value).toBe(String(SCHEMA_VERSION));
		expect(sql.exec<{ schema_version: number }>('SELECT schema_version FROM maintenance WHERE id = 1').one().schema_version).toBe(SCHEMA_VERSION);
		expect(identityColumns(sql).slice(-2)).toEqual(['ext_json', 'seen_ms']);
		// A few rows charged on top of the day's, however many identities there
		// are: the column is added, with no row rewritten or backfilled, and the
		// rebuild that copies all 10,000 rows into schema 10 is not charged.
		// (Measured 53 read and 3 written with 10,000 identities, as with 500.)
		expect(readsReserved(sql) - before.reads).toBeLessThan(64);
		expect(writesReserved(sql) - before.writes).toBeGreaterThan(0);
		expect(writesReserved(sql) - before.writes).toBeLessThanOrEqual(4);
		// None recorded yet: no seen.
		expect(sql.exec<{ seen_ms: number }>("SELECT seen_ms FROM identities WHERE user_id = 'kept_user'").one().seen_ms).toBe(0);
		expect(store.statusInputs('kept_user')).toEqual({ choice: 'dnd', roomMutes: [] });
		expect(store.getIdentity('kept_user')).not.toHaveProperty('seen');
		expect(store.getRoomState().latest_log_id).toBe(before.head);
		store.settleSeen({ userId: 'kept_user', at: now, now });
		// A sign-in reads it with the identity row, not with the status state.
		expect(store.getIdentity('kept_user')?.seen).toBe(now);
		expect(store.statusInputs('kept_user')).toEqual({ choice: 'dnd', roomMutes: [] });
		return { writes: writesReserved(sql) };
	});

	// A later wake finds schema 10 and changes nothing.
	await evictDurableObject(stub);
	await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		expect(store.requiresReset()).toBe(false);
		expect(store.storageAccounting().writes).toBe(0);
		// A wake's own reads stay within the eight-row handover allowance of its
		// first reservation, and it writes nothing.
		const woken = new Store(state, defaultStoreConfig());
		woken.initialize();
		expect(woken.storageAccounting().writes).toBe(0);
		expect(woken.storageAccounting().reads).toBeLessThanOrEqual(8);
		expect(writesReserved(sql)).toBe(added.writes);
		expect(identityColumns(sql).filter((name) => name === 'seen_ms')).toHaveLength(1);
		expect(store.getIdentity('kept_user')?.seen).toBe(now);
	});
});

/** Every row of `table`, by the columns schema 9 and 10 share, in key order. */
function rowsOf(sql: SqlStorage, table: string, columns: string[]): unknown[] {
	return sql.exec(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${columns.join(', ')}`).toArray();
}

/** A message's latest text in its room's history: its last record there. */
function latestText(store: Store, messageId: string, now: number): string | undefined {
	return messagesOf(store.history({ roomId: 'general', after: 0n, now })).filter((message) => message.message_id === messageId).pop()?.body?.text;
}

const SHARED_COLUMNS: Record<string, string[]> = {
	rooms: ['room_id', 'parent_room_id', 'created_log_id', 'record_log_id', 'latest_log_id', 'fields_json', 'member_count'],
	records: ['room_id', 'log_id', 'commit_ms', 'kind', 'record_json'],
	message_state: ['message_id', 'room_id', 'latest_log_id', 'author_id'],
	reaction_state: ['message_id', 'user_id', 'log_id', 'from_json', 'emojis_json'],
	identities: ['user_id', 'user_handle', 'name', 'tier', 'roles_json', 'ext_json', 'seen_ms'],
	memberships: ['room_id', 'user_id'],
	credentials: ['credential_id', 'user_id', 'public_key_json', 'sign_count'],
	user_status: ['user_id', 'status', 'mute_until_ms'],
	room_mutes: ['user_id', 'room_id', 'mute_until_ms'],
	accepted_requests: ['user_id', 'request_id', 'digest', 'expires_ms'],
	resource_budgets: ['day', 'reads_reserved', 'writes_reserved', 'foreground_writes', 'maintenance_writes'],
	principal_limits: ['scope', 'principal_key', 'level', 'day', 'posts_day'],
};

it('upgrades a schema 9 store to the current schema in place: every row kept, rebuilt WITHOUT ROWID, and the rebuild not charged', async () => {
	const stub = env.DEMO.getByName(`schema-upgrade-9-${crypto.randomUUID()}`);
	const now = Date.now();
	const before = await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		for (const userId of ['ada', 'bob']) {
			store.registerIdentity({
				userId, name: userId, userHandle: `handle-${userId}`, now, ipKey: `ip-${userId}`,
				credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
			});
		}
		const post = (userId: string, requestId: string, params: Record<string, unknown>) => store.mutate({
			userId, ipKey: `ip-${userId}`, requestId, method: 'message', now, identity: { user_id: userId }, params: { room_id: 'general', ...params },
		});
		const first = post('ada', 'first', { body: { text: 'first' } });
		post('bob', 'second', { body: { text: 'second' } });
		post('ada', 'edit', { message_id: first.result.message_id, body: { text: 'first, edited' } });
		store.mutate({
			userId: 'bob', ipKey: 'ip-bob', requestId: 'react', method: 'reactions', now, identity: { user_id: 'bob' },
			params: { message_id: first.result.message_id, emojis: ['👍'] },
		});
		store.setStatus({ userId: 'bob', choice: 'dnd', now });
		toSchema9(sql);
		// Filler: the uncharged rebuild must copy them all.
		for (let index = 0; index < 2_000; index++) {
			sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms) VALUES (?, ?, ?, 'registered', ?, ?)", `filler_${index}`, `hf${index}`, `F${index}`, now, now);
		}
		const rows = Object.fromEntries(Object.entries(SHARED_COLUMNS).map(([table, columns]) => [table, rowsOf(sql, table, columns)]));
		return { rows, page: messagesOf(store.history({ roomId: 'general', after: 0n, now })), writes: writesReserved(sql), reads: readsReserved(sql), messageId: String(first.result.message_id) };
	});
	expect(before.rows.message_state).toHaveLength(2);
	expect(before.rows.reaction_state).toHaveLength(1);

	await evictDurableObject(stub);
	await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		expect(store.requiresReset()).toBe(false);
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'").one().value).toBe(String(SCHEMA_VERSION));
		expect(sql.exec<{ schema_version: number }>('SELECT schema_version FROM maintenance WHERE id = 1').one().schema_version).toBe(SCHEMA_VERSION);
		// The day's budget row moves by the wake's own charge (below); every other row is as it was.
		for (const [table, columns] of Object.entries(SHARED_COLUMNS)) {
			if (table !== 'resource_budgets') expect(rowsOf(sql, table, columns), table).toEqual(before.rows[table]);
		}
		// Every table keyed by text or more than one column is WITHOUT ROWID: no autoindex is left.
		for (const table of Object.keys(SHARED_COLUMNS)) {
			expect(sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table).one().sql, table).toMatch(/WITHOUT ROWID$/);
		}
		expect(sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_autoindex_%' OR name LIKE '%_v9' OR name = 'records_retention_idx'").toArray()).toEqual([]);
		// The indexes schema 9 had are rebuilt on the new tables, the partial one of `joined` registrations among them.
		expect(sql.exec<{ tbl_name: string }>("SELECT tbl_name FROM sqlite_master WHERE name = 'push_subscriptions_joined_idx'").one().tbl_name).toBe('push_subscriptions');
		expect(sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('message_state') ORDER BY cid").toArray().map((row) => row.name)).toEqual(['message_id', 'room_id', 'latest_log_id', 'author_id']);
		expect(sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM read_cursors').one().count).toBe(0);
		// The rebuild read and wrote every row once, and none of it is charged: the wake's own few are.
		expect(writesReserved(sql) - before.writes).toBeLessThanOrEqual(4);
		expect(readsReserved(sql) - before.reads).toBeLessThan(64);
		// The store reads the same: history, the edited message's current snapshot, reactions, status.
		expect(messagesOf(store.history({ roomId: 'general', after: 0n, now }))).toEqual(before.page);
		expect(latestText(store, before.messageId, now)).toBe('first, edited');
		expect(store.statusInputs('bob')).toEqual({ choice: 'dnd', roomMutes: [] });
		// And it writes: an edit of the upgraded message, and a new post.
		store.mutate({
			userId: 'ada', ipKey: 'ip-ada', requestId: 'after', method: 'message', now, identity: { user_id: 'ada' },
			params: { room_id: 'general', message_id: before.messageId, body: { text: 'edited again' } },
		});
		expect(latestText(store, before.messageId, now)).toBe('edited again');
	});
});

it('builds the joined wake index for a schema 9 store from code before it, with the rebuild, and later wakes add nothing', async () => {
	const stub = env.DEMO.getByName(`schema-joined-${crypto.randomUUID()}`);
	const now = Date.now();
	await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		store.registerIdentity({
			userId: 'kept_mod', name: 'Mod', userHandle: 'handle-kept_mod', now, ipKey: 'ip-kept_mod',
			credential: { credentialId: 'cred-kept_mod', userId: 'kept_mod', publicKey: 'AAAA', counter: 0 },
		});
		// As code before the index stored it: a registration with the scope's bit, which that code never set or read.
		sql.exec("INSERT INTO push_subscriptions (user_id, url, p256dh, auth, push_id, wake, created_ms, updated_ms) VALUES ('kept_mod', 'https://push.example.net/kept', 'p', 'a', NULL, 11, ?, ?)", now, now);
		// Last: code before the index made schema 9 without it.
		toSchema9(sql);
		sql.exec('DROP INDEX push_subscriptions_joined_idx');
		expect(() => sql.exec('SELECT user_id FROM push_subscriptions INDEXED BY push_subscriptions_joined_idx WHERE (wake & 8) != 0 LIMIT 0')).toThrow(/no such index/i);
	});

	await evictDurableObject(stub);
	const added = await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		expect(store.requiresReset()).toBe(false);
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'").one().value).toBe(String(SCHEMA_VERSION));
		expect(sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'push_subscriptions_joined_idx'").one().sql).toMatch(/WHERE \(wake & 8\) != 0$/);
		// The registration made before is in it.
		expect(store.joinedWakers(now)).toEqual(['kept_mod']);
		return { writes: writesReserved(sql) };
	});

	// A later wake finds schema 10 and changes nothing.
	await evictDurableObject(stub);
	await runInDurableObject(stub, async (_instance, state) => {
		const sql = state.storage.sql;
		const woken = new Store(state, defaultStoreConfig());
		woken.initialize();
		expect(woken.storageAccounting().writes).toBe(0);
		expect(woken.storageAccounting().reads).toBeLessThanOrEqual(8);
		expect(writesReserved(sql)).toBe(added.writes);
	});
});

it('upgrades a schema 10 store to 11 in place: the unread indexes and column go, with the state below the floor, and the rest stays', async () => {
	const stub = env.DEMO.getByName(`schema-upgrade-10-${crypto.randomUUID()}`);
	const now = Date.now();
	const before = await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		store.registerIdentity({
			userId: 'kept_user', name: 'Kept', userHandle: 'handle-kept_user', now, ipKey: 'ip-kept_user',
			credential: { credentialId: 'cred-kept_user', userId: 'kept_user', publicKey: 'AAAA', counter: 0 },
		});
		const posted = store.mutate({
			userId: 'kept_user', ipKey: 'ip-kept_user', requestId: 'kept', method: 'message', now,
			identity: { user_id: 'kept_user' }, params: { room_id: 'general', body: { text: 'kept' } },
		});
		store.mutate({
			userId: 'kept_user', ipKey: 'ip-kept_user', requestId: 'react', method: 'reactions', now,
			identity: { user_id: 'kept_user' }, params: { message_id: posted.result.message_id, emojis: ['👍'] },
		});
		toSchema10(sql);
		// What schema 10's cleanup left when a batch ran out: state below the floor, its records gone.
		const floor = sql.exec<{ history_floor: number }>('SELECT history_floor FROM log_state').one().history_floor;
		sql.exec("INSERT INTO message_state (message_id, room_id, latest_log_id, author_id) VALUES ('expired', 'general', ?, 'kept_user')", floor - 1);
		sql.exec("INSERT INTO reaction_state (message_id, user_id, log_id, from_json, emojis_json) VALUES ('expired', 'kept_user', ?, '{}', '[]')", floor - 1);
		sql.exec("INSERT INTO uploads (upload_key, owner_id, purpose, state, bytes, content_type, write_expires_ms, expires_ms, created_ms) VALUES ('kept-upload', 'kept_user', 'avatar', 'done', 10, 'image/png', ?, ?, ?)", now, now + 60_000, now);
		return { messageId: String(posted.result.message_id), writes: writesReserved(sql) };
	});

	await evictDurableObject(stub);
	await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		expect(store.requiresReset()).toBe(false);
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'").one().value).toBe(String(SCHEMA_VERSION));
		expect(sql.exec<{ schema_version: number }>('SELECT schema_version FROM maintenance WHERE id = 1').one().schema_version).toBe(SCHEMA_VERSION);
		expect(sql.exec("SELECT name FROM sqlite_master WHERE name IN ('message_state_latest_idx', 'reaction_state_log_idx', 'push_subscriptions_user_idx', 'push_subscriptions_waking_idx')").toArray()).toEqual([]);
		expect(sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('uploads')").toArray().map((row) => row.name)).not.toContain('content_type');
		expect(sql.exec("SELECT upload_key, state, bytes FROM uploads").toArray()).toEqual([{ upload_key: 'kept-upload', state: 'done', bytes: 10 }]);
		// The state below the floor went; the live message and its reaction set stayed.
		expect(sql.exec<{ message_id: string }>('SELECT message_id FROM message_state').toArray().map((row) => row.message_id)).toEqual([before.messageId]);
		expect(sql.exec<{ message_id: string }>('SELECT message_id FROM reaction_state').toArray().map((row) => row.message_id)).toEqual([before.messageId]);
		// A few rows, charged like the upgrades before it.
		expect(writesReserved(sql) - before.writes).toBeGreaterThan(0);
		expect(writesReserved(sql) - before.writes).toBeLessThan(64);
	});
});

it('upgrades a schema 8 store in place: limiter rows trade their timestamp lists for a token bucket and keep their day counts', async () => {
	const stub = env.DEMO.getByName(`schema-upgrade-8-${crypto.randomUUID()}`);
	const now = Date.now();
	const before = await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		store.registerIdentity({
			userId: 'kept_user', name: 'Kept', userHandle: 'handle-kept_user', now, ipKey: 'ip-kept_user',
			credential: { credentialId: 'cred-kept_user', userId: 'kept_user', publicKey: 'AAAA', counter: 0 },
		});
		store.mutate({
			userId: 'kept_user', ipKey: 'ip-kept_user', requestId: 'kept', method: 'message', now,
			identity: { user_id: 'kept_user' }, params: { room_id: 'general', body: { text: 'kept' } },
		});
		const head = store.getRoomState().latest_log_id;
		// Last: the current code never runs against schema 8's tables.
		toSchema8(sql);
		sql.exec(`UPDATE principal_limits SET post_events_json = ? WHERE scope = 'post'`, JSON.stringify([now]));
		// A table of limiter rows: the upgrade's cost must not grow with it.
		for (let index = 0; index < 500; index++) {
			sql.exec("INSERT INTO principal_limits (scope, principal_key, day, posts_day, registrations_day, updated_ms) VALUES ('post', ?, '', 0, 0, ?)", `ip:filler-${index}`, now);
		}
		return {
			head,
			posts: sql.exec<{ posts_day: number }>("SELECT posts_day FROM principal_limits WHERE scope = 'post' AND principal_key = 'user:kept_user'").one().posts_day,
			writes: sql.exec<{ writes_reserved: number }>('SELECT writes_reserved FROM resource_budgets ORDER BY day DESC LIMIT 1').one().writes_reserved,
		};
	});

	await evictDurableObject(stub);
	await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		expect(store.requiresReset()).toBe(false);
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'").one().value).toBe(String(SCHEMA_VERSION));
		expect(sql.exec<{ schema_version: number }>('SELECT schema_version FROM maintenance WHERE id = 1').one().schema_version).toBe(SCHEMA_VERSION);
		const columns = (table: string) => sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?) ORDER BY cid", table).toArray().map((row) => row.name);
		// Schema 8's timestamp lists, kept unread by schema 9, go with schema 10's rebuild.
		expect(columns('principal_limits')).toEqual(['scope', 'principal_key', 'level', 'level_ms', 'day', 'posts_day', 'registrations_day', 'uploads_day', 'updated_ms']);
		expect(columns('resource_budgets')).toContain('history_reserved');
		const row = sql.exec<{ level: number; posts_day: number }>("SELECT level, posts_day FROM principal_limits WHERE scope = 'post' AND principal_key = 'user:kept_user'").one();
		// The rolling minute starts over; the day's count stays.
		expect(row).toEqual({ level: 0, posts_day: before.posts });
		const budget = sql.exec<{ writes_reserved: number; history_reserved: number }>('SELECT writes_reserved, history_reserved FROM resource_budgets ORDER BY day DESC LIMIT 1').one();
		// The upgrade's own rows are charged on top of the day's: a few, however many limiter rows there are.
		expect(budget.history_reserved).toBe(0);
		expect(budget.writes_reserved).toBeGreaterThan(before.writes);
		expect(budget.writes_reserved - before.writes).toBeLessThan(64);
		expect(store.getRoomState().latest_log_id).toBe(before.head);
		expect(store.getIdentity('kept_user')?.name).toBe('Kept');
		// The upgraded limiters work: a page is charged to the new bucket.
		store.history({ roomId: 'general', limit: 1, now: Date.now(), userId: 'kept_user', ipKey: 'ip-kept_user' });
		expect(sql.exec<{ level: number }>("SELECT level FROM principal_limits WHERE scope = 'history' AND principal_key = 'user:kept_user'").one().level).toBe(1);
	});
});

it('upgrades a schema 7 store in place: it gains the push and user status tables and user ext, and nothing else changes', async () => {
	const stub = env.DEMO.getByName(`schema-upgrade-7-${crypto.randomUUID()}`);
	const now = Date.now();
	const head = await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		store.registerIdentity({
			userId: 'kept_user', name: 'Kept', userHandle: 'handle-kept_user', now, ipKey: 'ip-kept_user',
			credential: { credentialId: 'cred-kept_user', userId: 'kept_user', publicKey: 'AAAA', counter: 0 },
		});
		store.mutate({
			userId: 'kept_user', ipKey: 'ip-kept_user', requestId: 'kept', method: 'message', now,
			identity: { user_id: 'kept_user' }, params: { room_id: 'general', body: { text: 'kept' } },
		});
		const head = store.getRoomState().latest_log_id;
		// Last: schema 7 has schema 8's limiter rows, no push registrations, wake times, user status or room mutes, nor user ext.
		toSchema8(sql);
		sql.exec('ALTER TABLE identities DROP COLUMN ext_json');
		sql.exec('DROP TABLE push_subscriptions');
		sql.exec('DROP TABLE push_wakes');
		sql.exec('DROP TABLE user_status');
		sql.exec('DROP TABLE room_mutes');
		sql.exec("UPDATE _meta SET value = '7' WHERE key = 'schema_version'");
		sql.exec('UPDATE maintenance SET schema_version = 7 WHERE id = 1');
		return head;
	});

	await evictDurableObject(stub);
	await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		expect(store.requiresReset()).toBe(false);
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'").one().value).toBe(String(SCHEMA_VERSION));
		expect(sql.exec<{ schema_version: number }>('SELECT schema_version FROM maintenance WHERE id = 1').one().schema_version).toBe(SCHEMA_VERSION);
		const indexes = (table: string) => sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?", table).toArray().map((row) => row.name);
		// By registration time for expiry, and the partial index of `joined` registrations; a user's are their primary-key range.
		expect(indexes('push_subscriptions').sort()).toEqual(['push_subscriptions_joined_idx', 'push_subscriptions_updated_idx']);
		expect(indexes('push_wakes')).toContain('push_wakes_woken_idx');
		expect(sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('user_status') ORDER BY cid").toArray().map((row) => row.name)).toEqual(['user_id', 'status', 'mute_until_ms']);
		expect(sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('room_mutes') ORDER BY cid").toArray().map((row) => row.name)).toEqual(['user_id', 'room_id', 'mute_until_ms']);
		expect(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mutes'").toArray()).toEqual([]);
		expect(store.getRoomState().latest_log_id).toBe(head);
		expect(store.getIdentity('kept_user')?.name).toBe('Kept');
		expect(pushSubscriptionsOf(state, 'kept_user')).toEqual([]);
		expect(store.statusInputs('kept_user')).toEqual({ choice: 'online', roomMutes: [] });
		// Identities gain an empty ext.
		expect(sql.exec<{ ext_json: string }>("SELECT ext_json FROM identities WHERE user_id = 'kept_user'").one().ext_json).toBe('');
		expect(store.getIdentity('kept_user')).not.toHaveProperty('ext');
	});
});
