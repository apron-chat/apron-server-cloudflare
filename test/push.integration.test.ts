import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUSH_POLICY } from '../src/budget';
import type { PushSubscriptionRecord, Store } from '../src/store';
import { connect as open, request, until, type Frame, type Peer } from './helpers/socket';
import { withStore, type TestClock } from './helpers/store';
import { decryptPush, testBrowser, type TestBrowser } from './helpers/webpush';

let nextIp = 1;
const stub = () => env.DEMO.getByName('public-demo-v1');
const connect = () => open({ ip: `203.0.113.${nextIp++}` });
const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const POLICY = PUSH_POLICY!;

type Runtime = {
	store: Store;
	issueSession(userId: string, origin: string, now: number): Promise<string>;
	config: { activityEnabled: boolean };
};

/** Registers a passkey user straight into the store. */
async function register(userId: string): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		(instance as unknown as Runtime).store.registerIdentity({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
	});
}

/** A new connection signed in as a registered user (registered here unless `existing`). */
async function signedIn(userId: string, existing = false): Promise<Peer> {
	if (!existing) await register(userId);
	const token = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).issueSession(userId, 'http://localhost:5173', Date.now()));
	const peer = await connect();
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
	return peer;
}

/** A browser subscription for `push.example.net`, registered over `peer`. */
async function subscribe(peer: Peer, name: string): Promise<{ url: string; browser: TestBrowser }> {
	const browser = await testBrowser();
	const url = `https://push.example.net/send/${name}-${crypto.randomUUID()}`;
	const reply = await request(peer, `subscribe-${name}`, 'push_register', { kind: 'webpush', url, keys: { p256dh: browser.p256dh, auth: browser.auth } });
	expect(reply.result).toEqual({});
	return { url, browser };
}

/** Sends `away` as the notification it is, then a request, so it is applied before the caller goes on. */
async function setAway(peer: Peer, away: boolean): Promise<void> {
	peer.send({ method: 'activity', params: { away } });
	expect((await request(peer, `sync-${crypto.randomUUID()}`, 'me', {})).result.you).toBeTruthy();
}

/** Each live connection's `away`, for one user. */
function awayOf(userId: string): Promise<boolean[]> {
	return runInDurableObject(stub(), (_instance, state) => state.getWebSockets()
		.map((socket) => socket.deserializeAttachment() as { userId?: string; away?: boolean; closing?: boolean })
		.filter((attachment) => attachment.userId === userId && !attachment.closing)
		.map((attachment) => attachment.away === true));
}

function subscriptionsOf(userId: string): Promise<PushSubscriptionRecord[]> {
	return runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.pushSubscriptionsOf(userId));
}

type Push = { url: string; headers: Headers; body: Uint8Array };

/** Captures every outbound fetch the object makes, answering with `status(url)`. */
function capturePushes(status: (url: string) => number = () => 201) {
	const pushes: Push[] = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input as RequestInfo, init as RequestInit);
		const url = request.url;
		pushes.push({ url, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
		return new Response(null, { status: status(url) });
	});
	return pushes;
}

