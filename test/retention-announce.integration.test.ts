import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { connect } from './helpers/socket';

it('tells members of expired thread rooms they left, even when the room listing fails', async () => {
	const peer = await connect({ ip: '192.0.2.77' });
	try {
		expect((await peer.next()).method).toBe('server');
		peer.send({ id: 'auth', method: 'auth', params: { scheme: 'guest' } });
		expect((await peer.next()).id).toBe('auth');
		peer.send({ id: 'thread', method: 'room_set', params: { parent_room_id: 'general', title: 'Short-lived' } });
		const joined = await peer.next();
		expect(joined.method).toBe('room_update');
		const roomId = joined.params.joined[0].room_id;
		expect((await peer.next()).result.room_id).toBe(roomId);

		await runInDurableObject(env.DEMO.getByName('public-demo-v1'), async (instance, state) => {
			// Age every record past retention and make cleanup due now.
			state.storage.sql.exec('UPDATE records SET commit_ms = 0');
			state.storage.sql.exec('UPDATE maintenance SET next_cleanup_ms = 0, cleanup_cursor = NULL, cleanup_cutoff_ms = NULL WHERE id = 1');
			// Simulate an exhausted budget for the re-announcement listing.
			const runtime = instance as unknown as { store: { listRooms: () => unknown }; alarm(): Promise<void> };
			const listRooms = runtime.store.listRooms;
			runtime.store.listRooms = () => { throw new Error('listing unavailable'); };
			try { await runtime.alarm(); } finally { runtime.store.listRooms = listRooms; }
		});
		expect(await peer.next()).toEqual({ method: 'room_update', params: { left: [{ room_id: roomId }] } });
		// The member no longer receives the room's deliveries, and it is gone.
		peer.send({ id: 'join', method: 'room_join', params: { room_id: roomId } });
		expect((await peer.next()).error.code).toBe(-32602);
	} finally { peer.close(); }
});
