/*
 * The history chain inside the running object: ApronDemoServer's Store,
 * chain and alarm over miniflare's local D1 (HISTORY_D1) and R2
 * (HISTORY_BLOB). SQLite keeps 3 records, so a few posts and cleanup alarms
 * move history down. Each test pins something moving it must never do:
 * lose or skip a record, delete one before the tier below holds it, or set
 * the alarm a second away while a copy cannot come.
 *
 * The first test reads D1's `records` table, which every tier here shares,
 * exactly: it runs first, before the others write to it.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { HistoryChain } from "../../src/history/chain";
import { buildHistoryChain, historyLayout } from "../../src/history/config";
import type { HistorySchedule } from "../../src/history/schedule";
import { chainStateStore } from "../../src/history/state";
import type { Store } from "../../src/store";
import { connect, greeting, request } from "../helpers/socket";
import { expectRetryAfter } from "../helpers/store";

const MIB = 1024 * 1024;
const DAY_MS = 86_400_000;
const FAST = { anonymousPostsPerMinute: 100_000, ipPostsPerMinute: 100_000, globalPostsPerMinute: 100_000 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The runtime's parts these tests drive (private members, reached as the tests reach them elsewhere). */
type Runtime = {
	store: Store & { config: Record<string, unknown> }; config: { limits: Record<string, number> }; history?: HistoryChain;
	runtimeEnv: Record<string, unknown>; d1Held?: boolean; historySchedule: HistorySchedule;
	deadlines: { maintenance: { at?: number; clear(): void } };
	underHistoryLease(holder: { kind: "job"; job: "export" }, fn: () => Promise<void>): Promise<void>;
	d1Missing(): Promise<string | undefined>; historyStatus(now: number): Promise<string[]>; alarm(): Promise<void>;
};

/**
 * Runs `fn` in a fresh object whose SQLite keeps 3 records, its chain built
 * from the bindings as the Worker builds it (D1 keeping `d1Records`, off at
 * 0; the cold tier on R2), with the steps the tests take.
 */
async function inObject(name: string, d1Records: number, fn: (object: Awaited<ReturnType<typeof harness>>) => Promise<void>) {
	await runInDurableObject(env.DEMO.getByName(`${name}-${crypto.randomUUID()}`), async (instance, state) => fn(harness(instance as unknown as Runtime, state, name, d1Records)));
}

