/*
 * ContentPolicy: the one definition of what this server takes as content,
 * shared by a client's post (the Store's commit paths) and an import (a
 * restored record, RestorePort.normalize). Built from limits alone: no
 * Store, no SQL, no config.
 *
 * A post builds its record field by field and calls the parts (body,
 * emojis, snapshot size, room fields); an import has whole records and
 * calls `record`, which composes the same parts per kind, so an import
 * never keeps what a post would refuse. A refusal carries the code and
 * message a post answers with.
 *
 * What stays the Store's, since it reads state: whether a custom emoji key
 * is in this server's catalog, whether a reply's target exists, and the
 * caps that count rows (reacting users per message, rooms, threads).
 */

import { type ChatRecord, type NameLimits, roomClientFields, withClientUsers } from "@apron/archive";
import { type BodyLimits, type MessageBody, isEmptyBody, normalizeBody, sharedTextBody } from "./body.ts";
import { normalizeEmojis } from "./emoji.ts";
import { type SnapshotLike, contentBytes } from "./snapshot.ts";
import { type Verdict, accept, isPlainObject, refuse, utf8Bytes } from "./verdict.ts";

export interface ContentLimits extends BodyLimits, NameLimits {
	/** Most bytes in a message snapshot's client content (contentBytes). */
	maxSnapshotBytes: number;
	/** Most entries in one user's reaction set (a count limit: denied). */
	reactionEmojisPerUser: number;
	/** Most bytes in a room's client fields (title, description, ext) as JSON. */
	roomMetadataBytes: number;
}

export interface ContentPolicy {
	readonly limits: ContentLimits;
	/** A client's message body as kept. */
	body(value: unknown): Verdict<MessageBody>;
	/** An editor's save (ext:editors): the current body with the request's text. */
	sharedText(current: Record<string, unknown> | undefined, value: unknown): Verdict<Record<string, unknown> & { text: string }>;
	/** A reaction set as kept. */
	emojis(value: unknown): Verdict<string[]>;
	/** Whether a snapshot's client content fits maxSnapshotBytes. */
	snapshot(snapshot: SnapshotLike): Verdict<void>;
	/** Whether a room's client fields fit roomMetadataBytes. */
	roomFields(fields: Record<string, unknown>): Verdict<void>;
	/** A logged record as a client could have produced it, or why none could: the parts above, per kind. */
	record(record: ChatRecord): Verdict<ChatRecord>;
}

export function contentPolicy(limits: ContentLimits): ContentPolicy {
	const snapshot = (value: SnapshotLike): Verdict<void> =>
		contentBytes(value) > limits.maxSnapshotBytes ? refuse("too_large", "message snapshot is too large") : accept(undefined);
	const roomFields = (fields: Record<string, unknown>): Verdict<void> =>
		utf8Bytes(JSON.stringify(fields)) > limits.roomMetadataBytes ? refuse("too_large", "room metadata is too large") : accept(undefined);

	/** A message record's value as a post would have made it, in place. */
	const message = (value: Record<string, unknown>): Verdict<void> => {
		if (value.deleted !== undefined && typeof value.deleted !== "boolean") return refuse("invalid_params", "deleted must be boolean");
		if (value.ext !== undefined && !isPlainObject(value.ext)) return refuse("invalid_params", "ext must be an object");
		if (value.reply_to !== undefined) {
			const reply = value.reply_to;
			if (!isPlainObject(reply) || typeof reply.message_id !== "string" || reply.message_id.length === 0) return refuse("invalid_params", "reply_to.message_id must be a non-empty string");
			// Only the reference is kept, as a post keeps it.
			value.reply_to = { message_id: reply.message_id };
		}
		if (value.deleted === true) {
			// A tombstone carries no body and no ext (§4.4).
			delete value.body;
			delete value.ext;
		} else {
			if (value.body === undefined) return refuse("invalid_params", "message body is required");
			const body = normalizeBody(value.body, limits);
			if (!body.ok) return body;
			if (isEmptyBody(body.value)) return refuse("invalid_params", "message cannot be empty");
			value.body = body.value;
		}
		return snapshot(value as SnapshotLike);
	};

	/** A reactions record's sets, each as a post would keep it, in place. */
	const reactions = (value: Record<string, unknown>): Verdict<void> => {
		const sets = value.reactions as Array<Record<string, unknown>>;
		for (const set of sets) {
			const emojis = normalizeEmojis(set.emojis, limits);
			if (!emojis.ok) return emojis;
			set.emojis = emojis.value;
		}
		return accept(undefined);
	};

	/** A room record's client fields as a post would take them. */
	const room = (value: Record<string, unknown>): Verdict<void> => {
		if (value.title !== undefined && typeof value.title !== "string") return refuse("invalid_params", "title must be a string");
		if (value.description !== undefined && typeof value.description !== "string") return refuse("invalid_params", "description must be a string");
		if (value.ext !== undefined && !isPlainObject(value.ext)) return refuse("invalid_params", "ext must be an object");
		return roomFields(roomClientFields(value));
	};

	return {
		limits,
		body: (value) => normalizeBody(value, limits),
		sharedText: (current, value) => sharedTextBody(current, value, limits),
		emojis: (value) => normalizeEmojis(value, limits),
		snapshot,
		roomFields,
		record(record) {
			let value: unknown;
			try {
				value = typeof record?.record_json === "string" ? JSON.parse(record.record_json) : undefined;
			} catch {
				value = undefined;
			}
			if (!isPlainObject(value)) return refuse("invalid_params", "record is not a JSON object");
			// Every recorded user a client's: bare, a protocol ID, a name within the limits.
			if (!withClientUsers(value, record.kind, limits)) return refuse("invalid_params", "record names a user no client could be");
			const checked = record.kind === "message" ? message(value)
				: record.kind === "reactions" ? reactions(value)
				: record.kind === "room" ? room(value)
				: accept(undefined);
			if (!checked.ok) return checked;
			const json = JSON.stringify(value);
			return accept(json === record.record_json ? record : { ...record, record_json: json });
		},
	};
}
