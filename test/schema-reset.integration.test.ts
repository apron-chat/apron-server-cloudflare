import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BOOTSTRAP_ROW_RESERVATION } from '../src/budget';
import { MAX_CARRIED_PASSKEYS, SCHEMA_VERSION, Store, UPGRADABLE_SCHEMA_VERSION, defaultStoreConfig } from '../src/store';
import { pushSubscriptionsOf } from './helpers/store';

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

/** Turns a fresh store's identities back into those of code before `seen`, which makes the same schema 9 without `seen_ms`. */
function withoutSeen(sql: SqlStorage): void {
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

it('adds seen to a schema 9 store from code before it, without a new schema version, and nothing else changes', async () => {
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
		// Still schema 9: code before `seen` runs on this object as it is.
		expect(SCHEMA_VERSION).toBe(9);
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'").one().value).toBe('9');
		expect(sql.exec<{ schema_version: number }>('SELECT schema_version FROM maintenance WHERE id = 1').one().schema_version).toBe(9);
		expect(identityColumns(sql).slice(-2)).toEqual(['ext_json', 'seen_ms']);
		// A few rows charged on top of the day's, however many identities there
		// are: the column is added, with no row rewritten or backfilled.
		// (Measured 53 read and 3 written with 10,000 identities, as with 500.)
		expect(readsReserved(sql) - before.reads).toBeLessThan(64);
		expect(writesReserved(sql) - before.writes).toBeGreaterThan(0);
		expect(writesReserved(sql) - before.writes).toBeLessThanOrEqual(4);
		// None recorded yet: no seen.
		expect(sql.exec<{ seen_ms: number }>("SELECT seen_ms FROM identities WHERE user_id = 'kept_user'").one().seen_ms).toBe(0);
		expect(store.statusInputs('kept_user')).toEqual({ choice: 'dnd', roomMutes: [] });
		expect(store.getIdentity('kept_user')).not.toHaveProperty('seen');
		expect(store.getRoomState().latest_log_id).toBe(before.head);
		store.setSeen({ userId: 'kept_user', seen: now, now });
		// A sign-in reads it with the identity row, not with the status state.
		expect(store.getIdentity('kept_user')?.seen).toBe(now);
		expect(store.statusInputs('kept_user')).toEqual({ choice: 'dnd', roomMutes: [] });
		return { writes: writesReserved(sql) };
	});

	// A later wake finds the column and adds nothing: its probe reads no row and writes none.
	await evictDurableObject(stub);
	await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		expect(store.requiresReset()).toBe(false);
		expect(store.storageAccounting().writes).toBe(0);
		// A wake's own reads, the probe's among them, stay within the eight-row
		// handover allowance of its first reservation, and it writes nothing.
		const woken = new Store(state, defaultStoreConfig());
		woken.initialize();
		// (Measured 6 reads, the probe charged as one of them.)
		expect(woken.storageAccounting().writes).toBe(0);
		expect(woken.storageAccounting().reads).toBeLessThanOrEqual(8);
		// The probe is metered as no row read (the store charges it as one).
		const probe = sql.exec('SELECT seen_ms FROM identities LIMIT 0');
		expect(probe.toArray()).toEqual([]);
		expect(probe.rowsRead).toBe(0);
		expect(writesReserved(sql)).toBe(added.writes);
		expect(identityColumns(sql).filter((name) => name === 'seen_ms')).toHaveLength(1);
		expect(store.getIdentity('kept_user')?.seen).toBe(now);
	});
});

