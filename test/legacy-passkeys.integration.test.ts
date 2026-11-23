// TEMPORARY: REMOVE AFTER 2026-12-22, with src/legacy-passkeys.ts (LEGACY_RP_ID).
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { WebAuthnService } from '../src/auth';
import { LEGACY_PASSKEYS_REMOVE_AFTER, signInNotice, SINCE_KEY } from '../src/legacy-passkeys';
import { loadConfig, type RuntimeConfig } from '../src/config';
import { connect as open, greeting, request, until, type Peer } from './helpers/socket';
import { softPasskey } from './helpers/webauthn';

// FIXME(2026-12-22): this fails from 2026-12-23 (UTC) on, on purpose, so the
// migration does not outlive its 30 days. Don't move the date to make it
// pass: remove the legacy passkey code as src/legacy-passkeys.ts says, which
// deletes this file and this test with it.
it(`is removed by ${LEGACY_PASSKEYS_REMOVE_AFTER}`, () => {
	const due = Date.parse(`${LEGACY_PASSKEYS_REMOVE_AFTER}T00:00:00Z`) + 24 * 60 * 60 * 1_000;
	expect(Number.isFinite(due)).toBe(true);
	expect(Date.now() < due, [
		`The legacy passkey migration (LEGACY_RP_ID) was due for removal after ${LEGACY_PASSKEYS_REMOVE_AFTER}.`,
		'Clean up: delete src/legacy-passkeys.ts and this file, then',
		'`grep -rn LEGACY_RP_ID src test docs SPEC.md wrangler*.toml worker-configuration.d.ts`',
		'and remove each marked line, as the header of src/legacy-passkeys.ts says.',
	].join(' ')).toBe(true);
});

// A server whose RP ID moved from a parent domain to its own host
// (LEGACY_RP_ID): passkeys made for the old one still sign in, on the
// passkey page only, which then offers one for the new RP ID. The suites'
// RP ID is `localhost`; here the object's is `chat.localhost`, with
// `localhost` its legacy RP ID, and the page runs on https://chat.localhost.
const OLD = 'https://localhost';
const NEW = 'https://chat.localhost';
const APP = 'com.example.myapp';
const APP_REDIRECT = `${APP}:/signed-in`;

let nextIp = 1;
const stub = () => env.DEMO.getByName('public-demo-v1');
const ip = () => `198.51.100.${nextIp++}`;
type Passkey = Awaited<ReturnType<typeof softPasskey>>;
const counters = new WeakMap<Passkey, number>();
const nextCounter = (passkey: Passkey) => { const next = (counters.get(passkey) ?? 0) + 1; counters.set(passkey, next); return next; };
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

type Server = { config: RuntimeConfig; webAuthn: WebAuthnService; legacySince?: number };
let kept: RuntimeConfig | undefined;

/**
 * Sets the object's RP IDs, as RP_ID and LEGACY_RP_ID would, and makes now
 * the switch: passkeys made before are the legacy RP ID's (SINCE_KEY), as
 * after a deploy.
 */
async function rpIds(rpId: string, legacyRpId?: string): Promise<void> {
	await runInDurableObject(stub(), async (instance, state) => {
		const server = instance as unknown as Server;
		await state.storage.put(SINCE_KEY, Date.now());
		delete server.legacySince;
		kept ??= server.config;
		const { legacyRpId: _, ...rest } = server.config;
		server.config = { ...rest, rpId, ...(legacyRpId ? { legacyRpId } : {}) };
		server.webAuthn = new WebAuthnService(server.config);
	});
}

afterEach(async () => {
	if (!kept) return;
	const config = kept;
	kept = undefined;
	await runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as Server;
		server.config = config;
		server.webAuthn = new WebAuthnService(config);
	});
});

async function client(resource: string) {
	const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
	const state = b64(crypto.getRandomValues(new Uint8Array(12)));
	const params = { response_type: 'code', client_id: APP, redirect_uri: APP_REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state, resource };
	return {
		url(base: string) {
			const url = new URL(base);
			for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
			return url;
		},
		code(redirect: string) {
			const url = new URL(redirect);
			expect(url.searchParams.get('state')).toBe(state);
			return url.searchParams.get('code')!;
		},
		redeem(code: string) {
			return { code, code_verifier: verifier, redirect_uri: APP_REDIRECT, client_id: APP };
		},
	};
}

