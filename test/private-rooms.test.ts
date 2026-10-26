import { expect, it } from "vitest";
import { DEFAULT_LIMITS, MAX_PRIVATE_ROOM_LIMIT, PUSH_POLICY } from "../src/budget";
import { PRIVATE_ROOM_PREFIX, RETENTION_MS, WAKE_SCOPES, type Store, type StoreConfig, type StoreMutationInput } from "../src/store";
import { errorCode, withStore as withNamedStore, type TestClock } from "./helpers/store";

// Private rooms (§4.2.4): `private_<log id>` rooms that only their members
// see, counted apart from the threads.

const ROOMY: Partial<StoreConfig> = {
	registeredPostsPerMinute: 1_000,
	registeredPostsPerDay: 5_000,
	ipPostsPerMinute: 1_000,
	ipPostsPerDay: 5_000,
	globalPostsPerMinute: 1_000,
	globalPostsPerDay: 5_000,
};

const withStore = <T>(name: string, fn: Parameters<typeof withNamedStore<T>>[2], config: Partial<StoreConfig> = {}) =>
	withNamedStore(`private-${name}`, { ...ROOMY, ...config }, fn);

let requests = 0;
function op(clock: TestClock, userId: string, method: string, params: Record<string, unknown>): StoreMutationInput {
	return { userId, ipKey: `ip-${userId}`, requestId: `r${++requests}`, method, now: clock.value, params, identity: { user_id: userId, name: userId } };
}

function register(store: Store, clock: TestClock, ...userIds: string[]): void {
	for (const userId of userIds) {
		store.registerIdentity({
			userId, name: userId, userHandle: `handle-${userId}`, now: clock.value, ipKey: `ip-${userId}`,
			credential: { credentialId: `credential-${userId}`, userId, publicKey: "AAAA", counter: 0 },
		});
	}
}

const create = (store: Store, clock: TestClock, userId: string, params: Record<string, unknown> = {}) =>
	String(store.mutate(op(clock, userId, "room_set", { private: true, ...params })).result.room_id);
const add = (store: Store, clock: TestClock, actorId: string, roomId: string, userId: string) =>
	store.changeMembership({ userId, ipKey: `ip-${actorId}`, roomId, join: true, now: clock.value, actorId });
const leave = (store: Store, clock: TestClock, userId: string, roomId: string) =>
	store.changeMembership({ userId, ipKey: `ip-${userId}`, roomId, join: false, now: clock.value });
const post = (store: Store, clock: TestClock, userId: string, roomId: string, params: Record<string, unknown> = {}) =>
	store.mutate(op(clock, userId, "message", { room_id: roomId, body: { text: "hi" }, ...params }));
