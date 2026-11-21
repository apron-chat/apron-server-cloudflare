// Room caps by creation (roomCreationWindowMs): the thread and private-room
// caps count the rooms started within the window, so they limit how fast
// rooms are started, not how many exist. Posting in, joining or leaving an
// older room never needs a slot, and rooms are kept as long as their
// history, however many (test/history/chain.integration.test.ts pages a
// thread's history back from the cold tier). A user's own rooms are bounded by
// MAX_MEMBERSHIPS_PER_USER, so reading them stays within its reservation.
import { afterEach, expect, it, vi } from "vitest";
import { MAX_MEMBERSHIPS_PER_USER } from "../src/budget";
import { MAX_LISTED_USER_ROOMS } from "../src/domain";
import { type Store, type StoreConfig, StoreError, type StoreMutationInput } from "../src/store";
import { messagesOf, withStore, type TestClock } from "./helpers/store";
import { sqliteOf } from "../src/store/open";

const DAY = 24 * 60 * 60 * 1000;
const CONFIG: Partial<StoreConfig> = {
	// History far longer than the window, so rooms are old, not expired.
	historyHotRecords: 0,
	retentionMs: 10_000 * DAY,
	roomCreationWindowMs: 10 * DAY,
	maxThreads: 2,
	maxThreadsPerUser: 2,
	maxPrivateRooms: 2,
	maxPrivateRoomsPerUser: 2,
	guestPostsPerMinute: 10_000,
	guestPostsPerDay: 10_000,
	registeredPostsPerMinute: 10_000,
	registeredPostsPerDay: 10_000,
	ipPostsPerMinute: 10_000,
	ipPostsPerDay: 10_000,
	globalPostsPerMinute: 10_000,
	globalPostsPerDay: 50_000,
};

afterEach(() => vi.restoreAllMocks());

let requests = 0;
function op(clock: TestClock, userId: string, method: string, params: Record<string, unknown>): StoreMutationInput {
	requests += 1;
	return { userId, ipKey: "ip", requestId: `r-${requests}`, method, now: clock.value, params, identity: { user_id: userId, name: userId } };
}
const thread = (store: Store, clock: TestClock, title = "Thread", userId = "alice") =>
	String(store.messages.mutate(op(clock, userId, "room_set", { parent_room_id: "general", title })).result.room_id);
const say = (store: Store, clock: TestClock, roomId: string, text = "hi") =>
	store.messages.mutate(op(clock, "alice", "message", { room_id: roomId, body: { text } }));
const listedThreads = (store: Store, clock: TestClock) =>
	store.rooms.list(clock.value).filter((room) => room.parent_room_id === "general").map((room) => room.room_id);
const refusal = (fn: () => unknown): string => {
	try {
		fn();
	} catch (error) {
		if (error instanceof StoreError) return `${error.code}: ${error.message}`;
		throw error;
	}
	throw new Error("expected a refusal");
};
const register = (store: Store, clock: TestClock, userId: string) =>
	store.accounts.register({ userId, name: userId, userHandle: `h-${userId}`, now: clock.value, ipKey: "ip", credential: { credentialId: `c-${userId}`, userId, publicKey: "AAAA", counter: 0 } });
const overruns = (spy: { mock: { calls: unknown[][] } }) =>
	spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('"event":"accounting_overrun"'));

it("the caps count rooms started within the window: older rooms stay listed and readable, and activity in them never needs a slot", async () => {
	await withStore("caps-threads", CONFIG, (store, clock) => {
		const first = thread(store, clock, "First");
		say(store, clock, first, "before");
		const second = thread(store, clock, "Second");
		expect(refusal(() => thread(store, clock))).toBe("denied: thread_limit");
		expect(store.rooms.counts(clock.value).public).toEqual({ recent: 2, older: 0 });

		// Past the window: both stop counting, stay listed, and their slots are free.
		clock.value += 11 * DAY;
		expect(store.rooms.counts(clock.value).public).toEqual({ recent: 0, older: 2 });
		thread(store, clock, "Third");
		thread(store, clock, "Fourth");
		expect(refusal(() => thread(store, clock))).toBe("denied: thread_limit");
		expect(listedThreads(store, clock)).toEqual(expect.arrayContaining([first, second]));

		// The cap is full, yet the older rooms take posts and saves: activity never needs a slot.
		say(store, clock, first, "after");
		store.messages.mutate(op(clock, "alice", "room_set", { room_id: second, title: "Renamed" }));
		expect(messagesOf(sqliteOf(store).historyLog.historyPage({ roomId: first, after: "0", limit: 50, now: clock.value })).map((message) => message.body?.text)).toEqual(["before", "after"]);
		expect(store.rooms.counts(clock.value).public).toEqual({ recent: 2, older: 2 });
	});
});

