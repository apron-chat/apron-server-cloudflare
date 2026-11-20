import { expect, it } from "vitest";
import type { ChatRecord } from "../../src/history/records";
import { RESTORE_RECORDS_BATCH, Store, UNCLAIMED_ROLE, type RoomRecord, type StoreConfig, type StoreMutationInput } from "../../src/store";
import { exportArchive } from "../../src/history/archive/export";
import { type ArchivedRoom, type ArchivedUser, collectArchive, jsonlReader, jsonlWriter, linesOf, writeArchiveToString } from "@apron/archive";
import { importArchive } from "../../src/history/archive/import";
import { MemoryBlobStore } from "./support/memory-blob-store";
import { ColdHistoryTier } from "../../src/history/cold/tier";
import { HISTORY_CODECS, archiveChain } from "../../src/history/config";
import { storeExport, storeRestore } from "../../src/history/store-head";
import { withoutOutputs } from "../../src/history/records";
import { HistoryChain } from "../../src/history/chain";
import { MemoryHead } from "./support/memory-tiers";
import { MemoryChainStateStore } from "./support/memory-tiers";
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
		clock.value = src.records[src.records.length - 1].commit_ms + DAY_MS;
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
		clock.value = src.records[src.records.length - 1].commit_ms + DAY_MS;
		const head = Number(store.logBounds().latest_log_id);
		// Every record is in the tiers below: the room lists as it did, with no history here, but
		// its head only as far as records known here reach (its room record), and the log head stays.
		expect(store.restoreRoom(archived(src.rooms[src.lobby]), [], clock.value)).toEqual({ created: true, stored: 0 });
		expect(store.getRoom(src.lobby, clock.value)).toEqual({ ...src.rooms[src.lobby], latest_log_id: src.rooms[src.lobby].log_id });
		expect(store.listRooms(clock.value).map((room) => room.room_id)).toContain(src.lobby);
		expect(Number(store.logBounds().latest_log_id)).toBe(head);
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

it("keeps a cold tier's chunk index and the backups' schedule in SQLite, within their reservations however many chunks it lists", async () => {
	await withStore("chunk-index", CONFIG, async (store, clock, state) => {
		const overruns = watched(store);
		const index = store.chunkIndex("cold");
		const ref = (first: number, last: number, rooms: string[]) => ({ first, last, key: `history/x/${first}.jsonl`, records: last - first + 1, bytes: 100, rooms, users: ["ada"] });
		await index.update({ put: [ref(10, 20, ["general"]), ref(21, 40, ["general", "lobby"])] });
		expect((await index.list()).map((chunk) => chunk.first).sort()).toEqual([10, 21]);
		// One row a chunk, by tier and first; another tier's chunks are its own.
		expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM history_chunks WHERE tier = 'cold'").one().count).toBe(2);
		await store.chunkIndex("colder").update({ put: [ref(5, 6, ["general"])] });
		expect((await index.list()).length).toBe(2);
		// Removes, then puts, as one change: a chunk cut from 21 to 30 is listed at 30.
		await index.update({ put: [ref(30, 40, ["lobby"])], remove: [21] });
		expect((await index.list()).map((chunk) => [chunk.first, chunk.rooms])).toEqual([[10, ["general"]], [30, ["lobby"]]]);
		expect(JSON.parse(state.storage.sql.exec<{ ref: string }>("SELECT ref FROM history_chunks WHERE tier = 'cold' AND first = 30").one().ref)).toEqual(ref(30, 40, ["lobby"]));
		await index.update({ remove: [10, 30] });
		expect(await index.list()).toEqual([]);

		expect(store.historyMetaNumber("history:export:nightly", clock.value)).toBe(0);
		store.setHistoryMeta("history:export:nightly", "1234", clock.value);
		expect(store.historyMetaNumber("history:export:nightly", clock.value)).toBe(1234);
		store.setHistoryMeta("history:export:nightly", null, clock.value);
		expect(store.historyMetaNumber("history:export:nightly", clock.value)).toBe(0);
		expect(() => store.setHistoryMeta("history:published", "1", clock.value)).toThrow();
		expect(() => store.historyMetaNumber("identity_count", clock.value)).toThrow();

		// However many chunks it lists, the cold tier over it stays within them.
		const chunks = 3_000;
		const many = Array.from({ length: chunks }, (_, i) => ({ first: i * 10 + 1, last: i * 10 + 5, key: `history/x/${i}.jsonl`, records: 1, bytes: 100, rooms: [`r${i % 5}`], users: ["ada"] }));
		for (let i = 0; i < chunks; i += 500) await store.chunkIndex("cold").update({ put: many.slice(i, i + 500) });
		const tier = new ColdHistoryTier({ name: "cold", store: new MemoryBlobStore(), index: store.chunkIndex("cold"), codecs: HISTORY_CODECS, prefix: "history/x/", clock: clock.clock });
		// Keep the newest 100 records (a chunk each): the floor is the 100th newest chunk's first.
		expect(await tier.floorFor({ records: 100, thresholdPercent: 100 }, { now: clock.value, below: Number.MAX_SAFE_INTEGER })).toBe((chunks - 100) * 10 + 1);
		expect(await tier.floorFor({ records: 10_000, thresholdPercent: 100 }, { now: clock.value, below: Number.MAX_SAFE_INTEGER })).toBeUndefined();
		expect((await tier.stats()).records).toBe(chunks);
		expect(await tier.trimBelow(201, 1_000)).toBe(20);
		expect((await store.chunkIndex("cold").list()).length).toBe(chunks - 20);
		// The objects are missing here, so reads find nothing.
		expect(await tier.read({ roomIds: ["r0"], lower: 1, upper: Number.MAX_SAFE_INTEGER, forward: false, limit: 10 })).toEqual([]);
		expect(overruns).toEqual([]);
	});
});

