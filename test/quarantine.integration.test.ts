import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { ACCOUNTING_QUARANTINED, QUARANTINE_MS, QUARANTINES_PER_DAY, Store, StoreError, type StoreConfig } from '../src/store';
import { connect, greeting, request } from './helpers/socket';

type Runtime = { store: Store };

afterEach(() => { vi.restoreAllMocks(); });

/** Fills the public range, so a listing reads far more than a reservation of nothing allows. */
function seedThreads(state: DurableObjectState, now: number): void {
	state.storage.transactionSync(() => {
		for (let index = 1; index <= 100; index += 1) {
			state.storage.sql.exec(
				`INSERT INTO rooms (room_id, parent_room_id, created_log_id, record_log_id, latest_log_id, fields_json, created_ms, updated_ms)
				 VALUES (?, 'general', ?, ?, ?, '{}', ?, ?)`,
				`quarantine-thread-${index}`, index, index, index, now, now,
			);
		}
	});
}

/** A Store acting for whoever `who` holds, as the runtime's ACTOR context would say. */
function storeActingAs(state: DurableObjectState, who: { principals: string[] }, now: () => number, config: Partial<StoreConfig> = {}): Store {
	const store = new Store(state, config, { now });
	store.actor = () => who.principals;
	store.initialize();
	return store;
}

/** An operation that reserves nothing and reads every room: it overruns. */
function overrun(store: Store, now: number): void {
	expect(() => store.withMeter('foreground', { reads: 0, writes: 0 }, () => store.listRooms(now), now)).toThrow('storage cost exceeded its reservation');
}

function quarantined(fn: () => unknown): StoreError {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(StoreError);
		expect((error as StoreError).code).toBe('retry_after');
		expect((error as StoreError).data?.reason).toBe(ACCOUNTING_QUARANTINED);
		return error as StoreError;
	}
	throw new Error('expected the operation to be refused as quarantined');
}

it('pauses only the user and address an overrun acted for, charges its excess, and keeps the pause across a wake', async () => {
	const stub = env.DEMO.getByName('quarantine-isolates');
	const now = Date.now() + 3_000;
	const who = { principals: ['user:mallory', 'ip:mallory-ip'] };
	const notices: unknown[] = [];
	await runInDurableObject(stub, async (_instance, state) => {
		const store = storeActingAs(state, who, () => now);
		store.onQuarantine = (detail) => notices.push(detail);
		seedThreads(state, now);
		const reads = () => state.storage.sql.exec<{ foreground_reads: number }>('SELECT foreground_reads FROM resource_budgets ORDER BY day DESC LIMIT 1').one().foreground_reads;
		const before = reads();
		overrun(store, now);
		// The server stays open, and the rows the reservation left out are charged.
		expect(store.accountingStatus().unsafe).toBe(false);
		expect(reads() - before).toBeGreaterThanOrEqual(100);
		await Promise.resolve();
		expect(notices).toEqual([{ principals: ['user:mallory', 'ip:mallory-ip'], message: expect.stringContaining('storage cost exceeded its reservation'), count: 1, limit: QUARANTINES_PER_DAY }]);

		// Mallory is refused by user and by address, for a day; everyone else and the server's own work are not.
		const error = quarantined(() => store.getRoomState());
		expect(error.retryAfterMs).toBe(QUARANTINE_MS);
		who.principals = ['user:mallory-again', 'ip:mallory-ip'];
		quarantined(() => store.getRoomState());
		who.principals = ['user:alice', 'ip:alice-ip'];
		expect(() => store.getRoomState()).not.toThrow();
		who.principals = [];
		expect(() => store.getRoomState()).not.toThrow();
	});

	await evictDurableObject(stub);
	await runInDurableObject(stub, (_instance, state) => {
		const woken = { principals: ['user:mallory'] };
		const store = storeActingAs(state, woken, () => now + 1_000);
		quarantined(() => store.getRoomState());
		// The pause ends on its own.
		const later = storeActingAs(state, woken, () => now + QUARANTINE_MS + 1);
		expect(() => later.getRoomState()).not.toThrow();
	});
});

