import { describe, expect, it } from "vitest";
import {
	collectArchive,
	jsonlReader,
	jsonlWriter,
	linesFromStream,
	linesOf,
	MAX_LINE_BYTES,
	recordToWire,
	utf8Length,
	wireToRecord,
	writeArchiveToString,
} from "../../src/history/archive/format";
import type { ArchivePart } from "../../src/history/archive/types";
import type { ChatRecord, RecordKind } from "../../src/history/records";
import { sceneArchives } from "../fixtures/archives";

function record(kind: RecordKind, roomId: string, logId: number, fields: Record<string, unknown> = {}): ChatRecord {
	return { room_id: roomId, log_id: logId, commit_ms: logId, kind, record_json: JSON.stringify({ room_id: roomId, log_id: String(logId), ...fields }) };
}

const header = { apron_archive: 1 as const, server: "wss://chat.example/", exported_at: "2026-10-27T12:00:00.000Z" };

const records: ChatRecord[] = [
	record("room", "general", 100, { title: "General" }),
	record("membership", "general", 101, { members: [{ user: { user_id: "ada", name: "Ada" }, joined: true }] }),
	record("message", "general", 102, { message_id: "102", from: { user_id: "ada", name: "Ada" }, body: { text: "Hi!" } }),
	record("reactions", "general", 103, { message_id: "102", reactions: [{ from: { user_id: "bob" }, emojis: ["👍"] }] }),
	record("message", "general", 104, { message_id: "102", prev_log_id: "102", from: { user_id: "ada", name: "Ada" }, body: { text: "Hi, all!" } }),
];

