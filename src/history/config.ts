/*
 * Builds the history pipeline (PLAN §13) from the Worker's bindings and the
 * LIMIT_* history limits, in a fixed order: the head over the Store's
 * SQLite, then D1 where HISTORY_D1 is bound (and LIMIT_HISTORY_D1_RECORDS is
 * above 0), then the blob tier where HISTORY_BLOB is. There is no tier list
 * to configure: a tier exists where its binding does. Every tier is wrapped
 * for stall tracking.
 *
 * Blob stores come from a registry the caller passes in
 * (BlobStoreProviders): the Worker's has `r2` alone (WORKER_BLOB_STORES);
 * Node scripts register `fs` (scripts/fs-blob-store.mjs), tests `memory`
 * (test/history/support/). What a registry lacks cannot be named.
 */

import { R2BlobStore } from "./blob/r2";
import type { SegmentIndex } from "./blob/segments";
import type { BlobStore } from "./blob/store";
import { BlobHistoryTier } from "./blob/tier";
import { D1HistoryTier } from "./d1";
import { HistoryPipeline, type PipelineStage, instrument } from "./pipeline";
import type { Clock, Retention } from "./records";
import { type StorePort, StoreHead } from "./store-head";

/** The history limits (src/budget.ts Limits). */
export interface HistoryLimits {
	retentionRecords: number;
	retentionSeconds: number;
	minRetentionSeconds: number;
	historyD1Records: number;
	historyBlobRecords: number;
	cleanupThresholdPercent: number;
}

/** The Worker's history bindings. */
export interface HistoryEnv {
	HISTORY_D1?: D1Database;
	HISTORY_BLOB?: R2Bucket;
}

/** Makes the history blob store (segments and backups) from the env; undefined where it is not bound. */
export type BlobStoreProvider = (env: HistoryEnv) => BlobStore | undefined;

/** Blob store providers by name, as a caller registers them. */
export type BlobStoreProviders = Readonly<Record<string, BlobStoreProvider>>;

/** The Worker's registry: R2 over HISTORY_BLOB, and nothing else. */
export const WORKER_BLOB_STORES: BlobStoreProviders = Object.freeze({
	r2: (env: HistoryEnv) => env.HISTORY_BLOB ? new R2BlobStore(env.HISTORY_BLOB) : undefined,
});

/** The provider the Worker's blob store comes from. */
export const BLOB_PROVIDER = "r2";

/** Times a tier's call for stall tracking (the runtime's Stalls.track), by the kind of service. */
export type HistoryTrack = <R>(kind: "d1" | "r2", method: string, call: () => Promise<R>) => Promise<R>;

export const HEAD_TIER = "hot";
export const D1_TIER = "recent";
export const BLOB_TIER = "cold";
/** Where blob segments live in the store, before the server's name (`history/<server>/`). */
export const SEGMENT_PREFIX = "history/";

/** Where blob stores come from: a registry and the name of the provider to use (default: the Worker's `r2`). */
export interface BlobStoreChoice {
	blobStores?: BlobStoreProviders;
	blobProvider?: string;
}

export interface BuildOptions extends BlobStoreChoice {
	env: HistoryEnv;
	limits: HistoryLimits;
	store: StorePort;
	clock: Clock;
	track?: HistoryTrack;
	/** The blob tier's segment index (the Store's SQLite in the Durable Object); without it, no blob tier. */
	segmentIndex?: (tier: string) => SegmentIndex;
	/** This server's name, in blob segments' keys. */
	server?: string;
	/** This server's WebSocket URL, in blob segments' headers (ARCHIVE.md §2). */
	serverUrl?: string;
}

/**
 * The history blob store from the registry's provider, or undefined where
 * it is not bound. A provider the registry lacks is an error, not a missing
 * binding: the Worker's has no `memory` or `fs` to name.
 */
