import { describe, expect, it } from "vitest";
import type { ChatRecord } from "../src/records.ts";
import {
	archiveIdentity, bareUser, clientUser, contentKey, isProtocolId, roomClientFields, splitReferences, validateRecord, withBareUsers, withClientUsers,
} from "../src/validate.ts";

const record = (log: number, kind: string, value: Record<string, unknown>, room = "general"): ChatRecord => ({
	room_id: room, log_id: log, commit_ms: log, kind, record_json: JSON.stringify({ room_id: room, log_id: String(log), ...value }),
});
const limits = { maxNameBytes: 64, maxNameCodePoints: 32 };

describe("validateRecord", () => {
	it("takes each kind in its shape, with commit_ms made a positive integer", () => {
		const message = record(10, "message", { message_id: "10", from: { user_id: "ada" } });
		const checked = validateRecord({ ...message, commit_ms: 0 }, "general");
		expect("record" in checked && checked.record.commit_ms).toBe(10);
		expect("record" in checked && checked.record.value.message_id).toBe("10");
		expect(validateRecord(record(11, "room", { title: "General" }))).toHaveProperty("record");
		expect(validateRecord(record(12, "reactions", { message_id: "10", reactions: [{ from: { user_id: "bob" }, emojis: ["👍"] }] }))).toHaveProperty("record");
		expect(validateRecord(record(13, "membership", { members: [{ user: { user_id: "bob" }, joined: true }] }))).toHaveProperty("record");
	});

	it("says what is wrong", () => {
		const message = record(10, "message", { message_id: "10", from: { user_id: "ada" } });
		expect(validateRecord(message, "other")).toEqual({ problem: "belongs to another room" });
		expect(validateRecord({ ...message, log_id: 0 })).toEqual({ problem: "has no valid log_id" });
		expect(validateRecord({ ...message, log_id: 2 ** 53 })).toEqual({ problem: "has no valid log_id" });
		expect(validateRecord({ ...message, kind: "poll" })).toEqual({ problem: "is of an unknown kind" });
		expect(validateRecord({ ...message, record_json: "[1]" })).toEqual({ problem: "is not a JSON object" });
		expect(validateRecord({ ...message, record_json: "{" })).toEqual({ problem: "is not a JSON object" });
		expect(validateRecord(record(10, "message", { message_id: "10", from: { user_id: "" } }))).toEqual({ problem: "is not a valid message record" });
		expect(validateRecord(record(12, "reactions", { message_id: "10", reactions: [{ from: { user_id: "bob" }, emojis: [1] }] }))).toEqual({ problem: "is not a valid reactions record" });
		expect(validateRecord(record(13, "membership", { members: [{ user: { user_id: "bob" } }] }))).toEqual({ problem: "is not a valid membership record" });
	});
});

