import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { DORMANT_AFTER_MS, Store } from '../src/store';

const day = 86_400_000;

it('removes accounts nobody came back to, and keeps every account in use', async () => {
	await runInDurableObject(env.DEMO.getByName('dormant-prune'), (_instance, state) => {
		const now = Date.now();
		const clock = { now };
		const store = new Store(state, {}, { now: () => clock.now });
		store.initialize();
		const sql = state.storage.sql;
		const signedUp = now - DORMANT_AFTER_MS - day;
		const user = (id: string, created: number, seen: number, roles = '[]', used = created) => {
			sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms, roles_json, seen_ms) VALUES (?, ?, ?, 'registered', ?, ?, ?, ?)", id, `h-${id}`, id, created, created, roles, seen);
			sql.exec("INSERT INTO credentials (credential_id, user_id, public_key_json, sign_count, transports_json, created_ms, updated_ms) VALUES (?, ?, '{}', 0, '[]', ?, ?)", `c-${id}`, id, created, used);
			sql.exec("INSERT OR IGNORE INTO memberships (room_id, user_id) VALUES ('general', ?)", id);
		};
		const before = sql.exec<{ member_count: number }>("SELECT member_count FROM rooms WHERE room_id = 'general'").one().member_count;
		sql.exec("UPDATE rooms SET member_count = member_count + 8 WHERE room_id = 'general'");
		sql.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('identity_count', '8')");
		user('passerby', signedUp, signedUp + 60_000);
		user('never-offline', signedUp, 0);
		user('came-back', signedUp, signedUp + 5 * day);
		user('passkey-later', signedUp, signedUp + 60_000, '[]', signedUp + 10 * day);
		user('recent', now - 2 * day, now - 2 * day);
		user('moderator', signedUp, signedUp, '["mod"]');
		user('subscribed', signedUp, signedUp);
		sql.exec("INSERT INTO push_subscriptions (user_id, url, p256dh, auth, push_id, wake, created_ms, updated_ms) VALUES ('subscribed', 'https://push.example/1', 'k', 'a', 'p', 0, ?, ?)", signedUp, signedUp);
		user('online', signedUp, signedUp);
		const result = store.pruneDormantIdentities(now, new Set(['online']));
		expect(result).toEqual({ pruned: expect.arrayContaining(['passerby', 'never-offline']), more: false });
		expect(result.pruned).toHaveLength(2);
		const left = sql.exec<{ user_id: string }>('SELECT user_id FROM identities ORDER BY user_id').toArray().map((row) => row.user_id);
		expect(left).toEqual(expect.arrayContaining(['came-back', 'passkey-later', 'recent', 'moderator', 'subscribed', 'online']));
		expect(left).not.toContain('passerby');
		for (const table of ['credentials', 'memberships']) {
			expect(sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id IN ('passerby', 'never-offline')`).one().count).toBe(0);
		}
		expect(sql.exec<{ member_count: number }>("SELECT member_count FROM rooms WHERE room_id = 'general'").one().member_count).toBe(before + 6);
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'identity_count'").one().value).toBe('6');
		// Retired, as /purge retires them: the user_id is never issued again.
		expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM _meta WHERE key IN ('purged:passerby', 'purged:never-offline')").one().count).toBe(2);
		expect(store.dormantPruned(now)).toEqual({ today: 2, total: 2 });
		expect(store.pruneDormantIdentities(now, new Set(['online']))).toEqual({ pruned: [], more: false });
	});
});
