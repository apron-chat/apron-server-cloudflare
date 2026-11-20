import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IdMap, RECORD_FIELDS, freeUserId, nextFree, nudgeLogIds, remapListing, remapRecord, remapUser } from "../src/ids.ts";
import type { ChatRecord } from "../src/records.ts";
import type { ArchivedUser, RoomListing } from "../src/types.ts";

/** A map moving log IDs 100 and 101 and users ada and bob. */
function sampleMap(): IdMap {
	return new IdMap(new Map([[100, 200], [101, 201]]), new Map([["ada", "ada-2"], ["bob", "bob-2"]]));
}

function record(wire: Record<string, unknown>, columns: Partial<ChatRecord> = {}): ChatRecord {
	return { room_id: "general", log_id: 7, commit_ms: 7, kind: "message", record_json: JSON.stringify(wire), ...columns };
}

/** Sets `value` at `path` (array indexes as numbers) in a deep copy of `base`. */
function setAt(base: Record<string, unknown>, path: Array<string | number>, value: unknown): Record<string, unknown> {
	const copy = structuredClone(base);
	let node: Record<string | number, unknown> = copy;
	for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
	node[path[path.length - 1]] = value;
	return copy;
}

// One case per field of RECORD_FIELDS: a wire object holding an old ID at
// `path`, and what it reads after remapping with sampleMap.
const base = {
	log_id: "7",
	message_id: "7",
	room_id: "general",
	from: { user_id: "carol", name: "Carol" },
	reply_to: { message_id: "8" },
	body: { text: "hi", mentions: ["carol", "dan"] },
	ext: { editors: { "body.text": "mentioned", edited_by: "carol" } },
	reactions: [{ from: { user_id: "carol" }, emojis: ["👍"] }, { from: { user_id: "dan" }, emojis: ["👍"] }],
	members: [{ user: { user_id: "carol" }, joined: true }, { user: { user_id: "dan" }, joined: false }],
	prev_log_id: "6",
	prev_room_id: "general",
	parent_room_id: "general",
	latest_log_id: "7",
	history_log_id: "7",
};
const fieldCases: Array<{ field: string; path: Array<string | number>; from: unknown; to: unknown }> = [
	{ field: "log_id", path: ["log_id"], from: "100", to: "200" },
	{ field: "message_id", path: ["message_id"], from: "101", to: "201" },
	{ field: "prev_log_id", path: ["prev_log_id"], from: "100", to: "200" },
	{ field: "reply_to.message_id", path: ["reply_to", "message_id"], from: "101", to: "201" },
	{ field: "latest_log_id", path: ["latest_log_id"], from: "100", to: "200" },
	{ field: "history_log_id", path: ["history_log_id"], from: "100", to: "200" },
	{ field: "room_id", path: ["room_id"], from: "100", to: "200" },
	{ field: "parent_room_id", path: ["parent_room_id"], from: "101", to: "201" },
	{ field: "prev_room_id", path: ["prev_room_id"], from: "private_100", to: "private_200" },
	{ field: "from.user_id", path: ["from", "user_id"], from: "ada", to: "ada-2" },
	{ field: "reactions.*.from.user_id", path: ["reactions", 1, "from", "user_id"], from: "bob", to: "bob-2" },
	{ field: "members.*.user.user_id", path: ["members", 1, "user", "user_id"], from: "ada", to: "ada-2" },
	{ field: "body.mentions.*", path: ["body", "mentions", 1], from: "bob", to: "bob-2" },
	{ field: "ext.editors.edited_by", path: ["ext", "editors", "edited_by"], from: "ada", to: "ada-2" },
];

