/*
 * The HistoryTier conformance suite: what every tier must do,
 * whatever it keeps records in. Run on MemoryHistoryTier, the D1 tier, and
 * ColdHistoryTier over MemoryBlobStore and R2 (test/history/tiers.test.ts).
 *
 * Records are written as valid wire records (an archive drops invalid ones),
 * with `commit_ms` equal to `log_id`, as the cold tier reads them back. The
 * tests of retention and trimming append one record at a time, so a tier
 * that keeps whole chunks (the cold tier) keeps one record per chunk and
 * its floors fall where a per-record tier's do. Stats are compared without
 * moves, since a per-record tier counts log IDs and the cold tier each
 * room's copy.
 *
 * The caller passes its `describe`, `it` and `expect`, as for the BlobStore
 * suite (conformance/blob-store.ts).
 */

import type { ChatRecord, RecordKind } from "../../../src/history/records";
import { limitByLogId, toRange } from "../../../src/history/records";
import type { HistoryTier } from "../../../src/history/tier";

export interface Expect {
	(actual: unknown): {
		toBe(expected: unknown): void;
		toEqual(expected: unknown): void;
		toBeUndefined(): void;
		toBeLessThanOrEqual(expected: number): void;
		toBeGreaterThanOrEqual(expected: number): void;
	};
}

export interface Runner {
	describe(name: string, body: () => void): void;
	it(name: string, body: () => Promise<void>, timeoutMs?: number): void;
	expect: Expect;
}

const ada = { user_id: "ada", name: "Ada" };
const bob = { user_id: "bob", name: "Bob" };

/** A valid wire record of `kind` in `roomId` at `logId`, stored in `storedIn` (a move's copy). */
export function wireRecord(kind: RecordKind, roomId: string, logId: number, fields: Record<string, unknown> = {}, storedIn = roomId): ChatRecord {
	const base: Record<string, unknown> = { room_id: roomId, log_id: String(logId) };
	if (kind === "message") Object.assign(base, { message_id: String(logId), from: ada, body: { text: `message ${logId}` } });
	if (kind === "reactions") Object.assign(base, { message_id: String(logId - 1), reactions: [{ from: bob, emojis: ["👍"] }] });
	if (kind === "membership") Object.assign(base, { members: [{ user: bob, joined: true }] });
	if (kind === "room") Object.assign(base, { title: `Room ${roomId}` });
	return { room_id: storedIn, log_id: logId, commit_ms: logId, kind, record_json: JSON.stringify({ ...base, ...fields }) };
}

/** Two rooms' log with every kind, and a move from `a` to `b` (one log ID, both rooms' copies). */
export function sampleLog(): ChatRecord[] {
	const move = { message_id: "1003", from: ada, prev_room_id: "a", prev_log_id: "1003", body: { text: "moved" } };
	return [
		wireRecord("room", "a", 1001),
		wireRecord("room", "b", 1002),
		wireRecord("message", "a", 1003),
		wireRecord("message", "b", 1004),
		wireRecord("reactions", "a", 1005, { message_id: "1003" }),
		wireRecord("membership", "a", 1006),
		wireRecord("message", "a", 1007),
		wireRecord("message", "b", 1008, move, "a"),
		wireRecord("message", "b", 1008, move),
		wireRecord("message", "b", 1009),
		wireRecord("message", "a", 1010, { message_id: "1007", prev_log_id: "1007", body: { text: "edited" } }),
		wireRecord("message", "a", 1011),
		wireRecord("message", "b", 1012),
	].sort((x, y) => x.log_id - y.log_id || (x.room_id < y.room_id ? -1 : 1));
}

/** One room's messages at `ids`. */
function messages(ids: readonly number[]): ChatRecord[] {
	return ids.map((id) => wireRecord("message", "a", id));
}

const TEN = Array.from({ length: 10 }, (_, index) => (index + 1) * 1000);

async function appendEach(tier: HistoryTier, records: readonly ChatRecord[]): Promise<void> {
	for (const record of records) await tier.append(toRange([record]));
}

async function appendInBatches(tier: HistoryTier, records: readonly ChatRecord[], size: number): Promise<void> {
	const ids = [...new Set(records.map((record) => record.log_id))];
	for (let index = 0; index < ids.length; index += size) {
		const batch = new Set(ids.slice(index, index + size));
		await tier.append(toRange(records.filter((record) => batch.has(record.log_id))));
	}
}

