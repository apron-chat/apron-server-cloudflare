import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, UPLOAD_POLICY } from '../src/budget';
import { BREAKER_ALERT_ONLY, BREAKER_MS, DEGRADED, OPERATION_PAUSED, Store, StoreError, type OverrunNotice, type StoreConfig } from '../src/store';

afterEach(() => { vi.restoreAllMocks(); });

/**
 * A Store with one operation whose estimate is wrong: it reserves nothing
 * and lists every room, as `topLevelRoomIds` did before #67. Its name on the
 * stack (`leakyListing`) is what an overrun and a breaker are named after.
 */
class LeakyStore extends Store {
	leakyListing(now: number): number {
		const reserved = (this as unknown as { reserved: (cost: object, maintenance: boolean, now: number, fn: () => number) => number }).reserved;
		return reserved.call(this, { reads: 0 }, false, now, () => this.listRooms(now).length);
	}
}

function seedThreads(state: DurableObjectState, now: number, count = 100): void {
	state.storage.transactionSync(() => {
		for (let index = 1; index <= count; index += 1) {
			state.storage.sql.exec(
				`INSERT INTO rooms (room_id, parent_room_id, created_log_id, record_log_id, latest_log_id, fields_json, created_ms, updated_ms)
				 VALUES (?, 'general', ?, ?, ?, '{}', ?, ?)`,
				`tier-thread-${index}`, index, index, index, now, now,
			);
		}
	});
}

function leakyStore(state: DurableObjectState, clock: { now: number }, config: Partial<StoreConfig> = {}): LeakyStore {
	const store = new LeakyStore(state, config, { now: () => clock.now });
	store.initialize();
	return store;
}

function refusal(fn: () => unknown): StoreError {
	try { fn(); } catch (error) {
		expect(error).toBeInstanceOf(StoreError);
		return error as StoreError;
	}
	throw new Error('expected a refusal');
}

const foregroundReads = (state: DurableObjectState) =>
	state.storage.sql.exec<{ foreground_reads: number }>('SELECT foreground_reads FROM resource_budgets ORDER BY day DESC LIMIT 1').one().foreground_reads;

it('observes an ordinary overrun: the operation finishes, its excess is charged, and nothing stops', async () => {
	await runInDurableObject(env.DEMO.getByName('tier-observe'), async (_instance, state) => {
		const clock = { now: Date.now() + 3_000 };
		const store = leakyStore(state, clock);
		const notices: OverrunNotice[] = [];
		store.onOverrun = (notice) => notices.push(notice);
		store.actor = () => ['ip:observed-ip', 'user:observed'];
		const error = vi.spyOn(console, 'error');
		seedThreads(state, clock.now);
		const before = foregroundReads(state);
		expect(store.leakyListing(clock.now)).toBe(101);
		// Charged as spent: the 100-odd rows the reservation left out are on the books.
		expect(foregroundReads(state) - before).toBeGreaterThanOrEqual(100);
		expect(store.accountingStatus()).toMatchObject({ unsafe: false, uncertain: false });
		expect(store.accountingGuard(clock.now)).toMatchObject({ overruns: 1, breakers: {} });
		expect(() => store.getRoomState()).not.toThrow();
		await Promise.resolve();
		expect(notices).toEqual([expect.objectContaining({ operation: 'leakyListing', firstToday: true, breaker: false, huge: false, principals: ['ip:observed-ip', 'user:observed'] })]);
		expect(error.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('"event":"accounting_overrun","operation":"leakyListing"'));
	});
});

