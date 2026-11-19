/*
 * Builds the history pipeline (PLAN §13): from the `HISTORY` config when
 * set (src/history/settings.ts), else the default tiers from the LIMIT_*
 * vars: the head over the Store, then D1 where HISTORY_D1 is bound. A tier
 * whose binding is missing is left out, as is the whole pipeline when no
 * tier is left below the head. Every tier is wrapped for stall tracking.
 *
 * Tier and store kinds are one table each (TIER_FACTORIES, blobStoreOf):
 * adding a kind adds one entry.
 */

import { MemoryBlobStore } from "./blob/memory";
import { R2BlobStore } from "./blob/r2";
import type { SegmentIndex } from "./blob/segments";
import type { BlobStore } from "./blob/store";
import { BlobHistoryTier } from "./blob/tier";
import { D1HistoryTier } from "./d1";
import { HistoryPipeline, type PipelineStage, instrument } from "./pipeline";
import type { Clock, Retention } from "./records";
import type { BlobStoreSettings, HistorySettings, RetentionSettings, TierSettings } from "./settings";
import { type StorePort, StoreHead } from "./store-head";

/** The limits the default tiers take (src/budget.ts Limits). */
export interface HistoryLimits {
	retentionRecords: number;
	retentionSeconds: number;
	minRetentionSeconds: number;
	archiveRecords: number;
	cleanupThresholdPercent: number;
}

/** The Worker's env: bindings are looked up by the names the settings give. */
export interface HistoryEnv {
	HISTORY_D1?: D1Database;
}

const binding = <T>(env: HistoryEnv, name: string): T | undefined => (env as Record<string, unknown>)[name] as T | undefined;

/** Times a tier's call for stall tracking (the runtime's Stalls.track), by the kind of service. */
export type HistoryTrack = <R>(kind: "d1" | "r2", method: string, call: () => Promise<R>) => Promise<R>;

export const HEAD_TIER = "hot";
export const D1_TIER = "recent";

