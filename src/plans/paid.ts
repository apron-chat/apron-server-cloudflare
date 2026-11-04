// Workers Paid ($5/month): the free plan with the budgets its larger
// allowances pay for. Select a plan in src/budget.ts, then run
// npm run budget:generate.
//
// Paid bills overage instead of failing closed. The limits below are sized
// for a front-page day (about 40,000 visitors, a tenth registering) rather
// than a 31st of the month's inclusions: a busy day past its share costs
// nothing while the month stays inside them, and the bill cap (`billCap`)
// stops the server on the estimated overage in dollars. Worst cases at these
// values, per UTC day, priced as if the month's inclusions were spent:
//
// - SQL rows written: the application's own ceiling, 10.5 million, $10.50.
//   Posts, frames, and admissions all charge it and fail closed at it.
// - SQL rows read: 120 million, about $0.12.
// - Durable Object requests: about 600,000, from 6 million frames at 20
//   incoming WebSocket messages a request and 300,000 admissions: about
//   $0.09. Pings are answered by the runtime and not billed. Rejected connection
//   attempts also reach the object, at most `objectRequestsPerLocationMinute`
//   a minute from each location; the attack pause weighs the rest.
// - Durable Object duration: one object awake all day is 10,800 GB-s, about
//   $0.14, under the 12,900 daily share. User status spends
//   it rather than requests: one timer keeps the object awake up to a minute
//   after its last event while a status change waits to be announced.
// - Storage: history is kept 7 days, matching uploaded images, so the
//   database watermarks rise to 768 MB (1 GB hard), a fifth of the 5 GB-month
//   included. Cleanup runs daily; it removes the same rows a day as hourly
//   would, in batches that continue until it is caught up.
//
// That is about $11 a day in all, and the daily cap stops the server at $5
// first; early in a month the inclusions cover it (50 million rows written).
//
// None of that bounds hostile traffic that never gets past the entry Worker,
// which is billed per request. An edge block rule stops requests before they
// invoke the Worker (src/budget-guard.ts). The Worker turns it on within
// seconds of a flood; the budget guard, every minute, turns it on when the
// estimated overage (src/pricing.ts) passes the bill cap below, and off once
// it is back under. Usage past a daily share costs nothing while the month
// stays inside its inclusions, so a busy day runs on instead of stopping.
import type { Plan } from "../budget.ts";
import { FREE_PLAN } from "./free.ts";

