import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { Store } from '../src/store';
import { connect, exchange, request } from './helpers/socket';

const stub = () => env.DEMO.getByName('public-demo-v1');
type Runtime = { store: Store; config: Record<string, unknown>; issueSession(userId: string, origin: string, now: number): Promise<string>; alarmTail: Promise<void> };
const runtime = <T>(fn: (server: Runtime, state: DurableObjectState) => T | Promise<T>) =>
	runInDurableObject(stub(), (instance, state) => fn(instance as unknown as Runtime, state));

it('schedules the alarm when a connection starts holding read cursors, from its frames alone', async () => {
	const userId = `reader_${crypto.randomUUID().slice(0, 8)}`;
	// Read cursors travel in `activity` frames, which vitest.config.ts turns off.
	await runtime((server) => { server.config = { ...server.config, activityEnabled: true }; });
	const token = await runtime((server) => {
		server.store.registerIdentity({
			userId, name: 'Reader', userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
		return server.issueSession(userId, 'http://localhost:5173', Date.now());
	});
	const peer = await connect({ ip: '198.18.7.9' });
	try {
		await peer.next();
		expect((await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
		const one = (await request(peer, 'one', 'message', { room_id: 'general', body: { text: 'one' } })).result.message_id;
		const two = (await request(peer, 'two', 'message', { room_id: 'general', body: { text: 'two' } })).result.message_id;
		// The alarm is known and an hour away, so only a new deadline moves it.
		await runtime(async (server, state) => {
			await server.alarmTail;
			const at = Date.now() + 3_600_000;
			await state.storage.setAlarm(at);
			Object.assign(server.store, { scheduledAlarmAt: at });
			Object.assign(server, { alarmKnown: true });
		});
		// The first cursor is written; the second, within the minute, is held.
		peer.send({ method: 'activity', params: { room_id: 'general', read_message_id: one } });
		await exchange(peer, 'after-one', 'me', {});
		peer.send({ method: 'activity', params: { room_id: 'general', read_message_id: two } });
		await exchange(peer, 'after-two', 'me', {});
		const held = await runtime(async (server, state) => {
			await server.alarmTail;
			const attachment = state.getWebSockets().map((ws) => ws.deserializeAttachment() as { userId?: string; reads?: Record<string, string>; readsAt?: number })
				.find((candidate) => candidate.userId === userId)!;
			return { reads: attachment.reads, due: attachment.readsAt! + 60_000, alarm: await state.storage.getAlarm() };
		});
		expect(held.reads).toEqual({ general: two });
		expect(held.alarm).not.toBeNull();
		expect(held.alarm!).toBeLessThanOrEqual(held.due);
	} finally {
		peer.close();
		await runtime((server) => { server.config = { ...server.config, activityEnabled: false }; });
	}
});