it("joining and leaving never need a slot", async () => {
	await withStore("caps-membership", CONFIG, (store, clock) => {
		register(store, clock, "bob_1");
		const old = thread(store, clock, "Old");
		const other = thread(store, clock, "Other");
		clock.value += 11 * DAY;
		thread(store, clock, "New one");
		thread(store, clock, "New two");
		expect(refusal(() => thread(store, clock))).toBe("denied: thread_limit");
		expect(store.rooms.changeMembership({ userId: "bob_1", ipKey: "ip", roomId: old, join: true, now: clock.value }).changed).toBe(true);
		expect(store.rooms.changeMembership({ userId: "bob_1", ipKey: "ip", roomId: other, join: true, now: clock.value }).changed).toBe(true);
		expect(store.rooms.changeMembership({ userId: "bob_1", ipKey: "ip", roomId: old, join: false, now: clock.value }).changed).toBe(true);
	});
});

it("per-user caps count the user's own rooms started within the window", async () => {
	const config = { ...CONFIG, maxThreads: 10, maxThreadsPerUser: 2 };
	await withStore("caps-per-user", config, (store, clock) => {
		register(store, clock, "dana_1");
		thread(store, clock, "One", "dana_1");
		thread(store, clock, "Two", "dana_1");
		expect(refusal(() => thread(store, clock, "Three", "dana_1"))).toMatch(/^denied: You can start at most 2 threads in 10 days/);
		// Someone else's share is their own.
		register(store, clock, "eve_1");
		thread(store, clock, "Eve's", "eve_1");
		clock.value += 11 * DAY;
		thread(store, clock, "Three", "dana_1");
	});
});

it("a user holding any role is held only to the server's thread cap, not the per-user one", async () => {
	const config = { ...CONFIG, maxThreads: 5, maxThreadsPerUser: 2 };
	await withStore("caps-per-user-roles", config, (store, clock) => {
		for (const [userId, role] of [["mod_1", "threader"], ["pal_1", "friend"], ["plain_1", ""]] as const) {
			register(store, clock, userId);
			if (role) store.accounts.setRole({ userId, role, on: true, now: clock.value });
		}
		thread(store, clock, "One", "mod_1");
		thread(store, clock, "Two", "mod_1");
		thread(store, clock, "Three", "mod_1");
		thread(store, clock, "Four", "pal_1");
		// Without a role, the per-user cap still holds.
		thread(store, clock, "Plain", "plain_1");
		// The server's cap holds for everyone: five threads started in the window.
		expect(refusal(() => thread(store, clock, "Six", "mod_1"))).toMatch(/^denied: thread_limit/);
	});
	await withStore("caps-per-user-roles-plain", config, (store, clock) => {
		register(store, clock, "plain_1");
		thread(store, clock, "One", "plain_1");
		thread(store, clock, "Two", "plain_1");
		expect(refusal(() => thread(store, clock, "Three", "plain_1"))).toMatch(/^denied: You can start at most 2 threads/);
		// Losing the role restores the per-user cap.
		store.accounts.setRole({ userId: "plain_1", role: "threader", on: true, now: clock.value });
		thread(store, clock, "Three", "plain_1");
		store.accounts.setRole({ userId: "plain_1", role: "threader", on: false, now: clock.value });
		expect(refusal(() => thread(store, clock, "Four", "plain_1"))).toMatch(/^denied: You can start at most 2 threads/);
	});
});

