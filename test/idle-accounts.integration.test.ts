import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { MUTE_FOREVER, Store } from '../src/store';

const day = 86_400_000;

/** A store with `config`, over its own object, on a fixed clock. */
async function withStore<T>(name: string, config: Record<string, number>, fn: (store: Store, sql: SqlStorage, clock: { now: number }) => T): Promise<T> {
	return runInDurableObject(env.DEMO.getByName(name), (_instance, state) => {
		const clock = { now: Date.now() };
		const store = new Store(state, config, { now: () => clock.now });
		store.initialize();
		return fn(store, state.storage.sql, clock);
	});
}

function seed(sql: SqlStorage, now: number) {
	return (id: string, active: { created: number; seen?: number; updated?: number; passkeyUsed?: number; roles?: string; passkey?: boolean }) => {
		const updated = active.updated ?? active.created;
		sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms, roles_json, seen_ms) VALUES (?, ?, ?, 'registered', ?, ?, ?, ?)",
			id, `h-${id}`, id, now - active.created, now - updated, active.roles ?? '[]', active.seen === undefined ? 0 : now - active.seen);
		if (active.passkey !== false) {
			sql.exec("INSERT INTO credentials (credential_id, user_id, public_key_json, sign_count, transports_json, created_ms, updated_ms) VALUES (?, ?, '{}', 0, '[]', ?, ?)",
				`c-${id}`, id, now - active.created, now - (active.passkeyUsed ?? active.created));
		}
		sql.exec("INSERT OR IGNORE INTO memberships (room_id, user_id) VALUES ('general', ?)", id);
		sql.exec("UPDATE rooms SET member_count = member_count + 1 WHERE room_id = 'general'");
		sql.exec("UPDATE _meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'identity_count'");
	};
}

it('removes accounts idle past the cutoff, whatever their first day, with their bots, and keeps every active one', async () => {
	await withStore('idle-prune', { idleAccountMs: 30 * day, keptActiveAccounts: 1 }, (store, sql, clock) => {
		const now = clock.now;
		sql.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('identity_count', '0')");
		const user = seed(sql, now);
		// Idle: gone, however they used their first days, a status or mute included.
		user('idle', { created: 90 * day, seen: 40 * day });
		user('muted', { created: 90 * day, seen: 60 * day });
		sql.exec("INSERT INTO user_status (user_id, status, mute_until_ms) VALUES ('muted', 'dnd', ?)", now - 50 * day);
		user('invited', { created: 60 * day, passkey: false });
		user('owner', { created: 60 * day, seen: 50 * day });
		sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms, roles_json, seen_ms) VALUES ('bot_owner', '', 'bot', 'registered', ?, 0, '[\"bot\"]', 0)", now - 50 * day);
		// Active, one way or another: kept.
		user('seen', { created: 60 * day, seen: 2 * day });
		user('passkey', { created: 60 * day, passkeyUsed: 3 * day });
		user('resumed', { created: 60 * day, updated: day });
		user('new', { created: 2 * day });
		user('botter', { created: 60 * day, seen: 50 * day });
		sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms, roles_json, seen_ms) VALUES ('bot_botter', '', 'bot', 'registered', ?, ?, '[\"bot\"]', 0)", now - 50 * day, now - day);
		// Idle but exempt: a role, a live upload, connected now.
		user('moderator', { created: 90 * day, seen: 80 * day, roles: '["mod"]' });
		user('uploader', { created: 90 * day, seen: 80 * day });
		sql.exec("INSERT INTO uploads (upload_key, owner_id, purpose, message_id, embed_id, state, bytes, write_expires_ms, expires_ms, created_ms) VALUES ('a/x', 'uploader', 'avatar', NULL, 'e', 'done', 1, 0, ?, ?)", now + day, now);
		user('online', { created: 90 * day, seen: 80 * day });
		// The most recently active is always kept: here `new`, which is active anyway.
		const result = store.pruneIdleIdentities(now, new Set(['online']));
		expect(new Set(result.pruned)).toEqual(new Set(['idle', 'muted', 'invited', 'owner', 'bot_owner']));
		expect(result.more).toBe(false);
		const left = sql.exec<{ user_id: string }>('SELECT user_id FROM identities').toArray().map((row) => row.user_id);
		expect(new Set(left)).toEqual(new Set(['seen', 'passkey', 'resumed', 'new', 'botter', 'bot_botter', 'moderator', 'uploader', 'online']));
		expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM user_status WHERE user_id = 'muted'").one().count).toBe(0);
		// Retired for retiredUserIdMs, from now.
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'purged:idle'").one().value).toBe(String(now));
		expect(store.idlePruned(now)).toEqual({ today: 5, total: 5 });
		// Once a UTC day.
		user('later', { created: 90 * day, seen: 80 * day });
		expect(store.pruneIdleIdentities(now, new Set(['online'])).pruned).toEqual([]);
		expect(store.pruneIdleIdentities(now + day, new Set(['online'])).pruned).toEqual(['later']);
	});
});

it('always keeps the keptActiveAccounts most recently active, however idle', async () => {
	await withStore('idle-keep', { idleAccountMs: 30 * day, keptActiveAccounts: 2 }, (store, sql, clock) => {
		const user = seed(sql, clock.now);
		user('oldest', { created: 300 * day, seen: 200 * day });
		user('older', { created: 300 * day, seen: 100 * day });
		user('old', { created: 300 * day, seen: 50 * day });
		expect(store.pruneIdleIdentities(clock.now).pruned).toEqual(['oldest']);
	});
});