const meta = (state: DurableObjectState, key: string) =>
	Number(state.storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = ?", key).toArray()[0]?.value ?? 0);

it("creates a private room for a registered user only: top-level, untitled unless named, and marked private", async () => {
	await withStore("create", (store, clock, state) => {
		register(store, clock, "ada");
		const created = store.mutate(op(clock, "ada", "room_set", { private: true }));
		const roomId = String(created.result.room_id);
		expect(roomId.startsWith(PRIVATE_ROOM_PREFIX)).toBe(true);
		expect(roomId.slice(PRIVATE_ROOM_PREFIX.length)).toBe(created.room?.log_id);
		// No title is supplied: clients name a private room after its members.
		expect(created.room).toEqual({ room_id: roomId, log_id: created.room?.log_id, private: true, latest_log_id: created.room?.latest_log_id, history_log_id: created.room?.log_id });
		expect(created.membership?.params.members).toEqual([{ user: { user_id: "ada", name: "ada" }, joined: true }]);
		expect(meta(state, "private_count")).toBe(1);
		expect(meta(state, "thread_count")).toBe(0);
		// A named one keeps its name; a member's save may clear it.
		const named = create(store, clock, "ada", { title: "Plans", description: "Who brings what" });
		expect(store.getRoom(named)).toMatchObject({ private: true, title: "Plans", description: "Who brings what" });
		const saved = store.mutate(op(clock, "ada", "room_set", { room_id: named, private: false }));
		expect(saved.room).toMatchObject({ room_id: named, private: true });
		expect(saved.room).not.toHaveProperty("title");
		// Guests have no private rooms, and none is a thread or has one.
		expect(errorCode(() => store.mutate(op(clock, "guest_1", "room_set", { private: true })))).toBe("denied");
		expect(errorCode(() => store.mutate(op(clock, "ada", "room_set", { private: true, parent_room_id: "general" })))).toBe("denied");
		expect(errorCode(() => store.mutate(op(clock, "ada", "room_set", { parent_room_id: roomId, title: "Side" })))).toBe("denied");
		// The public listing never holds it; its members' does.
		expect(store.listRooms().map((room) => room.room_id)).toEqual(["general"]);
		expect(store.privateRoomsOf("ada").map((room) => room.room_id).sort()).toEqual([roomId, named].sort());
	});
});

it("hides a private room from everyone outside it, as if it did not exist", async () => {
	await withStore("hidden", (store, clock) => {
		register(store, clock, "ada", "bob", "cy");
		const roomId = create(store, clock, "ada");
		const missing = `${PRIVATE_ROOM_PREFIX}1`;
		const secret = String(post(store, clock, "ada", roomId).result.message_id);
		const unknown = "999";
		for (const id of [roomId, missing]) {
			expect(errorCode(() => post(store, clock, "bob", id))).toBe("invalid_params");
			expect(errorCode(() => store.history({ roomId: id, userId: "bob" }))).toBe("invalid_params");
			expect(errorCode(() => store.mutate(op(clock, "bob", "room_set", { room_id: id, title: "x" })))).toBe("invalid_params");
			expect(errorCode(() => store.mutate(op(clock, "bob", "room_set", { parent_room_id: id, title: "x" })))).toBe("invalid_params");
			// Nobody joins one by themselves, and only a member adds others.
			expect(errorCode(() => store.changeMembership({ userId: "bob", ipKey: "ip-bob", roomId: id, join: true, now: clock.value }))).toBe("invalid_params");
			expect(errorCode(() => add(store, clock, "bob", id, "cy"))).toBe("invalid_params");
		}
		for (const id of [secret, unknown]) {
			expect(errorCode(() => store.mutate(op(clock, "bob", "reactions", { message_id: id, emojis: ["👍"] })))).toBe("invalid_params");
			expect(errorCode(() => post(store, clock, "bob", "general", { reply_to: { message_id: id } }))).toBe("invalid_params");
		}
		// Ada's own edit of it still works; her members' view is the full one.
		expect(post(store, clock, "ada", roomId, { message_id: secret, body: { text: "edited" } }).message?.body).toMatchObject({ text: "edited" });
		expect(store.history({ roomId, userId: "ada" }).messages?.every((message) => message.message_id === secret)).toBe(true);
	});
});

it("lets members add others, who then see the room, and keeps messages from crossing its walls", async () => {
	await withStore("members", (store, clock) => {
		register(store, clock, "ada", "bob", "cy");
		const roomId = create(store, clock, "ada");
		const added = add(store, clock, "ada", roomId, "bob");
		expect(added.changed).toBe(true);
		expect(added.room).toMatchObject({ room_id: roomId, private: true });
		expect(added.rooms).toContain(roomId);
		// Bob is a member now: he posts, reads, and adds Cy in turn.
		const fromBob = String(post(store, clock, "bob", roomId).result.message_id);
		expect(store.history({ roomId, userId: "bob" }).messages?.map((message) => message.message_id)).toContain(fromBob);
		expect(add(store, clock, "bob", roomId, "cy").changed).toBe(true);
		// A private room's messages stay in it, and no other room's come in.
		const outside = String(post(store, clock, "bob", "general").result.message_id);
		expect(errorCode(() => post(store, clock, "bob", "general", { message_id: fromBob }))).toBe("denied");
		expect(errorCode(() => post(store, clock, "bob", roomId, { message_id: outside }))).toBe("denied");
		// A reply to one of its messages stays in it too.
		expect(errorCode(() => post(store, clock, "bob", "general", { reply_to: { message_id: fromBob } }))).toBe("denied");
		expect(post(store, clock, "ada", roomId, { reply_to: { message_id: fromBob } }).message?.reply_to).toEqual({ message_id: fromBob });
	});
});

it("removes a private room once its last member leaves, freeing its slot", async () => {
	await withStore("empty", (store, clock, state) => {
		register(store, clock, "ada", "bob");
		const roomId = create(store, clock, "ada");
		add(store, clock, "ada", roomId, "bob");
		const message = String(post(store, clock, "bob", roomId).result.message_id);
		leave(store, clock, "ada", roomId);
		expect(store.removeEmptyThread(roomId, clock.value)).toBe(false);
		leave(store, clock, "bob", roomId);
		expect(store.removeEmptyThread(roomId, clock.value)).toBe(true);
		expect(store.getRoom(roomId)).toBeNull();
		expect(meta(state, "private_count")).toBe(0);
		// Its messages go with it.
		expect(errorCode(() => store.mutate(op(clock, "bob", "reactions", { message_id: message, emojis: ["👍"] })))).toBe("invalid_params");
	});
});

it("caps the private rooms one user starts, the ones they are in, and the server's", async () => {
	await withStore("caps", (store, clock) => {
		register(store, clock, "ada", "bob", "cy", "dee");
		for (let index = 0; index < 2; index += 1) create(store, clock, "ada");
		expect(errorCode(() => create(store, clock, "ada"))).toBe("denied");
		// Leaving one to someone else still counts against its starter until it goes.
		const first = store.privateRoomsOf("ada")[0].room_id;
		add(store, clock, "ada", first, "bob");
		leave(store, clock, "ada", first);
		expect(errorCode(() => create(store, clock, "ada"))).toBe("denied");
		// Bob is in one; two more fill his three, so nobody can add him to a fourth.
		create(store, clock, "bob");
		create(store, clock, "bob");
		const cyRoom = create(store, clock, "cy");
		expect(errorCode(() => add(store, clock, "cy", cyRoom, "bob"))).toBe("denied");
		expect(errorCode(() => create(store, clock, "bob"))).toBe("denied");
		// The server's ceiling: six rooms exist, and that is all there is room for.
		create(store, clock, "cy");
		expect(errorCode(() => create(store, clock, "dee"))).toBe("denied");
	}, { maxPrivateRooms: 6, maxPrivateRoomsPerUser: 2, maxPrivateMembershipsPerUser: 3 });
});

it("answers a private room's creation as unsupported where private rooms are off", async () => {
	await withStore("off", (store, clock) => {
		register(store, clock, "ada");
		expect(errorCode(() => create(store, clock, "ada"))).toBe("unsupported");
	}, { maxPrivateRooms: 0 });
});

it("removes a private room whose whole log expired, with its members told it left", async () => {
	await withStore("expiry", (store, clock, state) => {
		register(store, clock, "ada", "bob");
		const idle = create(store, clock, "ada");
		add(store, clock, "ada", idle, "bob");
		clock.value += RETENTION_MS / 2;
		const busy = create(store, clock, "ada");
		clock.value += RETENTION_MS / 2 + 60_000;
		post(store, clock, "ada", busy);
		let removed: string[] = [];
		for (let pass = 0; pass < 5; pass += 1) {
			const result = store.runCleanup(clock.value);
			removed = [...removed, ...result.removed_rooms];
			clock.value = Math.max(clock.value, result.next_due_ms) + 1;
		}
		expect(removed).toEqual([idle]);
		expect(store.getRoom(idle)).toBeNull();
		expect(store.getRoom(busy)).not.toBeNull();
		expect(meta(state, "private_count")).toBe(1);
		expect(store.privateRoomsOf("bob")).toEqual([]);
	});
});

it("keeps public scans and a member's listing within their reservations with the private range full", async () => {
	await withStore("costs", (store, clock, state) => {
		register(store, clock, "ada");
		// The ceiling's worth of private rows, Ada in the per-user ceiling's worth of them.
		state.storage.transactionSync(() => {
			for (let index = 0; index < MAX_PRIVATE_ROOM_LIMIT; index += 1) {
				const logId = clock.value + index;
				const roomId = `${PRIVATE_ROOM_PREFIX}${logId}`;
				state.storage.sql.exec(
					`INSERT INTO rooms (room_id, parent_room_id, created_log_id, record_log_id, latest_log_id, fields_json, created_ms, updated_ms)
					 VALUES (?, NULL, ?, ?, ?, '{}', ?, ?)`,
					roomId, logId, logId, logId, clock.value, clock.value,
				);
				if (index < DEFAULT_LIMITS.privateMembershipsPerUser) state.storage.sql.exec("INSERT INTO memberships (room_id, user_id) VALUES (?, ?)", roomId, "ada");
			}
		});
		clock.value += MAX_PRIVATE_ROOM_LIMIT;
		// Each throws past its reservation; none does.
		expect(store.listRooms().map((room) => room.room_id)).toEqual(["general"]);
		expect(store.privateRoomsOf("ada")).toHaveLength(DEFAULT_LIMITS.privateMembershipsPerUser);
		expect(store.listRooms(clock.value, { maintenance: true, withPrivate: true })).toHaveLength(MAX_PRIVATE_ROOM_LIMIT + 1);
		expect(store.mutate(op(clock, "ada", "room_set", { parent_room_id: "general", title: "Side" })).created).toBe(true);
		expect(errorCode(() => create(store, clock, "ada"))).toBe("denied");
		clock.value += RETENTION_MS + 60_000;
		expect(store.runCleanup(clock.value).removed_rooms.length).toBeGreaterThan(0);
	});
});

it("wakes only a private room's members for its messages, and each of them for `private`", async () => {
	await withStore("push", (store, clock) => {
		register(store, clock, "ada", "bob", "cy");
		const roomId = create(store, clock, "ada");
		add(store, clock, "ada", roomId, "bob");
		const keys = { p256dh: "p".repeat(87), auth: "a".repeat(22) };
		store.registerPushSubscription({ userId: "bob", url: "https://push.example.net/bob", ...keys, wake: WAKE_SCOPES.private, now: clock.value });
		store.registerPushSubscription({ userId: "cy", url: "https://push.example.net/cy", ...keys, now: clock.value });
		// Cy is mentioned but not a member: no push. Bob wakes for `private`.
		const claim = store.claimPushes({
			senderId: "ada", roomId,
			candidates: [{ userId: "cy", reasons: WAKE_SCOPES.mentions }, { userId: "bob", reasons: WAKE_SCOPES.private }],
			now: clock.value,
		});
		expect(claim.subscriptions.map((subscription) => subscription.userId)).toEqual(["bob"]);
	}, { push: { ...PUSH_POLICY! } });
});