it("private rooms follow the same rule, with their own caps", async () => {
	await withStore("caps-private", CONFIG, (store, clock) => {
		register(store, clock, "carol_1");
		const open = (title: string) => String(store.messages.mutate({ ...op(clock, "carol_1", "room_set", { private: true, title }), identity: { user_id: "carol_1", name: "carol_1" } }).result.room_id);
		const one = open("One");
		open("Two");
		expect(refusal(() => open("Three"))).toMatch(/^denied: You can start at most 2 private rooms in 10 days/);
		clock.value += 11 * DAY;
		expect(store.rooms.counts(clock.value).private).toEqual({ recent: 0, older: 2 });
		open("Three");
		open("Four");
		expect(refusal(() => open("Five"))).toMatch(/^denied: You can start at most 2 private rooms/);
		// The older one is kept and listed for its members.
		expect(store.rooms.list(clock.value, { withPrivate: true }).some((room) => room.room_id === one)).toBe(true);
	});
});

it("rooms are kept however many there are: listed by most recent activity up to a bound, never removed, never in the way of a new room", async () => {
	const config = { ...CONFIG, maxThreads: 4, maxThreadsPerUser: 4 };
	await withStore("caps-many", config, (store, clock) => {
		const reads = () => (sqliteOf(store) as unknown as { observed: { reads: number } }).observed.reads;
		const countReads = () => {
			const before = reads();
			store.rooms.counts(clock.value);
			return reads() - before;
		};
		const created: string[] = [];
		let early = 0;
		// 208 threads, four a window: past the 200 a listing names, and far past the cap.
		for (let generation = 0; generation < 52; generation += 1) {
			for (let i = 0; i < 4; i += 1) created.push(thread(store, clock, `g${generation}-${i}`));
			clock.value += 11 * DAY;
			if (generation === 2) early = countReads();
		}
		expect(store.rooms.counts(clock.value).public).toEqual({ recent: 0, older: 208 });
		// Counting the recent rooms reads a range of the creation index, whatever the older ones number.
		expect(countReads()).toBeLessThanOrEqual(early + 2);
		for (let round = 0; round < 4; round += 1) {
			const result = store.lifecycle.runCleanup(clock.value);
			expect(result.removed_rooms).toEqual([]);
			clock.value = Math.max(clock.value, result.next_due_ms);
		}
		// A listing names the 200 most recently active threads; an older one is read by its room_id.
		expect(new Set(listedThreads(store, clock))).toEqual(new Set(created.slice(-200)));
		expect(store.rooms.get(created[0], clock.value)?.room_id).toBe(created[0]);
		// Activity brings an old thread back into the listing, ahead of quieter ones.
		say(store, clock, created[0], "back again");
		const listed = listedThreads(store, clock);
		expect(listed).toHaveLength(200);
		expect(listed).toContain(created[0]);
		expect(listed).not.toContain(created[8]);
		// An export names every room.
		expect(sqliteOf(store).allRooms(clock.value).filter((room) => room.parent_room_id === "general").map((room) => room.room_id)).toEqual(created);
		// New rooms take the window's slots only.
		for (let i = 0; i < 4; i += 1) thread(store, clock, `fresh-${i}`);
		expect(refusal(() => thread(store, clock))).toBe("denied: thread_limit");
	});
});

it("an object made before the rooms' kind indexes works without them, and its first cleanup adds them", async () => {
	await withStore("caps-index", CONFIG, (store, clock, state) => {
		const sql = state.storage.sql;
		const indexes = () => sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'rooms_kind_%' ORDER BY name").toArray().map((row) => row.name);
		expect(indexes()).toEqual(["rooms_kind_created_idx", "rooms_kind_head_idx"]);
		sql.exec("DROP INDEX rooms_kind_created_idx");
		sql.exec("DROP INDEX rooms_kind_head_idx");
		thread(store, clock, "Before");
		clock.value += 11 * DAY;
		thread(store, clock, "Fresh");
		expect(store.rooms.counts(clock.value).public).toEqual({ recent: 1, older: 1 });
		expect(listedThreads(store, clock)).toHaveLength(2);
		expect(indexes()).toEqual([]);
		store.lifecycle.runCleanup(clock.value);
		expect(indexes()).toEqual(["rooms_kind_created_idx", "rooms_kind_head_idx"]);
		expect(store.rooms.counts(clock.value).public).toEqual({ recent: 1, older: 1 });
	});
});

