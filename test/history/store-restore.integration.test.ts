import { expect, it } from "vitest";
import type { ArchivedRoom, ArchivedUser } from "../../src/history/archive/types";
import type { ChatRecord } from "../../src/history/records";
import { RESTORE_RECORDS_BATCH, Store, UNCLAIMED_ROLE, type RoomRecord, type StoreConfig, type StoreMutationInput } from "../../src/store";
import { errorCode, withStore, type TestClock } from "../helpers/store";

const DAY_MS = 86_400_000;

const CONFIG: Partial<StoreConfig> = {
	anonymousPostsPerMinute: 1_000, registeredPostsPerMinute: 1_000, trustedPostsPerMinute: 1_000,
	ipPostsPerMinute: 1_000, globalPostsPerMinute: 1_000, registrationsPerIpDay: 1_000, registrationsPerDay: 1_000,
};

/** A store whose every accounting overrun is collected, to assert there were none. */
function watched(store: Store): string[] {
	const overruns: string[] = [];
	store.onAccounting = (change, message) => {
		if (change === "overrun") overruns.push(message ?? "");
	};
	return overruns;
}

function input(clock: TestClock, userId: string, method: string, params: Record<string, unknown>): StoreMutationInput {
	clock.value += 1_000;
	return { userId, ipKey: `${userId}-ip`, method, now: clock.value, params, identity: { user_id: userId, name: userId.toUpperCase() } };
}

const ARCHIVED_USERS: ArchivedUser[] = [
	{ user_id: "ada", name: "Ada", roles: ["admin"], avatar: "https://cdn.example/ada.png", ext: { pronouns: "she/her", permissions: { admin: true } } },
	{ user_id: "bob", name: "Bob", roles: ["mod"], ext: { long: "x".repeat(2_000) } },
	{ user_id: "carol", avatar: "javascript:alert(1)" },
];

interface Source {
	lobby: string;
	thread: string;
	secret: string;
	m1: string;
	m2: string;
	records: ChatRecord[];
	rooms: Record<string, RoomRecord>;
	pages: Record<string, unknown>;
	members: Record<string, string[]>;
}

/**
 * A room built by commits on another server, its thread, and what that
 * server shows of them: messages (one edited, one deleted), reactions (one
 * set removed), joins and a leave, and a room edit.
 */
