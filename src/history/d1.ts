/*
 * The D1 history tier (binding HISTORY_D1): records that left the head,
 * kept in the same shape (one row per room and log ID) until its own
 * retention lets them go. /purge and /rename reach it (applyOp), each in
 * one step.
 *
 * Every write may be repeated without harm, so a failure is retried by a
 * later cycle.
 */

import { type ChatRecord, type HistoryOp, type HistoryQuery, type RecordRange, type Retention, type TierStats, purgedRecord, renamedRecord, thresholdCount, toRange } from "./records";
import type { FloorContext, LowerTier, OpStep } from "./tier";

/** Statements one D1 batch carries at most. */
const BATCH_STATEMENTS = 50;

interface Row {
	room_id: string;
	log_id: number;
	commit_ms: number;
	kind: string;
	record_json: string;
}

const toRecord = (row: Row): ChatRecord => ({ ...row, log_id: Number(row.log_id), commit_ms: Number(row.commit_ms) });

export class D1HistoryTier implements LowerTier {
	private ready?: Promise<void>;

	/** The table it keeps records in: one per tier sharing a database (the tests run several). */
	private readonly table: string;

	constructor(readonly name: string, private readonly db: D1Database, options: { table?: string } = {}) {
		this.table = options.table ?? "records";
		if (!/^[a-z_][a-z0-9_]*$/i.test(this.table)) throw new Error(`bad D1 history table name ${this.table}`);
	}

	/** Creates the table and its log index once a wake; a failure is tried again on the next call. */
	private schema(): Promise<void> {
		this.ready ??= this.db.batch([
			this.db.prepare(`CREATE TABLE IF NOT EXISTS ${this.table} (
				room_id TEXT NOT NULL,
				log_id INTEGER NOT NULL,
				commit_ms INTEGER NOT NULL,
				kind TEXT NOT NULL,
				record_json TEXT NOT NULL,
				PRIMARY KEY (room_id, log_id)
			) WITHOUT ROWID`),
			this.db.prepare(`CREATE INDEX IF NOT EXISTS ${this.table}_log_idx ON ${this.table} (log_id)`),
		]).then(() => undefined, (error: unknown) => {
			this.ready = undefined;
			throw error;
		});
		return this.ready;
	}

	private async run(statements: D1PreparedStatement[]): Promise<void> {
		for (let start = 0; start < statements.length; start += BATCH_STATEMENTS) {
			await this.db.batch(statements.slice(start, start + BATCH_STATEMENTS));
		}
	}

	/** Copies records in, replacing any copy already there: a repeated copy changes nothing. */
	async append(range: RecordRange): Promise<void> {
		if (!range.records.length) return;
		await this.schema();
		const insert = this.db.prepare(
			`INSERT OR REPLACE INTO ${this.table} (room_id, log_id, commit_ms, kind, record_json) VALUES (?1, ?2, ?3, ?4, ?5)`,
		);
		await this.run(range.records.map((row) => insert.bind(row.room_id, row.log_id, row.commit_ms, row.kind, row.record_json)));
	}

	async scan(from: number, limit: number): Promise<RecordRange> {
		if (limit <= 0) return toRange([]);
		await this.schema();
		const result = await this.db.prepare(
			`SELECT room_id, log_id, commit_ms, kind, record_json FROM ${this.table} WHERE log_id IN (
			   SELECT DISTINCT log_id FROM ${this.table} WHERE log_id >= ?1 ORDER BY log_id LIMIT ?2)
			 ORDER BY log_id, room_id`,
		).bind(from, limit).all<Row>();
		return toRange(result.results.map(toRecord));
	}

	/**
	 * The records of `roomIds` with the first `limit` distinct log IDs in
	 * `lower`..`upper`, nearest the page's start first: oldest first
	 * `forward`, else newest. A move's record is a row in each of its rooms,
	 * so rows are counted by log ID: two rooms' copies take one place.
	 */
	async read(query: HistoryQuery): Promise<ChatRecord[]> {
		if (!query.roomIds.length || query.lower > query.upper || query.limit <= 0) return [];
		await this.schema();
		const order = query.forward ? "ASC" : "DESC";
		const result = await this.db.prepare(
			`SELECT room_id, log_id, commit_ms, kind, record_json FROM ${this.table}
			 WHERE room_id IN (SELECT value FROM json_each(?1)) AND log_id IN (
			   SELECT DISTINCT log_id FROM ${this.table}
			   WHERE room_id IN (SELECT value FROM json_each(?1)) AND log_id >= ?2 AND log_id <= ?3
			   ORDER BY log_id ${order} LIMIT ?4)
			 ORDER BY log_id ${order}`,
		).bind(JSON.stringify(query.roomIds), query.lower, query.upper, query.limit).all<Row>();
		return result.results.map(toRecord);
	}

