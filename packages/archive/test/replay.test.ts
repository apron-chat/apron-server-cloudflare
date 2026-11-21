import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type ArchivedRoom, type ChatRecord, collectArchive, compareReplayed, jsonlReader, linesOf, type RecordKind, replayRecords } from "../src/index.ts";
import { sceneArchives } from "./fixtures/scenes/index.ts";

/** A stored record; `storedIn` is the room the row is in, for a move's copy in its source room. */
function record(kind: RecordKind, roomId: string, logId: number, fields: Record<string, unknown> = {}, storedIn = roomId): ChatRecord {
	return { room_id: storedIn, log_id: logId, commit_ms: logId, kind, record_json: JSON.stringify({ room_id: roomId, log_id: String(logId), ...fields }) };
}

const ada = { user_id: "ada", name: "Ada" };
const bob = { user_id: "bob", name: "Bob" };
const carol = { user_id: "carol", name: "Carol" };

const message = (roomId: string, logId: number, messageId: number, fields: Record<string, unknown> = {}, storedIn = roomId) =>
	record("message", roomId, logId, { message_id: String(messageId), from: ada, ...fields }, storedIn);
const reactions = (roomId: string, logId: number, messageId: number, sets: Array<[typeof ada, string[]]>) =>
	record("reactions", roomId, logId, { message_id: String(messageId), reactions: sets.map(([from, emojis]) => ({ from, emojis })) });
const membership = (roomId: string, logId: number, members: Array<[typeof ada, boolean]>) =>
	record("membership", roomId, logId, { members: members.map(([user, joined]) => ({ user, joined })) });

/** A small log with every kind of change: edits, a delete, a move, reactions set and cleared, joins and leaves. */
const log: ChatRecord[] = [
	record("room", "general", 100, { title: "General" }),
	record("room", "thread", 101, { title: "Thread", parent_room_id: "general" }),
	membership("general", 102, [[ada, true]]),
	membership("general", 103, [[bob, true]]),
	message("general", 110, 110, { body: { text: "first" } }),
	message("general", 111, 111, { from: bob, body: { text: "second" }, reply_to: { message_id: "110" } }),
	message("general", 112, 110, { prev_log_id: "110", body: { text: "first, edited" } }),
	reactions("general", 113, 110, [[bob, ["👍"]]]),
	reactions("general", 114, 110, [[carol, ["🎉", "👍"]]]),
	reactions("general", 115, 110, [[bob, []]]),
	reactions("general", 116, 111, [[ada, ["❤️"]]]),
	// Bob's message moves to the thread: one snapshot, logged in both rooms.
	message("thread", 120, 111, { from: bob, prev_log_id: "111", prev_room_id: "general", body: { text: "second" }, reply_to: { message_id: "110" } }, "general"),
	message("thread", 120, 111, { from: bob, prev_log_id: "111", prev_room_id: "general", body: { text: "second" }, reply_to: { message_id: "110" } }),
	reactions("thread", 121, 111, [[ada, ["❤️"]]]),
	message("general", 130, 130, { body: { text: "oops" } }),
	reactions("general", 131, 130, [[bob, ["😮"]]]),
	message("general", 132, 130, { prev_log_id: "130", deleted: true }),
	membership("general", 140, [[bob, false]]),
	membership("thread", 141, [[ada, true], [bob, true]]),
	record("room", "general", 150, { title: "General (ops)", prev_log_id: "100", ext: { topic: "deploys" } }),
	membership("general", 151, [[carol, true]]),
];

