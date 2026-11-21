// The index planner (planImport over indexArchive and planFromIndex) makes
// the plan the planner before it made (test/support/plan-v1.ts), for random
// archives, targets and options: the same report, rooms, placeholders,
// records and state, or the same refusal; and so does a plan streamed from
// the file's text. One difference is meant: a renumbered plan's report
// lists no log IDs (every one is new: the plan's IdMap and records carry them).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type ImportTarget, type PlanOptions, indexArchive, planFromIndex, planImport, recordLines } from "../src/plan.ts";
import { type ChatRecord, byLog } from "../src/records.ts";
import { readArchive } from "../src/format.ts";
import { textSource } from "../src/stream.ts";
import { planImportV1 } from "./support/plan-v1.ts";

const ROOMS = ["a", "b", "c", "t"];
const USERS = ["ada", "bob", "cy", "admin", "~bot"];

const user = fc.constantFrom(...USERS);
// Mostly listed rooms; now and then one the file does not list (its records are references).
const room = fc.constantFrom(...ROOMS, ...ROOMS, "x");
const log = fc.integer({ min: 1, max: 40 });

type Wire = readonly [key: string, value: Record<string, unknown>];

/** One wire record: its key and value. */
const record: fc.Arbitrary<Wire> = fc.oneof(
	{ weight: 4, arbitrary: fc.record({ room, log, from: user, text: fc.constantFrom("hi", "yo", "bad", "hi there"), moved: fc.option(fc.constantFrom(...ROOMS), { nil: undefined, freq: 3 }) })
		.map(({ room, log, from, text, moved }): Wire => ["messages", { room_id: room, log_id: String(log), message_id: String(log), from: { user_id: from, name: from.toUpperCase(), roles: ["admin"] }, body: { text }, ...(moved ? { prev_room_id: moved } : {}) }]) },
	{ weight: 1, arbitrary: fc.record({ room, log, on: log, users: fc.uniqueArray(user, { minLength: 1, maxLength: 3 }) })
		.map(({ room, log, on, users }): Wire => ["reactions", { room_id: room, log_id: String(log), message_id: String(on), reactions: users.map((id) => ({ from: { user_id: id }, reactions: ["+1"] })) }]) },
	{ weight: 1, arbitrary: fc.record({ room, log, users: fc.uniqueArray(user, { minLength: 1, maxLength: 3 }), joined: fc.boolean() })
		.map(({ room, log, users, joined }): Wire => ["memberships", { room_id: room, log_id: String(log), members: users.map((id) => ({ user: { user_id: id }, joined })) }]) },
	{ weight: 1, arbitrary: fc.record({ room, log, title: fc.constantFrom("A", "B") }).map(({ room, log, title }): Wire => ["rooms", { room_id: room, log_id: String(log), title }]) },
);

const listing = (roomId: string) => fc.record({
	history: fc.constantFrom<string | null | undefined>(undefined, undefined, null, "5", "20"),
	logId: fc.option(fc.integer({ min: 1, max: 30 }), { nil: undefined }),
	members: fc.option(fc.uniqueArray(user, { maxLength: 3 }), { nil: undefined }),
	count: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
	joined: fc.boolean(),
}).map(({ history, logId, members, count, joined }) => ({
	[joined ? "joined" : "not_joined"]: [{
		room_id: roomId, title: roomId.toUpperCase(),
		...(roomId === "t" ? { parent_room_id: "a" } : {}),
		...(history !== undefined ? { history_log_id: history } : {}),
		...(logId !== undefined ? { log_id: String(logId) } : {}),
		...(members ? { members: members.map((id) => ({ user_id: id })) } : {}),
		...(count !== undefined ? { member_count: count } : {}),
	}],
}));

const archiveSpec = fc.record({
	server: fc.constantFrom(undefined, "here", "there"),
	// Each room listed (a room listed twice: the later listing stands), or not.
	listings: fc.subarray([...ROOMS, "a"], { minLength: 1 }).chain((rooms) => fc.tuple(...rooms.map(listing))),
	users: fc.uniqueArray(user, { maxLength: 5 }),
	// Records a few to a line, in any order.
	lines: fc.array(fc.array(record, { minLength: 1, maxLength: 3 }), { maxLength: 30 }),
	junk: fc.boolean(),
});
type ArchiveSpec = typeof archiveSpec extends fc.Arbitrary<infer T> ? T : never;