/** A message record of `roomId` as an archive holds it. */
function messageRecord(roomId: string, logId: number, value: Record<string, unknown>): ChatRecord {
	return { room_id: roomId, log_id: logId, commit_ms: logId, kind: "message", record_json: JSON.stringify({ message_id: String(logId), log_id: String(logId), room_id: roomId, from: { user_id: "ada", name: "Ada" }, body: { text: `m${logId}` }, ...value }) };
}

const LIMITS = { retentionRecords: 5_000, retentionSeconds: 0, minRetentionSeconds: 0, historyD1Records: 0, historyColdRecords: 0, cleanupThresholdPercent: 80 };

it("refuses records past the clock, and raises the log head only by records it stores, never by a listing", async () => {
	await withStore("restore-future", CONFIG, (store, clock) => {
		const overruns = watched(store);
		store.restoreUsers([{ user_id: "ada", name: "Ada" }], clock.value);
		const head = Number(store.logBounds().latest_log_id);
		const listing = (extra: Record<string, unknown> = {}) => ({ listing: { room_id: "lobby", log_id: String(clock.value - 5_000), ...extra }, joined: false });
		// A record past the clock and five minutes: refused whole.
		expect(errorCode(() => store.restoreRoom(listing(), [messageRecord("lobby", clock.value + 6 * 60_000, {})], clock.value))).toBe("invalid_params");
		expect(errorCode(() => store.restoreRoom(listing({ log_id: String(Number.MAX_SAFE_INTEGER) }), [], clock.value))).toBe("invalid_params");
		expect(store.getRoom("lobby", clock.value)).toBeNull();
		// A listing's head far in the future counts only as far as the records known here.
		const logId = clock.value - 4_000;
		expect(store.restoreRoom(listing({ latest_log_id: String(Number.MAX_SAFE_INTEGER) }), [messageRecord("lobby", logId, {})], clock.value)).toEqual({ created: true, stored: 1 });
		expect(Number(store.getRoom("lobby", clock.value)!.latest_log_id)).toBe(Math.max(head, logId));
		expect(Number(store.logBounds().latest_log_id)).toBe(Math.max(head, logId));
		// Commits go on as before.
		const posted = store.mutate(input(clock, "ada", "message", { room_id: "lobby", body: { format: "plain", text: "after" } })).message!;
		expect(Number(posted.log_id)).toBeLessThanOrEqual(clock.value);
		expect(overruns).toEqual([]);
	});
});

