/*
 * A BlobStore over a local directory (PLAN §9), for Node scripts that export
 * to or import from local files. Node only: the Worker never imports it (it
 * has no filesystem), so it lives under scripts/ rather than src/.
 *
 * A key is a relative path under the directory, `/`-separated. Keys that
 * could leave the directory (absolute, `..`, backslashes) or that a
 * filesystem cannot hold (empty segments, a trailing `/`) are refused. Bodies
 * are written to a temporary file beside their target and renamed into place,
 * so a reader never sees half a body and a crash leaves only a temporary
 * file, which listings skip. It passes the same conformance suite as the
 * Worker's stores (scripts/fs-blob-store.test.mjs). A script registers it as
 * the `fs` provider (fsBlobStores) with the history code
 * (src/history/config.ts, BlobStoreProviders); the Worker's registry has
 * only `r2`.
 */

import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

/** @typedef {import('../src/history/blob/store.ts').BlobStore} BlobStore */
/** @typedef {import('../src/history/blob/store.ts').BlobObject} BlobObject */
/** @typedef {import('../src/history/blob/store.ts').BlobWriter} BlobWriter */
/** @typedef {import('../src/history/blob/store.ts').BlobListing} BlobListing */
/** @typedef {import('../src/history/blob/store.ts').BlobListOptions} BlobListOptions */
/** @typedef {import('../src/history/config.ts').BlobStoreProviders} BlobStoreProviders */

/** Temporary files start with this; keys may not, and listings skip them. */
const TEMP_MARK = '.apron-tmp-';

/** @param {unknown} error */
const missing = (error) => /** @type {{ code?: string }} */ (error)?.code === 'ENOENT';

/** @implements {BlobStore} */
export class FsBlobStore {
	/** @param {string} directory The root; created on the first write if absent. */
	constructor(directory) {
		this.directory = resolve(directory);
	}

	/**
	 * The file a key names, after checking the key stays inside the directory.
	 * @param {string} key
	 */
	path(key) {
		if (typeof key !== 'string' || key === '') throw new Error('a blob key must be a non-empty string');
		if (key.startsWith('/') || key.includes('\\') || /^[A-Za-z]:/.test(key) || key.includes('\0')) {
			throw new Error(`blob key ${JSON.stringify(key)} must be a relative path with / separators`);
		}
		for (const segment of key.split('/')) {
			if (segment === '' || segment === '.' || segment === '..') {
				throw new Error(`blob key ${JSON.stringify(key)} has an empty, "." or ".." segment`);
			}
			if (segment.startsWith(TEMP_MARK)) throw new Error(`blob key ${JSON.stringify(key)} uses the reserved prefix ${TEMP_MARK}`);
		}
		const path = join(this.directory, ...key.split('/'));
		if (!path.startsWith(this.directory + sep)) throw new Error(`blob key ${JSON.stringify(key)} leaves the store's directory`);
		return path;
	}

	/** @param {string} path */
	temporary(path) {
		return join(dirname(path), `${TEMP_MARK}${randomBytes(8).toString('hex')}`);
	}

	/**
	 * @param {string} key
	 * @returns {Promise<BlobObject | null>}
	 */
	async get(key) {
		const path = this.path(key);
		let size;
		try {
			const info = await stat(path);
			if (!info.isFile()) return null;
			size = info.size;
		} catch (error) {
			if (missing(error)) return null;
			throw error;
		}
		return {
			size,
			text: () => readFile(path, 'utf8'),
			stream: async () => /** @type {ReadableStream<Uint8Array>} */ (Readable.toWeb(createReadStream(path))),
		};
	}

	/**
	 * @param {string} key
	 * @param {string} body
	 * @param {{ contentType?: string, metadata?: Record<string, string> }} [_options] Accepted; a file has no content type or metadata.
	 */
	async put(key, body, _options) {
		const path = this.path(key);
		await mkdir(dirname(path), { recursive: true });
		const temporary = this.temporary(path);
		try {
			await writeFile(temporary, body, 'utf8');
			await rename(temporary, path);
		} catch (error) {
			await unlink(temporary).catch(() => {});
			throw error;
		}
	}