async function partsOf(text: string): Promise<ArchivePart[]> {
	const parts: ArchivePart[] = [];
	for await (const part of jsonlReader(linesOf(text)).parts()) parts.push(part);
	return parts;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

describe("jsonlWriter and jsonlReader", () => {
	it("round-trips every part kind", async () => {
		const text = await writeArchiveToString(async (writer) => {
			await writer.header(header);
			await writer.listing({
				joined: [{ room_id: "general", log_id: "100", title: "General", members: [{ user_id: "ada" }] }],
				not_joined: [{ room_id: "ops", history_log_id: null }],
				users: [{ user_id: "ada", name: "Ada" }, { user_id: "bob", name: "Bob" }],
			});
			await writer.records([...records].reverse());
			await writer.extra("uploads", [{ key: "a.png" }, { key: "b.png" }]);
		});
		expect(text.endsWith("\n")).toBe(true);
		const lines = text.split("\n");
		expect(lines.pop()).toBe("");
		expect(lines).toHaveLength(4);
		expect(JSON.parse(lines[0])).toEqual(header);
		// One part with each kind's records in log order.
		const recordLine = JSON.parse(lines[2]);
		expect(Object.keys(recordLine)).toEqual(["rooms", "memberships", "messages", "reactions"]);
		expect(recordLine.messages.map((value: { log_id: string }) => value.log_id)).toEqual(["102", "104"]);

		const reader = jsonlReader(linesOf(text));
		expect(await reader.header()).toEqual(header);
		const parts: ArchivePart[] = [];
		for await (const part of reader.parts()) parts.push(part);
		expect(parts.map((part) => part.kind)).toEqual(["listing", "records", "extra"]);
		expect(parts[0]).toEqual({
			kind: "listing",
			joined: [{ room_id: "general", log_id: "100", title: "General", members: [{ user_id: "ada" }] }],
			not_joined: [{ room_id: "ops", history_log_id: null }],
			users: [{ user_id: "ada", name: "Ada" }, { user_id: "bob", name: "Bob" }],
		});
		expect(parts[1]).toEqual({ kind: "records", records });
		expect(parts[2]).toEqual({ kind: "extra", key: "uploads", values: [{ key: "a.png" }, { key: "b.png" }] });
	});

	it("writes a move's copies once and reads it back in its destination", async () => {
		const json = JSON.stringify({ message_id: "5", log_id: "9", room_id: "thread", prev_room_id: "general", from: { user_id: "ada" }, body: { text: "moved" } });
		const copies: ChatRecord[] = [
			{ room_id: "general", log_id: 9, commit_ms: 9, kind: "message", record_json: json },
			{ room_id: "thread", log_id: 9, commit_ms: 9, kind: "message", record_json: json },
		];
		const text = await writeArchiveToString(async (writer) => {
			await writer.header(header);
			await writer.records(copies);
		});
		const archive = await collectArchive(jsonlReader(linesOf(text)));
		expect(archive.records).toEqual([copies[1]]);
	});

	it("enforces the header first and once", async () => {
		const lines: string[] = [];
		const writer = jsonlWriter(async (line) => void lines.push(line));
		await expect(writer.records(records)).rejects.toThrow(/before the header/);
		await expect(writer.close()).rejects.toThrow(/without a header/);
		await expect(writer.header({ apron_archive: 2 as 1 })).rejects.toThrow(/apron_archive: 1/);
		await writer.header(header);
		await expect(writer.header(header)).rejects.toThrow(/twice/);
		await expect(writer.extra("messages", [])).rejects.toThrow(/not an extra key/);
		await writer.close();
		await expect(writer.listing({ users: [] })).rejects.toThrow(/after close/);
		expect(lines).toEqual([`${JSON.stringify(header)}\n`]);
	});

	it("writes nothing for empty parts", async () => {
		const text = await writeArchiveToString(async (writer) => {
			await writer.header(header);
			await writer.listing({});
			await writer.records([]);
			await writer.extra("uploads", []);
		});
		expect(text).toBe(`${JSON.stringify(header)}\n`);
	});

	it("rejects records of an unknown kind", async () => {
		const writer = jsonlWriter(async () => {});
		await writer.header(header);
		await expect(writer.records([{ ...records[0], kind: "poll" }])).rejects.toThrow(/unknown kind "poll"/);
	});

	it("splits parts at the line cap, each line within it", async () => {
		expect(MAX_LINE_BYTES).toBe(256 * 1024);
		const many = Array.from({ length: 200 }, (_, i) =>
			record("message", "general", 1000 + i, { message_id: String(1000 + i), from: { user_id: "ada" }, body: { text: `message ${i} ${"é".repeat(40)}` } }));
		const cap = 2048;
		const text = await writeArchiveToString(async (writer) => {
			await writer.header(header);
			await writer.records(many);
			await writer.extra("blob", [{ text: "x".repeat(cap * 2) }]);
		}, { maxLineBytes: cap });
		const lines = text.split("\n").slice(1, -1);
		expect(lines.length).toBeGreaterThan(5);
		// Every line but the oversized single entry fits, newline included.
		for (const line of lines.slice(0, -1)) expect(utf8Length(line) + 1).toBeLessThanOrEqual(cap);
		expect(new TextEncoder().encode(lines[0]).length).toBe(utf8Length(lines[0]));
		expect(Object.keys(JSON.parse(lines[lines.length - 1]))).toEqual(["blob"]);
		const archive = await collectArchive(jsonlReader(linesOf(text)));
		expect(archive.records).toEqual(many);
		expect(archive.extras).toEqual([{ key: "blob", values: [{ text: "x".repeat(cap * 2) }] }]);
	});

	it("counts UTF-8 bytes as TextEncoder does", () => {
		for (const text of ["", "ascii", "é", "€", "👍🏽", "🏳️‍🌈", "a\ud800b", "\udc00"]) {
			expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length);
		}
	});
});

