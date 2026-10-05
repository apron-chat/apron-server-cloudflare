import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUSH_POLICY } from '../src/budget';
import { MUTE_FOREVER, WAKE_SCOPES, type PushSubscriptionRecord, type Store } from '../src/store';
import { connect as open, exchange, request, until, type Frame, type Peer } from './helpers/socket';
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
	config: { activityEnabled: boolean; push?: unknown };
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
async function subscribe(peer: Peer, name: string, pushId?: string, wake?: unknown): Promise<{ url: string; browser: TestBrowser }> {
	const browser = await testBrowser();
	const url = `https://push.example.net/send/${name}-${crypto.randomUUID()}`;
	const reply = await request(peer, `subscribe-${name}`, 'push_register', { kind: 'webpush', url, keys: { p256dh: browser.p256dh, auth: browser.auth }, ...(pushId !== undefined ? { push_id: pushId } : {}), ...(wake !== undefined ? { wake } : {}) });
	expect(reply.result).toEqual({});
	return { url, browser };
}

/** Sends `status` `idle` as the notification it is, then a request, so it is applied before the caller goes on. */
async function setIdle(peer: Peer, idle: boolean): Promise<void> {
	peer.send({ method: 'status', params: { idle } });
	expect((await request(peer, `sync-${crypto.randomUUID()}`, 'me', {})).result.you).toBeTruthy();
}

