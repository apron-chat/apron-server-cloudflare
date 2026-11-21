/*
 * The Push conformance suite: what every Push part must do, as the runtime
 * relies on it (src/index.ts: push_register and push_unregister, a
 * message's wakes and their claims, `unread`, revoked and gone
 * registrations, held wakes' messages, `/status`). Run on the SQLite-backed
 * part (openStore) and on MemoryPush (test/store/support/memory-push.ts) by
 * test/store/push.test.ts.
 *
 * The suite observes a part through its own methods only. What a claim
 * reads besides push state (users and their roles, memberships, the log)
 * the fixture sets up: every user it makes is registered and in `general`.
 * Time moves only by `advance`, so no two registrations share a moment.
 */

import type { PushPolicy } from "../../../src/budget";
import { WAKE_SCOPES } from "../../../src/domain";
import { type Push, StoreError } from "../../../src/store";

export interface PushFixture {
	push: Push;
	policy: PushPolicy;
	now(): number;
	advance(ms: number): void;
	/** A registered user, a member of `general`, holding `roles`. */
	user(userId: string, roles?: readonly string[]): void;
	/** Posts `text` by `userId` in `roomId`; the message's ID. */
	post(userId: string, roomId: string, text: string): string;
}

/** Runs `body` against a fresh part with `policy`, and its fixture. */
export type WithPushFixture = (policy: PushPolicy, body: (fixture: PushFixture) => void | Promise<void>) => Promise<void>;

export interface Runner {
	describe(name: string, body: () => void): void;
	it(name: string, body: () => Promise<void>): void;
	expect: (actual: unknown) => {
		toBe(expected: unknown): void;
		toEqual(expected: unknown): void;
		toThrow(expected?: unknown): void;
		toBeNull(): void;
	};
}

const KEYS = { p256dh: "p".repeat(87), auth: "a".repeat(22) };
const { mentions, replies, joined } = WAKE_SCOPES;

