/*
 * Blob storage (PLAN §5, §9): the small interface the blob tier and the
 * backups write through, so the same code runs over R2 in the Worker
 * (blob/r2.ts), over memory in tests (test/history/support/), and over a
 * directory in Node scripts (scripts/fs-blob-store.mjs). Each caller
 * registers the providers it has (history/config.ts, BlobStoreProviders).
 *
 * Keys are plain strings with `/` as a separator by convention. Listings are
 * sorted by key, so zero-padded names (segment keys, dated exports) list in
 * order. Bodies are text (segments are JSON Lines) or, written through a
 * writer, bytes (a backup encoded through @apron/archive codecs, gzip).
 *
 * Every implementation passes the same conformance suite
 * (test/history/conformance/blob-store.ts).
 */

/** A stored object, as `get` returns it. */
export interface BlobObject {
	/** The body's size in bytes (UTF-8). */
	size: number;
	/** The custom metadata it was stored with (BlobPutOptions.metadata), where the store keeps any. */
	metadata?: Record<string, string>;
	/** The whole body as text. */
	text(): Promise<string>;
	/**
	 * The body as a byte stream, for bodies too large to hold as one string
	 * (a full export being imported). Optional: a store without it is read with
	 * `text()`. A body is read once, through either `text()` or `stream()`:
	 * R2 hands out a single body stream per `get`.
	 */
	stream?(): Promise<ReadableStream<Uint8Array>>;
}

export interface BlobPutOptions {
	contentType?: string;
	/**
	 * Custom metadata stored with the object (R2: customMetadata), such as the
	 * codecs a backup went through. A store that cannot keep it (a directory)
	 * ignores it, so a reader also has the object's name to go by.
	 */
	metadata?: Record<string, string>;
}

export interface BlobListOptions {
	/** Only keys sorted after this one (exclusive). */
	startAfter?: string;
	/** The most keys to return in one page; a store may return fewer and still have more. */
	limit?: number;
	/** A `cursor` from the previous page: continues that listing. Takes over from `startAfter`. */
	cursor?: string;
}

export interface BlobListing {
	keys: Array<{ key: string; size: number }>;
	/** Present when more keys may follow: pass it back as `cursor` for the next page. */
	cursor?: string;
}

export interface BlobStore {
	/** The object under `key`, or null if there is none. */
	get(key: string): Promise<BlobObject | null>;
	/** Stores `body` under `key`, replacing what was there. */
	put(key: string, body: string, options?: BlobPutOptions): Promise<void>;
	/**
	 * For bodies too large to hold as one string (full exports): a writer that
	 * commits on close. Until `close` resolves nothing is visible under `key`
	 * (what was there before stays); `abort` discards what was written.
	 */
	writer(key: string, options?: BlobPutOptions): Promise<BlobWriter>;
	/** Deletes the keys; a key with no object is not an error. */
	delete(keys: readonly string[]): Promise<void>;
	/** Keys starting with `prefix`, sorted, a page at a time. */
	list(prefix: string, options?: BlobListOptions): Promise<BlobListing>;
}

/** A body written in pieces. Call `close` or `abort` exactly once. */
export interface BlobWriter {
	/** Text is written as UTF-8; bytes as they are. */
	write(chunk: string | Uint8Array): Promise<void>;
	close(): Promise<void>;
	abort(): Promise<void>;
}
