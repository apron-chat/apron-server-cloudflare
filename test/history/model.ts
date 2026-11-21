/*
 * The reference model: one in-memory map of every record committed, with
 * /purge and /rename applied as the chain applies them, against which a
 * real chain's reads are compared. The model runs that drive it are
 * fast-check command sequences (chain.test.ts).
 */

import { type ChatRecord, type Rewrite, authoredMessages, byLog, rewritten, withKept } from "../../src/history/records";

export class Model {
	private records = new Map<string, ChatRecord>();

	add(record: ChatRecord, alsoIn?: string): void {
		this.records.set(`${record.log_id}\u0000${record.room_id}`, record);
		if (alsoIn) this.records.set(`${record.log_id}\u0000${alsoIn}`, { ...record, room_id: alsoIn });
	}

	/**
	 * /purge or /rename, applied to the records still held (from `floor` on).
	 * The tiers that take rewrites rewrite what they hold: a purge knows a
	 * message's author only from the records it rewrites, as the tiers do, so
	 * a reaction can outlive the message it is on, and stays when that
	 * message's sender is purged. What a tier that takes none (the cold tier)
	 * serves (`kept`) has the rewrite applied record by record when it is
	 * read (withKept), the purge naming the messages the tiers above found.
	 */
	apply(rewrite: Rewrite, options: { floor?: number; kept?: (record: ChatRecord) => boolean } = {}): void {
		const floor = options.floor ?? 0;
		const kept = options.kept ?? (() => false);
		const reached = this.all().filter((record) => record.log_id >= floor && !kept(record));
		const held = this.all().filter((record) => record.log_id >= floor && kept(record));
		const expired = this.all().filter((record) => record.log_id < floor);
		const messages = rewrite.into === null ? [...new Set([...(rewrite.messages ?? []), ...authoredMessages(reached, [rewrite.user])])] : undefined;
		const read = withKept(held, [{ first: 0, seq: 0, through: Number.MAX_SAFE_INTEGER, rewrites: [messages ? { ...rewrite, messages } : rewrite] }]);
		const next = [...expired, ...read, ...rewritten(reached, [rewrite])];
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