async function post(peer: Peer, id: string, params: Record<string, unknown>): Promise<Frame> {
	const reply = await request(peer, id, 'message', params);
	expect(reply.error).toBeUndefined();
	return reply;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('push over the socket', () => {
	it('advertises webpush with the VAPID public key', async () => {
		const peer = await connect();
		try {
			const server = await peer.next();
			expect(server.params.push).toEqual({ webpush: { key: env.VAPID_PUBLIC_KEY } });
		} finally { peer.close(); }
	});

	it('takes registrations from registered users only, with a public https endpoint and valid keys', async () => {
		const guest = await connect();
		try {
			await guest.next();
			await request(guest, 'auth', 'auth', { scheme: 'guest' });
			const browser = await testBrowser();
			const denied = await request(guest, 'register', 'push_register', { kind: 'webpush', url: 'https://push.example.net/x', keys: { p256dh: browser.p256dh, auth: browser.auth } });
			expect(denied.error.code).toBe(-32001);
			expect((await request(guest, 'unregister', 'push_unregister', { url: 'https://push.example.net/x' })).error.code).toBe(-32001);
		} finally { guest.close(); }

		const browser = await testBrowser();
		const keys = { p256dh: browser.p256dh, auth: browser.auth };
		const offCurve = (() => {
			const bytes = Uint8Array.from(atob(browser.p256dh.replaceAll('-', '+').replaceAll('_', '/') + '='), (c) => c.charCodeAt(0));
			bytes[64] ^= 1;
			return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
		})();
		const cases: Array<[string, Record<string, unknown>]> = [
			['an unknown kind', { kind: 'relay', url: 'https://push.example.net/x', token: 't' }],
			['plain http', { kind: 'webpush', url: 'http://push.example.net/x', keys }],
			['an IPv4 literal', { kind: 'webpush', url: 'https://10.0.0.1/x', keys }],
			['an IPv4 spelled as a number', { kind: 'webpush', url: 'https://2130706433/x', keys }],
			['an IPv6 literal', { kind: 'webpush', url: 'https://[::1]/x', keys }],
			['localhost', { kind: 'webpush', url: 'https://push.localhost/x', keys }],
			['a single-label host', { kind: 'webpush', url: 'https://metadata/x', keys }],
			['an internal suffix', { kind: 'webpush', url: 'https://push.corp.internal/x', keys }],
			['a port', { kind: 'webpush', url: 'https://push.example.net:8443/x', keys }],
			['credentials', { kind: 'webpush', url: 'https://user:pw@push.example.net/x', keys }],
			['a long url', { kind: 'webpush', url: `https://push.example.net/${'x'.repeat(1024)}`, keys }],
			['no keys', { kind: 'webpush', url: 'https://push.example.net/x' }],
			['a short p256dh', { kind: 'webpush', url: 'https://push.example.net/x', keys: { ...keys, p256dh: keys.p256dh.slice(0, 40) } }],
			['a p256dh off the curve', { kind: 'webpush', url: 'https://push.example.net/x', keys: { ...keys, p256dh: offCurve } }],
			['a long auth', { kind: 'webpush', url: 'https://push.example.net/x', keys: { ...keys, auth: `${keys.auth}AAAA` } }],
			['a non-base64url auth', { kind: 'webpush', url: 'https://push.example.net/x', keys: { ...keys, auth: 'a+b/c'.repeat(4) } }],
		];
		// Two bad requests per connection, below the repeated-violation close.
		for (let index = 0; index < cases.length; index += 2) {
			const peer = await signedIn(unique('vera'));
			try {
				for (const [label, params] of cases.slice(index, index + 2)) {
					const reply = await request(peer, `bad-${index}`, 'push_register', params);
					expect(reply.error?.code, label).toBe(-32602);
				}
			} finally { peer.close(); }
		}

		const userId = unique('rosa');
		const peer = await signedIn(userId);
		try {
			const { url } = await subscribe(peer, 'rosa');
			expect((await subscriptionsOf(userId)).map((row) => row.url)).toEqual([url]);
			// Unregistering removes it; an unknown url is already gone.
			expect((await request(peer, 'unregister', 'push_unregister', { url })).result).toEqual({});
			expect((await request(peer, 'unregister-again', 'push_unregister', { url })).result).toEqual({});
			expect(await subscriptionsOf(userId)).toEqual([]);
		} finally { peer.close(); }
	});

	it('tracks away per connection: away ends with away false, a read cursor, typing, or a message', async () => {
		const userId = unique('aldo');
		const peer = await signedIn(userId);
		const other = await signedIn(userId, true);
		try {
			expect(await awayOf(userId)).toEqual([false, false]);
			// Activity is off in these tests; a push server still notes away from a notification.
			await setAway(peer, true);
			expect((await awayOf(userId)).sort()).toEqual([false, true]);
			// A request is still unsupported with activity off, and changes nothing.
			expect((await request(peer, 'activity-request', 'activity', { away: false })).error.code).toBe(-32601);
			expect((await awayOf(userId)).sort()).toEqual([false, true]);
			// A history page does not end it; a message does.
			await request(peer, 'history', 'history', { room_id: 'general' });
			expect((await awayOf(userId)).sort()).toEqual([false, true]);
			await post(peer, 'back', { body: { text: 'back' } });
			expect(await awayOf(userId)).toEqual([false, false]);
			await setAway(peer, true);
			await setAway(peer, false);
			expect(await awayOf(userId)).toEqual([false, false]);
			for (const ending of [{ read_message_id: '1' }, { room_id: 'general', typing: 0 }]) {
				await setAway(peer, true);
				peer.send({ method: 'activity', params: ending });
				await request(peer, `sync-${JSON.stringify(ending)}`, 'me', {});
				expect(await awayOf(userId), JSON.stringify(ending)).toEqual([false, false]);
			}
			// An explicit away wins over typing in the same update.
			peer.send({ method: 'activity', params: { away: true, typing: 3 } });
			await request(peer, 'sync-both', 'me', {});
			expect((await awayOf(userId)).sort()).toEqual([false, true]);
		} finally { peer.close(); other.close(); }
	});

	it('tracks away with activity on too, where typing ends it and is still relayed', async () => {
		await runInDurableObject(stub(), (instance) => { (instance as unknown as Runtime).config.activityEnabled = true; });
		const userId = unique('anya');
		const peer = await signedIn(userId);
		try {
			expect((await request(peer, 'away', 'activity', { away: true })).result).toEqual({});
			expect(await awayOf(userId)).toEqual([true]);
			expect((await request(peer, 'bad-away', 'activity', { away: 'yes' })).error.code).toBe(-32602);
			expect((await request(peer, 'typing', 'activity', { room_id: 'general', typing: 2 })).result).toEqual({});
			expect(await awayOf(userId)).toEqual([false]);
		} finally {
			peer.close();
			await runInDurableObject(stub(), (instance) => { (instance as unknown as Runtime).config.activityEnabled = false; });
		}
	});

	it('wakes mentioned users whose every connection is away or gone, with the message in the push', async () => {
		const pushes = capturePushes();
		const [aliceId, bobId, carolId, daveId] = [unique('alice'), unique('bob'), unique('carol'), unique('dave')];
		const alice = await signedIn(aliceId);
		const bob = await signedIn(bobId);
		const carol = await signedIn(carolId);
		const dave = await signedIn(daveId);
		try {
			const bobSub = await subscribe(bob, 'bob');
			const carolSub = await subscribe(carol, 'carol');
			const daveSub = await subscribe(dave, 'dave');
			// Alice's own subscription is never woken by her own mention.
			await subscribe(alice, 'alice');
			// Carol is away; Bob is attended; Dave has gone.
			await setAway(carol, true);
			dave.close();
			await vi.waitFor(async () => expect(await awayOf(daveId)).toEqual([]));

			const long = 'é'.repeat(250);
			const first = await post(alice, 'first', { room_id: 'general', body: { text: long, format: 'markdown', mentions: [bobId, carolId, aliceId, daveId, 'guest_1'], embeds: [{ kind: 'link', url: 'https://example.com' }] } });
			await vi.waitFor(() => expect(pushes).toHaveLength(2), { timeout: 5_000 });
			expect(pushes.map((push) => push.url).sort()).toEqual([carolSub.url, daveSub.url].sort());
			const carolPush = pushes.find((push) => push.url === carolSub.url)!;
			expect(carolPush.headers.get('authorization')).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${env.VAPID_PUBLIC_KEY}$`));
			expect(carolPush.headers.get('content-encoding')).toBe('aes128gcm');
			expect(carolPush.headers.get('ttl')).toBe(String(POLICY.ttlSeconds));
			expect(carolPush.headers.get('urgency')).toBe('normal');
			// The message without log_id, format or embeds, its text cut to 200 code points.
			const payload = JSON.parse((await decryptPush(carolPush.body, carolSub.browser)).plaintext);
			expect(payload).toEqual({
				message_id: first.result.message_id, room_id: 'general', from: { user_id: aliceId, name: `Name of ${aliceId}` },
				body: { text: `${'é'.repeat(199)}…`, mentions: [bobId, carolId, aliceId, daveId, 'guest_1'] },
			});

			// Edits, retries, and commands wake no one; a message from Carol ends her away.
			pushes.length = 0;
			await post(alice, 'edit', { message_id: first.result.message_id, body: { text: 'edited', mentions: [carolId] } });
			await post(alice, 'first', { room_id: 'general', body: { text: long, format: 'markdown', mentions: [bobId, carolId, aliceId, daveId, 'guest_1'], embeds: [{ kind: 'link', url: 'https://example.com' }] } });
			await request(alice, 'command', 'command', { body: { text: '/help', mentions: [carolId] } });
			await post(carol, 'carol-back', { body: { text: 'here' } });
			// Bob goes away: the next mention wakes him, not Carol.
			await setAway(bob, true);
			await post(alice, 'second', { body: { text: 'ping', mentions: [carolId, bobId] } });
			await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 5_000 });
			expect(pushes[0].url).toBe(bobSub.url);
			expect(JSON.parse((await decryptPush(pushes[0].body, bobSub.browser)).plaintext).body).toEqual({ text: 'ping', mentions: [carolId, bobId] });
		} finally { alice.close(); bob.close(); carol.close(); dave.close(); }
	});

	it('forgets a subscription its push service says is gone', async () => {
		const pushes = capturePushes((url) => url.includes('/gone-') ? 410 : 201);
		const [aliceId, erinId] = [unique('alice'), unique('erin')];
		const alice = await signedIn(aliceId);
		const erin = await signedIn(erinId);
		let kept: string;
		try {
			const gone = await subscribe(erin, 'gone');
			kept = (await subscribe(erin, 'kept')).url;
			expect(await subscriptionsOf(erinId)).toHaveLength(2);
			expect(gone.url).toContain('/gone-');
		} finally { erin.close(); }
		await vi.waitFor(async () => expect(await awayOf(erinId)).toEqual([]));
		try {
			await post(alice, 'mention', { body: { text: 'hi', mentions: [erinId] } });
			await vi.waitFor(() => expect(pushes).toHaveLength(2), { timeout: 5_000 });
			await vi.waitFor(async () => expect((await subscriptionsOf(erinId)).map((row) => row.url)).toEqual([kept]), { timeout: 5_000 });
		} finally { alice.close(); }
	});

	it('wakes at most wakesPerMessage users for one message', async () => {
		const pushes = capturePushes();
		const aliceId = unique('alice');
		const alice = await signedIn(aliceId);
		const mentioned = Array.from({ length: POLICY.wakesPerMessage + 2 }, (_, index) => unique(`m${index}`));
		await runInDurableObject(stub(), async (instance) => {
			const { store } = instance as unknown as Runtime;
			for (const userId of mentioned) {
				store.registerIdentity({
					userId, name: userId, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
					credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
				});
				const browser = await testBrowser();
				store.registerPushSubscription({ userId, url: `https://push.example.net/send/${userId}`, p256dh: browser.p256dh, auth: browser.auth });
			}
		});
		try {
			await post(alice, 'many', { body: { text: 'everyone', mentions: mentioned } });
			await vi.waitFor(() => expect(pushes).toHaveLength(POLICY.wakesPerMessage), { timeout: 5_000 });
			// In mention order: the last two are left out.
			expect(pushes.map((push) => push.url).sort()).toEqual(mentioned.slice(0, POLICY.wakesPerMessage).map((userId) => `https://push.example.net/send/${userId}`).sort());
		} finally { alice.close(); }
	});
});

