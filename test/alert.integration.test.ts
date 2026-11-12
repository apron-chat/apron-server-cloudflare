import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { Store } from '../src/store';
import { DEFAULT_LIMITS } from '../src/budget';

type Runtime = { store: Store };

afterEach(() => { vi.restoreAllMocks(); });

it('tells the admins of the day\'s first overrun, and the server stays open', async () => {
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
		// Reserving nothing for a read of many rooms overruns: observed, charged, and the work finishes.
		expect(store.withMeter('foreground', { reads: 0, writes: 0 }, () => store.listRooms(now), now)).toHaveLength(101);
		expect(store.accountingStatus().unsafe).toBe(false);
	});

	// The notice runs once the operation has unwound.
	await vi.waitFor(() => expect(warn.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('"admins_notified"')));
	await runInDurableObject(stub, (instance, state) => {
		expect((instance as unknown as Runtime).store.accountingStatus().unsafe).toBe(false);
		const [latest] = state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM records WHERE room_id = 'general' ORDER BY log_id DESC LIMIT 1").toArray();
		const record = JSON.parse(latest.record_json) as { from: { user_id: string }; body: { text: string; mentions: string[] } };
		expect(record.from.user_id).toBe('admin');
		expect(record.body.mentions).toEqual([bossId]);
		expect(record.body.text).toMatch(new RegExp(`^\\*\\*Storage overrun: \`\\w+\`\\*\\* used more rows than it reserved[^]*the server stays open[^]*\\n\\n@${bossId}$`));
	});

	const probe = await stub.fetch(new Request('https://demo.test/?apron_connection_status=1', { headers: { Origin: 'http://localhost:5173', 'X-Apron-Trusted-IP-Key': 'probe-key-for-the-test' } }));
	expect(probe.status).toBe(200);
	expect(await probe.json()).toEqual({ available: true });
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
	// The first alarm also records the database's size, once within the hour.
	// The accounting change carries what failed: the log line saying so may be sampled away.
	expect(points).toEqual([['alarm', 'light'], ['db_bytes'], ['alarm', 'full'], ['accounting', 'uncertain', expect.stringContaining('injected budget reservation failure')], ['accounting', 'recovered']]);
	const closed = error.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"accounting_closed"')).map((line) => JSON.parse(line));
	expect(closed).toEqual([{ event: 'accounting_closed', kind: 'uncertain', message: expect.stringContaining('injected budget reservation failure') }]);
});

