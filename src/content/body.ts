/*
 * A message's `body` (protocol §3.5) as a client sends it: `text` within
 * the text limit, `format` plain (the default) or markdown, `embeds` objects
 * with a `kind` (at most `maxEmbeds`, their `og` trimmed, embeds.ts), and
 * `mentions` the user_ids its sender lists (deduplicated; the server never
 * reads mentions out of text). `output_ref` is the server's alone
 * (output-ref.ts): a client's is dropped.
 */

import { isProtocolId } from "@apron/archive";
import { type HostList, withCleanOg } from "./embeds.ts";
import { type Verdict, accept, boundedText, cloneJson, isPlainObject, refuse, utf8Bytes } from "./verdict.ts";

export interface BodyLimits {
	/** Most UTF-8 bytes in `body.text`. */
	maxTextBytes: number;
	/** Most embeds a body holds (a count limit: `denied`). */
	maxEmbeds: number;
	/** Hosts `og` media may come from (server policy). */
	ogMediaHosts: HostList;
}

/** Most UTF-8 bytes in one mentioned user_id. */
export const MAX_MENTION_BYTES = 256;

/** A body as kept: its text, format and embeds always present, mentions when given. */
export type MessageBody = Record<string, unknown> & { text: string; format: "plain" | "markdown"; embeds: Record<string, unknown>[]; mentions?: string[] };

/** A client's body as this server keeps it, or why it is refused. */
export function normalizeBody(value: unknown, limits: BodyLimits): Verdict<MessageBody> {
	if (!isPlainObject(value)) return refuse("invalid_params", "body must be an object");
	const body = value;
	const text = body.text === undefined ? accept("") : boundedText(body.text, "body.text", limits.maxTextBytes);
	if (!text.ok) return text;
	// The protocol defaults an omitted format to plain text.
	const format = body.format === undefined ? "plain" : body.format;
	if (format !== "plain" && format !== "markdown") return refuse("invalid_params", "body.format is invalid");
	const embeds = body.embeds === undefined ? [] : body.embeds;
	if (!Array.isArray(embeds)) return refuse("invalid_params", "body.embeds must be an array");
	// A count limit this server sets: denied (§1.1).
	if (embeds.length > limits.maxEmbeds) return refuse("denied", `A message has at most ${limits.maxEmbeds} embeds`);
	for (const embed of embeds) {
		if (!isPlainObject(embed) || typeof embed.kind !== "string" || embed.kind.length === 0) {
			return refuse("invalid_params", "body.embeds must be objects with a kind");
		}
	}
	let mentions: string[] | undefined;
	if (body.mentions !== undefined) {
		if (!Array.isArray(body.mentions)) return refuse("invalid_params", "body.mentions must be an array of user_id strings");
		const unique = new Set<string>();
		for (const item of body.mentions) {
			// Mentions are user_ids (§2.4): a string that cannot be one makes the whole message invalid.
			if (!isProtocolId(item)) return refuse("invalid_params", "body.mentions must be an array of user_id strings");
			if (utf8Bytes(item) > MAX_MENTION_BYTES) return refuse("too_large", "a mentioned user_id is too long");
			unique.add(item);
		}
		mentions = [...unique];
	}
	// `output_ref` is the server's alone (output-ref.ts): a client's is dropped.
	const clientEmbeds = (cloneJson(embeds) as Record<string, unknown>[]).map(({ output_ref: _ref, ...embed }) => withCleanOg(embed, limits.ogMediaHosts));
	return accept({ ...cloneJson(body), text: text.value, format, embeds: clientEmbeds, ...(mentions ? { mentions } : {}) } as MessageBody);
}

/**
 * The body of an editor's save (ext:editors): the current body, with the
 * text that the request carries, checked as any text is.
 */
export function sharedTextBody(current: Record<string, unknown> | undefined, value: unknown, limits: Pick<BodyLimits, "maxTextBytes">): Verdict<Record<string, unknown> & { text: string }> {
	if (!isPlainObject(value)) return refuse("invalid_params", "body must be an object");
	const text = value.text === undefined ? accept("") : boundedText(value.text, "body.text", limits.maxTextBytes);
	if (!text.ok) return text;
	return accept({ ...cloneJson(current ?? {}), text: text.value });
}

/** Whether a kept body says nothing: no text and no embeds (§3.5.1: a new one is `invalid_params`). */
export function isEmptyBody(body: Pick<MessageBody, "text" | "embeds">): boolean {
	return body.text === "" && body.embeds.length === 0;
}
