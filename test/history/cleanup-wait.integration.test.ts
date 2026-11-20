// A cleanup job that waits for the copy below looks again in a second only
// while a cycle can run next wake. Blocked (the D1 tier off while it holds
// history, or a history job holding the lock), it waits HISTORY_RETRY_MS:
// no alarm a second for as long as the block lasts.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { HistoryChain } from "../../src/history/chain";
import { buildHistoryChain, historyLayout } from "../../src/history/config";
import type { HistorySchedule } from "../../src/history/schedule";
import type { Store } from "../../src/store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Runtime = {
	store: Store & { config: Record<string, unknown> }; config: { limits: Record<string, number> }; history?: HistoryChain;
	runtimeEnv: Record<string, unknown>; d1Held?: boolean; historySchedule: HistorySchedule; alarm(): Promise<void>;
};

async function setUp(runtime: Runtime, state: DurableObjectState, name: string) {
	runtime.store.config = { ...runtime.store.config, retentionRecords: 3, minRetentionMs: 0, cleanupThresholdPercent: 100, anonymousPostsPerMinute: 100_000, ipPostsPerMinute: 100_000, globalPostsPerMinute: 100_000 };
	runtime.config = { ...runtime.config, limits: { ...runtime.config.limits, retentionRecords: 3, historyD1Records: 100, cleanupThresholdPercent: 100 } };
	const build = (bindings: Record<string, unknown>) => buildHistoryChain({
		layout: historyLayout(bindings as never, runtime.config.limits as never), limits: runtime.config.limits as never, store: runtime.store,
		clock: { now: Date.now }, chunkIndex: (tier) => runtime.store.chunkIndex(tier), server: `${name}-${Date.now()}`,
	});
	runtime.history = build(env as never);
	let posted = 0;
	const post = async (count: number) => {
		for (let index = 0; index < count; index += 1, posted += 1) {
			runtime.store.mutate({ userId: "p", ipKey: "ip", requestId: `${name}-${posted}`, method: "message", now: Date.now(), params: { room_id: "general", body: { format: "plain", text: `m ${posted}` } }, identity: { user_id: "p", name: "p" } });
			await sleep(2);
		}
	};
	const cleanupNow = () => {
		state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1");
		runtime.store.forgetCleanupDue();
	};
	/** How long after now the next cleanup is due, after one alarm. */
	const nextCleanupAfterAlarm = async () => {
		cleanupNow();
		const before = Date.now();
		await runtime.alarm();
		const row = state.storage.sql.exec<{ next_cleanup_ms: number; cleanup_cursor: number | null }>("SELECT next_cleanup_ms, cleanup_cursor FROM maintenance WHERE id = 1").toArray()[0];
		return { wait: row.next_cleanup_ms - before, waiting: row.cleanup_cursor !== null };
	};
	return { build, post, nextCleanupAfterAlarm };
}

it("waits minutes, not a second, while the D1 tier is off and holds history", async () => {
	await runInDurableObject(env.DEMO.getByName("cleanup-wait-d1-off-v1"), async (instance, state) => {
		const runtime = instance as unknown as Runtime;
		const { build, post, nextCleanupAfterAlarm } = await setUp(runtime, state, "d1-off");
		await post(10);
		for (let round = 0; round < 6; round += 1) await nextCleanupAfterAlarm();
		runtime.runtimeEnv = { ...runtime.runtimeEnv, HISTORY_D1: undefined };
		runtime.d1Held = undefined;
		runtime.history = build({ ...env, HISTORY_D1: undefined });
		await post(10);
		for (let round = 0; round < 3; round += 1) {
			const { wait, waiting } = await nextCleanupAfterAlarm();
			expect(waiting).toBe(true);
			expect(wait).toBeGreaterThan(60_000);
		}
	});
});

it("waits minutes, not a second, while a history job holds the lock", async () => {
	await runInDurableObject(env.DEMO.getByName("cleanup-wait-job-v1"), async (instance, state) => {
		const runtime = instance as unknown as Runtime;
		const { post, nextCleanupAfterAlarm } = await setUp(runtime, state, "job");
		await post(10);
		for (let round = 0; round < 6; round += 1) await nextCleanupAfterAlarm();
		await post(10);
		const lease = runtime.historySchedule.acquire({ kind: "job", job: "export" });
		expect("refused" in lease).toBe(false);
		for (let round = 0; round < 3; round += 1) {
			const { wait, waiting } = await nextCleanupAfterAlarm();
			expect(waiting).toBe(true);
			expect(wait).toBeGreaterThan(60_000);
		}
		// Released, the cycle it held up is asked for, and the copy goes on.
		if (!("refused" in lease)) expect(lease.release().cycleSoon).toBe(true);
	});
});
