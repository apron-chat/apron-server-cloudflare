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

it('logs how long a timer kept the object awake since its last activity', async () => {
	const log = vi.spyOn(console, 'log');
	await runInDurableObject(env.DEMO.getByName('timer-log'), (instance) => {
		const server = instance as unknown as { noteActivity(): void; noteTimerFired(timer: string): void };
		const start = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(start);
		server.noteActivity();
		vi.spyOn(Date, 'now').mockReturnValue(start + 45_000);
		server.noteTimerFired('push_wake');
		vi.spyOn(Date, 'now').mockReturnValue(start + 60_000);
		server.noteTimerFired('push_wake');
	});
	const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"timer_kept_awake"')).map((line) => JSON.parse(line));
	// The second counts only from the first: a timer firing is activity too.
	expect(lines).toEqual([{ event: 'timer_kept_awake', timer: 'push_wake', ms: 45_000 }, { event: 'timer_kept_awake', timer: 'push_wake', ms: 15_000 }]);
});

it('posts the alert though registration is closed and the admin user does not exist yet', async () => {
	const stub = env.DEMO.getByName('alert-registration-closed');
	const warn = vi.spyOn(console, 'warn');
	await runInDurableObject(stub, async (instance, state) => {
		const store = (instance as unknown as Runtime).store as unknown as Store & { config: { registeredIdentityCount: number } };
		expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM identities WHERE user_id = 'admin'").one().count).toBe(0);
		store.config.registeredIdentityCount = 0;
		await (instance as unknown as { notifyAdmins(text: string): Promise<void> }).notifyAdmins('**Budget stop is on.**');
		const [latest] = state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM records WHERE room_id = 'general' AND kind = 'message' ORDER BY log_id DESC LIMIT 1").toArray();
		expect(JSON.parse(latest.record_json)).toMatchObject({ from: { user_id: 'admin' }, body: { text: '**Budget stop is on.**', format: 'markdown' } });
	});
	expect(warn.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('"admins_notified"'));
});
