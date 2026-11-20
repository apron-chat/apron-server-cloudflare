/*
 * The cold tier: the oldest history, kept as large chunks of the whole log
 * (every room's records over a stretch of log IDs, chunks.ts) in a
 * BlobStore, listed in a ChunkIndex the caller owns.
 *
 * - Appending: a copy brings a chunk's worth at once (`appendBatch`), and
 *   becomes one chunk, keyed by its first log ID. A copy retried over the
 *   same stretch rewrites the same key. A range overlapping chunks already
 *   listed (a retry over a source that changed since) is merged with them
 *   into one chunk, the new records winning, and they go: INSERT OR REPLACE.
 * - Reading: chunks are ordered and do not overlap, so a page reads the
 *   chunks over its window that hold one of its rooms, in page order, until
 *   it is full. A few decoded chunks are cached, as a page often reads the
 *   one the last page read.
 * - Retention and trimming: by whole chunks, by count, bytes and age (a
 *   chunk's time is its last log ID: log IDs are commit times). A floor that
 *   cuts a chunk (one set from above) rewrites it without what is below.
 * - /purge and /rename (applyOp): a sweep in log order over the chunks that
 *   can hold what they change, a few chunks a step, rewriting only those
 *   that change. The index names each chunk's users, so a rename visits
 *   only chunks naming its user, and a purge starts at the first chunk
 *   naming one of its users (or at the oldest, when the op names messages
 *   to drop reactions on: those can be anywhere). From there a purge reads
 *   every chunk, since reactions on its users' messages come later in the
 *   log; messages of theirs it finds are told to the pipeline before the
 *   chunk is rewritten.
 *
 * It depends on nothing but its BlobStore, ChunkIndex, codec chain and
 * clock: what the codecs do to the bytes, and where the index is kept, are
 * the caller's. It assumes one writer (the Durable Object).
 */

import type { ArchiveCodec, ArchiveHeader } from "@apron/archive";
import { type ChatRecord, type Clock, type HistoryOp, type HistoryQuery, type RecordRange, type Retention, type TierStats, authoredMessages, limitByLogId, purgedRecord, renamedRecord, thresholdCount, toRange } from "../records";
import type { BlobStore } from "../storage/store";
import type { FloorContext, LowerTier, OpStep } from "../tier";
import { type ChunkIndex, type ChunkRef, chunkKey, chunkRef, readChunk, uniqueRecords, writeChunk } from "./chunks";

/** Log IDs a chunk holds, as a copy brings them (appendBatch). */
const CHUNK_LOG_IDS = 10_000;
/** Chunks one step of a /purge or /rename reads at most. */
const OP_CHUNKS = 4;
/** Decoded chunks kept in memory. */
const CACHED_CHUNKS = 2;

export interface ColdTierOptions {
	name: string;
	store: BlobStore;
	index: ChunkIndex;
	/** The codec chain chunks are stored through; opaque here. */
	codecs: readonly ArchiveCodec[];
	/** Key prefix, such as `history/<server>/`. */
	prefix: string;
	clock: Clock;
	/** Each chunk's header (`server` and the like); `apron_archive` and `exported_at` are set here. */
	header?: Partial<ArchiveHeader>;
	/** Log IDs a chunk holds (default 10,000). */
	chunkLogIds?: number;
	/** Chunks one /purge or /rename step reads at most (default 4). */
	opChunks?: number;
	/** Decoded chunks kept in memory (default 2; 0 for none). */
	cachedChunks?: number;
}

export class ColdHistoryTier implements LowerTier {
	readonly name: string;
	readonly appendBatch: number;
	private readonly store: BlobStore;
	private readonly index: ChunkIndex;
	private readonly codecs: readonly ArchiveCodec[];
	private readonly prefix: string;
	private readonly clock: Clock;
	private readonly header: Partial<ArchiveHeader>;
	private readonly opChunks: number;
	private readonly cacheSize: number;
	/** Decoded chunks by key, least recently used first. */
	private readonly cache = new Map<string, ChatRecord[]>();

