import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { fetchEntry } from '../src/index';

// A self-hosted server whose RP ID is its own host, used from a shared client
// elsewhere. No Durable Object binding: the answer must not need one.
function selfHosted(extra: Record<string, string | undefined> = {}): Env {
	return {
		...env,
		DEMO: undefined,
		RP_ID: 'apron.shazow.net',
		RP_ORIGINS: 'https://apron.shazow.net,https://web.apron.chat',
		ALLOWED_ORIGINS: 'https://apron.shazow.net,https://web.apron.chat',
		...extra,
	} as unknown as Env;
}

const wellKnown = (host: string, method = 'GET') => new Request(`https://${host}/.well-known/webauthn`, { method });

it('publishes RP_ORIGINS as related origins on the RP ID host', async () => {
	const response = await fetchEntry(wellKnown('apron.shazow.net'), selfHosted());
	expect(response.status).toBe(200);
	expect(response.headers.get('Content-Type')).toBe('application/json');
	expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
	expect(await response.json()).toEqual({ origins: ['https://apron.shazow.net', 'https://web.apron.chat'] });
	// Host names compare without case, as browsers send them.
	expect((await fetchEntry(wellKnown('Apron.Shazow.NET'), selfHosted())).status).toBe(200);
	const head = await fetchEntry(wellKnown('apron.shazow.net', 'HEAD'), selfHosted());
	expect(head.status).toBe(200);
	expect(head.headers.get('Content-Type')).toBe('application/json');
	expect(await head.text()).toBe('');
});

it('is not found on a host other than the RP ID', async () => {
	// As in production: the Worker on server.apron.chat, RP ID apron.chat.
	const production = selfHosted({ RP_ID: 'apron.chat', RP_ORIGINS: 'https://web.apron.chat', ALLOWED_ORIGINS: '*' });
	expect((await fetchEntry(wellKnown('server.apron.chat'), production)).status).toBe(404);
	expect((await fetchEntry(wellKnown('web.apron.shazow.net'), selfHosted())).status).toBe(404);
	// Only GET and HEAD, and only that path.
	expect((await fetchEntry(wellKnown('apron.shazow.net', 'POST'), selfHosted())).status).toBe(404);
	expect((await fetchEntry(new Request('https://apron.shazow.net/.well-known/webauthn/'), selfHosted())).status).toBe(404);
});

it('is not found where passkeys are not configured', async () => {
	// No RP_ID: only the local default, which nothing needs published.
	expect((await fetchEntry(wellKnown('localhost'), selfHosted({ RP_ID: undefined }))).status).toBe(404);
	// A configuration that does not load offers no passkeys.
	const unconfigured = selfHosted({ ALLOWED_ORIGINS: undefined, RP_ORIGINS: undefined, ENVIRONMENT: undefined, NODE_ENV: undefined });
	expect((await fetchEntry(wellKnown('apron.shazow.net'), unconfigured)).status).toBe(404);
});