export function blobStoreOf(env: HistoryEnv, choice: BlobStoreChoice = {}): BlobStore | undefined {
	const providers = choice.blobStores ?? WORKER_BLOB_STORES;
	const name = choice.blobProvider ?? BLOB_PROVIDER;
	if (!Object.hasOwn(providers, name)) throw new Error(`no blob store provider ${name} is registered here (${Object.keys(providers).join(", ") || "none"})`);
	return providers[name](env);
}

/** Whether the D1 tier is on: HISTORY_D1 bound, and a count to keep there (D1 cannot keep everything). */
export function d1Enabled(env: HistoryEnv, limits: Pick<HistoryLimits, "historyD1Records">): boolean {
	return Boolean(env.HISTORY_D1) && limits.historyD1Records > 0;
}

/** The head's retention, from the limits: its own count, age ceiling and minimum age. */
export function headRetention(limits: HistoryLimits): Retention {
	return {
		...(limits.retentionRecords > 0 ? { records: limits.retentionRecords } : {}),
		...(limits.retentionSeconds > 0 ? { ageMs: limits.retentionSeconds * 1_000 } : {}),
		minAgeMs: limits.minRetentionSeconds * 1_000,
		thresholdPercent: limits.cleanupThresholdPercent,
	};
}

/** Whether any tier below the head would be built: the Store needs to know before the pipeline exists. */
export function hasLowerTiers(env: HistoryEnv, limits: HistoryLimits, choice: BlobStoreChoice = {}): boolean {
	return d1Enabled(env, limits) || blobStoreOf(env, choice) !== undefined;
}

const tracker = (options: BuildOptions): HistoryTrack => options.track ?? ((_kind, _method, call) => call());

/** The pipeline: SQLite, then D1 and the blob tier where bound. Undefined when there is no tier below the head. */
export function buildHistoryPipeline(options: BuildOptions): HistoryPipeline | undefined {
	const { env, limits } = options;
	const track = tracker(options);
	const stages: PipelineStage[] = [];
	if (d1Enabled(env, limits)) {
		stages.push({
			tier: instrument(new D1HistoryTier(D1_TIER, env.HISTORY_D1!), (method, call) => track("d1", method, call)),
			retention: { records: limits.historyD1Records, thresholdPercent: limits.cleanupThresholdPercent },
			label: "D1",
		});
	}
	const blobs = options.segmentIndex ? blobStoreOf(env, options) : undefined;
	if (blobs && options.segmentIndex) {
		const tier = new BlobHistoryTier({
			name: BLOB_TIER, store: blobs, index: options.segmentIndex(BLOB_TIER), prefix: `${SEGMENT_PREFIX}${options.server ?? "server"}/`,
			header: { ...(options.serverUrl ?? options.server ? { server: options.serverUrl ?? options.server } : {}) }, clock: options.clock,
		});
		stages.push({
			tier: instrument(tier, (method, call) => track("r2", method, call)),
			retention: { ...(limits.historyBlobRecords > 0 ? { records: limits.historyBlobRecords } : {}), thresholdPercent: limits.cleanupThresholdPercent },
			label: (options.blobProvider ?? BLOB_PROVIDER) === "r2" ? "R2" : options.blobProvider,
		});
	}
	return stages.length ? headPipeline(options, stages) : undefined;
}

/** A pipeline of the Store's head and `stages`. */
function headPipeline(options: Pick<BuildOptions, "store" | "limits" | "clock">, stages: PipelineStage[]): HistoryPipeline {
	const head = new StoreHead(HEAD_TIER, options.store);
	return new HistoryPipeline({ head, headRetention: headRetention(options.limits), stages, state: head.stateStore(), clock: options.clock, headLabel: "SQLite" });
}

/**
 * The pipeline exports and imports read and write: the history pipeline
 * when there is one, else the head alone (a server whose history lives in
 * its SQLite only can still be backed up and restored).
 */
export function archivePipeline(pipeline: HistoryPipeline | undefined, options: Pick<BuildOptions, "store" | "limits" | "clock">): HistoryPipeline {
	return pipeline ?? headPipeline(options, []);
}
