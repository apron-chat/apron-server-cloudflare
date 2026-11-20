// Archived rooms (roomArchiveMs): a thread or private room whose newest
// record is older than the archive window stays listed and readable but no
// longer counts against the room caps; a new record in it makes it active
// again, taking a slot. Archived rooms are kept for good, however many.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { HistoryChain } from "../src/history/chain";
import { buildHistoryChain } from "../src/history/config";
import { R2BlobStore } from "../src/history/storage/r2";
import { Store, StoreError, type StoreConfig, type StoreMutationInput } from "../src/store";
import { errorCode, messagesOf, withStore, type TestClock } from "./helpers/store";

const DAY = 24 * 60 * 60 * 1000;
const CONFIG: Partial<StoreConfig> = {
	// History far longer than the archive window, so rooms are archived, not expired.
	retentionRecords: 0,
	retentionMs: 365 * DAY,
	roomArchiveMs: 10 * DAY,
	maxThreads: 2,
	maxThreadsPerUser: 2,
	maxPrivateRooms: 2,
	maxPrivateRoomsPerUser: 2,
	anonymousPostsPerMinute: 1_000,
	anonymousPostsPerDay: 1_000,
	registeredPostsPerMinute: 1_000,
	registeredPostsPerDay: 1_000,
	ipPostsPerMinute: 1_000,
	ipPostsPerDay: 1_000,
	globalPostsPerMinute: 1_000,
	globalPostsPerDay: 5_000,
};

let requests = 0;
function op(clock: TestClock, userId: string, method: string, params: Record<string, unknown>): StoreMutationInput {
	requests += 1;
	return { userId, ipKey: "ip", requestId: `r-${requests}`, method, now: clock.value, params, identity: { user_id: userId, name: userId } };
}

const thread = (store: Store, clock: TestClock, title = "Thread") =>
	String(store.mutate(op(clock, "alice", "room_set", { parent_room_id: "general", title })).result.room_id);
const say = (store: Store, clock: TestClock, roomId: string, text = "hi") =>
	store.mutate(op(clock, "alice", "message", { room_id: roomId, body: { text } }));
const archived = (store: Store, clock: TestClock) =>
	store.listRooms(clock.value).filter((room) => room.archived).map((room) => room.room_id);
const refusal = (fn: () => unknown): string => {
	try {
		fn();
	} catch (error) {
		if (error instanceof StoreError) return `${error.code}: ${error.message}`;
		throw error;
	}
	throw new Error("expected a refusal");
};

it("a quiet thread stops counting, stays listed and readable, and a post makes it active again", async () => {
	await withStore("archive-threads", CONFIG, (store, clock) => {
		const first = thread(store, clock, "First");
		say(store, clock, first, "before");
		const second = thread(store, clock, "Second");
		expect(refusal(() => thread(store, clock))).toBe("denied: thread_limit");
		expect(archived(store, clock)).toEqual([]);

		// Quiet past the window: both are archived, listed with the mark, and free their slots.
		clock.value += 11 * DAY;
		expect(archived(store, clock)).toEqual([first, second]);
		expect(store.roomCounts(clock.value).public).toEqual({ active: 0, archived: 2 });
		const third = thread(store, clock, "Third");
		const fourth = thread(store, clock, "Fourth");
		expect(refusal(() => thread(store, clock))).toBe("denied: thread_limit");
		expect(store.roomCounts(clock.value).public).toEqual({ active: 2, archived: 2 });

		// An archived room's history is still read in full.
		expect(messagesOf(store.historyPage({ roomId: first, after: "0", limit: 50, now: clock.value })).map((message) => message.body?.text)).toEqual(["before"]);

		// A post would make it active again: refused as a new thread is while the cap is full.
		expect(refusal(() => say(store, clock, first, "back"))).toBe("denied: thread_limit");
		// A room save too.
		expect(refusal(() => store.mutate(op(clock, "alice", "room_set", { room_id: first, title: "Renamed" })))).toBe("denied: thread_limit");

		// Once the new ones go quiet too, the post goes through and the room is active again.
		clock.value += 11 * DAY;
		expect(archived(store, clock)).toEqual([first, second, third, fourth]);
		say(store, clock, first, "back");
		expect(archived(store, clock)).toEqual([second, third, fourth]);
		expect(store.listRooms(clock.value).find((room) => room.room_id === first)?.archived).toBeUndefined();
		expect(store.roomCounts(clock.value).public).toEqual({ active: 1, archived: 3 });
		expect(messagesOf(store.historyPage({ roomId: first, after: "0", limit: 50, now: clock.value })).map((message) => message.body?.text)).toEqual(["before", "back"]);
	});
});

it("the archived mark is a delivery field: never in a room's logged record", async () => {
	await withStore("archive-logged", CONFIG, (store, clock) => {
		const room = thread(store, clock);
		clock.value += 11 * DAY;
		const listed = store.listRooms(clock.value).find((entry) => entry.room_id === room);
		expect(listed?.archived).toBe(true);
		const records = store.historyPage({ roomId: room, after: "0", limit: 50, now: clock.value }).rooms ?? [];
		expect(records.length).toBeGreaterThan(0);
		for (const record of records) expect(record).not.toHaveProperty("archived");
	});
});

