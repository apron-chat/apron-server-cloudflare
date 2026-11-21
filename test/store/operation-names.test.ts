/*
 * The names operations reserve under (src/store/accounting.ts): what overrun
 * logs and notices, breakers, BREAKER_EXEMPT and BREAKER_ALERT_ONLY key on.
 * Each reservation names its operation explicitly; these pin a
 * representative set, one or more per part and implementation module, the
 * metering entry points, and nested work (a message committed inside a
 * mutation's reservation), so moving code between modules cannot rename one
 * silently. The names are the SqliteStore method names the stack gave them
 * before names were explicit.
 */

import { expect, it } from "vitest";
import { LIVE_TEXT_POLICY, PUSH_POLICY, UPLOAD_POLICY } from "../../src/budget";
import { WAKE_SCOPES } from "../../src/domain";
import type { Store } from "../../src/store";
import { sqliteOf } from "../../src/store/open";
import { withStore, type TestClock } from "../helpers/store";

type Ledger = { reserve: (...args: unknown[]) => { operation?: string }; reserveControl: (...args: unknown[]) => { operation?: string } };

/** The operation names of the reservations `fn` makes, in order. */
function namesOf(store: Store, fn: () => unknown): string[] {
	const ledger = (sqliteOf(store) as unknown as { ledger: Ledger }).ledger;
	const made: Array<{ operation?: string }> = [];
	const reserve = ledger.reserve;
	const reserveControl = ledger.reserveControl;
	ledger.reserve = (...args) => { const cost = reserve.apply(ledger, args); made.push(cost); return cost; };
	ledger.reserveControl = (...args) => { const cost = reserveControl.apply(ledger, args); made.push(cost); return cost; };
	try { fn(); } finally {
		ledger.reserve = reserve;
		ledger.reserveControl = reserveControl;
	}
	return made.map((cost) => cost.operation ?? "(none)");
}

const CONFIG = {
	push: PUSH_POLICY!,
	uploads: { ...UPLOAD_POLICY!, mediaOrigin: "https://media.test" },
	liveText: { ...LIVE_TEXT_POLICY!, publicOrigin: "https://demo.test", enabled: true },
};

function register(store: Store, clock: TestClock, userId: string): void {
	store.accounts.register({
		userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: clock.value, ipKey: `ip-${userId}`,
		credential: { credentialId: `cred-${userId}`, userId, publicKey: "AAAA", counter: 0 },
	});
}

