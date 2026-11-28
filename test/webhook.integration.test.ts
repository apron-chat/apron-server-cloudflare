import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect as open, exchange, request, until, type Frame, type Peer } from './helpers/socket';
import { base64Decode, importWebhookSigningKey, verificationResponse, verifyWebhookSignature } from '../src/webhook';
import { testBrowser } from './helpers/webpush';
import type { Store } from '../src/store';

// Push kind `webhook` (protocol §4.9.4) against the real Durable Object: a
// bot registers its URL, the server verifies it, calls it on a mention or a
// reply while the bot has no connection, and runs the frames it answers with.
// Every outbound request is caught by a stand-in endpoint (`endpoint`) that
// answers verifications as a Standard Webhooks consumer would.

let nextIp = 1;
const stub = () => env.DEMO.getByName('public-demo-v1');
const connect = (origin: string | null = 'http://localhost:5173') => open({ ip: `198.51.100.${nextIp++}`, origin });
const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

type Runtime = {
	store: Store;
	issueSession(userId: string, origin: string, now: number): Promise<string>;
	webhookRetryDelaysMs: readonly number[];
	config: { webhook?: unknown };
};

async function register(userId: string): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		(instance as unknown as Runtime).store.accounts.register({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
	});
}

async function signedIn(userId: string): Promise<Peer> {
	await register(userId);
	const token = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).issueSession(userId, 'http://localhost:5173', Date.now()));
	const peer = await connect();
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
	return peer;
}

async function command(peer: Peer, id: string, text: string): Promise<{ frame: Frame; notice?: Frame }> {
	const { frame, skipped } = await exchange(peer, id, 'command', { room_id: 'general', body: { text } });
	return { frame, notice: skipped.find((candidate) => candidate.method === 'message' && candidate.params.from.user_id === '~private') };
}

/** The owner's bot: its token, and a connection signed in with it. */
async function botOf(owner: Peer): Promise<{ token: string; peer: Peer; botId: string }> {
	const minted = await command(owner, 'invite-bot', '/invite-bot');
	const token = minted.notice!.params.body.text.match(/```\n(apron_bot_[A-Za-z0-9_-]+)\n```/)![1];
	const peer = await connect(null);
	await peer.next();
	const you = (await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you;
	expect(you.roles).toEqual(['bot']);
	return { token, peer, botId: you.user_id };
}

/** Waits until the object counts none of a user's connections, once they closed. */
async function disconnected(userId: string): Promise<void> {
	await vi.waitFor(async () => {
		const open = await runInDurableObject(stub(), (_instance, state) => state.getWebSockets()
			.filter((socket) => socket.readyState === 1)
			.map((socket) => socket.deserializeAttachment() as { userId?: string; closing?: boolean })
			.filter((attachment) => attachment.userId === userId && !attachment.closing).length);
		expect(open).toBe(0);
	});
}

type Hit = { url: string; headers: Headers; body: string; json: any };

/**
 * A stand-in for every outbound request: verifications are answered with
 * the right `webhook-challenge-response` (unless `answer` says otherwise),
 * and calls with what `respond` returns.
 */
function endpoint(options: {
	endpointId?: () => string | undefined;
	answer?: (hit: Hit) => string | null;
	respond?: (hit: Hit) => Response | Promise<Response>;
} = {}) {
	const hits: Hit[] = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const body = await request.text();
		let json: any;
		try { json = JSON.parse(body); } catch { json = undefined; }
		const hit = { url: request.url, headers: request.headers, body, json };
		hits.push(hit);
		const challenge = request.headers.get('webhook-challenge');
		if (challenge !== null) {
			const id = options.endpointId?.();
			const answer = options.answer ? options.answer(hit) : id ? await verificationResponse(await publicKey(), id, challenge) : null;
			return new Response(null, { status: 204, headers: answer ? { 'webhook-challenge-response': answer } : {} });
		}
		return options.respond ? options.respond(hit) : new Response(null, { status: 202 });
	});
	return hits;
}

let cachedKey: Uint8Array<ArrayBuffer> | undefined;
/** The server's signing public key, as `server.push.webhook.signature_keys` advertises it. */
async function publicKey(): Promise<Uint8Array<ArrayBuffer>> {
	return cachedKey ??= (await importWebhookSigningKey(env.WEBHOOK_SIGNING_KEY!)).publicKey;
}

