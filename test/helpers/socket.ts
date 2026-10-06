import { SELF } from "cloudflare:test";
import { expect } from "vitest";

export type Frame = { id?: string | null; method?: string; result?: any; error?: any; params?: any };

export type ConnectOptions = {
	ip: string;
	/** Omit the Origin header with `null`. */
	origin?: string | null;
	path?: string;
	host?: string;
	/**
	 * Keep the frames that only tell another user's `status` (§4.11): `user`
	 * `{"new": {"user_id", "status"}}`, which every connection gets as others
	 * sign in, change, and leave. Left out by default, for tests about
	 * anything else.
	 */
	statuses?: boolean;
};

/** Whether a frame only tells another user's `status` (§4.11). */
export function statusOnly(frame: Frame): boolean {
	const user = frame.method === "user" && !frame.params?.old ? frame.params?.new : undefined;
	return !!user && Object.keys(frame.params).length === 1 && Object.keys(user).sort().join() === "status,user_id";
}

/** Opens a WebSocket to the Worker and queues its frames for `next()`. */
export async function connect({ ip, origin = "http://localhost:5173", path = "/ws", host = "demo.test", statuses = false }: ConnectOptions) {
	const response = await SELF.fetch(`https://${host}${path}`, { headers: {
		Upgrade: "websocket", ...(origin === null ? {} : { Origin: origin }), "CF-Connecting-IP": ip,
	} });
	expect(response.status).toBe(101);
	const socket = response.webSocket!;
	const frames: Frame[] = [];
	const waiters: ((frame: Frame) => void)[] = [];
	let closed: { code: number; reason: string } | undefined;
	socket.addEventListener("message", (event) => {
		const frame = JSON.parse(String(event.data));
		if (!statuses && statusOnly(frame)) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame); else frames.push(frame);
	});
	socket.addEventListener("close", (event) => { closed = { code: event.code, reason: event.reason }; });
	socket.accept();
	return {
		socket,
		send(frame: unknown) { socket.send(JSON.stringify(frame)); },
		next(): Promise<Frame> {
			const frame = frames.shift();
			return frame ? Promise.resolve(frame) : new Promise((resolve) => waiters.push(resolve));
		},
		closed: () => closed,
		close() { try { socket.close(1000, "test complete"); } catch { /* already closed */ } },
	};
}

export type Peer = Awaited<ReturnType<typeof connect>>;

/**
 * Reads the frames every connection opens with: `server`, then the
 * `~private` welcome naming the server version (Appendix B).
 */
export async function greeting(peer: Peer): Promise<{ server: Frame; welcome: Frame }> {
	const server = await peer.next();
	expect(server.method).toBe("server");
	const welcome = await peer.next();
	expect(welcome.method).toBe("message");
	expect(welcome.params.from.user_id).toBe("~private");
	expect(welcome.params.body.text).toMatch(/^Welcome to Apron Chat\. Server version: `[^`]+`/);
	return { server, welcome };
}

/** Drains frames until one matches; earlier frames are returned for inspection. */
export async function until(peer: Peer, match: (frame: Frame) => boolean): Promise<{ frame: Frame; skipped: Frame[] }> {
	const skipped: Frame[] = [];
	for (;;) {
		const frame = await peer.next();
		if (match(frame)) return { frame, skipped };
		skipped.push(frame);
	}
}

/** Skips notifications that precede the reply to request `id`. */
export async function reply(peer: Peer, id: string): Promise<Frame> {
	return (await until(peer, (frame) => frame.id === id)).frame;
}

/** Sends a request; its reply and the notifications that preceded it. */
export async function exchange(peer: Peer, id: string, method: string, params: unknown): Promise<{ frame: Frame; skipped: Frame[] }> {
	peer.send({ id, method, params });
	return until(peer, (frame) => frame.id === id);
}

/**
 * Sends a `status` request (§4.11) and waits for its reply; the reply and
 * the notifications before it, which include the user's mute changes.
 */
export async function status(peer: Peer, params: Record<string, unknown>): Promise<{ frame: Frame; skipped: Frame[] }> {
	return exchange(peer, `status-${crypto.randomUUID()}`, "status", params);
}

/** Sends a request and returns its reply, skipping notifications before it. */
export async function request(peer: Peer, id: string, method: string, params: unknown): Promise<Frame> {
	return (await exchange(peer, id, method, params)).frame;
}
