import { DurableObject } from "cloudflare:workers";
import { AuthError, AuthTooLargeError, candidateUserIdFor, WebAuthnService, type ChallengeRecord, type CredentialRepository } from "./auth";
import { isAllowedOrigin, loadConfig, pushHostAllowed, type RuntimeConfig } from "./config";
import { ACCOUNT_USAGE_POLICY, ADMISSION_BUDGET, PLAN, MAX_FRAME_LEASE, MAX_PUSH_CANDIDATES, MAX_THREAD_LIMIT, MAX_TYPE_THROTTLE_PER_MINUTE, PUSH_POLICY, UPLOAD_POLICY } from "./budget";
import { fetchAccountUsage, type AccountUsageSnapshot } from "./account-usage";
import { runBudgetGuard, watchForFlood } from "./budget-guard";
import { sniffImage } from "./image";
import { signUploadToken, verifyUploadToken } from "./upload-token";
import { AUTH_SECRET_BYTES, base64UrlDecode, base64UrlEncode, sendWebPush, validP256PublicKey, type VapidKeys } from "./webpush";
import { extractClientIp, hashIpKey, stripForwardingHeaders } from "./ip";
import {
	errorFromUnknown,
	FrameError,
	jsonString,
	objectParam,
	optionalString,
	parseFrame,
	positiveIntParam,
	protocolError,
	protocolReply,
	requiredString,
	retryAfterSeconds,
	utf8Bytes,
	type ProtocolError,
	type RequestFrame,
} from "./protocol";
import {
	ADMIN_USER_ID,
	DEFAULT_JOINED_ROOMS,
	MAX_PASSKEYS_PER_USER,
	MAX_PUSH_URL_BYTES,
	MAX_ROLES_PER_USER,
	MAX_MUTE_SECONDS,
	MUTE_FOREVER,
	PUSH_ID_PATTERN,
	ROLE_PATTERN,
	WAKE_SCOPES,
	ROOM_ID,
	Store,
	StoreError,
	UPLOAD_SWEEP_BATCH,
	UPLOAD_WRITE_GRACE_MS,
	uploadResultEmbed,
	type Broadcast,
	type MessageSnapshot,
	type PushCandidate,
	type PushSubscriptionRecord,
	type RoomRecord,
	type StoreConfig,
	type StoreMutationInput,
	type StoreMutationResult,
	type UploadFinish,
	type UploadWrite,
} from "./store";

const OBJECT_NAME = "public-demo-v1";
const INTERNAL_IP_HEADER = "X-Apron-Trusted-IP-Key";
const ATTACHMENT_VERSION = 1;
/** Key prefix for passkey session records in the object's key-value storage. */
const SESSION_KEY_PREFIX = "session:";
/** Ordered, advisory expiry entries. The session record remains authoritative. */
const SESSION_EXPIRY_PREFIX = "session-expiry:";
const SESSION_CLEANUP_BATCH = 16;
/**
 * How often an alarm sweeps expired sessions. Every connection wakes the alarm
 * at its auth deadline, and the probe is KV work charged at its full bound, so
 * it runs at most this often; a resume rejects an expired session on its own.
 */
const SESSION_SWEEP_INTERVAL_MS = 60 * 60_000;
const MAX_SESSION_TOKEN_CHARS = 256;
/** Longest avatar URL a connection keeps: the media origin and an object key. */
const MAX_AVATAR_CHARS = 512;

type WebSocketConnection = WebSocket & {
	serializeAttachment?: (value: unknown) => void;
	deserializeAttachment?: () => unknown;
};

interface ConnectionAttachment {
	v: 1;
	connId: string;
	ipKey: string;
	tier: "pending" | "anonymous" | "registered";
	userId?: string;
	name?: string;
	/** The user's avatar (§4.6.6), for current user objects; never in `from`. */
	avatar?: string;
	/**
	 * A registered user's roles (§3.3), read with the identity at sign-in and
	 * kept current by `/role` and `/admin`: for current user objects, and for
	 * the admin and bot checks, which need no storage read.
	 */
	roles?: string[];
	origin?: string;
	/** The WebSocket URL this connection reached, for instructions that name the server (`/invite-bot`). */
	endpoint?: string;
	challenge?: ChallengeRecord;
	authDeadline: number;
	pendingFrames: number;
	pendingBytes: number;
	policyViolations: number[];
	historyInFlight: number;
	frameTimes: number[];
	/** Per-type throttle events from this connection, oldest first (budget.ts). */
	throttles?: Partial<Record<ThrottledType, number[]>>;
	/** When this connection last got a `~private` throttle notice, per type. */
	notices?: Partial<Record<ThrottledType, number>>;
	/** Frames this connection has already reserved and not yet spent, for one UTC day. */
	frameLease?: { day: string; remaining: number };
	/**
	 * The rooms this connection's user has joined (§4.3.2), which it receives
	 * deliveries for. Set at authentication and kept equal across the user's
	 * connections; a registered user's are also stored in the `memberships` table.
	 */
	rooms?: string[];
	/**
	 * Whether a `filter: "joined"` listing has been answered since
	 * authentication. The first one is not throttled: it is how a client
	 * learns its rooms.
	 */
	listedJoined?: boolean;
	/**
	 * The client said nobody is attending this connection (`status` `idle`,
	 * §4.11), so a mention or reply may wake its user by push (§4.7). Cleared
	 * by `idle: false` or an accepted message from this connection; kept
	 * from before authentication.
	 */
	away?: boolean;
	/**
	 * A `status` `mute` sent before authentication (§4.11), as the `mutes`
	 * row's `until_ms` it asks for (0 ends a mute), applied once the
	 * connection signs in as a registered user.
	 */
	pendingMute?: number;
	closing?: boolean;
}

/** Message types with their own per-user rate (budget.ts). */
type ThrottledType = "activity" | "room_list" | "push_register";
const THROTTLED_TYPES: readonly ThrottledType[] = ["activity", "room_list", "push_register"];
const THROTTLE_WINDOW_MS = 60_000;
/**
 * The system identity for notices to one connection only, never logged
 * (Appendix A.1). Protocol v7 prefixes system identities with `~`; no user
 * can hold such an id (guest, passkey, bot, and admin-issued ids all start
 * with a letter or digit, and `auth` never honors a requested `user_id`).
 */
const PRIVATE_IDENTITY = { user_id: "~private", name: "System message to you" } as const;
/**
 * The liveness ping clients send every `server.ping` seconds, byte for byte,
 * and its answer (§1). The runtime answers it without waking the object.
 */
const PING_REQUEST = '{"method":"ping"}';
const PING_RESPONSE = '{"method":"pong"}';
/** Joined room IDs a connection attachment may carry: every room, with slack for removals in flight. */
const MAX_ATTACHED_ROOMS = 2 * (MAX_THREAD_LIMIT + 1);
/**
 * Sign-up invites (`/invite`, protocol Appendix B): one token that creates a
 * new registered user on each use, up to its count. What they look like, the
 * key of the one live invite by the token's SHA-256, and the pointer to it.
 */
const JOIN_TOKEN_PREFIX = "apron_join_";
const JOIN_TOKEN_KEY_PREFIX = "join-token:";
const JOIN_INVITE_KEY = "join-invite";
/** Sign-ups one `/invite` may allow, and how long it lasts. */
const MAX_JOIN_USES = 50;
/** The name of a user who signs up with an invite and asks for none: not "Guest", which names guests. */
const JOIN_DEFAULT_NAME = "Member";
const JOIN_INVITE_TTL_MS = 7 * 86_400_000;
/**
 * The commands this server provides (§4.8), as `/help` lists them to those
 * who may run them: `everyone`, `owners` (registered users other than bots),
 * or `admins` (the `APRON_ADMIN_TOKEN` user and those given the `admin` role).
 */
const COMMANDS: ReadonlyArray<{ name: string; usage: string; help: string; audience: "everyone" | "owners" | "admins" }> = [
	{ name: "help", usage: "/help", help: "list the commands you can use here", audience: "everyone" },
	{ name: "invite-bot", usage: "/invite-bot", help: "get a sign-in token for your bot; a new one replaces the last", audience: "owners" },
	{ name: "avatar", usage: "/avatar", help: "set your avatar: send this command with one image attached", audience: "owners" },
	{ name: "passkeys", usage: "/passkeys [remove <n>]", help: "list your account's passkeys, or remove one of them", audience: "owners" },
	{ name: "admin", usage: "/admin [remove] <user_id>", help: "make a registered user an admin, or no longer one", audience: "admins" },
	{ name: "role", usage: "/role <user_id> [<role>]", help: "show a user's roles, or give or take away one (admin and bot act as such; others are labels)", audience: "admins" },
	{ name: "kick", usage: "/kick <user_id>", help: "remove a user from this room", audience: "admins" },
	{ name: "rename", usage: "/rename <old_user_id> <new_user_id>", help: "change a registered user's user_id", audience: "admins" },
	{ name: "invite-token", usage: "/invite-token <user_id>", help: "create a user who signs in with a token instead of a passkey, and get the token", audience: "admins" },
	{ name: "invite", usage: "/invite <uses>", help: `get a token that signs up to <uses> new users (at most ${MAX_JOIN_USES}) for a week, replacing the last one; /invite 0 revokes it`, audience: "admins" },
	{ name: "toggle", usage: "/toggle <activity|uploads>", help: "turn typing activity or uploads off or on for everyone", audience: "admins" },
	{ name: "purge", usage: "/purge <user_id>", help: "disconnect a user and delete their account, bot, and everything they posted or uploaded", audience: "admins" },
	{ name: "status", usage: "/status", help: "show today's Cloudflare usage and the demo's budgets", audience: "admins" },
];
/** Why a guest's post, reaction, join, leave, or room change is denied while guests only read. */
const GUEST_READ_ONLY = "Guests can only read here; sign in with a passkey to post or join rooms";
/**
 * A registered user's bot is `bot_` plus the owner's `user_id`. Guests are
 * `guest_<n>` and registered users `<name>_<digits>` or `u_…`, never starting
 * `guest_` or `bot_`, so the prefix names bots alone.
 */
const BOT_ID_PREFIX = "bot_";
/** Features an admin can turn off and on with `/toggle`. */
type ToggleFeature = "activity" | "uploads";
/**
 * The registered user `APRON_ADMIN_TOKEN` signs in as (ADMIN_USER_ID, `admin`)
 * is always an admin. Registered users are `<name>_<digits>` or `u_…`, so no
 * passkey user can take its id, and it never holds a passkey.
 */
const ADMIN_USER_NAME = "Admin";
/** Bot tokens start with this, so `auth` tells them from passkey session tokens without a storage read. */
const BOT_TOKEN_PREFIX = "apron_bot_";
/** Key prefix for bot tokens in key-value storage, by the token's SHA-256 like sessions. */
const BOT_TOKEN_KEY_PREFIX = "bot-token:";
/** Key prefix for each bot's current token key, so a new `/invite-bot` revokes the last token. */
const BOT_KEY_PREFIX = "bot:";
/** Invite tokens (`/invite-token`): what they look like, their hashed keys, and each user's pointer to theirs. */
const INVITE_TOKEN_PREFIX = "apron_invite_";
const INVITE_TOKEN_KEY_PREFIX = "invite-token:";
const INVITE_KEY_PREFIX = "invite:";
/** The protocol a bot's instructions point it at (`/invite-bot`). */
const PROTOCOL_URL = "https://github.com/shazow/apron/blob/main/PROTOCOL.md";

/**
 * A bearer session minted by a verified passkey login (protocol §4.9,
 * session resume). Stored under a SHA-256 key so the plaintext token never
 * rests in storage. Kept in key-value storage rather than the SQL store: it is
 * throwaway state with its own expiry and needs no schema migration.
 */
interface StoredSession {
	v: 1;
	userId: string;
	origin: string;
	expiresMs: number;
}

/**
 * A bot's bearer token (`/invite-bot`), stored under its SHA-256. Unlike a
 * passkey session it is bound to no origin, since bots are not browsers, and
 * does not expire: the owner's next `/invite-bot` replaces it.
 */
interface StoredBotToken {
	v: 1;
	botId: string;
	ownerId: string;
}

/** A bot's current token, by key, so the next invite can revoke it. */
interface StoredBot {
	v: 1;
	tokenKey: string;
}

/**
 * An invite token (`/invite-token`), stored only as its SHA-256 under
 * INVITE_TOKEN_KEY_PREFIX: the registered user it signs in as. The user's
 * INVITE_KEY_PREFIX entry is a StoredBot-shaped pointer back to it.
 */
interface StoredInviteToken {
	v: 1;
	userId: string;
}

/**
 * The live sign-up invite (`/invite`), stored only under its token's SHA-256:
 * how many sign-ups it has left and when it expires.
 */
interface StoredJoinInvite {
	v: 1;
	remaining: number;
	expiresMs: number;
}

interface SessionExpiryEntry {
	v: 1;
	sessionKey: string;
	expiresMs: number;
}

interface IdentityShape {
	user_id: string;
	name?: string;
	tier?: "anonymous" | "registered";
}

function randomId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256Hex(token: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares a presented token with a configured one through their digests, so the time taken says nothing of the secret. */
async function sameToken(presented: string, configured: string): Promise<boolean> {
	return await sha256Hex(presented) === await sha256Hex(configured);
}

async function sessionKey(token: string): Promise<string> {
	return SESSION_KEY_PREFIX + await sha256Hex(token);
}

/** Longest connection endpoint an attachment keeps. */
const MAX_ENDPOINT_CHARS = 256;

/** The WebSocket URL a request reached, `ws(s)://host/path` without its query; undefined when too long. */
function endpointOf(request: Request): string | undefined {
	const url = new URL(request.url);
	const endpoint = `${url.protocol === "http:" ? "ws:" : "wss:"}//${url.host}${url.pathname}`;
	return endpoint.length <= MAX_ENDPOINT_CHARS ? endpoint : undefined;
}

/**
 * Throws unless `userId` may be issued by an admin (`/rename`, `/invite-token`):
 * 1 to 64 letters, digits, `_` or `-`, starting with a letter or digit, and
 * not a guest's or bot's.
 */
function assertIssuableUserId(userId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(userId) || /^(guest|bot)(_|$)/i.test(userId)) {
		throw { name: "invalid_params", message: "A user_id is 1 to 64 letters, digits, _ or -, starting with a letter or digit, and not guest_ or bot_" } satisfies ProtocolError;
	}
}

/** Whether a `user_id` is an owner's bot's (`bot_<owner>`); a user may also be a bot by role (`isBot`). */
function isBotId(userId: string | undefined): boolean {
	return userId?.startsWith(BOT_ID_PREFIX) === true;
}

/** "Bot of <owner>", cut to the name limits by whole code points. */
function botName(owner: string, limits: { maxNameCodePoints: number; maxNameBytes: number }): string {
	const points = [...`Bot of ${owner}`].slice(0, limits.maxNameCodePoints);
	while (utf8Bytes(points.join("")) > limits.maxNameBytes) points.pop();
	return points.join("");
}

function sessionExpiryKey(expiresMs: number, sessionKeyValue: string): string {
	// Date.now() plus the configured lifetime is well below 16 decimal digits;
	// the fixed width keeps lexicographic KV listing ordered by expiry.
	return `${SESSION_EXPIRY_PREFIX}${Math.max(0, Math.trunc(expiresMs)).toString().padStart(16, "0")}:${sessionKeyValue.slice(SESSION_KEY_PREFIX.length)}`;
}

function nowMs(): number {
	return Date.now();
}

function asStoreConfig(config: RuntimeConfig): Partial<StoreConfig> {
	const limits = config.limits;
	return {
		retentionMs: limits.retentionSeconds * 1_000,
		dedupTtlMs: limits.dedupTtlSeconds * 1_000,
		cleanupIntervalMs: limits.cleanupSeconds * 1_000,
		cleanupBatch: limits.cleanupBatch,
		maxSnapshotBytes: limits.maxSnapshotBytes,
		maxTextBytes: limits.maxTextBytes,
		maxNameBytes: limits.maxNameBytes,
		maxNameCodePoints: limits.maxNameCodePoints,
		maxEmbeds: limits.maxEmbeds,
		maxThreads: limits.threadLimit,
		maxThreadMetadataBytes: limits.threadMetadataBytes,
		reactionUsersPerMessage: limits.reactionUsersPerMessage,
		reactionEmojisPerUser: limits.reactionEmojisPerUser,
		maxHistoryLimit: limits.historyMaxLimit,
		historyDefaultLimit: limits.historyDefaultLimit,
		maxHistoryResponseBytes: limits.historyMaxResponseBytes,
		historyRequestsPerUserMinute: limits.historyRequestsPerUserMinute,
		historyRequestsPerIpMinute: limits.historyRequestsPerIpMinute,
		anonymousPostsPerMinute: limits.anonymousPostsPerMinute,
		anonymousPostsPerDay: limits.anonymousPostsPerDay,
		registeredPostsPerMinute: limits.registeredPostsPerMinute,
		registeredPostsPerDay: limits.registeredPostsPerDay,
		ipPostsPerMinute: limits.ipPostsPerMinute,
		ipPostsPerDay: limits.ipPostsPerDay,
		globalPostsPerMinute: limits.globalPostsPerMinute,
		globalPostsPerDay: limits.globalPostsPerDay,
		registrationsPerIpDay: limits.registrationsPerIpDay,
		registrationsPerDay: limits.registrationsPerDay,
		registeredIdentityCount: limits.registeredIdentityCount,
		authAttemptsPerIpMinute: limits.authAttemptsPerIpMinute,
		principalLimitCap: limits.limiterRecordCap,
		sqlReadsPerDay: limits.sqlReadsPerDay,
		sqlWritesPerDay: limits.sqlWritesPerDay,
		foregroundReadsPerDay: limits.foregroundReadsPerDay,
		foregroundWritesPerDay: limits.foregroundWritesPerDay,
		maintenanceReadsPerDay: limits.maintenanceReadsPerDay,
		maintenanceWritesPerDay: limits.maintenanceWritesPerDay,
		storageHighWaterBytes: limits.databaseHighWaterBytes,
		storageHardTargetBytes: limits.databaseHardTargetBytes,
		storageLowWaterBytes: limits.databaseResumeLowWaterBytes,
		admissionEnabled: !config.admissionOff,
		uploads: config.uploads && UPLOAD_POLICY ? { ...UPLOAD_POLICY, mediaOrigin: config.uploads.mediaOrigin } : null,
		push: config.push && PUSH_POLICY ? { ...PUSH_POLICY } : null,
		processedFramesPerDay: limits.processedFramesPerDay,
		framesPerIpMinute: limits.framesPerIpMinute,
		connectionAdmissionsPerIpMinute: limits.connectionAdmissionsPerIpMinute,
		connectionAdmissionsPerDay: limits.connectionAdmissionsPerDay,
	};
}

function trustedIpKey(request: Request): string | null {
	const value = request.headers.get(INTERNAL_IP_HEADER);
	return value && /^[A-Za-z0-9_-]{22}$/.test(value) ? value : null;
}

function challengeFromAttachment(value: unknown, connectionId: string): ChallengeRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<ChallengeRecord>;
	const boundedString = (input: unknown, max = 1_024): input is string => typeof input === "string" && input.length > 0 && input.length <= max;
	if (!boundedString(candidate.challengeId) || !/^[A-Za-z0-9_-]+$/.test(candidate.challengeId)) return undefined;
	if (!boundedString(candidate.challenge) || !/^[A-Za-z0-9_-]+$/.test(candidate.challenge)) return undefined;
	if (candidate.action !== "register" && candidate.action !== "login") return undefined;
	if (!boundedString(candidate.origin) || !boundedString(candidate.rpId)) return undefined;
	if (!Number.isSafeInteger(candidate.expiresAt)) return undefined;
	if (candidate.connectionId !== undefined && (!boundedString(candidate.connectionId) || candidate.connectionId !== connectionId)) return undefined;
	for (const key of ["identityUserId", "userId", "userHandle", "userName"] as const) {
		if (key === "identityUserId" && candidate[key] === null) continue;
		if (candidate[key] !== undefined && !boundedString(candidate[key])) return undefined;
	}
	if (candidate.adds !== undefined && candidate.adds !== true) return undefined;
	return candidate as ChallengeRecord;
}

function connectionAttachment(socket: WebSocketConnection): ConnectionAttachment | null {
	try {
		const value = socket.deserializeAttachment?.();
		if (!value || typeof value !== "object") return null;
		const attachment = value as Partial<ConnectionAttachment>;
		if (attachment.v !== ATTACHMENT_VERSION || typeof attachment.connId !== "string" || typeof attachment.ipKey !== "string") return null;
		const challenge = challengeFromAttachment(attachment.challenge, attachment.connId);
		return {
			v: 1,
			connId: attachment.connId,
			ipKey: attachment.ipKey,
			tier: attachment.tier === "anonymous" || attachment.tier === "registered" ? attachment.tier : "pending",
			...(typeof attachment.userId === "string" ? { userId: attachment.userId } : {}),
			...(typeof attachment.name === "string" ? { name: attachment.name } : {}),
			...(typeof attachment.avatar === "string" && attachment.avatar.length <= MAX_AVATAR_CHARS ? { avatar: attachment.avatar } : {}),
			...(Array.isArray(attachment.roles) ? {
				roles: attachment.roles.filter((role): role is string => typeof role === "string" && ROLE_PATTERN.test(role)).slice(0, MAX_ROLES_PER_USER),
			} : {}),
			...(typeof attachment.origin === "string" ? { origin: attachment.origin } : {}),
			...(typeof attachment.endpoint === "string" && attachment.endpoint.length <= MAX_ENDPOINT_CHARS ? { endpoint: attachment.endpoint } : {}),
			...(challenge ? { challenge } : {}),
			...(Array.isArray(attachment.rooms) ? {
				rooms: attachment.rooms.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64).slice(0, MAX_ATTACHED_ROOMS),
			} : {}),
			...(attachment.listedJoined ? { listedJoined: true } : {}),
			...(attachment.away === true ? { away: true } : {}),
			...(Number.isSafeInteger(attachment.pendingMute) && attachment.pendingMute! >= 0 ? { pendingMute: attachment.pendingMute } : {}),
			authDeadline: typeof attachment.authDeadline === "number" ? attachment.authDeadline : 0,
			pendingFrames: typeof attachment.pendingFrames === "number" ? attachment.pendingFrames : 0,
			pendingBytes: typeof attachment.pendingBytes === "number" ? attachment.pendingBytes : 0,
			policyViolations: Array.isArray(attachment.policyViolations) ? attachment.policyViolations.filter((value): value is number => typeof value === "number").slice(-120) : [],
			historyInFlight: typeof attachment.historyInFlight === "number" ? attachment.historyInFlight : 0,
			frameTimes: Array.isArray(attachment.frameTimes) ? attachment.frameTimes.slice(-120) : [],
			...throttleState(attachment),
			...(attachment.closing ? { closing: true } : {}),
		};
	} catch {
		return null;
	}
}

/** The throttle fields of a stored attachment, bounded and type-checked. */
function throttleState(attachment: Partial<ConnectionAttachment>): Pick<ConnectionAttachment, "throttles" | "notices" | "frameLease"> {
	const out: Pick<ConnectionAttachment, "throttles" | "notices" | "frameLease"> = {};
	const throttles: Partial<Record<ThrottledType, number[]>> = {};
	const notices: Partial<Record<ThrottledType, number>> = {};
	for (const type of THROTTLED_TYPES) {
		const events = attachment.throttles?.[type];
		if (Array.isArray(events)) throttles[type] = events.filter((value): value is number => typeof value === "number").slice(-MAX_TYPE_THROTTLE_PER_MINUTE);
		const notice = attachment.notices?.[type];
		if (typeof notice === "number") notices[type] = notice;
	}
	if (Object.keys(throttles).length) out.throttles = throttles;
	if (Object.keys(notices).length) out.notices = notices;
	const lease = attachment.frameLease;
	if (lease && typeof lease.day === "string" && Number.isSafeInteger(lease.remaining) && lease.remaining > 0) {
		out.frameLease = { day: lease.day, remaining: Math.min(lease.remaining, MAX_FRAME_LEASE) };
	}
	return out;
}

