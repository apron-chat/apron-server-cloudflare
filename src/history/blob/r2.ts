/*
 * A BlobStore over an R2 bucket: the store the Worker uses, which
 * under `wrangler dev` and the vitest pool is miniflare's local R2.
 *
 * A writer buffers what it is given and, once the body outgrows one part,
 * streams it to R2 as a multipart upload: R2 wants every part but the last
 * at least 5 MiB and all of them the same size, so parts are cut at exactly
 * `partBytes`. A body that never outgrows one part is stored with a single
 * put on close. Nothing shows under the key until the upload completes.
 */

import type { BlobListing, BlobListOptions, BlobObject, BlobPutOptions, BlobStore, BlobWriter } from "./store";

/** R2's smallest part (all but the last). */
const MIN_PART_BYTES = 5 * 1024 * 1024;
/** R2 deletes at most this many keys per call. */
const DELETE_BATCH = 1000;
/** R2 lists at most this many keys per page. */
const LIST_LIMIT = 1000;

const encoder = new TextEncoder();

export interface R2BlobStoreOptions {
	/** Multipart part size; at least 5 MiB (smaller values are raised to it). Default 5 MiB. */
	partBytes?: number;
}

function httpMetadata(options?: BlobPutOptions): R2PutOptions | undefined {
	const put: R2PutOptions = {
		...(options?.contentType ? { httpMetadata: { contentType: options.contentType } } : {}),
		...(options?.metadata ? { customMetadata: options.metadata } : {}),
	};
	return Object.keys(put).length ? put : undefined;
}

/** Joins `chunks` and returns the first `bytes` of them, leaving the rest in `chunks`. */
function take(chunks: Uint8Array[], bytes: number): Uint8Array {
	const out = new Uint8Array(bytes);
	let offset = 0;
	while (offset < bytes) {
		const chunk = chunks[0]!;
		const wanted = bytes - offset;
		if (chunk.byteLength <= wanted) {
			out.set(chunk, offset);
			offset += chunk.byteLength;
			chunks.shift();
		} else {
			out.set(chunk.subarray(0, wanted), offset);
			offset += wanted;
			chunks[0] = chunk.subarray(wanted);
		}
	}
	return out;
}

export class R2BlobStore implements BlobStore {
	private readonly bucket: R2Bucket;
	private readonly partBytes: number;

	constructor(bucket: R2Bucket, options: R2BlobStoreOptions = {}) {
		this.bucket = bucket;
		this.partBytes = Math.max(MIN_PART_BYTES, Math.floor(options.partBytes ?? MIN_PART_BYTES));
	}

	async get(key: string): Promise<BlobObject | null> {
		const object = await this.bucket.get(key);
		if (!object) return null;
		return {
			size: object.size,
			...(object.customMetadata && Object.keys(object.customMetadata).length ? { metadata: { ...object.customMetadata } } : {}),
			text: () => object.text(),
			stream: async () => object.body,
		};
	}

	async put(key: string, body: string, options?: BlobPutOptions): Promise<void> {
		await this.bucket.put(key, body, httpMetadata(options));
	}

	async writer(key: string, options?: BlobPutOptions): Promise<BlobWriter> {
		const bucket = this.bucket;
		const partBytes = this.partBytes;
		const pending: Uint8Array[] = [];
		let pendingBytes = 0;
		let upload: R2MultipartUpload | undefined;
		const parts: R2UploadedPart[] = [];
		let done = false;

		const open = () => {
			if (done) throw new Error(`the writer for ${key} is already closed or aborted`);
		};
		const uploadPart = async (bytes: Uint8Array) => {
			upload ??= await bucket.createMultipartUpload(key, httpMetadata(options));
			parts.push(await upload.uploadPart(parts.length + 1, bytes));
		};
		const abortUpload = async () => {
			if (upload) await upload.abort();
		};

		return {
			write: async (chunk) => {
				open();
				const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
				if (bytes.byteLength === 0) return;
				pending.push(bytes);
				pendingBytes += bytes.byteLength;
				// Cut a part only when more than a part is waiting, so at least one
				// byte is always left for the last part, which may be short.
				while (pendingBytes > partBytes) {
					await uploadPart(take(pending, partBytes));
					pendingBytes -= partBytes;
				}
			},
			close: async () => {
				open();
				done = true;
				const rest = take(pending, pendingBytes);
				pendingBytes = 0;
				if (!upload) {
					await bucket.put(key, rest, httpMetadata(options));
					return;
				}
				try {
					parts.push(await upload.uploadPart(parts.length + 1, rest));
					await upload.complete(parts);
				} catch (error) {
					await abortUpload().catch(() => {});
					throw error;
				}
			},
			abort: async () => {
				if (done) return;
				done = true;
				pending.length = 0;
				pendingBytes = 0;
				await abortUpload();
			},
		};
	}

	async delete(keys: readonly string[]): Promise<void> {
		for (let i = 0; i < keys.length; i += DELETE_BATCH) {
			await this.bucket.delete(keys.slice(i, i + DELETE_BATCH));
		}
	}

	async list(prefix: string, options: BlobListOptions = {}): Promise<BlobListing> {
		const limit = Math.max(1, Math.min(options.limit ?? LIST_LIMIT, LIST_LIMIT));
		// R2's cursor carries the position, so startAfter goes only on a first page.
		const listed = await this.bucket.list(
			options.cursor !== undefined
				? { prefix, limit, cursor: options.cursor }
				: { prefix, limit, ...(options.startAfter !== undefined ? { startAfter: options.startAfter } : {}) },
		);
		const keys = listed.objects.map((object) => ({ key: object.key, size: object.size }));
		return listed.truncated ? { keys, cursor: listed.cursor } : { keys };
	}
}
