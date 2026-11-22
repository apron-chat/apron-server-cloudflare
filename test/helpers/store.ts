import { env, runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import { type Store, type StoreConfig, StoreError, openStore } from "../../src/store";
import { WAKE_SCOPES } from "../../src/domain";
import { sqliteOf } from "../../src/store/open";
import type { SqliteStore } from "../../src/store/sqlite-store";

/** A history page's messages; the array is omitted when empty (§4.3). */
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

/** How long history keeps records in tests of expiry by age. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** History by age alone (no count), as the tests of expiry by age run it. */
export const BY_AGE: Partial<StoreConfig> = { historyHotRecords: 0, retentionMs: RETENTION_MS };

/** Runs `fn` against a fresh, initialized Store in its own Durable Object. */
export async function withStore<T>(
	name: string,
	config: Partial<StoreConfig>,
	fn: (store: Store, clock: TestClock, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
	const stub = env.DEMO.getByName(`${name}-${crypto.randomUUID()}`);
	return runInDurableObject(stub, async (_instance, state) => {
		const clock = makeClock();
		const store = openStore(state, config, clock.clock);
		store.lifecycle.initialize();
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

/** A stored push registration as tests inspect it: Store's record plus the scopes it wakes for. */
export type StoredPushSubscription = { url: string; userId: string; p256dh: string; auth: string; pushId?: string; wake: Array<keyof typeof WAKE_SCOPES> };

/** A user's push registrations, expired ones included, most recently registered first, read straight from SQL. */
export function pushSubscriptionsOf(state: DurableObjectState, userId: string): StoredPushSubscription[] {
	return state.storage.sql.exec<{ url: string; p256dh: string; auth: string; push_id: string | null; wake: number }>(
		"SELECT url, p256dh, auth, push_id, wake FROM push_subscriptions WHERE user_id = ? ORDER BY updated_ms DESC", userId,
	).toArray().map((row) => ({
		url: row.url, userId, p256dh: row.p256dh, auth: row.auth, ...(row.push_id !== null ? { pushId: row.push_id } : {}),
		wake: (Object.keys(WAKE_SCOPES) as Array<keyof typeof WAKE_SCOPES>).filter((scope) => (Number(row.wake) & WAKE_SCOPES[scope]) !== 0),
	}));
}

/** The SqliteStore under a Durable Object's store (ApronDemoServer's `store`), for tests that reach into its internals. */
export function sqliteIn(instance: unknown): SqliteStore {
	return sqliteOf((instance as { store: Store }).store);
}
