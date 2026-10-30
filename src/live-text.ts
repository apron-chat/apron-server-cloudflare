/*
 * Live text (protocol §4.8.3): the bytes of one `append` or `terminal` text
 * while it streams, held in the Durable Object's memory only, and the
 * readers it fans out to. Nothing here touches storage: the object
 * publishes what was kept once, when the text ends (Store.finishLiveText).
 *
 * A terminal keeps its last `terminalKeepBytes` (§4.8.6 `keep_last`), an
 * append its first `appendMaxBytes` up to a whole character (§4.8.5). A
 * reader that connects gets what is kept, then every chunk as it arrives.
 */

export type LiveKind = "terminal" | "append";

/** Why a text ended, as the writer is told in the `PUT` response. */
export type LiveEnd = "complete" | "time" | "size" | "disconnected" | "removed" | "unavailable";

/**
 * §4.8.6 `keep_last`, exactly: the last `limit` bytes, starting at their
 * first byte below 0x20 (a control character), or else at their first byte
 * outside 0x80–0xBF (so no partial character starts the text).
 */
export function keepLast(output: Uint8Array, limit: number): Uint8Array {
	if (output.length <= limit) return output;
	const tail = output.subarray(output.length - limit);
	for (let index = 0; index < tail.length; index += 1) {
		if (tail[index] < 0x20) return tail.subarray(index);
	}
	let start = 0;
	while (start < tail.length && tail[start] >= 0x80 && tail[start] <= 0xbf) start += 1;
	return tail.subarray(start);
}

/** §4.8.5: the first `limit` bytes, cut back to a whole UTF-8 character. */
export function keepFirst(text: Uint8Array, limit: number): Uint8Array {
	if (text.length <= limit) return text;
	let end = Math.max(0, limit);
	// A continuation byte at the cut belongs to a character that starts before it.
	while (end > 0 && (text[end] & 0xc0) === 0x80) end -= 1;
	return text.subarray(0, end);
}

const decoder = new TextDecoder("utf-8");

