import { describe, expect, it } from "vitest";
import { type ArchiveSource, MAX_LISTING_MEMBER_BYTES, MAX_LISTING_MEMBERS, boundedMembers, exportArchive, isPrivateRoom } from "../src/export.ts";
import { MAX_READ_LINE_BYTES, jsonlWriter, readArchive } from "../src/format.ts";
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
	it("writes a move once, though both rooms' histories serve it", async () => {
		const moved = { ...message(30, "general", "ada"), record_json: JSON.stringify({ room_id: "later", log_id: "30", message_id: "10", prev_log_id: "10", prev_room_id: "general", from: { user_id: "ada" }, body: { text: "moved" } }) };
		const both: ArchivedRoom[] = [{ listing: { room_id: "general" }, joined: false }, { listing: { room_id: "later" }, joined: false }];
		// The source serves the move in both rooms' histories, as a server does.
		const source = memorySource(both, [message(10, "general", "ada"), moved, { ...moved, room_id: "later" }], users);
		const all = readArchive((await exported(source)).text);
		expect(all.records.filter((record) => record.log_id === 30).map((record) => record.room_id)).toEqual(["later"]);
		// Either room alone still has it.
		for (const roomIds of [["general"], ["later"]]) {
			const one = readArchive((await exported(source, { roomIds })).text);
			expect(one.records.filter((record) => record.log_id === 30)).toHaveLength(1);
		}
	});

	it("writes the header, every room's listing, then records with the users each page names first", async () => {
		const source = memorySource(rooms, records, users);
		const { text, report } = await exported(source, { header: { server: "wss://here" }, exportedAt: "2026-01-01T00:00:00.000Z" });
		const archive = readArchive(text);
		expect(archive.header).toEqual({ apron_archive: 1, server: "wss://here", exported_at: "2026-01-01T00:00:00.000Z" });
		expect(archive.rooms.map((room) => room.listing.room_id)).toEqual(["general", "private_40", "later"]);
		expect(archive.records.map((record) => record.log_id)).toEqual([10, 11, 12, 60]);
		// Members first, then each page's new names, never a user twice.
		expect(source.asked).toEqual([["ada"], ["bob"], ["cy"]]);
		expect(report).toEqual({ rooms: 3, users: 3, records: 4, truncated: [], sections: ["history"] });
	});

	it("leaves private rooms out when asked, keeps only the rooms asked for, and passes each page through prepare", async () => {
		expect(isPrivateRoom(rooms[1]!)).toBe(true);
		expect(isPrivateRoom({ listing: { room_id: "private_9" }, joined: false })).toBe(true);
		const { text } = await exported(memorySource(rooms, records, users), { privateRooms: false, roomIds: ["general", "private_40"] });
		expect(readArchive(text).rooms.map((room) => room.listing.room_id)).toEqual(["general"]);
		const { text: prepared } = await exported(memorySource(rooms, records, users), {
			prepare: async (page) => page.map((record) => ({ ...record, record_json: record.record_json.replace(/"m(\d+)"/, '"prepared $1"') })),
		});
		expect(readArchive(prepared).records.map((record) => JSON.parse(record.record_json).body.text)).toEqual(["prepared 10", "prepared 11", "prepared 12", "prepared 60"]);
	});

	it("clamps history_log_id to the source's floor, and keeps null", async () => {
		const { text } = await exported(memorySource(rooms, records, users, 30));
		const listed = Object.fromEntries(readArchive(text).rooms.map((room) => [room.listing.room_id, room.listing.history_log_id]));
		expect(listed).toEqual({ general: "30", private_40: null, later: "50" });
		const { text: unclamped } = await exported(memorySource(rooms, records, users));
		expect(readArchive(unclamped).rooms[0]!.listing.history_log_id).toBe("5");
	});

	it("bounds a listing's members: user ID order, at most the cap and within one line's bytes, member_count the true count, the truncation reported", async () => {
		const members = ["cy", "ada", "bob", "dee", "eve"].map((user_id) => ({ user_id }));
		const big: ArchivedRoom[] = [{ listing: { room_id: "big", log_id: "1", members, member_count: 7 }, joined: false }, { listing: { room_id: "small", log_id: "2", members: [{ user_id: "zed" }] }, joined: false }];
		const { text, report } = await exported(memorySource(big, [], []), { maxMembers: 3 });
		const listed = Object.fromEntries(readArchive(text).rooms.map((room) => [room.listing.room_id, room.listing]));
		expect(listed.big).toMatchObject({ members: [{ user_id: "ada" }, { user_id: "bob" }, { user_id: "cy" }], member_count: 7 });
		expect(listed.small).toMatchObject({ members: [{ user_id: "zed" }], member_count: 1 });
		expect(report.truncated).toEqual([{ room_id: "big", members: 7, kept: 3 }]);
		// A listing without members stays without.
		expect(boundedMembers({ room_id: "none" })).toEqual({ listing: { room_id: "none" } });
		// Within the bytes a reader takes on one line, whatever their IDs.
		const long = Array.from({ length: MAX_LISTING_MEMBERS }, (_, index) => ({ user_id: `${String(index).padStart(5, "0")}${"x".repeat(251)}` }));
		const { listing, truncated } = boundedMembers({ room_id: "wide", members: long });
		const bytes = new TextEncoder().encode(JSON.stringify(listing.members)).length;
		expect(bytes).toBeLessThanOrEqual(MAX_LISTING_MEMBER_BYTES);
		expect(truncated).toMatchObject({ members: MAX_LISTING_MEMBERS });
		expect(truncated!.kept).toBeLessThan(MAX_LISTING_MEMBERS);
		// IDs of 64 bytes, the longest this server issues: the count bounds them, and the line fits.
		const issued = Array.from({ length: MAX_LISTING_MEMBERS + 5 }, (_, index) => ({ user_id: `${String(index).padStart(6, "0")}${"y".repeat(58)}` }));
		const bounded = boundedMembers({ room_id: "full", title: "t".repeat(8 * 1024), members: issued });
		expect(bounded.truncated).toEqual({ room_id: "full", members: MAX_LISTING_MEMBERS + 5, kept: MAX_LISTING_MEMBERS });
		expect(new TextEncoder().encode(JSON.stringify(bounded.listing)).length).toBeLessThan(MAX_READ_LINE_BYTES);
	});
});
