import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { WebAuthnService } from '../src/auth';
import { PAGE_CHALLENGE_TTL_MS, PAGE_PREPARED_FRESH_MS } from '../src/oauth';
import { PAGE_HELPERS } from '../src/sign-in-page';
import { firstKind, passkeysForRpId, SINCE_KEY } from '../src/legacy-passkeys';
import { loadConfig, type RuntimeConfig } from '../src/config';
import { connect as open, greeting, request, until, type Peer } from './helpers/socket';
import { softPasskey } from './helpers/webauthn';

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
		// One "Continue with passkey", which finds either kind; nothing asks which.
		expect(html).toContain('<button type="button" class="primary" data-legacy="auto">Continue with passkey</button>');
		expect(html).not.toContain('data-passkey>Continue with passkey');
		expect(html).not.toContain('localhost</button>');
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

		// The new passkey, for the new RP ID, is added at once, the account's connections are told, and the
		// sign-in's code goes back with it. It excludes no passkey for the previous RP ID: a password manager
		// that matches excludeCredentials by ID alone (Bitwarden) would refuse to save it beside the old one.
		const upgraded = await begin(NEW, { query, upgrade: token });
		expect(upgraded.status).toBe(200);
		expect(upgraded.body.public_key.rp.id).toBe('chat.localhost');
		expect((upgraded.body.public_key.excludeCredentials ?? []).map((entry: { id: string }) => entry.id)).toEqual([]);
		const fresh = await softPasskey(NEW);
		const added = await finish(NEW, upgraded.body.challenge_id, await fresh.register(upgraded.body.public_key));
		expect(added).toEqual({ status: 200, body: { redirect: expect.stringMatching(/^com\.example\.myapp:\/signed-in\?code=/), added: true } });
		expect(await passkeysOf(userId)).toEqual([passkey.id, fresh.id].sort());
		// A later passkey for the account, in the client or as an addition, excludes the new one only.
		const excluded = await runInDurableObject(stub(), (instance) => (instance as unknown as { excludedPasskeys(userId: string): Promise<string[]> }).excludedPasskeys(userId));
		expect(excluded).toEqual([fresh.id]);
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
		// The old passkey still signs in, and is not offered the upgrade again: the account has a new one.
		const later = await loginQuery(NEW);
		const old = await begin(NEW, { query: later.query, legacy: true });
		const back = await finish(NEW, old.body.challenge_id, await passkey.assert(old.body.public_key, nextCounter(passkey), { origin: NEW }));
		expect(back).toEqual({ status: 200, body: { redirect: expect.any(String) } });
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

