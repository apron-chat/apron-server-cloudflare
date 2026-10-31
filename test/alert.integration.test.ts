import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { Store } from '../src/store';

type Runtime = { store: Store };

afterEach(() => { vi.restoreAllMocks(); });

it('tells the admins when an overrun closes accounting, and a status probe then says why and when to retry', async () => {
	const stub = env.DEMO.getByName('overrun-alert');
	const warn = vi.spyOn(console, 'warn');
	const bossId = 'overrun_boss';
	await runInDurableObject(stub, (instance, state) => {
		const store = (instance as unknown as Runtime).store;
		const now = Date.now();
		store.registerIdentity({
			userId: bossId, name: 'Boss', userHandle: `handle-${bossId}`, now, ipKey: `ip-${bossId}`,
			credential: { credentialId: `cred-${bossId}`, userId: bossId, publicKey: 'AAAA', counter: 0 },
		});
		store.setRole({ userId: bossId, role: 'admin', on: true });
		state.storage.transactionSync(() => {
			for (let index = 1; index <= 100; index += 1) {
				state.storage.sql.exec(
					`INSERT INTO rooms (room_id, parent_room_id, created_log_id, record_log_id, latest_log_id, fields_json, created_ms, updated_ms)
					 VALUES (?, 'general', ?, ?, ?, ?, ?, ?)`,
					`overrun-thread-${index}`, index, index, index, JSON.stringify({ title: `Thread ${index}` }), now, now,
				);
			}
		});
		// Reserving nothing for a read of many rooms overruns: accounting closes for good.
		expect(() => store.withMeter('foreground', { reads: 0, writes: 0 }, () => store.listRooms(now), now)).toThrow('storage cost exceeded its reservation');
		expect(store.accountingStatus().unsafe).toBe(true);
	});

	// The alert runs once the failed operation has unwound, past closed accounting.
	await vi.waitFor(() => expect(warn.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('"admins_notified"')));
	await runInDurableObject(stub, (instance, state) => {
		expect((instance as unknown as Runtime).store.accountingStatus().unsafe).toBe(true);
		const [latest] = state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM records WHERE room_id = 'general' ORDER BY log_id DESC LIMIT 1").toArray();
		const record = JSON.parse(latest.record_json) as { from: { user_id: string }; body: { text: string; mentions: string[] } };
		expect(record.from.user_id).toBe('admin');
		expect(record.body.mentions).toEqual([bossId]);
		expect(record.body.text).toMatch(new RegExp(`^\\*\\*Storage accounting closed\\.\\*\\*[^]*\\n\\n@${bossId}$`));
	});

	const probe = await stub.fetch(new Request('https://demo.test/?apron_connection_status=1', { headers: { Origin: 'http://localhost:5173', 'X-Apron-Trusted-IP-Key': 'probe-key-for-the-test' } }));
	expect(probe.status).toBe(503);
	expect(probe.headers.get('retry-after')).toBe('60');
	expect(await probe.json()).toEqual({ error: 'Server closed: storage accounting stopped after a cost overrun, until an operator reopens it' });
});

it('answers a status probe with storage unavailable while budget writes fail, and opens again once they work', async () => {
	const stub = env.DEMO.getByName('uncertain-probe');
	const probe = () => stub.fetch(new Request('https://demo.test/?apron_connection_status=1', { headers: { Origin: 'http://localhost:5173', 'X-Apron-Trusted-IP-Key': 'probe-key-for-the-test' } }));
	await runInDurableObject(stub, (instance, state) => {
		state.storage.sql.exec(`CREATE TRIGGER fail_budget_reservation
			BEFORE UPDATE OF reads_reserved ON resource_budgets
			BEGIN SELECT RAISE(ABORT, 'injected budget reservation failure'); END`);
		(instance as unknown as Runtime).store.getRoomState();
		expect((instance as unknown as Runtime).store.accountingStatus().uncertain).toBe(true);
	});
	const refused = await probe();
	expect(refused.status).toBe(503);
	expect(refused.headers.get('retry-after')).toBe('60');
	expect(await refused.json()).toEqual({ error: 'Server storage is unavailable; try again shortly' });

	await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec('DROP TRIGGER fail_budget_reservation'); });
	const reopened = await probe();
	expect(reopened.status).toBe(200);
	expect(await reopened.json()).toEqual({ available: true });
});