const connect = (origin: string) => open({ ip: ip(), origin: null, host: new URL(origin).host });
const post = (origin: string, path: string, body: unknown) => SELF.fetch(`${origin}${path}`, {
	method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': ip(), 'Content-Type': 'application/json', Origin: origin },
});
const begin = async (origin: string, body: Record<string, unknown>) => {
	const response = await post(origin, '/passkey/begin', { page: 'passkey', ...body });
	return { status: response.status, body: await response.json() as { challenge_id: string; public_key: any; error?: string } };
};
const finish = async (origin: string, challenge_id: string, credential: unknown) => {
	const response = await post(origin, '/passkey/finish', { challenge_id, credential });
	return { status: response.status, body: await response.json() as { redirect?: string; upgrade?: string; added?: boolean; error?: string } };
};

/** An account made through the passkey page under the old RP ID, as it was before the move; `keep` keeps its connection open. */
async function legacyAccount(keep = false): Promise<{ passkey: Passkey; userId: string; peer: Peer; token: string }> {
	const peer = await connect(OLD);
	try {
		await greeting(peer);
		const begun = await request(peer, 'begin', 'auth', { scheme: 'webauthn', action: 'register', step: 'begin', name: 'Ada' });
		const app = await client(OLD);
		const url = app.url(begun.result.external.url);
		const passkey = await softPasskey(OLD);
		const started = await begin(OLD, { query: url.searchParams.toString() });
		expect(started.body.public_key.rp.id).toBe('localhost');
		const done = await finish(OLD, started.body.challenge_id, await passkey.register(started.body.public_key));
		expect(done.status).toBe(200);
		const signedIn = await request(peer, 'finish', 'auth', { scheme: 'webauthn', action: 'register', step: 'finish', ...app.redeem(app.code(done.body.redirect!)) });
		return { passkey, userId: signedIn.result.you.user_id, peer, token: signedIn.result.token };
	} finally { if (!keep) peer.close(); }
}

/** How many sign-in codes are stored. */
const codes = () => runInDurableObject(stub(), async (_instance, state) => (await state.storage.list({ prefix: 'signin-code:' })).size);
const passkeysOf = (userId: string) => runInDurableObject(stub(), (instance) =>
	(instance as unknown as { store: { credentials: { idsForUser(userId: string): string[] } } }).store.credentials.idsForUser(userId).sort());

/** A legacy sign-in on the new host's page: the upgrade token it answers. */
async function legacySignIn(passkey: Passkey, query: string): Promise<string> {
	const legacy = await begin(NEW, { query, legacy: true });
	expect(legacy.body.public_key.rpId).toBe('localhost');
	const signedIn = await finish(NEW, legacy.body.challenge_id, await passkey.assert(legacy.body.public_key, nextCounter(passkey), { origin: NEW }));
	expect(signedIn).toEqual({ status: 200, body: { upgrade: expect.stringMatching(/^up_[A-Za-z0-9_-]{43}$/) } });
	return signedIn.body.upgrade!;
}

/** Redeems a page code on a new connection to `origin`; the account it signs in to. */
async function redeem(origin: string, redirect: string, app: Awaited<ReturnType<typeof client>>): Promise<string> {
	const peer = await connect(origin);
	try {
		await greeting(peer);
		const signedIn = await request(peer, 'finish', 'auth', { scheme: 'webauthn', action: 'login', step: 'finish', ...app.redeem(app.code(redirect)) });
		return signedIn.result.you.user_id;
	} finally { peer.close(); }
}

const loginQuery = async (origin: string) => {
	const app = await client(origin);
	return { app, query: app.url(`${origin}/passkey?action=login`).searchParams.toString(), url: app.url(`${origin}/passkey?action=login`) };
};

