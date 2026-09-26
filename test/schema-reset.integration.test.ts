import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BOOTSTRAP_ROW_RESERVATION } from '../src/budget';
import { MAX_CARRIED_PASSKEYS, SCHEMA_VERSION, type Store } from '../src/store';

type Runtime = { store: Store };

for (const storedVersion of [SCHEMA_VERSION - 1, SCHEMA_VERSION + 1]) {
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
			expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM message_state').one().n).toBe(0);
			expect((await state.storage.list({ prefix: 'session:' })).size).toBe(0);
			const general = store.getRoomState();
			expect(general).toEqual({ room_id: 'general', log_id: general.log_id, title: 'General', latest_log_id: general.log_id, history_log_id: general.log_id });
			expect(store.listRooms()).toEqual([general]);
			expect(store.getIdentity('user_before_reset')).toEqual({
				userId: 'user_before_reset', name: 'Before', userHandle: 'handle', credentialCount: 1, rooms: ['general'],
			});
			expect(store.getIdentity('user_left_general')?.rooms).toEqual([]);
			// The accounting latch does not survive, so the fresh store is usable.
			const budget = sql.exec<{ reads_reserved: number; writes_reserved: number }>(
				'SELECT reads_reserved, writes_reserved FROM resource_budgets WHERE day = ?', day,
			).one();
			// The day's metered reservations survive, plus the bootstrap charge
			// and the carried passkeys' rows.
			expect(budget.reads_reserved).toBeGreaterThanOrEqual(before.reads_reserved + BOOTSTRAP_ROW_RESERVATION + 2 * 4);
			expect(budget.writes_reserved).toBeGreaterThanOrEqual(before.writes_reserved + BOOTSTRAP_ROW_RESERVATION + 2 * 8);
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
		sql.exec("UPDATE _meta SET value = ? WHERE key = 'schema_version'", String(SCHEMA_VERSION - 1));
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
