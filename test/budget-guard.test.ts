import { describe, expect, it, vi } from "vitest";
import { createExecutionContext, createScheduledController, env as testEnv, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import * as guard from "../src/budget-guard";
import * as notifier from "../src/notify";
import { ACCOUNT_USAGE_POLICY as POLICY, PLAN } from "../src/budget";
import { billCap } from "../src/pricing";
import { EDGE_STOP_RULE_REF, readEdgeStop, resetFloodWatch, ruleHoldUntil, runBudgetGuard, setAttackStop, watchForFlood } from "../src/budget-guard";

const env = { ACCOUNT_ID: "account", ACCOUNT_ANALYTICS_TOKEN: "analytics", ZONE_ID: "zone", EDGE_STOP_TOKEN: "edge" };
const rule = { id: "rule-1", ref: EDGE_STOP_RULE_REF, action: "block", expression: 'http.host eq "server.apron.chat"', description: "Apron: budget stop" };

function usage(workerRequests = 1) {
	return {
		data: { viewer: { accounts: [{
			workersInvocationsAdaptive: [{ sum: { requests: workerRequests, cpuTimeUs: 1 } }],
			durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 1 } }],
			durableObjectsPeriodicGroups: [{ sum: { duration: 1, rowsRead: 1, rowsWritten: 1 } }],
			durableObjectsStorageGroups: [{ max: { storedBytes: 1 } }],
			monthWorkers: [{ sum: { requests: workerRequests, cpuTimeUs: 1 } }],
			monthInvocations: [{ sum: { requests: 1 } }],
			monthPeriodic: [{ sum: { duration: 1, rowsRead: 1, rowsWritten: 1 } }],
			r2Operations: [],
			r2Storage: [],
			monthR2Operations: [],
		}] } },
	};
}

/** A fake Cloudflare API: analytics, the zone's custom-rule entrypoint, and rule updates. */
function api({ workerRequests = 1, enabled = false, rules, analyticsStatus = 200 }: { workerRequests?: number; enabled?: boolean; rules?: object[]; analyticsStatus?: number } = {}) {
	rules ??= [{ ...rule, enabled }];
	const updates: unknown[] = [];
	const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/graphql")) return analyticsStatus === 200 ? Response.json(usage(workerRequests)) : new Response("", { status: analyticsStatus });
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer edge");
		if (url.endsWith("/zones/zone/rulesets/phases/http_request_firewall_custom/entrypoint")) {
			return Response.json({ result: { id: "ruleset-1", rules: [{ id: "other", ref: "apron_admission_off", action: "block", expression: "true", enabled: false }, ...rules] } });
		}
		if (url.endsWith("/zones/zone/rulesets/ruleset-1/rules/rule-1") && init?.method === "PATCH") {
			updates.push(JSON.parse(String(init.body)));
			return Response.json({ success: true });
		}
		return new Response("", { status: 404 });
	});
	return { fetcher: fetcher as unknown as typeof fetch, updates, calls: fetcher.mock.calls };
}

// A day and month of 100 million Worker requests, all of it today: 90
// million past the inclusion ($27), and their sampled logs, about 82 GB
// against 50 GB included ($8 billed, $7.98 prorated for the day's stop).
const overDaily = 100_000_000;

