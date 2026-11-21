/*
 * A schema reset (lifecycle.resetStorage) wipes the object's storage, and
 * with it what the store keeps in memory of it: a reset in the same
 * instance leaves no cold chunk index or open live text behind, and the
 * chunk index's table is made again when it is next needed.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { LIVE_TEXT_POLICY } from "../../src/budget";
import type { ChunkRef } from "../../src/history/cold/chunks";
import { openStore } from "../../src/store";

const REF: ChunkRef = { first: 1, last: 10, key: "history/cold/1", records: 10, bytes: 100, rooms: ["general"] };

it("forgets the cold chunk index on a reset, and makes its table again", async () => {
	await runInDurableObject(env.DEMO.getByName(`reset-chunks-${crypto.randomUUID()}`), async (_instance, state) => {
		const store = openStore(state, { tiered: true });
		store.lifecycle.initialize();
		await store.history.chunkIndex("cold").update({ put: [REF] });
		expect(await store.history.chunkIndex("cold").list()).toEqual([REF]);

		await store.lifecycle.resetStorage();
		expect(await store.history.chunkIndex("cold").list()).toEqual([]);
		await store.history.chunkIndex("cold").update({ put: [{ ...REF, first: 11, last: 20 }] });
		expect(state.storage.sql.exec<{ first: number }>("SELECT first FROM history_chunks WHERE tier = 'cold'").toArray().map((row) => row.first)).toEqual([11]);
	});
});

it("forgets the open live texts on a reset", async () => {
	await runInDurableObject(env.DEMO.getByName(`reset-live-${crypto.randomUUID()}`), async (_instance, state) => {
		const store = openStore(state, { liveText: { ...LIVE_TEXT_POLICY!, publicOrigin: "https://demo.test", enabled: true } });
		store.lifecycle.initialize();
		store.liveText!.start({ userId: "guest_1", ipKey: "ip", identity: { user_id: "guest_1" }, kind: "append", roomId: "general", text: "", now: Date.now() });
		expect(store.liveText!.open(Date.now())).toHaveLength(1);

		await store.lifecycle.resetStorage();
		expect(store.liveText!.open(Date.now())).toEqual([]);
	});
});
