/*
 * The blob history tier (PLAN §5, §9): the log kept as per-room segments in
 * a BlobStore (R2 in the Worker), each a complete ARCHIVE.md v1 file that
 * apron-web or scene.apron.chat can open as it is, found through a
 * SegmentIndex.
 *
 * - Appending: a range is split by room, and each room's share becomes one
 *   segment. Its key is a function of the room and the stretch, so a
 *   repeated append rewrites the same object. A share that overlaps
 *   segments already indexed for the room (a copy retried over a source
 *   that changed) is merged with them into one segment, the new records
 *   winning, and the old ones go: INSERT OR REPLACE semantics.
 * - Moves: the pipeline hands a move as two records, one per room, and each
 *   room's segment keeps its own. A segment's records are read back in the
 *   segment's room, one per log ID (segments.ts, decodeSegment).
 * - Reads: single-room (`multiRoom` false: the pipeline sends no
 *   joined-rooms pages here). Segments overlapping the window are fetched a
 *   few at a time, in page order, until the page is full; decoded segments
 *   are cached by key up to a byte cap. Where segments overlap (a crash
 *   during a merge leaves both), records are de-duplicated by room and log
 *   ID. An indexed segment whose object is missing reads as empty and is
 *   dropped from the index.
 * - Retention: by count (`records`, counting each room's copy) and bytes
 *   over whole segments, and by age with a segment's `last` as its time
 *   (log IDs are commit times, PROTOCOL §2.1). floorFor returns a segment's
 *   first, lowered until no segment straddles it, so trimming removes whole
 *   segments. trimBelow still handles a floor that cuts a segment (the
 *   pipeline may set one from the tier above): it rewrites that segment
 *   without the records below the floor.
 * - Trimming removes a segment from the index, then deletes its object: a
 *   crash in between leaves an unindexed object, which reads never see; an
 *   index rebuilt with `floor` skips it (segments.ts, RebuildOptions).
 * - Compaction (upkeep): a room's adjacent small segments that are final
 *   (wholly below `final`, the floor of the last rewritable tier) merge into
 *   one up to `segmentRecords` / `segmentBytes`, compacted per PROTOCOL
 *   §4.3.4 unless `compactRecords` is false. Segments that overlap merge
 *   whatever their size. The new segment is written and indexed before the
 *   old ones leave the index and then the store, so a crash at any point
 *   leaves either both (reads de-duplicate, the next upkeep merges them) or
 *   the new one.
 *
 * Deliberately not a RewritableTier: /purge and /rename stop above it
 * (decision 3).
 *
 * Records read back have `commit_ms` equal to their `log_id`: the wire
 * shape carries no commit time.
 */

import { jsonlWriter, utf8Length } from "../archive/format";
import type { ArchiveHeader, ArchivedUser, RoomListing } from "../archive/types";
import { type ChatRecord, type Clock, type HistoryQuery, type RecordRange, type Retention, type TierStats, byLog, limitByLogId, thresholdCount, toRange } from "../records";
import { compact } from "../render";
import type { FloorContext, HistoryTier } from "../tier";
import { type SegmentCursor, type SegmentIndex, type SegmentRef, decodeSegment, segmentKey } from "./segments";
import type { BlobStore } from "./store";

export const DEFAULT_SEGMENT_RECORDS = 1_000;
export const DEFAULT_SEGMENT_BYTES = 1_000_000;
export const DEFAULT_CACHE_BYTES = 8 * 1024 * 1024;
/** Segments fetched at once by a read. */
const READ_PARALLEL = 4;
/** Segments a scan asks the index for at a time. */
const SCAN_PAGE = 16;
/** Rooms one upkeep step looks at for something to merge. */
const UPKEEP_ROOMS = 32;

export interface BlobHistoryTierOptions {
	name: string;
	store: BlobStore;
	index: SegmentIndex;
	/** Key prefix, such as `history/<server>/`. */
	prefix: string;
	/** Each segment's header (`server` and the like); `apron_archive` and `exported_at` are set here. */
	header?: Partial<ArchiveHeader>;
	clock: Clock;
	/** Compaction's targets for a merged segment. */
	segmentRecords?: number;
	segmentBytes?: number;
	/** The decoded-segment cache's cap, by object size. 0 turns it off. */
	cacheBytes?: number;
	/** Whether compaction also folds records (PROTOCOL §4.3.4). Default true. */
	compactRecords?: boolean;
}

/** A small LRU cache of decoded segments, by key, capped by object size. */
class SegmentCache {
	private readonly entries = new Map<string, { records: ChatRecord[]; bytes: number }>();
	private total = 0;

