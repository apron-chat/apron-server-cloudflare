import { env, runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import { Store, StoreError, type StoreConfig } from "../../src/store";

/** A history page's messages; the array is omitted when empty (§4.1). */
export function messagesOf(page: { messages?: Array<{ log_id: string; message_id: string; room_id?: string; body?: Record<string, unknown> & { text?: string } }> }) {
	return page.messages ?? [];
}

export type TestClock = {
	value: number;
	readonly clock: { now(): number };
};

export function makeClock(): TestClock {
	const testClock: TestClock = {
		value: Date.now() + 1_000,
		clock: { now: () => testClock.value },
	};
	return testClock;
}

/** Runs `fn` against a fresh, initialized Store in its own Durable Object. */
export async function withStore<T>(
	name: string,
	config: Partial<StoreConfig>,
	fn: (store: Store, clock: TestClock, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
	const stub = env.DEMO.getByName(`${name}-${crypto.randomUUID()}`);
	return runInDurableObject(stub, async (_instance, state) => {
		const clock = makeClock();
		const store = new Store(state, config, clock.clock);
		store.initialize();
		return fn(store, clock, state);
	});
}

/** The StoreError code `fn` throws. */
export function errorCode(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		if (error instanceof StoreError) return error.code;
		throw error;
	}
	throw new Error("expected StoreError");
}

export function expectRetryAfter(error: unknown): asserts error is StoreError {
	expect(error).toBeInstanceOf(StoreError);
	expect((error as StoreError).code).toBe("retry_after");
}
