import { exceededAllowances, fetchAccountUsage, type AccountUsageEnvironment } from "./account-usage";
import { PLAN } from "./budget";

/**
 * The zone custom rule the guard turns on and off. It blocks the server's
 * hostname at the edge, before the Worker runs, so blocked requests are not
 * billed. Operators use `apron_admission_off` by hand; the guard never
 * touches that one.
 */
export const EDGE_STOP_RULE_REF = "apron_budget_stop";

/** How long an isolate waits after tripping the stop before it may try again. */
const FLOOD_RETRY_MS = 60_000;

interface BudgetGuardEnvironment extends AccountUsageEnvironment {
	ZONE_ID?: string;
	/** An API token with Zone WAF edit permission on `ZONE_ID`. */
	EDGE_STOP_TOKEN?: string;
	/** Counts sampled requests per Cloudflare location for the flood trip. */
	FLOOD_WATCH?: RateLimit;
}

type EdgeStopOutcome = "rule_failed" | "rule_missing" | "unchanged" | "held" | "changed";

type BudgetGuardResult =
	| { outcome: "unconfigured" | "usage_failed" | "rule_failed" | "rule_missing" }
	| { outcome: "unchanged" | "held" | "changed"; stop: boolean; exceeded: string[] };

interface RulesetRule {
	id: string;
	ref?: string;
	enabled?: boolean;
	action: string;
	expression: string;
	description?: string;
	last_updated?: string;
}

function log(event: string, fields: Record<string, unknown> = {}, level: "log" | "warn" | "error" = "log"): void {
	console[level](JSON.stringify({ event, ...fields }));
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Turns the edge stop rule on or off, changing nothing if it is already so.
 * A rule turned on less than the plan's `holdSeconds` ago is not turned off.
 */
async function setEdgeStop(env: BudgetGuardEnvironment & { ZONE_ID: string; EDGE_STOP_TOKEN: string }, stop: boolean, exceeded: string[], now: number, fetcher: typeof fetch): Promise<EdgeStopOutcome> {
	const api = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(env.ZONE_ID)}/rulesets`;
	const headers = { Authorization: `Bearer ${env.EDGE_STOP_TOKEN}`, "Content-Type": "application/json" };
	try {
		const response = await fetcher(`${api}/phases/http_request_firewall_custom/entrypoint`, { headers });
		if (!response.ok) throw new Error(`ruleset HTTP ${response.status}`);
		const ruleset = (await response.json() as { result?: { id?: string; rules?: RulesetRule[] } }).result;
		const rule = ruleset?.rules?.find((candidate) => candidate.ref === EDGE_STOP_RULE_REF);
		if (!ruleset?.id || !rule) {
			log("budget_guard_rule_missing", { ref: EDGE_STOP_RULE_REF, stop, exceeded }, "error");
			return "rule_missing";
		}
		// The Rulesets API treats a rule without `enabled` as enabled.
		const enabled = rule.enabled !== false;
		if (enabled === stop) return "unchanged";
		const holdMs = (PLAN.edgeStop?.holdSeconds ?? 0) * 1_000;
		const updatedAt = Date.parse(rule.last_updated ?? "");
		if (!stop && now - updatedAt < holdMs) return "held";
		const update = await fetcher(`${api}/${encodeURIComponent(ruleset.id)}/rules/${encodeURIComponent(rule.id)}`, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ ref: rule.ref, action: rule.action, expression: rule.expression, description: rule.description, enabled: stop }),
		});
		if (!update.ok) throw new Error(`rule update HTTP ${update.status}`);
	} catch (error) {
		log("budget_guard_rule_failed", { message: message(error), stop, exceeded }, "error");
		return "rule_failed";
	}
	log("budget_guard_edge_stop", { enabled: stop, exceeded }, stop ? "warn" : "log");
	return "changed";
}

/**
 * Compares account usage with the plan's allowances and turns the edge stop
 * rule on while any is reached, off once none is and the hold has passed.
 * Runs from the Worker's cron trigger, which the edge rule does not block.
 * When usage or the rule cannot be read, the rule keeps its current state.
 */
export async function runBudgetGuard(env: BudgetGuardEnvironment, now = Date.now(), fetcher: typeof fetch = fetch): Promise<BudgetGuardResult> {
	const { ZONE_ID, EDGE_STOP_TOKEN } = env;
	if (!env.ACCOUNT_ID || !env.ACCOUNT_ANALYTICS_TOKEN || !ZONE_ID || !EDGE_STOP_TOKEN) {
		log("budget_guard_unconfigured", {}, "error");
		return { outcome: "unconfigured" };
	}
	let exceeded: string[];
	try {
		exceeded = exceededAllowances(await fetchAccountUsage(env, now, undefined, fetcher));
	} catch (error) {
		log("budget_guard_usage_failed", { message: message(error) }, "error");
		return { outcome: "usage_failed" };
	}
	const stop = exceeded.length > 0;
	const outcome = await setEdgeStop({ ...env, ZONE_ID, EDGE_STOP_TOKEN }, stop, exceeded, now, fetcher);
	if (outcome === "rule_failed" || outcome === "rule_missing") return { outcome };
	return { outcome, stop, exceeded };
}

let floodTrippedAt = -Infinity;

/**
 * Called on every request. One request in `floodSampleEvery`, at random, is
 * counted against a per-location limit after the response; past it, the
 * edge stop is turned on at once instead of waiting minutes for analytics.
 * Counting writes nothing; tripping is the only write, and each isolate
 * tries at most once a minute.
 */
export function watchForFlood(env: BudgetGuardEnvironment, ctx: Pick<ExecutionContext, "waitUntil"> | undefined, now = Date.now(), random = Math.random, fetcher: typeof fetch = fetch): void {
	const policy = PLAN.edgeStop;
	const { FLOOD_WATCH, ZONE_ID, EDGE_STOP_TOKEN } = env;
	if (!policy || !ctx || !FLOOD_WATCH || !ZONE_ID || !EDGE_STOP_TOKEN) return;
	if (random() * policy.floodSampleEvery >= 1 || now - floodTrippedAt < FLOOD_RETRY_MS) return;
	ctx.waitUntil((async () => {
		try {
			if ((await FLOOD_WATCH.limit({ key: "requests" })).success) return;
		} catch {
			return;
		}
		if (now - floodTrippedAt < FLOOD_RETRY_MS) return;
		floodTrippedAt = now;
		await setEdgeStop({ ...env, ZONE_ID, EDGE_STOP_TOKEN }, true, ["flood"], now, fetcher);
	})());
}

/** Forgets that this isolate tripped the stop, for tests. */
export function resetFloodWatch(): void {
	floodTrippedAt = -Infinity;
}
