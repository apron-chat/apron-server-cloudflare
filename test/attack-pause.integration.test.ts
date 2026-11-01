import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker, { resetEntrySamples, sampleEntry } from '../src/index';
import { BURN_POLICY } from '../src/burn';
import { BREAKER_MS } from '../src/store';

afterEach(() => { vi.restoreAllMocks(); resetEntrySamples(); });

const headers = { Origin: 'http://localhost:5173', 'X-Apron-Trusted-IP-Key': 'd'.repeat(22) };

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
	notifyAdmins(text: string): Promise<void>;
	attackPauseRecord?: { until: number; count: number; trigger: string } | null;
	burnCheckedAt: number;
	store: { attackPause(): string; accountingGuard(now: number): { breakers: Record<string, number> } };
	evaluateTier(now: number): void;
};

it('pauses on a flood of refused entry requests: closes every socket, refuses everything, announces it, and stays paused across a wake', async () => {
	const stub = env.DEMO.getByName('attack-pause-flood');
	const peer = await open(stub);
	const told: string[] = [];
	await runInDurableObject(stub, (instance) => {
		vi.spyOn(instance as unknown as Runtime, 'notifyAdmins').mockImplementation(async (text) => { told.push(text); });
		// The open just weighed the meter; weigh it again at the next event.
		(instance as unknown as Runtime).burnCheckedAt = 0;
	});
	// 200,000 requests answered at the entry Worker in the last minute, nearly all refused.
	await (stub as unknown as { noteEntrySamples(seen: number, refused: number): Promise<void> }).noteEntrySamples(200_000, 190_000);
	expect(await peer.closed).toEqual({ code: 1013, reason: 'Server paused: unusual traffic; try later' });
	const refused = await stub.fetch('https://demo.test/ws', { headers: { ...headers, Upgrade: 'websocket' } });
	expect(refused.status).toBe(503);
	expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(29 * 60);
	expect(await refused.json()).toEqual({ error: 'Server paused: unusual traffic; try later' });
	await vi.waitFor(() => expect(told).toHaveLength(1));
	expect(told[0]).toMatch(/^\*\*Server tier: paused \(attack\)\*\* \(was open\)\. A flood of refused requests: \$\d+\.\d\d\/h, 95% of 200,00\d requests refused; held until \d{4}-\d\d-\d\d \d\d:\d\d UTC\. Traffic is costing money fast/);
	await evictDurableObject(stub);
	const afterWake = await stub.fetch('https://demo.test/ws', { headers: { ...headers, Upgrade: 'websocket' } });
	expect(afterWake.status).toBe(503);
	// Once the hold has passed, it admits again; the next pause that day holds twice as long.
	await runInDurableObject(stub, (instance) => {
		const runtime = instance as unknown as Runtime;
		expect(JSON.parse(runtime.store.attackPause())).toMatchObject({ count: 1, trigger: 'flood' });
		runtime.attackPauseRecord = { ...runtime.attackPauseRecord!, until: Date.now() - 1 };
	});
	const reopened = await open(stub);
	await runInDurableObject(stub, (instance) => {
		const runtime = instance as unknown as Runtime;
		runtime.burnCheckedAt = 0;
		vi.spyOn(runtime, 'notifyAdmins').mockImplementation(async () => {});
	});
	await (stub as unknown as { noteEntrySamples(seen: number, refused: number): Promise<void> }).noteEntrySamples(200_000, 190_000);
	await reopened.closed;
	await runInDurableObject(stub, (instance) => {
		const record = (instance as unknown as Runtime).attackPauseRecord!;
		expect(record.count).toBe(2);
		expect(record.until - Date.now()).toBeGreaterThan(59 * 60_000);
	});
});

it('keeps admitted heavy traffic open, telling the admins once an hour', async () => {
	const stub = env.DEMO.getByName('attack-pause-launch');
	const peer = await open(stub);
	const told: string[] = [];
	await runInDurableObject(stub, (instance) => {
		vi.spyOn(instance as unknown as Runtime, 'notifyAdmins').mockImplementation(async (text) => { told.push(text); });
		// The open just weighed the meter; weigh it again at the next event.
		(instance as unknown as Runtime).burnCheckedAt = 0;
	});
	// Served by the entry Worker (media, assets) and mostly not refused: a launch, not an attack.
	await (stub as unknown as { noteEntrySamples(seen: number, refused: number): Promise<void> }).noteEntrySamples(500_000, 10_000);
	await vi.waitFor(() => expect(told).toHaveLength(1));
	expect(told[0]).toMatch(/^\*\*Heavy traffic\*\* \(\$\d+\.\d\d\/h, 2% of 500,00\d requests refused, priced as if past the plan's inclusions\)/);
	await runInDurableObject(stub, (instance) => { (instance as unknown as Runtime).burnCheckedAt = 0; });
	await (stub as unknown as { noteEntrySamples(seen: number, refused: number): Promise<void> }).noteEntrySamples(500_000, 10_000);
	expect(told).toHaveLength(1);
	const closed = await Promise.race([peer.closed, new Promise((resolve) => setTimeout(() => resolve('open'), 100))]);
	expect(closed).toBe('open');
	peer.socket.close();
});

it('pauses when breakers are open on three actions, once for the same ones', async () => {
	const stub = env.DEMO.getByName('attack-pause-breakers');
	await runInDurableObject(stub, (instance) => {
		const runtime = instance as unknown as Runtime;
		vi.spyOn(runtime, 'notifyAdmins').mockImplementation(async () => {});
		const until = Date.now() + BREAKER_MS;
		vi.spyOn(runtime.store, 'accountingGuard').mockReturnValue({ day: '', overruns: 3, breakers: { a: until, b: until, c: until } } as never);
		runtime.evaluateTier(Date.now());
		expect(runtime.attackPauseRecord).toMatchObject({ trigger: 'breakers', count: 1 });
		// The hold passes with the same three still open: no second pause.
		runtime.attackPauseRecord = { ...runtime.attackPauseRecord!, until: Date.now() - 1 };
		runtime.evaluateTier(Date.now());
		expect(runtime.attackPauseRecord).toMatchObject({ count: 1 });
	});
});

it('samples the entry Worker\'s own answers, not the object\'s, and reports at most once a second an isolate', async () => {
	const notes: Array<[number, number]> = [];
	const fake = { getByName: () => ({ noteEntrySamples: async (seen: number, refused: number) => { notes.push([seen, refused]); } }) };
	const waits: Promise<unknown>[] = [];
	const ctx = { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } };
	const sampled = () => 0;
	const now = Date.parse('2026-11-02T12:00:00Z');
	const every = BURN_POLICY.entrySampleEvery;
	sampleEntry({ DEMO: fake } as never, ctx, new Response(null, { status: 429 }), now, sampled);
	sampleEntry({ DEMO: fake } as never, ctx, new Response(null, { status: 200 }), now + 10, sampled);
	sampleEntry({ DEMO: fake } as never, ctx, new Response(null, { status: 403 }), now + 20, () => 0.5);
	sampleEntry({ DEMO: fake } as never, ctx, new Response(null, { status: 503 }), now + 1_000, sampled);
	await Promise.all(waits);
	expect(notes).toEqual([[every, every], [2 * every, every]]);
	// A request the object answered is its own to count.
	const fromObject = await worker.fetch(new Request('https://server.example/ws', { headers: { Origin: 'http://localhost:5173' } }), env, ctx as never);
	expect(fromObject.status).toBeGreaterThanOrEqual(400);
});
