import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { MAX_THREAD_LIMIT } from '../src/budget';

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