function harness(runtime: Runtime, state: DurableObjectState, name: string, d1Records: number) {
	runtime.store.config = { ...runtime.store.config, retentionRecords: 3, cleanupThresholdPercent: 100, ...FAST };
	runtime.config = { ...runtime.config, limits: { ...runtime.config.limits, retentionRecords: 3, historyD1Records: d1Records, cleanupThresholdPercent: 100 } };
	const server = `${name}-${Date.now()}`;
	const build = (bindings: Record<string, unknown>) => buildHistoryChain({
		layout: historyLayout(bindings as never, runtime.config.limits as never), limits: runtime.config.limits as never, store: runtime.store,
		clock: { now: Date.now }, chunkIndex: (tier) => runtime.store.chunkIndex(tier), server,
	});
	runtime.history = build(env as never);
	const sql = <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) => state.storage.sql.exec<T>(query, ...bindings).toArray();
	let posted = 0;
	const object = {
		runtime, state,
		/** Posts `count` messages in `roomId`, each its own commit time; their log IDs. */
		async post(count: number, roomId = "general"): Promise<number[]> {
			const ids: number[] = [];
			for (let index = 0; index < count; index += 1, posted += 1) {
				const result = runtime.store.mutate({ userId: "p", ipKey: "ip", requestId: `${name}-${posted}`, method: "message", now: Date.now(), params: { room_id: roomId, body: { format: "plain", text: `m ${posted}` } }, identity: { user_id: "p", name: "p" } });
				ids.push(Number(result.message!.log_id));
				await sleep(2);
			}
			return ids;
		},
		/** Makes cleanup due now, as its scheduled time or a job's next step would. */
		cleanupNow() {
			state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1");
			runtime.store.forgetCleanupDue();
		},
		/** Full alarms with cleanup due: copy, delete, trim, publish. */
		async cycles(count: number) {
			for (let round = 0; round < count; round += 1) {
				object.cleanupNow();
				await runtime.alarm();
			}
		},
		/** Skips a running job's one-second pause, so a test need not sleep through it. */
		continueJob() {
			state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1 AND cleanup_cursor IS NOT NULL");
			runtime.store.forgetCleanupDue();
		},
		scheduleTomorrow() {
			state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = ? WHERE id = 1", Date.now() + DAY_MS);
			runtime.store.forgetCleanupDue();
		},
		jobRunning: () => sql<{ cursor: number | null }>("SELECT cleanup_cursor AS cursor FROM maintenance WHERE id = 1")[0].cursor !== null,
		hotLogs: () => sql<{ log_id: number }>("SELECT log_id FROM records ORDER BY log_id").map((row) => Number(row.log_id)),
		/** How long after now the next cleanup is due after one alarm with it due, and whether a job waits. */
		async nextCleanupAfterAlarm() {
			object.cleanupNow();
			const before = Date.now();
			await runtime.alarm();
			const row = sql<{ next_cleanup_ms: number; cleanup_cursor: number | null }>("SELECT next_cleanup_ms, cleanup_cursor FROM maintenance WHERE id = 1")[0];
			return { wait: row.next_cleanup_ms - before, waiting: row.cleanup_cursor !== null };
		},
		/** The next deploy has no D1: the chain is built without it, as on a restart. */
		dropD1() {
			runtime.runtimeEnv = { ...runtime.runtimeEnv, HISTORY_D1: undefined };
			runtime.d1Held = undefined;
			runtime.history = build({ ...env, HISTORY_D1: undefined });
		},
		/** Puts the database past its high-water mark and makes a post meet it; the size it had. */
		flood(): number {
			const size = runtime.store.databaseSize()!;
			Object.assign(runtime.store.config, { storageLowWaterBytes: 1, storageHighWaterBytes: 2, storageHardTargetBytes: size + 64 * MIB });
			let error: unknown;
			try { runtime.store.mutate({ userId: "p", ipKey: "ip", requestId: `${name}-refused`, method: "message", now: Date.now(), params: { room_id: "general", body: { format: "plain", text: "refused" } }, identity: { user_id: "p", name: "p" } }); } catch (caught) { error = caught; }
			expectRetryAfter(error);
			expect(runtime.store.takeAlarmChange()).toBe(true);
			return size;
		},
		/** Under the low-water mark again. */
		relieve(size: number) {
			Object.assign(runtime.store.config, { storageLowWaterBytes: size * 2, storageHighWaterBytes: size * 3, storageHardTargetBytes: size * 3 + 64 * MIB });
		},
		/** Runs alarms and checks none of them finds cleanup due or sets the next alarm to now, and nothing leaves SQLite. */
		async expectNoSpin() {
			const before = object.hotLogs().length;
			const seen: Array<number | null> = [];
			for (let round = 0; round < 5; round += 1) {
				expect(runtime.store.cleanupDue(Date.now())).toBe(false);
				await runtime.alarm();
				const alarm = await state.storage.getAlarm();
				seen.push(alarm === null ? null : alarm - Date.now());
			}
			// Another deadline may stand a moment away, but no alarm is set to now to find cleanup due again.
			for (const delay of seen) expect(delay === null || delay > 100).toBe(true);
			expect(object.hotLogs().length).toBe(before);
		},
		/** The log IDs of a room's messages, read down the whole chain. */
		async messages(roomId: string): Promise<number[]> {
			const page = await runtime.history!.read({ roomIds: [roomId], lower: 1, upper: Number.MAX_SAFE_INTEGER, forward: true, limit: 1_000 });
			return page.filter((record) => record.room_id === roomId && record.kind === "message").map((record) => record.log_id);
		},
	};
	return object;
}

