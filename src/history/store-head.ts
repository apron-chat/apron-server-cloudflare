/*
 * The Durable Object's Store as the history component's ports: adapters,
 * not reimplementations. Each takes only the Store methods it uses (a
 * narrow structural port, so this module does not load the Store):
 *
 * - storeHead: the head the chain runs (HistoryHead). Its trimming is
 *   the Store's own cleanup (Store.runCleanup), which removes records only
 *   below the copy marker and on its own schedule: trimBelow asks nothing
 *   of it. Its retention is the Store's config, found by the running
 *   cleanup job: floorFor ignores the Retention passed in.
 * - storeRestore: what an import writes through (RestorePort).
 * - storeExport: the rooms and users an export carries (ExportPort).
 *
 * The chain's state is state.ts over Store.historyStatePort().
 */

import { type ArchivedRoom, type ArchivedUser, MAX_LISTING_MEMBERS, type RoomListing } from "@apron/archive";
import { type ChatRecord, type HistoryQuery, type QueuedRewrite, type RecordRange, type TierStats, toRange } from "./records";
import type { ExportPort, HistoryHead, RestoreContext, RestorePort, RestoreResult } from "./tier";

/** What the head needs of the Store. */
export interface HeadStore {
	historyFloors(): { hot: number; published: number; latest: number };
	historyTarget(): number | undefined;
	historyScan(from: number, limit?: number): ChatRecord[];
	/** The most log IDs historyScan returns at once, whatever it is asked. */
	readonly historyScanLimit: number;
	historyRecords(query: HistoryQuery): ChatRecord[];
	historyLookup(logIds: readonly number[]): ChatRecord[];
	hotRecords(): number;
	publishHistoryFloor(floor: number): void;
	historyRewrites(): QueuedRewrite[];
	historyRewritesLogged(): number;
	dropHistoryRewrites(seq: number): void;
	amendHistoryPurge(seq: number, messageIds: readonly string[]): void;
	dropReactionsOn(messageIds: readonly string[]): void;
	purgeUsers(input: { userIds: readonly string[] }): unknown;
	renameIdentity(input: { from: string; to: string }): unknown;
}

/** What an import needs of the Store. */
export interface RestoreStore {
	getRoom(roomId: string): unknown;
	roomIsEmpty(roomId: string): boolean;
	identityExists(userId: string): boolean;
	isRetiredUserId(userId: string): boolean;
	historyFloors(): { latest: number };
	readonly content: { record(record: ChatRecord): { ok: true; value: ChatRecord } | { ok: false } };
	restoreUsers(users: readonly ArchivedUser[]): void;
	accountCapacity(): { used: number; limit: number };
	restoreRoomCapacity(rooms: readonly RoomListing[]): string | undefined;
	restoreRoom(room: ArchivedRoom, records: readonly ChatRecord[], now?: number, options?: { rooms?: readonly string[] }): RestoreResult;
	restoreMembers(roomId: string, changes: { join: readonly string[]; leave: readonly string[] }): { joined: number; left: number; skipped: number };
	historyImportJournal(): string | undefined;
	setHistoryImportJournal(value: string | null): void;
}

/** What an export needs of the Store. */
export interface ExportStore {
	listRooms(now?: number, options?: { maintenance?: boolean; withPrivate?: boolean }): Array<{ room_id: string }>;
	getIdentity(userId: string): { userId: string; name: string; avatar?: string; roles: string[]; ext?: Record<string, unknown> } | null;
	exportMembers(roomId: string, limit: number): { members: string[]; count: number };
}

export function storeHead(name: string, store: HeadStore): HistoryHead {
	return {
		name,
		/** The Store makes its records by commit: nothing is copied into it. */
		async append(range: RecordRange) {
			if (range.records.length) throw new Error("this head takes records only by commit");
		},
		scanLimit: store.historyScanLimit,
		scan: async (from, limit) => toRange(store.historyScan(from, limit)),
		read: async (query) => store.historyRecords(query),
		lookup: async (ids) => store.historyLookup(ids),
		stats: async (): Promise<TierStats> => ({ records: store.hotRecords() }),
		floorFor: async () => store.historyTarget(),
		/** Cleanup trims, below the copy marker, on its own schedule. */
		trimBelow: async () => 0,
		rewrites: {
			list: async () => store.historyRewrites(),
			logged: async () => store.historyRewritesLogged(),
			drop: async (seq) => store.dropHistoryRewrites(seq),
			amend: async (seq, messageIds) => store.amendHistoryPurge(seq, messageIds),
		},
		purge: async (userIds) => void store.purgeUsers({ userIds }),
		rename: async (from, to) => void store.renameIdentity({ from, to }),
		dropReactionsOn: async (messageIds) => store.dropReactionsOn(messageIds),
		publishedFloor: async () => store.historyFloors().published,
		publish: async (floor) => store.publishHistoryFloor(floor),
	};
}

export function storeRestore(store: RestoreStore): RestorePort {
	return {
		hasRoom: async (roomId) => store.getRoom(roomId) !== null,
		roomIsEmpty: async (roomId) => store.roomIsEmpty(roomId),
		hasUser: async (userId) => store.identityExists(userId),
		isRetired: async (userId) => store.isRetiredUserId(userId),
		latest: async () => store.historyFloors().latest,
		normalize: (record) => {
			const checked = store.content.record(record);
			return checked.ok ? checked.value : null;
		},
		restoreUsers: async (users) => store.restoreUsers(users),
		accounts: async () => store.accountCapacity(),
		roomCapacity: async (rooms) => store.restoreRoomCapacity(rooms),
		restoreRoom: async (room: ArchivedRoom, records: readonly ChatRecord[], context: RestoreContext) => store.restoreRoom(room, records, undefined, { rooms: context.rooms }),
		restoreMembers: async (roomId, changes) => store.restoreMembers(roomId, changes),
		journal: {
			get: async () => store.historyImportJournal(),
			set: async (value) => store.setHistoryImportJournal(value),
		},
	};
}

export function storeExport(store: ExportStore): ExportPort {
	return {
		/**
		 * Every room, as `room_list` lists it, private ones included (an
		 * export is the server's, not a member's view), with its current
		 * members (registered ones: guests' are not kept) and how many it has:
		 * a membership outlives its record in the log, so the records alone
		 * would lose members who joined long ago. At most MAX_LISTING_MEMBERS
		 * are read; the export bounds them further (boundedMembers).
		 */
		async rooms() {
			return store.listRooms(undefined, { maintenance: true, withPrivate: true }).map((room) => {
				const { latest_log_id, history_log_id, members: _members, member_count: _count, ...rest } = room as Record<string, unknown> & { room_id: string };
				const { members, count } = store.exportMembers(room.room_id, MAX_LISTING_MEMBERS);
				return {
					listing: {
						...rest, room_id: room.room_id,
						...(typeof latest_log_id === "string" ? { latest_log_id } : {}),
						...(typeof history_log_id === "string" || history_log_id === null ? { history_log_id } : {}),
						members: members.map((user_id) => ({ user_id })), member_count: count,
					},
					joined: false,
				};
			});
		},
		async users(userIds) {
			return userIds.flatMap((id) => {
				const identity = store.getIdentity(id);
				if (!identity) return [];
				return [{ user_id: identity.userId, name: identity.name, ...(identity.avatar ? { avatar: identity.avatar } : {}), roles: identity.roles, ...(identity.ext ? { ext: identity.ext } : {}) }];
			});
		},
	};
}
