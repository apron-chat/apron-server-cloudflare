import { expect, it } from 'vitest';
import { LIVE_TEXT_POLICY } from '../src/budget';
import { type StoreLiveTextConfig } from '../src/store/config';
import { openStore } from '../src/store';
import { withStore } from './helpers/store';

const LIVE: StoreLiveTextConfig = { ...LIVE_TEXT_POLICY!, publicOrigin: 'https://demo.test', enabled: true, concurrent: 1 };

it('frees a live text\'s slots once its write_url expires, before the alarm ends its message', async () => {
	await withStore('live-slots', { liveText: LIVE }, (store, clock) => {
		for (const userId of ['owner', 'other']) {
			store.accounts.register({
				userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: clock.value, ipKey: `ip-${userId}`,
				credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
			});
		}
		const post = (userId: string) => store.messages.commit({
			userId, ipKey: `ip-${userId}`, method: 'message', now: clock.value,
			params: { body: { text: 'waits', embeds: [{ kind: 'terminal' }] } }, identity: { user_id: userId },
		});
		post('owner');
		// Within the window it holds both the owner's one slot and the server's only one.
		expect(() => post('owner')).toThrow(/already have a live text open/);
		expect(() => post('other')).toThrow(/busy on this server/);
		// Past it, nothing can claim the write: the slots are free, though no alarm has run.
		clock.value += LIVE.writeWindowSeconds * 1_000 + 1;
		expect(store.liveText!.open(clock.value)).toHaveLength(1);
		post('owner');
		expect(store.liveText!.open(clock.value)).toHaveLength(2);
		// The alarm still ends the expired one's message.
		const expired = store.liveText!.expire(new Set(), clock.value);
		expect(expired.ended).toHaveLength(1);
	});
});

it('rewrites no message below the retention floor that cleanup has not yet deleted', async () => {
	await withStore('live-floor', { liveText: LIVE }, (store, clock, state) => {
		store.accounts.register({
			userId: 'owner', name: 'Owner', userHandle: 'handle-owner', now: clock.value, ipKey: 'ip-owner',
			credential: { credentialId: 'cred-owner', userId: 'owner', publicKey: 'AAAA', counter: 0 },
		});
		const posted = store.messages.commit({
			userId: 'owner', ipKey: 'ip-owner', method: 'message', now: clock.value,
			params: { body: { text: 'waits', embeds: [{ kind: 'terminal' }] } }, identity: { user_id: 'owner' },
		});
		const key = (posted.result.embeds as Array<{ write: { key: string } }>)[0].write.key;
		const latest = () => Number(state.storage.sql.exec<{ latest_log_id: number }>('SELECT latest_log_id FROM message_state WHERE message_id = ?', posted.result.message_id).one().latest_log_id);
		const before = latest();
		// Cleanup has moved the floor past the message (its first step), and not yet deleted it (the next).
		state.storage.sql.exec('UPDATE log_state SET history_floor = ? WHERE id = 1', before + 1);
		const fresh = openStore(state, { liveText: LIVE }, clock.clock);
		fresh.lifecycle.initialize();
		const claimed = fresh.liveText!.claim(key, clock.value);
		expect(claimed?.broadcasts ?? []).toEqual([]);
		expect(latest()).toBe(before);
	});
});
