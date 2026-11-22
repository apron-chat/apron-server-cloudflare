/*
 * The Push conformance suite (test/store/conformance/push.ts) on the
 * SQLite-backed part, as openStore makes it, and on MemoryPush; and the
 * optional parts' presence, decided by openStore from the configuration.
 */

import { describe, expect, it } from "vitest";
import { LIVE_TEXT_POLICY, PUSH_POLICY, UPLOAD_POLICY } from "../../src/budget";
import type { MessageSnapshot } from "../../src/store";
import { withStore } from "../helpers/store";
import { describePush, type PushFixture } from "./conformance/push";
import { MemoryPush } from "./support/memory-push";

const BASE = PUSH_POLICY!;

describePush("SQLite", BASE, (policy, body) => withStore("push-conformance", { push: policy }, (store, clock) => {
	const fixture: PushFixture = {
		push: store.push!,
		policy,
		now: () => clock.value,
		advance: (ms) => { clock.value += ms; },
		user(userId, roles = []) {
			store.accounts.register({
				userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: clock.value, ipKey: `ip-${userId}`,
				credential: { credentialId: `cred-${userId}`, userId, publicKey: "AAAA", counter: 0 },
			});
			for (const role of roles) store.accounts.setRole({ userId, role, on: true, now: clock.value });
		},
		post(userId, roomId, text) {
			const result = store.messages.mutate({
				userId, ipKey: `ip-${userId}`, method: "message", now: clock.value, params: { room_id: roomId, body: { text } }, identity: { user_id: userId },
			});
			return result.message!.message_id;
		},
	};
	return body(fixture);
}), { describe, it, expect });

describePush("MemoryPush", BASE, async (policy, body) => {
	let now = Date.now();
	const roles = new Map<string, readonly string[]>();
	const members = new Set<string>();
	const messages = new Map<string, MessageSnapshot>();
	const push = new MemoryPush({
		roles: (userId) => roles.get(userId),
		isMember: (roomId, userId) => members.has(`${roomId}\u0000${userId}`),
		parentOf: () => undefined,
		silenced: () => false,
		roomMuted: () => false,
		message: (messageId) => messages.get(messageId) ?? null,
	}, policy, { now: () => now });
	await body({
		push,
		policy,
		now: () => now,
		advance: (ms) => { now += ms; },
		user(userId, held = []) {
			roles.set(userId, held);
			members.add(`general\u0000${userId}`);
		},
		post(userId, roomId, text) {
			const messageId = `m${messages.size + 1}`;
			messages.set(messageId, { message_id: messageId, log_id: String(messages.size + 1), room_id: roomId, from: { user_id: userId }, body: { text } });
			return messageId;
		},
	});
}, { describe, it, expect });

describe("optional parts", () => {
	it("are absent where their feature is not configured", async () => {
		await withStore("parts-none", { push: null, uploads: null, liveText: null }, (store) => {
			expect([store.push, store.uploads, store.liveText]).toEqual([undefined, undefined, undefined]);
			expect(Object.keys(store).sort()).toEqual(["accounts", "admission", "credentials", "history", "lifecycle", "messages", "meter", "ops", "reads", "rooms", "server"]);
		});
	});

	it("are present where it is", async () => {
		const uploads = { ...UPLOAD_POLICY!, mediaOrigin: "https://media.test" };
		const liveText = { ...LIVE_TEXT_POLICY!, publicOrigin: "https://demo.test", enabled: true };
		await withStore("parts-all", { push: BASE, uploads, liveText }, (store) => {
			expect([!!store.push, !!store.uploads, !!store.liveText]).toEqual([true, true, true]);
		});
	});
});
