import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchEntry } from '../src/index';
import { connect as open, greeting, request, type Frame, type Peer } from './helpers/socket';
import { softPasskey } from './helpers/webauthn';

// The passkey page (protocol §4.10.1) and `external` (protocol
// §4.12) are served on a host that is the RP ID or under it. The suites'
// RP ID is `localhost`, so these connect to https://localhost, whose origin
// the page runs on; other suites reach demo.test, where nothing changes.
const ORIGIN = 'https://localhost';
const APP = 'com.example.myapp';
const APP_REDIRECT = `${APP}:/signed-in`;

let nextIp = 1;
const stub = () => env.DEMO.getByName('public-demo-v1');
const ip = () => `192.0.2.${nextIp++}`;
/** A connection to this host: `null` origin, as a native app sends; or the local web client's. */
const connect = (origin: string | null = null) => open({ ip: ip(), origin, host: 'localhost' });
type Passkey = Awaited<ReturnType<typeof softPasskey>>;
/** Each passkey's signature counter, which must move forward at each use. */
const counters = new WeakMap<Passkey, number>();
const nextCounter = (passkey: Passkey) => { const next = (counters.get(passkey) ?? 0) + 1; counters.set(passkey, next); return next; };

async function setExternal(on: boolean): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as { config: { externalSignIn: boolean } };
		server.config = { ...server.config, externalSignIn: on };
	});
}

afterEach(() => setExternal(false));

/** The Worker's environment with EXTERNAL_SIGN_IN on, for what it answers from its own configuration. */
const withExternal = () => ({ ...env, EXTERNAL_SIGN_IN: 'true' }) as unknown as Env;

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/** A client's side of an authorization request (protocol §4.12.2): PKCE, state, and the query it adds. */
async function client(redirectUri = APP_REDIRECT, clientId = APP) {
	const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
	const state = b64(crypto.getRandomValues(new Uint8Array(12)));
	const params = {
		response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
		code_challenge: challenge, code_challenge_method: 'S256', state, resource: ORIGIN,
	};
	return {
		verifier, state, redirectUri, clientId, params,
		/** `external.url` with the client's parameters added, keeping its own query. */
		url(base: string, overrides: Record<string, string | null> = {}) {
			const url = new URL(base);
			for (const [key, value] of Object.entries({ ...params, ...overrides })) {
				if (value === null) url.searchParams.delete(key);
				else url.searchParams.set(key, value);
			}
			return url;
		},
		/** What `auth` sends to redeem a code. */
		redeem(code: string, extra: Record<string, unknown> = {}) {
			return { code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId, ...extra };
		},
	};
}

type Client = Awaited<ReturnType<typeof client>>;

const page = (url: URL, init: RequestInit = {}) => SELF.fetch(url.href, { ...init, headers: { 'CF-Connecting-IP': ip(), ...init.headers } });
const pagePost = (path: string, body: unknown, origin: string | null = ORIGIN) => SELF.fetch(`${ORIGIN}${path}`, {
	method: 'POST', body: JSON.stringify(body),
	headers: { 'CF-Connecting-IP': ip(), 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
});

/**
 * What the page's script does: begin, run the passkey on the server's
 * origin, finish. `client` adds to the client data, as a frame would.
 */
async function ceremony(url: URL, passkey: Passkey, options: { page?: 'passkey' | 'authorize'; action?: 'login' | 'register'; client?: Record<string, unknown> } = {}) {
	const pageName = options.page ?? 'passkey';
	const begun = await pagePost('/passkey/begin', { page: pageName, query: url.searchParams.toString(), ...(options.action ? { action: options.action } : {}) });
	expect(begun.status).toBe(200);
	const { challenge_id, public_key } = await begun.json() as { challenge_id: string; public_key: any };
	const action = options.action ?? url.searchParams.get('action');
	const credential = action === 'login' ? await passkey.assert(public_key, nextCounter(passkey), options.client) : await passkey.register(public_key, options.client);
	const finished = await pagePost('/passkey/finish', { challenge_id, credential });
	return { status: finished.status, body: await finished.json() as { redirect?: string; error?: string }, publicKey: public_key };
}

/** The code and state the page sent back to the client's redirect. */
function returned(redirect: string, to: Client) {
	expect(redirect.startsWith(`${to.redirectUri}?`)).toBe(true);
	const url = new URL(redirect);
	expect(url.searchParams.get('state')).toBe(to.state);
	expect(url.searchParams.get('iss')).toBe(ORIGIN);
	return url.searchParams.get('code')!;
}

/** A `webauthn` begin on `peer`, which returns the passkey page's URL. */
async function begin(peer: Peer, action: 'login' | 'register', extra: Record<string, unknown> = {}): Promise<Frame> {
	return request(peer, `begin-${crypto.randomUUID()}`, 'auth', { scheme: 'webauthn', action, step: 'begin', ...extra });
}

/** Creates an account through the passkey page and signs `peer` in with its code. */
async function registerThroughPage(name = 'Ada'): Promise<{ peer: Peer; passkey: Passkey; userId: string; token: string }> {
	const peer = await connect();
	await greeting(peer);
	const begun = await begin(peer, 'register', { name });
	const app = await client();
	const passkey = await softPasskey(ORIGIN);
	const done = await ceremony(app.url(begun.result.external.url), passkey);
	expect(done.status).toBe(200);
	expect(done.body).toEqual({ redirect: expect.any(String) });
	const finished = await request(peer, 'finish', 'auth', { scheme: 'webauthn', action: 'register', step: 'finish', ...app.redeem(returned(done.body.redirect!, app)) });
	expect(finished.result.you.name).toBe(name);
	return { peer, passkey, userId: finished.result.you.user_id, token: finished.result.token };
}

/**
 * A `POST /oauth/token` from another site's client, form-encoded, through the
 * Worker with EXTERNAL_SIGN_IN on; `headers` adds to its own, such as HTTP Basic.
 */
const tokenRequest = (params: Record<string, string>, headers: Record<string, string> = {}) => fetchEntry(new Request(`${ORIGIN}/oauth/token`, {
	method: 'POST', body: new URLSearchParams(params).toString(),
	headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip(), Origin: 'https://chat.alice.dev', ...headers },
}), withExternal());

