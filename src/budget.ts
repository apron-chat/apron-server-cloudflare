// Single source for deployment resource policy. The plan files under
// src/plans/ hold each Cloudflare plan's budgets, allowances, and feature
// defaults; PLAN below selects the one that matches the account.
import { PAID_PLAN } from "./plans/paid.ts";

export interface Limits {
	retentionSeconds: number;
	cleanupSeconds: number;
	challengeTtlSeconds: number;
	/** Lifetime of a passkey session token, renewed on every successful resume. */
	sessionTtlSeconds: number;
	maxFrameBytes: number;
	maxTextBytes: number;
	maxSnapshotBytes: number;
	maxJsonDepth: number;
	maxJsonNodes: number;
	maxRequestIdBytes: number;
	maxNameCodePoints: number;
	maxNameBytes: number;
	maxEmbeds: number;
	historyDefaultLimit: number;
	historyMaxLimit: number;
	historyMaxResponseBytes: number;
	historyRequestsPerUserMinute: number;
	historyRequestsPerIpMinute: number;
	concurrentHistoryPerConnection: number;
	anonymousPostsPerMinute: number;
	anonymousPostsPerDay: number;
	registeredPostsPerMinute: number;
	registeredPostsPerDay: number;
	ipPostsPerMinute: number;
	ipPostsPerDay: number;
	globalPostsPerMinute: number;
	globalPostsPerDay: number;
	registrationsPerIpDay: number;
	registrationsPerDay: number;
	registeredIdentityCount: number;
	authAttemptsPerIpMinute: number;
	openConnections: number;
	anonymousConnectionsPerIp: number;
	registeredConnectionsPerUser: number;
	connectionsPerIp: number;
	connectionAdmissionsPerIpMinute: number;
	connectionAdmissionsPerDay: number;
	unauthenticatedTimeoutSeconds: number;
	pendingFramesPerConnection: number;
	pendingBytesPerConnection: number;
	framesPerConnectionMinute: number;
	framesPerIpMinute: number;
	processedFramesPerDay: number;
	repeatedPolicyViolations: number;
	/**
	 * Frames the whole server processes in a rolling minute, counted in memory
	 * before any SQL. Past it, requests get `retry_after` and notifications are
	 * dropped; the socket stays open. Free's 300 is sized for a spike from 50
	 * connected users, 10 of them active: about 20 frames a minute per active
	 * user (posts, reactions, edits, history pages, room lookups), one per quiet
	 * user, and a reconnect wave of auth plus a history page each.
	 */
	globalFramesPerMinute: number;
	/**
	 * Per-type throttles, counted per user across their connections. Activity
	 * over its limit is dropped and the sender gets one `@private` notice per
	 * window; other requests over theirs are answered with `retry_after`.
	 */
	activityBroadcastsPerUserMinute: number;
	roomListRequestsPerUserMinute: number;
	/** The longest typing indicator a relayed `activity` may ask for, in seconds. */
	activityMaxTypingSeconds: number;
	/**
	 * Frames one connection reserves at once. Each reservation's SQL
	 * bookkeeping (about 24 reserved writes) is then shared by the block;
	 * operations that do SQL work still reserve their own cost. An unspent
	 * block is burned when the connection closes or the UTC day ends.
	 */
	frameLease: number;
	/**
	 * Registered members listed per room in `members` (`room_list` with
	 * `members: true`, and `room_update` `joined`), in `user_id` order.
	 * Connected members, guests included, are always listed besides. Each
	 * listed registered member costs two indexed reads.
	 */
	roomListMembers: number;
	/**
	 * Seconds between client liveness pings, advertised as `server.ping`
	 * (protocol §1). The runtime answers the ping without waking the object,
	 * so it costs no frame budget.
	 */
	pingSeconds: number;
	/**
	 * A connection that has pinged is stale once this long passes with no
	 * ping or frame. It is closed before `members` are listed and before
	 * connections are counted for admission.
	 */
	pingTimeoutSeconds: number;
	/**
	 * Guest numbers (`guest_<n>`) the object reserves with one durable write.
	 * It serves them from memory and reserves the next block when they run
	 * out. A wake from hibernation or eviction cannot know how far it got, so
	 * it starts a fresh block and the rest of the old one is skipped: guest
	 * numbers stay unique but have gaps of up to one block per wake. Larger
	 * blocks save writes only while the object stays awake; smaller ones keep
	 * the latest number closer to the count of guests.
	 */
	guestNumberBlock: number;
	sqlWritesPerDay: number;
	sqlReadsPerDay: number;
	foregroundWritesPerDay: number;
	maintenanceWritesPerDay: number;
	foregroundReadsPerDay: number;
	maintenanceReadsPerDay: number;
	databaseHighWaterBytes: number;
	databaseHardTargetBytes: number;
	databaseResumeLowWaterBytes: number;
	cleanupBatch: number;
	threadLimit: number;
	threadMetadataBytes: number;
	/** Distinct users whose reaction sets one message may carry. */
	reactionUsersPerMessage: number;
	/** Distinct emoji in one user's reaction set on one message. */
	reactionEmojisPerUser: number;
	dedupTtlSeconds: number;
	limiterRecordCap: number;
	maxCredentialBytes: number;
	maxChallengeBytes: number;
}