it("takes a message here for the same one only in a room the import adds, never by the snapshot's say", async () => {
	await withStore("restore-collide", CONFIG, (store, clock, state) => {
		const overruns = watched(store);
		store.createInvitedIdentity({ userId: "ada", name: "Ada", now: clock.value, ipKey: "ip" });
		const native = store.mutate(input(clock, "ada", "message", { room_id: "general", body: { format: "plain", text: "mine" } })).message!;
		const stateOf = (messageId: string) => state.storage.sql.exec<{ room_id: string; latest_log_id: number }>("SELECT room_id, latest_log_id FROM message_state WHERE message_id = ?", messageId).toArray()[0];
		const before = stateOf(native.message_id);
		const base = clock.value - 60_000;
		const room = (roomId: string) => ({ listing: { room_id: roomId, log_id: String(base) }, joined: false });
		// Its ID again, by its author, in a new room claiming to have moved from general: another message.
		const claimed = store.restoreRoom(room("lobby"), [messageRecord("lobby", base + 1, { message_id: native.message_id, prev_room_id: "general" })], clock.value, { rooms: ["lobby"] });
		expect(claimed).toEqual({ created: true, stored: 1, collided: 1 });
		// A snapshot naming a room here the import does not add moves nothing there either.
		expect(store.restoreRoom(room("annex"), [messageRecord("annex", base + 2, { message_id: "m-annex", room_id: "general" })], clock.value, { rooms: ["annex"] })).toMatchObject({ collided: 1 });
		expect(stateOf("m-annex")).toBeUndefined();
		expect(stateOf(native.message_id)).toEqual(before);
		// Between two rooms the import adds, a move is the same message.
		store.restoreRoom(room("hall"), [messageRecord("hall", base + 3, { message_id: "m-move" })], clock.value, { rooms: ["hall", "porch"] });
		expect(store.restoreRoom(room("porch"), [messageRecord("porch", base + 4, { message_id: "m-move", prev_room_id: "hall", prev_log_id: String(base + 3) })], clock.value, { rooms: ["hall", "porch"] })).toEqual({ created: true, stored: 1 });
		expect(stateOf("m-move")).toEqual({ room_id: "porch", latest_log_id: base + 4 });
		expect(overruns).toEqual([]);
	});
});

it("takes a record only as a post would have made it: the Store's content policy, record by record", async () => {
	await withStore("restore-normalize", CONFIG, (store, clock) => {
		const overruns = watched(store);
		const base = clock.value - 60_000;
		const normalized = (value: Record<string, unknown>) => {
			const record = store.content.record(messageRecord("lobby", base, value));
			return record.ok ? JSON.parse(record.value.record_json) : null;
		};
		expect(normalized({ from: { user_id: "ada", name: "Ada", roles: ["admin"], tier: "registered" } }).from).toEqual({ user_id: "ada", name: "Ada" });
		expect(normalized({ body: { text: "hi", embeds: [{ kind: "link", og: { title: "T", image: { url: "https://evil.example/x.png" } } }] } }).body)
			.toEqual({ text: "hi", format: "plain", embeds: [{ kind: "link", og: { title: "T" } }] });
		for (const bad of [
			{ from: { user_id: "~private", name: "Server" } },
			{ body: { text: "x".repeat(300_000) } },
			{ body: { text: "hi", embeds: Array.from({ length: 100 }, () => ({ kind: "link" })) } },
			{ body: { text: "hi", mentions: ["not an id with spaces"] } },
			{ ext: { padding: "x".repeat(200_000) } },
		]) expect(normalized(bad), JSON.stringify(bad).slice(0, 80)).toBeNull();
		const reactions = store.content.record({ room_id: "lobby", log_id: base, commit_ms: base, kind: "reactions", record_json: JSON.stringify({ message_id: "m", reactions: [{ from: { user_id: "bob", roles: ["mod"] }, emojis: ["👍"] }] }) });
		expect(reactions.ok && JSON.parse(reactions.value.record_json).reactions).toEqual([{ from: { user_id: "bob" }, emojis: ["👍"] }]);
		// restoreRoom applies it too: what no client could have sent is dropped and counted.
		const result = store.restoreRoom({ listing: { room_id: "lobby", log_id: String(base) }, joined: false }, [
			messageRecord("lobby", base + 1, { from: { user_id: "ada", roles: ["admin"] } }),
			messageRecord("lobby", base + 2, { from: { user_id: "~private" } }),
		], clock.value);
		expect(result).toEqual({ created: true, stored: 1, rejected: 1 });
		expect(store.historyLookup([base + 1, base + 2]).map((record) => JSON.parse(record.record_json).from)).toEqual([{ user_id: "ada" }]);
		expect(overruns).toEqual([]);
	});
});

