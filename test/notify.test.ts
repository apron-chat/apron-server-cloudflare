import { afterEach, describe, expect, it, vi } from "vitest";
import { noticeText, notifyTrigger } from "../src/notify";

afterEach(() => { vi.restoreAllMocks(); });

describe("trigger notices", () => {
	it("says what tripped and what lifts it", () => {
		expect(noticeText({ kind: "edge_stop", exceeded: ["monthly.workerRequests", "flood"] })).toContain("reached: monthly.workerRequests, flood");
		expect(noticeText({ kind: "edge_stop_lifted" })).toContain("**Budget stop is off.**");
	});

	it("names each tier change, why, and what it means for people", () => {
		const degraded = noticeText({ kind: "tier", from: "open", to: "degraded", reasons: ["foreground SQL writes at 72% of today's ceiling"] });
		expect(degraded).toBe("**Server tier: degraded** (was open). foreground SQL writes at 72% of today's ceiling. Live text, uploads and older history are off until UTC midnight; chat works.");
		expect(noticeText({ kind: "tier", from: "degraded", to: "open", reasons: [] })).toBe("**Server tier: open** (was degraded). Everything works.");
		expect(noticeText({ kind: "tier", from: "open", to: "account_stop", reasons: ["Cloudflare usage reached monthly.workerRequests"] })).toContain("**Server tier: account stop**");
	});

	it("names a paused action and when it resumes, and the day's first overrun with the users it acted for", () => {
		const until = Date.UTC(2026, 10, 1, 18, 54);
		expect(noticeText({ kind: "breaker", operation: "topLevelRoomIds", open: true, until })).toMatch(/^\*\*Paused one action: `topLevelRoomIds`\.\*\*[^]*until 18:54 UTC; everything else works\.$/);
		expect(noticeText({ kind: "breaker", operation: "topLevelRoomIds", open: false })).toBe("**Resumed `topLevelRoomIds`.** Its pause ended.");
		const overrun = noticeText({ kind: "overrun", operation: "topLevelRoomIds", message: "topLevelRoomIds: 29/28 reads, 0/8 writes", users: ["guest_7"] });
		expect(overrun).toContain("**Storage overrun: `topLevelRoomIds`** used more rows than it reserved for `guest_7` (topLevelRoomIds: 29/28 reads, 0/8 writes)");
		expect(overrun).toContain("the server stays open");
	});

	it("never throws or rejects, whatever a channel does, and logs the failure", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(notifyTrigger({ kind: "edge_stop", exceeded: ["flood"] }, { admins: () => Promise.reject(new Error("object down")) })).resolves.toBeUndefined();
		await expect(notifyTrigger({ kind: "edge_stop_lifted" }, { admins: () => { throw new Error("thrown at once"); } })).resolves.toBeUndefined();
		await expect(notifyTrigger({ kind: "edge_stop_lifted" }, {})).resolves.toBeUndefined();
		const failures = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
		expect(failures).toEqual([
			{ event: "trigger_notice_failed", kind: "edge_stop", channel: "admins", message: "object down" },
			{ event: "trigger_notice_failed", kind: "edge_stop_lifted", channel: "admins", message: "thrown at once" },
		]);
	});

	it("tells each channel the notice's text", async () => {
		const admins = vi.fn(async () => {});
		await notifyTrigger({ kind: "edge_stop", exceeded: ["daily.sqlRowsRead"] }, { admins });
		expect(admins).toHaveBeenCalledWith(noticeText({ kind: "edge_stop", exceeded: ["daily.sqlRowsRead"] }));
	});
});