describe("remapRecord (PLAN §10.6)", () => {
	it("has a case for every field it maps", () => {
		expect(fieldCases.map((c) => c.field).sort()).toEqual(RECORD_FIELDS.map((f) => f.path.join(".")).sort());
	});

	it.each(fieldCases)("maps $field", ({ path, from, to }) => {
		const input = record(setAt(base, path, from));
		const out = remapRecord(input, sampleMap());
		expect(out).not.toBe(input);
		// That field, and nothing else in the wire shape, changes.
		expect(JSON.parse(out.record_json)).toEqual(setAt(base, path, to));
	});

	it("leaves a field without a mapped ID alone", () => {
		const input = record(base);
		expect(remapRecord(input, sampleMap())).toBe(input);
	});

	it("maps the room and log ID columns", () => {
		const out = remapRecord(record(base, { room_id: "private_101", log_id: 100, commit_ms: 100 }), sampleMap());
		expect(out.room_id).toBe("private_201");
		expect(out.log_id).toBe(200);
		expect(out.record_json).toBe(JSON.stringify(base));
	});

	it("moves commit_ms with the log ID only where they were equal", () => {
		expect(remapRecord(record(base, { log_id: 100, commit_ms: 100 }), sampleMap()).commit_ms).toBe(200);
		expect(remapRecord(record(base, { log_id: 100, commit_ms: 99 }), sampleMap()).commit_ms).toBe(99);
	});

	it("maps room IDs that are log IDs or private_<log id>, and no others", () => {
		const map = sampleMap();
		expect(map.roomId("100")).toBe("200");
		expect(map.roomId("private_100")).toBe("private_200");
		expect(map.roomId("102")).toBe("102");
		expect(map.roomId("general")).toBe("general");
		expect(map.roomId("private_x")).toBe("private_x");
		expect(map.roomId("0100")).toBe("0100");
		expect(map.logIdString("ada")).toBe("ada");
	});

	it("leaves every record untouched under an identity map", () => {
		const records = [record(setAt(base, ["log_id"], "100"), { log_id: 100, commit_ms: 100, room_id: "100" })];
		for (const map of [new IdMap(), new IdMap(new Map([[100, 100]]), new Map([["ada", "ada"]]))]) {
			for (const input of records) expect(remapRecord(input, map)).toBe(input);
		}
	});
});

describe("remapListing and remapUser", () => {
	it("maps a listing's rooms, log IDs and members", () => {
		const listing: RoomListing = {
			room_id: "private_100", log_id: "100", parent_room_id: "101", title: "t",
			latest_log_id: "101", history_log_id: null, members: [{ user_id: "ada", name: "Ada" }, { user_id: "carol" }],
		};
		expect(remapListing(listing, sampleMap())).toEqual({
			room_id: "private_200", log_id: "200", parent_room_id: "201", title: "t",
			latest_log_id: "201", history_log_id: null, members: [{ user_id: "ada-2", name: "Ada" }, { user_id: "carol" }],
		});
		expect(remapListing({ ...listing, history_log_id: "100" }, sampleMap()).history_log_id).toBe("200");
		const untouched: RoomListing = { room_id: "general", log_id: "5", members: [{ user_id: "carol" }] };
		expect(remapListing(untouched, sampleMap())).toBe(untouched);
	});

	it("maps a user's ID", () => {
		const user: ArchivedUser = { user_id: "ada", name: "Ada", roles: ["admin"] };
		expect(remapUser(user, sampleMap())).toEqual({ user_id: "ada-2", name: "Ada", roles: ["admin"] });
		const other: ArchivedUser = { user_id: "carol" };
		expect(remapUser(other, sampleMap())).toBe(other);
	});
});

describe("nudging log IDs (PLAN §10.3)", () => {
	it("finds the next free ID at or after a start", () => {
		const taken = new Set([5, 6, 8]);
		expect(nextFree((id) => taken.has(id), 5)).toBe(7);
		expect(nextFree((id) => taken.has(id), 8)).toBe(9);
		expect(nextFree((id) => taken.has(id), 4)).toBe(4);
	});

	it("leaves free IDs where they are", () => {
		expect(nudgeLogIds([1, 2, 3], () => false).size).toBe(0);
	});

	it("moves a collision to the next free millisecond, and later IDs it reaches with it", () => {
		const taken = new Set([10, 11, 13]);
		// 10 → 12 (11 is taken); 12 is then reached and moves to 14 (13 is taken); 20 stays.
		expect(nudgeLogIds([10, 12, 20], (id) => taken.has(id))).toEqual(new Map([[10, 12], [12, 14]]));
	});

	it("keeps order through a run of collisions", () => {
		const taken = new Set([1, 2, 3, 4, 5, 7]);
		expect(nudgeLogIds([1, 2, 3, 6], (id) => taken.has(id))).toEqual(new Map([[1, 6], [2, 8], [3, 9], [6, 10]]));
	});

	it("keeps order, avoids taken IDs and moves as little as it can (property)", () => {
		fc.assert(fc.property(
			fc.uniqueArray(fc.nat({ max: 39 }), { maxLength: 40 }),
			fc.uniqueArray(fc.nat({ max: 39 }), { minLength: 1, maxLength: 15 }),
			(takenIds, importedIds) => {
				const taken = new Set(takenIds);
				const imported = [...importedIds].sort((a, b) => a - b);
				const moved = nudgeLogIds(imported, (id) => taken.has(id));
				let previous = -Infinity;
				for (const id of imported) {
					const out = moved.get(id) ?? id;
					expect(moved.get(id)).not.toBe(id);
					expect(taken.has(out)).toBe(false);
					expect(out).toBeGreaterThanOrEqual(id);
					expect(out).toBeGreaterThan(previous);
					// The nearest such ID: every one between the lowest allowed and it is taken.
					for (let between = Math.max(id, previous + 1); between < out; between++) expect(taken.has(between)).toBe(true);
					previous = out;
				}
			},
		), { numRuns: 300 });
	});
});