/** Each live connection's `idle`, for one user. */
function idleOf(userId: string): Promise<boolean[]> {
	return runInDurableObject(stub(), (_instance, state) => state.getWebSockets()
		.map((socket) => socket.deserializeAttachment() as { userId?: string; idle?: boolean; closing?: boolean })
		.filter((attachment) => attachment.userId === userId && !attachment.closing)
		.map((attachment) => attachment.idle === true));
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
			expect(server.params.push).toEqual({ webpush: { key: env.VAPID_PUBLIC_KEY }, wake: ['mentions', 'replies'] });
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
			['a push service not in PUSH_HOSTS', { kind: 'webpush', url: 'https://push.other.example/x', keys }],
			['a push_id past 64 characters', { kind: 'webpush', url: 'https://push.example.net/x', keys, push_id: 'x'.repeat(65) }],
			['an empty push_id', { kind: 'webpush', url: 'https://push.example.net/x', keys, push_id: '' }],
			['a push_id with other characters', { kind: 'webpush', url: 'https://push.example.net/x', keys, push_id: 'é' }],
			['a push_id that is not a string', { kind: 'webpush', url: 'https://push.example.net/x', keys, push_id: 7 }],
			['a wake that is not an array', { kind: 'webpush', url: 'https://push.example.net/x', keys, wake: 'mentions' }],
			['a wake entry that is not a string', { kind: 'webpush', url: 'https://push.example.net/x', keys, wake: ['mentions', 2] }],
			['a wake past 16 entries', { kind: 'webpush', url: 'https://push.example.net/x', keys, wake: Array.from({ length: 17 }, (_, index) => `ext:s${index}`) }],
			['a wake entry past 64 characters', { kind: 'webpush', url: 'https://push.example.net/x', keys, wake: ['x'.repeat(65)] }],
		];
		// Two bad requests per connection, below the repeated-violation close.
		for (let index = 0; index < cases.length; index += 2) {
			const peer = await signedIn(unique('vera'));
			try {
				for (const [label, params] of cases.slice(index, index + 2)) {
					const reply = await request(peer, `bad-${index}`, 'push_register', params);
					expect(reply.error?.code, label).toBe(-32602);
					if (label.includes('PUSH_HOSTS')) expect(reply.error.message).toBe('push service not allowed here');
				}
			} finally { peer.close(); }
		}

		const userId = unique('rosa');
		const peer = await signedIn(userId);
		try {
			const pushId = `A-z_0${'9'.repeat(59)}`;
			const { url } = await subscribe(peer, 'rosa', pushId);
			// Without `wake`, a registration wakes for mentions and replies.
			expect((await subscriptionsOf(userId)).map((row) => [row.url, row.pushId, row.wake])).toEqual([[url, pushId, ['mentions', 'replies']]]);
			// Unknown scopes are ignored, and a changed wake is written at once.
			await request(peer, 'wake-scopes', 'push_register', { kind: 'webpush', url, push_id: pushId, keys: (await subscriptionsOf(userId)).map((row) => ({ p256dh: row.p256dh, auth: row.auth }))[0], wake: ['replies', 'private', 'ext:x'] });
			expect((await subscriptionsOf(userId))[0].wake).toEqual(['replies']);
			// Unregistering removes it; an unknown url is already gone.
			expect((await request(peer, 'unregister', 'push_unregister', { url })).result).toEqual({});
			expect((await request(peer, 'unregister-again', 'push_unregister', { url })).result).toEqual({});
			expect(await subscriptionsOf(userId)).toEqual([]);
		} finally { peer.close(); }
	}, 20_000);

	it('tracks status idle per connection: only idle false ends it', async () => {
		const userId = unique('aldo');
		const peer = await signedIn(userId);
		const other = await signedIn(userId, true);
		try {
			expect(await idleOf(userId)).toEqual([false, false]);
			await setIdle(peer, true);
			expect((await idleOf(userId)).sort()).toEqual([false, true]);
			// Sent with an `id`, it is still a notification: processed, never answered.
			peer.send({ id: 'idle-request', method: 'status', params: { idle: false } });
			const answered = await exchange(peer, 'sync-request', 'me', {});
			expect(answered.skipped.filter((frame) => frame.id === 'idle-request')).toEqual([]);
			expect(await idleOf(userId)).toEqual([false, false]);
			await setIdle(peer, true);
			// A room's idle is not implemented: a scoped update is ignored.
			peer.send({ method: 'status', params: { room_id: 'general', idle: false } });
			await request(peer, 'sync-scoped', 'me', {});
			expect((await idleOf(userId)).sort()).toEqual([false, true]);
			// Neither a history page nor a message ends it (§4.11): only idle false.
			await request(peer, 'history', 'history', { room_id: 'general' });
			await post(peer, 'still-idle', { body: { text: 'posted while idle' } });
			expect((await idleOf(userId)).sort()).toEqual([false, true]);
			await setIdle(peer, false);
			expect(await idleOf(userId)).toEqual([false, false]);
			// A malformed idle changes nothing; nor do unknown fields or `invisible`.
			// None is a policy violation, so the connection stays open.
			await setIdle(other, true);
			for (const params of [{ idle: 'no' }, { idle: 1 }, { invisible: true, other: 1 }, { idle: null }, { idle: 'false' }]) {
				other.send({ method: 'status', params });
				await request(other, `sync-${JSON.stringify(params)}`, 'me', {});
				expect((await idleOf(userId)).sort(), JSON.stringify(params)).toEqual([false, true]);
			}
		} finally { peer.close(); other.close(); }
	});

	it('ignores status without push, and activity does not set or end idle', async () => {
		const pushes = capturePushes();
		const [aliceId, bobId, carolId] = [unique('alice'), unique('bob'), unique('carol')];
		const alice = await signedIn(aliceId);
		const bob = await signedIn(bobId);
		const carol = await signedIn(carolId);
		await runInDurableObject(stub(), (instance) => { (instance as unknown as Runtime).config.activityEnabled = true; });
		try {
			await subscribe(bob, 'bob');
			const carolSub = await subscribe(carol, 'carol');
			// Activity's `away` is not status: Bob stays attended.
			bob.send({ method: 'activity', params: { away: true } });
			await request(bob, 'sync-activity', 'me', {});
			expect(await idleOf(bobId)).toEqual([false]);
			// Nor do typing or a read cursor end idle.
			await setIdle(carol, true);
			carol.send({ method: 'activity', params: { room_id: 'general', typing: 2 } });
			carol.send({ method: 'activity', params: { room_id: 'general', read_message_id: '1' } });
			expect(await idleOf(carolId)).toEqual([true]);
			await post(alice, 'mention', { body: { text: 'hi', mentions: [bobId, carolId] } });
			await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 5_000 });
			expect(pushes[0].url).toBe(carolSub.url);

			// Without push, status is an unknown notification: ignored.
			const saved = await runInDurableObject(stub(), (instance) => {
				const runtime = instance as unknown as Runtime;
				const push = runtime.config.push;
				runtime.config = { ...runtime.config, push: undefined };
				return push;
			});
			try {
				await setIdle(bob, true);
				expect(await idleOf(bobId)).toEqual([false]);
			} finally {
				await runInDurableObject(stub(), (instance) => {
					const runtime = instance as unknown as Runtime;
					runtime.config = { ...runtime.config, push: saved };
				});
			}
		} finally {
			alice.close(); bob.close(); carol.close();
			await runInDurableObject(stub(), (instance) => { (instance as unknown as Runtime).config.activityEnabled = false; });
		}
	});

	it('wakes mentioned users whose every connection is idle or gone, with the message in the push', async () => {
		const pushes = capturePushes();
		const [aliceId, bobId, carolId, daveId] = [unique('alice'), unique('bob'), unique('carol'), unique('dave')];
		const alice = await signedIn(aliceId);
		const bob = await signedIn(bobId);
		const carol = await signedIn(carolId);
		const dave = await signedIn(daveId);
		try {
			const bobSub = await subscribe(bob, 'bob');
			const carolSub = await subscribe(carol, 'carol', 'carol-phone');
			const daveSub = await subscribe(dave, 'dave');
			// Alice's own subscription is never woken by her own mention.
			await subscribe(alice, 'alice');
			// Carol is idle; Bob is attended; Dave has gone.
			await setIdle(carol, true);
			dave.close();
			await vi.waitFor(async () => expect(await idleOf(daveId)).toEqual([]), { timeout: 5_000 });

			const long = 'é'.repeat(250);
			const first = await post(alice, 'first', { room_id: 'general', body: { text: long, format: 'markdown', mentions: [bobId, carolId, aliceId, daveId, 'guest_1'], embeds: [{ kind: 'link', url: 'https://example.com' }] } });
			await vi.waitFor(() => expect(pushes).toHaveLength(2), { timeout: 5_000 });
			expect(pushes.map((push) => push.url).sort()).toEqual([carolSub.url, daveSub.url].sort());
			const carolPush = pushes.find((push) => push.url === carolSub.url)!;
			expect(carolPush.headers.get('authorization')).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${env.VAPID_PUBLIC_KEY}$`));
			expect(carolPush.headers.get('content-encoding')).toBe('aes128gcm');
			expect(carolPush.headers.get('ttl')).toBe(String(POLICY.ttlSeconds));
			expect(carolPush.headers.get('urgency')).toBe('high');
			// The envelope: the registration's push_id, no unread, and the message
			// without log_id, format or embeds, its text cut to 200 code points.
			const payload = JSON.parse((await decryptPush(carolPush.body, carolSub.browser)).plaintext);
			expect(payload).toEqual({
				push_id: 'carol-phone',
				message: {
					message_id: first.result.message_id, room_id: 'general', from: { user_id: aliceId, name: `Name of ${aliceId}` },
					body: { text: `${'é'.repeat(199)}…`, mentions: [bobId, carolId, aliceId, daveId, 'guest_1'] },
				},
			});
			// Dave registered without a push_id: his envelope has only the message.
			const davePush = pushes.find((push) => push.url === daveSub.url)!;
			const davePayload = JSON.parse((await decryptPush(davePush.body, daveSub.browser)).plaintext);
			expect(Object.keys(davePayload)).toEqual(['message']);
			expect(davePayload.message.message_id).toBe(first.result.message_id);

			// Edits, retries, and commands wake no one. Carol is attended again.
			pushes.length = 0;
			await post(alice, 'edit', { message_id: first.result.message_id, body: { text: 'edited', mentions: [carolId] } });
			await post(alice, 'first', { room_id: 'general', body: { text: long, format: 'markdown', mentions: [bobId, carolId, aliceId, daveId, 'guest_1'], embeds: [{ kind: 'link', url: 'https://example.com' }] } });
			await request(alice, 'command', 'command', { body: { text: '/help', mentions: [carolId] } });
			await setIdle(carol, false);
			// Bob goes idle: the next mention wakes him, not Carol.
			await setIdle(bob, true);
			await post(alice, 'second', { body: { text: 'ping', mentions: [carolId, bobId] } });
			await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 5_000 });
			expect(pushes[0].url).toBe(bobSub.url);
			expect(JSON.parse((await decryptPush(pushes[0].body, bobSub.browser)).plaintext).message.body).toEqual({ text: 'ping', mentions: [carolId, bobId] });
		} finally { alice.close(); bob.close(); carol.close(); dave.close(); }
	});

	it('keeps every payload within 2048 bytes, dropping mentions first', async () => {
		const pushes = capturePushes();
		const [aliceId, bobId] = [unique('alice'), unique('bob')];
		const alice = await signedIn(aliceId);
		const bob = await signedIn(bobId);
		try {
			const bobSub = await subscribe(bob, 'bob', 'p'.repeat(64));
			await setIdle(bob, true);
			// Far more mentions than fit one payload (§4.7).
			const many = Array.from({ length: 60 }, (_, index) => `someone-${index}-${'x'.repeat(48)}`);
			await post(alice, 'crowd', { room_id: 'general', body: { text: '"quoted"\\'.repeat(40), mentions: [bobId, ...many] } });
			await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 5_000 });
			const plaintext = (await decryptPush(pushes[0].body, bobSub.browser)).plaintext;
			expect(new TextEncoder().encode(plaintext).byteLength).toBeLessThanOrEqual(2048);
			const payload = JSON.parse(plaintext);
			// The bound covers the whole envelope; the fallbacks apply inside `message`.
			expect(payload.push_id).toBe('p'.repeat(64));
			expect(Object.keys(payload)).toEqual(['push_id', 'message']);
			expect(payload.message.body).not.toHaveProperty('mentions');
			expect(payload.message.body.text).toMatch(/^"quoted"/);
			expect(payload.message.from).toEqual({ user_id: aliceId, name: `Name of ${aliceId}` });
		} finally { alice.close(); bob.close(); }
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
		await vi.waitFor(async () => expect(await idleOf(erinId)).toEqual([]), { timeout: 5_000 });
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
			// Ten mentions with no registration first: they take no wake slots.
			const unsubscribed = Array.from({ length: 10 }, (_, index) => unique(`none${index}`));
			await post(alice, 'many', { body: { text: 'everyone', mentions: [...unsubscribed, ...mentioned] } });
			await vi.waitFor(() => expect(pushes).toHaveLength(POLICY.wakesPerMessage), { timeout: 5_000 });
			// In mention order: the last two are left out.
			expect(pushes.map((push) => push.url).sort()).toEqual(mentioned.slice(0, POLICY.wakesPerMessage).map((userId) => `https://push.example.net/send/${userId}`).sort());
		} finally { alice.close(); }
	});
});

