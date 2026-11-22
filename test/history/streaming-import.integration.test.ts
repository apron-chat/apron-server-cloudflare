// The streaming import through the Store: a run that fails midway leaves
// its journal and the line it got to (`history:import_progress`), and a new
// Store over the same object goes on from there to the same result as an
// import never interrupted; a thread whose records come first in the file
// is restored after its parent, which is made first from its listing.
import { expect, it } from "vitest";
import { type ChatRecord, type ScanStats, textSource, writeArchiveToString } from "@apron/archive";
import { importArchive } from "../../src/history/archive/import";
import { archiveChain } from "../../src/history/config";
import { type Store, type StoreConfig, openStore } from "../../src/store";
import { withStore } from "../helpers/store";
import { sqliteOf } from "../../src/store/open";

const CONFIG: Partial<StoreConfig> = {
	guestPostsPerMinute: 1_000, registeredPostsPerMinute: 1_000, trustedPostsPerMinute: 1_000,
	ipPostsPerMinute: 1_000, globalPostsPerMinute: 1_000, registrationsPerIpDay: 1_000, registrationsPerDay: 1_000,
};
const LIMITS = { historyHotRecords: 5_000, historyMaxAgeSeconds: 0, historyD1Records: 0, historyColdRecords: 0, cleanupThresholdPercent: 80 };

/** Two rooms and a thread of `lobby`, the thread's records first in the file (its parent's start later), many records to a line. */
async function archiveText(base: number): Promise<string> {
	const message = (roomId: string, logId: number): ChatRecord => ({
		room_id: roomId, log_id: logId, commit_ms: logId, kind: "message",
		record_json: JSON.stringify({ message_id: String(logId), log_id: String(logId), room_id: roomId, from: { user_id: `user-${logId % 7}`, name: "U" }, body: { text: `m${logId}` } }),
	});
	const thread = String(base + 1);
	const groups: Record<string, ChatRecord[]> = { [thread]: [], lobby: [], random: [] };
	for (let at = 0; at < 1_500; at += 1) {
		const roomId = at % 3 === 0 ? thread : at % 3 === 1 ? "random" : "lobby";
		groups[roomId]!.push(message(roomId, base + 10 + at));
	}
	return writeArchiveToString(async (writer) => {
		await writer.header({ apron_archive: 1, server: "wss://elsewhere.test/" });
		await writer.listing({ not_joined: [{ room_id: "lobby", log_id: String(base) }, { room_id: "random", log_id: String(base) }, { room_id: thread, parent_room_id: "lobby", log_id: String(base + 1) }] });
		for (const roomId of [thread, "random", "lobby"]) await writer.records(groups[roomId]!);
	}, { maxLineBytes: 16 * 1024 });
}

/** The records, rooms and message states an import left (the store's own general aside, made at its clock). */
function contents(state: DurableObjectState): { records: unknown[]; rooms: unknown[]; messages: unknown[] } {
	return {
		records: state.storage.sql.exec("SELECT room_id, log_id, kind, record_json FROM records WHERE kind <> 'membership' AND room_id <> 'general' ORDER BY log_id, room_id").toArray(),
		rooms: state.storage.sql.exec("SELECT room_id, parent_room_id, created_log_id, latest_log_id FROM rooms WHERE room_id <> 'general' ORDER BY room_id").toArray(),
		messages: state.storage.sql.exec("SELECT message_id, room_id, author_id FROM message_state ORDER BY message_id").toArray(),
	};
}

it("goes on from the line it got to in a new Store after a failure midway, to what an import never interrupted leaves, its thread after its parent", async () => {
	const base = Date.now() - 600_000;
	const text = await archiveText(base);
	const expected = await withStore("stream-reference", CONFIG, async (store, clock, state) => {
		const report = await importArchive(archiveChain(undefined, { store: store.history, limits: LIMITS, clock: clock.clock }), store.history.restore(), textSource(text), { clock: clock.clock });
		expect(report).toMatchObject({ records: 1_500, rejected: 0 });
		return contents(state);
	});
	await withStore("stream-resume", CONFIG, async (store, clock, state) => {
		const restore = store.history.restore();
		let calls = 0;
		const failing = { ...restore, restoreRoom: async (...args: Parameters<typeof restore.restoreRoom>) => {
			calls += 1;
			if (calls === 9) throw new Error("injected failure");
			return restore.restoreRoom(...args);
		} };
		const options = { clock: clock.clock, checkpoint: 250, batch: 100 };
		await expect(importArchive(archiveChain(undefined, { store: store.history, limits: LIMITS, clock: clock.clock }), failing, textSource(text), options)).rejects.toThrow("injected failure");
		expect(store.history.importJournal()).toBeDefined();
		const saved = JSON.parse(sqliteOf(store).historyLog.historyImportProgress()!) as { line: number; offset: number; entry: number };
		expect(saved.entry).toBeGreaterThan(0);

		// A new Store over the same object, as after a restart.
		const again = openStore(state, CONFIG, clock.clock);
		again.lifecycle.initialize();
		const stats: ScanStats = { skipped: 0, scanned: 0 };
		const report = await importArchive(archiveChain(undefined, { store: again.history, limits: LIMITS, clock: clock.clock }), again.history.restore(), textSource(text), { ...options, stats });
		expect(report).toMatchObject({ resumed: true, records: 1_500 });
		expect(stats.skipped).toBe(saved.offset);
		expect(again.history.importJournal()).toBeUndefined();
		expect(sqliteOf(again).historyLog.historyImportProgress()).toBeUndefined();
		const got = contents(state);
		expect(got.rooms).toContainEqual(expect.objectContaining({ room_id: String(base + 1), parent_room_id: "lobby" }));
		expect(got).toEqual(expected);
	});
});