	constructor(private readonly cap: number) {}

	get(key: string): ChatRecord[] | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.records;
	}

	set(key: string, records: ChatRecord[], bytes: number): void {
		this.drop(key);
		if (bytes > this.cap) return;
		this.entries.set(key, { records, bytes });
		this.total += bytes;
		for (const [oldest, entry] of this.entries) {
			if (this.total <= this.cap) break;
			this.entries.delete(oldest);
			this.total -= entry.bytes;
		}
	}

	drop(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.entries.delete(key);
		this.total -= entry.bytes;
	}
}

type JsonObject = Record<string, unknown>;

/** Logged room fields for a listing: a room record without its log position and delivery fields. */
const NOT_LISTED = new Set(["prev_log_id", "latest_log_id", "history_log_id", "members", "member_count"]);

/** Records keyed by room and log ID, the first one kept. */
function dedupe(records: Iterable<ChatRecord>, into = new Map<string, ChatRecord>()): Map<string, ChatRecord> {
	for (const record of records) {
		const id = `${record.log_id}\u0000${record.room_id}`;
		if (!into.has(id)) into.set(id, record);
	}
	return into;
}

export class BlobHistoryTier implements HistoryTier {
	readonly name: string;
	readonly multiRoom = false;
	private readonly store: BlobStore;
	readonly index: SegmentIndex;
	private readonly prefix: string;
	private readonly header: Partial<ArchiveHeader>;
	private readonly clock: Clock;
	private readonly segmentRecords: number;
	private readonly segmentBytes: number;
	private readonly compactRecords: boolean;
	private readonly cache: SegmentCache;
	/** Where upkeep looks for rooms to merge next. */
	private upkeepRoom = "";

	constructor(options: BlobHistoryTierOptions) {
		this.name = options.name;
		this.store = options.store;
		this.index = options.index;
		this.prefix = options.prefix;
		this.header = options.header ?? {};
		this.clock = options.clock;
		this.segmentRecords = options.segmentRecords ?? DEFAULT_SEGMENT_RECORDS;
		this.segmentBytes = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES;
		this.compactRecords = options.compactRecords ?? true;
		this.cache = new SegmentCache(options.cacheBytes ?? DEFAULT_CACHE_BYTES);
	}

	/** A segment's ARCHIVE.md text: header, the room's listing with the users its records name, then its records. */
	async encode(roomId: string, records: readonly ChatRecord[], bounds: { first: number; last: number }): Promise<string> {
		let listing: RoomListing = { room_id: roomId };
		const users = new Map<string, ArchivedUser>();
		const note = (user: unknown) => {
			if (user && typeof user === "object" && typeof (user as ArchivedUser).user_id === "string") users.set((user as ArchivedUser).user_id, user as ArchivedUser);
		};
		for (const record of records) {
			const value = JSON.parse(record.record_json) as JsonObject;
			if (record.kind === "room" && value.room_id === roomId) {
				// The latest room record describes the room: a room record is complete (PROTOCOL §4.2).
				listing = { room_id: roomId };
				for (const [key, item] of Object.entries(value)) if (!NOT_LISTED.has(key)) listing[key] = item;
			} else if (record.kind === "message") note(value.from);
			else if (record.kind === "reactions" && Array.isArray(value.reactions)) for (const set of value.reactions) note((set as JsonObject)?.from);
			else if (record.kind === "membership" && Array.isArray(value.members)) for (const member of value.members) note((member as JsonObject)?.user);
		}
		listing.room_id = roomId;
		listing.history_log_id = String(bounds.first);
		listing.latest_log_id = String(bounds.last);
		const lines: string[] = [];
		const writer = jsonlWriter(async (line) => {
			lines.push(line);
		});
		await writer.header({ ...this.header, apron_archive: 1, exported_at: new Date(this.clock.now()).toISOString() });
		await writer.listing({ not_joined: [listing], users: [...users.values()] });
		await writer.records(records);
		await writer.close();
		return lines.join("");
	}

	/** Writes a room's records as one segment (bounds default to theirs) and returns its ref; the index is the caller's. */
	private async write(roomId: string, records: readonly ChatRecord[], bounds?: { first: number; last: number }): Promise<SegmentRef> {
		const sorted = [...records].sort(byLog);
		const span = bounds ?? { first: sorted[0].log_id, last: sorted[sorted.length - 1].log_id };
		const key = segmentKey(this.prefix, { roomId, ...span });
		const body = await this.encode(roomId, sorted, span);
		this.cache.drop(key);
		await this.store.put(key, body, { contentType: "application/jsonl" });
		return { roomId, ...span, key, records: sorted.length, bytes: utf8Length(body) };
	}