it('keeps seen and everything else when code before it runs on the store and is redeployed again (rollback, roll forward)', async () => {
	const stub = env.DEMO.getByName(`schema-seen-rollback-${crypto.randomUUID()}`);
	const now = Date.now();
	await runInDurableObject(stub, async (instance) => {
		const { store } = instance as unknown as Runtime;
		for (const userId of ['seen_user', 'renamed_user', 'purged_user']) {
			store.registerIdentity({
				userId, name: userId, userHandle: `handle-${userId}`, now, ipKey: `ip-${userId}`,
				credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
			});
			store.setSeen({ userId, seen: now - 1_000, now });
		}
	});

	// Code before `seen` (708f6a5) on these tables: every statement it runs on
	// `identities`, verbatim but for its bindings, names its columns; none
	// recreates the table, inserts by position or reads `*`. It finds schema
	// 9, so it neither resets nor upgrades.
	await evictDurableObject(stub);
	await runInDurableObject(stub, (_instance, state) => {
		const sql = state.storage.sql;
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'").one().value).toBe('9');
		// Registration, a bot or `admin`, and a reset's passkey carry: named columns, so `seen_ms` takes its default.
		sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms) VALUES (?, ?, ?, 'registered', ?, ?)", 'old_user', 'handle-old_user', 'Old', now, now);
		sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms, roles_json) VALUES (?, '', ?, ?, ?, ?, ?)", 'bot_old_user', 'Bot', 'bot', now, now, '["bot"]');
		sql.exec("INSERT OR IGNORE INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms, roles_json) VALUES (?, ?, ?, 'registered', ?, ?, ?)", 'carried_user', 'handle-carried', 'Carried', now, now, '[]');
		// Reads by name.
		expect(sql.exec("SELECT user_id, user_handle, name, tier, created_ms, updated_ms, avatar_url, avatar_expires_ms, roles_json, ext_json FROM identities WHERE user_id = ? LIMIT 1", 'seen_user').one()).toMatchObject({ user_id: 'seen_user', ext_json: '' });
		expect(sql.exec(`SELECT m.user_id, i.name, i.avatar_url, i.avatar_expires_ms, i.roles_json, i.ext_json, s.status
			FROM memberships m LEFT JOIN identities i ON i.user_id = m.user_id LEFT JOIN user_status s ON s.user_id = m.user_id
			WHERE m.room_id = ? ORDER BY m.user_id LIMIT ?`, 'general', 10).toArray().map((row) => row.user_id)).toEqual(['purged_user', 'renamed_user', 'seen_user']);
		expect(sql.exec(`SELECT c.credential_id, c.user_id, c.public_key_json, c.sign_count, c.transports_json,
				c.created_ms, c.updated_ms, i.user_handle, i.name, i.tier, i.roles_json,
				i.created_ms AS identity_created_ms, i.updated_ms AS identity_updated_ms,
				EXISTS (SELECT 1 FROM memberships m WHERE m.room_id = ? AND m.user_id = c.user_id) AS in_general
			FROM credentials c JOIN identities i ON i.user_id = c.user_id
			WHERE i.tier = 'registered' AND i.user_id <> ?
			ORDER BY c.updated_ms DESC, c.credential_id LIMIT ?`, 'general', 'admin', 100).toArray()).toHaveLength(3);
		expect(sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM identities').one().count).toBe(6);
		// Updates of other columns leave `seen_ms` as it is; /rename moves it with the row; /purge deletes the row.
		sql.exec('UPDATE identities SET name = ?, ext_json = ?, updated_ms = ? WHERE user_id = ?', 'Seen', '{"tz":"UTC"}', now, 'seen_user');
		sql.exec('UPDATE identities SET roles_json = ?, updated_ms = ? WHERE user_id = ?', '["friend"]', now, 'seen_user');
		sql.exec('UPDATE identities SET avatar_url = ?, avatar_expires_ms = ?, updated_ms = ? WHERE user_id = ?', 'https://example.test/a.png', now + 1, now, 'seen_user');
		sql.exec("UPDATE identities SET avatar_url = '', avatar_expires_ms = 0, updated_ms = ? WHERE user_id = ?", now, 'seen_user');
		sql.exec('UPDATE identities SET user_id = ?, updated_ms = ? WHERE user_id = ?', 'renamed_to', now, 'renamed_user');
		sql.exec('DELETE FROM identities WHERE user_id IN (?)', 'purged_user');
	});

	// The redeploy finds the column with what it held, and adds nothing.
	await evictDurableObject(stub);
	await runInDurableObject(stub, (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		expect(store.requiresReset()).toBe(false);
		expect(identityColumns(sql).filter((name) => name === 'seen_ms')).toHaveLength(1);
		expect(store.getIdentity('seen_user')?.seen).toBe(now - 1_000);
		expect(store.getIdentity('renamed_to')?.seen).toBe(now - 1_000);
		expect(store.getIdentity('old_user')).not.toHaveProperty('seen');
		expect(store.getIdentity('carried_user')).not.toHaveProperty('seen');
		expect(store.getIdentity('seen_user')).toMatchObject({ name: 'Seen', roles: ['friend'] });
		expect(store.getIdentity('purged_user')).toBeNull();
		store.setSeen({ userId: 'old_user', seen: now, now });
		expect(store.getIdentity('old_user')?.seen).toBe(now);
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
		// Schema 8's timestamp lists stay, unread: dropping them would rewrite the table four times.
		expect(columns('principal_limits')).toEqual(['scope', 'principal_key', 'day', 'posts_day', 'registrations_day', 'uploads_day', 'updated_ms',
			'post_events_json', 'auth_events_json', 'history_events_json', 'admission_events_json', 'level', 'level_ms']);
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
		expect(indexes('push_subscriptions')).toEqual(expect.arrayContaining(['push_subscriptions_user_idx', 'push_subscriptions_updated_idx', 'push_subscriptions_waking_idx']));
		// The waking-registration index is partial: registrations that wake for nothing are not in it.
		expect(sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'push_subscriptions_waking_idx'").one().sql).toMatch(/WHERE wake != 0$/);
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