it('excludes from a new passkey only the passkeys made for RP_ID, since the switch', () => {
	const passkeys = [{ credentialId: 'old', createdMs: 1_000 }, { credentialId: 'new', createdMs: 2_000 }, { credentialId: 'at', createdMs: 1_500 }];
	expect(passkeysForRpId(passkeys, 1_500)).toEqual(['new', 'at']);
	// Before the switch is known, none: a duplicate is harmless; a refused new passkey is not.
	expect(passkeysForRpId(passkeys, undefined)).toEqual([]);
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
	expect(() => config({ LEGACY_RP_ID: 'chat' })).toThrow(/not a public suffix/);
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
	const tries = triesList();
	const legacyButton = element('', { legacy: 'auto' });
	const createButton = element('', { legacy: 'upgrade' });
	const screen = { ...element('upgrade'), hidden: true };
	const heading = element();
	const brandLine = { ...element(), className: 'brand' };
	brandLine.classList = { contains: (name) => name === 'brand' };
	const main = { children: [brandLine, heading, screen, status] };
	screen.parentElement = main;
	const document = {
		getElementById: (id: string) => id === 'config' ? { textContent: config } : id === 'upgrade' ? screen : id === 'tries' ? tries : status,
		querySelectorAll: (selector: string) => selector === '[data-legacy]' ? [legacyButton, createButton] : [],
		// The page's own sign-in button gives way to this module's.
		querySelector: () => null,
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
	const begins: unknown[] = [];
	const fetch = (path: string, init: { body: string }) => {
		if (path.endsWith('/begin')) begins.push(JSON.parse(init.body));
		return post(NEW, path, JSON.parse(init.body));
	};
	const assigned: string[] = [];
	// A device that last signed in here with this old passkey.
	const localStorage = { getItem: (key: string) => key === 'apron-passkey-kind' ? 'old' : null, setItem: () => {} };
	new Function('window', 'document', 'navigator', 'PublicKeyCredential', 'fetch', 'location', 'localStorage', scripts.join('\n'))(
		{ PublicKeyCredential }, document, navigator, PublicKeyCredential, fetch, { assign: (to: string) => assigned.push(to) }, localStorage,
	);

	// One ceremony begun ahead of the tap, for the legacy RP ID, and none that no button could use.
	await vi.waitFor(() => expect(begins).toHaveLength(1));
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(begins).toMatchObject([{ legacy: true }]);
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
		// A sign-in in the client is for the new RP ID too, with the passkey page besides,
		// which also finds passkeys for the old one.
		const login = await request(web, 'login', 'auth', { scheme: 'webauthn', action: 'login', step: 'begin' });
		expect(login.result.public_key.rpId).toBe('chat.localhost');
		expect(login.result.external).toEqual({ url: `${NEW}/passkey?action=login` });
	} finally { web.close(); }
	// On the passkey page, for a new account; the legacy RP ID is refused for it.
	const app = await client(NEW);
	const query = app.url(`${NEW}/passkey?action=register&name=Grace`).searchParams.toString();
	expect((await begin(NEW, { query })).body.public_key.rp.id).toBe('chat.localhost');
	expect((await begin(NEW, { query, legacy: true })).status).toBe(400);
});

/**
 * The checklist of RP IDs the page tries (`#tries`), as the page script
 * uses it: rows by `data-try`, each with its note, tag and Retry.
 */
function triesList() {
	type Row = { dataset: Record<string, string>; className: string; hidden: boolean; parts: Record<string, { textContent: string; hidden: boolean; listeners: (() => void)[]; dataset: Record<string, string>; addEventListener(type: string, listener: () => void): void }>; querySelector(selector: string): unknown };
	const part = (dataset: Record<string, string> = {}) => {
		const made = { textContent: '', hidden: true, listeners: [] as (() => void)[], dataset, addEventListener: (_type: string, listener: () => void) => made.listeners.push(listener) };
		return made;
	};
	const row = (kind: string, note: string): Row => {
		const parts = { small: part(), em: part(), retry: part({ retry: kind }) };
		parts.small.textContent = note;
		return { dataset: { try: kind, note }, className: 'key', hidden: false, parts, querySelector: (selector: string) => selector === 'small' ? parts.small : selector === 'em' ? parts.em : parts.retry };
	};
	const rows = [row('login', 'Check for passkey'), row('legacy', 'Check for older passkey')];
	const list = {
		hidden: true, rows,
		append: (moved: Row) => { rows.splice(rows.indexOf(moved), 1); rows.push(moved); },
		querySelector: (selector: string) => rows.find((each) => selector.includes(`"${each.dataset.try}"`)),
		querySelectorAll: () => [...rows],
		after: () => {},
		/** What a reader sees: each row's RP ID kind, note, tag, and whether it has a Retry. */
		seen: () => rows.map((each) => [each.dataset.try, each.parts.small.textContent, each.parts.em.textContent, !each.parts.retry.hidden]),
		retry: (kind: string) => rows.find((each) => each.dataset.try === kind)!.parts.retry.listeners[0](),
	};
	return list;
}

/**
 * The sign-in page's scripts under a stand-in browser: `has` is which
 * passkeys the device holds, by RP ID; a prompt for another RP ID is closed
 * empty (NotAllowedError), as a real one is. Returns its controls.
 */
