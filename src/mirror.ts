/**
 * Hosted rooms with mirrors (extension `ext:remote`; the trusted
 * federation recipe), on when `REMOTE_SELF` is set. Both roles live here:
 *
 * - Owner: this server hosts a room and gives each mirror server one link
 *   (an account, Store.createRemoteLink). The link reads the room; its
 *   act-as requests (index.ts, actAs) write as the mirror's users. Here:
 *   `/remote invite`, the link's join to the room's threads, and the
 *   link's `relay` wake push for every record of its rooms.
 * - Mirror: this server shows another server's room in a local mirror room.
 *   It reads the owner's room through the link (history from its place in
 *   the owner's log, then live), writes each record as a copy inside this
 *   server, and forwards its users' writes in the room to the owner,
 *   answering them when the owner's record comes back. It connects on
 *   demand (a write, a wake push, the alarm) and closes when idle.
 *
 * index.ts calls in through a few marked hooks; MirrorHost is what this
 * module needs of it.
 */
import type { Broadcast, MessageSnapshot, MirrorRoom, MirrorState, RoomRecord, Store, StoreMutationInput } from "./store";
import { StoreError } from "./store-error";
import type { ProtocolError, RequestFrame } from "./protocol";
import { apronLink } from "./protocol";
import { isShadowUserId, normalizeRemoteAddress, parseInvite, remoteAuthority, remoteUserIdError, sameAddress, shadowUserId } from "./remote";
import { addServerToLinks, LinkConnection, remoteReason, rewriteMentions, type ReplyFrame } from "./remote-client";

/** A connection as index.ts holds it: enough to answer it. */
export interface MirrorClient {
	userId?: string;
	tier: string;
	name?: string;
	ipKey: string;
}

/** What the mirror needs of the Durable Object (index.ts). */
export interface MirrorHost {
	readonly store: Store;
	readonly self: string;
	readonly lingerMs: number;
	readonly storage: DurableObjectStorage;
	/** Runs `fn` in the object's mutation queue, so its records go out in order. */
	runMutation(fn: () => Promise<void>): Promise<void>;
	/** Delivers a committed record to its rooms' members (and wakes their mirrors). */
	broadcastRecord(record: Broadcast): void;
	/** A room created or saved: its members and its parent's get `room_update` `updated`. */
	roomChanged(room: RoomRecord): void;
	/** The creator of a new room, a registered admin, joined it: their connections get the room. */
	roomJoined(userId: string, room: RoomRecord, membership?: Broadcast): void;
	reply(socket: unknown, request: RequestFrame, result: Record<string, unknown>): void;
	notice(socket: unknown, roomId: string, text: string): void;
	/** Joins a user (a link) to a room as `actorId` would add them, with every delivery a join makes. */
	addMember(actor: { ipKey: string; userId?: string }, roomId: string, userId: string): Promise<void>;
	/** addMember within the mutation that runs now. */
	addMemberNow(actor: { ipKey: string; userId?: string }, roomId: string, userId: string): void;
	removeMember(actor: { ipKey: string; userId?: string }, roomId: string, userId: string): Promise<boolean>;
	mintLinkToken(linkId: string): Promise<string>;
	forgetLinkTokens(linkId: string): Promise<void>;
	closeConnectionsOf(userId: string, reason: string): void;
	/** Sets the alarm no later than `at`. */
	wakeAt(at: number): Promise<void>;
	/** A new copy wakes its readers by push, as any new message does (§4.9). */
	pushFor(message: MessageSnapshot): void;
	/** Whether the server may dial out now: not paused, not out of capacity. */
	mayDial(): boolean;
}

/** A link's `relay` wake push (§4.9.4), as the owner keeps it. */
interface WakeRegistration {
	url: string;
	token: string;
	push_id?: string;
}

/** The mirror's own users as the owner knows them: their remote user's ID there, and the name it last sent. */
interface OwnerUser {
	id: string;
	name: string;
}

/** Error names by code (§1.1), to pass an owner's error on to the mirror's user. */
const ERROR_NAMES: Record<number, ProtocolError["name"]> = {
	[-32700]: "parse_error", [-32600]: "invalid_request", [-32601]: "unsupported", [-32602]: "invalid_params",
	[-32603]: "internal_error", [-32001]: "denied", [-32002]: "retry_after", [-32003]: "too_large",
};
/** How long a forwarded write waits for the owner before its user is told to try again. */
const FORWARD_TIMEOUT_MS = 10_000;
/** How long an accepted new message or thread waits for its copy or mirror thread (reconnecting and catching up as needed) before an error. */
const COPY_WAIT_MS = 60_000;
/** The members of a room a link's leave looks through for its remote users. */
const REMOTE_MEMBERS_LIMIT = 1_000;
/** Local joins and leaves an owner's queue keeps while it cannot be reached (the oldest go first). */
const MAX_QUEUED_MEMBERSHIPS = 200;
/** While anything is mirrored, the alarm reads every owner this often, in case a wake push was lost. */
const MIRROR_CHECK_MS = 5 * 60_000;
/** A wake push's `TTL` (§4.9.2): the mirror reads every MIRROR_CHECK_MS anyway. */
const WAKE_TTL_SECONDS = 300;
/** At most one wake push a link this often (the owner's debounce). */
const WAKE_INTERVAL_MS = 2_000;
/** History pages a catch-up reads at a time. */
const HISTORY_PAGE = 100;
/** The IP key the mirror's own writes are charged to (they are `system` writes: no posting limits apply). */
const MIRROR_IP_KEY = "remote-mirror";

/** One owner server's connection, as this mirror holds it. */
interface Session {
	server: string;
	connection?: LinkConnection;
	connecting?: Promise<LinkConnection>;
	/** Live records that arrive while a catch-up reads history (§4.3.5). */
	buffer?: Array<Record<string, unknown>>;
	inflight: number;
	idle?: ReturnType<typeof setTimeout>;
}

export class RemoteRooms {
	private readonly sessions = new Map<string, Session>();
	private wakeRegistrations: Map<string, WakeRegistration> | undefined;
	private readonly wakeTimers = new Map<string, { timer?: ReturnType<typeof setTimeout>; last: number }>();

	constructor(private readonly host: MirrorHost) {}

	private get store(): Store {
		return this.host.store;
	}

	private now(): number {
		return Date.now();
	}

	// ─────────────────────────── commands ───────────────────────────

	/**
	 * `/remote` (admins): `invite <address>` (owner), `connect <invite>`
	 * (mirror), `unshare`, `list`, `revoke <address>`. Each answers with a
	 * `~private` notice before the result; mistakes are `invalid_params`.
	 */
	async command(socket: unknown, client: MirrorClient, request: RequestFrame, roomId: string, args: string[]): Promise<void> {
		const [action, argument] = args;
		const usage = { name: "invalid_params", message: "Usage: /remote invite <address> | connect <invite> | unshare | list | revoke <address>" } satisfies ProtocolError;
		if (action === "list" && args.length === 1) return this.list(socket, request, roomId);
		if (action === "unshare" && args.length === 1) return this.unshare(socket, client, request, roomId);
		if (action === "revoke" && args.length === 2) return this.revoke(socket, request, roomId, argument);
		if (action === "invite" && args.length === 2) return this.invite(socket, client, request, roomId, argument);
		if (action === "connect" && args.length === 2) return this.connect(socket, client, request, argument);
		throw usage;
	}

	/**
	 * Owner: joins this server's link for the mirror at `address` to the room
	 * (made on first use) and to the room's threads, mints it a token, and
	 * gives the invite in a code span.
	 */
	private async invite(socket: unknown, client: MirrorClient, request: RequestFrame, roomId: string, address: string): Promise<void> {
		const server = normalizeRemoteAddress(address);
		if (!server) throw { name: "invalid_params", message: "The address is the mirror server's WebSocket URL, ws:// or wss://, such as wss://chat.example/ws" } satisfies ProtocolError;
		if (server === this.host.self) throw { name: "invalid_params", message: "That is this server's own address" } satisfies ProtocolError;
		if (this.mirrorOf(roomId)) throw { name: "invalid_params", message: "This room is a mirror of another server's room; invite to the room there" } satisfies ProtocolError;
		const room = this.store.getRoom(roomId, this.now());
		if (room?.parent_room_id !== undefined) throw { name: "invalid_params", message: "Invite to the thread's room; its threads come with it" } satisfies ProtocolError;
		let linkId = this.store.remoteLinkFor(server, this.now());
		if (linkId === undefined) {
			const authority = remoteAuthority(server);
			await this.host.runMutation(async () => {
				const created = this.store.createRemoteLink({ server, name: `Link bot for ${authority}`.slice(0, 64), roomId, now: this.now(), ipKey: client.ipKey });
				linkId = created.userId;
				for (const record of created.broadcasts) this.host.broadcastRecord(record);
			});
		} else if (!this.store.isRoomMember(roomId, linkId, this.now())) {
			await this.host.addMember({ ipKey: client.ipKey, userId: client.userId }, roomId, linkId);
		}
		for (const thread of this.store.threadsOf(roomId, this.now())) await this.joinThread(linkId!, thread);
		const token = await this.host.mintLinkToken(linkId!);
		this.host.notice(socket, roomId, [
			`To mirror this room on ${server}, an admin there runs \`/remote connect\` with this invite. It holds a token of this server's link for that server (\`${linkId}\`), which reads this room and writes in it as that server's users, so hand it over privately. \`/remote unshare\` here stops every mirror of this room; \`/remote revoke ${server}\` stops that server's.`,
			"`" + apronLink(this.host.self, { room: roomId, token }) + "`",
		].join("\n\n"));
		this.host.reply(socket, request, {});
	}

