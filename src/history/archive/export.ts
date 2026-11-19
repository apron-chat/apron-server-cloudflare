/*
 * exportArchive (PLAN §10.1): the whole server's history, or some rooms',
 * as one ARCHIVE.md v1 file, read across every tier of the pipeline (upper
 * tiers winning, as pages do). The file's shape is @apron/archive's
 * exportArchive; this module is its source over the pipeline
 * (pipelineSource) and the server's options (clock, page size, `prepare`).
 */

import { type ArchiveSource, type ArchiveWriter, type ChatRecord, type ExportOptions as ArchiveExportOptions, type ExportReport, exportArchive as writeArchive } from "@apron/archive";
import type { HistoryPipeline } from "../pipeline";
import type { Clock } from "../records";

export type { ExportReport };

export interface ExportOptions extends Omit<ArchiveExportOptions, "exportedAt"> {
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

/** Every record of one room from the published floor on, through the pipeline, oldest first, a page at a time. */
export async function* roomRecords(pipeline: HistoryPipeline, roomId: string, pageSize = 500): AsyncGenerator<ChatRecord[]> {
	let lower = await pipeline.publishedFloor();
	for (;;) {
		const page = (await pipeline.read({ roomIds: [roomId], lower, upper: Number.MAX_SAFE_INTEGER, forward: true, limit: pageSize })).filter((record) => record.room_id === roomId);
		if (!page.length) return;
		yield page;
		lower = page[page.length - 1].log_id + 1;
	}
}

/** The pipeline as an export's source: its head's rooms and users, records across every tier, history from the published floor. */
export function pipelineSource(pipeline: HistoryPipeline, pageSize?: number): ArchiveSource {
	const head = pipeline.head;
	return {
		rooms: async () => (head.rooms ? head.rooms() : []),
		users: async (userIds) => (head.users ? head.users(userIds) : []),
		records: (roomId) => roomRecords(pipeline, roomId, pageSize),
		floor: () => pipeline.publishedFloor(),
	};
}

/** Writes the pipeline's history as one ARCHIVE.md v1 file (PLAN §10.1). The writer is closed at the end. */
export async function exportArchive(pipeline: HistoryPipeline, out: ArchiveWriter, options: ExportOptions): Promise<ExportReport> {
	const { clock, pageSize, ...rest } = options;
	return writeArchive(pipelineSource(pipeline, pageSize), out, { ...rest, exportedAt: new Date(clock.now()).toISOString() });
}
