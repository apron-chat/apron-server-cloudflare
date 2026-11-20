/*
 * The reference model: one in-memory map of every record committed, with
 * /purge and /rename applied as the chain applies them, against which a
 * real chain's reads are compared. The model runs that drive it are
 * fast-check command sequences (chain.test.ts).
 */

import { type ChatRecord, type Rewrite, byLog, rewritten } from "../../src/history/records";

export class Model {
	private records = new Map<string, ChatRecord>();

	add(record: ChatRecord, alsoIn?: string): void {
		this.records.set(`${record.log_id}\u0000${record.room_id}`, record);
		if (alsoIn) this.records.set(`${record.log_id}\u0000${alsoIn}`, { ...record, room_id: alsoIn });
	}

	/**
	 * /purge or /rename, applied to the records still held (from `floor` on)
	 * but those `kept`: a tier that takes no rewrites (the cold tier) keeps
	 * what it holds as it was. A purge knows a message's author only from
	 * the records it rewrites, as the tiers do: a reaction can outlive the
	 * message it is on, and stays when that message's sender is purged.
	 */
	apply(rewrite: Rewrite, options: { floor?: number; kept?: (record: ChatRecord) => boolean } = {}): void {
		const floor = options.floor ?? 0;
		const kept = options.kept ?? (() => false);
		const reached = this.all().filter((record) => record.log_id >= floor && !kept(record));
		const left = this.all().filter((record) => record.log_id < floor || kept(record));
		const next = [...left, ...rewritten(reached, [rewrite])];
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