	async lookup(ids: readonly number[]): Promise<ChatRecord[]> {
		if (!ids.length) return [];
		await this.schema();
		const result = await this.db.prepare(
			`SELECT room_id, log_id, commit_ms, kind, record_json FROM ${this.table} WHERE log_id IN (SELECT value FROM json_each(?1)) ORDER BY log_id, room_id`,
		).bind(JSON.stringify(ids)).all<Row>();
		return result.results.map(toRecord);
	}

	/** Distinct log IDs in `lower`..`upper` (those this tier serves, for /status). */
	async stats(context: { lower?: number; upper?: number } = {}): Promise<TierStats> {
		await this.schema();
		const row = await this.db.prepare(
			`SELECT COUNT(DISTINCT log_id) AS records, MIN(log_id) AS oldest, MAX(log_id) AS newest FROM ${this.table} WHERE log_id >= ?1 AND log_id <= ?2`,
		).bind(context.lower ?? 0, context.upper ?? Number.MAX_SAFE_INTEGER).first<{ records: number; oldest: number | null; newest: number | null }>();
		return {
			records: Number(row?.records ?? 0),
			...(row?.oldest != null ? { oldest: Number(row.oldest) } : {}),
			...(row?.newest != null ? { newest: Number(row.newest) } : {}),
		};
	}

	/**
	 * Where its retention ends: by count, the log ID of the `keep`th newest
	 * record below `below` (the floor above; records from there on are
	 * copies), so the newest `keep` stay; by age, the first record young
	 * enough. Undefined while nothing need leave. Reads up to `keep` index
	 * entries.
	 */
	async floorFor(retention: Retention, context: FloorContext): Promise<number | undefined> {
		await this.schema();
		const below = Number.isFinite(context.below) ? context.below : Number.MAX_SAFE_INTEGER;
		let floor: number | undefined;
		const keep = thresholdCount(retention.records, retention.thresholdPercent);
		if (keep > 0) {
			const row = await this.db.prepare(
				`SELECT log_id FROM ${this.table} WHERE log_id < ?1 ORDER BY log_id DESC LIMIT 1 OFFSET ?2`,
			).bind(below, keep).first<{ log_id: number }>();
			// The (keep + 1)th newest exists: the floor is the keep-th newest's log ID, just above it.
			if (row) {
				const kept = await this.db.prepare(
					`SELECT log_id FROM ${this.table} WHERE log_id > ?1 AND log_id < ?2 ORDER BY log_id LIMIT 1`,
				).bind(Number(row.log_id), below).first<{ log_id: number }>();
				if (kept) floor = Number(kept.log_id);
			}
		}
		if (retention.ageMs && retention.ageMs > 0) {
			// The first record young enough, or one past the last if none is.
			const cutoff = context.now - retention.ageMs;
			const old = await this.db.prepare(
				`SELECT log_id FROM ${this.table} WHERE log_id < ?1 AND commit_ms < ?2 ORDER BY log_id DESC LIMIT 1`,
			).bind(below, cutoff).first<{ log_id: number }>();
			if (old) {
				const fresh = await this.db.prepare(
					`SELECT log_id FROM ${this.table} WHERE log_id > ?1 AND log_id < ?2 ORDER BY log_id LIMIT 1`,
				).bind(Number(old.log_id), below).first<{ log_id: number }>();
				const ageFloor = fresh ? Number(fresh.log_id) : Number(old.log_id) + 1;
				if (floor === undefined || ageFloor > floor) floor = ageFloor;
			}
		}
		if (floor !== undefined && retention.minAgeMs && retention.minAgeMs > 0) {
			const young = await this.db.prepare(
				`SELECT log_id FROM ${this.table} WHERE commit_ms >= ?1 ORDER BY log_id LIMIT 1`,
			).bind(context.now - retention.minAgeMs).first<{ log_id: number }>();
			if (young && Number(young.log_id) < floor) floor = Number(young.log_id);
		}
		return floor;
	}

