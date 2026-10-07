import {
	evictDurableObject,
	env,
	SELF,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { expect, it } from "vitest";
import { connect as open, greeting } from "./helpers/socket";

let nextIpOctet = 1;

function testIp(): string {
	const octet = nextIpOctet++;
	return `203.0.113.${octet}`;
}

function waitForClose(socket: WebSocket, timeoutMs = 3_000): Promise<CloseEvent> {
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
			timer = undefined;
			reject(new Error("timed out waiting for WebSocket close"));
		}, timeoutMs);
		const onClose = (event: Event) => {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			resolve(event as CloseEvent);
		};
		if (socket.readyState === WebSocket.CLOSED) {
			onClose(new CloseEvent("close", { code: 1000 }));
			return;
		}
		socket.addEventListener("close", onClose, { once: true });
	});
}

/** The shared socket on the lifecycle host, with a close that gives the DO a turn to see it. */
async function connect(ip: string) {
	const peer = await open({ ip, host: "lifecycle.test" });
	const close = async () => {
		const { socket } = peer;
		if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
			socket.close(1000, "test complete");
			// The workerd test client does not always surface a peer close event
			// for an explicitly closed hibernating socket.  Give the close task a
			// turn to reach the DO without making cleanup depend on that event.
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		}
	};
	return { ...peer, close };
}

type HibernatedSocket = WebSocket & {
	deserializeAttachment(): Record<string, any>;
	serializeAttachment(value: unknown): void;
};

/** The object's hibernatable sockets, with their attachments typed. */
function socketsOf(instance: unknown): HibernatedSocket[] {
	return (instance as { ctx: { getWebSockets(): WebSocket[] } }).ctx.getWebSockets() as HibernatedSocket[];
}

/** Every socket's attachment, read inside the object. */
function attachments(stub: DurableObjectStub): Promise<Record<string, any>[]> {
	return runInDurableObject(stub, async (instance) => socketsOf(instance).map((socket) => socket.deserializeAttachment()));
}

async function pendingSocket(ip = testIp()) {
	const peer = await connect(ip);
	await greeting(peer);
	return peer;
}

async function guestSocket(ip = testIp()) {
	const peer = await pendingSocket(ip);
	peer.socket.send(JSON.stringify({ id: "auth", method: "auth", params: { scheme: "guest" } }));
	const auth = await peer.next();
	expect(auth.result?.you?.user_id).toBeTruthy();
	return peer;
}

it("restores hibernated socket attachment state without re-announcing the session", async () => {
	const stub = env.DEMO.getByName("public-demo-v1");
	const peer = await guestSocket();
	try {
		await evictDurableObject(stub);
		peer.socket.send(JSON.stringify({
			id: "after-eviction",
			method: "message",
			params: { room_id: "general", body: { format: "plain", text: "after hibernation" } },
		}));
		// The broadcast comes before the result on the sender's connection (§1).
		const broadcast = await peer.next();
		const reply = await peer.next();
		expect(reply.id).toBe("after-eviction");
		expect(reply.result?.message_id).toMatch(/^[1-9][0-9]*$/);
		expect(broadcast.method).toBe("message");
		expect(broadcast.params?.body?.text).toBe("after hibernation");
		expect(broadcast.params?.room_id).toBe("general");
	} finally {
		await peer.close();
	}
});

it("enforces the per-IP anonymous connection cap (pending and guest sockets) and releases it only after close", async () => {
	const ip = testIp();
	const first = await pendingSocket(ip);
	const second = await pendingSocket(ip);
	try {
		const rejected = await SELF.fetch("https://lifecycle.test/ws", {
			headers: {
				Upgrade: "websocket",
				Origin: "http://localhost:5173",
				"CF-Connecting-IP": ip,
			},
		});
		expect(rejected.status).toBe(429);

		await first.close();
		const admitted = await pendingSocket(ip);
		await admitted.close();
	} finally {
		await second.close();
	}
});