export function describeHistoryTier(name: string, makeTier: () => HistoryTier | Promise<HistoryTier>, runner: Runner): void {
	const { describe, it, expect } = runner;
	describe(`HistoryTier conformance: ${name}`, () => {
		it("is empty at first", async () => {
			const tier = await makeTier();
			expect((await tier.scan(0, 10)).records).toEqual([]);
			if (tier.read) expect(await tier.read({ roomIds: ["a"], lower: 1, upper: Number.MAX_SAFE_INTEGER, forward: false, limit: 10 })).toEqual([]);
			expect((await tier.stats()).records).toBe(0);
			expect(await tier.floorFor({ records: 1, thresholdPercent: 100 }, { now: 0, below: Infinity })).toBeUndefined();
			expect(await tier.trimBelow(Number.MAX_SAFE_INTEGER, 10)).toBe(0);
		});

		it("appends idempotently, with INSERT OR REPLACE semantics", async () => {
			const tier = await makeTier();
			const log = sampleLog();
			await appendInBatches(tier, log, 4);
			await appendInBatches(tier, log, 4);
			await tier.append(toRange(log));
			expect((await tier.scan(0, 100)).records).toEqual(log);
			// A record appended again with new content replaces the old.
			const replaced = wireRecord("message", "a", 1007, { body: { text: "replaced" } });
			await tier.append(toRange([replaced]));
			const after = (await tier.scan(0, 100)).records;
			expect(after.length).toBe(log.length);
			expect(after.find((record) => record.log_id === 1007)).toEqual(replaced);
		});

		it("scans oldest first, by distinct log ID, every room's copy", async () => {
			const tier = await makeTier();
			const log = sampleLog();
			await appendInBatches(tier, log, 3);
			for (const [from, limit] of [[0, 1], [0, 8], [1004, 4], [1008, 1], [1008, 2], [1009, 100], [1013, 5]] as const) {
				const range = await tier.scan(from, limit);
				const expected = limitByLogId(log.filter((record) => record.log_id >= from), limit, true);
				expect(range.records).toEqual(expected);
				if (expected.length) {
					expect(range.first).toBe(expected[0].log_id);
					expect(range.last).toBe(expected[expected.length - 1].log_id);
				}
			}
		});

		it("reads windows of one room or several, forward and backward, bounds inclusive, a page counted by log ID", async () => {
			const tier = await makeTier();
			if (!tier.read) return;
			const log = sampleLog();
			await appendInBatches(tier, log, 2);
			// Both rooms at once: the move at 1008 is two rows but one place in a page (a page left short of it would end history early).
			for (const rooms of [["a"], ["b"], ["a", "b"]]) {
				for (const [lower, upper, limit] of [[1, Number.MAX_SAFE_INTEGER, 100], [1003, 1008, 100], [1003, 1008, 2], [1007, 1009, 2], [1008, 1008, 1], [1, 1007, 3], [1012, 1012, 5], [1013, 2000, 5]] as const) {
					for (const forward of [true, false]) {
						const got = await tier.read({ roomIds: rooms, lower, upper, forward, limit });
						const expected = limitByLogId(log.filter((record) => rooms.includes(record.room_id) && record.log_id >= lower && record.log_id <= upper), limit, forward);
						expect([rooms, lower, upper, limit, forward, got]).toEqual([rooms, lower, upper, limit, forward, expected]);
					}
				}
			}
			// The move is in each room's page, in that room.
			const moved = await tier.read({ roomIds: ["a"], lower: 1008, upper: 1008, forward: true, limit: 1 });
			expect(moved.map((record) => record.room_id)).toEqual(["a"]);
		});

		it("looks records up by log ID, in any room", async () => {
			const tier = await makeTier();
			if (!tier.lookup) return;
			const log = sampleLog();
			await appendInBatches(tier, log, 5);
			expect(await tier.lookup([1008, 1003, 4242])).toEqual(log.filter((record) => record.log_id === 1003 || record.log_id === 1008));
			expect(await tier.lookup([])).toEqual([]);
		});

		it("finds its floor by count, counting only below the tier above", async () => {
			const tier = await makeTier();
			await appendEach(tier, messages(TEN));
			expect(await tier.floorFor({ records: 4, thresholdPercent: 100 }, { now: 0, below: Infinity })).toBe(7000);
			expect(await tier.floorFor({ records: 4, thresholdPercent: 50 }, { now: 0, below: Infinity })).toBe(9000);
			expect(await tier.floorFor({ records: 4, thresholdPercent: 100 }, { now: 0, below: 9000 })).toBe(5000);
			expect(await tier.floorFor({ records: 20, thresholdPercent: 100 }, { now: 0, below: Infinity })).toBeUndefined();
			expect(await tier.floorFor({ thresholdPercent: 100 }, { now: 0, below: Infinity })).toBeUndefined();
		});

		it("finds its floor by age", async () => {
			const tier = await makeTier();
			await appendEach(tier, messages(TEN));
			expect(await tier.floorFor({ ageMs: 5_500, thresholdPercent: 100 }, { now: 10_000, below: Infinity })).toBe(5000);
			expect(await tier.floorFor({ ageMs: 1_000, thresholdPercent: 100 }, { now: 100_000, below: Infinity })).toBe(10_001);
		});

		it("trims below a floor in bounded batches, idempotently", async () => {
			const tier = await makeTier();
			await appendEach(tier, messages(TEN));
			expect(await tier.trimBelow(6000, 3)).toBe(3);
			expect((await tier.scan(0, 1)).records[0].log_id).toBe(4000);
			expect(await tier.trimBelow(6000, 10)).toBe(2);
			expect(await tier.trimBelow(6000, 10)).toBe(0);
			expect((await tier.scan(0, 100)).records).toEqual(messages(TEN.slice(5)));
			expect(await tier.trimBelow(1, 10)).toBe(0);
		});

		it("reports stats consistent with what it holds", async () => {
			const tier = await makeTier();
			const records = [...messages(TEN.slice(0, 5)), ...TEN.slice(5).map((id) => wireRecord("message", "b", id))];
			await appendInBatches(tier, records, 3);
			const stats = await tier.stats();
			expect([stats.records, stats.oldest, stats.newest]).toEqual([10, 1000, 10_000]);
			expect((await tier.stats({ lower: 10_001 })).records).toBe(0);
			const bounded = await tier.stats({ lower: 3000, upper: 7000 });
			expect(bounded.records).toBeLessThanOrEqual(10);
			expect(bounded.oldest ?? 3000).toBeGreaterThanOrEqual(3000);
			expect(bounded.newest ?? 7000).toBeLessThanOrEqual(7000);
			await tier.trimBelow(6000, 100);
			expect((await tier.stats()).records).toBe(5);
		});
	});
}