describe("replayRecords", () => {
	const state = replayRecords(log);

	it("keeps the latest room record (without delivery fields) and snapshot (edits, moves and tombstones), and replays reactions and memberships per user", () => {
		expect(state.rooms.get("general")).toMatchObject({ room_id: "general", log_id: 150, fields: { title: "General (ops)", ext: { topic: "deploys" } } });
		expect(state.rooms.get("thread")?.fields).toEqual({ title: "Thread", parent_room_id: "general" });
		expect(state.messages.get("110")).toMatchObject({ room_id: "general", log_id: 112, body: { text: "first, edited" }, deleted: false });
		expect(state.messages.get("111")).toMatchObject({ room_id: "thread", from: { user_id: "bob" }, reply_to: "110", log_id: 120 });
		expect(state.messages.get("130")?.value).toEqual(JSON.parse(log.find((r) => r.log_id === 132)!.record_json));
		expect(state.messages.get("130")).toMatchObject({ message_id: "130", room_id: "general", log_id: 132, from: ada, deleted: true });
		// Cleared sets and a deleted message's are dropped.
		expect(state.reactions.get("110")).toEqual(new Map([["carol", ["🎉", "👍"]]]));
		expect(state.reactions.get("111")).toEqual(new Map([["ada", ["❤️"]]]));
		expect(state.reactions.has("130")).toBe(false);
		expect(state.members.get("general")).toEqual(new Set(["ada", "carol"]));
		expect(state.members.get("thread")).toEqual(new Set(["ada", "bob"]));
	});

	it("keeps every user's latest set and membership change as logged, for a writer of state", () => {
		// Bob's cleared set stays, as does the set on the deleted message.
		expect(state.reactionSets.get("110")?.get("bob")).toEqual({ log_id: 115, from: bob, emojis: [] });
		expect(state.reactionSets.get("130")?.get("bob")).toEqual({ log_id: 131, from: bob, emojis: ["😮"] });
		expect(state.reactionSets.get("111")?.get("ada")?.log_id).toBe(121);
		expect(state.memberships.get("general")?.get("bob")).toEqual({ log_id: 140, user: bob, joined: false });
		expect([...state.memberships.get("general")!.keys()]).toEqual(["ada", "bob", "carol"]);
	});

	it("orders by the record's log_id, not its wire spelling, a tombstone winning at an equal log ID in either order", () => {
		const first = message("general", 7, 7, { body: { text: "first" } });
		const edit = { ...message("general", 8, 7, { body: { text: "edit" } }), record_json: JSON.stringify({ room_id: "general", log_id: "1", message_id: "7", from: ada, body: { text: "edit" } }) };
		expect(replayRecords([edit, first]).messages.get("7")).toMatchObject({ log_id: 8, body: { text: "edit" } });
		const live = message("general", 5, 5, { body: { text: "x" } });
		const tomb = message("general", 5, 5, { deleted: true });
		expect(replayRecords([live, tomb]).messages.get("5")?.deleted).toBe(true);
		expect(replayRecords([tomb, live]).messages.get("5")?.deleted).toBe(true);
	});

	it("does not depend on record order or duplicates (property)", () => {
		// Any order of the log, with any of its records repeated anywhere.
		const reordered = fc.tuple(fc.shuffledSubarray(log, { minLength: log.length }), fc.array(fc.constantFrom(...log), { maxLength: 12 }))
			.chain(([all, repeats]) => fc.shuffledSubarray([...all, ...repeats], { minLength: all.length + repeats.length }));
		fc.assert(fc.property(reordered, (records) => {
			expect(compareReplayed(replayRecords(records), state)).toEqual({ equal: true, differences: [] });
		}), { numRuns: 200 });
	});

	it("starts members from a listing, as of its latest_log_id", () => {
		const listings: ArchivedRoom[] = [
			{ joined: true, listing: { room_id: "general", log_id: "100", title: "Old", latest_log_id: "145", members: [{ user_id: "ada" }, { user_id: "dave" }] } },
			{ joined: false, listing: { room_id: "lobby", log_id: "90", title: "Lobby", latest_log_id: "90", history_log_id: null } },
		];
		const withListings = replayRecords(log, listings, [ada, { ...bob, roles: ["admin"] }, { user_id: "ada", name: "Ada L." }]);
		// Carol's join at 151 comes after the listing; bob's leave at 140 does not.
		expect(withListings.members.get("general")).toEqual(new Set(["ada", "dave", "carol"]));
		// The room record at 150 is newer than the listing's log_id; the lobby has only its listing.
		expect(withListings.rooms.get("general")?.fields.title).toBe("General (ops)");
		expect(withListings.rooms.get("lobby")).toMatchObject({ room_id: "lobby", log_id: 90, fields: { title: "Lobby" } });
		// A later object of a user replaces an earlier one.
		expect(withListings.users.get("ada")?.name).toBe("Ada L.");
	});

	it("skips records that do not parse or lack their keys", () => {
		const broken: ChatRecord[] = [
			{ room_id: "general", log_id: 1, commit_ms: 1, kind: "message", record_json: "{" },
			record("message", "general", 2, { body: { text: "transient" } }),
			record("reactions", "general", 3, { message_id: "1" }),
			record("membership", "general", 4, {}),
		];
		const empty = replayRecords(broken);
		expect([empty.messages.size, empty.reactions.size, empty.members.size]).toEqual([0, 0, 0]);
	});
});

