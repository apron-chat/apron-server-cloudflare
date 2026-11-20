import { afterEach, describe, expect, it, vi } from 'vitest';
import { addServerToLinks, LinkConnection, remoteReason, rewriteMentions } from '../src/remote-client';
import { requestId, wakeUrlAllowed } from '../src/mirror';
import { sameAddress } from '../src/remote';

// The text mapping a mirror applies both ways, and the wake push policy (extension `ext:remote`).

describe('text', () => {
	it('rewrites mentions by A.3 rules, outside code', () => {
		const ids = new Map([['ada', 'ada@a.example']]);
		expect(rewriteMentions('@ada, @ada. x@ada `@ada` ```\n@ada\n``` @adam', ids)).toBe('@ada@a.example, @ada@a.example. x@ada `@ada` ```\n@ada\n``` @adam');
		// Plain text has no code: a backtick is a character.
		expect(rewriteMentions('`@ada`', ids, false)).toBe('`@ada@a.example`');
		// Code closes only at a run of as many backticks.
		expect(rewriteMentions('``a```b`@ada`', ids)).toBe('``a```b`@ada`');
	});

	it('gives links without server the owner\'s', () => {
		expect(addServerToLinks('see apron:?room=ops&message=1 and https://link.apron.chat/#room=x and apron:?server=ws://b/ws&room=y', 'ws://a.example/ws'))
			.toBe('see apron:?server=ws://a.example/ws&room=ops&message=1 and https://link.apron.chat/#server=ws://a.example/ws&room=x and apron:?server=ws://b/ws&room=y');
		// Code spans and fenced code stay as they are in Markdown, as for mentions; plain text has none.
		expect(addServerToLinks('apron:?room=a `apron:?room=b` ```\napron:?room=c\n``` ``x`apron:?room=d`` apron:?room=e', 'ws://a.example/ws'))
			.toBe('apron:?server=ws://a.example/ws&room=a `apron:?room=b` ```\napron:?room=c\n``` ``x`apron:?room=d`` apron:?server=ws://a.example/ws&room=e');
		expect(addServerToLinks('`apron:?room=b`', 'ws://a.example/ws', false)).toBe('`apron:?server=ws://a.example/ws&room=b`');
		// The value is form-encoded, with `:` and `/` left as they are.
		expect(addServerToLinks('apron:?room=a', 'wss://a.example:8443/ws path?x=1&y')).toBe('apron:?server=wss://a.example:8443/ws+path%3Fx%3D1%26y&room=a');
		expect(addServerToLinks('apron:?', 'ws://a.example/ws')).toBe('apron:?server=ws://a.example/ws');
		// A link ends at a quote or a closing bracket, as in Markdown and HTML.
		expect(addServerToLinks('[x](apron:?room=a) "apron:?room=b"', 'ws://a.example/ws', false)).toBe('[x](apron:?server=ws://a.example/ws&room=a) "apron:?server=ws://a.example/ws&room=b"');
	});

	it('reads the reason of a link\'s refusal', () => {
		expect(remoteReason({ code: -32001, data: { ext: { remote: 'not_joined' } } })).toBe('not_joined');
		expect(remoteReason({ code: -32001, data: { ext: { remote: 'removed' } } })).toBe('removed');
		expect(remoteReason({ code: -32001, message: 'no' })).toBeUndefined();
	});
});

describe('request ids', () => {
	it('stay within 128 bytes, the same for the same request', async () => {
		expect(await requestId('bob:c19')).toBe('bob:c19');
		const long = `${'b'.repeat(100)}:${'c'.repeat(100)}`;
		const hashed = await requestId(long);
		expect(hashed).toMatch(/^h:[0-9a-f]{64}$/);
		expect(await requestId(long)).toBe(hashed);
		expect(await requestId(`${long}x`)).not.toBe(hashed);
		expect(await requestId('é'.repeat(64))).toBe('é'.repeat(64));
		expect(await requestId('é'.repeat(65))).toMatch(/^h:/);
	});
});

