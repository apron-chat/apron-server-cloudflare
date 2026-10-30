import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../src/store';
import { connect as open, exchange, request, until, type Frame, type Peer } from './helpers/socket';

// vitest.config.ts sets LIVE_TEXT_MAX_SECONDS 2, LIVE_TEXT_MODERATOR_MAX_SECONDS 3
// and LIVE_TEXT_WRITE_WINDOW_SECONDS 3, so texts end within the tests.
const ORDINARY_MS = 2_000;
const MODERATOR_MS = 3_000;
const WINDOW_MS = 3_000;
const ADMIN_TOKEN = 'admin-token-0123456789abcdef';
const stub = () => env.DEMO.getByName('public-demo-v1');
const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const encode = (text: string) => new TextEncoder().encode(text);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let nextIp = 1;
const ip = () => `198.51.100.${nextIp++ % 250 + 1}`;
const connect = () => open({ ip: `203.0.113.${nextIp++ % 250 + 1}` });

async function setConfig(change: Record<string, unknown>): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as { config: Record<string, unknown> };
		server.config = { ...server.config, ...change };
	});
}

/** A registered user, signed in on a new connection, with `roles`. */
async function signedIn(userId: string, roles: string[] = []): Promise<Peer> {
	const token = await runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as { store: Store; issueSession(userId: string, origin: string, now: number): Promise<string> };
		runtime.store.registerIdentity({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
		for (const role of roles) runtime.store.setRole({ userId, role, now: Date.now() });
		return runtime.issueSession(userId, 'http://localhost:5173', Date.now());
	});
	const peer = await connect();
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
	return peer;
}

/** A streaming `PUT` to a write URL: write chunks with `send`, end it with `end`, and await `response`. */
function streamTo(url: string) {
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	// The server cancels the body when it ends the text early.
	writer.closed.catch(() => undefined);
	writer.ready.catch(() => undefined);
	const response = SELF.fetch(url, { method: 'PUT', body: readable, headers: { 'CF-Connecting-IP': ip() }, duplex: 'half' } as RequestInit);
	return {
		response,
		send: (text: string) => writer.write(encode(text)).catch(() => undefined),
		end: () => writer.close().catch(() => undefined),
	};
}

/** A reader of a live url: what it got so far, and a wait for text in it. */
async function readerOf(url: string) {
	const response = await SELF.fetch(url, { headers: { 'CF-Connecting-IP': ip() } });
	const decoder = new TextDecoder();
	let text = '';
	let done = false;
	const reader = response.body?.getReader();
	const pump = (async () => {
		if (!reader) return;
		for (;;) {
			const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
			if (chunk.done) break;
			text += decoder.decode(chunk.value, { stream: true });
		}
		done = true;
	})();
	return {
		response,
		text: () => text,
		done: () => done,
		ended: () => pump,
		async waitFor(part: string): Promise<void> {
			for (let tries = 0; tries < 200 && !text.includes(part); tries++) await sleep(10);
			expect(text).toContain(part);
		},
		cancel: () => reader?.cancel().catch(() => undefined),
	};
}

const command = (peer: Peer, id: string, text: string, extra: Record<string, unknown> = {}) =>
	exchange(peer, id, 'command', { room_id: 'general', body: { text }, ...extra });
const isMessage = (messageId: string) => (frame: Frame) => frame.method === 'message' && frame.params.message_id === messageId;
const fromUser = (userId: string) => (frame: Frame) => frame.method === 'message' && frame.params.from?.user_id === userId;