export interface BuildOptions {
	env: HistoryEnv;
	limits: HistoryLimits;
	store: StorePort;
	clock: Clock;
	settings?: HistorySettings;
	track?: HistoryTrack;
	/** The segment index for a blob tier, by tier name (the Store's SQLite in the Durable Object). */
	segmentIndex?: (tier: string) => SegmentIndex;
	/** This server's name, in blob segments' headers. */
	server?: string;
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

/** A tier's Retention from its settings, with the server-wide threshold as the default. */
export function retentionOf(settings: RetentionSettings, thresholdPercent: number): Retention {
	return {
		...(settings.records !== undefined ? { records: settings.records } : {}),
		...(settings.bytes !== undefined ? { bytes: settings.bytes } : {}),
		...(settings.ageSeconds !== undefined ? { ageMs: settings.ageSeconds * 1_000 } : {}),
		...(settings.minAgeSeconds !== undefined ? { minAgeMs: settings.minAgeSeconds * 1_000 } : {}),
		thresholdPercent: settings.thresholdPercent ?? thresholdPercent,
	};
}

/** A blob store from its settings, or undefined when its binding is missing. The `fs` provider is for Node scripts only. */
export function blobStoreOf(settings: BlobStoreSettings, env: HistoryEnv): BlobStore | undefined {
	switch (settings.provider) {
		case "r2": {
			const bucket = binding<R2Bucket>(env, settings.binding);
			return bucket ? new R2BlobStore(bucket) : undefined;
		}
		case "memory":
			return new MemoryBlobStore();
		case "fs":
			throw new Error("the fs blob store runs in Node scripts only (scripts/fs-blob-store.mjs), not in the Worker");
	}
}

type Factory = (settings: TierSettings, options: BuildOptions, thresholdPercent: number) => PipelineStage | undefined;

const track = (options: BuildOptions): HistoryTrack => options.track ?? ((_kind, _method, call) => call());

const TIER_FACTORIES: Record<Exclude<TierSettings["kind"], "sqlite">, Factory> = {
	d1(settings, options, thresholdPercent) {
		if (settings.kind !== "d1") return undefined;
		const db = binding<D1Database>(options.env, settings.binding);
		if (!db) return undefined;
		return {
			tier: instrument(new D1HistoryTier(settings.name, db), (method, call) => track(options)("d1", method, call)),
			retention: retentionOf(settings.retention, thresholdPercent),
			label: "D1",
		};
	},
	blob(settings, options, thresholdPercent) {
		if (settings.kind !== "blob") return undefined;
		const store = blobStoreOf(settings.store, options.env);
		if (!store || !options.segmentIndex) return undefined;
		const tier = new BlobHistoryTier({
			name: settings.name, store, index: options.segmentIndex(settings.name), prefix: `${settings.store.prefix}${options.server ?? "server"}/`,
			header: { ...(options.server ? { server: options.server } : {}) }, clock: options.clock,
			segmentRecords: settings.segments.records, segmentBytes: settings.segments.bytes, cacheBytes: settings.cacheBytes,
			compactRecords: settings.segments.compact,
		});
		return {
			tier: instrument(tier, (method, call) => track(options)("r2", method, call)),
			retention: retentionOf(settings.retention, thresholdPercent),
			readable: settings.readable,
			label: settings.store.provider === "r2" ? "R2" : settings.store.provider,
		};
	},
};

/** Whether any tier below the head would be built: the Store needs to know before the pipeline exists. */
export function hasLowerTiers(env: HistoryEnv, limits: HistoryLimits, settings?: HistorySettings): boolean {
	if (!settings) return Boolean(env.HISTORY_D1 && limits.archiveRecords > 0);
	return settings.tiers.slice(1).some((tier) => tier.kind === "d1" ? binding(env, tier.binding) !== undefined
		: tier.kind === "blob" ? tier.store.provider === "memory" || (tier.store.provider === "r2" && binding(env, tier.store.binding) !== undefined)
		: false);
}

/**
 * The pipeline: from `settings` when given, else SQLite then D1 where
 * HISTORY_D1 is bound and `archiveRecords` is set. Undefined when there is
 * no tier below the head.
 */
export function buildHistoryPipeline(options: BuildOptions): HistoryPipeline | undefined {
	const { env, limits } = options;
	const stages: PipelineStage[] = [];
	let headName = HEAD_TIER;
	if (options.settings) {
		headName = options.settings.tiers[0].name;
		for (const settings of options.settings.tiers.slice(1)) {
			if (settings.kind === "sqlite") continue;
			const stage = TIER_FACTORIES[settings.kind](settings, options, limits.cleanupThresholdPercent);
			if (stage) stages.push(stage);
		}
	} else if (env.HISTORY_D1 && limits.archiveRecords > 0) {
		stages.push({
			tier: instrument(new D1HistoryTier(D1_TIER, env.HISTORY_D1), (method, call) => track(options)("d1", method, call)),
			retention: { records: limits.archiveRecords, thresholdPercent: limits.cleanupThresholdPercent },
			label: "D1",
		});
	}
	if (!stages.length) return undefined;
	const head = new StoreHead(headName, options.store);
	return new HistoryPipeline({
		head, headRetention: headRetention(limits), stages, state: head.stateStore(), clock: options.clock, headLabel: "SQLite",
		batch: options.settings?.schedule.batch,
	});
}

/**
 * The pipeline exports and imports read and write: the history pipeline
 * when there is one, else the head alone (a server whose history lives in
 * its SQLite only can still be backed up and restored).
 */
export function archivePipeline(pipeline: HistoryPipeline | undefined, options: Pick<BuildOptions, "store" | "limits" | "clock" | "settings">): HistoryPipeline {
	if (pipeline) return pipeline;
	const head = new StoreHead(options.settings?.tiers[0].name ?? HEAD_TIER, options.store);
	return new HistoryPipeline({ head, headRetention: headRetention(options.limits), stages: [], state: head.stateStore(), clock: options.clock, headLabel: "SQLite" });
}
