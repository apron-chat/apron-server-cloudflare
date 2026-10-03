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
		concurrentHistoryPerConnection: 1,
		anonymousPostsPerMinute: 5,
		anonymousPostsPerDay: 100,
		registeredPostsPerMinute: 20,
		registeredPostsPerDay: 500,
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
		guestNumberBlock: 10,
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
		threadMetadataBytes: 2 * 1024,
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
		// Each mute change costs a few written rows.
		mutesPerUserMinute: 6,
		// A busy conversation wakes an away user once a minute per room.
		coalesceSeconds: 60,
		subscriptionsPerUser: 5,
		// Clients register on every connection, refreshing at most daily; a
		// browser unused for a week is not pushed to.
		pushExpiryDays: 7,
		registersPerUserMinute: 10,
		ttlSeconds: 24 * 60 * 60,
	}),
	features: Object.freeze({
		activity: false,
		guestPosting: false,
	}),
});