describe('live text end to end', () => {
	beforeEach(() => setConfig({ adminToken: ADMIN_TOKEN }));
	afterEach(() => setConfig({ adminToken: undefined, guestPosting: true }));

	it('advertises embed:terminal and embed:append, and /toggle livetext turns them off and on', async () => {
		const admin = await connect();
		try {
			const server = await admin.next();
			expect(server.params.apron).toBe(10);
			expect(server.params.capabilities).toEqual(expect.arrayContaining(['embed:terminal', 'embed:append']));
			expect(server.params.capabilities).not.toContain('embed:stream');
			expect((await request(admin, 'auth', 'auth', { scheme: 'token', token: ADMIN_TOKEN })).result.you.user_id).toBe('admin');
			const off = await command(admin, 'off', '/toggle livetext');
			expect(off.frame.result).toEqual({});
			expect(off.skipped.find(fromUser('~private'))!.params.body.text).toContain('Live text is now **off**');
			const later = await connect();
			try {
				expect((await later.next()).params.capabilities).not.toContain('embed:terminal');
			} finally { later.close(); }
			expect((await command(admin, 'refused', '/embed-terminal')).frame.error).toMatchObject({ code: -32602, message: 'Unknown command /embed-terminal; try /help' });
			expect((await request(admin, 'post', 'message', { body: { embeds: [{ kind: 'terminal' }] } })).error).toMatchObject({ code: -32001, message: 'Live text is turned off here' });
			expect((await command(admin, 'on', '/toggle livetext')).frame.result).toEqual({});
		} finally { admin.close(); }
	});

	it('streams /embed-terminal: a private notice with the link, the message when the PUT arrives, readers live, then the output', async () => {
		const userId = unique('builder');
		const writer = await signedIn(userId, ['mod']);
		const watcher = await signedIn(unique('watcher'));
		try {
			const { frame, skipped } = await command(writer, 'term', '/embed-terminal make test');
			const [result] = frame.result.embeds;
			expect(result).toEqual({ embed_id: expect.any(String), kind: 'terminal', write_url: expect.stringMatching(/^https:\/\/demo\.test\/w\/l\./) });
			const notice = skipped.find(fromUser('~private'))!;
			expect(notice.params).toMatchObject({ room_id: 'general', body: { format: 'markdown' } });
			expect(notice.params.body.text).toContain('Stream a terminal into this room within 3 seconds (80×40, up to 3 seconds and 2 MB; the last 32 KB is kept)');
			expect(notice.params.body.text).toContain(`script -qfc 'stty cols 80 rows 40; YOUR_COMMAND' /dev/null | curl -sT - '${result.write_url}'`);
			// Nothing is posted before the write arrives.
			expect(skipped.some(fromUser(userId))).toBe(false);

			const put = streamTo(result.write_url);
			await put.send('\x1b[32mok\x1b[0m 1\r\n');
			const posted = (await until(watcher, fromUser(userId))).frame.params;
			expect(posted.body).toEqual({ text: '', format: 'plain', embeds: [{ embed_id: result.embed_id, kind: 'terminal', title: 'make test', url: expect.stringMatching(/^https:\/\/demo\.test\/live\/[A-Za-z0-9_-]{22}$/) }] });
			const url = posted.body.embeds[0].url;
			const reader = await readerOf(url);
			expect(reader.response.status).toBe(200);
			expect(reader.response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
			expect(reader.response.headers.get('X-Content-Type-Options')).toBe('nosniff');
			// No compression: it would buffer the stream until the end.
			expect(reader.response.headers.get('Cache-Control')).toContain('no-transform');
			expect(reader.response.headers.get('Access-Control-Allow-Origin')).toBe('*');
			// The kept text first, then each chunk as it arrives.
			await reader.waitFor('ok\x1b[0m 1\r\n');
			await put.send('\x1b[31mfail\x1b[0m 2\r\n');
			await reader.waitFor('fail');
			await put.end();
			const response = await put.response;
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('Done: the text is posted.\n');
			await reader.ended();
			expect(reader.text()).toBe('\x1b[32mok\x1b[0m 1\r\n\x1b[31mfail\x1b[0m 2\r\n');
			// The finished snapshot carries the output, without url.
			const finished = (await until(watcher, isMessage(posted.message_id))).frame.params;
			expect(finished.body.embeds).toEqual([{ embed_id: result.embed_id, kind: 'terminal', title: 'make test', output: '\x1b[32mok\x1b[0m 1\r\n\x1b[31mfail\x1b[0m 2\r\n' }]);
			expect(finished.prev_log_id).toBe(posted.log_id);
			// The url and the write_url end with the text.
			expect((await SELF.fetch(url, { headers: { 'CF-Connecting-IP': ip() } })).status).toBe(404);
			const again = await SELF.fetch(result.write_url, { method: 'PUT', body: 'again', headers: { 'CF-Connecting-IP': ip() } });
			expect(again.status).toBe(409);
		} finally { writer.close(); watcher.close(); }
	});

	it('streams /embed-append into a markdown message that replies where the command did, then merges it', async () => {
		const userId = unique('llm');
		const writer = await signedIn(userId, ['admin']);
		try {
			const question = (await request(writer, 'q', 'message', { body: { text: 'What now?' } })).result.message_id;
			// The opening, trailing whitespace trimmed, ends in a paragraph break.
			const { frame, skipped } = await command(writer, 'append', '/embed-append **Plan:** ', { reply_to: { message_id: question } });
			const [result] = frame.result.embeds;
			expect(result.kind).toBe('append');
			expect(skipped.find(fromUser('~private'))!.params.body.text).toContain(`your-llm-command | curl -sT - '${result.write_url}'`);
			const put = streamTo(result.write_url);
			await put.send('1. Roll ');
			const posted = (await until(writer, fromUser(userId))).frame.params;
			expect(posted).toMatchObject({ reply_to: { message_id: question }, body: { text: '**Plan:**\n\n', format: 'markdown', embeds: [{ embed_id: result.embed_id, kind: 'append', url: expect.any(String) }] } });
			const reader = await readerOf(posted.body.embeds[0].url);
			await reader.waitFor('1. Roll ');
			await put.send('back.\n2. Renew the *cert*.\n');
			await put.end();
			expect((await put.response).status).toBe(200);
			const merged = (await until(writer, isMessage(posted.message_id))).frame.params;
			expect(merged.body).toEqual({ text: '**Plan:**\n\n1. Roll back.\n2. Renew the *cert*.\n', format: 'markdown' });
			expect(reader.text()).toBe('1. Roll back.\n2. Renew the *cert*.\n');
		} finally { writer.close(); }
	});

	it('starts an /embed-append without an opening with empty text, and keeps a message\'s text exactly as sent', async () => {
		const userId = unique('bare');
		const writer = await signedIn(userId, ['mod']);
		try {
			const { frame } = await command(writer, 'bare', '/embed-append');
			const put = streamTo(frame.result.embeds[0].write_url);
			await put.send('Hello');
			const posted = (await until(writer, fromUser(userId))).frame.params;
			expect(posted.body).toMatchObject({ text: '', format: 'markdown' });
			await put.end();
			await put.response;
			expect((await until(writer, isMessage(posted.message_id))).frame.params.body).toEqual({ text: 'Hello', format: 'markdown' });
			// The message flow adds nothing to the text it is sent.
			const { frame: sent, skipped } = await exchange(writer, 'msg', 'message', { body: { text: 'logs:', format: 'markdown', embeds: [{ kind: 'append' }] } });
			expect(skipped.find(isMessage(sent.result.message_id))!.params.body.text).toBe('logs:');
			const rest = streamTo(sent.result.embeds[0].write_url);
			await rest.send('ok');
			await rest.end();
			await rest.response;
			expect((await until(writer, (f) => isMessage(sent.result.message_id)(f) && f.params.prev_log_id !== undefined)).frame.params.body.text).toBe('logs:ok');
		} finally { writer.close(); }
	});

	it('takes a new terminal or append embed in a message (§4.8.3), with readers waiting for its write', async () => {
		const userId = unique('poster');
		const writer = await signedIn(userId, ['mod']);
		try {
			const { frame, skipped } = await exchange(writer, 'post', 'message', { body: { text: 'Build:', embeds: [{ kind: 'terminal', title: 'ci' }] } });
			const posted = skipped.find(isMessage(frame.result.message_id))!.params;
			const url = posted.body.embeds[0].url;
			expect(frame.result.embeds).toEqual([{ embed_id: posted.body.embeds[0].embed_id, kind: 'terminal', write_url: expect.stringMatching(/\/w\/l\./) }]);
			// A reader before the write waits for it.
			const early = await readerOf(url);
			expect(early.response.status).toBe(200);
			await sleep(50);
			expect(early.done()).toBe(false);
			const put = streamTo(frame.result.embeds[0].write_url);
			await put.send('step 1\n');
			await early.waitFor('step 1\n');
			await put.end();
			await put.response;
			await early.ended();
			const finished = (await until(writer, isMessage(frame.result.message_id))).frame.params;
			expect(finished.body).toEqual({ text: 'Build:', format: 'plain', embeds: [{ embed_id: posted.body.embeds[0].embed_id, kind: 'terminal', title: 'ci', output: 'step 1\n' }] });
			// A terminal or append in any other command is invalid_params.
			expect((await command(writer, 'avatar', '/avatar', { body: { text: '/avatar', embeds: [{ kind: 'append' }] } })).frame.error).toBeTruthy();
			expect((await request(writer, 'help-embed', 'command', { room_id: 'general', body: { text: '/help', embeds: [{ kind: 'terminal' }] } })).error).toMatchObject({ code: -32602 });
		} finally { writer.close(); }
	});

	it('ends a text at the owner\'s time limit: 2 seconds here for others, 3 for admins and mods', async () => {
		for (const [roles, limit] of [[[], ORDINARY_MS], [['mod'], MODERATOR_MS]] as const) {
			const peer = await signedIn(unique('slow'), [...roles]);
			try {
				const { frame } = await command(peer, 'slow', '/embed-terminal');
				const put = streamTo(frame.result.embeds[0].write_url);
				const started = Date.now();
				await put.send('waiting forever\n');
				const response = await put.response;
				const elapsed = Date.now() - started;
				expect(elapsed).toBeGreaterThanOrEqual(limit - 100);
				expect(elapsed).toBeLessThan(limit + 1_500);
				expect(await response.text()).toBe(`Stopped at the ${limit / 1_000}-second limit; what was kept is posted.\n`);
				const finished = (await until(peer, (f) => f.method === 'message' && f.params.body?.embeds?.[0]?.output !== undefined)).frame.params;
				expect(finished.body.embeds[0].output).toBe('waiting forever\n');
				await put.end();
			} finally { peer.close(); }
		}
	}, 15_000);

	it('allows one live text at a time per user, pending writes included, and expires unused writes', async () => {
		const userId = unique('eager');
		const peer = await signedIn(userId);
		try {
			const first = await command(peer, 'first', '/embed-terminal');
			expect(first.frame.result.embeds).toHaveLength(1);
			const second = await command(peer, 'second', '/embed-append hi');
			expect(second.frame.error).toEqual({ code: -32001, message: 'You already have a live text open; finish it, or let its write_url expire, before you start another' });
			expect((await request(peer, 'third', 'message', { body: { embeds: [{ kind: 'append' }] } })).error.code).toBe(-32001);
			// Past the window the link is refused before it reaches the object, and the user may start again.
			// (A token's expiry is rounded up to the second.)
			await sleep(WINDOW_MS + 1_100);
			expect((await SELF.fetch(first.frame.result.embeds[0].write_url, { method: 'PUT', body: 'late', headers: { 'CF-Connecting-IP': ip() } })).status).toBe(403);
			const again = await command(peer, 'again', '/embed-append hi');
			expect(again.frame.result.embeds[0].kind).toBe('append');
			// A message's write that never comes: the alarm publishes it without the embed.
			const done = streamTo(again.frame.result.embeds[0].write_url);
			await done.end();
			await done.response;
			const post = await exchange(peer, 'post', 'message', { body: { text: 'waiting', embeds: [{ kind: 'append' }] } });
			await sleep(WINDOW_MS + 300);
			await runDurableObjectAlarm(stub());
			const expired = (await until(peer, (f) => isMessage(post.frame.result.message_id)(f) && f.params.prev_log_id !== undefined)).frame.params;
			expect(expired.body).toEqual({ text: 'waiting', format: 'plain' });
		} finally { peer.close(); }
	}, 15_000);

	it('limits how often a user starts live text, and readers of one text', async () => {
		const userId = unique('spam');
		const peer = await signedIn(userId, ['mod']);
		try {
			let url = '';
			for (let index = 0; index < 3; index++) {
				const { frame } = await command(peer, `start-${index}`, '/embed-terminal');
				const put = streamTo(frame.result.embeds[0].write_url);
				if (index < 2) {
					await put.end();
					await put.response;
					continue;
				}
				await put.send('x');
				url = (await until(peer, fromUser(userId))).frame.params.body.embeds[0].url;
				// Ten readers at once; the eleventh is refused.
				const readers = await Promise.all(Array.from({ length: 10 }, () => readerOf(url)));
				for (const reader of readers) expect(reader.response.status).toBe(200);
				const extra = await SELF.fetch(url, { headers: { 'CF-Connecting-IP': ip() } });
				expect(extra.status).toBe(429);
				expect(extra.headers.get('Retry-After')).toBe('10');
				await put.end();
				await put.response;
				for (const reader of readers) await reader.ended();
			}
			const refused = await command(peer, 'start-3', '/embed-terminal');
			expect(refused.frame.error).toMatchObject({ code: -32002, message: 'Live text limit reached', data: { retry_after: expect.any(Number) } });
			expect(refused.frame.error.data.ext).toBeUndefined();
		} finally { peer.close(); }
	});

	it('refuses guests where guests only read, and lists the commands only to those who may use them', async () => {
		await setConfig({ guestPosting: false });
		const guest = await connect();
		try {
			await guest.next();
			await request(guest, 'auth', 'auth', { scheme: 'guest' });
			expect((await command(guest, 'term', '/embed-terminal')).frame.error).toMatchObject({ code: -32001, message: 'Guests can only read here; sign in with a passkey to post or join rooms' });
			const help = await command(guest, 'help', '/help');
			expect(help.skipped.find(fromUser('~private'))!.params.body.text).not.toContain('/embed-');
		} finally { guest.close(); }
	});

	it('reads only a known url, and only with GET or HEAD', async () => {
		expect((await SELF.fetch('https://demo.test/live/AAAAAAAAAAAAAAAAAAAAAA', { headers: { 'CF-Connecting-IP': ip() } })).status).toBe(404);
		expect((await SELF.fetch('https://demo.test/live/not-an-id', { headers: { 'CF-Connecting-IP': ip() } })).status).toBe(404);
		expect((await SELF.fetch('https://demo.test/live/AAAAAAAAAAAAAAAAAAAAAA', { method: 'POST', body: 'x', headers: { 'CF-Connecting-IP': ip() } })).status).toBe(405);
		const forged = 'https://demo.test/w/l.AAAAAAAAAAAAAAAAAAAAAA.2097152.9999999999.AAAA';
		expect((await SELF.fetch(forged, { method: 'PUT', body: 'x', headers: { 'CF-Connecting-IP': ip() } })).status).toBe(403);
	});
});
