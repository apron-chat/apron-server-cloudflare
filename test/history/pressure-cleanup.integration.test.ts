// A flood that reaches the storage watermark starts cleanup at once, not at
// the daily slot: what is past the count is copied down to D1 and leaves
// SQLite, so posting resumes within a cleanup cycle. Nothing leaves before
// D1 holds it, and with D1 off the pressure is looked at again in minutes,
// not every second.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { HistoryChain } from "../../src/history/chain";
import { buildHistoryChain, historyLayout } from "../../src/history/config";
import { chainStateStore } from "../../src/history/state";
import type { Store } from "../../src/store";
import { expectRetryAfter } from "../helpers/store";

const MIB = 1024 * 1024;
const DAY_MS = 86_400_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Runtime = {
	store: Store & { config: Record<string, unknown> }; config: { limits: Record<string, number> }; history?: HistoryChain;
	runtimeEnv: Record<string, unknown>; d1Held?: boolean; alarm(): Promise<void>;
};

async function setUp(runtime: Runtime, state: DurableObjectState, name: string) {
	runtime.store.config = { ...runtime.store.config, retentionRecords: 3, cleanupThresholdPercent: 100, anonymousPostsPerMinute: 100_000, ipPostsPerMinute: 100_000, globalPostsPerMinute: 100_000 };
	runtime.config = { ...runtime.config, limits: { ...runtime.config.limits, retentionRecords: 3, historyD1Records: 1_000, cleanupThresholdPercent: 100 } };
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
	const sql = <T extends Record<string, SqlStorageValue>>(query: string) => state.storage.sql.exec<T>(query).toArray()[0];
	const hotRecords = () => Number(sql<{ count: number }>("SELECT COUNT(*) AS count FROM records").count);
	const scheduleTomorrow = () => {
		state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = ? WHERE id = 1", Date.now() + DAY_MS);
		runtime.store.forgetCleanupDue();
	};
	/** Skips a running job's one-second pause, so a test need not sleep through it. */
	const continueJob = () => {
		state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1 AND cleanup_cursor IS NOT NULL");
		runtime.store.forgetCleanupDue();
	};
	const jobRunning = () => sql<{ cursor: number | null }>("SELECT cleanup_cursor AS cursor FROM maintenance WHERE id = 1").cursor !== null;
	/** Puts the database past its high-water mark and makes a post meet it. */
	const flood = () => {
		const size = runtime.store.databaseSize()!;
		Object.assign(runtime.store.config, { storageLowWaterBytes: 1, storageHighWaterBytes: 2, storageHardTargetBytes: size + 64 * MIB });
		let error: unknown;
		try { runtime.store.mutate({ userId: "p", ipKey: "ip", requestId: `${name}-refused`, method: "message", now: Date.now(), params: { room_id: "general", body: { format: "plain", text: "refused" } }, identity: { user_id: "p", name: "p" } }); } catch (caught) { error = caught; }
		expectRetryAfter(error);
		expect(runtime.store.takeAlarmChange()).toBe(true);
		return size;
	};
	return { build, post, hotRecords, scheduleTomorrow, continueJob, jobRunning, flood };
}

it("moves a flood down to D1 at once, never before D1 holds it, and posting resumes", async () => {
	await runInDurableObject(env.DEMO.getByName("pressure-cleanup-d1-v1"), async (instance, state) => {
		const runtime = instance as unknown as Runtime;
		const { post, hotRecords, scheduleTomorrow, continueJob, jobRunning, flood } = await setUp(runtime, state, "pressure-d1");
		await post(30);
		scheduleTomorrow();
		const before = hotRecords();
		expect(before).toBeGreaterThan(30);
		const size = flood();

		// The next alarm does the full work: the cleanup the watermark asked for starts though its scheduled time is a day off.
		expect(runtime.store.cleanupDue(Date.now())).toBe(true);
		await runtime.alarm();
		expect(jobRunning()).toBe(true);

		const links = chainStateStore(runtime.store.historyStatePort(), "hot");
		for (let round = 0; round < 40 && hotRecords() > 3; round += 1) {
			continueJob();
			await runtime.alarm();
			// Copy before delete: SQLite's floor never passes what the link into D1 has copied.
			const { hot } = runtime.store.historyFloors(Date.now());
			expect(hot).toBeLessThanOrEqual((await links.loadLink("hot")).through + 1);
		}
		expect(hotRecords()).toBe(3);

		// Under the low-water mark again, posting resumes.
		Object.assign(runtime.store.config, { storageLowWaterBytes: size * 2, storageHighWaterBytes: size * 3, storageHardTargetBytes: size * 3 + 64 * MIB });
		await post(1);
	});
});