describe("budget guard", () => {
	it("turns the edge stop on once the overage passes the bill cap, keeping the rule as it was", async () => {
		const { fetcher, updates } = api({ workerRequests: overDaily });
		expect(await runBudgetGuard(env, Date.now(), fetcher)).toEqual({ outcome: "changed", stop: true, exceeded: ["day overage $34.98 over $5", "month overage $35 over $25"] });
		expect(updates).toEqual([{ ref: rule.ref, action: rule.action, expression: rule.expression, description: rule.description, enabled: true }]);
	});

	it.runIf(billCap())("runs on through a day past its daily share that costs nothing, and follows BILL_CAP_*", async () => {
		// Three days' share of requests in one, still inside the month's inclusion.
		const busy = api({ workerRequests: POLICY.daily.workerRequests * 3 });
		expect(await runBudgetGuard(env, Date.now(), busy.fetcher)).toEqual({ outcome: "unchanged", stop: false, exceeded: [] });
		const raised = api({ workerRequests: overDaily });
		expect(await runBudgetGuard({ ...env, BILL_CAP_DAY: "40", BILL_CAP_MONTH: "40" }, Date.now(), raised.fetcher)).toEqual({ outcome: "unchanged", stop: false, exceeded: [] });
		const lowered = api({ workerRequests: overDaily });
		expect(await runBudgetGuard({ ...env, BILL_CAP_DAY: "40", BILL_CAP_MONTH: "34.5" }, Date.now(), lowered.fetcher)).toMatchObject({ outcome: "changed", stop: true, exceeded: ["month overage $35 over $34.50"] });
		const invalid = api({ workerRequests: overDaily });
		expect(await runBudgetGuard({ ...env, BILL_CAP_DAY: "lots" }, Date.now(), invalid.fetcher)).toEqual({ outcome: "usage_failed" });
	});

	it("turns the edge stop off once the overage is back under the cap", async () => {
		const { fetcher, updates } = api({ enabled: true });
		expect(await runBudgetGuard(env, Date.now(), fetcher)).toMatchObject({ outcome: "changed", stop: false });
		expect(updates).toEqual([expect.objectContaining({ enabled: false })]);
	});

	it("leaves a rule already in the right state alone", async () => {
		for (const [workerRequests, enabled] of [[1, false], [overDaily, true]] as const) {
			const { fetcher, updates } = api({ workerRequests, enabled });
			expect(await runBudgetGuard(env, Date.now(), fetcher)).toMatchObject({ outcome: "unchanged", stop: enabled });
			expect(updates).toEqual([]);
		}
	});

	it.runIf(PLAN.edgeStop)("holds a stop turned on less than holdSeconds ago, then lifts it", async () => {
		const now = Date.parse("2026-09-27T12:00:00Z");
		const hold = PLAN.edgeStop!.holdSeconds * 1_000;
		const recent = api({ rules: [{ ...rule, enabled: true, last_updated: new Date(now - hold + 60_000).toISOString() }] });
		expect(await runBudgetGuard(env, now, recent.fetcher)).toMatchObject({ outcome: "held", stop: false });
		expect(recent.updates).toEqual([]);
		const old = api({ rules: [{ ...rule, enabled: true, last_updated: new Date(now - hold).toISOString() }] });
		expect(await runBudgetGuard(env, now, old.fetcher)).toMatchObject({ outcome: "changed", stop: false });
		expect(old.updates).toEqual([expect.objectContaining({ enabled: false })]);
	});

	it("holds an attack pause's edge stop until its hold ends, whatever the bill, then clears it", async () => {
		const now = Date.parse("2026-11-02T12:00:00Z");
		const until = now + 30 * 60_000;
		const on = api();
		expect(await setAttackStop(env, until, "flood", now, on.fetcher)).toBe("changed");
		expect(on.updates).toEqual([expect.objectContaining({ enabled: true, description: `${rule.description} [attack hold until 2026-11-02T12:30:00.000Z]` })]);
		const held = { ...rule, enabled: true, description: `${rule.description} [attack hold until 2026-11-02T12:30:00.000Z]`, last_updated: new Date(now - 2 * 60 * 60_000).toISOString() };
		expect(ruleHoldUntil(held.description)).toBe(until);
		// A longer hold extends it on a rule already on; a shorter one changes nothing.
		const extend = api({ rules: [held] });
		expect(await setAttackStop(env, until + 60_000, "burn", now, extend.fetcher)).toBe("changed");
		expect(extend.updates).toEqual([expect.objectContaining({ enabled: true, description: `${rule.description} [attack hold until 2026-11-02T12:31:00.000Z]` })]);
		expect(await setAttackStop(env, until - 60_000, "burn", now, api({ rules: [held] }).fetcher)).toBe("unchanged");
		// The guard keeps it on through the hold, though the bill is under its cap.
		const during = api({ rules: [held] });
		expect(await runBudgetGuard(env, until - 1, during.fetcher)).toMatchObject({ outcome: "held", stop: false });
		expect(during.updates).toEqual([]);
		const after = api({ rules: [held] });
		expect(await runBudgetGuard(env, until, after.fetcher)).toMatchObject({ outcome: "changed", stop: false });
		expect(after.updates).toEqual([expect.objectContaining({ enabled: false, description: rule.description })]);
		expect(await readEdgeStop(env, api({ rules: [held] }).fetcher)).toMatchObject({ state: "on", holdUntil: until });
		expect(await setAttackStop({ ...env, ZONE_ID: undefined }, until, "flood", now, on.fetcher)).toBe("unconfigured");
		// A rule with no description, trimmed by the API, still carries its hold.
		const bare = api({ rules: [{ ...rule, description: undefined }] });
		expect(await setAttackStop(env, until, "flood", now, bare.fetcher)).toBe("changed");
		expect(bare.updates).toEqual([expect.objectContaining({ description: "[attack hold until 2026-11-02T12:30:00.000Z]" })]);
		expect(ruleHoldUntil("[attack hold until 2026-11-02T12:30:00.000Z] ")).toBe(until);
		// ATTACK_PAUSE=false lifts it at once, hold or not.
		const off = api({ rules: [held] });
		expect(await runBudgetGuard({ ...env, ATTACK_PAUSE: "false" }, until - 60_000, off.fetcher)).toMatchObject({ outcome: "changed", stop: false });
	});

	it("reads a rule without enabled as enabled", async () => {
		const { fetcher, updates } = api({ rules: [rule] });
		expect(await runBudgetGuard(env, Date.now(), fetcher)).toMatchObject({ outcome: "changed", stop: false });
		expect(updates).toEqual([expect.objectContaining({ enabled: false })]);
	});

	it("keeps the rule's state when usage cannot be read, and never touches another rule", async () => {
		const { fetcher, calls } = api({ enabled: true, analyticsStatus: 500 });
		expect(await runBudgetGuard(env, Date.now(), fetcher)).toEqual({ outcome: "usage_failed" });
		expect(calls).toHaveLength(1);
		const missing = api({ workerRequests: overDaily, rules: [] });
		expect(await runBudgetGuard(env, Date.now(), missing.fetcher)).toEqual({ outcome: "rule_missing" });
		expect(missing.updates).toEqual([]);
	});

	it("does nothing without its account, zone, and tokens", async () => {
		const { fetcher, calls } = api();
		for (const key of Object.keys(env)) {
			expect(await runBudgetGuard({ ...env, [key]: undefined }, Date.now(), fetcher)).toEqual({ outcome: "unconfigured" });
		}
		expect(calls).toHaveLength(0);
	});

	it("runs from the Worker's cron trigger", async () => {
		const run = vi.spyOn(guard, "runBudgetGuard");
		try {
			const ctx = createExecutionContext();
			worker.scheduled(createScheduledController({ cron: "* * * * *", scheduledTime: 1_000 }), testEnv, ctx);
			await waitOnExecutionContext(ctx);
			expect(run).toHaveBeenCalledWith(testEnv, 1_000);
			// Tests configure no zone or tokens.
			await expect(run.mock.results[0].value).resolves.toEqual({ outcome: "unconfigured" });
		} finally { run.mockRestore(); }
	});

	it("tells the operators when its run turns the stop on or off, and only then", async () => {
		const notify = vi.spyOn(notifier, "notifyTrigger").mockResolvedValue(undefined);
		const run = vi.spyOn(guard, "runBudgetGuard");
		try {
			const cases: Array<[Awaited<ReturnType<typeof runBudgetGuard>>, unknown]> = [
				[{ outcome: "changed", stop: true, exceeded: ["monthly.workerRequests"] }, { kind: "edge_stop", exceeded: ["monthly.workerRequests"] }],
				[{ outcome: "changed", stop: false, exceeded: [] }, { kind: "edge_stop_lifted" }],
				[{ outcome: "unchanged", stop: true, exceeded: ["monthly.workerRequests"] }, undefined],
				[{ outcome: "held", stop: false, exceeded: [] }, undefined],
			];
			for (const [result, told] of cases) {
				notify.mockClear();
				run.mockResolvedValueOnce(result);
				const ctx = createExecutionContext();
				worker.scheduled(createScheduledController({ cron: "* * * * *", scheduledTime: 2_000 }), testEnv, ctx);
				await waitOnExecutionContext(ctx);
				if (told) expect(notify).toHaveBeenCalledWith(told, expect.objectContaining({ admins: expect.any(Function) }));
				else expect(notify).not.toHaveBeenCalled();
			}
		} finally { run.mockRestore(); notify.mockRestore(); }
	});
});

