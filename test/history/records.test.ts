// /purge and /rename below SQLite (src/history/records.ts): the tiers that
// take rewrites rewrite what they hold record by record (purgedRecord,
// renamedRecord), and pages read from a tier have its pending rewrites
// applied (rewritten). The cold tier takes none and keeps the rewrites it
// is delivered: withKept finds the rewrites a record names from its JSON's
// strings, and applies only those, so its cost does not grow with how many
// are kept. It must give exactly what applying every kept rewrite to every
// record in order gives.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { authoredMessages, purgedRecord, renamedRecord } from "@apron/archive";
import { type ChatRecord, type KeptRewrite, rewritten, withKept } from "../../src/history/records";

/** The definition: every rewrite, in order, to every record at or below its group's `through`; a purge's messages noted first. */
function reference(records: readonly ChatRecord[], kept: readonly KeptRewrite[], purged?: Set<string>): ChatRecord[] {
	let out = [...records];
	for (const group of kept) {
		for (const rewrite of group.rewrites) {
			if (rewrite.into === null && purged) for (const id of authoredMessages(out.filter((record) => record.log_id <= group.through), [rewrite.user])) purged.add(id);
			out = out.flatMap((record) => {
				if (record.log_id > group.through) return [record];
				const json = rewrite.into === null ? purgedRecord(record, [rewrite.user], rewrite.messages ?? []) : renamedRecord(record, rewrite.user, rewrite.into);
				return json === null ? [] : [{ ...record, record_json: json }];
			});
		}
	}
	return out;
}

const USERS = ["ada", "bob", "cy", "dee", "ada-2", "bob-2", "x\"y"];
const user = fc.constantFrom(...USERS);
const MESSAGES = ["m1", "m2", "m3", "m4", "m5"];
const record = fc.oneof(
	fc.record({ log: fc.integer({ min: 1, max: 40 }), message: fc.constantFrom(...MESSAGES), from: user, mention: fc.option(user, { nil: undefined }) }).map(({ log, message, from, mention }): ChatRecord => ({
		room_id: "r", log_id: log, commit_ms: log, kind: "message",
		record_json: JSON.stringify({ message_id: message, log_id: String(log), room_id: "r", from: { user_id: from }, body: { text: "hi", ...(mention ? { mentions: [mention] } : {}) } }),
	})),
	fc.record({ log: fc.integer({ min: 1, max: 40 }), message: fc.constantFrom(...MESSAGES), sets: fc.array(user, { minLength: 1, maxLength: 3 }) }).map(({ log, message, sets }): ChatRecord => ({
		room_id: "r", log_id: log, commit_ms: log, kind: "reactions",
		record_json: JSON.stringify({ message_id: message, log_id: String(log), room_id: "r", reactions: [...new Set(sets)].map((from) => ({ from: { user_id: from }, emojis: ["👍"] })) }),
	})),
	fc.record({ log: fc.integer({ min: 1, max: 40 }), who: fc.array(user, { minLength: 1, maxLength: 3 }) }).map(({ log, who }): ChatRecord => ({
		room_id: "r", log_id: log, commit_ms: log, kind: "membership",
		record_json: JSON.stringify({ room_id: "r", log_id: String(log), members: [...new Set(who)].map((id) => ({ user: { user_id: id }, membership: "join" })) }),
	})),
);
const rewrite = fc.oneof(
	fc.record({ user, messages: fc.subarray(MESSAGES) }).map(({ user, messages }) => ({ user, into: null, ...(messages.length ? { messages } : {}) })),
	fc.record({ user, into: user }).filter(({ user, into }) => user !== into),
);
const groups = fc.array(fc.record({ through: fc.integer({ min: 0, max: 45 }), rewrites: fc.array(rewrite, { minLength: 1, maxLength: 4 }) }), { maxLength: 5 })
	.map((list) => list.map((group, index): KeptRewrite => ({ first: index * 10, seq: index * 10 + group.rewrites.length - 1, ...group })));

const values = (records: readonly ChatRecord[]) => records.map((each) => ({ ...each, record_json: JSON.parse(each.record_json) as unknown }));