/** Registers the bot's webhook over its connection and waits for it to be verified. */
async function registered(bot: Peer, botId: string, url: string, params: Record<string, unknown> = {}, respond?: (hit: Hit) => Response | Promise<Response>): Promise<{ endpointId: string; hits: Hit[] }> {
	let endpointId: string | undefined;
	const hits = endpoint({ endpointId: () => endpointId, ...(respond ? { respond } : {}) });
	const reply = await request(bot, `register-${crypto.randomUUID()}`, 'push_register', { kind: 'webhook', url, ...params });
	expect(reply.result).toMatchObject({ endpoint_id: expect.stringMatching(/^wh_[A-Za-z0-9_-]+$/), state: 'verifying' });
	endpointId = reply.result.endpoint_id;
	await vi.waitFor(async () => expect((await hookOf(botId, url))?.state).toBe('on'));
	return { endpointId: endpointId!, hits };
}

/** A bot's registration of `url`, as stored (polling over push_register would spend its registrations a minute). */
function hookOf(botId: string, url: string) {
	return runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.webhooks!.of(botId).find((hook) => hook.url === url));
}

/** Another connection signed in with the bot's token. */
async function again(token: string): Promise<Peer> {
	const peer = await connect(null);
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.roles).toEqual(['bot']);
	return peer;
}

afterEach(() => { vi.restoreAllMocks(); });
// Retries after milliseconds, not seconds: a first challenge often comes before the test has read the endpoint_id.
beforeEach(async () => {
	await runInDurableObject(stub(), (instance) => { (instance as unknown as Runtime).webhookRetryDelaysMs = [50, 50]; });
});

describe('server frame (v11)', () => {
	it('announces apron 11 with each push kind\'s own configuration, and the v10 fields', async () => {
		const peer = await connect();
		try {
			const server = await peer.next();
			expect(server.params.apron).toBe(11);
			const push = server.params.push;
			expect(push.webpush).toEqual({ vapid_key: env.VAPID_PUBLIC_KEY, wake: ['mentions', 'replies', 'private'], key: env.VAPID_PUBLIC_KEY });
			// For clients of version 10, which read the scopes at the top.
			expect(push.wake).toEqual(['mentions', 'replies', 'private']);
			const key = await importWebhookSigningKey(env.WEBHOOK_SIGNING_KEY!);
			expect(push.webhook).toEqual({ signature_keys: [key.publicText], wake: ['mentions', 'replies', 'private', 'joined'], format: ['full', 'knock'] });
			expect(push.webhook.signature_keys[0]).toMatch(/^whpk_[A-Za-z0-9+/]{43}=$/);
		} finally { peer.close(); }
	});

	it('refuses a webpush wake that selects no scope it supports for the user, which used to wake for nothing', async () => {
		const browser = await testBrowser();
		const keys = { p256dh: browser.p256dh, auth: browser.auth };
		const wakes = [[], ['ext:x'], ['joined'], ['records']];
		// Two bad requests per connection, below the repeated-violation close.
		for (let index = 0; index < wakes.length; index += 2) {
			const peer = await signedIn(unique('wakeless'));
			try {
				for (const wake of wakes.slice(index, index + 2)) {
					const reply = await request(peer, `wake-${wake.join('-')}`, 'push_register', { kind: 'webpush', url: `https://push.example.net/w/${crypto.randomUUID()}`, keys, wake });
					expect(reply.error?.code, JSON.stringify(wake)).toBe(-32602);
				}
				expect((await request(peer, 'wake-ok', 'push_register', { kind: 'webpush', url: `https://push.example.net/w/${crypto.randomUUID()}`, keys, wake: ['joined', 'mentions'] })).result).toEqual({});
			} finally { peer.close(); }
		}
	});
});

