/**
 * Something the operators must hear of at once, posted publicly in
 * `general` with every admin mentioned: the server changing tier (open,
 * degraded, exhausted, account stop), an operation's breaker opening
 * or closing, the day's first storage overrun, and the edge stop turning on
 * (by the budget guard, or by the flood trip, `exceeded: ["flood"]`) or off.
 * New kinds of notice, and new ways to tell one, join here.
 */
export type TriggerNotice =
	| { kind: "edge_stop"; exceeded: readonly string[] }
	| { kind: "edge_stop_lifted" }
	| { kind: "tier"; from: ServerTier; to: ServerTier; reasons: readonly string[] }
	| { kind: "breaker"; operation: string; open: boolean; until?: number }
	| { kind: "overrun"; operation: string; message: string; users: readonly string[]; essential?: boolean }
	| { kind: "burn"; summary: string };

/**
 * How far the server refuses work, least to most (docs/configuration.md,
 * Server tiers). Each lifts by itself: degraded and exhausted at UTC
 * midnight, account stop at the day's or month's end, paused when its hold
 * ends.
 */
export type ServerTier = "open" | "degraded" | "exhausted" | "account_stop" | "paused";

export const TIER_LABEL: Record<ServerTier, string> = {
	open: "open",
	degraded: "degraded",
	exhausted: "exhausted",
	account_stop: "account stop",
	paused: "paused (attack)",
};

const TIER_MEANING: Record<ServerTier, string> = {
	open: "Everything works.",
	degraded: "Live text, uploads and older history are off until UTC midnight; chat works.",
	exhausted: "The day's storage or frame budget is spent: new work is refused until UTC midnight; open connections stay.",
	account_stop: "Cloudflare usage reached its stop line: the server is closed until the day's or month's end.",
	paused: "Traffic is costing money fast and is mostly refused, which looks like an attack: every connection is closed and Cloudflare's edge blocks the server until the hold ends. It lifts by itself; a repeat the same UTC day holds twice as long.",
};

/**
 * The ways a notice can be told, each optional. `admins` posts the text in
 * `general` as the admin user, mentioning every admin, which pushes it to
 * their phones (ApronDemoServer.notifyAdmins).
 */
export interface NoticeChannels {
	admins?: (text: string) => Promise<unknown>;
}

function utcTime(ms: number): string {
	return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

/** What a notice says, as the admins read it. */
export function noticeText(notice: TriggerNotice): string {
	switch (notice.kind) {
		case "edge_stop": {
			const reached = notice.exceeded.length ? notice.exceeded.join(", ") : "an allowance";
			return `**Budget stop is on.** Cloudflare's edge now blocks the server, reached: ${reached}. The budget guard lifts it once usage is back under every allowance.`;
		}
		case "edge_stop_lifted":
			return "**Budget stop is off.** Cloudflare's edge lets requests through again.";
		case "tier": {
			const why = notice.reasons.length ? ` ${notice.reasons.join("; ")}.` : "";
			return `**Server tier: ${TIER_LABEL[notice.to]}** (was ${TIER_LABEL[notice.from]}).${why} ${TIER_MEANING[notice.to]}`;
		}
		case "breaker":
			return notice.open
				? `**Paused one action: \`${notice.operation}\`.** It used more storage than it reserved, three times within an hour or once by far, so it is refused until ${notice.until ? utcTime(notice.until) : "an hour from now"}; everything else works.`
				: `**Resumed \`${notice.operation}\`.** Its pause ended.`;
		case "overrun": {
			const who = notice.users.length ? ` for ${notice.users.map((user) => `\`${user}\``).join(", ")}` : "";
			if (notice.essential) return `**Storage overrun: \`${notice.operation}\`** used more rows than it reserved${who} (${notice.message}). It is essential (signing in, rooms or history), so it keeps working with no pause; its rows are charged. Told at most once an hour while it goes on: its estimate needs fixing.`;
			return `**Storage overrun: \`${notice.operation}\`** used more rows than it reserved${who} (${notice.message}). It finished and its rows are charged; the server stays open. Further overruns today are counted without a notice.`;
		}
		case "burn":
			return `**Heavy traffic** (${notice.summary}, priced as if past the plan's inclusions). Most of it is admitted, so it looks like a busy day, not an attack: the server stays open, and the bill cap stops it if the overage passes the cap. Told at most once an hour.`;
	}
}

/**
 * Tells the operators of `notice` in every way `channels` offers. It never
 * throws or rejects, so a trigger calls it only after doing its own work
 * (turning the stop on, closing accounting), and a notice that fails is
 * only logged: telling must never undo or delay what it tells of.
 */
export async function notifyTrigger(notice: TriggerNotice, channels: NoticeChannels): Promise<void> {
	try {
		const text = noticeText(notice);
		await Promise.all(Object.entries(channels).map(async ([channel, send]) => {
			try {
				await send?.(text);
			} catch (error) {
				console.warn(JSON.stringify({ event: "trigger_notice_failed", kind: notice.kind, channel, message: error instanceof Error ? error.message : String(error) }));
			}
		}));
	} catch { /* never reached: each channel catches its own failure */ }
}
