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
async function setAway(peer: Peer, idle: boolean): Promise<void> {
	peer.send({ method: 'status', params: { idle } });
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
	});

	it('tracks status idle per connection: it ends with idle false or an accepted message', async () => {
		const userId = unique('aldo');
		const peer = await signedIn(userId);
		const other = await signedIn(userId, true);
		try {
			expect(await awayOf(userId)).toEqual([false, false]);
			await setAway(peer, true);
			expect((await awayOf(userId)).sort()).toEqual([false, true]);
			// A notification only: a request gets the unsupported-method path and changes nothing.
			expect((await request(peer, 'idle-request', 'status', { idle: false })).error.code).toBe(-32601);
			// A room's idle is not implemented: a scoped update is ignored.
			peer.send({ method: 'status', params: { room_id: 'general', idle: false } });
			await request(peer, 'sync-scoped', 'me', {});
			expect((await awayOf(userId)).sort()).toEqual([false, true]);
			// A history page does not end it, nor a refused message; an accepted one does.
			await request(peer, 'history', 'history', { room_id: 'general' });
			expect((await request(peer, 'refused', 'message', { room_id: 'no-such-room', body: { text: 'x' } })).error.code).toBe(-32602);
			expect((await awayOf(userId)).sort()).toEqual([false, true]);
			await post(peer, 'back', { body: { text: 'back' } });
			expect(await awayOf(userId)).toEqual([false, false]);
			await setAway(peer, true);
			await setAway(peer, false);
			expect(await awayOf(userId)).toEqual([false, false]);
			// A malformed idle changes nothing; nor do unknown fields or `invisible`.
			// (Another connection: each malformed one counts as a policy violation.)
			await setAway(other, true);
			for (const params of [{ idle: 'no' }, { idle: 1 }, { invisible: true, other: 1 }]) {
				other.send({ method: 'status', params });
				await request(other, `sync-${JSON.stringify(params)}`, 'me', {});
				expect((await awayOf(userId)).sort(), JSON.stringify(params)).toEqual([false, true]);
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
			expect((await request(bob, 'activity-away', 'activity', { away: true })).result).toEqual({});
			expect(await awayOf(bobId)).toEqual([false]);
			// Nor do typing or a read cursor end idle.
			await setAway(carol, true);
			expect((await request(carol, 'typing', 'activity', { room_id: 'general', typing: 2 })).result).toEqual({});
			carol.send({ method: 'activity', params: { room_id: 'general', read_message_id: '1' } });
			expect(await awayOf(carolId)).toEqual([true]);
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
				await setAway(bob, true);
				expect(await awayOf(bobId)).toEqual([false]);
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

	it('wakes mentioned users whose every connection is away or gone, with the message in the push', async () => {
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
			expect(JSON.parse((await decryptPush(pushes[0].body, bobSub.browser)).plaintext).message.body).toEqual({ text: 'ping', mentions: [carolId, bobId] });
		} finally { alice.close(); bob.close(); carol.close(); dave.close(); }
	});

	it('keeps every payload within 3072 bytes, dropping mentions first', async () => {
		const pushes = capturePushes();
		const [aliceId, bobId] = [unique('alice'), unique('bob')];
		const alice = await signedIn(aliceId);
		const bob = await signedIn(bobId);
		try {
			const bobSub = await subscribe(bob, 'bob', 'p'.repeat(64));
			await setAway(bob, true);
			// Far more mentions than fit one payload (§4.7).
			const many = Array.from({ length: 60 }, (_, index) => `someone-${index}-${'x'.repeat(48)}`);
			await post(alice, 'crowd', { room_id: 'general', body: { text: '"quoted"\\'.repeat(40), mentions: [bobId, ...many] } });
			await vi.waitFor(() => expect(pushes).toHaveLength(1), { timeout: 5_000 });
			const plaintext = (await decryptPush(pushes[0].body, bobSub.browser)).plaintext;
			expect(new TextEncoder().encode(plaintext).byteLength).toBeLessThanOrEqual(3072);
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
	async function away(name: string, wake?: unknown): Promise<string> {
		const userId = unique(name);
		const peer = await signedIn(userId);
		const { url } = await subscribe(peer, userId, undefined, wake);
		peer.close();
		await vi.waitFor(async () => expect(await awayOf(userId)).toEqual([]));
		return url;
	}
	const userOf = (url: string) => url.slice('https://push.example.net/send/'.length).replace(/-[0-9a-f-]{36}$/, '');

	it('wakes each user only on registrations whose wake includes why they qualify', async () => {
		const pushes = capturePushes();
		const urls = {
			mentionsOnlyMentioned: await away('mm', ['mentions']),
			mentionsOnlyRepliedTo: await away('mr', ['mentions']),
			repliesOnlyRepliedTo: await away('rr', ['replies']),
			repliesOnlyMentioned: await away('rm', ['replies']),
			nothing: await away('none', []),
			both: await away('both'),
			attended: '',
			control: await away('ctrl'),
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
			await setAway(bob, true);
			await setAway(bobToo, true);
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
			// 0 ends it: `you` without mute, and pushes again (once Bob is idle again).
			bob.send({ method: 'status', params: { mute: 0 } });
			const ended = youOf(await drainTo(bobToo, 'sync-zero'));
			expect(ended).toHaveLength(1);
			expect(ended[0]).not.toHaveProperty('mute');
			await setAway(bob, true);
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
			expect((await awayOf(userId)).sort()).toEqual([false, true]);
			// The user's other connection hears of the mute.
			expect(youOf(await drainTo(first, 'sync-first'))[0]).toMatchObject({ user_id: userId, mute: true });
		} finally { first.close(); peer.close(); }
	});

	it('refuses malformed mutes and ignores guests\' mutes', async () => {
		const userId = unique('mal');
		for (const pair of [[-1, 1.5], ['3600', false]]) {
			const peer = await signedIn(userId, pair[0] !== -1);
			try {
				for (const mute of pair) peer.send({ method: 'status', params: { mute } });
				expect((await request(peer, 'me', 'me', {})).result.you).not.toHaveProperty('mute');
			} finally { peer.close(); }
		}
		const guest = await connect();
		try {
			await guest.next();
			await request(guest, 'auth', 'auth', { scheme: 'guest' });
			guest.send({ method: 'status', params: { mute: true } });
			expect((await request(guest, 'me', 'me', {})).result.you).not.toHaveProperty('mute');
		} finally { guest.close(); }
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
			await vi.waitFor(async () => expect(await awayOf(userId)).toEqual([]));
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

	it('charges pushes to pushesPerDay and wakes to the sender, skipping the rest until the next UTC day', async () => {
		const keys = await browserKeys();
		await withStore('push-daily', { push: { ...POLICY, pushesPerDay: 3, wakesPerSenderDay: 3, coalesceSeconds: 1 } }, (store, clock) => {
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
			// Sal's third woken user today is past wakesPerSenderDay; another sender still wakes.
			clock.value += 1_000;
			expect(claim(store, clock, ['di'], 'general', 'sal').subscriptions).toHaveLength(1);
			clock.value += 1_000;
			expect(claim(store, clock, ['ed'], 'general', 'sal')).toMatchObject({ subscriptions: [], skipped: 2 });
		});
	});

	it('forgets a gone registration by endpoint and keys, keeping a fresh one', async () => {
		const [old, fresh] = [await browserKeys(), await browserKeys()];
		await withStore('push-gone', config, (store, clock) => {
			registerUser(store, clock, 'ida');
			registerUser(store, clock, 'jon');
			const url = 'https://push.example.net/shared';
			store.registerPushSubscription({ userId: 'ida', url, ...old, now: clock.value });
			store.registerPushSubscription({ userId: 'jon', url, ...fresh, now: clock.value });
			store.forgetPushSubscriptions([{ url, p256dh: old.p256dh }], clock.value);
			expect(store.pushSubscriptionsOf('ida')).toEqual([]);
			expect(store.pushSubscriptionsOf('jon').map((row) => row.p256dh)).toEqual([fresh.p256dh]);
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
			expect(store.setMute({ userId: 'mo', untilMs: clock.value + 90_500, now: clock.value })).toBe(true);
			expect(store.muteOf('mo', clock.value)).toBe(91);
			const first = claim(store, clock, ['mo', 'ned']);
			expect(first.subscriptions.map((row) => row.userId)).toEqual(['ned']);
			expect(first.muted).toBe(1);
			// It ends by itself, with no write.
			clock.value += 91_000;
			expect(store.muteOf('mo', clock.value)).toBeUndefined();
			expect(claim(store, clock, ['mo'], 'thread').subscriptions.map((row) => row.userId)).toEqual(['mo']);
			expect(store.setMute({ userId: 'mo', untilMs: MUTE_FOREVER, now: clock.value })).toBe(true);
			expect(store.setMute({ userId: 'mo', untilMs: MUTE_FOREVER, now: clock.value })).toBe(false);
			clock.value += 400 * 86_400_000;
			expect(store.muteOf('mo', clock.value)).toBe(true);
			// No identity, no mute.
			expect(store.setMute({ userId: 'guest_3', untilMs: MUTE_FOREVER, now: clock.value })).toBe(false);
			store.renameIdentity({ from: 'mo', to: 'moe', now: clock.value });
			expect(store.muteOf('mo', clock.value)).toBeUndefined();
			expect(store.muteOf('moe', clock.value)).toBe(true);
			store.purgeUsers({ userIds: ['moe'], now: clock.value });
			registerUser(store, clock, 'moe');
			expect(store.muteOf('moe', clock.value)).toBeUndefined();
			expect(store.setMute({ userId: 'moe', untilMs: null, now: clock.value })).toBe(false);
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