describe('webhook registration', () => {
	it('takes a webhook from bots only, with a public https url, a supported wake and format', async () => {
		const ownerId = unique('hookowner');
		const owner = await signedIn(ownerId);
		const { peer: bot, token } = await botOf(owner);
		endpoint();
		try {
			// A person, the owner included, is denied.
			expect((await request(owner, 'person', 'push_register', { kind: 'webhook', url: 'https://bot.example/apron' })).error.code).toBe(-32001);
			const cases: Array<[string, Record<string, unknown>, number]> = [
				['plain http', { url: 'http://bot.example/apron' }, -32602],
				['an IP literal', { url: 'https://10.0.0.1/apron' }, -32602],
				['an internal host', { url: 'https://bot.internal/apron' }, -32602],
				['a port', { url: 'https://bot.example:8443/apron' }, -32602],
				['an empty wake', { url: 'https://bot.example/apron', wake: [] }, -32602],
				['only unknown scopes', { url: 'https://bot.example/apron', wake: ['records', 'ext:x'] }, -32602],
				['an unknown format', { url: 'https://bot.example/apron', format: 'mail' }, -32602],
				['a long url', { url: `https://bot.example/${'x'.repeat(600)}` }, -32003],
			];
			// Two bad requests per connection, below the repeated-violation close.
			for (let index = 0; index < cases.length; index += 2) {
				const peer = await again(token);
				try {
					for (const [label, params, code] of cases.slice(index, index + 2)) {
						expect((await request(peer, `bad-${label}`, 'push_register', { kind: 'webhook', ...params })).error?.code, label).toBe(code);
					}
				} finally { peer.close(); }
			}
			// Any public host: PUSH_HOSTS names push services, not bots.
			const reply = await request(bot, 'good', 'push_register', { kind: 'webhook', url: 'https://bot.example/apron' });
			expect(reply.result).toEqual({ endpoint_id: expect.stringMatching(/^wh_[A-Za-z0-9_-]{16}$/), state: 'verifying' });
			expect(reply.result.endpoint_id).not.toContain('.');
			// Unregistering removes it; an unknown url is already gone.
			expect((await request(bot, 'unregister', 'push_unregister', { url: 'https://bot.example/apron' })).result).toEqual({});
			expect((await request(bot, 'unregister-again', 'push_unregister', { url: 'https://bot.example/apron' })).result).toEqual({});
		} finally { owner.close(); bot.close(); }
	});

	it('verifies the url after the result with a signed challenge, keeping the endpoint_id when registered again', async () => {
		const owner = await signedIn(unique('verifier'));
		const { peer: bot, botId } = await botOf(owner);
		try {
			const url = `https://bot.example/verify/${crypto.randomUUID()}`;
			const { endpointId, hits } = await registered(bot, botId, url, { wake: ['mentions'] });
			const verification = hits.find((hit) => hit.headers.get('webhook-challenge') !== null)!;
			expect(verification.url).toBe(url);
			// Signed as calls are: v2a over endpoint_id.msg_id.timestamp.body.
			const id = verification.headers.get('webhook-id')!;
			expect(id).toMatch(/^msg_[A-Za-z0-9_-]+$/);
			const timestamp = Number(verification.headers.get('webhook-timestamp'));
			expect(Math.abs(timestamp - Date.now() / 1000)).toBeLessThan(60);
			expect(base64Decode(verification.headers.get('webhook-challenge')!)?.byteLength).toBe(32);
			expect(await verifyWebhookSignature([await publicKey()], endpointId, id, timestamp, verification.body, verification.headers.get('webhook-signature')!)).toBe(true);
			// Registering again keeps the endpoint_id and returns the state, verifying nothing again.
			const before = hits.length;
			const again = await request(bot, 'again', 'push_register', { kind: 'webhook', url, wake: ['mentions'] });
			expect(again.result).toEqual({ endpoint_id: endpointId, state: 'on' });
			expect(hits.length).toBe(before);
		} finally { owner.close(); bot.close(); }
	});

	it('marks a url that answers the challenge wrongly failing, with why, and verifies again when registered again', async () => {
		const owner = await signedIn(unique('wrong'));
		const { peer: bot, botId } = await botOf(owner);
		try {
			const url = `https://bot.example/wrong/${crypto.randomUUID()}`;
			let right = false;
			let endpointId: string | undefined;
			endpoint({ answer: (hit) => right ? null : hit.headers.get('webhook-challenge'), endpointId: () => endpointId });
			const reply = await request(bot, 'register', 'push_register', { kind: 'webhook', url });
			endpointId = reply.result.endpoint_id;
			await vi.waitFor(async () => expect((await hookOf(botId, url))?.state).toBe('failing'));
			// The state and why, as registering again returns them; while failing, that verifies again.
			const failing = await request(bot, 'failing', 'push_register', { kind: 'webhook', url });
			expect(failing.result).toMatchObject({ endpoint_id: endpointId, state: 'verifying' });
			await vi.waitFor(async () => expect((await hookOf(botId, url))?.state).toBe('failing'));
			expect((await hookOf(botId, url))?.error).toMatch(/verification failed: webhook-challenge-response does not answer/);
			right = true;
			vi.restoreAllMocks();
			endpoint({ endpointId: () => endpointId });
			const retried = await request(bot, 'retry', 'push_register', { kind: 'webhook', url });
			expect(retried.result).toEqual({ endpoint_id: endpointId, state: 'verifying' });
			await vi.waitFor(async () => expect((await hookOf(botId, url))?.state).toBe('on'));
		} finally { owner.close(); bot.close(); }
	});
});