	/** Deletes up to `max` records below `floor`, oldest first; returns how many went. */
	async trimBelow(floor: number, max: number): Promise<number> {
		await this.schema();
		const result = await this.db.prepare(
			`DELETE FROM ${this.table} WHERE (room_id, log_id) IN (
			   SELECT room_id, log_id FROM ${this.table} WHERE log_id < ?1 ORDER BY log_id LIMIT ?2)`,
		).bind(floor, max).run();
		return result.meta.changes ?? 0;
	}

	/** /purge and /rename, each in one step: a few statements over the whole table. */
	async applyOp(op: HistoryOp, step: OpStep): Promise<undefined> {
		if (op.op === "purge") await this.purge(op.userIds, op.messageIds, step);
		else await this.rename(op.from, op.to);
		return undefined;
	}

	/**
	 * /purge (Store.purgeUsers) of what is here: the users' message
	 * snapshots go, with every reaction set on their messages (`messageIds`,
	 * their current ones, and those whose snapshots are here), and their
	 * reaction sets and memberships are taken out of the records listing
	 * them, a record left empty going. The messages of theirs found here are
	 * told (`step.found`) before anything is rewritten.
	 */
	private async purge(userIds: readonly string[], messageIds: readonly string[], step: OpStep): Promise<void> {
		await this.schema();
		const ids = JSON.stringify(userIds);
		const authored = await this.db.prepare(
			`SELECT DISTINCT json_extract(record_json, '$.message_id') AS message_id FROM ${this.table}
			 WHERE kind = 'message' AND json_extract(record_json, '$.from.user_id') IN (SELECT value FROM json_each(?1))`,
		).bind(ids).all<{ message_id: string }>();
		const mine = authored.results.map((row) => row.message_id);
		// Told before anything is rewritten: the rewrite removes what found them.
		await step.found(mine);
		const messages = [...new Set([...messageIds, ...mine])];
		const listing = await this.db.prepare(
			`SELECT room_id, log_id, kind, record_json FROM ${this.table} WHERE
			   (kind = 'reactions' AND (json_extract(record_json, '$.message_id') IN (SELECT value FROM json_each(?2)) OR EXISTS (
			     SELECT 1 FROM json_each(record_json, '$.reactions') WHERE json_extract(value, '$.from.user_id') IN (SELECT value FROM json_each(?1)))))
			   OR (kind = 'membership' AND EXISTS (
			     SELECT 1 FROM json_each(record_json, '$.members') WHERE json_extract(value, '$.user.user_id') IN (SELECT value FROM json_each(?1))))`,
		).bind(ids, JSON.stringify(messages)).all<Row>();
		const statements = listing.results.map((row) => this.rewrite(row, purgedRecord(row, userIds, messages)));
		statements.push(this.db.prepare(
			`DELETE FROM ${this.table} WHERE kind = 'message' AND json_extract(record_json, '$.from.user_id') IN (SELECT value FROM json_each(?1))`,
		).bind(ids));
		await this.run(statements);
	}

	/** /rename (Store.renameIdentity) of what is here: every record naming `from` names `to`. */
	private async rename(from: string, to: string): Promise<void> {
		await this.schema();
		const listing = await this.db.prepare(
			`SELECT room_id, log_id, kind, record_json FROM ${this.table} WHERE
			   (kind = 'message' AND json_extract(record_json, '$.from.user_id') = ?1)
			   OR (kind = 'reactions' AND EXISTS (SELECT 1 FROM json_each(record_json, '$.reactions') WHERE json_extract(value, '$.from.user_id') = ?1))
			   OR (kind = 'membership' AND EXISTS (SELECT 1 FROM json_each(record_json, '$.members') WHERE json_extract(value, '$.user.user_id') = ?1))`,
		).bind(from).all<Row>();
		await this.run(listing.results.map((row) => this.rewrite(row, renamedRecord(row, from, to))));
	}

	/** A record's new JSON in place, or its deletion. */
	private rewrite(row: Pick<Row, "room_id" | "log_id">, json: string | null): D1PreparedStatement {
		return json === null
			? this.db.prepare(`DELETE FROM ${this.table} WHERE room_id = ?1 AND log_id = ?2`).bind(row.room_id, row.log_id)
			: this.db.prepare(`UPDATE ${this.table} SET record_json = ?3 WHERE room_id = ?1 AND log_id = ?2`).bind(row.room_id, row.log_id, json);
	}
}
