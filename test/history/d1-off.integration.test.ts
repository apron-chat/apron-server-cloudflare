// D1 holds history from the first copy into it, not first from its first
// trim: a deploy that drops it (HISTORY_D1 unbound, or its limit 0) before
// then must stop the chain, not rebuild it as SQLite → cold. The copy
// marker out of SQLite describes D1: a cold tier in its place would take it
// for its own and skip what D1 holds, and cleanup would then delete it.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { HistoryChain } from "../../src/history/chain";
import { buildHistoryChain, historyLayout } from "../../src/history/config";
import type { Store } from "../../src/store";

const stub = () => env.DEMO.getByName("d1-off-before-first-trim-v1");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Runtime = {
	store: Store & { config: Record<string, unknown> }; config: { limits: Record<string, number> }; history?: HistoryChain;
	runtimeEnv: Record<string, unknown>; d1Held?: boolean; d1Missing(): Promise<string | undefined>; alarm(): Promise<void>;
};

it("stops the chain when D1 goes off after its first copy, before its first trim", async () => {
	await runInDurableObject(stub(), async (instance, state) => {
		const runtime = instance as unknown as Runtime;
		const server = `d1-off-${Date.now()}`;
		runtime.store.config = { ...runtime.store.config, retentionRecords: 3, minRetentionMs: 0, cleanupThresholdPercent: 100, anonymousPostsPerMinute: 100_000, ipPostsPerMinute: 100_000, globalPostsPerMinute: 100_000 };
		runtime.config = { ...runtime.config, limits: { ...runtime.config.limits, retentionRecords: 3, historyD1Records: 100, cleanupThresholdPercent: 100 } };
		const build = (bindings: Record<string, unknown>) => buildHistoryChain({
			layout: historyLayout(bindings as never, runtime.config.limits as never), limits: runtime.config.limits as never, store: runtime.store,
			clock: { now: Date.now }, chunkIndex: (tier) => runtime.store.chunkIndex(tier), server,
		});
		runtime.history = build(env as never);
		const post = async (count: number, tag: string) => {
			const ids: number[] = [];
			for (let index = 0; index < count; index += 1) {
				const result = runtime.store.mutate({ userId: "p", ipKey: "ip", requestId: `${tag}-${index}`, method: "message", now: Date.now(), params: { room_id: "general", body: { format: "plain", text: `${tag} ${index}` } }, identity: { user_id: "p", name: "p" } });
				ids.push(Number(result.message!.log_id));
				await sleep(2);
			}
			return ids;
		};
		const rounds = async (count: number) => {
			for (let round = 0; round < count; round += 1) {
				state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1");
				runtime.store.forgetCleanupDue();
				await runtime.alarm();
			}
		};
		await post(10, "a");
		await rounds(6);
		// Copied into D1, far below its limit: it has never trimmed, but it holds history.
		const marker = (await runtime.history!.view()).links[0].through;
		expect(marker).toBeGreaterThan(0);
		expect(await runtime.history!.hasTierState("recent")).toBe(true);

		// The next deploy has no D1: the chain is built without it, as on a restart.
		runtime.runtimeEnv = { ...runtime.runtimeEnv, HISTORY_D1: undefined };
		runtime.d1Held = undefined;
		runtime.history = build({ ...env, HISTORY_D1: undefined });
		expect(await runtime.d1Missing()).toBe("unbound");
		const later = await post(10, "b");
		await rounds(4);
		// Nothing went past D1 into the cold tier, and SQLite let nothing go: it keeps what it holds until D1 is back.
		const cold = runtime.history!.tiers[1];
		expect(cold.name).toBe("cold");
		expect((await cold.scan(0, 1_000)).records).toEqual([]);
		expect((await runtime.history!.view()).links[0].through).toBe(marker);
		const hot = new Set(state.storage.sql.exec<{ log_id: number }>("SELECT log_id FROM records").toArray().map((row) => Number(row.log_id)));
		expect(later.filter((id) => !hot.has(id))).toEqual([]);
		// The copy out of SQLite counts as stalled, for the alert.
		expect((await runtime.history!.view()).links[0].stall.kind).not.toBe("ok");
	});
});