	/** Drops segments from the index, then their objects (see the top of the file). */
	private async discard(refs: readonly SegmentRef[]): Promise<void> {
		if (!refs.length) return;
		await this.index.remove(refs);
		for (const ref of refs) this.cache.drop(ref.key);
		await this.store.delete(refs.map((ref) => ref.key));
	}

	/** A segment's records, in its room; empty (and dropped from the index) when its object is missing. */
	async load(ref: SegmentRef): Promise<ChatRecord[]> {
		const cached = this.cache.get(ref.key);
		if (cached) return cached;
		const object = await this.store.get(ref.key);
		if (!object) {
			await this.index.remove([ref]);
			return [];
		}
		const records = await decodeSegment(ref.roomId, await object.text());
		this.cache.set(ref.key, records, object.size);
		return records;
	}

	async append(range: RecordRange): Promise<void> {
		const rooms = new Map<string, ChatRecord[]>();
		for (const record of range.records) {
			const list = rooms.get(record.room_id);
			if (list) list.push(record);
			else rooms.set(record.room_id, [record]);
		}
		for (const [roomId, share] of rooms) {
			// One record per log ID, the last given winning.
			const byId = new Map<number, ChatRecord>();
			for (const record of share) byId.set(record.log_id, record);
			const fresh = [...byId.values()].sort(byLog);
			const overlapping = await this.index.find([roomId], fresh[0].log_id, fresh[fresh.length - 1].log_id);
			for (const ref of overlapping) for (const record of await this.load(ref)) if (!byId.has(record.log_id)) byId.set(record.log_id, record);
			const bounds = overlapping.length
				? { first: Math.min(fresh[0].log_id, ...overlapping.map((ref) => ref.first)), last: Math.max(fresh[fresh.length - 1].log_id, ...overlapping.map((ref) => ref.last)) }
				: undefined;
			const ref = await this.write(roomId, [...byId.values()], bounds);
			await this.index.add([ref]);
			await this.discard(overlapping.filter((old) => old.key !== ref.key));
		}
	}

	/**
	 * Fills a page from segments taken in page order (`next` hands them out):
	 * stops once `limit` distinct log IDs are in and the next segment can
	 * only hold log IDs past them. `keep` filters records.
	 */
	private async gather(next: () => Promise<SegmentRef | undefined>, keep: (record: ChatRecord) => boolean, limit: number, forward: boolean): Promise<ChatRecord[]> {
		const found = new Map<string, ChatRecord>();
		const ids = new Set<number>();
		const boundary = (): number | undefined => {
			if (ids.size < limit) return undefined;
			const sorted = [...ids].sort((a, b) => (forward ? a - b : b - a));
			return sorted[limit - 1];
		};
		let pending = await next();
		while (pending) {
			const batch: SegmentRef[] = [];
			while (pending && batch.length < READ_PARALLEL) {
				const edge = boundary();
				if (edge !== undefined && (forward ? pending.first > edge : pending.last < edge)) {
					pending = undefined;
					break;
				}
				batch.push(pending);
				pending = await next();
			}
			const loaded = await Promise.all(batch.map((ref) => this.load(ref)));
			for (const records of loaded) {
				const kept = records.filter(keep);
				dedupe(kept, found);
				for (const record of kept) ids.add(record.log_id);
			}
		}
		return limitByLogId([...found.values()], limit, forward);
	}

	async scan(from: number, limit: number): Promise<RecordRange> {
		let page: SegmentRef[] = [];
		let cursor: SegmentCursor | undefined;
		let done = false;
		const next = async (): Promise<SegmentRef | undefined> => {
			if (!page.length && !done) {
				page = await this.index.after(from, SCAN_PAGE, cursor);
				if (page.length < SCAN_PAGE) done = true;
				if (page.length) cursor = { first: page[page.length - 1].first, roomId: page[page.length - 1].roomId };
			}
			return page.shift();
		};
		return toRange(await this.gather(next, (record) => record.log_id >= from, limit, true));
	}

	async read(query: HistoryQuery): Promise<ChatRecord[]> {
		const refs = await this.index.find(query.roomIds, query.lower, query.upper);
		refs.sort(query.forward ? (a, b) => a.first - b.first || a.last - b.last : (a, b) => b.last - a.last || b.first - a.first);
		const rooms = new Set(query.roomIds);
		return this.gather(async () => refs.shift(), (record) => rooms.has(record.room_id) && record.log_id >= query.lower && record.log_id <= query.upper, query.limit, query.forward);
	}

