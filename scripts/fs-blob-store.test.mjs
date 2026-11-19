import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, test } from 'node:test';
import { describeBlobStore } from '../test/history/conformance/blob-store.ts';
import { FsBlobStore } from './fs-blob-store.mjs';

// The conformance suite's matchers (test/history/conformance/blob-store.ts, `Expect`) over node:assert.
const expect = (actual) => ({
	toBe: (expected) => assert.equal(actual, expected),
	toEqual: (expected) => assert.deepEqual(actual, expected),
	toBeNull: () => assert.equal(actual, null),
	toBeLessThanOrEqual: (expected) => assert.ok(actual <= expected, `${actual} > ${expected}`),
});

const directory = await mkdtemp(join(tmpdir(), 'apron-fs-blob-store-'));
after(() => rm(directory, { recursive: true, force: true }));

describeBlobStore('FsBlobStore', () => new FsBlobStore(directory), {
	describe,
	it: (name, body, timeout) => it(name, { timeout }, body),
	expect,
});

test('FsBlobStore refuses keys that leave its directory or cannot be files', async () => {
	const store = new FsBlobStore(join(directory, 'keys'));
	for (const key of ['', '/etc/passwd', '../outside', 'a/../../outside', 'a/./b', 'a//b', 'a/', 'a\\b', 'C:/x', '.apron-tmp-x']) {
		await assert.rejects(store.put(key, 'x'), Error, `key ${JSON.stringify(key)}`);
		await assert.rejects(store.get(key), Error, `key ${JSON.stringify(key)}`);
	}
	// Dots inside a segment are fine.
	await store.put('a/..b/c..', 'ok');
	assert.equal(await (await store.get('a/..b/c..')).text(), 'ok');
});

test('FsBlobStore leaves no temporary files and removes emptied directories', async () => {
	const root = join(directory, 'tidy');
	const store = new FsBlobStore(root);
	await store.put('room/one.jsonl', '1');
	const writer = await store.writer('room/two.jsonl');
	await writer.write('2');
	// A pending writer's temporary file is not listed.
	assert.deepEqual((await store.list('')).keys.map((k) => k.key), ['room/one.jsonl']);
	await writer.close();
	const aborted = await store.writer('room/three.jsonl');
	await aborted.write('3');
	await aborted.abort();
	assert.deepEqual(await readdir(join(root, 'room')), ['one.jsonl', 'two.jsonl']);
	await store.delete(['room/one.jsonl', 'room/two.jsonl']);
	assert.deepEqual(await readdir(root), []);
});