async function signInPage(has: Record<string, Passkey>, storage: Map<string, string>, options: { saves?: Passkey; finish?: (body: Record<string, unknown>) => Promise<unknown> | undefined; clock?: { now: number }; hints?: Record<string, string> } = {}) {
	const { url } = await loginQuery(NEW);
	for (const [key, value] of Object.entries(options.hints ?? {})) url.searchParams.set(key, value);
	const html = await (await SELF.fetch(url.href, { headers: { 'CF-Connecting-IP': ip() } })).text();
	const config = html.match(/<script type="application\/json" id="config">(.*?)<\/script>/s)![1];
	const scripts = [...html.matchAll(/<script nonce="[^"]*">(.*?)<\/script>/gs)].map((match) => match[1]);
	type Node = { id: string; hidden: boolean; disabled: boolean; textContent: string; className: string; dataset: Record<string, string>; listeners: (() => void)[]; classList: { contains(name: string): boolean }; parentElement?: { children: Node[] }; addEventListener(type: string, listener: () => void): void; querySelector(): { focus(): void } };
	const node = (id = '', dataset: Record<string, string> = {}): Node => {
		const made: Node = { id, hidden: false, disabled: false, textContent: '', className: '', dataset, listeners: [], classList: { contains: (name) => made.className.split(' ').includes(name) }, addEventListener: (_type, listener) => made.listeners.push(listener), querySelector: () => ({ focus: () => {} }) };
		return made;
	};
	const status = node('status');
	const auto = node('', { legacy: 'auto' });
	const save = node('', { legacy: 'upgrade' });
	const upgrade = { ...node('upgrade'), hidden: true };
	const unsaved = { ...node('unsaved'), hidden: true };
	const tries = triesList();
	const onward = node();
	upgrade.parentElement = { children: [upgrade, unsaved, status] };
	unsaved.parentElement = upgrade.parentElement;
	const document = {
		getElementById: (id: string) => id === 'config' ? { textContent: config } : id === 'upgrade' ? upgrade : id === 'unsaved' ? unsaved : id === 'tries' ? tries : status,
		querySelectorAll: (selector: string) => selector === '[data-legacy]' ? [auto, save] : selector === '[data-continue]' ? [onward] : selector === '[data-retry]' ? tries.rows.map((each) => each.parts.retry) : selector === '[data-legacy="auto"]' ? [auto] : [],
		querySelector: () => null,
	};
	const prompts: string[] = [];
	const navigator = { credentials: {
		get: async ({ publicKey }: { publicKey: { challenge: string; rpId: string } }) => {
			prompts.push(publicKey.rpId);
			const passkey = has[publicKey.rpId];
			if (!passkey) throw Object.assign(new Error('closed'), { name: 'NotAllowedError' });
			const assertion = await passkey.assert(publicKey, nextCounter(passkey), { origin: NEW });
			return { id: assertion.id, toJSON: () => assertion };
		},
		create: async ({ publicKey }: { publicKey: { challenge: string; rp: { id: string } } }) => {
			if (!options.saves) throw Object.assign(new Error('closed'), { name: 'NotAllowedError' });
			const created = await options.saves.register(publicKey);
			return { id: created.id, toJSON: () => created };
		},
	} };
	const PublicKeyCredential = { parseRequestOptionsFromJSON: (json: unknown) => json, parseCreationOptionsFromJSON: (json: unknown) => json };
	const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } };
	const assigned: string[] = [];
	const begins: unknown[] = [];
	const timers: (() => void)[] = [];
	const clock = options.clock;
	const time = clock ? { now: () => clock.now } : Date;
	const later = clock ? (run: () => void) => { timers.push(run); } : setTimeout;
	const fetch = (path: string, init: { body: string }) => {
		const body = JSON.parse(init.body);
		if (path.endsWith('/begin')) begins.push(body);
		const instead = path.endsWith('/finish') ? options.finish?.(body) : undefined;
		return instead ? instead.then((answer) => new Response(JSON.stringify(answer), { status: 200 })) : post(NEW, path, body);
	};
	new Function('window', 'document', 'navigator', 'PublicKeyCredential', 'fetch', 'location', 'localStorage', 'Date', 'setTimeout', scripts.join('\n'))(
		{ PublicKeyCredential }, document, navigator, PublicKeyCredential, fetch, { assign: (to: string) => assigned.push(to) }, localStorage, time, later,
	);
	// Its ceremonies are begun as the page shows; a tap waits for none.
	await new Promise((resolve) => setTimeout(resolve, 200));
	return { tap: () => auto.listeners[0](), save: () => save.listeners[0](), proceed: () => onward.listeners[0](), status, upgrade, unsaved, tries, auto, prompts, assigned, begins, timers };
}

