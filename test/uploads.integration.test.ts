import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UPLOAD_POLICY } from '../src/budget';
import { sniffAudio } from '../src/audio';
import { sniffImage } from '../src/image';
import { fetchEntry } from '../src/index';
import { signUploadToken, verifyUploadToken } from '../src/upload-token';
import { Store, UPLOAD_WRITE_GRACE_MS, type EmojiDraft, type StoreError } from '../src/store';
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

/** A WebM header as MediaRecorder writes it: EBML with DocType "webm". */
function webm(bytes = 64): Uint8Array {
	const data = new Uint8Array(bytes);
	data.set([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...new TextEncoder().encode('webm')]);
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
			// A new upload keeps only its title until the write finishes (§4.8.4).
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

	it('completes a voice clip with og.audio, and keeps audio off avatars', async () => {
		await withStore('uploads-audio', { uploads: UPLOADS }, (store, clock) => {
			register(store, clock, 'vera');
			const created = post(store, clock, 'vera', { body: { embeds: [{ kind: 'upload', title: 'voice-message.webm' }] } });
			const write = writeOf(created.result);
			expect(store.claimUpload(write.write.key, clock.value)).toBe(true);
			const finished = store.finishUpload({ key: write.write.key, ok: true, bytes: 64, contentType: 'audio/webm' }, clock.value);
			expect(finished.accepted).toBe(true);
			const url = `${MEDIA}/${write.write.key}`;
			expect((finished.broadcasts[0].params.body as { embeds: unknown[] }).embeds[0]).toEqual({ embed_id: write.embed_id, kind: 'upload', title: 'voice-message.webm', url, og: { title: 'voice-message.webm', audio: { url, type: 'audio/webm' } } });

			const avatar = store.startAvatarUpload({ userId: 'vera', now: clock.value });
			expect(store.claimUpload(avatar.key, clock.value)).toBe(true);
			const refused = store.finishUpload({ key: avatar.key, ok: true, bytes: 64, contentType: 'audio/webm' }, clock.value);
			expect(refused).toMatchObject({ accepted: false, deletedUploads: [avatar.key] });
		});
	});

	it('fails a write that never comes, a failed one, and one whose embed is gone', async () => {
		await withStore('uploads-expiry', { uploads: UPLOADS }, (store, clock) => {
			register(store, clock, 'bob');
			const withText = post(store, clock, 'bob', { body: { text: 'caption', embeds: [{ kind: 'upload' }] } });
			const alone = post(store, clock, 'bob', { body: { embeds: [{ kind: 'upload' }] } });
			// A failed write publishes the message without the embed (§4.8.3).
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
		await withStore('uploads-quota', { uploads: { ...UPLOADS, uploadsPerUserDay: 2, uploadsPerDay: 3, storedBytesCap: 4 * UPLOADS.maxFileBytes + UPLOADS.maxAvatarBytes } }, (store, clock) => {
			register(store, clock, 'carol');
			register(store, clock, 'dave');
			register(store, clock, 'erin');
			const keys = (result: Record<string, unknown>) => [0, 1].map((index) => writeOf(result, index).write.key);
			const carols = keys(post(store, clock, 'carol', { body: { embeds: [{ kind: 'upload' }, { kind: 'upload' }] } }).result);
			let error: unknown;
			try { post(store, clock, 'carol', { body: { embeds: [{ kind: 'upload' }] } }); } catch (caught) { error = caught; }
			expectRetryAfter(error);
			expect((error as Error).message).toBe('Daily upload limit reached');
			// Its category for clients (`ext:limits`): only requests with uploads are held back.
			expect(error.data).toEqual({ ext: { limits: 'upload' } });
			// The server's count is charged by writes claimed, not uploads started:
			// Carol's two and Dave's two started, none written, leave it open.
			const daves = keys(post(store, clock, 'dave', { body: { embeds: [{ kind: 'upload' }, { kind: 'upload' }] } }).result);
			for (const key of [...carols, daves[0]]) expect(store.claimUpload(key, clock.value)).toBe(true);
			// Three claimed: Dave's other write is refused until the reset, and no upload starts.
			expect(store.claimUpload(daves[1], clock.value)).toBe('closed');
			try { post(store, clock, 'erin', { body: { embeds: [{ kind: 'upload' }] } }); } catch (caught) { error = caught; }
			expect((error as Error).message).toBe('Daily upload limit reached for the server');
			expect((error as StoreError).data).toEqual({ ext: { limits: 'upload' } });
			// A new day resets the counts, but the bytes still held count against the cap.
			clock.value += 86_400_000;
			try { post(store, clock, 'dave', { body: { embeds: [{ kind: 'upload' }] } }); } catch (caught) { error = caught; }
			expect((error as Error).message).toBe('Upload storage is full');
			expect((error as StoreError).data).toEqual({ ext: { limits: 'upload' } });
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
			expect(store.roomMembers(['general'], 10, clock.value).get('general')).toContainEqual({ user_id: 'erin', name: 'Name of erin', avatar: `${MEDIA}/${first.upload.key}`, roles: [] });
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
			// A new user_id is a user clients keep nothing for: /rename gets every
			// profile field to announce (§3.3), the live avatar included.
			const third = setAvatar();
			expect(store.renameIdentity({ from: 'erin', to: 'erin_2', now: clock.value })).toMatchObject({
				name: 'Name of erin', avatar: `${MEDIA}/${third.upload.key}`, roles: [],
			});
		});
	});

	it('keeps custom emoji in one catalog row as published, never expiring, and the server\'s rather than the uploader\'s (ext:emoji)', async () => {
		const config = { uploads: { ...UPLOADS, maxEmoji: 2 } };
		await withStore('uploads-emoji', config, (store, clock, state) => {
			register(store, clock, 'ada');
			const add = (key: string, side = 1) => {
				const upload = store.startEmojiUpload({ userId: 'ada', key, now: clock.value });
				expect(upload).toMatchObject({ key: expect.stringMatching(/^e\/[A-Za-z0-9_-]{22}$/), maxBytes: UPLOADS.maxEmojiBytes });
				expect(store.claimUpload(upload.key, clock.value)).toBe(true);
				const draft = store.emojiDraft({ add: { key: upload.key, ok: true, bytes: 64, contentType: 'image/png', width: side, height: side } }, clock.value)!;
				const committed = store.commitEmoji(draft, clock.value);
				expect(committed.applied).toBe(true);
				return { upload, draft, committed };
			};
			const stored = () => state.storage.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'emoji_catalog'").toArray()[0]?.value;
			expect(store.emojiCatalog(clock.value)).toBeNull();
			const a = add(':a:');
			expect(store.emojiCatalog(clock.value)).toEqual({ url: `${MEDIA}/${a.draft.key}`, keys: new Set([':a:']) });
			expect(a.draft.key).toMatch(/^e\/c\/[0-9a-f]{64}\.json$/);
			expect(stored()).toBe(a.draft.json);
			expect(JSON.parse(stored()!)).toEqual({ ':a:': { url: `${MEDIA}/${a.upload.key}`, width: 1, height: 1 } });
			const b = add(':b:');
			expect(b.committed.deletedUploads).toEqual([]);
			// At the cap a new key is denied; a known one may still be replaced,
			// releasing the catalog two back. Its old image stays with the
			// previous catalog, which refers to it.
			expect(errorCode(() => store.startEmojiUpload({ userId: 'ada', key: ':c:', now: clock.value }))).toBe('denied');
			const replaced = add(':a:', 2);
			expect(replaced.committed.deletedUploads).toEqual([a.draft.key]);
			expect(JSON.parse(stored()!)).toEqual({ ':a:': { url: `${MEDIA}/${replaced.upload.key}`, width: 2, height: 2 }, ':b:': { url: `${MEDIA}/${b.upload.key}`, width: 1, height: 1 } });
			// A draft made from a catalog that changed since does not apply.
			const stale = store.emojiDraft({ remove: ':b:' }, clock.value)!;
			expect(store.commitEmoji(store.emojiDraft({ remove: ':a:' }, clock.value)!, clock.value)).toEqual({ applied: true, deletedUploads: [a.upload.key, b.draft.key] });
			expect(store.commitEmoji(stale, clock.value)).toEqual({ applied: false, deletedUploads: [] });
			expect(store.emojiDraft({ remove: ':a:' }, clock.value)).toBeNull();
			// Emoji never expire, and purging the admin who added them leaves them.
			clock.value += 400 * 86_400_000;
			store.cleanupUploads(clock.value);
			expect(store.purgeUsers({ userIds: ['ada'], now: clock.value }).deletedUploads).toEqual([]);
			expect(store.emojiCatalog(clock.value)?.keys).toEqual(new Set([':b:']));
			// After a wake, the catalog is read again from its row.
			const woken = new Store(state, config, clock.clock);
			woken.initialize();
			expect(woken.emojiCatalog(clock.value)).toEqual(store.emojiCatalog(clock.value));
		});
	});

	it('keeps the server\'s title, description and avatar in _meta, the avatar the server\'s, never expiring and counted as stored (/server)', async () => {
		await withStore('uploads-server', { uploads: UPLOADS }, (store, clock, state) => {
			register(store, clock, 'ada');
			const sql = state.storage.sql;
			const storedBytes = () => Number(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'upload_bytes'").toArray()[0]?.value ?? 0);
			const meta = () => Object.fromEntries(sql.exec<{ key: string; value: string }>("SELECT key, value FROM _meta WHERE key LIKE 'server:%'").toArray().map((row) => [row.key, row.value]));
			expect(store.serverMetadata(clock.value)).toEqual({});
			store.setServerText('title', 'Chat Club', clock.value);
			store.setServerText('description', 'Talk about *clubs*.', clock.value);
			expect(store.serverMetadata(clock.value)).toEqual({ title: 'Chat Club', description: 'Talk about *clubs*.' });
			store.setServerText('description', undefined, clock.value);
			expect(meta()).toEqual({ 'server:title': 'Chat Club' });

			// An avatar is an avatar in size, kept under e/ as the server's.
			const start = () => {
				const upload = store.startServerAvatarUpload({ userId: 'ada', now: clock.value });
				expect(upload).toMatchObject({ key: expect.stringMatching(/^e\/[A-Za-z0-9_-]{22}$/), maxBytes: UPLOADS.maxAvatarBytes });
				expect(store.claimUpload(upload.key, clock.value)).toBe(true);
				return upload;
			};
			const first = start();
			expect(storedBytes()).toBe(UPLOADS.maxAvatarBytes);
			// It is no custom emoji, and only an image becomes the avatar.
			expect(store.emojiDraft({ add: { key: first.key, ok: true, bytes: 64, contentType: 'image/png' } }, clock.value)).toBeNull();
			const finished = store.finishUpload({ key: first.key, ok: true, bytes: 64, contentType: 'image/png' }, clock.value);
			expect(finished).toEqual({ accepted: true, broadcasts: [], serverAvatar: `${MEDIA}/${first.key}`, deletedUploads: [] });
			expect(storedBytes()).toBe(64);
			expect(sql.exec<{ owner_id: string; expires_ms: number }>('SELECT owner_id, expires_ms FROM uploads WHERE upload_key = ?', first.key).one()).toEqual({ owner_id: '~server', expires_ms: Number.MAX_SAFE_INTEGER });
			const audio = start();
			expect(store.finishUpload({ key: audio.key, ok: true, bytes: 64, contentType: 'audio/webm' }, clock.value)).toMatchObject({ accepted: false, deletedUploads: [audio.key] });
			// A new one replaces the old, whose object goes at once.
			const second = start();
			expect(store.finishUpload({ key: second.key, ok: true, bytes: 32, contentType: 'image/png' }, clock.value)).toEqual({ accepted: true, broadcasts: [], serverAvatar: `${MEDIA}/${second.key}`, deletedUploads: [first.key] });
			expect(storedBytes()).toBe(32);

			// It never expires, and renaming or purging the admin who set it leaves it.
			clock.value += 400 * 86_400_000;
			store.cleanupUploads(clock.value);
			store.renameIdentity({ from: 'ada', to: 'ada_2', now: clock.value });
			expect(store.purgeUsers({ userIds: ['ada_2'], now: clock.value }).deletedUploads).toEqual([]);
			expect(store.serverMetadata(clock.value)).toEqual({ title: 'Chat Club', avatar: `${MEDIA}/${second.key}` });
			expect(storedBytes()).toBe(32);

			// After a wake, the values are read again from their rows.
			const woken = new Store(state, { uploads: UPLOADS }, clock.clock);
			woken.initialize();
			expect(woken.serverMetadata(clock.value)).toEqual({ title: 'Chat Club', avatar: `${MEDIA}/${second.key}` });
			// Clearing the avatar releases its image.
			expect(woken.clearServerAvatar(clock.value)).toEqual({ changed: true, deletedUploads: [second.key] });
			expect(woken.clearServerAvatar(clock.value)).toEqual({ changed: false, deletedUploads: [] });
			expect(storedBytes()).toBe(0);
			expect(meta()).toEqual({ 'server:title': 'Chat Club' });
		});
	});

	it('keeps a replaced or removed emoji image with the previous catalog, and releases both at the next change (ext:emoji)', async () => {
		const config = { uploads: { ...UPLOADS, maxEmoji: 4 } };
		await withStore('uploads-emoji-superseded', config, (store, clock, state) => {
			register(store, clock, 'ada');
			const add = (key: string, bytes: number) => {
				const upload = store.startEmojiUpload({ userId: 'ada', key, now: clock.value });
				expect(store.claimUpload(upload.key, clock.value)).toBe(true);
				return commit(store.emojiDraft({ add: { key: upload.key, ok: true, bytes, contentType: 'image/png' } }, clock.value)!, upload.key);
			};
			const remove = (key: string) => commit(store.emojiDraft({ remove: key }, clock.value)!);
			const commit = (draft: EmojiDraft, image?: string) => {
				const committed = store.commitEmoji(draft, clock.value);
				expect(committed.applied).toBe(true);
				// The stored-bytes count is always the sum of the rows kept.
				expect(storedBytes()).toBe(rowBytes());
				return { image, catalog: draft.key, deleted: committed.deletedUploads };
			};
			const sql = <T extends Record<string, SqlStorageValue>>(query: string) => state.storage.sql.exec<T>(query).toArray();
			const storedBytes = () => Number(sql<{ value: string }>("SELECT value FROM _meta WHERE key = 'upload_bytes'")[0]?.value ?? 0);
			const rowBytes = () => sql<{ total: number | null }>('SELECT SUM(bytes) AS total FROM uploads')[0].total ?? 0;
			const states = () => Object.fromEntries(sql<{ upload_key: string; state: string }>('SELECT upload_key, state FROM uploads').map((row) => [row.upload_key, row.state]));
			const previous = () => sql<{ value: string }>("SELECT value FROM _meta WHERE key = 'emoji_catalog_previous'")[0]?.value;

			const x = add(':x:', 64);
			const y = add(':y:', 100);
			expect(y.deleted).toEqual([]);
			expect(storedBytes()).toBe(164);
			// Removing the key just added returns the catalog to the one before:
			// that catalog is current again, so nothing goes, and :y:'s image
			// stays, with its bytes, while the previous catalog refers to it.
			const back = remove(':y:');
			expect(back.catalog).toBe(x.catalog);
			expect(back.deleted).toEqual([]);
			expect(previous()).toBe(y.catalog);
			expect(states()).toEqual({ [x.image!]: 'done', [y.image!]: 'superseded' });
			expect(storedBytes()).toBe(164);
			// The next change releases that catalog and the image only it had.
			const empty = remove(':x:');
			expect(empty.catalog).toBeNull();
			expect(empty.deleted).toEqual([y.image, y.catalog]);
			expect(previous()).toBe(x.catalog);
			expect(states()).toEqual({ [x.image!]: 'superseded' });
			expect(storedBytes()).toBe(64);
			const z = add(':z:', 10);
			expect(z.deleted).toEqual([x.image, x.catalog]);
			expect(previous()).toBeUndefined();
			expect(states()).toEqual({ [z.image!]: 'done' });
			// Replacing twice: each image goes one change after it was replaced.
			const z2 = add(':z:', 20);
			expect(z2.deleted).toEqual([]);
			expect(states()).toEqual({ [z.image!]: 'superseded', [z2.image!]: 'done' });
			expect(storedBytes()).toBe(30);
			const z3 = add(':z:', 30);
			expect(z3.deleted).toEqual([z.image, z.catalog]);
			expect(states()).toEqual({ [z2.image!]: 'superseded', [z3.image!]: 'done' });
			expect(storedBytes()).toBe(50);
			// A superseded image counts against the stored-bytes cap, and not
			// against maxEmoji; it is the server's, so purges and expiry leave it.
			clock.value += 400 * 86_400_000;
			store.cleanupUploads(clock.value);
			expect(store.purgeUsers({ userIds: ['ada'], now: clock.value }).deletedUploads).toEqual([]);
			expect(states()).toEqual({ [z2.image!]: 'superseded', [z3.image!]: 'done' });
			// It survives a wake, and the next change after it releases it.
			const woken = new Store(state, config, clock.clock);
			woken.initialize();
			const committed = woken.commitEmoji(woken.emojiDraft({ remove: ':z:' }, clock.value)!, clock.value);
			expect(committed).toEqual({ applied: true, deletedUploads: [z2.image, z2.catalog] });
			expect(states()).toEqual({ [z3.image!]: 'superseded' });
			expect(storedBytes()).toBe(rowBytes());
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

	it('rewrites what a renamed user left to the new user_id, keeping recorded names', async () => {
		await withStore('uploads-rename', { uploads: UPLOADS }, (store, clock, state) => {
			register(store, clock, 'oscar');
			register(store, clock, 'peggy');
			const theirs = post(store, clock, 'oscar', { body: { text: 'mine', embeds: [{ kind: 'upload' }] } });
			const messageId = theirs.result.message_id as string;
			const embedId = (theirs.message!.body!.embeds as Array<{ embed_id: string }>)[0].embed_id;
			post(store, clock, 'oscar', { message_id: messageId, body: { text: 'mine, edited', embeds: [{ embed_id: embedId, kind: 'upload' }] } });
			const kept = post(store, clock, 'peggy', { body: { text: 'hello' } });
			const react = (userId: string, id: string) => store.commitMutation({ userId, ipKey: `ip-${userId}`, method: 'reactions', now: clock.value, params: { message_id: id, emojis: ['👍'] }, identity: { user_id: userId, name: `Name of ${userId}` } });
			react('oscar', kept.result.message_id as string);
			react('peggy', kept.result.message_id as string);
			react('peggy', messageId);
			// A move re-logs every reaction set on the message in one record.
			const thread = store.commitMutation({ userId: 'peggy', ipKey: 'ip-peggy', method: 'room_set', now: clock.value, params: { parent_room_id: 'general', title: 'T' }, identity: { user_id: 'peggy' } });
			post(store, clock, 'peggy', { message_id: kept.result.message_id, room_id: thread.room!.room_id, body: { text: 'hello' } });

			expect(store.renameIdentity({ from: 'oscar', to: 'oskar', now: clock.value }).name).toBe('Name of oscar');
			expect(store.accountingStatus().unsafe).toBe(false);
			const sql = state.storage.sql;
			const dump = (table: string) => sql.exec(`SELECT * FROM ${table}`).toArray().map((row) => JSON.stringify(row)).join('\n');
			for (const table of ['records', 'message_state', 'reaction_state', 'uploads', 'accepted_requests', 'principal_limits', 'memberships']) {
				expect(dump(table)).not.toMatch(/"oscar"|user:oscar/);
			}
			const records = sql.exec<{ kind: string; record_json: string }>('SELECT kind, record_json FROM records').toArray().map((row) => ({ kind: row.kind, record: JSON.parse(row.record_json) }));
			const messages = records.filter((row) => row.kind === 'message' && row.record.message_id === messageId);
			expect(messages).toHaveLength(2);
			for (const { record } of messages) expect(record.from).toEqual({ user_id: 'oskar', name: 'Name of oscar' });
			const moved = records.find((row) => row.kind === 'reactions' && row.record.room_id === thread.room!.room_id && row.record.reactions.length > 1);
			expect(moved!.record.reactions.map((set: { from: { user_id: string } }) => set.from.user_id).sort()).toEqual(['oskar', 'peggy']);
			expect(records.some((row) => row.kind === 'membership' && row.record.members.some((member: { user: { user_id: string } }) => member.user.user_id === 'oskar'))).toBe(true);
			expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM uploads WHERE owner_id = 'oskar'").one().count).toBe(1);
			expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM principal_limits WHERE principal_key = 'user:oskar'").one().count).toBeGreaterThan(0);

			// The message is still theirs to edit, and their reaction set theirs to change.
			const edited = post(store, clock, 'oskar', { message_id: messageId, body: { text: 'edited after the rename', embeds: [{ embed_id: embedId, kind: 'upload' }] } });
			expect(edited.message!.from.user_id).toBe('oskar');
			expect(react('oskar', kept.result.message_id as string).result).toBeDefined();
			expect(() => post(store, clock, 'peggy', { message_id: messageId, body: { text: 'not mine' } })).toThrow();
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
		expect(sniffImage(webm())).toBeNull();
	});

	it('knows voice clips by their containers: WebM, Ogg, and MP4', () => {
		const encode = (text: string) => new TextEncoder().encode(text);
		expect(sniffAudio(webm())).toEqual({ type: 'audio/webm' });
		const matroska = webm();
		matroska.set(encode('mkv '), 12);
		expect(sniffAudio(matroska)).toBeNull();
		const ogg = (codec: string) => {
			const data = new Uint8Array(64);
			data.set(encode('OggS'), 0);
			data[26] = 1;
			data[27] = 19;
			data.set(encode(codec), 28);
			return data;
		};
		expect(sniffAudio(ogg('OpusHead'))).toEqual({ type: 'audio/ogg' });
		expect(sniffAudio(ogg('\x01vorbis'))).toEqual({ type: 'audio/ogg' });
		expect(sniffAudio(ogg('\x80theora'))).toBeNull();
		const mp4 = (brand: string) => new Uint8Array([0, 0, 0, 24, ...encode('ftyp'), ...encode(brand), 0, 0, 0, 0]);
		expect(sniffAudio(mp4('iso5'))).toEqual({ type: 'audio/mp4' });
		expect(sniffAudio(mp4('M4A '))).toEqual({ type: 'audio/mp4' });
		expect(sniffAudio(mp4('heic'))).toBeNull();
		expect(sniffAudio(mp4('avif'))).toBeNull();
		expect(sniffAudio(png())).toBeNull();
		expect(sniffAudio(encode('<html><script>alert(1)</script>'))).toBeNull();
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

	it('writes a voice clip and publishes it as og.audio; an avatar refuses audio', async () => {
		const peer = await signedIn(unique('speaker'));
		try {
			const { frame } = await exchange(peer, 'post', 'message', { body: { embeds: [{ kind: 'upload', title: 'voice-message.webm' }] } });
			const messageId = frame.result.message_id;
			// As MediaRecorder types it, with its codecs (ext:media matches the type alone).
			const body = webm();
			const written = await SELF.fetch(frame.result.embeds[0].write_url, { method: 'PUT', body: body as Uint8Array<ArrayBuffer>, headers: { 'Content-Length': String(body.byteLength), 'Content-Type': 'audio/webm;codecs=opus' } });
			expect(written.status).toBe(204);
			const completed = (await until(peer, isMessage(messageId))).frame.params.body.embeds[0];
			expect(completed).toEqual({ embed_id: frame.result.embeds[0].embed_id, kind: 'upload', title: 'voice-message.webm', url: expect.stringMatching(/^https:\/\/media\.test\/f\//), og: { title: 'voice-message.webm', audio: { url: completed.url, type: 'audio/webm' } } });
			expect((await media().get(completed.url.slice('https://media.test/'.length)))?.httpMetadata?.contentType).toBe('audio/webm');

			const avatar = await request(peer, 'avatar', 'command', { body: { text: '/avatar', embeds: [{ kind: 'upload' }] } });
			expect((await put(avatar.result.embeds[0].write_url, webm())).status).toBe(415);
		} finally { peer.close(); }
	});

	it('refuses a write with 429 while the day\'s uploads are spent, leaving it pending to write after', async () => {
		const peer = await signedIn(unique('uploader'));
		// The server's daily count, as claimed writes charge it.
		const setGlobal = (count: number | null) => runInDurableObject(stub(), (_instance, state) => {
			if (count === null) return void state.storage.sql.exec("DELETE FROM principal_limits WHERE scope = 'upload' AND principal_key = 'global'");
			state.storage.sql.exec(
				`INSERT INTO principal_limits (scope, principal_key, day, uploads_day, updated_ms) VALUES ('upload', 'global', ?, ?, ?)
				 ON CONFLICT (scope, principal_key) DO UPDATE SET day = excluded.day, uploads_day = excluded.uploads_day`,
				new Date().toISOString().slice(0, 10), count, Date.now(),
			);
		});
		const before = await runInDurableObject(stub(), (_instance, state) =>
			state.storage.sql.exec<{ uploads_day: number }>("SELECT uploads_day FROM principal_limits WHERE scope = 'upload' AND principal_key = 'global'").toArray()[0]?.uploads_day ?? null);
		try {
			const { frame } = await exchange(peer, 'post', 'message', { body: { text: 'later', embeds: [{ kind: 'upload' }] } });
			await setGlobal(UPLOAD_POLICY!.uploadsPerDay);
			const closed = await put(frame.result.embeds[0].write_url, png());
			expect(closed.status).toBe(429);
			expect(Number(closed.headers.get('Retry-After'))).toBeGreaterThan(0);
			expect(closed.headers.get('Access-Control-Expose-Headers')).toContain('Retry-After');
			// Not used up: once the count allows it, the same write_url writes.
			await setGlobal(0);
			expect((await put(frame.result.embeds[0].write_url, png())).status).toBe(204);
		} finally {
			await setGlobal(before);
			peer.close();
		}
	});

	it('refuses what is not an image and publishes the message without it', async () => {
		const peer = await signedIn(unique('uploader'));
		try {
			const { frame } = await exchange(peer, 'post', 'message', { body: { text: 'not an image', embeds: [{ kind: 'upload' }] } });
			const tooBig = new Uint8Array(UPLOAD_POLICY!.maxFileBytes + 1);
			expect((await put(frame.result.embeds[0].write_url, tooBig)).status).toBe(413);
			// A declared type the server does not keep is refused before the body
			// is read (ext:media), and leaves the write open; parameters are ignored.
			const typed = (type: string, body: Uint8Array) => SELF.fetch(frame.result.embeds[0].write_url, { method: 'PUT', body: body as Uint8Array<ArrayBuffer>, headers: { 'Content-Length': String(body.byteLength), 'Content-Type': type } });
			expect((await typed('text/plain', png())).status).toBe(415);
			expect((await typed('image/svg+xml', png())).status).toBe(415);
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
			expect(you).toEqual({ user_id: userId, name: `Name of ${userId}`, avatar: expect.stringMatching(/^https:\/\/media\.test\/a\//), roles: [], ext: { permissions: { add_members: true } }, status: 'online' });
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

	it('drops an invisible user\'s missing avatar at sign-in without telling others they connected', async () => {
		const userId = unique('hidden');
		const first = await signedIn(userId);
		const started = await request(first, 'avatar', 'command', { body: { text: '/avatar', embeds: [{ kind: 'upload' }] } });
		expect((await put(started.result.embeds[0].write_url, png())).status).toBe(204);
		await until(first, (frame) => frame.method === 'user');
		expect((await request(first, 'invisible', 'me', { status: 'invisible' })).result.you.status).toBe('invisible');
		first.close();
		const watcher = await signedIn(unique('watcher'));
		try {
			await exchange(watcher, 'sync-before', 'me', {});
			// The bucket already deleted it: signing in removes the avatar.
			const url = await nearExpiry(userId);
			await media().delete(url.slice('https://media.test/'.length));
			const back = await resume(userId);
			try {
				await expect.poll(async () => (await avatarExpiry(userId)).avatar_url).toBe('');
				// The user's own connection is told; others are not, since an
				// invisible user's sign-in must not show.
				expect((await until(back, (frame) => frame.method === 'user')).frame.params.you).toMatchObject({ user_id: userId, avatar: '', status: 'invisible' });
				const seen = (await exchange(watcher, 'sync-after', 'me', {})).skipped;
				expect(JSON.stringify(seen)).not.toContain(userId);
			} finally { back.close(); }
		} finally { watcher.close(); }
	});

	it('advertises ext:media only where uploads are configured, naming the media origin only when it is not the server\'s', async () => {
		const setUploads = (uploads: unknown) => runInDurableObject(stub(), (instance) => {
			const server = instance as unknown as { config: { uploads?: unknown } };
			const original = server.config.uploads;
			server.config = { ...server.config, uploads };
			return original;
		});
		const announced = async () => {
			const peer = await connect();
			try { return (await peer.next()).params; } finally { peer.close(); }
		};
		const original = await setUploads(undefined);
		try {
			const bare = await announced();
			expect(bare.capabilities).not.toContain('ext:media');
			expect(bare.ext).not.toHaveProperty('media');
			await setUploads({ ...(original as object), mediaOrigin: 'https://demo.test' });
			const same = await announced();
			expect(same.ext.media).not.toHaveProperty('origins');
			expect(same.ext.media.upload['image/png']).toEqual({ max_bytes: UPLOAD_POLICY!.maxFileBytes });
			expect(same.ext.media.avatar['image/png']).toEqual({ max_bytes: UPLOAD_POLICY!.maxAvatarBytes });
			// Audio is kept as an attachment only, never as an avatar.
			expect(same.ext.media.upload['audio/webm']).toBeDefined();
			expect(same.ext.media.avatar['audio/webm']).toBeUndefined();
		} finally { await setUploads(original); }
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
			const offered = (await late.next()).params;
			expect(offered.capabilities).not.toContain('embed:upload');
			// Uploads already made are still served from the media origin, but nothing more is accepted.
			expect(offered.capabilities).toContain('ext:media');
			expect(offered.ext.media).toEqual({ origins: [MEDIA] });
			late.close();
			const on = await toggle('on');
			expect(notice(on.skipped)).toBe('Uploads are now **on**.');
			expect((await request(user, 'post2', 'message', { body: { text: 'y', embeds: [{ kind: 'upload' }] } })).result.embeds).toHaveLength(1);
			const fresh = await connect();
			const back = (await fresh.next()).params;
			expect(back.capabilities).toContain('embed:upload');
			expect(Object.keys(back.ext.media)).toEqual(['origins', 'upload', 'avatar', 'emoji']);
			fresh.close();
			expect((await request(user, 'nope', 'command', { body: { text: '/toggle uploads' } })).error.code).toBe(-32001);
			expect((await request(admin, 'bad', 'command', { room_id: 'general', body: { text: '/toggle typing' } })).error.message).toBe('Usage: /toggle activity|uploads|presence|addmember');
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
			// Only a notification: with an `id` it gets no reply either way (§1).
			quiet.alice.send({ id: 'typing', method: 'activity', params: { room_id: 'general', typing: 5 } });
			expect((await exchange(quiet.alice, 'after-typing', 'me', {})).skipped.filter((frame) => frame.id === 'typing')).toEqual([]);
			quiet.alice.close(); quiet.bob.close();
			expect(await runInDurableObject(stub(), (instance) => (instance as unknown as { store: Store }).store.toggle('activity'))).toBeUndefined();
		} finally { admin.close(); }
	});

	it('adds, replaces and removes custom emoji with /emoji, publishing each catalog at a new catalog_url (ext:emoji)', async () => {
		const admin = await connect(null);
		await admin.next();
		expect((await request(admin, 'auth', 'auth', { scheme: 'token', token: ADMIN_TOKEN })).result.you.user_id).toBe('admin');
		const watcher = await connect();
		const user = await signedIn(unique('reactor'));
		const keyOf = (url: string) => url.slice('https://media.test/'.length);
		const serverFrame = async (peer: Peer) => (await until(peer, (frame) => frame.method === 'server')).frame.params;
		const add = async (id: string, image: Uint8Array, key = ':partyparrot:') => {
			const started = await request(admin, id, 'command', { room_id: 'general', body: { text: `/emoji add ${key}`, embeds: [{ kind: 'upload' }] } });
			expect(started.result.embeds[0].write_url).toMatch(/^https:\/\/demo\.test\/w\/e\./);
			return put(started.result.embeds[0].write_url, image);
		};
		try {
			// No catalog yet: the extension is not offered.
			const before = (await watcher.next()).params;
			expect(before.capabilities).not.toContain('ext:emoji');
			expect(before.ext).not.toHaveProperty('emoji');
			// Admins only, listed in their /help; a key is :name:, with one image.
			const help = await exchange(admin, 'help', 'command', { room_id: 'general', body: { text: '/help' } });
			expect(help.skipped.find((frame) => frame.params?.from?.user_id === '~private')!.params.body.text).toContain('`/emoji add|remove :name:`');
			expect((await request(user, 'not-admin', 'command', { body: { text: '/emoji add :mine:', embeds: [{ kind: 'upload' }] } })).error.code).toBe(-32001);
			expect((await request(admin, 'no-colons', 'command', { body: { text: '/emoji add partyparrot', embeds: [{ kind: 'upload' }] } })).error.code).toBe(-32602);
			expect((await request(admin, 'no-image', 'command', { body: { text: '/emoji add :partyparrot:' } })).error.code).toBe(-32602);
			expect((await request(admin, 'unknown', 'command', { body: { text: '/emoji remove :partyparrot:' } })).error.code).toBe(-32602);
			// Not an image: refused, and nothing changes.
			const started = await request(admin, 'audio', 'command', { room_id: 'general', body: { text: '/emoji add :partyparrot:', embeds: [{ kind: 'upload' }] } });
			expect((await put(started.result.embeds[0].write_url, webm())).status).toBe(415);

			// An image becomes the key's, and every connection gets a new server frame.
			expect((await add('add', png(64, 32))).status).toBe(204);
			const first = await serverFrame(watcher);
			expect(first.capabilities).toContain('ext:emoji');
			const firstUrl: string = first.ext.emoji.catalog_url;
			expect(firstUrl).toMatch(/^https:\/\/media\.test\/e\/c\/[0-9a-f]{64}\.json$/);
			expect((await serverFrame(user)).ext.emoji.catalog_url).toBe(firstUrl);
			const published = await media().get(keyOf(firstUrl));
			expect(published?.httpMetadata).toMatchObject({ contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' });
			const catalog = await published!.json<Record<string, { url: string }>>();
			expect(catalog).toEqual({ ':partyparrot:': { url: expect.stringMatching(/^https:\/\/media\.test\/e\/[A-Za-z0-9_-]{22}$/), width: 64, height: 32 } });
			const firstImage = keyOf(catalog[':partyparrot:'].url);
			expect((await media().head(firstImage))?.httpMetadata?.cacheControl).toBe('public, max-age=31536000, immutable');
			// A new connection is offered the same catalog.
			const late = await connect();
			expect((await late.next()).params.ext.emoji).toEqual({ catalog_url: firstUrl });
			late.close();

			// Reactions take keys the catalog has, beside emoji sequences.
			const posted = await request(user, 'post', 'message', { body: { text: 'party' } });
			const reacted = await exchange(user, 'react', 'reactions', { message_id: posted.result.message_id, emojis: [':partyparrot:', '\u2764'] });
			expect(reacted.frame.result).toEqual({});
			expect(reacted.skipped.find((frame) => frame.method === 'reactions')!.params.reactions[0].emojis).toEqual([':partyparrot:', '\u2764\uFE0F']);
			expect((await request(user, 'unknown-key', 'reactions', { message_id: posted.result.message_id, emojis: [':nope:'] })).error.code).toBe(-32602);
			expect((await request(user, 'case', 'reactions', { message_id: posted.result.message_id, emojis: [':PartyParrot:'] })).error.code).toBe(-32602);

			// A new image replaces the old; the catalog before, and the old image
			// it refers to, stay until the next change.
			expect((await add('replace', png(16, 16))).status).toBe(204);
			const secondUrl: string = (await serverFrame(watcher)).ext.emoji.catalog_url;
			expect(secondUrl).not.toBe(firstUrl);
			const replaced = await (await media().get(keyOf(secondUrl)))!.json<Record<string, { url: string }>>();
			expect(Object.keys(replaced)).toEqual([':partyparrot:']);
			expect(replaced[':partyparrot:']).toMatchObject({ width: 16, height: 16 });
			expect(await media().head(firstImage)).not.toBeNull();
			expect(await media().head(keyOf(firstUrl))).not.toBeNull();

			// Removing the last one withdraws the extension, and deletes the
			// catalog two back with the image only it had; the removed image
			// stays with the catalog before.
			const removed = await exchange(admin, 'remove', 'command', { room_id: 'general', body: { text: '/emoji remove :partyparrot:' } });
			expect(removed.frame.result).toEqual({});
			expect(removed.skipped.find((frame) => frame.params?.from?.user_id === '~private')!.params.body.text).toBe('Removed the custom emoji `:partyparrot:`.');
			const after = await serverFrame(watcher);
			expect(after.capabilities).not.toContain('ext:emoji');
			expect(after.ext).not.toHaveProperty('emoji');
			await expect.poll(async () => await media().head(firstImage)).toBeNull();
			await expect.poll(async () => await media().head(keyOf(firstUrl))).toBeNull();
			expect(await media().head(keyOf(secondUrl))).not.toBeNull();
			expect(await media().head(keyOf(replaced[':partyparrot:'].url))).not.toBeNull();
			// A removed key stays in a set that has it, so its user can still change their other reactions; nobody takes it up.
			const kept = await exchange(user, 'kept', 'reactions', { message_id: posted.result.message_id, emojis: [':partyparrot:'] });
			expect(kept.frame.result).toEqual({});
			expect(kept.skipped.find((frame) => frame.method === 'reactions')!.params.reactions[0].emojis).toEqual([':partyparrot:']);
			expect((await request(admin, 'taken-up', 'reactions', { message_id: posted.result.message_id, emojis: [':partyparrot:'] })).error.code).toBe(-32602);
			expect((await request(user, 'cleared', 'reactions', { message_id: posted.result.message_id, emojis: [] })).result).toEqual({});
			expect((await request(user, 'gone', 'reactions', { message_id: posted.result.message_id, emojis: [':partyparrot:'] })).error.code).toBe(-32602);

			// The next change deletes them; removing that emoji again leaves the catalog empty.
			expect((await add('other', png(), ':confetti:')).status).toBe(204);
			expect((await serverFrame(watcher)).capabilities).toContain('ext:emoji');
			await expect.poll(async () => await media().head(keyOf(replaced[':partyparrot:'].url))).toBeNull();
			await expect.poll(async () => await media().head(keyOf(secondUrl))).toBeNull();
			expect((await request(admin, 'remove-other', 'command', { room_id: 'general', body: { text: '/emoji remove :confetti:' } })).result).toEqual({});
			expect((await serverFrame(watcher)).capabilities).not.toContain('ext:emoji');
		} finally { admin.close(); watcher.close(); user.close(); }
	});

	it('/server shows, sets and clears the server\'s title, description and avatar for admins, over its variables', async () => {
		const admin = await connect(null);
		await admin.next();
		expect((await request(admin, 'auth', 'auth', { scheme: 'token', token: ADMIN_TOKEN })).result.you.user_id).toBe('admin');
		const watcher = await connect();
		const user = await signedIn(unique('member'));
		const serverFrame = async (peer: Peer) => (await until(peer, (frame) => frame.method === 'server')).frame.params;
		const notice = (skipped: Frame[]) => skipped.find((frame) => frame.params?.from?.user_id === '~private')!.params.body.text as string;
		const command = (id: string, text: string, embeds?: unknown[]) => exchange(admin, id, 'command', { room_id: 'general', body: { text, ...(embeds ? { embeds } : {}) } });
		const configured = await runInDurableObject(stub(), (instance) => (instance as unknown as { config: { server: Record<string, string> } }).config.server);
		const setVariables = (server: Record<string, string>) => runInDurableObject(stub(), (instance) => {
			const runtime = instance as unknown as { config: { server: Record<string, string> } };
			runtime.config = { ...runtime.config, server };
		});
		try {
			// Nothing set: no title (not RP_NAME), description or avatar.
			const before = (await watcher.next()).params;
			expect(before).not.toHaveProperty('title');
			expect(before).not.toHaveProperty('description');
			expect(before).not.toHaveProperty('avatar');
			const shown = await command('show', '/server');
			expect(shown.frame.result).toEqual({});
			expect(notice(shown.skipped)).toBe([
				'This server\'s title, description and avatar, as clients show it:',
				'- **title**: none (clients show the server\'s address)',
				'- **description**: none',
				'- **avatar**: none',
			].join('\n'));
			// Admins only, listed in their /help.
			const help = await exchange(admin, 'help', 'command', { room_id: 'general', body: { text: '/help' } });
			expect(notice(help.skipped)).toContain('`/server [title|description [<text>] | avatar]`');
			expect((await request(user, 'not-admin', 'command', { body: { text: '/server title Mine' } })).error.code).toBe(-32001);
			expect((await request(user, 'not-admin-show', 'command', { body: { text: '/server' } })).error.code).toBe(-32001);
			// The rules of SERVER_TITLE and SERVER_DESCRIPTION; unknown fields and stray attachments are refused.
			for (const [id, text] of [['long-title', `/server title ${'x'.repeat(81)}`], ['two-lines', '/server title two\nlines'], ['long-description', `/server description ${'x'.repeat(501)}`], ['control', '/server description a\u0007b'], ['unknown', '/server colour blue'], ['avatar-text', '/server avatar https://example.com/a.png']]) {
				expect((await request(admin, id, 'command', { body: { text } })).error.code).toBe(-32602);
			}
			expect((await request(admin, 'stray', 'command', { body: { text: '/server title Club', embeds: [{ kind: 'upload' }] } })).error.code).toBe(-32602);
			expect((await request(admin, 'two-images', 'command', { body: { text: '/server avatar', embeds: [{ kind: 'upload' }, { kind: 'upload' }] } })).error.code).toBe(-32602);

			// Each change sends every connection a new server frame.
			const titled = await command('title', '/server title  Chat Club ');
			expect(notice(titled.skipped)).toContain('Set the server\'s title.\n\nThis server\'s title, description and avatar, as clients show it:\n- **title** (set with `/server title`): Chat Club\n');
			expect((await serverFrame(watcher)).title).toBe('Chat Club');
			expect((await serverFrame(user)).title).toBe('Chat Club');
			await command('description', '/server description Talk about *clubs*.\nAll welcome.');
			const described = await serverFrame(watcher);
			expect(described).toMatchObject({ title: 'Chat Club', description: 'Talk about *clubs*.\nAll welcome.' });
			expect(described.capabilities).toContain('command');
			expect(notice((await command('show-set', '/server')).skipped)).toContain('- **description** (set with `/server description`):\n  > Talk about *clubs*.\n  > All welcome.');

			// An image becomes the avatar when its write finishes; it is kept under e/, never expiring.
			const audio = await command('audio', '/server avatar', [{ kind: 'upload' }]);
			expect((await put(audio.frame.result.embeds[0].write_url, webm())).status).toBe(415);
			const started = await command('avatar', '/server avatar', [{ kind: 'upload' }]);
			const write = started.frame.result.embeds[0].write_url as string;
			expect(write).toMatch(/^https:\/\/demo\.test\/w\/e\./);
			expect((await put(write, png(256, 256))).status).toBe(204);
			const avatar = (await serverFrame(watcher)).avatar as string;
			expect(avatar).toMatch(/^https:\/\/media\.test\/e\/[A-Za-z0-9_-]{22}$/);
			await until(user, (frame) => frame.method === 'server' && frame.params.avatar === avatar);
			const key = avatar.slice('https://media.test/'.length);
			expect((await media().head(key))?.httpMetadata).toMatchObject({ contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' });
			expect(await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ owner_id: string; purpose: string }>('SELECT owner_id, purpose FROM uploads WHERE upload_key = ?', key).one())).toEqual({ owner_id: '~server', purpose: 'server' });
			const late = await connect();
			expect((await late.next()).params).toMatchObject({ title: 'Chat Club', description: 'Talk about *clubs*.\nAll welcome.', avatar });
			late.close();

			// Stored values survive a restart and override the variables; clearing one falls back to its variable.
			await setVariables({ title: 'From Variable', description: 'Variable *description*.', avatar: 'https://example.com/icon.png' });
			await runInDurableObject(stub(), (instance) => { (instance as unknown as { store: { serverCache: unknown } }).store.serverCache = null; });
			const restarted = await connect();
			expect((await restarted.next()).params).toMatchObject({ title: 'Chat Club', description: 'Talk about *clubs*.\nAll welcome.', avatar });
			restarted.close();
			const cleared = await command('clear-title', '/server title');
			expect(notice(cleared.skipped)).toContain('Cleared the server\'s title.\n\nThis server\'s title, description and avatar, as clients show it:\n- **title** (from `SERVER_TITLE`): From Variable\n');
			expect((await serverFrame(watcher)).title).toBe('From Variable');
			await command('clear-description', '/server description');
			expect((await serverFrame(watcher)).description).toBe('Variable *description*.');
			const unset = await command('clear-again', '/server title');
			expect(notice(unset.skipped)).toContain('The server\'s title was not set with `/server title`.');
			// Clearing the avatar deletes its image.
			const removed = await command('clear-avatar', '/server avatar');
			expect(removed.frame.result).toEqual({});
			expect(notice(removed.skipped)).toContain('Cleared the server\'s avatar.');
			expect(notice(removed.skipped)).toContain('- **avatar** (from `SERVER_AVATAR`): <https://example.com/icon.png>');
			expect((await serverFrame(watcher)).avatar).toBe('https://example.com/icon.png');
			await expect.poll(async () => await media().head(key)).toBeNull();
			expect(await runInDurableObject(stub(), (_instance, state) => state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM _meta WHERE key LIKE 'server:%'").one().count)).toBe(0);
		} finally {
			await setVariables(configured);
			admin.close(); watcher.close(); user.close();
		}
	});

	it('serves uploads itself, readable from any origin, only where it is its own media origin', async () => {
		const key = `e/c/${'0'.repeat(64)}.json`;
		await media().put(key, '{":x:":{"url":"https://demo.test/e/x"}}', { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' } });
		try {
			const own = { ...env, MEDIA_ORIGIN: 'https://demo.test' } as Env;
			const served = await fetchEntry(new Request(`https://demo.test/${key}`), own);
			expect(served.status).toBe(200);
			expect(served.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(served.headers.get('Content-Type')).toBe('application/json');
			expect(served.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
			expect(await served.json()).toEqual({ ':x:': { url: 'https://demo.test/e/x' } });
			expect((await fetchEntry(new Request(`https://demo.test/${key}`, { method: 'HEAD' }), own)).status).toBe(200);
			expect((await fetchEntry(new Request(`https://demo.test/e/c/${'1'.repeat(64)}.json`), own)).status).toBe(404);
			expect((await fetchEntry(new Request(`https://demo.test/${key}`, { method: 'DELETE' }), own)).status).toBe(404);
			// Where the bucket's own domain serves them, the Worker does not.
			expect((await SELF.fetch(`https://demo.test/${key}`)).status).toBe(404);
		} finally { await media().delete(key); }
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
			expect((await request(admin, 'self', 'command', { room_id: 'general', body: { text: '/purge admin' } })).error.code).toBe(-32001);
		} finally { spammer.close(); admin.close(); }
	});
});