function writeAttachment(socket: WebSocketConnection, attachment: ConnectionAttachment): void {
	// The attachment is intentionally limited to connection state. The runtime
	// rejects oversized attachments; keeping this assertion near serialization
	// makes that failure visible during development.
	const serialized = JSON.stringify(attachment);
	if (utf8Bytes(serialized) > 12_000) throw new Error("connection attachment exceeds safety budget");
	socket.serializeAttachment?.(attachment);
}

function openSocket(socket: WebSocketConnection): boolean {
	return socket.readyState === 1;
}

/** Async ceremonies must not overwrite counters for frames queued meanwhile. */
function writeSessionAttachment(socket: WebSocketConnection, attachment: ConnectionAttachment): void {
	const current = connectionAttachment(socket);
	if (current) {
		attachment.pendingFrames = current.pendingFrames;
		attachment.pendingBytes = current.pendingBytes;
		attachment.frameTimes = current.frameTimes;
		attachment.policyViolations = current.policyViolations;
		attachment.throttles = current.throttles;
		attachment.notices = current.notices;
		attachment.frameLease = current.frameLease;
		attachment.closing = current.closing;
		if (current.away) attachment.away = true;
		else delete attachment.away;
		if (current.pendingMute !== undefined) attachment.pendingMute = current.pendingMute;
		else delete attachment.pendingMute;
	}
	writeAttachment(socket, attachment);
}

function errorToProtocol(error: unknown): ProtocolError {
	if (error instanceof AuthTooLargeError) return { name: "too_large", message: error.message };
	if (error instanceof AuthError) {
		return { name: "denied", message: error.message };
	}
	if (error instanceof StoreError) {
		if (error.code === "internal_error") return { name: "internal_error", message: "Demo temporarily unavailable" };
		return {
			name: error.code,
			message: error.message,
			...(error.retryAfterMs !== undefined
				? { data: { ...error.data, retry_after: retryAfterSeconds(error.retryAfterMs) } }
				: error.data ? { data: error.data } : {}),
		};
	}
	return errorFromUnknown(error);
}

function isUpgrade(request: Request): boolean {
	return request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function originAllowed(config: RuntimeConfig, request: Request): boolean {
	const origin = request.headers.get("Origin");
	return isAllowedOrigin(config, origin);
}

function responseError(status: number, message: string, retryAfter?: number): Response {
	const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	if (retryAfter !== undefined) headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfter / 1_000))));
	return new Response(JSON.stringify({ error: message }), { status, headers });
}

function asDecimalId(value: unknown, field: string, allowZero = true): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !/^\d+$/.test(value)) throw { name: "invalid_params", message: `${field} must be a decimal string` } satisfies ProtocolError;
	const number = Number(value);
	if (!Number.isSafeInteger(number) || (!allowZero && number === 0)) throw { name: "invalid_params", message: `${field} is outside the supported range` } satisfies ProtocolError;
	return String(number);
}

function passkeyCredentialParam(params: Record<string, unknown>, action: "register" | "login"): Record<string, unknown> {
	const credential = objectParam(params, "credential");
	if (!credential) throw { name: "invalid_params", message: "credential is required" } satisfies ProtocolError;
	const requiredCredentialString = (value: unknown, name: string): string => {
		if (typeof value !== "string" || value.length === 0) throw { name: "invalid_params", message: `credential.${name} must be a non-empty string` } satisfies ProtocolError;
		return value;
	};
	const id = requiredCredentialString(credential.id, "id");
	const rawId = requiredCredentialString(credential.rawId, "rawId");
	if (!/^[A-Za-z0-9_-]{1,1024}$/.test(id) || rawId !== id) throw { name: "invalid_params", message: "credential id must be unpadded base64url" } satisfies ProtocolError;
	if (credential.type !== "public-key") throw { name: "invalid_params", message: "credential.type must be public-key" } satisfies ProtocolError;
	const response = objectParam(credential, "response");
	if (!response) throw { name: "invalid_params", message: "credential.response is required" } satisfies ProtocolError;
	requiredCredentialString(response.clientDataJSON, "response.clientDataJSON");
	if (action === "register") requiredCredentialString(response.attestationObject, "response.attestationObject");
	else {
		requiredCredentialString(response.authenticatorData, "response.authenticatorData");
		requiredCredentialString(response.signature, "response.signature");
		if (response.userHandle !== undefined) requiredCredentialString(response.userHandle, "response.userHandle");
	}
	objectParam(credential, "clientExtensionResults");
	return credential;
}

/** The wire identity (section 3.3); the internal quota tier stays private. */
function publicIdentity(attachment: ConnectionAttachment): { user_id: string; name?: string } | null {
	const identity = identityOf(attachment);
	return identity ? { user_id: identity.user_id, ...(identity.name ? { name: identity.name } : {}) } : null;
}

/**
 * A connection's user as a current object (§3.3): `you`, `new`, and room
 * `members` and `users`, which carry `avatar` (§4.6.6). Recorded objects,
 * such as a message's `from`, use publicIdentity and never do.
 */
function currentUser(attachment: ConnectionAttachment): PublicUser | null {
	const identity = publicIdentity(attachment);
	return identity && attachment.avatar ? { ...identity, avatar: attachment.avatar } : identity;
}

/** Whether a connection's user is registered and has a role (§3.3), from its attachment. */
function hasRole(attachment: ConnectionAttachment, role: string): boolean {
	return attachment.tier === "registered" && (attachment.roles ?? []).includes(role);
}

/** Keeps a live avatar on a connection's attachment, or none; the caller writes the attachment. */
function setAvatar(attachment: ConnectionAttachment, avatar: string | undefined): void {
	if (avatar) attachment.avatar = avatar;
	else delete attachment.avatar;
}

function identityOf(attachment: ConnectionAttachment): IdentityShape | null {
	if (!attachment.userId || (attachment.tier !== "anonymous" && attachment.tier !== "registered")) return null;
	return { user_id: attachment.userId, ...(attachment.name ? { name: attachment.name } : {}), tier: attachment.tier };
}

/**
 * A user object as this server sends it (§3.3): `user_id` and `name`, and in
 * current objects `avatar` and `roles`.
 */
type PublicUser = { user_id: string; name?: string; avatar?: string; roles?: string[]; mute?: number | true };

/**
 * A room in a listing, with `members` when asked for (§4.3.1), and
 * `member_count` when `members` leaves some out.
 */
type ListedRoom = RoomRecord & { members?: Array<{ user_id: string }>; member_count?: number };

/** A `room_list` result (§4.3.1). */
interface ListingResult {
	joined?: ListedRoom[];
	not_joined?: ListedRoom[];
	users?: PublicUser[];
}

/** User objects once each, in `user_id` order. */
function sortedUsers(users: Iterable<PublicUser>): PublicUser[] {
	return [...users].sort((a, b) => a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0);
}

/** `room_update` `left` for one room, with the logged membership that removed the user, if any (§4.3.2). */
function leftUpdate(roomId: string, membership?: Broadcast): Record<string, unknown> {
	return { method: "room_update", params: { left: [{ room_id: roomId }], ...(membership ? { memberships: [membership.params] } : {}) } };
}

/** A `room_update` notification (§4.3.3) with one field. */
function roomUpdate(field: "joined" | "updated" | "left", ...records: unknown[]): Record<string, unknown> {
	return { method: "room_update", params: { [field]: records } };
}

/** Host names that resolve only inside a network, never to a public push service. */
const INTERNAL_HOST_SUFFIXES = ["localhost", "localdomain", "local", "internal", "intranet", "lan", "home.arpa", "corp", "private"];

/**
 * Why a push endpoint is refused, or null when it is taken (§4.7: `https`
 * endpoints that resolve to non-internal addresses). The Worker cannot
 * resolve names before it fetches, so it refuses endpoints that name an
 * address or an internal network outright: IP literals, single-label hosts,
 * and internal suffixes such as `localhost`; and it refuses credentials and
 * ports other than https's own. A public name that resolves to a private
 * address is left to the platform, whose outbound fetch does not reach
 * private networks. Past those checks, the host must be one `PUSH_HOSTS`
 * allows: by default, the browsers' own push services.
 */
function pushEndpointError(value: string, hosts: RuntimeConfig["pushHosts"]): string | null {
	if (utf8Bytes(value) > MAX_PUSH_URL_BYTES) return `url is at most ${MAX_PUSH_URL_BYTES} bytes`;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "url must be an https URL";
	}
	if (url.protocol !== "https:") return "url must be an https URL";
	if (url.username || url.password || url.port) return "url must not carry credentials or a port";
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	// The URL parser has already turned every IPv4 spelling (hex, octal, a
	// bare number) into dotted decimal, and IPv6 into brackets.
	if (host.startsWith("[") || /^[0-9.]+$/.test(host) || !host.includes(".") ||
		INTERNAL_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
		return "url must name a public push service";
	}
	if (!pushHostAllowed(hosts, host)) return "push service not allowed here";
	return null;
}

/** Entries a `push_register` `wake` may list, known or not. */
const MAX_WAKE_ENTRIES = 16;

/**
 * A `push_register` `wake` (§4.7) as a WAKE_SCOPES bitmask, undefined when
 * absent. Unknown scopes are ignored, as the protocol asks; an array that is
 * too long, or entries that are not short strings, are `invalid_params`.
 */
function wakeParam(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_WAKE_ENTRIES || value.some((entry) => typeof entry !== "string" || entry.length > 64)) {
		throw { name: "invalid_params", message: `wake must be an array of at most ${MAX_WAKE_ENTRIES} scope names` } satisfies ProtocolError;
	}
	let mask = 0;
	for (const entry of value as string[]) if (Object.hasOwn(WAKE_SCOPES, entry)) mask |= WAKE_SCOPES[entry as keyof typeof WAKE_SCOPES];
	return mask;
}

/** Longest `body.text` a push carries, in code points; longer text is cut, ending in `…`. */
const PUSH_TEXT_CODE_POINTS = 200;

/** Largest push payload, in bytes of JSON (§4.7), leaving a relay room to wrap it for APNs or FCM. */
const MAX_PUSH_PAYLOAD_BYTES = 3072;

/**
 * What a push carries (§4.7): the envelope `{push_id?, message}`, with the
 * registration's `push_id` when it has one (`unread` is not implemented,
 * so never sent), and as `message` the message without `log_id`, its text
 * cut to PUSH_TEXT_CODE_POINTS (left out when empty), and without `format`,
 * `embeds`, `ext`, or the server's `prev_*` links. Each fallback drops more
 * of `message` until the whole envelope fits MAX_PUSH_PAYLOAD_BYTES: first
 * `mentions`, then all of `from` but its `user_id` and `name`, then `body`.
 */
function pushPayload(message: MessageSnapshot, pushId?: string): string {
	const body = message.body ?? {};
	const points = typeof body.text === "string" ? [...body.text] : [];
	const text = points.length > PUSH_TEXT_CODE_POINTS ? points.slice(0, PUSH_TEXT_CODE_POINTS - 1).join("") + "…" : points.join("");
	const tail = message.reply_to ? { reply_to: message.reply_to } : {};
	const shortFrom = { user_id: message.from.user_id, ...(typeof message.from.name === "string" ? { name: message.from.name } : {}) };
	const textField = text ? { text } : {};
	const payload = (from: unknown, fields: Record<string, unknown>) => jsonString({
		...(pushId !== undefined ? { push_id: pushId } : {}),
		message: { message_id: message.message_id, room_id: message.room_id, from, ...tail, ...(Object.keys(fields).length ? { body: fields } : {}) },
	});
	const candidates = [
		...(Array.isArray(body.mentions) ? [payload(message.from, { ...textField, mentions: body.mentions })] : []),
		payload(message.from, textField),
		payload(shortFrom, textField),
	];
	return candidates.find((candidate) => utf8Bytes(candidate) <= MAX_PUSH_PAYLOAD_BYTES) ?? payload(shortFrom, {});
}

// Browsers hide failed WebSocket handshake responses. An explicit, read-only
// HTTP probe on the same URL exposes capacity errors without admitting a socket.
function isConnectionStatus(request: Request): boolean {
	return request.method === "GET" && new URL(request.url).searchParams.get("apron_connection_status") === "1" && !isUpgrade(request);
}

export async function fetchEntry(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
	// Every request the Worker sees is billed, whatever it answers.
	watchForFlood(env, ctx);
	const response = await fetchConnection(request, env);
	if (!isConnectionStatus(request)) return response;
	const headers = new Headers(response.headers);
	headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Access-Control-Expose-Headers", "Retry-After");
	headers.set("Cache-Control", "no-store");
	return new Response(response.body, { status: response.status, headers });
}

/**
 * `PUT /w/<token>`: a `write_url` (§4.6.3). The token's signature is checked
 * before the body is read, the Durable Object claims the upload so a URL
 * writes once, and the bytes must be a PNG, JPEG, GIF, or WebP image within
 * the token's size. The object is stored in R2 with the type its bytes
 * show, then the Durable Object finishes the write; one it no longer wants
 * is deleted again.
 */
async function handleUploadWrite(request: Request, env: Env, token: string): Promise<Response> {
	// Any origin may write: the token is the credential, and no cookie is sent.
	const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "PUT, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };
	const answer = (status: number, message?: string): Response => {
		const response = message === undefined ? new Response(null, { status }) : responseError(status, message);
		const headers = new Headers(response.headers);
		for (const [name, value] of Object.entries(cors)) headers.set(name, value);
		return new Response(response.body, { status: response.status, headers });
	};
	if (request.method === "OPTIONS") return answer(204);
	if (request.method !== "PUT") return answer(405, "Method not allowed");
	let config: RuntimeConfig;
	try {
		config = loadConfig(env);
	} catch {
		return answer(503, "Configuration unavailable");
	}
	const uploads = config.uploads;
	const media = env.MEDIA;
	if (!uploads || !media || !env.DEMO) return answer(404, "Not found");
	const grant = await verifyUploadToken(uploads.signingKey, token);
	if (!grant) return answer(403, "This write_url is not valid or has expired");
	const length = Number(request.headers.get("Content-Length") ?? NaN);
	if (!Number.isSafeInteger(length) || length <= 0) return answer(411, "Content-Length is required");
	if (length > grant.maxBytes) return answer(413, `An upload here is at most ${grant.maxBytes} bytes`);
	const stub = env.DEMO.getByName(OBJECT_NAME);
	try {
		if (!await stub.claimUpload(grant.key)) return answer(409, "This write_url was already used or has expired");
	} catch {
		return answer(503, "Demo capacity reached");
	}
	const fail = async (status: number, message: string): Promise<Response> => {
		await stub.finishUpload({ key: grant.key, ok: false }).catch(() => false);
		return answer(status, message);
	};
	let body: Uint8Array;
	try {
		body = new Uint8Array(await request.arrayBuffer());
	} catch {
		return fail(400, "The upload was interrupted");
	}
	if (body.byteLength !== length || body.byteLength > grant.maxBytes) return fail(400, "The body does not match its Content-Length");
	const image = sniffImage(body);
	if (!image) return fail(415, "Only PNG, JPEG, GIF, and WebP images can be uploaded");
	try {
		await media.put(grant.key, body, {
			httpMetadata: {
				contentType: image.type,
				// Attached images never change; an avatar key is rewritten when refreshed.
				cacheControl: grant.key.startsWith("f/") ? "public, max-age=604800, immutable" : "public, max-age=86400",
			},
		});
	} catch {
		return fail(503, "Storage is unavailable; try again");
	}
	let accepted = false;
	try {
		accepted = await stub.finishUpload({ key: grant.key, ok: true, bytes: body.byteLength, contentType: image.type, ...(image.width && image.height ? { width: image.width, height: image.height } : {}) });
	} catch { /* not accepted */ }
	if (!accepted) {
		await media.delete(grant.key).catch(() => undefined);
		return answer(410, "This upload is no longer wanted: it expired, or its message or embed is gone");
	}
	return answer(204);
}

async function fetchConnection(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname.startsWith("/w/")) return handleUploadWrite(request, env, url.pathname.slice(3));
	const status = isConnectionStatus(request);
	const rootUpgrade = url.pathname === "/" && (isUpgrade(request) || status);
	if (url.pathname !== "/ws" && !rootUpgrade) {
		if (env.ASSETS) return env.ASSETS.fetch(request);
		return responseError(404, "Not found");
	}
	let config: RuntimeConfig;
	try {
		config = loadConfig(env);
	} catch {
		return responseError(503, "Configuration unavailable");
	}
	if (!originAllowed(config, request)) return responseError(403, "Origin not allowed");
	if (request.method !== "GET") return responseError(405, "Method not allowed");
	if (request.body !== null || (request.headers.has("Content-Length") && request.headers.get("Content-Length") !== "0") || request.headers.has("Transfer-Encoding")) {
		return responseError(400, "WebSocket upgrade must not contain a body");
	}
	if (!isUpgrade(request) && !status) return responseError(400, "WebSocket upgrade required");
	const clientIp = extractClientIp(request.headers);
	if (!clientIp) return responseError(403, "Trusted client address unavailable");
	if (config.admissionOff) return responseError(503, "Demo admission is closed");
	const key = await hashIpKey(clientIp);
	// This counts attempts, including connections subsequently rejected by the DO.
	// Fail closed if the binding is absent or unavailable; never bypass admission.
	try {
		if (!env.CONNECTION_ATTEMPTS) return responseError(503, "Demo admission unavailable");
		const { success } = await env.CONNECTION_ATTEMPTS.limit({ key });
		if (!success) return responseError(429, "Connection attempts exceeded", ADMISSION_BUDGET.workerWindowSeconds * 1_000);
	} catch {
		return responseError(503, "Demo admission unavailable");
	}
	if (!env.DEMO) return responseError(503, "Demo capacity unavailable");
	const headers = stripForwardingHeaders(request.headers);
	headers.set(INTERNAL_IP_HEADER, key);
	headers.delete("content-length");
	const forwarded = new Request(request, { headers });
	const stub = env.DEMO.getByName(OBJECT_NAME);
	try { return await stub.fetch(forwarded); }
	catch { return responseError(503, "Demo capacity reached", 60_000); }
}

export default {
	fetch: fetchEntry,
	// The cron trigger in wrangler.production.toml runs the budget guard.
	scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
		ctx.waitUntil(runBudgetGuard(env, controller.scheduledTime));
	},
} satisfies ExportedHandler<Env>;