describe("freeUserId (PLAN §10.4)", () => {
	it("numbers a taken ID from 2", () => {
		expect(freeUserId("ada", () => false)).toBe("ada");
		expect(freeUserId("ada", (id) => id === "ada")).toBe("ada-2");
		const taken = new Set(["ada", "ada-2", "ada-3"]);
		expect(freeUserId("ada", (id) => taken.has(id))).toBe("ada-4");
	});
});

describe("remapping round trip (property)", () => {
	it("returns the original record when remapped with a map and then its inverse", () => {
		// The map permutes these, so its inverse undoes it; IDs outside them stay.
		const logPool = Array.from({ length: 12 }, (_, i) => 1000 + i);
		const userPool = Array.from({ length: 8 }, (_, i) => `u${i}`);
		const logId = fc.constantFrom(...logPool, 5000, 5001);
		const userId = fc.constantFrom(...userPool, "x", "y");
		const roomId = fc.oneof(logId.map(String), logId.map((id) => `private_${id}`), fc.constant("general"));
		const identity = userId.map((user_id) => ({ user_id, name: "N" }));
		const optional = <T>(arbitrary: fc.Arbitrary<T>) => fc.option(arbitrary, { nil: undefined });
		const wire = fc.oneof(
			fc.record({ kind: fc.constant("room" as const), room_id: roomId, parent_room_id: optional(roomId), title: fc.constant("t") }),
			fc.record({
				kind: fc.constant("message" as const), message_id: logId.map(String), room_id: roomId, from: identity,
				body: fc.record({ text: fc.constant("x"), mentions: optional(fc.tuple(userId, userId)) }),
				reply_to: optional(logId.map((id) => ({ message_id: String(id) }))),
				ext: optional(userId.map((edited_by) => ({ editors: { "body.text": "mentioned", edited_by } }))),
				prev_log_id: optional(logId.map(String)),
				prev_room_id: optional(roomId),
			}),
			fc.record({ kind: fc.constant("reactions" as const), message_id: logId.map(String), room_id: roomId, reactions: fc.tuple(identity, identity).map(([a, b]) => [{ from: a, emojis: ["👍"] }, { from: b, emojis: ["🎉"] }]) }),
			fc.record({ kind: fc.constant("membership" as const), room_id: roomId, members: fc.tuple(identity, identity).map(([a, b]) => [{ user: a, joined: true }, { user: b, joined: false }]) }),
		);
		fc.assert(fc.property(
			fc.shuffledSubarray(logPool, { minLength: logPool.length }),
			fc.shuffledSubarray(userPool, { minLength: userPool.length }),
			logId, wire, fc.boolean(),
			(logTargets, userTargets, id, { kind, ...fields }, timed) => {
				const map = new IdMap(new Map(logPool.map((from, i) => [from, logTargets[i]])), new Map(userPool.map((from, i) => [from, userTargets[i]])));
				const inverse = new IdMap(new Map([...map.logIds].map(([a, b]) => [b, a])), new Map([...map.users].map(([a, b]) => [b, a])));
				// Absent options are left out of the wire, as a client leaves them.
				const present = Object.fromEntries(Object.entries({ ...fields, body: "body" in fields && fields.body ? Object.fromEntries(Object.entries(fields.body).filter(([, value]) => value !== undefined)) : undefined }).filter(([, value]) => value !== undefined));
				const input: ChatRecord = {
					room_id: present.room_id as string, log_id: id,
					// Either the log ID's time, or a time no log ID in the map has.
					commit_ms: timed ? id : 9000,
					kind, record_json: JSON.stringify({ ...present, log_id: String(id) }),
				};
				expect(remapRecord(remapRecord(input, map), inverse)).toEqual(input);
			},
		), { numRuns: 300 });
	});
});