describe("jsonlReader tolerance (ARCHIVE.md §1)", () => {
	it("skips blank and non-object lines, accepts \\r\\n, ignores unknown keys", async () => {
		const text = [
			"",
			"   ",
			"not json",
			`${JSON.stringify(header)}`,
			"[1,2,3]",
			"42",
			"null",
			"\"a string\"",
			"{broken",
			JSON.stringify({ messages: [JSON.parse(records[2].record_json)], more: true, first_log_id: "102", live: { typing: [] } }),
			"",
			JSON.stringify({ users: [{ user_id: "ada" }], notes: "free text" }),
		].join("\r\n");
		const reader = jsonlReader(linesOf(text));
		expect(await reader.header()).toEqual(header);
		const parts: ArchivePart[] = [];
		for await (const part of reader.parts()) parts.push(part);
		expect(parts).toEqual([
			{ kind: "records", records: [records[2]] },
			{ kind: "listing", joined: [], not_joined: [], users: [{ user_id: "ada" }] },
		]);
	});

	it("skips invalid entries and keeps valid ones", async () => {
		const text = [
			JSON.stringify(header),
			JSON.stringify({
				rooms: [{ room_id: "general", log_id: "1" }, { room_id: "", log_id: "2" }, { room_id: "x", log_id: "abc" }, { log_id: "3" }, "room", null],
				messages: [{ room_id: "general", log_id: "4", message_id: "4" }, { room_id: "general", log_id: "5", message_id: "5", from: { user_id: "ada" } }],
				reactions: [{ room_id: "general", log_id: "6", reactions: [] }],
				memberships: [{ room_id: "general", log_id: "7", members: [] }, { room_id: "general", log_id: "8" }],
				joined: [{ room_id: "general" }, { title: "no id" }],
				users: [{ name: "no id" }, { user_id: "ada" }],
			}),
		].join("\n");
		const parts = await partsOf(text);
		expect(parts[0]).toEqual({ kind: "listing", joined: [{ room_id: "general" }], not_joined: [], users: [{ user_id: "ada" }] });
		expect(parts[1].kind === "records" && parts[1].records.map((r) => [r.kind, r.log_id])).toEqual([["room", 1], ["message", 5], ["membership", 7]]);
	});

	it("yields a line's listing before its records, then its extras", async () => {
		const text = `${JSON.stringify(header)}\n${JSON.stringify({ activity: [{ x: 1 }], rooms: [JSON.parse(records[0].record_json)], not_joined: [{ room_id: "ops" }] })}\n`;
		expect((await partsOf(text)).map((part) => part.kind)).toEqual(["listing", "records", "extra"]);
	});

	it("requires a v1 header", async () => {
		await expect(jsonlReader(linesOf("")).header()).rejects.toThrow(/no JSON object line/);
		await expect(jsonlReader(linesOf("\n\nnope\n")).header()).rejects.toThrow(/no JSON object line/);
		await expect(jsonlReader(linesOf(`{"rooms":[]}\n`)).header()).rejects.toThrow(/line 1 has no apron_archive/);
		await expect(jsonlReader(linesOf(`\n{"apron_archive":2}\n`)).header()).rejects.toThrow(/unsupported Apron archive version 2/);
		await expect(partsOf(`{"rooms":[]}\n`)).rejects.toThrow(/no apron_archive/);
		const reader = jsonlReader(linesOf(`${JSON.stringify(header)}\n`));
		reader.parts();
		expect(() => reader.parts()).toThrow(/once/);
	});
});

describe("wireToRecord and recordToWire", () => {
	it("convert between wire records and ChatRecords", () => {
		const wire = { message_id: "7", log_id: "9", room_id: "general", from: { user_id: "ada" }, body: { text: "x" } };
		const converted = wireToRecord("message", wire);
		expect(converted).toEqual({ room_id: "general", log_id: 9, commit_ms: 9, kind: "message", record_json: JSON.stringify(wire) });
		expect(recordToWire(converted!)).toEqual(wire);
		expect(wireToRecord("message", { ...wire, from: undefined })).toBeNull();
		expect(wireToRecord("room", { room_id: "general", log_id: "0" })).toBeNull();
		expect(wireToRecord("room", { room_id: "general", log_id: "9007199254740993" })).toBeNull();
		expect(wireToRecord("room", [])).toBeNull();
		// A stored record missing its IDs gets them from the row.
		expect(recordToWire({ room_id: "r", log_id: 3, commit_ms: 3, kind: "room", record_json: "{\"title\":\"T\"}" })).toEqual({ title: "T", room_id: "r", log_id: "3" });
	});
});

