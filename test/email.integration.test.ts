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
	const mail = await proposeAny(peer, email, extra);
	expect(mail.code).toMatch(/^[0-9]{6}$/);
	return mail as Mail & { code: string };
}

/** Proposes `email` on `peer` and returns the email it sent, which may carry no code. */
async function proposeAny(peer: Peer, email: string, extra: Record<string, unknown> = {}): Promise<Mail & { code?: string; link?: string; token?: string }> {
	const before = outbox.length;
	const reply = await request(peer, `propose-${crypto.randomUUID()}`, 'auth', { scheme: 'email', email, ...extra });
	expect(reply.error).toBeUndefined();
	expect(reply.result).toEqual({});
	expect(outbox.length).toBe(before + 1);
	const mail = outbox[outbox.length - 1];
	expect(mail.to).toBe(email.trim().toLowerCase());
	const code = /Your code is ([0-9]{6})\./.exec(mail.text)?.[1];
	const link = /^(https:\/\/link\.apron\.chat\/#\S+)$/m.exec(mail.text)?.[1];
	const token = link ? new URLSearchParams(link.split('#')[1]).get('token')! : undefined;
	return { ...mail, ...(code ? { code } : {}), ...(link ? { link, token } : {}) };
}

async function approve(peer: Peer, token: string, scheme = 'email'): Promise<Frame> {
	return request(peer, `approve-${crypto.randomUUID()}`, 'auth', { scheme, token });
}

/** Another connection signed in as an existing user, with a fresh session. */
async function signedInAgain(userId: string): Promise<Peer> {
	const token = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).issueSession(userId, 'http://localhost:5173', Date.now()));
	const peer = await fresh();
	expect((await approve(peer, token, 'token')).result.you.user_id).toBe(userId);
	return peer;
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

/** The pending (not signed in) connections' sign-in deadlines, for those with a proposal. */
function pendingDeadlines(): Promise<number[]> {
	return runInDurableObject(stub(), (_instance, state) => state.getWebSockets()
		.map((socket) => socket.deserializeAttachment() as { authDeadline: number; emailProposal?: string; tier: string })
		.filter((attachment) => attachment.emailProposal && attachment.tier === 'pending')
		.map((attachment) => attachment.authDeadline));
}

/** The rooms a registered user is stored in. */
function storedRooms(userId: string): Promise<string[]> {
	return runInDurableObject(stub(), (_instance, state) => [...state.storage.sql.exec('SELECT room_id FROM memberships WHERE user_id = ?', userId)].map((row) => String(row.room_id)));
}

/** Runs a command in `general` and returns the `~private` notices before its result. */
async function command(peer: Peer, text: string): Promise<{ reply: Frame; notices: string[] }> {
	const { frame, skipped } = await exchange(peer, `cmd-${crypto.randomUUID()}`, 'command', { room_id: 'general', body: { text } });
	return { reply: frame, notices: skipped.filter((frame) => frame.params?.from?.user_id === '~private').map((frame) => frame.params.body.text) };
}

