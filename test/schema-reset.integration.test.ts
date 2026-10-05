import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BOOTSTRAP_ROW_RESERVATION } from '../src/budget';
import { MAX_CARRIED_PASSKEYS, SCHEMA_VERSION, UPGRADABLE_SCHEMA_VERSIONS, type Store } from '../src/store';

type Runtime = { store: Store };

// Schemas 5, 6 and 7 are upgraded in place (below); older and newer schemas are reset.
for (const storedVersion of [Math.min(...UPGRADABLE_SCHEMA_VERSIONS) - 1, SCHEMA_VERSION + 1]) {
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
			if (storedVersion < SCHEMA_VERSION) {
				// An older schema has no roles column, and lists its admins in `_meta`.
				state.storage.sql.exec('ALTER TABLE identities DROP COLUMN roles_json');
				state.storage.sql.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('admins', ?)", JSON.stringify(['user_before_reset', 'gone_user']));
			} else {
				state.storage.sql.exec(`UPDATE identities SET roles_json = '["admin","friend"]' WHERE user_id = 'user_before_reset'`);
			}
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
			// Users whose passkeys were carried keep their roles (an older schema's admin list as `admin`).
			expect(store.getIdentity('user_before_reset')?.roles).toEqual(storedVersion < SCHEMA_VERSION ? ['admin'] : ['admin', 'friend']);
			expect(store.getIdentity('user_left_general')?.roles).toEqual([]);
			expect(sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM _meta WHERE key = 'admins'").one().n).toBe(0);
			expect(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM message_state').one().n).toBe(0);
			expect((await state.storage.list({ prefix: 'session:' })).size).toBe(0);
			const general = store.getRoomState();
			expect(general).toEqual({ room_id: 'general', log_id: general.log_id, title: 'General', latest_log_id: general.log_id, history_log_id: general.log_id });
			expect(store.listRooms()).toEqual([general]);
			expect(store.getIdentity('user_before_reset')).toEqual({
				userId: 'user_before_reset', name: 'Before', userHandle: 'handle', credentialCount: 1, rooms: ['general'],
				roles: storedVersion < SCHEMA_VERSION ? ['admin'] : ['admin', 'friend'],
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

it('upgrades a schema 5 store in place: intro messages become descriptions, and nothing else is lost', async () => {
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
		const plain = String(mutate('plain', 'message', { body: { text: 'Use *nix boxes_only_ for builds\n# not a heading', format: 'plain' } }).result.message_id);
		const thread = String(mutate('thread', 'room_set', { parent_room_id: 'general', title: 'Deploy' }).result.room_id);
		const saved = mutate('save', 'room_set', { room_id: thread, title: 'Deploys' }).room!.log_id;
		const deletedThread = String(mutate('thread-2', 'room_set', { parent_room_id: 'general', title: 'Gone' }).result.room_id);
		const longThread = String(mutate('thread-3', 'room_set', { parent_room_id: 'general', title: 'Long' }).result.room_id);
		const longSaved = mutate('save-3', 'room_set', { room_id: longThread, title: 'Long', ext: { note: 'x'.repeat(40) } }).room!.log_id;
		const plainThread = String(mutate('thread-4', 'room_set', { parent_room_id: 'general', title: 'Plain' }).result.room_id);
		// The intro was edited after the room last embedded it, and one intro was deleted.
		mutate('edit', 'message', { message_id: intro, body: { text: 'Deploy chatter, *edited*', format: 'markdown' } });
		mutate('delete', 'message', { message_id: gone, deleted: true });
		await state.storage.put('session:kept', { v: 1, userId: 'upgrader', origin: 'http://localhost:5173', expiresMs: now + 60_000 });
		const head = store.getRoomState().latest_log_id;

		// Rewind to schema 5's shape: rooms point at intro messages and have no
		// member_count, and logged room records embed the intro's snapshot.
		const snapshotOf = (text: string, messageId: string) => ({ message_id: messageId, log_id: messageId, room_id: 'general', from: identity, body: { text, format: 'plain' } });
		sql.exec('ALTER TABLE rooms ADD COLUMN intro_message_id TEXT');
		// Nor roles (schema 7).
		sql.exec('ALTER TABLE identities DROP COLUMN roles_json');
		sql.exec('ALTER TABLE rooms DROP COLUMN member_count');
		// Schema 5 allowed one passkey per identity.
		sql.exec('ALTER TABLE credentials RENAME TO credentials_old');
		sql.exec('DROP INDEX credentials_user_idx');
		sql.exec('CREATE TABLE credentials (credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, public_key_json TEXT NOT NULL, sign_count INTEGER NOT NULL, transports_json TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)');
		sql.exec('CREATE INDEX credentials_user_idx ON credentials (user_id)');
		sql.exec('INSERT INTO credentials SELECT * FROM credentials_old');
		sql.exec('DROP TABLE credentials_old');
		for (const [room, message] of [[thread, intro], [deletedThread, gone], [longThread, long], [plainThread, plain]]) {
			sql.exec('UPDATE rooms SET intro_message_id = ? WHERE room_id = ?', message, room);
		}
		const rewrite = (room: string, logId: string, text: string, messageId: string) => {
			const record = JSON.parse(sql.exec<{ record_json: string }>("SELECT record_json FROM records WHERE room_id = ? AND log_id = ?", room, Number(logId)).one().record_json);
			sql.exec("UPDATE records SET record_json = ? WHERE room_id = ? AND log_id = ?", JSON.stringify({ ...record, intro_message: snapshotOf(text, messageId) }), room, Number(logId));
		};
		rewrite(thread, thread, 'Old intro text', intro);
		rewrite(thread, saved, 'Deploy chatter', intro);
		rewrite(deletedThread, deletedThread, 'soon deleted', gone);
		// The long thread's older and current records both embed the long intro.
		rewrite(longThread, longThread, 'é'.repeat(2_000), long);
		rewrite(longThread, longSaved, 'é'.repeat(2_000), long);
		sql.exec("UPDATE _meta SET value = '5' WHERE key = 'schema_version'");
		sql.exec('UPDATE maintenance SET schema_version = 5 WHERE id = 1');
		const budget = sql.exec<{ maintenance_reads: number; maintenance_writes: number }>('SELECT maintenance_reads, maintenance_writes FROM resource_budgets WHERE day = ?', day).one();
		return { thread, saved, deletedThread, longThread, longSaved, plainThread, budget, head };
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
		// An identity may now hold several passkeys (§4.9).
		store.addCredential({ userId: 'upgrader', userHandle: 'handle', now: Date.now(), ipKey: 'upgrade-ip-2', credential: { credentialId: 'cred-second', userId: 'upgrader', publicKey: 'BBBB', counter: 0 } });
		expect(store.getIdentity('upgrader')?.credentialCount).toBe(2);
		expect(sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'credentials'").toArray().map((row) => row.name)).toContain('credentials_user_idx');
		expect(await state.storage.get('session:kept')).toMatchObject({ userId: 'upgrader' });

		// Rooms take their intro message's current text as their description.
		const rooms = new Map(store.listRooms().map((room) => [room.room_id, room]));
		expect(rooms.get(fixture.thread)).toMatchObject({ title: 'Deploys', description: 'Deploy chatter, *edited*' });
		expect(rooms.get(fixture.deletedThread)).not.toHaveProperty('description');
		const cut = rooms.get(fixture.longThread)!.description!;
		const ext = { note: 'x'.repeat(40) };
		const bytes = (fields: unknown) => new TextEncoder().encode(JSON.stringify(fields)).length;
		expect(cut.endsWith('…')).toBe(true);
		expect(bytes({ title: 'Long', description: cut, ext })).toBeLessThanOrEqual(2_048);
		expect(bytes({ title: 'Long', description: cut + 'é', ext })).toBeGreaterThan(2_048);
		// The room's current record at the same log_id says exactly what the listing does (§2);
		// its older record is cut against its own client fields alone.
		const longHistory = store.historyPage({ roomId: fixture.longThread, after: '0', limit: 50 }).rooms!;
		expect(longHistory.map((room) => room.log_id)).toEqual([fixture.longThread, fixture.longSaved]);
		expect(longHistory[1].description).toBe(cut);
		expect(bytes({ title: 'Long', description: longHistory[0].description })).toBeLessThanOrEqual(2_048);
		expect(bytes({ title: 'Long', description: longHistory[0].description + 'é' })).toBeGreaterThan(2_048);
		// A plain-text intro is escaped, since a description is Markdown by convention.
		expect(rooms.get(fixture.plainThread)!.description).toBe('Use \\*nix boxes\\_only\\_ for builds\n\\# not a heading');
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
		expect(counts).toEqual({ general: 1, [fixture.thread]: 1, [fixture.deletedThread]: 1, [fixture.longThread]: 1, [fixture.plainThread]: 1 });

		// The upgrade's rows are charged to the day's maintenance reservation.
		const budget = sql.exec<{ maintenance_reads: number; maintenance_writes: number }>('SELECT maintenance_reads, maintenance_writes FROM resource_budgets WHERE day = ?', day).one();
		expect(budget.maintenance_reads).toBeGreaterThan(fixture.budget.maintenance_reads);
		expect(budget.maintenance_writes).toBeGreaterThan(fixture.budget.maintenance_writes);
	});

	// A later wake finds the current schema and changes nothing.
	await evictDurableObject(stub);
	await runInDurableObject(stub, (instance, state) => {
		const { store } = instance as unknown as Runtime;
		expect(store.requiresReset()).toBe(false);
		expect(state.storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'").one().value).toBe(String(SCHEMA_VERSION));
	});
});

it('upgrades a schema 6 store in place: roles move into identities, and nothing else is lost', async () => {
	const stub = env.DEMO.getByName(`schema-upgrade-6-${crypto.randomUUID()}`);
	const now = Date.now();
	const head = await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		for (const userId of ['listed_admin', 'plain_user']) {
			store.registerIdentity({
				userId, name: userId, userHandle: `handle-${userId}`, now, ipKey: `ip-${userId}`,
				credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
			});
		}
		store.mutate({
			userId: 'plain_user', ipKey: 'ip-plain_user', requestId: 'kept', method: 'message', now,
			identity: { user_id: 'plain_user' }, params: { room_id: 'general', body: { text: 'kept' } },
		});
		// Schema 6: no roles column; bots by tier, admins in a `_meta` list.
		sql.exec('ALTER TABLE identities DROP COLUMN roles_json');
		sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms) VALUES ('bot_plain_user', '', 'Bot', 'bot', 1, 1)");
		sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms) VALUES ('admin', '', 'Admin', 'registered', 1, 1)");
		sql.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('admins', ?)", JSON.stringify(['listed_admin', 'gone_user']));
		sql.exec("UPDATE _meta SET value = '6' WHERE key = 'schema_version'");
		sql.exec('UPDATE maintenance SET schema_version = 6 WHERE id = 1');
		return store.getRoomState().latest_log_id;
	});

	await evictDurableObject(stub);
	await runInDurableObject(stub, async (instance, state) => {
		const { store } = instance as unknown as Runtime;
		const sql = state.storage.sql;
		expect(store.requiresReset()).toBe(false);
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'").one().value).toBe(String(SCHEMA_VERSION));
		expect(store.getRoomState().latest_log_id).toBe(head);
		expect(store.getIdentity('listed_admin')?.roles).toEqual(['admin']);
		expect(store.getIdentity('plain_user')?.roles).toEqual([]);
		expect(store.getIdentity('bot_plain_user')?.roles).toEqual(['bot']);
		expect(store.getIdentity('admin')?.roles).toEqual(['admin']);
		expect(sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM _meta WHERE key = 'admins'").one().n).toBe(0);
	});
});

it('upgrades a schema 7 store in place: it gains the push and user status tables, and nothing else changes', async () => {
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
		// Schema 7 has no push registrations, wake times, user status or room mutes.
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
		expect(store.pushSubscriptionsOf('kept_user')).toEqual([]);
		expect(store.statusInputs('kept_user')).toEqual({ choice: 'online', roomMutes: [] });
	});
});