it('closes accounting for everyone once a day has had its quarantines, or for an overrun no one is held to', async () => {
	await runInDurableObject(env.DEMO.getByName('quarantine-cap'), (_instance, state) => {
		const now = Date.now() + 3_000;
		const who = { principals: [] as string[] };
		const store = storeActingAs(state, who, () => now);
		seedThreads(state, now);
		for (let index = 0; index < QUARANTINES_PER_DAY; index += 1) {
			who.principals = [`user:u${index}`];
			overrun(store, now);
			expect(store.accountingStatus().unsafe).toBe(false);
		}
		who.principals = ['user:one-too-many'];
		overrun(store, now);
		expect(store.accountingStatus().unsafe).toBe(true);
	});

	await runInDurableObject(env.DEMO.getByName('quarantine-unattributed'), (_instance, state) => {
		const now = Date.now() + 3_000;
		const store = storeActingAs(state, { principals: [] }, () => now);
		seedThreads(state, now);
		overrun(store, now);
		expect(store.accountingStatus().unsafe).toBe(true);
	});
});

it('closes accounting for everyone when one overrun exceeds a hundredth of the day\'s SQL ceiling', async () => {
	await runInDurableObject(env.DEMO.getByName('quarantine-large-excess'), (_instance, state) => {
		const now = Date.now() + 3_000;
		// A ceiling small enough that reading the 100 threads is more than a hundredth of it.
		const store = storeActingAs(state, { principals: ['user:big'] }, () => now, { sqlReadsPerDay: 5_000, foregroundReadsPerDay: 4_000, maintenanceReadsPerDay: 1_000 });
		seedThreads(state, now);
		overrun(store, now);
		expect(store.accountingStatus().unsafe).toBe(true);
	});
});

it('lifts every quarantine with a new recovery value', async () => {
	const stub = env.DEMO.getByName('quarantine-recovery');
	const now = Date.now() + 3_000;
	await runInDurableObject(stub, (_instance, state) => {
		const store = storeActingAs(state, { principals: ['user:mallory'] }, () => now);
		seedThreads(state, now);
		overrun(store, now);
	});
	await evictDurableObject(stub);
	await runInDurableObject(stub, (_instance, state) => {
		const who = { principals: ['user:mallory'] };
		quarantined(() => storeActingAs(state, who, () => now).getRoomState());
		const recovered = storeActingAs(state, who, () => now, { accountingRecovery: 'lift-quarantine' });
		expect(() => recovered.getRoomState()).not.toThrow();
		expect(() => storeActingAs(state, who, () => now).getRoomState()).not.toThrow();
	});
});

it('pauses the connection whose frame overran, while another keeps working', async () => {
	const error = vi.spyOn(console, 'error');
	const mallory = await connect({ ip: '198.51.100.66' });
	const alice = await connect({ ip: '198.51.100.77' });
	await greeting(mallory);
	await greeting(alice);
	expect((await request(mallory, 'auth', 'auth', { scheme: 'guest' })).result).toBeTruthy();
	expect((await request(alice, 'auth', 'auth', { scheme: 'guest' })).result).toBeTruthy();

	// The next `not_joined` listing's top-level room read reserves nothing, so
	// it overruns as the one on 2026-11-01 did (an estimate too small for the data).
	await runInDurableObject(env.DEMO.getByName('public-demo-v1'), (instance, state) => {
		seedThreads(state, Date.now());
		const store = (instance as unknown as Runtime).store;
		store.topLevelRoomIds = (now = Date.now()) => store.withMeter('foreground', { reads: 0, writes: 0 }, () => store.listRooms(now).map((room) => room.room_id), now);
	});

	const failed = await request(mallory, 'overrun', 'room_list', { filter: 'not_joined' });
	expect(failed.error?.code).toBe(-32603);
	expect(error.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('"accounting_quarantined"'));

	const paused = await request(mallory, 'paused', 'room_list', { filter: 'joined' });
	expect(paused.error?.data?.retry_after).toBeGreaterThan(0);
	const open = await request(alice, 'open', 'room_list', { filter: 'joined' });
	expect(open.error).toBeUndefined();
	expect(open.result).toBeTruthy();

	await runInDurableObject(env.DEMO.getByName('public-demo-v1'), (instance) => {
		expect((instance as unknown as Runtime).store.accountingStatus().unsafe).toBe(false);
	});
	mallory.close();
	alice.close();
});
