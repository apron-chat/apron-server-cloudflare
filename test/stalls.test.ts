import { describe, expect, it } from "vitest";
import { StallMeter } from "../src/stalls";

type Point = [event: string, details: string[], values: number[]];

function meter(start = 1_000_000) {
	let now = start;
	const points: Point[] = [];
	const stalls = new StallMeter((event, details, values) => { points.push([event, details, values]); }, () => now);
	return { stalls, points, at: (ms: number) => { now = start + ms; }, advance: (ms: number) => { now += ms; } };
}

describe("StallMeter", () => {
	it("writes nothing for what takes under 5 seconds", () => {
		const { stalls, points } = meter();
		stalls.note("handler", "message", 4_999);
		stalls.note("r2", "delete", 0);
		expect(points).toEqual([]);
	});

	it("writes a key's first slow one at once, and sums its repeats into one point a minute later", () => {
		const { stalls, points, at } = meter();
		stalls.note("handler", "alarm", 12_000);
		stalls.note("handler", "alarm", 30_000);
		stalls.note("handler", "alarm", 6_000);
		stalls.note("queue", "", 9_000);
		expect(points).toEqual([
			["slow", ["handler", "alarm"], [1, 12_000, 12_000]],
			["slow", ["queue", ""], [1, 9_000, 9_000]],
		]);
		// The next event after the minute writes the repeats: count, worst, total.
		at(60_000);
		stalls.note("handler", "message", 10);
		expect(points.slice(2)).toEqual([["slow", ["handler", "alarm"], [2, 30_000, 36_000]]]);
		// A new minute: the first slow one is written at once again.
		stalls.note("handler", "alarm", 7_000);
		expect(points.at(-1)).toEqual(["slow", ["handler", "alarm"], [1, 7_000, 7_000]]);
	});

	it("times a promise until it settles, either way, without changing its outcome", async () => {
		const { stalls, points, advance } = meter();
		let finish!: (value: string) => void;
		const tracked = stalls.track("r2", "get", new Promise<string>((resolve) => { finish = resolve; }));
		advance(8_000);
		finish("object");
		expect(await tracked).toBe("object");
		const failing = stalls.track("push", "", Promise.reject(new Error("push service down")));
		await expect(failing).rejects.toThrow("push service down");
		expect(points).toEqual([["slow", ["r2", "get"], [1, 8_000, 8_000]]]);
	});

	it("reports an instance awake past 15 minutes, with what it had in flight, at most once per 15", async () => {
		const { stalls, points, advance } = meter();
		const snapshot = () => ({ sockets: 40, live: 0, wakes: 2 });
		let release!: () => void;
		const pending = stalls.track("queue", "", new Promise<void>((resolve) => { release = resolve; }));
		stalls.event(snapshot);
		advance(14 * 60_000);
		stalls.event(snapshot);
		expect(points).toEqual([]);
		advance(60_000);
		stalls.event(snapshot);
		// Age in minutes, events since the last report, open sockets.
		expect(points).toEqual([["awake", ["queue=1 wakes=2"], [15, 3, 40]]]);
		// Not again within 15 minutes; then again, counting only the events since.
		advance(10 * 60_000);
		stalls.event(snapshot);
		release();
		await pending;
		// The queue wait took 25 minutes: that is written as slow too.
		expect(points.at(-1)).toEqual(["slow", ["queue", ""], [1, 25 * 60_000, 25 * 60_000]]);
		advance(5 * 60_000);
		stalls.event(() => ({ sockets: 3 }));
		expect(points.at(-1)).toEqual(["awake", ["none"], [30, 2, 3]]);
	});

	it("never throws, whatever the writer or the snapshot does", () => {
		let now = 0;
		const stalls = new StallMeter(() => { throw new Error("dataset down"); }, () => now);
		expect(() => stalls.note("handler", "alarm", 60_000)).not.toThrow();
		now = 20 * 60_000;
		expect(() => stalls.event(() => { throw new Error("no sockets"); })).not.toThrow();
	});
});