it("leaving an archived room is never refused; joining one is, while the cap is full", async () => {
	await withStore("archive-membership", CONFIG, (store, clock) => {
		store.registerIdentity({ userId: "bob_1", name: "Bob", userHandle: "h-bob", now: clock.value, ipKey: "ip", credential: { credentialId: "c-bob", userId: "bob_1", publicKey: "AAAA", counter: 0 } });
		const quiet = thread(store, clock, "Quiet");
		const other = thread(store, clock, "Other");
		store.changeMembership({ userId: "bob_1", ipKey: "ip", roomId: quiet, join: true, now: clock.value });
		clock.value += 11 * DAY;
		thread(store, clock, "New one");
		thread(store, clock, "New two");
		expect(errorCode(() => store.changeMembership({ userId: "bob_1", ipKey: "ip", roomId: other, join: true, now: clock.value }))).toBe("denied");
		expect(store.changeMembership({ userId: "bob_1", ipKey: "ip", roomId: quiet, join: false, now: clock.value }).changed).toBe(true);
	});
});

it("private rooms archive the same way, with their own cap", async () => {
	await withStore("archive-private", CONFIG, (store, clock) => {
		store.registerIdentity({ userId: "carol_1", name: "Carol", userHandle: "h-carol", now: clock.value, ipKey: "ip", credential: { credentialId: "c-carol", userId: "carol_1", publicKey: "AAAA", counter: 0 } });
		const open = (title: string) => String(store.mutate({ ...op(clock, "carol_1", "room_set", { private: true, title }), identity: { user_id: "carol_1", name: "Carol" } }).result.room_id);
		const one = open("One");
		open("Two");
		expect(errorCode(() => open("Three"))).toBe("denied");
		clock.value += 11 * DAY;
		expect(store.roomCounts(clock.value).private).toEqual({ active: 0, archived: 2 });
		// Their slots are free again, the creator's own share included.
		open("Three");
		open("Four");
		expect(errorCode(() => open("Five"))).toBe("denied");
		expect(store.listRooms(clock.value, { withPrivate: true }).find((room) => room.room_id === one)?.archived).toBe(true);
	});
});

it("archived rooms are kept however many there are: listed newest first up to a bound, never removed, never in the way of a new room", async () => {
	const config = { ...CONFIG, retentionMs: 10_000 * DAY, maxThreads: 4, maxThreadsPerUser: 4 };
	await withStore("archive-unbounded", config, (store, clock) => {
		const reads = () => (store as unknown as { observed: { reads: number } }).observed.reads;
		const countReads = () => {
			const before = reads();
			store.roomCounts(clock.value);
			return reads() - before;
		};
		const created: string[] = [];
		let early = 0;
		// 152 threads, four at a time, each generation archived before the next:
		// past the 100 archived threads a listing names, and far past the cap.
		for (let generation = 0; generation < 38; generation += 1) {
			for (let i = 0; i < 4; i += 1) created.push(thread(store, clock, `g${generation}-${i}`));
			clock.value += 11 * DAY;
			if (generation === 2) early = countReads();
		}
		expect(store.roomCounts(clock.value).public).toEqual({ active: 0, archived: 152 });
		// Counting the live rooms reads ranges of the kind index, whatever the archived ones number.
		expect(countReads()).toBeLessThanOrEqual(early + 2);
		// Cleanup removes none of them: their history is still there.
		for (let round = 0; round < 4; round += 1) {
			const result = store.runCleanup(clock.value);
			expect(result.removed_rooms).toEqual([]);
			clock.value = Math.max(clock.value, result.next_due_ms);
		}
		expect(store.roomCounts(clock.value).public).toEqual({ active: 0, archived: 152 });
		// A listing names the 100 most recently active archived threads; an older one is read by its room_id.
		const listed = archived(store, clock);
		expect(listed).toHaveLength(100);
		expect(new Set(listed)).toEqual(new Set(created.slice(-100)));
		expect(store.getRoom(created[0], clock.value)?.archived).toBe(true);
		// An export names every room, archived ones included.
		expect(store.allRooms(clock.value).filter((room) => room.archived).map((room) => room.room_id)).toEqual(created);
		// New rooms take live slots only.
		for (let i = 0; i < 4; i += 1) thread(store, clock, `fresh-${i}`);
		expect(refusal(() => thread(store, clock))).toBe("denied: thread_limit");
		expect(store.roomCounts(clock.value).public).toEqual({ active: 4, archived: 152 });
	});
});

it("an object made before the room kind index works without it, and its first cleanup adds it", async () => {
	await withStore("archive-index", CONFIG, (store, clock, state) => {
		const sql = state.storage.sql;
		const hasIndex = () => sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'rooms_kind_head_idx'").toArray().length === 1;
		expect(hasIndex()).toBe(true);
		sql.exec("DROP INDEX rooms_kind_head_idx");
		const first = thread(store, clock, "Before");
		clock.value += 11 * DAY;
		expect(archived(store, clock)).toEqual([first]);
		expect(store.roomCounts(clock.value).public).toEqual({ active: 0, archived: 1 });
		thread(store, clock, "Fresh");
		expect(hasIndex()).toBe(false);
		store.runCleanup(clock.value);
		expect(hasIndex()).toBe(true);
		expect(store.roomCounts(clock.value).public).toEqual({ active: 1, archived: 1 });
	});
});

