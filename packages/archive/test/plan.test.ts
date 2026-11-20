import { describe, expect, it } from "vitest";
import { type ImportTarget, type PlanOptions, type UserIdRules, importStateJson, parseImportState, planImport } from "../src/plan.ts";
import type { CollectedArchive } from "../src/format.ts";
import type { ChatRecord } from "../src/records.ts";
import type { ArchivedRoom, ArchivedUser } from "../src/types.ts";
import { withBareUsers } from "../src/validate.ts";

const NOW = 1_000_000;

const message = (log: number, room: string, from: string, text = `m${log}`, extra: Record<string, unknown> = {}): ChatRecord => ({
	room_id: room, log_id: log, commit_ms: log, kind: "message",
	record_json: JSON.stringify({ room_id: room, log_id: String(log), message_id: String(log), from: { user_id: from, name: from.toUpperCase(), roles: ["admin"] }, body: { text }, ...extra }),
});

function archive(records: ChatRecord[], rooms: ArchivedRoom[], users: ArchivedUser[] = [], header: Record<string, unknown> = {}): CollectedArchive {
	return { header: { apron_archive: 1, ...header }, rooms, users, records: [...records].sort((a, b) => a.log_id - b.log_id), extras: [], fields: [] };
}

const room = (room_id: string, extra: Record<string, unknown> = {}): ArchivedRoom => ({ listing: { room_id, title: room_id, ...extra }, joined: false });

/** A target held in memory: rooms, users, retired IDs and records. */
function memoryTarget(init: { rooms?: string[]; users?: string[]; retired?: string[]; records?: ChatRecord[]; latest?: number } = {}): ImportTarget & { lookups: number[][] } {
	const rooms = new Set(init.rooms ?? []);
	const users = new Set(init.users ?? []);
	const retired = new Set(init.retired ?? []);
	const records = init.records ?? [];
	const lookups: number[][] = [];
	return {
		lookups,
		hasRoom: async (id) => rooms.has(id),
		hasUser: async (id) => users.has(id),
		isRetired: async (id) => retired.has(id),
		latest: async () => init.latest ?? Math.max(0, ...records.map((record) => record.log_id)),
		lookup: async (ids) => {
			lookups.push([...ids]);
			const wanted = new Set(ids);
			return records.filter((record) => wanted.has(record.log_id));
		},
	};
}

const options = (extra: Partial<PlanOptions> = {}): PlanOptions => ({ now: () => NOW, ...extra });

