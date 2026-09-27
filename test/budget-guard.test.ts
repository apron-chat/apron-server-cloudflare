import { describe, expect, it, vi } from "vitest";
import { createExecutionContext, createScheduledController, env as testEnv, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import * as guard from "../src/budget-guard";
import { ACCOUNT_USAGE_POLICY as POLICY, PLAN } from "../src/budget";
import { EDGE_STOP_RULE_REF, resetFloodWatch, runBudgetGuard, watchForFlood } from "../src/budget-guard";

const env = { ACCOUNT_ID: "account", ACCOUNT_ANALYTICS_TOKEN: "analytics", ZONE_ID: "zone", EDGE_STOP_TOKEN: "edge" };
const rule = { id: "rule-1", ref: EDGE_STOP_RULE_REF, action: "block", expression: 'http.host eq "server.apron.chat"', description: "Apron: budget stop" };

function usage(workerRequests = 1) {
	return {
		data: { viewer: { accounts: [{
			workersInvocationsAdaptive: [{ sum: { requests: workerRequests } }],
			durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 1 } }],
			durableObjectsPeriodicGroups: [{ sum: { duration: 1, rowsRead: 1, rowsWritten: 1 } }],
			durableObjectsStorageGroups: [{ max: { storedBytes: 1 } }],
			monthWorkers: [{ sum: { requests: workerRequests, cpuTimeUs: 1 } }],
			monthInvocations: [{ sum: { requests: 1 } }],
			monthPeriodic: [{ sum: { duration: 1, rowsRead: 1, rowsWritten: 1 } }],
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

const overDaily = POLICY.daily.workerRequests;

describe("budget guard", () => {
	it("turns the edge stop on once usage reaches an allowance, keeping the rule as it was", async () => {
		const { fetcher, updates } = api({ workerRequests: overDaily });
		expect(await runBudgetGuard(env, Date.now(), fetcher)).toEqual({ outcome: "changed", stop: true, exceeded: ["daily.workerRequests"] });
		expect(updates).toEqual([{ ref: rule.ref, action: rule.action, expression: rule.expression, description: rule.description, enabled: true }]);
	});

	it("turns the edge stop off once usage is back under every allowance", async () => {
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
});

// Only a plan that bills past its included usage, like Workers Paid, has an edge stop.
describe.runIf(PLAN.edgeStop)("flood trip", () => {
	const policy = PLAN.edgeStop!;

	/** Runs watchForFlood once and waits for its work after the response. */
	async function watch(opts: { random: number; success?: boolean; now?: number; fetcher?: typeof fetch; limiter?: RateLimit | undefined }) {
		const limit = vi.fn(async () => ({ success: opts.success ?? true }));
		const pending: Promise<unknown>[] = [];
		const { fetcher } = opts.fetcher ? { fetcher: opts.fetcher } : api();
		const floodEnv = { ...env, FLOOD_WATCH: "limiter" in opts ? opts.limiter : { limit } as unknown as RateLimit };
		watchForFlood(floodEnv, { waitUntil: (promise) => { pending.push(promise); } }, opts.now ?? Date.now(), () => opts.random, fetcher);
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

	it("does nothing under the limit or without its binding", async () => {
		resetFloodWatch();
		const under = api();
		await watch({ random: 0, success: true, fetcher: under.fetcher });
		expect(under.calls).toHaveLength(0);
		const unbound = await watch({ random: 0, limiter: undefined });
		expect(unbound.pending).toEqual([]);
	});

	it("is sized so ordinary traffic cannot trip it", () => {
		// A quarter of a day's admissions, arriving at one location in one minute, stays under it.
		expect(policy.floodRequestsPerColoMinute).toBeGreaterThan(PLAN.limits.connectionAdmissionsPerDay / 4);
		expect(policy.holdSeconds).toBeGreaterThanOrEqual(15 * 60);
	});
});