describe("recorded users", () => {
	it("bareUser keeps only user_id and a name", () => {
		expect(bareUser({ user_id: "ada", name: "Ada", roles: ["admin"], tier: "registered" })).toEqual({ user_id: "ada", name: "Ada" });
		expect(bareUser({ user_id: "ada", name: "" })).toEqual({ user_id: "ada" });
		expect(bareUser("ada")).toBe("ada");
	});

	it("withBareUsers makes every recorded user bare, and returns the same record when nothing changes", () => {
		const reactions = record(12, "reactions", { message_id: "10", reactions: [{ from: { user_id: "bob", roles: ["x"] }, emojis: ["👍"] }] });
		expect(JSON.parse(withBareUsers(reactions).record_json).reactions[0].from).toEqual({ user_id: "bob" });
		const bare = record(13, "membership", { members: [{ user: { user_id: "bob" }, joined: true }] });
		expect(withBareUsers(bare)).toBe(bare);
	});

	it("clientUser refuses what no client could be, and drops names past the limits", () => {
		expect(clientUser({ user_id: "ada", name: "Ada" }, limits)).toEqual({ user_id: "ada", name: "Ada" });
		expect(clientUser({ user_id: "ada", name: "x".repeat(40) }, limits)).toEqual({ user_id: "ada" });
		expect(clientUser({ user_id: "ada", name: "  " }, limits)).toEqual({ user_id: "ada" });
		expect(clientUser({ user_id: "~server" }, limits)).toBeNull();
		expect(clientUser({ user_id: "a b" }, limits)).toBeNull();
		expect(clientUser({ user_id: "a".repeat(257) }, limits)).toBeNull();
		expect(clientUser({ user_id: "a".repeat(20) }, { ...limits, maxUserIdBytes: 16 })).toBeNull();
		expect(isProtocolId("ok")).toBe(true);
		expect(isProtocolId("tab\there")).toBe(false);
	});

	it("withClientUsers rewrites in place, and fails a record with one that cannot be", () => {
		const value: Record<string, unknown> = { members: [{ user: { user_id: "bob", tier: "guest" }, joined: true }] };
		expect(withClientUsers(value, "membership", limits)).toBe(true);
		expect(value.members).toEqual([{ user: { user_id: "bob" }, joined: true }]);
		expect(withClientUsers({ reactions: [{ from: { user_id: "~x" }, emojis: [] }] }, "reactions", limits)).toBe(false);
		expect(withClientUsers({ reactions: "no" }, "reactions", limits)).toBe(false);
		expect(withClientUsers({ from: { user_id: "ada" } }, "message", limits)).toBe(true);
		expect(withClientUsers({}, "message", limits)).toBe(false);
		expect(withClientUsers({ title: "x" }, "room", limits)).toBe(true);
	});
});

describe("rooms, duplicates and references", () => {
	it("roomClientFields keeps title, a non-blank description and a non-empty ext, copied", () => {
		const ext = { theme: { color: "red" } };
		const fields = roomClientFields({ title: "T", description: " ", ext, members: [] });
		expect(fields).toEqual({ title: "T", ext });
		expect(fields.ext).not.toBe(ext);
		expect(roomClientFields({ description: "D", ext: {} })).toEqual({ description: "D" });
	});

	it("contentKey ignores where a record is and its log ID's spelling", () => {
		const a = record(10, "message", { message_id: "10", from: { user_id: "ada" }, body: { text: "hi" } });
		const b = { ...record(10, "message", { message_id: "10", from: { user_id: "ada" }, body: { text: "hi" }, prev_room_id: "x" }, "other"), log_id: 10 };
		expect(contentKey(a)).toBe(contentKey(b));
		expect(contentKey(a)).not.toBe(contentKey(record(10, "message", { message_id: "10", from: { user_id: "ada" }, body: { text: "ho" } })));
	});

	it("splitReferences keeps listed rooms' records from history_log_id on", () => {
		const records = [
			record(5, "message", { message_id: "5", from: { user_id: "ada" } }),
			record(15, "message", { message_id: "15", from: { user_id: "ada" } }),
			record(16, "message", { message_id: "16", from: { user_id: "ada" } }, "elsewhere"),
			record(17, "message", { message_id: "17", from: { user_id: "ada" } }, "quiet"),
			record(18, "message", { message_id: "18", from: { user_id: "ada" } }, "open"),
		];
		const split = splitReferences({
			rooms: [
				{ listing: { room_id: "general", history_log_id: "1" }, joined: true },
				{ listing: { room_id: "general", history_log_id: "10" }, joined: true },
				{ listing: { room_id: "quiet", history_log_id: null }, joined: false },
				{ listing: { room_id: "open" }, joined: false },
			],
			records,
		});
		expect([...split.rooms.keys()]).toEqual(["general", "quiet", "open"]);
		expect(split.content.map((r) => r.log_id)).toEqual([15, 18]);
		expect(split.references.map((r) => r.log_id)).toEqual([5, 16, 17]);
	});

	it("archiveIdentity follows the header and the records' extent", () => {
		const records = [record(5, "room", {}), record(9, "room", {})];
		const header = { apron_archive: 1 as const, server: "wss://a" };
		expect(archiveIdentity({ header, records })).toBe(archiveIdentity({ header: { ...header }, records: [...records] }));
		expect(archiveIdentity({ header, records })).not.toBe(archiveIdentity({ header, records: records.slice(0, 1) }));
	});
});
