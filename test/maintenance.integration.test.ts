import { expect, it } from "vitest";
import { Store, type StoreConfig, type StoreMutationInput } from "../src/store";
import { BY_AGE, expectRetryAfter, messagesOf, RETENTION_MS, withStore as withNamedStore, type TestClock } from "./helpers/store";

const DAY_MS = 86_400_000;

const withStore = <T>(name: string, config: Partial<StoreConfig>, fn: Parameters<typeof withNamedStore<T>>[2]) =>
	withNamedStore(`maintenance-${name}`, { ...BY_AGE, ...config }, fn);

function messageInput(clock: TestClock, requestId: string, text: string): StoreMutationInput {
	return {
		userId: "maintenance-user",
		ipKey: "maintenance-ip",
		requestId,
		method: "message",
		now: clock.value,
		params: { room_id: "general", body: { format: "plain", text } },
		identity: { user_id: "maintenance-user", name: "Maintenance Tester" },
	};
}

function oneLog(result: ReturnType<Store["mutate"]>): bigint {
	const value = result.message?.log_id;
	if (value === undefined) throw new Error("mutation did not produce a message record");
	return BigInt(value);
}

function nextUtcDay(value: number): number {
	return (Math.floor(value / DAY_MS) + 1) * DAY_MS;
}

function rowValue<T extends Record<string, SqlStorageValue>>(state: DurableObjectState, query: string, ...bindings: unknown[]): T {
	return state.storage.sql.exec<T>(query, ...bindings).one();
}

it("keeps an early authentication alarm cheap while cleanup is not due", async () => {
	await withStore("early-auth-alarm", {}, async (store, clock, state) => {
		const authDeadline = clock.value + 60_000;
		await store.scheduleAlarm(authDeadline, clock.value);
		expect(await state.storage.getAlarm()).toBe(authDeadline);

		const before = store.storageAccounting();
		const result = store.runCleanup(authDeadline);
		const after = store.storageAccounting();
		expect(result.did_work).toBe(false);
		expect(result.next_due_ms).toBeGreaterThan(authDeadline);
		// The early gate reads the maintenance/room rows and reserves its
		// control work; it must not reserve or execute a full 1024-row batch.
		expect(after.reservedReads - before.reservedReads).toBeLessThan(1_024);
		expect(after.reservedWrites - before.reservedWrites).toBeLessThan(1_024);
		expect(after.writes - before.writes).toBeLessThan(100);
		expect(await state.storage.getAlarm()).toBe(authDeadline);
	});
});

it("keeps a full day of empty hourly cleanups below one deletion batch", async () => {
	await withStore("idle-day", { cleanupIntervalMs: 3_600_000 }, (store, clock, state) => {
		// The object seeded its first deadline with the plan's interval; start there.
		clock.value = store.runCleanup(clock.value).next_due_ms - 3_600_000;
		const before = store.storageAccounting();
		// Stay inside the seeded general record's retention window: this test
		// measures idle hours, not the one expiry of that bootstrap record.
		for (let hour = 0; hour < 23; hour++) {
			clock.value += 3_600_000;
			const cleanup = store.runCleanup(clock.value);
			expect(cleanup.did_work).toBe(false);
			expect(cleanup.next_due_ms).toBe(clock.value + 3_600_000);
		}
		const after = store.storageAccounting();
		expect(after.reservedWrites - before.reservedWrites).toBeLessThan(1_024);
		expect(after.writes - before.writes).toBeLessThan(200);
		expect(store.accountingStatus().unsafe).toBe(false);
		const maintenance = rowValue<{ cleanup_cursor: number | null; cleanup_cutoff_ms: number | null }>(state,
			"SELECT cleanup_cursor, cleanup_cutoff_ms FROM maintenance WHERE id = 1");
		expect(maintenance).toEqual({ cleanup_cursor: null, cleanup_cutoff_ms: null });
	});
});