/** HTTP Basic for a public client (RFC 6749 §2.3.1): its form-urlencoded `client_id`, and an empty password. */
const basic = (clientId: string) => ({ Authorization: `Basic ${btoa(`${encodeURIComponent(clientId).replaceAll('%20', '+')}:`)}` });

/** Rewrites every stored code, and the new passkeys codes hold, to have expired. */
async function expireCodes(): Promise<void> {
	await runInDurableObject(stub(), async (_instance, state) => {
		for (const prefix of ['signin-code:', 'signin-pending:']) {
			const records = await state.storage.list<{ expiresMs: number }>({ prefix });
			for (const [key, value] of records) await state.storage.put(key, { ...value, expiresMs: Date.now() - 1 });
		}
	});
}

/** Moves every stored code, and the new passkeys codes hold, back in time, until the newest code has just expired. */
async function passCodeExpiry(): Promise<void> {
	await runInDurableObject(stub(), async (_instance, state) => {
		const codes = await state.storage.list<{ expiresMs: number }>({ prefix: 'signin-code:' });
		const by = Math.max(...[...codes.values()].map((code) => code.expiresMs)) - Date.now() + 1_000;
		for (const prefix of ['signin-code:', 'signin-pending:']) {
			const records = await state.storage.list<{ expiresMs: number }>({ prefix });
			for (const [key, value] of records) await state.storage.put(key, { ...value, expiresMs: value.expiresMs - by });
		}
	});
}

it('offers the passkey page in webauthn begin results, to every client on a host under the RP ID', async () => {
	// The local web client: a ceremony in the client, and the page besides.
	const web = await connect('http://localhost:5173');
	// A native app: no Origin, so no ceremony of its own; the page only.
	const app = await connect();
	// Where the host is not under the RP ID, nothing changes.
	const elsewhere = await open({ ip: ip(), origin: null });
	try {
		expect((await greeting(web)).server.params.auth).toEqual(['webauthn', 'token', 'guest']);
		const local = await begin(web, 'login');
		expect(local.result).toMatchObject({ challenge_id: expect.any(String), public_key: { rpId: 'localhost', userVerification: 'required' } });
		expect(local.result.external).toEqual({ url: `${ORIGIN}/passkey?action=login` });
		const named = await begin(web, 'register', { name: 'Ada Lovelace' });
		expect(named.result.external.url).toBe(`${ORIGIN}/passkey?action=register&name=Ada%20Lovelace`);

		const { server, welcome } = await greeting(app);
		expect(server.params.auth).toEqual(['webauthn', 'token', 'guest']);
		expect(server.params.signup).toEqual(['webauthn', 'token']);
		expect(server.params.welcome).toMatch(/Create a passkey/);
		expect(welcome.params.body.text).toMatch(/^Welcome to Apron Chat/);
		const remote = await begin(app, 'register');
		expect(remote.result).toEqual({ external: { url: `${ORIGIN}/passkey?action=register` } });
		// A credential finish still needs one of RP_ORIGINS.
		const finish = await request(app, 'f', 'auth', { scheme: 'webauthn', action: 'login', step: 'finish', challenge_id: 'x', credential: {} });
		expect(finish.error).toMatchObject({ code: -32001, message: 'This connection sends no Origin; use a code from the passkey page in external.url' });

		expect((await greeting(elsewhere)).server.params.auth).toEqual(['token', 'guest']);
		expect((await begin(elsewhere, 'login')).error).toMatchObject({ code: -32601, message: 'Passkeys are not offered to a connection that sends no Origin' });
	} finally { web.close(); app.close(); elsewhere.close(); }
});

it('says which origin it refuses passkeys in the client to', async () => {
	const rpOrigins = async (origins?: string[]) => runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as { config: { rpOrigins: string[] } };
		const kept = server.config.rpOrigins;
		if (origins) server.config = { ...server.config, rpOrigins: origins };
		return kept;
	});
	const kept = await rpOrigins();
	const web = 'http://localhost:5173';
	const token = await runInDurableObject(stub(), (instance) =>
		(instance as unknown as { issueSession(userId: string, origin: string, now: number): Promise<string> }).issueSession('user_origin_refused', web, Date.now()));
	await rpOrigins([]);
	const paged = await connect(web);
	const elsewhere = await open({ ip: ip(), origin: web });
	try {
		await greeting(paged);
		await greeting(elsewhere);
		const finish = await request(paged, 'f', 'auth', { scheme: 'webauthn', action: 'login', step: 'finish', challenge_id: 'x', credential: {} });
		expect(finish.error.message).toBe('Origin "http://localhost:5173" is not configured for passkeys; use a code from the passkey page in external.url');
		expect((await begin(elsewhere, 'login')).error).toMatchObject({ code: -32601, message: 'Passkeys are not offered to origin "http://localhost:5173"' });
		const resumed = await request(elsewhere, 'resume', 'auth', { scheme: 'token', token });
		expect(resumed.error).toMatchObject({ code: -32001, message: 'Origin "http://localhost:5173" is not configured for passkeys' });
	} finally {
		paged.close();
		elsewhere.close();
		await rpOrigins(kept);
	}
});

it('writes spaces in the passkey page\'s query as %20, so a client that encodes it again keeps the name', async () => {
	const peer = await connect();
	try {
		await greeting(peer);
		const begun = await begin(peer, 'register', { name: 'Sim Passkey+1' });
		expect(begun.result.external.url).toBe(`${ORIGIN}/passkey?action=register&name=Sim%20Passkey%2B1`);
		// A client that decodes each query item, with `+` as a plus, encodes
		// it again, and adds its own (protocol §4.12.1), as Foundation's
		// URLComponents does.
		const app = await client();
		const [base, query] = begun.result.external.url.split('?');
		const items = [...query.split('&').map((item: string) => item.split('=').map(decodeURIComponent)), ...Object.entries(app.params)];
		const url = new URL(`${base}?${items.map((item) => item.map(encodeURIComponent).join('=')).join('&')}`);
		expect(url.searchParams.get('name')).toBe('Sim Passkey+1');
		expect((await page(url)).status).toBe(200);
		const done = await ceremony(url, await softPasskey(ORIGIN));
		expect(done.status).toBe(200);
		const finished = await request(peer, 'finish', 'auth', { scheme: 'webauthn', action: 'register', step: 'finish', ...app.redeem(returned(done.body.redirect!, app)) });
		expect(finished.result.you.name).toBe('Sim Passkey+1');
	} finally { peer.close(); }
});