it('signs in on the passkey page with a passkey made for the legacy RP ID, then adds one for the new, then issues the code', async () => {
	const { passkey, userId, peer } = await legacyAccount(true);
	try {
		await rpIds('chat.localhost', 'localhost');

		// The page offers the older passkey, and has the next screen ready.
		const { app, query, url } = await loginQuery(NEW);
		const html = await (await SELF.fetch(url.href, { headers: { 'CF-Connecting-IP': ip() } })).text();
		expect(html).toContain('data-legacy="legacy">Use one made for localhost</button>');
		expect(html).toContain('<div id="upgrade" hidden>');

		// The usual sign-in is for the new RP ID; the legacy one, asked for, for the old,
		// on the page's origin, the new host's, under both. It issues no code yet.
		expect((await begin(NEW, { query })).body.public_key.rpId).toBe('chat.localhost');
		const before = await codes();
		const token = await legacySignIn(passkey, query);
		expect(await codes()).toBe(before);

		// The upgrade works only on the page and request it was offered on.
		const other = await loginQuery(NEW);
		expect(await begin(NEW, { query: other.query, upgrade: token })).toEqual({ status: 400, body: { error: 'This sign-in expired. Start again from the app.' } });

		// The new passkey, for the new RP ID, excluding the old one, is added at once, the account's
		// connections are told, and the sign-in's code goes back with it.
		const upgraded = await begin(NEW, { query, upgrade: token });
		expect(upgraded.status).toBe(200);
		expect(upgraded.body.public_key.rp.id).toBe('chat.localhost');
		expect(upgraded.body.public_key.excludeCredentials.map((entry: { id: string }) => entry.id)).toEqual([passkey.id]);
		const fresh = await softPasskey(NEW);
		const added = await finish(NEW, upgraded.body.challenge_id, await fresh.register(upgraded.body.public_key));
		expect(added).toEqual({ status: 200, body: { redirect: expect.stringMatching(/^com\.example\.myapp:\/signed-in\?code=/), added: true } });
		expect(await passkeysOf(userId)).toEqual([passkey.id, fresh.id].sort());
		const told = await until(peer, (frame) => frame.method === 'message' && frame.params?.from?.user_id === '~private');
		expect(told.frame.params.body.text).toBe('A passkey was added to your account on the passkey page. If it wasn\'t you, remove it with `/passkeys`.');
		expect(await redeem(NEW, added.body.redirect!, app)).toBe(userId);

		// The token is used up.
		expect((await begin(NEW, { query, upgrade: token })).status).toBe(400);
		expect((await post(NEW, '/passkey/finish', { skip: true, upgrade: token })).status).toBe(400);

		// And the new passkey signs in with the new RP ID, with no upgrade.
		const next = await loginQuery(NEW);
		const again = await begin(NEW, { query: next.query });
		const done = await finish(NEW, again.body.challenge_id, await fresh.assert(again.body.public_key, nextCounter(fresh)));
		expect(done).toEqual({ status: 200, body: { redirect: expect.any(String) } });
		expect(await redeem(NEW, done.body.redirect!, next.app)).toBe(userId);
	} finally { peer.close(); }
});

it('issues the sign-in code on "Not now", once', async () => {
	const { passkey, userId } = await legacyAccount();
	await rpIds('chat.localhost', 'localhost');
	const { app, query } = await loginQuery(NEW);
	const token = await legacySignIn(passkey, query);
	const skipped = await post(NEW, '/passkey/finish', { skip: true, upgrade: token });
	expect(skipped.status).toBe(200);
	const { redirect } = await skipped.json() as { redirect: string };
	expect(await redeem(NEW, redirect, app)).toBe(userId);
	expect(await passkeysOf(userId)).toEqual([passkey.id]);
	expect((await post(NEW, '/passkey/finish', { skip: true, upgrade: token })).status).toBe(400);
	expect((await begin(NEW, { query, upgrade: token })).status).toBe(400);
});