it('opens a breaker on the third overrun of one operation within an hour, refusing only that operation for an hour', async () => {
	const stub = env.DEMO.getByName('tier-breaker');
	const clock = { now: Date.now() + 3_000 };
	await runInDurableObject(stub, async (_instance, state) => {
		const store = leakyStore(state, clock);
		const notices: OverrunNotice[] = [];
		store.onOverrun = (notice) => notices.push(notice);
		seedThreads(state, clock.now);
		store.leakyListing(clock.now);
		clock.now += 60_000;
		store.leakyListing(clock.now);
		expect(store.accountingGuard(clock.now).breakers).toEqual({});
		clock.now += 60_000;
		store.leakyListing(clock.now);
		await Promise.resolve();
		expect(notices.map((notice) => [notice.firstToday, notice.breaker])).toEqual([[true, false], [false, false], [false, true]]);
		expect(store.accountingGuard(clock.now).breakers).toEqual({ leakyListing: clock.now + BREAKER_MS });
		const refused = refusal(() => store.leakyListing(clock.now));
		expect(refused.code).toBe('retry_after');
		expect(refused.data?.reason).toBe(OPERATION_PAUSED);
		expect(refused.retryAfterMs).toBe(BREAKER_MS);
		// Everything else works.
		expect(() => store.getRoomState()).not.toThrow();
		expect(store.listRooms(clock.now)).toHaveLength(101);
	});
	// The breaker survives a wake, then closes on its own.
	await evictDurableObject(stub);
	await runInDurableObject(stub, (_instance, state) => {
		const woken = leakyStore(state, clock);
		expect(refusal(() => woken.leakyListing(clock.now)).data?.reason).toBe(OPERATION_PAUSED);
		clock.now += BREAKER_MS;
		expect(woken.accountingGuard(clock.now).breakers).toEqual({});
		expect(woken.leakyListing(clock.now)).toBe(101);
	});
});

it('never opens a breaker on an essential operation, however often or far it overruns', async () => {
	const stub = env.DEMO.getByName('tier-essential');
	const clock = { now: Date.now() + 3_000 };
	const essential = BREAKER_ALERT_ONLY as Set<string>;
	essential.add('leakyListing');
	try {
		await runInDurableObject(stub, async (_instance, state) => {
			const store = leakyStore(state, clock, { sqlReadsPerDay: 5_000, foregroundReadsPerDay: 4_000, maintenanceReadsPerDay: 1_000 });
			const notices: OverrunNotice[] = [];
			store.onOverrun = (notice) => notices.push(notice);
			seedThreads(state, clock.now);
			for (let index = 0; index < 4; index += 1) {
				expect(store.leakyListing(clock.now)).toBe(101);
				clock.now += 60_000;
			}
			await Promise.resolve();
			expect(notices.every((notice) => notice.essential && !notice.breaker)).toBe(true);
			expect(notices[0].huge).toBe(true);
			expect(store.accountingGuard(clock.now).breakers).toEqual({});
		});
	} finally {
		essential.delete('leakyListing');
	}
	expect([...BREAKER_ALERT_ONLY]).toEqual(expect.arrayContaining(['registerIdentity', 'listRooms', 'roomMembers', 'history']));
});

it('opens the breaker at once when one overrun exceeds a hundredth of the day, and the rest of the server works', async () => {
	await runInDurableObject(env.DEMO.getByName('tier-huge'), async (_instance, state) => {
		const clock = { now: Date.now() + 3_000 };
		// A ceiling small enough that reading 100 threads is more than a hundredth of it.
		const store = leakyStore(state, clock, { sqlReadsPerDay: 5_000, foregroundReadsPerDay: 4_000, maintenanceReadsPerDay: 1_000 });
		const notices: OverrunNotice[] = [];
		store.onOverrun = (notice) => notices.push(notice);
		seedThreads(state, clock.now);
		// The overrun still finishes: its rows are already read.
		expect(store.leakyListing(clock.now)).toBe(101);
		await Promise.resolve();
		expect(notices).toEqual([expect.objectContaining({ operation: 'leakyListing', huge: true, breaker: true })]);
		expect(refusal(() => store.leakyListing(clock.now)).data?.reason).toBe(OPERATION_PAUSED);
		expect(() => store.getRoomState()).not.toThrow();
		expect(store.accountingStatus().unsafe).toBe(false);
	});
});