export interface AdmissionBudget {
	requestsPerIpMinute: number;
	workerWindowSeconds: number;
	edgeRequestsPerIpWindow: number;
	edgeWindowSeconds: number;
	edgeBlockSeconds: number;
}

/** A plan's included usage per UTC day, which the account-usage stop compares against. */
export interface AccountAllowance {
	daily: Readonly<{
		workerRequests: number;
		durableObjectRequests: number;
		durableObjectDurationGbSeconds: number;
		sqlRowsRead: number;
		sqlRowsWritten: number;
	}>;
	storedBytes: number;
	/** Incoming WebSocket messages billed as one Durable Object request. */
	webSocketMessagesPerRequest: number;
	/**
	 * Included usage per month, for a plan that bills past it. Usage since the
	 * start of the UTC calendar month stops at `monthlyStopRatio` of any of it.
	 */
	monthly?: Readonly<MonthlyAllowance>;
	monthlyStopRatio?: number;
	/**
	 * R2's free tier, for a plan that stores uploads there. Each day stops at
	 * its share (a 31st) of the monthly operations, and the month at
	 * `monthlyStopRatio` of them, like the Workers allowances.
	 */
	r2?: Readonly<R2Allowance>;
}

export interface R2Allowance {
	classAOperationsMonthly: number;
	classBOperationsMonthly: number;
	storedBytes: number;
}

export interface MonthlyAllowance {
	workerRequests: number;
	workerCpuMs: number;
	durableObjectRequests: number;
	durableObjectDurationGbSeconds: number;
	sqlRowsRead: number;
	sqlRowsWritten: number;
	logEvents: number;
}

/** Defaults for the feature switches; `ACTIVITY` and `GUEST_POSTING` override them. */
export interface Features {
	activity: boolean;
	guestPosting: boolean;
}

/**
 * The edge stop for a plan that bills past its included usage. The Worker
 * trips it on a flood; the budget guard holds and lifts it.
 */
export interface EdgeStop {
	/** Requests one Cloudflare location may pass to the Worker in a minute before the Worker trips the stop. */
	floodRequestsPerColoMinute: number;
	/** The Worker counts one request in this many, chosen at random, against that limit. */
	floodSampleEvery: number;
	/** The budget guard keeps the stop on at least this long after it was turned on. */
	holdSeconds: number;
}

/**
 * Uploads (protocol §4.6.3, cap `embed:upload`): images registered users
 * attach to messages or set as avatars, stored in R2 and served from its
 * public bucket domain.
 */
export interface UploadPolicy {
	/** Largest attached image. */
	maxFileBytes: number;
	/** Largest avatar image. */
	maxAvatarBytes: number;
	/** Uploads the whole server issues a UTC day, avatars included. */
	uploadsPerDay: number;
	/** Uploads one user may start a UTC day. */
	uploadsPerUserDay: number;
	/** How long a `write_url` stays usable. */
	writeWindowSeconds: number;
	/** How long an attached image lives; the bucket's lifecycle rule for `f/` must match. */
	fileRetentionSeconds: number;
	/** How long an avatar lives; the bucket's lifecycle rule for `a/` must match. */
	avatarRetentionSeconds: number;
	/** A signed-in user's avatar closer than this to expiry is written again, restarting it. */
	avatarRefreshSeconds: number;
	/** How long R2 may keep an object after its lifecycle expiry; still counted as stored. */
	lifecycleLagSeconds: number;
	/** Bytes all live uploads may hold, pending writes counted at their largest. */
	storedBytesCap: number;
}

export interface Plan {
	name: string;
	limits: Readonly<Limits>;
	admission: Readonly<AdmissionBudget>;
	account: Readonly<AccountAllowance>;
	features: Readonly<Features>;
	edgeStop?: Readonly<EdgeStop>;
	uploads?: Readonly<UploadPolicy>;
}

// Match the account's Workers plan. To switch back to Free, import FREE_PLAN
// from ./plans/free.ts here, then run npm run budget:generate.
export const PLAN: Plan = PAID_PLAN;

export const DEFAULT_LIMITS: Readonly<Limits> = PLAN.limits;
export const DEFAULT_FEATURES: Readonly<Features> = PLAN.features;
export const UPLOAD_POLICY: Readonly<UploadPolicy> | undefined = PLAN.uploads;