	async lookup(logIds: readonly number[]): Promise<ChatRecord[]> {
		const wanted = new Set(logIds);
		const refs = new Map<string, SegmentRef>();
		for (const id of wanted) for (const ref of await this.index.overlapping(id, id)) refs.set(ref.key, ref);
		const found = new Map<string, ChatRecord>();
		for (const ref of refs.values()) dedupe((await this.load(ref)).filter((record) => wanted.has(record.log_id)), found);
		return [...found.values()].sort(byLog);
	}

	/**
	 * From the index alone: segments cut by the bounds count in proportion to
	 * the part of their stretch inside them, and `oldest` and `newest` are
	 * the bounds of the segments' stretches, so both are approximate when
	 * the bounds cut segments. Each room's copy of a move counts.
	 */
	async stats(context: { lower?: number; upper?: number } = {}): Promise<TierStats> {
		const lower = context.lower ?? 1;
		const upper = context.upper ?? Number.MAX_SAFE_INTEGER;
		const refs = await this.index.overlapping(lower, upper);
		if (!refs.length) return { records: 0, bytes: 0 };
		let records = 0;
		let bytes = 0;
		let oldest = Number.POSITIVE_INFINITY;
		let newest = 0;
		for (const ref of refs) {
			const from = Math.max(ref.first, lower);
			const to = Math.min(ref.last, upper);
			const share = (to - from + 1) / (ref.last - ref.first + 1);
			records += share >= 1 ? ref.records : Math.round(ref.records * share);
			bytes += share >= 1 ? ref.bytes : Math.round(ref.bytes * share);
			oldest = Math.min(oldest, from);
			newest = Math.max(newest, to);
		}
		return { records, bytes, oldest, newest };
	}

	/**
	 * retentionFloor over segments (plan.ts): only segments wholly below
	 * `below` count. The count and byte limits keep the newest segments
	 * holding their threshold's share; the age drops segments whose `last`
	 * is older than `ageMs`; `minAgeMs` keeps any segment younger. The floor
	 * is a segment's first, lowered until no segment straddles it.
	 */
	async floorFor(retention: Retention, context: FloorContext): Promise<number | undefined> {
		const own = (await this.index.overlapping(1, Number.MAX_SAFE_INTEGER)).filter((ref) => ref.last < context.below);
		if (!own.length) return undefined;
		const newestFirst = [...own].sort((a, b) => b.last - a.last || b.first - a.first);
		let floor: number | undefined;
		const keepNewest = (limit: number, size: (ref: SegmentRef) => number) => {
			let total = 0;
			for (const ref of newestFirst) total += size(ref);
			if (total <= limit) return;
			let kept = 0;
			let lowest = Number.POSITIVE_INFINITY;
			for (const ref of newestFirst) {
				kept += size(ref);
				lowest = Math.min(lowest, ref.first);
				if (kept >= limit) break;
			}
			if (floor === undefined || lowest > floor) floor = lowest;
		};
		const records = thresholdCount(retention.records, retention.thresholdPercent);
		if (records > 0) keepNewest(records, (ref) => ref.records);
		const bytes = thresholdCount(retention.bytes, retention.thresholdPercent);
		if (bytes > 0) keepNewest(bytes, (ref) => ref.bytes);
		if (retention.ageMs && retention.ageMs > 0) {
			const cutoff = context.now - retention.ageMs;
			const fresh = own.filter((ref) => ref.last >= cutoff);
			const ageFloor = fresh.length ? Math.min(...fresh.map((ref) => ref.first)) : Math.max(...own.map((ref) => ref.last)) + 1;
			if (floor === undefined || ageFloor > floor) floor = ageFloor;
		}
		if (floor !== undefined && retention.minAgeMs && retention.minAgeMs > 0) {
			const young = own.filter((ref) => ref.last >= context.now - retention.minAgeMs!);
			if (young.length) floor = Math.min(floor, ...young.map((ref) => ref.first));
		}
		if (floor === undefined) return undefined;
		// Lower it to a boundary no segment straddles, the tier above's included.
		const all = await this.index.overlapping(1, floor - 1);
		for (let moved = true; moved;) {
			moved = false;
			for (const ref of all) {
				if (ref.first < floor && ref.last >= floor) {
					floor = ref.first;
					moved = true;
				}
			}
		}
		return floor <= Math.min(...own.map((ref) => ref.first)) ? undefined : floor;
	}

