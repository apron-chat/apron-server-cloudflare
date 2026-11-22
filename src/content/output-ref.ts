/*
 * Terminal output kept in R2 (ApronDemoServer.storeTerminalOutput) is referred to
 * from its message's embed by an internal `output_ref`, which never leaves
 * the server: before a record goes out its output is put back from R2
 * (withTerminalOutputs), or the reference is dropped (withoutOutputRefs).
 * The one place that knows the reference's shape, and the one check for it
 * (refsOf). The Store, the runtime and the history component share it.
 */

import type { ChatRecord } from "@apron/archive";

/**
 * Where a stored terminal snapshot keeps its output instead of `output`:
 * the R2 key and the output's size as JSON, so a history page budgets for
 * it before the runtime puts it back (withTerminalOutputs). Never sent: the
 * runtime replaces it with `output`, or leaves it out.
 */
export interface TerminalOutputRef {
	key: string;
	bytes: number;
}

/**
 * The largest finished terminal `output`, in bytes of JSON: a control
 * character escapes to six (`\u001b`), so the kept bytes are cut further when
 * escaping would pass it, and one record always fits a history response.
 * Colored output escapes to about 1.4 times its bytes (32 KB of it was 45 KB
 * of JSON), so this cuts only output dense in control characters, and it
 * bounds what history by count (historyHotRecords) can hold of terminals.
 */
export const MAX_TERMINAL_OUTPUT_JSON_BYTES = 64 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A terminal embed's TerminalOutputRef as the server writes it, or undefined. */
export function outputRef(embed: unknown): TerminalOutputRef | undefined {
	if (!isPlainObject(embed) || embed.kind !== "terminal" || !isPlainObject(embed.output_ref)) return undefined;
	const { key, bytes } = embed.output_ref;
	return typeof key === "string" && /^f\/[A-Za-z0-9_-]{22}$/.test(key) && Number.isSafeInteger(bytes) && (bytes as number) >= 0 && (bytes as number) <= MAX_TERMINAL_OUTPUT_JSON_BYTES
		? { key, bytes: bytes as number } : undefined;
}

/** Whether a record (its wire value) has any `output_ref`, valid or not: one that must be resolved or removed before it is sent. */
export function hasOutputRef(record: unknown): boolean {
	const embeds = isPlainObject(record) && isPlainObject(record.body) ? record.body.embeds : undefined;
	return Array.isArray(embeds) && embeds.some((embed) => isPlainObject(embed) && embed.output_ref !== undefined);
}

/** The R2 keys of the terminal outputs a record refers to; only well-formed refs on terminal embeds. */
export function terminalOutputKeys(record: unknown): string[] {
	const embeds = isPlainObject(record) && isPlainObject(record.body) ? record.body.embeds : undefined;
	if (!Array.isArray(embeds)) return [];
	return embeds.flatMap((embed) => {
		const ref = outputRef(embed);
		return ref ? [ref.key] : [];
	});
}

/**
 * A record with each stored terminal's output put back from `outputs` (by
 * R2 key), and its TerminalOutputRef removed either way: a terminal whose
 * output could not be read goes without it. The record itself is unchanged.
 */
export function withTerminalOutputs<T>(record: T, outputs: (key: string) => string | undefined): T {
	if (!hasOutputRef(record)) return record;
	const value = record as unknown as Record<string, unknown> & { body: Record<string, unknown> & { embeds: unknown[] } };
	const embeds = value.body.embeds.map((embed) => {
		if (!isPlainObject(embed) || embed.output_ref === undefined) return embed;
		const ref = outputRef(embed);
		const { output_ref: _ref, ...rest } = embed;
		const output = ref ? outputs(ref.key) : undefined;
		return output === undefined ? rest : { ...rest, output };
	});
	return { ...value, body: { ...value.body, embeds } } as unknown as T;
}

/**
 * The one check of a logged record: its wire value, parsed, when it holds an
 * `output_ref` (a message's embed); undefined otherwise. Most records are
 * passed over without parsing.
 */
export function refsOf(record: ChatRecord): Record<string, unknown> | undefined {
	if (record.kind !== "message" || !record.record_json.includes("output_ref")) return undefined;
	const value: unknown = JSON.parse(record.record_json);
	return isPlainObject(value) && hasOutputRef(value) ? value : undefined;
}

/** A record with any `output_ref` dropped (and no output put back): for records taken from elsewhere, or with nothing to resolve them. */
export function withoutOutputRefs(record: ChatRecord): ChatRecord {
	const value = refsOf(record);
	return value ? { ...record, record_json: JSON.stringify(withTerminalOutputs(value, () => undefined)) } : record;
}
