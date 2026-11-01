import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../src/budget';
import { Store, type OverrunNotice } from '../src/store';

afterEach(() => { vi.restoreAllMocks(); });

type Priv = {
	observed: { reads: number; writes: number };
	reserved: (cost: object, maintenance: boolean, now: number, fn: () => unknown) => unknown;
	reserveCost: (cost: object, maintenance: boolean, now: number) => any;
	transaction: <T>(fn: () => T) => T;
	assertReservation: (r: any, br: number, bw: number) => void;
	settleReservation: (r: any, br: number, bw: number) => void;
	assertAccounting: () => void;
	rawRows: (q: string) => unknown[];
	guard: any;
};

class ProbeStore extends Store {
	/** Shaped like commitMutation/cleanup: reserve, a transaction with an in-transaction assert, then settle. */
	twoTx(now: number, extraPerTx: number, transactions: number): void {
		const self = this as unknown as Priv;
		self.assertAccounting();
		const br = self.observed.reads, bw = self.observed.writes;
		const r = self.reserveCost({ reads: 0 }, false, now);
		try {
			for (let i = 0; i < transactions; i += 1) {
				self.transaction(() => { self.observed.reads += extraPerTx; self.assertReservation(r, br, bw); });
			}
		} finally { self.settleReservation(r, br, bw); }
	}
	/** An outer reservation that is generous, with a nested inner one that overruns. */
	nested(now: number): void {
		const self = this as unknown as Priv;
		self.reserved({ reads: 5000 }, false, now, () => {
			self.reserved({ reads: 0 }, false, now, () => { self.observed.reads += 100; });
		});
	}
	plainOverrun(now: number): void {
		const self = this as unknown as Priv;
		self.reserved({ reads: 0 }, false, now, () => { self.observed.reads += 100; });
	}
}

const fg = (state: DurableObjectState) => state.storage.sql.exec<{ foreground_reads: number }>('SELECT foreground_reads FROM resource_budgets ORDER BY day DESC LIMIT 1').one().foreground_reads;

it('P1: name of an in-transaction overrun in a real mutation', async () => {
	await runInDurableObject(env.DEMO.getByName('probe-p1'), async (_i, state) => {
		const now = Date.now() + 3000;
		const store = new Store(state, {}, { now: () => now });
		store.initialize();
		const notices: OverrunNotice[] = [];
		store.onOverrun = (n) => notices.push(n);
		const s = store as unknown as Priv & { commitStoredResult: (...a: unknown[]) => unknown };
		const orig = s.commitStoredResult.bind(store);
		s.commitStoredResult = (...a: unknown[]) => { s.observed.reads += 400; return orig(...a); };
		for (let i = 0; i < 3; i += 1) {
			store.mutate({ userId: 'u1', tier: 'anonymous', ipKey: 'ip1', method: 'message', now, requestId: `r${i}`, params: { room_id: 'general', body: { text: 'hi' + i } }, identity: { user_id: 'u1', name: 'U', tier: 'anonymous' } } as any);
		}
		await Promise.resolve();
		console.log('P1 names', notices.map((n) => [n.operation, n.breaker]));
		console.log('P1 breakers', store.accountingGuard(now).breakers);
		let refused: unknown = 'not refused';
		try { store.mutate({ userId: 'u1', tier: 'anonymous', ipKey: 'ip1', method: 'message', now, requestId: 'r9', params: { room_id: 'general', body: { text: 'again' } }, identity: { user_id: 'u1', name: 'U', tier: 'anonymous' } } as any); }
		catch (e) { refused = (e as any).data?.reason ?? String(e); }
		console.log('P1 fourth mutation after breaker', refused);
	});
});

it('P2: excess charged across two in-transaction asserts (cleanup shape)', async () => {
	await runInDurableObject(env.DEMO.getByName('probe-p2'), async (_i, state) => {
		const now = Date.now() + 3000;
		const store = new ProbeStore(state, {}, { now: () => now });
		store.initialize();
		store.getRoomState();
		const before = fg(state);
		store.twoTx(now, 1000, 2);
		console.log('P2 used 2000 extra reads; foreground_reads delta', fg(state) - before);
		const b2 = fg(state);
		store.twoTx(now, 1000, 1);
		console.log('P2 single tx with 1000 extra; delta', fg(state) - b2);
	});
});

it('P3: nested reservation refund after inner overrun', async () => {
	await runInDurableObject(env.DEMO.getByName('probe-p3'), async (_i, state) => {
		const now = Date.now() + 3000;
		const store = new ProbeStore(state, {}, { now: () => now });
		store.initialize();
		store.getRoomState();
		let before = fg(state);
		store.nested(now);
		console.log('P3 nested(inner overruns by ~92): foreground_reads delta', fg(state) - before);
		before = fg(state);
		const self = store as unknown as Priv;
		self.reserved({ reads: 5000 }, false, now, () => { self.observed.reads += 100; });
		console.log('P3 control, same outer w/o inner overrun: delta', fg(state) - before);
		await Promise.resolve();
		console.log('P3 overruns', store.accountingGuard(now).overruns);
	});
});

it('P4: pause blocks /status pieces and alarm scheduling', async () => {
	await runInDurableObject(env.DEMO.getByName('probe-p4'), async (instance, state) => {
		const now = Date.now() + 3000;
		const rt = instance as unknown as { store: Store };
		const store = rt.store;
		store.initialize();
		(store as unknown as Priv).guard.pausedUntil = now + 3_600_000;
		const tryIt = async (name: string, fn: () => unknown) => {
			try { await fn(); console.log('P4', name, 'ok'); } catch (e) { console.log('P4', name, 'THROWS', (e as any).data?.reason ?? String(e)); }
		};
		await tryIt('status', () => store.status());
		await tryIt('throttleTrips', () => store.throttleTrips());
		await tryIt('pushesToday', () => store.pushesToday());
		await tryIt('scheduleAlarm', () => store.scheduleAlarm(now + 10_000));
		await tryIt('cleanup', () => (store as any).cleanup?.(now + 86_400_000 * 2));
		await tryIt('checkConnectionBudget', () => store.checkConnectionBudget());
		await tryIt('announcedTier', () => store.announcedTier());
		await tryIt('notify alert mutate', () => store.alert(() => store.getRoomState()));
	});
});

it('P5: evaluateTier cost and repetition', async () => {
	await runInDurableObject(env.DEMO.getByName('probe-p5'), async (instance, state) => {
		const rt = instance as unknown as { store: Store; evaluateTier(now: number): void; announcedTier?: unknown };
		const now = Date.now();
		rt.store.getRoomState();
		const b = fg(state);
		for (let i = 0; i < 5; i += 1) rt.evaluateTier(now + i);
		console.log('P5 5x evaluateTier, no change: foreground_reads delta', fg(state) - b, 'announced', JSON.stringify(rt.announcedTier));
	});
});

it('P6: overrun names for real ops with a wrapped stack (maintenance overrun via sweep)', async () => {
	await runInDurableObject(env.DEMO.getByName('probe-p6'), async (_i, state) => {
		const now = Date.now() + 3000;
		const store = new ProbeStore(state, {}, { now: () => now });
		store.initialize();
		const notices: OverrunNotice[] = [];
		store.onOverrun = (n) => notices.push(n);
		store.plainOverrun(now);
		const asyncOp = async () => { await Promise.resolve(); store.plainOverrun(now); };
		await asyncOp();
		await Promise.resolve();
		console.log('P6 names', notices.map((n) => n.operation));
		console.log('P6 stack sample', new Error().stack?.split('\n').slice(0, 4).join(' | '));
		void DEFAULT_LIMITS;
	});
});