it('finds the passkey whichever RP ID it is for, from one button, without asking which', async () => {
	const { passkey } = await legacyAccount();
	const other = await legacyAccount();
	await rpIds('chat.localhost', 'localhost');
	// Someone with a new passkey, on a device that has not signed in here: the new kind is asked
	// for first, so one tap signs in.
	const fresh = await softPasskey(NEW);
	const { query } = await loginQuery(NEW);
	const token = await legacySignIn(passkey, query);
	const added = await begin(NEW, { query, upgrade: token });
	expect((await finish(NEW, added.body.challenge_id, await fresh.register(added.body.public_key))).status).toBe(200);
	const first = await signInPage({ 'chat.localhost': fresh }, new Map());
	expect(first.tries.hidden).toBe(true);
	first.tap();
	await vi.waitFor(() => expect(first.assigned).toHaveLength(1));
	expect(first.prompts).toEqual(['chat.localhost']);

	// Someone with only an old passkey on such a device: the new kind finds nothing, and the
	// checklist says so (with a Retry); the next tap of the same button finds the old one.
	const device = new Map<string, string>();
	const old = await signInPage({ localhost: other.passkey }, device);
	old.tap();
	await vi.waitFor(() => expect(old.tries.hidden).toBe(false));
	expect(old.tries.seen()).toEqual([['login', 'None selected', '', true], ['legacy', 'Check for older passkey', '', false]]);
	// Said too, since the checklist isn't a live region.
	expect(old.status.textContent).toBe('Checked chat.localhost for passkey, none selected. Check localhost for passkey?');
	old.tap();
	await vi.waitFor(() => expect(old.upgrade.hidden).toBe(false));
	expect(old.prompts).toEqual(['chat.localhost', 'localhost']);
	expect(old.assigned).toEqual([]);
	// Until it saves a new passkey, this device asks for the old kind first.
	expect(device.get('apron-passkey-kind')).toBe('old');
	const again = await signInPage({ localhost: other.passkey }, device, { saves: await softPasskey(NEW) });
	again.tap();
	await vi.waitFor(() => expect(again.upgrade.hidden).toBe(false));
	expect(again.prompts).toEqual(['localhost']);
	// Once it does, the new kind.
	again.save();
	await vi.waitFor(() => expect(again.assigned).toHaveLength(1));
	expect(device.get('apron-passkey-kind')).toBe('new');
});

