import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/budget';
import { Store } from '../src/store';

it('closes accounting while a budget write fails, and reopens once the staged write lands', async () => {
	const stub = env.DEMO.getByName('budget-reservation-failure');
	const now = Date.now() + 1_000;
	await runInDurableObject(stub, (_instance, state) => {
		const store = new Store(state, {}, { now: () => now });
		store.initialize();
		const reserved = () => state.storage.sql.exec<{ reads_reserved: number; writes_reserved: number }>(
			'SELECT reads_reserved, writes_reserved FROM resource_budgets ORDER BY day DESC LIMIT 1',
		).one();
		const marker = () => state.storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'accounting_unsafe' LIMIT 1").one().value;
		const before = reserved();
		state.storage.sql.exec(`CREATE TRIGGER fail_budget_reservation
			BEFORE UPDATE OF reads_reserved ON resource_budgets
			BEGIN SELECT RAISE(ABORT, 'injected budget reservation failure'); END`);

		// The reservation is staged; the write that settles it fails after the
		// operation. That closes accounting as uncertain, the marker written
		// outside the failed statement, so nothing runs on a lagging row.
		store.getRoomState();
		expect(marker()).toBe('uncertain');
		expect(reserved()).toEqual(before);
		expect(store.accountingStatus()).toMatchObject({ unsafe: false, uncertain: true });
		// While the write still fails, work is refused as storage unavailable.
		expect(() => store.getRoomState()).toThrow('storage is unavailable');

		// Storage works again: the next operation writes what was staged first,
		// then runs, and the marker clears without an operator.
		state.storage.sql.exec('DROP TRIGGER fail_budget_reservation');
		expect(() => store.getRoomState()).not.toThrow();
		expect(store.accountingStatus()).toMatchObject({ unsafe: false, uncertain: false });
		expect(marker()).toBe('0');
		expect(reserved().reads_reserved).toBeGreaterThan(before.reads_reserved);
	});
});

