import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Store, StoreError } from '../src/store';
import { expectRetryAfter } from './helpers/store';

const DAY = 86_400_000;

it('shares an anonymous allowance across identities and calendar-minute boundaries: a burst, then one post a step', async () => {
	await runInDurableObject(env.DEMO.getByName('quota-rolling-minute'), (_instance, state) => {
		let now = (Math.floor(Date.now() / DAY) + 1) * DAY + 119_000;
		const store = new Store(state, {}, { now: () => now });
		const post = (userId: string) => store.mutate({ userId, ipKey: 'shared-nat', method: 'message', now,
			identity: { user_id: userId }, params: { room_id: 'general', body: { text: 'bounded' } } });
		for (let index = 0; index < 5; index++) post(`guest-${index}`);
		now += 1_001;
		// Five a minute drain one every 12 s: the sixth waits out what is left of the first step.
		try { post('fresh-guest'); expect.unreachable(); }
		catch (error) { expectRetryAfter(error); expect(error.retryAfterMs).toBe(10_999); }
		now += 10_998;
		expect(() => post('fresh-guest')).toThrow('Guest posting limit reached');
		now += 1;
		expect(post('fresh-guest').result.message_id).toBeTruthy();
		// And then the next step.
		expect(() => post('another-guest')).toThrow('Guest posting limit reached');
		now += 12_000;
		expect(post('another-guest').result.message_id).toBeTruthy();
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

it('gives users with any role the trusted posting limits, for their IP too, under the global ones', async () => {
	await runInDurableObject(env.DEMO.getByName('quota-moderator'), (_instance, state) => {
		const now = (Math.floor(Date.now() / DAY) + 1) * DAY + 43_200_000;
		// A global minute limit that two trusted users' 50 each nearly fill.
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
		// Past the registered 20 and the IP's 30, up to the trusted 50.
		for (let index = 0; index < 50; index++) post('mod');
		expect(() => post('mod')).toThrow('Posting limit reached');
		for (let index = 0; index < 50; index++) post('threader');
		expect(() => post('threader')).toThrow('Posting limit reached');
		// The global 110 still holds: the admin gets the 10 left.
		for (let index = 0; index < 10; index++) post('admin-user');
		expect(() => post('admin-user')).toThrow('Posting limit reached');
	});
	await runInDurableObject(env.DEMO.getByName('quota-trusted-friend'), (_instance, state) => {
		const now = (Math.floor(Date.now() / DAY) + 1) * DAY + 43_200_000;
		const store = new Store(state, { globalPostsPerMinute: 1_000 }, { now: () => now });
		for (const userId of ['pal', 'artist', 'owner']) store.registerIdentity({
			userId, name: userId, userHandle: userId, ipKey: `${userId}-ip`, now,
			credential: { credentialId: userId, userId, publicKey: 'fixture-policy-only', counter: 0 },
		});
		// `friend` grants only trust; any other label an admin gives does too.
		store.setRole({ userId: 'pal', role: 'friend', on: true, now });
		store.setRole({ userId: 'artist', role: 'artist', on: true, now });
		store.registerBot({ ownerId: 'owner', botId: 'bot_owner', name: 'owner', now, ipKey: 'owner-ip' });
		const post = (userId: string) => store.mutate({ userId, ipKey: `${userId}-ip`, method: 'message', now,
			identity: { user_id: userId }, params: { room_id: 'general', body: { text: 'bounded' } } });
		for (const userId of ['pal', 'artist']) {
			for (let index = 0; index < 50; index++) post(userId);
			expect(() => post(userId)).toThrow('Posting limit reached');
		}
		// An owner's bot holds the role `bot` by what it is, not by an admin's grant: registered limits.
		expect(store.getIdentity('bot_owner')!.roles).toEqual(['bot']);
		for (let index = 0; index < 20; index++) post('bot_owner');
		expect(() => post('bot_owner')).toThrow('Posting limit reached');
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

describe('history quota', () => {
	const noon = () => (Math.floor(Date.now() / DAY) + 1) * DAY + 43_200_000;
	const refusal = (fn: () => unknown): StoreError => {
		try { fn(); } catch (error) { expectRetryAfter(error); return error; }
		throw new Error('expected a refusal');
	};

	it('lets a quiet user open a burst of pages at once, then a page a step, and the IP its own larger burst', async () => {
		await runInDurableObject(env.DEMO.getByName('quota-history-burst'), (_instance, state) => {
			let now = noon();
			const store = new Store(state, { historyBurstPerUser: 6, historyRequestsPerUserMinute: 2, historyBurstPerIp: 8, historyRequestsPerIpMinute: 4 }, { now: () => now });
			const page = (userId: string) => store.history({ roomId: 'general', limit: 1, now, userId, ipKey: 'shared-nat' });
			for (let index = 0; index < 6; index++) page('reader');
			const refused = refusal(() => page('reader'));
			expect(refused.message).toBe('History request limit reached');
			// Named for clients, which tell limits apart by it (data.limit).
			expect(refused.data).toEqual({ limit: 'history' });
			// Two a minute: one every 30 s.
			expect(refused.retryAfterMs).toBe(30_000);
			// Another user on the same address has the IP's 2 left.
			page('neighbour');
			page('neighbour');
			expect(refusal(() => page('neighbour')).retryAfterMs).toBe(15_000);
			now += 30_000;
			page('reader');
		});
	});

	it('counts pages a day per user and per IP, until the UTC day ends', async () => {
		await runInDurableObject(env.DEMO.getByName('quota-history-daily'), (_instance, state) => {
			let now = noon();
			const store = new Store(state, { historyRequestsPerUserDay: 3, historyRequestsPerIpDay: 5 }, { now: () => now });
			const page = (userId: string, ipKey = 'home') => store.history({ roomId: 'general', limit: 1, now, userId, ipKey });
			for (let index = 0; index < 3; index++) page('reader');
			const daily = refusal(() => page('reader'));
			expect(daily.message).toBe('Daily history limit reached');
			expect(daily.data).toEqual({ limit: 'history' });
			expect(daily.retryAfterMs).toBe(DAY / 2);
			page('neighbour');
			page('neighbour');
			const network = refusal(() => page('neighbour'));
			expect(network.message).toBe('Daily history limit reached for this network');
			expect(network.data).toEqual({ limit: 'history' });
			// Elsewhere the reader is still at their own daily count.
			expect(refusal(() => page('reader', 'office')).message).toBe('Daily history limit reached');
			now += DAY / 2;
			page('reader');
		});
	});

	it('counts pages a day for the whole server on the budget row, giving back the pages its other limits refused', async () => {
		await runInDurableObject(env.DEMO.getByName('quota-history-server'), (_instance, state) => {
			const now = noon();
			const store = new Store(state, { historyRequestsPerDay: 4, historyBurstPerUser: 2, historyRequestsPerUserMinute: 1 }, { now: () => now });
			const page = (userId: string) => store.history({ roomId: 'general', limit: 1, now, userId, ipKey: `${userId}-ip` });
			page('reader');
			page('reader');
			// Refused by the reader's own limit: it gives its server count back.
			for (let index = 0; index < 5; index++) refusal(() => page('reader'));
			expect(store.budget(now).history).toBe(2);
			page('other');
			page('other');
			const busy = refusal(() => page('third'));
			expect(busy.message).toBe('History is busy until the daily reset');
			expect(busy.data).toEqual({ limit: 'history' });
			expect(busy.retryAfterMs).toBe(DAY / 2);
			// Everything else goes on.
			store.registerIdentity({
				userId: 'poster', name: 'poster', userHandle: 'poster', ipKey: 'poster-ip', now,
				credential: { credentialId: 'poster', userId: 'poster', publicKey: 'fixture-policy-only', counter: 0 },
			});
			expect(store.mutate({ userId: 'poster', ipKey: 'poster-ip', method: 'message', now,
				identity: { user_id: 'poster' }, params: { room_id: 'general', body: { text: 'still posting' } } }).result.message_id).toBeTruthy();
			// Pages for internal use are not counted.
			store.historyPage({ roomId: 'general', limit: 1, now });
			expect(store.budget(now).history).toBe(4);
		});
	});

	it('gives the server-wide count back for a request that serves no page, an unknown room or bad bounds', async () => {
		await runInDurableObject(env.DEMO.getByName('quota-history-invalid'), (_instance, state) => {
			const now = noon();
			const store = new Store(state, { historyRequestsPerDay: 4, historyBurstPerUser: 2, historyRequestsPerUserDay: 2 }, { now: () => now });
			const invalid = (query: { roomId?: string; after?: string }) => {
				try { store.history({ roomId: 'general', limit: 1, now, userId: 'prober', ipKey: 'prober-ip', ...query }); expect.unreachable(); }
				catch (error) { expect(error).toBeInstanceOf(StoreError); expect((error as StoreError).code).toBe('invalid_params'); }
			};
			for (let index = 0; index < 6; index++) invalid({ roomId: 'no-such-room' });
			invalid({ after: 'not-a-log-id' });
			expect(store.budget(now).history).toBe(0);
			// The prober's own limits were rolled back with the page: they still read their two.
			store.history({ roomId: 'general', limit: 1, now, userId: 'prober', ipKey: 'prober-ip' });
			store.history({ roomId: 'general', limit: 1, now, userId: 'prober', ipKey: 'prober-ip' });
			expect(store.history({ roomId: 'general', limit: 1, now, userId: 'other', ipKey: 'other-ip' }).latest_log_id).toBeTruthy();
			expect(store.budget(now).history).toBe(3);
		});
	});

	it('charges one written row a page, the budget row with the clock, and the limiter rows every fourth page and once a minute', async () => {
		await runInDurableObject(env.DEMO.getByName('quota-history-cost'), (_instance, state) => {
			let now = noon();
			const store = new Store(state, {}, { now: () => now });
			const page = () => store.history({ roomId: 'general', limit: 1, now, userId: 'reader', ipKey: 'home' });
			page();
			const charged = (fn: () => unknown, by = store) => {
				const before = by.budget(now).writes;
				fn();
				return by.budget(now).writes - before;
			};
			const writes: number[] = [];
			for (let index = 0; index < 5; index++) {
				now += 1_000;
				writes.push(charged(page));
			}
			// The first page wrote both limiter rows; the fourth after it holds LIMITER_UNWRITTEN_EVENTS
			// unwritten, so the user's and the IP's rows are written (each with its index entry).
			expect(writes).toEqual([1, 1, 1, 5, 1]);
			// A minute on, they are written whatever they hold.
			now += 60_000;
			expect(charged(page)).toBe(5);
			// A refused page is charged only the budget row.
			const limited = new Store(state, { historyBurstPerUser: 1, historyRequestsPerUserMinute: 1 }, { now: () => now });
			limited.history({ roomId: 'general', limit: 1, now, userId: 'limited', ipKey: 'home' });
			expect(charged(() => refusal(() => limited.history({ roomId: 'general', limit: 1, now, userId: 'limited', ipKey: 'home' })), limited)).toBe(1);
		});
	});

	it('holds a daily cap within a few pages however often the object is evicted', async () => {
		await runInDurableObject(env.DEMO.getByName('quota-history-eviction-cycles'), (_instance, state) => {
			let now = noon();
			// Durable Objects hibernate ten seconds after their last event, sockets open or not:
			// each cycle is a fresh Store over the same storage, 15 s after the last.
			const cycles = (config: Record<string, number>, page: (store: Store, index: number) => unknown) => {
				let served = 0;
				for (let cycle = 0; cycle < 10; cycle++) {
					now += 15_000;
					const store = new Store(state, config, { now: () => now });
					for (let index = 0; index < 5; index++) {
						try { page(store, index); served += 1; } catch (error) { expectRetryAfter(error); }
						now += 1_000;
					}
				}
				return served;
			};
			// One user, five pages a wake, against a daily cap of 3: 21 were served when a wake
			// forgot every charge since the row's last write. Each wake writes its first charge:
			// now 3, then 2, then 1 (within the cap plus 6, limiter-cache.ts).
			const user = cycles({ historyRequestsPerUserDay: 3 }, (store) => store.history({ roomId: 'general', limit: 1, now, userId: 'reader', ipKey: 'reader-ip' }));
			expect(user).toBe(6);
			expect(new Store(state, {}, { now: () => now }).limiterDay('history', 'user:reader', now).posts_day).toBe(3);
			// The IP's cap, which keeps one network from using up the server's count, the same way.
			const network = cycles({ historyRequestsPerIpDay: 3 }, (store, index) => store.history({ roomId: 'general', limit: 1, now, userId: `neighbour-${now}-${index}`, ipKey: 'shared-ip' }));
			expect(network).toBe(6);
			expect(new Store(state, {}, { now: () => now }).limiterDay('history', 'ip:shared-ip', now).posts_day).toBe(3);
		});
	});

	it('keeps, written, a limiter row that cleanup finds idle in SQL while its cached copy holds charges', async () => {
		await runInDurableObject(env.DEMO.getByName('quota-history-cleanup'), (_instance, state) => {
			let now = noon() + 10 * 3_600_000;
			const config = { historyRequestsPerUserDay: 2 };
			const page = (store: Store) => store.history({ roomId: 'general', limit: 1, now, userId: 'reader', ipKey: 'home' });
			page(new Store(state, config, { now: () => now }));
			// 00:30 the next day, after an eviction: the first page is written, the second held.
			const lastWritten = now;
			now += 2.5 * 3_600_000;
			const store = new Store(state, config, { now: () => now });
			page(store);
			now += 1_000;
			page(store);
			// As if the held copy's row had last been written before today: cleanup finds it idle.
			state.storage.sql.exec("UPDATE principal_limits SET updated_ms = ? WHERE principal_key = 'user:reader'", lastWritten);
			now += 1_000;
			store.runCleanup(now);
			expect(state.storage.sql.exec("SELECT posts_day FROM principal_limits WHERE scope = 'history' AND principal_key = 'user:reader'").toArray()).toEqual([{ posts_day: 2 }]);
			expect(refusal(() => page(store)).message).toBe('Daily history limit reached');
			expect(refusal(() => page(new Store(state, config, { now: () => now }))).message).toBe('Daily history limit reached');
		});
	});

	it('keeps a principal\'s first charge and anything a minute old through an eviction, and forgets at most the last minute', async () => {
		const stub = env.DEMO.getByName('quota-history-eviction');
		let now = noon();
		const config = { historyRequestsPerUserDay: 3 };
		await runInDurableObject(stub, (_instance, state) => {
			const store = new Store(state, config, { now: () => now });
			store.history({ roomId: 'general', limit: 1, now, userId: 'reader', ipKey: 'home' });
			now += 61_000;
			store.history({ roomId: 'general', limit: 1, now, userId: 'reader', ipKey: 'home' });
			now += 1_000;
			// Held in memory: lost to the eviction below.
			store.history({ roomId: 'general', limit: 1, now, userId: 'reader', ipKey: 'home' });
			expect(store.limiterDay('history', 'user:reader', now).posts_day).toBe(3);
		});
		await evictDurableObject(stub);
		await runInDurableObject(stub, (_instance, state) => {
			const store = new Store(state, config, { now: () => now });
			expect(store.limiterDay('history', 'user:reader', now).posts_day).toBe(2);
			store.history({ roomId: 'general', limit: 1, now, userId: 'reader', ipKey: 'home' });
			expect(refusal(() => store.history({ roomId: 'general', limit: 1, now, userId: 'reader', ipKey: 'home' })).message).toBe('Daily history limit reached');
		});
	});
});

describe('limiter row count', () => {
	const noon = () => (Math.floor(Date.now() / DAY) + 1) * DAY + 43_200_000;
	const count = (state: DurableObjectState) => state.storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'principal_limit_count'").toArray().map((row) => Number(row.value));
	const rows = (state: DurableObjectState) => state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM principal_limits').one().count;

	it('lowers the count by the limiter rows a purge deletes', async () => {
		await runInDurableObject(env.DEMO.getByName('quota-limiter-count-purge'), (_instance, state) => {
			const now = noon();
			const store = new Store(state, {}, { now: () => now });
			store.history({ roomId: 'general', limit: 1, now, userId: 'leaver', ipKey: 'home' });
			store.history({ roomId: 'general', limit: 1, now, userId: 'stayer', ipKey: 'home' });
			expect(count(state)).toEqual([3]);
			store.purgeUsers({ userIds: ['leaver', 'nobody'], now });
			expect(rows(state)).toBe(2);
			expect(count(state)).toEqual([2]);
		});
	});

	it('writes a missing count back, so the cap still applies', async () => {
		await runInDurableObject(env.DEMO.getByName('quota-limiter-count-missing'), (_instance, state) => {
			const now = noon();
			const store = new Store(state, { principalLimitCap: 3 }, { now: () => now });
			state.storage.sql.exec("DELETE FROM _meta WHERE key = 'principal_limit_count'");
			store.history({ roomId: 'general', limit: 1, now, userId: 'first', ipKey: 'home' });
			expect(count(state)).toEqual([2]);
			store.history({ roomId: 'general', limit: 1, now, userId: 'second', ipKey: 'home' });
			expect(() => store.history({ roomId: 'general', limit: 1, now, userId: 'third', ipKey: 'home' })).toThrow('Demo capacity reached');
		});
	});
});