/** Kept bytes as text; invalid UTF-8 reads as U+FFFD, as a client decodes it. */
export function liveTextString(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

/** Bytes a reader may fall behind before it is dropped, so a stalled one cannot grow the object's memory. */
export const MAX_READER_BACKLOG_BYTES = 256 * 1024;

/** The kept bytes of one text: the last part for a terminal, the first for an append. */
export class LiveBuffer {
	readonly kind: LiveKind;
	/** The most kept: `terminalKeepBytes`, or the bytes an append may add. */
	readonly limit: number;
	/** Bytes received in all, kept or not. */
	received = 0;
	/** An append that reached its limit keeps nothing more. */
	full = false;
	private bytes: Uint8Array;
	private length = 0;

	constructor(kind: LiveKind, limit: number) {
		this.kind = kind;
		this.limit = Math.max(0, limit);
		// A terminal compacts when its buffer fills, at twice what it keeps, so
		// each byte is copied a bounded number of times (keepLast is stable:
		// cutting early and again later keeps what one cut at the end keeps).
		this.bytes = new Uint8Array(kind === "terminal" ? 2 * this.limit : this.limit);
	}

	/**
	 * Takes a chunk; returns the bytes readers get now (all of a terminal's
	 * chunk; an append's up to its limit), and whether an append is full.
	 */
	push(chunk: Uint8Array): { send: Uint8Array; full: boolean } {
		this.received += chunk.length;
		if (this.kind === "terminal") {
			if (this.length + chunk.length <= this.bytes.length) {
				this.bytes.set(chunk, this.length);
				this.length += chunk.length;
			} else {
				const joined = new Uint8Array(this.length + chunk.length);
				joined.set(this.bytes.subarray(0, this.length));
				joined.set(chunk, this.length);
				const kept = keepLast(joined, this.limit);
				this.bytes.set(kept);
				this.length = kept.length;
			}
			return { send: chunk, full: false };
		}
		if (this.full) return { send: new Uint8Array(0), full: true };
		if (this.length + chunk.length <= this.limit) {
			this.bytes.set(chunk, this.length);
			this.length += chunk.length;
			return { send: chunk, full: false };
		}
		const joined = new Uint8Array(this.length + chunk.length);
		joined.set(this.bytes.subarray(0, this.length));
		joined.set(chunk, this.length);
		const kept = keepFirst(joined, this.limit);
		const before = this.length;
		this.bytes.set(kept);
		this.length = kept.length;
		this.full = true;
		return { send: kept.slice(Math.min(before, kept.length)), full: true };
	}

	/** What is kept now: what a reader that connects gets first, and what the text publishes when it ends. */
	kept(): Uint8Array {
		const bytes = this.bytes.subarray(0, this.length);
		return this.kind === "terminal" ? keepLast(bytes, this.limit) : bytes;
	}
}

/**
 * How long readers' bytes wait to be sent together, and how many may wait.
 * A writer in a pseudo-terminal sends a chunk per line or less, and each
 * chunk to each reader is a write through the runtime to the entry Worker
 * and on to the client: sending at most every 50 ms costs a fraction of the
 * CPU, a delay no reader sees.
 */
export const READER_FLUSH_MS = 50;
export const READER_FLUSH_BYTES = 16 * 1024;

/** One text's readers: response streams fed from memory, in batches. */
export class LiveReaders {
	private readonly controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
	/** Bytes not yet sent to the readers, and the one timer that sends them. */
	private pending: Uint8Array[] = [];
	private pendingBytes = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** Reads the text has served over its life, reconnects included. */
	served = 0;

	get size(): number {
		return this.controllers.size;
	}

	/**
	 * A new reader's stream, starting with `initial`, what is kept now: the
	 * bytes still waiting go to the other readers first, since `initial`
	 * already holds them.
	 */
	open(initial: Uint8Array): ReadableStream<Uint8Array> {
		this.flush();
		this.served += 1;
		let own: ReadableStreamDefaultController<Uint8Array> | undefined;
		return new ReadableStream<Uint8Array>({
			start: (controller) => {
				own = controller;
				this.controllers.add(controller);
				if (initial.length) controller.enqueue(initial.slice());
			},
			cancel: () => {
				if (own) this.controllers.delete(own);
			},
		}, new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }));
	}

	/** Queues a chunk for every reader: sent within READER_FLUSH_MS, or at once past READER_FLUSH_BYTES. */
	send(chunk: Uint8Array): void {
		if (!chunk.length || !this.controllers.size) return;
		this.pending.push(chunk);
		this.pendingBytes += chunk.length;
		if (this.pendingBytes >= READER_FLUSH_BYTES) this.flush();
		else this.timer ??= setTimeout(() => this.flush(), READER_FLUSH_MS);
	}

	/** Sends what waits, as one chunk; a reader too far behind is dropped. */
	flush(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.pendingBytes) return;
		const chunk = this.pending.length === 1 ? this.pending[0] : new Uint8Array(this.pendingBytes);
		if (this.pending.length > 1) {
			let offset = 0;
			for (const part of this.pending) {
				chunk.set(part, offset);
				offset += part.length;
			}
		}
		this.pending = [];
		this.pendingBytes = 0;
		for (const controller of [...this.controllers]) {
			const desired = controller.desiredSize;
			if (desired !== null && desired < -MAX_READER_BACKLOG_BYTES) {
				this.controllers.delete(controller);
				try { controller.error(new Error("reader fell behind")); } catch { /* gone */ }
				continue;
			}
			try { controller.enqueue(chunk); } catch { this.controllers.delete(controller); }
		}
	}

	/** Ends every reader's response, after what waits: the text ended. No timer is left. */
	close(): void {
		this.flush();
		for (const controller of this.controllers) {
			try { controller.close(); } catch { /* already closed or errored */ }
		}
		this.controllers.clear();
	}
}

/**
 * The headers of a live text's `url` (§4.8.3), readable from any origin.
 * `no-transform` keeps the edge (and wrangler dev) from compressing it:
 * compression buffers the stream, so readers would see nothing until the end.
 */
export function liveTextHeaders(): Headers {
	return new Headers({
		"Content-Type": "text/plain; charset=utf-8",
		"X-Content-Type-Options": "nosniff",
		"Cache-Control": "no-store, no-transform",
		"Access-Control-Allow-Origin": "*",
		"Content-Security-Policy": "default-src 'none'",
	});
}
