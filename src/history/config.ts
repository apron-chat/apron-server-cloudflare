/*
 * Builds the history chain from the Worker's bindings and the LIMIT_*
 * history limits, in a fixed order (the order the tiers are linked in): the
 * head over the Store's SQLite, then D1 where HISTORY_D1 is bound (and LIMIT_HISTORY_D1_RECORDS is
 * above 0), then the cold tier where HISTORY_BLOB is. There is no tier list
 * to configure: a tier exists where its binding does. Every tier is wrapped
 * for stall tracking.
 *
 * HISTORY_CODECS is the codec chain everything history stores in the blob
 * store goes through (cold chunks and backups): the one place it is named.
 *
 * Blob stores come from a registry the caller passes in
 * (BlobStoreProviders): the Worker's has `r2` alone (WORKER_BLOB_STORES);
 * Node scripts register `fs` (scripts/fs-blob-store.mjs), tests `memory`
 * (test/history/support/). What a registry lacks cannot be named.
 */

import { type ArchiveCodec, gzip } from "@apron/archive";
import type { ChunkIndex } from "./cold/chunks";
import { ColdHistoryTier } from "./cold/tier";
import { D1HistoryTier } from "./d1";
import { type ChainStage, HistoryChain, instrument } from "./chain";
import type { Clock, Retention } from "./records";
import { R2BlobStore } from "./storage/r2";
import type { BlobStore } from "./storage/store";
import { type ChainStatePort, chainStateStore } from "./state";
import type { D1Off } from "./status";
import { type HeadStore, storeHead } from "./store-head";

/** The history limits (src/budget.ts Limits). */
export interface HistoryLimits {
	historyHotRecords: number;
	historyMaxAgeSeconds: number;
	historyD1Records: number;
	historyColdRecords: number;
	cleanupThresholdPercent: number;
}

/** The Worker's history bindings. */
export interface HistoryEnv {
	HISTORY_D1?: D1Database;
	HISTORY_BLOB?: R2Bucket;
}

/** Makes the history blob store (cold chunks and backups) from the env; undefined where it is not bound. */
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
export const COLD_TIER = "cold";
/** Where cold chunks live in the store, before the server's name (`history/<server>/`). */
export const CHUNK_PREFIX = "history/";

/** The codec chain history's stored archives go through, in order: cold chunks and backups. */
export const HISTORY_CODECS: readonly ArchiveCodec[] = [gzip];

/** Where blob stores come from: a registry and the name of the provider to use (default: the Worker's `r2`). */
export interface BlobStoreChoice {
	blobStores?: BlobStoreProviders;
	blobProvider?: string;
}

/** The Store as the chain needs it: the head's records and the chain's state. */
export interface ChainStore extends HeadStore {
	historyStatePort(): ChainStatePort;
}

/**
 * Which tiers below the head exist in this deploy, from the bindings and
 * limits alone: the D1 database where the D1 tier is on (d1Enabled), and
 * the blob store where one is bound. Resolved once, before the Store: the
 * Store is `tiered` when there is any (layoutTiered), and the chain is
 * built from the same layout, so the two cannot disagree.
 */
export interface HistoryLayout {
	d1?: D1Database;
	blobs?: BlobStore;
	/** The blob store's provider, for /status ("R2"). */
	blobLabel?: string;
}

export function historyLayout(env: HistoryEnv, limits: Pick<HistoryLimits, "historyD1Records">, choice: BlobStoreChoice = {}): HistoryLayout {
	const blobs = blobStoreOf(env, choice);
	const provider = choice.blobProvider ?? BLOB_PROVIDER;
	return {
		...(d1Enabled(env, limits) ? { d1: env.HISTORY_D1! } : {}),
		...(blobs ? { blobs, blobLabel: provider === "r2" ? "R2" : provider } : {}),
	};
}

/** Whether a layout has any tier below the head. */
export function layoutTiered(layout: HistoryLayout): boolean {
	return Boolean(layout.d1 || layout.blobs);
}