describe('wake scopes', () => {
	/** A message by `userId` in general, straight into the store; its message_id. */
	async function authored(userId: string, text: string): Promise<string> {
		return runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.mutate({
			userId, ipKey: `ip-${userId}`, method: 'message', now: Date.now(), identity: { user_id: userId }, params: { body: { text } },
		}).result.message_id as string);
	}

	/** A registered user with one registration and no connection; their subscription url. */
	async function gone(name: string, wake?: unknown): Promise<string> {
		const userId = unique(name);
		const peer = await signedIn(userId);
		const { url } = await subscribe(peer, userId, undefined, wake);
		peer.close();
		await vi.waitFor(async () => expect(await idleOf(userId)).toEqual([]), { timeout: 5_000 });
		return url;
	}
	const userOf = (url: string) => url.slice('https://push.example.net/send/'.length).replace(/-[0-9a-f-]{36}$/, '');

	it('wakes each user only on registrations whose wake includes why they qualify', async () => {
		const pushes = capturePushes();
		const urls = {
			mentionsOnlyMentioned: await gone('mm', ['mentions']),
			mentionsOnlyRepliedTo: await gone('mr', ['mentions']),
			repliesOnlyRepliedTo: await gone('rr', ['replies']),
			repliesOnlyMentioned: await gone('rm', ['replies']),
			nothing: await gone('none', []),
			both: await gone('both'),
			attended: '',
			control: await gone('ctrl'),
		};
		const attendedId = unique('here');
		const here = await signedIn(attendedId);
		urls.attended = (await subscribe(here, attendedId)).url;
		const senderId = unique('sender');
		const sender = await signedIn(senderId);
		try {
			const user = (key: keyof typeof urls) => userOf(urls[key]);
			const reply = async (id: string, key: keyof typeof urls, mentions: string[] = []) => post(sender, id, {
				body: { text: `re ${id}`, ...(mentions.length ? { mentions } : {}) }, reply_to: { message_id: await authored(user(key), `by ${key}`) },
			});
			await post(sender, 'm1', { body: { text: 'hi', mentions: [user('mentionsOnlyMentioned'), user('repliesOnlyMentioned')] } });
			await reply('r1', 'mentionsOnlyRepliedTo');
			await reply('r2', 'repliesOnlyRepliedTo');
			await reply('r3', 'nothing', [user('nothing')]);
			// Mentioned and replied to in one message: pushed once.
			await reply('r4', 'both', [user('both')]);
			// An attended author is not woken by a reply.
			await reply('r5', 'attended');
			await vi.waitFor(() => expect(pushes.map((push) => push.url).sort()).toEqual([urls.mentionsOnlyMentioned, urls.repliesOnlyRepliedTo, urls.both].sort()), { timeout: 5_000 });
			// Replying to one's own message wakes no one: the sender is never a candidate.
			await runInDurableObject(stub(), async (instance) => {
				const runtime = instance as unknown as { wakeFor(message: unknown): void };
				const own = await authored(user('control'), 'mine');
				runtime.wakeFor({ message_id: '1', room_id: 'general', from: { user_id: user('control') }, reply_to: { message_id: own }, body: { text: 'me again', mentions: [user('control')] } });
			});
			await post(sender, 'control', { body: { text: 'control' }, reply_to: { message_id: await authored(user('control'), 'control') } });
			await vi.waitFor(() => expect(pushes).toHaveLength(4), { timeout: 5_000 });
			expect(pushes[3].url).toBe(urls.control);
			expect(pushes.filter((push) => push.url === urls.control)).toHaveLength(1);
		} finally { sender.close(); here.close(); }
	});
});

