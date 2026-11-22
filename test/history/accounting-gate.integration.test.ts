/*
 * The history chain's state is kept in memory once read (history-log.ts),
 * but a cycle is still refused as every reservation would refuse it: with
 * the maintenance budget spent, or accounting closed on a storage failure,
 * no tier below the head is asked for anything (no D1 query, no R2 write
 * whose result could not be recorded), and the cycle fails with the
 * refusal a reservation gives, at its first snapshot. Once work may run
 * again, the cycle reaches the tiers.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { HistoryChain } from "../../src/history/chain";
import { toRange } from "../../src/history/records";
import { chainStateStore } from "../../src/history/state";
import { openStore, type Store, StoreError } from "../../src/store";
import { sqliteOf } from "../../src/store/open";
import { MemoryHistoryTier } from "./support/memory-tiers";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The next UTC midnight: the store's clock starts at a fixed time of day after it (ahead of the running object's own clock), so a run is the same whenever it runs. */
const MIDNIGHT = (Math.floor(Date.now() / DAY_MS) + 1) * DAY_MS;

/**
 * A tiered store whose chain runs over two tiers in memory that log each
 * call, its records moved down and its state read, its clock starting at
 * `start` and two hours later when it returns.
 */
async function warmChain(state: DurableObjectState, start: number) {
	const clock = { now: start };
	const store: Store = openStore(state, {
		tiered: true, historyHotRecords: 3, cleanupThresholdPercent: 100, guestPostsPerMinute: 1e5, ipPostsPerMinute: 1e5, globalPostsPerMinute: 1e5,
	}, { now: () => clock.now });
	store.lifecycle.initialize();
	const calls: string[] = [];
	const logged = (tier: MemoryHistoryTier) => new Proxy(tier, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? (...args: unknown[]) => { calls.push(`${target.name}.${String(prop)}`); return value.apply(target, args); } : value;
		},
	});
	const mid = new MemoryHistoryTier("mid");
	const cold = new MemoryHistoryTier("cold");
	const chain = new HistoryChain({
		head: store.history.head("sqlite"), headRetention: { records: 3, thresholdPercent: 100 },
		stages: [{ tier: logged(mid), retention: { records: 4, thresholdPercent: 100 } }, { tier: logged(cold), retention: { records: 1_000, thresholdPercent: 100 } }],
		state: chainStateStore(store.history.state(), "sqlite"), clock: { now: () => clock.now }, batch: 3,
	});
	for (let index = 0; index < 20; index += 1) {
		clock.now += 10;
		store.messages.mutate({ userId: "p", ipKey: "ip", requestId: `r${index}`, method: "message", now: clock.now, params: { room_id: "general", body: { format: "plain", text: `m ${index}` } }, identity: { user_id: "p", name: "p" } });
	}
	for (let round = 0; round < 15; round += 1) {
		await chain.cycle({ steps: 50 });
		state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1");
		sqliteOf(store).forgetCleanupDue();
		store.lifecycle.runCleanup(clock.now);
		clock.now += 1_000;
	}
	expect(cold.records.size).toBeGreaterThan(0);
	// More records reach the middle tier, and two hours pass: the next cycle
	// has the lower tiers' targets to find again (TARGET_REFRESH_MS).
	await mid.append(toRange(Array.from({ length: 8 }, (_, index) => ({
		room_id: "general", log_id: 10_000 + index, commit_ms: clock.now, kind: "message",
		record_json: JSON.stringify({ message_id: `x${index}`, from: { user_id: "p" }, body: { text: "x" } }),
	}))));
	clock.now = start + 2 * HOUR_MS;
	calls.length = 0;
	return { store, chain, calls };
}

/** The error `cycle` rejects with. */
async function refusal(chain: HistoryChain, calls: readonly string[]): Promise<unknown> {
	let report: unknown;
	try {
		report = await chain.cycle({ steps: 10 });
	} catch (error) {
		return error;
	}
	throw new Error(`expected the cycle to be refused; it ran ${JSON.stringify(calls)} and returned ${String((report as { report: { failure?: { error: unknown } } }).report.failure?.error)}`);
}

for (const [when, start] of [["within a day", MIDNIGHT + HOUR_MS], ["past a UTC midnight", MIDNIGHT + DAY_MS - HOUR_MS]] as const) {
	it(`refuses a history cycle before any tier below while the maintenance budget is spent (${when})`, async () => {
		await runInDurableObject(env.DEMO.getByName(`history-gate-budget-${crypto.randomUUID()}`), async (_instance, state) => {
			const { store, chain, calls } = await warmChain(state, start);
			const config = sqliteOf(store).config as unknown as Record<string, number>;
			const limits = { reads: config.maintenanceReadsPerDay, writes: config.maintenanceWritesPerDay };
			config.maintenanceReadsPerDay = 1;
			config.maintenanceWritesPerDay = 1;

			const error = await refusal(chain, calls);
			expect(error).toBeInstanceOf(StoreError);
			expect((error as StoreError).code).toBe("retry_after");
			expect((error as StoreError).message).toBe("Maintenance budget exhausted");
			expect(calls).toEqual([]);

			// With the budget back, the same cycle reaches the tiers.
			config.maintenanceReadsPerDay = limits.reads;
			config.maintenanceWritesPerDay = limits.writes;
			await chain.cycle({ steps: 10 });
			expect(calls).toContain("mid.floorFor");
		});
	});
}

it("refuses a history cycle before any tier below while accounting is closed on a storage failure", async () => {
	await runInDurableObject(env.DEMO.getByName(`history-gate-uncertain-${crypto.randomUUID()}`), async (_instance, state) => {
		const { store, chain, calls } = await warmChain(state, MIDNIGHT + HOUR_MS);
		state.storage.sql.exec(`CREATE TRIGGER fail_budget_reservation
			BEFORE UPDATE OF reads_reserved ON resource_budgets
			BEGIN SELECT RAISE(ABORT, 'injected budget reservation failure'); END`);
		// A reservation whose settling write fails closes accounting as uncertain.
		try { store.history.hotRecords(); } catch { /* the failure is what closes it */ }
		expect(store.ops.accountingStatus().uncertain).toBe(true);

		const error = await refusal(chain, calls);
		expect(error).toBeInstanceOf(StoreError);
		expect((error as StoreError).message).toBe("storage is unavailable");
		expect(calls).toEqual([]);

		// Storage works again: accounting reopens, and the cycle reaches the tiers.
		state.storage.sql.exec("DROP TRIGGER fail_budget_reservation");
		await chain.cycle({ steps: 10 });
		expect(store.ops.accountingStatus().uncertain).toBe(false);
		expect(calls).toContain("mid.floorFor");
	});
});
