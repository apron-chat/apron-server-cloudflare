/*
 * A SegmentIndex in memory, for tests: the blob tier's index as
 * SqlSegmentIndex keeps it in the Durable Object's SQLite, with the same
 * bounds on every query (SEGMENT_QUERY_ROWS).
 */

import { SEGMENT_QUERY_ROWS, STRADDLE_ROWS, type SegmentCursor, type SegmentIndex, type SegmentPosition, type SegmentRef } from "../../../src/history/blob/segments";

const byFirst = (a: SegmentRef, b: SegmentRef) => a.first - b.first || (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0);
const byRoom = (a: SegmentRef, b: SegmentRef) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0) || a.first - b.first;
const byLast = (a: SegmentRef, b: SegmentRef) => a.last - b.last || byFirst(a, b);

/** A SegmentIndex in memory. */
export class MemorySegmentIndex implements SegmentIndex {
	private readonly refs = new Map<string, SegmentRef>();

	private static id(ref: Pick<SegmentRef, "roomId" | "first">): string {
		return `${ref.roomId}\u0000${ref.first}`;
	}

	/** Every segment, by first. */
	all(): SegmentRef[] {
		return [...this.refs.values()].map((ref) => ({ ...ref })).sort(byFirst);
	}

	async find(roomIds: readonly string[], lower: number, upper: number, options: { forward?: boolean; limit?: number } = {}): Promise<SegmentRef[]> {
		const limit = options.limit ?? SEGMENT_QUERY_ROWS;
		return [...new Set(roomIds)].flatMap((roomId) => {
			const own = this.all().filter((ref) => ref.roomId === roomId && ref.first <= upper && ref.last >= lower);
			const straddling = own.filter((ref) => ref.first < lower).slice(-STRADDLE_ROWS);
			const inside = own.filter((ref) => ref.first >= lower);
			return [...straddling, ...(options.forward === false ? inside.slice(-limit) : inside.slice(0, limit))];
		}).sort(byRoom);
	}

	async overlapping(lower: number, upper: number): Promise<SegmentRef[]> {
		return this.all().filter((ref) => ref.last >= lower).sort(byLast).slice(0, SEGMENT_QUERY_ROWS).filter((ref) => ref.first <= upper).sort(byFirst);
	}

	async newest(below: number, limit: number, after?: SegmentPosition): Promise<SegmentRef[]> {
		return this.all().filter((ref) => ref.last < below && (!after || byLast(ref, { ...after, key: "", records: 0, bytes: 0 }) < 0)).sort((a, b) => byLast(b, a)).slice(0, limit);
	}

	async startingBelow(floor: number, limit: number): Promise<SegmentRef[]> {
		return this.all().filter((ref) => ref.first < floor).slice(0, limit);
	}

	async lowestBelow(below: number): Promise<number | undefined> {
		return this.all().slice(0, SEGMENT_QUERY_ROWS).find((ref) => ref.last < below)?.first;
	}

	async straddling(floor: number): Promise<number | undefined> {
		const nearest = this.all().filter((ref) => ref.first < floor).slice(-SEGMENT_QUERY_ROWS);
		const found = nearest.filter((ref) => ref.last >= floor);
		return found.length ? Math.min(...found.map((ref) => ref.first)) : undefined;
	}

	async after(from: number, limit: number, cursor?: SegmentCursor): Promise<SegmentRef[]> {
		return this.all()
			.filter((ref) => ref.last >= from && (!cursor || ref.first > cursor.first || (ref.first === cursor.first && ref.roomId > cursor.roomId)))
			.slice(0, limit);
	}

	async oldest(limit: number): Promise<SegmentRef[]> {
		return this.all().sort(byLast).slice(0, limit);
	}

	async forRoom(roomId: string): Promise<SegmentRef[]> {
		return this.all().filter((ref) => ref.roomId === roomId).slice(0, SEGMENT_QUERY_ROWS);
	}

	async rooms(): Promise<string[]> {
		return [...new Set(this.all().sort(byRoom).slice(0, SEGMENT_QUERY_ROWS).map((ref) => ref.roomId))].sort();
	}

	async add(refs: readonly SegmentRef[]): Promise<void> {
		for (const ref of refs) this.refs.set(MemorySegmentIndex.id(ref), { ...ref });
	}

	async remove(refs: readonly SegmentRef[]): Promise<void> {
		for (const ref of refs) {
			const id = MemorySegmentIndex.id(ref);
			if (this.refs.get(id)?.key === ref.key) this.refs.delete(id);
		}
	}

	async clear(): Promise<void> {
		this.refs.clear();
	}
}
