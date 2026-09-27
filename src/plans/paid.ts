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
//   the 12,900 daily share, so duration cannot run over.
// - Storage: unchanged; the database watermarks stay far below 5 GB.
//
// None of that bounds hostile traffic that never gets past the entry Worker,
// which is billed per request. The budget guard (src/budget-guard.ts) checks
// account usage every minute and turns on an edge block rule, which stops
// requests before they invoke the Worker, when usage reaches the daily share
// or `monthlyStopRatio` of the month's included usage.
import type { Plan } from "../budget.ts";
import { FREE_PLAN } from "./free.ts";

export const PAID_PLAN: Plan = Object.freeze({
	name: "Workers Paid",
	limits: Object.freeze({
		...FREE_PLAN.limits,
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
	}),
	features: Object.freeze({
		// Typing costs about 5 frames a typing minute, inside the frame budget.
		activity: true,
		// Guests only read, as on Free: a moderation choice, not a budget one.
		guestPosting: false,
	}),
});
