import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EMAIL_POLICY } from '../src/budget';
import { connect as open, exchange, request, until, type Frame, type Peer } from './helpers/socket';

let nextIp = 1;
const stub = () => env.DEMO.getByName('public-demo-v1');
const ADMIN_TOKEN = 'admin-token-0123456789abcdef';
const POLICY = EMAIL_POLICY!;
const ip = () => `192.0.2.${nextIp++}`;
const connect = (origin: string | null = 'http://localhost:5173', at = ip()) => open({ ip: at, origin });
const address = () => `ada.${crypto.randomUUID().slice(0, 8)}@example.com`;

type Mail = { to: string; subject: string; text: string };
type Runtime = {
	config: { email?: { policy: typeof POLICY }; adminToken?: string };
	deliverEmail(to: string, message: { subject: string; text: string }): Promise<void>;
	store: { registerIdentity(input: Record<string, unknown>): unknown };
	issueSession(userId: string, origin: string, now: number): Promise<string>;
};

/** Every email the server sends in a test, in place of the mail service. */
let outbox: Mail[] = [];

/** Runs with the plan's email policy changed by `changes` (none: the plan's own). */
async function setPolicy(changes: Partial<typeof POLICY> = {}): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const runtime = instance as unknown as Runtime;
		if (runtime.config.email) runtime.config = { ...runtime.config, email: { ...runtime.config.email, policy: { ...POLICY, ...changes } } };
	});
}

beforeEach(async () => {
	outbox = [];
	await runInDurableObject(stub(), (instance) => {
		const runtime = instance as unknown as Runtime;
		runtime.config = { ...runtime.config, adminToken: ADMIN_TOKEN };
		vi.spyOn(runtime, 'deliverEmail').mockImplementation(async (to, message) => { outbox.push({ to, ...message }); });
	});
	// Most tests mail one address more often than a day allows; the limits test restores it.
	await setPolicy({ sendsPerAddressDay: 20 });
});

afterEach(async () => {
	vi.restoreAllMocks();
	await runInDurableObject(stub(), (instance) => {
		const runtime = instance as unknown as Runtime;
		runtime.config = { ...runtime.config, adminToken: undefined };
	});
	await setPolicy();
});

/** A new connection past its `server` frame and welcome. */
async function fresh(origin?: string | null, at?: string): Promise<Peer> {
	const peer = await connect(origin, at);
	await peer.next();
	await peer.next();
	return peer;
}

