import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { MAX_THREAD_LIMIT } from '../src/budget';
import { withStore } from './helpers/store';

it('/rename stays within its reservation with the most membership rows a user can have', async () => {
	await runInDurableObject(env.DEMO.getByName(`rename-cost-${crypto.randomUUID()}`), (instance, state) => {
		const { store } = instance as unknown as { store: {
			registerIdentity(input: Record<string, unknown>): unknown;
			renameIdentity(input: { from: string; to: string }): { rooms: string[] };
			accountingStatus(): { unsafe: boolean };
		} };
		store.registerIdentity({
			userId: 'big_1', name: 'Big', userHandle: 'h', now: Date.now(), ipKey: 'ip',
			credential: { credentialId: 'c-big', userId: 'big_1', publicKey: 'AAAA', counter: 0 },
		});
		// `general` plus one row per other room and per removed room awaiting purge.
		for (let n = 0; n < 2 * MAX_THREAD_LIMIT; n++) {
			state.storage.sql.exec('INSERT INTO memberships (room_id, user_id) VALUES (?, ?)', `room_${n}`, 'big_1');
		}
		expect(store.renameIdentity({ from: 'big_1', to: 'big_2' }).rooms).toEqual(['general']);
		expect(store.accountingStatus().unsafe).toBe(false);
	});
});

it('/rename and /purge reserve by the records retained, not by how old the oldest one is', async () => {
	await withStore('rename-old-log', {}, (store, clock) => {
		store.registerIdentity({
			userId: 'old_1', name: 'Old', userHandle: 'h-old', now: clock.value, ipKey: 'ip',
			credential: { credentialId: 'c-old', userId: 'old_1', publicKey: 'AAAA', counter: 0 },
		});
		const post = (requestId: string) => store.mutate({
			userId: 'old_1', ipKey: 'ip', requestId, method: 'message', now: clock.value,
			params: { room_id: 'general', body: { text: requestId } }, identity: { user_id: 'old_1', name: 'Old' },
		});
		post('first');
		// A log id is a commit time: days apart, two records span billions of ids.
		clock.value += 6 * 86_400_000;
		post('second');
		expect(store.renameIdentity({ from: 'old_1', to: 'old_2', now: clock.value }).rooms).toEqual(['general']);
		expect(store.purgeUsers({ userIds: ['old_2'], now: clock.value }).messages).toBe(2);
		expect(store.accountingStatus().unsafe).toBe(false);
	});
});

it('/purge, an admin command, is charged to the day\'s budget but not refused by it', async () => {
	await withStore('purge-unchecked', { foregroundWritesPerDay: 1_500 }, (store, clock) => {
		store.registerIdentity({
			userId: 'gone_1', name: 'Gone', userHandle: 'h-gone', now: clock.value, ipKey: 'ip',
			credential: { credentialId: 'c-gone', userId: 'gone_1', publicKey: 'AAAA', counter: 0 },
		});
		store.mutate({
			userId: 'gone_1', ipKey: 'ip', requestId: 'post', method: 'message', now: clock.value,
			params: { room_id: 'general', body: { text: 'bye' } }, identity: { user_id: 'gone_1', name: 'Gone' },
		});
		// Its reservation alone is past the day's foreground writes.
		expect(store.purgeUsers({ userIds: ['gone_1'], now: clock.value }).messages).toBe(1);
		expect(store.accountingStatus().unsafe).toBe(false);
	});
});
