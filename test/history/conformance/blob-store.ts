/*
 * The BlobStore conformance suite (PLAN §12.2): what every store must do,
 * run on MemoryBlobStore and R2BlobStore (miniflare R2) in vitest
 * (test/history/blob-store.test.ts) and on FsBlobStore under `node --test`
 * (scripts/fs-blob-store.test.mjs).
 *
 * It is runner-neutral: the caller passes its `describe`, `it` and `expect`,
 * and the suite uses only the few matchers listed in `Expect`, so a small
 * shim over node:assert serves for Node. It is written in the TypeScript
 * Node runs directly (types only, erased on load), and imports nothing at
 * run time, so Node imports this file as it is.
 *
 * Each test works under its own key prefix, so a store shared between tests
 * (one R2 bucket) needs no cleanup between them.
 */

import type { BlobStore } from "../../../src/history/blob/store";

/** The matchers the suite uses; vitest's `expect` has them, and Node gets a shim. */
export interface Expect {
	(actual: unknown): {
		toBe(expected: unknown): void;
		toEqual(expected: unknown): void;
		toBeNull(): void;
		toBeLessThanOrEqual(expected: number): void;
	};
}

export interface Runner {
	describe(name: string, body: () => void): void;
	/** `timeoutMs` for the slow tests (large bodies). */
	it(name: string, body: () => Promise<void>, timeoutMs?: number): void;
	expect: Expect;
}

const MiB = 1024 * 1024;

let run = 0;

/** A prefix no other test uses, so tests may share one store. */
function freshRoot(name: string): string {
	run += 1;
	const nonce = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
	return `conformance/${name.replace(/[^A-Za-z0-9_-]+/g, "-")}/${run}-${nonce}/`;
}

/** Every key under `prefix`, paging through, with each page checked against `limit`. */
async function listAll(store: BlobStore, expect: Expect, prefix: string, options: { startAfter?: string; limit?: number } = {}) {
	const keys: Array<{ key: string; size: number }> = [];
	let cursor: string | undefined;
	let pages = 0;
	do {
		const page = await store.list(prefix, { ...options, cursor });
		if (options.limit !== undefined) expect(page.keys.length).toBeLessThanOrEqual(options.limit);
		keys.push(...page.keys);
		cursor = page.cursor;
		pages += 1;
		if (pages > 1000) throw new Error("the listing never ends");
	} while (cursor !== undefined);
	return { keys, pages };
}

/** `length` characters of text that differ along their length, so a misplaced piece shows. */
function filler(length: number, seed: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let line = "";
	for (let i = 0; line.length < 4096; i++) line += `${alphabet[(seed + i) % alphabet.length]}`;
	let out = `<${seed}>`;
	while (out.length < length) out += line;
	return out.slice(0, length);
}

