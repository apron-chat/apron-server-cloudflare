import { describe, expect, it, vi } from "vitest";
import { recordMetric } from "../src/metrics";

describe("metrics", () => {
	it("writes the event as index and first blob, its details, and its value", () => {
		const writeDataPoint = vi.fn();
		recordMetric({ writeDataPoint }, "push", ["sent"], 3);
		recordMetric({ writeDataPoint }, "alarm", ["light"]);
		expect(writeDataPoint.mock.calls).toEqual([
			[{ indexes: ["push"], blobs: ["push", "sent"], doubles: [3] }],
			[{ indexes: ["alarm"], blobs: ["alarm", "light"], doubles: [1] }],
		]);
	});

	it("writes nothing without the binding, and never throws", () => {
		expect(() => recordMetric(undefined, "alarm", ["full"])).not.toThrow();
		expect(() => recordMetric({ writeDataPoint: () => { throw new Error("dataset down"); } }, "alarm", ["full"])).not.toThrow();
	});
});