describe("planImport", () => {
	it("makes accounts only for users the import uses: named by a record, or listed as a new room's member", async () => {
		// ana posted, ben's join is a record, cy is a member the listing names (his join aged out), dee is only listed as a user.
		const join = (log: number, roomId: string, userId: string): ChatRecord => ({
			room_id: roomId, log_id: log, commit_ms: log, kind: "membership",
			record_json: JSON.stringify({ room_id: roomId, log_id: String(log), members: [{ user: { user_id: userId }, joined: true }] }),
		});
		const plan = await planImport(
			archive(
				[join(60, "general", "ben"), message(70, "general", "ana"), message(80, "old", "eli")],
				[room("general", { history_log_id: "50", members: [{ user_id: "ana" }, { user_id: "ben" }, { user_id: "cy" }] }), room("old", { members: [{ user_id: "fay" }] })],
				["ana", "ben", "cy", "dee", "eli", "fay"].map((user_id) => ({ user_id, name: user_id.toUpperCase() })),
			),
			memoryTarget({ rooms: ["old"] }),
			options(),
		);
		expect(Object.keys(plan.report.users).sort()).toEqual(["ana", "ben", "cy"]);
		expect(plan.placeholders.map((user) => user.user_id).sort()).toEqual(["ana", "ben", "cy"]);
		// A placeholder keeps its profile from the file's users part.
		expect(plan.placeholders.find((user) => user.user_id === "cy")).toMatchObject({ name: "CY" });
		// The listing goes to the writer with its members, which it joins (importArchive's membersOf).
		expect(plan.rooms[0]!.listing.members).toEqual([{ user_id: "ana" }, { user_id: "ben" }, { user_id: "cy" }]);
	});

	it("orders new rooms top-level first, so a thread's parent is restored before it whatever their names", async () => {
		// `battleplan` sorts before its parent `security`: restored in name order, the thread would come first.
		const plan = await planImport(
			archive([message(10, "security", "kate"), message(20, "battleplan", "kevin"), message(30, "aside", "kate")], [room("security"), room("battleplan", { parent_room_id: "security" }), room("aside", { parent_room_id: "zeta" }), room("zeta")]),
			memoryTarget(),
			options(),
		);
		expect(plan.rooms.map((entry) => entry.roomId)).toEqual(["security", "zeta", "aside", "battleplan"]);
		expect(plan.state.rooms.map((entry) => entry.archive)).toEqual(["security", "zeta", "aside", "battleplan"]);
	});

	it("imports listed rooms that are new, skips existing ones, and counts references", async () => {
		const plan = await planImport(
			archive([message(10, "a", "ada"), message(20, "b", "ada"), message(30, "unlisted", "ada"), message(5, "a", "ada")], [room("a", { history_log_id: "8" }), room("b")]),
			memoryTarget({ rooms: ["b"] }),
			options(),
		);
		expect(plan.report.roomsAdded).toEqual(["a"]);
		expect(plan.report.roomsSkipped).toEqual(["b"]);
		expect(plan.report.references).toBe(2);
		expect(plan.records.map((record) => record.log_id)).toEqual([10]);
		// Recorded users made bare.
		expect(JSON.parse(plan.records[0]!.record_json).from).toEqual({ user_id: "ada", name: "ADA" });
		// The room's bounds follow its records.
		expect(plan.rooms[0]!.listing).toMatchObject({ room_id: "a", log_id: "10", latest_log_id: "10" });
	});

	it("makes a moved message's copy again in the new room it left", async () => {
		const plan = await planImport(archive([message(10, "b", "ada", "moved", { prev_room_id: "a" })], [room("a"), room("b")]), memoryTarget(), options());
		expect(plan.records.map((record) => `${record.log_id}@${record.room_id}`)).toEqual(["10@a", "10@b"]);
		// A writer that took the move from both rooms' histories gives it twice, both naming the room it went to: read once.
		const twice = message(10, "b", "ada", "moved", { prev_room_id: "a" });
		const again = await planImport(archive([twice, twice], [room("a"), room("b")]), memoryTarget(), options());
		expect(again.records.map((record) => `${record.log_id}@${record.room_id}`)).toEqual(["10@a", "10@b"]);
		expect(again.report.records).toBe(plan.report.records);
	});

	it("maps users: new placeholders, free IDs past taken and retired ones, the rules' base for IDs that cannot stand", async () => {
		const rules: UserIdRules = { restorable: (id) => /^[a-z]+$/.test(id), placeholderBase: (id) => `imported-${id.replace(/[^a-z]/g, "")}` };
		const plan = await planImport(
			archive([message(10, "a", "ada"), message(11, "a", "bob"), message(12, "a", "guest_1")], [room("a")], [{ user_id: "ada", name: "Ada", roles: ["admin"] }]),
			memoryTarget({ users: ["ada"], retired: ["bob"] }),
			options({ userIds: rules }),
		);
		expect(plan.report.users).toEqual({ ada: { placeholder: "ada-2" }, bob: { placeholder: "bob-2" }, guest_1: { placeholder: "imported-guest" } });
		// Profiles carried over, roles never.
		expect(plan.placeholders).toContainEqual({ user_id: "ada-2", name: "Ada" });
		expect(JSON.parse(plan.records[0]!.record_json).from.user_id).toBe("ada-2");
		expect(plan.report.remapped.users).toEqual({ ada: "ada-2", bob: "bob-2", guest_1: "imported-guest" });
	});

	it("matches users only from an authenticated archive", async () => {
		const input = archive([message(10, "a", "ada"), message(11, "a", "cy")], [room("a")], [], { server: "wss://here" });
		await expect(planImport(input, memoryTarget({ users: ["ada"] }), options({ users: "match" }))).rejects.toThrow(/users match needs an archive verified/);
		const auto = await planImport(input, memoryTarget({ users: ["ada"] }), options({ authenticated: true, server: "wss://here" }));
		expect(auto.report.users).toEqual({ ada: { matched: "ada" }, cy: { placeholder: "cy" } });
		const elsewhere = await planImport(input, memoryTarget({ users: ["ada"] }), options({ authenticated: true, server: "wss://other" }));
		expect(elsewhere.report.users.ada).toEqual({ placeholder: "ada-2" });
	});

	it("applies userMap overrides, and refuses impossible ones", async () => {
		const input = archive([message(10, "a", "ada"), message(11, "a", "bob")], [room("a")]);
		const plan = await planImport(input, memoryTarget({ users: ["root"] }), options({ userMap: { ada: { existing: "root" }, bob: { placeholder: "robert" } } }));
		expect(plan.report.users).toEqual({ ada: { matched: "root" }, bob: { placeholder: "robert" } });
		await expect(planImport(input, memoryTarget(), options({ userMap: { ada: { existing: "nobody" } } }))).rejects.toThrow(/no account here/);
		await expect(planImport(input, memoryTarget({ users: ["robert"] }), options({ userMap: { bob: { placeholder: "robert" } } }))).rejects.toThrow(/taken/);
	});

	it("skips duplicates and nudges collisions past every taken log ID", async () => {
		// Held as stored: recorded users bare.
		const held = [
			message(10, "x", "ada", "same"),
			message(20, "x", "eve", "other"),
			message(21, "x", "eve", "also taken"),
		].map(withBareUsers);
		const target = memoryTarget({ records: held });
		const plan = await planImport(archive([message(10, "a", "ada", "same"), message(20, "a", "ada", "new"), message(30, "a", "ada")], [room("a")]), target, options({ users: "new" }));
		expect(plan.report.duplicates).toBe(1);
		expect(plan.records.map((record) => record.log_id)).toEqual([22, 30]);
		expect(plan.report.remapped.logIds).toEqual({ 20: "22" });
		// The message ID follows its log ID.
		expect(JSON.parse(plan.records[0]!.record_json).message_id).toBe("22");
	});

	it("renumbers after the target's latest, in order, with listings following", async () => {
		const plan = await planImport(archive([message(10, "a", "ada"), message(500, "a", "ada")], [room("a"), room("empty", { history_log_id: null })]), memoryTarget({ latest: NOW + 50 }), options({ ids: "renumber" }));
		expect(plan.records.map((record) => record.log_id)).toEqual([NOW + 51, NOW + 52]);
		expect(plan.rooms.map((entry) => [entry.listing.room_id, entry.listing.log_id, entry.listing.history_log_id])).toEqual([
			["a", String(NOW + 51), String(NOW + 51)],
			["empty", String(NOW + 51 + 2 + 1), null],
		]);
		expect(plan.state.ids).toEqual({ mode: "renumber", base: NOW + 51 });
	});

	it("refuses log IDs past the clock unless renumbered", async () => {
		const input = archive([message(NOW + 10 * 60_000, "a", "ada")], [room("a")]);
		await expect(planImport(input, memoryTarget(), options())).rejects.toThrow(/later than this server's clock/);
		await expect(planImport(input, memoryTarget(), options({ futureMs: 60 * 60_000 }))).resolves.toBeDefined();
		await expect(planImport(input, memoryTarget(), options({ ids: "renumber" }))).resolves.toBeDefined();
	});

	it("reports a placeholder cap rather than throwing", async () => {
		const plan = await planImport(archive([message(10, "a", "ada"), message(11, "a", "bob")], [room("a")]), memoryTarget(), options({ maxPlaceholders: 1 }));
		expect(plan.report.refused).toMatch(/2 placeholder accounts, more than the 1/);
	});

	it("refuses more placeholders than the target has room for, saying how many fit", async () => {
		const input = archive([message(10, "a", "ada"), message(11, "a", "bob"), message(12, "a", "cy")], [room("a")]);
		const full = { ...memoryTarget(), accounts: async () => ({ used: 8, limit: 10 }) };
		const refused = await planImport(input, full, options());
		expect(refused.report.accounts).toEqual({ used: 8, limit: 10 });
		expect(refused.report.refused).toBe("this archive would make 3 placeholder accounts, but there is room for 2 more (8 of 10 accounts are in use)");
		const roomy = { ...memoryTarget(), accounts: async () => ({ used: 7, limit: 10 }) };
		expect((await planImport(input, roomy, options())).report.refused).toBeUndefined();
		// A resumed plan made its placeholders already: its run decides, not the count now.
		const resumed = await planImport(input, full, options({ resume: (await planImport(input, roomy, options())).state }));
		expect(resumed.report.refused).toBeUndefined();
	});

	it("journals users that stay themselves compactly, and reads the journal back as the plan's state", async () => {
		const users = Array.from({ length: 50 }, (_, index) => `user${index}`);
		const input = archive(users.map((user, index) => message(10 + index, "a", user)), [room("a")]);
		const plan = await planImport(input, memoryTarget({ users: ["user3"] }), options({ users: "new" }));
		const text = importStateJson(plan.state);
		// user3 is taken here: it is the one with a target of its own.
		expect(plan.state.users.user3).toEqual({ placeholder: "user3-2" });
		expect(text).toContain('"user0":"="');
		expect(text.length).toBeLessThan(JSON.stringify(plan.state).length / 2);
		expect(parseImportState(text)).toEqual(plan.state);
		expect(parseImportState(JSON.stringify(plan.state))).toEqual(plan.state);
		expect(parseImportState(JSON.stringify({ ...plan.state, users: { a: "?" } }))).toBeUndefined();
	});

	it("drops what the target's normalize refuses, after the prepare step", async () => {
		const target = { ...memoryTarget(), normalize: (record: ChatRecord) => (record.record_json.includes("secret") ? null : record) };
		const plan = await planImport(archive([message(10, "a", "ada", "secret"), message(11, "a", "ada", "fine")], [room("a")]), target, options({ prepare: (record) => record }));
		expect(plan.report.rejected).toBe(1);
		expect(plan.records.map((record) => record.log_id)).toEqual([11]);
	});

	it("makes the same plan again from its state, whatever the options say", async () => {
		const input = archive([message(10, "a", "ada"), message(20, "a", "bob")], [room("a")]);
		const first = await planImport(input, memoryTarget({ users: ["ada"], records: [message(20, "x", "eve")] }), options());
		const state = JSON.parse(JSON.stringify(first.state));
		// Resumed against a target that now holds what the first run wrote.
		const again = await planImport(input, memoryTarget({ rooms: ["a"], users: ["ada", "ada-2", "bob"] }), options({ users: "match", ids: "renumber", resume: state }));
		expect(again.report.resumed).toBe(true);
		expect(again.report.roomsAdded).toEqual(first.report.roomsAdded);
		expect(again.report.users).toEqual(first.report.users);
		expect(again.records).toEqual(first.records);
		expect(again.state).toEqual(first.state);
	});
});
