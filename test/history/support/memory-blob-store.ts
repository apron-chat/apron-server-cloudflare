/*
 * A BlobStore held in memory: for tests. It behaves as R2 does
 * where the conformance suite can tell (sorted listings, paging, writers that
 * commit on close), and records each call in `calls` so a test can see what
 * a tier asked of its store. Tests register it as the `memory` provider
 * (memoryBlobStores); the Worker's registry has only `r2`
 * (src/history/config.ts, WORKER_BLOB_STORES), so it never reaches one.
 */

import type { BlobListing, BlobListOptions, BlobObject, BlobPutOptions, BlobStore, BlobWriter } from "../../../src/history/storage/store";
import type { BlobStoreProviders } from "../../../src/history/config";

interface Stored {
	bytes: Uint8Array;
	contentType?: string;
	metadata?: Record<string, string>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(chunks: readonly Uint8Array[]): Uint8Array {
	let size = 0;
	for (const chunk of chunks) size += chunk.byteLength;
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function objectOf(stored: Stored): BlobObject {
	const bytes = stored.bytes;
	return {
		size: bytes.byteLength,
		...(stored.metadata ? { metadata: { ...stored.metadata } } : {}),
		text: async () => decoder.decode(bytes),
		stream: async () =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes.slice());
					controller.close();
				},
			}),
	};
}

export class MemoryBlobStore implements BlobStore {
	/** Every call, in order: `get`, `put`, `writer`, `writer.close`, `writer.abort`, `delete` (one per key), `list` (key: the prefix). */
	readonly calls: Array<{ method: string; key?: string }> = [];
	private readonly objects = new Map<string, Stored>();

	async get(key: string): Promise<BlobObject | null> {
		this.calls.push({ method: "get", key });
		const stored = this.objects.get(key);
		return stored ? objectOf(stored) : null;
	}

	async put(key: string, body: string, options?: BlobPutOptions): Promise<void> {
		this.calls.push({ method: "put", key });
		this.objects.set(key, { bytes: encoder.encode(body), contentType: options?.contentType, ...(options?.metadata ? { metadata: { ...options.metadata } } : {}) });
	}

	async writer(key: string, options?: BlobPutOptions): Promise<BlobWriter> {
		this.calls.push({ method: "writer", key });
		// Chunks wait here until close, so nothing shows under the key before then.
		let chunks: Uint8Array[] | undefined = [];
		const open = (): Uint8Array[] => {
			if (!chunks) throw new Error(`the writer for ${key} is already closed or aborted`);
			return chunks;
		};
		return {
			write: async (chunk) => {
				open().push(typeof chunk === "string" ? encoder.encode(chunk) : chunk.slice());
			},
			close: async () => {
				const bytes = concat(open());
				chunks = undefined;
				this.calls.push({ method: "writer.close", key });
				this.objects.set(key, { bytes, contentType: options?.contentType, ...(options?.metadata ? { metadata: { ...options.metadata } } : {}) });
			},
			abort: async () => {
				chunks = undefined;
				this.calls.push({ method: "writer.abort", key });
			},
		};
	}

	async delete(keys: readonly string[]): Promise<void> {
		for (const key of keys) {
			this.calls.push({ method: "delete", key });
			this.objects.delete(key);
		}
	}

	async list(prefix: string, options: BlobListOptions = {}): Promise<BlobListing> {
		this.calls.push({ method: "list", key: prefix });
		// The cursor is the last key of the previous page: the listing resumes after it.
		const after = options.cursor ?? options.startAfter;
		const limit = Math.max(1, Math.min(options.limit ?? 1000, 1000));
		const matching = [...this.objects.keys()]
			.filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		const page = matching.slice(0, limit);
		const keys = page.map((key) => ({ key, size: this.objects.get(key)!.bytes.byteLength }));
		return matching.length > limit ? { keys, cursor: page[page.length - 1] } : { keys };
	}

	/** The content type an object was stored with, for tests. */
	contentType(key: string): string | undefined {
		return this.objects.get(key)?.contentType;
	}
}

/** A registry with `memory` alone, over `store` (buildHistoryPipeline's blobStores, with blobProvider "memory"). */
export function memoryBlobStores(store: BlobStore = new MemoryBlobStore()): BlobStoreProviders {
	return { memory: () => store };
}