describe('webhook calls', () => {
	it('calls on a mention while the bot is away, with the call shape of §4.9.4, signed for its endpoint', async () => {
		const ownerId = unique('caller');
		const owner = await signedIn(ownerId);
		const { peer: bot, botId } = await botOf(owner);
		const url = `https://bot.example/call/${crypto.randomUUID()}`;
		const { endpointId, hits } = await registered(bot, botId, url);
		const botPost = (await request(bot, 'sunny', 'message', { room_id: 'general', body: { text: 'Sunny today.' } })).result as { message_id: string };
		bot.close();
		await disconnected(botId);
		try {
			const posted = await request(owner, 'mention', 'message', { room_id: 'general', body: { text: `@${botId} hello`, mentions: [botId] } });
			const messageId = posted.result.message_id;
			await vi.waitFor(() => expect(hits.filter((hit) => hit.json?.method === 'webhook')).toHaveLength(1));
			const call = hits.find((hit) => hit.json?.method === 'webhook')!;
			expect(call.url).toBe(url);
			expect(call.headers.get('content-type')).toMatch(/^application\/json/);
			const id = call.headers.get('webhook-id')!;
			expect(id).not.toContain('.');
			const timestamp = Number(call.headers.get('webhook-timestamp'));
			expect(await verifyWebhookSignature([await publicKey()], endpointId, id, timestamp, call.body, call.headers.get('webhook-signature')!)).toBe(true);
			// Not for another endpoint.
			expect(await verifyWebhookSignature([await publicKey()], 'wh_other', id, timestamp, call.body, call.headers.get('webhook-signature')!)).toBe(false);
			const params = call.json.params;
			expect(Object.keys(call.json)).toEqual(['method', 'params']);
			expect(params).toMatchObject({
				server: 'wss://demo.test/ws',
				you: { user_id: botId, roles: ['bot'] },
				attempt: 1,
				first_log_id: expect.any(String), last_log_id: expect.any(String),
				token: expect.stringMatching(/^apron_webhook_/), token_expires: expect.stringMatching(/^\d+$/),
				wake: { [messageId]: ['mentions'] },
				rooms: [expect.objectContaining({ room_id: 'general' })],
				users: [{ user_id: ownerId, name: `Name of ${ownerId}`, roles: [] }],
			});
			expect(params).not.toHaveProperty('since');
			expect(Number(params.token_expires) - Date.now()).toBeGreaterThan(14 * 60_000);
			expect(params.messages).toHaveLength(1);
			const [message] = params.messages;
			expect(message).toMatchObject({ message_id: messageId, room_id: 'general', from: { user_id: ownerId, roles: [] }, body: { text: `@${botId} hello`, mentions: [botId] } });
			expect(params.first_log_id).toBe(message.log_id);
			expect(params.last_log_id).toBe(message.log_id);

			// A message that does not concern the bot calls nothing; the next call says where the last ended.
			await request(owner, 'plain', 'message', { room_id: 'general', body: { text: 'nothing for bots' } });
			const reply = await request(owner, 'reply', 'message', { room_id: 'general', reply_to: { message_id: messageId }, body: { text: 'and again' } });
			expect(reply.error).toBeUndefined();
			// The owner replied to their own message: not to the bot, so still no call.
			await request(owner, 'reply-bot', 'message', { room_id: 'general', reply_to: { message_id: botPost.message_id }, body: { text: 'tomorrow?' } });
			await vi.waitFor(() => expect(hits.filter((hit) => hit.json?.method === 'webhook')).toHaveLength(2));
			const second = hits.filter((hit) => hit.json?.method === 'webhook')[1].json.params;
			expect(second.since).toBe(params.last_log_id);
			const [answer] = second.messages;
			expect(Object.values(second.wake)).toEqual([['replies']]);
			// The replied-to message as a full snapshot, its author with roles.
			expect(answer.reply_to).toMatchObject({ message_id: botPost.message_id, log_id: expect.any(String), from: { user_id: botId, roles: ['bot'] }, body: { text: 'Sunny today.' } });
		} finally { owner.close(); }
	});

	it('does not call while the bot has a connection open', async () => {
		const owner = await signedIn(unique('present'));
		const { peer: bot, botId } = await botOf(owner);
		const { hits } = await registered(bot, botId, `https://bot.example/present/${crypto.randomUUID()}`);
		try {
			await request(owner, 'mention', 'message', { room_id: 'general', body: { text: `@${botId}`, mentions: [botId] } });
			await until(bot, (frame) => frame.method === 'message' && frame.params.body?.text === `@${botId}`);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(hits.filter((hit) => hit.json?.method === 'webhook')).toEqual([]);
		} finally { owner.close(); bot.close(); }
	});

	it('runs the request frames a 2xx answer holds, as the bot, deduplicated, at most 10, recording a failure in error', async () => {
		const ownerId = unique('answered');
		const owner = await signedIn(ownerId);
		const { peer: bot, botId } = await botOf(owner);
		const url = `https://bot.example/answer/${crypto.randomUUID()}`;
		// The bot answers each call in its response: a reply and a reaction, one frame a line.
		const frames = (target: string) => [
			JSON.stringify({ id: `answer-${target}`, method: 'message', params: { room_id: 'general', reply_to: { message_id: target }, body: { text: 'Sunny, 21°C' } } }),
			JSON.stringify({ id: `react-${target}`, method: 'reactions', params: { room_id: 'general', message_id: target, emojis: ['👀'] } }),
		].join('\n');
		const { hits } = await registered(bot, botId, url, {}, (hit) => new Response(frames(hit.json.params.messages[0].message_id), { status: 200 }));
		bot.close();
		await disconnected(botId);
		try {
			const ask = async (id: string) => {
				const posted = await request(owner, id, 'message', { room_id: 'general', body: { text: `@${botId} weather?`, mentions: [botId] } });
				return posted.result.message_id as string;
			};
			const messageId = await ask('first');
			await vi.waitFor(() => expect(hits.filter((hit) => hit.json?.method === 'webhook')).toHaveLength(1));
			const posted = await until(owner, (frame) => frame.method === 'message' && frame.params.from?.user_id === botId && frame.params.body?.text === 'Sunny, 21°C');
			expect(posted.frame.params.reply_to).toEqual({ message_id: messageId });
			await until(owner, (frame) => frame.method === 'reactions' && frame.params.message_id === messageId);
			// The same frames again (a retried call) post nothing twice: the ids deduplicate them (§1.2).
			const count = async () => runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ n: number }>(
				"SELECT COUNT(*) AS n FROM message_state WHERE author_id = ?", botId).one().n);
			const before = await count();
			await runInDurableObject(stub(), async (instance) => {
				const server = instance as unknown as { runWebhookFrames(hook: unknown, identity: unknown, text: string, until: number): Promise<void> };
				const store = (instance as unknown as Runtime).store;
				const hook = store.webhooks!.of(botId)[0];
				await server.runWebhookFrames(hook, store.accounts.get(botId), frames(messageId), Date.now() + 60_000);
			});
			expect(await count()).toBe(before);
			// A frame the token may not send fails, and is kept in `error`; past 10 lines nothing runs.
			await runInDurableObject(stub(), async (instance) => {
				const server = instance as unknown as { runWebhookFrames(hook: unknown, identity: unknown, text: string, until: number): Promise<void> };
				const store = (instance as unknown as Runtime).store;
				const hook = store.webhooks!.of(botId)[0];
				const lines = [JSON.stringify({ id: 'set', method: 'room_set', params: { room_id: 'general', title: 'Hijacked' } })];
				for (let index = 0; index < 12; index++) lines.push(JSON.stringify({ id: `many-${index}`, method: 'message', params: { room_id: 'general', body: { text: `line ${index}` } } }));
				await server.runWebhookFrames(hook, store.accounts.get(botId), lines.join('\n'), Date.now() + 60_000);
			});
			expect(await count()).toBe(before + 9);
			const state = (await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.webhooks!.of(botId)[0]));
			expect(state.error).toMatch(/frame 1 failed: A webhook token may only post, react, show typing and read history/);
			expect(state.state).toBe('on');
		} finally { owner.close(); }
	});

	it('retries a 503 with the same webhook-id and a higher attempt, removes a 410, and fails 4xx at once', async () => {
		const owner = await signedIn(unique('retried'));
		const { peer: bot, botId } = await botOf(owner);
		const url = `https://bot.example/retry/${crypto.randomUUID()}`;
		let endpointId: string | undefined;
		const statuses = [503, 200, 404, 410];
		const hits = endpoint({ endpointId: () => endpointId, respond: () => new Response(null, { status: statuses.shift() ?? 500, headers: { 'Retry-After': '0' } }) });
		endpointId = (await request(bot, 'register', 'push_register', { kind: 'webhook', url })).result.endpoint_id;
		await vi.waitFor(async () => expect((await hookOf(botId, url))?.state).toBe('on'));
		bot.close();
		await disconnected(botId);
		const calls = () => hits.filter((hit) => hit.json?.method === 'webhook');
		try {
			await request(owner, 'one', 'message', { room_id: 'general', body: { text: `@${botId} one`, mentions: [botId] } });
			await vi.waitFor(() => expect(calls()).toHaveLength(2));
			const [first, retry] = calls();
			expect(first.json.params.attempt).toBe(1);
			expect(retry.json.params.attempt).toBe(2);
			expect(retry.headers.get('webhook-id')).toBe(first.headers.get('webhook-id'));
			expect(retry.json.params.token).toBe(first.json.params.token);
			// A 404 is not retried, and is kept as the last error.
			await request(owner, 'two', 'message', { room_id: 'general', body: { text: `@${botId} two`, mentions: [botId] } });
			await vi.waitFor(() => expect(calls()).toHaveLength(3));
			await vi.waitFor(async () => expect((await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.webhooks!.of(botId)[0])).error).toMatch(/call failed: HTTP 404/));
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(calls()).toHaveLength(3);
			// A 410 removes the registration.
			await request(owner, 'three', 'message', { room_id: 'general', body: { text: `@${botId} three`, mentions: [botId] } });
			await vi.waitFor(async () => expect(await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.webhooks!.of(botId))).toEqual([]));
		} finally { owner.close(); }
	});

	it('calls with only a knock in the knock format, and for the bot\'s room changes', async () => {
		const ownerId = unique('knocker');
		const owner = await signedIn(ownerId);
		const { peer: bot, botId } = await botOf(owner);
		const { hits } = await registered(bot, botId, `https://bot.example/knock/${crypto.randomUUID()}`, { format: 'knock', wake: ['mentions'] });
		bot.close();
		await disconnected(botId);
		try {
			const posted = await request(owner, 'mention', 'message', { room_id: 'general', body: { text: `@${botId}`, mentions: [botId] } });
			await vi.waitFor(() => expect(hits.filter((hit) => hit.json?.method === 'webhook')).toHaveLength(1));
			const params = hits.find((hit) => hit.json?.method === 'webhook')!.json.params;
			expect(Object.keys(params).sort()).toEqual(['attempt', 'latest_log_id', 'server', 'token', 'token_expires', 'you']);
			expect(BigInt(params.latest_log_id)).toBeGreaterThan(0n);
			expect(posted.result.message_id).toBeDefined();
		} finally { owner.close(); }

		// A full webhook hears of the rooms it is added to.
		const other = await signedIn(unique('roomy'));
		const { peer: roomBot, botId: roomBotId } = await botOf(other);
		const { hits: roomHits } = await registered(roomBot, roomBotId, `https://bot.example/rooms/${crypto.randomUUID()}`);
		roomBot.close();
		await disconnected(roomBotId);
		try {
			const created = await request(other, 'room', 'room_set', { private: true });
			expect(created.error).toBeUndefined();
			const roomId = created.result.room_id as string;
			const joined = await request(other, 'add', 'room_join', { room_id: roomId, user_id: roomBotId });
			expect(joined.error).toBeUndefined();
			await vi.waitFor(() => expect(roomHits.filter((hit) => hit.json?.params?.joined)).toHaveLength(1));
			const call = roomHits.find((hit) => hit.json?.params?.joined)!.json.params;
			expect(call.joined).toEqual([expect.objectContaining({ room_id: roomId })]);
			// A message in that private room calls it for `private`.
			await request(other, 'private-post', 'message', { room_id: roomId, body: { text: 'ops only' } });
			await vi.waitFor(() => expect(roomHits.filter((hit) => hit.json?.params?.messages)).toHaveLength(1));
			const privateCall = roomHits.find((hit) => hit.json?.params?.messages)!.json.params;
			expect(Object.values(privateCall.wake)).toEqual([['private']]);
		} finally { other.close(); }
	});
});

