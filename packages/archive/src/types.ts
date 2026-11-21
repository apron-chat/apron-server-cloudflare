/*
 * ARCHIVE.md v1 types (apron-web's ARCHIVE.md): JSON Lines, a
 * header on line 1, then parts holding listings (`joined`, `not_joined`,
 * `users`, as `room_list` gives them) and records (`rooms`, `messages`,
 * `reactions`, `memberships`, as `history` gives them). Readers ignore keys
 * they do not know.
 */

import type { ChatRecord } from "./records.ts";

export interface ArchivedUser {
	user_id: string;
	name?: string;
	avatar?: string;
	roles?: string[];
	ext?: Record<string, unknown>;
	[extra: string]: unknown;
}

export interface ArchiveHeader {
	apron_archive: 1;
	server?: string;
	exported_at?: string;
	you?: ArchivedUser;
	media?: string[];
	[extra: string]: unknown;
}

export interface RoomListing {
	room_id: string;
	log_id?: string;
	parent_room_id?: string;
	title?: string;
	description?: string;
	latest_log_id?: string;
	history_log_id?: string | null;
	members?: Array<{ user_id: string; [extra: string]: unknown }>;
	[extra: string]: unknown;
}

export interface ArchivedRoom {
	listing: RoomListing;
	joined: boolean;
}

export type ArchivePart =
	| { kind: "listing"; joined: RoomListing[]; not_joined: RoomListing[]; users: ArchivedUser[] }
	| { kind: "records"; records: ChatRecord[] }
	| { kind: "extra"; key: string; values: unknown[] }
	/** An unknown key with an object value (an extension's section), as it is. */
	| { kind: "field"; key: string; value: Record<string, unknown> };

/** Streaming ARCHIVE.md v1 writer: header first, then listings and users, then record parts. */
export interface ArchiveWriter {
	header(header: ArchiveHeader): Promise<void>;
	listing(part: { joined?: RoomListing[]; not_joined?: RoomListing[]; users?: ArchivedUser[] }): Promise<void>;
	/** Written as `rooms`/`messages`/`reactions`/`memberships` parts. */
	records(records: readonly ChatRecord[]): Promise<void>;
	/** Future sections' parts. */
	extra(key: string, values: readonly unknown[]): Promise<void>;
	close(): Promise<void>;
}

/** Streaming reader, tolerant as ARCHIVE.md §1 requires (skips blank and non-object lines, ignores unknown keys). */
export interface ArchiveReader {
	header(): Promise<ArchiveHeader>;
	/** In file order. */
	parts(): AsyncIterable<ArchivePart>;
}
