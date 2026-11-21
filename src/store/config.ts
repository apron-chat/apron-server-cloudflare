/** The store's configuration: what a deploy sets (StoreConfig) and its defaults. */

import { type CostEstimate, MAINTENANCE_CONTROL_READS, MAINTENANCE_CONTROL_WRITES } from "../budget-ledger";
import { DEFAULT_LIMITS, type LiveTextPolicy, MAX_PRIVATE_ROOM_LIMIT, type PushPolicy, type UploadPolicy } from "../budget";
import { DEDUP_TTL_MS, LIMITER_IDLE_MS, MINUTE_MS } from "./limits";
import { bucketHorizonMs, type Rate } from "../limiter";

export interface StoreConfig {
  /** Records older than this have expired whatever the count; 0 sets no age limit (retentionCutoff). */
  retentionMs: number;
  /** History keeps at least the latest this many records; 0 keeps no count (retentionCutoff). */
  historyHotRecords: number;
  /**
   * Whether history tiers lie below this SQLite (the history chain,
   * src/history/: the D1 tier where it is bound): records leaving it are
   * copied down first, and history is published from the deepest tier's floor.
   */
  tiered: boolean;
  /** The share of `historyHotRecords` that each cleanup keeps, in percent (keptHotRecords). */
  cleanupThresholdPercent: number;
  /** Inactivity past which an account is removed (pruneIdleIdentities). */
  idleAccountMs: number;
  /** The most recently active accounts pruneIdleIdentities always keeps. */
  keptActiveAccounts: number;
  dedupTtlMs: number;
  cleanupIntervalMs: number;
  cleanupBatch: number;
  maxSnapshotBytes: number;
  maxTextBytes: number;
  maxNameBytes: number;
  maxNameCodePoints: number;
  maxEmbeds: number;
  /** Thread rooms (rooms with a parent) that may exist at once. */
  maxThreads: number;
  /** Live thread rooms one registered user may have created (`creator_id`) at once. */
  maxThreadsPerUser: number;
  /**
   * The thread and private-room caps (maxThreads, maxThreadsPerUser,
   * maxPrivateRooms, maxPrivateRoomsPerUser) count the rooms created within
   * this long (by their creation log ID, a commit time): they limit how many
   * rooms are started, not how many exist, so posting in an older room never
   * needs a slot. 0 counts every room that exists.
   */
  roomCreationWindowMs: number;
  /** Serialized client fields of one room record. */
  roomMetadataBytes: number;
  /** Serialized client fields every room may hold whatever the total (roomMetadataMinBytes). */
  roomMetadataMinBytes: number;
  /** Serialized client fields past roomMetadataMinBytes, of every room together (roomMetadataTotalBytes). */
  roomMetadataTotalBytes: number;
  /** Private rooms (§4.2.4) that may exist at once, beside the threads. */
  maxPrivateRooms: number;
  /** Live private rooms one registered user may have created (`creator_id`) at once. */
  maxPrivateRoomsPerUser: number;
  /** Private rooms one registered user may be a member of at once. */
  maxPrivateMembershipsPerUser: number;
  reactionUsersPerMessage: number;
  reactionEmojisPerUser: number;
  maxHistoryLimit: number;
  historyPageSize: number;
  maxHistoryResponseBytes: number;
  historyRequestsPerUserMinute: number;
  historyRequestsPerIpMinute: number;
  historyBurstPerUser: number;
  historyBurstPerIp: number;
  historyRequestsPerUserDay: number;
  historyRequestsPerIpDay: number;
  historyRequestsPerDay: number;
  /**
   * How far back from a room's head, in records, a guest may page with
   * `before` alone: the records past `before` must be fewer than this.
   */
  guestHistoryDepth: number;
  guestPostsPerMinute: number;
  guestPostsPerDay: number;
  registeredPostsPerMinute: number;
  registeredPostsPerDay: number;
  /** A trusted user's posts (a registered user holding any role, which only an admin gives), in place of the registered limits; also their IP's allowance, when larger. */
  trustedPostsPerMinute: number;
  trustedPostsPerDay: number;
  ipPostsPerMinute: number;
  ipPostsPerDay: number;
  globalPostsPerMinute: number;
  globalPostsPerDay: number;
  registrationsPerIpDay: number;
  registrationsPerDay: number;
  registeredAccounts: number;
  authAttemptsPerIpMinute: number;
  framesPerIpMinute: number;
  processedFramesPerDay: number;
  connectionAdmissionsPerIpMinute: number;
  connectionAdmissionsPerDay: number;
  principalLimitCap: number;
  sqlReadsPerDay: number;
  sqlWritesPerDay: number;
  foregroundReadsPerDay: number;
  foregroundWritesPerDay: number;
  maintenanceReadsPerDay: number;
  maintenanceWritesPerDay: number;
  /** Occupied SQLite bytes at which foreground growth is suspended. */
  storageHighWaterBytes: number;
  /** Hard target including control data and cleanup headroom. */
  storageHardTargetBytes: number;
  /** Effective occupied bytes below which growth may resume. */
  storageLowWaterBytes: number;
  /** Optional operator switch. */
  admissionEnabled: boolean;
  /**
   * The hosts whose `og` media (`image`, `video`, `audio`) are kept
   * (`OG_MEDIA_HOSTS`): exact hosts, `*.host` for subdomains, or `"*"` for
   * any. Every viewer's client loads a kept URL, so only hosts whose access
   * logs a sender cannot read belong here; this server hosts and proxies no
   * media of its own (§4.8.1). Empty: none are kept.
   */
  ogMediaHosts: readonly string[] | "*";
  /**
   * How long a room's member rows may be reused (roomMembers); any write to
   * what they were read from ends it sooner. 0 or absent: never reused.
   */
  memberCacheMs?: number;
  /** Conservative row-cost estimate for one foreground mutation. */
  mutationCost: CostEstimate;
  /** Conservative row-cost estimate for one history read. */
  historyCost: CostEstimate;
  /** Conservative row-cost estimate for one auth attempt. */
  authCost: CostEstimate;
  /** Conservative row-cost estimate for one maintenance batch. */
  cleanupCost: CostEstimate;
  /**
   * Uploads (protocol §4.8.3), or null without them: the plan's policy and
   * the public origin its R2 objects are served from.
   */
  uploads: StoreUploadConfig | null;
  /** Web Push (protocol §4.9), or null without it: the plan's push policy. */
  push: PushPolicy | null;
  /**
   * Live text (protocol §4.8.3, `embed:terminal` and `embed:append`), or
   * null without it: the plan's policy, the origin live `url`s are served
   * from, and whether it is on while no admin toggled it.
   */
  liveText?: StoreLiveTextConfig | null;
}