it('takes the legacy RP ID only for a sign-in on the passkey page', async () => {
	const { passkey, userId } = await legacyAccount();
	const { query } = await loginQuery(NEW);
	const refused = { status: 400, body: { error: 'The request was not understood.' } };

	// Without LEGACY_RP_ID, none.
	await rpIds('chat.localhost');
	expect(await begin(NEW, { query, legacy: true })).toEqual(refused);
	const html = await (await SELF.fetch(`${NEW}/passkey?${query}`, { headers: { 'CF-Connecting-IP': ip() } })).text();
	expect(html).not.toContain('data-legacy');
	expect(html).not.toContain('id="upgrade"');

	await rpIds('chat.localhost', 'localhost');
	// Never for a new passkey.
	const register = (await loginQuery(NEW)).app.url(`${NEW}/passkey?action=register`).searchParams.toString();
	expect(await begin(NEW, { query: register, legacy: true })).toEqual(refused);
	// An assertion for the old RP ID answers only a legacy ceremony.
	const usual = await begin(NEW, { query });
	const crossed = await finish(NEW, usual.body.challenge_id, await passkey.assert({ ...usual.body.public_key, rpId: 'localhost' }, nextCounter(passkey), { origin: NEW }));
	expect(crossed.status).toBe(400);

	// An upgrade takes only a token a legacy sign-in gave: never an addition link's
	// request handle, which a client's URL carries and anyone who sees it could send.
	const handle = await runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as { store: { accounts: { get(userId: string): { userHandle?: string } | null } }; createRequestHandle(userId: string, userHandle: string | undefined, now: number): Promise<string> };
		return server.createRequestHandle(userId, server.store.accounts.get(userId)?.userHandle, Date.now());
	});
	expect(handle).toMatch(/^rq_/);
	expect(await begin(NEW, { query, upgrade: handle })).toEqual(refused);
	expect((await post(NEW, '/passkey/finish', { skip: true, upgrade: handle })).status).toBe(400);
	expect((await begin(NEW, { query, upgrade: `up_${'A'.repeat(43)}` })).status).toBe(400);
	expect(await begin(NEW, { query, upgrade: 'up_short' })).toEqual(refused);
	expect(await begin(NEW, { query, legacy: true, upgrade: `up_${'A'.repeat(43)}` })).toEqual(refused);
	expect(await passkeysOf(userId)).toEqual([passkey.id]);
	// A sign-in with a passkey for the new RP ID offers no upgrade.
	const fresh = await softPasskey(NEW);
	const unknown = await begin(NEW, { query });
	expect((await finish(NEW, unknown.body.challenge_id, await fresh.assert(unknown.body.public_key, nextCounter(fresh)))).body.upgrade).toBeUndefined();
});

it('takes a legacy RP ID that RP_ID is under, for the passkey page', () => {
	const config = (extra: Record<string, string>) => loadConfig({ NODE_ENV: 'test', ALLOWED_ORIGINS: '*', RP_ORIGINS: 'https://web.apron.chat', RP_ID: 'server.apron.chat', ...extra } as Parameters<typeof loadConfig>[0]);
	expect(config({}).legacyRpId).toBeUndefined();
	expect(config({ LEGACY_RP_ID: '' }).legacyRpId).toBeUndefined();
	expect(config({ LEGACY_RP_ID: ' Apron.Chat ' }).legacyRpId).toBe('apron.chat');
	// Only a domain RP_ID is under, which the page on RP_ID's host may use.
	expect(() => config({ LEGACY_RP_ID: 'server.apron.chat' })).toThrow(/domain RP_ID is under/);
	expect(() => config({ LEGACY_RP_ID: 'pron.chat' })).toThrow(/domain RP_ID is under/);
	expect(() => config({ LEGACY_RP_ID: 'web.apron.chat' })).toThrow(/domain RP_ID is under/);
	expect(() => config({ LEGACY_RP_ID: 'https://apron.chat' })).toThrow(/must be a host name/);
	expect(() => config({ LEGACY_RP_ID: 'apron.chat', PASSKEY_PAGE: 'false' })).toThrow(/needs PASSKEY_PAGE/);
});