describe('call tokens', () => {
	it('signs the bot in until token_expires, to post, react, type and read history in its rooms only, replacing no token', async () => {
		const owner = await signedIn(unique('tokened'));
		const { peer: bot, botId, token: botToken } = await botOf(owner);
		const { hits } = await registered(bot, botId, `https://bot.example/token/${crypto.randomUUID()}`);
		bot.close();
		await disconnected(botId);
		try {
			await request(owner, 'mention', 'message', { room_id: 'general', body: { text: `@${botId}`, mentions: [botId] } });
			await vi.waitFor(() => expect(hits.filter((hit) => hit.json?.method === 'webhook')).toHaveLength(1));
			const token = hits.find((hit) => hit.json?.method === 'webhook')!.json.params.token;
			const peer = await connect(null);
			try {
				await peer.next();
				const auth = await request(peer, 'auth', 'auth', { scheme: 'token', token });
				expect(auth.result.you).toMatchObject({ user_id: botId, roles: ['bot'] });
				// No token of its own: the bot's long-lived token stays.
				expect(auth.result).not.toHaveProperty('token');
				expect((await request(peer, 'history', 'history', { room_id: 'general', limit: 5 })).error).toBeUndefined();
				expect((await request(peer, 'post', 'message', { room_id: 'general', body: { text: 'via call token' } })).error).toBeUndefined();
				expect((await request(peer, 'set', 'room_set', { room_id: 'general', title: 'x' })).error.code).toBe(-32001);
				expect((await request(peer, 'register', 'push_register', { kind: 'webhook', url: 'https://bot.example/other' })).error.code).toBe(-32001);
				expect((await request(peer, 'elsewhere', 'message', { room_id: 'private_nowhere', body: { text: 'x' } })).error.code).toBe(-32001);
			} finally { peer.close(); }
			// The long-lived token still signs in, with its full powers.
			const again = await connect(null);
			try {
				await again.next();
				expect((await request(again, 'auth', 'auth', { scheme: 'token', token: botToken })).result.you.user_id).toBe(botId);
			} finally { again.close(); }
			// A forged or changed token is denied.
			const forged = await connect(null);
			try {
				await forged.next();
				expect((await request(forged, 'auth', 'auth', { scheme: 'token', token: `${token.slice(0, -2)}AA` })).error.code).toBe(-32001);
			} finally { forged.close(); }
		} finally { owner.close(); }
	});
});

