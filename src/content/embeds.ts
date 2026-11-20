/*
 * Embeds (protocol §4.8): what a message's `body.embeds` may hold as a
 * client sends it, and the embeds the server writes itself.
 *
 * Protocol-level: an embed is an object with a non-empty `kind`, and its
 * `og` (§4.8.1), which clients build themselves (such as link previews), is
 * the server's to trim: kept as one line of plain text per field, the rest
 * dropped. Server policy: which hosts `og` media may point at
 * (`ogMediaHosts`, OG_MEDIA_HOSTS), and the upload and live-text result
 * embeds this server writes.
 */

import { isPlainObject, utf8Bytes } from "./verdict.ts";

/**
 * The text an embed's `og` may carry, with its longest kept length in code
 * points. Media are kept only from the media hosts.
 */
export const OG_TEXT_FIELDS: Readonly<Record<string, number>> = { title: 256, description: 512, site_name: 128 };
export const OG_MEDIA_FIELDS = ["image", "video", "audio"] as const;
const OG_MEDIA_URL_BYTES = 2_048;
const OG_MEDIA_TYPE_BYTES = 128;
const OG_MEDIA_ALT_CODE_POINTS = 512;
const OG_MEDIA_MAX_DIMENSION = 16_384;

/** Control, bidirectional override, and line or paragraph separator characters. */
const OG_UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Hosts media may come from: `"*"` for any, else exact hosts or `*.` suffixes. */
export type HostList = readonly string[] | "*";

/** Whether `host` is on a host list: `"*"`, an exact entry, or under a `*.example.com` entry. */
export function hostListAllowed(hosts: HostList, host: string): boolean {
	if (hosts === "*") return true;
	return hosts.some((entry) => entry.startsWith("*.") ? host.endsWith(entry.slice(1)) : host === entry);
}

/** `value` as one line of plain text of at most `max` code points, or undefined when empty. */
export function ogLine(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const line = value.replace(OG_UNSAFE_CHARACTERS, " ").replace(/\s+/g, " ").trim();
	const points = [...line];
	if (!points.length) return undefined;
	return points.length > max ? `${points.slice(0, max - 1).join("").trimEnd()}…` : line;
}

/**
 * An `og` media object with an absolute `https:` `url` on one of `hosts`,
 * without credentials or a port, and bounded details; or undefined.
 */
export function ogMedia(value: unknown, hosts: HostList): Record<string, unknown> | undefined {
	if (!isPlainObject(value) || typeof value.url !== "string" || utf8Bytes(value.url) > OG_MEDIA_URL_BYTES) return undefined;
	let url: URL;
	try {
		url = new URL(value.url);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
	if (!hostListAllowed(hosts, url.hostname)) return undefined;
	const media: Record<string, unknown> = { url: url.href };
	if (typeof value.type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(value.type) && value.type.length <= OG_MEDIA_TYPE_BYTES) media.type = value.type;
	for (const field of ["width", "height"] as const) {
		const size = value[field];
		if (Number.isInteger(size) && (size as number) > 0 && (size as number) <= OG_MEDIA_MAX_DIMENSION) media[field] = size;
	}
	const alt = ogLine(value.alt, OG_MEDIA_ALT_CODE_POINTS);
	if (alt) media.alt = alt;
	return media;
}

/**
 * `embed` with its `og` reduced to kept text fields, plus media on one of
 * `mediaHosts`, or without `og` when nothing is left.
 */
export function withCleanOg(embed: Record<string, unknown>, mediaHosts: HostList): Record<string, unknown> {
	if (embed.og === undefined) return embed;
	const { og, ...rest } = embed;
	const clean: Record<string, unknown> = {};
	if (isPlainObject(og)) {
		for (const [field, max] of Object.entries(OG_TEXT_FIELDS)) {
			const line = ogLine(og[field], max);
			if (line) clean[field] = line;
		}
		if (mediaHosts === "*" || mediaHosts.length) {
			for (const field of OG_MEDIA_FIELDS) {
				const media = ogMedia(og[field], mediaHosts);
				if (media) clean[field] = media;
			}
		}
	}
	return Object.keys(clean).length ? { ...rest, og: clean } : rest;
}

/** An upload embed's `title`: its sender's single line of text, bounded like `og.title`. */
export function uploadTitle(value: unknown): string | undefined {
	return ogLine(value, OG_TEXT_FIELDS.title);
}

/**
 * A terminal embed's `og` (protocol §4.8.1): what it is, for a client that
 * doesn't render terminal embeds and shows it as the card its `og`
 * describes, which opens its `url`. Titled as the embed is.
 */
export function terminalOg(title: unknown): { title: string; description: string } {
	return { title: typeof title === "string" && title ? title : "Terminal", description: "Terminal output. Open it to watch." };
}

/** What a pending upload's result embed needs (server policy: this server's uploads). */
export interface PendingWrite {
	key: string;
	embedId: string;
	maxBytes: number;
	writeExpiresMs: number;
}

/**
 * A new upload as a result lists it (§4.8.3), with `write` in place of the
 * `write_url` the runtime signs from it. Kept in the stored result, so a
 * retry signs the same URL.
 */
export function uploadResultEmbed(upload: PendingWrite): Record<string, unknown> {
	return {
		embed_id: upload.embedId,
		kind: "upload",
		write: { key: upload.key, max_bytes: upload.maxBytes, expires_ms: upload.writeExpiresMs },
	};
}

/** What a live text's result embed needs (server policy: this server's live texts). */
export interface LiveWrite {
	key: string;
	kind: "terminal" | "append";
	embedId: string;
	limit: number;
	writeExpiresMs: number;
}

/**
 * The most bytes a write may send: for an append, the bytes it keeps (its
 * `limit`), so edits never let it stream more than an append without them;
 * for a terminal, `maxInputBytes`.
 */
export function liveInputLimit(entry: Pick<LiveWrite, "kind" | "limit">, policy: { maxInputBytes: number }): number {
	return entry.kind === "append" ? Math.min(entry.limit, policy.maxInputBytes) : policy.maxInputBytes;
}

/**
 * A new live text as a result lists it (§4.8.3), with `write` in place of
 * the `write_url` the runtime signs from it, as for an upload.
 */
export function liveResultEmbed(entry: LiveWrite, policy: { maxInputBytes: number }): Record<string, unknown> {
	return {
		embed_id: entry.embedId,
		kind: entry.kind,
		write: { key: entry.key, max_bytes: liveInputLimit(entry, policy), expires_ms: entry.writeExpiresMs },
	};
}