	constructor(options: ColdTierOptions) {
		this.name = options.name;
		this.store = options.store;
		this.index = options.index;
		this.codecs = options.codecs;
		this.prefix = options.prefix;
		this.clock = options.clock;
		this.header = options.header ?? {};
		this.appendBatch = options.chunkLogIds ?? CHUNK_LOG_IDS;
		this.opChunks = options.opChunks ?? OP_CHUNKS;
		this.cacheSize = options.cachedChunks ?? CACHED_CHUNKS;
	}

	/** Every chunk, by first log ID. */
	private async chunks(): Promise<ChunkRef[]> {
		return (await this.index.list()).sort((a, b) => a.first - b.first);
	}

	private async load(ref: ChunkRef): Promise<ChatRecord[]> {
		const cached = this.cache.get(ref.key);
		if (cached) {
			this.cache.delete(ref.key);
			this.cache.set(ref.key, cached);
			return cached;
		}
		const records = await readChunk(this.store, ref.key);
		if (this.cacheSize > 0) {
			this.cache.set(ref.key, records);
			for (const key of this.cache.keys()) {
				if (this.cache.size <= this.cacheSize) break;
				this.cache.delete(key);
			}
		}
		return records;
	}

	/** Writes `records` as the chunk `[first, last]` under `key` (replacing what is there); returns its ref. */
	private async write(key: string, records: readonly ChatRecord[], bounds: { first: number; last: number }): Promise<ChunkRef> {
		this.cache.delete(key);
		const bytes = await writeChunk(this.store, key, records, this.codecs, { ...this.header, apron_archive: 1, exported_at: new Date(this.clock.now()).toISOString() });
		return chunkRef(key, records, bounds, bytes);
	}

	/** Drops chunks from the store, then from the index (a crash between leaves entries only a retried trim or sweep visits again). */
	private async discard(refs: readonly ChunkRef[]): Promise<void> {
		if (!refs.length) return;
		for (const ref of refs) this.cache.delete(ref.key);
		await this.store.delete(refs.map((ref) => ref.key));
		await this.index.update({ remove: refs.map((ref) => ref.first) });
	}

	async append(range: RecordRange): Promise<void> {
		const fresh = uniqueRecords(range.records);
		if (!fresh.length) return;
		const first = fresh[0].log_id;
		const last = fresh[fresh.length - 1].log_id;
		const overlapping = (await this.chunks()).filter((ref) => ref.first <= last && ref.last >= first);
		const held = (await Promise.all(overlapping.map((ref) => this.load(ref)))).flat();
		const bounds = { first: Math.min(first, ...overlapping.map((ref) => ref.first)), last: Math.max(last, ...overlapping.map((ref) => ref.last)) };
		// A chunk listed at the same first is rewritten in place, under its key.
		const key = overlapping.find((ref) => ref.first === bounds.first)?.key ?? chunkKey(this.prefix, bounds.first, this.codecs);
		const ref = await this.write(key, uniqueRecords([...held, ...fresh]), bounds);
		// The new chunk is listed, and those it replaces unlisted, at once; their objects go after.
		await this.index.update({ put: [ref], remove: overlapping.filter((old) => old.first !== ref.first).map((old) => old.first) });
		const gone = overlapping.filter((old) => old.key !== key);
		for (const old of gone) this.cache.delete(old.key);
		if (gone.length) await this.store.delete(gone.map((old) => old.key));
	}

	/** Records of the chunks `refs` hands out in page order, kept by `keep`, until `limit` distinct log IDs are in. */
	private async gather(refs: readonly ChunkRef[], keep: (record: ChatRecord) => boolean, limit: number, forward: boolean): Promise<ChatRecord[]> {
		const found: ChatRecord[] = [];
		const ids = new Set<number>();
		for (const ref of refs) {
			if (ids.size >= limit) break;
			for (const record of await this.load(ref)) {
				if (!keep(record)) continue;
				found.push(record);
				ids.add(record.log_id);
			}
		}
		return limitByLogId(uniqueRecords(found), limit, forward);
	}

