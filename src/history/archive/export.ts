/*
 * exportArchive: the whole server's history, or some rooms',
 * as one ARCHIVE.md v1 file, read across every tier of the pipeline (upper
 * tiers winning, as pages do). The file's shape is @apron/archive's
 * exportArchive; this module is its source over the pipeline
 * (pipelineSource) and the server's options (clock, `prepare`).
 */

import { type ArchiveSource, type ArchiveWriter, type ChatRecord, type ExportOptions as ArchiveExportOptions, type ExportReport, exportArchive as writeArchive } from "@apron/archive";
import type { HistoryPipeline } from "../pipeline";
import type { Clock, PublicRecord } from "../records";
import type { ExportPort } from "../tier";

export type { ExportReport };

export interface ExportOptions extends Omit<ArchiveExportOptions, "exportedAt"> {
	clock: Clock;
	/**
	 * Makes a page's records what clients would get (required: nothing is
	 * exported unprepared): the runtime puts back terminal output kept in R2
	 * for its internal `output_ref`, which must never leave the server;
	 * withoutOutputs drops it where there is none to put back.
	 */
	prepare: (records: ChatRecord[]) => Promise<PublicRecord[]>;
}

/** Log IDs an export reads a page. */
const PAGE_SIZE = 500;

/** Every record of one room from the published floor on, through the pipeline, oldest first, a page at a time. */
async function* roomRecords(pipeline: HistoryPipeline, roomId: string): AsyncGenerator<ChatRecord[]> {
	let lower = await pipeline.publishedFloor();
	for (;;) {
		const page = (await pipeline.read({ roomIds: [roomId], lower, upper: Number.MAX_SAFE_INTEGER, forward: true, limit: PAGE_SIZE })).filter((record) => record.room_id === roomId);
		if (!page.length) return;
		yield page;
		lower = page[page.length - 1].log_id + 1;
	}
}

/** An export's source: the server's rooms and users (`server`), records across every tier, history from the published floor. */
function pipelineSource(pipeline: HistoryPipeline, server: ExportPort): ArchiveSource {
	return {
		rooms: () => server.rooms(),
		users: (userIds) => server.users(userIds),
		records: (roomId) => roomRecords(pipeline, roomId),
		floor: () => pipeline.publishedFloor(),
	};
}

/** Writes the pipeline's history as one ARCHIVE.md v1 file. The writer is closed at the end. */
export async function exportArchive(pipeline: HistoryPipeline, server: ExportPort, out: ArchiveWriter, options: ExportOptions): Promise<ExportReport> {
	const { clock, ...rest } = options;
	return writeArchive(pipelineSource(pipeline, server), out, { ...rest, exportedAt: new Date(clock.now()).toISOString() });
}