describe("compareReplayed", () => {
	it("reports readable differences", () => {
		const changed: ChatRecord[] = [
			...log.filter((entry) => !(entry.kind === "message" && entry.log_id === 112) && !(entry.kind === "membership" && entry.log_id === 151)),
			message("general", 112, 110, { prev_log_id: "110", body: { text: "first, edited differently" } }),
			reactions("general", 160, 111, [[ada, ["❤"]], [bob, ["🙂"]]]),
			record("room", "general", 161, { title: "Renamed" }),
			membership("general", 162, [[bob, true]]),
			message("general", 170, 170, { body: { text: "new" } }),
		];
		const result = compareReplayed(replayRecords(log, [], [ada, bob]), replayRecords(changed, [], [{ ...ada, name: "Ada L." }]));
		expect(result.equal).toBe(false);
		expect(result.differences).toEqual([
			"room general: ext differs: a {\"topic\":\"deploys\"}, b (none)",
			"room general: title differs: a \"General (ops)\", b \"Renamed\"",
			"message 110 in general: body differs: a {\"text\":\"first, edited\"}, b {\"text\":\"first, edited differently\"}",
			"message 170 in general: only in b",
			"reactions on 111: bob's set only in b: [\"🙂\"]",
			"members of general: only in a: carol; only in b: bob",
			"user ada: name differs: a \"Ada\", b \"Ada L.\"",
			"user bob: only in a",
		]);
	});

	it("reports a moved message's room, author and deletion", () => {
		const a = replayRecords([message("general", 1, 1, { body: { text: "x" } })]);
		const b = replayRecords([message("thread", 2, 1, { from: bob, deleted: true })]);
		expect(compareReplayed(a, b).differences).toEqual([
			"message 1 in thread: room differs: a general, b thread",
			"message 1 in thread: from differs: a ada, b bob",
			"message 1 in thread: deleted differs: a false, b true",
			"message 1 in thread: body differs: a {\"text\":\"x\"}, b (none)",
		]);
	});

	it("ignores log IDs, names as logged, roles and emoji variation selectors", () => {
		const a = replayRecords([
			record("room", "general", 1, { title: "G", latest_log_id: "9", history_log_id: "1" }),
			message("general", 2, 2, { from: ada, body: { text: "x" } }),
			reactions("general", 3, 2, [[bob, ["❤️", "👍"]]]),
		], [], [{ ...ada, roles: ["admin"] }]);
		const b = replayRecords([
			record("room", "general", 5, { title: "G", prev_log_id: "1" }),
			message("general", 2, 2, { from: { user_id: "ada", name: "Someone else" }, body: { text: "x" } }),
			message("general", 7, 2, { prev_log_id: "2", from: ada, body: { text: "x" } }),
			reactions("general", 8, 2, [[bob, ["👍", "❤", "👍"]]]),
		], [], [{ ...ada, roles: ["unclaimed"] }]);
		expect(compareReplayed(a, b)).toEqual({ equal: true, differences: [] });
	});

	it("compares through an idMap applied to the 'a' side", () => {
		const source: ChatRecord[] = [
			record("room", "general", 100, { title: "General" }),
			record("room", "100", 100, { title: "Thread", parent_room_id: "general" }, "100"),
			record("room", "private_101", 101, { title: "Private", private: true }),
			message("100", 110, 110, { body: { text: "hi @ada", mentions: ["ada"] }, ext: { editors: { edited_by: "bob" } } }),
			message("private_101", 111, 111, { from: bob, body: { text: "re" }, reply_to: { message_id: "110" } }),
			reactions("100", 112, 110, [[bob, ["👍"]]]),
			membership("private_101", 113, [[ada, true], [bob, true]]),
		];
		const logIds: Record<string, string> = { "100": "200", "101": "201", "110": "210", "111": "211" };
		const userIds: Record<string, string> = { ada: "ada-2" };
		const renumbered = (input: ChatRecord[]) => input.map((entry) => {
			let json = entry.record_json;
			for (const [from, to] of Object.entries(logIds)) json = json.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`private_${from}"`, `private_${to}"`);
			for (const [from, to] of Object.entries(userIds)) json = json.replaceAll(`"${from}"`, `"${to}"`);
			const value = JSON.parse(json);
			return { ...entry, room_id: value.room_id, log_id: Number(value.log_id), commit_ms: Number(value.log_id), record_json: json };
		});
		const a = replayRecords(source, [], [ada, bob]);
		const b = replayRecords(renumbered(source), [], [{ ...ada, user_id: "ada-2" }, bob]);
		expect(b.messages.get("210")?.room_id).toBe("200");
		expect(b.rooms.has("private_201")).toBe(true);
		const idMap = { logId: (id: string) => logIds[id] ?? id, userId: (id: string) => userIds[id] ?? id };
		expect(compareReplayed(a, b, { idMap })).toEqual({ equal: true, differences: [] });
		// Without the map, everything that moved differs.
		const plain = compareReplayed(a, b);
		expect(plain.equal).toBe(false);
		expect(plain.differences).toContain("room 100: only in a");
		expect(plain.differences).toContain("user ada-2: only in b");
		// A map that misses a user shows exactly where.
		const partial = compareReplayed(a, b, { idMap: { logId: idMap.logId } });
		expect(partial.differences).toEqual([
			"message 210 in 200: from differs: a ada, b ada-2",
			"message 210 in 200: body differs: a {\"mentions\":[\"ada\"],\"text\":\"hi @ada\"}, b {\"mentions\":[\"ada-2\"],\"text\":\"hi @ada\"}",
			"members of private_201: only in a: ada; only in b: ada-2",
			"user ada: only in a",
			"user ada-2: only in b",
		]);
	});

	it("replays every scene to rooms, messages and users, equal to itself, and finds a change in it", async () => {
		for (const name of Object.keys(sceneArchives)) {
			const archive = await collectArchive(jsonlReader(linesOf(sceneArchives[name])));
			const state = replayRecords(archive.records, archive.rooms, archive.users);
			expect([state.rooms.size, state.messages.size, state.users.size].every((size) => size > 0), name).toBe(true);
			expect(compareReplayed(state, replayRecords([...archive.records].reverse(), archive.rooms, archive.users)).equal).toBe(true);
			const last = archive.records.filter((entry) => entry.kind === "message").pop()!;
			const value = JSON.parse(last.record_json);
			const edited = { ...last, log_id: last.log_id + 1_000_000, record_json: JSON.stringify({ ...value, log_id: String(last.log_id + 1_000_000), body: { text: "changed" } }) };
			const result = compareReplayed(state, replayRecords([...archive.records, edited], archive.rooms, archive.users));
			expect(result.differences).toHaveLength(1);
			expect(result.differences[0]).toMatch(new RegExp(`^message ${value.message_id} in .*: body differs`));
		}
	});
});