	async scan(from: number, limit: number): Promise<RecordRange> {
		const refs = (await this.chunks()).filter((ref) => ref.last >= from);
		return toRange(await this.gather(refs, (record) => record.log_id >= from, limit, true));
	}

	async read(query: HistoryQuery): Promise<ChatRecord[]> {
		const rooms = new Set(query.roomIds);
		const refs = (await this.chunks()).filter((ref) => ref.first <= query.upper && ref.last >= query.lower && ref.rooms.some((room) => rooms.has(room)));
		if (!query.forward) refs.reverse();
		return this.gather(refs, (record) => rooms.has(record.room_id) && record.log_id >= query.lower && record.log_id <= query.upper, query.limit, query.forward);
	}

	async lookup(logIds: readonly number[]): Promise<ChatRecord[]> {
		const wanted = new Set(logIds);
		const found: ChatRecord[] = [];
		for (const ref of await this.chunks()) {
			if (!logIds.some((id) => id >= ref.first && id <= ref.last)) continue;
			found.push(...(await this.load(ref)).filter((record) => wanted.has(record.log_id)));
		}
		return uniqueRecords(found);
	}

	/** From the index alone: a chunk the bounds cut counts in proportion to the part of its stretch inside them. */
	async stats(context: { lower?: number; upper?: number } = {}): Promise<TierStats> {
		const lower = context.lower ?? 1;
		const upper = context.upper ?? Number.MAX_SAFE_INTEGER;
		let records = 0;
		let bytes = 0;
		let oldest: number | undefined;
		let newest: number | undefined;
		for (const ref of await this.chunks()) {
			const from = Math.max(ref.first, lower);
			const to = Math.min(ref.last, upper);
			if (from > to || !ref.records) continue;
			const share = (to - from + 1) / (ref.last - ref.first + 1);
			records += share >= 1 ? ref.records : Math.round(ref.records * share);
			bytes += share >= 1 ? ref.bytes : Math.round(ref.bytes * share);
			oldest ??= from;
			newest = to;
		}
		return { records, bytes, ...(oldest !== undefined ? { oldest } : {}), ...(newest !== undefined ? { newest } : {}) };
	}

	/**
	 * The floor a retention allows over whole chunks wholly below `below`
	 * (records at or past it are copies held above): the newest chunks that
	 * hold the count's and bytes' threshold share stay, chunks older than
	 * `ageMs` go, and none younger than `minAgeMs` does. The floor is a
	 * chunk's first; undefined while nothing need leave.
	 */
	async floorFor(retention: Retention, context: FloorContext): Promise<number | undefined> {
		const own = (await this.chunks()).filter((ref) => ref.last < context.below);
		if (!own.length) return undefined;
		let floor: number | undefined;
		for (const [limit, size] of [[thresholdCount(retention.records, retention.thresholdPercent), (ref: ChunkRef) => ref.records], [thresholdCount(retention.bytes, retention.thresholdPercent), (ref: ChunkRef) => ref.bytes]] as const) {
			if (limit <= 0) continue;
			let kept = 0;
			for (let index = own.length - 1; index > 0; index -= 1) {
				kept += size(own[index]);
				if (kept >= limit) {
					floor = Math.max(floor ?? 0, own[index].first);
					break;
				}
			}
		}
		if (retention.ageMs && retention.ageMs > 0) {
			const cutoff = context.now - retention.ageMs;
			const fresh = own.find((ref) => ref.last >= cutoff);
			const ageFloor = fresh ? fresh.first : own[own.length - 1].last + 1;
			floor = Math.max(floor ?? 0, ageFloor);
		}
		if (floor !== undefined && retention.minAgeMs && retention.minAgeMs > 0) {
			const young = own.find((ref) => ref.last >= context.now - retention.minAgeMs!);
			if (young) floor = Math.min(floor, young.first);
		}
		return floor === undefined || floor <= own[0].first ? undefined : floor;
	}

