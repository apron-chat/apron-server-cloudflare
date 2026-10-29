import { afterEach, describe, expect, it, vi } from "vitest";
import { noticeText, notifyTrigger } from "../src/notify";

afterEach(() => { vi.restoreAllMocks(); });

describe("trigger notices", () => {
	it("says what tripped and what lifts it", () => {
		expect(noticeText({ kind: "edge_stop", exceeded: ["monthly.workerRequests", "flood"] })).toContain("reached: monthly.workerRequests, flood");
		expect(noticeText({ kind: "accounting_overrun" })).toContain("ACCOUNTING_RECOVERY");
	});

	it("never throws or rejects, whatever a channel does, and logs the failure", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(notifyTrigger({ kind: "edge_stop", exceeded: ["flood"] }, { admins: () => Promise.reject(new Error("object down")) })).resolves.toBeUndefined();
		await expect(notifyTrigger({ kind: "accounting_overrun" }, { admins: () => { throw new Error("thrown at once"); } })).resolves.toBeUndefined();
		await expect(notifyTrigger({ kind: "accounting_overrun" }, {})).resolves.toBeUndefined();
		const failures = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
		expect(failures).toEqual([
			{ event: "trigger_notice_failed", kind: "edge_stop", channel: "admins", message: "object down" },
			{ event: "trigger_notice_failed", kind: "accounting_overrun", channel: "admins", message: "thrown at once" },
		]);
	});

	it("tells each channel the notice's text", async () => {
		const admins = vi.fn(async () => {});
		await notifyTrigger({ kind: "edge_stop", exceeded: ["daily.sqlRowsRead"] }, { admins });
		expect(admins).toHaveBeenCalledWith(noticeText({ kind: "edge_stop", exceeded: ["daily.sqlRowsRead"] }));
	});
});