export function describePush(name: string, base: PushPolicy, withFixture: WithPushFixture, { describe, it, expect }: Runner): void {
	/** The policy for a test: generous allowances, so only what a test sets limits it. */
	const policy = (overrides: Partial<PushPolicy> = {}): PushPolicy => ({
		...base, wakesPerMessage: 10, pushesPerDay: 1_000, pushesPerSenderDay: 1_000, pushesPerRecipientDay: 1_000, joinedPushesPerRecipientDay: 1_000,
		subscriptionsPerUser: 4, coalesceSeconds: 60, joinedCoalesceSeconds: 600, ...overrides,
	});
	const code = (fn: () => unknown) => {
		try { fn(); } catch (error) { return error instanceof StoreError ? error.code : String(error); }
		return "none";
	};
	/** What a claim for `userId`, for `why`, in `roomId`, returns of each registration. */
	const claimed = (fixture: PushFixture, userId: string, why: number, roomId = "general", extra: { alert?: boolean; allowed?: (url: string) => boolean } = {}) =>
		fixture.push.claim({ senderId: "sender", roomId, candidates: [{ userId, reasons: why }], now: fixture.now(), ...extra });

	describe(`Push conformance: ${name}`, () => {
		it("claims a user's registration for a wake it asked for, with its keys, push_id, scopes and unread", async () => {
			await withFixture(policy(), (fixture) => {
				fixture.user("ada");
				fixture.push.register({ userId: "ada", url: "https://push.example.net/a", ...KEYS, pushId: "phone", now: fixture.now() });
				expect(claimed(fixture, "ada", mentions)).toEqual({
					subscriptions: [{ url: "https://push.example.net/a", userId: "ada", ...KEYS, pushId: "phone", reasons: mentions, unread: 1 }],
					skipped: 0,
				});
				expect(fixture.push.sentToday(fixture.now())).toBe(1);
			});
		});

		it("refuses a registration from an unknown user, or with a bad push_id or wake", async () => {
			await withFixture(policy(), (fixture) => {
				fixture.user("ada");
				expect(code(() => fixture.push.register({ userId: "nobody", url: "https://push.example.net/n", ...KEYS, now: fixture.now() }))).toBe("denied");
				expect(code(() => fixture.push.register({ userId: "ada", url: "https://push.example.net/a", ...KEYS, pushId: "not ok", now: fixture.now() }))).toBe("invalid_params");
				expect(code(() => fixture.push.register({ userId: "ada", url: "https://push.example.net/a", ...KEYS, wake: 64, now: fixture.now() }))).toBe("invalid_params");
				expect(claimed(fixture, "ada", mentions).subscriptions).toEqual([]);
			});
		});

		it("keeps one registration per endpoint, with its latest keys, and the most recent subscriptionsPerUser", async () => {
			await withFixture(policy({ subscriptionsPerUser: 2 }), (fixture) => {
				fixture.user("ada");
				for (const name of ["a", "b", "c"]) {
					fixture.push.register({ userId: "ada", url: `https://push.example.net/${name}`, ...KEYS, now: fixture.now() });
					fixture.advance(1_000);
				}
				fixture.push.register({ userId: "ada", url: "https://push.example.net/c", p256dh: "q".repeat(87), auth: KEYS.auth, now: fixture.now() });
				const rows = claimed(fixture, "ada", mentions).subscriptions;
				expect(rows.map((row) => [row.url, row.p256dh])).toEqual([["https://push.example.net/c", "q".repeat(87)], ["https://push.example.net/b", KEYS.p256dh]]);
			});
		});

		it("passes over registrations that do not wake for the reason, and those `allowed` refuses", async () => {
			await withFixture(policy(), (fixture) => {
				fixture.user("ada");
				fixture.push.register({ userId: "ada", url: "https://push.example.net/replies", ...KEYS, wake: replies, now: fixture.now() });
				expect(claimed(fixture, "ada", mentions).subscriptions).toEqual([]);
				fixture.advance(1_000);
				fixture.push.register({ userId: "ada", url: "https://push.retired.example/m", ...KEYS, wake: mentions | replies, now: fixture.now() });
				const rows = claimed(fixture, "ada", replies, "general", { allowed: (url) => url.startsWith("https://push.example.net/") }).subscriptions;
				expect(rows.map((row) => [row.url, row.reasons])).toEqual([["https://push.example.net/replies", replies]]);
			});
		});

		it("removes a registration, all of a user's, and a gone one only with the keys pushed to", async () => {
			await withFixture(policy(), (fixture) => {
				fixture.user("ada");
				fixture.user("bob");
				for (const userId of ["ada", "bob"]) {
					for (const name of ["a", "b"]) {
						fixture.push.register({ userId, url: `https://push.example.net/${userId}/${name}`, ...KEYS, now: fixture.now() });
						fixture.advance(1_000);
					}
				}
				fixture.push.remove({ userId: "ada", url: "https://push.example.net/ada/a", now: fixture.now() });
				expect(claimed(fixture, "ada", mentions, "r1").subscriptions.map((row) => row.url)).toEqual(["https://push.example.net/ada/b"]);
				fixture.push.clearSubscriptions("ada", fixture.now());
				expect(claimed(fixture, "ada", mentions, "r2").subscriptions).toEqual([]);
				fixture.push.forgetSubscriptions([
					{ userId: "bob", url: "https://push.example.net/bob/a", p256dh: "other" },
					{ userId: "bob", url: "https://push.example.net/bob/b", p256dh: KEYS.p256dh },
				], fixture.now());
				expect(claimed(fixture, "bob", mentions).subscriptions.map((row) => row.url)).toEqual(["https://push.example.net/bob/a"]);
			});
		});

		it("wakes a user for a room once within coalesceSeconds, but an alert is not held back", async () => {
			await withFixture(policy({ coalesceSeconds: 60 }), (fixture) => {
				fixture.user("ada");
				fixture.push.register({ userId: "ada", url: "https://push.example.net/a", ...KEYS, now: fixture.now() });
				expect(claimed(fixture, "ada", mentions).subscriptions.length).toBe(1);
				fixture.advance(30_000);
				expect(claimed(fixture, "ada", mentions).subscriptions).toEqual([]);
				expect(claimed(fixture, "ada", mentions, "elsewhere").subscriptions.length).toBe(1);
				const alert = claimed(fixture, "ada", mentions, "general", { alert: true }).subscriptions;
				expect(alert.map((row) => row.unread)).toEqual([undefined]);
				// The alert's wake counts for the window too.
				fixture.advance(61_000);
				expect(claimed(fixture, "ada", mentions).subscriptions.length).toBe(1);
			});
		});

		it("counts a user's unread up with each wake, and clears it", async () => {
			await withFixture(policy(), (fixture) => {
				fixture.user("ada");
				fixture.push.register({ userId: "ada", url: "https://push.example.net/a", ...KEYS, now: fixture.now() });
				expect(claimed(fixture, "ada", mentions, "r1").subscriptions.map((row) => row.unread)).toEqual([1]);
				expect(claimed(fixture, "ada", replies, "r2").subscriptions.map((row) => row.unread)).toEqual([2]);
				fixture.push.clearUnread("ada", fixture.now());
				expect(claimed(fixture, "ada", mentions, "r3").subscriptions.map((row) => row.unread)).toEqual([1]);
			});
		});

		it("keeps `joined` for moderators only, who wake for it in rooms they joined, without unread", async () => {
			await withFixture(policy(), (fixture) => {
				fixture.user("mod", ["mod"]);
				fixture.user("plain");
				fixture.push.register({ userId: "mod", url: "https://push.example.net/mod", ...KEYS, wake: mentions | joined, now: fixture.now() });
				fixture.advance(1_000);
				fixture.push.register({ userId: "plain", url: "https://push.example.net/plain", ...KEYS, wake: mentions | joined, now: fixture.now() });
				expect(fixture.push.joinedWakers(fixture.now())).toEqual(["mod"]);
				expect(claimed(fixture, "mod", joined).subscriptions.map((row) => [row.reasons, row.unread])).toEqual([[joined, undefined]]);
				expect(claimed(fixture, "mod", joined, "not-joined").subscriptions).toEqual([]);
				expect(claimed(fixture, "plain", joined).subscriptions).toEqual([]);
			});
		});

		it("wakes at most wakesPerMessage users, and skips what the allowances leave out", async () => {
			await withFixture(policy({ wakesPerMessage: 1, pushesPerSenderDay: 2 }), (fixture) => {
				for (const userId of ["ada", "bob"]) {
					fixture.user(userId);
					fixture.push.register({ userId, url: `https://push.example.net/${userId}`, ...KEYS, now: fixture.now() });
					fixture.advance(1_000);
				}
				const candidates = [{ userId: "ada", reasons: mentions }, { userId: "bob", reasons: mentions }];
				const first = fixture.push.claim({ senderId: "sender", roomId: "r1", candidates, now: fixture.now() });
				expect(first.subscriptions.map((row) => row.userId)).toEqual(["ada"]);
				fixture.push.claim({ senderId: "sender", roomId: "r2", candidates, now: fixture.now() });
				const spent = fixture.push.claim({ senderId: "sender", roomId: "r3", candidates, now: fixture.now() });
				expect(spent.subscriptions).toEqual([]);
				expect(spent.skipped).toBe(2);
				expect(fixture.push.sentToday(fixture.now())).toBe(2);
			});
		});

		it("reads a held wake's message as it is now, and null for one unknown", async () => {
			await withFixture(policy(), (fixture) => {
				fixture.user("ada");
				const messageId = fixture.post("ada", "general", "hello");
				const message = fixture.push.message(messageId, fixture.now());
				expect([message?.message_id, message?.room_id, (message?.body as { text?: string } | undefined)?.text]).toEqual([messageId, "general", "hello"]);
				expect(fixture.push.message("no-such-message", fixture.now())).toBeNull();
			});
		});
	});
}
