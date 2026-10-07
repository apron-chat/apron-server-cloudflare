import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BOOTSTRAP_ROW_RESERVATION } from '../src/budget';
import { MAX_CARRIED_PASSKEYS, SCHEMA_VERSION, UPGRADABLE_SCHEMA_VERSION, type Store } from '../src/store';
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
		// Schema 7 has no push registrations, wake times, user status or room mutes, nor user ext.
		sql.exec('ALTER TABLE identities DROP COLUMN ext_json');
		sql.exec('DROP TABLE push_subscriptions');
		sql.exec('DROP TABLE push_wakes');
		sql.exec('DROP TABLE user_status');
		sql.exec('DROP TABLE room_mutes');
		sql.exec("UPDATE _meta SET value = '7' WHERE key = 'schema_version'");
		sql.exec('UPDATE maintenance SET schema_version = 7 WHERE id = 1');
		return store.getRoomState().latest_log_id;
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
