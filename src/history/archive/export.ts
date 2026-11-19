/*
 * exportArchive (PLAN §10.1): the whole server's history, or some rooms',
 * as one ARCHIVE.md v1 file, read across every tier of the pipeline (upper
 * tiers winning, as pages do).
 *
 * The file: a header (no `you`: a server export is no one's view), one
 * listing part with every room as `not_joined`, then each room's records in
 * log order, a page at a time, each page preceded by the users it names
 * that no earlier part did. Nothing past a page is held in memory.
 *
 * Further sections (uploads, ...) write their own parts after history's
 * (ArchiveSection); history is the only one so far.
 */

import type { HistoryPipeline } from "../pipeline";
import type { ChatRecord, Clock } from "../records";
import type { ArchiveHeader, ArchivedRoom, ArchivedUser, ArchiveReader, ArchiveWriter } from "./types";

export interface ExportOptions {
	/** Only these rooms (default: every room). */
	roomIds?: readonly string[];
	/** Header fields: `server` above all, and `media`. */
	header?: Partial<ArchiveHeader>;
	clock: Clock;
	/** Log IDs read per page (default 500). */
	pageSize?: number;
	/**
	 * Makes a page's records what clients would get: the runtime puts back
	 * terminal output kept in R2 for its internal `output_ref`, which must
	 * never leave the server.
	 */
	prepare?: (records: ChatRecord[]) => Promise<ChatRecord[]>;
}

export interface ExportReport {
	rooms: number;
	users: number;
	records: number;
	sections: string[];
}

export interface ImportOptionsBase {
	dryRun?: boolean;
}

/** One kind of content an archive carries (PLAN §5). History now; uploads and others later. */
export interface ArchiveSection<Source, Target, Options = unknown, Report = unknown> {
	readonly key: string;
	write(source: Source, out: ArchiveWriter, options: ExportOptions): Promise<{ rooms: number; users: number; records: number }>;
	read?(input: ArchiveReader, into: Target, options: Options): Promise<Report>;
}

/** The user IDs a record names: its sender, reaction sets' senders, members. */
export function namedUsers(record: ChatRecord): string[] {
	const value = JSON.parse(record.record_json) as {
		from?: { user_id?: string };
		reactions?: Array<{ from?: { user_id?: string } }>;
		members?: Array<{ user?: { user_id?: string } }>;
	};
	const ids = [
		value.from?.user_id,
		...(value.reactions ?? []).map((set) => set.from?.user_id),
		...(value.members ?? []).map((member) => member.user?.user_id),
	];
	return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Every record of one room from `from` on, through the pipeline, oldest first, a page at a time. */
export async function* roomRecords(pipeline: HistoryPipeline, roomId: string, pageSize = 500): AsyncGenerator<ChatRecord[]> {
	let lower = await pipeline.publishedFloor();
	for (;;) {
		const page = (await pipeline.read({ roomIds: [roomId], lower, upper: Number.MAX_SAFE_INTEGER, forward: true, limit: pageSize })).filter((record) => record.room_id === roomId);
		if (!page.length) return;
		yield page;
		lower = page[page.length - 1].log_id + 1;
	}
}

/** The history section: rooms, the users they name, and their records. */
export const historySection: ArchiveSection<HistoryPipeline, HistoryPipeline> = {
	key: "history",
	async write(pipeline, out, options) {
		const head = pipeline.head;
		const all: ArchivedRoom[] = head.rooms ? await head.rooms() : [];
		const wanted = options.roomIds ? new Set(options.roomIds) : undefined;
		const rooms = all.filter((room) => !wanted || wanted.has(room.listing.room_id));
		const published = await pipeline.publishedFloor();
		const listings = rooms.map((room) => {
			// History starts at the published floor or the room's creation, whichever is later.
			const created = Number(room.listing.log_id ?? 0);
			const start = Math.max(published, Number.isFinite(created) ? created : 0);
			return { ...room.listing, history_log_id: room.listing.history_log_id === null ? null : String(start) };
		});
		const named = new Set<string>();
		for (const listing of listings) for (const member of listing.members ?? []) named.add(member.user_id);
		const listed = new Set<string>();
		const userPart = async (ids: Iterable<string>) => {
			const fresh = [...new Set(ids)].filter((id) => !listed.has(id));
			if (!fresh.length) return [];
			for (const id of fresh) listed.add(id);
			return head.users ? head.users(fresh) : [];
		};
		await out.listing({ not_joined: listings, users: await userPart(named) });
		let records = 0;
		for (const room of rooms) {
			for await (const read of roomRecords(pipeline, room.listing.room_id, options.pageSize)) {
				const page = options.prepare ? await options.prepare(read) : read;
				const users: ArchivedUser[] = await userPart(page.flatMap(namedUsers));
				if (users.length) await out.listing({ users });
				await out.records(page);
				records += page.length;
			}
		}
		return { rooms: rooms.length, users: listed.size, records };
	},
};

/**
 * Writes the pipeline's history as one ARCHIVE.md v1 file (PLAN §10.1).
 * The writer is closed at the end.
 */
export async function exportArchive(pipeline: HistoryPipeline, out: ArchiveWriter, options: ExportOptions): Promise<ExportReport> {
	await out.header({ ...options.header, apron_archive: 1, exported_at: new Date(options.clock.now()).toISOString() });
	const written = await historySection.write(pipeline, out, options);
	await out.close();
	return { ...written, sections: [historySection.key] };
}
