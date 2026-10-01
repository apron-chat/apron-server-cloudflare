import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UPLOAD_POLICY } from '../src/budget';
import { sniffImage } from '../src/image';
import { signUploadToken, verifyUploadToken } from '../src/upload-token';
import { UPLOAD_WRITE_GRACE_MS, type Store } from '../src/store';
import { connect as open, exchange, request, until, type Frame, type Peer } from './helpers/socket';
import { errorCode, expectRetryAfter, withStore, type TestClock } from './helpers/store';

const MEDIA = 'https://media.test';
const UPLOADS = { ...UPLOAD_POLICY!, mediaOrigin: MEDIA };
const stub = () => env.DEMO.getByName('public-demo-v1');
const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

/** A PNG header of the given size: all the sniffer reads. */
function png(width = 1, height = 1, bytes = 64): Uint8Array {
	const data = new Uint8Array(bytes);
	data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(data.buffer).setUint32(16, width);
	new DataView(data.buffer).setUint32(20, height);
	return data;
}

function register(store: Store, clock: TestClock, userId: string): void {
	store.registerIdentity({
		userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: clock.value, ipKey: `ip-${userId}`,
		credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
	});
}

function post(store: Store, clock: TestClock, userId: string, params: Record<string, unknown>) {
	return store.commitMutation({ userId, ipKey: `ip-${userId}`, method: 'message', now: clock.value, params, identity: { user_id: userId, name: `Name of ${userId}` } });
}

type Write = { key: string; max_bytes: number; expires_ms: number };
const writeOf = (result: Record<string, unknown>, index = 0) => (result.embeds as Array<{ embed_id: string; write: Write }>)[index];

