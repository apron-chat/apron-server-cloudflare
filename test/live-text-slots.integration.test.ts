import { expect, it } from 'vitest';
import { LIVE_TEXT_POLICY } from '../src/budget';
import { type StoreLiveTextConfig } from '../src/store';
import { withStore } from './helpers/store';

const LIVE: StoreLiveTextConfig = { ...LIVE_TEXT_POLICY!, publicOrigin: 'https://demo.test', enabled: true, concurrent: 1 };

it('frees a live text\'s slots once its write_url expires, before the alarm ends its message', async () => {
	await withStore('live-slots', { liveText: LIVE }, (store, clock) => {
		for (const userId of ['owner', 'other']) {
			store.registerIdentity({
				userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: clock.value, ipKey: `ip-${userId}`,
				credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
			});
		}
		const post = (userId: string) => store.commitMutation({
			userId, ipKey: `ip-${userId}`, method: 'message', now: clock.value,
			params: { body: { text: 'waits', embeds: [{ kind: 'terminal' }] } }, identity: { user_id: userId },
		});
		post('owner');
		// Within the window it holds both the owner's one slot and the server's only one.
		expect(() => post('owner')).toThrow(/already have a live text open/);
		expect(() => post('other')).toThrow(/busy on this server/);
		// Past it, nothing can claim the write: the slots are free, though no alarm has run.
		clock.value += LIVE.writeWindowSeconds * 1_000 + 1;
		expect(store.openLiveTexts(clock.value)).toHaveLength(1);
		post('owner');
		expect(store.openLiveTexts(clock.value)).toHaveLength(2);
		// The alarm still ends the expired one's message.
		const expired = store.expireLiveTexts(new Set(), clock.value);
		expect(expired.ended).toHaveLength(1);
	});
});