describe('status mute', () => {
	/** Frames this peer receives until a reply to a `me` request, so earlier notifications are all in. */
	async function drainTo(peer: Peer, id: string): Promise<Frame[]> {
		return (await exchange(peer, id, 'me', {})).skipped;
	}
	const youOf = (frames: Frame[]) => frames.filter((frame) => frame.method === 'user' && frame.params.you).map((frame) => frame.params.you);

	it('mutes a user\'s pushes for seconds or until changed, echoed in you to their connections', async () => {
		const pushes = capturePushes();
		const [aliceId, bobId] = [unique('alice'), unique('bob')];
		const alice = await signedIn(aliceId);
		const bob = await signedIn(bobId);
		const bobToo = await signedIn(bobId, true);
		try {
			const bobSub = await subscribe(bob, 'bob');
			await setIdle(bob, true);
			await setIdle(bobToo, true);
			bob.send({ method: 'status', params: { mute: 3600 } });
			// Every connection of Bob's hears it, the one that set it included; never anyone else.
			const echoed = youOf(await drainTo(bobToo, 'sync-too'));
			expect(echoed).toHaveLength(1);
			expect(echoed[0]).toMatchObject({ user_id: bobId, mute: expect.any(Number) });
			expect(echoed[0].mute).toBeGreaterThan(3590);
			expect(echoed[0].mute).toBeLessThanOrEqual(3600);
			expect(youOf(await drainTo(bob, 'sync-bob'))).toHaveLength(1);
			expect(youOf(await drainTo(alice, 'sync-alice'))).toEqual([]);
			// `me` and a new sign-in echo it too.
			expect((await request(bob, 'me', 'me', {})).result.you.mute).toBeGreaterThan(3590);
			const later = await signedIn(bobId, true);
			later.close();
			// Muted: no push, and no wake slot taken.
			await post(alice, 'muted', { body: { text: 'hi', mentions: [bobId] } });
			// `true` mutes until changed.
			bob.send({ method: 'status', params: { mute: true } });
			expect(youOf(await drainTo(bobToo, 'sync-true'))[0].mute).toBe(true);
			await post(alice, 'muted-forever', { body: { text: 'hi', mentions: [bobId] } });
			// 0 ends it, echoed as `mute: 0`, and pushes again (once Bob is idle again).
			bob.send({ method: 'status', params: { mute: 0 } });
			const ended = youOf(await drainTo(bobToo, 'sync-zero'));
			expect(ended).toHaveLength(1);
			expect(ended[0].mute).toBe(0);
			// Not muted, `me` leaves it out.
			expect((await request(bobToo, 'me-unmuted', 'me', {})).result.you).not.toHaveProperty('mute');
			await setIdle(bob, true);
			await post(alice, 'unmuted', { body: { text: 'welcome back', mentions: [bobId] } });
			await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 5_000 });
			expect(pushes[0].url).toBe(bobSub.url);
			expect(JSON.parse((await decryptPush(pushes[0].body, bobSub.browser)).plaintext).message.body.text).toBe('welcome back');
			// Ending a mute that is not set changes nothing and echoes nothing.
			bob.send({ method: 'status', params: { mute: 0 } });
			expect(youOf(await drainTo(bobToo, 'sync-again'))).toEqual([]);
		} finally { alice.close(); bob.close(); bobToo.close(); }
	});

	it('applies status sent before authentication once signed in', async () => {
		const userId = unique('early');
		const first = await signedIn(userId);
		const token = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).issueSession(userId, 'http://localhost:5173', Date.now()));
		const peer = await connect();
		try {
			await peer.next();
			peer.send({ method: 'status', params: { idle: true, mute: true } });
			const you = (await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you;
			expect(you).toMatchObject({ user_id: userId, mute: true });
			expect((await idleOf(userId)).sort()).toEqual([false, true]);
			// The user's other connection hears of the mute.
			expect(youOf(await drainTo(first, 'sync-first'))[0]).toMatchObject({ user_id: userId, mute: true });
		} finally { first.close(); peer.close(); }
	});

	it('ignores invalid status fields one by one, without counting them, and guests\' mutes', async () => {
		const userId = unique('mal');
		const peer = await signedIn(userId);
		try {
			// Each invalid mute is ignored on its own; none is a policy violation.
			for (const mute of [-1, 1.5, '3600', false, null, {}]) peer.send({ method: 'status', params: { mute } });
			expect((await request(peer, 'me', 'me', {})).result.you).not.toHaveProperty('mute');
			// A valid field in the same update still applies.
			peer.send({ method: 'status', params: { idle: true, mute: false } });
			peer.send({ method: 'status', params: { idle: 'yes', mute: 60 } });
			const you = (await request(peer, 'me-after', 'me', {})).result.you;
			expect(you.mute).toBeGreaterThan(55);
			expect(await idleOf(userId)).toEqual([true]);
			expect(peer.closed()).toBeUndefined();
		} finally { peer.close(); }
		const guest = await connect();
		try {
			await guest.next();
			await request(guest, 'auth', 'auth', { scheme: 'guest' });
			guest.send({ method: 'status', params: { mute: true } });
			expect((await request(guest, 'me', 'me', {})).result.you).not.toHaveProperty('mute');
		} finally { guest.close(); }
	});
});

describe('push review fixes', () => {
	/** Sets the time of a user's connections' last frame, as if they had been quiet since. */
	function quietSince(userId: string, at: number): Promise<void> {
		return runInDurableObject(stub(), (_instance, state) => {
			for (const socket of state.getWebSockets()) {
				const attachment = socket.deserializeAttachment() as { userId?: string; frameTimes: number[] };
				if (attachment.userId !== userId) continue;
				socket.serializeAttachment({ ...attachment, frameTimes: [at] });
			}
		});
	}

	it('treats a connection that never sent status as idle once it has been quiet for ten minutes', async () => {
		const pushes = capturePushes();
		const [aliceId, silentId, reportingId] = [unique('alice'), unique('silent'), unique('reporting')];
		const alice = await signedIn(aliceId);
		const silent = await signedIn(silentId);
		const reporting = await signedIn(reportingId);
		try {
			const silentSub = await subscribe(silent, 'silent');
			await subscribe(reporting, 'reporting');
			// This client reports status, and is attending: quiet or not, it is attended.
			reporting.send({ method: 'status', params: { idle: false } });
			await request(reporting, 'sync', 'me', {});
			await quietSince(silentId, Date.now() - 11 * 60_000);
			await quietSince(reportingId, Date.now() - 11 * 60_000);
			await post(alice, 'quiet', { body: { text: 'anyone?', mentions: [silentId, reportingId] } });
			await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 5_000 });
			expect(pushes[0].url).toBe(silentSub.url);
		} finally { alice.close(); silent.close(); reporting.close(); }
	});

	it('checks PUSH_HOSTS again before each push', async () => {
		const pushes = capturePushes();
		const [aliceId, bobId] = [unique('alice'), unique('bob')];
		const alice = await signedIn(aliceId);
		const bob = await signedIn(bobId);
		const setHosts = (hosts: readonly string[] | '*') => runInDurableObject(stub(), (instance) => {
			const runtime = instance as unknown as { config: { pushHosts: readonly string[] | '*' } };
			runtime.config = { ...runtime.config, pushHosts: hosts };
		});
		try {
			const bobSub = await subscribe(bob, 'bob');
			await setIdle(bob, true);
			await setHosts(['push.elsewhere.example']);
			await post(alice, 'narrowed', { room_id: 'general', body: { text: 'not sent', mentions: [bobId] } });
			await setHosts(['push.example.net']);
			// Another room: the first wake still coalesces general.
			const thread = (await request(alice, 'thread', 'room_set', { parent_room_id: 'general', title: 'Hosts' })).result.room_id;
			await post(alice, 'restored', { room_id: thread, body: { text: 'sent', mentions: [bobId] } });
			await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 5_000 });
			expect(JSON.parse((await decryptPush(pushes[0].body, bobSub.browser)).plaintext).message.body.text).toBe('sent');
		} finally { alice.close(); bob.close(); await setHosts(['push.example.net']); }
	});

	it('drops a mute sent before a guest sign-in, and ignores room-scoped status without counting it', async () => {
		const guest = await connect();
		try {
			await guest.next();
			guest.send({ method: 'status', params: { mute: true } });
			await request(guest, 'auth', 'auth', { scheme: 'guest' });
			const attachments = await runInDurableObject(stub(), (_instance, state) => state.getWebSockets().map((socket) => socket.deserializeAttachment() as { pendingMute?: unknown; tier: string }));
			expect(attachments.filter((attachment) => attachment.pendingMute !== undefined && attachment.tier !== 'pending')).toEqual([]);
			// Scoped fields this server does not implement: ignored, not violations.
			for (let index = 0; index < 4; index++) guest.send({ method: 'status', params: { room_id: 'general', mute: 'x', idle: 7, invisible: true } });
			// A room the user cannot see is ignored entirely too, not taken as unscoped.
			guest.send({ method: 'status', params: { room_id: 'no-such-room', mute: true } });
			expect((await request(guest, 'still-open', 'me', {})).result.you).toBeTruthy();
			expect(guest.closed()).toBeUndefined();
		} finally { guest.close(); }
	});

	it('times a mute sent before sign-in from when it applies', async () => {
		const userId = unique('later');
		const first = await signedIn(userId);
		first.close();
		const token = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).issueSession(userId, 'http://localhost:5173', Date.now()));
		const peer = await connect();
		try {
			await peer.next();
			peer.send({ method: 'status', params: { mute: 120 } });
			const mute = (await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.mute;
			expect(mute).toBeGreaterThan(115);
			expect(mute).toBeLessThanOrEqual(120);
		} finally { peer.close(); }
	});
});