it('creates an account and signs in through the passkey page, with a bearer token that resumes from any client', async () => {
	const { peer, passkey, userId, token } = await registerThroughPage('Ada');
	peer.close();
	expect(userId).toMatch(/^ada_\d{4}$/);
	expect(token).toMatch(/^apron_session_/);
	// Not bound to an origin (protocol §4.10.1): no Origin, or the web client's.
	for (const origin of [null, 'http://localhost:5173']) {
		const again = await connect(origin);
		try {
			await greeting(again);
			expect((await request(again, 'resume', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(userId);
		} finally { again.close(); }
	}

	// Signing in: the page goes straight back with the code (no second screen), which signs in on any connection.
	const app = await client();
	const done = await ceremony(app.url(`${ORIGIN}/passkey?action=login`), passkey);
	expect(done.status).toBe(200);
	expect(done.body).toEqual({ redirect: expect.any(String) });
	const other = await connect();
	try {
		await greeting(other);
		// A guest connection signs in, as a passkey in the client would (§4.10).
		expect((await request(other, 'guest', 'auth', { scheme: 'guest' })).result.you.user_id).toMatch(/^guest_/);
		const signedIn = await request(other, 'finish', 'auth', { scheme: 'webauthn', action: 'login', step: 'finish', ...app.redeem(returned(done.body.redirect!, app)) });
		expect(signedIn.result.you).toMatchObject({ user_id: userId, name: 'Ada' });
		expect(signedIn.result.token).toMatch(/^apron_session_/);
	} finally { other.close(); }
});

it('validates the authorization request on the page itself, and never redirects an invalid one', async () => {
	const app = await client();
	const base = `${ORIGIN}/passkey?action=login`;
	const refused = async (overrides: Record<string, string | null>, text: RegExp) => {
		const response = await page(app.url(base, overrides), { redirect: 'manual' });
		expect(response.status).toBe(400);
		expect(response.headers.get('Location')).toBeNull();
		expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
		expect(response.headers.get('X-Frame-Options')).toBe('DENY');
		const body = await response.text();
		expect(body).toMatch(text);
		expect(body).not.toContain('<script nonce');
	};
	await refused({ redirect_uri: 'http://evil.example/callback' }, /return address \(redirect_uri\) is not one/);
	await refused({ redirect_uri: 'myapp:/no-dot' }, /redirect_uri/);
	await refused({ redirect_uri: 'https://chat.alice.dev/cb#fragment' }, /redirect_uri/);
	await refused({ redirect_uri: null }, /no return address/);
	await refused({ resource: 'https://other.example' }, /for another server \(https:\/\/other\.example\)/);
	await refused({ resource: null }, /must name this server/);
	await refused({ code_challenge: null }, /PKCE with S256/);
	await refused({ code_challenge_method: 'plain' }, /PKCE with S256/);
	await refused({ response_type: 'token' }, /response_type=code/);
	await refused({ state: null }, /state/);
	await refused({ client_id: null }, /client_id/);
	await refused({ action: 'switch' }, /action/);
	await refused({ action: 'register', request: 'rq_not-a-handle' }, /add a passkey is not valid/);
	await refused({ name: 'Ada' }, /mixes a sign-in with a new passkey/);

	// A valid request: the page, which names the client and is never framed or cached.
	const shown = await page(app.url(base));
	expect(shown.status).toBe(200);
	expect(shown.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
	expect(shown.headers.get('Content-Security-Policy')).toMatch(/frame-ancestors 'none'.*|.*frame-ancestors 'none'/);
	expect(shown.headers.get('X-Frame-Options')).toBe('DENY');
	expect(shown.headers.get('Cache-Control')).toBe('no-store');
	expect(shown.headers.get('Referrer-Policy')).toBe('no-referrer');
	const html = await shown.text();
	// One screen, before the passkey: who is asking, what they get, and the caution.
	expect(html).toContain('<h1>Sign in to Apron Demo on an app on this device (com.example.myapp)?</h1>\n<p>It will be able to read and send messages as you.</p>');
	expect(html).toContain('localhost has not verified this app.');
	expect(html).toContain('Only continue if you just started signing in on an app on this device.');
	expect(html).toContain('<button type="button" class="primary" data-passkey>Continue with passkey</button><button type="button" data-cancel>Cancel</button>');
	expect(html.match(/<h1>/g)).toHaveLength(1);
	for (const gone of ['Allow access', '>Allow<', 'Not you?', 'Use another passkey', 'Create an account']) expect(html).not.toContain(gone);
	// Cancel goes back with access_denied, state, and iss.
	const deny = new URL(JSON.parse(/<script type="application\/json" id="config">(.*?)<\/script>/.exec(html)![1]).deny);
	expect(deny.href.startsWith(`${APP_REDIRECT}?`)).toBe(true);
	expect(Object.fromEntries(deny.searchParams)).toEqual({ error: 'access_denied', state: app.state, iss: ORIGIN });

	// Who is asking, by the redirect: an https host; a loopback address.
	const web = await client('https://chat.alice.dev/callback', 'https://chat.alice.dev/client.json');
	const webHtml = await (await page(web.url(base))).text();
	expect(webHtml).toContain('<h1>Sign in to Apron Demo on chat.alice.dev?</h1>');
	expect(webHtml).toContain('Only continue if you just started signing in on chat.alice.dev.');
	const loopback = await client('http://127.0.0.1:53682/callback');
	const loopbackHtml = await (await page(loopback.url(base))).text();
	expect(loopbackHtml).toContain('<h1>Sign in to Apron Demo on an app on this device?</h1>');
	expect(loopbackHtml).toContain('Only continue if you just started signing in on an app on this device.');
	const registerHtml = await (await page(app.url(`${ORIGIN}/passkey?action=register&name=Ada`))).text();
	expect(registerHtml).toContain('<strong>An app on this device (com.example.myapp)</strong> wants to create an account for you on <strong>localhost</strong>, with a new passkey. It will be able to read and send messages as you.');
	expect(registerHtml).toContain('<button type="button" class="primary" data-passkey>Create passkey</button><button type="button" data-cancel>Cancel</button>');
	expect(registerHtml.match(/<h1>/g)).toHaveLength(1);

	// The page's own requests are checked again, and must come from the page.
	expect((await pagePost('/passkey/begin', { page: 'passkey', query: app.url(base, { resource: 'https://other.example' }).searchParams.toString() })).status).toBe(400);
	expect((await pagePost('/passkey/begin', { page: 'passkey', query: app.url(base).searchParams.toString() }, 'https://evil.example')).status).toBe(403);
	expect((await pagePost('/passkey/begin', { page: 'passkey', query: app.url(base).searchParams.toString() }, null)).status).toBe(403);
	expect((await pagePost('/passkey/finish', { challenge_id: 'missing', credential: {} })).status).toBe(400);
	// Elsewhere (a host not under the RP ID), there is no page.
	expect((await SELF.fetch(app.url(base).href.replace(ORIGIN, 'https://demo.test'), { headers: { 'CF-Connecting-IP': ip() } })).status).toBe(404);
});

it('refuses a ceremony run in a frame on another site: crossOrigin or topOrigin in the client data', async () => {
	const app = await client();
	const passkey = await softPasskey(ORIGIN);
	for (const framed of [{ crossOrigin: true }, { topOrigin: 'https://evil.example' }, { crossOrigin: false, topOrigin: ORIGIN }]) {
		const done = await ceremony(app.url(`${ORIGIN}/passkey?action=register&name=Framed`), passkey, { client: framed });
		expect(done.status).toBe(400);
		expect(done.body.redirect).toBeUndefined();
	}
	// The same passkey, not framed, works; crossOrigin: false alone is fine.
	const done = await ceremony(app.url(`${ORIGIN}/passkey?action=register&name=Framed`), passkey, { client: { crossOrigin: false } });
	expect(done.status).toBe(200);
	// A ceremony refused is used up.
	const begun = await pagePost('/passkey/begin', { page: 'passkey', query: app.url(`${ORIGIN}/passkey?action=login`).searchParams.toString() });
	const { challenge_id, public_key } = await begun.json() as { challenge_id: string; public_key: any };
	expect((await pagePost('/passkey/finish', { challenge_id, credential: await passkey.assert(public_key, nextCounter(passkey), { topOrigin: 'https://evil.example' }) })).status).toBe(400);
	expect((await pagePost('/passkey/finish', { challenge_id, credential: await passkey.assert(public_key, nextCounter(passkey)) })).status).toBe(400);
});

it('binds codes to their action, client, redirect, verifier and page, once, until they expire', async () => {
	const { peer, passkey, userId } = await registerThroughPage('Bea');
	peer.close();
	const signIn = async () => {
		const app = await client();
		const done = await ceremony(app.url(`${ORIGIN}/passkey?action=login`), passkey);
		return { app, code: returned(done.body.redirect!, app) };
	};
	const finish = (target: Peer, params: Record<string, unknown>, action = 'login') =>
		request(target, `finish-${crypto.randomUUID()}`, 'auth', { scheme: 'webauthn', action, step: 'finish', ...params });
	const fresh = async () => { const target = await connect(); await greeting(target); return target; };

	const target = await fresh();
	try {
		// Each mismatch is denied, and uses the code up.
		const wrongAction = await signIn();
		expect((await finish(target, wrongAction.app.redeem(wrongAction.code), 'register')).error.code).toBe(-32001);
		expect((await finish(target, wrongAction.app.redeem(wrongAction.code))).error.code).toBe(-32001);
		for (const wrong of [{ code_verifier: b64(crypto.getRandomValues(new Uint8Array(32))) }, { redirect_uri: 'com.example.other:/signed-in' }, { client_id: 'com.example.other' }]) {
			const attempt = await signIn();
			expect((await finish(target, attempt.app.redeem(attempt.code, wrong))).error.code).toBe(-32001);
			expect((await finish(target, attempt.app.redeem(attempt.code))).error.code).toBe(-32001);
		}
		// Expired.
		const late = await signIn();
		await expireCodes();
		expect((await finish(target, late.app.redeem(late.code))).error.code).toBe(-32001);
		// Once only: the second use is denied, also on another connection.
		const once = await signIn();
		expect((await finish(target, once.app.redeem(once.code))).result.you.user_id).toBe(userId);
		const second = await fresh();
		try {
			expect((await finish(second, once.app.redeem(once.code))).error.code).toBe(-32001);
		} finally { second.close(); }
		// A signed-in connection does not switch accounts with a code.
		const switching = await signIn();
		expect((await finish(target, switching.app.redeem(switching.code))).error.code).toBe(-32001);
	} finally { target.close(); }

	// The page binds: a passkey-page code does not finish `external`, nor an `/oauth/authorize` code `webauthn`.
	await setExternal(true);
	const crossed = await fresh();
	try {
		const passkeyCode = await signIn();
		expect((await request(crossed, 'ext', 'auth', { scheme: 'external', ...passkeyCode.app.redeem(passkeyCode.code) })).error.code).toBe(-32001);
		const app = await client();
		const authorized = await ceremony(app.url(`${ORIGIN}/oauth/authorize`), passkey, { page: 'authorize', action: 'login' });
		expect(authorized.status).toBe(200);
		expect((await finish(crossed, app.redeem(returned(authorized.body.redirect!, app)))).error.code).toBe(-32001);
	} finally { crossed.close(); }
});

it('adds a passkey through the page only to the account whose connection began it', async () => {
	const { peer: owner, userId } = await registerThroughPage('Cy');
	const { peer: stranger } = await registerThroughPage('Dee');
	try {
		const begun = await begin(owner, 'register');
		const url = new URL(begun.result.external.url);
		expect(url.searchParams.get('action')).toBe('register');
		expect(url.searchParams.get('request')).toMatch(/^rq_[A-Za-z0-9_-]{43}$/);
		expect(url.searchParams.has('name')).toBe(false);

		// The page names the account, on one screen.
		const app = await client();
		const html = await (await page(app.url(url.href))).text();
		expect(html).toContain(`<strong>An app on this device (com.example.myapp)</strong> wants to add a passkey to <strong>Cy (@${userId})</strong>’s account on <strong>localhost</strong>.`);
		expect(html).toContain('Create passkey');

		const passkey = await softPasskey(ORIGIN);
		const add = async () => {
			const done = await ceremony(app.url(url.href), passkey);
			expect(done.status).toBe(200);
			expect(done.body).toEqual({ redirect: expect.any(String) });
			return returned(done.body.redirect!, app);
		};
		const finish = (target: Peer, code: string) => request(target, `add-${crypto.randomUUID()}`, 'auth', { scheme: 'webauthn', action: 'register', step: 'finish', ...app.redeem(code) });
		// Another account's connection, and a connection that is not signed in, are denied,
		// and the code is kept for the account's own connection.
		const misplaced = await add();
		expect((await finish(stranger, misplaced)).error.code).toBe(-32001);
		const anonymous = await connect();
		try {
			await greeting(anonymous);
			expect((await finish(anonymous, misplaced)).error.code).toBe(-32001);
		} finally { anonymous.close(); }
		// The account's own connection adds it, and answers `you` only; then the code is used up.
		const added = await finish(owner, misplaced);
		expect(added.result).toEqual({ you: expect.objectContaining({ user_id: userId }) });
		expect((await finish(owner, misplaced)).error.code).toBe(-32001);
		const credentials = await runInDurableObject(stub(), (instance) => (instance as unknown as { store: { credentialIdsForUser(id: string): string[] } }).store.credentialIdsForUser(userId));
		expect(credentials).toHaveLength(2);
		expect(credentials).toContain(passkey.id);
		// The new passkey signs in through the page, to that account.
		const login = await client();
		const done = await ceremony(login.url(`${ORIGIN}/passkey?action=login`), passkey);
		expect(done.body).toEqual({ redirect: expect.any(String) });
		const signingIn = await connect();
		try {
			await greeting(signingIn);
			expect((await request(signingIn, 'login', 'auth', { scheme: 'webauthn', action: 'login', step: 'finish', ...login.redeem(returned(done.body.redirect!, login)) })).result.you.user_id).toBe(userId);
		} finally { signingIn.close(); }
	} finally { owner.close(); stranger.close(); }
});

it('tells the page of a passkey no account has, only when no code may still give it one', async () => {
	const login = async (passkey: Passkey) => ceremony((await client()).url(`${ORIGIN}/passkey?action=login`), passkey);
	const unknown = { error: "This passkey isn't for an account here. Try another passkey, or cancel to go back.", unknown_credential: true };
	const generic = { error: "That passkey didn't work here. Try again, or use another passkey." };
	type Server = { config: { signalUnknownPasskeys: boolean }; store: { getCredential(id: string): unknown }; pendingCredential(id: string): Promise<boolean> };

	// A passkey made on the page whose code was never redeemed: pending while its code may be.
	const orphan = await softPasskey(ORIGIN);
	expect((await ceremony((await client()).url(`${ORIGIN}/passkey?action=register&name=Orphan`), orphan)).status).toBe(200);
	expect(await login(orphan)).toMatchObject({ status: 400, body: generic });
	// Just past its code's expiry, a redemption that took the code may still be writing it.
	await passCodeExpiry();
	expect(await login(orphan)).toMatchObject({ status: 400, body: generic });
	// Once the grace has passed too, no account will have it.
	await expireCodes();
	expect(await login(orphan)).toMatchObject({ status: 400, body: unknown });
	// Nor one this server never saw.
	expect(await login(await softPasskey(ORIGIN))).toMatchObject({ status: 400, body: unknown });

	// An assertion for another origin, RP ID or challenge, a registration's client data, or
	// authenticator data that is only an RP ID hash, unsigned as it is without a key, is not classified.
	expect(await login(await softPasskey('https://evil.example'))).toMatchObject({ status: 400, body: generic });
	const elsewhere = await softPasskey(ORIGIN);
	const altered = (change: (options: { challenge: string; rpId: string }) => { challenge: string; rpId: string }, extra: Record<string, unknown> = {}): Passkey => ({
		...elsewhere, assert: (options, counter, client) => elsewhere.assert(change(options), counter, { ...client, ...extra }),
	});
	expect(await login(altered((options) => ({ ...options, rpId: 'example.com' })))).toMatchObject({ status: 400, body: generic });
	expect(await login(altered((options) => ({ ...options, challenge: b64(crypto.getRandomValues(new Uint8Array(32))) })))).toMatchObject({ status: 400, body: generic });
	expect(await login(altered((options) => options, { type: 'webauthn.create' }))).toMatchObject({ status: 400, body: generic });
	const rpIdHashOnly: Passkey = { ...elsewhere, assert: async (options, counter, client) => {
		const assertion = await elsewhere.assert(options, counter, client);
		const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(options.rpId)));
		return { ...assertion, response: { ...assertion.response, authenticatorData: b64(rpIdHash) } };
	} };
	expect(await login(rpIdHashOnly)).toMatchObject({ status: 400, body: generic });
	// The same passkey, unaltered, is unknown: each of those was the only difference.
	expect(await login(elsewhere)).toMatchObject({ status: 400, body: unknown });

	// A known passkey that fails verification: another key's signature under its credential ID.
	const { peer, passkey } = await registerThroughPage('Known');
	// A passkey an addition made, whose code was never redeemed, is pending as a new account's is.
	const addition = await softPasskey(ORIGIN);
	expect((await ceremony((await client()).url((await begin(peer, 'register')).result.external.url), addition)).status).toBe(200);
	peer.close();
	expect(await login(addition)).toMatchObject({ status: 400, body: generic });
	await expireCodes();
	expect(await login(addition)).toMatchObject({ status: 400, body: unknown });
	const forger = await softPasskey(ORIGIN);
	const forged = { ...forger, assert: async (options: any, counter?: number) => ({ ...await forger.assert(options, counter), id: passkey.id, rawId: passkey.id }) };
	const knownFails = await login(forged as Passkey);
	expect(knownFails.status).toBe(400);
	expect(knownFails.body).toEqual(generic);
	expect((await login(passkey)).body).toEqual({ redirect: expect.any(String) });

	// A failed lookup, or a failed read of pending passkeys, is the usual error.
	const stranger = await softPasskey(ORIGIN);
	const broken = async (patch: (server: Server) => () => void) => {
		const restore = await runInDurableObject(stub(), (instance) => patch(instance as unknown as Server));
		try { return await login(stranger); } finally { await runInDurableObject(stub(), () => restore()); }
	};
	expect(await broken((server) => {
		const store = server.store;
		const original = store.getCredential;
		store.getCredential = () => { throw new Error('storage unavailable'); };
		return () => { store.getCredential = original; };
	})).toMatchObject({ status: 503, body: { error: 'Something went wrong. Try again.' } });
	expect(await broken((server) => {
		server.pendingCredential = async () => { throw new Error('storage unavailable'); };
		return () => { delete (server as Partial<Server>).pendingCredential; };
	})).toMatchObject({ status: 503, body: { error: 'Something went wrong. Try again.' } });
	// With the signal off, as by default (loadConfig), an unknown passkey's answer is exactly a
	// known one's that fails: no message or flag tells a registered credential ID from another.
	const off = await broken((server) => {
		server.config = { ...server.config, signalUnknownPasskeys: false };
		return () => { server.config = { ...server.config, signalUnknownPasskeys: true }; };
	});
	expect({ status: off.status, body: off.body }).toEqual({ status: knownFails.status, body: knownFails.body });
	expect(await login(stranger)).toMatchObject({ status: 400, body: unknown });
});

it('offers external with EXTERNAL_SIGN_IN: metadata, /oauth/authorize with a passkey, codes on the connection or at /oauth/token', async () => {
	// Off by default: no metadata, no authorize page, and `external` is unsupported.
	expect((await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).status).toBe(404);
	const off = await connect();
	try {
		const { server } = await greeting(off);
		expect(server.params.auth).not.toContain('external');
		expect(server.params.capabilities).not.toContain('ext:oauth');
		expect((await request(off, 'ext', 'auth', { scheme: 'external' })).error.code).toBe(-32601);
	} finally { off.close(); }

	await setExternal(true);
	const metadata = await fetchEntry(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), withExternal());
	expect(metadata.status).toBe(200);
	expect(metadata.headers.get('Access-Control-Allow-Origin')).toBe('*');
	expect(await metadata.json()).toEqual({
		issuer: ORIGIN,
		authorization_endpoint: `${ORIGIN}/oauth/authorize`,
		token_endpoint: `${ORIGIN}/oauth/token`,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none'],
		authorization_response_iss_parameter_supported: true,
	});
	// Only on a host the page serves.
	expect((await fetchEntry(new Request('https://demo.test/.well-known/oauth-authorization-server'), withExternal())).status).toBe(404);

	const peer = await connect();
	try {
		const { server } = await greeting(peer);
		expect(server.params.auth).toEqual(['webauthn', 'token', 'external', 'guest']);
		expect(server.params.signup).toEqual(['webauthn', 'token', 'external']);
		// The metadata, the token endpoint and their CORS are `ext:oauth`'s.
		expect(server.params.capabilities).toContain('ext:oauth');
		expect((await request(peer, 'begin', 'auth', { scheme: 'external' })).result).toEqual({ external: { url: `${ORIGIN}/oauth/authorize` } });
		// This server's own tokens are for `token`.
		expect((await request(peer, 'token', 'auth', { scheme: 'external', token: 'anything' })).error.code).toBe(-32001);

		// A new account on /oauth/authorize, redeemed on the connection.
		const app = await client();
		const shown = await fetchEntry(new Request(app.url(`${ORIGIN}/oauth/authorize`).href, { headers: { 'CF-Connecting-IP': ip() } }), withExternal());
		expect(shown.status).toBe(200);
		expect(shown.headers.get('X-Frame-Options')).toBe('DENY');
		const html = await shown.text();
		// The same one screen as the passkey page, with "Create an account" running a new passkey from it.
		expect(html).toContain('<h1>Sign in to Apron Demo on an app on this device (com.example.myapp)?</h1>');
		expect(html).toContain('<button type="button" class="primary" data-passkey>Continue with passkey</button><button type="button" data-cancel>Cancel</button>');
		expect(html).toContain('New here? <button type="button" class="link" data-passkey="register">Create an account</button>');
		expect(html.match(/<h1>/g)).toHaveLength(1);
		for (const gone of ['Allow access', '>Allow<', 'Not you?', 'Already have an account?']) expect(html).not.toContain(gone);
		const passkey = await softPasskey(ORIGIN);
		const created = await ceremony(app.url(`${ORIGIN}/oauth/authorize`), passkey, { page: 'authorize', action: 'register' });
		expect(created.status).toBe(200);
		const signedUp = await request(peer, 'redeem', 'auth', { scheme: 'external', ...app.redeem(returned(created.body.redirect!, app)) });
		const userId = signedUp.result.you.user_id;
		expect(signedUp.result.token).toMatch(/^apron_session_/);

		// On the signed-in connection, a code for the same account only answers `you`.
		const again = await client();
		const same = await ceremony(again.url(`${ORIGIN}/oauth/authorize`), passkey, { page: 'authorize', action: 'login' });
		expect(same.body).toEqual({ redirect: expect.any(String) });
		expect((await request(peer, 'same', 'auth', { scheme: 'external', ...again.redeem(returned(same.body.redirect!, again)) })).result).toEqual({ you: expect.objectContaining({ user_id: userId }) });

		// Another account's identity is denied on a signed-in connection, and on a guest's.
		const { peer: other } = await registerThroughPage('Eve');
		const guest = await connect();
		try {
			await greeting(guest);
			await request(guest, 'guest', 'auth', { scheme: 'guest' });
			for (const target of [other, guest]) {
				const attempt = await client();
				const done = await ceremony(attempt.url(`${ORIGIN}/oauth/authorize`), passkey, { page: 'authorize', action: 'login' });
				expect((await request(target, 'cross', 'auth', { scheme: 'external', ...attempt.redeem(returned(done.body.redirect!, attempt)) })).error.code).toBe(-32001);
			}
		} finally { other.close(); guest.close(); }

		// The token endpoint: form-encoded, open to any origin, an Apron token for `token`.
		const library = await client('https://chat.alice.dev/callback', 'https://chat.alice.dev/client.json');
		const done = await ceremony(library.url(`${ORIGIN}/oauth/authorize`), passkey, { page: 'authorize', action: 'login' });
		const code = returned(done.body.redirect!, library);
		const form = { grant_type: 'authorization_code', code, code_verifier: library.verifier, redirect_uri: library.redirectUri, client_id: library.clientId };
		const wrongResource = await tokenRequest({ ...form, resource: 'https://other.example' });
		expect(wrongResource.status).toBe(400);
		expect(await wrongResource.json()).toEqual({ error: 'invalid_target' });
		expect(await (await tokenRequest({ ...form, grant_type: 'password' })).json()).toEqual({ error: 'unsupported_grant_type' });
		const issued = await tokenRequest({ ...form, resource: ORIGIN });
		expect(issued.status).toBe(200);
		expect(issued.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(issued.headers.get('Cache-Control')).toBe('no-store');
		const body = await issued.json() as { access_token: string; token_type: string; expires_in: number };
		expect(body).toMatchObject({ token_type: 'Bearer', expires_in: expect.any(Number) });
		expect(body.access_token).toMatch(/^apron_session_/);
		const reused = await tokenRequest(form);
		expect(reused.status).toBe(400);
		expect(await reused.json()).toEqual({ error: 'invalid_grant' });
		const resumed = await connect();
		try {
			await greeting(resumed);
			expect((await request(resumed, 'resume', 'auth', { scheme: 'token', token: body.access_token })).result.you.user_id).toBe(userId);
		} finally { resumed.close(); }
		// A passkey-page code is not for the token endpoint.
		const pageClient = await client();
		const pageDone = await ceremony(pageClient.url(`${ORIGIN}/passkey?action=login`), passkey);
		const pageCode = returned(pageDone.body.redirect!, pageClient);
		expect(await (await tokenRequest({ grant_type: 'authorization_code', code: pageCode, code_verifier: pageClient.verifier, redirect_uri: pageClient.redirectUri, client_id: pageClient.clientId })).json()).toEqual({ error: 'invalid_grant' });
	} finally { peer.close(); }
});

it('keeps an external code a connection cannot take for one that can, and names a new account by the request', async () => {
	await setExternal(true);
	const fresh = async () => { const target = await connect(); await greeting(target); return target; };
	const redeem = (target: Peer, params: Record<string, unknown>) => request(target, `ext-${crypto.randomUUID()}`, 'auth', { scheme: 'external', ...params });
	const newAccount = async () => {
		const app = await client();
		const passkey = await softPasskey(ORIGIN);
		const created = await ceremony(app.url(`${ORIGIN}/oauth/authorize`), passkey, { page: 'authorize', action: 'register' });
		expect(created.status).toBe(200);
		return { app, passkey, code: returned(created.body.redirect!, app) };
	};
	const { peer: signedIn } = await registerThroughPage('Fay');
	const targets: Peer[] = [signedIn];
	try {
		// A new account's code on a signed-in connection is denied, and still works on a new connection.
		const kept = await newAccount();
		expect((await redeem(signedIn, kept.app.redeem(kept.code))).error.code).toBe(-32001);
		const target = await fresh();
		targets.push(target);
		// A name over the limits is `too_large` before the code is tried.
		expect((await redeem(target, kept.app.redeem(kept.code, { name: 'x'.repeat(1_000) }))).error.code).toBe(-32003);
		const signedUp = await redeem(target, kept.app.redeem(kept.code, { name: '  Gil  ' }));
		expect(signedUp.result.you).toMatchObject({ user_id: expect.stringMatching(/^gil_\d{4}$/), name: 'Gil' });
		expect(signedUp.result.token).toMatch(/^apron_session_/);
		// Then it is used up, and its passkey signs in to the new account.
		const again = await fresh();
		targets.push(again);
		expect((await redeem(again, kept.app.redeem(kept.code))).error.code).toBe(-32001);
		const login = await client();
		const done = await ceremony(login.url(`${ORIGIN}/oauth/authorize`), kept.passkey, { page: 'authorize', action: 'login' });
		expect((await redeem(again, login.redeem(returned(done.body.redirect!, login)))).result.you.user_id).toBe(signedUp.result.you.user_id);

		// An invalid attempt still uses the code up.
		const burned = await newAccount();
		const other = await fresh();
		targets.push(other);
		expect((await redeem(other, burned.app.redeem(burned.code, { code_verifier: b64(crypto.getRandomValues(new Uint8Array(32))) }))).error.code).toBe(-32001);
		expect((await redeem(other, burned.app.redeem(burned.code))).error.code).toBe(-32001);

		// Without a name, the new account is a "Member", never a "Guest".
		const unnamed = await newAccount();
		const member = await redeem(other, unnamed.app.redeem(unnamed.code));
		expect(member.result.you).toMatchObject({ user_id: expect.stringMatching(/^member_\d{4}$/), name: 'Member' });
	} finally { for (const target of targets) target.close(); }
});

it('takes a public client\'s client_id at /oauth/token in the body or with HTTP Basic, and keeps a code it refuses before redeeming', async () => {
	await setExternal(true);
	const { peer, passkey, userId } = await registerThroughPage('Ada');
	peer.close();
	// The client ID is a URL, so its `:` and `/` are form-urlencoded in Basic.
	const signIn = async () => {
		const library = await client('https://chat.alice.dev/callback', 'https://chat.alice.dev/client.json');
		const done = await ceremony(library.url(`${ORIGIN}/oauth/authorize`), passkey, { page: 'authorize', action: 'login' });
		const code = returned(done.body.redirect!, library);
		/** What every request sends but the client: x/oauth2's `Exchange` with PKCE and `resource`. */
		const form = { grant_type: 'authorization_code', code, code_verifier: library.verifier, redirect_uri: library.redirectUri, resource: ORIGIN };
		return { library, form };
	};
	const signsIn = async (response: Response) => {
		expect(response.status).toBe(200);
		const body = await response.json() as { access_token: string };
		const resumed = await connect();
		try {
			await greeting(resumed);
			expect((await request(resumed, 'resume', 'auth', { scheme: 'token', token: body.access_token })).result.you.user_id).toBe(userId);
		} finally { resumed.close(); }
	};

	// A browser client may send Basic across origins.
	const preflight = await fetchEntry(new Request(`${ORIGIN}/oauth/token`, { method: 'OPTIONS', headers: { Origin: 'https://chat.alice.dev', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } }), withExternal());
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');

	// Basic alone.
	const alone = await signIn();
	await signsIn(await tokenRequest(alone.form, basic(alone.library.clientId)));

	// Basic and the body, when they agree.
	const both = await signIn();
	await signsIn(await tokenRequest({ ...both.form, client_id: both.library.clientId }, basic(both.library.clientId)));

	// Refused before the code is looked up, it stays usable: Basic for another client than the body's, a password,
	// another scheme, a malformed credential, no client at all, a repeated client_id, or another grant type.
	const refused = await signIn();
	const withBody = { ...refused.form, client_id: refused.library.clientId };
	for (const [form, headers, status, error] of [
		[withBody, basic('https://evil.example/client.json'), 401, 'invalid_client'],
		[refused.form, { Authorization: `Basic ${btoa(`${encodeURIComponent(refused.library.clientId)}:secret`)}` }, 401, 'invalid_client'],
		[withBody, { Authorization: 'Bearer anything' }, 401, 'invalid_client'],
		[refused.form, { Authorization: 'Basic not-base64!' }, 401, 'invalid_client'],
		[refused.form, { Authorization: `Basic ${btoa(':')}` }, 401, 'invalid_client'],
		[refused.form, {}, 400, 'invalid_request'],
		[{ ...withBody, client_id: '' }, {}, 400, 'invalid_request'],
		[{ ...withBody, grant_type: 'password' }, basic(refused.library.clientId), 400, 'unsupported_grant_type'],
	] as const) {
		const response = await tokenRequest(form, headers);
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ error });
		if (status === 401) expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="token"');
	}
	const repeated = new URLSearchParams(withBody);
	repeated.append('client_id', refused.library.clientId);
	expect(await (await fetchEntry(new Request(`${ORIGIN}/oauth/token`, {
		method: 'POST', body: repeated.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip() },
	}), withExternal())).json()).toEqual({ error: 'invalid_request' });
	await signsIn(await tokenRequest(withBody));
	// A redemption attempt uses the code up, Basic or not.
	expect(await (await tokenRequest(refused.form, basic(refused.library.clientId))).json()).toEqual({ error: 'invalid_grant' });

	// x/oauth2's AutoDetect: Basic with url.QueryEscape'd credentials and no client_id in the body, then, only
	// if that fails, the client_id in the body. The first now succeeds; had it been refused, the code would
	// have been kept for the second (above).
	const detect = await signIn();
	const queryEscape = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).replaceAll('%20', '+');
	const attempts: string[] = [];
	let response = await tokenRequest(detect.form, { Authorization: `Basic ${btoa(`${queryEscape(detect.library.clientId)}:${queryEscape('')}`)}` });
	attempts.push(`header ${response.status}`);
	if (!response.ok) {
		response = await tokenRequest({ ...detect.form, client_id: detect.library.clientId });
		attempts.push(`params ${response.status}`);
	}
	expect(attempts).toEqual(['header 200']);
	await signsIn(response);
});

