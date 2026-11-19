/*
 * The reference model (PLAN §12.3) and its seeded generator: one in-memory
 * map of every record committed, with /purge and /rename applied to all of
 * it, against which a real pipeline's reads are compared. Also a small
 * seeded PRNG (no dependency): the seed is printed on failure, and
 * HISTORY_SEED replays one.
 */

import { type ChatRecord, type HistoryOp, applyOps, byLog } from "../../src/history/records";

/** mulberry32: a tiny seeded PRNG. */
export function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

export const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)];

/** Seeds to run: HISTORY_SEED alone when set, else `count` fixed ones. */
export function seeds(count: number, base = 1): number[] {
	const fixed = typeof process !== "undefined" ? process.env?.HISTORY_SEED : undefined;
	return fixed ? [Number(fixed)] : Array.from({ length: count }, (_, index) => base + index * 7919);
}

export class Model {
	private records = new Map<string, ChatRecord>();

	add(record: ChatRecord, alsoIn?: string): void {
		this.records.set(`${record.log_id}\u0000${record.room_id}`, record);
		if (alsoIn) this.records.set(`${record.log_id}\u0000${alsoIn}`, { ...record, room_id: alsoIn });
	}

	/**
	 * /purge or /rename. A purge knows a message's author only from records
	 * still held (from `floor` on), as the tiers do: a reaction can outlive
	 * the message it is on, and stays when that message's sender is purged.
	 */
	apply(op: HistoryOp, floor = 0): void {
		const held = this.all().filter((record) => record.log_id >= floor);
		const gone = this.all().filter((record) => record.log_id < floor);
		const next = [...gone, ...applyOps(held, [op])];
		this.records = new Map(next.map((record) => [`${record.log_id}\u0000${record.room_id}`, record]));
	}

	all(): ChatRecord[] {
		return [...this.records.values()].sort(byLog);
	}

	/** A room's records from `floor` on, in log order. */
	room(roomId: string, floor: number): ChatRecord[] {
		return this.all().filter((record) => record.room_id === roomId && record.log_id >= floor);
	}
}

/** Records as comparable strings. */
export const show = (records: readonly ChatRecord[]) => records.map((record) => `${record.room_id}@${record.log_id}:${record.record_json}`);
