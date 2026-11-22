import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { WebAuthnService } from '../src/auth';
import type { RuntimeConfig } from '../src/config';
import { connect as open, greeting, request, type Peer } from './helpers/socket';
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

type Server = { config: RuntimeConfig; webAuthn: WebAuthnService };
let kept: RuntimeConfig | undefined;

/** Sets the object's RP IDs, as RP_ID and LEGACY_RP_ID would. */
async function rpIds(rpId: string, legacyRpId?: string): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as Server;
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

/** An account made through the passkey page under the old RP ID, as it was before the move. */
async function legacyAccount(): Promise<{ passkey: Passkey; userId: string }> {
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
		return { passkey, userId: signedIn.result.you.user_id };
	} finally { peer.close(); }
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

it('signs in on the passkey page with a passkey made for the legacy RP ID, then adds one for the new', async () => {
	const { passkey, userId } = await legacyAccount();
	await rpIds('chat.localhost', 'localhost');

	// The page offers the older passkey, and has the next screen ready.
	const { app, query, url } = await loginQuery(NEW);
	const html = await (await SELF.fetch(url.href, { headers: { 'CF-Connecting-IP': ip() } })).text();
	expect(html).toContain('data-passkey="legacy">Use one made for localhost</button>');
	expect(html).toContain('<div id="upgrade" hidden>');

	// The usual sign-in is for the new RP ID; the legacy one, asked for, for the old.
	expect((await begin(NEW, { query })).body.public_key.rpId).toBe('chat.localhost');
	const legacy = await begin(NEW, { query, legacy: true });
	expect(legacy.status).toBe(200);
	expect(legacy.body.public_key.rpId).toBe('localhost');
	// The page's origin is the new host's, under both RP IDs.
	const signedIn = await finish(NEW, legacy.body.challenge_id, await passkey.assert(legacy.body.public_key, nextCounter(passkey), { origin: NEW }));
	expect(signedIn.status).toBe(200);
	expect(signedIn.body).toEqual({ redirect: expect.stringMatching(/^com\.example\.myapp:\/signed-in\?/), upgrade: expect.stringMatching(/^rq_/) });

	// The new passkey, for the new RP ID, excluding the old one, is added at once.
	const upgraded = await begin(NEW, { query, upgrade: signedIn.body.upgrade });
	expect(upgraded.status).toBe(200);
	expect(upgraded.body.public_key.rp.id).toBe('chat.localhost');
	expect(upgraded.body.public_key.excludeCredentials.map((entry: { id: string }) => entry.id)).toEqual([passkey.id]);
	const fresh = await softPasskey(NEW);
	expect(await finish(NEW, upgraded.body.challenge_id, await fresh.register(upgraded.body.public_key))).toEqual({ status: 200, body: { added: true } });
	await runInDurableObject(stub(), (instance) => {
		const store = (instance as unknown as { store: { credentials: { idsForUser(userId: string): string[] } } }).store;
		expect(store.credentials.idsForUser(userId).sort()).toEqual([passkey.id, fresh.id].sort());
	});

	// The code from the legacy sign-in still signs the client in.
	expect(await redeem(NEW, signedIn.body.redirect!, app)).toBe(userId);

	// And the new passkey signs in with the new RP ID.
	const next = await loginQuery(NEW);
	const again = await begin(NEW, { query: next.query });
	const done = await finish(NEW, again.body.challenge_id, await fresh.assert(again.body.public_key, nextCounter(fresh)));
	expect(done.status).toBe(200);
	expect(done.body.upgrade).toBeUndefined();
	expect(await redeem(NEW, done.body.redirect!, next.app)).toBe(userId);
});

it('takes the legacy RP ID only for a sign-in on the passkey page', async () => {
	const { passkey } = await legacyAccount();
	const { query } = await loginQuery(NEW);
	const refused = { status: 400, body: { error: 'The request was not understood.' } };

	// Without LEGACY_RP_ID, none.
	await rpIds('chat.localhost');
	expect(await begin(NEW, { query, legacy: true })).toEqual(refused);
	const html = await (await SELF.fetch(`${NEW}/passkey?${query}`, { headers: { 'CF-Connecting-IP': ip() } })).text();
	expect(html).not.toContain('data-passkey="legacy"');
	expect(html).not.toContain('id="upgrade"');

	await rpIds('chat.localhost', 'localhost');
	// Never for a new passkey.
	const register = (await loginQuery(NEW)).app.url(`${NEW}/passkey?action=register`).searchParams.toString();
	expect(await begin(NEW, { query: register, legacy: true })).toEqual(refused);
	// An assertion for the old RP ID answers only a legacy ceremony.
	const usual = await begin(NEW, { query });
	const crossed = await finish(NEW, usual.body.challenge_id, await passkey.assert({ ...usual.body.public_key, rpId: 'localhost' }, nextCounter(passkey), { origin: NEW }));
	expect(crossed.status).toBe(400);
	// An upgrade needs a handle a legacy sign-in gave.
	expect((await begin(NEW, { query, upgrade: `rq_${'A'.repeat(43)}` })).status).toBe(400);
	expect(await begin(NEW, { query, upgrade: 'rq_short' })).toEqual(refused);
	expect(await begin(NEW, { query, legacy: true, upgrade: `rq_${'A'.repeat(43)}` })).toEqual(refused);
	// A sign-in with a passkey for the new RP ID offers no upgrade.
	const fresh = await softPasskey(NEW);
	const unknown = await begin(NEW, { query });
	expect((await finish(NEW, unknown.body.challenge_id, await fresh.assert(unknown.body.public_key, nextCounter(fresh)))).body.upgrade).toBeUndefined();
});
