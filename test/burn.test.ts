import { describe, expect, it } from 'vitest';
import { attackHoldMs, BURN_POLICY, BurnMeter, burnSummary, SHADOW_USD } from '../src/burn';

const start = Date.parse('2026-11-02T12:00:00Z');
const minute = 60_000;

/** Runs `perMinute` for `minutes` minutes from `from`, weighing the meter after each, and returns every decision. */
function run(meter: BurnMeter, from: number, minutes: number, perMinute: (meter: BurnMeter, at: number) => void) {
	const decisions = [];
	for (let index = 0; index < minutes; index += 1) {
		const at = from + index * minute;
		perMinute(meter, at);
		decisions.push(meter.decide(at + minute - 1));
	}
	return decisions;
}

describe('shadow burn meter', () => {
	it('prices each billed event past the inclusions', () => {
		// A Worker request, 2 ms of CPU and its sampled log; an object request and its log on top.
		expect(SHADOW_USD.entry).toBeCloseTo(0.545e-6, 9);
		expect(SHADOW_USD.fetch).toBeCloseTo(SHADOW_USD.entry + 0.15e-6 + 0.0512e-6, 9);
		// Twenty messages bill as one object request.
		expect(SHADOW_USD.message).toBeLessThan(SHADOW_USD.alarm);
	});

	it('never trips on a deploy reconnect wave', () => {
		const meter = new BurnMeter();
		// About 800 reconnects in the first minute, tapering over three, a few refused for capacity.
		const wave = [800, 300, 100];
		const decisions = run(meter, start, 10, (m, at) => {
			const fetches = wave[Math.floor((at - start) / minute)] ?? 20;
			m.note('fetch', at, fetches, Math.floor(fetches / 10));
			m.note('message', at, fetches * 5);
		});
		expect(decisions.every((decision) => decision.action === 'none')).toBe(true);
	});

	it('never trips on a front-page peak, nor on a retry storm against a full server', () => {
		const meter = new BurnMeter();
		// 2,300 sockets: a few thousand frames a minute, a couple of hundred
		// admissions, and 100 refused retries a minute against the full server.
		const decisions = run(meter, start, 60, (m, at) => {
			m.note('message', at, 3_000);
			m.note('fetch', at, 300, 100);
			m.note('alarm', at, 4);
			m.note('entry', at, 2_000, 200);
		});
		expect(decisions.every((decision) => decision.action === 'none')).toBe(true);
		expect(meter.window(start + 60 * minute).usdPerHour).toBeLessThan(0.1);
	});

	it('pauses within two minutes on a flood the limiters already refuse', () => {
		const meter = new BurnMeter();
		// 100,000 requests a minute, 95% refused before the object: about $3/h.
		const decisions = run(meter, start, 3, (m, at) => m.note('entry', at, 100_000, 95_000));
		expect(decisions[0]).toMatchObject({ action: 'pause', trigger: 'flood' });
		const window = (decisions[0] as { window: Parameters<typeof burnSummary>[0] }).window;
		expect(window.usdPerHour).toBeGreaterThan(BURN_POLICY.usdPerHour);
		expect(burnSummary(window)).toMatch(/^\$\d+\.\d\d\/h, 95% of 100,000 requests refused$/);
	});

	it('pauses on a sustained burn half refused, but only alerts on one mostly admitted', () => {
		const half = new BurnMeter();
		// 40,000 requests a minute, 60% refused: about $1.30/h, too little refused for the fast rule.
		const decisions = run(half, start, 10, (m, at) => m.note('entry', at, 40_000, 24_000));
		expect(decisions.slice(0, 2).every((decision) => decision.action === 'none')).toBe(true);
		expect(decisions.at(-1)).toMatchObject({ action: 'pause', trigger: 'burn' });
		const launch = new BurnMeter();
		const admitted = run(launch, start, 10, (m, at) => m.note('fetch', at, 40_000, 1_000));
		expect(admitted.at(-1)).toMatchObject({ action: 'alert' });
		expect(admitted.some((decision) => decision.action === 'pause')).toBe(false);
	});

	it('forgets minutes past its window', () => {
		const meter = new BurnMeter();
		meter.note('entry', start, 1_000_000, 1_000_000);
		expect(meter.decide(start).action).toBe('pause');
		expect(meter.window(start + BURN_POLICY.windowMinutes * minute)).toMatchObject({ usd: 0, seen: 0 });
		expect(meter.decide(start + BURN_POLICY.windowMinutes * minute).action).toBe('none');
	});

	it('holds 30 minutes, doubling per pause in a day, at most 4 hours', () => {
		expect([1, 2, 3, 4].map(attackHoldMs)).toEqual([30, 60, 120, 240].map((minutes) => minutes * minute));
		expect(attackHoldMs(20)).toBe(4 * 60 * minute);
	});
});