export const PAID_PLAN: Plan = Object.freeze({
	name: "Workers Paid",
	limits: Object.freeze({
		...FREE_PLAN.limits,
		retentionSeconds: 7 * 24 * 60 * 60,
		// A removed account's user_id may be taken again once its messages are gone.
		retiredUserIdSeconds: 7 * 24 * 60 * 60,
		// Registered users' statuses at most 15 s late: at most 5,760 presence
		// wakes a day, about 52,000 maintenance writes of Paid's 1.5 million.
		presenceAlarmSeconds: 15,
		cleanupSeconds: 24 * 60 * 60,
		// A first visit opens every joined room's newest page at once: room
		// for 60 in a burst, then 20 a minute. A page is charged one written
		// row (its budget row), and its two limiter rows every fourth page,
		// about two on average, so an IP at its daily count writes about
		// 12,000 (under 2% of the foreground writes), and the server-wide
		// count about 80,000 (11%) and 40,000 frames (27%) at most.
		historyRequestsPerUserMinute: 20,
		historyRequestsPerIpMinute: 60,
		historyBurstPerUser: 60,
		historyBurstPerIp: 120,
		historyRequestsPerUserDay: 3_000,
		// A campus behind one address reads a lot of pages in a day.
		historyRequestsPerIpDay: 30_000,
		// A front-page day: about 40,000 visitors, each opening a few pages.
		historyRequestsPerDay: 400_000,
		anonymousPostsPerDay: 200,
		registeredPostsPerDay: 1_000,
		trustedPostsPerDay: 4_000,
		ipPostsPerDay: 2_000,
		globalPostsPerMinute: 600,
		globalPostsPerDay: 60_000,
		// A conference or office behind one address can sign up together.
		registrationsPerIpDay: 20,
		// A front-page day: up to 10% of 40,000 visitors register.
		registrationsPerDay: 5_000,
		// About 2 KB an identity with its passkey: 100 MB at the cap. Dormant
		// accounts are pruned (cleanup), so the cap is not spent for good.
		registeredIdentityCount: 50_000,
		// Every slot is room for one limiter's counters. A new address takes
		// four (admission, frames, auth, history), so this is about 125,000
		// addresses in a day: past it, a new address cannot connect until
		// cleanup. About 75 MB at the cap, well under the database watermarks.
		limiterRecordCap: 500_000,
		// The memory bound: each open connection may queue
		// pendingBytesPerConnection of incoming frames, and all of them
		// together at most MAX_SOCKET_QUEUE_ALLOCATION (32 MiB): 500 at 64 KiB.
		// Each post to a room is sent to every member's socket, so load-test
		// the broadcast before raising it further.
		openConnections: 500,
		// Up to 8 small frames in flight (pendingFramesPerConnection), or 4 of
		// the largest (16 KiB).
		pendingBytesPerConnection: 64 * 1024,
		// Pings stay at Free's 45 seconds (150 to go stale): the runtime answers
		// them without waking the object, which is not billed, and a dead
		// socket is found (freeing its slot, its user shown offline and pushed
		// again) within 150 seconds, well inside Cloudflare's idle timeout.
		// Room for an office or a campus behind one address: twenty-odd people
		// opening a shared link together, each a guest until they sign in.
		// These are fairness limits; openConnections and the daily admissions
		// below bound what they can spend.
		anonymousConnectionsPerIp: 24,
		connectionsPerIp: 32,
		// Every connection's `auth` is an attempt, guest and token sign-ins
		// too: twice every connection an address may hold, so a reconnect wave
		// signs them all in before the 30-second auth deadline.
		authAttemptsPerIpMinute: 64,
		// A sign-in costs three admissions (guest, sign-in connection, the
		// signed-in reconnect): ten people signing in at once from one address.
		connectionAdmissionsPerIpMinute: 30,
		// Each connection's first frame leases 10, so this is a few dozen
		// connections from one address starting in the same minute.
		framesPerIpMinute: 480,
		// A front-page day: 40,000 visitors, two or three connections each,
		// with room for reconnects after deploys and evictions.
		connectionAdmissionsPerDay: 300_000,
		// Every connection that sends a frame leases 10, so admissions alone
		// can spend 3 million.
		processedFramesPerDay: 6_000_000,
		// A busy minute with the server full, or a deploy's reconnect wave: 500
		// connections, a few frames each.
		globalFramesPerMinute: 5_000,
		// The calibrated ceiling; members cost only reads.
		roomListMembers: 200,
		// A guest visit from a new address writes about 30 rows and a repeat
		// one about 15, so a front-page day's connections alone write about 2
		// million; these leave room for the day's chat. Early in a month these
		// cost nothing (50 million rows written are included); a day at them
		// once the month's inclusions are spent would cost about $11, and the
		// daily bill cap stops the server at $5 first.
		sqlWritesPerDay: 10_500_000,
		sqlReadsPerDay: 120_000_000,
		foregroundWritesPerDay: 9_000_000,
		// Cleanup deletes a day's limiter rows (two writes each) besides presence
		// (about 52,000) and retention.
		maintenanceWritesPerDay: 1_500_000,
		foregroundReadsPerDay: 100_000_000,
		maintenanceReadsPerDay: 20_000_000,
		databaseHighWaterBytes: 768 * 1024 * 1024,
		databaseHardTargetBytes: 1024 * 1024 * 1024,
		databaseResumeLowWaterBytes: 640 * 1024 * 1024,
	}),
	// The attempt limiters still guard Durable Object requests: enough over
	// the 30 admissions for refused upgrades' status probes and retries. One
	// address at its limit all day is 86,400 Durable Object requests, still
	// under the per-location limit that bounds them.
	admission: Object.freeze({
		...FREE_PLAN.admission,
		requestsPerIpMinute: 60,
		// Three busy /56s' worth, as on Free.
		requestsPerIpv6PrefixMinute: 180,
		// Twice a full reconnect of the 500 open connections, as on Free.
		objectRequestsPerLocationMinute: 1_000,
		// Live text readers have their own location share, so a crowd reading
		// one text cannot crowd out connections there.
		liveReadsPerLocationMinute: 1_000,
	}),
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
		// Paid bills past these instead of failing; src/pricing.ts prices what
		// runs over them, and billCap stops the server on the estimate.
		monthly: Object.freeze({
			workerRequests: 10_000_000,
			workerCpuMs: 30_000_000,
			durableObjectRequests: 1_000_000,
			durableObjectDurationGbSeconds: 400_000,
			sqlRowsRead: 25_000_000_000,
			sqlRowsWritten: 50_000_000,
			// Workers Logs from 2026-12-01: 50 GB ingested and 10 GB-month stored
			// a billing cycle, then $0.25 a GB and $0.10 a GB-month. Logs are kept
			// 7 days, so storage is at most 7/30 of what was ingested in the cycle
			// and the week before: about 6 GB-month for one month's stop, and
			// past 10 only when two months' stops fall in one cycle, by cents.
			// Until then logs bill per event, 20 million included: the stop is
			// about 3 million sampled worker events, and the Durable Object
			// request stop comes long before its 12 million Durable Object ones.
			logBytes: 50_000_000_000,
		}),
		// The overage the server may run up: $5 added in one UTC day, or $25 in
		// a calendar month, past the $5 plan. A billing cycle overlaps at most
		// two calendar months, so a cycle costs at most $55 more than the plan.
		// Each stop lands a detection lag (a minute or so of analytics) late;
		// the attack pause (src/index.ts) stops a flood long before either.
		billCap: Object.freeze({ dayUsd: 5, monthUsd: 25 }),
		// Measured on the demo in October 2026: Durable Object events about
		// 1 KB, entry Worker events up to 6.3 KB with their request headers.
		logEstimate: Object.freeze({
			sampleRate: 0.1,
			workerEventBytes: 8_192,
			durableObjectEventBytes: 2_048,
		}),
		// R2's free tier, which covers uploads (below): billed past it too.
		r2: Object.freeze({
			classAOperationsMonthly: 1_000_000,
			classBOperationsMonthly: 10_000_000,
			storedBytes: 10 * 1024 * 1024 * 1024,
		}),
	}),
	edgeStop: Object.freeze({
		// A front-page day at one location is a few thousand requests a minute
		// at most (connections, probes, media), so 200 a second is a flood.
		// Spread thinner than that over every location, the attack pause
		// (src/burn.ts) weighs what it costs.
		floodRequestsPerColoMinute: 12_000,
		// Sampling keeps the per-request cost to one random number; the rate
		// limiter counts 600 sampled requests a minute.
		floodSampleEvery: 20,
		// Long enough for analytics to show the flood, so the guard's bill cap
		// takes over before the hold ends if the flood ran up the bill.
		holdSeconds: 30 * 60,
	}),
	// Images and voice clips kept in R2 and served from its public bucket
	// domain, counted together. At most 500 uploads a day are about 16,000
	// writes a month (1 million free), and the stored-bytes cap keeps storage
	// at half the free 10 GB-month whatever the mix of types and sizes: 500
	// full-size files a day for a week would be 17.5 GB.
	uploads: Object.freeze({
		maxFileBytes: 5 * 1024 * 1024,
		maxAvatarBytes: 256 * 1024,
		// Custom emoji live until an admin removes them: at most 125 MB.
		maxEmojiBytes: 256 * 1024,
		maxEmoji: 500,
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
	// Live text (embed:terminal, embed:append): the free plan's policy with
	// more texts a day, more readers, and more kept. A day at these limits is
	// at most 3,200 Durable Object requests (100 writes, 30 reads each, and an
	// alarm), a tenth of the 32,000 daily share; about 3,600 SQL rows written;
	// and the kept text of a week at most about 90 MB of SQLite (each
	// terminal's output at most 128 KiB of JSON), an eighth of the high-water
	// mark. Streaming keeps the object awake, which the duration bound above
	// already covers (docs/cost-report.md, Live text).
	liveText: Object.freeze({
		...FREE_PLAN.liveText!,
		terminalKeepBytes: 32 * 1024,
		maxInputBytes: 2 * 1024 * 1024,
		startsPerUserDay: 20,
		startsPerDay: 100,
		concurrent: 4,
		// A text a crowd opens: readers cost the object memory, not money (each
		// read is one billed request, however long it streams), so the bound is
		// readers at once, server-wide at its ceiling. Reads over a text's life
		// are not counted: the attempt limiters bound reconnects, and a text
		// streams 300 seconds at most.
		readersPerText: 200,
		readers: 400,
		// An office reading a text together, but not one host holding the
		// server's readers: it would need 25 addresses (a /48's /56s, which
		// the prefix limiter slows to 180 attempts a minute).
		readersPerAddress: 16,
	}),
	// Email sign-in (scheme `email`), on once the deployment has a sender
	// (EMAIL_FROM and the EMAIL send_email binding). Workers Paid includes
	// 3,000 emails a month, then $0.35 per 1,000; 95 a day stays inside it
	// even in a 31-day month, so email adds nothing to the bill. Free has no
	// policy: it cannot send to arbitrary addresses. A proposal is about
	// three key-value writes and a limiter row or two, and an approval a
	// registration's worth for a new account, all inside the budgets above.
	email: Object.freeze({
		sendsPerDay: 95,
		// A household or office behind one address signs a few people up; a
		// script that mails strangers from it stops at ten.
		sendsPerIpDay: 10,
		// Retries for a lost or slow email, but not a flood of one inbox.
		sendsPerAddressDay: 3,
		proposalSeconds: 10 * 60,
		maxFailures: 5,
		addressesPerUser: 3,
	}),
	features: Object.freeze({
		// Typing costs about 5 frames a typing minute, inside the frame budget.
		activity: true,
		// Guests only read, as on Free: a moderation choice, not a budget one.
		guestPosting: false,
		// User status, as on Free: connected users' from their connection
		// attachments, and a listed member's chosen status read with them
		// (nothing for members who never chose one or muted, one read at
		// worst), with their `seen` written when their last connection
		// closes or with a chosen `invisible`, at most once in 10 minutes
		// per user (SEEN_WRITE_GRANULARITY_MS).
		presence: true,
		// Live text, where PUBLIC_ORIGIN and UPLOAD_SIGNING_KEY are set.
		liveText: true,
	}),
});
