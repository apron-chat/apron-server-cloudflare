/*
 * A message snapshot (protocol §3.5): what in it is its author's content,
 * and what the server adds. The server's: `prev_log_id` and `prev_room_id`
 * (the links to the previous snapshot), and a finished terminal's `output`
 * (or its internal `output_ref`). The size limit bounds the rest
 * (contentBytes), as a save checks it and as an import does.
 */

import { isPlainObject, utf8Bytes } from "./verdict.ts";

/** The fields of a snapshot these rules read. */
export interface SnapshotLike {
	body?: Record<string, unknown>;
	reply_to?: { message_id: string };
	deleted?: boolean;
	ext?: Record<string, unknown>;
	prev_log_id?: string;
	prev_room_id?: string;
}

/** A snapshot without the server's finished terminal `output`s (or their refs). */
export function withoutOutputs<T extends SnapshotLike>(snapshot: T): T {
	const embeds = snapshot.body?.embeds;
	if (!Array.isArray(embeds) || !embeds.some((embed) => isPlainObject(embed) && (embed.output !== undefined || embed.output_ref !== undefined))) return snapshot;
	return {
		...snapshot,
		body: {
			...snapshot.body,
			embeds: embeds.map((embed) => {
				if (!isPlainObject(embed) || (embed.output === undefined && embed.output_ref === undefined)) return embed;
				const { output: _output, output_ref: _ref, ...rest } = embed;
				return rest;
			}),
		},
	};
}

/**
 * The bytes the snapshot size limit counts: the snapshot as JSON without
 * what the server adds (its links to the previous snapshot, and terminal
 * output). One definition, for a save and for an import.
 */
export function contentBytes(snapshot: SnapshotLike): number {
	const { prev_log_id: _log, prev_room_id: _room, ...client } = withoutOutputs(snapshot);
	return utf8Bytes(JSON.stringify(client));
}

/** A snapshot's content, which only its author changes: what a save keeps besides `room_id` and the server's links. */
export function messageContent(snapshot: SnapshotLike): Record<string, unknown> {
	return { body: snapshot.body, reply_to: snapshot.reply_to, deleted: snapshot.deleted === true, ext: snapshot.ext };
}

/**
 * ext:editors (apron's EXTENSIONS.md): whether `userId`, who did not send
 * the message, may save its `body.text`. Its sender shares it with
 * `ext.editors {"body.text": "mentioned"}`, and then each user in the current
 * `body.mentions` may save it. Any other key or value shares nothing.
 */
export function sharesText(snapshot: SnapshotLike, userId: string): boolean {
	if (snapshot.deleted) return false;
	const editors = snapshot.ext?.editors;
	if (!isPlainObject(editors) || editors["body.text"] !== "mentioned") return false;
	const mentions = snapshot.body?.mentions;
	return Array.isArray(mentions) && mentions.includes(userId);
}

/** Whether a message's body has an `append` embed, whose live text writes into `body.text` (§4.8.5). */
export function hasAppend(snapshot: SnapshotLike): boolean {
	const embeds = snapshot.body?.embeds;
	return Array.isArray(embeds) && embeds.some((embed) => isPlainObject(embed) && embed.kind === "append");
}

/**
 * `ext` with `ext.editors.edited_by` set to `userId`, or removed without one
 * (ext:editors): the server sets it on a save by someone other than the
 * sender, removes it on the sender's saves, and ignores it in requests.
 */
export function withEditedBy(ext: Record<string, unknown> | undefined, userId: string | undefined): Record<string, unknown> | undefined {
	const editors = ext?.editors;
	if (!ext || !isPlainObject(editors) || (userId === undefined && !Object.hasOwn(editors, "edited_by"))) return ext;
	const { edited_by: _, ...grants } = editors;
	const next = userId === undefined ? grants : { ...grants, edited_by: userId };
	const { editors: _old, ...rest } = ext;
	if (Object.keys(next).length) return { ...rest, editors: next };
	return Object.keys(rest).length ? rest : undefined;
}
