/*
 * The history archive (D1, binding ARCHIVE): records that left the object's
 * own SQLite, the hot log (Store, `retentionRecords`), kept for
 * `archiveRecords` more before they expire. It holds the hot log's `records`
 * rows as they were, in the same shape, so a history page below the hot
 * floor reads them here (Store.historyWithArchive) and serves them as if
 * they had never left.
 *
 * The object writes here only from its maintenance (ApronDemoServer.runArchive):
 * copies of records about to leave the hot log, `/purge` and `/rename` applied
 * to what is archived, and deletion below the published floor. Every write
 * may be repeated without harm, so a failure is retried on a later alarm.
 */

/** One `records` row, as the hot log and the archive both keep it. */
export interface ArchiveRow {
	room_id: string;
	log_id: number;
	commit_ms: number;
	kind: string;
	record_json: string;
}

/** The archived records a history page needs: some rooms' records in a window, nearest first. */
export interface ArchiveQuery {
	roomIds: string[];
	lower: number;
	upper: number;
	forward: boolean;
	limit: number;
}

/** What the archive must undo of a user, as the hot log did (Store.purgeUsers, Store.renameIdentity). */
export type ArchiveOp =
	| { op: "purge"; userIds: string[]; messageIds: string[] }
	| { op: "rename"; from: string; to: string };

interface Identity { user_id: string; [key: string]: unknown }

/** Statements one D1 batch carries at most. */
const BATCH_STATEMENTS = 50;

export class Archive {
	private ready?: Promise<void>;

	constructor(private readonly db: D1Database) {}