it("names each operation's reservations as before", async () => {
	await withStore("operation-names", CONFIG, async (store, clock) => {
		const names: Record<string, string[]> = {};
		const pin = (label: string, fn: () => unknown) => { names[label] = namesOf(store, fn); };
		const now = () => clock.value;
		pin("accounts.register", () => register(store, clock, "ada"));
		register(store, clock, "bob");
		pin("accounts.get", () => store.accounts.get("ada"));
		pin("credentials.get", () => store.credentials.get("cred-ada"));
		pin("rooms.list", () => store.rooms.list(now()));
		pin("rooms.counts", () => store.rooms.counts(now()));
		pin("messages.mutate", () => store.messages.mutate({
			userId: "ada", ipKey: "ip-ada", requestId: "r1", method: "message", now: now(), params: { body: { text: "hello" } }, identity: { user_id: "ada" },
		}));
		pin("messages.historyAcrossTiers", () => store.messages.historyAcrossTiers({ roomId: "general", now: now(), userId: "ada", tier: "registered", ipKey: "ip-ada" } as never));
		pin("sqlite.history", () => sqliteOf(store).history({ roomId: "general", now: now(), userId: "ada", tier: "registered", ipKey: "ip-ada" } as never));
		pin("reads.setRoomMute", () => store.reads.setRoomMute({ userId: "ada", roomId: "general", untilMs: now() + 60_000, now: now() }));
		pin("reads.statusInputs", () => store.reads.statusInputs("ada", now()));
		pin("reads.cursors", () => store.reads.cursors("ada", now()));
		pin("accounts.setStatus", () => store.accounts.setStatus({ userId: "ada", choice: "dnd", now: now() }));
		pin("admission.reserveFrames", () => store.admission.reserveFrames({ ipKey: "ip-ada", now: now() }));
		pin("admission.reserveAuthAttempt", () => store.admission.reserveAuthAttempt({ ipKey: "ip-ada", now: now() }));
		pin("push.register", () => store.push!.register({ userId: "bob", url: "https://push.example.net/b", p256dh: "p".repeat(87), auth: "a".repeat(22), now: now() }));
		pin("push.claim", () => store.push!.claim({ senderId: "ada", roomId: "general", candidates: [{ userId: "bob", reasons: WAKE_SCOPES.mentions }], now: now() }));
		pin("push.sentToday", () => store.push!.sentToday(now()));
		pin("uploads.startAvatar", () => store.uploads!.startAvatar({ userId: "ada", now: now() }));
		pin("server.metadata", () => store.server.metadata(now()));
		pin("server.emojiCatalog", () => store.server.emojiCatalog(now()));
		pin("liveText.start", () => store.liveText!.start({ userId: "ada", ipKey: "ip-ada", identity: { user_id: "ada" }, kind: "append", roomId: "general", text: "", now: now() }));
		pin("liveText.open", () => store.liveText!.open(now()));
		pin("history.hotRecords", () => store.history.hotRecords(now()));
		pin("history.state", () => store.history.state().copyMarker());
		pin("history.chunkIndex", () => { void store.history.chunkIndex("cold").list(); });
		pin("history.restore.roomIsEmpty", () => { void store.history.restore().roomIsEmpty("general"); });
		pin("history.restore.accounts", () => { void store.history.restore().accounts(); });
		pin("ops.status", () => store.ops.status(now()));
		pin("withMeter", () => sqliteOf(store).withMeter("foreground", { reads: 1 }, () => undefined, now()));
		pin("meter.foreground", () => { void store.meter.foreground({ reads: 1 }, async () => undefined, now()); });
		pin("lifecycle.cleanupDue", () => store.lifecycle.cleanupDue(now()));
		clock.value += 60_000;
		pin("lifecycle.runCleanup", () => store.lifecycle.runCleanup(now()));
		pin("accounts.pruneIdle", () => store.accounts.pruneIdle(now()));
		expect(names).toEqual({
			"accounts.register": ["registerIdentity"],
			"accounts.get": ["getIdentity"],
			"credentials.get": ["getCredential"],
			"rooms.list": ["listRooms"],
			"rooms.counts": ["roomCounts"],
			// The message is committed (commitMessage) inside the mutation's reservations.
			"messages.mutate": ["commitMutation", "commitMutation"],
			// Named after the method that reserves for every history read; BREAKER_ALERT_ONLY's "history" never matches it.
			"messages.historyAcrossTiers": ["historyImpl"],
			"sqlite.history": ["historyImpl"],
			"reads.setRoomMute": ["setRoomMute"],
			"reads.statusInputs": ["statusInputs"],
			"reads.cursors": ["readCursors"],
			"accounts.setStatus": ["setStatus"],
			"admission.reserveFrames": ["reserveFrames"],
			"admission.reserveAuthAttempt": ["reserveAuthAttempt"],
			"push.register": ["registerPushSubscription"],
			"push.claim": ["claimPushes"],
			"push.sentToday": ["pushesToday"],
			"uploads.startAvatar": ["startAvatarUpload"],
			"server.metadata": ["serverMetadata"],
			"server.emojiCatalog": ["emojiCatalog"],
			"liveText.start": ["startLiveCommand"],
			// Read once, then from memory.
			"liveText.open": [],
			"history.hotRecords": ["hotRecords"],
			"history.state": ["unknown"],
			"history.chunkIndex": ["unknown", "unknown", "unknown"],
			"history.restore.roomIsEmpty": ["roomIsEmpty"],
			"history.restore.accounts": ["accountCapacity"],
			"ops.status": ["status"],
			"withMeter": ["unknown"],
			"meter.foreground": ["unknown"],
			"lifecycle.cleanupDue": ["cleanupDue"],
			"lifecycle.runCleanup": ["runCleanup"],
			"accounts.pruneIdle": ["pruneIdleIdentities"],
		});
	});
});