describe('store uploads', () => {
	it('answers a retried post with the current state: the write grant only while the write is still open (§1.2)', async () => {
		await withStore('uploads-retry', { uploads: UPLOADS }, (store, clock) => {
			register(store, clock, 'rita');
			const params = { body: { text: 'retried', embeds: [{ kind: 'upload', title: 'dot.png' }] } };
			const send = () => store.commitMutation({ userId: 'rita', ipKey: 'ip-rita', requestId: 'retry-1', method: 'message', now: clock.value, params, identity: { user_id: 'rita', name: 'Name of rita' } });
			const first = send();
			const write = writeOf(first.result);
			// Before the write, a retry gets the same grant, and nothing is executed again.
			const early = send();
			expect(early.deduplicated).toBe(true);
			expect(early.broadcasts).toEqual([]);
			expect(early.result).toEqual(first.result);
			expect(store.claimUpload(write.write.key, clock.value)).toBe(true);
			store.finishUpload({ key: write.write.key, ok: true, bytes: 64, contentType: 'image/png' }, clock.value);
			// Once the write is done, the retry names the message and embed, without a grant.
			const late = send();
			expect(late.deduplicated).toBe(true);
			expect(late.result).toEqual({ message_id: first.result.message_id, embeds: [{ embed_id: write.embed_id, kind: 'upload' }] });
		});
	});

	it('gives every embed an id, starts pending uploads, and keeps what the server owns on a save', async () => {
		await withStore('uploads-identity', { uploads: UPLOADS }, (store, clock) => {
			register(store, clock, 'alice');
			const created = post(store, clock, 'alice', { body: { text: 'look', embeds: [{ kind: 'link', url: 'https://example.com' }, { kind: 'upload', title: 'dot.png', url: 'https://evil.example/x', og: { image: { url: 'https://evil.example/x' } } }] } });
			const embeds = created.message!.body!.embeds as Array<Record<string, unknown>>;
			expect(embeds.map((embed) => embed.embed_id)).toEqual([expect.stringMatching(/^embed_/), expect.stringMatching(/^embed_/)]);
			// A new upload keeps only its title until the write finishes (§4.6.4).
			expect(embeds[1]).toEqual({ embed_id: embeds[1].embed_id, kind: 'upload', title: 'dot.png' });
			const write = writeOf(created.result);
			expect(write.embed_id).toBe(embeds[1].embed_id);
			expect(write.write).toMatchObject({ key: expect.stringMatching(/^f\/[A-Za-z0-9_-]{22}$/), max_bytes: UPLOADS.maxFileBytes });
			expect(created.uploads).toHaveLength(1);

			// The write finishes: a server snapshot completes the embed.
			expect(store.claimUpload(write.write.key, clock.value)).toBe(true);
			expect(store.claimUpload(write.write.key, clock.value)).toBe(false);
			const finished = store.finishUpload({ key: write.write.key, ok: true, bytes: 64, contentType: 'image/png', width: 1, height: 1 }, clock.value);
			expect(finished.accepted).toBe(true);
			const completed = (finished.broadcasts[0].params.body as { embeds: Array<Record<string, unknown>> }).embeds[1];
			const url = `${MEDIA}/${write.write.key}`;
			expect(completed).toEqual({ embed_id: embeds[1].embed_id, kind: 'upload', title: 'dot.png', url, og: { title: 'dot.png', image: { url, type: 'image/png', width: 1, height: 1 } } });
			expect(store.finishUpload({ key: write.write.key, ok: true, bytes: 64, contentType: 'image/png' }, clock.value).accepted).toBe(false);

			// A save sends embeds back by id; the server restores the upload's url and og.
			clock.value += 1_000;
			const messageId = created.result.message_id as string;
			const saved = post(store, clock, 'alice', { message_id: messageId, body: { text: 'look again', embeds: [{ embed_id: embeds[1].embed_id, kind: 'upload', url: 'https://evil.example/y', title: 'renamed.png' }] } });
			expect((saved.message!.body!.embeds as unknown[])[0]).toEqual({ ...completed, title: 'renamed.png' });
			// The link embed was left out and is gone; an unknown id is refused.
			expect(errorCode(() => post(store, clock, 'alice', { message_id: messageId, body: { text: 'x', embeds: [{ embed_id: 'embed_nope', kind: 'link' }] } }))).toBe('invalid_params');
			// Leaving the upload out removes it, and its object is the caller's to delete.
			const removed = post(store, clock, 'alice', { message_id: messageId, body: { text: 'no image' } });
			expect(removed.deletedUploads).toEqual([write.write.key]);
			// Guests cannot upload.
			expect(errorCode(() => post(store, clock, 'guest_1', { body: { embeds: [{ kind: 'upload' }] } }))).toBe('denied');
		});
	});

	it('fails a write that never comes, a failed one, and one whose embed is gone', async () => {
		await withStore('uploads-expiry', { uploads: UPLOADS }, (store, clock) => {
			register(store, clock, 'bob');
			const withText = post(store, clock, 'bob', { body: { text: 'caption', embeds: [{ kind: 'upload' }] } });
			const alone = post(store, clock, 'bob', { body: { embeds: [{ kind: 'upload' }] } });
			// A failed write publishes the message without the embed (§4.6.3).
			const failedKey = writeOf(withText.result).write.key;
			expect(store.claimUpload(failedKey, clock.value)).toBe(true);
			const failed = store.finishUpload({ key: failedKey, ok: false }, clock.value);
			expect(failed.accepted).toBe(false);
			expect(failed.deletedUploads).toEqual([failedKey]);
			expect(failed.broadcasts[0].params).toMatchObject({ message_id: withText.result.message_id, body: { text: 'caption', embeds: [] } });
			// Past its window and grace, a write never started is failed by the sweep;
			// a message left with nothing is a tombstone.
			expect(store.expirePendingUploads(clock.value)).toMatchObject({ broadcasts: [], next: writeOf(alone.result).write.expires_ms + UPLOAD_WRITE_GRACE_MS });
			clock.value += UPLOADS.writeWindowSeconds * 1_000 + UPLOAD_WRITE_GRACE_MS + 1;
			expect(store.claimUpload(writeOf(alone.result).write.key, clock.value)).toBe(false);
			const expired = store.expirePendingUploads(clock.value);
			expect(expired.broadcasts).toHaveLength(1);
			expect(expired.broadcasts[0].params).toMatchObject({ message_id: alone.result.message_id, deleted: true });
			expect(expired.broadcasts[0].params.body).toBeUndefined();
			expect(expired.next).toBeUndefined();
			// A message deleted while its write was in flight does not take the object.
			clock.value += 1_000;
			const deleted = post(store, clock, 'bob', { body: { text: 'soon gone', embeds: [{ kind: 'upload' }] } });
			const key = writeOf(deleted.result).write.key;
			expect(store.claimUpload(key, clock.value)).toBe(true);
			expect(post(store, clock, 'bob', { message_id: deleted.result.message_id, deleted: true }).deletedUploads).toEqual([key]);
			expect(store.finishUpload({ key, ok: true, bytes: 10, contentType: 'image/png' }, clock.value).accepted).toBe(false);
		});
	});

	it('charges daily upload counts and the stored-bytes cap', async () => {
		await withStore('uploads-quota', { uploads: { ...UPLOADS, uploadsPerUserDay: 2, uploadsPerDay: 3, storedBytesCap: 3 * UPLOADS.maxFileBytes + UPLOADS.maxAvatarBytes } }, (store, clock) => {
			register(store, clock, 'carol');
			register(store, clock, 'dave');
			post(store, clock, 'carol', { body: { embeds: [{ kind: 'upload' }, { kind: 'upload' }] } });
			let error: unknown;
			try { post(store, clock, 'carol', { body: { embeds: [{ kind: 'upload' }] } }); } catch (caught) { error = caught; }
			expectRetryAfter(error);
			expect((error as Error).message).toBe('Daily upload limit reached');
			post(store, clock, 'dave', { body: { embeds: [{ kind: 'upload' }] } });
			try { post(store, clock, 'dave', { body: { embeds: [{ kind: 'upload' }] } }); } catch (caught) { error = caught; }
			expect((error as Error).message).toBe('Uploads are closed until the daily reset');
			// A new day resets the counts, but the bytes still held count against the cap.
			clock.value += 86_400_000;
			try { post(store, clock, 'dave', { body: { embeds: [{ kind: 'upload' }] } }); } catch (caught) { error = caught; }
			expect((error as Error).message).toBe('Upload storage is full; try again later');
			store.startAvatarUpload({ userId: 'dave', now: clock.value });
		});
	});

	it('refuses new uploads while an admin has turned them off', async () => {
		await withStore('uploads-off', { uploads: UPLOADS }, (store, clock) => {
			register(store, clock, 'frank');
			expect(store.toggle('uploads', clock.value)).toBeUndefined();
			store.setToggle('uploads', false, clock.value);
			expect(store.toggle('uploads', clock.value)).toBe(false);
			expect(errorCode(() => post(store, clock, 'frank', { body: { embeds: [{ kind: 'upload' }] } }))).toBe('denied');
			expect(errorCode(() => store.startAvatarUpload({ userId: 'frank', now: clock.value }))).toBe('denied');
			// Other embeds still post.
			post(store, clock, 'frank', { body: { embeds: [{ kind: 'link', url: 'https://example.com' }] } });
			store.setToggle('uploads', undefined, clock.value);
			expect(store.toggle('uploads', clock.value)).toBeUndefined();
			post(store, clock, 'frank', { body: { embeds: [{ kind: 'upload' }] } });
		});
	});

	it('sets, replaces, refreshes, clears, and expires avatars, shown in identities and member lists', async () => {
		await withStore('uploads-avatar', { uploads: UPLOADS }, (store, clock) => {
			register(store, clock, 'erin');
			const setAvatar = () => {
				const upload = store.startAvatarUpload({ userId: 'erin', now: clock.value });
				expect(upload.key).toMatch(/^a\//);
				expect(upload.maxBytes).toBe(UPLOADS.maxAvatarBytes);
				store.claimUpload(upload.key, clock.value);
				return { upload, finished: store.finishUpload({ key: upload.key, ok: true, bytes: 100, contentType: 'image/webp' }, clock.value) };
			};
			const first = setAvatar();
			expect(first.finished).toMatchObject({ accepted: true, broadcasts: [], avatar: { userId: 'erin', url: `${MEDIA}/${first.upload.key}` }, deletedUploads: [] });
			expect(store.getIdentity('erin')!.avatar).toBe(`${MEDIA}/${first.upload.key}`);
			expect(store.roomMembers(['general'], 10, clock.value).get('general')).toContainEqual({ user_id: 'erin', name: 'Name of erin', avatar: `${MEDIA}/${first.upload.key}` });
			// A new avatar replaces the old one, whose object goes.
			const second = setAvatar();
			expect(second.finished.deletedUploads).toEqual([first.upload.key]);
			// Not due for a refresh until the last week before it expires.
			expect(store.avatarRefreshDue('erin', clock.value)).toBeNull();
			clock.value += (UPLOADS.avatarRetentionSeconds - UPLOADS.avatarRefreshSeconds) * 1_000 + 1;
			expect(store.avatarRefreshDue('erin', clock.value)).toBe(second.upload.key);
			store.renewAvatar({ userId: 'erin', key: second.upload.key, now: clock.value });
			expect(store.avatarRefreshDue('erin', clock.value)).toBeNull();
			// Past its expiry it is no longer shown, and past the lifecycle lag cleanup forgets it.
			clock.value += UPLOADS.avatarRetentionSeconds * 1_000 + 1;
			expect(store.getIdentity('erin')!.avatar).toBeUndefined();
			expect(store.avatarRefreshDue('erin', clock.value)).toBeNull();
			clock.value += UPLOADS.lifecycleLagSeconds * 1_000;
			expect(store.cleanupUploads(clock.value)).toBe(1);
			// Clearing removes a live one.
			setAvatar();
			expect(store.clearAvatar({ userId: 'erin', now: clock.value }).changed).toBe(true);
			expect(store.clearAvatar({ userId: 'erin', now: clock.value })).toEqual({ changed: false, deletedUploads: [] });
		});
	});

	it('purges users and everything they left, rewriting records they share with others', async () => {
		await withStore('uploads-purge', { uploads: UPLOADS }, (store, clock, state) => {
			register(store, clock, 'mallory');
			register(store, clock, 'trent');
			const theirs = post(store, clock, 'mallory', { body: { text: 'spam', embeds: [{ kind: 'upload' }] } });
			const edited = theirs.result.message_id as string;
			post(store, clock, 'mallory', { message_id: edited, body: { text: 'more spam', embeds: [{ embed_id: (theirs.message!.body!.embeds as Array<{ embed_id: string }>)[0].embed_id, kind: 'upload' }] } });
			const kept = post(store, clock, 'trent', { body: { text: 'hello' } });
			const react = (userId: string, messageId: string) => store.commitMutation({ userId, ipKey: `ip-${userId}`, method: 'reactions', now: clock.value, params: { message_id: messageId, emojis: ['👍'] }, identity: { user_id: userId } });
			react('mallory', kept.result.message_id as string);
			react('trent', kept.result.message_id as string);
			react('trent', edited);
			// A move re-logs every reaction set on the message in one record.
			const thread = store.commitMutation({ userId: 'trent', ipKey: 'ip-trent', method: 'room_set', now: clock.value, params: { parent_room_id: 'general', title: 'T' }, identity: { user_id: 'trent' } });
			post(store, clock, 'trent', { message_id: kept.result.message_id, room_id: thread.room!.room_id, body: { text: 'hello' } });
			store.setRole({ userId: 'mallory', role: 'admin', on: true, now: clock.value });
			const before = store.countIdentities();

			const purged = store.purgeUsers({ userIds: ['mallory', 'bot_mallory'], now: clock.value });
			expect(purged).toEqual({ messages: 1, reactions: 1, deletedUploads: [writeOf(theirs.result).write.key] });
			expect(store.getIdentity('mallory')).toBeNull();
			expect(store.roles(clock.value).has('mallory')).toBe(false);
			expect(store.countIdentities()).toBe(before - 1);
			const sql = state.storage.sql;
			const records = sql.exec<{ kind: string; record_json: string }>('SELECT kind, record_json FROM records').toArray();
			expect(records.some((row) => row.record_json.includes('mallory'))).toBe(false);
			// trent's message and reaction sets stay, the move's record without mallory's set.
			const moved = records.filter((row) => row.kind === 'reactions').map((row) => JSON.parse(row.record_json)).find((record) => record.reactions.length > 0 && record.room_id === thread.room!.room_id);
			expect(moved.reactions.map((set: { from: { user_id: string } }) => set.from.user_id)).toEqual(['trent']);
			expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM message_state WHERE author_id = 'trent'").one().count).toBe(1);
			expect(sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM reaction_state').one().count).toBe(1);
			expect(sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM uploads').one().count).toBe(0);
			expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM memberships WHERE user_id = 'mallory'").one().count).toBe(0);
		});
	});
});

describe('upload tokens and image sniffing', () => {
	it('signs write tokens that expire and refuse any change', async () => {
		const grant = { key: 'f/AAAAAAAAAAAAAAAAAAAAAA', maxBytes: 1_000, expiresMs: 2_000_000 };
		const token = await signUploadToken('secret-0123456789abcdef0123456789', grant);
		expect(await verifyUploadToken('secret-0123456789abcdef0123456789', token, 1_000_000)).toEqual(grant);
		expect(await verifyUploadToken('secret-0123456789abcdef0123456789', token, 2_000_000)).toBeNull();
		expect(await verifyUploadToken('another-secret-0123456789abcdef012', token, 1_000_000)).toBeNull();
		expect(await verifyUploadToken('secret-0123456789abcdef0123456789', token.replace('.1000.', '.9999.'), 1_000_000)).toBeNull();
		expect(await verifyUploadToken('secret-0123456789abcdef0123456789', 'f.x.1.2.sig', 1_000_000)).toBeNull();
	});

	it('knows images by their bytes, with sizes where the header has them', () => {
		expect(sniffImage(png(640, 480))).toEqual({ type: 'image/png', width: 640, height: 480 });
		const gif = new Uint8Array([...new TextEncoder().encode('GIF89a'), 0x20, 0x00, 0x10, 0x00]);
		expect(sniffImage(gif)).toEqual({ type: 'image/gif', width: 32, height: 16 });
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03]);
		expect(sniffImage(jpeg)).toEqual({ type: 'image/jpeg', width: 64, height: 48 });
		const webp = new Uint8Array(30);
		webp.set(new TextEncoder().encode('RIFF'), 0);
		webp.set(new TextEncoder().encode('WEBPVP8X'), 8);
		webp.set([99, 0, 0, 49, 0, 0], 24);
		expect(sniffImage(webp)).toEqual({ type: 'image/webp', width: 100, height: 50 });
		expect(sniffImage(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull();
		expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
	});
});

describe('uploads end to end', () => {
	let nextIp = 1;
	const ADMIN_TOKEN = 'admin-token-0123456789abcdef';
	const connect = (origin: string | null = 'http://localhost:5173') => open({ ip: `203.0.113.${nextIp++}`, origin });

	async function setAdminToken(value: string | undefined): Promise<void> {
		await runInDurableObject(stub(), (instance) => {
			const server = instance as unknown as { config: { adminToken?: string } };
			server.config = { ...server.config, adminToken: value };
		});
	}
	beforeEach(() => setAdminToken(ADMIN_TOKEN));
	afterEach(() => setAdminToken(undefined));

	async function signedIn(userId: string): Promise<Peer> {
		const token = await runInDurableObject(stub(), async (instance) => {
			const runtime = instance as unknown as { store: Store; issueSession(userId: string, origin: string, now: number): Promise<string> };
			runtime.store.registerIdentity({
				userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
				credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
			});
			return runtime.issueSession(userId, 'http://localhost:5173', Date.now());
		});
		const peer = await connect();
		await peer.next();
		expect((await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
		return peer;
	}

	const put = (url: string, body: Uint8Array) => SELF.fetch(url, { method: 'PUT', body: body as Uint8Array<ArrayBuffer>, headers: { 'Content-Length': String(body.byteLength) } });
	const media = () => env.MEDIA!;
	const isMessage = (messageId: string) => (frame: Frame) => frame.method === 'message' && frame.params.message_id === messageId;

	it('writes an image to write_url once and publishes the completed embed', async () => {
		const userId = unique('uploader');
		const peer = await signedIn(userId);
		try {
			const { frame, skipped } = await exchange(peer, 'post', 'message', { body: { text: 'a dot', embeds: [{ kind: 'upload', title: 'dot.png' }] } });
			const messageId = frame.result.message_id;
			// The broadcast came first, with the embed pending.
			expect(skipped.find(isMessage(messageId))!.params.body.embeds).toEqual([{ embed_id: expect.any(String), kind: 'upload', title: 'dot.png' }]);
			const [embed] = frame.result.embeds;
			expect(embed).toEqual({ embed_id: expect.any(String), kind: 'upload', write_url: expect.stringMatching(/^https:\/\/demo\.test\/w\/f\./) });

			const preflight = await SELF.fetch(embed.write_url, { method: 'OPTIONS' });
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
			expect((await put(embed.write_url.replace(/.$/, (last: string) => (last === 'A' ? 'B' : 'A')), png())).status).toBe(403);
			expect((await put(embed.write_url, png(4, 2))).status).toBe(204);
			const completed = (await until(peer, isMessage(messageId))).frame.params.body.embeds[0];
			expect(completed).toMatchObject({ embed_id: embed.embed_id, kind: 'upload', title: 'dot.png', url: expect.stringMatching(/^https:\/\/media\.test\/f\//), og: { title: 'dot.png', image: { type: 'image/png', width: 4, height: 2 } } });
			const key = completed.url.slice('https://media.test/'.length);
			const object = await media().get(key);
			expect(object?.httpMetadata?.contentType).toBe('image/png');
			// A write_url writes once.
			expect((await put(embed.write_url, png())).status).toBe(409);
			expect((await media().get(key))?.size).toBe(64);
			// Deleting the message deletes its image.
			await request(peer, 'delete', 'message', { message_id: messageId, deleted: true });
			await expect.poll(async () => await media().head(key)).toBeNull();
		} finally { peer.close(); }
	});

	it('refuses what is not an image and publishes the message without it', async () => {
		const peer = await signedIn(unique('uploader'));
		try {
			const { frame } = await exchange(peer, 'post', 'message', { body: { text: 'not an image', embeds: [{ kind: 'upload' }] } });
			const tooBig = new Uint8Array(UPLOAD_POLICY!.maxFileBytes + 1);
			expect((await put(frame.result.embeds[0].write_url, tooBig)).status).toBe(413);
			expect((await put(frame.result.embeds[0].write_url, new TextEncoder().encode('<script>alert(1)</script>'))).status).toBe(415);
			expect((await until(peer, isMessage(frame.result.message_id))).frame.params.body.embeds).toEqual([]);
		} finally { peer.close(); }
	});

	it('sets an avatar with /avatar, shows it in current user objects, and removes it with me', async () => {
		const userId = unique('avatar');
		const peer = await signedIn(userId);
		try {
			const started = await request(peer, 'avatar', 'command', { body: { text: '/avatar', embeds: [{ kind: 'upload' }] } });
			const [embed] = started.result.embeds;
			expect(embed.write_url).toMatch(/^https:\/\/demo\.test\/w\/a\./);
			expect((await put(embed.write_url, png())).status).toBe(204);
			const you = (await until(peer, (frame) => frame.method === 'user')).frame.params.you;
			expect(you).toEqual({ user_id: userId, name: `Name of ${userId}`, avatar: expect.stringMatching(/^https:\/\/media\.test\/a\//), roles: [] });
			expect((await request(peer, 'me', 'me', {})).result.you.avatar).toBe(you.avatar);
			// A message's author is a recorded object, without the avatar.
			const posted = await exchange(peer, 'post', 'message', { body: { text: 'hi' } });
			expect(posted.skipped.find(isMessage(posted.frame.result.message_id))!.params.from).toEqual({ user_id: userId, name: `Name of ${userId}` });
			const removed = await exchange(peer, 'remove', 'me', { avatar: '' });
			expect(removed.frame.result.you.avatar).toBe('');
			expect(removed.skipped.find((frame) => frame.method === 'user')!.params.you.avatar).toBe('');
			expect((await request(peer, 'bad', 'command', { body: { text: '/avatar' } })).error.code).toBe(-32602);
		} finally { peer.close(); }
	});

	/** Signs an existing user in on a new connection. */
	async function resume(userId: string): Promise<Peer> {
		const token = await runInDurableObject(stub(), (instance) => (instance as unknown as { issueSession(userId: string, origin: string, now: number): Promise<string> }).issueSession(userId, 'http://localhost:5173', Date.now()));
		const peer = await connect();
		await peer.next();
		expect((await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
		return peer;
	}

	/** Moves a user's avatar to one day before it expires. */
	const nearExpiry = (userId: string) => runInDurableObject(stub(), (_instance, state) => {
		const soon = Date.now() + 86_400_000;
		state.storage.sql.exec('UPDATE identities SET avatar_expires_ms = ? WHERE user_id = ?', soon, userId);
		state.storage.sql.exec("UPDATE uploads SET expires_ms = ? WHERE owner_id = ? AND purpose = 'avatar'", soon, userId);
		return state.storage.sql.exec<{ avatar_url: string }>('SELECT avatar_url FROM identities WHERE user_id = ?', userId).one().avatar_url;
	});
	const avatarExpiry = (userId: string) => runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ avatar_url: string; avatar_expires_ms: number }>('SELECT avatar_url, avatar_expires_ms FROM identities WHERE user_id = ?', userId).one());

	it('writes an avatar again when its owner signs in during its last week, and drops one whose object is gone', async () => {
		const userId = unique('regular');
		const first = await signedIn(userId);
		const started = await request(first, 'avatar', 'command', { body: { text: '/avatar', embeds: [{ kind: 'upload' }] } });
		expect((await put(started.result.embeds[0].write_url, png())).status).toBe(204);
		await until(first, (frame) => frame.method === 'user');
		first.close();
		const url = await nearExpiry(userId);
		const key = url.slice('https://media.test/'.length);
		const uploaded = (await media().head(key))!.uploaded.getTime();
		const second = await resume(userId);
		await expect.poll(async () => (await avatarExpiry(userId)).avatar_expires_ms).toBeGreaterThan(Date.now() + 29 * 86_400_000);
		expect((await media().head(key))!.uploaded.getTime()).toBeGreaterThanOrEqual(uploaded);
		second.close();
		// The bucket already deleted it: signing in removes the avatar.
		await nearExpiry(userId);
		await media().delete(key);
		const third = await resume(userId);
		try {
			await expect.poll(async () => (await avatarExpiry(userId)).avatar_url).toBe('');
			expect((await until(third, (frame) => frame.method === 'user')).frame.params.you.avatar).toBe('');
		} finally { third.close(); }
	});

	it('/toggle uploads turns uploads off and on for admins, saying which', async () => {
		const user = await signedIn(unique('toggler'));
		const admin = await connect(null);
		await admin.next();
		expect((await request(admin, 'auth', 'auth', { scheme: 'token', token: ADMIN_TOKEN })).result.you.user_id).toBe('admin');
		const notice = (skipped: Frame[]) => skipped.find((frame) => frame.params?.from?.user_id === '~private')!.params.body.text;
		const toggle = (id: string) => exchange(admin, id, 'command', { room_id: 'general', body: { text: '/toggle uploads' } });
		try {
			const off = await toggle('off');
			expect(off.frame.result).toEqual({});
			expect(notice(off.skipped)).toMatch(/^Uploads are now \*\*off\*\*/);
			const refused = await request(user, 'post', 'message', { body: { text: 'x', embeds: [{ kind: 'upload' }] } });
			expect(refused.error.message).toBe('Uploads are turned off here');
			expect((await request(user, 'avatar', 'command', { body: { text: '/avatar', embeds: [{ kind: 'upload' }] } })).error.code).toBe(-32602);
			const late = await connect();
			expect((await late.next()).params.capabilities).not.toContain('embed:upload');
			late.close();
			const on = await toggle('on');
			expect(notice(on.skipped)).toBe('Uploads are now **on**.');
			expect((await request(user, 'post2', 'message', { body: { text: 'y', embeds: [{ kind: 'upload' }] } })).result.embeds).toHaveLength(1);
			const fresh = await connect();
			expect((await fresh.next()).params.capabilities).toContain('embed:upload');
			fresh.close();
			expect((await request(user, 'nope', 'command', { body: { text: '/toggle uploads' } })).error.code).toBe(-32001);
			expect((await request(admin, 'bad', 'command', { room_id: 'general', body: { text: '/toggle typing' } })).error.message).toBe('Usage: /toggle activity|uploads');
		} finally { user.close(); admin.close(); }
	});

	it('/toggle activity turns typing relays and the activity cap off and on', async () => {
		const admin = await connect(null);
		await admin.next();
		expect((await request(admin, 'auth', 'auth', { scheme: 'token', token: ADMIN_TOKEN })).result.you.user_id).toBe('admin');
		const notice = (skipped: Frame[]) => skipped.find((frame) => frame.params?.from?.user_id === '~private')!.params.body.text;
		const toggle = (id: string) => exchange(admin, id, 'command', { room_id: 'general', body: { text: '/toggle activity' } });
		const guests = async () => {
			const alice = await connect();
			const server = await alice.next();
			const bob = await connect();
			await bob.next();
			await request(alice, 'auth', 'auth', { scheme: 'guest' });
			await request(bob, 'auth', 'auth', { scheme: 'guest' });
			return { alice, bob, caps: server.params.capabilities as string[] };
		};
		try {
			// Tests run with ACTIVITY=false: the first toggle turns it on.
			const on = await toggle('on');
			expect(notice(on.skipped)).toBe('Activity is now **on**: typing is relayed, and new connections are offered it.');
			const live = await guests();
			expect(live.caps).toContain('activity');
			live.alice.send({ method: 'activity', params: { room_id: 'general', typing: 5 } });
			expect((await until(live.bob, (frame) => frame.method === 'activity')).frame.params).toMatchObject({ room_id: 'general', typing: 5 });
			live.alice.close(); live.bob.close();
			// Back to the deployment's default: off again, and the override is gone.
			const off = await toggle('off');
			expect(notice(off.skipped)).toBe('Activity is now **off**: typing is no longer relayed, and new connections are not offered it.');
			const quiet = await guests();
			expect(quiet.caps).not.toContain('activity');
			expect((await request(quiet.alice, 'typing', 'activity', { room_id: 'general', typing: 5 })).error.code).toBe(-32601);
			quiet.alice.close(); quiet.bob.close();
			expect(await runInDurableObject(stub(), (instance) => (instance as unknown as { store: Store }).store.toggle('activity'))).toBeUndefined();
		} finally { admin.close(); }
	});

	it('/purge disconnects a user and deletes their content and uploads', async () => {
		const userId = unique('spammer');
		const spammer = await signedIn(userId);
		const admin = await connect(null);
		await admin.next();
		expect((await request(admin, 'auth', 'auth', { scheme: 'token', token: ADMIN_TOKEN })).result.you.user_id).toBe('admin');
		try {
			const { frame } = await exchange(spammer, 'post', 'message', { body: { text: 'buy now', embeds: [{ kind: 'upload' }] } });
			expect((await put(frame.result.embeds[0].write_url, png())).status).toBe(204);
			const url = (await until(spammer, isMessage(frame.result.message_id))).frame.params.body.embeds[0].url;
			const purged = await exchange(admin, 'purge', 'command', { room_id: 'general', body: { text: `/purge @${userId}` } });
			expect(purged.frame.result).toEqual({});
			expect(purged.skipped.find((candidate) => candidate.params?.from?.user_id === '~private')!.params.body.text).toBe(`Purged \`${userId}\`: 1 message, 0 reaction sets, 1 upload.`);
			await expect.poll(() => spammer.closed()?.code).toBe(1008);
			await expect.poll(async () => await media().head(url.slice('https://media.test/'.length))).toBeNull();
			const history = await request(admin, 'history', 'history', { room_id: 'general', limit: 50 });
			expect(JSON.stringify(history.result)).not.toContain(userId);
			expect((await request(admin, 'again', 'command', { room_id: 'general', body: { text: `/purge ${userId}` } })).error.code).toBe(-32602);
			expect((await request(admin, 'self', 'command', { room_id: 'general', body: { text: '/purge admin' } })).error.code).toBe(-32602);
		} finally { spammer.close(); admin.close(); }
	});
});
