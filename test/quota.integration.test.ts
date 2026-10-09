import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { Store } from '../src/store';
import { expectRetryAfter } from './helpers/store';

const DAY = 86_400_000;

it('shares an anonymous rolling window across identities and calendar-minute boundaries', async () => {
	await runInDurableObject(env.DEMO.getByName('quota-rolling-minute'), (_instance, state) => {
		let now = (Math.floor(Date.now() / DAY) + 1) * DAY + 119_000;
		const store = new Store(state, {}, { now: () => now });
		const post = (userId: string) => store.mutate({ userId, ipKey: 'shared-nat', method: 'message', now,
			identity: { user_id: userId }, params: { room_id: 'general', body: { text: 'bounded' } } });
		for (let index = 0; index < 5; index++) post(`guest-${index}`);
		now += 1_001;
		try { post('fresh-guest'); expect.unreachable(); }
		catch (error) { expectRetryAfter(error); expect(error.retryAfterMs).toBe(58_999); }
		now += 59_000;
		expect(post('fresh-guest').result.message_id).toBeTruthy();
	});
});

it('uses durable registered identities for twenty posts while preserving the aggregate IP cap', async () => {
	await runInDurableObject(env.DEMO.getByName('quota-registered-ip'), (_instance, state) => {
		const now = (Math.floor(Date.now() / DAY) + 1) * DAY + 43_200_000;
		const store = new Store(state, {}, { now: () => now });
		// Identity fixtures exercise policy only; signed ceremonies are tested in
		// auth.integration.test.ts and the browser against the real verifier.
		for (const userId of ['registered-a', 'registered-b']) store.registerIdentity({
			userId, name: userId, userHandle: userId, ipKey: 'shared-nat', now,
			credential: { credentialId: userId, userId, publicKey: 'fixture-policy-only', counter: 0 },
		});
		const post = (userId: string) => store.mutate({ userId, ipKey: 'shared-nat', method: 'message', now,
			identity: { user_id: userId }, params: { room_id: 'general', body: { text: 'bounded' } } });
		for (let index = 0; index < 20; index++) post('registered-a');
		expect(() => post('registered-a')).toThrow('Posting limit reached');
		for (let index = 0; index < 10; index++) post('registered-b');
		expect(() => post('registered-b')).toThrow('Posting limit reached');
	});
});

it('gives admins, mods and threaders the moderator posting limits, for their IP too, under the global ones', async () => {
	await runInDurableObject(env.DEMO.getByName('quota-moderator'), (_instance, state) => {
		const now = (Math.floor(Date.now() / DAY) + 1) * DAY + 43_200_000;
		// A global minute limit that two moderators' 50 each nearly fill.
		const store = new Store(state, { globalPostsPerMinute: 110 }, { now: () => now });
		for (const userId of ['mod', 'threader', 'admin-user', 'member']) store.registerIdentity({
			userId, name: userId, userHandle: userId, ipKey: `${userId}-ip`, now,
			credential: { credentialId: userId, userId, publicKey: 'fixture-policy-only', counter: 0 },
		});
		store.setRole({ userId: 'mod', role: 'mod', on: true, now });
		store.setRole({ userId: 'threader', role: 'threader', on: true, now });
		store.setRole({ userId: 'admin-user', role: 'admin', on: true, now });
		const post = (userId: string, ipKey = `${userId}-ip`) => store.mutate({ userId, ipKey, method: 'message', now,
			identity: { user_id: userId }, params: { room_id: 'general', body: { text: 'bounded' } } });
		// Past the registered 20 and the IP's 30, up to the moderator 50.
		for (let index = 0; index < 50; index++) post('mod');
		expect(() => post('mod')).toThrow('Posting limit reached');
		for (let index = 0; index < 50; index++) post('threader');
		expect(() => post('threader')).toThrow('Posting limit reached');
		// The global 110 still holds: the admin gets the 10 left.
		for (let index = 0; index < 10; index++) post('admin-user');
		expect(() => post('admin-user')).toThrow('Posting limit reached');
	});
	await runInDurableObject(env.DEMO.getByName('quota-moderator-role-removed'), (_instance, state) => {
		const now = (Math.floor(Date.now() / DAY) + 1) * DAY + 43_200_000;
		const store = new Store(state, {}, { now: () => now });
		store.registerIdentity({
			userId: 'mod', name: 'mod', userHandle: 'mod', ipKey: 'mod-ip', now,
			credential: { credentialId: 'mod', userId: 'mod', publicKey: 'fixture-policy-only', counter: 0 },
		});
		store.setRole({ userId: 'mod', role: 'mod', on: true, now });
		const post = () => store.mutate({ userId: 'mod', ipKey: 'mod-ip', method: 'message', now,
			identity: { user_id: 'mod' }, params: { room_id: 'general', body: { text: 'bounded' } } });
		for (let index = 0; index < 20; index++) post();
		// Without the role, the registered limit applies again.
		store.setRole({ userId: 'mod', role: 'mod', on: false, now });
		expect(() => post()).toThrow('Posting limit reached');
	});
});

it('returns the longest applicable retry window and never replenishes on a backward clock', async () => {
	await runInDurableObject(env.DEMO.getByName('quota-retry-reset'), (_instance, state) => {
		let now = (Math.floor(Date.now() / DAY) + 1) * DAY + 43_200_000;
		const store = new Store(state, { anonymousPostsPerMinute: 1, anonymousPostsPerDay: 1 }, { now: () => now });
		const post = () => store.mutate({ userId: 'guest', ipKey: 'nat', method: 'message', now,
			identity: { user_id: 'guest' }, params: { room_id: 'general', body: { text: 'bounded' } } });
		post();
		now -= 60_000;
		try { post(); expect.unreachable(); }
		catch (error) { expectRetryAfter(error); expect(error.retryAfterMs).toBe(43_200_000); }
		now += 43_260_001;
		expect(post().result.message_id).toBeTruthy();
	});
});