it("keeps imported reaction sets and room records only as a post would: one content policy for both", async () => {
	await withStore("restore-content-drift", { ...CONFIG, reactionEmojisPerUser: 3, roomMetadataLimit: 256 }, (store, clock) => {
		const overruns = watched(store);
		const base = clock.value - 60_000;
		const reactions = (logId: number, from: string, emojis: unknown[]): ChatRecord => ({
			room_id: "lobby", log_id: logId, commit_ms: logId, kind: "reactions",
			record_json: JSON.stringify({ message_id: String(base + 1), room_id: "lobby", log_id: String(logId), reactions: [{ from: { user_id: from }, emojis }] }),
		});
		const roomRecord = (logId: number, title: string): ChatRecord => ({
			room_id: "lobby", log_id: logId, commit_ms: logId, kind: "room", record_json: JSON.stringify({ room_id: "lobby", log_id: String(logId), title }),
		});
		const result = store.restoreRoom({ listing: { room_id: "lobby", log_id: String(base) }, joined: false }, [
			messageRecord("lobby", base + 1, { from: { user_id: "ada" } }),
			// Unqualified and repeated: kept qualified and once, as a post keeps them.
			reactions(base + 2, "bob", ["❤", "❤️", "👍", "👍"]),
			// What a post refuses: past the cap, too long, a control character.
			reactions(base + 3, "carol", ["👍", "❤", "🎉", "🚀"]),
			reactions(base + 4, "dan", ["x".repeat(65)]),
			reactions(base + 5, "eve", ["👍\u0007"]),
			// A room record whose fields a room_set would refuse.
			roomRecord(base + 6, "x".repeat(300)),
			roomRecord(base + 7, "Lobby"),
		], clock.value);
		expect(result).toEqual({ created: true, stored: 3, rejected: 4 });
		const sets = store.historyLookup([base + 2]).map((record) => JSON.parse(record.record_json).reactions);
		expect(sets).toEqual([[{ from: { user_id: "bob" }, emojis: ["❤️", "👍"] }]]);
		expect(store.historyLookup([base + 3, base + 4, base + 5, base + 6])).toEqual([]);
		expect(overruns).toEqual([]);
	});
});

it("takes a room with only joins and leaves past its creation as empty, so a fresh server's general is filled (the importing admin joined it)", async () => {
	await withStore("restore-empty-room", CONFIG, (store, clock) => {
		const overruns = watched(store);
		expect(store.roomIsEmpty("general")).toBe(true);
		expect(store.roomIsEmpty("no-such-room")).toBe(false);
		// Signing in joins general: a logged membership, and still empty.
		for (const userId of ["ada", "bob"]) {
			store.registerIdentity({ userId, name: userId, userHandle: `handle-${userId}`, now: clock.value, ipKey: `${userId}-ip`, credential: { credentialId: `cred-${userId}`, userId, publicKey: "AAAA", counter: 0 } });
		}
		const membership = (userId: string, join: boolean) => {
			clock.value += 1_000;
			store.changeMembership({ userId, ipKey: `${userId}-ip`, roomId: "general", join, now: clock.value });
		};
		membership("ada", true);
		membership("bob", true);
		membership("bob", false);
		expect(store.historyLookup([clock.value]).map((record) => record.kind)).toEqual(["membership"]);
		expect(store.roomIsEmpty("general")).toBe(true);
		// A message, or a room record past its creation, puts it in use.
		store.mutate(input(clock, "ada", "message", { room_id: "general", body: { text: "hello" } }));
		expect(store.roomIsEmpty("general")).toBe(false);
		const thread = store.mutate(input(clock, "ada", "room_set", { parent_room_id: "general", title: "Thread" })).result as { room_id: string };
		expect(store.roomIsEmpty(thread.room_id)).toBe(true);
		store.mutate(input(clock, "ada", "room_set", { room_id: thread.room_id, title: "Renamed" }));
		expect(store.roomIsEmpty(thread.room_id)).toBe(false);
		expect(overruns).toEqual([]);
	});
});