it('asks the device to drop the passkey it just used, only when the page says no account has it', async () => {
	// The page's own script and configuration, run against the server with a stand-in browser.
	const run = async (passkey: Passkey) => {
		const html = await (await page((await client()).url(`${ORIGIN}/passkey?action=login`))).text();
		const config = html.match(/<script type="application\/json" id="config">(.*?)<\/script>/s)![1];
		const script = html.match(/<script nonce="[^"]*">(.*?)<\/script>/s)![1];
		const status = { textContent: '' };
		const clicks: (() => void)[] = [];
		const button = { dataset: {}, disabled: false, addEventListener: (_type: string, listener: () => void) => clicks.push(listener) };
		const document = {
			getElementById: (id: string) => id === 'config' ? { textContent: config } : status,
			querySelectorAll: (selector: string) => selector === '[data-cancel]' ? [] : [button],
		};
		const signals: unknown[] = [];
		const PublicKeyCredential = {
			parseRequestOptionsFromJSON: (json: unknown) => json,
			signalUnknownCredential: async (options: unknown) => { signals.push(options); },
		};
		const navigator = { credentials: { get: async ({ publicKey }: { publicKey: { challenge: string; rpId: string } }) => {
			const assertion = await passkey.assert(publicKey, nextCounter(passkey));
			return { id: assertion.id, toJSON: () => assertion };
		} } };
		const begins: string[] = [];
		const fetch = (path: string, init: { body: string }) => {
			if (path === '/passkey/begin') begins.push(path);
			return pagePost(path, JSON.parse(init.body));
		};
		new Function('window', 'document', 'navigator', 'PublicKeyCredential', 'fetch', 'location', script)(
			{ PublicKeyCredential }, document, navigator, PublicKeyCredential, fetch, { assign: () => { throw new Error('left the page'); } },
		);
		clicks[0]();
		await vi.waitFor(() => expect(status.textContent).not.toBe(''));
		await vi.waitFor(() => expect(begins).toHaveLength(2));
		return { status: status.textContent, signals };
	};

	// A passkey no account has: its own ID, for the page's RP ID.
	const stranger = await softPasskey(ORIGIN);
	expect(await run(stranger)).toEqual({ status: "This passkey isn't for an account here. Try another passkey, or cancel to go back.", signals: [{ rpId: 'localhost', credentialId: stranger.id }] });
	// Any other error asks nothing.
	expect(await run(await softPasskey('https://evil.example'))).toEqual({ status: "That passkey didn't work here. Try again, or use another passkey.", signals: [] });
});