describe("rewrites", () => {
	it("rewrites a record as /purge and /rename rewrite SQLite's, and applies pending rewrites in order to a page", () => {
		const reactions = { kind: "reactions", record_json: JSON.stringify({ message_id: "m1", reactions: [{ from: { user_id: "a" }, emojis: ["👍"] }, { from: { user_id: "b" }, emojis: ["🎉"] }] }) };
		expect(JSON.parse(purgedRecord(reactions, ["a"], [])!).reactions).toEqual([{ from: { user_id: "b" }, emojis: ["🎉"] }]);
		// Every set on a purged message goes, and a record left empty with them.
		expect(purgedRecord(reactions, ["z"], ["m1"])).toBeNull();
		const membership = { kind: "membership", record_json: JSON.stringify({ members: [{ user: { user_id: "a" }, joined: true }] }) };
		expect(purgedRecord(membership, ["a"], [])).toBeNull();
		const message = { kind: "message", record_json: JSON.stringify({ message_id: "m1", from: { user_id: "a", name: "A" } }) };
		expect(JSON.parse(renamedRecord(message, "a", "b")).from).toEqual({ user_id: "b", name: "A" });
		expect(JSON.parse(renamedRecord(reactions, "a", "c")).reactions.map((set: { from: { user_id: string } }) => set.from.user_id)).toEqual(["c", "b"]);
		expect(JSON.parse(renamedRecord(membership, "a", "d")).members[0].user.user_id).toBe("d");
		// Rewrites pending for a tier, applied in order to what a page read from it.
		const at = (logId: number, kind: string, value: object) => ({ room_id: "general", log_id: logId, commit_ms: logId, kind, record_json: JSON.stringify(value) });
		const records = [
			at(1, "message", { message_id: "m1", from: { user_id: "gone" } }),
			at(2, "message", { message_id: "m2", from: { user_id: "old" } }),
			at(3, "reactions", { message_id: "m1", reactions: [{ from: { user_id: "x" }, emojis: ["👍"] }] }),
			at(4, "reactions", { message_id: "m2", reactions: [{ from: { user_id: "gone" }, emojis: ["👍"] }, { from: { user_id: "old" }, emojis: ["🎉"] }] }),
			at(5, "membership", { members: [{ user: { user_id: "gone" }, joined: true }] }),
		];
		const result = rewritten(records, [{ user: "gone", into: null }, { user: "old", into: "new" }]);
		expect(result.map((entry) => [entry.log_id, JSON.parse(entry.record_json)])).toEqual([
			[2, { message_id: "m2", from: { user_id: "new" } }],
			[4, { message_id: "m2", reactions: [{ from: { user_id: "new" }, emojis: ["🎉"] }] }],
		]);
	});
});

describe("withKept", () => {
	it("gives what applying every kept rewrite in order gives, and notes the same purged messages", () => {
		fc.assert(fc.property(fc.array(record, { maxLength: 25 }), groups, (records, kept) => {
			const purged = new Set<string>();
			const expected = new Set<string>();
			expect(values(withKept(records, kept, purged))).toEqual(values(reference(records, kept, expected)));
			expect([...purged].sort()).toEqual([...expected].sort());
		}), { numRuns: 400 });
	});

	it("reads thousands of kept rewrites in time that does not grow with their number", () => {
		const records = Array.from({ length: 2_000 }, (_, index): ChatRecord => ({
			room_id: "r", log_id: index + 1, commit_ms: index + 1, kind: "message",
			record_json: JSON.stringify({ message_id: `m${index}`, log_id: String(index + 1), room_id: "r", from: { user_id: index % 100 === 0 ? "ada" : `user${index % 50}` }, body: { text: `text ${index}` } }),
		}));
		// 5,000 purges and renames of users the records mostly do not name, in a few groups.
		const many: KeptRewrite[] = Array.from({ length: 5 }, (_, group) => ({
			first: group * 1_000, seq: group * 1_000 + 999, through: 1_000_000,
			rewrites: Array.from({ length: 1_000 }, (_, at) => (at % 2 ? { user: `gone${group}-${at}`, into: null } : { user: `old${group}-${at}`, into: `new${group}-${at}` })),
		}));
		many[4].rewrites.push({ user: "ada", into: null });
		const started = performance.now();
		const out = withKept(records, many);
		const elapsed = performance.now() - started;
		expect(out).toHaveLength(2_000 - 20);
		expect(out.some((each) => each.record_json.includes('"ada"'))).toBe(false);
		expect(elapsed).toBeLessThan(2_000);
	});
});