function textOf(spec: ArchiveSpec): string {
	return [
		JSON.stringify({ apron_archive: 1, ...(spec.server ? { server: spec.server } : {}) }),
		...spec.listings.map((line) => JSON.stringify(line)),
		JSON.stringify({ users: spec.users.map((id) => ({ user_id: id, name: id.toUpperCase(), roles: ["mod"] })) }),
		...(spec.junk ? ["", "not json", "[1]"] : []),
		...spec.lines.map((line) => {
			const out: Record<string, unknown[]> = {};
			for (const [key, value] of line) (out[key] ??= []).push(value);
			return JSON.stringify(out);
		}),
	].join("\n");
}

/**
 * What is true at the target: rooms, empty rooms, users, retired IDs, and
 * records held at the archive's log IDs: the same message as one of its
 * (a duplicate), the same under the name its author gets here (a
 * duplicate under the user mapping), or another (a collision).
 */
const targetSpec = fc.record({
	rooms: fc.subarray(ROOMS, { maxLength: 2 }),
	empty: fc.subarray(ROOMS, { maxLength: 1 }),
	users: fc.subarray([...USERS, "ada-2", "imported-admin"]),
	retired: fc.subarray(["bob", "cy-2"]),
	held: fc.array(fc.record({ pick: fc.nat(), as: fc.constantFrom("same", "renamed", "other") }), { maxLength: 6 }),
	latest: fc.integer({ min: 0, max: 50 }),
	accounts: fc.option(fc.integer({ min: 0, max: 6 }), { nil: undefined }),
	rejectBad: fc.boolean(),
	roomCap: fc.boolean(),
});
type TargetSpec = typeof targetSpec extends fc.Arbitrary<infer T> ? T : never;

function makeTarget(spec: TargetSpec, archive: ArchiveSpec): ImportTarget {
	const messages = archive.lines.flat().filter(([key]) => key === "messages").map(([, value]) => value as { log_id: string; from: { user_id: string }; [key: string]: unknown });
	const held: ChatRecord[] = messages.length ? spec.held.map(({ pick, as }) => {
		const { from, name: _name, roles: _roles, prev_room_id: _prev, ...value } = messages[pick % messages.length]!;
		const logId = Number(value.log_id);
		const body = as === "other" ? { text: "theirs" } : value.body;
		const author = as === "renamed" ? `${from.user_id}-2` : from.user_id;
		return { room_id: "elsewhere", log_id: logId, commit_ms: logId, kind: "message", record_json: JSON.stringify({ ...value, room_id: "elsewhere", from: { user_id: author, name: from.user_id.toUpperCase() }, body }) };
	}) : [];
	return {
		hasRoom: async (id) => spec.rooms.includes(id) || spec.empty.includes(id),
		roomIsEmpty: async (id) => spec.empty.includes(id),
		hasUser: async (id) => spec.users.includes(id),
		isRetired: async (id) => spec.retired.includes(id),
		latest: async () => spec.latest,
		lookup: async (ids) => held.filter((one) => ids.includes(one.log_id)),
		...(spec.rejectBad ? { normalize: (one: ChatRecord) => (one.record_json.includes('"bad"') ? null : one) } : {}),
		...(spec.accounts !== undefined ? { accounts: async () => ({ used: 2, limit: 2 + spec.accounts! }) } : {}),
		...(spec.roomCap ? { roomCapacity: async (rooms) => (rooms.length > 2 ? "too many rooms" : undefined) } : {}),
	};
}

const optionsSpec = fc.record({
	users: fc.constantFrom(undefined, "auto", "new", "match"),
	authenticated: fc.boolean(),
	ids: fc.constantFrom(undefined, "original", "renumber"),
	server: fc.constantFrom(undefined, "here"),
	maxMemberships: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
	maxPlaceholders: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
	userMap: fc.option(fc.constantFrom<NonNullable<PlanOptions["userMap"]>>({ ada: { placeholder: "ada-x" } }, { cy: { existing: "ada" } }, { bob: { placeholder: "~nope" } }), { nil: undefined, freq: 4 }),
	prepare: fc.boolean(),
	// Mostly a clock past every log ID; now and then one some are past.
	now: fc.constantFrom(10_000, 10_000, 10_000, 25),
});
type OptionsSpec = typeof optionsSpec extends fc.Arbitrary<infer T> ? T : never;

