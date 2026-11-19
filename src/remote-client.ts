/**
 * The outbound side of extension `ext:remote` (the trusted federation
 * recipe): one WebSocket connection to another Apron server, signed in as
 * its link for this server, and the text mapping of the ids in a message.
 * A mirror (mirror.ts) reads the owner's room and sends its users' writes
 * on such a connection.
 */

/** A frame a request was answered with: a result, or an error (§1.1). */
export interface ReplyFrame {
	result?: Record<string, unknown>;
	error?: { code: number; message?: string; data?: Record<string, unknown> };
}

/** The reason a link's request was refused, from `error.data.ext.remote` ("not_joined", "removed"), if any. */
export function remoteReason(error: ReplyFrame["error"]): string | undefined {
	const ext = error?.data?.ext as Record<string, unknown> | undefined;
	return ext && typeof ext === "object" && typeof ext.remote === "string" ? ext.remote : undefined;
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
 * One outbound connection to a remote server, signed in as its link for
 * this server (§3.2, `token` scheme). Every frame is handled in arrival
 * order, one at a time: a reply resolves its request, and anything else
 * (the room's records, `user` notifications) goes to `onFrame`, awaited
 * before the next frame. So a request's record (§1: it comes before the
 * result) is handled before its result is seen.
 */
export class LinkConnection {
	private socket: WebSocket | undefined;
	private readonly waiting = new Map<string, (frame: ReplyFrame) => void>();
	private closedReason: string | undefined;
	private chain: Promise<void> = Promise.resolve();
	/** The link's own user object, from the sign-in's `you`. */
	you: Record<string, unknown> = {};

	private constructor(readonly server: string, private readonly onFrame: (frame: Record<string, unknown>) => void | Promise<void>, private readonly onClose: () => void) {}

	/**
	 * Dials `server` (a `ws` or `wss` address, over the platform's fetch with
	 * an upgrade) and signs in with `token`; throws an Error saying why it
	 * could not.
	 */
	static async open(server: string, token: string, options: { onFrame?: (frame: Record<string, unknown>) => void | Promise<void>; onClose?: () => void; timeoutMs?: number } = {}): Promise<LinkConnection> {
		const timeoutMs = options.timeoutMs ?? 10_000;
		const connection = new LinkConnection(server, options.onFrame ?? (() => undefined), options.onClose ?? (() => undefined));
		let response: Response;
		try {
			response = await fetch(server.replace(/^ws/i, "http"), { headers: { Upgrade: "websocket" }, signal: AbortSignal.timeout(timeoutMs) });
		} catch (error) {
			throw new Error(`connect failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const socket = response.webSocket;
		if (!socket) {
			const detail = (await response.text().catch(() => "")).slice(0, 120);
			throw new Error(`no upgrade: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
		}
		socket.accept();
		connection.socket = socket;
		let greet: () => void = () => undefined;
		const greeted = new Promise<void>((resolve) => { greet = resolve; });
		socket.addEventListener("message", (event) => {
			let frame: Record<string, unknown>;
			try {
				frame = JSON.parse(String(event.data)) as Record<string, unknown>;
			} catch {
				return;
			}
			if (frame.method === "server") greet();
			connection.chain = connection.chain.then(() => connection.handle(frame)).catch((error) => {
				console.warn(JSON.stringify({ event: "remote_frame_failed", server, error: error instanceof Error ? error.message : String(error) }));
			});
		});
		socket.addEventListener("close", () => connection.fail("connection closed"));
		socket.addEventListener("error", () => connection.fail("connection failed"));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const ok = await Promise.race([greeted.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
		clearTimeout(timer);
		if (!ok) {
			connection.close();
			throw new Error("no server frame");
		}
		const auth = await connection.call("auth", { scheme: "token", token }, "auth", timeoutMs);
		if (auth.error) {
			connection.close();
			// `denied` (§1.1): the token no longer signs in.
			throw new Error(`sign-in ${auth.error.code === -32001 ? "refused" : "failed"}: ${auth.error.message ?? ""}`);
		}
		connection.you = (auth.result?.you as Record<string, unknown> | undefined) ?? {};
		return connection;
	}

	private async handle(frame: Record<string, unknown>): Promise<void> {
		const id = typeof frame.id === "string" ? frame.id : undefined;
		const waiter = id === undefined ? undefined : this.waiting.get(id);
		if (waiter) {
			this.waiting.delete(id!);
			waiter(frame as ReplyFrame);
			return;
		}
		if (id === undefined && this.closedReason === undefined) await this.onFrame(frame);
	}

	get open(): boolean {
		return this.socket !== undefined && this.closedReason === undefined;
	}

	/** Sends a request and waits for its answer; a closed connection, or none in time, answers with an error. */
	call(method: string, params: Record<string, unknown>, id: string, timeoutMs = 10_000): Promise<ReplyFrame> {
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

	/** Resolves once every frame received so far has been handled. */
	settled(): Promise<void> {
		return this.chain;
	}

	close(): void {
		this.fail("closed");
		try { this.socket?.close(1000, "nothing more to do"); } catch { /* already closed */ }
	}

	private fail(reason: string): void {
		if (this.closedReason === undefined) {
			this.closedReason = reason;
			this.onClose();
		}
		for (const [id, waiter] of this.waiting) {
			this.waiting.delete(id);
			waiter({ error: { code: -32603, message: reason } });
		}
	}
}