it("rooms never archive with roomArchiveMs 0: they count until removed", async () => {
	await withStore("archive-off", { ...CONFIG, roomArchiveMs: 0 }, (store, clock) => {
		thread(store, clock);
		thread(store, clock);
		clock.value += 100 * DAY;
		expect(archived(store, clock)).toEqual([]);
		expect(refusal(() => thread(store, clock))).toBe("denied: thread_limit");
		expect(store.roomCounts(clock.value).public).toEqual({ active: 2, archived: 0 });
	});
});

it("an imported room whose newest record is old comes in archived, taking no slot", async () => {
	await withStore("archive-import", CONFIG, (store, clock) => {
		thread(store, clock, "One");
		thread(store, clock, "Two");
		const old = clock.value - 40 * DAY;
		const roomId = String(old);
		const listing = { room_id: roomId, parent_room_id: "general", title: "Old thread", log_id: String(old), latest_log_id: String(old + 1) };
		const records = [
			{ room_id: roomId, log_id: old, commit_ms: old, kind: "room" as const, record_json: JSON.stringify({ room_id: roomId, log_id: String(old), parent_room_id: "general", title: "Old thread" }) },
			{ room_id: roomId, log_id: old + 1, commit_ms: old + 1, kind: "message" as const, record_json: JSON.stringify({ room_id: roomId, log_id: String(old + 1), message_id: String(old + 1), from: { user_id: "dee", name: "Dee" }, body: { text: "long ago" } }) },
		];
		// The planner's capacity check agrees: an old room needs no slot, a recent one does.
		expect(store.restoreRoomCapacity([listing], clock.value)).toBeUndefined();
		expect(store.restoreRoomCapacity([{ ...listing, latest_log_id: String(clock.value) }], clock.value)).toMatch(/thread_limit/);
		store.restoreRoom({ listing, joined: false }, records, clock.value);
		expect(archived(store, clock)).toContain(roomId);
		expect(store.roomCounts(clock.value).public).toEqual({ active: 2, archived: 1 });
	});
});

it("an archived room's history pages from the cold tier", async () => {
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	type Runtime = { store: Store & { config: Record<string, unknown> }; config: { limits: Record<string, number> }; history?: HistoryChain; alarm(): Promise<void> };
	await runInDurableObject(env.DEMO.getByName(`archive-cold-${crypto.randomUUID()}`), async (instance, state) => {
		const runtime = instance as unknown as Runtime;
		runtime.store.config = { ...runtime.store.config, retentionRecords: 3, minRetentionMs: 0, cleanupThresholdPercent: 100, anonymousPostsPerMinute: 100_000, ipPostsPerMinute: 100_000, globalPostsPerMinute: 100_000 };
		runtime.config = { ...runtime.config, limits: { ...runtime.config.limits, retentionRecords: 3, historyD1Records: 0, cleanupThresholdPercent: 100 } };
		runtime.history = buildHistoryChain({
			layout: { blobs: new R2BlobStore(env.HISTORY_BLOB!), blobLabel: "R2" }, limits: runtime.config.limits as never, store: runtime.store,
			clock: { now: Date.now }, chunkIndex: (tier) => runtime.store.chunkIndex(tier), server: `archive-cold-${Date.now()}`,
		});
		const room = String(runtime.store.mutate({ userId: "p", ipKey: "ip", requestId: "t", method: "room_set", now: Date.now(), params: { parent_room_id: "general", title: "Long ago" }, identity: { user_id: "p", name: "p" } }).result.room_id);
		const logs: number[] = [];
		for (let index = 0; index < 120; index += 1) {
			const result = runtime.store.mutate({ userId: "p", ipKey: "ip", requestId: `m-${index}`, method: "message", now: Date.now(), params: { room_id: room, body: { text: `m ${index}` } }, identity: { user_id: "p", name: "p" } });
			logs.push(Number(result.message!.log_id));
			await sleep(2);
		}
		for (let round = 0; round < 10; round += 1) {
			state.storage.sql.exec("UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1");
			runtime.store.forgetCleanupDue();
			await runtime.alarm();
		}
		const cold = (await runtime.history!.tiers[1].scan(0, 100_000)).records.filter((record) => record.room_id === room);
		expect(cold.length).toBeGreaterThan(0);
		// Quiet past the window: archived, still listed, and every message pages back through the cold tier.
		runtime.store.config = { ...runtime.store.config, roomArchiveMs: 1 };
		await sleep(5);
		expect(runtime.store.listRooms(Date.now()).find((entry) => entry.room_id === room)?.archived).toBe(true);
		const page = await runtime.history!.read({ roomIds: [room], lower: 1, upper: Number.MAX_SAFE_INTEGER, forward: true, limit: 1_000 });
		expect(page.filter((record) => record.kind === "message").map((record) => record.log_id)).toEqual(logs);
	});
});