it("reuses a known future alarm without spending SQL and still advances earlier deadlines", async () => {
	await withStore("cached-alarm", {}, async (store, clock, state) => {
		const first = clock.value + 30_000;
		await store.scheduleAlarm(first, clock.value);
		const before = store.storageAccounting();
		for (let attempt = 0; attempt < 100; attempt++) {
			await store.scheduleAlarm(attempt % 2 ? first + 60_000 : undefined, clock.value);
		}
		expect(store.storageAccounting()).toEqual(before);
		expect(await state.storage.getAlarm()).toBe(first);
		await store.scheduleAlarm(first - 10_000, clock.value);
		expect(await state.storage.getAlarm()).toBe(first - 10_000);
		expect(store.storageAccounting().writes).toBeGreaterThan(before.writes);

		// A new Store must read durable alarm state rather than assuming a cache
		// survived a wake; its following scheduling requests can reuse that read.
		const restarted = new Store(state, {}, clock.clock);
		restarted.initialize();
		await restarted.scheduleAlarm(undefined, clock.value);
		const afterWake = restarted.storageAccounting();
		await restarted.scheduleAlarm(undefined, clock.value);
		expect(restarted.storageAccounting()).toEqual(afterWake);
		clock.value = first;
		restarted.runCleanup(clock.value);
		await restarted.scheduleAlarm(undefined, clock.value);
		expect(await state.storage.getAlarm()).toBeGreaterThan(clock.value);
	});
});

it("defers exhausted cleanup to the next UTC day and schedules one reset alarm", async () => {
	const config = { maintenanceReadsPerDay: 1_100, maintenanceWritesPerDay: 1_100 };
	// The first Store only seeds today's budget and maintenance rows.
	await withStore("maintenance-deferral", config, async (_seeded, clock, state) => {
		const day = new Date(clock.value).toISOString().slice(0, 10);
		const sql = state.storage.sql;
		// Leave only the control reserve available. Reconstructing Store makes
		// the native wake path load this durable budget rather than a stale cache.
		sql.exec(
			"UPDATE resource_budgets SET reads_reserved = 1_068, writes_reserved = 1_068, maintenance_reads = 1_068, maintenance_writes = 1_068 WHERE day = ?",
			day,
		);
		sql.exec("UPDATE maintenance SET next_cleanup_ms = ?, cleanup_cutoff_ms = NULL, cleanup_cursor = NULL WHERE id = 1", clock.value);
		const store = new Store(state, config, clock.clock);
		store.initialize();
		const resetAt = nextUtcDay(clock.value);

		let failure: unknown;
		try {
			store.runCleanup(clock.value);
		} catch (error) {
			failure = error;
		}
		expectRetryAfter(failure);
		const maintenance = rowValue<{ next_cleanup_ms: number }>(state, "SELECT next_cleanup_ms FROM maintenance WHERE id = 1");
		expect(maintenance.next_cleanup_ms).toBe(resetAt);
		expect(store.budget(clock.value).maintenance_reads).toBe(1_076);
		expect(store.budget(clock.value).maintenance_writes).toBe(1_076);

		await store.scheduleAlarm(undefined, clock.value);
		expect(await state.storage.getAlarm()).toBe(resetAt);
		// Ordinary scheduling no longer fits in the tiny budget, so it uses its
		// 24-row control reservation exactly once and does not spin at +1s.
		expect(store.budget(clock.value).maintenance_reads).toBe(1_100);
		expect(store.budget(clock.value).maintenance_writes).toBe(1_100);
		await store.scheduleAlarm(undefined, clock.value);
		expect(await state.storage.getAlarm()).toBe(resetAt);
	});
});

it("makes repeated cleanup invocations idempotent across due alarms and wakes", async () => {
	await withStore("cleanup-idempotence", { cleanupBatch: 1 }, async (store, clock, state) => {
		// The seeded general room record is the oldest record in the log.
		const generalLog = BigInt(store.getRoomState().log_id);
		const firstLog = oneLog(store.mutate(messageInput(clock, "idempotent-1", "first")));
		const secondLog = oneLog(store.mutate(messageInput(clock, "idempotent-2", "second")));
		clock.value += RETENTION_MS + 1;

		const seeded = store.runCleanup(clock.value);
		expect(seeded.history_floor).toBe(String(generalLog + 1n));
		expect(seeded.deleted_records).toBe(1);
		clock.value = seeded.next_due_ms + 1;
		const first = store.runCleanup(clock.value);
		expect(first.history_floor).toBe(String(firstLog + 1n));
		expect(first.deleted_records).toBe(1);
		const replay = store.runCleanup(clock.value);
		expect(replay.deleted_records).toBe(0);
		expect(replay.deleted_messages).toBe(0);
		expect(replay.history_floor).toBe(first.history_floor);
		expect(replay.latest_id).toBe(String(secondLog));
		expect(replay.did_work).toBe(false);

		clock.value = first.next_due_ms + 1;
		const continuation = store.runCleanup(clock.value);
		expect(continuation.deleted_records).toBe(1);
		expect(continuation.history_floor).toBe(String(secondLog + 1n));
		const finalReplay = store.runCleanup(clock.value);
		expect(finalReplay.deleted_records).toBe(0);
		expect(finalReplay.history_floor).toBe(continuation.history_floor);
		expect(finalReplay.latest_id).toBe(String(secondLog));
		expect(finalReplay.did_work).toBe(false);
		expect(await state.storage.getAlarm()).toBeNull();
	});
});

