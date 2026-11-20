// The Store's head directly above the cold tier (HISTORY_BLOB bound, no D1):
// a copy asks the head for a whole chunk, but the head scans at most
// HISTORY_SCAN_BATCH log IDs at once (HistoryTier.scanLimit). The copy must
// gather the chunk over several scans and never take a capped scan for the
// end of the head's records: cleanup trims below the copy marker.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { HistoryChain } from "../../src/history/chain";
import { buildHistoryChain } from "../../src/history/config";
import { R2BlobStore } from "../../src/history/storage/r2";
import type { Store } from "../../src/store";

const stub = () => env.DEMO.getByName("head-to-cold-v1");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Runtime = { store: Store & { config: Record<string, unknown> }; config: { limits: Record<string, number> }; history?: HistoryChain; alarm(): Promise<void> };

it("loses nothing when the head copies straight into the cold tier", async () => {
	await runInDurableObject(stub(), async (instance, state) => {
		const runtime = instance as unknown as Runtime;
		runtime.store.config = { ...runtime.store.config, retentionRecords: 3, minRetentionMs: 0, cleanupThresholdPercent: 100, anonymousPostsPerMinute: 100_000, ipPostsPerMinute: 100_000, globalPostsPerMinute: 100_000 };
		runtime.config = { ...runtime.config, limits: { ...runtime.config.limits, retentionRecords: 3, historyD1Records: 0, cleanupThresholdPercent: 100 } };
		runtime.history = buildHistoryChain({
			layout: { blobs: new R2BlobStore(env.HISTORY_BLOB!), blobLabel: "R2" }, limits: runtime.config.limits as never, store: runtime.store,
			clock: { now: Date.now }, chunkIndex: (tier) => runtime.store.chunkIndex(tier), server: `head-to-cold-${Date.now()}`,
		});
		const logs: number[] = [];
		for (let index = 0; index < 150; index += 1) {
			const result = runtime.store.mutate({ userId: "p", ipKey: "ip", requestId: `r-${index}`, method: "message", now: Date.now(), params: { room_id: "general", body: { format: "plain", text: `m ${index}` } }, identity: { user_id: "p", name: "p" } });
			logs.push(Number(result.message!.log_id));
			await sleep(2);
		}
		for (let round = 0; round < 12; round += 1) {
			state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1");
			runtime.store.forgetCleanupDue();
			await runtime.alarm();
		}
		const hot = state.storage.sql.exec<{ log_id: number }>("SELECT log_id FROM records ORDER BY log_id").toArray().map((row) => Number(row.log_id));
		const cold = (await runtime.history!.tiers[1].scan(0, 100_000)).records.map((record) => record.log_id);
		// Something did move down, and every record is in one tier or the other.
		expect(cold.length).toBeGreaterThan(0);
		const held = new Set([...hot, ...cold]);
		expect(logs.filter((id) => !held.has(id))).toEqual([]);
		// And a page down the chain reads every message, in order.
		const page = await runtime.history!.read({ roomIds: ["general"], lower: 1, upper: Number.MAX_SAFE_INTEGER, forward: true, limit: 1_000 });
		const messages = page.filter((record) => record.kind === "message").map((record) => record.log_id);
		expect(messages).toEqual(logs);
	});
});