it("fills an empty room with the archive's room record in place of its own, so a round trip adds no room record", async () => {
	await withStore("restore-fill-empty", CONFIG, (store, clock, state) => {
		const overruns = watched(store);
		const roomRecords = () => state.storage.sql.exec<{ log_id: number; record_json: string }>("SELECT log_id, record_json FROM records WHERE room_id = 'general' AND kind = 'room' ORDER BY log_id").toArray();
		const [own] = roomRecords();
		expect(store.roomIsEmpty("general")).toBe(true);
		// An archive's general, older than this fresh server's: its room record and a message.
		const base = clock.value - 60_000;
		const archived = { room_id: "general", log_id: String(base), title: "General", description: "Day-to-day chatter." };
		const result = store.restoreRoom({ listing: { ...archived }, joined: false }, [
			{ room_id: "general", log_id: base, commit_ms: base, kind: "room", record_json: JSON.stringify(archived) },
			messageRecord("general", base + 1, {}),
		], clock.value, { rooms: ["general"] });
		expect(result).toMatchObject({ created: false, stored: 2 });
		// The archive's room record is the room's: this server's own, logged after it, is gone.
		expect(roomRecords().map((row) => row.log_id)).toEqual([base]);
		expect(roomRecords()[0].log_id).not.toBe(own.log_id);
		const room = store.getRoom("general", clock.value)!;
		expect(room).toMatchObject({ title: "General", description: "Day-to-day chatter.", log_id: String(base) });
		// Its head is its newest record, not the deleted creation.
		expect(room.latest_log_id).toBe(String(base + 1));
		// Not empty now: a later import into it merges as into any room, keeping its records.
		expect(store.roomIsEmpty("general")).toBe(false);
		expect(overruns).toEqual([]);
	});
});

it("imports through the Store: IDs that cannot stand here become placeholders, and no message is a guest's", async () => {
	await withStore("restore-import", CONFIG, async (store, clock, state) => {
		const base = clock.value - 60_000;
		const text = await writeArchiveToString(async (writer) => {
			await writer.header({ apron_archive: 1, server: "wss://elsewhere.test/" });
			await writer.listing({ not_joined: [{ room_id: "lobby", log_id: String(base), latest_log_id: String(base + 3) }] });
			await writer.records([
				messageRecord("lobby", base + 1, { from: { user_id: "guest_7", name: "Guest" } }),
				messageRecord("lobby", base + 2, { from: { user_id: "bot_ada" } }),
				messageRecord("lobby", base + 3, { from: { user_id: "admin", roles: ["admin"] }, body: { text: "hi", embeds: Array.from({ length: 100 }, () => ({ kind: "link" })) } }),
			]);
		});
		const chain = archiveChain(undefined, { store, limits: LIMITS, clock: clock.clock });
		const report = await importArchive(chain, storeRestore(store), jsonlReader(linesOf(text)), { clock: clock.clock });
		expect(report).toMatchObject({ roomsAdded: ["lobby"], records: 2, rejected: 1, users: { guest_7: { placeholder: "imported-guest_7" }, bot_ada: { placeholder: "imported-bot_ada" } } });
		const authors = state.storage.sql.exec<{ author_id: string }>("SELECT author_id FROM message_state ORDER BY author_id").toArray().map((row) => row.author_id);
		expect(authors).toEqual(["imported-bot_ada", "imported-guest_7"]);
		expect(store.getIdentity("imported-guest_7")?.roles).toEqual([UNCLAIMED_ROLE]);
		// The admin's own ID is never an import's to take, matched or made.
		expect(store.restoreUsers([{ user_id: "admin", name: "Admin" }], clock.value)).toEqual([]);
	});
});

