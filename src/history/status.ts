/*
 * What `/status` and `/history status` say of history: the records each
 * tier holds (that only it serves) against its limit, with what cleanup
 * keeps of it, a stalled link, and, for `/history status`, each link's
 * markers, the published floor and whether the invariants hold. Never
 * throws: the tiers below give up after 5 seconds.
 */

import { thresholdRecords } from "../budget";
import type { HistoryLimits } from "./config";
import type { HistoryChain } from "./chain";
import { checkInvariants } from "./link";

/** Why the D1 tier is off while it holds history (config.ts d1Off). */
export type D1Off = "unbound" | "disabled";

export interface StatusInput {
	limits: HistoryLimits;
	/** The records SQLite holds from its floor on (may throw: the budget). */
	hotRecords(): number;
	/** The chain, where there are tiers below SQLite. */
	chain?: HistoryChain;
	/** The D1 tier holds history but is off in this deploy, and why. */
	d1Off?: D1Off;
}

const count = (value: number) => Math.round(value).toLocaleString("en-US");

/** A count against its limit, with what cleanup keeps of it (cleanupThresholdPercent). */
function against(value: number, limit: number | undefined, percent: number): string {
	return limit && limit > 0
		? `${count(value)} / ${count(limit)} records (${Math.round((100 * value) / limit)}%; cleanup keeps ${count(thresholdRecords(limit, percent))})`
		: `${count(value)} records (${limit === undefined ? "kept by age" : "kept"})`;
}

/** Why the D1 tier is off, for people: what to change. */
export function d1OffReason(off: D1Off): string {
	return off === "unbound" ? "it holds history; needs the `HISTORY_D1` binding" : "it holds history; `LIMIT_HISTORY_D1_RECORDS` is 0";
}

/** `/status`'s history lines. */
export async function statusLines(input: StatusInput): Promise<string[]> {
	const { limits } = input;
	const hotLimit = limits.retentionRecords > 0 ? limits.retentionRecords : undefined;
	const hot = () => {
		try {
			return against(input.hotRecords(), hotLimit, limits.cleanupThresholdPercent);
		} catch {
			return "unknown";
		}
	};
	if (input.d1Off) {
		const until = input.d1Off === "unbound" ? "it is bound" : "it is above 0";
		return [`- History in SQLite: ${hot()}`, `- History in D1: **${input.d1Off === "unbound" ? "unbound" : "off"}** (${d1OffReason(input.d1Off)}): no history moves below SQLite until ${until}`];
	}
	if (!input.chain) return [`- History in SQLite: ${hot()}`, `- History in D1: off${limits.historyD1Records > 0 ? " (no `HISTORY_D1` binding)" : ""}`];
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const tiers = await Promise.race([
			input.chain.stats(),
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 5_000); }),
		]).finally(() => clearTimeout(timer));
		const lines: string[] = [];
		for (const [index, tier] of tiers.entries()) {
			const limit = index === 0 ? hotLimit : tier.retention.records ?? 0;
			lines.push(`- History in ${tier.label}: ${against(tier.stats.records, limit, tier.retention.thresholdPercent)}`);
			const next = tiers[index + 1];
			const stall = tier.link?.stall;
			if (next && stall && stall.kind !== "ok") lines.push(`- History copy ${tier.label} → ${next.label}: failing since ${new Date(stall.since).toISOString()}`);
		}
		return lines;
	} catch {
		return [`- History in SQLite: ${hot()}`, "- History below SQLite: unavailable"];
	}
}

/** `/history status`'s lines past `/status`'s: each link's markers, the published floor, and the invariants. */
export async function detailLines(chain: HistoryChain): Promise<string[]> {
	const [view, published, logged] = await Promise.all([chain.view(), chain.publishedFloor(), chain.logged()]);
	const violations = checkInvariants(view, published, logged);
	return [
		...view.tiers.map((tier, index) => {
			const link = view.links[index];
			const below = link ? `, copied through ${link.through}, rewrites delivered through ${link.delivered} of ${logged}` : "";
			return `- \`${tier.name}\`: floor ${tier.floor}${below}${tier.rewrites ? "" : " (keeps what /purge and /rename change above it)"}`;
		}),
		`- Published floor: ${published}`,
		violations.length ? `- **Invariants broken:** ${violations.join("; ")}` : "- Invariants hold.",
	];
}
