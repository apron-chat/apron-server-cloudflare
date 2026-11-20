/*
 * Tier state kept for the pipeline (TierStateStore), over a small port of
 * the head's storage: plain values by key, and the few numbers the head
 * owns. The rules are here, not in the Store:
 *
 * - The head's floor is its hot floor, and it applies no ops. Its `through`
 *   is the copy marker the head's cleanup stops at (the port's, never
 *   lowered); its target is kept in memory, as the head's cleanup finds it
 *   again after a wake; its stall is a value of its own.
 * - A lower tier with no state yet starts at the published floor, holding
 *   nothing, with every op so far behind it.
 *
 * Persisted as JSON under `history:tier:<name>` (a lower tier) and
 * `history:head:stall`, a stall as its fields (stall.ts).
 */

import { type Stall, type StallFields, stallFromFields, stallToFields } from "./stall";
import type { HeadStateUpdate, LowerStateUpdate, TierState, TierStateStore } from "./tier";

/** What tier state needs of the head's storage. */
export interface TierStatePort {
	/** A stored value by key (`history:tier:…`, `history:head:stall`), or undefined. */
	value(key: string): string | undefined;
	/** Writes a value, or removes it for null. */
	setValue(key: string, value: string | null): void;
	/** The head's own floor: nothing below it is in the head. */
	hotFloor(): number;
	/** Where history starts (HistoryHead.publishedFloor). */
	publishedFloor(): number;
	/** The newest op queued so far (its seq), 0 for none. */
	opsSeq(): number;
	/** The head's copy marker: the newest log ID the next tier holds, 0 for none. */
	copyMarker(): number;
	/** Raises the copy marker (never lowers it). */
	raiseCopyMarker(through: number): void;
}

export const TIER_STATE_KEY = "history:tier:";
export const HEAD_STALL_KEY = "history:head:stall";

/** A lower tier's state as stored. */
interface StoredLower extends StallFields {
	floor: number;
	target: number;
	through: number;
	ops: number;
	opCursor?: string;
}

function parse<T>(text: string | undefined): T | undefined {
	if (!text) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

/** Tier state over `port`, the head being `head`. */
export function tierStateStore(port: TierStatePort, head: string): TierStateStore {
	let headTarget = 0;
	const fresh = (): StoredLower => {
		const published = port.publishedFloor();
		return { floor: published, target: published, through: published - 1, ops: port.opsSeq() };
	};
	const lower = (name: string): StoredLower => {
		const saved = parse<Partial<StoredLower>>(port.value(TIER_STATE_KEY + name));
		return saved && typeof saved.floor === "number" && typeof saved.through === "number" ? { ...fresh(), ...saved } : fresh();
	};
	const headStall = (): Stall => stallFromFields(parse<StallFields>(port.value(HEAD_STALL_KEY)));
	const writeHeadStall = (stall: Stall) => {
		const fields = stallToFields(stall);
		port.setValue(HEAD_STALL_KEY, Object.keys(fields).length ? JSON.stringify(fields) : null);
	};
	return {
		async load(names) {
			const out: Record<string, TierState> = {};
			for (const name of names) {
				if (name === head) {
					const floor = port.hotFloor();
					const through = port.copyMarker();
					out[name] = { floor, target: Math.max(floor, headTarget), through: through > 0 ? through : floor - 1, ops: 0, stall: headStall() };
					continue;
				}
				const { stalledSince, stalledOn, alertedAt, opCursor, ...rest } = lower(name);
				out[name] = { ...rest, ...(opCursor !== undefined ? { opCursor } : {}), stall: stallFromFields({ stalledSince, stalledOn, alertedAt }) };
			}
			return out;
		},
		async saveHead(update: HeadStateUpdate) {
			// update.floor: the head's floor is its hot floor, which its own cleanup moves.
			if (update.target !== undefined) headTarget = Math.max(headTarget, update.target);
			if (update.through !== undefined && update.through > port.copyMarker()) port.raiseCopyMarker(update.through);
			if (update.stall !== undefined) writeHeadStall(update.stall);
		},
		async saveLower(name: string, update: LowerStateUpdate) {
			const { stall, opCursor, ...given } = update;
			const numbers = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined));
			const current = lower(name);
			const { stalledSince: _since, stalledOn: _on, alertedAt: _at, opCursor: oldCursor, ...kept } = current;
			const stallFields = stallToFields(stall ?? stallFromFields(current));
			const cursor = opCursor === null ? undefined : opCursor ?? oldCursor;
			const next: StoredLower = { ...kept, ...numbers, ...(cursor !== undefined ? { opCursor: cursor } : {}), ...stallFields };
			port.setValue(TIER_STATE_KEY + name, JSON.stringify(next));
		},
		async has(name) {
			return port.value(TIER_STATE_KEY + name) !== undefined;
		},
	};
}
