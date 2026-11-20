import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type ChatRecord, compareReplayed, namedUsers, remapRecord, replayRecords, IdMap } from "@apron/archive";
import { sceneArchives } from "../../packages/archive/test/fixtures/scenes";
import { idMapOf, normalizeIn, roundTrip } from "./support/roundtrip";

// The scene round trip (test/history/support/roundtrip.ts): each archive is
// imported into a fresh server, exported, imported into another fresh
// server, and exported again, all through the real /history import and
// export paths. Then:
//
// 1. Fixed point: the second export is the first, line for line, but for
//    the header's `exported_at`. After one trip through this server, an
//    archive goes round unchanged.
// 2. The two servers hold the same state (replayed from their exports).
// 3. The first trip keeps everything but the transformations in
//    FIRST_TRIP below, each checked for what it is.
//
// The scenes are packages/archive/test/fixtures/scenes/, and any files
// `npm run roundtrip -- <file or scene directory>...` names
// (scripts/roundtrip.mjs; ROUNDTRIP_SCENES in vitest.config.ts).

/** What a first trip may change, and nothing else. */
const FIRST_TRIP = {
	"header": "The header names this server (`server`: its WebSocket URL, `media`: its origins); a scene's own header fields (`title`, `description`, `avatar`, `you`, `room`) are not kept.",
	"extensions": "A scene's extension lines (`activity`, `live`) are not stored, so not exported.",
	"presence": "Users' presence (`status`, `seen`) is not imported.",
	"users unnamed": "A user no record names (a scene's reader, `you`) gets a placeholder, but no record names it, so it is not exported.",
	"listing members": "Members a listing names without a membership record are not joined: memberships come from records.",
	"server rooms": "The importing server's own rooms (a fresh server's `general`) are in its export; an archive's `general` fills it instead.",
	"users made bare": "A record's recorded users (`from`, reaction sets' `from`, members' `user`) keep `user_id` and `name` only: roles and the like are this server's to say.",
	"embeds defaulted": "Content policy: a message body without `embeds` gets `embeds: []`, as a post's does.",
	"format defaulted": "Content policy: a body without `format` gets `plain`.",
	"og media dropped": "Content policy: link-preview media (`og.image`, `og.audio`, `og.video`) on hosts this server does not serve media from is dropped.",
	"ids remapped": "User and log IDs that cannot stand here are remapped (the import's report names them).",
} as const;
type Transformation = keyof typeof FIRST_TRIP;

/** Paths where two JSON values differ: added, removed or changed. */
function differences(a: unknown, b: unknown, path = ""): Array<{ path: string; change: "added" | "removed" | "changed" }> {
	const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
	if (isObject(a) && isObject(b) && Array.isArray(a) === Array.isArray(b)) {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		return [...keys].flatMap((key) => {
			const at = path ? `${path}.${key}` : key;
			if (!(key in a)) return [{ path: at, change: "added" as const }];
			if (!(key in b)) return [{ path: at, change: "removed" as const }];
			return differences(a[key], b[key], at);
		});
	}
	return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, change: "changed" }];
}

/** What the content policy did to a record, by FIRST_TRIP name; anything else as `unexplained: <path>`. */
function policyChanges(before: ChatRecord, after: ChatRecord): string[] {
	return differences(JSON.parse(before.record_json), JSON.parse(after.record_json)).map(({ path, change }) => {
		if (/^(from|reactions\.\d+\.from|members\.\d+\.user)\.(?!user_id$|name$)[^.]+$/.test(path) && change === "removed") return "users made bare";
		if (path === "body.embeds" && change === "added") return "embeds defaulted";
		if (path === "body.format" && change === "added") return "format defaulted";
		if (/^body\.embeds\.\d+\.og\.(image|audio|video)$/.test(path) && change === "removed") return "og media dropped";
		return `unexplained: ${change} ${path}`;
	});
}

/** The scenes this run takes: the fixtures (unless ROUNDTRIP_ONLY), and the files ROUNDTRIP_SCENES names. */
function scenes(): Array<[string, string]> {
	const bindings = env as unknown as { ROUNDTRIP_SCENES?: string; ROUNDTRIP_ONLY?: string };
	const extra = bindings.ROUNDTRIP_SCENES ? Object.entries(JSON.parse(bindings.ROUNDTRIP_SCENES) as Record<string, string>) : [];
	return [...(bindings.ROUNDTRIP_ONLY === "true" ? [] : Object.entries(sceneArchives).map(([name, text]): [string, string] => [`fixture-${name}`, text])), ...extra];
}