async function source(): Promise<Source> {
	return withStore("restore-source", CONFIG, (store, clock) => {
		// Past the target's own `general`, created later in real time.
		clock.value += DAY_MS;
		for (const userId of ["ada", "bob", "carol"]) store.createInvitedIdentity({ userId, name: userId.toUpperCase(), now: (clock.value += 1_000), ipKey: "ip" });
		store.setRole({ userId: "ada", role: "admin", on: true, now: clock.value });
		const lobby = store.mutate(input(clock, "ada", "room_set", { title: "Lobby", description: "Plans" })).result.room_id as string;
		store.changeMembership({ userId: "bob", ipKey: "bob-ip", roomId: lobby, join: true, now: (clock.value += 1_000) });
		store.changeMembership({ userId: "carol", ipKey: "carol-ip", roomId: lobby, join: true, now: (clock.value += 1_000) });
		const m1 = store.mutate(input(clock, "ada", "message", { room_id: lobby, body: { format: "plain", text: "hello" } })).message!.message_id;
		const m2 = store.mutate(input(clock, "bob", "message", { room_id: lobby, body: { format: "plain", text: "hi" }, reply_to: { message_id: m1 } })).message!.message_id;
		store.mutate(input(clock, "ada", "message", { room_id: lobby, message_id: m1, body: { format: "plain", text: "hello, all" } }));
		store.mutate(input(clock, "bob", "message", { room_id: lobby, message_id: m2, deleted: true }));
		store.mutate(input(clock, "bob", "reactions", { message_id: m1, emojis: ["👍"] }));
		store.mutate(input(clock, "carol", "reactions", { message_id: m1, emojis: ["🎉"] }));
		store.mutate(input(clock, "carol", "reactions", { message_id: m1, emojis: [] }));
		store.mutate(input(clock, "ada", "room_set", { room_id: lobby, title: "Lobby 2", description: "Plans" }));
		store.changeMembership({ userId: "carol", ipKey: "carol-ip", roomId: lobby, join: false, now: (clock.value += 1_000) });
		const thread = store.mutate(input(clock, "bob", "room_set", { parent_room_id: lobby, title: "Side" })).result.room_id as string;
		store.mutate(input(clock, "bob", "message", { room_id: thread, body: { format: "plain", text: "aside" } }));
		const secret = store.mutate(input(clock, "ada", "room_set", { private: true, title: "Secret" })).result.room_id as string;
		store.changeMembership({ userId: "bob", ipKey: "ada-ip", roomId: secret, join: true, now: (clock.value += 1_000), actorId: "ada" });
		store.mutate(input(clock, "bob", "message", { room_id: secret, body: { format: "plain", text: "psst" } }));
		const restored = [lobby, thread, secret];
		const records = store.historyScan(1, 100, clock.value).filter((record) => restored.includes(record.room_id));
		const view = (roomId: string) => store.history({ roomId, after: 0n, limit: 100, now: clock.value });
		const members = store.roomMembers(restored, 10, clock.value);
		return {
			lobby, thread, secret, m1, m2, records,
			rooms: Object.fromEntries(restored.map((roomId) => [roomId, store.getRoom(roomId, clock.value)!])),
			pages: Object.fromEntries(restored.map((roomId) => [roomId, view(roomId)])),
			members: Object.fromEntries(restored.map((roomId) => [roomId, (members.get(roomId) ?? []).map((member) => member.user_id)])),
		};
	});
}

/** The archive's room: its listing as the source lists it. */
function archived(room: RoomRecord): ArchivedRoom {
	return { listing: { ...room } as unknown as ArchivedRoom["listing"], joined: false };
}

function identity(state: DurableObjectState, userId: string) {
	return state.storage.sql.exec<{ name: string; roles_json: string; avatar_url: string; ext_json: string }>(
		"SELECT name, roles_json, avatar_url, ext_json FROM identities WHERE user_id = ?", userId,
	).toArray()[0];
}

