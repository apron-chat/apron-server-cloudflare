/**
 * The sender of trusted federation (extension `ext:remote`; the recipe
 * `recipes/trusted_federation.md`): for each remote server this server
 * shares rooms with, an outbox over this server's own log. It sends the
 * records of this server's own users in the shared rooms, in log order,
 * through the remote server's link for this server, as those users
 * (act-as), and keeps its place in the log after each result. It never
 * reads the remote room: what the link's connection delivers is ignored.
 *
 * This module holds the mapping and the order (Outbox) and the outbound
 * connection (LinkConnection); the Durable Object gives them storage and a
 * clock (index.ts, RemoteSenders).
 */

/** One logged record of a shared room, as the outbox reads it (Store.outboxRecords). */
export interface OutboxRecord {
	room_id: string;
	log_id: number;
	kind: string;
	record: Record<string, unknown>;
}

/** A frame a request was answered with: a result, or an error (§1.1). */
export interface ReplyFrame {
	result?: Record<string, unknown>;
	error?: { code: number; message?: string; data?: Record<string, unknown> };
}

/** Sends one request on the link's connection and waits for its answer. */
export type LinkCall = (method: string, params: Record<string, unknown>, id: string) => Promise<ReplyFrame>;

/** What an outbox needs from the server it sends for. */
export interface OutboxDeps {
	/** This server's address, for links in text without `server` (Appendix A.4). */
	self: string;
	/** The shared rooms with this remote server: local room → remote room. */
	pairs(): Map<string, string>;
	/** Whether this server's link for the remote server is in a local room: a pair holds only while it is. */
	linkInRoom(roomId: string): boolean;
	dropPair(roomId: string, why: string): void;
	cursor(): number;
	advance(logId: number): void;
	records(rooms: readonly string[], after: number, limit: number): OutboxRecord[];
	/** A local message as it is now (its current snapshot), or null. */
	message(messageId: string): Record<string, unknown> | null;
	/** Whether a user is one of this server's own (not a remote user, a link, or a system identity), and exists. */
	isLocalUser(userId: string): boolean;
	/** A local user's current name ("" for none), or undefined for an unknown user. */
	userName(userId: string): string | undefined;
	/** A remote user of this remote server: its `user_id` there (`ext.remote.user_id`); undefined for anyone else. */
	remoteUserOf(userId: string): string | undefined;
	copy(messageId: string): Promise<string | undefined>;
	setCopy(messageId: string, copyId: string): Promise<void>;
	user(userId: string): Promise<{ id: string; name: string } | undefined>;
	setUser(userId: string, value: { id: string; name: string }): Promise<void>;
	log(event: string, data: Record<string, unknown>): void;
}

/** Error codes (§1.1) the outbox tells apart. */
const DENIED = -32001;
const INVALID_PARAMS = -32602;
const RETRY_AFTER = -32002;

/** The remote server asks to wait (`retry_after`), or the connection failed: try again later. */
export class RetryLater extends Error {
	constructor(readonly afterMs: number, message: string) {
		super(message);
	}
}

/** The remote server refused the link's sign-in: stop sending to it until an admin acts. */
export class SendingStopped extends Error {}

/** How many records an outbox reads at a time. */
const OUTBOX_BATCH = 32;

/**
 * Request ids made from what is sent, so a record sent again after a close
 * is a duplicate on the remote server (§1.2). At most 128 bytes.
 */
function requestId(...parts: Array<string | number>): string {
	const id = `x:${parts.join(":")}`;
	if (id.length <= 120) return id;
	// FNV-1a over the whole, with the start kept for logs.
	let hash = 0x811c9dc5;
	for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193) >>> 0;
	return `${id.slice(0, 100)}~${hash.toString(36)}`;
}

