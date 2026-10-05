// Workers Paid ($5/month): the free plan with the budgets its larger
// allowances pay for. Select a plan in src/budget.ts, then run
// npm run budget:generate.
//
// Paid bills overage instead of failing closed, so every change below is
// sized against the monthly included usage spread over a 31-day month (the
// `account.daily` allowances) with room to spare. Paid gives 16x the SQL rows
// written and 160x the rows read of Free, but only a third of its Durable
// Object requests (1 million a month against 100,000 a day), so frame and
// connection budgets move much less than SQL ones. Worst cases at these
// values, per UTC day:
//
// - SQL rows written: the application's own ceiling, 800,000 (half the
//   1.6 million daily share). Posts, frames, and admissions all charge it
//   and fail closed at it.
// - SQL rows read: 30 million (under 4% of the 800 million daily share).
// - Durable Object requests: about 21,000 of the 32,000 daily share, from
//   150,000 frames at 20 incoming WebSocket messages a request (7,500), a full
//   100 connections pinging every 45 seconds (9,600), 4,000 admissions, and
//   alarms. Rejected connection attempts also reach the object; the
//   account-usage stop at 90% covers them.
// - Durable Object duration: one object awake all day is 10,800 GB-s, under
//   the 12,900 daily share, so duration cannot run over. User status spends
//   it rather than requests: one timer keeps the object awake up to a minute
//   after its last event while a status change waits to be announced.
// - Storage: history is kept 7 days, matching uploaded images, so the
//   database watermarks rise to 768 MB (1 GB hard), a fifth of the 5 GB-month
//   included. Cleanup runs daily; it removes the same rows a day as hourly
//   would, in batches that continue until it is caught up.
//
// None of that bounds hostile traffic that never gets past the entry Worker,
// which is billed per request. An edge block rule stops requests before they
// invoke the Worker (src/budget-guard.ts). The Worker turns it on within
// seconds of a flood; the budget guard, every minute, turns it on when usage
// reaches the daily share or `monthlyStopRatio` of the month's included
// usage, and off once usage is back under every allowance.
import type { Plan } from "../budget.ts";
import { FREE_PLAN } from "./free.ts";

