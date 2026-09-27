import { exceededAllowances, fetchAccountUsage, type AccountUsageEnvironment } from "./account-usage";

/**
 * The zone custom rule the guard turns on and off. It blocks the server's
 * hostname at the edge, before the Worker runs, so blocked requests are not
 * billed. Operators use `apron_admission_off` by hand; the guard never
 * touches that one.
 */
export const EDGE_STOP_RULE_REF = "apron_budget_stop";

export interface BudgetGuardEnvironment extends AccountUsageEnvironment {
	ZONE_ID?: string;
	/** An API token with Zone WAF edit permission on `ZONE_ID`. */
	EDGE_STOP_TOKEN?: string;
}

export type BudgetGuardResult =
	| { outcome: "unconfigured" | "usage_failed" | "rule_failed" | "rule_missing" }
	| { outcome: "unchanged" | "changed"; stop: boolean; exceeded: string[] };

interface RulesetRule {
	id: string;
	ref?: string;
	enabled?: boolean;
	action: string;
	expression: string;
	description?: string;
}

function log(event: string, fields: Record<string, unknown> = {}, level: "log" | "warn" | "error" = "log"): void {
	console[level](JSON.stringify({ event, ...fields }));
}

/**
 * Compares account usage with the plan's allowances and turns the edge stop
 * rule on while any is reached, off once none is. Runs from the Worker's cron
 * trigger, which the edge rule does not block. When usage or the rule cannot
 * be read, the rule keeps its current state.
 */
export async function runBudgetGuard(env: BudgetGuardEnvironment, now = Date.now(), fetcher: typeof fetch = fetch): Promise<BudgetGuardResult> {
	if (!env.ACCOUNT_ID || !env.ACCOUNT_ANALYTICS_TOKEN || !env.ZONE_ID || !env.EDGE_STOP_TOKEN) {
		log("budget_guard_unconfigured", {}, "error");
		return { outcome: "unconfigured" };
	}
	let exceeded: string[];
	try {
		exceeded = exceededAllowances(await fetchAccountUsage(env, now, undefined, fetcher));
	} catch (error) {
		log("budget_guard_usage_failed", { message: error instanceof Error ? error.message : String(error) }, "error");
		return { outcome: "usage_failed" };
	}
	const stop = exceeded.length > 0;
	const api = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(env.ZONE_ID)}/rulesets`;
	const headers = { Authorization: `Bearer ${env.EDGE_STOP_TOKEN}`, "Content-Type": "application/json" };
	try {
		const response = await fetcher(`${api}/phases/http_request_firewall_custom/entrypoint`, { headers });
		if (!response.ok) throw new Error(`ruleset HTTP ${response.status}`);
		const ruleset = (await response.json() as { result?: { id?: string; rules?: RulesetRule[] } }).result;
		const rule = ruleset?.rules?.find((candidate) => candidate.ref === EDGE_STOP_RULE_REF);
		if (!ruleset?.id || !rule) {
			log("budget_guard_rule_missing", { ref: EDGE_STOP_RULE_REF, stop, exceeded }, "error");
			return { outcome: "rule_missing" };
		}
		// The Rulesets API treats a rule without `enabled` as enabled.
		if ((rule.enabled !== false) === stop) return { outcome: "unchanged", stop, exceeded };
		const update = await fetcher(`${api}/${encodeURIComponent(ruleset.id)}/rules/${encodeURIComponent(rule.id)}`, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ ref: rule.ref, action: rule.action, expression: rule.expression, description: rule.description, enabled: stop }),
		});
		if (!update.ok) throw new Error(`rule update HTTP ${update.status}`);
	} catch (error) {
		log("budget_guard_rule_failed", { message: error instanceof Error ? error.message : String(error), stop, exceeded }, "error");
		return { outcome: "rule_failed" };
	}
	log("budget_guard_edge_stop", { enabled: stop, exceeded }, stop ? "warn" : "log");
	return { outcome: "changed", stop, exceeded };
}
