/*
 * A ChunkIndex in memory, for the cold tier in tests (the Worker's is the
 * Store's SQLite, Store.chunkIndex). It counts its calls, and can be told
 * to fail an update, so a test can see what the tier asked of it.
 */

import type { ChunkIndex, ChunkRef } from "../../../src/history/cold/chunks";

export class MemoryChunkIndex implements ChunkIndex {
	readonly refs = new Map<number, ChunkRef>();
	/** Calls of `list` and `update`, in order. */
	readonly calls: string[] = [];

	async list(): Promise<ChunkRef[]> {
		this.calls.push("list");
		return [...this.refs.values()].map((ref) => structuredClone(ref));
	}

	async update(change: { put?: readonly ChunkRef[]; remove?: readonly number[] }): Promise<void> {
		this.calls.push("update");
		for (const first of change.remove ?? []) this.refs.delete(first);
		for (const ref of change.put ?? []) this.refs.set(ref.first, structuredClone(ref));
	}
}