it("exports a room's whole history after a retitle: the listing's creation, not its latest room record, starts it", async () => {
	const exported = await withStore("export-retitle", CONFIG, async (store, clock) => {
		store.createInvitedIdentity({ userId: "ada", name: "Ada", now: clock.value, ipKey: "ip" });
		store.setRole({ userId: "ada", role: "admin", on: true, now: clock.value });
		const lobby = store.mutate(input(clock, "ada", "room_set", { title: "Lobby" })).result.room_id as string;
		for (const text of ["one", "two"]) store.mutate(input(clock, "ada", "message", { room_id: lobby, body: { format: "plain", text } }));
		store.mutate(input(clock, "ada", "room_set", { room_id: lobby, title: "Lobby, renamed" }));
		const lines: string[] = [];
		await exportArchive(archiveChain(undefined, { store, limits: LIMITS, clock: clock.clock }), storeExport(store), jsonlWriter(async (line) => { lines.push(line); }), { clock: clock.clock, roomIds: [lobby], prepare: withoutOutputs });
		return { text: lines.join(""), clock: clock.value };
	});
	const archive = await collectArchive(jsonlReader(linesOf(exported.text)));
	const target = new MemoryHead("hot", { now: () => exported.clock });
	const chain = new HistoryChain({ head: target, headRetention: { thresholdPercent: 100 }, stages: [], state: new MemoryChainStateStore(), clock: { now: () => exported.clock } });
	const report = await importArchive(chain, target, archive, { clock: { now: () => exported.clock }, dryRun: true });
	expect(report.references).toBe(0);
	expect(report.records).toBe(archive.records.length);
	expect(archive.records.filter((record) => record.kind === "message")).toHaveLength(2);
});

it("joins a new room's listed members with no membership record, within its accounts and caps, and exports a room's members in user ID order", async () => {
	await withStore("restore-members", { ...CONFIG, maxPrivateRooms: 10, maxPrivateMembershipsPerUser: 1 }, (store, clock, state) => {
		const overruns = watched(store);
		store.restoreUsers(["ana", "ben", "cy"].map((user_id) => ({ user_id, name: user_id.toUpperCase() })));
		const base = clock.value - 60_000;
		const room = (room_id: string) => ({ listing: { room_id, log_id: String(base) }, joined: false });
		store.restoreRoom(room("lounge"), []);
		const members = (roomId: string) => state.storage.sql.exec<{ user_id: string }>("SELECT user_id FROM memberships WHERE room_id = ? ORDER BY user_id", roomId).toArray().map((row) => row.user_id);
		const count = (roomId: string) => state.storage.sql.exec<{ member_count: number }>("SELECT member_count FROM rooms WHERE room_id = ?", roomId).one().member_count;
		// No account here (ghost) is skipped; a repeat joins nothing more.
		expect(store.restoreMembers("lounge", { join: ["cy", "ana", "ghost"], leave: [] })).toEqual({ joined: 2, left: 0, skipped: 1 });
		expect(store.restoreMembers("lounge", { join: ["cy", "ana"], leave: [] })).toEqual({ joined: 0, left: 0, skipped: 0 });
		expect(members("lounge")).toEqual(["ana", "cy"]);
		// A complete listing that leaves out a member the records joined removes them.
		expect(store.restoreMembers("lounge", { join: ["ben"], leave: ["cy"] })).toEqual({ joined: 1, left: 1, skipped: 0 });
		expect(members("lounge")).toEqual(["ana", "ben"]);
		expect(count("lounge")).toBe(2);
		// No log record is made for them.
		expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM records WHERE room_id = 'lounge' AND kind = 'membership'").one().n).toBe(0);
		// Exported: in user ID order, at most the limit, with the true count.
		expect(store.exportMembers("lounge", 10)).toEqual({ members: ["ana", "ben"], count: 2 });
		expect(store.exportMembers("lounge", 1)).toEqual({ members: ["ana"], count: 2 });
		// A private room's cap per user: past it, skipped.
		store.restoreRoom(room(`private_${base}`), []);
		store.restoreRoom(room(`private_${base + 1}`), []);
		expect(store.restoreMembers(`private_${base}`, { join: ["ana"], leave: [] })).toEqual({ joined: 1, left: 0, skipped: 0 });
		expect(store.restoreMembers(`private_${base + 1}`, { join: ["ana"], leave: [] })).toEqual({ joined: 0, left: 0, skipped: 1 });
		expect(() => store.restoreMembers("no-such-room", { join: ["ana"], leave: [] })).toThrow(/No room/);
		expect(overruns).toEqual([]);
	});
});
