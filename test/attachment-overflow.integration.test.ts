import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { type Store } from '../src/store';
import { connect, exchange, request, type Peer } from './helpers/socket';

const stub = () => env.DEMO.getByName('public-demo-v1');
const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let nextIp = 1;

/** A registered user, signed in on a new connection. */
async function signedIn(userId: string, register = true): Promise<Peer> {
	const token = await runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as { store: Store; issueSession(userId: string, origin: string, now: number): Promise<string> };
		if (register) {
			runtime.store.registerIdentity({
				userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
				credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
			});
		}
		return runtime.issueSession(userId, 'http://localhost:5173', Date.now());
	});
	const peer = await connect({ ip: `203.0.113.${nextIp++ % 250 + 1}` });
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
	return peer;
}

it('closes only the connection whose state outgrows its attachment, even inside a mutation', async () => {
	const userId = unique('grown');
	const observer = await signedIn(unique('observer'));
	const full = await signedIn(userId);
	const other = await signedIn(userId, false);
	const warn = vi.spyOn(console, 'warn');
	try {
		// One of the user's connections holds state just under the safety budget
		// (unwritten read cursors): any further growth no longer fits.
		await runInDurableObject(stub(), (_instance, state) => {
			// The user's first connection (`full`): the one opened earlier.
			const socket = state.getWebSockets().filter((ws) => {
				const attachment = ws.deserializeAttachment() as { userId?: string; closing?: boolean };
				return attachment.userId === userId && !attachment.closing;
			}).sort((a, b) => (a.deserializeAttachment() as { openedAt: number }).openedAt - (b.deserializeAttachment() as { openedAt: number }).openedAt)[0];
			const attachment = socket.deserializeAttachment() as Record<string, unknown>;
			const reads: Record<string, string> = {};
			for (let index = 0; JSON.stringify({ ...attachment, reads }).length < 11_900; index++) reads[`r${String(index).padStart(60, '0')}`] = '1';
			socket.serializeAttachment({ ...attachment, reads, readsAt: Date.now() });
		});
		// A name change writes every connection of the user, in one mutation.
		const renamed = await exchange(other, 'rename', 'me', { name: 'x'.repeat(40) });
		expect(renamed.frame.result.you.name).toBe('x'.repeat(40));
		const closes = [full, other, observer].map((peer) => peer.closed());
		for (let tries = 0; tries < 100 && !full.closed(); tries++) await sleep(10);
		expect(full.closed()).toEqual({ code: 1011, reason: 'Connection state too large; reconnect' });
		expect(warn.mock.calls.flat().some((line) => /attachment_overflow/.test(String(line)))).toBe(true);
		// Nobody else was closed: not the user's other connection, nor anyone else's.
		expect(closes.slice(1)).toEqual([undefined, undefined]);
		expect(other.closed()).toBeUndefined();
		expect(observer.closed()).toBeUndefined();
		expect((await request(observer, 'still-open', 'me', {})).result.you).toBeTruthy();
	} finally { observer.close(); full.close(); other.close(); }
});
