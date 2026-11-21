/*
 * The history chain's state as the store keeps it in memory (history-log.ts):
 * a write is kept as written once it is made, even if settling its
 * reservation then fails, so the next read answers what is stored.
 */

import { expect, it } from "vitest";
import { sqliteOf } from "../../src/store/open";
import { withStore } from "../helpers/store";

type Ledger = { refund: (...args: unknown[]) => void };

/** Makes the next reservation's settling (its refund) fail once, after its work. */
function failNextSettle(store: Parameters<typeof sqliteOf>[0]): void {
	const ledger = (sqliteOf(store) as unknown as { ledger: Ledger }).ledger;
	const refund = ledger.refund;
	ledger.refund = () => {
		ledger.refund = refund;
		throw new Error("injected settle failure");
	};
}

it("keeps a state value as written when its reservation fails to settle", async () => {
	await withStore("history-state-settle", { tiered: true }, async (store, _clock, state) => {
		const port = store.history.state();
		const key = "history:link:sqlite";
		expect(port.value(key)).toBeUndefined();
		failNextSettle(store);
		expect(() => port.setValue(key, "{\"through\":7}")).toThrow("injected settle failure");
		expect(state.storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = ?", key).one().value).toBe("{\"through\":7}");
		expect(port.value(key)).toBe("{\"through\":7}");
	});
});

it("keeps the copy marker as raised when its reservation fails to settle", async () => {
	await withStore("history-marker-settle", { tiered: true }, async (store) => {
		const port = store.history.state();
		expect(port.copyMarker()).toBe(0);
		failNextSettle(store);
		expect(() => port.raiseCopyMarker(5)).toThrow("injected settle failure");
		expect(port.copyMarker()).toBe(5);
	});
});
