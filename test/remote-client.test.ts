import { describe, expect, it } from 'vitest';
import { addServerToLinks, remoteReason, rewriteMentions } from '../src/remote-client';
import { wakeUrlAllowed } from '../src/mirror';
import { sameAddress } from '../src/remote';

// The text mapping a mirror applies both ways, and the wake push policy (extension `ext:remote`).

describe('text', () => {
	it('rewrites mentions by A.3 rules, outside code', () => {
		const ids = new Map([['ada', 'ada@a.example']]);
		expect(rewriteMentions('@ada, @ada. x@ada `@ada` ```\n@ada\n``` @adam', ids)).toBe('@ada@a.example, @ada@a.example. x@ada `@ada` ```\n@ada\n``` @adam');
	});

	it('gives links without server the owner\'s', () => {
		expect(addServerToLinks('see apron:?room=ops&message=1 and https://link.apron.chat/#room=x and apron:?server=ws://b/ws&room=y', 'ws://a.example/ws'))
			.toBe('see apron:?server=ws://a.example/ws&room=ops&message=1 and https://link.apron.chat/#server=ws://a.example/ws&room=x and apron:?server=ws://b/ws&room=y');
	});

	it('reads the reason of a link\'s refusal', () => {
		expect(remoteReason({ code: -32001, data: { ext: { remote: 'not_joined' } } })).toBe('not_joined');
		expect(remoteReason({ code: -32001, data: { ext: { remote: 'removed' } } })).toBe('removed');
		expect(remoteReason({ code: -32001, message: 'no' })).toBeUndefined();
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
