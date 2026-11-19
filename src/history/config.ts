/*
 * Builds the history pipeline from the environment (PLAN §13): the head
 * over the Store, then the tiers whose bindings are present, each wrapped
 * for stall tracking. No binding, no tier.
 */

import { D1HistoryTier } from "./d1";
import { HistoryPipeline, type PipelineStage, instrument } from "./pipeline";
import type { Clock, Retention } from "./records";
import { type StorePort, StoreHead } from "./store-head";

/** The limits the default tiers take (src/budget.ts Limits). */
export interface HistoryLimits {
	retentionRecords: number;
	retentionSeconds: number;
	minRetentionSeconds: number;
	archiveRecords: number;
	cleanupThresholdPercent: number;
}

export interface HistoryEnv {
	HISTORY_D1?: D1Database;
}

/** Times a tier's call for stall tracking (the runtime's Stalls.track), by the kind of service. */
export type HistoryTrack = <R>(kind: "d1" | "r2", method: string, call: () => Promise<R>) => Promise<R>;

export const HEAD_TIER = "hot";
export const D1_TIER = "recent";

/** The head's retention, from the limits: its own count, age ceiling and minimum age. */
export function headRetention(limits: HistoryLimits): Retention {
	return {
		...(limits.retentionRecords > 0 ? { records: limits.retentionRecords } : {}),
		...(limits.retentionSeconds > 0 ? { ageMs: limits.retentionSeconds * 1_000 } : {}),
		minAgeMs: limits.minRetentionSeconds * 1_000,
		thresholdPercent: limits.cleanupThresholdPercent,
	};
}

/**
 * The pipeline of the default tiers: SQLite, then D1 where HISTORY_D1 is
 * bound and `archiveRecords` is set. Undefined when there is no tier below
 * the head.
 */
export function buildHistoryPipeline(options: { env: HistoryEnv; limits: HistoryLimits; store: StorePort; clock: Clock; track?: HistoryTrack }): HistoryPipeline | undefined {
	const { env, limits } = options;
	const track: HistoryTrack = options.track ?? ((_kind, _method, call) => call());
	const stages: PipelineStage[] = [];
	if (env.HISTORY_D1 && limits.archiveRecords > 0) {
		stages.push({
			tier: instrument(new D1HistoryTier(D1_TIER, env.HISTORY_D1), (method, call) => track("d1", method, call)),
			retention: { records: limits.archiveRecords, thresholdPercent: limits.cleanupThresholdPercent },
			label: "D1",
		});
	}
	if (!stages.length) return undefined;
	const head = new StoreHead(HEAD_TIER, options.store);
	return new HistoryPipeline({
		head, headRetention: headRetention(limits), stages, state: head.stateStore(), clock: options.clock, headLabel: "SQLite",
	});
}