function identityCount(state: DurableObjectState): number {
	return Number(state.storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'identity_count'").one().value);
}

it("restores users as unclaimed placeholders, skipping existing, retired and unissuable IDs, all or nothing against the cap", async () => {
	await withStore("restore-users", { ...CONFIG, registeredIdentityCount: 5 }, (store, clock, state) => {
		const overruns = watched(store);
		store.createInvitedIdentity({ userId: "dan", name: "Dan", now: clock.value, ipKey: "ip" });
		state.storage.sql.exec("INSERT INTO _meta (key, value) VALUES ('purged:gone', '5'), ('renamed:moved', 'elsewhere')");
		expect(store.isRetiredUserId("gone")).toBe(true);
		expect(store.isRetiredUserId("moved")).toBe(true);
		expect(store.isRetiredUserId("dan")).toBe(false);
		expect(store.isRetiredUserId("ada")).toBe(false);

		const created = store.restoreUsers([
			...ARCHIVED_USERS,
			{ user_id: "dan", name: "Not Dan", roles: ["admin"] },
			{ user_id: "gone", name: "Gone" },
			{ user_id: "moved" },
			{ user_id: "guest_7", name: "Guest" },
			{ user_id: "bot_ada", name: "Ada's bot" },
			{ user_id: "ada", name: "Ada again" },
		], clock.value);
		expect(created).toEqual(["ada", "bob", "carol"]);
		expect(identity(state, "ada")).toEqual({ name: "Ada", roles_json: JSON.stringify([UNCLAIMED_ROLE]), avatar_url: "https://cdn.example/ada.png", ext_json: JSON.stringify({ pronouns: "she/her" }) });
		// An ext too large for a `me` write is dropped; a name missing falls back to the ID; an avatar must be https.
		expect(identity(state, "bob")).toEqual({ name: "Bob", roles_json: '["unclaimed"]', avatar_url: "", ext_json: "" });
		expect(identity(state, "carol")).toEqual({ name: "carol", roles_json: '["unclaimed"]', avatar_url: "", ext_json: "" });
		expect(identity(state, "dan")).toMatchObject({ name: "Dan", roles_json: "[]" });
		for (const userId of ["gone", "moved", "guest_7", "bot_ada"]) expect(identity(state, userId)).toBeUndefined();
		expect(identityCount(state)).toBe(4);
		// Listed as members would be: the avatar is live, the role shows.
		expect(store.getIdentity("ada")).toMatchObject({ roles: [UNCLAIMED_ROLE] });

		// Twice more would pass the cap of 5: refused before anything is written.
		expect(errorCode(() => store.restoreUsers([{ user_id: "erin" }, { user_id: "fay" }], clock.value))).toBe("denied");
		expect(identity(state, "erin")).toBeUndefined();
		expect(identityCount(state)).toBe(4);
		// Existing users cost nothing against it: a retry creates only what is new.
		expect(store.restoreUsers([...ARCHIVED_USERS, { user_id: "erin" }], clock.value)).toEqual(["erin"]);
		expect(identityCount(state)).toBe(5);
		expect(overruns).toEqual([]);
	});
});

it("restores a room and its thread from another server's records, with the history and current state commits would leave", async () => {
	const src = await source();
	const lobbyRecords = src.records.filter((record) => record.room_id === src.lobby);
	const threadRecords = src.records.filter((record) => record.room_id === src.thread);
	expect(lobbyRecords.map((record) => record.kind)).toEqual(expect.arrayContaining(["room", "message", "reactions", "membership"]));
	await withStore("restore-room", CONFIG, (store, clock, state) => {
		const overruns = watched(store);
		clock.value = src.records[src.records.length - 1].commit_ms + DAY_MS;
		store.restoreUsers(ARCHIVED_USERS, clock.value);

		// A thread before its parent is refused, writing nothing.
		expect(errorCode(() => store.restoreRoom(archived(src.rooms[src.thread]), threadRecords, clock.value))).toBe("invalid_params");
		expect(store.getRoom(src.thread, clock.value)).toBeNull();

		// The room over two calls: the first creates it, the second extends it.
		const half = Math.floor(lobbyRecords.length / 2);
		expect(store.restoreRoom(archived(src.rooms[src.lobby]), lobbyRecords.slice(0, half), clock.value)).toEqual({ created: true, stored: half });
		expect(store.restoreRoom(archived(src.rooms[src.lobby]), lobbyRecords.slice(half), clock.value)).toEqual({ created: false, stored: lobbyRecords.length - half });
		expect(store.restoreRoom(archived(src.rooms[src.thread]), threadRecords, clock.value)).toEqual({ created: true, stored: threadRecords.length });
		const secretRecords = src.records.filter((record) => record.room_id === src.secret);
		expect(store.restoreRoom(archived(src.rooms[src.secret]), secretRecords, clock.value)).toEqual({ created: true, stored: secretRecords.length });
		// Repeated, a call stores and changes nothing.
		expect(store.restoreRoom(archived(src.rooms[src.lobby]), lobbyRecords, clock.value)).toEqual({ created: false, stored: 0 });

		// What the source showed: the rooms, their history, their members.
		for (const roomId of [src.lobby, src.thread, src.secret]) {
			expect(store.getRoom(roomId, clock.value)).toEqual(src.rooms[roomId]);
			expect(store.history({ roomId, after: 0n, limit: 100, now: clock.value })).toEqual(src.pages[roomId]);
			expect((store.roomMembers([roomId], 10, clock.value).get(roomId) ?? []).map((member) => member.user_id)).toEqual(src.members[roomId]);
		}
		expect(src.members[src.lobby]).toEqual(["ada", "bob"]);
		expect(src.members[src.secret]).toEqual(["ada", "bob"]);
		expect(store.getRoom(src.secret, clock.value)!.private).toBe(true);
		expect(store.listRooms(clock.value).map((room) => room.room_id)).toEqual(["general", src.lobby, src.thread]);
		expect(store.privateRoomsOf("bob", clock.value).map((room) => room.room_id)).toEqual([src.secret]);
		const sql = state.storage.sql;
		expect(sql.exec<{ count: number }>("SELECT member_count AS count FROM rooms WHERE room_id = ?", src.lobby).one().count).toBe(2);
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'thread_count'").one().value).toBe("2");
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'private_count'").one().value).toBe("1");
		expect(sql.exec<{ user_id: string; emojis_json: string }>("SELECT user_id, emojis_json FROM reaction_state WHERE message_id = ?", src.m1).toArray())
			.toEqual([{ user_id: "bob", emojis_json: '["👍"]' }]);
		// The log head is past every restored record.
		const restoredHead = Math.max(...src.records.map((record) => record.log_id));
		expect(Number(store.logBounds().latest_log_id)).toBe(restoredHead);

		// Current state works as with native messages: an unchanged set logs
		// nothing, a new one does, an edit takes a new log ID past the head,
		// and the deleted message is a tombstone.
		const at = (userId: string, method: string, params: Record<string, unknown>) => input(clock, userId, method, params);
		expect(store.mutate(at("bob", "reactions", { message_id: src.m1, emojis: ["👍"] })).broadcasts).toEqual([]);
		expect(store.mutate(at("carol", "reactions", { message_id: src.m1, emojis: ["❤️"] })).broadcasts).toHaveLength(1);
		const edited = store.mutate(at("ada", "message", { room_id: src.lobby, message_id: src.m1, body: { format: "plain", text: "hello again" } })).message!;
		expect(Number(edited.log_id)).toBeGreaterThan(restoredHead);
		expect(edited.prev_log_id).toBe(src.records.filter((record) => record.kind === "message" && JSON.parse(record.record_json).message_id === src.m1).at(-1)!.log_id.toString());
		expect(errorCode(() => store.mutate(at("carol", "reactions", { message_id: src.m2, emojis: ["👍"] })))).toBe("denied");
		expect(errorCode(() => store.mutate(at("carol", "message", { room_id: src.lobby, message_id: src.m1, body: { format: "plain", text: "mine" } })))).toBe("denied");
		// Only a private room's members see it.
		expect(errorCode(() => store.mutate(input(clock, "carol", "message", { room_id: src.secret, body: { format: "plain", text: "let me in" } })))).toBe("invalid_params");
		expect(store.mutate(input(clock, "bob", "message", { room_id: src.secret, body: { format: "plain", text: "still here" } })).message).toBeDefined();
		// A placeholder leaves like anyone.
		expect(store.changeMembership({ userId: "bob", ipKey: "bob-ip", roomId: src.lobby, join: false, now: (clock.value += 1_000) }).changed).toBe(true);
		expect(store.getRoom(src.lobby, clock.value)!.latest_log_id).not.toBe(src.rooms[src.lobby].latest_log_id);
		expect(overruns).toEqual([]);
	});
});

it("rebuilds the same state from a room's records sent newest batch first", async () => {
	const src = await source();
	const lobbyRecords = src.records.filter((record) => record.room_id === src.lobby);
	await withStore("restore-reversed", CONFIG, (store, clock, state) => {
		const overruns = watched(store);
		store.restoreUsers(ARCHIVED_USERS, clock.value);
		const third = Math.ceil(lobbyRecords.length / 3);
		for (const start of [2 * third, third, 0]) store.restoreRoom(archived(src.rooms[src.lobby]), lobbyRecords.slice(start, start + third), clock.value);
		expect(store.getRoom(src.lobby, clock.value)).toEqual(src.rooms[src.lobby]);
		expect(store.history({ roomId: src.lobby, after: 0n, limit: 100, now: clock.value })).toEqual(src.pages[src.lobby]);
		expect((store.roomMembers([src.lobby], 10, clock.value).get(src.lobby) ?? []).map((member) => member.user_id)).toEqual(["ada", "bob"]);
		const sql = state.storage.sql;
		expect(sql.exec<{ user_id: string }>("SELECT user_id FROM reaction_state WHERE message_id = ?", src.m1).toArray()).toEqual([{ user_id: "bob" }]);
		const latest = (messageId: string) => sql.exec<{ latest_log_id: number }>("SELECT latest_log_id FROM message_state WHERE message_id = ?", messageId).one().latest_log_id;
		const snapshots = (messageId: string) => lobbyRecords.filter((record) => record.kind === "message" && JSON.parse(record.record_json).message_id === messageId);
		expect(latest(src.m1)).toBe(snapshots(src.m1).at(-1)!.log_id);
		expect(latest(src.m2)).toBe(snapshots(src.m2).at(-1)!.log_id);
		expect(sql.exec<{ count: number }>("SELECT member_count AS count FROM rooms WHERE room_id = ?", src.lobby).one().count).toBe(2);
		expect(overruns).toEqual([]);
	});
});

it("makes a room from its listing alone, and refuses records below the hot floor, a full batch's excess, and a room past the caps", async () => {
	const src = await source();
	const lobbyRecords = src.records.filter((record) => record.room_id === src.lobby);
	await withStore("restore-listing", { ...CONFIG, maxThreads: 1 }, (store, clock, state) => {
		const overruns = watched(store);
		// Every record is in the tiers below: the room lists as it did, with no history here.
		expect(store.restoreRoom(archived(src.rooms[src.lobby]), [], clock.value)).toEqual({ created: true, stored: 0 });
		expect(store.getRoom(src.lobby, clock.value)).toEqual(src.rooms[src.lobby]);
		expect(store.listRooms(clock.value).map((room) => room.room_id)).toContain(src.lobby);
		expect(Number(store.logBounds().latest_log_id)).toBe(Number(src.rooms[src.lobby].latest_log_id));
		// One public room past general is the cap here.
		expect(errorCode(() => store.restoreRoom(archived(src.rooms[src.thread]), [], clock.value))).toBe("denied");
		expect(store.getRoom(src.thread, clock.value)).toBeNull();
		// Too many records a call.
		const many = Array.from({ length: RESTORE_RECORDS_BATCH + 1 }, (_, index) => ({ ...lobbyRecords[0], log_id: lobbyRecords[0].log_id + index }));
		expect(errorCode(() => store.restoreRoom(archived(src.rooms[src.lobby]), many, clock.value))).toBe("invalid_params");

		// Below the hot floor: refused whole, nothing stored.
		state.storage.sql.exec("UPDATE log_state SET history_floor = ? WHERE id = 1", lobbyRecords[2].log_id);
		const reopened = new Store(state, { ...CONFIG, maxThreads: 1 }, clock.clock);
		reopened.initialize();
		const reopenedOverruns = watched(reopened);
		expect(errorCode(() => reopened.restoreRoom(archived(src.rooms[src.lobby]), lobbyRecords, clock.value))).toBe("invalid_params");
		expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM records WHERE room_id = ?", src.lobby).one().count).toBe(0);
		// Those at or above it are taken.
		expect(reopened.restoreRoom(archived(src.rooms[src.lobby]), lobbyRecords.slice(2), clock.value)).toEqual({ created: false, stored: lobbyRecords.length - 2 });
		expect(overruns).toEqual([]);
		expect(reopenedOverruns).toEqual([]);
	});
});

it("never lets the idle prune remove an unclaimed placeholder, until the claim takes the role away", async () => {
	await withStore("restore-idle", { ...CONFIG, idleAccountMs: 30 * DAY_MS, keptActiveAccounts: 1 }, (store, clock, state) => {
		const overruns = watched(store);
		const sql = state.storage.sql;
		sql.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('idle_activity_since', ?)", String(clock.value - 365 * DAY_MS));
		expect(store.restoreUsers(ARCHIVED_USERS, clock.value)).toEqual(["ada", "bob", "carol"]);
		store.createInvitedIdentity({ userId: "modder", name: "Modder", now: clock.value, ipKey: "ip" });
		store.setRole({ userId: "modder", role: "mod", on: true, now: clock.value });
		store.createInvitedIdentity({ userId: "plain", name: "Plain", now: clock.value, ipKey: "ip" });

		// Well past the idle cutoff: only the account with no role goes.
		clock.value += 60 * DAY_MS;
		store.createInvitedIdentity({ userId: "recent", name: "Recent", now: clock.value, ipKey: "ip" });
		expect(store.pruneIdleIdentities(clock.value).pruned).toEqual(["plain"]);
		const retired = () => sql.exec<{ key: string }>("SELECT key FROM _meta WHERE key LIKE 'purged:%'").toArray().map((row) => row.key);
		expect(retired()).toEqual(["purged:plain"]);
		for (const userId of ["ada", "bob", "carol", "modder"]) expect(identity(state, userId)).toBeDefined();

		// The claim takes the role away: ada is an ordinary account again, idle once the cutoff passes.
		expect(store.setRole({ userId: "ada", role: UNCLAIMED_ROLE, on: false, now: clock.value }).roles).toEqual([]);
		clock.value += 31 * DAY_MS;
		store.createInvitedIdentity({ userId: "newest", name: "Newest", now: clock.value, ipKey: "ip" });
		expect(new Set(store.pruneIdleIdentities(clock.value).pruned)).toEqual(new Set(["ada", "recent"]));
		expect(identity(state, "ada")).toBeUndefined();
		for (const userId of ["bob", "carol", "modder", "newest"]) expect(identity(state, userId)).toBeDefined();
		expect(overruns).toEqual([]);
	});
});

it("keeps a blob tier's segment index and the backups' schedule in SQLite, within their reservations", async () => {
	await withStore("segment-index", CONFIG, async (store, clock, state) => {
		const overruns = watched(store);
		const index = store.segmentIndex("Cold-1");
		expect(store.segmentIndex("Cold-1")).toBe(index);
		const ref = (roomId: string, first: number, last: number) => ({ roomId, first, last, key: `${roomId}/${first}-${last}`, records: last - first + 1, bytes: 100 });
		await index.add([ref("general", 10, 20), ref("lobby", 15, 30), ref("general", 21, 40)]);
		expect(state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'history_segments%'").toArray()).toEqual([{ name: "history_segments__old_1" }]);
		expect((await index.find(["general"], 18, 25)).map((segment) => segment.first)).toEqual([10, 21]);
		expect((await index.after(0, 2)).map((segment) => segment.first)).toEqual([10, 15]);
		expect((await index.oldest(1))[0].last).toBe(20);
		expect(await index.rooms()).toEqual(["general", "lobby"]);
		await index.remove([ref("lobby", 15, 30)]);
		expect(await index.forRoom("lobby")).toEqual([]);
		await index.clear();
		expect(await index.overlapping(0, 100)).toEqual([]);

		expect(store.historyMetaNumber("history:export:nightly", clock.value)).toBe(0);
		store.setHistoryMeta("history:export:nightly", "1234", clock.value);
		expect(store.historyMetaNumber("history:export:nightly", clock.value)).toBe(1234);
		store.setHistoryMeta("history:export:nightly", null, clock.value);
		expect(store.historyMetaNumber("history:export:nightly", clock.value)).toBe(0);
		expect(() => store.setHistoryMeta("history:published", "1", clock.value)).toThrow();
		expect(() => store.historyMetaNumber("identity_count", clock.value)).toThrow();
		expect(overruns).toEqual([]);
	});
});