	/**
	 * Deletes chunks wholly below `floor`, oldest first, until at least `max`
	 * records went; a chunk the floor cuts is rewritten without its records
	 * below it. Returns how many records went.
	 */
	async trimBelow(floor: number, max: number): Promise<number> {
		let removed = 0;
		for (const ref of await this.chunks()) {
			if (ref.first >= floor || removed >= max) break;
			if (ref.last < floor) {
				await this.discard([ref]);
				removed += ref.records;
				continue;
			}
			const records = await this.load(ref);
			const kept = records.filter((record) => record.log_id >= floor);
			removed += records.length - kept.length;
			if (!kept.length) {
				await this.discard([ref]);
				continue;
			}
			const cut = await this.write(ref.key, kept, { first: floor, last: ref.last });
			await this.index.update({ put: [cut], remove: [ref.first] });
		}
		return removed;
	}

	/**
	 * A bounded step of /purge or /rename (see the top of the file): up to
	 * `opChunks` chunks, from `step.cursor` (a log ID) on. Returns the log
	 * ID to go on from, or undefined once no chunk is left.
	 */
	async applyOp(op: HistoryOp, step: OpStep): Promise<string | undefined> {
		const all = await this.chunks();
		let from = step.cursor !== undefined ? Number(step.cursor) : undefined;
		if (from === undefined) {
			const users = op.op === "purge" ? op.userIds : [op.from];
			const start = op.op === "purge" && op.messageIds.length ? all[0] : all.find((ref) => ref.users.some((user) => users.includes(user)));
			if (!start) return undefined;
			from = start.first;
		}
		const ahead = all.filter((ref) => ref.last >= from!);
		const visit = op.op === "rename" ? ahead.filter((ref) => ref.users.includes(op.from)) : ahead;
		const messages = new Set(op.op === "purge" ? op.messageIds : []);
		for (const ref of visit.slice(0, this.opChunks)) {
			const records = await this.load(ref);
			let rewritten: ChatRecord[];
			if (op.op === "purge") {
				const fresh = authoredMessages(records, op.userIds).filter((id) => !messages.has(id));
				if (fresh.length) {
					await step.found(fresh);
					for (const id of fresh) messages.add(id);
				}
				rewritten = records.flatMap((record) => {
					const json = purgedRecord(record, op.userIds, [...messages]);
					return json === null ? [] : [json === record.record_json ? record : { ...record, record_json: json }];
				});
			} else {
				rewritten = records.map((record) => {
					const json = renamedRecord(record, op.from, op.to);
					return json === record.record_json ? record : { ...record, record_json: json };
				});
			}
			await this.rewrite(ref, records, rewritten);
		}
		const next = visit[this.opChunks];
		return next ? String(Math.max(next.first, from)) : undefined;
	}

	/** Puts a chunk's rewritten records in place of `records` (dropping it when none is left), and its listing to match. */
	private async rewrite(ref: ChunkRef, records: readonly ChatRecord[], rewritten: readonly ChatRecord[]): Promise<void> {
		if (!rewritten.length) {
			await this.discard([ref]);
			return;
		}
		const changed = rewritten.length !== records.length || rewritten.some((record, index) => record !== records[index]);
		if (changed) {
			const updated = await this.write(ref.key, rewritten, ref);
			await this.index.update({ put: [updated] });
			return;
		}
		// Unchanged, but listed as before a rewrite a crash cut short: listed as it is.
		const listed = chunkRef(ref.key, records, ref, ref.bytes);
		if (listed.records !== ref.records || listed.rooms.join() !== ref.rooms.join() || listed.users.join() !== ref.users.join()) await this.index.update({ put: [listed] });
	}
}