describe('addresses', () => {
	it('compare after lowercasing scheme and host, keeping port and path', () => {
		expect(sameAddress('WSS://Chat.Example/ws', 'wss://chat.example/ws')).toBe(true);
		expect(sameAddress('ws://127.0.0.1:8788/ws', 'ws://127.0.0.1:8788/ws')).toBe(true);
		expect(sameAddress('wss://chat.example/WS', 'wss://chat.example/ws')).toBe(false);
		expect(sameAddress('wss://chat.example:443/ws', 'wss://chat.example/ws')).toBe(false);
		expect(sameAddress(undefined, 'wss://chat.example/ws')).toBe(false);
		expect(sameAddress('chat.example', 'chat.example')).toBe(false);
	});
});

describe('wake pushes', () => {
	it('go to https, or to http on a loopback host', () => {
		expect(wakeUrlAllowed('https://mirror.example/remote/wake/x')).toBe(true);
		expect(wakeUrlAllowed('http://127.0.0.1:8788/remote/wake/x')).toBe(true);
		expect(wakeUrlAllowed('http://localhost:8788/remote/wake/x')).toBe(true);
		expect(wakeUrlAllowed('http://mirror.example/remote/wake/x')).toBe(false);
		expect(wakeUrlAllowed('https://user:pass@mirror.example/x')).toBe(false);
		expect(wakeUrlAllowed('ftp://mirror.example/x')).toBe(false);
	});
});

describe('a link connection', () => {
	afterEach(() => { vi.restoreAllMocks(); });

	it('paces its requests: at most 4 awaiting answers, and 10 frames a second', async () => {
		// A stand-in owner on the other end of a WebSocketPair: it greets, signs the link in, and holds every other request.
		const pair = new WebSocketPair();
		const owner = pair[1];
		owner.accept();
		const held: Array<{ id: string; at: number }> = [];
		owner.addEventListener('message', (event) => {
			const frame = JSON.parse(String(event.data)) as { id: string; method: string };
			if (frame.method === 'auth') owner.send(JSON.stringify({ id: frame.id, result: { you: { user_id: 'link_1' } } }));
			else held.push({ id: frame.id, at: Date.now() });
		});
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			setTimeout(() => owner.send(JSON.stringify({ method: 'server', params: { apron: 10 } })), 0);
			return new Response(null, { status: 101, webSocket: pair[0] });
		});
		const connection = await LinkConnection.open('ws://owner.example/ws', 'token');
		const answers = Array.from({ length: 6 }, (_, n) => connection.call('me', {}, `r${n}`));
		await new Promise((resolve) => setTimeout(resolve, 600));
		// Four went, a turn apart; the other two wait for answers.
		expect(held.map((request) => request.id)).toEqual(['r0', 'r1', 'r2', 'r3']);
		for (let n = 1; n < held.length; n += 1) expect(held[n].at - held[n - 1].at).toBeGreaterThanOrEqual(90);
		for (const request of held.splice(0, 2)) owner.send(JSON.stringify({ id: request.id, result: {} }));
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(held.map((request) => request.id)).toEqual(['r2', 'r3', 'r4', 'r5']);
		for (const request of held.splice(0)) owner.send(JSON.stringify({ id: request.id, result: {} }));
		expect((await Promise.all(answers)).every((answer) => answer.result !== undefined)).toBe(true);
		connection.close();
	});
});

describe('a link connection that closes while signing in', () => {
	afterEach(() => { vi.restoreAllMocks(); });

	it('fails the open at once with the reason, and tells onClose once', async () => {
		const pair = new WebSocketPair();
		const owner = pair[1];
		owner.accept();
		owner.addEventListener('message', (event) => {
			const frame = JSON.parse(String(event.data)) as { method: string };
			// The owner goes away instead of answering the sign-in.
			if (frame.method === 'auth') owner.close(1001, 'going away');
		});
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			setTimeout(() => owner.send(JSON.stringify({ method: 'server', params: { apron: 10 } })), 0);
			return new Response(null, { status: 101, webSocket: pair[0] });
		});
		const started = Date.now();
		const closes: string[] = [];
		await expect(LinkConnection.open('ws://owner.example/ws', 'token', { onClose: () => closes.push('closed') })).rejects.toThrow(/sign-in failed: connection (closed|failed)/);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(closes).toEqual(['closed']);
	});
});