describe('security review fixes', () => {
	const senderCharged = (userId: string) => runInDurableObject(stub(), (_instance, state) =>
		state.storage.sql.exec<{ posts_day: number }>("SELECT posts_day FROM principal_limits WHERE scope = 'push' AND principal_key = ?", `user:${userId}`).toArray()[0]?.posts_day ?? 0);

	it('drops mute changes past mutesPerUserMinute, counted per user across reconnects', async () => {
		const userId = unique('flip');
		const peer = await signedIn(userId);
		const watcher = await signedIn(userId, true);
		try {
			for (let index = 0; index < POLICY.mutesPerUserMinute + 2; index++) peer.send({ method: 'status', params: { mute: index % 2 ? 0 : 60 } });
			await request(peer, 'sync-peer', 'me', {});
			const echoes = (await exchange(watcher, 'sync', 'me', {})).skipped.filter((frame) => frame.method === 'user');
			expect(echoes).toHaveLength(POLICY.mutesPerUserMinute);
			// A new connection does not reset the count.
			peer.close();
			const again = await signedIn(userId, true);
			try {
				again.send({ method: 'status', params: { mute: true } });
				await request(again, 'sync-again-peer', 'me', {});
				const later = (await exchange(watcher, 'sync-again', 'me', {})).skipped.filter((frame) => frame.method === 'user');
				expect(later).toEqual([]);
				expect(again.closed()).toBeUndefined();
			} finally { again.close(); }
		} finally { peer.close(); watcher.close(); }
	});

	it('limits push_register per user across reconnects', async () => {
		const userId = unique('regs');
		const browser = await testBrowser();
		const params = { kind: 'webpush', url: 'https://push.example.net/again', keys: { p256dh: browser.p256dh, auth: browser.auth } };
		const first = await signedIn(userId);
		for (let index = 0; index < POLICY.registersPerUserMinute; index++) {
			expect((await request(first, `reg-${index}`, 'push_register', params)).result).toEqual({});
		}
		first.close();
		const second = await signedIn(userId, true);
		try {
			expect((await request(second, 'over', 'push_register', params)).error.code).toBe(-32002);
		} finally { second.close(); }
	});

	it('stores one spelling of an endpoint, refuses a trailing-dot host, and caps urls at 512 bytes', async () => {
		const userId = unique('norm');
		const peer = await signedIn(userId);
		try {
			const browser = await testBrowser();
			const keys = { p256dh: browser.p256dh, auth: browser.auth };
			expect((await request(peer, 'spelled', 'push_register', { kind: 'webpush', url: 'https://PUSH.example.net:443/a/../b', keys })).result).toEqual({});
			expect((await request(peer, 'plain', 'push_register', { kind: 'webpush', url: 'https://push.example.net/b', keys })).result).toEqual({});
			expect((await subscriptionsOf(userId)).map((row) => row.url)).toEqual(['https://push.example.net/b']);
			expect((await request(peer, 'dot', 'push_register', { kind: 'webpush', url: 'https://push.example.net./c', keys })).error.code).toBe(-32602);
			expect((await request(peer, 'long', 'push_register', { kind: 'webpush', url: `https://push.example.net/${'x'.repeat(500)}`, keys })).error.code).toBe(-32602);
			// Unregistering by another spelling removes it too.
			expect((await request(peer, 'unregister', 'push_unregister', { url: 'https://PUSH.example.net/b' })).result).toEqual({});
			expect(await subscriptionsOf(userId)).toEqual([]);
		} finally { peer.close(); }
	});

	it('forgets a registration its push service refuses with 403, and charges the sender only for delivered pushes', async () => {
		const pushes = capturePushes((url) => url.includes('/refused-') ? 403 : url.includes('/failing-') ? 500 : 201);
		const [aliceId, bobId, carolId] = [unique('alice'), unique('bob'), unique('carol')];
		const alice = await signedIn(aliceId);
		try {
			for (const [userId, name] of [[bobId, 'refused'], [carolId, 'failing']] as const) {
				const peer = await signedIn(userId);
				await subscribe(peer, name);
				peer.close();
				await vi.waitFor(async () => expect(await idleOf(userId)).toEqual([]), { timeout: 5_000 });
			}
			await post(alice, 'mention', { body: { text: 'hi', mentions: [bobId, carolId] } });
			await vi.waitFor(() => expect(pushes).toHaveLength(2), { timeout: 5_000 });
			await vi.waitFor(async () => expect(await subscriptionsOf(bobId)).toEqual([]), { timeout: 5_000 });
			expect(await subscriptionsOf(carolId)).toHaveLength(1);
			// Neither push was delivered, so Alice was charged nothing.
			expect(await senderCharged(aliceId)).toBe(0);
		} finally { alice.close(); }
	});

	it('passes over registrations PUSH_HOSTS no longer allows before they take a wake', async () => {
		const keys = { p256dh: (await testBrowser()).p256dh, auth: 'a'.repeat(22) };
		await withStore('push-hosts-claim', { push: { ...POLICY, wakesPerMessage: 1 } }, (store, clock) => {
			for (const userId of ['old', 'new']) {
				store.registerIdentity({
					userId, name: userId, userHandle: `handle-${userId}`, now: clock.value, ipKey: `ip-${userId}`,
					credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
				});
			}
			store.registerPushSubscription({ userId: 'old', url: 'https://push.retired.example/x', ...keys, now: clock.value });
			store.registerPushSubscription({ userId: 'new', url: 'https://push.example.net/y', ...keys, now: clock.value });
			const claimed = store.claimPushes({
				senderId: 'sender', roomId: 'general', now: clock.value,
				candidates: [{ userId: 'old', reasons: WAKE_SCOPES.mentions }, { userId: 'new', reasons: WAKE_SCOPES.mentions }],
				allowed: (url) => url.startsWith('https://push.example.net/'),
			});
			expect(claimed.subscriptions.map((row) => row.userId)).toEqual(['new']);
			expect(store.pushesToday(clock.value)).toBe(1);
		});
	});

	it("clears a user's push registrations on /passkeys remove, and a bot's on a new token", async () => {
		const userId = unique('keys');
		await register(userId);
		await runInDurableObject(stub(), (instance) => {
			(instance as unknown as Runtime).store.addCredential({
				userId, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
				credential: { credentialId: `cred2-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
			});
		});
		const peer = await signedIn(userId, true);
		try {
			await subscribe(peer, 'phone');
			expect((await request(peer, 'remove', 'command', { body: { text: '/passkeys remove 2' } })).result).toEqual({});
			expect(await subscriptionsOf(userId)).toEqual([]);
			// The bot's token is replaced: its registrations go with the old one.
			const botId = `bot_${userId}`;
			expect((await request(peer, 'bot', 'command', { body: { text: '/invite-bot' } })).result).toEqual({});
			await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.registerPushSubscription({
				userId: botId, url: 'https://push.example.net/bot', p256dh: 'p'.repeat(87), auth: 'a'.repeat(22),
			}));
			expect(await subscriptionsOf(botId)).toHaveLength(1);
			expect((await request(peer, 'bot-again', 'command', { body: { text: '/invite-bot' } })).result).toEqual({});
			expect(await subscriptionsOf(botId)).toEqual([]);
		} finally { peer.close(); }
	});

	it('keeps a connection that only mutes under the silent-idle rule', async () => {
		const pushes = capturePushes();
		const [aliceId, quietId] = [unique('alice'), unique('quiet')];
		const alice = await signedIn(aliceId);
		const quiet = await signedIn(quietId);
		try {
			const quietSub = await subscribe(quiet, 'quiet');
			// `mute` alone does not say the client reports idle.
			quiet.send({ method: 'status', params: { mute: 0, invisible: false } });
			await request(quiet, 'sync', 'me', {});
			await runInDurableObject(stub(), (_instance, state) => {
				for (const socket of state.getWebSockets()) {
					const attachment = socket.deserializeAttachment() as { userId?: string; frameTimes: number[] };
					if (attachment.userId === quietId) socket.serializeAttachment({ ...attachment, frameTimes: [Date.now() - 11 * 60_000] });
				}
			});
			await post(alice, 'quiet', { body: { text: 'still there?', mentions: [quietId] } });
			await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 5_000 });
			expect(pushes[0].url).toBe(quietSub.url);
		} finally { alice.close(); quiet.close(); }
	});
});

describe('push limits over the socket', () => {
	it('limits push_register to registersPerUserMinute a user', async () => {
		const userId = unique('reg');
		const peer = await signedIn(userId);
		try {
			const browser = await testBrowser();
			const params = { kind: 'webpush', url: 'https://push.example.net/again', keys: { p256dh: browser.p256dh, auth: browser.auth } };
			for (let index = 0; index < POLICY.registersPerUserMinute; index++) {
				expect((await request(peer, `again-${index}`, 'push_register', params)).result).toEqual({});
			}
			const limited = await request(peer, 'over', 'push_register', params);
			expect(limited.error.code).toBe(-32002);
			expect(limited.error.data.retry_after).toBeGreaterThan(0);
		} finally { peer.close(); }
	});

	it("wakes no one for a guest's mentions", async () => {
		const pushes = capturePushes();
		const [targetId, controlId, aliceId] = [unique('tara'), unique('cole'), unique('alice')];
		for (const userId of [targetId, controlId]) {
			const peer = await signedIn(userId);
			await subscribe(peer, userId);
			peer.close();
			await vi.waitFor(async () => expect(await idleOf(userId)).toEqual([]), { timeout: 5_000 });
		}
		const guest = await connect();
		const alice = await signedIn(aliceId);
		try {
			await guest.next();
			await request(guest, 'auth', 'auth', { scheme: 'guest' });
			await post(guest, 'guest-mention', { body: { text: 'hey', mentions: [targetId] } });
			await post(alice, 'control', { body: { text: 'hey', mentions: [controlId] } });
			await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 5_000 });
			expect(pushes[0].url).toContain(`/${controlId}-`);
		} finally { guest.close(); alice.close(); }
	});
});

describe('push subscriptions in the store', () => {
	const config = { push: { ...POLICY } };
	const DAY = 86_400_000;
	/** Moves the clock to the next UTC midday, so a test that counts per day can't cross midnight. */
	const atMidday = (clock: TestClock) => { clock.value = (Math.floor(clock.value / DAY) + 1) * DAY + DAY / 2; };
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
	const claim = (store: Store, clock: TestClock, candidates: string[], roomId = 'general', senderId = 'sender') =>
		store.claimPushes({ senderId, roomId, candidates: candidates.map((userId) => ({ userId, reasons: WAKE_SCOPES.mentions })), now: clock.value });

	it('keeps subscriptionsPerUser per user, replacing the least recently registered; registrations are per user', async () => {
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
			// A changed push_id is a change, even within a day; an absent one removes it.
			const of = (userId: string, n: number) => store.pushSubscriptionsOf(userId).find((row) => row.url === url(n));
			store.registerPushSubscription({ userId: 'ann', url: url(1), ...keys, pushId: 'one', now: clock.value });
			expect(of('ann', 1)?.pushId).toBe('one');
			store.registerPushSubscription({ userId: 'ann', url: url(1), ...keys, pushId: 'two', now: clock.value });
			expect(of('ann', 1)?.pushId).toBe('two');
			store.registerPushSubscription({ userId: 'ann', url: url(1), ...keys, now: clock.value });
			expect(of('ann', 1)).not.toHaveProperty('pushId');
			expect(() => store.registerPushSubscription({ userId: 'ann', url: url(1), ...keys, pushId: 'not ok' })).toThrow(/push_id/);
			// Ben registers the same endpoint: both hold it, each their own.
			store.registerPushSubscription({ userId: 'ben', url: url(99), ...keys, pushId: 'ben', now: clock.value });
			expect(store.pushSubscriptionsOf('ben').map((row) => row.url)).toEqual([url(99)]);
			expect(of('ann', 99)).toBeDefined();
			// Unregistering takes only the caller's own.
			store.removePushSubscription({ userId: 'ann', url: url(99) });
			expect(of('ann', 99)).toBeUndefined();
			expect(store.pushSubscriptionsOf('ben')).toHaveLength(1);
			// No identity, no subscription.
			expect(() => store.registerPushSubscription({ userId: 'guest_7', url: url(7), ...keys })).toThrow(/Sign in/);
		});
	});

	it('spends wake slots only on users with live registrations, and coalesces per user and room', async () => {
		const keys = await browserKeys();
		await withStore('push-slots', { push: { ...POLICY, wakesPerMessage: 2 } }, (store, clock) => {
			for (const userId of ['fay', 'gus', 'hal']) {
				registerUser(store, clock, userId);
				store.registerPushSubscription({ userId, url: `https://push.example.net/${userId}`, ...keys, now: clock.value });
			}
			const nobody = Array.from({ length: 10 }, (_, index) => `nobody_${index}`);
			const first = claim(store, clock, [...nobody, 'fay', 'gus', 'hal']);
			expect(first.subscriptions.map((row) => row.userId)).toEqual(['fay', 'gus']);
			// Fay and Gus were just woken for general; Hal takes the slot. Another room wakes them again.
			expect(claim(store, clock, ['fay', 'gus', 'hal']).subscriptions.map((row) => row.userId)).toEqual(['hal']);
			expect(claim(store, clock, ['fay']).coalesced).toBe(1);
			expect(claim(store, clock, ['fay'], 'thread').subscriptions.map((row) => row.userId)).toEqual(['fay']);
			clock.value += POLICY.coalesceSeconds * 1_000;
			expect(claim(store, clock, ['fay']).subscriptions.map((row) => row.userId)).toEqual(['fay']);
		});
	});

	it('charges pushes to pushesPerDay and each recipient, skipping the rest until the next UTC day', async () => {
		const keys = await browserKeys();
		await withStore('push-daily', { push: { ...POLICY, pushesPerDay: 3, coalesceSeconds: 1 } }, (store, clock) => {
			atMidday(clock);
			for (const userId of ['cy', 'di', 'ed']) {
				registerUser(store, clock, userId);
				for (const n of [1, 2]) store.registerPushSubscription({ userId, url: `https://push.example.net/${userId}/${n}`, ...keys, now: clock.value });
			}
			expect(claim(store, clock, [])).toEqual({ subscriptions: [], coalesced: 0, muted: 0, skipped: 0 });
			const first = claim(store, clock, ['cy', 'di', 'nobody']);
			expect(first.subscriptions).toHaveLength(3);
			expect(first.skipped).toBe(1);
			expect(store.pushesToday(clock.value)).toBe(3);
			clock.value += 1_000;
			expect(claim(store, clock, ['cy'])).toEqual({ subscriptions: [], coalesced: 0, muted: 0, skipped: 2 });
			clock.value += DAY;
			expect(claim(store, clock, ['cy'], 'general', 'sal').subscriptions).toHaveLength(2);
			expect(store.pushesToday(clock.value)).toBe(2);
		});
	});

	it('charges senders only for delivered pushes, and caps what one recipient gets a day', async () => {
		const keys = await browserKeys();
		await withStore('push-sender', { push: { ...POLICY, pushesPerSenderDay: 3, pushesPerRecipientDay: 3, coalesceSeconds: 1 } }, (store, clock) => {
			atMidday(clock);
			for (const userId of ['fi', 'gil', 'hu']) {
				registerUser(store, clock, userId);
				for (const n of [1, 2]) store.registerPushSubscription({ userId, url: `https://push.example.net/${userId}/${n}`, ...keys, now: clock.value });
			}
			// Claims alone, never delivered, cost the sender nothing: Sam's 3 pushes
			// to Fi are all claimed, the third cut by Fi's recipient cap of 3.
			expect(claim(store, clock, ['fi'], 'room-0', 'sam').subscriptions).toHaveLength(2);
			clock.value += 2_000;
			expect(claim(store, clock, ['fi'], 'room-1', 'sam')).toMatchObject({ subscriptions: [expect.anything()], skipped: 1 });
			clock.value += 2_000;
			// Fi has had 3 pushes today: no more, from anyone.
			expect(claim(store, clock, ['fi'], 'room-2', 'tess')).toMatchObject({ subscriptions: [], skipped: 2 });
			// Sam's delivered pushes reach the sender cap: Sam wakes no one more today.
			store.chargePushSender('sam', 3, clock.value);
			expect(claim(store, clock, ['gil'], 'general', 'sam')).toMatchObject({ subscriptions: [], skipped: 2 });
			expect(claim(store, clock, ['gil'], 'general', 'tess').subscriptions).toHaveLength(2);
			// A message cannot claim past the sender's allowance either.
			store.chargePushSender('uma', 2, clock.value);
			expect(claim(store, clock, ['hu'], 'general', 'uma').subscriptions).toHaveLength(1);
			expect(store.accountingStatus().unsafe).toBe(false);
		});
	});

	it('forgets a gone registration by user, endpoint and keys, keeping a fresh one and other users\' own', async () => {
		const [old, fresh] = [await browserKeys(), await browserKeys()];
		await withStore('push-gone', config, (store, clock) => {
			registerUser(store, clock, 'ida');
			registerUser(store, clock, 'jon');
			const url = 'https://push.example.net/shared';
			store.registerPushSubscription({ userId: 'ida', url, ...old, now: clock.value });
			store.registerPushSubscription({ userId: 'jon', url, ...old, now: clock.value });
			// Ida's push came back gone: only her registration goes.
			store.forgetPushSubscriptions([{ userId: 'ida', url, p256dh: old.p256dh }], clock.value);
			expect(store.pushSubscriptionsOf('ida')).toEqual([]);
			expect(store.pushSubscriptionsOf('jon')).toHaveLength(1);
			// Jon registered again with new keys before his gone push came back: the fresh one stays.
			store.registerPushSubscription({ userId: 'jon', url, ...fresh, now: clock.value });
			store.forgetPushSubscriptions([{ userId: 'jon', url, p256dh: old.p256dh }], clock.value);
			expect(store.pushSubscriptionsOf('jon').map((row) => row.p256dh)).toEqual([fresh.p256dh]);
		});
	});

	it('keeps accounting safe when many users register one endpoint and it goes', async () => {
		const keys = await browserKeys();
		await withStore('push-shared-endpoint', config, (store, clock) => {
			const url = 'https://push.example.net/everyone';
			const users = Array.from({ length: 50 }, (_, index) => `many_${index}`);
			for (const userId of users) {
				registerUser(store, clock, userId);
				store.registerPushSubscription({ userId, url, ...keys, now: clock.value });
			}
			// Every user's 410 forgets that user's row alone, within its reservation.
			const claimed = claim(store, clock, users.slice(0, 32));
			expect(claimed.subscriptions).toHaveLength(POLICY.wakesPerMessage);
			store.forgetPushSubscriptions(claimed.subscriptions, clock.value);
			store.forgetPushSubscriptions([{ userId: users[49], url, p256dh: keys.p256dh }], clock.value);
			expect(store.accountingStatus().unsafe).toBe(false);
			expect(users.filter((userId) => store.pushSubscriptionsOf(userId).length)).toHaveLength(50 - POLICY.wakesPerMessage - 1);
			// The store still takes work.
			expect(() => store.registerPushSubscription({ userId: users[0], url, ...keys, now: clock.value })).not.toThrow();
		});
	});

	it('skips registrations older than pushExpiryDays, refreshes them once a day, and cleanup deletes them', async () => {
		const keys = await browserKeys();
		await withStore('push-expiry', config, (store, clock) => {
			registerUser(store, clock, 'kit');
			registerUser(store, clock, 'lou');
			store.registerPushSubscription({ userId: 'kit', url: 'https://push.example.net/kit', ...keys, now: clock.value });
			store.registerPushSubscription({ userId: 'lou', url: 'https://push.example.net/lou', ...keys, now: clock.value });
			clock.value += (POLICY.pushExpiryDays - 1) * DAY;
			// Lou's browser connects again: more than a day on, the registration is refreshed.
			store.registerPushSubscription({ userId: 'lou', url: 'https://push.example.net/lou', ...keys, now: clock.value });
			clock.value += DAY + 1_000;
			expect(claim(store, clock, ['kit', 'lou']).subscriptions.map((row) => row.userId)).toEqual(['lou']);
			expect(store.pushSubscriptionsOf('kit')).toHaveLength(1);
			for (let run = 0; run < 3; run++) {
				store.runCleanup(clock.value);
				clock.value += 2_000;
			}
			expect(store.pushSubscriptionsOf('kit')).toEqual([]);
			expect(store.pushSubscriptionsOf('lou')).toHaveLength(1);
		});
	});

	it('mutes for seconds or until changed, skips muted users without a wake slot, and moves mutes with /rename', async () => {
		const keys = await browserKeys();
		await withStore('push-mute', { push: { ...POLICY, wakesPerMessage: 1 } }, (store, clock) => {
			for (const userId of ['mo', 'ned']) {
				registerUser(store, clock, userId);
				store.registerPushSubscription({ userId, url: `https://push.example.net/${userId}`, ...keys, now: clock.value });
			}
			expect(store.setMute({ userId: 'mo', untilMs: clock.value + 90_500, now: clock.value })).toEqual({ changed: true, mute: 91 });
			expect(store.muteOf('mo', clock.value)).toBe(91);
			const first = claim(store, clock, ['mo', 'ned']);
			expect(first.subscriptions.map((row) => row.userId)).toEqual(['ned']);
			expect(first.muted).toBe(1);
			// It ends by itself, with no write.
			clock.value += 91_000;
			expect(store.muteOf('mo', clock.value)).toBeUndefined();
			expect(claim(store, clock, ['mo'], 'thread').subscriptions.map((row) => row.userId)).toEqual(['mo']);
			expect(store.setMute({ userId: 'mo', untilMs: MUTE_FOREVER, now: clock.value })).toEqual({ changed: true, mute: true });
			expect(store.setMute({ userId: 'mo', untilMs: MUTE_FOREVER, now: clock.value })).toEqual({ changed: false, mute: true });
			clock.value += 400 * 86_400_000;
			expect(store.muteOf('mo', clock.value)).toBe(true);
			// No identity, no mute.
			expect(store.setMute({ userId: 'guest_3', untilMs: MUTE_FOREVER, now: clock.value })).toEqual({ changed: false });
			store.renameIdentity({ from: 'mo', to: 'moe', now: clock.value });
			expect(store.muteOf('mo', clock.value)).toBeUndefined();
			expect(store.muteOf('moe', clock.value)).toBe(true);
			store.purgeUsers({ userIds: ['moe'], now: clock.value });
			registerUser(store, clock, 'moe');
			expect(store.muteOf('moe', clock.value)).toBeUndefined();
			expect(store.setMute({ userId: 'moe', untilMs: null, now: clock.value })).toEqual({ changed: false });
		});
	});

	it('moves subscriptions with /rename, push_id kept, and deletes them with /purge', async () => {
		const keys = await browserKeys();
		await withStore('push-rename', config, (store, clock) => {
			registerUser(store, clock, 'eve');
			store.registerPushSubscription({ userId: 'eve', url: 'https://push.example.net/eve', ...keys, pushId: 'eve-laptop', now: clock.value });
			expect(claim(store, clock, ['eve']).subscriptions).toHaveLength(1);
			store.renameIdentity({ from: 'eve', to: 'eva', now: clock.value });
			expect(store.pushSubscriptionsOf('eve')).toEqual([]);
			expect(store.pushSubscriptionsOf('eva')).toEqual([{ url: 'https://push.example.net/eve', userId: 'eva', ...keys, pushId: 'eve-laptop', wake: ['mentions', 'replies'] }]);
			// The wake time moved too: Eva is still coalesced in general.
			expect(claim(store, clock, ['eva']).coalesced).toBe(1);
			store.purgeUsers({ userIds: ['eva'], now: clock.value });
			expect(store.pushSubscriptionsOf('eva')).toEqual([]);
		});
	});
});