describe("scene round trip: import, export, import, export", () => {
	for (const [name, text] of scenes()) {
		it(`${name}: a fixed point after one trip, and the first trip loses only what FIRST_TRIP says`, async () => {
			const run = name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
			const trip = await roundTrip(run, text);
			const { scene, first, second } = trip;
			const applied = new Map<Transformation, number>();
			const note = (what: Transformation, count = 1) => { if (count) applied.set(what, (applied.get(what) ?? 0) + count); };

			// The imports: nothing refused, duplicated or collided.
			for (const report of [first.report, second.report]) {
				expect(report, name).toMatchObject({ rejected: 0, duplicates: 0, collisions: 0, expired: 0, references: 0, dryRun: false });
			}

			// 1. Fixed point: the second export is the first, but for when it was made.
			const lines = (snapshot: typeof first.export) => snapshot.text.split("\n").filter(Boolean);
			const [firstHeader, ...firstRest] = lines(first.export);
			const [secondHeader, ...secondRest] = lines(second.export);
			const { exported_at: _a, ...headerOne } = JSON.parse(firstHeader!) as Record<string, unknown>;
			const { exported_at: _b, ...headerTwo } = JSON.parse(secondHeader!) as Record<string, unknown>;
			expect(headerTwo).toEqual(headerOne);
			expect(secondRest).toEqual(firstRest);
			// The second import changed nothing it was given.
			expect(second.report.remapped).toEqual({ logIds: {}, users: {} });
			for (const [userId, target] of Object.entries(second.report.users)) expect(target, userId).toEqual({ placeholder: userId });

			// 2. The two servers hold the same state.
			expect(compareReplayed(first.export.state, second.export.state, { idMap: idMapOf(second.report) }).differences).toEqual([]);

			// 3. The first trip, against the scene.
			// The header names this server; the scene's own fields are not kept.
			expect(Object.keys(headerOne).sort()).toEqual(["apron_archive", "media", "server"]);
			expect(headerOne).toMatchObject({ apron_archive: 1, server: "wss://demo.test/" });
			if (Object.keys(scene.archive.header).some((key) => !["apron_archive", "exported_at"].includes(key))) note("header");
			// Extension lines and presence are not kept.
			expect(first.export.archive.extras).toEqual([]);
			expect(first.export.archive.fields).toEqual([]);
			note("extensions", scene.archive.extras.length + scene.archive.fields.length);
			for (const user of first.export.archive.users) expect(Object.keys(user), user.user_id).not.toContain("status");
			note("presence", scene.archive.users.filter((user) => "status" in user || "seen" in user).length);
			const map = idMapOf(first.report);
			note("ids remapped", Object.keys(first.report.remapped.logIds).length + Object.keys(first.report.remapped.users).length);

			// The records the server took: the scene's, through its content policy, each change named.
			const normalized = await normalizeIn(`roundtrip-${run}-a`, scene.archive.records);
			const unexplained: string[] = [];
			const taken: ChatRecord[] = [];
			scene.archive.records.forEach((record, index) => {
				const after = normalized[index];
				expect(after, `record ${record.log_id} refused by the content policy`).not.toBeNull();
				for (const change of policyChanges(record, after!)) {
					if (change.startsWith("unexplained")) unexplained.push(`${record.kind} ${record.log_id} in ${record.room_id}: ${change}`);
					else note(change as Transformation);
				}
				taken.push(after!);
			});
			expect(unexplained).toEqual([]);

			// What the first export should hold: those records, the listings without members only
			// they name, and the users some record names, remapped as the import's report says.
			const idMap = new IdMap(new Map(Object.entries(first.report.remapped.logIds).map(([from, to]) => [Number(from), Number(to)])), new Map(Object.entries(first.report.remapped.users)));
			const records = taken.map((record) => remapRecord(record, idMap));
			const listings = scene.archive.rooms.map((room) => {
				const { members, ...rest } = room.listing;
				if (Array.isArray(members) && members.length) note("listing members");
				return { ...room, listing: rest };
			});
			const named = new Set(scene.archive.records.flatMap((record) => namedUsers(record)));
			const users = scene.archive.users.filter((user) => named.has(user.user_id));
			note("users unnamed", scene.archive.users.length - users.length);
			const expected = replayRecords(records, listings, users.map((user) => ({ ...user, user_id: idMap.userId(user.user_id) })));
			// The server's own rooms the scene does not have.
			const sceneRooms = new Set(scene.archive.rooms.map((room) => map.roomId?.(room.listing.room_id) ?? room.listing.room_id));
			const own = [...first.export.state.rooms.keys()].filter((roomId) => !sceneRooms.has(roomId));
			expect(own, "rooms of the server's own").toEqual(sceneRooms.has("general") ? [] : ["general"]);
			note("server rooms", own.length);
			const exported = { ...first.export.state, rooms: new Map([...first.export.state.rooms].filter(([roomId]) => sceneRooms.has(roomId))) };
			expect(compareReplayed(expected, exported).differences).toEqual([]);

			// Every change the trip made is one FIRST_TRIP names (a typo in a name would fail here).
			for (const what of applied.keys()) expect(Object.keys(FIRST_TRIP)).toContain(what);
		}, 120_000);
	}
});