// Calibrated implementation bounds remain explicit: raising a payload or parser
// bound requires rechecking its consumers. Resource ceilings below instead use
// the selected defaults, so changing a budget does not require editing it twice.
export const MAX_FRAME_BYTES = 16 * 1024;
export const MAX_TEXT_BYTES = 4 * 1024;
export const MAX_SNAPSHOT_BYTES = 8 * 1024;
export const MAX_JSON_DEPTH = 8;
export const MAX_JSON_NODES = 2_048;
export const MAX_REQUEST_ID_BYTES = 128;
export const MAX_NAME_CODE_POINTS = 80;
export const MAX_NAME_BYTES = 320;
export const MAX_EMBEDS = 4;
export const MAX_HISTORY_LIMIT = 50;
export const MAX_HISTORY_RESPONSE_BYTES = 256 * 1024;
export const MAX_PENDING_FRAMES = 8;
export const MAX_PENDING_BYTES = 128 * 1024;
export const MAX_CONCURRENT_HISTORY = 1;
export const MAX_CREDENTIAL_BYTES = 16 * 1024;
export const MAX_CHALLENGE_BYTES = 16 * 1024;
export const MAX_OPEN_CONNECTIONS = DEFAULT_LIMITS.openConnections;
export const MAX_REGISTERED_IDENTITIES = DEFAULT_LIMITS.registeredIdentityCount;
export const MAX_LIMITER_RECORDS = DEFAULT_LIMITS.limiterRecordCap;
export const MAX_PROCESSED_FRAMES = DEFAULT_LIMITS.processedFramesPerDay;
export const MAX_GLOBAL_POSTS_PER_MINUTE = DEFAULT_LIMITS.globalPostsPerMinute;
export const MAX_GLOBAL_POSTS_PER_DAY = DEFAULT_LIMITS.globalPostsPerDay;
export const MAX_REGISTRATIONS_PER_DAY = DEFAULT_LIMITS.registrationsPerDay;
export const MAX_CLEANUP_BATCH = 100;
export const MAX_THREAD_LIMIT = 100;
export const MAX_THREAD_METADATA_BYTES = 2 * 1024;
// A move re-logs every reaction set of the moved message in one record, so the
// per-message cap bounds that record, its SQL work, and its history response.
export const MAX_REACTION_USERS_PER_MESSAGE = 64;
export const MAX_REACTION_EMOJIS_PER_USER = 16;
export const MAX_EMOJI_BYTES = 64;
export const MAX_CONNECTION_FRAME_RATE = 120;
// The server-wide frame window is one in-memory timestamp per frame.
export const MAX_GLOBAL_FRAMES_PER_MINUTE = 1_000;
// Throttle windows live in connection attachments, one timestamp per event.
export const MAX_TYPE_THROTTLE_PER_MINUTE = 60;
// A block counts against the IP's frame minute all at once.
export const MAX_FRAME_LEASE = 20;
// Every room in a listing carries its members list, so it multiplies the
// listing's reads and response by the thread ceiling (listings past the
// response cap leave members out).
export const MAX_ROOM_LIST_MEMBERS = 200;
// A guest-number block is one durable write, spent whether or not the object
// hands its numbers out before it sleeps; this bounds how fast numbers climb.
export const MAX_GUEST_NUMBER_BLOCK = 10_000;
export const MAX_SQL_WRITES = DEFAULT_LIMITS.sqlWritesPerDay;
export const MAX_SQL_READS = DEFAULT_LIMITS.sqlReadsPerDay;
export const MAX_DATABASE_HIGH_WATER_BYTES = DEFAULT_LIMITS.databaseHighWaterBytes;
export const MAX_DATABASE_HARD_TARGET_BYTES = DEFAULT_LIMITS.databaseHardTargetBytes;
export const MAINTENANCE_CONTROL_RESERVE = 8;
export const BOOTSTRAP_ROW_RESERVATION = 512;
export const MAX_SOCKET_QUEUE_ALLOCATION = 32 * 1024 * 1024;
export const ADMISSION_BUDGET: Readonly<AdmissionBudget> = PLAN.admission;

// Account analytics are a delayed safety signal, not an exact quota meter.
// Keep this policy separate from local application reservations: a refresh can
// only stop this object after Cloudflare reports that the account is nearing a
// shared allowance.
export const ACCOUNT_USAGE_POLICY = Object.freeze({
	refreshEveryEvents: 1_000,
	minimumRefreshIntervalMs: 60_000,
	staleAfterMs: 5 * 60_000,
	initialRetryMs: 60_000,
	maxRetryMs: 15 * 60_000,
	stopRatio: 0.90,
	...PLAN.account,
});