it("publishes a floor before a failed physical delete and resumes after restart", async () => {
	await withStore("cleanup-restart", { cleanupBatch: 2 }, (store, clock, state) => {
		const oldLog = oneLog(store.mutate(messageInput(clock, "restart-old", "old message")));
		const head = store.getRoomState().latest_log_id;
		clock.value += RETENTION_MS + 1;
		state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = ? WHERE id = 1", clock.value);
		state.storage.sql.exec(`
			CREATE TRIGGER fail_record_delete
			BEFORE DELETE ON records
			BEGIN
				SELECT RAISE(ABORT, 'injected cleanup deletion failure');
			END
		`);

		let failure: unknown;
		try {
			store.runCleanup(clock.value);
		} catch (error) {
			failure = error;
		}
		const floor = oldLog + 1n;
		expect(failure).toBeDefined();
		expect(store.getRoomState().history_log_id).toBeNull();
		expect(store.getRoomState().latest_log_id).toBe(head);
		// The seeded general record and the message are both still stored.
		expect(Number(rowValue<{ count: number }>(state, "SELECT COUNT(*) AS count FROM records").count)).toBe(2);
		expect(Number(rowValue<{ count: number }>(state, "SELECT COUNT(*) AS count FROM message_state").count)).toBe(1);
		const hidden = store.history({ roomId: "general", after: 0n, limit: 50, now: clock.value });
		expect(hidden.messages).toBeUndefined();
		expect(hidden.latest_log_id).toBe(head);
		expect(hidden.history_log_id).toBeNull();

		state.storage.sql.exec("DROP TRIGGER fail_record_delete");
		const restarted = new Store(state, { cleanupBatch: 2 }, clock.clock);
		restarted.initialize();
		let last: ReturnType<Store["runCleanup"]> | undefined;
		for (let run = 0; run < 5; run += 1) {
			clock.value = run === 0 ? clock.value + 1_001 : last!.next_due_ms + 1;
			last = restarted.runCleanup(clock.value);
			if (!last.did_work && last.next_due_ms > clock.value) break;
		}
		expect(last?.history_floor).toBe(String(floor));
		expect(last?.latest_id).toBe(head);
		expect(Number(rowValue<{ count: number }>(state, "SELECT COUNT(*) AS count FROM records").count)).toBe(0);
		expect(Number(rowValue<{ count: number }>(state, "SELECT COUNT(*) AS count FROM message_state").count)).toBe(0);
		expect(messagesOf(restarted.history({ roomId: "general", after: 0n, limit: 50, now: clock.value }))).toEqual([]);
	});
});