it('runs the full alarm for a live text past its deadline, or open texts a lost instance left, and not otherwise', async () => {
	type LiveRuntime = Runtime & { alarm(): Promise<void>; deadlines: { live: { set(at: number | undefined): boolean } } };
	await runInDurableObject(env.DEMO.getByName('live-deadline-alarm'), async (instance, state) => {
		const runtime = instance as unknown as LiveRuntime;
		state.storage.sql.exec('UPDATE maintenance SET next_cleanup_ms = ? WHERE id = 1', Date.now() + 3_600_000);
		runtime.store.forgetCleanupDue();
		const expire = vi.spyOn(runtime.store, 'expireLiveTexts');
		// No open text to recover: a light alarm.
		await runtime.alarm();
		expect(expire).not.toHaveBeenCalled();
		// A text past its deadline: the full alarm ends it (the time limit).
		runtime.deadlines.live.set(Date.now() - 1);
		await runtime.alarm();
		expect(expire).toHaveBeenCalledTimes(1);
	});
	await runInDurableObject(env.DEMO.getByName('live-lost-alarm'), async (instance, state) => {
		const runtime = instance as unknown as LiveRuntime;
		state.storage.sql.exec('UPDATE maintenance SET next_cleanup_ms = ? WHERE id = 1', Date.now() + 3_600_000);
		runtime.store.forgetCleanupDue();
		// Open in storage, from an instance that was evicted or redeployed.
		vi.spyOn(runtime.store, 'openLiveTexts').mockReturnValue([{} as ReturnType<Store['openLiveTexts']>[number]]);
		const expire = vi.spyOn(runtime.store, 'expireLiveTexts').mockReturnValue({ broadcasts: [], ended: [], next: undefined } as unknown as ReturnType<Store['expireLiveTexts']>);
		await runtime.alarm();
		expect(expire).toHaveBeenCalledTimes(1);
	});
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

it('tells the admins once when the database passes half its high-water mark, and again only after it falls under 40%', async () => {
	type Sized = Runtime & {
		maybeRecordDatabaseSize(now: number): void;
		notifyAdmins(text: string): Promise<void>;
		databaseSizeRecordedAt: number;
		storageAlerted?: boolean;
	};
	const told: string[] = [];
	let size = 0;
	const high = DEFAULT_LIMITS.databaseHighWaterBytes;
	await runInDurableObject(env.DEMO.getByName('storage-alert'), async (instance) => {
		const runtime = instance as unknown as Sized;
		vi.spyOn(runtime.store, 'databaseSize').mockImplementation(() => size);
		vi.spyOn(runtime, 'notifyAdmins').mockImplementation(async (text) => { told.push(text); });
		// One hourly reading at `bytes`.
		const reading = async (bytes: number) => {
			size = bytes;
			runtime.databaseSizeRecordedAt = -Infinity;
			runtime.maybeRecordDatabaseSize(Date.now());
			await new Promise((resolve) => setTimeout(resolve, 10));
		};
		await reading(Math.floor(high * 0.3));
		expect(told).toEqual([]);
		await reading(Math.ceil(high * 0.55));
		expect(told).toHaveLength(1);
		expect(told[0]).toMatch(/^\*\*The database is at 422 MiB, 55% of the 768 MiB where posting stops\.\*\* Nothing is refused yet\./);
		expect(told[0]).toContain('told again only after it falls under 307 MiB');
		// Still high, an hour later and after the instance restarts (the flag is kept in storage): no repeat.
		await reading(Math.ceil(high * 0.6));
		delete runtime.storageAlerted;
		await reading(Math.ceil(high * 0.6));
		await reading(Math.floor(high * 0.45));
		expect(told).toHaveLength(1);
		// Under 40% it is armed again, and the next crossing tells again.
		await reading(Math.floor(high * 0.35));
		await reading(Math.ceil(high * 0.5));
		expect(told).toHaveLength(2);
		// Past the mark itself (a deploy onto a full database), it says posting is refused.
		await reading(Math.floor(high * 0.35));
		await reading(high);
		expect(told[2]).toContain('Posting that grows it is refused now.');
	});
});

it('tells the admins once when long room descriptions fill their total, naming the largest public rooms, and again only after it falls under 75%', async () => {
	type Noted = Runtime & {
		maybeAlertRoomNotes(now: number): void;
		notifyAdmins(text: string): Promise<void>;
		roomNotesAlerted?: boolean;
	};
	const told: string[] = [];
	await runInDurableObject(env.DEMO.getByName('room-notes-alert'), async (instance) => {
		const runtime = instance as unknown as Noted;
		const store = runtime.store;
		vi.spyOn(runtime, 'notifyAdmins').mockImplementation(async (text) => { told.push(text); });
		// Small limits, so a few rooms fill the total.
		Object.assign(store.config, { roomMetadataLimit: 1_000, roomMetadataMinLimit: 200, roomMetadataTotalLimit: 1_800 });
		const now = Date.now();
		store.createInvitedIdentity({ userId: 'mia', name: 'mia', now, ipKey: 'ip-test' });
		let request = 0;
		// A room_set as handleRoomSet makes it, then the alert check it runs either way; the error code, if any.
		const save = async (params: Record<string, unknown>): Promise<string> => {
			let outcome = 'ok';
			try {
				const result = store.mutate({ userId: 'mia', ipKey: 'ip-test', requestId: `r${++request}`, method: 'room_set', now: Date.now(), params, identity: { user_id: 'mia', name: 'mia' } });
				outcome = String(result.result.room_id);
			} catch (error) {
				outcome = (error as { code?: string }).code ?? 'error';
			} finally {
				runtime.maybeAlertRoomNotes(Date.now());
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
			return outcome;
		};
		const text = (length: number) => 'x'.repeat(length);
		await save({ private: true, title: 'Secret plans', description: text(900) });
		const big = await save({ parent_room_id: 'general', title: 'Big `notes`', description: text(900) });
		const mid = await save({ parent_room_id: 'general', title: 'Mid', description: text(400) });
		expect(told).toEqual([]);
		// Past the total: refused, and the admins are told once, of the public rooms only.
		expect(await save({ parent_room_id: 'general', title: 'More', description: text(400) })).toBe('too_large');
		expect(told).toHaveLength(1);
		expect(told[0]).toMatch(/^\*\*Long room descriptions are full: 1\.\d KiB past 0\.2 KiB a room, of the 1\.8 KiB they may hold together\.\*\*/);
		expect(told[0]).toContain(`The most past it: \`Big 'notes'\` (\`${big}\`, 0.7 KiB), \`Mid\` (\`${mid}\`, 0.2 KiB).`);
		expect(told[0]).not.toContain('Secret');
		expect(told[0]).toContain('Told again only after it falls under 1.3 KiB.');
		// A short room still saves; later refusals, and a new instance (the flag is kept in storage), tell nothing more.
		expect(await save({ parent_room_id: 'general', title: 'Short' })).not.toBe('too_large');
		expect(await save({ parent_room_id: 'general', title: 'More', description: text(400) })).toBe('too_large');
		delete runtime.roomNotesAlerted;
		expect(await save({ room_id: mid, title: 'Mid', description: text(700) })).toBe('too_large');
		expect(told).toHaveLength(1);
		// Shrinking checks nothing; the next save that grows a room sees the total under 75%, which arms it again.
		await save({ room_id: big, title: 'Big', description: text(100) });
		expect(await save({ room_id: mid, title: 'Mid', description: text(650) })).toBe(mid);
		expect(store.roomNotesAlerted()).toBe(false);
		expect(await save({ room_id: big, title: 'Big', description: text(900) })).toBe('too_large');
		expect(told).toHaveLength(2);
	});
});
