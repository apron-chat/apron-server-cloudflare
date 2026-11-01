import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { ACCOUNT_USAGE_POLICY, DEFAULT_LIMITS } from '../src/budget';
import type { AccountUsageMonitor, AccountUsageSnapshot } from '../src/account-usage';
import { Store } from '../src/store';

const headers = { Origin: 'http://localhost:5173', 'X-Apron-Trusted-IP-Key': 'c'.repeat(22) };

/** Opens a socket straight to `stub`, recording how it closes. */
async function open(stub: DurableObjectStub) {
	const response = await stub.fetch('https://demo.test/ws', { headers: { ...headers, Upgrade: 'websocket' } });
	expect(response.status).toBe(101);
	const socket = response.webSocket!;
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		socket.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }));
	});
	socket.accept();
	return { socket, closed };
}

/**
 * A snapshot that stops the server: past the month's bill cap ($26 of CPU) and sampled on
 * the 1st, when the plan has monthly allowances, so it must hold on every
 * later day of the month (on the 1st itself it is today's); past a daily
 * one, sampled today, otherwise.
 */
function stopSnapshot(now = Date.now()): AccountUsageSnapshot {
	const today = new Date(now).toISOString().slice(0, 10);
	const monthly = ACCOUNT_USAGE_POLICY.monthly;
	const zero = { workerRequests: 0, durableObjectRequests: 0, durableObjectDurationGbSeconds: 0, sqlRowsRead: 0, sqlRowsWritten: 0, storedBytes: 0 };
	if (!monthly) return { day: today, sampledAt: now, ...zero, workerRequests: ACCOUNT_USAGE_POLICY.daily.workerRequests, stop: true };
	const first = `${today.slice(0, 8)}01`;
	return {
		day: first,
		sampledAt: Date.parse(`${first}T12:00:00Z`),
		...zero,
		month: {
			month: today.slice(0, 7),
			workerRequests: 0, workerCpuMs: monthly.workerCpuMs + 1_300_000_000, durableObjectRequests: 0, durableObjectDurationGbSeconds: 0,
			sqlRowsRead: 0, sqlRowsWritten: 0, logBytes: 0,
		},
		stop: true,
	};
}

it('keeps a saved account-usage stop across a wake, refusing new connections', async () => {
	const stub = env.DEMO.getByName('account-usage-stop-wake');
	await runInDurableObject(stub, (_instance, state) => {
		const store = new Store(state, {});
		store.initialize();
		store.persistAccountUsageSnapshot(stopSnapshot());
	});
	await evictDurableObject(stub);
	const response = await stub.fetch('https://demo.test/ws', { headers: { ...headers, Upgrade: 'websocket' } });
	expect(response.status).toBe(503);
	expect(response.headers.get('Retry-After')).toBe('300');
	expect(await response.json()).toEqual({ error: 'Demo account capacity reached' });
});

it('closes a socket on its next frame once the account-usage stop holds', async () => {
	const stub = env.DEMO.getByName('account-usage-stop-frame');
	const peer = await open(stub);
	await runInDurableObject(stub, (instance) => {
		(instance as unknown as { accountUsage: AccountUsageMonitor }).accountUsage.restore(stopSnapshot());
	});
	peer.socket.send(JSON.stringify({ id: 'after-stop', method: 'auth', params: { scheme: 'guest' } }));
	expect(await peer.closed).toEqual({ code: 1013, reason: 'Demo account capacity reached; try later' });
});

it('keeps every socket open when the daily frame budget runs out, refusing requests until the reset and telling the user once', async () => {
	const stub = env.DEMO.getByName('frame-budget-keep-open');
	const first = await open(stub);
	const second = await open(stub);
	await runInDurableObject(stub, (_instance, state) => {
		const cursor = state.storage.sql.exec(
			"UPDATE principal_limits SET day = ?, posts_day = ? WHERE scope = 'frames' AND principal_key = 'global'",
			new Date().toISOString().slice(0, 10), DEFAULT_LIMITS.processedFramesPerDay,
		);
		expect(cursor.rowsWritten).toBe(1);
	});
	const replies: Array<{ id?: string; error?: { code: number; message: string; data?: { retry_after?: number } } }> = [];
	const notices: string[] = [];
	first.socket.addEventListener('message', (event) => {
		const frame = JSON.parse(String(event.data));
		if (typeof frame.id === 'string' && frame.id.startsWith('over-budget')) replies.push(frame);
		if (frame.method === 'message' && frame.params?.from?.user_id === '~private' && !String(frame.params.body.text).startsWith('Welcome')) notices.push(frame.params.body.text);
	});
	const warn = vi.spyOn(console, 'warn');
	first.socket.send(JSON.stringify({ id: 'over-budget', method: 'auth', params: { scheme: 'guest' } }));
	await vi.waitFor(() => expect(replies).toHaveLength(1));
	expect(replies[0].error?.message).toBe('Daily frame budget exhausted');
	expect(replies[0].error?.data?.retry_after).toBeGreaterThan(0);
	// A refusal that lasts is explained once, in a ~private notice asking for a report.
	await vi.waitFor(() => expect(notices).toHaveLength(1));
	expect(notices[0]).toMatch(/^\*\*Daily frame budget exhausted\.\*\* The server has handled as many messages and requests as it allows in a day\. This lasts until/);
	expect(notices[0]).toMatch(/please report it to an admin with the code `frame_budget` and the time \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/);
	// Retrying is refused again, without another notice or count.
	first.socket.send(JSON.stringify({ id: 'over-budget-again', method: 'auth', params: { scheme: 'guest' } }));
	await vi.waitFor(() => expect(replies).toHaveLength(2));
	await runInDurableObject(stub, (instance) => {
		expect((instance as unknown as { store: Store }).store.throttleTrips()).toEqual([['frame_budget', 1]]);
	});
	expect(notices).toHaveLength(1);
	expect(warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"throttle_tripped"'))).toEqual([
		expect.stringContaining('"trigger":"frame_budget","method":"auth"'),
	]);
	// Neither socket is closed: readers stay connected, and nobody reconnects into the same refusal.
	const closed = await Promise.race([first.closed, second.closed, new Promise((resolve) => setTimeout(() => resolve('open'), 200))]);
	expect(closed).toBe('open');
	first.socket.close();
	second.socket.close();
});
