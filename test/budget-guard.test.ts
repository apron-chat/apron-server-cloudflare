import { describe, expect, it, vi } from "vitest";
import { createExecutionContext, createScheduledController, env as testEnv, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import * as guard from "../src/budget-guard";
import { ACCOUNT_USAGE_POLICY } from "../src/budget";
import { EDGE_STOP_RULE_REF, runBudgetGuard } from "../src/budget-guard";

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

const overDaily = ACCOUNT_USAGE_POLICY.daily.workerRequests;

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