export interface StoreLiveTextConfig extends LiveTextPolicy {
  /** This Worker's public origin, where a live text's `url` points; no trailing slash. */
  publicOrigin: string;
  /** On unless an admin turned it off with `/toggle livetext` (or on, when this is false). */
  enabled: boolean;
}

interface StoreUploadConfig extends UploadPolicy {
  /** Where the bucket serves objects, such as `https://media.apron.chat`; no trailing slash. */
  mediaOrigin: string;
}

const DEFAULT_CONFIG: StoreConfig = {
  retentionMs: DEFAULT_LIMITS.historyMaxAgeSeconds * 1000,
  historyHotRecords: DEFAULT_LIMITS.historyHotRecords,
  tiered: false,
  cleanupThresholdPercent: DEFAULT_LIMITS.cleanupThresholdPercent,
  idleAccountMs: DEFAULT_LIMITS.idleAccountSeconds * 1000,
  keptActiveAccounts: DEFAULT_LIMITS.keptActiveAccounts,
  dedupTtlMs: DEDUP_TTL_MS,
  cleanupIntervalMs: DEFAULT_LIMITS.cleanupIntervalSeconds * 1000,
  cleanupBatch: DEFAULT_LIMITS.cleanupBatch,
  maxSnapshotBytes: DEFAULT_LIMITS.maxSnapshotBytes,
  maxTextBytes: DEFAULT_LIMITS.maxTextBytes,
  maxNameBytes: DEFAULT_LIMITS.maxNameBytes,
  maxNameCodePoints: DEFAULT_LIMITS.maxNameCodePoints,
  maxEmbeds: DEFAULT_LIMITS.maxEmbeds,
  maxThreads: DEFAULT_LIMITS.threads,
  maxThreadsPerUser: DEFAULT_LIMITS.threadsPerUser,
  roomCreationWindowMs: DEFAULT_LIMITS.roomCreationWindowSeconds * 1000,
  roomMetadataBytes: DEFAULT_LIMITS.roomMetadataBytes,
  roomMetadataMinBytes: DEFAULT_LIMITS.roomMetadataMinBytes,
  roomMetadataTotalBytes: DEFAULT_LIMITS.roomMetadataTotalBytes,
  maxPrivateRooms: DEFAULT_LIMITS.privateRooms,
  maxPrivateRoomsPerUser: DEFAULT_LIMITS.privateRoomsPerUser,
  maxPrivateMembershipsPerUser: DEFAULT_LIMITS.privateMembershipsPerUser,
  reactionUsersPerMessage: DEFAULT_LIMITS.reactionUsersPerMessage,
  reactionEmojisPerUser: DEFAULT_LIMITS.reactionEmojisPerUser,
  maxHistoryLimit: DEFAULT_LIMITS.historyMaxPageSize,
  historyPageSize: DEFAULT_LIMITS.historyPageSize,
  maxHistoryResponseBytes: DEFAULT_LIMITS.historyMaxResponseBytes,
  historyRequestsPerUserMinute: DEFAULT_LIMITS.historyRequestsPerUserMinute,
  historyRequestsPerIpMinute: DEFAULT_LIMITS.historyRequestsPerIpMinute,
  historyBurstPerUser: DEFAULT_LIMITS.historyBurstPerUser,
  historyBurstPerIp: DEFAULT_LIMITS.historyBurstPerIp,
  historyRequestsPerUserDay: DEFAULT_LIMITS.historyRequestsPerUserDay,
  historyRequestsPerIpDay: DEFAULT_LIMITS.historyRequestsPerIpDay,
  historyRequestsPerDay: DEFAULT_LIMITS.historyRequestsPerDay,
  guestHistoryDepth: DEFAULT_LIMITS.guestHistoryDepth,
  guestPostsPerMinute: DEFAULT_LIMITS.guestPostsPerMinute,
  guestPostsPerDay: DEFAULT_LIMITS.guestPostsPerDay,
  registeredPostsPerMinute: DEFAULT_LIMITS.registeredPostsPerMinute,
  registeredPostsPerDay: DEFAULT_LIMITS.registeredPostsPerDay,
  trustedPostsPerMinute: DEFAULT_LIMITS.trustedPostsPerMinute,
  trustedPostsPerDay: DEFAULT_LIMITS.trustedPostsPerDay,
  ipPostsPerMinute: DEFAULT_LIMITS.ipPostsPerMinute,
  ipPostsPerDay: DEFAULT_LIMITS.ipPostsPerDay,
  globalPostsPerMinute: DEFAULT_LIMITS.globalPostsPerMinute,
  globalPostsPerDay: DEFAULT_LIMITS.globalPostsPerDay,
  registrationsPerIpDay: DEFAULT_LIMITS.registrationsPerIpDay,
  registrationsPerDay: DEFAULT_LIMITS.registrationsPerDay,
  registeredAccounts: DEFAULT_LIMITS.registeredAccounts,
  authAttemptsPerIpMinute: DEFAULT_LIMITS.authAttemptsPerIpMinute,
  framesPerIpMinute: DEFAULT_LIMITS.framesPerIpMinute,
  processedFramesPerDay: DEFAULT_LIMITS.processedFramesPerDay,
  connectionAdmissionsPerIpMinute: DEFAULT_LIMITS.connectionAdmissionsPerIpMinute,
  connectionAdmissionsPerDay: DEFAULT_LIMITS.connectionAdmissionsPerDay,
  principalLimitCap: DEFAULT_LIMITS.limiterRecords,
  sqlReadsPerDay: DEFAULT_LIMITS.sqlReadsPerDay,
  sqlWritesPerDay: DEFAULT_LIMITS.sqlWritesPerDay,
  foregroundReadsPerDay: DEFAULT_LIMITS.foregroundReadsPerDay,
  foregroundWritesPerDay: DEFAULT_LIMITS.foregroundWritesPerDay,
  maintenanceReadsPerDay: DEFAULT_LIMITS.maintenanceReadsPerDay,
  maintenanceWritesPerDay: DEFAULT_LIMITS.maintenanceWritesPerDay,
  storageHighWaterBytes: DEFAULT_LIMITS.databaseHighWaterBytes,
  storageHardTargetBytes: DEFAULT_LIMITS.databaseHardTargetBytes,
  storageLowWaterBytes: DEFAULT_LIMITS.databaseResumeLowWaterBytes,
  admissionEnabled: true,
  ogMediaHosts: [],
  uploads: null,
  push: null,
  // These bounds include the reservation row and worst-case indexed control
  // updates for one accepted operation; calibrated workloads may lower them
  // only after observing cursor counts.
  mutationCost: { reads: 64, writes: 64, posts: 1 },
  historyCost: { reads: 64 },
  authCost: { reads: 24, writes: 8, frames: 1 },
  // A batch also scans the public and private ranges for rooms whose log has
  // left every tier, at up to two reads a row (its key's index entry and the
  // row).
  cleanupCost: { reads: 1024 + 4 * MAX_PRIVATE_ROOM_LIMIT, writes: 1024 },
};