	/**
	 * Mirror: dials the invite's owner, signs in as its link for this
	 * server, reads the room, and makes the mirror room: its title,
	 * description and privacy, `ext.remote` the owner's room, with the admin
	 * in it, and a mirror thread for each of the room's threads that the link
	 * is in. It starts at the owner's head; older records are not copied.
	 */
	private async connect(socket: unknown, client: MirrorClient, request: RequestFrame, link: string): Promise<void> {
		const invite = parseInvite(link);
		if (!invite) throw { name: "invalid_params", message: "The invite is a link from /remote invite on the owner, with server, room and token" } satisfies ProtocolError;
		if (invite.server === this.host.self) throw { name: "invalid_params", message: "That invite is this server's own" } satisfies ProtocolError;
		if (this.store.mirrorState(this.now()).rooms.some((room) => room.server === invite.server && room.owner_room === invite.room && !room.unshared)) {
			throw { name: "invalid_params", message: "This server mirrors that room already" } satisfies ProtocolError;
		}
		let connection: LinkConnection | undefined;
		let owned: Record<string, unknown> | undefined;
		// The room's threads that the link is in: each gets a mirror thread now (their records after the start follow).
		let threads: Array<Record<string, unknown>> = [];
		let threadUsers: unknown;
		try {
			connection = await LinkConnection.open(invite.server, invite.token);
			const bound = boundServer(connection);
			if (!sameAddress(bound, this.host.self)) throw new Error(`the link there is bound to ${bound ?? "no server"}, not ${this.host.self}`);
			const listed = await connection.call("room_list", { room_id: invite.room }, `mirror-connect:${this.now()}`);
			if (listed.error) throw new Error(listed.error.message ?? `error ${listed.error.code}`);
			const rooms = [...(listed.result?.joined as unknown[] ?? []), ...(listed.result?.not_joined as unknown[] ?? [])] as Array<Record<string, unknown>>;
			owned = rooms.find((room) => room.room_id === invite.room);
			if (!owned) throw new Error("the link is not in that room");
			const listedThreads = await connection.call("room_list", { parent_room_id: invite.room, filter: "joined", members: true }, `mirror-threads:${this.now()}`);
			threads = (listedThreads.result?.joined as Array<Record<string, unknown>> | undefined) ?? [];
			threadUsers = listedThreads.result?.users;
		} catch (error) {
			throw { name: "invalid_params", message: `Could not connect to ${invite.server}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) } satisfies ProtocolError;
		} finally {
			connection?.close();
		}
		const title = typeof owned.title === "string" && owned.title.trim() ? owned.title : remoteAuthority(invite.server);
		const description = typeof owned.description === "string" && owned.description ? owned.description : undefined;
		const isPrivate = owned.private === true;
		const start = Number(owned.latest_log_id) || 0;
		let room: RoomRecord | undefined;
		await this.host.runMutation(async () => {
			const result = this.store.mutate({
				userId: client.userId!, tier: "registered", ipKey: client.ipKey, method: "room_set", now: this.now(),
				params: { title, ...(description !== undefined ? { description } : {}), ...(isPrivate ? { private: true } : {}) },
				identity: { user_id: client.userId!, ...(client.name ? { name: client.name } : {}), tier: "registered" },
				roomRemote: { server: invite.server, room_id: invite.room },
			});
			room = result.room;
			if (room) this.host.roomJoined(client.userId!, room, result.membership);
		});
		if (!room) throw { name: "internal_error", message: "The mirror room was not made" } satisfies ProtocolError;
		const state = this.store.mirrorState(this.now());
		state.rooms.push({ room_id: room.room_id, server: invite.server, owner_room: invite.room, token: invite.token, start, threads: {} });
		state.servers[invite.server] ??= { cursor: start };
		this.store.setMirrorState(state, this.now());
		// A private mirror room has no threads here (copyRoom leaves them out).
		for (const thread of threads) await this.applyRecord(invite.server, "rooms", thread);
		await this.seedThreads(invite.server, threads, threadUsers);
		this.host.notice(socket, room.room_id, `Mirroring ${title} from ${remoteAuthority(invite.server)} in room \`${room.room_id}\`.`);
		this.host.reply(socket, request, {});
		// Live from now on, with the wake push registered, then idle until there is more.
		void this.ensure(invite.server).then(() => this.touch(invite.server), () => undefined);
		await this.host.wakeAt(this.now() + MIRROR_CHECK_MS);
	}

	/**
	 * In a mirror room: the link leaves the owner's room, and the mirror
	 * room takes no more writes (it stays, with its copies). In an owner's
	 * room: every link leaves the room and its threads.
	 */
	private async unshare(socket: unknown, client: MirrorClient, request: RequestFrame, roomId: string): Promise<void> {
		const mirror = this.mirrorOf(roomId);
		if (mirror) {
			let told = true;
			try {
				const connection = await this.ensure(mirror.room.server);
				const left = await connection.call("room_leave", { room_id: mirror.room.owner_room }, `mirror-unshare:${roomId}:${this.now()}`);
				if (left.error) told = false;
			} catch {
				told = false;
			}
			this.markUnshared(mirror.room.server, mirror.room.owner_room);
			this.host.notice(socket, roomId, `This room no longer mirrors ${remoteAuthority(mirror.room.server)}; it keeps its copies and takes no more writes.${told ? "" : " The owner could not be told now; its link stays in the room there until an admin there removes it."}`);
			this.host.reply(socket, request, {});
			return;
		}
		const removed: string[] = [];
		const threads = this.store.threadsOf(roomId, this.now());
		for (const [linkId, link] of Object.entries(this.store.remoteLinks(this.now()))) {
			for (const room of [roomId, ...threads]) {
				if (this.store.isRoomMember(room, linkId, this.now()) && await this.host.removeMember({ ipKey: client.ipKey, userId: client.userId }, room, linkId) && room === roomId) removed.push(link.server);
			}
		}
		this.host.notice(socket, roomId, removed.length ? `This room is no longer shared with ${removed.join(", ")}.` : "This room is not shared.");
		this.host.reply(socket, request, {});
	}

	/** Owner: revokes the link's tokens and wake push, and closes its connections. Its account and remote users stay. */
	private async revoke(socket: unknown, request: RequestFrame, roomId: string, address: string): Promise<void> {
		const server = normalizeRemoteAddress(address);
		const linkId = server === undefined ? undefined : this.store.remoteLinkFor(server, this.now());
		if (server === undefined || linkId === undefined) throw { name: "invalid_params", message: `No link is bound to ${address}`.slice(0, 200) } satisfies ProtocolError;
		await this.host.forgetLinkTokens(linkId);
		await this.forgetWake(linkId);
		this.host.closeConnectionsOf(linkId, "This link was revoked");
		this.host.notice(socket, roomId, `Revoked the link \`${linkId}\` for ${server}: its tokens no longer sign in. Its account, its remote users and their posts stay.`);
		this.host.reply(socket, request, {});
	}

	private list(socket: unknown, request: RequestFrame, roomId: string): void {
		const now = this.now();
		const lines: string[] = [];
		for (const [linkId, link] of Object.entries(this.store.remoteLinks(now))) {
			const rooms = this.store.getIdentity(linkId)?.rooms ?? [];
			lines.push(`- Shared with ${link.server}: link \`${linkId}\`, in ${rooms.length ? rooms.map((room) => `\`${room}\``).join(", ") : "no rooms"}`);
		}
		const state = this.store.mirrorState(now);
		for (const room of state.rooms) {
			lines.push(`- Mirror of \`${room.owner_room}\` on ${room.server}: room \`${room.room_id}\`${room.unshared ? " (unshared)" : ""}; read through log ID ${state.servers[room.server]?.cursor ?? 0}${this.sessions.get(room.server)?.connection?.open ? ", connected" : ""}`);
		}
		this.host.notice(socket, roomId, lines.length ? lines.join("\n") : "Nothing is shared. `/remote invite <address>` shares a room; `/remote connect <invite>` mirrors one.");
		this.host.reply(socket, request, {});
	}

	// ─────────────────────────── owner ───────────────────────────

	/**
	 * Owner hook, in the mutation that made a thread, before its result: each
	 * link in its parent joins it (every member of the room can see a thread
	 * here: private rooms have none), so its mirrors read it from its first
	 * records on.
	 */
	threadCreated(threadId: string, parentId: string): void {
		for (const linkId of Object.keys(this.store.remoteLinks(this.now()))) {
			if (!this.store.isRoomMember(parentId, linkId, this.now())) continue;
			try {
				this.host.addMemberNow({ ipKey: MIRROR_IP_KEY }, threadId, linkId);
			} catch (error) {
				console.warn(JSON.stringify({ event: "remote_thread_join_failed", link: linkId, room_id: threadId, error: error instanceof Error ? error.message : String(error) }));
			}
		}
	}

	private async joinThread(linkId: string, threadId: string): Promise<void> {
		if (this.store.isRoomMember(threadId, linkId, this.now())) return;
		try {
			await this.host.addMember({ ipKey: MIRROR_IP_KEY }, threadId, linkId);
		} catch (error) {
			console.warn(JSON.stringify({ event: "remote_thread_join_failed", link: linkId, room_id: threadId, error: error instanceof Error ? error.message : String(error) }));
		}
	}

	/**
	 * Owner: a link's `push_register` with `kind` `relay` and the wake scope
	 * `ext:remote` (§4.9): a POST to `url` with `Authorization: Bearer
	 * <token>` for the records of its rooms. `url` is `https`, or `http` to a
	 * loopback host for development. One a link, replacing the last.
	 */
	async registerWake(socket: unknown, linkId: string, server: string, request: RequestFrame): Promise<void> {
		const params = request.params;
		const wake = Array.isArray(params.wake) ? params.wake : [];
		if (!wake.includes("ext:remote")) throw { name: "invalid_params", message: "A link's relay push wakes for ext:remote" } satisfies ProtocolError;
		const url = typeof params.url === "string" && params.url.length <= 512 ? params.url : "";
		const token = typeof params.token === "string" && params.token.length > 0 && params.token.length <= 512 ? params.token : "";
		if (!wakeUrlAllowed(url) || !token) throw { name: "invalid_params", message: "A relay push needs an https url (or http to a loopback host) and a token" } satisfies ProtocolError;
		// Only to the link's own server: a token holder may not make this server POST elsewhere.
		if (new URL(url).host !== new URL(server.replace(/^ws/i, "http")).host) throw { name: "invalid_params", message: "A link's relay push goes to its own server" } satisfies ProtocolError;
		const registration: WakeRegistration = { url, token, ...(typeof params.push_id === "string" ? { push_id: params.push_id.slice(0, 64) } : {}) };
		await this.store.withMeterAsync("foreground", { writes: 1 }, () => this.host.storage.put(WAKE_KEY_PREFIX + linkId, registration));
		(await this.wakes()).set(linkId, registration);
		this.host.reply(socket, request, {});
	}

	private async wakes(): Promise<Map<string, WakeRegistration>> {
		if (!this.wakeRegistrations) {
			const listed = await this.store.withMeterAsync("foreground", { reads: 8 }, () => this.host.storage.list<WakeRegistration>({ prefix: WAKE_KEY_PREFIX, limit: 64 }));
			this.wakeRegistrations = new Map([...listed].map(([key, value]) => [key.slice(WAKE_KEY_PREFIX.length), value]));
		}
		return this.wakeRegistrations;
	}

	private async forgetWake(linkId: string): Promise<void> {
		(await this.wakes()).delete(linkId);
		await this.store.withMeterAsync("foreground", { writes: 1 }, () => this.host.storage.delete(WAKE_KEY_PREFIX + linkId));
	}

	/**
	 * Owner hook, after any record: each link with a wake push that is in one
	 * of the record's rooms gets a push, at most one each WAKE_INTERVAL_MS
	 * (the records between go with it), also while it is connected.
	 */
	onRecord(record: Broadcast): void {
		if (record.method === "membership") {
			this.forwardMembership(record);
			this.linkLeaves(record);
		}
		const rooms = record.rooms;
		if (this.wakeRegistrations?.size === 0) return;
		void this.wakes().then((registrations) => {
			for (const [linkId, registration] of registrations) {
				if (!rooms.some((roomId) => this.store.isRoomMember(roomId, linkId, this.now()))) continue;
				const slot = this.wakeTimers.get(linkId) ?? { last: 0 };
				this.wakeTimers.set(linkId, slot);
				if (slot.timer !== undefined) continue;
				slot.timer = setTimeout(() => {
					slot.timer = undefined;
					slot.last = Date.now();
					void fetch(registration.url, {
						method: "POST",
						// §4.9.2: a push without `message` is `low`; a wake older than the mirror's own check is worth nothing.
						headers: { Authorization: `Bearer ${registration.token}`, "Content-Type": "application/json", TTL: String(WAKE_TTL_SECONDS), Urgency: "low" },
						body: JSON.stringify(registration.push_id ? { push_id: registration.push_id } : {}),
					}).then((response) => response.body?.cancel(), (error) => {
						console.warn(JSON.stringify({ event: "remote_wake_failed", link: linkId, error: error instanceof Error ? error.message : String(error) }));
					});
				}, Math.max(0, slot.last + WAKE_INTERVAL_MS - Date.now()));
			}
		}, () => undefined);
	}

	/**
	 * Owner hook, after a membership record: when a link leaves a room (its
	 * own `room_leave`, an admin's removal, or `/remote unshare`), its
	 * remote users leave the room and its threads too, as the system: they
	 * may come back with the link, so nothing marks them removed.
	 */
	private linkLeaves(record: Broadcast): void {
		const roomId = record.params.room_id;
		if (typeof roomId !== "string") return;
		for (const member of (record.params.members as Array<Record<string, unknown>> | undefined) ?? []) {
			const linkId = (member.user as Record<string, unknown> | undefined)?.user_id;
			if (member.joined !== false || typeof linkId !== "string") continue;
			const server = this.store.remoteLink(linkId, this.now());
			if (server === undefined) continue;
			const suffix = `@${remoteAuthority(server)}`;
			// After the mutation that logged the leave (this hook runs inside it).
			void (async () => {
				for (const room of [roomId, ...this.store.threadsOf(roomId, this.now())]) {
					for (const user of this.store.roomMembers([room], REMOTE_MEMBERS_LIMIT, this.now()).get(room) ?? []) {
						if (user.user_id.endsWith(suffix)) await this.host.removeMember({ ipKey: MIRROR_IP_KEY }, room, user.user_id);
					}
				}
			})().catch((error) => {
				console.warn(JSON.stringify({ event: "remote_users_not_removed", link: linkId, room_id: roomId, error: error instanceof Error ? error.message : String(error) }));
			});
		}
	}

	// ─────────────────────────── mirror: reading ───────────────────────────

	/** The mirror room (or a thread of one) that `roomId` is, with the owner's room or thread it shows. */
	private mirrorOf(roomId: string): { room: MirrorRoom; ownerRoom: string; thread: boolean } | undefined {
		for (const room of this.store.mirrorState(this.now()).rooms) {
			if (room.room_id === roomId) return { room, ownerRoom: room.owner_room, thread: false };
			const thread = Object.entries(room.threads).find(([, local]) => local === roomId);
			if (thread) return { room, ownerRoom: thread[0], thread: true };
		}
		return undefined;
	}

	/** The local room for the owner `server`'s room or thread, with its mirror room. */
	private localRoom(state: MirrorState, server: string, ownerRoom: string): { roomId: string; mirror: MirrorRoom } | undefined {
		for (const mirror of state.rooms) {
			if (mirror.server !== server || mirror.unshared) continue;
			if (mirror.owner_room === ownerRoom) return { roomId: mirror.room_id, mirror };
			if (mirror.threads[ownerRoom]) return { roomId: mirror.threads[ownerRoom], mirror };
		}
		return undefined;
	}

	/** The newest token for an owner, from its mirror rooms. */
	private tokenFor(server: string): string | undefined {
		const rooms = this.store.mirrorState(this.now()).rooms.filter((room) => room.server === server && !room.unshared);
		return rooms[rooms.length - 1]?.token;
	}

	/**
	 * The open connection to an owner, dialing it if there is none: sign in
	 * as the link, register the wake push, and catch up from this mirror's
	 * place in the owner's log, holding live records meanwhile (§4.3.5).
	 */
	async ensure(server: string): Promise<LinkConnection> {
		const session = this.session(server);
		// A dial in progress is still catching up (its live records held): wait for it, open or not.
		if (session.connecting) return session.connecting;
		if (session.connection?.open) return session.connection;
		if (!this.host.mayDial()) throw new Error("this server is paused or out of capacity");
		session.connecting ??= this.dial(session).finally(() => { session.connecting = undefined; });
		return session.connecting;
	}

	private session(server: string): Session {
		let session = this.sessions.get(server);
		if (!session) {
			session = { server, inflight: 0 };
			this.sessions.set(server, session);
		}
		return session;
	}

	private async dial(session: Session): Promise<LinkConnection> {
		const token = this.tokenFor(session.server);
		if (!token) throw new Error("nothing is mirrored from that server");
		session.buffer = [];
		const connection = await LinkConnection.open(session.server, token, {
			onFrame: (frame) => this.onFrame(session, frame),
			onClose: () => {
				if (session.connection === connection) session.connection = undefined;
				console.log(JSON.stringify({ event: "remote_mirror_closed", server: session.server }));
			},
		});
		const bound = boundServer(connection);
		if (!sameAddress(bound, this.host.self)) {
			connection.close();
			throw new Error(`the link is bound to ${bound ?? "no server"}`);
		}
		session.connection = connection;
		console.log(JSON.stringify({ event: "remote_mirror_connected", server: session.server }));
		try {
			await this.registerOwnWake(session.server, connection);
			await this.checkJoined(session.server, connection);
			await this.seedMembers(session.server, connection);
			await this.catchUp(session, connection);
		} finally {
			// The records held while reading history, then live.
			const held = session.buffer ?? [];
			session.buffer = undefined;
			for (const frame of held) await this.apply(session.server, frame);
		}
		this.touch(session.server);
		// Joins and leaves that a close cut off go now (they wait for this dial to finish).
		void this.flushMemberships(session.server);
		return connection;
	}

	/** The wake push this mirror asks of the owner: a POST to its own `/remote/wake/<id>` (index.ts routes it here). */
	private async registerOwnWake(server: string, connection: LinkConnection): Promise<void> {
		const state = this.store.mirrorState(this.now());
		const entry = state.servers[server] ??= { cursor: 0 };
		if (!entry.wake) {
			entry.wake = { id: randomId(), token: randomId() };
			this.store.setMirrorState(state, this.now());
		}
		const origin = this.host.self.replace(/^ws/i, "http").replace(/^(https?:\/\/[^/]+).*$/i, "$1");
		const registered = await connection.call("push_register", { kind: "relay", url: `${origin}/remote/wake/${entry.wake.id}`, token: entry.wake.token, wake: ["ext:remote"] }, `mirror-wake:${this.now()}`);
		if (registered.error) console.warn(JSON.stringify({ event: "remote_wake_register_failed", server, error: registered.error.message ?? registered.error.code }));
	}

	/**
	 * The owner's rooms that the link is still in: a mirror room whose owner
	 * room the link left while this mirror was away (an admin there removed
	 * it) stops, as history without `room_id` cannot show the link's leave.
	 */
	private async checkJoined(server: string, connection: LinkConnection): Promise<void> {
		const listed = await connection.call("room_list", { filter: "joined" }, `mirror-joined:${this.now()}`);
		if (listed.error || !listed.result) return;
		const rooms = (listed.result.joined as Array<Record<string, unknown>> | undefined) ?? [];
		const joined = new Set(rooms.map((room) => room.room_id));
		for (const room of this.store.mirrorState(this.now()).rooms) {
			if (room.server === server && !room.unshared && !joined.has(room.owner_room)) this.markUnshared(server, room.owner_room);
		}
		for (const room of rooms) this.checkPrivacy(server, room);
	}

	/**
	 * A mirror room's privacy is fixed when it is made (here a room's ID says
	 * whether it is private): an owner room that became private while its
	 * mirror is public stops being mirrored, so nothing private shows in a
	 * public room. One that became public keeps its private mirror.
	 */
	private checkPrivacy(server: string, room: Record<string, unknown>): void {
		if (room.private !== true || typeof room.room_id !== "string") return;
		const mirror = this.store.mirrorState(this.now()).rooms.find((candidate) => candidate.server === server && candidate.owner_room === room.room_id && !candidate.unshared);
		if (mirror && !mirror.room_id.startsWith("private_")) {
			console.warn(JSON.stringify({ event: "remote_mirror_privacy_changed", server, owner_room: room.room_id, room_id: mirror.room_id }));
			this.markUnshared(server, room.room_id);
		}
	}

	/**
	 * Once, when a mirror room is made (its first connection): the owner's
	 * members join it as remote users (§4.2.1: as many as the owner lists;
	 * a list cut short only adds), and this mirror's own users there (the
	 * connecting admin) join the owner's room as theirs. After that, both
	 * sides follow membership records: the owner's, copied from history, and
	 * this mirror's, sent as they happen (forwardMembership). The mirror's
	 * own joins are not charged as posts; a remote user in as many private
	 * rooms as anyone may be is left out.
	 */
	private async seedMembers(server: string, connection: LinkConnection): Promise<void> {
		for (const mirror of this.store.mirrorState(this.now()).rooms) {
			if (mirror.server !== server || mirror.unshared || mirror.seeded) continue;
			const listed = await connection.call("room_list", { room_id: mirror.owner_room, members: true }, `mirror-members:${mirror.owner_room}:${this.now()}`);
			if (listed.error || !listed.result) continue;
			const record = [...((listed.result.joined as unknown[]) ?? []), ...((listed.result.not_joined as unknown[]) ?? [])][0] as Record<string, unknown> | undefined;
			const users = new Map(((listed.result.users as Array<Record<string, unknown>> | undefined) ?? []).map((user) => [user.user_id, user]));
			for (const member of (record?.members as Array<Record<string, unknown>> | undefined) ?? []) {
				const user = users.get(member.user_id) ?? member;
				await this.copyMember(server, mirror.room_id, user, true);
			}
			const local = this.store.roomMembers([mirror.room_id], 500, this.now()).get(mirror.room_id) ?? [];
			for (const member of local) {
				if (!isShadowUserId(member.user_id) && this.store.remoteLink(member.user_id, this.now()) === undefined) this.queueMembership(server, mirror.owner_room, member.user_id, member.name ?? "", true);
			}
			const state = this.store.mirrorState(this.now());
			const stored = state.rooms.find((room) => room.room_id === mirror.room_id);
			if (stored) {
				stored.seeded = true;
				this.store.setMirrorState(state, this.now());
			}
		}
	}

	/**
	 * A user of the owner's membership record in a local room: a remote user
	 * joins or leaves it (not charged; a remote user removed here is not
	 * joined again). Links, system identities, and this mirror's own users'
	 * remote users (whose memberships are this server's own) are left out.
	 */
	private async copyMember(server: string, roomId: string, user: Record<string, unknown>, joined: boolean): Promise<void> {
		const remote = (user.ext as Record<string, unknown> | undefined)?.remote as Record<string, unknown> | undefined;
		if (remote && remote.user_id === undefined) return;
		if (remote?.server === this.host.self) return;
		const local = this.localUser(server, user);
		if (!local?.remote) return;
		if (joined === this.store.isRoomMember(roomId, local.userId, this.now())) return;
		if (joined && this.store.remoteUserLeft(local.userId, roomId, this.now())) return;
		await this.host.runMutation(async () => {
			try {
				const change = this.store.changeMembership({ userId: local.userId, ipKey: MIRROR_IP_KEY, roomId, join: joined, now: this.now(), system: true });
				if (change.membership) this.host.broadcastRecord(change.membership);
			} catch (error) {
				// Past a limit (such as the private rooms one user may be in): left out.
				if (!(error instanceof StoreError)) throw error;
				console.warn(JSON.stringify({ event: "remote_member_skipped", server, room_id: roomId, user_id: local.userId, error: error.message }));
			}
		});
	}

	/** An owner's membership record: each entry copied (copyMember), and the link's own leave stops the mirror room. */
	private async copyMembership(server: string, record: Record<string, unknown>): Promise<void> {
		this.linkLeft(server, record);
		if (typeof record.room_id !== "string") return;
		const target = this.localRoom(this.store.mirrorState(this.now()), server, record.room_id);
		if (!target || Number(record.log_id) <= target.mirror.start) return;
		for (const member of (record.members as Array<Record<string, unknown>> | undefined) ?? []) {
			const user = member.user as Record<string, unknown> | undefined;
			if (user) await this.copyMember(server, target.roomId, user, member.joined !== false);
		}
	}

	/**
	 * Mirror hook, after a membership record here: a local user's join or
	 * leave of a mirror room or thread goes to the owner as their remote
	 * user's `room_join` or `room_leave`.
	 */
	private forwardMembership(record: Broadcast): void {
		const roomId = record.params.room_id;
		const mirror = typeof roomId === "string" ? this.mirrorOf(roomId) : undefined;
		if (!mirror || mirror.room.unshared) return;
		for (const member of (record.params.members as Array<Record<string, unknown>> | undefined) ?? []) {
			const user = member.user as Record<string, unknown> | undefined;
			const userId = user?.user_id;
			if (typeof userId !== "string" || userId.startsWith("~") || isShadowUserId(userId) || this.store.remoteLink(userId, this.now()) !== undefined) continue;
			const name = typeof user!.name === "string" ? user!.name : "";
			this.queueMembership(mirror.room.server, mirror.ownerRoom, userId, name, member.joined !== false);
		}
		void this.flushMemberships(mirror.room.server);
	}

	/**
	 * A local join or leave for the owner, kept (in the mirror state) until
	 * the owner answers it: a close, an outage or an eviction only delays
	 * it to the next connection. A later change of the same user and room
	 * replaces it.
	 */
	private queueMembership(server: string, ownerRoom: string, userId: string, name: string, joined: boolean): void {
		const state = this.store.mirrorState(this.now());
		const entry = state.servers[server] ??= { cursor: 0 };
		entry.memberships = [...(entry.memberships ?? []).filter((item) => item.owner_room !== ownerRoom || item.user_id !== userId), { owner_room: ownerRoom, user_id: userId, name, joined }]
			.slice(-MAX_QUEUED_MEMBERSHIPS);
		this.store.setMirrorState(state, this.now());
	}

	private readonly membershipFlushes = new Map<string, Promise<void>>();

	/** Sends the queued joins and leaves of one owner, one flush at a time, as work in flight (the linger waits for it). */
	private flushMemberships(server: string): Promise<void> {
		const next = (this.membershipFlushes.get(server) ?? Promise.resolve()).then(() => this.sendQueuedMemberships(server)).catch((error) => {
			console.warn(JSON.stringify({ event: "remote_membership_not_sent", server, error: error instanceof Error ? error.message : String(error) }));
		});
		this.membershipFlushes.set(server, next);
		return next;
	}

	private async sendQueuedMemberships(server: string): Promise<void> {
		const queued = () => this.store.mirrorState(this.now()).servers[server]?.memberships ?? [];
		if (!queued().length) return;
		const session = this.session(server);
		session.inflight += 1;
		try {
			const connection = await this.ensure(server);
			for (let item = queued()[0]; item; item = queued()[0]) {
				// No answer (the connection closed or timed out): the rest wait for the next connection.
				if (!await this.sendMembership(connection, server, item.owner_room, item.user_id, item.name, item.joined)) return;
				const state = this.store.mirrorState(this.now());
				const entry = state.servers[server];
				if (!entry?.memberships) return;
				// Sent: off the queue, unless a newer change of the same user and room replaced it meanwhile.
				const sent = item;
				entry.memberships = entry.memberships.filter((other) => other.owner_room !== sent.owner_room || other.user_id !== sent.user_id || other.joined !== sent.joined);
				if (!entry.memberships.length) delete entry.memberships;
				this.store.setMirrorState(state, this.now());
			}
		} finally {
			session.inflight -= 1;
			this.touch(server);
		}
	}

	/** One join or leave as the user's remote user; false when the owner gave no answer (a closed connection, or none in time). */
	private async sendMembership(connection: LinkConnection, server: string, ownerRoom: string, userId: string, name: string, joined: boolean): Promise<boolean> {
		await this.ownerUser(connection, server, userId, name);
		const answer = await connection.call(joined ? "room_join" : "room_leave", { room_id: ownerRoom, ext: { remote: { user_id: userId } } }, `${userId}:${joined ? "join" : "leave"}:${ownerRoom}:${this.now()}`);
		if (answer.error && unanswered(connection, answer)) return false;
		if (answer.error) console.warn(JSON.stringify({ event: "remote_membership_refused", server, owner_room: ownerRoom, user_id: userId, error: answer.error.message ?? answer.error.code }));
		return true;
	}

	/** Pages forward through the owner's log from this mirror's place, writing each record (§4.3.5). */
	private async catchUp(session: Session, connection: LinkConnection): Promise<void> {
		let head: string | undefined;
		for (;;) {
			const cursor = this.store.mirrorState(this.now()).servers[session.server]?.cursor ?? 0;
			const page = await connection.call("history", { after: String(cursor + 1), ...(head ? { before: head } : {}), limit: HISTORY_PAGE }, `mirror-history:${cursor}:${this.now()}`);
			if (page.error || !page.result) throw new Error(`history: ${page.error?.message ?? "no result"}`);
			head ??= typeof page.result.latest_log_id === "string" ? page.result.latest_log_id : undefined;
			const records: Array<{ kind: string; record: Record<string, unknown> }> = [];
			for (const kind of ["rooms", "messages", "reactions", "memberships"]) {
				for (const record of (page.result[kind] as Array<Record<string, unknown>> | undefined) ?? []) records.push({ kind, record });
			}
			records.sort((a, b) => Number(a.record.log_id) - Number(b.record.log_id) || Number(b.kind === "rooms") - Number(a.kind === "rooms"));
			for (const { kind, record } of records) await this.applyRecord(session.server, kind, record);
			const last = Number(page.result.last_log_id);
			if (Number.isFinite(last)) this.advance(session.server, last);
			if (page.result.more !== true) return;
		}
	}

	private advance(server: string, logId: number): void {
		const state = this.store.mirrorState(this.now());
		const entry = state.servers[server] ??= { cursor: 0 };
		if (logId <= entry.cursor) return;
		entry.cursor = logId;
		this.store.setMirrorState(state, this.now());
	}

	/** A frame from the owner that is not a reply: held while catching up, else written now. */
	private async onFrame(session: Session, frame: Record<string, unknown>): Promise<void> {
		if (session.buffer) {
			session.buffer.push(frame);
			return;
		}
		await this.apply(session.server, frame);
		this.touch(session.server);
	}

	/** A live frame: its records (a message, reactions, room records and memberships), and profile changes. */
	private async apply(server: string, frame: Record<string, unknown>): Promise<void> {
		const params = (frame.params ?? {}) as Record<string, unknown>;
		const cursor = this.store.mirrorState(this.now()).servers[server]?.cursor ?? 0;
		const records: Array<{ kind: string; record: Record<string, unknown> }> = [];
		if (frame.method === "message") records.push({ kind: "messages", record: params });
		else if (frame.method === "reactions") records.push({ kind: "reactions", record: params });
		else if (frame.method === "room_update") {
			for (const key of ["joined", "updated"]) for (const room of (params[key] as Array<Record<string, unknown>> | undefined) ?? []) records.push({ kind: "rooms", record: room });
			for (const record of (params.memberships as Array<Record<string, unknown>> | undefined) ?? []) records.push({ kind: "memberships", record });
			for (const left of (params.left as Array<Record<string, unknown>> | undefined) ?? []) {
				if (typeof left.room_id === "string") this.markUnshared(server, left.room_id);
			}
		} else if (frame.method === "user") {
			await this.profileFrom(server, params.new as Record<string, unknown> | undefined);
			return;
		}
		for (const { kind, record } of records) {
			const logId = Number(record.log_id);
			// What a catch-up read already; a room record of a join carries its own older log ID, so it always goes.
			if (kind !== "rooms" && Number.isFinite(logId) && logId <= cursor) continue;
			await this.applyRecord(server, kind, record);
			if (kind !== "rooms" && Number.isFinite(logId)) this.advance(server, logId);
		}
		// The link was joined to a thread: its first members come with it (the creator joined before the link).
		if (frame.method === "room_update") await this.seedThreads(server, (params.joined as Array<Record<string, unknown>> | undefined) ?? [], params.users);
	}

	/**
	 * The members of owner threads that the link was just joined to (a
	 * `room_update` `joined`, or `/remote connect`'s listing), into their
	 * mirror threads: remote users as copyMember joins them, and this
	 * server's own users (a thread's creator) as themselves, which goes back
	 * to the owner as a join it already has. `users` are the frame's user
	 * objects, by which bare members are mapped.
	 */
	private async seedThreads(server: string, rooms: Array<Record<string, unknown>>, users: unknown): Promise<void> {
		const byId = new Map(((users as Array<Record<string, unknown>> | undefined) ?? []).map((user) => [user.user_id, user]));
		for (const room of rooms) {
			if (typeof room.room_id !== "string" || typeof room.parent_room_id !== "string") continue;
			const target = this.localRoom(this.store.mirrorState(this.now()), server, room.room_id);
			if (!target || target.roomId === target.mirror.room_id) continue;
			for (const member of (room.members as Array<Record<string, unknown>> | undefined) ?? []) {
				const user = byId.get(member.user_id) ?? member;
				const remote = (user.ext as Record<string, unknown> | undefined)?.remote as Record<string, unknown> | undefined;
				try {
					if (remote?.server === this.host.self && typeof remote.user_id === "string") {
						if (this.store.identityExists(remote.user_id) && !this.store.isRoomMember(target.roomId, remote.user_id, this.now())) await this.host.addMember({ ipKey: MIRROR_IP_KEY }, target.roomId, remote.user_id);
					} else await this.copyMember(server, target.roomId, user, true);
				} catch (error) {
					console.warn(JSON.stringify({ event: "remote_member_skipped", server, room_id: target.roomId, user_id: String(member.user_id), error: error instanceof Error ? error.message : String(error) }));
				}
			}
		}
	}

	/** One record of the owner's log, written into the mirror (each in the mutation queue; a failure is logged and skipped). */
	private async applyRecord(server: string, kind: string, record: Record<string, unknown>): Promise<void> {
		try {
			if (kind === "messages") await this.copyMessage(server, record as unknown as MessageSnapshot);
			else if (kind === "reactions") await this.copyReactions(server, record);
			else if (kind === "rooms") await this.copyRoom(server, record);
			else if (kind === "memberships") await this.copyMembership(server, record);
		} catch (error) {
			console.warn(JSON.stringify({ event: "remote_copy_failed", server, kind, log_id: record.log_id, error: error instanceof Error ? error.message : String(error) }));
		}
	}

	/** The link's own leave of an owner's room (its admin removed it, or this mirror unshared): the mirror room stops. */
	private linkLeft(server: string, record: Record<string, unknown>): void {
		const link = this.linkIdOn(server);
		if (!link || typeof record.room_id !== "string") return;
		for (const member of (record.members as Array<Record<string, unknown>> | undefined) ?? []) {
			const user = member.user as Record<string, unknown> | undefined;
			if (member.joined === false && user?.user_id === link) this.markUnshared(server, record.room_id);
		}
	}

	/** The link's own `user_id` on an owner, from the sign-in. */
	private linkIdOn(server: string): string | undefined {
		const you = this.sessions.get(server)?.connection?.you;
		return typeof you?.user_id === "string" ? you.user_id : undefined;
	}

	private markUnshared(server: string, ownerRoom: string): void {
		const state = this.store.mirrorState(this.now());
		const room = state.rooms.find((candidate) => candidate.server === server && candidate.owner_room === ownerRoom && !candidate.unshared);
		if (!room) return;
		room.unshared = true;
		this.store.setMirrorState(state, this.now());
		console.log(JSON.stringify({ event: "remote_mirror_unshared", server, owner_room: ownerRoom, room_id: room.room_id }));
	}

	/**
	 * The local user a recorded user object of the owner `server` stands for:
	 * this server's own user, when the owner knows them as a remote user of
	 * this server; else a remote user (made on first use) of the server it
	 * comes from, the owner or a third one. Never a system identity.
	 */
	private localUser(server: string, from: Record<string, unknown> | undefined): { userId: string; remote?: { server: string; user_id: string }; name?: string } | undefined {
		const userId = from?.user_id;
		if (typeof userId !== "string" || userId.startsWith("~")) return undefined;
		const remote = (from!.ext as Record<string, unknown> | undefined)?.remote as Record<string, unknown> | undefined;
		const name = typeof from!.name === "string" ? from!.name : undefined;
		if (remote?.server === this.host.self && typeof remote.user_id === "string") {
			return this.store.identityExists(remote.user_id) ? { userId: remote.user_id } : undefined;
		}
		const origin = typeof remote?.server === "string" && typeof remote.user_id === "string" ? { server: normalizeRemoteAddress(remote.server) ?? remote.server, user_id: remote.user_id } : { server, user_id: userId };
		if (remoteUserIdError(origin.user_id)) return undefined;
		const id = shadowUserId(origin.server, origin.user_id);
		try {
			return { userId: id, remote: origin, name: this.store.ensureShadow({ userId: id, remote: origin, name: (name ?? origin.user_id).slice(0, 64), now: this.now(), ipKey: MIRROR_IP_KEY }) };
		} catch {
			return undefined;
		}
	}

	/** A remote user's name from the owner's records, when it changed. */
	private async rename(user: { userId: string; remote?: unknown; name?: string }, name: unknown): Promise<void> {
		if (!user.remote || typeof name !== "string" || name === user.name) return;
		await this.host.runMutation(async () => {
			this.store.mutate({
				userId: user.userId, tier: "registered", ipKey: MIRROR_IP_KEY, method: "me", now: this.now(), system: true,
				params: { name: name.slice(0, 64) }, identity: { user_id: user.userId, tier: "registered" },
			});
		});
	}

	private async profileFrom(server: string, user: Record<string, unknown> | undefined): Promise<void> {
		if (!user || typeof user.user_id !== "string" || typeof user.name !== "string" || isShadowUserId(user.user_id) || user.user_id.startsWith("~")) return;
		const id = shadowUserId(server, user.user_id);
		const stored = this.store.getIdentity(id);
		if (stored && stored.name !== user.name) await this.rename({ userId: id, remote: true, name: stored.name }, user.name);
	}

	/** Owner IDs in a message's mentions and text, as this mirror knows the users (the reverse of ownerIds). */
	private mapIn(server: string, body: Record<string, unknown> | undefined): Record<string, unknown> {
		const source = body ?? {};
		const ids = new Map<string, string>();
		const self = remoteAuthority(this.host.self);
		const owner = remoteAuthority(server);
		for (const id of Array.isArray(source.mentions) ? source.mentions : []) {
			if (typeof id !== "string" || id.startsWith("~")) continue;
			ids.set(id, id.endsWith(`@${self}`) ? id.slice(0, -(self.length + 1)) : isShadowUserId(id) ? id : `${id}@${owner}`);
		}
		const text = typeof source.text === "string" ? addServerToLinks(rewriteMentions(source.text, ids), server) : "";
		// The owner's embeds load from its own origins: their URLs go as text.
		const urls = (Array.isArray(source.embeds) ? source.embeds : []).map((embed) => (embed as Record<string, unknown>)?.url).filter((url): url is string => typeof url === "string");
		const full = [text, ...urls].filter(Boolean).join("\n") || "(attachment)";
		return { text: full, format: source.format === "markdown" ? "markdown" : "plain", ...(ids.size ? { mentions: [...ids.values()] } : {}) };
	}

	/**
	 * A message snapshot of the owner: a new snapshot of its copy (made on
	 * the first), as its author here, with `ext.remote` the original's. A
	 * move out of the mirrored rooms deletes the copy, and a later snapshot
	 * restores it; a copy hidden here (an admin's or mod's delete,
	 * Store.originalOf) and a remote user removed from the room here take
	 * nothing more.
	 */
	private async copyMessage(server: string, snapshot: MessageSnapshot): Promise<void> {
		if (typeof snapshot.message_id !== "string") return;
		const state = this.store.mirrorState(this.now());
		const target = this.localRoom(state, server, snapshot.room_id);
		if (target && Number(snapshot.log_id) <= target.mirror.start) return;
		const author = this.localUser(server, snapshot.from as unknown as Record<string, unknown>);
		if (!author) return;
		await this.rename(author, (snapshot.from as unknown as Record<string, unknown>)?.name);
		const copy = this.store.copyOf(server, snapshot.message_id, this.now());
		// A copy hidden here (an admin's or mod's delete) takes nothing more; one the owner deleted takes its restore.
		if (copy && this.store.originalOf(copy, this.now())?.hidden) return;
		const current = copy ? this.store.pushedMessage(copy, this.now()) : null;
		if (!target || snapshot.deleted) {
			if (!copy || current?.deleted) return;
			await this.write(author, { message_id: copy, room_id: current?.room_id ?? "", deleted: true }, server, snapshot);
			return;
		}
		if (this.store.remoteUserLeft(author.userId, target.roomId, this.now())) return;
		const replyTo = snapshot.reply_to?.message_id ? this.store.copyOf(server, snapshot.reply_to.message_id, this.now()) : undefined;
		await this.write(author, {
			...(copy ? { message_id: copy } : {}),
			room_id: target.roomId,
			body: this.mapIn(server, snapshot.body),
			...(replyTo ? { reply_to: { message_id: replyTo } } : {}),
		}, server, snapshot);
	}

	private async write(author: { userId: string; remote?: { server: string; user_id: string }; name?: string }, params: Record<string, unknown>, server: string, original: MessageSnapshot): Promise<void> {
		const name = this.store.getIdentity(author.userId)?.name;
		await this.host.runMutation(async () => {
			const input: StoreMutationInput = {
				userId: author.userId, tier: "registered", ipKey: MIRROR_IP_KEY, method: "message", now: this.now(), system: true, params,
				identity: { user_id: author.userId, ...(name ? { name } : {}), tier: "registered" },
				copy: { remote: { server, room_id: original.room_id, message_id: original.message_id } },
				...(author.remote ? { remote: author.remote } : {}),
			};
			const result = this.store.mutate(input);
			for (const record of result.broadcasts) this.host.broadcastRecord(record);
			if (result.message) this.host.pushFor(result.message);
		});
	}

	/** The owner's reactions record: each user's set on the copy, as that user here. */
	private async copyReactions(server: string, record: Record<string, unknown>): Promise<void> {
		if (typeof record.message_id !== "string") return;
		const copy = this.store.copyOf(server, record.message_id, this.now());
		if (!copy) return;
		const room = this.store.messageRoom(copy, this.now());
		for (const set of (record.reactions as Array<Record<string, unknown>> | undefined) ?? []) {
			const user = this.localUser(server, set.from as Record<string, unknown> | undefined);
			if (!user || (room && this.store.remoteUserLeft(user.userId, room, this.now()))) continue;
			await this.host.runMutation(async () => {
				try {
					const result = this.store.mutate({
						userId: user.userId, tier: "registered", ipKey: MIRROR_IP_KEY, method: "reactions", now: this.now(), system: true,
						params: { message_id: copy, emojis: Array.isArray(set.emojis) ? set.emojis : [] },
						identity: { user_id: user.userId, tier: "registered" },
						copy: { remote: { server, room_id: String(record.room_id ?? ""), message_id: record.message_id as string } },
						...(user.remote ? { remote: user.remote } : {}),
					});
					for (const broadcast of result.broadcasts) this.host.broadcastRecord(broadcast);
				} catch (error) {
					// A custom emoji this server lacks, and the like: that set stays as it was.
					if (!(error instanceof StoreError)) throw error;
				}
			});
		}
	}

	/**
	 * A room record of the owner: a thread of a mirrored room gets a thread
	 * of the mirror room (once; `ext.remote` the owner's thread), and its
	 * later records save its `title` and `description`. A private mirror
	 * room has no threads here, so its owner's threads are not mirrored.
	 */
	private async copyRoom(server: string, record: Record<string, unknown>): Promise<void> {
		const ownerThread = record.room_id;
		const parent = record.parent_room_id;
		if (typeof ownerThread === "string" && parent === undefined) this.checkPrivacy(server, record);
		if (typeof ownerThread !== "string" || typeof parent !== "string") return;
		const state = this.store.mirrorState(this.now());
		const mirror = state.rooms.find((room) => room.server === server && room.owner_room === parent && !room.unshared);
		if (!mirror) return;
		const fields = { ...(typeof record.title === "string" ? { title: record.title } : {}), ...(typeof record.description === "string" ? { description: record.description } : {}) };
		const local = mirror.threads[ownerThread];
		if (!local && mirror.room_id.startsWith("private_")) return;
		await this.host.runMutation(async () => {
			const result = this.store.mutate({
				userId: "~room", ipKey: MIRROR_IP_KEY, method: "room_set", now: this.now(), system: true,
				params: local ? { room_id: local, ...fields } : { parent_room_id: mirror.room_id, ...fields },
				identity: { user_id: "~room" },
				...(local ? {} : { roomRemote: { server, room_id: ownerThread } }),
			});
			if (!result.room) return;
			if (!local) {
				const next = this.store.mirrorState(this.now());
				const room = next.rooms.find((candidate) => candidate.room_id === mirror.room_id);
				if (room) room.threads[ownerThread] = result.room.room_id;
				this.store.setMirrorState(next, this.now());
			}
			this.host.roomChanged(result.room);
		});
	}

	// ─────────────────────────── mirror: forwarding ───────────────────────────

	/**
	 * A local user's write in a mirror room or one of its threads
	 * (`message`, `reactions`, `room_set`): sent to the owner as that user's
	 * remote user, and answered when the owner's record has been copied
	 * here. False for a request about any other room.
	 */
	async forward(socket: unknown, client: MirrorClient, request: RequestFrame): Promise<boolean> {
		const roomId = this.requestRoom(request);
		const mirror = roomId === undefined ? undefined : this.mirrorOf(roomId);
		if (!mirror) return false;
		// The mirror room's own title, description and members are this server's.
		if (request.method === "room_set" && !mirror.thread && typeof request.params.room_id === "string") return false;
		// An admin or mod here hides another user's copy for this server only: a local delete (copyMessage leaves it hidden).
		if (request.method === "message" && request.params.deleted === true && typeof request.params.message_id === "string" && client.userId &&
			this.store.messageAuthor(request.params.message_id, this.now()) !== client.userId && this.store.mayDeleteAny(client.userId, this.now())) return false;
		if (mirror.room.unshared) throw { name: "denied", message: "This room is no longer shared by its owner; it takes no more writes" } satisfies ProtocolError;
		if (client.tier !== "registered" || !client.userId) throw { name: "denied", message: "Sign in to write in a shared room" } satisfies ProtocolError;
		// A private mirror room has no threads here, so the owner's thread would have nowhere to go.
		if (request.method === "room_set" && typeof request.params.room_id !== "string" && mirror.room.room_id.startsWith("private_")) throw { name: "denied", message: "A private room has no threads" } satisfies ProtocolError;
		const server = mirror.room.server;
		const session = this.session(server);
		session.inflight += 1;
		try {
			let connection: LinkConnection;
			try {
				connection = await withTimeout(this.ensure(server), FORWARD_TIMEOUT_MS);
			} catch {
				throw { name: "retry_after", message: `${remoteAuthority(server)}, which hosts this room, cannot be reached now`, data: { retry_after: 5 } } satisfies ProtocolError;
			}
			const userId = client.userId;
			// The user's remote user exists on the owner before their first write.
			await this.ownerUser(connection, server, userId, client.name ?? "");
			const params = await this.mapOut(connection, server, request, mirror.ownerRoom, userId);
			const answer = await connection.call(request.method, params, `${userId}:${request.id ?? this.now()}`.slice(0, 128), FORWARD_TIMEOUT_MS);
			await connection.settled();
			if (answer.error) throw this.ownerError(server, mirror.ownerRoom, answer.error);
			this.host.reply(socket, request, await this.mapResult(server, request, answer.result ?? {}, Date.now() + COPY_WAIT_MS));
			return true;
		} finally {
			session.inflight -= 1;
			this.touch(server);
		}
	}

	/** The local room a forwardable request is about. */
	private requestRoom(request: RequestFrame): string | undefined {
		const params = request.params;
		if (request.method === "message") return typeof params.room_id === "string" ? params.room_id : undefined;
		if (request.method === "reactions") return typeof params.message_id === "string" ? this.store.messageRoom(params.message_id, this.now()) ?? undefined : undefined;
		if (request.method === "room_set") return typeof params.room_id === "string" ? params.room_id : typeof params.parent_room_id === "string" ? params.parent_room_id : undefined;
		return undefined;
	}

	/** The owner's error, for the mirror's user; a closed connection or no answer is `retry_after`. */
	private ownerError(server: string, ownerRoom: string, error: NonNullable<ReplyFrame["error"]>): ProtocolError {
		if (remoteReason(error) === "not_joined") this.markUnshared(server, ownerRoom);
		if (error.code === -32603 && /closed|no answer|not connected|failed/.test(error.message ?? "")) {
			return { name: "retry_after", message: `${remoteAuthority(server)}, which hosts this room, did not answer`, data: { retry_after: 5 } };
		}
		return { name: ERROR_NAMES[error.code] ?? "internal_error", message: (error.message ?? "refused by the owner").slice(0, 200), ...(error.data ? { data: error.data } : {}) };
	}

	/**
	 * A local user's remote user on the owner: from the `you` of a `me`
	 * through the link, sent before their first write and again when their
	 * name changed.
	 */
	private async ownerUser(connection: LinkConnection, server: string, userId: string, name: string): Promise<string> {
		const key = `${USER_KEY_PREFIX}${server}|${userId}`;
		const known = await this.store.withMeterAsync("foreground", { reads: 1 }, () => this.host.storage.get<OwnerUser>(key));
		if (known && known.name === name) return known.id;
		const answer = await connection.call("me", { name, ext: { remote: { user_id: userId } } }, `${userId}:me:${this.now()}`);
		const you = answer.result?.you as Record<string, unknown> | undefined;
		const id = typeof you?.user_id === "string" ? you.user_id : known?.id ?? shadowUserId(this.host.self, userId);
		// Unanswered, it is sent again next time (the act-as write still makes the remote user).
		if (answer.error && unanswered(connection, answer)) return id;
		await this.store.withMeterAsync("foreground", { writes: 1 }, () => this.host.storage.put(key, { id, name } satisfies OwnerUser));
		return id;
	}

	/** Mirror hook, after a local user's profile change: sent to each owner that knows them, if connected. */
	onProfile(userId: string, name: string): void {
		for (const [server, session] of this.sessions) {
			const connection = session.connection;
			if (!connection?.open) continue;
			void this.store.withMeterAsync("foreground", { reads: 1 }, () => this.host.storage.get<OwnerUser>(`${USER_KEY_PREFIX}${server}|${userId}`))
				.then((known) => (known ? this.ownerUser(connection, server, userId, name) : undefined))
				.catch(() => undefined);
		}
	}

	/** A local request's params with its IDs mapped to the owner's: rooms, messages (from the copies), users. */
	private async mapOut(connection: LinkConnection, server: string, request: RequestFrame, ownerRoom: string, userId: string): Promise<Record<string, unknown>> {
		const params = request.params;
		// The act-as user is this server's `user_id` (§ext:remote); the owner shows it as `<user_id>@<this host>`.
		const ext = { remote: { user_id: userId } };
		// From the copy's state, not its `ext`, which a tombstone lacks (a restore of the user's deleted message).
		const original = (copy: unknown) => {
			if (typeof copy !== "string") return undefined;
			const origin = this.store.originalOf(copy, this.now());
			return origin?.server === server ? origin.message_id : undefined;
		};
		if (request.method === "reactions") {
			const messageId = original(params.message_id);
			if (!messageId) throw { name: "invalid_params", message: "unknown or expired message" } satisfies ProtocolError;
			return { message_id: messageId, emojis: params.emojis, ext };
		}
		if (request.method === "room_set") {
			const fields = { ...(params.title !== undefined ? { title: params.title } : {}), ...(params.description !== undefined ? { description: params.description } : {}) };
			if (typeof params.room_id === "string") return { room_id: ownerRoom, ...fields, ext };
			return { parent_room_id: ownerRoom, ...fields, ext };
		}
		const out: Record<string, unknown> = { room_id: ownerRoom, ext };
		if (typeof params.message_id === "string") {
			const messageId = original(params.message_id);
			if (!messageId) throw { name: "invalid_params", message: "unknown or expired message" } satisfies ProtocolError;
			out.message_id = messageId;
		}
		if (params.deleted !== undefined) out.deleted = params.deleted;
		const replyTo = (params.reply_to as Record<string, unknown> | undefined)?.message_id;
		const replyOriginal = original(replyTo);
		if (replyOriginal) out.reply_to = { message_id: replyOriginal };
		const body = params.body as Record<string, unknown> | undefined;
		if (body && typeof body === "object") {
			const ids = new Map<string, string>();
			for (const id of Array.isArray(body.mentions) ? body.mentions : []) {
				if (typeof id !== "string") continue;
				const mapped = await this.ownerIdOf(connection, server, id);
				if (mapped) ids.set(id, mapped);
			}
			out.body = {
				...(typeof body.text === "string" ? { text: rewriteMentions(body.text, ids) } : {}),
				...(body.format !== undefined ? { format: body.format } : {}),
				...(ids.size ? { mentions: [...ids.values()] } : {}),
			};
		}
		return out;
	}

	/** A local user ID as the owner knows the user: the owner's own user, a third server's, or this server's (through `me`). */
	private async ownerIdOf(connection: LinkConnection, server: string, userId: string): Promise<string | undefined> {
		if (isShadowUserId(userId)) {
			const remote = this.store.getIdentity(userId)?.ext?.remote as Record<string, unknown> | undefined;
			if (remote?.server === server && typeof remote.user_id === "string") return remote.user_id;
			return remote ? userId : undefined;
		}
		const name = this.store.getIdentity(userId)?.name;
		if (name === undefined) return undefined;
		return this.ownerUser(connection, server, userId, name);
	}

	/**
	 * The owner's result, with its IDs mapped back to this server's: a new
	 * message's copy, or a new thread's mirror thread. The owner sends the
	 * record before the result, so on a live connection it is here already;
	 * one dialed meanwhile holds records while it catches up, and one that
	 * closed is dialed again (catching up from the cursor). So the answer
	 * waits for it, for a limited time.
	 */
	private async mapResult(server: string, request: RequestFrame, result: Record<string, unknown>, deadline: number): Promise<Record<string, unknown>> {
		const ownerId = request.method === "message" ? result.message_id : request.method === "room_set" ? result.room_id : undefined;
		if (typeof ownerId !== "string") return {};
		const find = request.method === "message"
			? () => this.store.copyOf(server, ownerId, this.now())
			: () => this.store.mirrorState(this.now()).rooms.find((room) => room.server === server && room.threads[ownerId])?.threads[ownerId];
		for (;;) {
			const local = find();
			if (local) return request.method === "message" ? { message_id: local } : { room_id: local };
			if (Date.now() >= deadline) break;
			const session = this.sessions.get(server);
			if (session?.connecting) await session.connecting.catch(() => undefined);
			else if (!session?.connection?.open) await this.ensure(server).catch(() => new Promise((resolve) => setTimeout(resolve, 1_000)));
			else await new Promise((resolve) => setTimeout(resolve, 100));
		}
		// Accepted, not copied in time: it comes with a later read, and a resend (same request id) is the owner's duplicate.
		console.warn(JSON.stringify({ event: "remote_copy_late", server, method: request.method, id: ownerId }));
		throw { name: "internal_error", message: "The owner took it, but its copy has not arrived here yet; sending it again with the same id is safe" } satisfies ProtocolError;
	}

	// ─────────────────────────── mirror: waking ───────────────────────────

	/** Keeps an owner's connection while it works, and closes it after the linger with nothing in flight. */
	private touch(server: string): void {
		const session = this.sessions.get(server);
		if (!session) return;
		if (session.idle !== undefined) clearTimeout(session.idle);
		session.idle = setTimeout(() => {
			session.idle = undefined;
			if (session.inflight > 0 || session.buffer || session.connecting) return this.touch(server);
			session.connection?.close();
		}, this.host.lingerMs);
	}

	/**
	 * The wake route (`POST /remote/wake/<id>`, index.ts): the owner's push.
	 * The owner it names is read now, and the connection lingers. False for
	 * an unknown id or a wrong token.
	 */
	wake(id: string, authorization: string | null): boolean {
		const state = this.store.mirrorState(this.now());
		const server = Object.entries(state.servers).find(([, entry]) => entry.wake?.id === id && authorization === `Bearer ${entry.wake.token}`)?.[0];
		if (!server) return false;
		void this.ensure(server).then(() => this.touch(server), (error) => {
			console.warn(JSON.stringify({ event: "remote_wake_read_failed", server, error: error instanceof Error ? error.message : String(error) }));
		});
		return true;
	}

	private started = false;

	/**
	 * Hook on this instance's first request: each owner is read once, so a
	 * mirror that stopped while its owner was busy (an eviction, a restart)
	 * catches up without waiting for a push or the alarm.
	 */
	startup(): void {
		if (this.started) return;
		this.started = true;
		void this.onAlarm(this.now()).catch(() => undefined);
	}

	/** Alarm hook: while anything is mirrored, each owner is read now and then, in case a push was lost. */
	async onAlarm(now: number): Promise<void> {
		const servers = new Set(this.store.mirrorState(now).rooms.filter((room) => !room.unshared).map((room) => room.server));
		if (!servers.size) return;
		for (const server of servers) {
			if (this.sessions.get(server)?.connection?.open) continue;
			void this.ensure(server).then(() => this.touch(server), () => undefined);
		}
		await this.host.wakeAt(now + MIRROR_CHECK_MS);
	}
}

/** The address the link signed in on is bound to: its `you.ext.remote.server`. */
function boundServer(connection: LinkConnection): string | undefined {
	const server = ((connection.you.ext as Record<string, unknown> | undefined)?.remote as Record<string, unknown> | undefined)?.server;
	return typeof server === "string" ? server : undefined;
}

/** Whether a request's error is the connection's own (closed, or no answer in time), not the owner's answer. */
function unanswered(connection: LinkConnection, answer: ReplyFrame): boolean {
	return !connection.open || /^no answer to /.test(answer.error?.message ?? "");
}

/** Key prefix for a link's wake push (owner). */
const WAKE_KEY_PREFIX = "remote-wake:";
/** Key prefix for a local user's remote user on an owner (mirror), by owner and user. */
const USER_KEY_PREFIX = "remote-user:";

/** Whether a wake push may go to `url`: `https`, or `http` to a loopback host (development). */
export function wakeUrlAllowed(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.username || parsed.password) return false;
	if (parsed.protocol === "https:") return true;
	return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
}

function randomId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(18));
	return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); })]).finally(() => clearTimeout(timer));
}