it('excludes no legacy passkey from an addition, on the passkey page or in a client from RP_ORIGINS', async () => {
	const { passkey, userId, token } = await legacyAccount();
	await rpIds('chat.localhost', 'localhost');
	const excluded = (publicKey: { excludeCredentials?: { id: string }[] }) => (publicKey.excludeCredentials ?? []).map((entry) => entry.id);
	// On the passkey page, from an addition's `request` handle.
	const peer = await connect(NEW);
	try {
		await greeting(peer);
		expect((await request(peer, 'token', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
		const begun = await request(peer, 'add', 'auth', { scheme: 'webauthn', action: 'register', step: 'begin' });
		const app = await client(NEW);
		const url = app.url(begun.result.external.url);
		expect(url.searchParams.get('request')).toMatch(/^rq_/);
		const started = await begin(NEW, { query: url.searchParams.toString() });
		expect(started.status).toBe(200);
		expect(started.body.public_key.rp.id).toBe('chat.localhost');
		expect(excluded(started.body.public_key)).toEqual([]);
	} finally { peer.close(); }
	// In a client from RP_ORIGINS, whose own ceremony adds it.
	const web = await open({ ip: ip(), origin: 'http://localhost:5173', host: new URL(NEW).host });
	try {
		await greeting(web);
		expect((await request(web, 'token', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
		const begun = await request(web, 'add', 'auth', { scheme: 'webauthn', action: 'register', step: 'begin' });
		expect(begun.result.public_key.rp.id).toBe('chat.localhost');
		expect(excluded(begun.result.public_key)).toEqual([]);
	} finally { web.close(); }
	expect(await passkeysOf(userId)).toEqual([passkey.id]);
});

it('records the switch at the start of a passkey ceremony, before any passkey it makes', async () => {
	await rpIds('chat.localhost', 'localhost');
	const clear = () => runInDurableObject(stub(), async (instance, state) => {
		await state.storage.delete(SINCE_KEY);
		delete (instance as unknown as Server).legacySince;
	});
	const recorded = () => runInDurableObject(stub(), (_instance, state) => state.storage.get<number>(SINCE_KEY));
	// On the passkey page, for a new account.
	await clear();
	const app = await client(NEW);
	const before = Date.now();
	expect((await begin(NEW, { query: app.url(`${NEW}/passkey?action=register&name=Grace`).searchParams.toString() })).status).toBe(200);
	expect(await recorded()).toBeLessThanOrEqual(before);
	// In a client, on a guest's connection that nothing signed in to as registered.
	await clear();
	const web = await open({ ip: ip(), origin: 'http://localhost:5173', host: new URL(NEW).host });
	try {
		await greeting(web);
		await request(web, 'begin', 'auth', { scheme: 'webauthn', action: 'register', step: 'begin', name: 'Grace' });
		expect(await recorded()).toBeLessThanOrEqual(Date.now());
	} finally { web.close(); }
});

it('lasts on the server, for a ceremony the page begins before its tap, longer than the browser waits', async () => {
	await rpIds('chat.localhost', 'localhost');
	const { query } = await loginQuery(NEW);
	const before = Date.now();
	const begun = await begin(NEW, { query });
	// The browser's own timeout starts at the tap; the server's, at the begin.
	expect(begun.body.public_key.timeout).toBe(120_000);
	const expires = await runInDurableObject(stub(), async (_instance, state) => {
		const ceremonies = [...(await state.storage.list<{ challenge: { challengeId: string }; expiresMs: number }>({ prefix: 'signin-ceremony:' })).values()];
		return ceremonies.find((ceremony) => ceremony.challenge.challengeId === begun.body.challenge_id)?.expiresMs;
	});
	expect(expires! - before).toBeGreaterThanOrEqual(PAGE_CHALLENGE_TTL_MS);
	expect(expires! - Date.now()).toBeLessThanOrEqual(PAGE_CHALLENGE_TTL_MS);
	// The page uses one it began ahead only while a whole timeout still fits before it expires.
	expect(PAGE_PREPARED_FRESH_MS + 120_000).toBeLessThan(PAGE_CHALLENGE_TTL_MS);
});

it('answers the same finish again with its first answer, as the page retries one it got no answer to', async () => {
	await rpIds('chat.localhost', 'localhost');
	const app = await client(NEW);
	const query = app.url(`${NEW}/passkey?action=register&name=Grace`).searchParams.toString();
	const begun = await begin(NEW, { query });
	const made = await (await softPasskey(NEW)).register(begun.body.public_key);
	const first = await finish(NEW, begun.body.challenge_id, made);
	expect(first.status).toBe(200);
	expect(first.body.redirect).toMatch(/^com\.example\.myapp:\/signed-in\?code=/);
	// The same finish: the same answer, with the same code.
	expect(await finish(NEW, begun.body.challenge_id, made)).toEqual(first);
	// Another credential for the same challenge is no retry.
	const other = await (await softPasskey(NEW)).register(begun.body.public_key);
	expect(await finish(NEW, begun.body.challenge_id, other)).toEqual({ status: 400, body: { error: 'This passkey request expired. Try again.' } });
	// Nor is the same one from another origin that the page is served on.
	const SIDE = 'https://x.chat.localhost';
	const elsewhere = await SELF.fetch(`${SIDE}/passkey/finish`, { method: 'POST', body: JSON.stringify({ challenge_id: begun.body.challenge_id, credential: made }), headers: { 'CF-Connecting-IP': ip(), 'Content-Type': 'application/json', Origin: SIDE } });
	expect(elsewhere.status).toBe(400);
	// What is kept opens only with the credential: no code in it as stored.
	const stored = await runInDurableObject(stub(), async (_instance, state) => JSON.stringify([...(await state.storage.list({ prefix: 'signin-finished:' })).values()]));
	const code = new URL(first.body.redirect!).searchParams.get('code')!;
	expect(stored).not.toContain(code);
});

it('answers a retried finish even once the address has used up its sign-in attempts', async () => {
	await rpIds('chat.localhost', 'localhost');
	const app = await client(NEW);
	const query = app.url(`${NEW}/passkey?action=register&name=Grace`).searchParams.toString();
	// Straight to the object, as the entry Worker forwards a request it admitted: the object's own
	// per-address attempts, not the entry's limiter, are what this counts.
	const send = (route: 'begin' | 'finish', body: unknown) => stub().fetch(new Request(`https://signin.internal/__signin/${route}`, {
		method: 'POST', body: JSON.stringify(body),
		headers: { 'X-Apron-Trusted-IP-Key': 'retryingAddress0000000', 'X-Apron-Server-Origin': NEW, Origin: NEW, 'Content-Type': 'application/json' },
	}));
	const begun = await (await send('begin', { page: 'passkey', query })).json() as { challenge_id: string; public_key: any };
	const made = await (await softPasskey(NEW)).register(begun.public_key);
	const first = await send('finish', { challenge_id: begun.challenge_id, credential: made });
	expect(first.status).toBe(200);
	const answer = await first.json();
	let limited = false;
	for (let n = 0; n < 200 && !limited; n++) limited = (await send('finish', { challenge_id: `bogus${n}`, credential: made })).status === 429;
	expect(limited).toBe(true);
	const again = await send('finish', { challenge_id: begun.challenge_id, credential: made });
	expect(again.status).toBe(200);
	expect(await again.json()).toEqual(answer);
});

it("sends a finish again after the server couldn't be reached, and says so when the new passkey wasn't saved", async () => {
	const { passkey } = await legacyAccount();
	await rpIds('chat.localhost', 'localhost');
	const fresh = await softPasskey(NEW);
	let finishes = 0;
	const redirect = 'com.example.myapp:/signed-in?code=kept&state=s';
	const page = await signInPage({ localhost: passkey }, new Map([['apron-passkey-kind', 'old']]), {
		saves: fresh,
		finish: () => {
			finishes++;
			// The sign-in's first finish is lost on the way; the page sends it again.
			if (finishes === 1) return Promise.reject(new TypeError('Failed to fetch'));
			// The upgrade's answer: the sign-in's code, without the new passkey.
			if (finishes === 3) return Promise.resolve({ redirect, error: 'The new passkey could not be added.' });
			return undefined;
		},
	});
	page.tap();
	await vi.waitFor(() => expect(page.upgrade.hidden).toBe(false), { timeout: 5_000 });
	expect(finishes).toBe(2);
	page.save();
	// Said, not passed over: nothing opens until Continue.
	await vi.waitFor(() => expect(page.unsaved.hidden).toBe(false));
	expect(page.upgrade.hidden).toBe(true);
	expect(page.assigned).toEqual([]);
	page.proceed();
	expect(page.assigned).toEqual([redirect]);
});

it('begins a held ceremony again before it is too old, and on a tap after that, before the prompt', async () => {
	const { passkey } = await legacyAccount();
	await rpIds('chat.localhost', 'localhost');
	const clock = { now: 0 };
	const page = await signInPage({ localhost: passkey }, new Map([['apron-passkey-kind', 'old']]), { clock });
	expect(page.begins).toHaveLength(1);
	// Its timer begins it again while it is still fresh, so a later tap still goes straight to the prompt.
	expect(page.timers).toHaveLength(1);
	page.timers.shift()!();
	await vi.waitFor(() => expect(page.begins).toHaveLength(2));
	// One held past freshness (its timer not run, as in a throttled tab) is begun again at the tap.
	clock.now = PAGE_PREPARED_FRESH_MS + 1;
	page.tap();
	await vi.waitFor(() => expect(page.upgrade.hidden).toBe(false));
	// Three for the sign-in (the first, its refresh, and the tap's), then the upgrade's, prepared as it shows.
	await vi.waitFor(() => expect(page.begins).toHaveLength(4));
	expect(page.begins).toMatchObject([{ legacy: true }, { legacy: true }, { legacy: true }, { upgrade: expect.any(String) }]);
	expect(page.prompts).toEqual(['localhost']);
	// The sign-in's timers left behind begin nothing more; the upgrade's own still refreshes it.
	// Both set by now: the sign-in refresh's, and the upgrade's once its begin is answered.
	await vi.waitFor(() => expect(page.timers).toHaveLength(2));
	for (const run of page.timers.splice(0)) run();
	await vi.waitFor(() => expect(page.begins).toHaveLength(5));
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(page.begins).toHaveLength(5);
	expect(page.begins[4]).toMatchObject({ upgrade: expect.any(String) });
});

it('retries an RP ID that found none, and says so when neither did', async () => {
	const { passkey } = await legacyAccount();
	await rpIds('chat.localhost', 'localhost');
	// A device whose old passkey's prompt was closed by mistake, and which has no new one.
	const has: Record<string, Passkey> = {};
	const page = await signInPage(has, new Map());
	page.tap();
	await vi.waitFor(() => expect(page.tries.seen()[0]).toEqual(['login', 'None selected', '', true]));
	page.tap();
	await vi.waitFor(() => expect(page.tries.seen()).toEqual([['login', 'None selected', '', true], ['legacy', 'None selected', '', true]]));
	expect(page.auto.hidden).toBe(true);
	expect(page.status.textContent).toBe('Checked chat.localhost and localhost for passkey, none selected. Retry either, or cancel to go back.');
	// One ceremony held for each RP ID, for its Retry, and none begun twice: the first, the next, and each one again.
	await vi.waitFor(() => expect(page.begins).toHaveLength(4));
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(page.begins).toMatchObject([{ action: 'login' }, { legacy: true }, { action: 'login' }, { legacy: true }]);
	// Retry the old one, this time not closed.
	has.localhost = passkey;
	page.tries.retry('legacy');
	await vi.waitFor(() => expect(page.upgrade.hidden).toBe(false));
	expect(page.prompts).toEqual(['chat.localhost', 'localhost', 'localhost']);
	// On the upgrade screen, only the upgrade's own ceremony is held: the other RP ID's is dropped.
	await vi.waitFor(() => expect(page.begins.at(-1)).toMatchObject({ upgrade: expect.any(String) }));
	expect(page.begins).toHaveLength(5);
});

it("asks first for the RP ID the client's hints point to", async () => {
	const { passkey } = await legacyAccount();
	await rpIds('chat.localhost', 'localhost');
	// An account with a new passkey (its upgrade done), named by login_hint: the new kind first, on a device with no memory.
	const fresh = await softPasskey(NEW);
	const { query } = await loginQuery(NEW);
	const token = await legacySignIn(passkey, query);
	const added = await begin(NEW, { query, upgrade: token });
	await finish(NEW, added.body.challenge_id, await fresh.register(added.body.public_key));
	const userId = await runInDurableObject(stub(), (instance) => (instance as unknown as { store: { credentials: { get(id: string): { userId: string } } } }).store.credentials.get(fresh.id).userId);
	const hinted = await signInPage({ 'chat.localhost': fresh }, new Map(), { hints: { login_hint: userId } });
	hinted.tap();
	await vi.waitFor(() => expect(hinted.assigned).toHaveLength(1));
	expect(hinted.prompts).toEqual(['chat.localhost']);
	// `rp_id_last`: the client's own ceremony for RP_ID just found none, so the old kind first, even where this device would ask for the new.
	const last = await signInPage({ localhost: passkey }, new Map([['apron-passkey-kind', 'new']]), { hints: { rp_id_last: 'chat.localhost' } });
	last.tap();
	// Its account already has a new passkey, so no upgrade: straight back to the client.
	await vi.waitFor(() => expect(last.assigned).toHaveLength(1));
	expect(last.prompts).toEqual(['localhost']);
	// A hint that isn't one of this server's RP IDs, or names no account, says nothing.
	const ignored = await signInPage({}, new Map([['apron-passkey-kind', 'old']]), { hints: { rp_id_last: 'elsewhere.example', login_hint: 'nobody' } });
	ignored.tap();
	await vi.waitFor(() => expect(ignored.prompts).toEqual(['localhost']));
});

it('orders by the account first, then by the RP ID the client asks to be last', () => {
	const ids = { rpId: 'server.example', legacyRpId: 'example' };
	const old = { createdMs: 1 };
	const current = { createdMs: 3 };
	expect(firstKind({ ...ids, since: 2, passkeys: [current] })).toBe('login');
	expect(firstKind({ ...ids, since: 2, passkeys: [old] })).toBe('legacy');
	// Both kinds: the RP ID the client asks to be last goes last, else the newest.
	expect(firstKind({ ...ids, since: 2, passkeys: [old, current], last: 'server.example' })).toBe('legacy');
	expect(firstKind({ ...ids, since: 2, passkeys: [old, current] })).toBe('login');
	// No account: only the RP ID to ask for last.
	expect(firstKind({ ...ids, since: undefined, last: 'server.example' })).toBe('legacy');
	expect(firstKind({ ...ids, since: undefined, last: 'example' })).toBe('login');
	expect(firstKind({ ...ids, since: undefined })).toBeUndefined();
});

it('reads a credential a password manager hands back, as apron-web does', () => {
	const credentialJson = new Function(`${PAGE_HELPERS}; return credentialJson;`)() as (credential: unknown) => Record<string, any>;
	const bytes = (...values: number[]) => new Uint8Array(values);
	// 1Password's proxy in Firefox: toJSON throws, a field is reachable only through its getter, and
	// a field is a view from another realm.
	const proxy = {
		id: 'AQID', rawId: bytes(1, 2, 3).buffer, type: 'public-key',
		toJSON() { throw new Error('denied'); },
		getClientExtensionResults: () => ({}),
		response: {
			clientDataJSON: bytes(4, 5),
			get authenticatorData(): ArrayBuffer { throw new Error('denied'); },
			getAuthenticatorData: () => bytes(6).buffer,
			signature: bytes(7).buffer,
			userHandle: null,
		},
	};
	expect(credentialJson(proxy)).toEqual({ id: 'AQID', rawId: 'AQID', type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: 'BAU', authenticatorData: 'Bg', signature: 'Bw' } });
	// A toJSON that encodes a field otherwise (padded base64): the credential's own fields are sent.
	const padded = { ...proxy, toJSON: () => ({ id: 'AQID', rawId: 'AQID', type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: 'BAU=', authenticatorData: 'Bg', signature: 'Bw' } }) };
	expect(credentialJson(padded).response.clientDataJSON).toBe('BAU');
	// One that agrees, but leaves out clientExtensionResults: toJSON's, with the credential's own.
	const agrees = { ...proxy, toJSON: () => ({ id: 'AQID', rawId: 'AQID', type: 'public-key', response: { clientDataJSON: 'BAU', authenticatorData: 'Bg', signature: 'Bw' } }) };
	expect(credentialJson(agrees).clientExtensionResults).toEqual({});
});

// Last: it sweeps an hour ahead, which moves the store's effective clock on for any test after it.
it('sweeps a sign-in with a legacy passkey whose new passkey was never saved', async () => {
	const { passkey } = await legacyAccount();
	await rpIds('chat.localhost', 'localhost');
	// Earlier tests recorded the switch: this account's passkey counts as made before it, as a legacy one is.
	await runInDurableObject(stub(), (instance) => { (instance as unknown as { legacySince?: number }).legacySince = Date.now() + 3_600_000; });
	const { query } = await loginQuery(NEW);
	await legacySignIn(passkey, query);
	const left = await runInDurableObject(stub(), async (instance, state) => {
		const count = async () => (await state.storage.list({ prefix: 'signin-upgrade:' })).size;
		const before = await count();
		const server = instance as unknown as { sweepSignIn(now: number): Promise<boolean> };
		while (await server.sweepSignIn(Date.now() + 3_600_000)) { /* the next batch */ }
		return { before, after: await count() };
	});
	// This one, and any an earlier test left the same way.
	expect(left.before).toBeGreaterThanOrEqual(1);
	expect(left.after).toBe(0);
	await runInDurableObject(stub(), (instance) => { (instance as unknown as { legacySince?: number }).legacySince = undefined; });
});