it('sweeps expired codes, ceremonies and addition handles from their expiry index', async () => {
	const app = await client();
	// A ceremony begun and never finished, and a code never redeemed.
	await pagePost('/passkey/begin', { page: 'passkey', query: app.url(`${ORIGIN}/passkey?action=login`).searchParams.toString() });
	const done = await ceremony(app.url(`${ORIGIN}/passkey?action=register&name=Swept`), await softPasskey(ORIGIN));
	expect(done.status).toBe(200);
	const records = () => runInDurableObject(stub(), async (_instance, state) => [...(await state.storage.list({ prefix: 'signin-' })).keys()]);
	expect((await records()).some((key) => key.startsWith('signin-code:'))).toBe(true);
	expect((await records()).some((key) => key.startsWith('signin-ceremony:'))).toBe(true);
	expect((await records()).some((key) => key.startsWith('signin-pending:'))).toBe(true);
	// Past the longest lifetime (an addition handle's 10 minutes), every record and entry goes.
	await runInDurableObject(stub(), async (instance) => {
		const sweep = (instance as unknown as { sweepSignIn(now: number): Promise<boolean> }).sweepSignIn.bind(instance);
		while (await sweep(Date.now() + 11 * 60_000)) { /* a full batch may leave more */ }
	});
	expect(await records()).toEqual([]);
});