export const PAID_PLAN: Plan = Object.freeze({
	name: "Workers Paid",
	limits: Object.freeze({
		...FREE_PLAN.limits,
		retentionSeconds: 7 * 24 * 60 * 60,
		cleanupSeconds: 24 * 60 * 60,
		historyRequestsPerUserMinute: 20,
		historyRequestsPerIpMinute: 60,
		anonymousPostsPerDay: 200,
		registeredPostsPerDay: 1_000,
		ipPostsPerDay: 2_000,
		globalPostsPerMinute: 120,
		globalPostsPerDay: 10_000,
		registrationsPerIpDay: 5,
		registrationsPerDay: 300,
		connectionAdmissionsPerDay: 4_000,
		processedFramesPerDay: 150_000,
		// Twice Free's spike: 20 active users among 50 connected.
		globalFramesPerMinute: 600,
		// The calibrated ceiling; members cost only reads.
		roomListMembers: 200,
		sqlWritesPerDay: 800_000,
		sqlReadsPerDay: 30_000_000,
		foregroundWritesPerDay: 700_000,
		maintenanceWritesPerDay: 100_000,
		foregroundReadsPerDay: 25_000_000,
		maintenanceReadsPerDay: 5_000_000,
		databaseHighWaterBytes: 768 * 1024 * 1024,
		databaseHardTargetBytes: 1024 * 1024 * 1024,
		databaseResumeLowWaterBytes: 640 * 1024 * 1024,
	}),
	// The per-IP attempt limiter still guards Durable Object requests, which
	// Paid includes fewer of than Free.
	admission: FREE_PLAN.admission,
	// Monthly included usage divided by 31 days, rounded down, so stopping
	// under the daily share every day keeps the month inside what $5 covers.
	account: Object.freeze({
		daily: Object.freeze({
			workerRequests: 320_000, // 10 million a month
			durableObjectRequests: 32_000, // 1 million a month
			durableObjectDurationGbSeconds: 12_900, // 400,000 GB-s a month
			sqlRowsRead: 800_000_000, // 25 billion a month
			sqlRowsWritten: 1_600_000, // 50 million a month
		}),
		storedBytes: 5 * 1024 * 1024 * 1024, // 5 GB-month
		// Paid bills 20 incoming WebSocket messages as one request; analytics
		// report each message.
		webSocketMessagesPerRequest: 20,
		// Paid bills past these instead of failing. The daily shares keep any 31
		// days under 90% of them, but each daily stop lands a detection lag
		// late; stopping usage since the start of the calendar month at
		// monthlyStopRatio bounds those overshoots too. A billing cycle overlaps
		// at most two calendar months, so at one half the cycle stays inside
		// what the plan includes even when it does not start on the 1st.
		monthly: Object.freeze({
			workerRequests: 10_000_000,
			workerCpuMs: 30_000_000,
			durableObjectRequests: 1_000_000,
			durableObjectDurationGbSeconds: 400_000,
			sqlRowsRead: 25_000_000_000,
			sqlRowsWritten: 50_000_000,
			// Workers Logs: one event per Worker or Durable Object invocation,
			// counted without the WebSocket ratio.
			logEvents: 20_000_000,
		}),
		monthlyStopRatio: 0.5,
		// R2's free tier, which covers uploads (below): billed past it too.
		r2: Object.freeze({
			classAOperationsMonthly: 1_000_000,
			classBOperationsMonthly: 10_000_000,
			storedBytes: 10 * 1024 * 1024 * 1024,
		}),
	}),
	edgeStop: Object.freeze({
		// Legitimate traffic is a few hundred requests a day in all, so 20 a
		// second at one location is a flood. Spread thinner than that over every
		// location, an attack stays within what the minute guard stops in time.
		floodRequestsPerColoMinute: 1_200,
		// Sampling keeps the per-request cost to one random number; the rate
		// limiter counts 60 sampled requests a minute.
		floodSampleEvery: 20,
		// Long enough for analytics to show the flood, so the guard's daily or
		// monthly stop takes over before the hold ends.
		holdSeconds: 30 * 60,
	}),
	// Images kept in R2 and served from its public bucket domain. At most 500
	// uploads a day are about 16,000 writes a month (1 million free), and the
	// stored-bytes cap keeps storage at half the free 10 GB-month whatever the
	// mix of sizes: 500 full-size images a day for a week would be 17.5 GB.
	uploads: Object.freeze({
		maxFileBytes: 5 * 1024 * 1024,
		maxAvatarBytes: 256 * 1024,
		uploadsPerDay: 500,
		uploadsPerUserDay: 20,
		writeWindowSeconds: 10 * 60,
		fileRetentionSeconds: 7 * 24 * 60 * 60,
		avatarRetentionSeconds: 30 * 24 * 60 * 60,
		avatarRefreshSeconds: 7 * 24 * 60 * 60,
		lifecycleLagSeconds: 24 * 60 * 60,
		storedBytesCap: 5 * 1024 * 1024 * 1024,
	}),
	// Mentions and replies wake users through Web Push (VAPID keys required): enough for
	// half the day's posts to each wake one browser.
	push: Object.freeze({
		...FREE_PLAN.push!,
		pushesPerDay: 5_000,
		pushesPerSenderDay: 200,
	}),
	features: Object.freeze({
		// Typing costs about 5 frames a typing minute, inside the frame budget.
		activity: true,
		// Guests only read, as on Free: a moderation choice, not a budget one.
		guestPosting: false,
		// User status, as on Free: connected users' from their connection
		// attachments, and a listed member's chosen status read with them
		// (nothing for members who never chose one or muted, one read at
		// worst).
		presence: true,
	}),
});