it("with the D1 tier off, looks at the pressure again in minutes, not every alarm", async () => {
	await runInDurableObject(env.DEMO.getByName("pressure-cleanup-d1-off-v1"), async (instance, state) => {
		const runtime = instance as unknown as Runtime;
		const { build, post, scheduleTomorrow, continueJob, jobRunning, flood } = await setUp(runtime, state, "pressure-off");
		await post(10);
		// D1 holds history first, so turning it off blocks the chain instead of rebuilding it without D1.
		for (let round = 0; round < 6; round += 1) {
			state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1");
			runtime.store.forgetCleanupDue();
			await runtime.alarm();
			continueJob();
		}
		runtime.runtimeEnv = { ...runtime.runtimeEnv, HISTORY_D1: undefined };
		runtime.d1Held = undefined;
		runtime.history = build({ ...env, HISTORY_D1: undefined });
		await post(10);
		scheduleTomorrow();
		flood();

		await runtime.alarm();
		expect(jobRunning()).toBe(true);
		// Nothing can be copied: the job waits HISTORY_RETRY_MS, and the pressure does not start another before then.
		for (let round = 0; round < 3; round += 1) {
			expect(runtime.store.cleanupDue(Date.now() + 1_000)).toBe(false);
			expect(runtime.store.cleanupDue(Date.now() + 60_000)).toBe(false);
			await runtime.alarm();
		}
	});
});

/** Takes D1 away after it has held history, so cleanup jobs wait on the copy into it. */
async function holdThenDropD1(runtime: Runtime, state: DurableObjectState, helpers: Awaited<ReturnType<typeof setUp>>) {
	await helpers.post(10);
	for (let round = 0; round < 6; round += 1) {
		state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1");
		runtime.store.forgetCleanupDue();
		await runtime.alarm();
		helpers.continueJob();
	}
	runtime.runtimeEnv = { ...runtime.runtimeEnv, HISTORY_D1: undefined };
	runtime.d1Held = undefined;
	runtime.history = helpers.build({ ...env, HISTORY_D1: undefined });
	await helpers.post(10);
}

/** Runs alarms and checks none of them finds cleanup due or sets the next alarm to now. */
async function expectNoSpin(runtime: Runtime, state: DurableObjectState, hotRecords: () => number) {
	const before = hotRecords();
	const seen: Array<number | null> = [];
	for (let round = 0; round < 5; round += 1) {
		expect(runtime.store.cleanupDue(Date.now())).toBe(false);
		await runtime.alarm();
		const alarm = await state.storage.getAlarm();
		seen.push(alarm === null ? null : alarm - Date.now());
	}
	// Another deadline may stand a moment away, but no alarm is set to now to find cleanup due again.
	for (const delay of seen) expect(delay === null || delay > 100).toBe(true);
	expect(hotRecords()).toBe(before);
}

it("a refusal at the watermark does not re-trigger a scheduled cleanup job that waits on D1", async () => {
	await runInDurableObject(env.DEMO.getByName("pressure-cleanup-running-job-v1"), async (instance, state) => {
		const runtime = instance as unknown as Runtime;
		const helpers = await setUp(runtime, state, "pressure-running");
		await holdThenDropD1(runtime, state, helpers);
		// The daily cleanup starts unpressed, and waits on the copy into D1.
		state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1");
		runtime.store.forgetCleanupDue();
		await runtime.alarm();
		expect(helpers.jobRunning()).toBe(true);
		// The watermark is met while that job waits: it is not due before its own next step.
		helpers.flood();
		await expectNoSpin(runtime, state, helpers.hotRecords);
	});
});

it("a cleanup job the watermark started is not re-triggered once it outlasts the pressure backoff", async () => {
	await runInDurableObject(env.DEMO.getByName("pressure-cleanup-long-job-v1"), async (instance, state) => {
		const runtime = instance as unknown as Runtime;
		const helpers = await setUp(runtime, state, "pressure-long");
		await holdThenDropD1(runtime, state, helpers);
		helpers.scheduleTomorrow();
		helpers.flood();
		await runtime.alarm();
		expect(helpers.jobRunning()).toBe(true);
		// The backoff since that start runs out while the job still waits on D1.
		(runtime.store as unknown as { pressureCleanupAfter: number }).pressureCleanupAfter = 0;
		await expectNoSpin(runtime, state, helpers.hotRecords);
	});
});