export function describeBlobStore(name: string, makeStore: () => BlobStore | Promise<BlobStore>, { describe, it, expect }: Runner): void {
	describe(`BlobStore conformance: ${name}`, () => {
		it("puts, gets and replaces an object", async () => {
			const store = await makeStore();
			const root = freshRoot(name);
			await store.put(`${root}a.jsonl`, '{"apron_archive":1}\n', { contentType: "application/jsonl" });
			const object = await store.get(`${root}a.jsonl`);
			expect(object === null).toBe(false);
			expect(object!.size).toBe(20);
			expect(await object!.text()).toBe('{"apron_archive":1}\n');
			await store.put(`${root}a.jsonl`, "second");
			const replaced = await store.get(`${root}a.jsonl`);
			expect(replaced!.size).toBe(6);
			expect(await replaced!.text()).toBe("second");
		});

		it("counts sizes in UTF-8 bytes and keeps text intact", async () => {
			const store = await makeStore();
			const root = freshRoot(name);
			const body = "héllo, wörld ✓ 🎉\n";
			await store.put(`${root}utf8`, body);
			const object = await store.get(`${root}utf8`);
			expect(object!.size).toBe(new TextEncoder().encode(body).byteLength);
			expect(await object!.text()).toBe(body);
			await store.put(`${root}empty`, "");
			const empty = await store.get(`${root}empty`);
			expect(empty!.size).toBe(0);
			expect(await empty!.text()).toBe("");
		});

		it("streams a body when it offers a stream", async () => {
			const store = await makeStore();
			const root = freshRoot(name);
			await store.put(`${root}s`, "streamed body");
			const object = await store.get(`${root}s`);
			if (!object!.stream) return;
			const reader = (await object!.stream()).getReader();
			const decoder = new TextDecoder();
			let text = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
			}
			expect(text + decoder.decode()).toBe("streamed body");
		});

		it("returns null for a missing key, and deleting one is fine", async () => {
			const store = await makeStore();
			const root = freshRoot(name);
			expect(await store.get(`${root}missing`)).toBeNull();
			await store.delete([`${root}missing`]);
			await store.delete([]);
			expect(await store.get(`${root}missing`)).toBeNull();
		});

		it("deletes several keys and leaves the rest", async () => {
			const store = await makeStore();
			const root = freshRoot(name);
			for (const key of ["a", "b", "c"]) await store.put(`${root}${key}`, key);
			await store.delete([`${root}a`, `${root}c`, `${root}never`]);
			expect(await store.get(`${root}a`)).toBeNull();
			expect(await store.get(`${root}c`)).toBeNull();
			expect(await (await store.get(`${root}b`))!.text()).toBe("b");
			expect((await listAll(store, expect, root)).keys).toEqual([{ key: `${root}b`, size: 1 }]);
		});

		it("lists keys under a prefix, sorted, with sizes", async () => {
			const store = await makeStore();
			const root = freshRoot(name);
			const keys = ["room-b/0002.jsonl", "room-a/0001.jsonl", "room-a/0003.jsonl", "room-a/0002.jsonl", "room-ab/0001.jsonl", "top.jsonl"];
			for (const key of keys) await store.put(`${root}${key}`, key);
			const all = await listAll(store, expect, root);
			expect(all.keys).toEqual([...keys].sort().map((key) => ({ key: `${root}${key}`, size: key.length })));
			// A prefix need not end at a separator: room-a matches room-ab too.
			expect((await listAll(store, expect, `${root}room-a`)).keys.map((k) => k.key)).toEqual([
				`${root}room-a/0001.jsonl`,
				`${root}room-a/0002.jsonl`,
				`${root}room-a/0003.jsonl`,
				`${root}room-ab/0001.jsonl`,
			]);
			expect((await listAll(store, expect, `${root}room-a/`)).keys.length).toBe(3);
			expect((await listAll(store, expect, `${root}nothing/`)).keys).toEqual([]);
			expect(await store.list(`${root}nothing/`)).toEqual({ keys: [] });
		});

		it("lists after startAfter, exclusively, whether or not that key exists", async () => {
			const store = await makeStore();
			const root = freshRoot(name);
			for (const key of ["01", "02", "03", "04"]) await store.put(`${root}${key}`, key);
			const keysAfter = async (startAfter: string) => (await listAll(store, expect, root, { startAfter })).keys.map((k) => k.key.slice(root.length));
			expect(await keysAfter(`${root}02`)).toEqual(["03", "04"]);
			expect(await keysAfter(`${root}025`)).toEqual(["03", "04"]);
			expect(await keysAfter(`${root}04`)).toEqual([]);
			// Before the prefix: everything under it.
			expect(await keysAfter(root.slice(0, -1))).toEqual(["01", "02", "03", "04"]);
		});

		it("pages with limit and cursor, every key once", async () => {
			const store = await makeStore();
			const root = freshRoot(name);
			const keys = Array.from({ length: 23 }, (_, i) => `seg/${String(i).padStart(4, "0")}`);
			for (const key of keys) await store.put(`${root}${key}`, "x");
			const first = await store.list(root, { limit: 5 });
			expect(first.keys.length).toBeLessThanOrEqual(5);
			expect(first.cursor !== undefined).toBe(true);
			const paged = await listAll(store, expect, root, { limit: 5 });
			expect(paged.keys.map((k) => k.key)).toEqual(keys.map((key) => `${root}${key}`));
			expect(paged.pages >= 5).toBe(true);
			// Paging after startAfter keeps both.
			const after = await listAll(store, expect, root, { limit: 4, startAfter: `${root}seg/0010` });
			expect(after.keys.map((k) => k.key)).toEqual(keys.slice(11).map((key) => `${root}${key}`));
			// A page that holds everything has no cursor.
			expect((await store.list(root, { limit: 100 })).cursor).toBe(undefined);
		});

		it("writes in pieces, visible only after close, and accepts a content type", async () => {
			const store = await makeStore();
			const root = freshRoot(name);
			await store.put(`${root}w`, "old");
			const writer = await store.writer(`${root}w`, { contentType: "application/jsonl" });
			await writer.write('{"apron_archive":1}\n');
			await writer.write("");
			await writer.write("ünïcode\n");
			// Not yet committed: the old body stays.
			expect(await (await store.get(`${root}w`))!.text()).toBe("old");
			const fresh = await store.writer(`${root}fresh`);
			await fresh.write("pending");
			expect(await store.get(`${root}fresh`)).toBeNull();
			await writer.close();
			await fresh.close();
			const object = await store.get(`${root}w`);
			expect(await object!.text()).toBe('{"apron_archive":1}\nünïcode\n');
			expect(object!.size).toBe(new TextEncoder().encode('{"apron_archive":1}\nünïcode\n').byteLength);
			expect(await (await store.get(`${root}fresh`))!.text()).toBe("pending");
		});

		it("writes bytes as they are, mixed with text, and keeps metadata where it keeps any", async () => {
			const store = await makeStore();
			const root = freshRoot(name);
			const writer = await store.writer(`${root}bytes`, { contentType: "application/gzip", metadata: { codecs: "gzip" } });
			await writer.write(new Uint8Array([0x1f, 0x8b, 0x00, 0xff]));
			await writer.write(new Uint8Array(0));
			await writer.write("é");
			await writer.close();
			const object = await store.get(`${root}bytes`);
			expect(object!.size).toBe(6);
			const read = object!.stream ? new Uint8Array(await new Response(await object!.stream()).arrayBuffer()) : undefined;
			if (read) expect([...read]).toEqual([0x1f, 0x8b, 0x00, 0xff, 0xc3, 0xa9]);
			// A store with no metadata (a directory) leaves it out; one with it gives it back as stored.
			if (object!.metadata !== undefined) expect(object!.metadata).toEqual({ codecs: "gzip" });
		});

		it("writes an empty body when closed with nothing written", async () => {
			const store = await makeStore();
			const root = freshRoot(name);
			const writer = await store.writer(`${root}empty`);
			await writer.close();
			const object = await store.get(`${root}empty`);
			expect(object!.size).toBe(0);
			expect(await object!.text()).toBe("");
		});

		it("discards an aborted writer's body", async () => {
			const store = await makeStore();
			const root = freshRoot(name);
			const writer = await store.writer(`${root}aborted`);
			await writer.write("never committed");
			await writer.abort();
			expect(await store.get(`${root}aborted`)).toBeNull();
			expect((await listAll(store, expect, root)).keys).toEqual([]);
			// An abort leaves an existing object as it was.
			await store.put(`${root}kept`, "kept");
			const second = await store.writer(`${root}kept`);
			await second.write("replacement");
			await second.abort();
			expect(await (await store.get(`${root}kept`))!.text()).toBe("kept");
		});

		it(
			"writes a large body across many writes (multipart where the store has it)",
			async () => {
				const store = await makeStore();
				const root = freshRoot(name);
				// 12 MiB in 64 KiB writes, then an odd tail: three 5 MiB parts on R2.
				const pieces: string[] = [];
				for (let i = 0; i < 192; i++) pieces.push(filler(64 * 1024, i));
				pieces.push(filler(12_345, 999));
				const writer = await store.writer(`${root}large.jsonl`, { contentType: "application/jsonl" });
				for (const piece of pieces) await writer.write(piece);
				expect(await store.get(`${root}large.jsonl`)).toBeNull();
				await writer.close();
				const expected = pieces.join("");
				const object = await store.get(`${root}large.jsonl`);
				expect(object!.size).toBe(12 * MiB + 12_345);
				const text = await object!.text();
				expect(text.length).toBe(expected.length);
				expect(text === expected).toBe(true);
				expect((await listAll(store, expect, root)).keys).toEqual([{ key: `${root}large.jsonl`, size: 12 * MiB + 12_345 }]);
			},
			120_000,
		);

		it(
			"writes a large body given in one piece, and aborts one past its first part",
			async () => {
				const store = await makeStore();
				const root = freshRoot(name);
				const body = filler(11 * MiB, 7);
				const writer = await store.writer(`${root}one-piece`);
				await writer.write(body);
				await writer.close();
				const object = await store.get(`${root}one-piece`);
				expect(object!.size).toBe(11 * MiB);
				expect((await object!.text()) === body).toBe(true);

				const aborted = await store.writer(`${root}aborted-large`);
				await aborted.write(filler(6 * MiB, 3));
				await aborted.write(filler(1024, 4));
				await aborted.abort();
				expect(await store.get(`${root}aborted-large`)).toBeNull();
			},
			120_000,
		);
	});
}