/** Proposes `email` on `peer` (§4.11.1) and returns the email it sent, with its code and any link token. */
async function propose(peer: Peer, email: string, extra: Record<string, unknown> = {}): Promise<Mail & { code: string; link?: string; token?: string }> {
	const before = outbox.length;
	const reply = await request(peer, `propose-${crypto.randomUUID()}`, 'auth', { scheme: 'email', email, ...extra });
	expect(reply.error).toBeUndefined();
	expect(reply.result).toEqual({});
	expect(outbox.length).toBe(before + 1);
	const mail = outbox[outbox.length - 1];
	expect(mail.to).toBe(email.trim().toLowerCase());
	const code = /Your code is ([0-9]{6})\./.exec(mail.text)![1];
	const link = /^(https:\/\/link\.apron\.chat\/#\S+)$/m.exec(mail.text)?.[1];
	const token = link ? new URLSearchParams(link.split('#')[1]).get('token')! : undefined;
	return { ...mail, code, ...(link ? { link, token } : {}) };
}

async function approve(peer: Peer, token: string, scheme = 'email'): Promise<Frame> {
	return request(peer, `approve-${crypto.randomUUID()}`, 'auth', { scheme, token });
}

/** Registers a passkey user straight into the store and signs a connection in with a session token. */
async function signedIn(userId: string): Promise<Peer> {
	const token = await runInDurableObject(stub(), (instance) => {
		const runtime = instance as unknown as Runtime;
		runtime.store.registerIdentity({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
		return runtime.issueSession(userId, 'http://localhost:5173', Date.now());
	});
	const peer = await fresh();
	expect((await approve(peer, token, 'token')).result.you.user_id).toBe(userId);
	return peer;
}

async function admin(): Promise<Peer> {
	const peer = await fresh();
	expect((await approve(peer, ADMIN_TOKEN, 'token')).result.you.user_id).toBe('admin');
	return peer;
}

/** Runs a command in `general` and returns the `~private` notices before its result. */
async function command(peer: Peer, text: string): Promise<{ reply: Frame; notices: string[] }> {
	const { frame, skipped } = await exchange(peer, `cmd-${crypto.randomUUID()}`, 'command', { room_id: 'general', body: { text } });
	return { reply: frame, notices: skipped.filter((frame) => frame.params?.from?.user_id === '~private').map((frame) => frame.params.body.text) };
}

it('signs up an unknown address with the emailed code, and the session resumes on the same origin only', async () => {
	const email = address();
	const peer = await fresh();
	let session: string;
	try {
		const mail = await propose(peer, `  ${email.toUpperCase()} `, { name: 'Ada', state: 'q8Rz-state' });
		expect(mail.subject).toBe(`${mail.code} is your Apron Demo code`);
		expect(mail.text).toContain('create an account on Apron Demo');
		// The link carries the server from configuration, the token and the state (§4.11.2).
		expect(mail.link).toMatch(/^https:\/\/link\.apron\.chat\/#server=wss:\/\/demo\.test\/&token=apron_email_[A-Za-z0-9_-]{43}&state=q8Rz-state$/);
		const signedUp = await approve(peer, mail.code);
		expect(signedUp.result.you).toMatchObject({ name: 'Ada' });
		expect(signedUp.result.you.user_id).toMatch(/^ada_/);
		expect(typeof signedUp.result.token).toBe('string');
		session = signedUp.result.token;
		// The code is used up.
		expect((await approve(await fresh(), mail.token!)).error.code).toBe(-32001);
		const userId = signedUp.result.you.user_id;
		const again = await fresh();
		try { expect((await approve(again, session, 'token')).result.you.user_id).toBe(userId); } finally { again.close(); }
		// Bound to the origin it was issued to (§3.2.1, §5.2), passkey origin or not.
		for (const origin of ['http://localhost:8787', null]) {
			const elsewhere = await fresh(origin);
			try { expect((await approve(elsewhere, session, 'token')).error.code).toBe(-32001); } finally { elsewhere.close(); }
		}
		const { notices } = await command(peer, '/email');
		expect(notices[0]).toContain(email);
	} finally { peer.close(); }
});

it('signs in to the account that holds an address, with the link on any connection and either scheme', async () => {
	const email = address();
	const first = await fresh();
	const userId = await (async () => {
		try {
			const mail = await propose(first, email);
			return (await approve(first, mail.code)).result.you.user_id as string;
		} finally { first.close(); }
	})();
	const proposer = await fresh();
	const opener = await fresh(null);
	try {
		const mail = await propose(proposer, email, { state: 'abc' });
		// The reply says nothing of the account; the email does, to its owner.
		expect(mail.text).toContain(`sign in to Apron Demo as ${userId}`);
		const signedIn = await approve(opener, mail.token!, 'token');
		expect(signedIn.result.you.user_id).toBe(userId);
		expect(signedIn.result.token).toBeTruthy();
		// Approval used it up; the code too.
		expect((await approve(proposer, mail.code)).error.code).toBe(-32001);
	} finally { proposer.close(); opener.close(); }
});

it('keeps a connection that is not signed in open while its proposal lasts', async () => {
	const peer = await fresh();
	try {
		const deadline = () => runInDurableObject(stub(), (_instance, state) => state.getWebSockets()
			.map((socket) => socket.deserializeAttachment() as { authDeadline: number; emailProposal?: string; tier: string })
			.filter((attachment) => attachment.emailProposal && attachment.tier === 'pending')
			.map((attachment) => attachment.authDeadline));
		const before = Date.now();
		await propose(peer, address());
		const deadlines = await deadline();
		expect(deadlines.length).toBeGreaterThan(0);
		expect(Math.max(...deadlines)).toBeGreaterThanOrEqual(before + POLICY.proposalSeconds * 1_000);
	} finally { peer.close(); }
});

it('sends no link without state, works a code only where proposed, and cancels after too many wrong codes', async () => {
	const email = address();
	const proposer = await fresh();
	const other = await fresh();
	try {
		const mail = await propose(proposer, email);
		expect(mail.link).toBeUndefined();
		expect(mail.text).not.toContain('apron_email_');
		// Short codes work only on the connection that proposed (§4.11.2).
		expect((await approve(other, mail.code)).error.code).toBe(-32001);
		const wrong = mail.code === '000000' ? '111111' : '000000';
		for (let attempt = 1; attempt < POLICY.maxFailures; attempt++) {
			expect((await approve(proposer, wrong)).error).toMatchObject({ code: -32001, message: 'That code is not the one emailed' });
		}
		expect((await approve(proposer, wrong)).error.message).toMatch(/last try/);
		expect((await approve(proposer, mail.code)).error.code).toBe(-32001);
		// A new proposal replaces the last; the replaced one's code no longer works.
		const first = await propose(proposer, email);
		const second = await propose(proposer, address());
		if (first.code !== second.code) expect((await approve(proposer, first.code)).error.code).toBe(-32001);
		expect((await approve(proposer, second.code)).result.you.user_id).toBeTruthy();
	} finally { proposer.close(); other.close(); }
});

it('adds an address to the signed-in account, which then signs in with it', async () => {
	const userId = `adder_${crypto.randomUUID().slice(0, 6)}`;
	const email = address();
	const peer = await signedIn(userId);
	const stranger = await fresh();
	try {
		const mail = await propose(peer, email, { state: 's1' });
		expect(mail.text).toContain(`add this address to ${userId}`);
		// An addition works only on a connection of the account that proposed it (§4.11.3).
		expect((await approve(stranger, mail.token!)).error.code).toBe(-32001);
		expect(await approve(peer, mail.code)).toMatchObject({ result: {} });
		expect((await command(peer, '/email')).notices[0]).toContain(email);
		const later = await fresh();
		try {
			const signIn = await propose(later, email);
			expect((await approve(later, signIn.code)).result.you.user_id).toBe(userId);
		} finally { later.close(); }
		// An address another account holds is denied at approval, not at the proposal (§4.11.4).
		const other = await signedIn(`other_${crypto.randomUUID().slice(0, 6)}`);
		try {
			const taken = await propose(other, email);
			expect((await approve(other, taken.code)).error).toMatchObject({ code: -32001, message: 'That address belongs to another account' });
		} finally { other.close(); }
		// /email remove: the address no longer signs in, and signs up anew.
		expect((await command(peer, `/email remove ${email}`)).notices[0]).toContain('no longer signs you in');
		const after = await fresh();
		try {
			const signUp = await propose(after, email);
			expect(signUp.text).toContain('create an account');
			expect((await approve(after, signUp.code)).result.you.user_id).not.toBe(userId);
		} finally { after.close(); }
	} finally { peer.close(); stranger.close(); }
});

it('does not let a signed-in connection approve a sign-in, nor bots or the admin user add an address', async () => {
	const email = address();
	const proposer = await fresh();
	const busy = await signedIn(`busy_${crypto.randomUUID().slice(0, 6)}`);
	const boss = await admin();
	try {
		const mail = await propose(proposer, email, { state: 'x' });
		expect((await approve(busy, mail.token!)).error).toMatchObject({ code: -32001, message: 'Identity switching requires reconnect' });
		// That failure counted, but the proposal stands.
		expect((await approve(proposer, mail.token!)).result.you).toBeTruthy();
		const refused = await request(boss, 'boss', 'auth', { scheme: 'email', email: address() });
		expect(refused.error.code).toBe(-32001);
	} finally { proposer.close(); busy.close(); boss.close(); }
});

it('limits emails per address and per network, with retry_after', async () => {
	await setPolicy();
	const email = address();
	for (let sent = 0; sent < POLICY.sendsPerAddressDay; sent++) {
		const peer = await fresh();
		try { await propose(peer, email); } finally { peer.close(); }
	}
	const peer = await fresh();
	try {
		const refused = await request(peer, 'over', 'auth', { scheme: 'email', email });
		expect(refused.error).toMatchObject({ code: -32002, message: 'No more sign-in emails to this address today' });
	} finally { peer.close(); }
	// One network: a burst of three, then one a minute.
	const shared = ip();
	const peers = [await fresh(undefined, shared), await fresh(undefined, shared)];
	try {
		for (let sent = 0; sent < 3; sent++) await propose(peers[sent % 2], address());
		const refused = await request(peers[1], 'burst', 'auth', { scheme: 'email', email: address() });
		expect(refused.error).toMatchObject({ code: -32002, message: 'Sign-in emails limited; wait a minute' });
		expect(outbox.length).toBe(POLICY.sendsPerAddressDay + 3);
	} finally { for (const peer of peers) peer.close(); }
});

it('refuses malformed proposals before sending anything', async () => {
	// Each on a connection of its own: repeated invalid requests close a connection.
	for (const params of [{}, { email: 'not an address' }, { email: 'Ada <ada@example.com>' }, { email: address(), state: '' }, { email: address(), state: 'x'.repeat(257) }, { email: 7 }]) {
		const peer = await fresh();
		try {
			expect((await request(peer, 'bad', 'auth', { scheme: 'email', ...params })).error.code).toBe(-32602);
		} finally { peer.close(); }
	}
	const peer = await fresh();
	try {
		expect((await approve(peer, 'apron_email_nothing')).error.code).toBe(-32001);
		expect((await approve(peer, 'Hk41x9')).error.code).toBe(-32001);
		expect(outbox).toEqual([]);
	} finally { peer.close(); }
});

it('moves addresses with /rename, and removes them with /invite-purge and /purge', async () => {
	const email = address();
	const first = await fresh();
	let userId: string;
	let session: string;
	try {
		const mail = await propose(first, email);
		const signedUp = await approve(first, mail.code);
		userId = signedUp.result.you.user_id;
		session = signedUp.result.token;
	} finally { first.close(); }
	const boss = await admin();
	try {
		const renamed = `${userId}x`;
		expect((await command(boss, `/rename ${userId} ${renamed}`)).reply.result).toEqual({});
		const peer = await fresh();
		try {
			const mail = await propose(peer, email);
			expect(mail.text).toContain(`as ${renamed}`);
			expect((await approve(peer, mail.code)).result.you.user_id).toBe(renamed);
		} finally { peer.close(); }
		// /invite-purge takes the address away, and ends the email sessions.
		expect((await command(boss, `/invite-purge ${renamed}`)).notices.join('\n')).toContain('every token and email address');
		const resumed = await fresh();
		try { expect((await approve(resumed, session, 'token')).error.code).toBe(-32001); } finally { resumed.close(); }
		const peer2 = await fresh();
		try {
			const mail = await propose(peer2, email);
			expect(mail.text).toContain('create an account');
			const newUser = (await approve(peer2, mail.code)).result.you.user_id;
			expect(newUser).not.toBe(renamed);
			// /purge forgets the new account's address too.
			expect((await command(boss, `/purge ${newUser}`)).reply.result).toEqual({});
		} finally { peer2.close(); }
		const peer3 = await fresh();
		try { expect((await propose(peer3, email)).text).toContain('create an account'); } finally { peer3.close(); }
	} finally { boss.close(); }
});

it('is unsupported and unadvertised where the deployment has no sender', async () => {
	type Saved = Runtime & { savedEmail?: Runtime["config"]["email"] };
	await runInDurableObject(stub(), (instance) => {
		const runtime = instance as unknown as Saved;
		expect(runtime.config.email).toBeDefined();
		runtime.savedEmail = runtime.config.email;
		runtime.config = { ...runtime.config, email: undefined };
	});
	try {
		const peer = await connect();
		try {
			const server = (await peer.next()).params;
			expect(server.auth).toEqual(['webauthn', 'token', 'guest']);
			expect(server.signup).toEqual(['webauthn', 'token']);
			await peer.next();
			expect((await request(peer, 'email', 'auth', { scheme: 'email', email: address() })).error.code).toBe(-32601);
			expect((await request(peer, 'code', 'auth', { scheme: 'email', token: '123456' })).error.code).toBe(-32601);
			expect(outbox).toEqual([]);
		} finally { peer.close(); }
	} finally {
		await runInDurableObject(stub(), (instance) => {
			const runtime = instance as unknown as Saved;
			runtime.config = { ...runtime.config, email: runtime.savedEmail };
		});
	}
});
