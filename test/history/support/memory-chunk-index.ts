/*
 * A ChunkIndex in memory, for the cold tier in tests (the Worker's is the
 * Store's SQLite, Store.chunkIndex). A test can replace `update` to make
 * it fail.
 */

import type { ChunkIndex, ChunkRef } from "../../../src/history/cold/chunks";

export class MemoryChunkIndex implements ChunkIndex {
	private readonly refs = new Map<number, ChunkRef>();

	async list(): Promise<ChunkRef[]> {
		return [...this.refs.values()].map((ref) => structuredClone(ref));
	}

	async update(change: { put?: readonly ChunkRef[]; remove?: readonly number[] }): Promise<void> {
		for (const first of change.remove ?? []) this.refs.delete(first);
		for (const ref of change.put ?? []) this.refs.set(ref.first, structuredClone(ref));
	}
}
