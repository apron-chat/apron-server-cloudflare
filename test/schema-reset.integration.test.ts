import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BOOTSTRAP_ROW_RESERVATION } from '../src/budget';
import { MAX_CARRIED_PASSKEYS, SCHEMA_VERSION, UPGRADABLE_SCHEMA_VERSION, type Store } from '../src/store';

type Runtime = { store: Store };

// Schema 5 is upgraded in place (below); older and newer schemas are reset.
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
			state.storage.sql.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('admins', ?)", JSON.stringify(['user_before_reset', 'gone_user']));
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
			// Admins whose passkeys were carried stay admins.
			expect(store.isAdmin('user_before_reset')).toBe(true);
			expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'admins'").one().value).toBe('["user_before_reset"]');
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

it(`upgrades a schema ${UPGRADABLE_SCHEMA_VERSION} store in place: intro messages become descriptions, and nothing else is lost`, async () => {
	const stub = env.DEMO.getByName(`schema-upgrade-${crypto.randomUUID()}`);
	const day = new Date().toISOString().slice(0, 10);
	const now = Date.now();
	const fixture = await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		const identity = { user_id: 'upgrader', name: 'Upgrader' };
		const mutate = (requestId: string, method: string, params: Record<string, unknown>) => store.mutate({
			userId: 'upgrader', ipKey: 'upgrade-ip', requestId, method, now: Date.now(), identity, params,
		});
		store.registerIdentity({
			userId: 'upgrader', name: 'Upgrader', userHandle: 'handle', now, ipKey: 'upgrade-ip',
			credential: { credentialId: 'cred-upgrader', userId: 'upgrader', publicKey: 'AAAA', counter: 0 },
		});
		const intro = String(mutate('intro', 'message', { body: { text: 'Deploy chatter', format: 'markdown' } }).result.message_id);
		const gone = String(mutate('gone', 'message', { body: { text: 'soon deleted' } }).result.message_id);
		const long = String(mutate('long', 'message', { body: { text: 'é'.repeat(2_000) } }).result.message_id);
		const thread = String(mutate('thread', 'room_set', { parent_room_id: 'general', title: 'Deploy' }).result.room_id);
		const saved = mutate('save', 'room_set', { room_id: thread, title: 'Deploys' }).room!.log_id;
		const deletedThread = String(mutate('thread-2', 'room_set', { parent_room_id: 'general', title: 'Gone' }).result.room_id);
		const longThread = String(mutate('thread-3', 'room_set', { parent_room_id: 'general', title: 'Long' }).result.room_id);
		// The intro was edited after the room last embedded it, and one intro was deleted.
		mutate('edit', 'message', { message_id: intro, body: { text: 'Deploy chatter, *edited*', format: 'markdown' } });
		mutate('delete', 'message', { message_id: gone, deleted: true });
		await state.storage.put('session:kept', { v: 1, userId: 'upgrader', origin: 'http://localhost:5173', expiresMs: now + 60_000 });
		const head = store.getRoomState().latest_log_id;

		// Rewind to schema 5's shape: rooms point at intro messages and have no
		// member_count, and logged room records embed the intro's snapshot.
		const snapshotOf = (text: string, messageId: string) => ({ message_id: messageId, log_id: messageId, room_id: 'general', from: identity, body: { text, format: 'plain' } });
		sql.exec('ALTER TABLE rooms ADD COLUMN intro_message_id TEXT');
		sql.exec('ALTER TABLE rooms DROP COLUMN member_count');
		for (const [room, message] of [[thread, intro], [deletedThread, gone], [longThread, long]]) {
			sql.exec('UPDATE rooms SET intro_message_id = ? WHERE room_id = ?', message, room);
		}
		const rewrite = (room: string, logId: string, text: string, messageId: string) => {
			const record = JSON.parse(sql.exec<{ record_json: string }>("SELECT record_json FROM records WHERE room_id = ? AND log_id = ?", room, Number(logId)).one().record_json);
			sql.exec("UPDATE records SET record_json = ? WHERE room_id = ? AND log_id = ?", JSON.stringify({ ...record, intro_message: snapshotOf(text, messageId) }), room, Number(logId));
		};
		rewrite(thread, thread, 'Old intro text', intro);
		rewrite(thread, saved, 'Deploy chatter', intro);
		rewrite(deletedThread, deletedThread, 'soon deleted', gone);
		sql.exec("UPDATE _meta SET value = '5' WHERE key = 'schema_version'");
		sql.exec('UPDATE maintenance SET schema_version = 5 WHERE id = 1');
		const budget = sql.exec<{ maintenance_reads: number; maintenance_writes: number }>('SELECT maintenance_reads, maintenance_writes FROM resource_budgets WHERE day = ?', day).one();
		return { thread, saved, deletedThread, longThread, budget, head };
	});

	await evictDurableObject(stub);
	await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		expect(store.requiresReset()).toBe(false);
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'").one().value).toBe(String(SCHEMA_VERSION));
		expect(sql.exec<{ schema_version: number }>('SELECT schema_version FROM maintenance WHERE id = 1').one().schema_version).toBe(SCHEMA_VERSION);
		const columns = sql.exec<{ name: string }>('PRAGMA table_info(rooms)').toArray().map((column) => column.name);
		expect(columns).toContain('member_count');
		expect(columns).not.toContain('intro_message_id');

		// Nothing was wiped: the chat, the passkey, and its session remain.
		expect(store.getRoomState().latest_log_id).toBe(fixture.head);
		expect(store.getCredential('cred-upgrader')?.userId).toBe('upgrader');
		expect(await state.storage.get('session:kept')).toMatchObject({ userId: 'upgrader' });

		// Rooms take their intro message's current text as their description.
		const rooms = new Map(store.listRooms().map((room) => [room.room_id, room]));
		expect(rooms.get(fixture.thread)).toMatchObject({ title: 'Deploys', description: 'Deploy chatter, *edited*' });
		expect(rooms.get(fixture.deletedThread)).not.toHaveProperty('description');
		const cut = rooms.get(fixture.longThread)!.description!;
		expect(cut.endsWith('…')).toBe(true);
		expect(new TextEncoder().encode(JSON.stringify({ title: 'Long', description: cut })).length).toBeLessThanOrEqual(2_048);
		expect(new TextEncoder().encode(JSON.stringify({ title: 'Long', description: cut + 'é' })).length).toBeGreaterThan(2_048);
		for (const room of rooms.values()) expect(room).not.toHaveProperty('intro_message');

		// History's room records lose intro_message: the current record takes
		// the room's description, an older one the text it embedded.
		const history = store.historyPage({ roomId: fixture.thread, after: '0', limit: 50 });
		expect(history.rooms?.map((room) => [room.log_id, room.title, room.description])).toEqual([
			[fixture.thread, 'Deploy', 'Old intro text'],
			[fixture.saved, 'Deploys', 'Deploy chatter, *edited*'],
		]);
		const stored = sql.exec<{ record_json: string }>("SELECT record_json FROM records WHERE kind = 'room'").toArray();
		expect(stored.some((row) => row.record_json.includes('intro_message'))).toBe(false);

		// Each room counts its registered members: the upgrader joined general and made the threads.
		const counts = Object.fromEntries(sql.exec<{ room_id: string; member_count: number }>('SELECT room_id, member_count FROM rooms').toArray().map((row) => [row.room_id, row.member_count]));
		expect(counts).toEqual({ general: 1, [fixture.thread]: 1, [fixture.deletedThread]: 1, [fixture.longThread]: 1 });

		// The upgrade's rows are charged to the day's maintenance reservation.
		const budget = sql.exec<{ maintenance_reads: number; maintenance_writes: number }>('SELECT maintenance_reads, maintenance_writes FROM resource_budgets WHERE day = ?', day).one();
		expect(budget.maintenance_reads).toBeGreaterThan(fixture.budget.maintenance_reads);
		expect(budget.maintenance_writes).toBeGreaterThan(fixture.budget.maintenance_writes);
	});

	// A later wake finds schema 6 and changes nothing.
	await evictDurableObject(stub);
	await runInDurableObject(stub, (instance, state) => {
		const { store } = instance as unknown as Runtime;
		expect(store.requiresReset()).toBe(false);
		expect(state.storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'").one().value).toBe(String(SCHEMA_VERSION));
	});
});