it('charges rows found past an overrun already noted, and counts it once', async () => {
	await runInDurableObject(env.DEMO.getByName('tier-incremental'), (_instance, state) => {
		const now = Date.now() + 3_000;
		const store = new Store(state, {}, { now: () => now });
		store.initialize();
		seedThreads(state, now);
		// As runCleanup does: one reservation checked after each of two transactions.
		const internals = store as unknown as {
			observed: { reads: number; writes: number };
			reserveCost(cost: object, maintenance: boolean, now: number): object;
			assertReservation(reserved: object, reads: number, writes: number): void;
		};
		const before = foregroundReads(state);
		const start = { reads: internals.observed.reads, writes: internals.observed.writes };
		const reservation = internals.reserveCost({ reads: 0 }, false, now);
		store.listRooms(now);
		internals.assertReservation(reservation, start.reads, start.writes);
		const afterFirst = foregroundReads(state);
		store.listRooms(now);
		internals.assertReservation(reservation, start.reads, start.writes);
		const afterSecond = foregroundReads(state);
		expect(afterFirst - before).toBeGreaterThanOrEqual(100);
		// The second listing's rows are charged too, not lost to the first count.
		expect(afterSecond - afterFirst).toBeGreaterThanOrEqual(100);
		expect(store.accountingGuard(now).overruns).toBe(1);
	});
});

it('keeps an overrun charge for later when storage fails while charging it, without looping', async () => {
	await runInDurableObject(env.DEMO.getByName('tier-charge-failure'), (_instance, state) => {
		const clock = { now: Date.now() + 3_000 };
		const store = leakyStore(state, clock);
		seedThreads(state, clock.now);
		const before = foregroundReads(state);
		state.storage.sql.exec(`CREATE TRIGGER fail_overrun_charge
			BEFORE UPDATE OF foreground_reads ON resource_budgets
			BEGIN SELECT RAISE(ABORT, 'injected budget failure'); END`);
		// The charge fails: accounting closes as uncertain, once, and the call returns.
		expect(store.leakyListing(clock.now)).toBe(101);
		expect(store.accountingStatus().uncertain).toBe(true);
		state.storage.sql.exec('DROP TRIGGER fail_overrun_charge');
		// Storage works again: the next operation recovers and the kept charge lands.
		expect(() => store.getRoomState()).not.toThrow();
		expect(store.accountingStatus().uncertain).toBe(false);
		expect(foregroundReads(state) - before).toBeGreaterThanOrEqual(100);
	});
});