it('frees retired user ids after retiredUserIdMs, in two steps, a marker without its time starting now', async () => {
	await withStore('retired-ids', { retiredUserIdMs: 7 * day }, (store, sql, clock) => {
		const now = clock.now;
		sql.exec("INSERT INTO _meta (key, value) VALUES ('purged:fresh', ?), ('purged:stale', ?), ('purged:legacy', '1'), ('renamed:kept', '1')", String(now - day), String(now - 8 * day));
		const markers = () => Object.fromEntries(sql.exec<{ key: string; value: string }>("SELECT key, value FROM _meta WHERE key LIKE 'purged:%' OR key LIKE 'renamed:%'").toArray().map((row) => [row.key, row.value]));
		// The due ids, still retired until the caller has revoked their tokens and frees them.
		expect(store.dueRetiredUserIds(now)).toEqual(['stale']);
		expect(store.userIdTaken('stale')).toBe(true);
		expect(markers()).toEqual({ 'purged:fresh': String(now - day), 'purged:stale': String(now - 8 * day), 'purged:legacy': String(now), 'renamed:kept': '1' });
		store.freeRetiredUserIds(['stale'], now);
		expect(store.userIdTaken('stale')).toBe(false);
		const later = now + 7 * day + 1;
		const due = store.dueRetiredUserIds(later);
		expect(new Set(due)).toEqual(new Set(['fresh', 'legacy']));
		store.freeRetiredUserIds(due, later);
		expect(markers()).toEqual({ 'renamed:kept': '1' });
	});
});

it('prunes a batch past SQLite\'s 100 bound parameters, and keeps the owner of a connected bot', async () => {
	await withStore('idle-many', { idleAccountMs: 30 * day, keptActiveAccounts: 1 }, (store, sql, clock) => {
		const user = seed(sql, clock.now);
		for (let index = 0; index < 80; index++) {
			user(`many-${index}`, { created: 90 * day, seen: 60 * day });
			sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms, roles_json, seen_ms) VALUES (?, '', 'bot', 'registered', ?, 0, '[\"bot\"]', 0)", `bot_many-${index}`, clock.now - 60 * day);
		}
		user('recent', { created: day });
		const result = store.pruneIdleIdentities(clock.now, new Set(['bot_many-0']));
		// 79 owners and their bots; many-0's bot is connected, so many-0 stays.
		expect(result.pruned).toHaveLength(158);
		expect(result.pruned).not.toContain('many-0');
		expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM identities WHERE user_id LIKE '%many-%'").one().count).toBe(2);
	});
});

it('clears mutes that ran out, keeping a chosen status and mutes still running', async () => {
	await withStore('expired-mutes', {}, (store, sql, clock) => {
		const now = clock.now;
		sql.exec("INSERT INTO user_status (user_id, status, mute_until_ms) VALUES ('a', 'online', ?), ('b', 'dnd', ?), ('c', 'online', ?), ('d', 'online', ?)", now - 1, now - 1, now + day, MUTE_FOREVER);
		sql.exec("INSERT INTO room_mutes (user_id, room_id, mute_until_ms) VALUES ('a', 'general', ?), ('b', 'general', ?)", now - 1, MUTE_FOREVER);
		// a's and b's mutes cleared, a's row then empty and deleted, a's room mute deleted.
		expect(store.clearExpiredMutes(now)).toBe(4);
		expect(sql.exec("SELECT user_id, status, mute_until_ms FROM user_status ORDER BY user_id").toArray()).toEqual([
			{ user_id: 'b', status: 'dnd', mute_until_ms: null },
			{ user_id: 'c', status: 'online', mute_until_ms: now + day },
			{ user_id: 'd', status: 'online', mute_until_ms: MUTE_FOREVER },
		]);
		expect(sql.exec("SELECT user_id FROM room_mutes").toArray()).toEqual([{ user_id: 'b' }]);
	});
});

it('records a sign-in as activity at most once a day, and never revives a signed-out bot', async () => {
	await withStore('note-active', {}, (store, sql, clock) => {
		const now = clock.now;
		seed(sql, now)('person', { created: 10 * day, updated: 3 * day });
		sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms, roles_json, seen_ms) VALUES ('bot_person', '', 'bot', 'registered', ?, 0, '[\"bot\"]', 0)", now - day);
		const updated = (id: string) => sql.exec<{ updated_ms: number }>('SELECT updated_ms FROM identities WHERE user_id = ?', id).one().updated_ms;
		store.noteActive('person', now);
		expect(updated('person')).toBe(now);
		store.noteActive('person', now + 60_000);
		expect(updated('person')).toBe(now);
		store.noteActive('bot_person', now);
		expect(updated('bot_person')).toBe(0);
	});
});

it('revokes every token of a retired id, and of its bot, before freeing it', async () => {
	await runInDurableObject(env.DEMO.getByName('retired-tokens'), async (instance, state) => {
		const runtime = instance as unknown as { pruneIdle(now: number): Promise<void>; store: Store; upkeepDay: string };
		const now = Date.now();
		const retired = now - 30 * day;
		state.storage.sql.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('purged:gone', ?)", String(retired));
		await state.storage.put('invite:gone', { v: 1, tokenKey: 'invite-token:abc' });
		await state.storage.put('invite-token:abc', { v: 1, userId: 'gone' });
		await state.storage.put('bot:bot_gone', { v: 1, tokenKey: 'bot-token:def' });
		await state.storage.put('bot-token:def', { v: 1, userId: 'bot_gone' });
		runtime.upkeepDay = '';
		await runtime.pruneIdle(now);
		for (const key of ['invite:gone', 'invite-token:abc', 'bot:bot_gone', 'bot-token:def']) expect(await state.storage.get(key)).toBeUndefined();
		expect(runtime.store.userIdTaken('gone')).toBe(false);
	});
});
