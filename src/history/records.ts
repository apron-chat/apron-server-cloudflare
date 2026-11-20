/*
 * Records: the unit every history tier stores and hands on.
 *
 * A record is one entry of the server-wide log (a room record, message
 * snapshot, reaction record or membership record) in its wire shape, as
 * `history` serves it, with the room it is logged in and its log ID. A move
 * is logged once per room it belongs to: two records, one log ID. The
 * record type and its format-level helpers are @apron/archive's
 * (packages/archive/src/records.ts); this module adds what the chain
 * needs: ranges, queries, retention, and the rewrites /purge and /rename
 * send down the chain.
 *
 * Everything here is pure: no I/O, no clock.
 */

import { type ChatRecord, authoredMessages, byLog, purgedRecord, renamedRecord } from "@apron/archive";
import { refsOf, withoutOutputRefs } from "../content/output-ref";

export { type ChatRecord, type RecordKind, authoredMessages, byLog, logIds, purgedRecord, renamedRecord } from "@apron/archive";

declare const PUBLIC: unique symbol;

/**
 * A record as it may leave the server (an export, a backup): no internal
 * `output_ref`, its terminal output put back or dropped (src/output-ref.ts).
 * Only asPublic makes one.
 */
export type PublicRecord = ChatRecord & { readonly [PUBLIC]: true };

/** Records as public, checked: one still holding an `output_ref` is an error, never written out. */
export function asPublic(records: readonly ChatRecord[]): PublicRecord[] {
	for (const record of records) if (refsOf(record)) throw new Error(`record ${record.log_id} in ${record.room_id} still holds an internal output reference`);
	return records as PublicRecord[];
}

/** Records made public with every `output_ref` dropped, no output put back: for a server with no terminal output to resolve. */
export async function withoutOutputs(records: readonly ChatRecord[]): Promise<PublicRecord[]> {
	return asPublic(records.map(withoutOutputRefs));
}

/** A contiguous range of the log: the unit tiers hand on. Records sorted by (log_id, room_id). */
export interface RecordRange {
	first: number;
	last: number;
	records: ChatRecord[];
}

/** What a history page asks of a tier. `limit` counts distinct log IDs (a move's rows take one place). */
export interface HistoryQuery {
	roomIds: string[];
	/** Inclusive. */
	lower: number;
	/** Inclusive. */
	upper: number;
	forward: boolean;
	limit: number;
}

/**
 * A tier's ceiling: retention keeps `thresholdPercent` of whichever limits
 * are set (the strictest wins). `minAgeMs` holds records younger than it
 * whatever the count says.
 */
export interface Retention {
	records?: number;
	bytes?: number;
	ageMs?: number;
	minAgeMs?: number;
	thresholdPercent: number;
}

export interface TierStats {
	records: number;
	bytes?: number;
	oldest?: number;
	newest?: number;
}

/** A clock, injected: nothing under src/history/ reads Date.now(). */
export interface Clock {
	now(): number;
}

/**
 * What `/purge` or `/rename` did at the head, for the tiers below to do
 * too: `user` renamed `into` another ID, or purged (`into` null). A purge
 * goes with the messages of its user found so far (`messages`): reaction
 * sets on them go too, wherever they are.
 */
export interface Rewrite {
	user: string;
	into: string | null;
	messages?: string[];
}

/** A Rewrite in the head's log, numbered in order: links deliver them down the chain in that order. */
export interface QueuedRewrite {
	seq: number;
	rewrite: Rewrite;
}

/**
 * A rewrite delivered to a tier that takes none (the cold tier): kept, and
 * applied to what that tier holds whenever it is read, up to `through`, the
 * newest log ID it held when the rewrite reached it. What it took later came
 * from a tier that had applied the rewrite already.
 */
export interface KeptRewrite extends QueuedRewrite {
	through: number;
}

/**
 * Records of a tier that takes no rewrites, with the rewrites it kept
 * applied in order, each record by itself: a purged user's message
 * snapshots, reaction sets and memberships go, and reaction sets on the
 * messages the purge names (those the tiers above found); a renamed user's
 * ID changes. Nothing is inferred across records, so a page shows the same
 * whatever records share it (a reaction set on a purged message only this
 * tier holds stays, unless the purge names that message). Only records at
 * or below each rewrite's `through` are touched.
 */
export function withKept(records: readonly ChatRecord[], kept: readonly KeptRewrite[]): ChatRecord[] {
	let out = [...records];
	for (const { rewrite, through } of kept) {
		out = out.flatMap((record) => {
			if (record.log_id > through) return [record];
			const json = rewrite.into === null ? purgedRecord(record, [rewrite.user], rewrite.messages ?? []) : renamedRecord(record, rewrite.user, rewrite.into);
			return json === null ? [] : [json === record.record_json ? record : { ...record, record_json: json }];
		});
	}
	return out;
}

/** The records a count keeps under a threshold: `percent` of `limit`, at least one; 0 without a limit. */
export function thresholdCount(limit: number | undefined, percent: number): number {
	return limit && limit > 0 ? Math.max(1, Math.floor((limit * percent) / 100)) : 0;
}

/**
 * The records of the first `limit` distinct log IDs, nearest the page's
 * start first: oldest first `forward`, else newest. Every room's copy of a
 * kept log ID stays.
 */
export function limitByLogId(records: readonly ChatRecord[], limit: number, forward: boolean): ChatRecord[] {
	const sorted = [...records].sort((a, b) => (forward ? 1 : -1) * byLog(a, b));
	const kept = new Set<number>();
	const out: ChatRecord[] = [];
	for (const record of sorted) {
		if (!kept.has(record.log_id)) {
			if (kept.size >= limit) break;
			kept.add(record.log_id);
		}
		out.push(record);
	}
	return out;
}

/** A range over `records`, sorted; empty ranges have first > last. */
export function toRange(records: readonly ChatRecord[]): RecordRange {
	const sorted = [...records].sort(byLog);
	return sorted.length
		? { first: sorted[0].log_id, last: sorted[sorted.length - 1].log_id, records: sorted }
		: { first: 1, last: 0, records: [] };
}

/**
 * Records with rewrites applied in order, as a tier that takes them
 * (HistoryTier.rewrite) applies them to what it holds: a purged user's
 * message snapshots go, with every reaction set on those messages (the
 * rewrite's own, and those found among `records`), and their reaction sets
 * and memberships; a record left empty goes. Used on pages read from a tier
 * a rewrite has yet to reach.
 */
export function rewritten(records: readonly ChatRecord[], rewrites: readonly Rewrite[]): ChatRecord[] {
	let out = [...records];
	for (const { user, into, messages } of rewrites) {
		if (into === null) {
			const dropped = [...new Set([...(messages ?? []), ...authoredMessages(out, [user])])];
			out = out.flatMap((record) => {
				const json = purgedRecord(record, [user], dropped);
				return json === null ? [] : [json === record.record_json ? record : { ...record, record_json: json }];
			});
		} else {
			out = out.map((record) => {
				const json = renamedRecord(record, user, into);
				return json === record.record_json ? record : { ...record, record_json: json };
			});
		}
	}
	return out;
}