function optionsOf(spec: OptionsSpec): PlanOptions {
	return {
		now: () => spec.now,
		...(spec.users ? { users: spec.users as PlanOptions["users"] } : {}),
		authenticated: spec.authenticated,
		...(spec.ids ? { ids: spec.ids as PlanOptions["ids"] } : {}),
		...(spec.server ? { server: spec.server } : {}),
		...(spec.maxMemberships !== undefined ? { maxMembershipsPerUser: spec.maxMemberships } : {}),
		...(spec.maxPlaceholders !== undefined ? { maxPlaceholders: spec.maxPlaceholders } : {}),
		...(spec.userMap ? { userMap: spec.userMap } : {}),
		// Changes what a server must never take from a file as it is.
		...(spec.prepare ? { prepare: (one: ChatRecord) => (one.record_json.includes('"yo"') ? { ...one, record_json: one.record_json.replace('"yo"', '"hi"') } : one) } : {}),
	};
}

/** A plan, or the refusal it throws, comparable. */
async function outcome<T>(fn: () => Promise<T>): Promise<{ value: T } | { error: string }> {
	try {
		return { value: await fn() };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Plans the archive streamed from its text, as an import reads a file: indexed, planned, and its records selected as the text is read again. */
async function streamedPlan(text: string, target: ImportTarget, options: PlanOptions) {
	const source = textSource(text);
	const index = await indexArchive(source, { ...(options.prepare ? { prepare: options.prepare } : {}), ...(target.normalize ? { normalize: target.normalize } : {}) });
	const plan = await planFromIndex(index, source, target, options);
	const records: ChatRecord[] = [];
	for await (const line of recordLines(source)) records.push(...plan.select(line));
	return { ...plan, records: records.sort(byLog) };
}

describe("planner parity", () => {
	it("plans what the planner before the index did, from an archive held whole or streamed", async () => {
		const seen = { planned: 0, refused: 0, records: 0, duplicates: 0, moved: 0, references: 0 };
		await fc.assert(fc.asyncProperty(archiveSpec, targetSpec, optionsSpec, async (archive, target, options) => {
			const text = textOf(archive);
			const collected = readArchive(text);
			const before = await outcome(() => planImportV1(collected, makeTarget(target, archive), optionsOf(options)));
			const after = await outcome(() => planImport(collected, makeTarget(target, archive), optionsOf(options)));
			const streamed = await outcome(() => streamedPlan(text, makeTarget(target, archive), optionsOf(options)));
			if ("error" in before) {
				seen.refused += 1;
				expect(after).toEqual(before);
				expect(streamed).toEqual(before);
				return;
			}
			seen.planned += 1;
			seen.records += before.value.records.length;
			seen.duplicates += before.value.report.duplicates;
			seen.references += before.value.report.references;
			const renumbered = before.value.state.ids.mode === "renumber";
			if (!renumbered) seen.moved += Object.keys(before.value.report.remapped.logIds).length;
			const { report, rooms, placeholders, records, state } = before.value;
			const expected = { report: { ...report, remapped: { ...report.remapped, logIds: renumbered ? {} : report.remapped.logIds } }, rooms, placeholders, records, state };
			for (const got of [after, streamed]) {
				if ("error" in got) throw new Error(`refused: ${got.error}`);
				expect({ report: got.value.report, rooms: got.value.rooms, placeholders: got.value.placeholders, records: got.value.records, state: got.value.state }).toEqual(expected);
				for (const [from, to] of before.value.map.logIds) expect(got.value.map.logId(from)).toBe(to);
			}
		}), { numRuns: 500 });
		// The cases reached what matters: plans with records, duplicates, moved IDs and references, and refusals.
		expect(seen.planned).toBeGreaterThan(250);
		expect(seen.refused).toBeGreaterThan(10);
		for (const key of ["records", "duplicates", "moved", "references"] as const) expect(seen[key]).toBeGreaterThan(20);
	});
});