// The tests bind a local D1 database as HISTORY_D1 (wrangler.toml); this
// chain is built without a chunk index, so without the cold tier.
it("moves records past SQLite into D1, serves them in history, applies /purge there, and expires them past D1's own limit", async () => {
	const stub = () => env.DEMO.getByName("public-demo-v1");
	const inD1 = async () => (await env.HISTORY_D1!.prepare("SELECT log_id FROM records ORDER BY log_id").all<{ log_id: number }>()).results.map((row) => String(row.log_id));
	const peer = await connect({ ip: "192.0.2.91" });
	try {
		await greeting(peer);
		expect((await request(peer, "auth", "auth", { scheme: "guest" })).result).toBeDefined();
		const logs = await runInDurableObject(stub(), async (instance, state) => {
			const runtime = instance as unknown as Runtime;
			// Three records in SQLite, four more in D1.
			runtime.store.config = { ...runtime.store.config, retentionRecords: 3, historyD1Records: 4, cleanupThresholdPercent: 100, ...FAST };
			runtime.config = { ...runtime.config, limits: { ...runtime.config.limits, retentionRecords: 3, historyD1Records: 4, cleanupThresholdPercent: 100 } };
			// The chain takes its tiers' limits when built.
			runtime.history = buildHistoryChain({ layout: historyLayout(env, runtime.config.limits as never), limits: runtime.config.limits as never, store: runtime.store, clock: { now: Date.now } });
			const logs: string[] = [];
			for (let index = 0; index < 10; index += 1) {
				// One sender's message among those D1 will hold, for /purge below.
				const userId = index === 5 ? "archive-victim" : "archive-poster";
				const result = runtime.store.mutate({
					userId, ipKey: "archive-ip", requestId: `archive-${index}`, method: "message", now: Date.now(),
					params: { room_id: "general", body: { format: "plain", text: `message ${index}` } },
					identity: { user_id: userId, name: userId },
				});
				logs.push(String(result.message!.log_id));
				// Each its own commit time: the count ends at one.
				await sleep(3);
			}
			// Cleanup due on each alarm, until it settles: copy, remove, find D1's limit, publish it, trim.
			for (let round = 0; round < 8; round += 1) {
				state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1");
				runtime.store.forgetCleanupDue();
				await runtime.alarm();
			}
			const hot = state.storage.sql.exec<{ log_id: number }>("SELECT log_id FROM records ORDER BY log_id").toArray().map((row) => String(row.log_id));
			expect(hot).toEqual(logs.slice(7));
			return logs;
		});

		// D1 holds the four newest records that left SQLite; the rest expired.
		expect(await inD1()).toEqual(logs.slice(3, 7));
		const bounds = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.logBounds());
		expect(bounds.history_floor).toBe(logs[3]);

		// History serves both, newest page first, as one log.
		const ids = (page: { messages: Array<{ log_id: string }> }) => page.messages.map((message) => message.log_id);
		const newest = (await request(peer, "newest", "history", { room_id: "general", limit: 50 })).result;
		expect(ids(newest)).toEqual(logs.slice(3));
		expect(newest.history_log_id).toBe(logs[3]);
		expect(newest.more).toBe(false);
		// Forward from the start: D1's records first.
		const first = (await request(peer, "first", "history", { room_id: "general", after: "0", limit: 2 })).result;
		expect(ids(first)).toEqual(logs.slice(3, 5));
		expect(first.more).toBe(true);
		// A page across the hot floor (`before` includes its own).
		expect(ids((await request(peer, "across", "history", { room_id: "general", before: logs[7], limit: 3 })).result)).toEqual(logs.slice(5, 8));

		// /purge: queued for the link into D1, and applied to pages that read it before D1 has it.
		await runInDurableObject(stub(), (instance) => {
			const runtime = instance as unknown as Runtime;
			runtime.store.purgeUsers({ userIds: ["archive-victim"] });
			expect(runtime.store.historyRewrites()).toEqual([{ seq: 1, rewrite: { user: "archive-victim", into: null, messages: [] } }]);
			// A tier that finds more of the user's messages adds them to the rewrite, once each; another seq is left alone.
			runtime.store.amendHistoryPurge(1, ["no-such-message", "no-such-message"]);
			runtime.store.amendHistoryPurge(9, ["other"]);
			expect(runtime.store.historyRewrites()).toEqual([{ seq: 1, rewrite: { user: "archive-victim", into: null, messages: ["no-such-message"] } }]);
		});
		expect(await inD1()).toEqual(logs.slice(3, 7));
		const purgedPage = [logs[3], logs[4], ...logs.slice(6)];
		expect(ids((await request(peer, "early", "history", { room_id: "general", limit: 50 })).result)).toEqual(purgedPage);
		// The next full alarm delivers it to D1 (the command asks for one in a second).
		await runInDurableObject(stub(), async (instance, state) => {
			const runtime = instance as unknown as Runtime;
			state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1");
			runtime.store.forgetCleanupDue();
			await runtime.alarm();
			expect(runtime.store.historyRewrites()).toEqual([]);
		});
		expect(await inD1()).toEqual([logs[3], logs[4], logs[6]]);
		// /status shows what each holds against its limit.
		const status = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).historyStatus(Date.now()));
		expect(status).toEqual(["- History in SQLite: 3 / 3 records (100%; cleanup keeps 3)", "- History in D1: 3 / 4 records (75%; cleanup keeps 4)"]);
		expect(ids((await request(peer, "purged", "history", { room_id: "general", limit: 50 })).result)).toEqual(purgedPage);
	} finally { peer.close(); }
});