	/**
	 * @param {string} key
	 * @param {{ contentType?: string, metadata?: Record<string, string> }} [_options] Accepted; a file has no content type or metadata.
	 * @returns {Promise<BlobWriter>}
	 */
	async writer(key, _options) {
		const path = this.path(key);
		await mkdir(dirname(path), { recursive: true });
		const temporary = this.temporary(path);
		const file = await open(temporary, 'wx');
		let done = false;
		const ensureOpen = () => {
			if (done) throw new Error(`the writer for ${key} is already closed or aborted`);
		};
		return {
			write: async (chunk) => {
				ensureOpen();
				if (typeof chunk === 'string') {
					if (chunk !== '') await file.writeFile(chunk, 'utf8');
				} else if (chunk.byteLength) {
					await file.writeFile(chunk);
				}
			},
			close: async () => {
				ensureOpen();
				done = true;
				try {
					await file.close();
					await rename(temporary, path);
				} catch (error) {
					await unlink(temporary).catch(() => {});
					throw error;
				}
			},
			abort: async () => {
				if (done) return;
				done = true;
				await file.close().catch(() => {});
				await unlink(temporary).catch(() => {});
			},
		};
	}

	/** @param {readonly string[]} keys */
	async delete(keys) {
		for (const key of keys) {
			const path = this.path(key);
			try {
				await unlink(path);
			} catch (error) {
				if (missing(error)) continue;
				throw error;
			}
			// Drop the directories the delete emptied, up to the root, so a
			// listing of an emptied room shows nothing left behind.
			for (let parent = dirname(path); parent !== this.directory && parent.startsWith(this.directory + sep); parent = dirname(parent)) {
				try {
					await rmdir(parent);
				} catch {
					break;
				}
			}
		}
	}

	/**
	 * Keys under `prefix`, sorted. The cursor is the page's last key.
	 * @param {string} prefix
	 * @param {BlobListOptions} [options]
	 * @returns {Promise<BlobListing>}
	 */
	async list(prefix, options = {}) {
		const after = options.cursor ?? options.startAfter;
		const limit = Math.max(1, Math.min(options.limit ?? 1000, 1000));
		/** @type {Array<{ key: string; size: number }>} */
		const found = [];
		await this.walk('', prefix, after, found);
		found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		const keys = found.slice(0, limit);
		return found.length > limit ? { keys, cursor: keys[keys.length - 1].key } : { keys };
	}

	/**
	 * Collects the files under `relative`, skipping directories no key under
	 * `prefix` can be in.
	 * @param {string} relative A key prefix ending in `/`, or empty for the root.
	 * @param {string} prefix
	 * @param {string | undefined} after
	 * @param {Array<{ key: string; size: number }>} found
	 */
	async walk(relative, prefix, after, found) {
		let entries;
		try {
			entries = await readdir(join(this.directory, ...relative.split('/').filter(Boolean)), { withFileTypes: true });
		} catch (error) {
			if (missing(error)) return;
			throw error;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(TEMP_MARK)) continue;
			const key = relative + entry.name;
			if (entry.isDirectory()) {
				const directory = `${key}/`;
				if (directory.startsWith(prefix) || prefix.startsWith(directory)) await this.walk(directory, prefix, after, found);
			} else if (entry.isFile() && key.startsWith(prefix) && (after === undefined || key > after)) {
				found.push({ key, size: (await stat(join(this.directory, ...key.split('/')))).size });
			}
		}
	}
}

/**
 * A registry with `fs` alone, over `directory` (the history code's
 * blobStores, with blobProvider "fs").
 * @param {string} directory
 * @returns {BlobStoreProviders}
 */
export function fsBlobStores(directory) {
	const store = new FsBlobStore(directory);
	return { fs: () => store };
}