it("runs the page's scripts: the legacy sign-in, then the new passkey, then back to the client", async () => {
	const { passkey, userId } = await legacyAccount();
	await rpIds('chat.localhost', 'localhost');
	const { url } = await loginQuery(NEW);
	const html = await (await SELF.fetch(url.href, { headers: { 'CF-Connecting-IP': ip() } })).text();
	const config = html.match(/<script type="application\/json" id="config">(.*?)<\/script>/s)![1];
	// The page's script, then this module's, sharing one scope as classic scripts do.
	const scripts = [...html.matchAll(/<script nonce="[^"]*">(.*?)<\/script>/gs)].map((match) => match[1]);
	expect(scripts).toHaveLength(2);

	type Element = {
		hidden: boolean; disabled: boolean; dataset: Record<string, string>; textContent: string; className: string; id: string;
		classList: { contains(name: string): boolean }; parentElement?: { children: Element[] }; listeners: (() => void)[];
		addEventListener(type: string, listener: () => void): void; querySelector(selector: string): { focus(): void }; focus(): void;
	};
	const element = (id = '', dataset: Record<string, string> = {}): Element => {
		const made: Element = {
			id, hidden: false, disabled: false, dataset, textContent: '', className: '', listeners: [],
			classList: { contains: (name) => made.className.split(' ').includes(name) },
			addEventListener: (_type, listener) => made.listeners.push(listener),
			querySelector: () => ({ focus: () => {} }), focus: () => {},
		};
		return made;
	};
	const status = element('status');
	const legacyButton = element('', { legacy: 'legacy' });
	const createButton = element('', { legacy: 'upgrade' });
	const screen = { ...element('upgrade'), hidden: true };
	const heading = element();
	const brandLine = { ...element(), className: 'brand' };
	brandLine.classList = { contains: (name) => name === 'brand' };
	const main = { children: [brandLine, heading, screen, status] };
	screen.parentElement = main;
	const document = {
		getElementById: (id: string) => id === 'config' ? { textContent: config } : id === 'upgrade' ? screen : status,
		querySelectorAll: (selector: string) => selector === '[data-legacy]' ? [legacyButton, createButton] : selector === '[data-passkey]' ? [element()] : [],
	};
	const fresh = await softPasskey(NEW);
	const PublicKeyCredential = { parseRequestOptionsFromJSON: (json: unknown) => json, parseCreationOptionsFromJSON: (json: unknown) => json };
	const navigator = { credentials: {
		get: async ({ publicKey }: { publicKey: { challenge: string; rpId: string } }) => {
			expect(publicKey.rpId).toBe('localhost');
			const assertion = await passkey.assert(publicKey, nextCounter(passkey), { origin: NEW });
			return { id: assertion.id, toJSON: () => assertion };
		},
		create: async ({ publicKey }: { publicKey: { challenge: string; rp: { id: string } } }) => {
			expect(publicKey.rp.id).toBe('chat.localhost');
			const created = await fresh.register(publicKey);
			return { id: created.id, toJSON: () => created };
		},
	} };
	const fetch = (path: string, init: { body: string }) => post(NEW, path, JSON.parse(init.body));
	const assigned: string[] = [];
	new Function('window', 'document', 'navigator', 'PublicKeyCredential', 'fetch', 'location', scripts.join('\n'))(
		{ PublicKeyCredential }, document, navigator, PublicKeyCredential, fetch, { assign: (to: string) => assigned.push(to) },
	);

	legacyButton.listeners[0]();
	// Signed in: the screen offering a new passkey, in place of the rest.
	await vi.waitFor(() => expect(screen.hidden).toBe(false));
	expect(heading.hidden).toBe(true);
	expect(status.hidden).toBe(false);
	expect(brandLine.hidden).toBe(false);
	expect(assigned).toEqual([]);
	createButton.listeners[0]();
	await vi.waitFor(() => expect(assigned).toHaveLength(1));
	expect(status.textContent).toBe('');
	expect(assigned[0]).toMatch(/^com\.example\.myapp:\/signed-in\?code=/);
	await runInDurableObject(stub(), (instance) => {
		const store = (instance as unknown as { store: { credentials: { idsForUser(userId: string): string[] } } }).store;
		expect(store.credentials.idsForUser(userId).sort()).toEqual([passkey.id, fresh.id].sort());
	});
});

const replace = (body: Record<string, unknown>) => begin(NEW, { page: 'replace', ...body });

/** A sign-in on the replace screen with the old passkey: its answer. */
async function replaceSignIn(passkey: Passkey) {
	const begun = await replace({ legacy: true });
	expect(begun.status).toBe(200);
	expect(begun.body.public_key.rpId).toBe('localhost');
	const finished = await post(NEW, '/passkey/finish', { challenge_id: begun.body.challenge_id, credential: await passkey.assert(begun.body.public_key, nextCounter(passkey), { origin: NEW }) });
	return { status: finished.status, body: await finished.json() as Record<string, any> };
}

it('replaces a legacy passkey on the replace screen, with no client and no code, and then says the account is set', async () => {
	const { passkey, userId } = await legacyAccount();
	await rpIds('chat.localhost', 'localhost');
	const html = await (await SELF.fetch(`${NEW}/passkey?action=replace`, { headers: { 'CF-Connecting-IP': ip() } })).text();
	expect(html).toContain('Replace your passkey');
	expect(html).toContain('data-run="old"');

	const before = await codes();
	const signedIn = await replaceSignIn(passkey);
	expect(signedIn).toEqual({ status: 200, body: { state: 'create', account: { user_id: userId, name: 'Ada' }, upgrade: expect.stringMatching(/^up_/) } });
	// Its token works only on the replace screen.
	const elsewhere = await loginQuery(NEW);
	expect((await begin(NEW, { query: elsewhere.query, upgrade: signedIn.body.upgrade })).status).toBe(400);
	const upgraded = await replace({ upgrade: signedIn.body.upgrade });
	expect(upgraded.body.public_key.rp.id).toBe('chat.localhost');
	const fresh = await softPasskey(NEW);
	expect(await finish(NEW, upgraded.body.challenge_id, await fresh.register(upgraded.body.public_key))).toEqual({ status: 200, body: { added: true } });
	expect(await passkeysOf(userId)).toEqual([passkey.id, fresh.id].sort());
	expect(await codes()).toBe(before);

	// Back again with the old passkey: the account is set, and this device may add one too.
	const again = await replaceSignIn(passkey);
	expect(again).toEqual({ status: 200, body: { state: 'already', account: { user_id: userId, name: 'Ada' }, added_at: expect.any(String), upgrade: expect.stringMatching(/^up_/) } });
	expect(Date.parse(again.body.added_at)).toBeGreaterThan(Date.now() - 60_000);

	// A sign-in screen no longer offers the upgrade to this account.
	const { query } = await loginQuery(NEW);
	const legacy = await begin(NEW, { query, legacy: true });
	const done = await finish(NEW, legacy.body.challenge_id, await passkey.assert(legacy.body.public_key, nextCounter(passkey), { origin: NEW }));
	expect(done).toEqual({ status: 200, body: { redirect: expect.any(String) } });
});

it('takes only a legacy sign-in or its upgrade on the replace screen, and only with LEGACY_RP_ID', async () => {
	const refused = { status: 400, body: { error: 'The request was not understood.' } };
	await rpIds('chat.localhost');
	expect(await replace({ legacy: true })).toEqual(refused);
	// Without LEGACY_RP_ID, the replace link is the passkey page's, which needs a client's request.
	expect((await SELF.fetch(`${NEW}/passkey?action=replace`, { headers: { 'CF-Connecting-IP': ip() } })).status).toBe(400);
	await rpIds('chat.localhost', 'localhost');
	expect(await replace({})).toEqual(refused);
	expect(await replace({ action: 'register', legacy: true })).toEqual(refused);
	expect((await replace({ upgrade: `up_${'A'.repeat(43)}` })).status).toBe(400);
});

it('tells an account signing in with only legacy passkeys to replace them, at most once a day, and says so on the sign-in screen', async () => {
	const { passkey, userId, token } = await legacyAccount();
	await rpIds('chat.localhost', 'localhost');
	// The sign-in screen's welcome links to the replace screen.
	const guest = await connect(NEW);
	try {
		const { server } = await greeting(guest);
		expect(server.params.welcome).toContain(`[Replace it](${NEW}/passkey?action=replace)`);
	} finally { guest.close(); }

	// Signing in (here with its session token) brings the notice.
	const peer = await connect(NEW);
	try {
		await greeting(peer);
		expect((await request(peer, 'resume', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
		const notice = await until(peer, (frame) => frame.method === 'message' && frame.params?.from?.user_id === '~private' && /Replace your passkey/.test(frame.params?.body?.text ?? ''));
		expect(notice.frame.params.body.text).toBe(`Your passkey was made for localhost, which this server stops accepting after December 22. [Replace your passkey](${NEW}/passkey?action=replace) to keep signing in.`);
	} finally { peer.close(); }

	const notice = (now = Date.now()) => runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as { legacyPort(): import('../src/legacy-passkeys').LegacyPort };
		return signInNotice(server.legacyPort(), userId, 'localhost', NEW, now);
	});
	// Not again today; again tomorrow.
	expect(await notice()).toBeUndefined();
	expect(await notice(Date.now() + 86_400_000)).toEqual(expect.stringContaining('Replace your passkey'));
	// None once the account has a passkey for the new RP ID.
	const signedIn = await replaceSignIn(passkey);
	const upgraded = await replace({ upgrade: signedIn.body.upgrade });
	const fresh = await softPasskey(NEW);
	expect((await finish(NEW, upgraded.body.challenge_id, await fresh.register(upgraded.body.public_key))).status).toBe(200);
	expect(await notice(Date.now() + 2 * 86_400_000)).toBeUndefined();

	// Without LEGACY_RP_ID, no welcome line.
	await rpIds('chat.localhost');
	const plain = await connect(NEW);
	try {
		expect((await greeting(plain)).server.params.welcome).not.toContain('passkey?action=replace');
	} finally { plain.close(); }
});

it('records the switch on a sign-in by an account with no passkeys, before it can make one', async () => {
	await rpIds('chat.localhost', 'localhost');
	// Not yet recorded, as just after a deploy; then the admin, who has no passkeys, signs in.
	await runInDurableObject(stub(), async (instance, state) => {
		const server = instance as unknown as Server & { config: RuntimeConfig & { adminToken?: string } };
		await state.storage.delete(SINCE_KEY);
		delete server.legacySince;
		server.config = { ...server.config, adminToken: 'legacy-admin-token-0123456789' };
	});
	const peer = await connect(NEW);
	try {
		await greeting(peer);
		expect((await request(peer, 'auth', 'auth', { scheme: 'token', token: 'legacy-admin-token-0123456789' })).result.you.user_id).toBe('admin');
		await vi.waitFor(async () => expect(await runInDurableObject(stub(), (_instance, state) => state.storage.get<number>(SINCE_KEY))).toEqual(expect.any(Number)));
	} finally { peer.close(); }
	// At most when the object woke: before anything this connection could make.
	const since = await runInDurableObject(stub(), (_instance, state) => state.storage.get<number>(SINCE_KEY));
	expect(since).toBeLessThanOrEqual(Date.now());
});

it('makes every new passkey for the new RP ID: in the client, on the passkey page, and as an addition', async () => {
	await rpIds('chat.localhost', 'localhost');
	// In a client from RP_ORIGINS.
	const web = await open({ ip: ip(), origin: 'http://localhost:5173', host: new URL(NEW).host });
	try {
		await greeting(web);
		const begun = await request(web, 'begin', 'auth', { scheme: 'webauthn', action: 'register', step: 'begin', name: 'Grace' });
		expect(begun.result.public_key.rp.id).toBe('chat.localhost');
		const login = await request(web, 'login', 'auth', { scheme: 'webauthn', action: 'login', step: 'begin' });
		expect(login.result.public_key.rpId).toBe('chat.localhost');
	} finally { web.close(); }
	// On the passkey page, for a new account; the legacy RP ID is refused for it.
	const app = await client(NEW);
	const query = app.url(`${NEW}/passkey?action=register&name=Grace`).searchParams.toString();
	expect((await begin(NEW, { query })).body.public_key.rp.id).toBe('chat.localhost');
	expect((await begin(NEW, { query, legacy: true })).status).toBe(400);
});

it("runs the replace screen's script: the old passkey, then the new one, then done", async () => {
	const { passkey, userId } = await legacyAccount();
	await rpIds('chat.localhost', 'localhost');
	const html = await (await SELF.fetch(`${NEW}/passkey?action=replace`, { headers: { 'CF-Connecting-IP': ip() } })).text();
	const scripts = [...html.matchAll(/<script nonce="[^"]*">(.*?)<\/script>/gs)].map((match) => match[1]);
	expect(scripts).toHaveLength(1);
	const ids = [...html.matchAll(/<section id="([a-z]+)" data-screen/g)].map((match) => match[1]);
	expect(ids).toEqual(['start', 'create', 'already', 'full', 'none', 'done', 'later', 'close']);

	type Node = { id: string; hidden: boolean; disabled: boolean; textContent: string; className: string; dataset: Record<string, string>; listeners: (() => void)[]; addEventListener(type: string, listener: () => void): void };
	const node = (id = '', dataset: Record<string, string> = {}, hidden = false): Node => {
		const made: Node = { id, hidden, disabled: false, textContent: '', className: '', dataset, listeners: [], addEventListener: (_type, listener) => made.listeners.push(listener) };
		return made;
	};
	const screens = ids.map((id) => node(id, {}, id !== 'start'));
	const shown = () => screens.filter((screen) => !screen.hidden).map((screen) => screen.id);
	const status = node('status');
	const names = [node(), node()];
	const accounts = [node()];
	const useOld = node('', { run: 'old' });
	const create = node('', { run: 'new' });
	const document = {
		getElementById: () => status,
		querySelector: () => ({ focus: () => {} }),
		querySelectorAll: (selector: string) => ({
			'[data-screen]': screens, '[data-name]': names, '[data-account]': accounts, '[data-added]': [],
			'[data-run]': [useOld, create], '[data-show]': [], button: [useOld, create],
		} as Record<string, Node[]>)[selector] ?? [],
	};
	const fresh = await softPasskey(NEW);
	const PublicKeyCredential = { parseRequestOptionsFromJSON: (json: unknown) => json, parseCreationOptionsFromJSON: (json: unknown) => json };
	const hints: string[] = [];
	const navigator = { credentials: {
		get: async ({ publicKey }: { publicKey: { challenge: string; rpId: string } }) => {
			hints.push(status.textContent);
			expect(publicKey.rpId).toBe('localhost');
			const assertion = await passkey.assert(publicKey, nextCounter(passkey), { origin: NEW });
			return { id: assertion.id, toJSON: () => assertion };
		},
		create: async ({ publicKey }: { publicKey: { challenge: string; rp: { id: string } } }) => {
			expect(publicKey.rp.id).toBe('chat.localhost');
			const created = await fresh.register(publicKey);
			return { id: created.id, toJSON: () => created };
		},
	} };
	const fetch = (path: string, init: { body: string }) => post(NEW, path, JSON.parse(init.body));
	new Function('window', 'document', 'navigator', 'PublicKeyCredential', 'fetch', 'location', scripts[0])(
		{ PublicKeyCredential }, document, navigator, PublicKeyCredential, fetch, { assign: () => { throw new Error('the replace screen goes nowhere'); } },
	);

	useOld.listeners[0]();
	await vi.waitFor(() => expect(shown()).toEqual(['create']));
	expect(hints).toEqual(['In your device’s prompt, choose the passkey for localhost.']);
	expect(names.map((name) => name.textContent)).toEqual(['Ada', 'Ada']);
	expect(accounts[0].textContent).toBe(`Ada (@${userId})`);
	create.listeners[0]();
	await vi.waitFor(() => expect(shown()).toEqual(['done']));
	expect(status.textContent).toBe('');
	expect(await passkeysOf(userId)).toEqual([passkey.id, fresh.id].sort());
});