it('signs up and signs in by code and by link on connections not signed in, with sessions bound to their origin', async () => {
	const email = address();
	const peers: Peer[] = [];
	const open = async (origin?: string | null) => { const peer = await fresh(origin); peers.push(peer); return peer; };
	try {
		// Sign-up: the reply says nothing; the email has the code, and with `state` the link (§4.11.2).
		const proposer = await open();
		const before = Date.now();
		const mail = await propose(proposer, `  ${email.toUpperCase()} `, { name: 'Ada', state: 'q8Rz-state' });
		expect(mail.subject).toBe(`${mail.code} is your Apron Demo code`);
		expect(mail.text).toContain('create an account on Apron Demo');
		expect(mail.link).toMatch(/^https:\/\/link\.apron\.chat\/#server=wss:\/\/demo\.test\/&token=apron_email_[A-Za-z0-9_-]{43}&state=q8Rz-state$/);
		// The connection waits for its code as long as the proposal lasts.
		expect(Math.max(...await pendingDeadlines())).toBeGreaterThanOrEqual(before + POLICY.proposalSeconds * 1_000);
		// A code works only where it was asked for; a wrong one counts.
		expect((await approve(await open(), mail.code)).error.code).toBe(-32001);
		const wrong = mail.code === '000000' ? '111111' : '000000';
		expect((await approve(proposer, wrong)).error).toMatchObject({ code: -32001, message: 'That code is not the one emailed' });
		const signedUp = await approve(proposer, mail.code);
		expect(signedUp.result.you).toMatchObject({ name: 'Ada' });
		const userId: string = signedUp.result.you.user_id;
		expect(userId).toMatch(/^ada_/);
		const session: string = signedUp.result.token;
		// Used up: the link too.
		expect((await approve(await open(), mail.token!)).error.code).toBe(-32001);
		// The session resumes on its origin only (§5.2).
		expect((await approve(await open(), session, 'token')).result.you.user_id).toBe(userId);
		for (const origin of ['http://localhost:8787', null]) expect((await approve(await open(origin), session, 'token')).error.code).toBe(-32001);
		// The address is listed, and is this account's only way back in, so it stays.
		expect((await command(proposer, '/email')).notices[0]).toContain(email);
		expect((await command(proposer, `/email remove ${email}`)).reply.error)
			.toMatchObject({ code: -32001, message: 'That address is your only way to sign in again; add a passkey or another address first' });

		// Sign-in: the link works on any connection not signed in, with either scheme; then the code is used up.
		const asker = await open(null);
		const signIn = await propose(asker, email, { state: 'abc' });
		expect(signIn.text).toContain(`sign in to Apron Demo as ${userId}`);
		const signedIn = await approve(await open(null), signIn.token!, 'token');
		expect(signedIn.result.you.user_id).toBe(userId);
		expect(signedIn.result.token).toBeTruthy();
		expect((await approve(asker, signIn.code)).error.code).toBe(-32001);

		// Without state there is no link; a new proposal replaces the last; enough wrong codes cancel one.
		const typist = await open();
		const first = await propose(typist, email);
		expect(first.link).toBeUndefined();
		expect(first.text).not.toContain('apron_email_');
		const second = await propose(typist, email);
		// The replaced proposal's code is now just a wrong code for the new one, and counts as one.
		const replaced = first.code !== second.code ? 1 : 0;
		if (replaced) expect((await approve(typist, first.code)).error.code).toBe(-32001);
		const miss = second.code === '000000' ? '111111' : '000000';
		for (let attempt = 1 + replaced; attempt < POLICY.maxFailures; attempt++) expect((await approve(typist, miss)).error.code).toBe(-32001);
		expect((await approve(typist, miss)).error.message).toMatch(/last try/);
		expect((await approve(typist, second.code)).error.code).toBe(-32001);
	} finally { for (const peer of peers) peer.close(); }
});

it('registers a guest with email, keeping its rooms, and never moves a guest or account into another account', async () => {
	const email = address();
	const peers: Peer[] = [];
	const open = async () => { const peer = await fresh(); peers.push(peer); return peer; };
	const asGuest = async () => {
		const peer = await open();
		const guestId: string = (await request(peer, 'guest', 'auth', { scheme: 'guest' })).result.you.user_id;
		return { peer, guestId };
	};
	try {
		// A guest's proposal registers, and the guest becomes the account. Its
		// link works only once handed back to the guest's own connection.
		const { peer: guest, guestId } = await asGuest();
		const thread = (await request(guest, 'thread', 'room_set', { parent_room_id: 'general', title: 'Guest thread' })).result.room_id;
		const mail = await propose(guest, email, { name: 'Grace', state: 'g1' });
		expect(mail.text).toContain('create an account on Apron Demo');
		expect(mail.link).toMatch(/&state=g1$/);
		expect((await approve(await open(), mail.token!)).error).toMatchObject({ code: -32001, message: 'Approve this registration on the guest connection that asked for it' });
		const watcher = await asGuest();
		const registered = await approve(guest, mail.token!);
		const userId: string = registered.result.you.user_id;
		expect(userId).toMatch(/^grace_/);
		expect(registered.result.token).toBeTruthy();
		expect(await storedRooms(userId)).toEqual(expect.arrayContaining(['general', thread]));
		// Like a passkey registration, others learn the guest became the account (§3.3).
		const renamed = await until(watcher.peer, (frame) => frame.method === 'user' && frame.params?.old?.user_id === guestId);
		expect(renamed.frame.params.new.user_id).toBe(userId);

		// A guest asking for an address that has an account gets no code: it would only switch accounts.
		const other = await asGuest();
		const exists = await proposeAny(other.peer, email);
		expect(exists.subject).toBe('You already have an account on Apron Demo');
		expect(exists.text).toContain(`already has one (${userId})`);
		expect(exists.code).toBeUndefined();

		// A sign-in link moves neither a guest's connection nor a signed-in one into the account (§4.11.3, §5.2).
		const signIn = await propose(await open(), email, { state: 'csrf' });
		expect((await approve(other.peer, signIn.token!, 'token')).error).toMatchObject({ code: -32001, message: "Sign in to an account on a new connection, not a guest's" });
		const busy = await signedIn(`busy_${crypto.randomUUID().slice(0, 6)}`);
		peers.push(busy);
		expect((await approve(busy, signIn.token!)).error).toMatchObject({ code: -32001, message: 'Identity switching requires reconnect' });
		// Those failures counted, but the proposal stands for a connection not signed in.
		expect((await approve(await open(), signIn.token!)).result.you.user_id).toBe(userId);
		// A guest's registration works only on its own connection.
		const { peer: third } = await asGuest();
		const pending = await propose(third, address());
		expect((await approve(await open(), pending.code)).error.code).toBe(-32001);
		expect((await approve(third, pending.code)).result.you.user_id).not.toMatch(/^guest_/);
	} finally { for (const peer of peers) peer.close(); }
});

it('adds, replaces and removes the address of a signed-in account, telling its other connections', async () => {
	const userId = `adder_${crypto.randomUUID().slice(0, 6)}`;
	const email = address();
	const peer = await signedIn(userId);
	const watcher = await signedInAgain(userId);
	const peers: Peer[] = [peer, watcher];
	const open = async () => { const next = await fresh(); peers.push(next); return next; };
	try {
		// An addition, approved only on the account's own connection (§4.11.3).
		const mail = await propose(peer, email, { state: 's1' });
		expect(mail.text).toContain(`add this address to ${userId}`);
		expect((await approve(await open(), mail.token!)).error.code).toBe(-32001);
		expect(await approve(peer, mail.code)).toMatchObject({ result: {} });
		expect((await command(peer, '/email')).notices[0]).toContain(email);
		await until(watcher, (frame) => frame.params?.from?.user_id === '~private' && /was added/.test(frame.params.body.text));
		// The address now signs in to the account.
		const later = await open();
		const signIn = await propose(later, email);
		expect((await approve(later, signIn.code)).result.you.user_id).toBe(userId);

		// One address an account: approving another replaces it.
		const replacement = address();
		const second = await propose(peer, replacement);
		expect(await approve(peer, second.code)).toMatchObject({ result: {} });
		const listed = (await command(peer, '/email')).notices[0];
		expect(listed).toContain(replacement);
		expect(listed).not.toContain(email);
		const told = await until(watcher, (frame) => frame.params?.from?.user_id === '~private' && /was added/.test(frame.params.body.text));
		expect(told.frame.params.body.text).toContain(`replacing ${email}`);

		// Another account's address is refused at approval, not at the proposal (§4.11.4).
		const other = await signedIn(`other_${crypto.randomUUID().slice(0, 6)}`);
		peers.push(other);
		const taken = await propose(other, replacement);
		expect((await approve(other, taken.code)).error).toMatchObject({ code: -32001, message: 'That address belongs to another account' });

		// This account has a passkey, so its address may go; it then signs up anew.
		expect((await command(peer, `/email remove ${replacement}`)).notices[0]).toContain('no longer signs you in');
		await until(watcher, (frame) => frame.params?.from?.user_id === '~private' && /was removed/.test(frame.params.body.text));
		const after = await open();
		const signUp = await propose(after, replacement);
		expect(signUp.text).toContain('create an account');
		expect((await approve(after, signUp.code)).result.you.user_id).not.toBe(userId);

		// Bots and the admin user take no address.
		const boss = await admin();
		peers.push(boss);
		expect((await request(boss, 'boss', 'auth', { scheme: 'email', email: address() })).error.code).toBe(-32001);
	} finally { for (const next of peers) next.close(); }
});

it('limits sends, refuses malformed requests first, and is unsupported where there is no sender', async () => {
	await setPolicy();
	// Per address: whoever asks.
	const email = address();
	for (let sent = 0; sent < POLICY.sendsPerAddressDay; sent++) {
		const peer = await fresh();
		try { await propose(peer, email); } finally { peer.close(); }
	}
	const over = await fresh();
	try {
		expect((await request(over, 'over', 'auth', { scheme: 'email', email })).error).toMatchObject({ code: -32002, message: 'No more sign-in emails to this address today' });
	} finally { over.close(); }
	// Per network: a burst of three, then one a minute.
	const shared = ip();
	const peers = [await fresh(undefined, shared), await fresh(undefined, shared)];
	try {
		for (let sent = 0; sent < 3; sent++) await propose(peers[sent % 2], address());
		expect((await request(peers[1], 'burst', 'auth', { scheme: 'email', email: address() })).error).toMatchObject({ code: -32002, message: 'Sign-in emails limited; wait a minute' });
	} finally { for (const peer of peers) peer.close(); }
	const sent = outbox.length;
	expect(sent).toBe(POLICY.sendsPerAddressDay + 3);

	// Malformed requests send nothing; each on its own connection, since repeated invalid requests close one.
	for (const params of [{}, { email: 'not an address' }, { email: 'Ada <ada@example.com>' }, { email: address(), state: '' }, { email: address(), state: 'x'.repeat(257) }, { email: 7 }]) {
		const peer = await fresh();
		try { expect((await request(peer, 'bad', 'auth', { scheme: 'email', ...params })).error.code).toBe(-32602); } finally { peer.close(); }
	}
	const peer = await fresh();
	try {
		expect((await approve(peer, 'apron_email_nothing')).error.code).toBe(-32001);
		expect((await approve(peer, 'Hk41x9')).error.code).toBe(-32001);
	} finally { peer.close(); }
	expect(outbox.length).toBe(sent);

	// Without a sender: unadvertised and unsupported.
	type Saved = Runtime & { savedEmail?: Runtime['config']['email'] };
	await runInDurableObject(stub(), (instance) => {
		const runtime = instance as unknown as Saved;
		runtime.savedEmail = runtime.config.email;
		runtime.config = { ...runtime.config, email: undefined };
	});
	try {
		const bare = await connect();
		try {
			const server = (await bare.next()).params;
			expect([server.auth, server.signup]).toEqual([['webauthn', 'token', 'guest'], ['webauthn', 'token']]);
			await bare.next();
			expect((await request(bare, 'email', 'auth', { scheme: 'email', email: address() })).error.code).toBe(-32601);
			expect((await request(bare, 'code', 'auth', { scheme: 'email', token: '123456' })).error.code).toBe(-32601);
		} finally { bare.close(); }
	} finally {
		await runInDurableObject(stub(), (instance) => {
			const runtime = instance as unknown as Saved;
			runtime.config = { ...runtime.config, email: runtime.savedEmail };
		});
	}
	expect(outbox.length).toBe(sent);
});

it('keeps addresses through /rename, drops them with /invite-purge and /purge, and never doubles a sign-up that fails part way', async () => {
	const email = address();
	const first = await fresh();
	let userId: string;
	let session: string;
	try {
		// A sign-up whose address write fails uses its proposal up, so no retry signs up a second account.
		const mail = await propose(first, email, { name: 'Orphan Test' });
		await runInDurableObject(stub(), (_instance, state) => {
			const put = state.storage.put.bind(state.storage);
			let failed = false;
			vi.spyOn(state.storage, 'put').mockImplementation(((entries: unknown, ...rest: unknown[]) => {
				if (!failed && entries && typeof entries === 'object' && Object.keys(entries).some((key) => key.startsWith('emails:'))) {
					failed = true;
					throw new Error('storage unavailable');
				}
				return (put as (...args: unknown[]) => unknown)(entries, ...rest);
			}) as typeof state.storage.put);
		});
		expect((await approve(first, mail.code)).error).toBeDefined();
		expect((await approve(first, mail.code)).error.code).toBe(-32001);
		const made = await runInDurableObject(stub(), (_instance, state) => [...state.storage.sql.exec("SELECT user_id FROM identities WHERE name = 'Orphan Test'")].length);
		expect(made).toBeLessThanOrEqual(1);
		// The address is still free: a new proposal signs it up.
		const again = await propose(first, email);
		const signedUp = await approve(first, again.code);
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
		// /invite-purge takes the address away and ends the email sessions.
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