describe("edge stop reading", () => {
	it("reports the rule's state without changing it", async () => {
		const on = api({ rules: [{ ...rule, enabled: true, last_updated: "2026-09-27T12:00:00Z" }] });
		await expect(readEdgeStop(env, on.fetcher)).resolves.toEqual({ state: "on", updatedAt: "2026-09-27T12:00:00Z" });
		const off = api({ enabled: false });
		await expect(readEdgeStop(env, off.fetcher)).resolves.toEqual({ state: "off" });
		expect([...on.updates, ...off.updates]).toEqual([]);
		expect(off.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
	});

	it("tells why the guard cannot work", async () => {
		const { fetcher, calls } = api();
		await expect(readEdgeStop({ ...env, EDGE_STOP_TOKEN: undefined }, fetcher)).resolves.toEqual({ state: "unconfigured" });
		await expect(readEdgeStop({ ...env, ZONE_ID: undefined }, fetcher)).resolves.toEqual({ state: "unconfigured" });
		expect(calls).toHaveLength(0);
		await expect(readEdgeStop(env, api({ rules: [] }).fetcher)).resolves.toEqual({ state: "rule_missing" });
		const denied = vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof fetch;
		await expect(readEdgeStop(env, denied)).resolves.toEqual({ state: "unreadable", message: "ruleset HTTP 403" });
	});
});

// Only a plan that bills past its included usage, like Workers Paid, has an edge stop.
describe.runIf(PLAN.edgeStop)("flood trip", () => {
	const policy = PLAN.edgeStop!;

	/** Runs watchForFlood once and waits for its work after the response. */
	async function watch(opts: { random: number; success?: boolean; now?: number; fetcher?: typeof fetch; limiter?: RateLimit | undefined; onStop?: () => Promise<void> }) {
		const limit = vi.fn(async () => ({ success: opts.success ?? true }));
		const pending: Promise<unknown>[] = [];
		const { fetcher } = opts.fetcher ? { fetcher: opts.fetcher } : api();
		const floodEnv = { ...env, FLOOD_WATCH: "limiter" in opts ? opts.limiter : { limit } as unknown as RateLimit };
		watchForFlood(floodEnv, { waitUntil: (promise) => { pending.push(promise); } }, opts.now ?? Date.now(), () => opts.random, fetcher, opts.onStop);
		await Promise.all(pending);
		return { limit, pending };
	}

	it("counts one request in floodSampleEvery, after the response", async () => {
		resetFloodWatch();
		const counted = await watch({ random: 0.99 / policy.floodSampleEvery });
		expect(counted.limit).toHaveBeenCalledWith({ key: "requests" });
		const skipped = await watch({ random: 1 / policy.floodSampleEvery });
		expect(skipped.limit).not.toHaveBeenCalled();
		expect(skipped.pending).toEqual([]);
	});

	it("turns the edge stop on at once past the limit, and each isolate tries once a minute", async () => {
		resetFloodWatch();
		const now = Date.parse("2026-09-27T12:00:00Z");
		const first = api();
		await watch({ random: 0, success: false, now, fetcher: first.fetcher });
		expect(first.updates).toEqual([expect.objectContaining({ enabled: true })]);
		const soon = api();
		const again = await watch({ random: 0, success: false, now: now + 59_000, fetcher: soon.fetcher });
		expect(again.limit).not.toHaveBeenCalled();
		const later = api();
		await watch({ random: 0, success: false, now: now + 60_000, fetcher: later.fetcher });
		expect(later.updates).toHaveLength(1);
	});

	it("tells the operators once it has turned the stop on, and a failing notice changes nothing", async () => {
		resetFloodWatch();
		const now = Date.parse("2026-09-27T13:00:00Z");
		const onStop = vi.fn(async () => { throw new Error("notice failed"); });
		const tripped = api();
		await watch({ random: 0, success: false, now, fetcher: tripped.fetcher, onStop });
		expect(tripped.updates).toEqual([expect.objectContaining({ enabled: true })]);
		expect(onStop).toHaveBeenCalledTimes(1);
		// Already on: nothing changed, so nothing is told.
		const already = api({ enabled: true });
		await watch({ random: 0, success: false, now: now + 60_000, fetcher: already.fetcher, onStop });
		expect(already.updates).toEqual([]);
		expect(onStop).toHaveBeenCalledTimes(1);
	});

	it("does nothing under the limit or without its binding", async () => {
		resetFloodWatch();
		const under = api();
		await watch({ random: 0, success: true, fetcher: under.fetcher });
		expect(under.calls).toHaveLength(0);
		const unbound = await watch({ random: 0, limiter: undefined });
		expect(unbound.pending).toEqual([]);
	});

	it("is sized so ordinary traffic cannot trip it", () => {
		// Ten times what one location may send the object in a minute (its
		// admissions are capped there), leaving room for probes and media.
		expect(policy.floodRequestsPerColoMinute).toBeGreaterThan(PLAN.admission.objectRequestsPerLocationMinute * 10);
		expect(policy.holdSeconds).toBeGreaterThanOrEqual(15 * 60);
	});
});
