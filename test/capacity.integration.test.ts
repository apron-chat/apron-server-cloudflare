import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/budget';
import { connect, greeting, type Peer } from './helpers/socket';

it('bounds admission at openConnections live sockets and delivers one ordered maximum fan-out', async () => {
	const peers: Peer[] = [];
	try {
		// Opened ten at a time, each from an address of its own: one at a time,
		// the hundred round trips outlast the timeout when the whole suite runs.
		const open = async (index: number) => {
			const peer = await connect({ ip: `198.51.${100 + Math.floor(index / 250)}.${index % 250}`, origin: null, host: 'capacity.test' });
			peers.push(peer);
			await greeting(peer);
			peer.send({ id: 'auth', method: 'auth', params: { scheme: 'guest' } });
			expect((await peer.next()).result.you.user_id).toBeTruthy();
		};
		for (let start = 1; start <= DEFAULT_LIMITS.openConnections; start += 10) {
			await Promise.all(Array.from({ length: Math.min(10, DEFAULT_LIMITS.openConnections - start + 1) }, (_, offset) => open(start + offset)));
		}
		const rejected = await SELF.fetch('https://capacity.test/ws', { headers: {
			Upgrade: 'websocket', 'CF-Connecting-IP': '198.51.110.1',
		} });
		expect(rejected.status).toBe(429);
		// A full server spreads its crowd's retries over two to five minutes.
		expect(rejected.headers.get('Apron-Server-Full')).toBe('1');
		const retry = Number(rejected.headers.get('Retry-After'));
		expect(retry).toBeGreaterThanOrEqual(120);
		expect(retry).toBeLessThanOrEqual(300);
		// The largest text a message may carry, to every socket the server holds.
		const text = 'x'.repeat(DEFAULT_LIMITS.maxTextBytes);
		peers[0].send({ id: 'fanout', method: 'message', params: { room_id: 'general', body: { text } } });
		// Every member gets the broadcast; the sender's comes before its result (§1).
		const frames = await Promise.all(peers.map(peer => peer.next()));
		const reply = await peers[0].next();
		expect(reply.id).toBe('fanout');
		expect(reply.result.message_id).toBeTruthy();
		for (const frame of frames) {
			expect(frame.method).toBe('message');
			expect(frame.params.body.text).toBe(text);
			expect(frame.params.message_id).toBe(reply.result.message_id);
			expect(frame.params.log_id).toBe(frames[0].params.log_id);
		}
	} finally {
		for (const peer of peers) peer.close();
	}
}, 120_000);