it("keeps the latest retentionRecords records however old, expiring older ones only once minRetentionMs old", async () => {
	const byCount: Partial<StoreConfig> = { retentionRecords: 3, minRetentionMs: DAY_MS, retentionMs: 0, cleanupThresholdPercent: 100 };
	await withStore("retention-count", byCount, (store, clock, state) => {
		// The seeded general room record and five messages: six records, a
		// second apart (the count ends at a commit time, and keeps any record
		// committed in the same millisecond as the last one counted).
		const logs = ["one", "two", "three", "four", "five"].map((text) => {
			clock.value += 1_000;
			return oneLog(store.mutate(messageInput(clock, `count-${text}`, text)));
		});
		const visible = () => messagesOf(store.historyPage({ roomId: "general", after: "0", limit: 50, now: clock.value })).map((entry) => BigInt(entry.log_id));

		// Past the count, but younger than minRetentionMs: nothing expires.
		clock.value += 60 * 60 * 1000;
		state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = ? WHERE id = 1", clock.value);
		expect(store.runCleanup(clock.value).deleted_records).toBe(0);
		expect(visible()).toEqual(logs);

		// A day on, all but the latest three go: the general room record and two messages.
		clock.value += 2 * DAY_MS;
		const expired = store.runCleanup(clock.value);
		expect(expired.history_floor).toBe(String(logs[1] + 1n));
		expect(expired.deleted_records).toBe(3);
		expect(Number(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM records").one().count)).toBe(3);
		expect(visible()).toEqual(logs.slice(2));

		// However old, the latest three stay.
		clock.value += 365 * DAY_MS;
		expect(store.runCleanup(clock.value).deleted_records).toBe(0);
		expect(visible()).toEqual(logs.slice(2));
	});
});

it("expires records past retentionSeconds whatever the count", async () => {
	await withStore("retention-ceiling", { retentionRecords: 100, minRetentionMs: DAY_MS, retentionMs: 7 * DAY_MS }, (store, clock) => {
		const last = ["old", "older"].map((text) => oneLog(store.mutate(messageInput(clock, `ceiling-${text}`, text)))).at(-1)!;
		clock.value += 8 * DAY_MS;
		const expired = store.runCleanup(clock.value);
		expect(expired.history_floor).toBe(String(last + 1n));
		expect(messagesOf(store.historyPage({ roomId: "general", after: "0", limit: 50, now: clock.value }))).toEqual([]);
	});
});

it("with tiers below, removes records from SQLite only once copied, and keeps the published floor until the pipeline raises it", async () => {
	const tiered: Partial<StoreConfig> = {
		tiered: true, retentionRecords: 3, minRetentionMs: DAY_MS, retentionMs: 0, cleanupThresholdPercent: 100,
		anonymousPostsPerMinute: 1_000, ipPostsPerMinute: 1_000, globalPostsPerMinute: 1_000,
	};
	await withStore("history-floors", tiered, (store, clock, state) => {
		const general = BigInt(store.getRoomState().log_id);
		const logs = Array.from({ length: 8 }, (_, index) => {
			clock.value += 1_000;
			return oneLog(store.mutate(messageInput(clock, `tiered-${index}`, `message ${index}`)));
		});
		const hotRecords = () => Number(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM records").one().count);
		const due = () => state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1") && store.forgetCleanupDue();
		clock.value += 2 * DAY_MS;

		// No job yet: no target. Past the count, but nothing copied: nothing leaves, and the job waits.
		expect(store.historyTarget(clock.value)).toBeUndefined();
		const waiting = store.runCleanup(clock.value);
		expect(waiting.deleted_records).toBe(0);
		expect(waiting.next_due_ms).toBe(clock.value + 1_000);
		expect(hotRecords()).toBe(9);

		// The job's target: the first record it keeps. The records below it, oldest first.
		expect(store.historyTarget(clock.value)).toBe(Number(logs[5]));
		const scanned = store.historyScan(Number(general), 100, clock.value).filter((row) => row.log_id < Number(logs[5]));
		expect(scanned.map((row) => BigInt(row.log_id))).toEqual([general, ...logs.slice(0, 5)]);
		store.saveHistoryState("hot", "hot", { through: Number(logs[4]) }, clock.value);
		expect(store.historyState(["hot", "recent"], "hot", clock.value)).toEqual({
			hot: { floor: 1, target: 1, through: Number(logs[4]), ops: 0 },
			recent: { floor: 1, target: 1, through: 0, ops: 0 },
		});
		// A failing copy from SQLite is kept, for /status and the admins' alert, until one succeeds.
		store.saveHistoryState("hot", "hot", { stalledSince: 123, alertedAt: 456 }, clock.value);
		expect(store.historyState(["hot"], "hot", clock.value).hot).toMatchObject({ stalledSince: 123, alertedAt: 456 });
		store.saveHistoryState("hot", "hot", { stalledSince: undefined, alertedAt: undefined }, clock.value);
		expect(store.historyState(["hot"], "hot", clock.value).hot.stalledSince).toBeUndefined();
		due();
		const moved = store.runCleanup(clock.value);
		expect(moved.deleted_records).toBe(6);
		// The published floor stays where it was: the tier below holds what left.
		expect(moved.history_floor).toBe(moved.previous_floor);
		expect(store.historyFloors(clock.value)).toEqual({ hot: Number(logs[4] + 1n), published: Number(moved.history_floor), latest: Number(logs[7]) });
		expect(hotRecords()).toBe(3);

		// History reads SQLite, and asks the tiers below for what is under it.
		const pending = store.historyAcrossTiers({ roomId: "general", before: String(logs[7] + 1n), limit: 10, now: clock.value });
		if (!("below" in pending)) throw new Error("expected a page that reads the tiers below");
		expect(pending.below).toEqual({ roomIds: ["general"], lower: Number(general), upper: Number(logs[4]), forward: false, limit: 11 });
		const page = pending.assemble([...scanned].reverse());
		expect(messagesOf(page).map((entry) => BigInt(entry.log_id))).toEqual(logs);
		expect(page.more).toBe(false);
		// Without them, SQLite's part alone.
		expect(messagesOf(store.history({ roomId: "general", before: String(logs[7] + 1n), limit: 10, now: clock.value })).map((entry) => BigInt(entry.log_id))).toEqual(logs.slice(5));

		// The pipeline raises the published floor, never past the hot floor, and makes cleanup due.
		store.publishHistoryFloor(Number(logs[1]), clock.value);
		expect(store.logBounds().history_floor).toBe(String(logs[1]));
		store.publishHistoryFloor(Number(logs[7]), clock.value);
		expect(store.historyFloors(clock.value)).toEqual({ hot: Number(logs[4] + 1n), published: Number(logs[4] + 1n), latest: Number(logs[7]) });
		expect(store.cleanupDue(clock.value)).toBe(true);
		const narrowed = store.historyAcrossTiers({ roomId: "general", before: String(logs[7] + 1n), limit: 10, now: clock.value });
		expect("below" in narrowed).toBe(false);
	});
});

it("forgets the pipeline's floors, queue and tier state once tiers are off, so turning them on again starts at the hot floor", async () => {
	await withStore("history-off", { cleanupIntervalMs: 3_600_000 }, (_store, clock, state) => {
		state.storage.sql.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('history:published', '5'), ('history:head:through', '7'), ('history:ops', '[]'), ('history:tier:recent', '{}'), ('history:export:nightly', '123'), ('historyx', 'kept')");
		const off = new Store(state, { ...BY_AGE, tiered: false, cleanupIntervalMs: 3_600_000 }, clock.clock);
		clock.value += DAY_MS;
		state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1");
		off.forgetCleanupDue();
		state.storage.sql.exec("INSERT INTO records (room_id, log_id, commit_ms, kind, record_json) VALUES ('general', 2, 0, 'membership', '{}')");
		off.runCleanup(clock.value);
		// Backups' schedule is no tier's state: it stays.
		expect(state.storage.sql.exec("SELECT key FROM _meta WHERE key LIKE 'history%' ORDER BY key").toArray()).toEqual([{ key: "history:export:nightly" }, { key: "historyx" }]);
		const on = new Store(state, { ...BY_AGE, tiered: true }, clock.clock);
		expect(on.logBounds().history_floor).toBe(off.logBounds().history_floor);
	});
});

it("drops SQLite's reaction sets on messages that only a tier below held, for /purge", async () => {
	await withStore("drop-reactions", { anonymousPostsPerMinute: 1_000, ipPostsPerMinute: 1_000 }, (store, clock, state) => {
		const posted = store.mutate(messageInput(clock, "reacted", "react to me"));
		const messageId = String(posted.result.message_id);
		store.mutate({ ...messageInput(clock, "reaction", ""), method: "reactions", params: { message_id: messageId, emojis: ["👍"] } });
		const count = (sql: string) => Number(state.storage.sql.exec<{ count: number }>(sql).one().count);
		expect(count("SELECT COUNT(*) AS count FROM records WHERE kind = 'reactions'")).toBe(1);
		store.dropReactionsOn([messageId], clock.value);
		expect(count("SELECT COUNT(*) AS count FROM records WHERE kind = 'reactions'")).toBe(0);
		expect(count("SELECT COUNT(*) AS count FROM reaction_state")).toBe(0);
	});
});

it("keeps cleanupThresholdPercent of retentionRecords: each daily cleanup trims back to it", async () => {
	const config: Partial<StoreConfig> = {
		retentionRecords: 10, cleanupThresholdPercent: 50, minRetentionMs: DAY_MS, retentionMs: 0,
		anonymousPostsPerMinute: 1_000, ipPostsPerMinute: 1_000, globalPostsPerMinute: 1_000,
	};
	await withStore("threshold", config, (store, clock, state) => {
		const count = () => Number(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM records").one().count);
		// The general room's record and eight messages: nine, under the limit of 10 but past its 50%.
		for (let index = 0; index < 8; index += 1) {
			clock.value += 1_000;
			store.mutate(messageInput(clock, `threshold-${index}`, `message ${index}`));
		}
		expect(count()).toBe(9);
		// Once the records are old enough, the daily cleanup keeps 5 (50% of 10), not 10.
		clock.value += 2 * DAY_MS;
		state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1");
		store.forgetCleanupDue();
		const cleaned = store.runCleanup(clock.value);
		expect(count()).toBe(5);
		// And comes back a day later, not sooner.
		expect(cleaned.next_due_ms).toBe(clock.value + DAY_MS);
	});
});