describe('owner controls', () => {
	it('lets the bot\'s owner see, pause, resume and remove its webhook', async () => {
		const owner = await signedIn(unique('controller'));
		const { peer: bot, botId } = await botOf(owner);
		const url = `https://bot.example/owner/${crypto.randomUUID()}`;
		const { endpointId, hits } = await registered(bot, botId, url);
		try {
			const shown = await command(owner, 'show', '/webhook');
			expect(shown.frame.result).toEqual({});
			expect(shown.notice!.params.body.text).toContain(url);
			expect(shown.notice!.params.body.text).toContain(endpointId);
			expect(shown.notice!.params.body.text).toContain(': on,');
			await command(owner, 'pause', '/webhook pause');
			expect((await request(bot, 'paused', 'push_register', { kind: 'webhook', url })).result).toEqual({ endpoint_id: endpointId, state: 'failing', error: expect.stringMatching(/paused/) });
			bot.close();
			await disconnected(botId);
			await request(owner, 'mention', 'message', { room_id: 'general', body: { text: `@${botId}`, mentions: [botId] } });
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(hits.filter((hit) => hit.json?.method === 'webhook')).toEqual([]);
			await command(owner, 'resume', '/webhook resume');
			await vi.waitFor(async () => expect((await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.webhooks!.of(botId)[0])).state).toBe('on'));
			await command(owner, 'remove', '/webhook remove');
			expect(await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.webhooks!.of(botId))).toEqual([]);
			expect((await command(owner, 'none', '/webhook')).notice!.params.body.text).toMatch(/has no webhook/);
			expect((await command(owner, 'bad', '/webhook bogus')).frame.error).toBeDefined();
		} finally { owner.close(); }
	});
});
