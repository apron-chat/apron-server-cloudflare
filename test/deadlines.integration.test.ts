import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); });

const headers = { Origin: 'http://localhost:5173', 'X-Apron-Trusted-IP-Key': 'e'.repeat(22) };

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

type Runtime = {
	config: { limits: { unauthenticatedTimeoutSeconds: number } };
	attackPauseRecord?: { day: string; until: number; count: number; trigger: string; summary: string } | null;
	rescheduleAlarm(): Promise<void>;
	runAlarm(): Promise<void>;
};

it('closes a connection that never signed in at its next frame past the deadline, with no alarm run', async () => {
	const stub = env.DEMO.getByName(`deadline-auth-${crypto.randomUUID()}`);
	const peer = await open(stub);
	const timeout = await runInDurableObject(stub, (instance) => (instance as unknown as Runtime).config.limits.unauthenticatedTimeoutSeconds);
	const realNow = Date.now.bind(Date);
	vi.spyOn(Date, 'now').mockImplementation(() => realNow() + timeout * 1_000 + 1_000);
	peer.socket.send(JSON.stringify({ id: 'late', method: 'auth', params: { scheme: 'guest' } }));
	expect(await peer.closed).toEqual({ code: 1008, reason: 'Authentication timed out' });
});

it('tags a sign-in timeout as silent when the connection never sent a frame, and counts closed sockets still listed when awake', async () => {
	const stub = env.DEMO.getByName(`deadline-silent-${crypto.randomUUID()}`);
	const peer = await open(stub);
	const writeDataPoint = vi.fn();
	const snapshot = await runInDurableObject(stub, async (instance, state) => {
		const runtime = instance as unknown as Runtime & {
			runtimeEnv: { METRICS?: unknown };
			refusals: { flush(now: number): void };
			awakeSnapshot(): Record<string, number>;
		};
		runtime.runtimeEnv.METRICS = { writeDataPoint };
		const socket = state.getWebSockets()[0];
		const attachment = socket.deserializeAttachment();
		// A socket this object closed and the runtime still lists counts as closing, not pending.
		socket.serializeAttachment({ ...attachment, closing: true });
		const closing = runtime.awakeSnapshot();
		socket.serializeAttachment({ ...attachment, authDeadline: Date.now() - 1 });
		const overdue = runtime.awakeSnapshot();
		await runtime.runAlarm();
		delete runtime.runtimeEnv.METRICS;
		return { closing, overdue };
	});
	expect(snapshot.closing).toMatchObject({ sockets: 1, pending: 0, closing: 1, closing_min: 1 });
	expect(snapshot.overdue).toMatchObject({ sockets: 1, pending: 1, overdue: 1, closing: 0, closing_min: 0 });
	expect(writeDataPoint).toHaveBeenCalledWith({ indexes: ['refusal'], blobs: ['refusal', 'close', '1008 Authentication timed out', 'silent'], doubles: [1] });
	expect(await peer.closed).toEqual({ code: 1008, reason: 'Authentication timed out' });
});

it('does not tag a sign-in timeout as silent when the connection sent a frame', async () => {
	const stub = env.DEMO.getByName(`deadline-heard-${crypto.randomUUID()}`);
	const peer = await open(stub);
	// A real frame before the deadline: its answer says the object has handled it.
	const answered = new Promise<void>((resolve) => peer.socket.addEventListener('message', (event) => {
		if (String(event.data).includes('"id":"early"')) resolve();
	}));
	peer.socket.send(JSON.stringify({ id: 'early', method: 'no_such_method', params: {} }));
	await answered;
	const writeDataPoint = vi.fn();
	await runInDurableObject(stub, async (instance, state) => {
		const runtime = instance as unknown as Runtime & { runtimeEnv: { METRICS?: unknown } };
		runtime.runtimeEnv.METRICS = { writeDataPoint };
		const socket = state.getWebSockets()[0];
		socket.serializeAttachment({ ...socket.deserializeAttachment(), authDeadline: Date.now() - 1 });
		await runtime.runAlarm();
		delete runtime.runtimeEnv.METRICS;
	});
	expect(writeDataPoint).toHaveBeenCalledWith({ indexes: ['refusal'], blobs: ['refusal', 'close', '1008 Authentication timed out', ''], doubles: [1] });
	expect(await peer.closed).toEqual({ code: 1008, reason: 'Authentication timed out' });
});