	/** Creates the table and its log index once a wake; a failure is tried again on the next call. */
	private schema(): Promise<void> {
		this.ready ??= this.db.batch([
			this.db.prepare(`CREATE TABLE IF NOT EXISTS records (
				room_id TEXT NOT NULL,
				log_id INTEGER NOT NULL,
				commit_ms INTEGER NOT NULL,
				kind TEXT NOT NULL,
				record_json TEXT NOT NULL,
				PRIMARY KEY (room_id, log_id)
			) WITHOUT ROWID`),
			this.db.prepare("CREATE INDEX IF NOT EXISTS records_log_idx ON records (log_id)"),
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

	/** Copies rows in, replacing any copy already there: a repeated copy changes nothing. */
	async insert(rows: readonly ArchiveRow[]): Promise<void> {
		if (!rows.length) return;
		await this.schema();
		const insert = this.db.prepare(
			"INSERT OR REPLACE INTO records (room_id, log_id, commit_ms, kind, record_json) VALUES (?1, ?2, ?3, ?4, ?5)",
		);
		await this.run(rows.map((row) => insert.bind(row.room_id, row.log_id, row.commit_ms, row.kind, row.record_json)));
	}

	/**
	 * Up to `limit` records of `roomIds` with log IDs in `lower`..`upper`,
	 * nearest the page's start first: oldest first `forward`, else newest.
	 */
	async page(query: ArchiveQuery): Promise<ArchiveRow[]> {
		if (!query.roomIds.length || query.lower > query.upper || query.limit <= 0) return [];
		await this.schema();
		const result = await this.db.prepare(
			`SELECT room_id, log_id, commit_ms, kind, record_json FROM records
			 WHERE room_id IN (SELECT value FROM json_each(?1)) AND log_id >= ?2 AND log_id <= ?3
			 ORDER BY log_id ${query.forward ? "ASC" : "DESC"} LIMIT ?4`,
		).bind(JSON.stringify(query.roomIds), query.lower, query.upper, query.limit).all<ArchiveRow>();
		return result.results.map((row) => ({ ...row, log_id: Number(row.log_id), commit_ms: Number(row.commit_ms) }));
	}

	/**
	 * Where the archive's own limit ends: the log ID of the `keep`th newest
	 * record below `below` (the hot floor), which the published floor may
	 * rise to, so the newest `keep` archived records stay. Undefined while it
	 * holds no more than `keep`. Reads up to `keep` index entries.
	 */
	async floor(below: number, keep: number): Promise<number | undefined> {
		await this.schema();
		const row = await this.db.prepare(
			"SELECT log_id FROM records WHERE log_id < ?1 ORDER BY log_id DESC LIMIT 1 OFFSET ?2",
		).bind(below, Math.max(0, keep - 1)).first<{ log_id: number }>();
		return row ? Number(row.log_id) : undefined;
	}

	/** Deletes up to `limit` records below `floor`, oldest first; returns how many went. */
	async deleteBelow(floor: number, limit: number): Promise<number> {
		await this.schema();
		const result = await this.db.prepare(
			`DELETE FROM records WHERE (room_id, log_id) IN (
			   SELECT room_id, log_id FROM records WHERE log_id < ?1 ORDER BY log_id LIMIT ?2)`,
		).bind(floor, limit).run();
		return result.meta.changes ?? 0;
	}

	/** Applies what `/purge` or `/rename` did to the hot log to the archived records too. */
	async apply(op: ArchiveOp): Promise<void> {
		await this.schema();
		if (op.op === "purge") await this.purge(op.userIds, op.messageIds);
		else await this.rename(op.from, op.to);
	}

	/**
	 * `/purge` (Store.purgeUsers) of what is archived: the users' message
	 * snapshots go, with every reaction set on their messages (`messageIds`,
	 * their current ones, and those whose snapshots are archived), and their
	 * reaction sets and memberships are taken out of the records listing
	 * them, a record left empty going.
	 */
	private async purge(userIds: readonly string[], messageIds: readonly string[]): Promise<void> {
		const ids = JSON.stringify(userIds);
		const authored = await this.db.prepare(
			`SELECT DISTINCT json_extract(record_json, '$.message_id') AS message_id FROM records
			 WHERE kind = 'message' AND json_extract(record_json, '$.from.user_id') IN (SELECT value FROM json_each(?1))`,
		).bind(ids).all<{ message_id: string }>();
		const messages = [...new Set([...messageIds, ...authored.results.map((row) => row.message_id)])];
		const listing = await this.db.prepare(
			`SELECT room_id, log_id, kind, record_json FROM records WHERE
			   (kind = 'reactions' AND (json_extract(record_json, '$.message_id') IN (SELECT value FROM json_each(?2)) OR EXISTS (
			     SELECT 1 FROM json_each(record_json, '$.reactions') WHERE json_extract(value, '$.from.user_id') IN (SELECT value FROM json_each(?1)))))
			   OR (kind = 'membership' AND EXISTS (
			     SELECT 1 FROM json_each(record_json, '$.members') WHERE json_extract(value, '$.user.user_id') IN (SELECT value FROM json_each(?1))))`,
		).bind(ids, JSON.stringify(messages)).all<ArchiveRow>();
		const statements = listing.results.map((row) => this.rewrite(row, purgedRecord(row, userIds, messages)));
		statements.push(this.db.prepare(
			`DELETE FROM records WHERE kind = 'message' AND json_extract(record_json, '$.from.user_id') IN (SELECT value FROM json_each(?1))`,
		).bind(ids));
		await this.run(statements);
	}

	/** `/rename` (Store.renameIdentity) of what is archived: every record naming `from` names `to`. */
	private async rename(from: string, to: string): Promise<void> {
		const listing = await this.db.prepare(
			`SELECT room_id, log_id, kind, record_json FROM records WHERE
			   (kind = 'message' AND json_extract(record_json, '$.from.user_id') = ?1)
			   OR (kind = 'reactions' AND EXISTS (SELECT 1 FROM json_each(record_json, '$.reactions') WHERE json_extract(value, '$.from.user_id') = ?1))
			   OR (kind = 'membership' AND EXISTS (SELECT 1 FROM json_each(record_json, '$.members') WHERE json_extract(value, '$.user.user_id') = ?1))`,
		).bind(from).all<ArchiveRow>();
		await this.run(listing.results.map((row) => this.rewrite(row, renamedRecord(row, from, to))));
	}

	/** A record's new JSON in place, or its deletion. */
	private rewrite(row: Pick<ArchiveRow, "room_id" | "log_id">, json: string | null): D1PreparedStatement {
		return json === null
			? this.db.prepare("DELETE FROM records WHERE room_id = ?1 AND log_id = ?2").bind(row.room_id, row.log_id)
			: this.db.prepare("UPDATE records SET record_json = ?3 WHERE room_id = ?1 AND log_id = ?2").bind(row.room_id, row.log_id, json);
	}
}

/** A reactions or membership record without the purged users' entries (null if none is left), as Store.purgeUsers rewrites it. */
export function purgedRecord(row: Pick<ArchiveRow, "kind" | "record_json">, userIds: readonly string[], messageIds: readonly string[]): string | null {
	const record = JSON.parse(row.record_json) as Record<string, unknown>;
	if (row.kind === "reactions") {
		const sets = (record.reactions as Array<{ from: Identity }>) ?? [];
		const kept = messageIds.includes(record.message_id as string) ? [] : sets.filter((set) => !userIds.includes(set.from.user_id));
		return kept.length ? JSON.stringify({ ...record, reactions: kept }) : null;
	}
	const members = ((record.members as Array<{ user: Identity }>) ?? []).filter((member) => !userIds.includes(member.user.user_id));
	return members.length ? JSON.stringify({ ...record, members }) : null;
}

/** A record naming `to` wherever it named `from`, as Store.renameIdentity rewrites it. */
export function renamedRecord(row: Pick<ArchiveRow, "kind" | "record_json">, from: string, to: string): string {
	const renamed = (user: Identity): Identity => user.user_id === from ? { ...user, user_id: to } : user;
	const record = JSON.parse(row.record_json) as Record<string, unknown>;
	if (row.kind === "message") return JSON.stringify({ ...record, from: renamed(record.from as Identity) });
	if (row.kind === "reactions") {
		return JSON.stringify({ ...record, reactions: (record.reactions as Array<{ from: Identity }>).map((set) => ({ ...set, from: renamed(set.from) })) });
	}
	return JSON.stringify({ ...record, members: (record.members as Array<{ user: Identity }>).map((member) => ({ ...member, user: renamed(member.user) })) });
}