/** Whether a denied write was refused because the link has left that room (the pair has ended). */
export function linkLeftRoom(error: ReplyFrame["error"]): boolean {
	if (!error || error.code !== DENIED) return false;
	if (error.data?.reason === "link_not_in_room") return true;
	return /link (is not in|has not joined|isn't in)|not a member/i.test(error.message ?? "");
}

/**
 * Rewrites each `@id` of `body.text` whose id `ids` maps (Appendix A.3:
 * the longest run of `[A-Za-z0-9_.+@:-]` ending in a letter, digit or `_`,
 * after an `@` that no letter or digit precedes), outside code spans and
 * fenced code.
 */
export function rewriteMentions(text: string, ids: ReadonlyMap<string, string>): string {
	if (!ids.size || !text.includes("@")) return text;
	let out = "";
	let index = 0;
	while (index < text.length) {
		if (text[index] === "`") {
			// A run of backticks opens code that the same run closes; unclosed, it is text.
			let run = 1;
			while (text[index + run] === "`") run += 1;
			const fence = "`".repeat(run);
			const close = text.indexOf(fence, index + run);
			const end = close < 0 ? index + run : close + run;
			out += text.slice(index, end);
			index = end;
			continue;
		}
		if (text[index] === "@" && !/[A-Za-z0-9]/.test(text[index - 1] ?? "")) {
			const match = /^[A-Za-z0-9_.+@:-]+/.exec(text.slice(index + 1));
			let id = match?.[0] ?? "";
			while (id && !/[A-Za-z0-9_]$/.test(id)) id = id.slice(0, -1);
			if (id && /^[A-Za-z0-9_]/.test(id) && ids.has(id)) {
				out += "@" + ids.get(id);
				index += 1 + id.length;
				continue;
			}
		}
		out += text[index];
		index += 1;
	}
	return out;
}

/** Links in text without `server` refer to their server (Appendix A.4): gives them this one's. */
export function addServerToLinks(text: string, self: string): string {
	return text.replace(/(https:\/\/link\.apron\.chat\/#|apron:\?)([^\s<>`)\]]*)/g, (whole, lead: string, keys: string) =>
		/(^|&)server=/.test(keys) ? whole : `${lead}server=${self}${keys ? `&${keys}` : ""}`);
}

/**
 * The outbox of one remote server: sends what its own users did in the
 * rooms shared with it, from the place in the log it keeps, and moves that
 * place after each record the remote server answered (or that it skips).
 */
export class Outbox {
	constructor(readonly server: string, private readonly deps: OutboxDeps) {}

	/**
	 * Sends everything after the cursor, then returns. Throws RetryLater when
	 * the remote server asks to wait or the connection fails, and
	 * SendingStopped when it refuses the sign-in.
	 */
	async drain(call: LinkCall): Promise<void> {
		for (;;) {
			const pairs = this.deps.pairs();
			if (!pairs.size) return;
			const records = this.deps.records([...pairs.keys()], this.deps.cursor(), OUTBOX_BATCH);
			if (!records.length) return;
			const groups = new Map<number, OutboxRecord[]>();
			for (const record of records) groups.set(record.log_id, [...(groups.get(record.log_id) ?? []), record]);
			for (const [logId, rows] of groups) {
				// A move: the copy leaves the source room before it enters the destination.
				rows.sort((a, b) => Number(a.record.room_id === a.room_id) - Number(b.record.room_id === b.room_id));
				for (const row of rows) await this.sendRecord(row, call);
				this.deps.advance(logId);
			}
		}
	}

	/**
	 * Has anything to send, by the rooms' heads: records after the cursor in a
	 * shared room. Whose they are is decided when they are read.
	 */
	behind(head: number): boolean {
		return this.deps.pairs().size > 0 && head > this.deps.cursor();
	}

	private async sendRecord(row: OutboxRecord, call: LinkCall): Promise<void> {
		const remoteRoom = this.deps.pairs().get(row.room_id);
		if (remoteRoom === undefined) return;
		if (!this.deps.linkInRoom(row.room_id)) {
			this.deps.dropPair(row.room_id, "this server's link left the room");
			return;
		}
		const ops = new Ops(this, call, row, remoteRoom);
		try {
			if (row.kind === "message") await this.sendMessage(ops, row.record);
			else if (row.kind === "reactions") await this.sendReactions(ops, row.record);
			else if (row.kind === "membership") await this.sendLeaves(ops, row.record);
		} catch (error) {
			if (!(error instanceof PairEnded)) throw error;
			this.deps.dropPair(row.room_id, "the remote server's link is not in the room");
		}
	}

	/** Whether a record's author is one of this server's own users: never a remote user, a link, or a system identity. */
	private localAuthor(from: unknown): string | undefined {
		if (!from || typeof from !== "object") return undefined;
		const user = from as Record<string, unknown>;
		const ext = user.ext as Record<string, unknown> | undefined;
		if (typeof user.user_id !== "string" || (ext && typeof ext === "object" && ext.remote !== undefined)) return undefined;
		return this.deps.isLocalUser(user.user_id) ? user.user_id : undefined;
	}

	private async sendMessage(ops: Ops, snapshot: Record<string, unknown>): Promise<void> {
		const author = this.localAuthor(snapshot.from);
		const messageId = snapshot.message_id;
		if (!author || typeof messageId !== "string") return;
		const remote = { user_id: author, room_id: ops.row.room_id, message_id: messageId };
		const movedOut = snapshot.room_id !== ops.row.room_id;
		if (movedOut || snapshot.deleted === true) {
			// A copy that was never made has nothing to delete: skipped.
			const copy = await this.deps.copy(messageId);
			if (copy === undefined) return;
			await ops.send("message", "delete", { message_id: copy, room_id: ops.remoteRoom, deleted: true, ext: { remote } });
			return;
		}
		await this.profile(ops, author);
		const fields = await this.clientFields(ops, snapshot);
		let copy = await this.deps.copy(messageId);
		const fresh = snapshot.prev_log_id === undefined || snapshot.prev_room_id !== undefined;
		if (copy === undefined) {
			// A create; for an edit of a message whose copy this server does not
			// know, the remote server answers a repeated create with the copy it has.
			const created = await ops.send("message", "create", { room_id: ops.remoteRoom, ...fields, ext: { remote } });
			const id = created?.message_id;
			if (typeof id !== "string") return;
			await this.deps.setCopy(messageId, id);
			copy = id;
			if (fresh) return;
		}
		await ops.send("message", "save", { message_id: copy, room_id: ops.remoteRoom, ...fields, ext: { remote } });
	}

	/**
	 * A message's client fields as the remote server takes them: the body
	 * with its mentions and `@id`s mapped and this server's links given its
	 * `server`, and `reply_to` mapped or dropped. Embeds are this server's
	 * (uploads and live text load from its origins only), so each goes as a
	 * line of text with its URL, if it has one.
	 */
	private async clientFields(ops: Ops, snapshot: Record<string, unknown>): Promise<Record<string, unknown>> {
		const body = (snapshot.body && typeof snapshot.body === "object" ? snapshot.body : {}) as Record<string, unknown>;
		let text = typeof body.text === "string" ? body.text : "";
		const ids = new Map<string, string>();
		const mentions: string[] = [];
		for (const userId of Array.isArray(body.mentions) ? body.mentions : []) {
			if (typeof userId !== "string") continue;
			const remoteUser = this.deps.remoteUserOf(userId);
			const mapped = remoteUser ?? (this.deps.isLocalUser(userId) ? await this.profile(ops, userId) : undefined);
			if (mapped === undefined) continue;
			ids.set(userId, mapped);
			mentions.push(mapped);
		}
		text = addServerToLinks(rewriteMentions(text, ids), this.deps.self);
		const urls = (Array.isArray(body.embeds) ? body.embeds : [])
			.map((embed) => embed && typeof embed === "object" ? (embed as Record<string, unknown>).url : undefined)
			.filter((url): url is string => typeof url === "string");
		if (urls.length) text = [text, ...urls].filter(Boolean).join("\n");
		if (!text) text = "(attachment)";
		const fields: Record<string, unknown> = { body: { text, format: body.format === "markdown" ? "markdown" : "plain", ...(mentions.length ? { mentions } : {}) } };
		const replyTo = await this.replyTarget(snapshot.reply_to);
		if (replyTo !== undefined) fields.reply_to = { message_id: replyTo };
		return fields;
	}

	/** A reply's target on the remote server: this server's message's copy, or a copy's original; else none. */
	private async replyTarget(reference: unknown): Promise<string | undefined> {
		const messageId = reference && typeof reference === "object" ? (reference as Record<string, unknown>).message_id : undefined;
		if (typeof messageId !== "string") return undefined;
		return this.target(messageId);
	}

	/** A local message's copy, or the original of a copy of this remote server's message; else undefined. */
	private async target(messageId: string): Promise<string | undefined> {
		const message = this.deps.message(messageId);
		if (!message) return undefined;
		const remote = (message.ext as Record<string, unknown> | undefined)?.remote as Record<string, unknown> | undefined;
		if (remote && typeof remote === "object") {
			return remote.server === this.server && typeof remote.message_id === "string" ? remote.message_id : undefined;
		}
		return this.localAuthor(message.from) ? this.deps.copy(messageId) : undefined;
	}

	private async sendReactions(ops: Ops, record: Record<string, unknown>): Promise<void> {
		const messageId = record.message_id;
		if (typeof messageId !== "string" || !Array.isArray(record.reactions)) return;
		const target = await this.target(messageId);
		if (target === undefined) return;
		for (const set of record.reactions as Array<Record<string, unknown>>) {
			const author = this.localAuthor(set.from);
			if (!author) continue;
			await this.profile(ops, author);
			await ops.send("reactions", `react:${author}`, { message_id: target, emojis: Array.isArray(set.emojis) ? set.emojis : [], ext: { remote: { user_id: author } } });
		}
	}

	/** A local user's leave, for one the remote server knows (a profile was sent). Joins come with the first write. */
	private async sendLeaves(ops: Ops, record: Record<string, unknown>): Promise<void> {
		for (const entry of Array.isArray(record.members) ? record.members as Array<Record<string, unknown>> : []) {
			if (entry.joined !== false) continue;
			const author = this.localAuthor(entry.user);
			if (!author || !await this.deps.user(author)) continue;
			await ops.send("room_leave", `leave:${author}`, { room_id: ops.remoteRoom, ext: { remote: { user_id: author } } });
		}
	}

	/**
	 * Sends a local user's profile (`me` with `name`) the first time this
	 * outbox sends for them, and again when their name has changed since;
	 * the user's ID on the remote server, from the `you` it answers with.
	 */
	private async profile(ops: Ops, userId: string): Promise<string | undefined> {
		const known = await this.deps.user(userId);
		const name = this.deps.userName(userId) ?? "";
		if (known && known.name === name) return known.id;
		const result = await ops.send("me", `me:${userId}:${name}`, { name, ext: { remote: { user_id: userId } } });
		const you = result?.you as Record<string, unknown> | undefined;
		const id = typeof you?.user_id === "string" ? you.user_id : known?.id;
		if (id !== undefined) await this.deps.setUser(userId, { id, name });
		return id;
	}

	/** @internal */
	refused(row: OutboxRecord, op: string, error: NonNullable<ReplyFrame["error"]>): void {
		this.deps.log("remote_send_refused", { server: this.server, room_id: row.room_id, log_id: row.log_id, op, code: error.code, message: error.message ?? "" });
	}
}

/** The remote server's link is no longer in the room: the pair has ended. */
class PairEnded extends Error {}

/** The requests of one record, each with an id made from the record and what it is. */
class Ops {
	private count = 0;

	constructor(private readonly outbox: Outbox, private readonly call: LinkCall, readonly row: OutboxRecord, readonly remoteRoom: string) {}

	/**
	 * Sends one request and waits for its answer: the result, or undefined
	 * when the remote server refused this one request (`denied`,
	 * `invalid_params` and the like: logged and skipped). `retry_after`
	 * throws RetryLater; a refusal because the link left the room, PairEnded.
	 */
	async send(method: string, op: string, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
		this.count += 1;
		const frame = await this.call(method, params, requestId(this.row.log_id, this.row.room_id, op, this.count));
		if (frame.result) return frame.result;
		const error = frame.error ?? { code: 0, message: "no result" };
		if (error.code === RETRY_AFTER) {
			const seconds = Number(error.data?.retry_after);
			throw new RetryLater(Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 5_000, error.message ?? "retry_after");
		}
		if (linkLeftRoom(error)) throw new PairEnded(error.message ?? "denied");
		if (error.code !== DENIED && error.code !== INVALID_PARAMS) {
			// Anything else (an internal error, a closed connection) is tried again later.
			throw new RetryLater(5_000, error.message ?? `error ${error.code}`);
		}
		this.outbox.refused(this.row, op, error);
		return undefined;
	}
}

/**
 * One outbound connection to a remote server, signed in as its link for
 * this server (§3.2, `token` scheme). Requests wait for their answers by
 * `id`; every other frame (the remote room's deliveries, notices) is
 * ignored.
 */
export class LinkConnection {
	private socket: WebSocket | undefined;
	private readonly waiting = new Map<string, (frame: ReplyFrame) => void>();
	private closedReason: string | undefined;

	private constructor(readonly server: string) {}

	/**
	 * Dials `server` (a `ws` or `wss` address, over the platform's fetch with
	 * an upgrade) and signs in with `token`. A refused sign-in throws
	 * SendingStopped; a failure to connect, RetryLater.
	 */
	static async open(server: string, token: string, timeoutMs = 15_000): Promise<LinkConnection> {
		const connection = new LinkConnection(server);
		let response: Response;
		try {
			response = await fetch(server.replace(/^ws/i, "http"), { headers: { Upgrade: "websocket" }, signal: AbortSignal.timeout(timeoutMs) });
		} catch (error) {
			throw new RetryLater(5_000, `connect failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const socket = response.webSocket;
		if (!socket) {
			const detail = (await response.text().catch(() => "")).slice(0, 120);
			throw new RetryLater(response.status === 429 || response.status === 503 ? 30_000 : 10_000, `no upgrade: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
		}
		socket.accept();
		connection.socket = socket;
		const serverFrame = new Promise<void>((resolve) => {
			socket.addEventListener("message", (event) => {
				let frame: Record<string, unknown>;
				try {
					frame = JSON.parse(String(event.data)) as Record<string, unknown>;
				} catch {
					return;
				}
				if (frame.method === "server") resolve();
				const id = typeof frame.id === "string" ? frame.id : undefined;
				const waiter = id === undefined ? undefined : connection.waiting.get(id);
				if (waiter) {
					connection.waiting.delete(id!);
					waiter(frame as ReplyFrame);
				}
				// Anything else, such as the remote room's records, is not this sender's.
			});
		});
		socket.addEventListener("close", () => connection.fail("connection closed"));
		socket.addEventListener("error", () => connection.fail("connection failed"));
		await Promise.race([serverFrame, new Promise<void>((_, reject) => setTimeout(() => reject(new RetryLater(5_000, "no server frame")), timeoutMs))]);
		const auth = await connection.call("auth", { scheme: "token", token }, "auth", timeoutMs);
		if (auth.error) {
			connection.close();
			if (auth.error.code === DENIED) throw new SendingStopped(`sign-in refused: ${auth.error.message ?? ""}`);
			throw new RetryLater(auth.error.code === RETRY_AFTER ? Math.max(1_000, Number(auth.error.data?.retry_after) * 1_000 || 5_000) : 5_000, `sign-in failed: ${auth.error.message ?? ""}`);
		}
		return connection;
	}

	get open(): boolean {
		return this.socket !== undefined && this.closedReason === undefined;
	}

	/** Sends a request and waits for its answer; a closed connection answers with an error. */
	call(method: string, params: Record<string, unknown>, id: string, timeoutMs = 15_000): Promise<ReplyFrame> {
		if (!this.open) return Promise.resolve({ error: { code: -32603, message: this.closedReason ?? "not connected" } });
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				resolve({ error: { code: -32603, message: `no answer to ${method}` } });
			}, timeoutMs);
			this.waiting.set(id, (frame) => {
				clearTimeout(timer);
				resolve(frame);
			});
			try {
				this.socket!.send(JSON.stringify({ id, method, params }));
			} catch {
				this.fail("send failed");
			}
		});
	}

	close(): void {
		this.fail("closed");
		try { this.socket?.close(1000, "nothing more to send"); } catch { /* already closed */ }
	}

	private fail(reason: string): void {
		this.closedReason ??= reason;
		for (const [id, waiter] of this.waiting) {
			this.waiting.delete(id);
			waiter({ error: { code: -32603, message: reason } });
		}
	}
}