it('posts the alert though registration is closed and the admin user does not exist yet', async () => {
	const stub = env.DEMO.getByName('alert-registration-closed');
	const warn = vi.spyOn(console, 'warn');
	await runInDurableObject(stub, async (instance, state) => {
		const store = (instance as unknown as Runtime).store as unknown as Store & { config: { registeredIdentityCount: number } };
		expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM identities WHERE user_id = 'admin'").one().count).toBe(0);
		store.config.registeredIdentityCount = 0;
		const writeDataPoint = vi.fn();
		(instance as unknown as { runtimeEnv: { METRICS?: unknown } }).runtimeEnv.METRICS = { writeDataPoint };
		await (instance as unknown as { notifyAdmins(text: string): Promise<void> }).notifyAdmins('**Budget stop is on.**');
		delete (instance as unknown as { runtimeEnv: { METRICS?: unknown } }).runtimeEnv.METRICS;
		// No admin but the sender: nobody mentioned, nothing pushed.
		expect(writeDataPoint).toHaveBeenCalledWith({ indexes: ['admins_notified'], blobs: ['admins_notified', 'not_pushed'], doubles: [0] });
		const [latest] = state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM records WHERE room_id = 'general' AND kind = 'message' ORDER BY log_id DESC LIMIT 1").toArray();
		expect(JSON.parse(latest.record_json)).toMatchObject({ from: { user_id: 'admin' }, body: { text: '**Budget stop is on.**', format: 'markdown' } });
	});
	expect(warn.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('"admins_notified"'));
});

it('counts alarms and accounting changes in METRICS, and logs why accounting closed', async () => {
	const stub = env.DEMO.getByName('metrics-counters');
	const error = vi.spyOn(console, 'error');
	const points = await runInDurableObject(stub, async (instance, state) => {
		const runtime = instance as unknown as Runtime & { runtimeEnv: { METRICS?: { writeDataPoint(point: unknown): void } }; alarm(): Promise<void> };
		const writeDataPoint = vi.fn();
		runtime.runtimeEnv.METRICS = { writeDataPoint };
		// An alarm with nothing but status work, then one with cleanup due.
		state.storage.sql.exec('UPDATE maintenance SET next_cleanup_ms = ? WHERE id = 1', Date.now() + 3_600_000);
		runtime.store.forgetCleanupDue();
		await runtime.alarm();
		state.storage.sql.exec('UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1');
		runtime.store.forgetCleanupDue();
		await runtime.alarm();
		// A budget write that fails closes accounting as uncertain; it reopens once writes work.
		state.storage.sql.exec(`CREATE TRIGGER fail_budget_reservation
			BEFORE UPDATE OF reads_reserved ON resource_budgets
			BEGIN SELECT RAISE(ABORT, 'injected budget reservation failure'); END`);
		runtime.store.getRoomState();
		state.storage.sql.exec('DROP TRIGGER fail_budget_reservation');
		runtime.store.getRoomState();
		delete runtime.runtimeEnv.METRICS;
		return writeDataPoint.mock.calls.map(([point]) => (point as { blobs: string[] }).blobs);
	});
	expect(points).toEqual([['alarm', 'light'], ['alarm', 'full'], ['accounting', 'uncertain'], ['accounting', 'recovered']]);
	const closed = error.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"accounting_closed"')).map((line) => JSON.parse(line));
	expect(closed).toEqual([{ event: 'accounting_closed', kind: 'uncertain', message: expect.stringContaining('injected budget reservation failure') }]);
});

it('runs the full alarm for an upload deadline stored before a wake, which the instance never saw', async () => {
	await runInDurableObject(env.DEMO.getByName('upload-deadline-wake'), async (instance, state) => {
		const runtime = instance as unknown as Runtime & { alarm(): Promise<void> };
		state.storage.sql.exec('UPDATE maintenance SET next_cleanup_ms = ? WHERE id = 1', Date.now() + 3_600_000);
		runtime.store.forgetCleanupDue();
		// Claimed by an earlier instance: only storage knows its deadline.
		const stored = vi.spyOn(runtime.store, 'nextUploadDeadline').mockReturnValue(Date.now() - 1);
		const expire = vi.spyOn(runtime.store, 'expirePendingUploads');
		await runtime.alarm();
		expect(stored).toHaveBeenCalledTimes(1);
		expect(expire).toHaveBeenCalledTimes(1);
		// Read once per instance: the next alarm goes by what the sweep found.
		await runtime.alarm();
		expect(stored).toHaveBeenCalledTimes(1);
	});
});