export class ApronDemoServer extends DurableObject<Env> {
	private readonly config: RuntimeConfig;
	private readonly runtimeEnv: Env;
	private readonly store: Store;
	private readonly webAuthn: WebAuthnService;
	private mutationTail: Promise<void> = Promise.resolve();
	private alarmTail: Promise<void> = Promise.resolve();
	private alarmFailures = 0;
	private alarmKnown = false;
	/** When the next alarm may sweep sessions; in memory, so a wake sweeps once. */
	private nextSessionSweepAt = 0;
	/** Admins' `/toggle`s, once read: a feature absent here has not been read yet. */
	private readonly toggles = new Map<ToggleFeature, boolean | undefined>();
	/** When the earliest pending upload's write window closes, if one is known (§4.6.3). */
	private uploadDeadline: number | undefined;
	private accountUsageEvents = 0;
	private accountUsageRetryAt = 0;
	private accountUsageFailureCount = 0;
	private accountUsageVerified = false;
	private accountUsageRefresh?: Promise<void>;
	private accountUsageSnapshot: AccountUsageSnapshot | null = null;
	private readonly queues = new WeakMap<WebSocketConnection, Promise<void>>();
	/**
	 * Room IDs known to exist (true) or not (false), so relaying activity needs
	 * no storage read. Lost on hibernation and refilled from listings, record
	 * broadcasts, and one lookup per unknown ID; bounded like the rooms table.
	 */
	private readonly knownRooms = new Map<string, boolean>();
	/**
	 * When each frame the server processed in the last minute arrived, oldest
	 * first, for `globalFramesPerMinute`. In memory: a hibernating object has
	 * received nothing, so a reset window loses no spike.
	 */
	private readonly recentFrames: number[] = [];
	private sessionWorkTail: Promise<void> = Promise.resolve();
	/**
	 * Guest numbers reserved durably and not yet handed out: the next one, and
	 * one past the last. Both start at zero, so the first guest after a start
	 * or wake reserves a fresh block rather than reusing one it cannot see.
	 */
	private guestNext = 0;
	private guestLimit = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.runtimeEnv = env;
		this.config = loadConfig(env);
		this.store = new Store(ctx as unknown as ConstructorParameters<typeof Store>[0], asStoreConfig(this.config));
		this.webAuthn = new WebAuthnService(this.config);
		// Answered by the runtime without waking the object or reaching
		// webSocketMessage; the time of the last answer tells a live peer from
		// one that vanished without a close frame (see isStale).
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_REQUEST, PING_RESPONSE));
		if (this.store.requiresReset()) {
			// Stored data from another schema version is wiped, not migrated. The
			// input gate holds every event until the fresh schema exists.
			void ctx.blockConcurrencyWhile(async () => {
				await this.store.resetStorage();
				this.accountUsageSnapshot = this.store.accountUsageSnapshot();
				console.warn(JSON.stringify({ event: "storage_schema_reset" }));
			});
		} else {
			this.store.initialize();
			this.accountUsageSnapshot = this.store.accountUsageSnapshot();
		}
	}

	async fetch(request: Request): Promise<Response> {
		const status = isConnectionStatus(request);
		if (request.method !== "GET" || (!isUpgrade(request) && !status)) return responseError(400, "WebSocket upgrade required");
		const ipKey = trustedIpKey(request);
		if (!ipKey) return responseError(403, "Trusted client address unavailable");
		if (this.config.admissionOff) return responseError(503, "Demo admission is closed");
		this.noteAccountUsageActivity(this.runtimeEnv);
		if (this.accountUsageBlocked(nowMs())) return responseError(503, "Demo account capacity reached", 300_000);
		const origin = request.headers.get("Origin");
		if (!isAllowedOrigin(this.config, origin)) return responseError(403, "Origin not allowed");
		try {
			const sockets = this.ctx.getWebSockets();
			// A vanished peer's socket still takes a slot until the runtime lets go
			// of it, but it must not lock its own IP out of reconnecting.
			const now = nowMs();
			this.closeStale(now);
			const peers = sockets.filter(socket => !this.isStale(socket, now)).map(socket => connectionAttachment(socket)).filter(peer => peer?.ipKey === ipKey);
			if (sockets.length >= this.config.limits.openConnections || peers.length >= this.config.limits.connectionsPerIp ||
				peers.filter(peer => peer?.tier !== "registered").length >= this.config.limits.anonymousConnectionsPerIp) {
				return responseError(429, "Demo capacity reached", 60_000);
			}
			if (status) {
				this.store.checkConnectionBudget(nowMs());
				// This is advisory; the real upgrade still checks all admission gates.
				return Response.json({ available: true });
			}
			this.store.reserveConnection({ ipKey, tier: "pending", now: nowMs() });
		} catch (error) {
			return this.storeResponseError(error);
		}
		const pair = new WebSocketPair();
		const server = pair[1] as WebSocketConnection;
		const endpoint = endpointOf(request);
		const attachment: ConnectionAttachment = {
			v: 1,
			connId: randomId("c"),
			ipKey,
			tier: "pending",
			...(origin ? { origin } : {}),
			...(endpoint ? { endpoint } : {}),
			authDeadline: nowMs() + this.config.limits.unauthenticatedTimeoutSeconds * 1_000,
			pendingFrames: 0,
			pendingBytes: 0,
			policyViolations: [],
			historyInFlight: 0,
			frameTimes: [],
		};
		this.ctx.acceptWebSocket(server);
		writeAttachment(server, attachment);
		this.send(server, this.serverAnnouncement(origin));
		// A welcome with the deployed version, before any auth (§3.2,
		// Appendix B): to this connection only, with no room_id, since the
		// client knows no rooms yet. A deploy closes every socket, so each
		// reconnect after one shows the new version.
		this.send(server, this.welcome(origin));
		await this.rescheduleAlarm();
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const socket = ws as WebSocketConnection;
		const attachment = connectionAttachment(socket);
		if (!attachment || attachment.closing) return Promise.resolve();
		this.noteAccountUsageActivity(this.runtimeEnv);
		if (this.accountUsageBlocked(nowMs())) {
			this.closePolicy(socket, attachment, 1013, "Demo account capacity reached; try later");
			return Promise.resolve();
		}
		if (typeof message !== "string") {
			this.closePolicy(socket, attachment, 1003, "Binary application frames are not supported");
			return Promise.resolve();
		}
		if (message.length > this.config.limits.maxFrameBytes || utf8Bytes(message) > this.config.limits.maxFrameBytes) {
			this.closePolicy(socket, attachment, 1009, "Frame exceeds the maximum size");
			return Promise.resolve();
		}
		const now = nowMs();
		attachment.frameTimes = attachment.frameTimes.filter(time => time > now - 60_000);
		if (attachment.frameTimes.length >= this.config.limits.framesPerConnectionMinute) {
			this.closePolicy(socket, attachment, 1008, "Frame rate limit reached");
			return Promise.resolve();
		}
		attachment.frameTimes.push(now);
		const bytes = utf8Bytes(message);
		if (attachment.pendingFrames >= this.config.limits.pendingFramesPerConnection || attachment.pendingBytes + bytes > this.config.limits.pendingBytesPerConnection) {
			this.closePolicy(socket, attachment, 1008, "Too many pending frames");
			return Promise.resolve();
		}
		attachment.pendingFrames += 1;
		attachment.pendingBytes += bytes;
		writeAttachment(socket, attachment);
		const prior = this.queues.get(socket) ?? Promise.resolve();
		const next = prior.catch(() => undefined).then(() => this.processFrame(socket, message)).catch((error) => this.handleFrameFailure(socket, error)).finally(() => {
			const latest = connectionAttachment(socket);
			if (latest) {
				latest.pendingFrames = Math.max(0, latest.pendingFrames - 1);
				latest.pendingBytes = Math.max(0, latest.pendingBytes - bytes);
				writeAttachment(socket, latest);
			}
		});
		this.queues.set(socket, next);
		return next;
	}

	async webSocketClose(ws: WebSocket, code = 1000): Promise<void> {
		const socket = ws as WebSocketConnection;
		const attachment = connectionAttachment(socket);
		if (!attachment) return;
		attachment.closing = true;
		writeAttachment(socket, attachment);
		try { socket.close(code === 1005 || code === 1006 ? 1000 : code); } catch { /* already closed */ }
		await this.rescheduleAlarm();
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		const socket = ws as WebSocketConnection;
		const attachment = connectionAttachment(socket);
		if (!attachment) return;
		attachment.closing = true;
		writeAttachment(socket, attachment);
		try { socket.close(1011, "Connection failed"); } catch { /* already closed */ }
		await this.rescheduleAlarm();
	}

	async alarm(): Promise<void> {
		this.alarmKnown = false;
		const now = nowMs();
		await this.refreshAccountUsage(this.runtimeEnv, now, false);
		for (const ws of this.ctx.getWebSockets()) {
			const socket = ws as WebSocketConnection;
			const attachment = connectionAttachment(socket);
			if (!attachment) continue;
			if (attachment.tier === "pending" && attachment.authDeadline <= now) {
				this.closePolicy(socket, attachment, 1008, "Authentication timed out");
				continue;
			}
			if (attachment.challenge && attachment.challenge.expiresAt <= now) {
				delete attachment.challenge;
				writeAttachment(socket, attachment);
			}
		}
		if (now >= this.nextSessionSweepAt) {
			try {
				// A full batch may have left more behind; sweep again on the next alarm.
				const full = await this.sweepSessions(now);
				this.nextSessionSweepAt = full ? 0 : now + SESSION_SWEEP_INTERVAL_MS;
			} catch { /* retried on the next alarm */ }
		}
		let result: ReturnType<Store["runCleanup"]> | undefined;
		try {
			result = this.store.runCleanup(now);
		} catch {
			// A metered maintenance failure is deferred. Do not spin an alarm loop.
			// The floor may already be durable even if a physical deletion failed,
			// so send every room's current record below.
		}
		// Committed removals need no store access; tell their members before any
		// listing that could fail on an exhausted budget.
		if (this.config.uploads) {
			try {
				await this.runMutation(async () => {
					const expired = this.store.expirePendingUploads(now);
					for (const record of expired.broadcasts) this.broadcastRecord(record);
					this.deleteMedia(expired.deletedUploads);
					this.uploadDeadline = expired.next;
				});
				// A full batch may have left more behind: sweep again shortly rather
				// than a cleanup interval later, so released bytes do not pile up.
				if (this.store.cleanupUploads(now) >= UPLOAD_SWEEP_BATCH) {
					const next = now + 1_000;
					this.uploadDeadline = this.uploadDeadline === undefined ? next : Math.min(this.uploadDeadline, next);
				}
			} catch { /* a metered maintenance failure is retried on the next alarm */ }
		}
		const removed = result?.removed_rooms ?? [];
		for (const roomId of removed) this.noteRoom(roomId, false);
		if (removed.length) this.removeRooms(removed);
		if (!result || result.history_floor !== result.previous_floor) {
			try {
				// Only rooms whose history_log_id moved need a new record.
				const rooms = this.store.listRooms(nowMs(), {
					maintenance: true,
					...(result ? { changedSinceFloor: Number(result.previous_floor) } : {}),
				});
				this.announceUpdated(rooms);
			} catch { /* announcement also requires capacity; clients see the floor on their next history page */ }
		}
		await this.rescheduleAlarm();
	}

	private storeResponseError(error: unknown): Response {
		const protocol = errorToProtocol(error);
		const status = protocol.name === "retry_after" ? 429 : protocol.name === "denied" ? 403 : 503;
		const retry = protocol.data?.retry_after;
		const message = protocol.data?.reason === "daily_budget" ? "Daily demo capacity reached" : protocol.message;
		return responseError(status, message, typeof retry === "number" ? retry * 1_000 : undefined);
	}

	private serverAnnouncement(origin: string | null): Record<string, unknown> {
		const limits = this.config.limits;
		return {
			method: "server",
			params: {
				// The protocol version, the implementation string, and the
				// capabilities (§3.1).
				apron: 7,
				agent: "apron-cloudflare-demo/7",
				capabilities: [
					"history", "edit", "rooms", "reactions", "command",
					...(this.activityOn() ? ["activity"] : []),
					...(this.uploadsOn() ? ["embed:upload"] : []),
					// Idle connections and mutes, which decide pushes (§4.7, §4.11).
					...(this.config.push ? ["status"] : []),
				],
				// Passkeys and their session tokens only where passkeys are offered;
				// bot tokens (`/invite-bot`) from anywhere, since bots are not browsers.
				// No `email`: the demo has no way to send mail.
				auth: this.passkeysOffered(origin) ? ["webauthn", "token", "guest"] : ["token", "guest"],
				// Schemes that create an account (§3.2): a passkey registration, and
				// a token only as an admin's sign-up invite (`/invite`); other tokens
				// sign in to existing users. A guest is a throwaway identity for one
				// connection, not an account, so `guest` is listed only in `auth`.
				signup: this.passkeysOffered(origin) ? ["webauthn", "token"] : ["token"],
				// For the sign-in screen (§3.2); the `~private` welcome below goes in a room.
				welcome: this.signInWelcome(origin),
				// Answered by the runtime without waking the object (see PING_REQUEST).
				ping: limits.pingSeconds,
				// Web Push (§4.7), with the VAPID key browsers subscribe with and the wake scopes.
				...(this.config.push ? { push: { webpush: { key: this.config.push.publicKey }, wake: Object.keys(WAKE_SCOPES) } } : {}),
				ext: {
					demo: {
						retention_seconds: limits.retentionSeconds,
						cleanup_seconds: limits.cleanupSeconds,
						max_frame_bytes: limits.maxFrameBytes,
						max_message_text_bytes: limits.maxTextBytes,
						max_snapshot_bytes: limits.maxSnapshotBytes,
						guest_posts_per_minute: limits.anonymousPostsPerMinute,
						registered_posts_per_minute: limits.registeredPostsPerMinute,
						// `false`: guests only read; posting, reacting, and room changes need a sign-in.
						guest_posting: this.config.guestPosting,
						server_frames_per_minute: limits.globalFramesPerMinute,
						room_list_per_minute: limits.roomListRequestsPerUserMinute,
						// Registered members listed per room in `members`; connected ones are always listed.
						room_list_members: limits.roomListMembers,
						// `read_message_id` in `activity` is dropped: no read cursors are kept.
						read_cursors: false,
						// With `activity`, typing is relayed; read cursors are neither kept nor relayed.
						...(this.activityOn() ? { activity_per_minute: limits.activityBroadcastsPerUserMinute } : {}),
					},
				},
			},
		};
	}

	/** Whether this origin is offered passkeys (§4.9) and their session tokens. */
	private passkeysOffered(origin: string | null): boolean {
		return origin !== null && this.config.rpOrigins.includes(origin);
	}

	/**
	 * `server.welcome` (§3.2): how this demo's sign-in schemes fit together,
	 * for the sign-in screen, worded for what this origin can sign in with.
	 */
	private signInWelcome(origin: string | null): string {
		const days = Math.max(1, Math.round(this.config.limits.retentionSeconds / 86_400));
		const history = `Messages are kept for ${days === 1 ? "a day" : `${days} days`}.`;
		const guests = this.config.guestPosting ? "Guests can post under a new name each visit." : "Guests can read along.";
		const signIn = this.passkeysOffered(origin)
			? "**Create a passkey** to post, react, and start threads; it signs you in on your next visit too."
			: "Passkeys work on the demo's own site; here, sign in with a bot token from `/invite-bot` there, or an invite token from an admin.";
		const invites = "An admin's invite token also creates an account; add a passkey once you're in, so you can sign in again without it.";
		return `**Apron public demo.** ${guests} ${signIn} ${invites} Bots sign in with a token their owner gets from \`/invite-bot\`. ${history}`;
	}

	/** The `~private` welcome, after the `server` frame; where guests only read, it says so (Appendix B). */
	private welcome(origin: string | null): Record<string, unknown> {
		const lines = [`Welcome to Apron Chat. Server version: \`${this.serverVersion()}\``];
		if (!this.config.guestPosting) {
			lines.push(this.passkeysOffered(origin)
				? "Guests can read. *Sign in with passkey* to participate."
				: "Guests can read. *Sign in with passkey* on the demo's own site, or use a bot token from `/invite-bot` there, to participate.");
		}
		return { method: "message", params: { from: { ...PRIVATE_IDENTITY }, body: { text: lines.join("\n\n"), format: "markdown" } } };
	}

	/** The deploy's tag (`wrangler deploy --tag`), else the start of its version ID. */
	private serverVersion(): string {
		const version = this.runtimeEnv.CF_VERSION_METADATA;
		return version?.tag || version?.id?.slice(0, 8) || "unknown";
	}

	private send(socket: WebSocketConnection, value: unknown): boolean {
		if (!openSocket(socket) || connectionAttachment(socket)?.closing) return false;
		try {
			socket.send(jsonString(value));
			return true;
		} catch {
			const attachment = connectionAttachment(socket);
			if (attachment) this.closePolicy(socket, attachment, 1011, "Delivery failed; reconnect to recover");
			return false;
		}
	}

	private reply(socket: WebSocketConnection, request: RequestFrame, result: unknown): void {
		if (request.id !== undefined) this.send(socket, protocolReply(request.id, result, request.full));
	}

	private fail(socket: WebSocketConnection, request: RequestFrame | null, error: ProtocolError): void {
		if (request && request.id === undefined) return;
		this.send(socket, protocolError(request?.id, error, request?.full ?? false));
	}

	private closePolicy(socket: WebSocketConnection, attachment: ConnectionAttachment, code: number, reason: string): void {
		attachment.policyViolations = [...attachment.policyViolations.filter((at) => at > nowMs() - 60_000), nowMs()];
		attachment.closing = true;
		writeAttachment(socket, attachment);
		try { socket.close(code, reason.slice(0, 120)); } catch { /* already closed */ }
	}

	private handleFrameFailure(socket: WebSocketConnection, error: unknown): void {
		if (error instanceof FrameError && error.closeCode !== undefined) {
			const attachment = connectionAttachment(socket);
			if (attachment) this.closePolicy(socket, attachment, error.closeCode, error.protocol.message);
			return;
		}
		const attachment = connectionAttachment(socket);
		if (attachment) this.fail(socket, null, errorToProtocol(error));
	}

	private async processFrame(socket: WebSocketConnection, raw: string | ArrayBuffer): Promise<void> {
		const attachment = connectionAttachment(socket);
		if (!attachment || attachment.closing) return;
		// Parsing is bounded CPU work with no storage; it comes first so an
		// activity notification can draw on its block lease. Every frame,
		// malformed ones included, is still charged before any other work.
		let parsed: ReturnType<typeof parseFrame> | undefined;
		let parseFailure: unknown;
		try {
			parsed = parseFrame(raw, {
				maxFrameBytes: this.config.limits.maxFrameBytes,
				maxJsonDepth: this.config.limits.maxJsonDepth,
				maxJsonNodes: this.config.limits.maxJsonNodes,
				maxRequestIdBytes: this.config.limits.maxRequestIdBytes,
			});
		} catch (error) {
			parseFailure = error;
		}
		// A server-wide spike limit, checked before any SQL. Over it, a request
		// gets retry_after and a notification is dropped; the socket stays open.
		const busy = this.takeServerFrame(nowMs());
		if (busy !== undefined) {
			if (parsed && parsed.request.id !== undefined) {
				this.fail(socket, parsed.request, { name: "retry_after", message: "Demo is busy; try again shortly", data: { retry_after: busy } });
			}
			return;
		}
		if (!this.chargeFrame(socket, attachment)) return;
		// The charge updated the attachment; handlers must not write back the copy read before it.
		const current = connectionAttachment(socket) ?? attachment;
		if (!parsed) {
			const error = parseFailure;
			if (error instanceof FrameError) {
				const request = error.id === null ? null : { method: "", params: {}, id: error.id, full: error.full };
				if (!error.notification) this.fail(socket, request, error.protocol);
				this.recordViolation(socket, error.protocol);
				if (error.closeCode !== undefined) {
					const latest = connectionAttachment(socket);
					if (latest) this.closePolicy(socket, latest, error.closeCode, error.protocol.message);
				}
				return;
			}
			throw error;
		}
		const request = parsed.request;
		try {
			await this.dispatch(socket, current, request);
		} catch (error) {
			const failure = errorToProtocol(error);
			this.fail(socket, request, failure);
			this.recordViolation(socket, failure);
		}
		if (!this.alarmKnown) await this.rescheduleAlarm();
	}

	/** Counts one frame against the server-wide minute; the seconds to wait when it is full. */
	private takeServerFrame(now: number): number | undefined {
		const frames = this.recentFrames;
		while (frames.length > 0 && frames[0] <= now - 60_000) frames.shift();
		if (frames.length >= this.config.limits.globalFramesPerMinute) return Math.max(1, Math.ceil((frames[0] + 60_000 - now) / 1_000));
		frames.push(now);
		return undefined;
	}

	/**
	 * Charges one incoming frame to the IP and daily frame budgets. A
	 * connection reserves `frameLease` frames at once and spends them from its
	 * attachment, so each frame carries a fraction of the reservation's SQL
	 * bookkeeping (SPEC section 7, durable block reservation). A block is never
	 * granted twice: it lives only in this connection's attachment, and an
	 * unspent one is burned when the connection closes or the UTC day ends.
	 */
	private chargeFrame(socket: WebSocketConnection, attachment: ConnectionAttachment): boolean {
		const now = nowMs();
		try {
			const latest = connectionAttachment(socket) ?? attachment;
			const day = new Date(now).toISOString().slice(0, 10);
			const lease = latest.frameLease?.day === day ? latest.frameLease.remaining : 0;
			if (lease > 0) {
				latest.frameLease = { day, remaining: lease - 1 };
			} else {
				const count = this.config.limits.frameLease;
				this.store.reserveFrames({ ipKey: attachment.ipKey, now, count });
				latest.frameLease = { day, remaining: count - 1 };
			}
			if (latest.frameLease.remaining === 0) delete latest.frameLease;
			writeAttachment(socket, latest);
			return true;
		} catch (error) {
			const failure = errorToProtocol(error);
			if (failure.message.includes("Daily frame budget")) {
				for (const peer of this.ctx.getWebSockets()) {
					const state = connectionAttachment(peer);
					if (state) this.closePolicy(peer, state, 1013, "Demo capacity reached; try after daily reset");
				}
			} else this.closePolicy(socket, connectionAttachment(socket) ?? attachment, 1013, failure.message);
			return false;
		}
	}

	private async dispatch(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		switch (request.method) {
			case "auth":
				await this.handleAuth(socket, attachment, request);
				return;
			case "history":
				await this.handleHistory(socket, attachment, request);
				return;
			case "message":
				await this.handleMessage(socket, attachment, request);
				return;
			case "room_set":
				await this.handleRoomSet(socket, attachment, request);
				return;
			case "room_join":
				await this.handleRoomJoin(socket, attachment, request);
				return;
			case "room_leave":
				await this.handleRoomLeave(socket, attachment, request);
				return;
			case "reactions":
				await this.handleReactions(socket, attachment, request);
				return;
			case "me":
				await this.handleMe(socket, attachment, request);
				return;
			case "activity":
				// Off unless the plan or `ACTIVITY` enables it: typing then gets the unsupported-method path.
				if (!this.activityOn()) break;
				await this.handleActivity(socket, request);
				return;
			case "status":
				// A notification only, on a push server (§4.11); a request, like a
				// `ping` request, gets the unsupported-method path.
				if (!this.config.push || request.id !== undefined) break;
				this.handleStatus(socket, attachment, request);
				return;
			case "push_register":
				if (!this.config.push) break;
				await this.handlePushRegister(socket, attachment, request);
				return;
			case "push_unregister":
				if (!this.config.push) break;
				this.handlePushUnregister(socket, attachment, request);
				return;
			case "room_list":
				await this.handleRoomList(socket, attachment, request);
				return;
			case "command":
				await this.handleCommand(socket, attachment, request);
				return;
			case "ping":
				// The exact ping bytes are answered by the runtime; a ping with other
				// spacing reaches here and is answered too, before auth as well (§1).
				if (request.id !== undefined) break;
				this.send(socket, JSON.parse(PING_RESPONSE));
				return;
		}
		if (request.id === undefined) return;
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate first" } satisfies ProtocolError;
		throw { name: "unsupported", message: "Unsupported method" } satisfies ProtocolError;
	}

	/**
	 * The next guest number. Numbers come from the in-memory block; an empty
	 * block (always so after a start or wake) first reserves the next
	 * `guestNumberBlock` numbers with one durable write. There is no await
	 * between reading and advancing `guestNext`, and the Store call is
	 * synchronous, so concurrent auths on other connections cannot both take
	 * a number or both reserve a block. A failed reservation (an exhausted
	 * budget) leaves the block empty and fails the auth.
	 */
	private nextGuestNumber(): number {
		if (this.guestNext >= this.guestLimit) {
			const block = this.store.reserveGuestNumbers(this.config.limits.guestNumberBlock, nowMs());
			this.guestNext = block.first;
			this.guestLimit = block.limit;
		}
		return this.guestNext++;
	}

	private async handleAuth(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		// Authentication ceremonies are request/response exchanges. Ignore auth
		// notifications before reserving any attempt or changing attachment state.
		if (request.id === undefined && request.params.scheme === "webauthn") return;
		// A guest auth on an authenticated connection changes nothing: answer it
		// without charging an attempt.
		if (request.params.scheme === "guest" && (attachment.tier === "anonymous" || attachment.tier === "registered")) {
			this.reply(socket, request, { you: this.you(attachment) });
			return;
		}
		this.store.reserveAuthAttempt({ ipKey: attachment.ipKey, now: nowMs() });
		const params = request.params;
		const scheme = requiredString(params, "scheme");
		if (scheme === "guest") {
			// A requested `name` or `user_id` is not honored: guests are
			// `guest_<n>` from a server-wide counter, never reissued, with a
			// generated name they keep (§3.2 lets the server assign identity).
			const number = this.nextGuestNumber();
			attachment.tier = "anonymous";
			attachment.userId = `guest_${number}`;
			attachment.name = `Guest ${number}`.slice(0, Math.min(this.config.limits.maxNameCodePoints, this.config.limits.maxNameBytes));
			// A new guest has joined the default room (§3.4).
			attachment.rooms = [...DEFAULT_JOINED_ROOMS];
			delete attachment.listedJoined;
			writeAttachment(socket, attachment);
			this.reply(socket, request, { you: this.current(attachment) });
			await this.rescheduleAlarm();
			return;
		}
		if (scheme === "token") {
			const token = requiredString(params, "token");
			if (this.config.adminToken !== undefined && await sameToken(token, this.config.adminToken)) await this.handleAdminToken(socket, attachment, request);
			else if (token.startsWith(BOT_TOKEN_PREFIX)) await this.handleBotToken(socket, attachment, request, token);
			else if (token.startsWith(INVITE_TOKEN_PREFIX)) await this.handleInviteToken(socket, attachment, request, token);
			else if (token.startsWith(JOIN_TOKEN_PREFIX)) await this.handleJoinToken(socket, attachment, request, token);
			else await this.handleTokenResume(socket, attachment, request);
			return;
		}
		if (scheme !== "webauthn") throw { name: "unsupported", message: "Unsupported authentication scheme" } satisfies ProtocolError;
		const action = requiredString(params, "action");
		if (action !== "register" && action !== "login") throw { name: "invalid_params", message: "Unknown passkey action" } satisfies ProtocolError;
		// A registration on a connection already signed in adds the passkey to
		// that account (§4.9); signing in as someone else takes a reconnect, and
		// a bot signs in with its token only.
		const adding = attachment.tier === "registered";
		if (adding && action !== "register") throw { name: "denied", message: "Identity switching requires reconnect" } satisfies ProtocolError;
		if (adding && hasRole(attachment, "bot")) throw { name: "denied", message: "A bot signs in with its token and takes no passkey" } satisfies ProtocolError;
		// A passkey would outlive the token: deleting APRON_ADMIN_TOKEN must turn `admin` off.
		if (adding && attachment.userId === ADMIN_USER_ID) {
			throw { name: "denied", message: "The admin user signs in with APRON_ADMIN_TOKEN only; make your own account an admin with /admin" } satisfies ProtocolError;
		}
		const step = requiredString(params, "step");
		const origin = this.requestOrigin(socket);
		if (!origin || !this.config.rpOrigins.includes(origin)) throw { name: "denied", message: "Frontend origin is not configured for passkeys" } satisfies ProtocolError;
		if (step === "begin") {
			const identity = action === "register" ? identityOf(attachment) : undefined;
			const name = action === "register" && !adding ? this.requestedName(params) : undefined;
			// Adding: the account's passkeys are excluded, and its user handle reused.
			const stored = adding ? this.store.getIdentity(attachment.userId!) : null;
			if (adding && !stored) throw { name: "denied", message: "Only a registered user can add a passkey" } satisfies ProtocolError;
			const existing = adding ? this.store.credentialIdsForUser(attachment.userId!) : [];
			if (existing.length >= MAX_PASSKEYS_PER_USER) throw { name: "denied", message: `An account holds at most ${MAX_PASSKEYS_PER_USER} passkeys` } satisfies ProtocolError;
			// An account without a handle yet (an invited user) gets one now, so
			// concurrent ceremonies for it share it.
			const shared = !stored ? null : stored.userHandle || this.store.ensureUserHandle(stored.userId, bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))), nowMs());
			const handle = shared && /^[A-Za-z0-9_-]{16,64}$/.test(shared) && shared.length % 4 !== 1 ? shared : undefined;
			const begun = await this.webAuthn.begin(action, origin, nowMs(), identity ?? undefined, existing, attachment.connId, {
				...(name !== undefined ? { name } : {}),
				userIdTaken: (userId) => this.store.userIdTaken(userId),
				...(adding ? { adds: handle ? { userHandle: handle } : {} } : {}),
			});
			if (connectionAttachment(socket)?.closing || !openSocket(socket)) return;
			attachment.challenge = begun.challenge;
			writeSessionAttachment(socket, attachment);
			this.reply(socket, request, { challenge_id: begun.challenge.challengeId, public_key: begun.publicKey });
			await this.rescheduleAlarm();
			return;
		}
		if (step !== "finish") throw { name: "invalid_params", message: "Passkey step must be begin or finish" } satisfies ProtocolError;
		const challengeId = requiredString(params, "challenge_id");
		const challenge = attachment.challenge;
		// A matching finish consumes the pending ceremony before any proof work,
		// including malformed proof data or failed verification. A finish naming a
		// different challenge is denied without destroying the usable ceremony.
		const matchingChallenge = challenge?.challengeId === challengeId;
		if (matchingChallenge) {
			delete attachment.challenge;
			writeAttachment(socket, attachment);
		}
		if (!challenge || !matchingChallenge || challenge.action !== action) throw { name: "denied", message: "Passkey challenge is missing or expired" } satisfies ProtocolError;
		const credential = passkeyCredentialParam(params, action);
		// A signed-in user's avatar, for the connection's current object (§4.6.6).
		let avatar: string | undefined;
		let roles: string[] = [];
		const repository: CredentialRepository = {
			getCredential: (credentialId) => this.store.getCredential(credentialId),
			getIdentity: (userId) => {
				const identity = this.store.getIdentity(userId);
				avatar = identity?.avatar;
				roles = identity?.roles ?? [];
				return identity ? { user_id: identity.userId, name: identity.name, tier: "registered" } : null;
			},
			registerCredential: (input) => {
				if (input.adds) {
					const added = this.store.addCredential({ userId: input.userId, userHandle: input.userHandle, credential: input.credential, now: input.now, ipKey: input.ipKey });
					return { user_id: added.userId, name: added.name };
				}
				// A guest registering on its connection keeps the rooms it had joined.
				const identity = this.store.registerIdentity({ ...input, ...(attachment.tier === "anonymous" && attachment.rooms ? { rooms: attachment.rooms } : {}) });
				// Each starting room's logged join goes to the room's members, this
				// connection among them, before anything else can commit (§4.3.2).
				for (const record of identity.broadcasts) this.broadcastRecord(record);
				return { user_id: identity.userId, name: identity.name, tier: "registered" };
			},
			updateCredentialCounter: (credentialId, counter) => this.store.updateCredentialCounter(credentialId, counter),
		};
		const finished = await this.webAuthn.finish(challenge, challengeId, credential, repository, {
			now: nowMs(),
			ipKey: attachment.ipKey,
			identity: identityOf(attachment) ?? undefined,
			connectionId: attachment.connId,
		});
		const latest = connectionAttachment(socket);
		if (!latest || latest.closing || !openSocket(socket)) return;
		if (challenge.adds) {
			// The connection stays signed in as it was, now with one more passkey.
			// The account's other connections are told, so an unexpected passkey
			// can be spotted and removed with /passkeys.
			for (const peer of this.connectionsOf(finished.identity.user_id, socket)) {
				this.deliverTo(peer, { method: "message", params: { from: { ...PRIVATE_IDENTITY }, body: {
					text: "A passkey was added to your account from another connection. If it wasn't you, remove it with `/passkeys`.", format: "markdown",
				} } });
			}
			this.reply(socket, request, { you: this.you(latest) });
			await this.rescheduleAlarm();
			return;
		}
		this.assertRegisteredCapacity(socket, finished.identity.user_id);
		const token = await this.issueSession(finished.identity.user_id, origin, nowMs());
		if (connectionAttachment(socket)?.closing || !openSocket(socket)) return;
		const guest = attachment.tier === "anonymous" ? publicIdentity(attachment) : null;
		const guestRooms = attachment.rooms ?? [];
		attachment.tier = "registered";
		attachment.userId = finished.identity.user_id;
		attachment.name = finished.identity.name;
		setAvatar(attachment, avatar);
		attachment.roles = roles;
		attachment.rooms = this.registeredRooms(socket, finished.identity.user_id);
		delete attachment.listedJoined;
		writeSessionAttachment(socket, attachment);
		this.applyPendingMute(socket);
		this.reply(socket, request, { you: this.you(attachment), token });
		if (guest) this.announceUser(socket, this.current(attachment), [...guestRooms, ...attachment.rooms], guest);
		this.refreshAvatar(finished.identity.user_id);
		await this.rescheduleAlarm();
	}

	/**
	 * The display name a passkey registration asks for, if any: trimmed, and
	 * within the name limits. It also seeds the new `user_id` (`foo_1234`).
	 */
	private requestedName(params: Record<string, unknown>): string | undefined {
		const name = optionalString(params, "name")?.trim();
		if (!name) return undefined;
		const { maxNameCodePoints, maxNameBytes } = this.config.limits;
		if ([...name].length > maxNameCodePoints || utf8Bytes(name) > maxNameBytes) {
			throw { name: "too_large", message: "name is too long" } satisfies ProtocolError;
		}
		return name;
	}

	/**
	 * A registered user's joined rooms for a connection it is authenticating:
	 * those of its other live connections, which are kept current, or else the
	 * ones stored with the identity.
	 */
	private registeredRooms(socket: WebSocketConnection, userId: string): string[] {
		return this.liveRoomsOf(userId, socket) ?? this.store.getIdentity(userId)?.rooms ?? [...DEFAULT_JOINED_ROOMS];
	}

	private assertRegisteredCapacity(socket: WebSocketConnection, userId: string): void {
		// A dropped socket lingers here until its close is processed; counting it
		// would refuse the reconnect that replaces it.
		const activeForUser = this.ctx.getWebSockets().filter(peer => {
			if (peer === socket || !openSocket(peer)) return false;
			const state = connectionAttachment(peer);
			return !!state && !state.closing && state.userId === userId;
		}).length;
		if (activeForUser >= this.config.limits.registeredConnectionsPerUser) throw { name: "retry_after", message: "Demo capacity reached", data: { retry_after: 60 } } satisfies ProtocolError;
	}

	/**
	 * Resumes a passkey session through the protocol's `token` scheme. The
	 * session must come from a ceremony on this same allowed origin and be
	 * unexpired. A resume once less than half its lifetime remains renews it for
	 * a full lifetime; earlier resumes leave it as is, since renewal is three KV
	 * writes charged at their bound on every reload, tab and reconnect. The
	 * token is not rotated, so several tabs may share one persisted token.
	 */
	private async handleTokenResume(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		return this.withSessionLock(() => this.handleTokenResumeLocked(socket, attachment, request));
	}

	private async handleTokenResumeLocked(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (attachment.tier === "registered") throw { name: "denied", message: "Identity switching requires reconnect" } satisfies ProtocolError;
		const origin = this.requestOrigin(socket);
		if (!origin || !this.config.rpOrigins.includes(origin)) throw { name: "denied", message: "Frontend origin is not configured for passkeys" } satisfies ProtocolError;
		const token = requiredString(request.params, "token");
		if (token.length > MAX_SESSION_TOKEN_CHARS) throw { name: "invalid_params", message: "token is too long" } satisfies ProtocolError;
		const key = await sessionKey(token);
		const session = await this.store.withMeterAsync("foreground", { reads: 1 }, () => this.ctx.storage.get<StoredSession>(key));
		const now = nowMs();
		const expired = { name: "denied", message: "Session expired; sign in with your passkey" } satisfies ProtocolError;
		if (!session || session.v !== 1 || session.origin !== origin || session.expiresMs <= now) {
			if (session && session.expiresMs <= now) {
				await this.store.withMeterAsync("foreground", { writes: 1 }, () => this.ctx.storage.delete(key));
			}
			throw expired;
		}
		const identity = this.store.getIdentity(session.userId);
		if (!identity) {
			await this.store.withMeterAsync("foreground", { writes: 1 }, () => this.ctx.storage.delete(key));
			throw expired;
		}
		if (connectionAttachment(socket)?.closing || !openSocket(socket)) return;
		this.assertRegisteredCapacity(socket, identity.userId);
		const lifetimeMs = this.config.limits.sessionTtlSeconds * 1_000;
		const renewed = { ...session, expiresMs: now + lifetimeMs };
		if (session.expiresMs - now < lifetimeMs / 2) {
			await this.store.withMeterAsync("foreground", { writes: 3 }, async () => {
				// The index is advisory. Writing it first means a crash cannot leave a
				// live session without an expiry entry; a stale entry is harmless.
				await this.ctx.storage.put<SessionExpiryEntry>(sessionExpiryKey(renewed.expiresMs, key), {
					v: 1, sessionKey: key, expiresMs: renewed.expiresMs,
				});
				await this.ctx.storage.put<StoredSession>(key, renewed);
				const oldIndex = sessionExpiryKey(session.expiresMs, key);
				const newIndex = sessionExpiryKey(renewed.expiresMs, key);
				if (oldIndex !== newIndex) await this.ctx.storage.delete(oldIndex);
			});
		}
		if (connectionAttachment(socket)?.closing || !openSocket(socket)) return;
		const guest = attachment.tier === "anonymous" ? publicIdentity(attachment) : null;
		const guestRooms = attachment.rooms ?? [];
		attachment.tier = "registered";
		attachment.userId = identity.userId;
		attachment.name = identity.name;
		setAvatar(attachment, identity.avatar);
		attachment.roles = identity.roles;
		attachment.rooms = this.liveRoomsOf(identity.userId, socket) ?? identity.rooms;
		delete attachment.listedJoined;
		writeSessionAttachment(socket, attachment);
		this.applyPendingMute(socket);
		this.reply(socket, request, { you: this.you(attachment), token });
		if (guest) this.announceUser(socket, this.current(attachment), [...guestRooms, ...attachment.rooms], guest);
		this.refreshAvatar(identity.userId);
		await this.rescheduleAlarm();
	}

	/**
	 * Signs a bot in with the token its owner got from `/invite-bot`, through
	 * the `token` scheme (§3.2). Bots are not browsers, so unlike a passkey
	 * session the token is taken from any origin, or none.
	 */
	private async handleBotToken(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, token: string): Promise<void> {
		return this.withSessionLock(async () => {
			if (attachment.tier === "registered") throw { name: "denied", message: "Identity switching requires reconnect" } satisfies ProtocolError;
			if (token.length > MAX_SESSION_TOKEN_CHARS) throw { name: "invalid_params", message: "token is too long" } satisfies ProtocolError;
			const key = BOT_TOKEN_KEY_PREFIX + await sha256Hex(token);
			const stored = await this.store.withMeterAsync("foreground", { reads: 1 }, () => this.ctx.storage.get<StoredBotToken>(key));
			const invalid = { name: "denied", message: "Bot token is not valid; its owner can get a new one with /invite-bot" } satisfies ProtocolError;
			if (!stored || stored.v !== 1 || !isBotId(stored.botId)) throw invalid;
			const identity = this.store.getIdentity(stored.botId);
			if (!identity) throw invalid;
			await this.signInKeyless(socket, attachment, request, identity);
		});
	}

	/**
	 * Signs a user in with the token an admin made for them (`/invite-token`),
	 * through the `token` scheme (§3.2), from any origin like a bot token.
	 */
	private async handleInviteToken(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, token: string): Promise<void> {
		return this.withSessionLock(async () => {
			if (attachment.tier === "registered") throw { name: "denied", message: "Identity switching requires reconnect" } satisfies ProtocolError;
			if (token.length > MAX_SESSION_TOKEN_CHARS) throw { name: "invalid_params", message: "token is too long" } satisfies ProtocolError;
			const key = INVITE_TOKEN_KEY_PREFIX + await sha256Hex(token);
			const stored = await this.store.withMeterAsync("foreground", { reads: 1 }, () => this.ctx.storage.get<StoredInviteToken>(key));
			const invalid = { name: "denied", message: "This invite token is not valid; ask an admin for a new one" } satisfies ProtocolError;
			if (!stored || stored.v !== 1 || typeof stored.userId !== "string") throw invalid;
			const identity = this.store.getIdentity(stored.userId);
			if (!identity) throw invalid;
			await this.signInKeyless(socket, attachment, request, identity);
		});
	}

	/**
	 * Signs in as the admin user with `APRON_ADMIN_TOKEN`, without a passkey. Like a
	 * bot token it is taken from any origin; the user is a registered one,
	 * created on first use, that can post, run `/invite-bot`, and run the admin
	 * commands.
	 */
	private async handleAdminToken(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		return this.withSessionLock(async () => {
			if (attachment.tier === "registered") throw { name: "denied", message: "Identity switching requires reconnect" } satisfies ProtocolError;
			const created = this.store.ensureAdminUser({ userId: ADMIN_USER_ID, name: ADMIN_USER_NAME, now: nowMs(), ipKey: attachment.ipKey });
			for (const record of created.broadcasts) this.broadcastRecord(record);
			const identity = this.store.getIdentity(ADMIN_USER_ID);
			if (!identity) throw { name: "internal_error", message: "Admin user is missing" } satisfies ProtocolError;
			await this.signInKeyless(socket, attachment, request, identity);
		});
	}

	/**
	 * Finishes a bearer-token sign-in that has no passkey session behind it
	 * (a bot or the admin user): the connection becomes the identity, and those
	 * who shared a room with the guest it replaces hear of it.
	 */
	private async signInKeyless(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, identity: { userId: string; name: string; rooms: string[]; avatar?: string; roles: string[] }, token?: string): Promise<void> {
		if (connectionAttachment(socket)?.closing || !openSocket(socket)) return;
		this.assertRegisteredCapacity(socket, identity.userId);
		const guest = attachment.tier === "anonymous" ? publicIdentity(attachment) : null;
		const guestRooms = attachment.rooms ?? [];
		attachment.tier = "registered";
		attachment.userId = identity.userId;
		attachment.name = identity.name;
		setAvatar(attachment, identity.avatar);
		attachment.roles = identity.roles;
		attachment.rooms = this.liveRoomsOf(identity.userId, socket) ?? identity.rooms;
		delete attachment.listedJoined;
		writeSessionAttachment(socket, attachment);
		this.applyPendingMute(socket);
		this.reply(socket, request, { you: this.you(attachment), ...(token ? { token } : {}) });
		if (guest) this.announceUser(socket, this.current(attachment), [...guestRooms, ...attachment.rooms], guest);
		this.refreshAvatar(identity.userId);
		await this.rescheduleAlarm();
	}

	/**
	 * Signs up a new user with the live `/invite` token (protocol Appendix B):
	 * each use creates a registered user with no passkey, named as `auth`
	 * asks (else "Guest"), with a `user_id` picked from the name like a
	 * passkey registration's, charged as a registration. The result carries
	 * the new user's own invite token (`apron_invite_…`, as `/invite-token`
	 * mints), so the shared invite is not needed again; they may add a
	 * passkey once signed in (§4.9). A used-up, expired, or replaced invite is
	 * `denied`.
	 */
	private async handleJoinToken(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, token: string): Promise<void> {
		return this.withSessionLock(async () => {
			if (attachment.tier === "registered") throw { name: "denied", message: "Identity switching requires reconnect" } satisfies ProtocolError;
			if (token.length > MAX_SESSION_TOKEN_CHARS) throw { name: "invalid_params", message: "token is too long" } satisfies ProtocolError;
			const name = this.requestedName(request.params) ?? JOIN_DEFAULT_NAME;
			const key = JOIN_TOKEN_KEY_PREFIX + await sha256Hex(token);
			const own = INVITE_TOKEN_PREFIX + bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
			const ownKey = INVITE_TOKEN_KEY_PREFIX + await sha256Hex(own);
			const open = () => !connectionAttachment(socket)?.closing && openSocket(socket);
			// The whole key-value cost (the invite read, then its count and the new
			// user's token, or pruning a dead invite) is reserved before the
			// account exists, so an exhausted budget cannot strand an account
			// without its token or an invite not counted down.
			const userId = await this.store.withMeterAsync("foreground", { reads: 1, writes: 3 }, async () => {
				const invite = await this.ctx.storage.get<StoredJoinInvite>(key);
				if (!invite || invite.v !== 1 || !(invite.remaining > 0) || invite.expiresMs <= nowMs()) {
					// A used-up or expired invite is dropped when it is next tried.
					if (invite) await this.ctx.storage.delete(key);
					throw { name: "denied", message: "This invite is used up or has expired; ask an admin for a new one" } satisfies ProtocolError;
				}
				// A connection gone before the sign-up spends no use.
				if (!open()) return null;
				const userId = candidateUserIdFor(name, (candidate) => this.store.userIdTaken(candidate));
				await this.runMutation(async () => {
					const created = this.store.createInvitedIdentity({ userId, name, now: nowMs(), ipKey: attachment.ipKey });
					for (const record of created.broadcasts) this.broadcastRecord(record);
				});
				// One put of three keys, with no await between creation and it: the
				// new user's token and pointer, and the invite counted down (a
				// used-up invite is pruned on its next try).
				await this.ctx.storage.put({
					[ownKey]: { v: 1, userId } satisfies StoredInviteToken,
					[INVITE_KEY_PREFIX + userId]: { v: 1, tokenKey: ownKey } satisfies StoredBot,
					[key]: { ...invite, remaining: invite.remaining - 1 } satisfies StoredJoinInvite,
				});
				return userId;
			});
			if (userId === null) return;
			const identity = this.store.getIdentity(userId);
			if (!identity) throw { name: "internal_error", message: "Invited user is missing" } satisfies ProtocolError;
			// A reply lost after this point costs one use: the user exists, with a
			// token nobody received, until an admin /purges them.
			await this.signInKeyless(socket, attachment, request, identity, own);
		});
	}

	/**
	 * `/invite <uses>`: mints the sign-up invite (protocol Appendix B), a
	 * token that signs up to `uses` new users within a week, and revokes the
	 * last one; `/invite 0` only revokes. The token goes to this connection
	 * only, in a `~private` notice, before the result (§1).
	 */
	private async invite(socket: WebSocketConnection, request: RequestFrame, roomId: string, count: string): Promise<void> {
		const uses = /^\d{1,3}$/.test(count) ? Number(count) : -1;
		if (uses < 0 || uses > MAX_JOIN_USES) throw { name: "invalid_params", message: `Usage: /invite <uses>, 0 to ${MAX_JOIN_USES}` } satisfies ProtocolError;
		const token = JOIN_TOKEN_PREFIX + bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
		const key = JOIN_TOKEN_KEY_PREFIX + await sha256Hex(token);
		const expiresMs = nowMs() + JOIN_INVITE_TTL_MS;
		await this.withSessionLock(() => this.store.withMeterAsync("foreground", { reads: 1, writes: 3 }, async () => {
			const previous = await this.ctx.storage.get<StoredBot>(JOIN_INVITE_KEY);
			// Revoke first: a failure between the writes leaves no invite, never two.
			if (previous?.v === 1 && typeof previous.tokenKey === "string") await this.ctx.storage.delete(previous.tokenKey);
			if (uses === 0) return void await this.ctx.storage.delete(JOIN_INVITE_KEY);
			await this.ctx.storage.put<StoredJoinInvite>(key, { v: 1, remaining: uses, expiresMs });
			await this.ctx.storage.put<StoredBot>(JOIN_INVITE_KEY, { v: 1, tokenKey: key });
		}));
		this.sendNotice(socket, roomId, uses === 0 ? "The sign-up invite is revoked." : [
			`This invite signs up ${uses} new user${uses === 1 ? "" : "s"} until ${new Date(expiresMs).toISOString().slice(0, 16).replace("T", " ")} UTC, and replaces any earlier one. Each gets their own token to sign in again with, and can add a passkey after.`,
			"```\n" + token + "\n```",
			`To sign up, authenticate with the token scheme and a name: \`{"method": "auth", "params": {"scheme": "token", "token": "${token}", "name": "Ada"}}\``,
		].join("\n\n"));
		this.reply(socket, request, {});
	}

	/**
	 * Mints a bot's token and revokes the one before it. The token is stored
	 * only as its SHA-256; the plaintext goes to the owner once.
	 */
	private async issueBotToken(botId: string, ownerId: string): Promise<string> {
		return this.withSessionLock(async () => {
			const token = BOT_TOKEN_PREFIX + bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
			const key = BOT_TOKEN_KEY_PREFIX + await sha256Hex(token);
			await this.store.withMeterAsync("foreground", { reads: 1, writes: 3 }, async () => {
				const previous = await this.ctx.storage.get<StoredBot>(BOT_KEY_PREFIX + botId);
				// Revoke first: a failure between the writes leaves no token, never two.
				if (previous?.v === 1 && typeof previous.tokenKey === "string") await this.ctx.storage.delete(previous.tokenKey);
				await this.ctx.storage.put<StoredBotToken>(key, { v: 1, botId, ownerId });
				await this.ctx.storage.put<StoredBot>(BOT_KEY_PREFIX + botId, { v: 1, tokenKey: key });
			});
			return token;
		});
	}

	private async issueSession(userId: string, origin: string, now: number): Promise<string> {
		return this.withSessionLock(() => this.issueSessionLocked(userId, origin, now));
	}

	private async issueSessionLocked(userId: string, origin: string, now: number): Promise<string> {
		const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
		const key = await sessionKey(token);
		const expiresMs = now + this.config.limits.sessionTtlSeconds * 1_000;
		await this.store.withMeterAsync("foreground", { writes: 2 }, async () => {
			await this.ctx.storage.put<SessionExpiryEntry>(sessionExpiryKey(expiresMs, key), { v: 1, sessionKey: key, expiresMs });
			await this.ctx.storage.put<StoredSession>(key, { v: 1, userId, origin, expiresMs });
		});
		return token;
	}

	/** Drops expired session records from a bounded, ordered expiry index. */
	/** Whether it processed a full batch, so more may be due. */
	private async sweepSessions(now: number): Promise<boolean> {
		return this.withSessionLock(() => this.sweepSessionsLocked(now));
	}

	private async sweepSessionsLocked(now: number): Promise<boolean> {
		// Socket deadline alarms can be frequent. Probe the bounded expiry index
		// before reserving a full batch; this is the only maintenance work
		// performed until an expiry is actually due.
		const dueProbe = await this.store.withMeterAsync("maintenance", { reads: 1 }, () => this.ctx.storage.list<SessionExpiryEntry>({
			prefix: SESSION_EXPIRY_PREFIX,
			end: `${SESSION_EXPIRY_PREFIX}${Math.max(0, Math.trunc(now)).toString().padStart(16, "0")}\uffff`,
			limit: 1,
		}), now);
		if (dueProbe.size === 0) return false;
		// Up to B index rows + B session reads; writes cover 2B expiry deletes.
		return await this.store.withMeterAsync("maintenance", {
			reads: 2 * SESSION_CLEANUP_BATCH + 2,
			writes: 2 * SESSION_CLEANUP_BATCH,
		}, async () => {
			const indexed = await this.ctx.storage.list<SessionExpiryEntry>({
				prefix: SESSION_EXPIRY_PREFIX,
				end: `${SESSION_EXPIRY_PREFIX}${Math.max(0, Math.trunc(now)).toString().padStart(16, "0")}\uffff`,
				limit: SESSION_CLEANUP_BATCH,
			});
			for (const [indexKey, entry] of indexed) {
				if (!entry || entry.v !== 1 || typeof entry.sessionKey !== "string" || !Number.isSafeInteger(entry.expiresMs)) {
					await this.ctx.storage.delete(indexKey);
					continue;
				}
				const session = await this.ctx.storage.get<StoredSession>(entry.sessionKey);
				if (!session || session.v !== 1 || !Number.isSafeInteger(session.expiresMs)) {
					await this.ctx.storage.delete(indexKey);
					continue;
				}
				if (session.expiresMs <= now) {
					await this.ctx.storage.delete([entry.sessionKey, indexKey]);
					continue;
				}
				if (entry.expiresMs < session.expiresMs) {
					await this.ctx.storage.delete(indexKey);
					continue;
				}
				// This should only be reached for a stale/malformed ordering entry;
				// preserve the live session and discard its obsolete index row.
				await this.ctx.storage.delete(indexKey);
			}
			return indexed.size >= SESSION_CLEANUP_BATCH;
		});
	}

	/**
	 * Serialize session KV decisions across fetches and alarms. Lock order:
	 * a holder of this lock may take runMutation's (a sign-up invite creates
	 * its user inside it), so a runMutation body must never wait for this
	 * lock, or the two deadlock.
	 */
	private async withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
		const prior = this.sessionWorkTail;
		let release!: () => void;
		const held = new Promise<void>(resolve => { release = resolve; });
		this.sessionWorkTail = prior.catch(() => undefined).then(() => held);
		await prior.catch(() => undefined);
		try {
			return await fn();
		} finally {
			release();
		}
	}

	private requestOrigin(socket: WebSocketConnection): string | null {
		const attachment = connectionAttachment(socket) as ConnectionAttachment & { origin?: string } | null;
		return attachment?.origin ?? null;
	}

	private async handleHistory(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate before loading history" } satisfies ProtocolError;
		if (attachment.historyInFlight >= this.config.limits.concurrentHistoryPerConnection) throw { name: "retry_after", message: "History request already in progress", data: { retry_after: 1 } } satisfies ProtocolError;
		const params = request.params;
		// Without room_id, history pages the default room (§4.1). Every room is
		// visible, so any room's history may be read without joining it.
		const roomId = optionalString(params, "room_id");
		const after = asDecimalId(params.after, "after");
		const before = asDecimalId(params.before, "before");
		const limit = positiveIntParam(params, "limit");
		attachment.historyInFlight += 1;
		writeAttachment(socket, attachment);
		try {
			const page = this.store.history({
				...(roomId !== undefined ? { roomId } : {}),
				after,
				before,
				limit: limit ?? this.config.limits.historyDefaultLimit,
				maxBytes: this.config.limits.historyMaxResponseBytes,
				now: nowMs(),
				userId: attachment.userId,
				ipKey: attachment.ipKey,
			});
			this.reply(socket, request, page);
		} finally {
			const latest = connectionAttachment(socket);
			if (latest) {
				latest.historyInFlight = Math.max(0, latest.historyInFlight - 1);
				writeAttachment(socket, latest);
			}
		}
	}

	/**
	 * Profile update (section 3.3): a given field replaces its value, an
	 * omitted one is unchanged, and an empty one removes it. Only registered
	 * users may change their name; `name: ""` removes it, so the user falls
	 * back to `user_id`. With uploads, `avatar: ""` removes a registered user's
	 * avatar; a new one comes only through `/avatar` (§4.6.6), so other values
	 * are declined, as is `ext`. `roles` is not settable (§3.3) and is ignored.
	 */
	private async handleMe(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity) throw { name: "denied", message: "Authenticate first" } satisfies ProtocolError;
		const name = optionalString(request.params, "name");
		const avatar = optionalString(request.params, "avatar");
		objectParam(request.params, "ext", false);
		const removeAvatar = avatar === "" && attachment.tier === "registered" && !!this.config.uploads;
		if (removeAvatar) {
			const cleared = this.store.clearAvatar({ userId: identity.user_id, now: nowMs() });
			this.deleteMedia(cleared.deletedUploads);
			// Announced as its empty value (§3.3), before the result.
			if (cleared.changed) this.announceAvatar(identity.user_id, "");
		}
		if (name === undefined) {
			const current = connectionAttachment(socket) ?? attachment;
			this.reply(socket, request, { you: removeAvatar ? { ...this.you(current), avatar: "" } : this.you(current) });
			return;
		}
		if (attachment.tier !== "registered") {
			throw { name: "denied", message: "Only registered users may change their name" } satisfies ProtocolError;
		}
		if (hasRole(attachment, "bot")) {
			throw { name: "denied", message: isBotId(identity.user_id) ? "A bot is named after its owner, who can rename it with /invite-bot" : "A bot can't change its name" } satisfies ProtocolError;
		}
		await this.runMutation(async () => {
			const result = this.store.commitMutation({
				userId: identity.user_id, ipKey: attachment.ipKey,
				requestId: request.id, method: "me", now: nowMs(),
				params: request.params, identity,
			});
			// Persist first, then refresh every live attachment for this identity so
			// subsequent messages from other tabs carry the same name. An accepted
			// retry must not roll back a newer name change.
			if (!result.deduplicated) {
				for (const peer of this.ctx.getWebSockets()) {
					const state = connectionAttachment(peer);
					if (state?.userId !== identity.user_id) continue;
					state.name = name;
					writeAttachment(peer, state);
				}
			}
			const current = connectionAttachment(socket);
			if (!current) return;
			// A removed name is announced as its empty value (§3.3).
			const you = { ...this.current(current)!, ...(current.name ? {} : { name: "" }) };
			const mute = this.you(current)?.mute;
			this.reply(socket, request, { you: mute === undefined ? you : { ...you, mute } });
			// Section 3.3: `you` to the user's other connections, `new` to those who share a room with the user.
			if (!result.deduplicated) this.announceUser(socket, you, current.rooms ?? []);
		});
	}

	/**
	 * Guests only read unless `GUEST_POSTING` is on: posting, reacting,
	 * joining, leaving, and room changes are denied by policy (§3.5, §4.3.2).
	 * Listing rooms and reading history stay open.
	 */
	private assertMayWrite(attachment: ConnectionAttachment): void {
		if (attachment.tier === "anonymous" && !this.config.guestPosting) throw { name: "denied", message: GUEST_READ_ONLY } satisfies ProtocolError;
	}

	/** Shared path for logged mutations: dedup, quotas, commit, reply, broadcast. */
	private async commitAndBroadcast(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, method: "message" | "reactions", action: string): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity) throw { name: "denied", message: `Authenticate before ${action}` } satisfies ProtocolError;
		const input: StoreMutationInput = {
			userId: identity.user_id,
			tier: identity.tier,
			ipKey: attachment.ipKey,
			requestId: request.id,
			method,
			now: nowMs(),
			params: request.params,
			identity,
		};
		let started = false;
		let created: MessageSnapshot | undefined;
		await this.runMutation(async () => {
			const result = this.store.mutate(input);
			// A deduplicated retry carries no records and is never rebroadcast.
			// The broadcast comes before the result on the sender's connection (§1).
			for (const record of result.broadcasts) this.broadcastRecord(record);
			this.reply(socket, request, await this.withWriteUrls(result.result));
			started = this.afterUploads(result);
			// Only a new message wakes anyone: not an edit, move, or retry (§4.7).
			if (method === "message" && !result.deduplicated && result.message?.prev_log_id === undefined) created = result.message;
		});
		if (created && identity.tier === "registered") this.wakeFor(created);
		// Pending writes that never come are failed by the alarm (§4.6.3).
		if (started) await this.rescheduleAlarm();
	}

	private async handleMessage(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate before posting" } satisfies ProtocolError;
		this.assertMayWrite(attachment);
		// Without room_id a message goes to the default room (§3.5). Posting does
		// not require joining; a poster who has not joined gets only the result.
		optionalString(request.params, "room_id");
		// Server-owned fields are ignored on input (PROTOCOL.md §2).
		delete request.params.log_id;
		delete request.params.from;
		const messageId = optionalString(request.params, "message_id");
		if (messageId === undefined && request.params.body === undefined) throw { name: "invalid_params", message: "Missing body" } satisfies ProtocolError;
		if (request.params.body !== undefined) objectParam(request.params, "body");
		await this.commitAndBroadcast(socket, attachment, request, "message", "posting");
		// An accepted message from a connection ends its `idle` (§4.11).
		this.setAway(socket, false);
	}

	private async handleReactions(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (identityOf(attachment)) this.assertMayWrite(attachment);
		await this.commitAndBroadcast(socket, attachment, request, "reactions", "reacting");
	}

	/**
	 * `room_set` (§4.3.4): creates a thread under `general`, which joins its
	 * creator, or replaces a thread's client fields. Creating sends the
	 * creator's connections `room_update` `joined` with the room's members,
	 * then a registered creator's logged membership, and the parent's other
	 * members `updated`. A save sends `updated` to the members of the room and
	 * of its parent, and to the saver. Both come before the result (§1).
	 */
	private async handleRoomSet(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity) throw { name: "denied", message: "Authenticate before changing rooms" } satisfies ProtocolError;
		this.assertMayWrite(attachment);
		await this.runMutation(async () => {
			const result = this.store.mutate({
				userId: identity.user_id, tier: identity.tier, ipKey: attachment.ipKey,
				requestId: request.id, method: "room_set", now: nowMs(), params: request.params, identity,
			});
			const room = result.room;
			if (room && !result.deduplicated) {
				this.noteRoom(room.room_id, true);
				const scope = [room.room_id, ...(room.parent_room_id !== undefined ? [room.parent_room_id] : [])];
				if (result.created) {
					this.setRooms(identity.user_id, [...(this.liveRoomsOf(identity.user_id) ?? []), room.room_id]);
					// A new room's only member is its creator: no storage to read.
					const creator = this.current(attachment)!;
					// The room with its members and a registered creator's membership, in one frame (§4.3.4).
					this.sendToUser(identity.user_id, this.joinedUpdate(room, [creator], undefined, undefined, result.membership));
					if (result.membership) this.broadcastRecord(result.membership, identity.user_id);
					this.deliver(roomUpdate("updated", room), scope, (state) => state.userId !== identity.user_id);
				} else {
					this.deliver(roomUpdate("updated", room), scope, (state) => state.userId !== identity.user_id);
					this.sendToUser(identity.user_id, roomUpdate("updated", room));
				}
			}
			this.reply(socket, request, result.result);
		});
	}

	/**
	 * `room_join` (§4.3.2): every connection of the user receives the room's
	 * deliveries from now on. A registered user's join is stored and logged:
	 * its membership goes to the room's members, the joiner's connections
	 * included. Then the user's connections get `room_update` `joined` with
	 * the room's members, and then the result. A guest's join lives in its
	 * connection and is not logged. Joining a room already joined logs
	 * nothing and re-sends `joined` to this connection only. With another
	 * user's `user_id`, it adds that user (see addMember).
	 */
	private async handleRoomJoin(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity) throw { name: "denied", message: "Authenticate before joining rooms" } satisfies ProtocolError;
		this.assertMayWrite(attachment);
		const roomId = requiredString(request.params, "room_id");
		const target = optionalString(request.params, "user_id");
		const known = this.store.getRoom(roomId, nowMs());
		this.noteRoom(roomId, known !== null);
		if (!known) throw { name: "invalid_params", message: "Unknown room" } satisfies ProtocolError;
		if (target !== undefined && target !== identity.user_id) {
			await this.addMember(socket, attachment, request, known, target);
			return;
		}
		// The members before the join, read before anything commits.
		const totals = new Map<string, number>();
		const before = this.membersOf([roomId], totals);
		const joiner = this.current(attachment)!;
		const current = attachment.rooms ?? [];
		if (current.includes(roomId)) {
			this.send(socket, this.joinedUpdate(known, before.get(roomId), joiner, totals.get(roomId)));
			this.reply(socket, request, {});
			return;
		}
		if (identity.tier !== "registered") {
			this.setRooms(identity.user_id, [...current, roomId]);
			this.sendToUser(identity.user_id, this.joinedUpdate(known, before.get(roomId), joiner, totals.get(roomId)));
			this.reply(socket, request, {});
			return;
		}
		await this.runMutation(async () => {
			const change = this.store.changeMembership({ userId: identity.user_id, ipKey: attachment.ipKey, roomId, join: true, now: nowMs() });
			this.setRooms(identity.user_id, change.rooms);
			// The room's other members get the membership; the joiner's connections
			// get it with the room and its members (§4.3.2).
			if (change.membership) this.broadcastRecord(change.membership, identity.user_id);
			this.sendToUser(identity.user_id, this.joinedUpdate(change.room ?? known, before.get(roomId), joiner, totals.get(roomId), change.membership));
			this.reply(socket, request, {});
		});
	}

	/**
	 * Whether this connection's user may add `userId` to a room or remove
	 * them from one (§4.3.2): an admin may for anyone, and a registered user
	 * for their own bot, say to have it keep a thread's `description` current.
	 */
	private assertMayManage(attachment: ConnectionAttachment, userId: string): void {
		const owner = attachment.tier === "registered" && !hasRole(attachment, "bot");
		if (owner && (userId === BOT_ID_PREFIX + attachment.userId || hasRole(attachment, "admin"))) return;
		throw { name: "denied", message: "Only an admin, or a bot's owner, can add or remove someone else" } satisfies ProtocolError;
	}

	/**
	 * `room_join` with another user's `user_id` (§4.3.2): an admin, or the
	 * owner of the bot named, adds a registered user to the room as if they
	 * had joined it. The join is stored and logged, charged to the adder's
	 * posting limits, and its membership goes to the room's members; the
	 * added user's connections then get `room_update` `joined`. Guests' rooms
	 * live in their own connections, so they are not added. A user already
	 * in the room changes nothing.
	 */
	private async addMember(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, room: RoomRecord, userId: string): Promise<void> {
		this.assertMayManage(attachment, userId);
		if (!this.store.identityExists(userId)) throw { name: "invalid_params", message: `${userId} is not a registered user`.slice(0, 200) } satisfies ProtocolError;
		const totals = new Map<string, number>();
		const before = this.membersOf([room.room_id], totals);
		await this.runMutation(async () => {
			const change = this.store.changeMembership({ userId, ipKey: attachment.ipKey, roomId: room.room_id, join: true, now: nowMs(), actorId: attachment.userId });
			if (change.changed) {
				this.setRooms(userId, change.rooms);
				if (change.membership) this.broadcastRecord(change.membership, userId);
				const peer = this.connectionsOf(userId)[0];
				const state = peer ? connectionAttachment(peer) : null;
				const joiner = state ? this.current(state) : null;
				if (joiner) this.sendToUser(userId, this.joinedUpdate(change.room ?? room, before.get(room.room_id), joiner, totals.get(room.room_id), change.membership));
			}
			this.reply(socket, request, {});
		});
	}

	/**
	 * `room_leave` (§4.3.2): a registered user's leave is stored and logged,
	 * and its membership goes to the room's members, the leaver's connections
	 * included. Then the user's connections stop receiving the room's
	 * deliveries and get `room_update` `left`, and then the result. The room
	 * stays visible and can be joined again. Leaving a room not joined
	 * changes nothing. With another user's `user_id`, an admin or the bot's
	 * owner removes that user, as `/kick` does but without its notice.
	 */
	private async handleRoomLeave(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity) throw { name: "denied", message: "Authenticate before leaving rooms" } satisfies ProtocolError;
		this.assertMayWrite(attachment);
		const roomId = requiredString(request.params, "room_id");
		const target = optionalString(request.params, "user_id");
		if (!this.roomExists(roomId)) throw { name: "invalid_params", message: "Unknown room" } satisfies ProtocolError;
		if (target !== undefined && target !== identity.user_id) {
			this.assertMayManage(attachment, target);
			if (!this.store.identityExists(target) && !this.connectionsOf(target).length) {
				throw { name: "invalid_params", message: `No user has the user_id ${target}`.slice(0, 200) } satisfies ProtocolError;
			}
			await this.removeMember(attachment, roomId, target);
			this.reply(socket, request, {});
			return;
		}
		const current = attachment.rooms ?? [];
		if (!current.includes(roomId)) {
			this.reply(socket, request, {});
			return;
		}
		if (identity.tier !== "registered") {
			this.setRooms(identity.user_id, current.filter((id) => id !== roomId));
			this.sendToUser(identity.user_id, roomUpdate("left", { room_id: roomId }));
			this.reply(socket, request, {});
			return;
		}
		await this.runMutation(async () => {
			const change = this.store.changeMembership({ userId: identity.user_id, ipKey: attachment.ipKey, roomId, join: false, now: nowMs() });
			// The room's other members get the membership; the leaver's connections
			// get it with `left` (§4.3.2).
			if (change.membership) this.broadcastRecord(change.membership, identity.user_id);
			this.setRooms(identity.user_id, change.rooms);
			this.sendToUser(identity.user_id, leftUpdate(roomId, change.membership));
			this.reply(socket, request, {});
		});
	}

	/**
	 * Activity (§4.4). Typing is relayed to the room's other members and never
	 * stored; without room_id it is in the default room. Read cursors are
	 * dropped: the demo neither keeps nor relays them. Neither touches the
	 * connection's `status` `idle` (§4.11). At most
	 * `activityBroadcastsPerUserMinute` relays per user; past that the update
	 * is dropped and the sender gets one `~private` notice per minute.
	 */
	private async handleActivity(socket: WebSocketConnection, request: RequestFrame): Promise<void> {
		const attachment = connectionAttachment(socket);
		const identity = attachment ? publicIdentity(attachment) : null;
		if (!attachment || !identity) throw { name: "denied", message: "Authenticate first" } satisfies ProtocolError;
		const typing = request.params.typing;
		if (typing !== undefined && (typeof typing !== "number" || !Number.isFinite(typing) || typing < 0)) {
			throw { name: "invalid_params", message: "typing must be a non-negative number of seconds" } satisfies ProtocolError;
		}
		const roomId = request.params.room_id ?? ROOM_ID;
		if (typing !== undefined && (typeof roomId !== "string" || roomId.length === 0 || roomId.length > 64)) {
			throw { name: "invalid_params", message: "room_id must be a room" } satisfies ProtocolError;
		}
		if (request.id !== undefined) this.reply(socket, request, {});
		// A guest who only reads has nothing to be typing.
		if (attachment.tier === "anonymous" && !this.config.guestPosting) return;
		if (typing === undefined || typeof roomId !== "string" || !this.roomExists(roomId)) return;
		const now = nowMs();
		const limit = this.config.limits.activityBroadcastsPerUserMinute;
		if (!this.takeThrottle(socket, identity.user_id, "activity", limit, now)) {
			this.noticeThrottled(socket, identity.user_id, "activity", roomId, now,
				`Typing updates are limited to ${limit} per minute, so others may not see you typing for a moment.`);
			return;
		}
		const seconds = Math.min(Math.floor(typing), this.config.limits.activityMaxTypingSeconds);
		const frame = { method: "activity", params: { room_id: roomId, from: identity, typing: seconds } };
		this.deliver(frame, [roomId], undefined, socket);
	}

	/**
	 * `status` (§4.11), a notification, implemented in part: unscoped `idle`
	 * and `mute`. `idle` marks this connection unattended (true) or attended
	 * (false), kept in the attachment, so it survives hibernation; an
	 * accepted message from the connection also ends it, and closing removes
	 * the connection. `mute` is the user's: seconds to stay quiet (cut to
	 * MAX_MUTE_SECONDS), `true` until changed, or `0` to end it; stored, so
	 * it outlasts the connection, and echoed in `you` to the user's
	 * connections when it changes. Guests get no pushes, so their mute is
	 * ignored. Both may come before authentication, and apply once signed in.
	 * A `room_id` scopes the fields to a room, which this server does not
	 * implement, so a scoped update is ignored, as are `invisible` and
	 * unknown fields. A malformed `idle` or `mute` is `invalid_params`, and
	 * nothing in the update applies.
	 */
	private handleStatus(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): void {
		const params = request.params;
		if (params.room_id !== undefined) return;
		const idle = params.idle;
		if (idle !== undefined && typeof idle !== "boolean") throw { name: "invalid_params", message: "idle must be a boolean" } satisfies ProtocolError;
		const mute = params.mute;
		if (mute !== undefined && mute !== true && !(typeof mute === "number" && Number.isSafeInteger(mute) && mute >= 0)) {
			throw { name: "invalid_params", message: "mute must be true or a whole number of seconds" } satisfies ProtocolError;
		}
		if (typeof idle === "boolean") this.setAway(socket, idle);
		if (mute === undefined) return;
		const now = nowMs();
		const untilMs = mute === true ? MUTE_FOREVER : mute === 0 ? 0 : now + Math.min(mute, MAX_MUTE_SECONDS) * 1_000;
		if (attachment.tier === "pending") {
			const state = connectionAttachment(socket);
			if (!state) return;
			state.pendingMute = untilMs;
			writeAttachment(socket, state);
			return;
		}
		if (attachment.tier === "registered") this.changeMute(attachment.userId!, untilMs, now);
	}

	/**
	 * Stores a registered user's mute (0 ends it) and, on a change, sends
	 * `user` `you` with it to every connection of theirs but `except` (§4.11).
	 * Never shown to others.
	 */
	private changeMute(userId: string, untilMs: number, now: number, except?: WebSocketConnection): void {
		if (!this.store.setMute({ userId, untilMs: untilMs > 0 ? untilMs : null, now })) return;
		const mute = this.store.muteOf(userId, now);
		for (const peer of this.connectionsOf(userId, except)) {
			const state = connectionAttachment(peer);
			const user = state ? this.current(state) : null;
			if (user) this.deliverTo(peer, { method: "user", params: { you: { ...user, ...(mute !== undefined ? { mute } : {}) } } });
		}
	}

	/** Applies a `status` `mute` sent before this connection signed in as a registered user. */
	private applyPendingMute(socket: WebSocketConnection): void {
		const state = connectionAttachment(socket);
		if (!state || state.pendingMute === undefined) return;
		const untilMs = state.pendingMute;
		delete state.pendingMute;
		writeAttachment(socket, state);
		// This connection learns the mute from its auth result.
		if (state.tier === "registered" && state.userId) this.changeMute(state.userId, untilMs, nowMs(), socket);
	}

	/**
	 * A connection's own user object (`you`, §3.3): its current object and,
	 * for a muted registered user, `mute`, the seconds left or `true` (§4.11),
	 * which is never shown to others.
	 */
	private you(attachment: ConnectionAttachment): PublicUser | null {
		const user = this.current(attachment);
		if (!user || attachment.tier !== "registered" || !this.config.push) return user;
		const mute = this.store.muteOf(user.user_id);
		return mute === undefined ? user : { ...user, mute };
	}

	/** Marks a connection idle or attended (`status` `idle`, §4.11), writing its attachment only on a change. */
	private setAway(socket: WebSocketConnection, away: boolean): void {
		const state = connectionAttachment(socket);
		if (!state || (state.away === true) === away) return;
		if (away) state.away = true;
		else delete state.away;
		writeAttachment(socket, state);
	}

	/** Whether a user has a connection someone attends: authenticated as them, not stale, and not idle (§4.11). */
	private attended(userId: string, now: number): boolean {
		return this.connectionsOf(userId).some((peer) => !this.isStale(peer, now) && !connectionAttachment(peer)?.away);
	}

	/**
	 * `push_register` (§4.7) for push kind `webpush`: `{kind: "webpush", url,
	 * keys: {p256dh, auth}, push_id?}`, the browser's `PushSubscription.toJSON()`
	 * with `kind` added (`expirationTime` is ignored). `push_id`, 1 to 64
	 * letters, digits, `_` or `-`, goes unchanged into every push to this
	 * registration. `wake` lists the scopes it wakes for (§4.7): at most
	 * MAX_WAKE_ENTRIES strings of at most 64 characters; scopes this server
	 * does not implement are ignored, `[]` wakes for nothing, and without it
	 * the registration wakes for `mentions` and `replies`. At most
	 * `registersPerUserMinute` a user, across their
	 * connections; past that, `retry_after`. Registered users only; a
	 * guest's identity lasts one connection, so there is no one to wake. The
	 * endpoint must be a public `https` URL (pushEndpointError), `p256dh` an
	 * uncompressed P-256 point and `auth` 16 bytes, both base64url. A user
	 * registering a `url` again replaces their own registration of it
	 * (Store.registerPushSubscription).
	 */
	private async handlePushRegister(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate first" } satisfies ProtocolError;
		if (attachment.tier !== "registered") throw { name: "denied", message: "Sign in to receive push notifications" } satisfies ProtocolError;
		const now = nowMs();
		const limit = PUSH_POLICY!.registersPerUserMinute;
		const retry = this.throttleRetry(attachment.userId!, "push_register", limit, now);
		if (retry !== undefined) throw { name: "retry_after", message: "Push registrations limited", data: { retry_after: retry } } satisfies ProtocolError;
		// Counted before validation, so refused registrations count too.
		this.takeThrottle(socket, attachment.userId!, "push_register", Number.MAX_SAFE_INTEGER, now);
		const params = request.params;
		const kind = requiredString(params, "kind");
		if (kind !== "webpush") throw { name: "invalid_params", message: "Unknown push kind; this server offers webpush" } satisfies ProtocolError;
		const url = requiredString(params, "url");
		const wake = wakeParam(params.wake);
		const pushId = optionalString(params, "push_id");
		if (pushId !== undefined && !PUSH_ID_PATTERN.test(pushId)) throw { name: "invalid_params", message: "push_id must be 1 to 64 letters, digits, _ or -" } satisfies ProtocolError;
		const problem = pushEndpointError(url, this.config.pushHosts);
		if (problem) throw { name: "invalid_params", message: problem } satisfies ProtocolError;
		const keys = objectParam(params, "keys")!;
		const key = (name: string): Uint8Array | null => typeof keys[name] === "string" && keys[name].length <= 256 ? base64UrlDecode(keys[name]) : null;
		const p256dh = key("p256dh");
		if (!p256dh || !await validP256PublicKey(p256dh)) {
			throw { name: "invalid_params", message: "keys.p256dh must be an uncompressed P-256 public key in base64url" } satisfies ProtocolError;
		}
		const auth = key("auth");
		if (auth?.byteLength !== AUTH_SECRET_BYTES) throw { name: "invalid_params", message: `keys.auth must be ${AUTH_SECRET_BYTES} bytes in base64url` } satisfies ProtocolError;
		// The key check awaited: register for the connection as it is now (a /rename may have moved it).
		const current = connectionAttachment(socket);
		if (!current || current.closing || current.tier !== "registered" || !current.userId) return;
		this.store.registerPushSubscription({ userId: current.userId, url, p256dh: base64UrlEncode(p256dh), auth: base64UrlEncode(auth), ...(pushId !== undefined ? { pushId } : {}), ...(wake !== undefined ? { wake } : {}), now: nowMs() });
		this.reply(socket, request, {});
	}

	/** `push_unregister` (§4.7): removes the user's own registration of `url`; an unknown one is already gone. */
	private handlePushUnregister(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): void {
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate first" } satisfies ProtocolError;
		if (attachment.tier !== "registered") throw { name: "denied", message: "Sign in to receive push notifications" } satisfies ProtocolError;
		const url = requiredString(request.params, "url");
		if (utf8Bytes(url) > MAX_PUSH_URL_BYTES) throw { name: "invalid_params", message: `url is at most ${MAX_PUSH_URL_BYTES} bytes` } satisfies ProtocolError;
		this.store.removePushSubscription({ userId: attachment.userId!, url, now: nowMs() });
		this.reply(socket, request, {});
	}

	/**
	 * Wakes those a registered user's new message concerns (§4.7): the users
	 * its `body.mentions` lists (scope `mentions`) and the author of the
	 * message it replies to (scope `replies`, one metered lookup); guests'
	 * messages wake no one. The candidates, the replied-to author first so
	 * mentions cannot crowd them out, then mentions in order, deduplicated
	 * with their reasons combined, are users other than the sender (and not
	 * guests) with no attended connection (see attended), at most
	 * MAX_PUSH_CANDIDATES. Store.claimPushes then wakes up to
	 * `wakesPerMessage` of those with live registrations for one of their
	 * reasons, at most once a `coalesceSeconds` per room, within the sender's
	 * and the server's daily allowances. Every room is visible to everyone,
	 * so a mention or reply anywhere counts, joined or not. Pushes go out
	 * after the result, kept alive with waitUntil. A failure here is logged
	 * and never touches the post.
	 */
	private wakeFor(message: MessageSnapshot): void {
		const vapid = this.config.push;
		const policy = PUSH_POLICY;
		if (!vapid || !policy) return;
		const now = nowMs();
		const sender = message.from.user_id;
		const reasons = new Map<string, number>();
		const consider = (userId: unknown, reason: number) => {
			if (typeof userId !== "string" || userId === sender || userId.startsWith("guest_")) return;
			const known = reasons.get(userId);
			if (known !== undefined) reasons.set(userId, known | reason);
			else if (reasons.size < MAX_PUSH_CANDIDATES && !this.attended(userId, now)) reasons.set(userId, reason);
		};
		const replyTo = message.reply_to?.message_id;
		if (replyTo !== undefined) {
			try {
				consider(this.store.messageAuthor(replyTo, now), WAKE_SCOPES.replies);
			} catch (error) {
				console.warn(JSON.stringify({ event: "push_reply_lookup_failed", reason: errorToProtocol(error).message }));
			}
		}
		const mentions = message.body?.mentions;
		if (Array.isArray(mentions)) for (const userId of mentions) consider(userId, WAKE_SCOPES.mentions);
		if (!reasons.size) return;
		const candidates: PushCandidate[] = [...reasons].map(([userId, reason]) => ({ userId, reasons: reason }));
		let claimed: ReturnType<Store["claimPushes"]>;
		try {
			claimed = this.store.claimPushes({ senderId: sender, roomId: message.room_id, candidates, now });
		} catch (error) {
			console.warn(JSON.stringify({ event: "push_claim_failed", reason: errorToProtocol(error).message }));
			return;
		}
		if (claimed.skipped) console.warn(JSON.stringify({ event: "push_allowance_reached", skipped: claimed.skipped }));
		if (claimed.subscriptions.length) this.ctx.waitUntil(this.deliverPushes(claimed.subscriptions, message, vapid, policy.ttlSeconds));
	}

	/**
	 * Pushes a message to each registration at once, each payload carrying
	 * that registration's `push_id`, and forgets those whose push service
	 * says they are gone (404 or 410). Other failures are only logged: the
	 * push is lost, not retried.
	 */
	private async deliverPushes(subscriptions: readonly PushSubscriptionRecord[], message: MessageSnapshot, vapid: VapidKeys, ttlSeconds: number): Promise<void> {
		const payloads = new Map<string | undefined, string>();
		const payloadFor = (pushId: string | undefined): string => {
			let payload = payloads.get(pushId);
			if (payload === undefined) payloads.set(pushId, payload = pushPayload(message, pushId));
			return payload;
		};
		const outcomes = await Promise.allSettled(subscriptions.map((subscription) =>
			sendWebPush(subscription, payloadFor(subscription.pushId), vapid, { ttlSeconds, urgency: "normal", nowMs: nowMs() })));
		const gone: Array<{ userId: string; url: string; p256dh: string }> = [];
		let failed = 0;
		outcomes.forEach((outcome, index) => {
			const { userId, url, p256dh } = subscriptions[index];
			if (outcome.status === "fulfilled" && outcome.value.gone) gone.push({ userId, url, p256dh });
			else if (outcome.status === "rejected" || outcome.value.status < 200 || outcome.value.status >= 300) failed++;
		});
		if (failed) console.warn(JSON.stringify({ event: "push_delivery_failed", failed, sent: subscriptions.length }));
		if (!gone.length) return;
		try {
			this.store.forgetPushSubscriptions(gone, nowMs());
		} catch { /* the next push to a gone registration tries again */ }
	}

	/**
	 * `room_list` (§4.3.1): rooms matching the filters, in `joined` (every
	 * match, never truncated) and `not_joined` (visible rooms not joined:
	 * top-level ones, or with `parent_room_id` that room's threads), each most
	 * recently active first. `filter` (`joined`, `not_joined`, or `all`, the
	 * default) leaves out the other array; one it asks for is present even
	 * when empty. With `members: true`, each room carries its `members` and
	 * the result `users` (see membersOf). `latest_log_id` is validated and
	 * ignored: guests' memberships are not logged, so a delta could miss their
	 * joins and leaves, and a result without `left` is a full listing. At most
	 * `roomListRequestsPerUserMinute` listings per user, except the first
	 * `filter: "joined"` listing after authentication.
	 */
	private async handleRoomList(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		const identity = identityOf(attachment);
		if (!identity) throw { name: "denied", message: "Authenticate before listing rooms" } satisfies ProtocolError;
		const params = request.params;
		const filter = params.filter ?? "all";
		if (filter !== "joined" && filter !== "not_joined" && filter !== "all") {
			throw { name: "invalid_params", message: "filter must be joined, not_joined, or all" } satisfies ProtocolError;
		}
		if (params.members !== undefined && typeof params.members !== "boolean") throw { name: "invalid_params", message: "members must be a boolean" } satisfies ProtocolError;
		const withMembers = params.members === true;
		const parent = optionalString(params, "parent_room_id");
		const roomId = optionalString(params, "room_id");
		asDecimalId(params.latest_log_id, "latest_log_id");
		const joinedIds = new Set(attachment.rooms ?? []);
		const result: ListingResult = {};
		if (filter !== "not_joined") result.joined = [];
		if (filter !== "joined") result.not_joined = [];
		// Unjoined top-level rooms: `general` is the only one, so a user in it
		// has none, and the answer needs no storage or listing allowance.
		if (filter === "not_joined" && parent === undefined && roomId === undefined && joinedIds.has(ROOM_ID)) {
			if (withMembers) result.users = [];
			this.reply(socket, request, result);
			return;
		}
		const now = nowMs();
		const exempt = filter === "joined" && !attachment.listedJoined && parent === undefined && roomId === undefined;
		if (exempt) {
			attachment.listedJoined = true;
			writeAttachment(socket, attachment);
		} else {
			const retry = this.throttleRetry(identity.user_id, "room_list", this.config.limits.roomListRequestsPerUserMinute, now);
			if (retry !== undefined) throw { name: "retry_after", message: "Room listing limited", data: { retry_after: retry } } satisfies ProtocolError;
			// Counted before the storage read, so a listing of an unknown room counts too.
			this.takeThrottle(socket, identity.user_id, "room_list", Number.MAX_SAFE_INTEGER, now);
		}
		let candidates: RoomRecord[];
		if (roomId !== undefined) {
			const room = this.store.getRoom(roomId, now);
			this.noteRoom(roomId, room !== null);
			if (!room) throw { name: "invalid_params", message: "Unknown room" } satisfies ProtocolError;
			candidates = [room];
		} else {
			const rooms = this.store.listRooms(now);
			for (const room of rooms) this.noteRoom(room.room_id, true);
			if (parent !== undefined && !rooms.some((room) => room.room_id === parent)) throw { name: "invalid_params", message: "Unknown parent_room_id" } satisfies ProtocolError;
			candidates = rooms.filter((room) => parent === undefined ? true : room.parent_room_id === parent);
		}
		const byActivity = (a: RoomRecord, b: RoomRecord) => Number(b.latest_log_id) - Number(a.latest_log_id) || Number(b.log_id) - Number(a.log_id);
		for (const room of candidates.sort(byActivity)) {
			if (joinedIds.has(room.room_id)) result.joined?.push({ ...room });
			// Without parent_room_id, unjoined threads are left to their parent's listing.
			else if (roomId !== undefined || parent !== undefined || room.parent_room_id === undefined) result.not_joined?.push({ ...room });
		}
		if (withMembers) {
			const listed = [...(result.joined ?? []), ...(result.not_joined ?? [])];
			const totals = new Map<string, number>();
			const members = this.membersOf(listed.map((room) => room.room_id), totals);
			const users = new Map<string, PublicUser>();
			for (const room of listed) {
				const list = members.get(room.room_id) ?? [];
				room.members = list.map((member) => ({ user_id: member.user_id }));
				const total = totals.get(room.room_id);
				if (total !== undefined) room.member_count = total;
				for (const member of list) users.set(member.user_id, member);
			}
			result.users = sortedUsers(users.values());
		}
		this.reply(socket, request, this.boundedListing(result));
	}

	/**
	 * Keeps a listing within the history response cap: `joined` is never
	 * truncated, and every room's client fields fit in 2 KiB, so for a
	 * listing no realistic room reaches, `members`, `member_count`, and
	 * `users` are left out.
	 */
	private boundedListing(result: ListingResult): ListingResult {
		const limit = this.config.limits.historyMaxResponseBytes;
		const fits = () => utf8Bytes(jsonString(result)) + 1_024 <= limit;
		if (fits()) return result;
		for (const room of [...(result.joined ?? []), ...(result.not_joined ?? [])]) {
			delete room.members;
			delete room.member_count;
		}
		delete result.users;
		return result;
	}

	/**
	 * `command` (§4.8): never logged, broadcast, or saved. The demo provides
	 * `/help`, which replies with a `~private` notice listing the commands the
	 * sender may run, `/invite-bot` for registered users, and `/admin`,
	 * `/kick`, `/rename` and `/status` for admins. An unknown
	 * command is an error the client shows; it is not a policy violation,
	 * since people mistype.
	 */
	private async handleCommand(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame): Promise<void> {
		if (!identityOf(attachment)) throw { name: "denied", message: "Authenticate first" } satisfies ProtocolError;
		const params = request.params;
		for (const name of ["message_id", "deleted"]) {
			if (params[name] !== undefined) throw { name: "invalid_params", message: `A command has no ${name}; send it as a message instead` } satisfies ProtocolError;
		}
		const roomId = optionalString(params, "room_id") ?? ROOM_ID;
		const body = objectParam(params, "body");
		if (!body) throw { name: "invalid_params", message: "Missing body" } satisfies ProtocolError;
		const text = optionalString(body, "text") ?? "";
		if (!this.roomExists(roomId)) throw { name: "invalid_params", message: "Unknown room" } satisfies ProtocolError;
		const line = text.trim();
		const words = line.startsWith("/") ? line.slice(1).split(/\s+/) : [""];
		const name = words[0].toLowerCase();
		const command = this.commands().find((candidate) => candidate.name === name);
		if (!command) {
			const message = line.startsWith("/") ? `Unknown command /${name}; try /help` : "A command starts with /; try /help";
			this.fail(socket, request, { name: "invalid_params", message: message.slice(0, 200) });
			return;
		}
		const owner = attachment.tier === "registered" && !hasRole(attachment, "bot");
		if (command.audience === "owners" && !owner) {
			throw { name: "denied", message: hasRole(attachment, "bot") ? `A bot can't use /${name}` : `Sign in with a passkey to use /${name}` } satisfies ProtocolError;
		}
		const admin = owner && hasRole(attachment, "admin");
		if (command.audience === "admins" && !admin) throw { name: "denied", message: `Only an admin can use /${name}` } satisfies ProtocolError;
		if (command.name === "invite-bot") {
			await this.inviteBot(socket, attachment, request, roomId);
			return;
		}
		if (command.name === "avatar") {
			await this.startAvatar(socket, attachment, request, body);
			return;
		}
		if (command.name === "passkeys") {
			try {
				this.passkeysCommand(socket, attachment, request, roomId, words.slice(1));
			} catch (error) {
				const protocol = errorToProtocol(error);
				if (protocol.name !== "invalid_params") throw error;
				this.fail(socket, request, protocol);
			}
			return;
		}
		if (["admin", "role", "kick", "rename", "purge", "toggle", "invite-token", "invite"].includes(command.name)) {
			try {
				if (command.name === "role") {
					if (words.length !== 2 && words.length !== 3) throw { name: "invalid_params", message: `Usage: ${command.usage}` } satisfies ProtocolError;
					this.role(socket, request, roomId, words[1], words[2]);
					return;
				}
				// `/admin remove <user_id>` takes one more word than `/admin <user_id>`.
				const revoke = command.name === "admin" && words[1] === "remove";
				// A user may be written `@user_id`, as a client's mention sends it (Appendix A.3).
				const target = (revoke ? words[2] : words[1])?.replace(/^@/, "");
				const argumentCount = command.name === "rename" || revoke ? 2 : 1;
				if (!target || words.length !== argumentCount + 1) throw { name: "invalid_params", message: `Usage: ${command.usage}` } satisfies ProtocolError;
				if (command.name === "admin") this.grantAdmin(socket, request, roomId, target, revoke);
				else if (command.name === "kick") await this.kick(socket, attachment, request, roomId, target);
				else if (command.name === "purge") await this.purge(socket, attachment, request, roomId, target);
				else if (command.name === "toggle") this.toggle(socket, request, roomId, target);
				else if (command.name === "invite-token") await this.inviteToken(socket, attachment, request, roomId, target);
				else if (command.name === "invite") await this.invite(socket, request, roomId, target);
				else await this.rename(socket, request, roomId, target, words[2].replace(/^@/, ""));
			} catch (error) {
				// A mistyped or wrong user_id is an error to show, like an unknown
				// command, not a policy violation.
				const protocol = errorToProtocol(error);
				if (protocol.name !== "invalid_params") throw error;
				this.fail(socket, request, protocol);
			}
			return;
		}
		if (command.name === "status") {
			await this.sendStatus(socket, request, roomId);
			return;
		}
		// The reply a command causes comes before its result (§1).
		const available = this.commands().filter((candidate) => candidate.audience === "everyone" || (candidate.audience === "owners" && owner) || admin);
		this.send(socket, {
			method: "message",
			params: {
				room_id: roomId,
				from: { ...PRIVATE_IDENTITY },
				body: { text: available.map((candidate) => `- \`${candidate.usage}\`: ${candidate.help}`).join("\n"), format: "markdown" },
			},
		});
		this.reply(socket, request, {});
	}

	/** The commands this deployment offers: `/avatar` only while uploads are on. */
	private commands(): typeof COMMANDS {
		return this.uploadsOn() ? COMMANDS : COMMANDS.filter((command) => command.name !== "avatar");
	}

	/** An admin's `/toggle` of a feature, read once and then kept in memory with every change. */
	private toggled(feature: ToggleFeature): boolean | undefined {
		if (!this.toggles.has(feature)) this.toggles.set(feature, this.store.toggle(feature, nowMs()));
		return this.toggles.get(feature);
	}

	/** Uploads: configured, and not turned off by an admin. */
	private uploadsOn(): boolean {
		return !!this.config.uploads && (this.toggled("uploads") ?? true);
	}

	/** Activity (typing): the deployment's default (plan or `ACTIVITY`) unless an admin toggled it. */
	private activityOn(): boolean {
		return this.toggled("activity") ?? this.config.activityEnabled;
	}

	/**
	 * `/toggle <feature>`: turns `activity` (typing) or, where configured,
	 * `uploads` off or on for everyone, and tells the sender which with a
	 * `~private` notice before the result (§1). Kept across restarts; toggling
	 * back to the deployment's default forgets the override. New connections
	 * are offered the cap only while it is on. With activity off, typing is
	 * no longer relayed; with uploads off, new upload embeds and `/avatar` are
	 * `denied`, and writes already started still finish.
	 */
	private toggle(socket: WebSocketConnection, request: RequestFrame, roomId: string, feature: string): void {
		const features: ToggleFeature[] = this.config.uploads ? ["activity", "uploads"] : ["activity"];
		const chosen = features.find((candidate) => candidate === feature);
		if (!chosen) throw { name: "invalid_params", message: `Usage: /toggle ${features.join("|")}` } satisfies ProtocolError;
		const on = !(chosen === "uploads" ? this.uploadsOn() : this.activityOn());
		const fallback = chosen === "uploads" ? true : this.config.activityEnabled;
		const override = on === fallback ? undefined : on;
		this.store.setToggle(chosen, override, nowMs());
		this.toggles.set(chosen, override);
		const notices: Record<ToggleFeature, [string, string]> = {
			activity: [
				"Activity is now **on**: typing is relayed, and new connections are offered it.",
				"Activity is now **off**: typing is no longer relayed, and new connections are not offered it.",
			],
			uploads: [
				"Uploads are now **on**.",
				"Uploads are now **off**: new attachments and avatars are refused, and new connections are not offered uploads.",
			],
		};
		this.sendNotice(socket, roomId, notices[chosen][on ? 0 : 1]);
		this.reply(socket, request, {});
	}

	/**
	 * `/passkeys`: lists the sender's passkeys, oldest first, numbered, with
	 * when each was added and last used; `/passkeys remove <n>` removes one,
	 * though never the last. Both answer with a `~private` notice before the
	 * result, and a removal is also told to the account's other connections.
	 * Sessions a removed passkey started stay valid until they expire.
	 */
	private passkeysCommand(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, roomId: string, args: string[]): void {
		const userId = attachment.userId!;
		const usage = { name: "invalid_params", message: "Usage: /passkeys, or /passkeys remove <n>" } satisfies ProtocolError;
		if (args.length !== 0 && (args.length !== 2 || args[0] !== "remove" || !/^\d{1,2}$/.test(args[1]))) throw usage;
		const passkeys = this.store.passkeys(userId, nowMs());
		const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
		if (args.length === 0) {
			this.sendNotice(socket, roomId, passkeys.length
				? ["Your passkeys:", ...passkeys.map((key, index) => `${index + 1}. \`${key.credentialId.slice(0, 8)}…\`, added ${day(key.createdMs)}, last used ${day(key.usedMs)}`)].join("\n")
				: "Your account has no passkey. Register one while signed in to add it.");
			this.reply(socket, request, {});
			return;
		}
		const chosen = passkeys[Number(args[1]) - 1];
		if (!chosen) throw { name: "invalid_params", message: `You have ${passkeys.length} passkey${passkeys.length === 1 ? "" : "s"}; see /passkeys` } satisfies ProtocolError;
		if (!this.store.removePasskey({ userId, credentialId: chosen.credentialId, now: nowMs() })) throw usage;
		const text = `Removed the passkey \`${chosen.credentialId.slice(0, 8)}…\` from your account.`;
		for (const peer of this.connectionsOf(userId, socket)) {
			this.deliverTo(peer, { method: "message", params: { from: { ...PRIVATE_IDENTITY }, body: { text, format: "markdown" } } });
		}
		this.sendNotice(socket, roomId, text);
		this.reply(socket, request, {});
	}

	/**
	 * `/avatar` with one `upload` embed (§4.6.6): the result carries the
	 * embed's `write_url`, and the image becomes the sender's avatar when the
	 * write finishes (finishUpload).
	 */
	private async startAvatar(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, body: Record<string, unknown>): Promise<void> {
		const embeds = body.embeds;
		const attached = Array.isArray(embeds) && embeds.length === 1 && !!embeds[0] && typeof embeds[0] === "object" && (embeds[0] as Record<string, unknown>).kind === "upload";
		if (!attached) throw { name: "invalid_params", message: "Attach one image to /avatar as an upload embed" } satisfies ProtocolError;
		let started = false;
		await this.runMutation(async () => {
			const upload = this.store.startAvatarUpload({ userId: attachment.userId!, now: nowMs() });
			this.reply(socket, request, await this.withWriteUrls({ embeds: [uploadResultEmbed(upload)] }));
			started = this.afterUploads({ uploads: [upload] });
		});
		if (started) await this.rescheduleAlarm();
	}

	/**
	 * `/purge <user_id>`: disconnects a user and their bot, then deletes them
	 * and everything they posted, reacted, or uploaded (Store.purgeUsers),
	 * silently: no records announce it, so clients showing their content keep
	 * it until they load history again. They may register a new passkey. The
	 * sender gets a `~private` notice before the result (§1).
	 */
	private async purge(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, roomId: string, target: string): Promise<void> {
		const userId = target.replace(/^@/, "");
		if (userId === attachment.userId) throw { name: "invalid_params", message: "You can't purge yourself" } satisfies ProtocolError;
		if (userId === ADMIN_USER_ID) throw { name: "invalid_params", message: "The admin user can't be purged" } satisfies ProtocolError;
		if (!this.store.identityExists(userId) && !this.connectionsOf(userId).length) {
			throw { name: "invalid_params", message: `No user has the user_id ${userId}`.slice(0, 200) } satisfies ProtocolError;
		}
		const userIds = isBotId(userId) ? [userId] : [userId, BOT_ID_PREFIX + userId];
		for (const id of userIds) {
			for (const peer of this.connectionsOf(id)) {
				const state = connectionAttachment(peer);
				if (state) this.closePolicy(peer, state, 1008, "Removed by an admin");
			}
		}
		let purged = { messages: 0, reactions: 0, deletedUploads: [] as string[] };
		await this.runMutation(async () => {
			purged = this.store.purgeUsers({ userIds, now: nowMs() });
		});
		this.deleteMedia(purged.deletedUploads);
		await this.forgetTokens(userIds);
		const uploads = purged.deletedUploads.length;
		this.sendNotice(socket, roomId, `Purged \`${userId}\`: ${purged.messages} message${purged.messages === 1 ? "" : "s"}, ${purged.reactions} reaction set${purged.reactions === 1 ? "" : "s"}, ${uploads} upload${uploads === 1 ? "" : "s"}.`);
		this.reply(socket, request, {});
	}

	/** Revokes bot and invite tokens, so purged users cannot sign in again. */
	private async forgetTokens(userIds: readonly string[]): Promise<void> {
		if (!userIds.length) return;
		await this.withSessionLock(() => this.store.withMeterAsync("foreground", { reads: 2 * userIds.length, writes: 4 * userIds.length }, async () => {
			for (const userId of userIds) {
				for (const pointer of [BOT_KEY_PREFIX + userId, INVITE_KEY_PREFIX + userId]) {
					const stored = await this.ctx.storage.get<StoredBot>(pointer);
					if (stored?.v !== 1 || typeof stored.tokenKey !== "string") continue;
					await this.ctx.storage.delete(stored.tokenKey);
					await this.ctx.storage.delete(pointer);
				}
			}
		}));
	}

	/**
	 * `/invite-token <user_id>` (a leading `@` is allowed): creates a
	 * registered user with no passkey (Store.createInvitedIdentity), who signs
	 * in with the bearer token the sender gets in a `~private` notice before
	 * the result (§1). A taken `user_id` is `invalid_params`. The token does
	 * not expire; `/purge` revokes it, and `/rename` moves it.
	 */
	private async inviteToken(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, roomId: string, target: string): Promise<void> {
		const userId = target.replace(/^@/, "");
		if (userId === ADMIN_USER_ID) throw { name: "invalid_params", message: `The user_id ${userId} is taken` } satisfies ProtocolError;
		assertIssuableUserId(userId);
		await this.runMutation(async () => {
			const created = this.store.createInvitedIdentity({ userId, name: userId, now: nowMs(), ipKey: attachment.ipKey });
			// The new user's logged join of `general` goes to its members (§4.3.2).
			for (const record of created.broadcasts) this.broadcastRecord(record);
		});
		const token = INVITE_TOKEN_PREFIX + bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
		const key = INVITE_TOKEN_KEY_PREFIX + await sha256Hex(token);
		await this.withSessionLock(() => this.store.withMeterAsync("foreground", { writes: 2 }, async () => {
			await this.ctx.storage.put<StoredInviteToken>(key, { v: 1, userId });
			await this.ctx.storage.put<StoredBot>(INVITE_KEY_PREFIX + userId, { v: 1, tokenKey: key });
		}));
		this.sendNotice(socket, roomId, [
			`Created \`${userId}\`, who signs in with this token instead of a passkey. It does not expire, and anyone who has it signs in as \`${userId}\`, so hand it over privately. \`/purge ${userId}\` removes them and the token.`,
			"```\n" + token + "\n```",
			`To sign in, authenticate with the token scheme: \`{"method": "auth", "params": {"scheme": "token", "token": "${token}"}}\``,
		].join("\n\n"));
		this.reply(socket, request, {});
	}

	/** After `/rename`, points the user's invite token, if any, at the new `user_id`. */
	private async moveInviteToken(from: string, to: string): Promise<void> {
		await this.withSessionLock(() => this.store.withMeterAsync("foreground", { reads: 1, writes: 3 }, async () => {
			const pointer = await this.ctx.storage.get<StoredBot>(INVITE_KEY_PREFIX + from);
			if (pointer?.v !== 1 || typeof pointer.tokenKey !== "string") return;
			await this.ctx.storage.put<StoredInviteToken>(pointer.tokenKey, { v: 1, userId: to });
			await this.ctx.storage.put<StoredBot>(INVITE_KEY_PREFIX + to, pointer);
			await this.ctx.storage.delete(INVITE_KEY_PREFIX + from);
		}));
	}

	/**
	 * A connection's user as a current object (§3.3): `you`, `new`, and room
	 * `users`. A registered user's carries `roles`, `[]` when the user has none
	 * (§3.3: an empty value means cleared), so any current object clears a
	 * role the user lost, even for a client that missed the `user`
	 * notification. Guests carry no `roles`.
	 */
	private current(attachment: ConnectionAttachment): PublicUser | null {
		const user = currentUser(attachment);
		return user && attachment.tier === "registered" ? { ...user, roles: attachment.roles ?? [] } : user;
	}

	/**
	 * A registered user's current object (§3.3) whether or not they are
	 * connected: from a live connection, else their stored identity (one
	 * read). Null for an unknown user.
	 */
	private currentOf(userId: string): { user: PublicUser; rooms: string[] } | null {
		for (const peer of this.connectionsOf(userId)) {
			const state = connectionAttachment(peer);
			const user = state && !state.closing ? this.current(state) : null;
			if (user) return { user, rooms: this.liveRoomsOf(userId) ?? state!.rooms ?? [] };
		}
		const stored = this.store.getIdentity(userId);
		if (!stored) return null;
		return {
			user: { user_id: userId, ...(stored.name ? { name: stored.name } : {}), ...(stored.avatar ? { avatar: stored.avatar } : {}), roles: stored.roles },
			rooms: stored.rooms,
		};
	}

	/** Sends one connection a `~private` markdown notice in a room (Appendix A.1). */
	private sendNotice(socket: WebSocketConnection, roomId: string, text: string): void {
		this.send(socket, { method: "message", params: { room_id: roomId, from: { ...PRIVATE_IDENTITY }, body: { text, format: "markdown" } } });
	}

	/**
	 * `/admin <user_id>`: gives a registered user (not a bot or guest) the
	 * `admin` role; `/admin remove <user_id>` takes it away (not from `admin`
	 * itself). The sender gets a `~private` notice before the result (§1).
	 */
	private grantAdmin(socket: WebSocketConnection, request: RequestFrame, roomId: string, userId: string, remove = false): void {
		const { changed, who } = this.changeRole(userId, "admin", !remove);
		const text = remove
			? (changed ? `${who} is no longer an admin.` : `${who} was not an admin.`)
			: (changed ? `${who} is now an admin.` : `${who} is already an admin.`);
		this.sendNotice(socket, roomId, text);
		this.reply(socket, request, {});
	}

	/**
	 * `/role <user_id>`: tells the sender a user's roles. `/role <user_id>
	 * <role>` gives them the role, or takes it away when they have it. Any
	 * role name is a label shown in `roles` (§3.3); `admin` also lets them run
	 * the admin commands, and `bot` makes them a bot. The sender gets a
	 * `~private` notice before the result (§1).
	 */
	private role(socket: WebSocketConnection, request: RequestFrame, roomId: string, target: string, requested?: string): void {
		const userId = target.replace(/^@/, "");
		if (requested === undefined) {
			const identity = userId.startsWith("guest_") ? null : this.store.getIdentity(userId);
			if (!identity) throw { name: "invalid_params", message: `No registered user has the user_id ${userId}`.slice(0, 200) } satisfies ProtocolError;
			const who = `**${identity.name || userId}** (\`${userId}\`)`;
			this.sendNotice(socket, roomId, identity.roles.length ? `${who} has the roles ${identity.roles.map((role) => `\`${role}\``).join(", ")}.` : `${who} has no roles.`);
			this.reply(socket, request, {});
			return;
		}
		const role = requested.toLowerCase();
		const { changed, on, who } = this.changeRole(userId, role);
		const text = on
			? (changed ? `${who} now has the role \`${role}\`.` : `${who} already has the role \`${role}\`.`)
			: (changed ? `${who} no longer has the role \`${role}\`.` : `${who} did not have the role \`${role}\`.`);
		this.sendNotice(socket, roomId, text);
		this.reply(socket, request, {});
	}

	/**
	 * Gives a user a role, takes it away, or toggles it (Store.setRole). On a
	 * change the user's connections keep the new roles, and it is announced:
	 * a role change is a profile change (§3.3), `user` `you` to the user's
	 * connections and `new` to those who share a room with them, with
	 * `roles: []` when the last role went.
	 */
	private changeRole(userId: string, role: string, on?: boolean): { changed: boolean; on: boolean; who: string } {
		const result = this.store.setRole({ userId, role, on, now: nowMs() });
		const who = `**${result.name || userId}** (\`${userId}\`)`;
		if (result.changed) {
			for (const peer of this.connectionsOf(userId)) {
				const state = connectionAttachment(peer);
				if (!state) continue;
				state.roles = result.roles;
				writeAttachment(peer, state);
			}
			const current = this.currentOf(userId);
			if (current) this.announceUser(null, current.user, current.rooms);
		}
		return { changed: result.changed, on: result.on, who };
	}

	/**
	 * `/kick <user_id>`: removes a user from the room of the command, as if
	 * they had left it (§4.3.2): a registered user's leave is stored and
	 * logged, its membership going to the room's members, and a guest's
	 * leaves its connections. Either way the user's connections get
	 * `room_update` `left`; they may join again. The limits charged are the
	 * admin's. The sender gets a `~private` notice before the result (§1).
	 */
	private async kick(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, roomId: string, userId: string): Promise<void> {
		if (userId === attachment.userId) throw { name: "invalid_params", message: "You can't kick yourself; leave the room instead" } satisfies ProtocolError;
		// Thrown after the mutation: runMutation treats any other error as fatal.
		if (!await this.removeMember(attachment, roomId, userId)) throw { name: "invalid_params", message: `${userId} is not in this room`.slice(0, 200) } satisfies ProtocolError;
		this.sendNotice(socket, roomId, `Removed \`${userId}\` from this room.`);
		this.reply(socket, request, {});
	}

	/**
	 * Removes another user from a room, as if they had left it (§4.3.2), for
	 * `/kick` and `room_leave` with a `user_id`: a registered user's leave is
	 * stored and logged, charged to the remover's posting limits, and its
	 * membership goes to the room's members; a connected guest's leaves its
	 * connections. Either way the user's connections get `room_update`
	 * `left`. Returns whether the user was in the room.
	 */
	private async removeMember(attachment: ConnectionAttachment, roomId: string, userId: string): Promise<boolean> {
		if (!this.store.identityExists(userId)) {
			// A guest's rooms live in its connections only.
			const rooms = this.liveRoomsOf(userId);
			if (!rooms?.includes(roomId)) return false;
			this.setRooms(userId, rooms.filter((id) => id !== roomId));
			this.sendToUser(userId, roomUpdate("left", { room_id: roomId }));
			return true;
		}
		let changed = false;
		await this.runMutation(async () => {
			const change = this.store.changeMembership({ userId, ipKey: attachment.ipKey, roomId, join: false, now: nowMs(), actorId: attachment.userId });
			if (!change.changed) return;
			changed = true;
			if (change.membership) this.broadcastRecord(change.membership, userId);
			this.setRooms(userId, change.rooms);
			this.sendToUser(userId, leftUpdate(roomId, change.membership));
		});
		return changed;
	}

	/**
	 * `/rename <old_user_id> <new_user_id>`: gives a registered user a new
	 * `user_id` (Store.renameIdentity), retiring the old one. The user's
	 * connections become the new identity and get `user` `you`, and those who
	 * share a room with the user get `user` `new` with `old` (protocol §3.3).
	 * Their messages, reactions and membership changes are rewritten to the
	 * new `user_id` without notifications, for clients that load history
	 * again. Sessions and the user's bot keep the old `user_id`: a session for
	 * it is `denied`, and the passkey signs in as the new one.
	 */
	private async rename(socket: WebSocketConnection, request: RequestFrame, roomId: string, from: string, to: string): Promise<void> {
		if (from === ADMIN_USER_ID || to === ADMIN_USER_ID) throw { name: "invalid_params", message: "The admin user's user_id is fixed" } satisfies ProtocolError;
		assertIssuableUserId(to);
		const renamed = this.store.renameIdentity({ from, to, now: nowMs() });
		await this.moveInviteToken(from, to);
		for (const peer of this.connectionsOf(from)) {
			const state = connectionAttachment(peer);
			if (!state) continue;
			state.userId = to;
			writeAttachment(peer, state);
		}
		const identity = { user_id: to, ...(renamed.name ? { name: renamed.name } : {}), roles: renamed.roles };
		const old = { user_id: from, ...(renamed.name ? { name: renamed.name } : {}) };
		this.announceUser(null, identity, this.liveRoomsOf(to) ?? renamed.rooms, old);
		this.sendNotice(socket, roomId, `Renamed \`${from}\` to \`${to}\`.`);
		this.reply(socket, request, {});
	}

	/**
	 * `/status`: a `~private` notice to the sender with today's Cloudflare
	 * account usage against the Free plan's daily allowance (refreshed now
	 * when account analytics are configured, at most once a minute), and the
	 * object's own daily reservations against their budgets.
	 */
	private async sendStatus(socket: WebSocketConnection, request: RequestFrame, roomId: string): Promise<void> {
		const now = nowMs();
		await this.refreshAccountUsage(this.runtimeEnv, now, true);
		const { budget, identities, databaseBytes } = this.store.status(now);
		const limits = this.config.limits;
		const count = (value: number) => Math.round(value).toLocaleString("en-US");
		const share = (used: number, limit: number) => `${count(used)} / ${count(limit)} (${limit > 0 ? Math.round((100 * used) / limit) : 0}%)`;
		const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
		const lines: string[] = [];
		const usage = this.accountUsageSnapshot;
		const daily = ACCOUNT_USAGE_POLICY.daily;
		if (usage) {
			lines.push(
				`**Cloudflare account, ${usage.day}** (sampled ${new Date(usage.sampledAt).toISOString().slice(11, 16)} UTC${usage.stop ? ", **stopped**: over " + Math.round(ACCOUNT_USAGE_POLICY.stopRatio * 100) + "% of a limit" : ""})`,
				"",
				`| | Used / ${PLAN.name} daily |`,
				"|---|---|",
				`| Worker requests | ${share(usage.workerRequests, daily.workerRequests)} |`,
				`| Durable Object requests | ${share(usage.durableObjectRequests, daily.durableObjectRequests)} |`,
				`| Durable Object duration (GB-s) | ${share(usage.durableObjectDurationGbSeconds, daily.durableObjectDurationGbSeconds)} |`,
				`| SQL rows read | ${share(usage.sqlRowsRead, daily.sqlRowsRead)} |`,
				`| SQL rows written | ${share(usage.sqlRowsWritten, daily.sqlRowsWritten)} |`,
				`| Stored | ${mib(usage.storedBytes)} / ${mib(ACCOUNT_USAGE_POLICY.storedBytes)} |`,
			);
			const r2 = ACCOUNT_USAGE_POLICY.r2;
			if (r2 && usage.r2) {
				lines.push(
					`| R2 Class A operations | ${share(usage.r2.classAOperations, r2.classAOperationsMonthly / 31)} |`,
					`| R2 Class B operations | ${share(usage.r2.classBOperations, r2.classBOperationsMonthly / 31)} |`,
					`| R2 stored | ${mib(usage.r2.storedBytes)} / ${mib(r2.storedBytes)} |`,
				);
			}
			const monthly = ACCOUNT_USAGE_POLICY.monthly;
			if (monthly && usage.month) {
				const month = usage.month;
				lines.push(
					"",
					`| ${month.month} | Used / ${PLAN.name} monthly (stops at ${Math.round((ACCOUNT_USAGE_POLICY.monthlyStopRatio ?? ACCOUNT_USAGE_POLICY.stopRatio) * 100)}%) |`,
					"|---|---|",
					`| Worker requests | ${share(month.workerRequests, monthly.workerRequests)} |`,
					`| Worker CPU (ms) | ${share(month.workerCpuMs, monthly.workerCpuMs)} |`,
					`| Durable Object requests | ${share(month.durableObjectRequests, monthly.durableObjectRequests)} |`,
					`| Durable Object duration (GB-s) | ${share(month.durableObjectDurationGbSeconds, monthly.durableObjectDurationGbSeconds)} |`,
					`| SQL rows read | ${share(month.sqlRowsRead, monthly.sqlRowsRead)} |`,
					`| SQL rows written | ${share(month.sqlRowsWritten, monthly.sqlRowsWritten)} |`,
					`| Log events | ${share(month.logEvents, monthly.logEvents)} |`,
				);
				if (r2 && month.r2) {
					lines.push(
						`| R2 Class A operations | ${share(month.r2.classAOperations, r2.classAOperationsMonthly)} |`,
						`| R2 Class B operations | ${share(month.r2.classBOperations, r2.classBOperationsMonthly)} |`,
					);
				}
			}
		} else {
			lines.push("**Cloudflare account**: no usage sample; set `ACCOUNT_ID` and `ACCOUNT_ANALYTICS_TOKEN` to read it.");
		}
		lines.push(
			"",
			`**Demo budgets, ${budget.day}** (reserved by this object)`,
			"",
			"| | Reserved / Budget |",
			"|---|---|",
			`| SQL rows read | ${share(budget.reads, limits.sqlReadsPerDay)} |`,
			`| SQL rows written | ${share(budget.writes, limits.sqlWritesPerDay)} |`,
			`| Frames | ${share(budget.frames, limits.processedFramesPerDay)} |`,
			`| Connection admissions | ${share(budget.admissions, limits.connectionAdmissionsPerDay)} |`,
			`| Posts | ${share(budget.posts, limits.globalPostsPerDay)} |`,
			`| Registrations | ${share(budget.registrations, limits.registrationsPerDay)} |`,
			...(this.config.push && PUSH_POLICY ? [`| Pushes | ${share(this.store.pushesToday(now), PUSH_POLICY.pushesPerDay)} |`] : []),
			`| Registered users | ${share(identities, limits.registeredIdentityCount)} |`,
			`| Open connections | ${share(this.ctx.getWebSockets().length, limits.openConnections)} |`,
			`| Database | ${databaseBytes === null ? "unknown" : mib(databaseBytes)} / ${mib(limits.databaseHardTargetBytes)} |`,
		);
		this.sendNotice(socket, roomId, lines.join("\n"));
		this.reply(socket, request, {});
	}

	/**
	 * `/invite-bot`: creates the sender's bot, `bot_<user_id>` named after
	 * the sender, or renames it after the sender's current name, and mints its
	 * bearer token. The token replaces the last one, whose connections close.
	 * It goes to this connection only, in a `~private` notice (Appendix A.1),
	 * before the result (§1).
	 */
	private async inviteBot(socket: WebSocketConnection, attachment: ConnectionAttachment, request: RequestFrame, roomId: string): Promise<void> {
		const ownerId = attachment.userId!;
		const botId = BOT_ID_PREFIX + ownerId;
		const name = botName(attachment.name || ownerId, this.config.limits);
		let bot!: ReturnType<Store["registerBot"]>;
		await this.runMutation(async () => {
			bot = this.store.registerBot({ ownerId, botId, name, now: nowMs(), ipKey: attachment.ipKey });
			// A new bot's logged join of `general` goes to its members (§4.3.2).
			for (const record of bot.broadcasts) this.broadcastRecord(record);
		});
		const token = await this.issueBotToken(botId, ownerId);
		for (const peer of this.connectionsOf(botId)) {
			const state = connectionAttachment(peer);
			if (state) this.closePolicy(peer, state, 1008, "Bot token replaced; sign in with the new one");
		}
		// Those who share a room with the bot see its new name (§3.3).
		if (bot.renamed) {
			const stored = this.store.getIdentity(botId);
			this.announceUser(socket, { user_id: botId, name, roles: stored?.roles ?? ["bot"] }, stored?.rooms ?? []);
		}
		const endpoint = connectionAttachment(socket)?.endpoint ?? attachment.endpoint ?? "this server's WebSocket URL";
		this.send(socket, {
			method: "message",
			params: {
				room_id: roomId,
				from: { ...PRIVATE_IDENTITY },
				body: {
					text: [
						`Your bot signs in as **${name}** (\`${botId}\`) with this token. It replaces any earlier one, and anyone who has it can post as your bot, so keep it secret.`,
						"```\n" + token + "\n```",
						"If you're using an LLM, you can give it these instructions:",
						"```\n" + [
							`Read ${PROTOCOL_URL}`,
							`Connect to ${endpoint}`,
							`Auth using token scheme with this token: "${token}"`,
							"Say hello when you join and listen for messages",
						].join("\n") + "\n```",
					].join("\n\n"),
					format: "markdown",
				},
			},
		});
		this.reply(socket, request, {});
	}

	/**
	 * Each room's members as `room_list` and `room_update` `joined` carry them
	 * (§4.3.1), in `user_id` order with their current objects: the registered
	 * members stored with the room, at most `roomListMembers` per room, and
	 * every connected user who has joined it, guests included, whose
	 * memberships live in their connections. `totals` gets each room's
	 * `member_count` (§4.3.1) where that leaves members out.
	 */
	private membersOf(roomIds: readonly string[], totals?: Map<string, number>): Map<string, PublicUser[]> {
		const counts = new Map<string, number>();
		const stored = this.store.roomMembers(roomIds, this.config.limits.roomListMembers, nowMs(), counts);
		const connected = this.connectedMembers();
		const members = new Map<string, PublicUser[]>();
		for (const roomId of new Set(roomIds)) {
			const users = new Map<string, PublicUser>();
			for (const member of stored.get(roomId) ?? []) users.set(member.user_id, member);
			for (const member of connected.get(roomId) ?? []) if (!users.has(member.user_id)) users.set(member.user_id, member);
			members.set(roomId, sortedUsers(users.values()));
			// A room past `roomListMembers` registered members lists only some of
			// them: the total is every stored member and every connected guest.
			const registered = counts.get(roomId);
			if (totals && registered !== undefined) {
				const guests = (connected.get(roomId) ?? []).filter((member) => member.user_id.startsWith("guest_")).length;
				if (registered + guests > users.size) totals.set(roomId, registered + guests);
			}
		}
		return members;
	}

	/**
	 * A `room_update` `joined` for one room (§4.3.3): its record with its
	 * `members` as bare `{user_id}`, and `users`, their current objects.
	 * `joiner` is added to the members read before the join, and to `total`,
	 * their `member_count` when those leave some out.
	 */
	private joinedUpdate(room: RoomRecord, members: readonly PublicUser[] = [], joiner?: PublicUser, total?: number, membership?: Broadcast): Record<string, unknown> {
		const users = new Map(members.map((member) => [member.user_id, member]));
		const count = total === undefined ? undefined : total + (joiner && !users.has(joiner.user_id) ? 1 : 0);
		if (joiner) users.set(joiner.user_id, joiner);
		const sorted = sortedUsers(users.values());
		const listed: ListedRoom = { ...room, members: sorted.map((member) => ({ user_id: member.user_id })) };
		if (count !== undefined && count > sorted.length) listed.member_count = count;
		return { method: "room_update", params: { joined: [listed], ...(membership ? { memberships: [membership.params] } : {}), users: sorted } };
	}

	/** Each room's members connected now: users who have joined it, one entry each. */
	private connectedMembers(): Map<string, PublicUser[]> {
		this.closeStale(nowMs());
		const members = new Map<string, Map<string, PublicUser>>();
		for (const peer of this.ctx.getWebSockets()) {
			const state = connectionAttachment(peer as WebSocketConnection);
			const identity = state && !state.closing ? this.current(state) : null;
			if (!identity) continue;
			for (const roomId of state!.rooms ?? []) {
				let listed = members.get(roomId);
				if (!listed) members.set(roomId, listed = new Map());
				listed.set(identity.user_id, identity);
			}
		}
		return new Map([...members].map(([roomId, listed]) => [roomId, [...listed.values()]]));
	}

	/**
	 * Whether a connection's peer has gone quiet: it has sent the liveness
	 * ping, but neither that nor any frame within the timeout. The runtime
	 * cannot ping, so a peer that vanished without a close frame (sleep, a
	 * network change) otherwise stays connected until the edge gives up on it.
	 * A connection that never pinged is never judged stale.
	 */
	private isStale(socket: WebSocket, now: number): boolean {
		const pinged = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime();
		if (pinged === undefined) return false;
		const frames = connectionAttachment(socket as WebSocketConnection)?.frameTimes ?? [];
		const heard = Math.max(pinged, frames[frames.length - 1] ?? 0);
		return heard <= now - this.config.limits.pingTimeoutSeconds * 1_000;
	}

	/**
	 * Closes stale connections. Nothing schedules this: it runs where a stale
	 * peer would be seen, before `members` are listed and before admission.
	 */
	private closeStale(now: number): void {
		const sockets = this.ctx.getWebSockets();
		let closed = 0;
		for (const ws of sockets) {
			const socket = ws as WebSocketConnection;
			const attachment = connectionAttachment(socket);
			if (!attachment || attachment.closing || !this.isStale(socket, now)) continue;
			attachment.closing = true;
			writeAttachment(socket, attachment);
			try { socket.close(1001, "Connection idle; reconnect to recover"); } catch { /* already closed */ }
			closed++;
		}
		// Shows in Workers Logs whether vanished peers are being found.
		if (closed) console.log(JSON.stringify({ event: "stale_connections_closed", closed, sockets: sockets.length }));
	}

	/**
	 * Sends an identity change (§3.3), `user` a current object (with `roles`
	 * for a registered user): `you` to the user's other connections,
	 * and `new` (with `old` when the `user_id` changed) to the connections of
	 * everyone else who shares one of `rooms` with the user. Joins and leaves
	 * are memberships, never `user` notifications (§4.3.2).
	 */
	private announceUser(origin: WebSocketConnection | null, user: PublicUser | null, rooms: readonly string[], old?: { user_id: string; name?: string } | null): void {
		if (!user) return;
		const identity = user;
		const shared = new Set(rooms);
		for (const peer of this.ctx.getWebSockets()) {
			const socket = peer as WebSocketConnection;
			if (socket === origin) continue;
			const state = connectionAttachment(socket);
			if (!state) continue;
			if (state.userId === identity.user_id) this.deliverTo(socket, { method: "user", params: { you: identity } });
			else if (state.rooms?.some((id) => shared.has(id))) this.deliverTo(socket, { method: "user", params: { new: identity, ...(old ? { old } : {}) } });
		}
	}

	/** Authenticated, open connections of one user. */
	private connectionsOf(userId: string, except?: WebSocketConnection): WebSocketConnection[] {
		return this.ctx.getWebSockets().filter((peer) => {
			if (peer === except || !openSocket(peer)) return false;
			const state = connectionAttachment(peer as WebSocketConnection);
			return !!state && !state.closing && state.userId === userId && (state.tier === "anonymous" || state.tier === "registered");
		}) as WebSocketConnection[];
	}

	/** The rooms a user's other live connections have joined, if any is connected. */
	private liveRoomsOf(userId: string, except?: WebSocketConnection): string[] | undefined {
		for (const peer of this.connectionsOf(userId, except)) {
			const rooms = connectionAttachment(peer)?.rooms;
			if (rooms) return [...rooms];
		}
		return undefined;
	}

	/** Sets a user's joined rooms on every one of their connections. */
	private setRooms(userId: string, rooms: readonly string[]): void {
		const unique = [...new Set(rooms)].slice(0, MAX_ATTACHED_ROOMS);
		for (const peer of this.connectionsOf(userId)) {
			const state = connectionAttachment(peer);
			if (!state) continue;
			state.rooms = [...unique];
			writeAttachment(peer, state);
		}
	}

	/** Sends a frame to every connection of one user. */
	private sendToUser(userId: string, value: unknown): void {
		for (const peer of this.connectionsOf(userId)) this.deliverTo(peer, value);
	}

	/**
	 * Removed thread rooms (their entire log expired): their members leave
	 * them and are told with `room_update` `left` (§4.3.3).
	 */
	private removeRooms(roomIds: readonly string[]): void {
		const removed = new Set(roomIds);
		for (const ws of this.ctx.getWebSockets()) {
			const socket = ws as WebSocketConnection;
			const state = connectionAttachment(socket);
			if (!state?.rooms?.some((id) => removed.has(id))) continue;
			const left = state.rooms.filter((id) => removed.has(id));
			state.rooms = state.rooms.filter((id) => !removed.has(id));
			writeAttachment(socket, state);
			this.deliverTo(socket, { method: "room_update", params: { left: left.map((room_id) => ({ room_id })) } });
		}
	}

	/**
	 * Rooms whose delivery fields changed, such as a raised `history_log_id`,
	 * as `room_update` `updated` to the members of each room and of its parent.
	 */
	private announceUpdated(rooms: readonly RoomRecord[]): void {
		if (!rooms.length) return;
		for (const ws of this.ctx.getWebSockets()) {
			const socket = ws as WebSocketConnection;
			const joined = new Set(connectionAttachment(socket)?.rooms ?? []);
			const relevant = rooms.filter((room) => joined.has(room.room_id) || (room.parent_room_id !== undefined && joined.has(room.parent_room_id)));
			if (relevant.length) this.deliverTo(socket, { method: "room_update", params: { updated: relevant } });
		}
	}

	private noteRoom(roomId: string, exists: boolean): void {
		this.knownRooms.delete(roomId);
		// The rooms table is capped; unknown IDs are bounded by the same size.
		if (this.knownRooms.size >= 2 * (this.config.limits.threadLimit + 1)) this.knownRooms.delete(this.knownRooms.keys().next().value!);
		this.knownRooms.set(roomId, exists);
	}

	/** Whether a room exists, from the cache or one bounded lookup. */
	private roomExists(roomId: string): boolean {
		const known = this.knownRooms.get(roomId);
		if (known !== undefined) return known;
		const exists = this.store.getRoom(roomId, nowMs()) !== null;
		this.noteRoom(roomId, exists);
		return exists;
	}

	/** Events of one type from a user's connections within the window. */
	private throttleEvents(userId: string, type: ThrottledType, now: number): number[] {
		const events: number[] = [];
		for (const peer of this.ctx.getWebSockets()) {
			const state = connectionAttachment(peer as WebSocketConnection);
			if (state?.userId !== userId) continue;
			for (const at of state.throttles?.[type] ?? []) if (at > now - THROTTLE_WINDOW_MS) events.push(at);
		}
		return events.sort((a, b) => a - b);
	}

	/** Seconds until the user may send one more of this type, or undefined when they may now. */
	private throttleRetry(userId: string, type: ThrottledType, limit: number, now: number): number | undefined {
		const events = this.throttleEvents(userId, type, now);
		if (events.length < limit) return undefined;
		return Math.max(1, Math.ceil((events[events.length - limit] + THROTTLE_WINDOW_MS - now) / 1_000));
	}

	/** Counts one event against the user's per-type limit; false when the limit is reached. */
	private takeThrottle(socket: WebSocketConnection, userId: string, type: ThrottledType, limit: number, now: number): boolean {
		if (this.throttleRetry(userId, type, limit, now) !== undefined) return false;
		const state = connectionAttachment(socket);
		if (!state) return false;
		const events = (state.throttles?.[type] ?? []).filter((at) => at > now - THROTTLE_WINDOW_MS);
		state.throttles = { ...state.throttles, [type]: [...events, now].slice(-MAX_TYPE_THROTTLE_PER_MINUTE) };
		writeAttachment(socket, state);
		return true;
	}

	/**
	 * Tells a throttled sender, once per window per user, with a `~private`
	 * notice (Appendix A.1) in the room they were active in. It goes to that
	 * connection only, is never logged, and carries no message_id or log_id.
	 */
	private noticeThrottled(socket: WebSocketConnection, userId: string, type: ThrottledType, roomId: string, now: number, text: string): void {
		for (const peer of this.ctx.getWebSockets()) {
			const state = connectionAttachment(peer as WebSocketConnection);
			if (state?.userId === userId && (state.notices?.[type] ?? 0) > now - THROTTLE_WINDOW_MS) return;
		}
		const state = connectionAttachment(socket);
		if (!state) return;
		state.notices = { ...state.notices, [type]: now };
		writeAttachment(socket, state);
		this.deliverTo(socket, {
			method: "message",
			params: { room_id: roomId, from: { ...PRIVATE_IDENTITY }, body: { text, format: "plain" } },
		});
	}

	private async runMutation(fn: () => Promise<void>): Promise<void> {
		const prior = this.mutationTail;
		let release!: () => void;
		this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
		await prior;
		try { await fn(); }
		catch (error) {
			if (!(error instanceof StoreError) || error.code === "internal_error") {
				// A platform/accounting failure may make commit visibility uncertain.
				// Force recovery so no recipient can silently skip a durable record.
				for (const peer of this.ctx.getWebSockets()) {
					const state = connectionAttachment(peer);
					if (state) this.closePolicy(peer, state, 1011, "Delivery interrupted; reconnect to recover");
				}
			}
			throw error;
		} finally { release(); }
	}

	/**
	 * Delivers one committed record to the members of the rooms it belongs to
	 * (§3.4): a moved message's snapshot reaches both rooms' members in one
	 * frame, delivered once per connection (section 3.5).
	 */
	/**
	 * A result with each new upload's `write_url` (§4.6.3) signed in place of
	 * the `write` the store keeps, so a retry signs the same URL.
	 */
	private async withWriteUrls(result: Record<string, unknown>): Promise<Record<string, unknown>> {
		const uploads = this.config.uploads;
		if (!uploads || !Array.isArray(result.embeds)) return result;
		const embeds = await Promise.all(result.embeds.map(async (embed: unknown) => {
			if (!embed || typeof embed !== "object") return embed;
			const { write, ...rest } = embed as Record<string, unknown>;
			const grant = write as { key?: unknown; max_bytes?: unknown; expires_ms?: unknown } | undefined;
			if (!grant || typeof grant.key !== "string" || typeof grant.max_bytes !== "number" || typeof grant.expires_ms !== "number") return embed;
			const token = await signUploadToken(uploads.signingKey, { key: grant.key, maxBytes: grant.max_bytes, expiresMs: grant.expires_ms });
			return { ...rest, write_url: `${uploads.publicOrigin}/w/${token}` };
		}));
		return { ...result, embeds };
	}

	/** Deletes the R2 objects an operation released and notes new write deadlines; returns whether any upload started. */
	private afterUploads(result: Pick<StoreMutationResult, "uploads" | "deletedUploads">): boolean {
		this.deleteMedia(result.deletedUploads ?? []);
		let started = false;
		for (const upload of result.uploads ?? []) {
			const due = upload.writeExpiresMs + UPLOAD_WRITE_GRACE_MS;
			this.uploadDeadline = this.uploadDeadline === undefined ? due : Math.min(this.uploadDeadline, due);
			started = true;
		}
		return started;
	}

	/** Deletes R2 objects after the response; a failure leaves them to the bucket's lifecycle rules. */
	private deleteMedia(keys: readonly string[]): void {
		const media = this.runtimeEnv.MEDIA;
		if (!media || !keys.length) return;
		for (let start = 0; start < keys.length; start += 1_000) {
			this.ctx.waitUntil(media.delete(keys.slice(start, start + 1_000)).catch(() => undefined));
		}
	}

	/**
	 * Writes a signed-in user's avatar again when it nears its expiry, which
	 * restarts the bucket's lifecycle clock for it: an avatar lasts while its
	 * owner keeps signing in. One whose object is already gone is removed.
	 */
	private refreshAvatar(userId: string): void {
		const media = this.runtimeEnv.MEDIA;
		if (!this.config.uploads || !media) return;
		this.ctx.waitUntil((async () => {
			const key = this.store.avatarRefreshDue(userId, nowMs());
			if (!key) return;
			const object = await media.get(key);
			if (!object) {
				const cleared = this.store.clearAvatar({ userId, now: nowMs() });
				if (cleared.changed) this.announceAvatar(userId, "");
				return;
			}
			await media.put(key, await object.arrayBuffer(), { httpMetadata: object.httpMetadata });
			this.store.renewAvatar({ userId, key, now: nowMs() });
		})().catch(() => undefined));
	}

	/**
	 * A user's avatar changed (§4.6.6): their connections keep it, they get
	 * `user` `you`, and those who share a room with them `user` `new`. An empty
	 * `avatar` announces a removed one.
	 */
	private announceAvatar(userId: string, avatar: string): void {
		const connections = this.connectionsOf(userId);
		for (const peer of connections) {
			const state = connectionAttachment(peer);
			if (!state) continue;
			setAvatar(state, avatar);
			writeAttachment(peer, state);
		}
		const connected = connections.length ? connectionAttachment(connections[0]) : null;
		const stored = connected ? null : this.store.getIdentity(userId);
		const name = connected?.name ?? stored?.name;
		const rooms = this.liveRoomsOf(userId) ?? stored?.rooms ?? [];
		const roles = connected?.roles ?? stored?.roles ?? [];
		this.announceUser(null, { user_id: userId, ...(name ? { name } : {}), avatar, roles }, rooms);
	}

	/**
	 * Called by the entry Worker before it stores a write (§4.6.3): whether
	 * this upload is waiting for one. Only one request may write it.
	 */
	async claimUpload(key: string): Promise<boolean> {
		return !!this.config.uploads && this.store.claimUpload(key, nowMs());
	}

	/**
	 * Called by the entry Worker when a claimed write finished or failed
	 * (§4.6.3). A file's message gets its new snapshot; an avatar becomes its
	 * owner's. Returns whether the write was accepted; if not, the Worker
	 * deletes what it stored.
	 */
	async finishUpload(write: UploadWrite): Promise<boolean> {
		if (!this.config.uploads) return false;
		let finished: UploadFinish = { accepted: false, broadcasts: [], deletedUploads: [] };
		await this.runMutation(async () => {
			finished = this.store.finishUpload(write, nowMs());
			for (const record of finished.broadcasts) this.broadcastRecord(record);
		});
		this.deleteMedia(finished.deletedUploads);
		if (finished.avatar) this.announceAvatar(finished.avatar.userId, finished.avatar.url);
		return finished.accepted;
	}

	/**
	 * Delivers one committed record to the members of the rooms it belongs to.
	 * A membership record goes in `room_update` `memberships` (§4.3.3); with
	 * `exceptUser`, not to that user's connections, which get it together with
	 * their `joined` or `left`.
	 */
	private broadcastRecord(record: Broadcast, exceptUser?: string): void {
		const frame = record.method === "membership"
			? { method: "room_update", params: { memberships: [record.params] } }
			: { method: record.method, params: record.params };
		this.deliver(frame, record.rooms, exceptUser === undefined ? undefined : (state) => state.userId !== exceptUser);
	}

	/**
	 * Sends to every authenticated connection whose user has joined one of
	 * `rooms` and passes `filter`, except `except`.
	 */
	private deliver(value: unknown, rooms: readonly string[], filter?: (state: ConnectionAttachment) => boolean, except?: WebSocketConnection): void {
		for (const ws of this.ctx.getWebSockets()) {
			const socket = ws as WebSocketConnection;
			if (socket === except) continue;
			const state = connectionAttachment(socket);
			if (!state?.rooms?.some((id) => rooms.includes(id)) || (filter && !filter(state))) continue;
			this.deliverTo(socket, value);
		}
	}

	/** Sends to one connection if it is authenticated; a failed send closes it so its client recovers. */
	private deliverTo(socket: WebSocketConnection, value: unknown): void {
		const attachment = connectionAttachment(socket);
		if (!attachment || attachment.closing || (attachment.tier !== "anonymous" && attachment.tier !== "registered")) return;
		if (!this.send(socket, value)) {
			attachment.closing = true;
			writeAttachment(socket, attachment);
			try { socket.close(1011, "Delivery failed; reconnect to recover"); } catch { /* closed */ }
		}
	}

	private recordViolation(socket: WebSocketConnection, error: ProtocolError): void {
		if (!["parse_error", "invalid_request", "invalid_params", "too_large"].includes(error.name)) return;
		const state = connectionAttachment(socket);
		if (!state || state.closing) return;
		state.policyViolations = [...state.policyViolations.filter(time => time > nowMs() - 60_000), nowMs()];
		if (state.policyViolations.length >= this.config.limits.repeatedPolicyViolations) this.closePolicy(socket, state, 1008, "Repeated policy violations");
		else writeAttachment(socket, state);
	}

	private rescheduleAlarm(): Promise<void> {
		const task = this.alarmTail.catch(() => undefined).then(async () => {
			let deadline: number | undefined;
			for (const socket of this.ctx.getWebSockets()) {
				const state = connectionAttachment(socket);
				if (!state || state.closing) continue;
				const due = [state.tier === "pending" ? state.authDeadline : undefined, state.challenge?.expiresAt]
					.filter((value): value is number => value !== undefined);
				for (const value of due) deadline = deadline === undefined ? value : Math.min(deadline, value);
			}
			if (this.uploadDeadline !== undefined) deadline = deadline === undefined ? this.uploadDeadline : Math.min(deadline, this.uploadDeadline);
			await this.store.scheduleAlarm(deadline, nowMs());
			this.alarmKnown = true;
		});
		this.alarmTail = task;
		// A failed alarm setup remains recoverable on the next admitted activity.
		return task.catch(() => {
			this.alarmKnown = false;
			this.alarmFailures++;
			if ((this.alarmFailures & (this.alarmFailures - 1)) === 0) console.warn(JSON.stringify({ event: "alarm_setup_failed", count: this.alarmFailures }));
		});
	}

	private accountUsageBlocked(now: number): boolean {
		return this.accountUsageSnapshot?.day === new Date(now).toISOString().slice(0, 10) && this.accountUsageSnapshot.stop;
	}

	private noteAccountUsageActivity(env: Env): void {
		if (!env.ACCOUNT_ID || !env.ACCOUNT_ANALYTICS_TOKEN) return;
		this.accountUsageEvents += 1;
		const now = nowMs();
		const stale = !this.accountUsageSnapshot || now - this.accountUsageSnapshot.sampledAt >= ACCOUNT_USAGE_POLICY.staleAfterMs;
		if (this.accountUsageEvents < ACCOUNT_USAGE_POLICY.refreshEveryEvents && !stale) return;
		// Keep the refresh alive after the request returns without adding its latency
		// to the admitted WebSocket attempt.
		this.ctx.waitUntil(this.refreshAccountUsage(env, now, false));
	}

	private async refreshAccountUsage(env: Env, now: number, forced: boolean): Promise<void> {
		if (!env.ACCOUNT_ID || !env.ACCOUNT_ANALYTICS_TOKEN) return;
		if (this.accountUsageRefresh) return this.accountUsageRefresh;
		if (!forced && now < this.accountUsageRetryAt) return;
		if (this.accountUsageSnapshot && now - this.accountUsageSnapshot.sampledAt < ACCOUNT_USAGE_POLICY.minimumRefreshIntervalMs) return;
		this.accountUsageEvents = 0;
		const task = (async () => {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5_000);
			try {
				const snapshot = await fetchAccountUsage(env, now, controller.signal);
				// Bounded confirmation per instance and after recovery; no sensitive data.
				if (!this.accountUsageVerified || this.accountUsageFailureCount > 0) {
					console.info(JSON.stringify({ event: "account_usage_refresh_succeeded", sampledAt: snapshot.sampledAt, stop: snapshot.stop }));
				}
				this.accountUsageVerified = true;
				try { this.store.persistAccountUsageSnapshot(snapshot, now); } catch { /* retain the in-memory safety stop */ }
				this.accountUsageSnapshot = snapshot;
				this.accountUsageFailureCount = 0;
				this.accountUsageRetryAt = 0;
				if (snapshot.stop) {
					for (const peer of this.ctx.getWebSockets()) {
						const state = connectionAttachment(peer);
						if (state) this.closePolicy(peer as WebSocketConnection, state, 1013, "Demo account capacity reached; try later");
					}
				}
			} catch {
				this.accountUsageFailureCount += 1;
				const delay = Math.min(ACCOUNT_USAGE_POLICY.maxRetryMs, ACCOUNT_USAGE_POLICY.initialRetryMs * 2 ** Math.min(this.accountUsageFailureCount - 1, 4));
				this.accountUsageRetryAt = now + delay;
				if ((this.accountUsageFailureCount & (this.accountUsageFailureCount - 1)) === 0) console.warn(JSON.stringify({ event: "account_usage_refresh_failed", count: this.accountUsageFailureCount }));
			} finally {
				clearTimeout(timeout);
			}
		})();
		this.accountUsageRefresh = task;
		await task;
		this.accountUsageRefresh = undefined;
	}
}
