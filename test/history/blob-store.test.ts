/*
 * The BlobStore conformance suite (test/history/conformance/blob-store.ts)
 * on the stores the Worker can use: MemoryBlobStore, and R2BlobStore over
 * miniflare's R2 (the HISTORY_BLOB dev bucket in wrangler.toml). FsBlobStore
 * runs the same suite under `node --test` (scripts/fs-blob-store.test.mjs).
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "../../src/history/blob/memory";
import { R2BlobStore } from "../../src/history/blob/r2";
import { describeBlobStore } from "./conformance/blob-store";

describeBlobStore("MemoryBlobStore", () => new MemoryBlobStore(), { describe, it, expect });

describeBlobStore(
	"R2BlobStore",
	() => {
		if (!env.HISTORY_BLOB) throw new Error("the HISTORY_BLOB R2 binding is missing from wrangler.toml");
		return new R2BlobStore(env.HISTORY_BLOB);
	},
	{ describe, it, expect },
);

describe("MemoryBlobStore call log", () => {
	it("records each call with its key", async () => {
		const store = new MemoryBlobStore();
		await store.put("a", "1", { contentType: "application/jsonl" });
		await store.get("a");
		const writer = await store.writer("b");
		await writer.write("2");
		await writer.close();
		await store.delete(["a", "b"]);
		await store.list("p/");
		expect(store.calls).toEqual([
			{ method: "put", key: "a" },
			{ method: "get", key: "a" },
			{ method: "writer", key: "b" },
			{ method: "writer.close", key: "b" },
			{ method: "delete", key: "a" },
			{ method: "delete", key: "b" },
			{ method: "list", key: "p/" },
		]);
		expect(store.contentType("a")).toBe(undefined);
	});
});

describe("R2BlobStore writer", () => {
	/** The bucket, counting what the store asks of it. */
	function countingBucket(bucket: R2Bucket) {
		const counts = { put: 0, createMultipartUpload: 0, uploadPart: [] as number[], complete: 0, abort: 0 };
		const wrapped = {
			get: (key: string) => bucket.get(key),
			put: (key: string, value: string | ArrayBufferView, options?: R2PutOptions) => {
				counts.put += 1;
				return bucket.put(key, value, options);
			},
			createMultipartUpload: async (key: string, options?: R2MultipartOptions) => {
				counts.createMultipartUpload += 1;
				const upload = await bucket.createMultipartUpload(key, options);
				return {
					key: upload.key,
					uploadId: upload.uploadId,
					uploadPart: (partNumber: number, value: ArrayBufferView) => {
						counts.uploadPart.push(value.byteLength);
						return upload.uploadPart(partNumber, value);
					},
					complete: (parts: R2UploadedPart[]) => {
						counts.complete += 1;
						return upload.complete(parts);
					},
					abort: () => {
						counts.abort += 1;
						return upload.abort();
					},
				};
			},
			delete: (keys: string | string[]) => bucket.delete(keys),
			list: (options?: R2ListOptions) => bucket.list(options),
		};
		return { bucket: wrapped as unknown as R2Bucket, counts };
	}

	it("stores a small body with one put, and a large one in equal 5 MiB parts", async () => {
		const { bucket, counts } = countingBucket(env.HISTORY_BLOB!);
		const store = new R2BlobStore(bucket);
		const small = await store.writer("writer-test/small");
		await small.write("a".repeat(1024));
		await small.close();
		expect(counts).toMatchObject({ put: 1, createMultipartUpload: 0 });

		const large = await store.writer("writer-test/large", { contentType: "application/jsonl" });
		for (let i = 0; i < 12; i++) await large.write("x".repeat(1024 * 1024));
		await large.write("tail");
		await large.close();
		const MiB = 1024 * 1024;
		expect(counts).toMatchObject({ put: 1, createMultipartUpload: 1, uploadPart: [5 * MiB, 5 * MiB, 2 * MiB + 4], complete: 1, abort: 0 });
		const object = await env.HISTORY_BLOB!.head("writer-test/large");
		expect(object?.size).toBe(12 * MiB + 4);
		expect(object?.httpMetadata?.contentType).toBe("application/jsonl");
	});

	it("aborts the multipart upload when a writer is aborted", async () => {
		const { bucket, counts } = countingBucket(env.HISTORY_BLOB!);
		const store = new R2BlobStore(bucket);
		const writer = await store.writer("writer-test/aborted");
		await writer.write("y".repeat(6 * 1024 * 1024));
		await writer.abort();
		expect(counts).toMatchObject({ createMultipartUpload: 1, uploadPart: [5 * 1024 * 1024], complete: 0, abort: 1 });
		expect(await env.HISTORY_BLOB!.head("writer-test/aborted")).toBeNull();
	});
});