it('schedules the alarm for read cursors a connection holds, and writes them on a light alarm', async () => {
	const stub = env.DEMO.getByName(`deadline-reads-${crypto.randomUUID()}`);
	const peer = await open(stub);
	const now = Date.now();
	const { alarm, flushed } = await runInDurableObject(stub, async (instance, state) => {
		const runtime = instance as unknown as Runtime & { flushReads(attachment: unknown, now: number, socket: unknown): void };
		const socket = state.getWebSockets()[0];
		// Cursors held since just under a minute ago: they fall due in a second.
		socket.serializeAttachment({ ...socket.deserializeAttachment(), reads: { general: '1' }, readsAt: now - 59_000 });
		await runtime.rescheduleAlarm();
		const alarm = await state.storage.getAlarm();
		const flushes = vi.spyOn(runtime, 'flushReads').mockImplementation(() => {});
		vi.spyOn(Date, 'now').mockImplementation(() => now + 1_500);
		await runtime.runAlarm();
		return { alarm, flushed: flushes.mock.calls.length };
	});
	expect(alarm).not.toBeNull();
	expect(alarm!).toBeLessThanOrEqual(now + 1_000);
	expect(flushed).toBe(1);
	peer.socket.close();
});

it('schedules the alarm for the end of an attack pause, so the change back is told then', async () => {
	const stub = env.DEMO.getByName(`deadline-pause-${crypto.randomUUID()}`);
	const until = Date.now() + 5 * 60_000;
	const alarm = await runInDurableObject(stub, async (instance, state) => {
		const runtime = instance as unknown as Runtime;
		runtime.attackPauseRecord = { day: '', until, count: 1, trigger: 'flood', summary: '' };
		await runtime.rescheduleAlarm();
		const alarm = await state.storage.getAlarm();
		runtime.attackPauseRecord = null;
		return alarm;
	});
	expect(alarm).not.toBeNull();
	expect(alarm!).toBeLessThanOrEqual(until);
});

it('opens a connection with the deployment\'s defaults when the admins\' toggles cannot be read', async () => {
	const stub = env.DEMO.getByName(`toggles-unread-${crypto.randomUUID()}`);
	await runInDurableObject(stub, (instance) => {
		const runtime = instance as unknown as { toggles: Map<string, unknown>; store: { toggle(): unknown; presenceToggle(): unknown } };
		runtime.toggles.clear();
		vi.spyOn(runtime.store, 'toggle').mockImplementation(() => { throw new Error('storage unavailable'); });
		vi.spyOn(runtime.store, 'presenceToggle').mockImplementation(() => { throw new Error('storage unavailable'); });
	});
	const peer = await open(stub);
	const first = await new Promise<{ method?: string }>((resolve) => peer.socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))), { once: true }));
	expect(first.method).toBe('server');
	const read = await runInDurableObject(stub, (instance) => {
		const runtime = instance as unknown as { toggles: Map<string, unknown>; addMemberOn(enforce?: boolean): boolean; activityOn(enforce?: boolean): boolean };
		// Shown as the deployment's default, but nothing the store does not check is allowed on it.
		return { size: runtime.toggles.size, shown: runtime.addMemberOn(), allowed: [runtime.addMemberOn(true), runtime.activityOn(true)] };
	});
	// Not cached: once the store answers, the toggles are read.
	expect(read).toEqual({ size: 0, shown: true, allowed: [false, false] });
	peer.socket.close();
});