it('retires the permanent overrun stop of earlier versions on wake', async () => {
	const stub = env.DEMO.getByName('tier-legacy-stop');
	await runInDurableObject(stub, (_instance, state) => {
		new Store(state, {}).initialize();
		state.storage.sql.exec("UPDATE _meta SET value = '1' WHERE key = 'accounting_unsafe'");
	});
	await evictDurableObject(stub);
	await runInDurableObject(stub, (_instance, state) => {
		const store = new Store(state, {});
		store.initialize();
		expect(() => store.getRoomState()).not.toThrow();
		expect(state.storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'accounting_unsafe'").one().value).toBe('0');
	});
});

it('degrades at 70% of a daily ceiling: live text, uploads and older history are refused, chat is not', async () => {
	await runInDurableObject(env.DEMO.getByName('tier-degrade'), (_instance, state) => {
		const now = Date.now() + 3_000;
		const store = new Store(state, { uploads: { ...UPLOAD_POLICY!, mediaOrigin: 'https://media.test' } }, { now: () => now });
		store.initialize();
		const user = store.registerIdentity({
			userId: 'degrade_user', name: 'Degrade', userHandle: 'handle-degrade', now, ipKey: 'ip-degrade',
			credential: { credentialId: 'cred-degrade', userId: 'degrade_user', publicKey: 'AAAA', counter: 0 },
		});
		expect(user).toBeTruthy();
		const day = new Date(now).toISOString().slice(0, 10);
		state.storage.sql.exec('UPDATE resource_budgets SET foreground_writes = ? WHERE day = ?', Math.ceil(DEFAULT_LIMITS.foregroundWritesPerDay * 0.75), day);
		// A new instance reads the row back, as after a wake.
		const busy = new Store(state, { uploads: { ...UPLOAD_POLICY!, mediaOrigin: 'https://media.test' } }, { now: () => now });
		busy.initialize();
		busy.getRoomState();
		expect(busy.budgetShares(now)?.writes).toBeGreaterThanOrEqual(0.7);
		const upload = refusal(() => busy.startAvatarUpload({ userId: 'degrade_user', now }));
		expect(upload.data?.reason).toBe(DEGRADED);
		const older = refusal(() => busy.history({ roomId: 'general', before: '9007199254740990', now, userId: 'degrade_user', ipKey: 'ip-degrade' }));
		expect(older.data?.reason).toBe(DEGRADED);
		// The latest page still loads.
		expect(() => busy.history({ roomId: 'general', now, userId: 'degrade_user', ipKey: 'ip-degrade' })).not.toThrow();
	});
});

it('announces every tier change and breaker to the admins, once', async () => {
	type Runtime = { store: Store; evaluateTier(now: number): void };
	const stub = env.DEMO.getByName('tier-announce');
	const warn = vi.spyOn(console, 'warn');
	const posts = (state: DurableObjectState) => state.storage.sql.exec<{ record_json: string }>(
		"SELECT record_json FROM records WHERE room_id = 'general' AND kind = 'message' ORDER BY log_id",
	).toArray().map((row) => JSON.parse(row.record_json) as { from: { user_id: string }; body: { text: string; mentions?: string[] } })
		.filter((post) => post.from.user_id === 'admin');
	await runInDurableObject(stub, async (instance, state) => {
		const runtime = instance as unknown as Runtime;
		const now = Date.now();
		runtime.store.registerIdentity({
			userId: 'tier_boss', name: 'Boss', userHandle: 'handle-tier-boss', now, ipKey: 'ip-tier-boss',
			credential: { credentialId: 'cred-tier-boss', userId: 'tier_boss', publicKey: 'AAAA', counter: 0 },
		});
		runtime.store.setRole({ userId: 'tier_boss', role: 'admin', on: true });
		const day = new Date(now).toISOString().slice(0, 10);
		state.storage.sql.exec('UPDATE resource_budgets SET foreground_writes = ? WHERE day = ?', Math.ceil(DEFAULT_LIMITS.foregroundWritesPerDay * 0.75), day);
		// The row is read back into memory by a reservation, as any frame does.
		(runtime.store as unknown as { ledger: { forget(): void } }).ledger.forget();
		runtime.store.getRoomState();
		runtime.evaluateTier(now);
		runtime.evaluateTier(now + 1);
	});
	await vi.waitFor(() => expect(warn.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('"admins_notified"')));
	await runInDurableObject(stub, (_instance, state) => {
		const announced = posts(state);
		expect(announced).toHaveLength(1);
		expect(announced[0].body.text).toMatch(/^\*\*Server tier: degraded\*\* \(was open\)\. foreground SQL writes at 75% of today's ceiling\./);
		expect(announced[0].body.mentions).toEqual(['tier_boss']);
	});
});

it('counts throttle trips by trigger over the last 24 hours', async () => {
	await runInDurableObject(env.DEMO.getByName('tier-trips'), (_instance, state) => {
		const clock = { now: Date.now() + 3_000 };
		const store = new Store(state, {}, { now: () => clock.now });
		store.initialize();
		store.noteThrottleTrip('degraded', clock.now);
		clock.now += 2 * 60 * 60 * 1000;
		store.noteThrottleTrip('degraded', clock.now);
		store.noteThrottleTrip('daily_posting_limit_reached', clock.now);
		expect(store.throttleTrips(clock.now)).toEqual([['degraded', 2], ['daily_posting_limit_reached', 1]]);
		// The first hour's trip leaves the window a day later; the rest stay.
		clock.now += 23 * 60 * 60 * 1000;
		expect(store.throttleTrips(clock.now)).toEqual([['daily_posting_limit_reached', 1], ['degraded', 1]]);
	});
});