describe('push subscriptions in the store', () => {
	const config = { push: { ...POLICY } };
	const browserKeys = async () => {
		const browser = await testBrowser();
		return { p256dh: browser.p256dh, auth: browser.auth };
	};
	function registerUser(store: Store, clock: TestClock, userId: string): void {
		store.registerIdentity({
			userId, name: userId, userHandle: `handle-${userId}`, now: clock.value, ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
	}

	it('keeps subscriptionsPerUser per user, replacing the least recently registered, and moves a url to whoever registers it', async () => {
		const keys = await browserKeys();
		await withStore('push-cap', config, (store, clock) => {
			registerUser(store, clock, 'ann');
			registerUser(store, clock, 'ben');
			const url = (n: number) => `https://push.example.net/${n}`;
			for (let n = 0; n < POLICY.subscriptionsPerUser; n++) {
				store.registerPushSubscription({ userId: 'ann', url: url(n), ...keys, now: clock.value });
				clock.value += 1_000;
			}
			// Registering the oldest again, unchanged within a day, writes nothing: it stays the oldest.
			store.registerPushSubscription({ userId: 'ann', url: url(0), ...keys, now: clock.value });
			store.registerPushSubscription({ userId: 'ann', url: url(99), ...keys, now: clock.value });
			const urls = store.pushSubscriptionsOf('ann').map((row) => row.url);
			expect(urls).toHaveLength(POLICY.subscriptionsPerUser);
			expect(urls[0]).toBe(url(99));
			expect(urls).not.toContain(url(0));
			// Ben's browser presents Ann's endpoint: it is his now.
			store.registerPushSubscription({ userId: 'ben', url: url(99), ...keys, now: clock.value });
			expect(store.pushSubscriptionsOf('ben').map((row) => row.url)).toEqual([url(99)]);
			expect(store.pushSubscriptionsOf('ann').map((row) => row.url)).not.toContain(url(99));
			// Unregistering takes only the user's own.
			store.removePushSubscription({ userId: 'ann', url: url(99) });
			expect(store.pushSubscriptionsOf('ben')).toHaveLength(1);
			// No identity, no subscription.
			expect(() => store.registerPushSubscription({ userId: 'guest_7', url: url(7), ...keys })).toThrow(/Sign in/);
		});
	});

	it('charges pushes to pushesPerDay, skipping the rest until the next UTC day', async () => {
		const keys = await browserKeys();
		await withStore('push-daily', { push: { ...POLICY, pushesPerDay: 3 } }, (store, clock) => {
			for (const userId of ['cy', 'di']) {
				registerUser(store, clock, userId);
				for (const n of [1, 2]) store.registerPushSubscription({ userId, url: `https://push.example.net/${userId}/${n}`, ...keys, now: clock.value });
			}
			expect(store.claimPushes({ userIds: [], now: clock.value })).toEqual({ subscriptions: [], skipped: 0 });
			const first = store.claimPushes({ userIds: ['cy', 'di', 'nobody'], now: clock.value });
			expect(first.subscriptions).toHaveLength(3);
			expect(first.skipped).toBe(1);
			expect(store.pushesToday(clock.value)).toBe(3);
			expect(store.claimPushes({ userIds: ['cy'], now: clock.value })).toEqual({ subscriptions: [], skipped: 2 });
			clock.value += 86_400_000;
			expect(store.claimPushes({ userIds: ['cy'], now: clock.value }).subscriptions).toHaveLength(2);
			expect(store.pushesToday(clock.value)).toBe(2);
			// Gone subscriptions are forgotten, whoever holds them.
			store.forgetPushSubscriptions(['https://push.example.net/cy/1', 'https://push.example.net/di/2'], clock.value);
			expect(store.pushSubscriptionsOf('cy').map((row) => row.url)).toEqual(['https://push.example.net/cy/2']);
			expect(store.pushSubscriptionsOf('di').map((row) => row.url)).toEqual(['https://push.example.net/di/1']);
		});
	});

	it('moves subscriptions with /rename and deletes them with /purge', async () => {
		const keys = await browserKeys();
		await withStore('push-rename', config, (store, clock) => {
			registerUser(store, clock, 'eve');
			store.registerPushSubscription({ userId: 'eve', url: 'https://push.example.net/eve', ...keys, now: clock.value });
			store.renameIdentity({ from: 'eve', to: 'eva', now: clock.value });
			expect(store.pushSubscriptionsOf('eve')).toEqual([]);
			expect(store.pushSubscriptionsOf('eva')).toEqual([{ url: 'https://push.example.net/eve', userId: 'eva', ...keys }]);
			expect(store.claimPushes({ userIds: ['eva'], now: clock.value }).subscriptions).toHaveLength(1);
			store.purgeUsers({ userIds: ['eva'], now: clock.value });
			expect(store.pushSubscriptionsOf('eva')).toEqual([]);
		});
	});
});
