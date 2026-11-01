import { fetchAccountUsage, snapshotReasons, type AccountUsageEnvironment } from "./account-usage";
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
	/** `false` turns the attack pause off: the guard then lifts the edge stop whatever hold it carries. */
	ATTACK_PAUSE?: string;
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

type StopRuleEnvironment = BudgetGuardEnvironment & { ZONE_ID: string; EDGE_STOP_TOKEN: string };

function rulesetsApi(env: StopRuleEnvironment): { api: string; headers: Record<string, string> } {
	return {
		api: `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(env.ZONE_ID)}/rulesets`,
		headers: { Authorization: `Bearer ${env.EDGE_STOP_TOKEN}`, "Content-Type": "application/json" },
	};
}

/** The zone's custom-rule entrypoint and the edge stop rule in it, if any; throws when it cannot be read. */
async function readStopRule(env: StopRuleEnvironment, fetcher: typeof fetch, signal?: AbortSignal): Promise<{ rulesetId?: string; rule?: RulesetRule }> {
	const { api, headers } = rulesetsApi(env);
	const response = await fetcher(`${api}/phases/http_request_firewall_custom/entrypoint`, { headers, signal });
	if (!response.ok) throw new Error(`ruleset HTTP ${response.status}`);
	const ruleset = (await response.json() as { result?: { id?: string; rules?: RulesetRule[] } }).result;
	return { rulesetId: ruleset?.id, rule: ruleset?.rules?.find((candidate) => candidate.ref === EDGE_STOP_RULE_REF) };
}

/** The Rulesets API treats a rule without `enabled` as enabled. */
function ruleEnabled(rule: RulesetRule): boolean {
	return rule.enabled !== false;
}

/**
 * The attack pause's hold, kept in the rule's description so the guard
 * honours it without asking the object: ` [attack hold until <ISO time>]`.
 */
const HOLD_MARK = /\s*\[attack hold until ([^\]]+)\]\s*$/;

/** When the attack hold written into a rule's description ends; 0 without one. */
export function ruleHoldUntil(description: string | undefined): number {
	const match = HOLD_MARK.exec(description ?? "");
	const until = match ? Date.parse(match[1]) : NaN;
	return Number.isFinite(until) ? until : 0;
}

/** A description with the hold mark set to `until`, or removed (0). */
function withHold(description: string | undefined, until: number): string {
	const base = (description ?? "").replace(HOLD_MARK, "").trim();
	const mark = `[attack hold until ${new Date(until).toISOString()}]`;
	return until ? (base ? `${base} ${mark}` : mark) : base;
}

/**
 * Turns the edge stop rule on or off, changing nothing if it is already so.
 * A rule turned on less than the plan's `holdSeconds` ago, or within an
 * attack hold (`holdUntil`, written into its description), is not turned
 * off; turning it off clears the hold. Turning it on with a later hold than
 * the rule has extends the hold even when it is already on.
 */
async function setEdgeStop(env: StopRuleEnvironment, stop: boolean, exceeded: string[], now: number, fetcher: typeof fetch, holdUntil = 0, ignoreHold = false): Promise<EdgeStopOutcome> {
	const { api, headers } = rulesetsApi(env);
	try {
		const { rulesetId, rule } = await readStopRule(env, fetcher);
		if (!rulesetId || !rule) {
			log("budget_guard_rule_missing", { ref: EDGE_STOP_RULE_REF, stop, exceeded }, "error");
			return "rule_missing";
		}
		const enabled = ruleEnabled(rule);
		const held = ignoreHold ? 0 : ruleHoldUntil(rule.description);
		const extend = stop && holdUntil > held;
		if (enabled === stop && !extend) return "unchanged";
		const holdMs = (PLAN.edgeStop?.holdSeconds ?? 0) * 1_000;
		const updatedAt = Date.parse(rule.last_updated ?? "");
		if (!stop && (now - updatedAt < holdMs || now < held)) return "held";
		const description = stop ? withHold(rule.description, Math.max(held, holdUntil)) : withHold(rule.description, 0);
		const update = await fetcher(`${api}/${encodeURIComponent(rulesetId)}/rules/${encodeURIComponent(rule.id)}`, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ ref: rule.ref, action: rule.action, expression: rule.expression, description, enabled: stop }),
		});
		if (!update.ok) throw new Error(`rule update HTTP ${update.status}`);
	} catch (error) {
		log("budget_guard_rule_failed", { message: message(error), stop, exceeded }, "error");
		return "rule_failed";
	}
	log("budget_guard_edge_stop", { enabled: stop, exceeded, ...(holdUntil ? { holdUntil: new Date(holdUntil).toISOString() } : {}) }, stop ? "warn" : "log");
	return "changed";
}

