/**
 * Something the operators must hear of at once: the edge stop turned on (by
 * the budget guard, or by the flood trip, `exceeded: ["flood"]`), or storage
 * accounting closed by an overrun, which stays closed until an operator
 * clears it, or an overrun that paused only the user or address it acted
 * for (Store.quarantineActor). New kinds of notice, and new ways to tell one, join here.
 */
export type TriggerNotice =
	| { kind: "edge_stop"; exceeded: readonly string[] }
	| { kind: "accounting_overrun" }
	| { kind: "accounting_quarantine"; principals: readonly string[]; message: string; count: number; limit: number };

/**
 * The ways a notice can be told, each optional. `admins` posts the text in
 * `general` as the admin user, mentioning every admin, which pushes it to
 * their phones (ApronDemoServer.notifyAdmins).
 */
export interface NoticeChannels {
	admins?: (text: string) => Promise<unknown>;
}

/** What a notice says, as the admins read it. */
export function noticeText(notice: TriggerNotice): string {
	switch (notice.kind) {
		case "edge_stop": {
			const reached = notice.exceeded.length ? notice.exceeded.join(", ") : "an allowance";
			return `**Budget stop is on.** Cloudflare's edge now blocks the server, reached: ${reached}. The budget guard lifts it once usage is back under every allowance.`;
		}
		case "accounting_overrun":
			return "**Storage accounting closed.** An operation used more rows than it reserved, so the server refuses all work until an operator deploys a new `ACCOUNTING_RECOVERY` value.";
		case "accounting_quarantine": {
			// Addresses are hashed keys, which say nothing to a reader; users are named.
			const users = notice.principals.filter((principal) => principal.startsWith("user:")).map((principal) => `\`${principal.slice(5)}\``);
			const who = users.length ? `${users.join(", ")} and their address` : "one address";
			const left = Math.max(0, notice.limit - notice.count);
			return `**Storage accounting overran for ${who}** (${notice.message}). They are paused for a day; the server stays open. ${left ? `Today ${left} more can be paused like this; the overrun after that closes the server for everyone.` : "The next overrun today closes the server for everyone."} A new \`ACCOUNTING_RECOVERY\` value lifts every pause.`;
		}
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
