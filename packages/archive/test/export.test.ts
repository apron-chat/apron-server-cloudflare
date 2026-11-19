import { describe, expect, it } from "vitest";
import { type ArchiveSource, exportArchive, isPrivateRoom } from "../src/export.ts";
import { jsonlWriter, readArchive } from "../src/format.ts";
import type { ChatRecord } from "../src/records.ts";
import type { ArchivedRoom, ArchivedUser } from "../src/types.ts";

const message = (log: number, room: string, from: string): ChatRecord => ({
	room_id: room, log_id: log, commit_ms: log, kind: "message",
	record_json: JSON.stringify({ room_id: room, log_id: String(log), message_id: String(log), from: { user_id: from }, body: { text: `m${log}` } }),
});

/** A source held in memory, paging each room's records two at a time. */
function memorySource(rooms: ArchivedRoom[], records: ChatRecord[], users: ArchivedUser[], floor?: number): ArchiveSource & { asked: string[][] } {
	const asked: string[][] = [];
	return {
		asked,
		rooms: async () => rooms,
		users: async (ids) => {
			asked.push([...ids]);
			return users.filter((user) => ids.includes(user.user_id));
		},
		async *records(roomId) {
			const own = records.filter((record) => record.room_id === roomId && record.log_id >= (floor ?? 0)).sort((a, b) => a.log_id - b.log_id);
			for (let start = 0; start < own.length; start += 2) yield own.slice(start, start + 2);
		},
		...(floor !== undefined ? { floor: async () => floor } : {}),
	};
}

async function exported(source: ArchiveSource, options: Parameters<typeof exportArchive>[2] = {}): Promise<{ text: string; report: Awaited<ReturnType<typeof exportArchive>> }> {
	const lines: string[] = [];
	const report = await exportArchive(source, jsonlWriter(async (line) => {
		lines.push(line);
	}), options);
	return { text: lines.join(""), report };
}

const rooms: ArchivedRoom[] = [
	{ listing: { room_id: "general", history_log_id: "5", members: [{ user_id: "ada" }] }, joined: false },
	{ listing: { room_id: "private_40", private: true, history_log_id: null }, joined: false },
	{ listing: { room_id: "later", history_log_id: "50" }, joined: false },
];
const records = [message(10, "general", "ada"), message(11, "general", "bob"), message(12, "general", "cy"), message(60, "later", "bob")];
const users: ArchivedUser[] = [{ user_id: "ada", name: "Ada" }, { user_id: "bob", name: "Bob" }, { user_id: "cy", name: "Cy" }];

describe("exportArchive", () => {
	it("writes the header, every room's listing, then records with the users each page names first", async () => {
		const source = memorySource(rooms, records, users);
		const { text, report } = await exported(source, { header: { server: "wss://here" }, exportedAt: "2026-01-01T00:00:00.000Z" });
		const archive = readArchive(text);
		expect(archive.header).toEqual({ apron_archive: 1, server: "wss://here", exported_at: "2026-01-01T00:00:00.000Z" });
		expect(archive.rooms.map((room) => room.listing.room_id)).toEqual(["general", "private_40", "later"]);
		expect(archive.records.map((record) => record.log_id)).toEqual([10, 11, 12, 60]);
		// Members first, then each page's new names, never a user twice.
		expect(source.asked).toEqual([["ada"], ["bob"], ["cy"]]);
		expect(report).toEqual({ rooms: 3, users: 3, records: 4, sections: ["history"] });
	});

	it("leaves private rooms out when asked, and keeps only the rooms asked for", async () => {
		expect(isPrivateRoom(rooms[1]!)).toBe(true);
		expect(isPrivateRoom({ listing: { room_id: "private_9" }, joined: false })).toBe(true);
		const { text } = await exported(memorySource(rooms, records, users), { privateRooms: false, roomIds: ["general", "private_40"] });
		expect(readArchive(text).rooms.map((room) => room.listing.room_id)).toEqual(["general"]);
	});

	it("clamps history_log_id to the source's floor, and keeps null", async () => {
		const { text } = await exported(memorySource(rooms, records, users, 30));
		const listed = Object.fromEntries(readArchive(text).rooms.map((room) => [room.listing.room_id, room.listing.history_log_id]));
		expect(listed).toEqual({ general: "30", private_40: null, later: "50" });
		const { text: unclamped } = await exported(memorySource(rooms, records, users));
		expect(readArchive(unclamped).rooms[0]!.listing.history_log_id).toBe("5");
	});

	it("passes each page through prepare", async () => {
		const { text } = await exported(memorySource(rooms, records, users), {
			prepare: async (page) => page.map((record) => ({ ...record, record_json: record.record_json.replace(/"m(\d+)"/, '"prepared $1"') })),
		});
		expect(readArchive(text).records.map((record) => JSON.parse(record.record_json).body.text)).toEqual(["prepared 10", "prepared 11", "prepared 12", "prepared 60"]);
	});
});