/**
 * The attack pause's edge stop (ApronDemoServer.pauseForAttack): on now,
 * held until `until` whatever the guard reads meanwhile. Unconfigured, the
 * object's own refusal is the only pause.
 */
export async function setAttackStop(env: BudgetGuardEnvironment, until: number, trigger: string, now = Date.now(), fetcher: typeof fetch = fetch): Promise<EdgeStopOutcome | "unconfigured"> {
	const { ZONE_ID, EDGE_STOP_TOKEN } = env;
	if (!ZONE_ID || !EDGE_STOP_TOKEN) return "unconfigured";
	return setEdgeStop({ ...env, ZONE_ID, EDGE_STOP_TOKEN }, true, [`attack:${trigger}`], now, fetcher, until);
}

/**
 * Compares account usage with the plan's stop lines (the bill cap, on a plan
 * that bills past its inclusions) and turns the edge stop rule on while any
 * is passed, off once none is and the hold has passed.
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
		exceeded = snapshotReasons(await fetchAccountUsage(env, now, undefined, fetcher));
	} catch (error) {
		log("budget_guard_usage_failed", { message: message(error) }, "error");
		return { outcome: "usage_failed" };
	}
	const stop = exceeded.length > 0;
	const ignoreHold = String(env.ATTACK_PAUSE ?? "").trim().toLowerCase() === "false";
	const outcome = await setEdgeStop({ ...env, ZONE_ID, EDGE_STOP_TOKEN }, stop, exceeded, now, fetcher, 0, ignoreHold);
	if (outcome === "rule_failed" || outcome === "rule_missing") return { outcome };
	return { outcome, stop, exceeded };
}

export type EdgeStopState =
	| { state: "unconfigured" | "rule_missing" }
	| { state: "unreadable"; message: string }
	| { state: "on" | "off"; updatedAt?: string; holdUntil?: number };

/**
 * Reads the edge stop rule without changing it, for `/status`: whether the
 * guard's zone, token, and rule work, and whether the stop is on. A guard
 * that cannot reach the rule only logs, so this is where it shows.
 */
export async function readEdgeStop(env: BudgetGuardEnvironment, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<EdgeStopState> {
	const { ZONE_ID, EDGE_STOP_TOKEN } = env;
	if (!ZONE_ID || !EDGE_STOP_TOKEN) return { state: "unconfigured" };
	try {
		const { rulesetId, rule } = await readStopRule({ ...env, ZONE_ID, EDGE_STOP_TOKEN }, fetcher, signal);
		if (!rulesetId || !rule) return { state: "rule_missing" };
		const holdUntil = ruleHoldUntil(rule.description);
		return { state: ruleEnabled(rule) ? "on" : "off", ...(rule.last_updated ? { updatedAt: rule.last_updated } : {}), ...(holdUntil ? { holdUntil } : {}) };
	} catch (error) {
		return { state: "unreadable", message: message(error) };
	}
}

let floodTrippedAt = -Infinity;

/**
 * Called on every request. One request in `floodSampleEvery`, at random, is
 * counted against a per-location limit after the response; past it, the
 * edge stop is turned on at once instead of waiting minutes for analytics.
 * Counting writes nothing; tripping is the only write, and each isolate
 * tries at most once a minute. `onStop` runs once the trip has turned the
 * stop on, after it; whatever it throws is ignored.
 */
export function watchForFlood(env: BudgetGuardEnvironment, ctx: Pick<ExecutionContext, "waitUntil"> | undefined, now = Date.now(), random = Math.random, fetcher: typeof fetch = fetch, onStop?: () => Promise<void>): void {
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
		if (await setEdgeStop({ ...env, ZONE_ID, EDGE_STOP_TOKEN }, true, ["flood"], now, fetcher) !== "changed") return;
		try { await onStop?.(); } catch { /* a notice never breaks the stop */ }
	})());
}

/** Forgets that this isolate tripped the stop, for tests. */
export function resetFloodWatch(): void {
	floodTrippedAt = -Infinity;
}