// SQLite directly above the cold tier (no D1): a copy asks for a whole
// chunk, but SQLite scans at most HISTORY_SCAN_BATCH log IDs at once
// (HistoryTier.scanLimit). The copy must gather the chunk over several scans
// and never take a capped scan for the end of SQLite's records, or cleanup
// trims below the copy marker.
it("loses nothing when SQLite copies straight into the cold tier, and pages every room's messages back down the chain", async () => {
	await inObject("head-to-cold", 0, async (object) => {
		const { runtime } = object;
		const thread = String(runtime.store.mutate({ userId: "p", ipKey: "ip", requestId: "thread", method: "room_set", now: Date.now(), params: { parent_room_id: "general", title: "Long ago" }, identity: { user_id: "p", name: "p" } }).result.room_id);
		const posted: Record<string, number[]> = { general: [], [thread]: [] };
		for (let index = 0; index < 75; index += 1) {
			posted.general.push(...await object.post(1));
			posted[thread].push(...await object.post(1, thread));
		}
		await object.cycles(12);
		const cold = (await runtime.history!.tiers[1].scan(0, 100_000)).records.map((record) => record.log_id);
		// Something did move down, from both rooms, and every record is in one tier or the other.
		expect(cold.length).toBeGreaterThan(0);
		const held = new Set([...object.hotLogs(), ...cold]);
		for (const [roomId, logs] of Object.entries(posted)) {
			expect(logs.some((id) => cold.includes(id)), roomId).toBe(true);
			expect(logs.filter((id) => !held.has(id)), roomId).toEqual([]);
			// And a page down the chain reads every message, in order.
			expect(await object.messages(roomId), roomId).toEqual(logs);
		}
		// The thread is kept, and listed, however much of its history went down.
		expect(runtime.store.listRooms(Date.now()).some((room) => room.room_id === thread)).toBe(true);
	});
});