describe("line sources", () => {
	it("linesOf splits on \\n with or without a final newline", async () => {
		const collect = async (text: string) => {
			const out: string[] = [];
			for await (const line of linesOf(text)) out.push(line);
			return out;
		};
		expect(await collect("a\nb\r\n\nc")).toEqual(["a", "b\r", "", "c"]);
		expect(await collect("a\n")).toEqual(["a"]);
		expect(await collect("")).toEqual([]);
	});

	it("linesFromStream decodes UTF-8 and splits lines across chunk boundaries", async () => {
		const text = `${JSON.stringify(header)}\r\n${JSON.stringify({ messages: [{ message_id: "1", log_id: "1", room_id: "général", from: { user_id: "ada" }, body: { text: "👍🏽 é €" } }] })}\n\n`;
		const bytes = new TextEncoder().encode(text);
		for (const size of [1, 2, 3, 5, 7, 64, bytes.length]) {
			const chunks: Uint8Array[] = [];
			for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
			const lines: string[] = [];
			for await (const line of linesFromStream(streamOf(chunks))) lines.push(line);
			expect(lines).toEqual([JSON.stringify(header) + "\r", text.split("\n")[1], ""]);
			const archive = await collectArchive(jsonlReader(linesFromStream(streamOf(chunks))));
			expect(archive.header).toEqual(header);
			expect(JSON.parse(archive.records[0].record_json).body.text).toBe("👍🏽 é €");
			expect(archive.records[0].room_id).toBe("général");
		}
	});

	it("linesFromStream yields a last line without a newline", async () => {
		const lines: string[] = [];
		for await (const line of linesFromStream(streamOf([new TextEncoder().encode("a\nb")]))) lines.push(line);
		expect(lines).toEqual(["a", "b"]);
	});
});

describe("scene fixtures", () => {
	const names = Object.keys(sceneArchives).sort();

	it("are all present", () => {
		expect(names).toEqual(["agent", "homealone", "itcrowd", "piper", "rich", "team", "whosonfirst"]);
	});

	for (const name of names) {
		it(`${name} parses, with well-formed records, and survives a rewrite`, async () => {
			const text = sceneArchives[name];
			const archive = await collectArchive(jsonlReader(linesOf(text)));
			expect(archive.header.apron_archive).toBe(1);
			expect(archive.rooms.length).toBeGreaterThan(0);
			expect(archive.users.length).toBeGreaterThan(0);
			// Every wire record of the file was kept: none was invalid.
			let wireCount = 0;
			for (const line of text.split("\n").slice(1)) {
				if (!line.trim()) continue;
				const value = JSON.parse(line);
				for (const key of ["rooms", "messages", "reactions", "memberships"]) wireCount += value[key]?.length ?? 0;
			}
			expect(archive.records).toHaveLength(wireCount);
			const listed = new Set(archive.rooms.map((room) => room.listing.room_id));
			for (const chatRecord of archive.records) {
				const value = JSON.parse(chatRecord.record_json);
				expect(["room", "message", "reactions", "membership"]).toContain(chatRecord.kind);
				expect(chatRecord.log_id).toBe(Number(value.log_id));
				expect(chatRecord.commit_ms).toBe(chatRecord.log_id);
				expect(chatRecord.room_id).toBe(value.room_id);
				expect(listed.has(chatRecord.room_id)).toBe(true);
				if (chatRecord.kind === "message") {
					expect(typeof value.message_id).toBe("string");
					expect(typeof value.from.user_id).toBe("string");
					expect(Number(value.message_id)).toBeLessThanOrEqual(chatRecord.log_id);
				}
			}
			// Written again and read back, the same records, listings and users.
			const rewritten = await writeArchiveToString(async (writer) => {
				await writer.header(archive.header);
				await writer.listing({
					joined: archive.rooms.filter((room) => room.joined).map((room) => room.listing),
					not_joined: archive.rooms.filter((room) => !room.joined).map((room) => room.listing),
					users: archive.users,
				});
				await writer.records(archive.records);
				for (const extra of archive.extras) await writer.extra(extra.key, extra.values);
			});
			const again = await collectArchive(jsonlReader(linesOf(rewritten)));
			expect(again.records).toEqual(archive.records);
			expect(again.users).toEqual(archive.users);
			expect(new Set(again.rooms.map((room) => JSON.stringify(room)))).toEqual(new Set(archive.rooms.map((room) => JSON.stringify(room))));
			expect(again.extras).toEqual(archive.extras);
		});
	}
});