it("with roomCreationWindowMs 0 every room that exists counts", async () => {
	await withStore("caps-window-off", { ...CONFIG, roomCreationWindowMs: 0 }, (store, clock) => {
		thread(store, clock);
		thread(store, clock);
		clock.value += 100 * DAY;
		expect(refusal(() => thread(store, clock))).toBe("denied: thread_limit");
		expect(store.rooms.counts(clock.value).public).toEqual({ recent: 2, older: 0 });
	});
});

it("an imported room created before the window takes no slot, and planning agrees", async () => {
	await withStore("caps-import", CONFIG, (store, clock) => {
		thread(store, clock, "One");
		thread(store, clock, "Two");
		const old = clock.value - 40 * DAY;
		const roomId = String(old);
		const listing = { room_id: roomId, parent_room_id: "general", title: "Old thread", log_id: String(old), latest_log_id: String(old + 1) };
		const records = [
			{ room_id: roomId, log_id: old, commit_ms: old, kind: "room" as const, record_json: JSON.stringify({ room_id: roomId, log_id: String(old), parent_room_id: "general", title: "Old thread" }) },
			{ room_id: roomId, log_id: old + 1, commit_ms: old + 1, kind: "message" as const, record_json: JSON.stringify({ room_id: roomId, log_id: String(old + 1), message_id: String(old + 1), from: { user_id: "dee", name: "Dee" }, body: { text: "long ago" } }) },
		];
		// An old room needs no slot; one created within the window does, as does one whose creation planning cannot tell.
		expect(sqliteOf(store).restoreRoomCapacity([listing], clock.value)).toBeUndefined();
		expect(sqliteOf(store).restoreRoomCapacity([{ ...listing, log_id: String(clock.value) }], clock.value)).toMatch(/thread_limit/);
		expect(sqliteOf(store).restoreRoomCapacity([{ room_id: roomId, parent_room_id: "general" }], clock.value)).toMatch(/thread_limit/);
		sqliteOf(store).restoreRoom({ listing, joined: false }, records, clock.value);
		expect(store.rooms.counts(clock.value).public).toEqual({ recent: 2, older: 1 });
	});
});

it("a user in hundreds of rooms joins and leaves within their reservations, and the membership cap holds", async () => {
	await withStore("caps-memberships", { ...CONFIG, maxThreads: 10 }, (store, clock, state) => {
		const error = vi.spyOn(console, "error");
		register(store, clock, "bob_1");
		register(store, clock, "cleo_1");
		const sql = state.storage.sql;
		// 300 rooms bob is in, older than the window.
		const base = clock.value - 400 * DAY;
		const join = (count: number, offset: number) => {
			for (let i = 0; i < count; i += 1) {
				const id = String(base + offset + i);
				sql.exec(
					"INSERT INTO rooms (room_id, parent_room_id, created_log_id, record_log_id, latest_log_id, fields_json, created_ms, updated_ms, member_count) VALUES (?, 'general', ?, ?, ?, ?, ?, ?, 1)",
					id, base + offset + i, base + offset + i, base + offset + i, JSON.stringify({ title: `t${offset + i}` }), base, base,
				);
				sql.exec("INSERT INTO memberships (room_id, user_id) VALUES (?, 'bob_1')", id);
			}
		};
		join(300, 0);
		const room = thread(store, clock, "Now");
		for (let round = 0; round < 4; round += 1) {
			expect(store.rooms.changeMembership({ userId: "bob_1", ipKey: "ip", roomId: room, join: true, now: clock.value }).changed).toBe(true);
			expect(store.rooms.changeMembership({ userId: "bob_1", ipKey: "ip", roomId: room, join: false, now: clock.value }).changed).toBe(true);
		}
		expect(store.accounts.get("bob_1")?.rooms.length).toBeLessThanOrEqual(351);
		// Someone else's join is unaffected: no overrun, so no breaker.
		expect(store.rooms.changeMembership({ userId: "cleo_1", ipKey: "ip", roomId: room, join: true, now: clock.value }).changed).toBe(true);
		expect(overruns(error)).toEqual([]);

		// At MAX_MEMBERSHIPS_PER_USER a join is refused, and creating a room (which joins its creator) too.
		const held = Number(sql.exec("SELECT COUNT(*) AS count FROM memberships WHERE user_id = 'bob_1'").one().count);
		join(MAX_MEMBERSHIPS_PER_USER - held - 1, 300);
		expect(store.rooms.changeMembership({ userId: "bob_1", ipKey: "ip", roomId: room, join: true, now: clock.value }).changed).toBe(true);
		const other = thread(store, clock, "Other");
		expect(refusal(() => store.rooms.changeMembership({ userId: "bob_1", ipKey: "ip", roomId: other, join: true, now: clock.value }))).toBe(`denied: A user may be in at most ${MAX_MEMBERSHIPS_PER_USER} rooms; leave one to join another`);
		expect(refusal(() => thread(store, clock, "Mine", "bob_1"))).toMatch(/^denied: A user may be in at most/);
		// Leaving one makes room.
		expect(store.rooms.changeMembership({ userId: "bob_1", ipKey: "ip", roomId: room, join: false, now: clock.value }).changed).toBe(true);
		expect(store.rooms.changeMembership({ userId: "bob_1", ipKey: "ip", roomId: other, join: true, now: clock.value }).changed).toBe(true);
		expect(overruns(error)).toEqual([]);
	});
});