it("closes binary and oversized application frames with bounded policy codes", async () => {
	const binary = await pendingSocket();
	try {
		const closed = waitForClose(binary.socket);
		binary.socket.send(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
		expect((await closed).code).toBe(1003);
	} finally {
		await binary.close();
	}

	const oversized = await pendingSocket();
	try {
		const closed = waitForClose(oversized.socket);
		oversized.socket.send("x".repeat(16_385));
		expect((await closed).code).toBe(1009);
	} finally {
		await oversized.close();
	}
});

it("enforces the per-connection frame budget independently of the IP budget", async () => {
	const peer = await pendingSocket();
	try {
		// Requests from an unauthenticated socket are denied, yet still spend
		// the application frame budget, which keeps this test independent of
		// posting/authentication quotas.  Each reply drains the native DO
		// queue, so the 61st frame tests the cap without leaving work in
		// flight for the next hibernation scenario.
		for (let index = 0; index < 60; index += 1) {
			peer.socket.send(JSON.stringify({ id: `frame-${index}`, method: "lifecycle-noop" }));
			const reply = await peer.next();
			expect(reply.id).toBe(`frame-${index}`);
			// Unauthenticated requests are denied before method dispatch.
			expect(reply.error?.code).toBe(-32001);
		}
		const closed = waitForClose(peer.socket);
		peer.socket.send(JSON.stringify({ id: "frame-60", method: "lifecycle-noop" }));
		expect((await closed).code).toBe(1008);
	} finally {
		await peer.close();
	}
});

it("schedules an authentication deadline and alarm-closes an expired pending socket", async () => {
	const stub = env.DEMO.getByName("public-demo-v1");
	const peer = await pendingSocket();
	try {
		const now = Date.now();
		const alarm = await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
		expect(alarm).not.toBeNull();
		expect(alarm!).toBeGreaterThanOrEqual(now);
		expect(alarm!).toBeLessThanOrEqual(now + 30_000);

		// The test uses the native hibernation attachment itself to move this
		// connection past its deadline, then invokes the real DO alarm hook.
		await runInDurableObject(stub, async (instance) => {
			const socket = socketsOf(instance)[0];
			const attachment = socket.deserializeAttachment();
			socket.serializeAttachment({ ...attachment, authDeadline: Date.now() - 1 });
		});
		const closed = waitForClose(peer.socket);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect((await closed).code).toBe(1008);
	} finally {
		await peer.close();
	}
});

it("expires a pending WebAuthn challenge on the shared alarm without authenticating it", async () => {
	const stub = env.DEMO.getByName("public-demo-v1");
	const peer = await pendingSocket();
	try {
		peer.socket.send(JSON.stringify({
			id: "challenge-begin",
			method: "auth",
			params: { scheme: "webauthn", action: "register", step: "begin" },
		}));
		const begun = await peer.next();
		expect(begun.id).toBe("challenge-begin");
		const challengeId = begun.result?.challenge_id;
		expect(challengeId).toEqual(expect.any(String));

		await runInDurableObject(stub, async (instance) => {
			const socket = socketsOf(instance).find((candidate) => candidate.deserializeAttachment().challenge?.challengeId === challengeId);
			expect(socket).toBeDefined();
			const attachment = socket!.deserializeAttachment();
			socket!.serializeAttachment({
				...attachment,
				challenge: { ...attachment.challenge, expiresAt: Date.now() - 1 },
			});
		});
		// The pending socket's authentication deadline keeps an alarm scheduled;
		// run the real DO alarm hook now.
		expect(await runDurableObjectAlarm(stub)).toBe(true);

		peer.socket.send(JSON.stringify({
			id: "expired-challenge",
			method: "auth",
			params: {
				scheme: "webauthn",
				action: "register",
				step: "finish",
				challenge_id: challengeId,
				credential: {},
			},
		}));
		const expired = await peer.next();
		expect(expired.id).toBe("expired-challenge");
		expect(expired.error?.code).toBe(-32001);
	} finally {
		await peer.close();
	}
});

it("ignores WebAuthn notifications and consumes matching malformed finishes", async () => {
	const stub = env.DEMO.getByName("public-demo-v1");
	const peer = await pendingSocket();
	try {
		peer.socket.send(JSON.stringify({ id: "unknown-scheme", method: "auth", params: { scheme: "password", action: "login", step: "begin" } }));
		// A scheme the spec does not define is an unknown name: invalid_params (§1).
		expect((await peer.next()).error?.code).toBe(-32602);
		peer.socket.send(JSON.stringify({ method: "auth", params: { scheme: "webauthn", action: "register", step: "begin" } }));
		peer.socket.send(JSON.stringify({ id: "notification-barrier", method: "lifecycle-noop" }));
		expect((await peer.next()).error?.code).toBe(-32001);
		const afterNotification = await attachments(stub);
		expect(afterNotification.some((attachment) => attachment.tier === "pending" && attachment.challenge !== undefined)).toBe(false);

		peer.socket.send(JSON.stringify({ id: "begin-for-finish", method: "auth", params: { scheme: "webauthn", action: "register", step: "begin" } }));
		const begun = await peer.next();
		const challengeId = begun.result?.challenge_id;
		expect(challengeId).toEqual(expect.any(String));
		peer.socket.send(JSON.stringify({ id: "malformed-finish", method: "auth", params: {
			scheme: "webauthn", action: "register", step: "finish", challenge_id: challengeId,
		} }));
		const malformed = await peer.next();
		expect(malformed.error?.code).toBe(-32602);

		const afterMalformed = await attachments(stub);
		expect(afterMalformed.some((attachment) => attachment.challenge?.challengeId === challengeId)).toBe(false);
		peer.socket.send(JSON.stringify({ id: "replayed-finish", method: "auth", params: {
			scheme: "webauthn", action: "register", step: "finish", challenge_id: challengeId,
		} }));
		const replayed = await peer.next();
		expect(replayed.error?.code).toBe(-32001);
	} finally {
		await peer.close();
	}
});

it("keeps a pending ceremony for a different challenge id and consumes it on action mismatch", async () => {
	const stub = env.DEMO.getByName("public-demo-v1");
	const peer = await pendingSocket();
	try {
		peer.socket.send(JSON.stringify({ id: "action-begin", method: "auth", params: { scheme: "webauthn", action: "register", step: "begin" } }));
		const begun = await peer.next();
		const challengeId = begun.result?.challenge_id as string;
		peer.socket.send(JSON.stringify({ id: "wrong-id", method: "auth", params: {
			scheme: "webauthn", action: "register", step: "finish", challenge_id: "other-challenge",
		} }));
		expect((await peer.next()).error?.code).toBe(-32001);
		const retained = await attachments(stub);
		expect(retained.some((attachment) => attachment.challenge?.challengeId === challengeId)).toBe(true);

		peer.socket.send(JSON.stringify({ id: "wrong-action", method: "auth", params: {
			scheme: "webauthn", action: "login", step: "finish", challenge_id: challengeId,
		} }));
		expect((await peer.next()).error?.code).toBe(-32001);
		const consumed = await attachments(stub);
		expect(consumed.some((attachment) => attachment.challenge?.challengeId === challengeId)).toBe(false);
	} finally {
		await peer.close();
	}
});