export function defaultStoreConfig(overrides: Partial<StoreConfig> = {}): StoreConfig {
  const merged = { ...DEFAULT_CONFIG, ...overrides };
  if (merged.retentionMs < 0 || merged.historyHotRecords < 0 || (merged.retentionMs === 0 && merged.historyHotRecords === 0) || merged.dedupTtlMs <= 0) {
    throw new Error("retention needs an age or a count, and dedup TTL must be positive");
  }
  if (merged.maxSnapshotBytes <= 0 || merged.maxTextBytes <= 0) {
    throw new Error("snapshot and text limits must be positive");
  }
  if (merged.historyPageSize <= 0 || merged.maxHistoryLimit < merged.historyPageSize) {
    throw new Error("history limits are inconsistent");
  }
  // A limiter row idle for LIMITER_IDLE_MS is removed, so no limiter may still matter by then.
  const rates: Rate[] = [
    { perMinute: merged.historyRequestsPerUserMinute, burst: merged.historyBurstPerUser },
    { perMinute: merged.historyRequestsPerIpMinute, burst: merged.historyBurstPerIp },
  ];
  if (rates.some((rate) => !(rate.perMinute > 0) || !((rate.burst ?? 0) >= 1) || bucketHorizonMs(rate) > LIMITER_IDLE_MS - MINUTE_MS)) {
    throw new Error("history bursts must be at least one request and spent within the limiter idle time");
  }
  if (merged.storageLowWaterBytes >= merged.storageHighWaterBytes ||
      merged.storageHighWaterBytes >= merged.storageHardTargetBytes) {
    throw new Error("storage watermarks are inconsistent");
  }
  if (merged.foregroundReadsPerDay > merged.sqlReadsPerDay ||
      merged.maintenanceReadsPerDay > merged.sqlReadsPerDay ||
      merged.foregroundWritesPerDay > merged.sqlWritesPerDay ||
      merged.maintenanceWritesPerDay > merged.sqlWritesPerDay) {
    throw new Error("foreground/maintenance budgets exceed daily ceilings");
  }
  if (merged.maintenanceReadsPerDay <= MAINTENANCE_CONTROL_READS ||
      merged.maintenanceWritesPerDay <= MAINTENANCE_CONTROL_WRITES) {
    throw new Error("maintenance budgets must leave control reserve");
  }
  if (merged.cleanupBatch <= 0 || merged.cleanupBatch > 100) {
    throw new Error("cleanup batch must be between 1 and 100");
  }
  return merged;
}
