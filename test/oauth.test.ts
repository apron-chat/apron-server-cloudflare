import { describe, expect, it } from 'vitest';
import { originOfEndpoint } from '../src/oauth';

describe("the server's origin from its WebSocket address (§4.12.1)", () => {
	it('is https:// with the host and port for wss://', () => {
		expect(originOfEndpoint('wss://chat.example/ws')).toBe('https://chat.example');
		expect(originOfEndpoint('wss://chat.example:8443/apron/ws')).toBe('https://chat.example:8443');
		expect(originOfEndpoint('wss://localhost:8787/')).toBe('https://localhost:8787');
	});

	it('is http:// for ws:// on a loopback host', () => {
		expect(originOfEndpoint('ws://localhost:8787/')).toBe('http://localhost:8787');
		expect(originOfEndpoint('ws://app.localhost:8787/')).toBe('http://app.localhost:8787');
		expect(originOfEndpoint('ws://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
		expect(originOfEndpoint('ws://127.0.0.2/ws')).toBe('http://127.0.0.2');
		expect(originOfEndpoint('ws://[::1]:8787/')).toBe('http://[::1]:8787');
	});

	it('is https:// for ws:// on any other host', () => {
		expect(originOfEndpoint('ws://chat.example/ws')).toBe('https://chat.example');
		expect(originOfEndpoint('ws://chat.example:8080/')).toBe('https://chat.example:8080');
		expect(originOfEndpoint('ws://localhost.chat.example/')).toBe('https://localhost.chat.example');
		expect(originOfEndpoint('ws://127.0.0.1.chat.example/')).toBe('https://127.0.0.1.chat.example');
		expect(originOfEndpoint('ws://10.0.0.5:8787/')).toBe('https://10.0.0.5:8787');
		expect(originOfEndpoint('ws://[::2]/')).toBe('https://[::2]');
	});

	it('is undefined for anything else', () => {
		expect(originOfEndpoint(undefined)).toBeUndefined();
		expect(originOfEndpoint('')).toBeUndefined();
		expect(originOfEndpoint('https://chat.example/ws')).toBeUndefined();
		expect(originOfEndpoint('not a url')).toBeUndefined();
	});
});