it("moves a flood at the storage watermark down to D1 at once, never before D1 holds it, and posting resumes", async () => {
	await inObject("pressure-d1", 1_000, async (object) => {
		const { runtime } = object;
		await object.post(30);
		object.scheduleTomorrow();
		expect(object.hotLogs().length).toBeGreaterThan(30);
		const size = object.flood();

		// The next alarm does the full work: the cleanup the watermark asked for starts though its scheduled time is a day off.
		expect(runtime.store.cleanupDue(Date.now())).toBe(true);
		await runtime.alarm();
		expect(object.jobRunning()).toBe(true);

		const links = chainStateStore(runtime.store.historyStatePort(), "hot");
		for (let round = 0; round < 40 && object.hotLogs().length > 3; round += 1) {
			object.continueJob();
			await runtime.alarm();
			// Copy before delete: SQLite's floor never passes what the link into D1 has copied.
			const { hot } = runtime.store.historyFloors(Date.now());
			expect(hot).toBeLessThanOrEqual((await links.loadLink("hot")).through + 1);
		}
		expect(object.hotLogs().length).toBe(3);

		// Under the low-water mark again, posting resumes.
		object.relieve(size);
		await object.post(1);
	});
});

// D1 holds history from its first copy, not from its first trim: a deploy
// that drops it (HISTORY_D1 unbound, or its limit 0) before then must stop
// the chain, not rebuild it as SQLite → cold. SQLite's copy marker describes
// D1: a cold tier in its place would take it for its own and skip what D1
// holds, and cleanup would then delete it. Meanwhile a cleanup job waiting
// on the copy into D1 looks again in HISTORY_RETRY_MS, not every second,
// and the storage watermark does not bring it forward.
it("with D1 dropped after its first copy: the chain stops, SQLite keeps everything, cleanup waits minutes, the copy is stalled, and a flood does not spin the alarm", async () => {
	await inObject("d1-off", 100, async (object) => {
		const { runtime } = object;
		await object.post(10);
		await object.cycles(6);
		// Copied into D1, far below its limit: it has never trimmed, but it holds history.
		const marker = (await runtime.history!.view()).links[0].through;
		expect(marker).toBeGreaterThan(0);
		expect(await runtime.history!.hasTierState("recent")).toBe(true);

		object.dropD1();
		expect(await runtime.d1Missing()).toBe("unbound");
		const later = await object.post(10);
		for (let round = 0; round < 3; round += 1) {
			const { wait, waiting } = await object.nextCleanupAfterAlarm();
			expect(waiting).toBe(true);
			expect(wait).toBeGreaterThan(60_000);
		}
		// Nothing went past D1 into the cold tier, and SQLite let nothing go: it keeps what it holds until D1 is back.
		const cold = runtime.history!.tiers[1];
		expect(cold.name).toBe("cold");
		expect((await cold.scan(0, 1_000)).records).toEqual([]);
		expect((await runtime.history!.view()).links[0].through).toBe(marker);
		const hot = new Set(object.hotLogs());
		expect(later.filter((id) => !hot.has(id))).toEqual([]);
		// The copy out of SQLite counts as stalled, for the alert.
		expect((await runtime.history!.view()).links[0].stall.kind).not.toBe("ok");

		// The watermark is met while the job waits on D1: it is not due before its own next step.
		object.flood();
		await object.expectNoSpin();
	});
});

it("waits minutes, not a second, while a history job holds the lock, and the job's end asks for the cycle", async () => {
	await inObject("cleanup-wait-job", 100, async (object) => {
		await object.post(10);
		await object.cycles(6);
		await object.post(10);
		await object.runtime.underHistoryLease({ kind: "job", job: "export" }, async () => {
			for (let round = 0; round < 3; round += 1) {
				const { wait, waiting } = await object.nextCleanupAfterAlarm();
				expect(waiting).toBe(true);
				expect(wait).toBeGreaterThan(60_000);
				// The cycle it holds up is left due.
				expect(object.runtime.historySchedule.want.kind).toBe("due");
			}
			object.runtime.deadlines.maintenance.clear();
		});
		// Ended, the job asked for the cycle it held up, in a second: the copy goes on.
		expect(object.runtime.deadlines.maintenance.at ?? Infinity).toBeLessThanOrEqual(Date.now() + 1_000);
	});
});
