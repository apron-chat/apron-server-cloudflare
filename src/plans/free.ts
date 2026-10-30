// Workers Free: the policy this deployment ran on before Workers Paid, kept so
// it can switch back. Select a plan in src/budget.ts, then run
// npm run budget:generate. Free fails closed at its daily allowances, so these
// values bound the application, not the bill.
import type { Plan } from "../budget.ts";

export const FREE_PLAN: Plan = Object.freeze({
	name: "Workers Free",
	limits: Object.freeze({
		retentionSeconds: 86_400,
		cleanupSeconds: 3_600,
		challengeTtlSeconds: 120,
		sessionTtlSeconds: 30 * 24 * 60 * 60,
		maxFrameBytes: 16_384,
		maxTextBytes: 4_096,
		maxSnapshotBytes: 8_192,
		maxJsonDepth: 8,
		maxJsonNodes: 2_048,
		maxRequestIdBytes: 128,
		maxNameCodePoints: 80,
		maxNameBytes: 320,
		maxEmbeds: 4,
		historyDefaultLimit: 20,
		historyMaxLimit: 50,
		historyMaxResponseBytes: 262_144,
		historyRequestsPerUserMinute: 10,
		historyRequestsPerIpMinute: 30,
		historyBurstPerUser: 30,
		historyBurstPerIp: 60,
		historyRequestsPerUserDay: 1_000,
		historyRequestsPerIpDay: 2_000,
		// About one charged written row a page: about 6,000 rows, a tenth of
		// the foreground writes, and 5% of the frames, at most.
		historyRequestsPerDay: 5_000,
		concurrentHistoryPerConnection: 1,
		anonymousPostsPerMinute: 5,
		anonymousPostsPerDay: 100,
		registeredPostsPerMinute: 20,
		registeredPostsPerDay: 500,
		trustedPostsPerMinute: 50,
		trustedPostsPerDay: 2_000,
		ipPostsPerMinute: 30,
		ipPostsPerDay: 1_000,
		globalPostsPerMinute: 60,
		globalPostsPerDay: 5_000,
		registrationsPerIpDay: 3,
		registrationsPerDay: 100,
		registeredIdentityCount: 10_000,
		authAttemptsPerIpMinute: 10,
		openConnections: 100,
		anonymousConnectionsPerIp: 2,
		registeredConnectionsPerUser: 3,
		connectionsPerIp: 10,
		connectionAdmissionsPerIpMinute: 5,
		connectionAdmissionsPerDay: 2_000,
		unauthenticatedTimeoutSeconds: 30,
		pendingFramesPerConnection: 8,
		pendingBytesPerConnection: 131_072,
		framesPerConnectionMinute: 60,
		framesPerIpMinute: 120,
		processedFramesPerDay: 100_000,
		repeatedPolicyViolations: 3,
		globalFramesPerMinute: 300,
		activityBroadcastsPerUserMinute: 10,
		roomListRequestsPerUserMinute: 6,
		activityMaxTypingSeconds: 30,
		frameLease: 10,
		roomListMembers: 100,
		pingSeconds: 45,
		pingTimeoutSeconds: 150,
		unpingedTimeoutSeconds: 900,
		guestNumberBlock: 10,
		// Status changes are announced at most once a minute per user, and a
		// closed connection's change waits a minute, so a reload or a mobile
		// reconnect shows nothing. Both run on one in-memory timer: no SQL, no
		// alarm, no Durable Object request.
		statusCoalesceSeconds: 60,
		offlineGraceSeconds: 60,
		sqlWritesPerDay: 80_000,
		sqlReadsPerDay: 3_000_000,
		foregroundWritesPerDay: 60_000,
		maintenanceWritesPerDay: 20_000,
		foregroundReadsPerDay: 2_500_000,
		maintenanceReadsPerDay: 500_000,
		databaseHighWaterBytes: 96 * 1024 * 1024,
		databaseHardTargetBytes: 128 * 1024 * 1024,
		databaseResumeLowWaterBytes: 80 * 1024 * 1024,
		cleanupBatch: 100,
		threadLimit: 100,
		// So one account cannot take every thread slot: a quarter of them.
		threadsPerUser: 25,
		threadMetadataBytes: 2 * 1024,
		privateRoomLimit: 100,
		// Private rooms one account may have started that are still live, and
		// may be in at once: started by them or by someone who added them.
		privateRoomsPerUser: 5,
		privateMembershipsPerUser: 20,
		reactionUsersPerMessage: 32,
		reactionEmojisPerUser: 8,
		dedupTtlSeconds: 86_400,
		limiterRecordCap: 10_000,
		maxCredentialBytes: 16 * 1024,
		maxChallengeBytes: 16 * 1024,
}),
	// Attempts are counted before the Durable Object, including its later
	// rejections. This is an approximate, per-Cloudflare-location limiter, not a
	// billing cap.
	admission: Object.freeze({
		requestsPerIpMinute: 10,
		// Three busy /56s' worth: a site's networks share it, an attacker's
		// /48 does not multiply the address limit.
		requestsPerIpv6PrefixMinute: 30,
		// Twice a full reconnect of the 100 open connections, so a deploy or a
		// wake never reaches it, while an attack from one location that stays
		// under the flood trip spends a sixth of the Durable Object requests
		// it could before.
		objectRequestsPerLocationMinute: 200,
		workerWindowSeconds: 60,
		// Free WAF supports only 10-second windows; this optional rule is zone-wide.
		edgeRequestsPerIpWindow: 10,
		edgeWindowSeconds: 10,
		edgeBlockSeconds: 10,
	}),
	// Workers Free daily allowances, reset at 00:00 UTC.
	account: Object.freeze({
		daily: Object.freeze({
			workerRequests: 100_000,
			durableObjectRequests: 100_000,
			durableObjectDurationGbSeconds: 13_000,
			sqlRowsRead: 5_000_000,
			sqlRowsWritten: 100_000,
		}),
		storedBytes: 5 * 1024 * 1024 * 1024,
		// Count every incoming WebSocket message as a whole request, as the
		// analytics report them.
		webSocketMessagesPerRequest: 1,
	}),
	// Web Push for mentions and replies, on once VAPID keys are set. A wake
	// costs a subscription read and a counter write, and each push is an outbound
	// request from the Durable Object, which needs no request allowance; the
	// daily cap bounds what the push services see from the demo.
	push: Object.freeze({
		pushesPerDay: 1_000,
		wakesPerMessage: 10,
		// One sender's delivered pushes cannot spend more than a twentieth of
		// the day, and one recipient gets at most a tenth of it, so a few
		// sybils cannot use up everyone's pushes or flood one person.
		pushesPerSenderDay: 50,
		pushesPerRecipientDay: 100,
		// Every message in a moderator's joined rooms (`joined`): its own
		// allowance, apart from the 100 their mentions and replies use, and
		// charged to no sender; at most one a room every 5 minutes.
		joinedPushesPerRecipientDay: 20,
		// Each mute or status change costs a few written rows.
		mutesPerUserMinute: 6,
		// A busy conversation wakes an unattended user (no connection attended, §4.5) at most once a minute per room.
		coalesceSeconds: 60,
		joinedCoalesceSeconds: 5 * 60,
		// A wake waits half a minute, so a user back at their screen by then is not pushed too.
		delaySeconds: 30,
		subscriptionsPerUser: 5,
		// Clients register on every connection, refreshing at most daily; a
		// browser unused for a week is not pushed to.
		pushExpiryDays: 7,
		registersPerUserMinute: 10,
		ttlSeconds: 24 * 60 * 60,
	}),
	// Live text (embed:terminal, embed:append), off by default here (features
	// below; LIVE_TEXT=true turns it on). A text keeps the one object awake
	// while it streams, which the duration allowance covers (one object awake
	// all day is 10,800 of its 13,000 GB-s), and costs a Durable Object
	// request for its write and for each read: at most 30 texts a day of 15
	// reads each is 480 of the 100,000. Its rows are two posts' worth, and
	// its kept text at most 1.5 MB of a day's retention.
	liveText: Object.freeze({
		// The owner's ceilings: 120 seconds, and 300 for admins and mods.
		maxSeconds: 120,
		moderatorMaxSeconds: 300,
		// A command's write_url waits two minutes for its PUT.
		writeWindowSeconds: 120,
		terminalKeepBytes: 16 * 1024,
		maxInputBytes: 1024 * 1024,
		// The message text limit: the body never grows past it.
		appendMaxBytes: 4_096,
		// Three texts at once, then one every 3 minutes and 20 seconds; an
		// IP twice that, for two people behind one address.
		startsPerUser: 3,
		startsPerIp: 6,
		startWindowMinutes: 10,
		startsPerUserDay: 10,
		startsPerDay: 30,
		concurrent: 2,
		readersPerText: 5,
		readsPerText: 15,
	}),
	features: Object.freeze({
		activity: false,
		guestPosting: false,
		// User status: connected users' from their connection attachments,
		// with no SQL; a listing reads each listed member's chosen status
		// with them, nothing for members who never chose one or muted
		// (measured), and their `seen` from the identity row it reads anyway,
		// as a sign-in does. A registered user shown offline writes their
		// `seen` (2 charged rows, measured: the identity row and the budget
		// row) when their last connection closes, or with a chosen
		// `invisible` (4 rows, measured, where the status alone is 3), but
		// at most once in SEEN_WRITE_GRANULARITY_MS (10 minutes): within it
		// the stored one is shown again, so reloads and reconnects within it
		// write nothing, several tabs closing together write once, and one
		// account writes at most 144 a day (288 rows, 0.5% of the
		// foreground writes). Requests are already this plan's
		// scarcest allowance after SQL writes; status adds none.
		presence: true,
		// Live text: off on Free, where the demo is meant to hibernate.
		liveText: false,
	}),
});