it('reopens accounting a storage failure left uncertain on the next wake, charging for what was lost', async () => {
	const stub = env.DEMO.getByName('budget-uncertain-wake');
	const now = Date.now() + 1_500;
	const maintenance = (state: DurableObjectState) => state.storage.sql.exec<{ maintenance_reads: number; maintenance_writes: number }>(
		'SELECT maintenance_reads, maintenance_writes FROM resource_budgets ORDER BY day DESC LIMIT 1',
	).one();
	let before = { maintenance_reads: 0, maintenance_writes: 0 };
	await runInDurableObject(stub, (_instance, state) => {
		const store = new Store(state, {}, { now: () => now });
		store.initialize();
		state.storage.sql.exec(`CREATE TRIGGER fail_budget_reservation
			BEFORE UPDATE OF reads_reserved ON resource_budgets
			BEGIN SELECT RAISE(ABORT, 'injected budget reservation failure'); END`);
		store.getRoomState();
		expect(store.accountingStatus().uncertain).toBe(true);
		// The instance goes before the staged write lands.
		state.storage.sql.exec('DROP TRIGGER fail_budget_reservation');
		before = maintenance(state);
	});

	await evictDurableObject(stub);
	await runInDurableObject(stub, (_instance, state) => {
		const restarted = new Store(state, {}, { now: () => now });
		restarted.initialize();
		// A wake writes nothing: the first operation charges for what was lost, then runs.
		expect(restarted.accountingStatus()).toMatchObject({ unsafe: false, uncertain: true });
		expect(maintenance(state)).toEqual(before);
		expect(() => restarted.getRoomState()).not.toThrow();
		expect(restarted.accountingStatus()).toMatchObject({ unsafe: false, uncertain: false });
		expect(state.storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'accounting_unsafe' LIMIT 1").one().value).toBe('0');
		const after = maintenance(state);
		expect(after.maintenance_reads).toBeGreaterThanOrEqual(before.maintenance_reads + Math.ceil(DEFAULT_LIMITS.sqlReadsPerDay / 100));
		expect(after.maintenance_writes).toBeGreaterThanOrEqual(before.maintenance_writes + Math.ceil(DEFAULT_LIMITS.sqlWritesPerDay / 100));
	});
});

it('persists an overrun stop across object eviction', async () => {
	const stub = env.DEMO.getByName('budget-overrun-restart');
	const now = Date.now() + 2_000;
	await runInDurableObject(stub, (_instance, state) => {
		const store = new Store(state, {}, { now: () => now });
		store.initialize();
		state.storage.transactionSync(() => {
			for (let index = 1; index <= 100; index += 1) {
				state.storage.sql.exec(
					`INSERT INTO rooms (room_id, parent_room_id, created_log_id, record_log_id, latest_log_id, fields_json, created_ms, updated_ms)
					 VALUES (?, 'general', ?, ?, ?, ?, ?, ?)`,
					`budget-thread-${index}`, index, index, index, JSON.stringify({ title: `Thread ${index}` }), now, now,
				);
			}
		});

		// The outer boundary deliberately reserves no operation rows while the
		// nested room read is bounded but larger than that reservation. The guard
		// latches unsafe and persists the marker before returning the error.
		expect(() => store.withMeter('foreground', { reads: 0, writes: 0 }, () => store.listRooms(now), now))
			.toThrow('storage cost exceeded its reservation');
		expect(store.accountingStatus().unsafe).toBe(true);
	});

	await evictDurableObject(stub);
	await runInDurableObject(stub, (_instance, state) => {
		const restarted = new Store(state, {}, { now: () => now });
		restarted.initialize();
		expect(restarted.accountingStatus().unsafe).toBe(true);
	});
});

it('clears a persisted accounting stop once per recovery value', async () => {
	const stub = env.DEMO.getByName('budget-recovery');
	const now = Date.now() + 3_000;
	const marker = (state: DurableObjectState) => state.storage.sql.exec<{ value: string }>(
		"SELECT value FROM _meta WHERE key = 'accounting_unsafe' LIMIT 1",
	).one().value;
	await runInDurableObject(stub, (_instance, state) => {
		const store = new Store(state, {}, { now: () => now });
		store.initialize();
		state.storage.sql.exec("UPDATE _meta SET value = '1' WHERE key = 'accounting_unsafe'");
	});

	await evictDurableObject(stub);
	await runInDurableObject(stub, (_instance, state) => {
		// Without a recovery value the stop stays.
		const latched = new Store(state, {}, { now: () => now });
		latched.initialize();
		expect(latched.accountingStatus().unsafe).toBe(true);

		const before = state.storage.sql.exec<{ maintenance_writes: number }>(
			'SELECT maintenance_writes FROM resource_budgets ORDER BY day DESC LIMIT 1',
		).one().maintenance_writes;
		const recovered = new Store(state, { accountingRecovery: 'first' }, { now: () => now });
		recovered.initialize();
		expect(recovered.accountingStatus().unsafe).toBe(false);
		expect(marker(state)).toBe('0');
		expect(() => recovered.getRoomState()).not.toThrow();
		const after = state.storage.sql.exec<{ maintenance_writes: number }>(
			'SELECT maintenance_writes FROM resource_budgets ORDER BY day DESC LIMIT 1',
		).one().maintenance_writes;
		expect(after).toBeGreaterThan(before);

		// A stop latched later is not cleared by the value already used.
		state.storage.sql.exec("UPDATE _meta SET value = '1' WHERE key = 'accounting_unsafe'");
		const again = new Store(state, { accountingRecovery: 'first' }, { now: () => now });
		again.initialize();
		expect(again.accountingStatus().unsafe).toBe(true);
		expect(() => again.getRoomState()).toThrow('storage accounting is unsafe');

		const next = new Store(state, { accountingRecovery: 'second' }, { now: () => now });
		next.initialize();
		expect(next.accountingStatus().unsafe).toBe(false);
		expect(marker(state)).toBe('0');
	});
});

it('writes an async operation\'s reservation before it awaits, and status writes the budget row once', async () => {
	await runInDurableObject(env.DEMO.getByName('budget-async-and-status'), async (_instance, state) => {
		const now = Date.now() + 1_000;
		const store = new Store(state, {}, { now: () => now });
		store.initialize();
		const reserved = () => state.storage.sql.exec<{ writes_reserved: number }>(
			'SELECT writes_reserved FROM resource_budgets ORDER BY day DESC LIMIT 1',
		).one().writes_reserved;
		store.getRoomState();
		const before = reserved();
		// Nothing settles it: an eviction during the await must not lose it.
		const during = await store.withMeterAsync('foreground', { writes: 100 }, async () => reserved(), now);
		expect(during).toBeGreaterThanOrEqual(before + 100);
		const writes = store.storageAccounting().writes;
		store.status(now);
		expect(store.storageAccounting().writes - writes).toBe(1);
	});
});