	/**
	 * Deletes segments below `floor`, oldest first, until at least `max`
	 * records went (so a count under `max` means nothing is left below the
	 * floor); a segment the floor cuts is rewritten without its records
	 * below it. Returns how many records went.
	 */
	async trimBelow(floor: number, max: number): Promise<number> {
		const refs = (await this.index.overlapping(1, floor - 1)).sort((a, b) => a.last - b.last || a.first - b.first);
		let removed = 0;
		for (const ref of refs) {
			if (removed >= max) break;
			if (ref.last < floor) {
				await this.discard([ref]);
				removed += ref.records;
				continue;
			}
			const records = await this.load(ref);
			const kept = records.filter((record) => record.log_id >= floor);
			// Other segments of the room over the kept stretch (a crash's leftovers) merge in, so the new one replaces no row it should not.
			const others = (await this.index.find([ref.roomId], floor, ref.last)).filter((other) => other.key !== ref.key);
			const merged = dedupe(kept);
			for (const other of others) {
				const held = await this.load(other);
				dedupe(held.filter((record) => record.log_id >= floor), merged);
				removed += held.filter((record) => record.log_id < floor).length;
			}
			let replacement: SegmentRef | undefined;
			if (merged.size) {
				replacement = await this.write(ref.roomId, [...merged.values()], { first: floor, last: Math.max(ref.last, ...others.map((other) => other.last)) });
				await this.index.add([replacement]);
			}
			await this.discard([ref, ...others].filter((old) => old.key !== replacement?.key));
			removed += records.length - kept.length;
		}
		return removed;
	}

	/** Compaction: up to `budget.steps` merges, each of one room's run of final segments. Whether it merged any. */
	async upkeep(budget: { steps: number }, context: { final: number }): Promise<boolean> {
		let merged = false;
		for (let step = 0; step < budget.steps; step += 1) {
			const rooms = await this.index.rooms();
			if (!rooms.length) break;
			const start = rooms.findIndex((room) => room >= this.upkeepRoom);
			const order = start <= 0 ? rooms : [...rooms.slice(start), ...rooms.slice(0, start)];
			let did = false;
			for (const roomId of order.slice(0, UPKEEP_ROOMS)) {
				this.upkeepRoom = roomId;
				if (await this.compact(roomId, { final: context.final })) {
					did = true;
					break;
				}
			}
			if (!did) {
				// Nothing in these rooms: start after them next time.
				const after = order[Math.min(order.length, UPKEEP_ROOMS) % order.length];
				this.upkeepRoom = after ?? "";
				break;
			}
			merged = true;
		}
		return merged;
	}

	/** The first run of a room's segments that compaction would merge, or undefined. */
	async mergeable(roomId: string, final: number): Promise<SegmentRef[] | undefined> {
		const refs = (await this.index.forRoom(roomId)).filter((ref) => ref.last < final);
		for (let start = 0; start < refs.length - 1; start += 1) {
			const run = [refs[start]];
			let records = refs[start].records;
			let bytes = refs[start].bytes;
			let reach = refs[start].last;
			for (let next = start + 1; next < refs.length; next += 1) {
				const ref = refs[next];
				const overlaps = ref.first <= reach;
				if (!overlaps && (records + ref.records > this.segmentRecords || bytes + ref.bytes > this.segmentBytes)) break;
				run.push(ref);
				records += ref.records;
				bytes += ref.bytes;
				reach = Math.max(reach, ref.last);
			}
			if (run.length > 1) return run;
		}
		return undefined;
	}

	/**
	 * Merges the room's first mergeable run (see the top of the file); returns
	 * how many segments it replaced (0: nothing to merge). Idempotent.
	 */
	async compact(roomId: string, options: { final: number }): Promise<number> {
		const run = await this.mergeable(roomId, options.final);
		if (!run) return 0;
		const records = [...dedupe((await Promise.all(run.map((ref) => this.load(ref)))).flat()).values()].sort(byLog);
		const bounds = { first: Math.min(...run.map((ref) => ref.first)), last: Math.max(...run.map((ref) => ref.last)) };
		if (!records.length) {
			await this.discard(run);
			return run.length;
		}
		const ref = await this.write(roomId, this.compactRecords ? compact(records) : records, bounds);
		await this.index.add([ref]);
		await this.discard(run.filter((old) => old.key !== ref.key));
		return run.length;
	}

	/** Restores a lost index from the store (segments.ts, rebuildSegmentIndex). */
	rebuildIndex(options?: { floor?: number; count?: boolean }): Promise<number> {
		return this.index.rebuild(this.store, this.prefix, options);
	}
}
