/*
 * The reference model: one in-memory map of every record
 * committed, with /purge and /rename applied to all of it, against which a
 * real pipeline's reads are compared. The model runs that drive it are
 * fast-check command sequences (pipeline.test.ts).
 */

import { type ChatRecord, type HistoryOp, applyOps, byLog } from "../../src/history/records";

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
