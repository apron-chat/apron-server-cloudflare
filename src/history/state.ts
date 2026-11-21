/*
 * The chain's state (ChainStateStore), over a small port of the head's
 * storage: plain values by key, and the few numbers the head owns. The
 * rules are here, not in the Store:
 *
 * - A tier's state is its floor and target. The head's floor is its hot
 *   floor (its own cleanup moves it); its target is kept in memory, as the
 *   head's cleanup finds it again after a wake. A lower tier with no state
 *   yet starts at the published floor, holding nothing.
 * - A link's state is what it holds of the tier above, what it delivered
 *   below, and its stall. The head's link holds through the copy marker,
 *   which the head's cleanup stops at (the port's, never lowered). A link
 *   with no state yet holds nothing and has delivered nothing: it delivers
 *   what the head's log still has, which costs nothing on an empty tier.
 * - A tier that takes no rewrites keeps those it was delivered (KeptRewrite),
 *   each under its own key, until its floor passes what it held then.
 *
 * Persisted as JSON under `history:tier:<name>`, `history:link:<from>` (a
 * stall as its fields, stall.ts) and `history:kept:<name>:<seq>`.
 */

import { type StallFields, stallFromFields, stallToFields } from "./stall";
import type { KeptRewrite } from "./records";
import type { ChainStateStore, LinkState, TierFloor } from "./tier";

/** What the chain's state needs of the head's storage. */
export interface ChainStatePort {
	/** A stored value by key (`history:tier:…`, `history:link:…`), or undefined. */
	value(key: string): string | undefined;
	/** Writes a value, or removes it for null. */
	setValue(key: string, value: string | null): void;
	/** The head's own floor: nothing below it is in the head. */
	hotFloor(): number;
	/** Where history starts (HistoryHead.publishedFloor). */
	publishedFloor(): number;
	/** The head's copy marker: the newest log ID the next tier holds, 0 for none. */
	copyMarker(): number;
	/** Raises the copy marker (never lowers it). */
	raiseCopyMarker(through: number): void;
	/** The values whose keys start with `prefix` (`history:kept:…`), by key, in key order. */
	entries(prefix: string): Array<[string, string]>;
}

export const TIER_STATE_KEY = "history:tier:";
export const LINK_STATE_KEY = "history:link:";
/**
 * The most groups of kept rewrites a tier that takes none holds at once
 * (KeptRewrite: those delivered while it held the same newest log ID, so a
 * group a change of the tier, not a /purge or /rename): past it, delivering
 * another into a new group fails, and the link stalls (and alerts) rather
 * than serve what it would change.
 */
export const MAX_KEPT_GROUPS = 4_096;
/**
 * The most one group of kept rewrites holds, as stored (its JSON, one
 * `_meta` value): a group that would pass it is closed, and the next
 * rewrite starts another with the same `through`. Well under SQLite's
 * value limit (2 MB), so a quiet tier, whose `through` seldom moves, never
 * stores a value too large to keep.
 */
export const MAX_KEPT_GROUP_BYTES = 256 * 1024;
/** A group of kept rewrites (KeptRewrite) of a tier that takes none: `history:kept:<tier>:<first seq, 16 digits>`. */
export const KEPT_STATE_KEY = "history:kept:";

const keptKey = (name: string, first: number) => `${KEPT_STATE_KEY}${name}:${String(first).padStart(16, "0")}`;
const isKept = (entry: KeptRewrite | undefined): entry is KeptRewrite =>
	!!entry && typeof entry.first === "number" && typeof entry.seq === "number" && typeof entry.through === "number" && Array.isArray(entry.rewrites)
	&& entry.rewrites.every((rewrite) => typeof rewrite?.user === "string");

interface StoredLink extends StallFields {
	through?: number;
	delivered: number;
}

function parse<T>(text: string | undefined): T | undefined {
	if (!text) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

/** The chain's state over `port`, the head being `head`. */
export function chainStateStore(port: ChainStatePort, head: string): ChainStateStore {
	let headTarget = 0;
	const tier = (name: string): TierFloor => {
		if (name === head) {
			const floor = port.hotFloor();
			return { floor, target: Math.max(floor, headTarget) };
		}
		const saved = parse<Partial<TierFloor>>(port.value(TIER_STATE_KEY + name));
		const published = port.publishedFloor();
		return typeof saved?.floor === "number" ? { floor: saved.floor, target: saved.target ?? saved.floor } : { floor: published, target: published };
	};
	const storedLink = (from: string): StoredLink | undefined => {
		const saved = parse<StoredLink>(port.value(LINK_STATE_KEY + from));
		return typeof saved?.delivered === "number" ? saved : undefined;
	};
	const link = (from: string): LinkState => {
		const saved = storedLink(from);
		const marker = from === head ? port.copyMarker() : undefined;
		const through = from === head ? (marker! > 0 ? marker! : port.hotFloor() - 1) : saved?.through ?? tier(from).floor - 1;
		return { through, delivered: saved?.delivered ?? 0, stall: stallFromFields(saved) };
	};
	return {
		async load(names) {
			return { tiers: names.map(tier), links: names.slice(0, -1).map(link) };
		},
		async loadLink(from) {
			return link(from);
		},
		async has(name) {
			return port.value(TIER_STATE_KEY + name) !== undefined;
		},
		async saveTier(name, update) {
			if (name === head) {
				// The head's floor is its hot floor, which its own cleanup moves.
				if (update.target !== undefined) headTarget = Math.max(headTarget, update.target);
				return;
			}
			const next = { ...tier(name), ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)) };
			port.setValue(TIER_STATE_KEY + name, JSON.stringify(next));
		},
		async saveLink(from, update) {
			const current = link(from);
			if (from === head && update.through !== undefined && update.through > port.copyMarker()) port.raiseCopyMarker(update.through);
			const stall = update.stall ?? current.stall;
			const next: StoredLink = {
				...(from === head ? {} : { through: update.through ?? current.through }),
				delivered: update.delivered ?? current.delivered,
				...stallToFields(stall),
			};
			port.setValue(LINK_STATE_KEY + from, JSON.stringify(next));
		},
		async kept(name) {
			return port.entries(`${KEPT_STATE_KEY}${name}:`).flatMap(([, text]) => {
				const entry = parse<KeptRewrite>(text);
				return isKept(entry) ? [entry] : [];
			});
		},
		async keep(name, entry) {
			port.setValue(keptKey(name, entry.first), JSON.stringify(entry));
		},
		async forgetKept(name, floor) {
			for (const [key, text] of port.entries(`${KEPT_STATE_KEY}${name}:`)) {
				const entry = parse<KeptRewrite>(text);
				if (!isKept(entry) || entry.through < floor) port.setValue(key, null);
			}
		},
	};
}