it("a user in hundreds of rooms keeps the room just joined and their top-level rooms in their listing", async () => {
	await withStore("room-caps-listed-rooms", { ...CONFIG, maxThreads: 10 }, (store, clock, state) => {
		register(store, clock, "bob_1");
		const sql = state.storage.sql;
		const base = clock.value - 400 * DAY;
		const insert = (roomId: string, parent: string | null, logId: number) => {
			sql.exec("INSERT INTO rooms (room_id, parent_room_id, created_log_id, record_log_id, latest_log_id, fields_json, created_ms, updated_ms, member_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)", roomId, parent, logId, logId, logId, JSON.stringify({ title: "t" }), base, base);
		};
		// A top-level room made long ago, and an old thread bob has not joined: the oldest IDs.
		const top = String(base - 2_000);
		insert(top, null, base - 2_000);
		sql.exec("INSERT INTO memberships (room_id, user_id) VALUES (?, 'bob_1')", top);
		const old = String(base - 1_000);
		insert(old, "general", base - 1_000);
		// 360 newer threads bob is in: more than a listing names by room_id.
		for (let i = 0; i < 360; i += 1) {
			insert(String(base + i), "general", base + i);
			sql.exec("INSERT INTO memberships (room_id, user_id) VALUES (?, 'bob_1')", String(base + i));
		}
		const listed = store.accounts.get("bob_1")!.rooms;
		expect(listed).toContain(top);
		expect(listed).toContain("general");
		expect(listed.length).toBeLessThanOrEqual(MAX_LISTED_USER_ROOMS);
		// Joining the old thread lists it, however many newer rooms bob is in: a connection is delivered to what is listed.
		const change = store.rooms.changeMembership({ userId: "bob_1", ipKey: "ip", roomId: old, join: true, now: clock.value });
		expect(change.rooms).toContain(old);
		expect(change.rooms).toContain(top);
		expect(change.rooms.length).toBeLessThanOrEqual(MAX_LISTED_USER_ROOMS);
		// Joining it again (already a member) lists it too.
		expect(store.rooms.changeMembership({ userId: "bob_1", ipKey: "ip", roomId: old, join: true, now: clock.value }).rooms).toContain(old);
		// The longest listing, as a connection's attachment stores it, fits the attachment's budget beside 64 read cursors.
		const ids = Array.from({ length: MAX_LISTED_USER_ROOMS }, (_, i) => String(9_000_000_000_000_000 + i));
		const reads = Object.fromEntries(ids.slice(0, 64).map((id) => [id, id]));
		expect(JSON.stringify({ rooms: ids, reads }).length).toBeLessThan(12_000 - 2_000);
	});
});