export interface BuildOptions {
	layout: HistoryLayout;
	limits: HistoryLimits;
	store: ChainStore;
	clock: Clock;
	track?: HistoryTrack;
	/** The cold tier's chunk index (the Store's SQLite in the Durable Object); without it, no cold tier. */
	chunkIndex?: (tier: string) => ChunkIndex;
	/** The codec chain cold chunks are stored through (default HISTORY_CODECS). */
	codecs?: readonly ArchiveCodec[];
	/** This server's name, in cold chunks' keys. */
	server?: string;
	/** This server's WebSocket URL, in cold chunks' headers (ARCHIVE.md §2). */
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

/** Why the D1 tier is off: HISTORY_D1 is unbound, or LIMIT_HISTORY_D1_RECORDS is 0; undefined when it is on. */
export function d1Off(env: HistoryEnv, limits: Pick<HistoryLimits, "historyD1Records">): D1Off | undefined {
	return !env.HISTORY_D1 ? "unbound" : limits.historyD1Records > 0 ? undefined : "disabled";
}

/** Whether the D1 tier is on: HISTORY_D1 bound, and a count to keep there (D1 cannot keep everything). */
export function d1Enabled(env: HistoryEnv, limits: Pick<HistoryLimits, "historyD1Records">): boolean {
	return Boolean(env.HISTORY_D1) && limits.historyD1Records > 0;
}

/** The head's retention, from the limits: its own count and age ceiling. */
export function headRetention(limits: HistoryLimits): Retention {
	return {
		...(limits.historyHotRecords > 0 ? { records: limits.historyHotRecords } : {}),
		...(limits.historyMaxAgeSeconds > 0 ? { ageMs: limits.historyMaxAgeSeconds * 1_000 } : {}),
		thresholdPercent: limits.cleanupThresholdPercent,
	};
}

const tracker = (options: BuildOptions): HistoryTrack => options.track ?? ((_kind, _method, call) => call());

/**
 * The chain: SQLite, linked to D1 and D1 to the cold tier, where the layout
 * has them. D1 takes /purge and /rename; the cold tier does not, so its link
 * acknowledges them (chain.ts). Undefined when there is no tier below the head.
 */
export function buildHistoryChain(options: BuildOptions): HistoryChain | undefined {
	const { layout, limits } = options;
	const track = tracker(options);
	const stages: ChainStage[] = [];
	if (layout.d1) {
		stages.push({
			tier: instrument(new D1HistoryTier(D1_TIER, layout.d1), (method, call) => track("d1", method, call)),
			retention: { records: limits.historyD1Records, thresholdPercent: limits.cleanupThresholdPercent },
			label: "D1",
		});
	}
	if (layout.blobs && options.chunkIndex) {
		const tier = new ColdHistoryTier({
			name: COLD_TIER, store: layout.blobs, index: options.chunkIndex(COLD_TIER), codecs: options.codecs ?? HISTORY_CODECS,
			prefix: `${CHUNK_PREFIX}${options.server ?? "server"}/`, clock: options.clock,
			header: { ...(options.serverUrl ?? options.server ? { server: options.serverUrl ?? options.server } : {}) },
		});
		stages.push({
			tier: instrument(tier, (method, call) => track("r2", method, call)),
			retention: { ...(limits.historyColdRecords > 0 ? { records: limits.historyColdRecords } : {}), thresholdPercent: limits.cleanupThresholdPercent },
			label: layout.blobLabel ?? "blobs",
		});
	}
	return stages.length ? headChain(options, stages) : undefined;
}

/** A chain of the Store's head and `stages`. */
function headChain(options: Pick<BuildOptions, "store" | "limits" | "clock">, stages: ChainStage[]): HistoryChain {
	const head = storeHead(HEAD_TIER, options.store);
	return new HistoryChain({ head, headRetention: headRetention(options.limits), stages, state: chainStateStore(options.store.historyStatePort(), HEAD_TIER), clock: options.clock });
}

/**
 * The chain exports and imports read and write: the history chain when
 * there is one, else the head alone (a server whose history lives in its
 * SQLite only can still be backed up and restored).
 */
export function archiveChain(chain: HistoryChain | undefined, options: Pick<BuildOptions, "store" | "limits" | "clock">): HistoryChain {
	return chain ?? headChain(options, []);
}
