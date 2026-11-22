/// <reference types="vite/client" />
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noAuditSink, type AdminAuditEvent, type AuditSink } from '../src/commands/audit';
import { AdminCapability, assertAdmin, assertRoles, authorizeAdmin, authorizeRoles, RoleCapability } from '../src/commands/capability';
import { commandList, defineCommands, helpText, type CommandTable, type ScopeBase } from '../src/commands/registry';
import { ApronDemoServer } from '../src/index';
import { connect as open, exchange, request, type Frame, type Peer } from './helpers/socket';

let nextIp = 1;
const stub = () => env.DEMO.getByName('public-demo-v1');
const ADMIN_TOKEN = 'admin-token-commands-0123456789';
const connect = (origin: string | null = 'http://localhost:5173') => open({ ip: `198.51.102.${nextIp++}`, origin });
const unique = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
/** The registry, as the runtime keeps it. */
const registry = () => (ApronDemoServer as unknown as { commandTable: CommandTable<ScopeBase> }).commandTable.commands;
const adminCommands = () => registry().filter((command) => command.audience === 'admins');

/** The audit events the runtime recorded since the last `beforeEach`, captured by a sink swapped in for the log's. */
let events: AdminAuditEvent[] = [];
const capture: AuditSink = { record: (event) => { events.push(event); } };

async function setRuntime(token: string | undefined, sink: AuditSink): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as { config: { adminToken?: string }; audit: AuditSink };
		server.config = { ...server.config, adminToken: token };
		server.audit = sink;
	});
}

beforeEach(async () => {
	events = [];
	await setRuntime(ADMIN_TOKEN, capture);
});
afterEach(() => setRuntime(undefined, noAuditSink));

/** Registers a passkey user straight into the store and signs a connection in with a session token. */
async function signedIn(userId: string): Promise<Peer> {
	const token = await runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as {
			store: { accounts: { register(input: Record<string, unknown>): unknown } };
			issueSession(userId: string, origin: string, now: number): Promise<string>;
		};
		runtime.store.accounts.register({
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

async function signedInAdmin(): Promise<Peer> {
	const peer = await connect(null);
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token: ADMIN_TOKEN })).result.you.user_id).toBe('admin');
	return peer;
}

async function guest(): Promise<Peer> {
	const peer = await connect();
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'guest' })).result.you.user_id).toMatch(/^guest_/);
	return peer;
}

/** A registered user's bot, signed in with the token `/invite-bot` gave its owner. */
async function botOf(owner: Peer): Promise<Peer> {
	const minted = await command(owner, 'invite-bot', '/invite-bot');
	const token = minted.notice!.params.body.text.match(/```\n(apron_bot_[A-Za-z0-9_-]+)\n```/)![1];
	const peer = await connect(null);
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token })).result.you.roles).toEqual(['bot']);
	return peer;
}

/** Runs a command in a room; its reply, the `~private` notice before it if any, and every frame before it. */
async function command(peer: Peer, id: string, text: string): Promise<{ frame: Frame; notice?: Frame; skipped: Frame[] }> {
	const { frame, skipped } = await exchange(peer, id, 'command', { room_id: 'general', body: { text } });
	const notice = skipped.find((candidate) => candidate.method === 'message' && candidate.params.from.user_id === '~private');
	return { frame, notice, skipped };
}

/**
 * Each command's lines for these tests: `run`, one an admin may run here
 * (`users` names the users it needs), and `usage`, a malformed one, or
 * null for a command that takes nothing to get wrong. Every command in the
 * registry has an entry (checked below), so a new command needs one.
 */
type Users = { alice: string; kicked: string; purged: string; resetting: string; renamed: string; renamedTo: string; invited: string };
const LINES: Record<string, { run?: (users: Users) => string; target?: (users: Users) => string | undefined; usage: string | null }> = {
	'admin': { run: (u) => `/admin @${u.alice}`, target: (u) => u.alice, usage: '/admin' },
	'avatar': { usage: '/avatar' },
	'embed-append': { usage: null },
	'embed-terminal': { usage: null },
	'emoji': { usage: '/emoji' },
	'help': { usage: null },
	'history': { run: () => '/history status', target: () => undefined, usage: '/history' },
	'invite-bot': { usage: null },
	'invite-code': { run: () => '/invite-code 2', target: () => undefined, usage: '/invite-code' },
	'invite-device': { usage: '/invite-device' },
	'invite-purge': { run: (u) => `/invite-purge ${u.resetting}`, target: (u) => u.resetting, usage: '/invite-purge' },
	'invite-token': { run: (u) => `/invite-token ${u.invited}`, target: (u) => u.invited, usage: '/invite-token' },
	'kick': { run: (u) => `/kick ${u.kicked}`, target: (u) => u.kicked, usage: '/kick' },
	'passkeys': { usage: '/passkeys remove' },
	'purge': { run: (u) => `/purge ${u.purged}`, target: (u) => u.purged, usage: '/purge' },
	'rename': { run: (u) => `/rename ${u.renamed} ${u.renamedTo}`, target: (u) => `${u.renamed} -> ${u.renamedTo}`, usage: '/rename x' },
	'role': { run: (u) => `/role ${u.alice} friend`, target: (u) => u.alice, usage: '/role' },
	'server': { run: () => '/server title Secret title text', target: () => undefined, usage: '/server bogus' },
	'status': { run: () => '/status', target: () => undefined, usage: null },
	'toggle': { run: () => '/toggle activity', target: () => 'activity', usage: '/toggle' },
};

/** What a command line may never leave in an audit event: tokens, and the text it set. */
const SECRET = /apron_[a-z]+_[A-Za-z0-9_-]{20,}|Secret title text/;

/** The durable state a command could change: every key-value key, and the rows of the tables that hold users, rooms, messages and settings. */
async function durableState(): Promise<string> {
	return runInDurableObject(stub(), async (_instance, state) => {
		const keys = [...(await state.storage.list()).keys()];
		const tables = ['identities', 'credentials', 'memberships', 'records', 'rooms', 'uploads', 'message_state', 'reaction_state', 'push_subscriptions', 'room_mutes', 'user_status'];
		const rows = Object.fromEntries(tables.map((table) => [table, state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()]));
		return JSON.stringify({ keys, rows });
	});
}

describe('the command registry', () => {
	it('has a line for every command, in /help order', () => {
		expect(registry().map((command) => command.name).sort()).toEqual(Object.keys(LINES).sort());
		const names = registry().map((command) => command.name);
		expect(names).toEqual([...names].sort());
		// Every admin command has a line that runs.
		for (const command of adminCommands()) expect(LINES[command.name].run, command.name).toBeDefined();
	});

	it('refuses every admin command to a guest, a registered user and a bot, auditing each refusal', async () => {
		const ownerId = unique('owner');
		const owner = await signedIn(ownerId);
		const bot = await botOf(owner);
		const visitor = await guest();
		const users: Users = { alice: ownerId, kicked: ownerId, purged: ownerId, resetting: ownerId, renamed: ownerId, renamedTo: unique('moved'), invited: unique('invited') };
		try {
			for (const [label, peer] of [['guest', visitor], ['registered', owner], ['bot', bot]] as const) {
				for (const spec of adminCommands()) {
					events = [];
					const line = LINES[spec.name].run!(users);
					const { frame, notice } = await command(peer, `${label}-${spec.name}`, line);
					expect(frame.error, `${label} ${line}`).toMatchObject({ code: -32001, message: `Only an admin can use /${spec.name}` });
					expect(notice).toBeUndefined();
					expect(events.filter((event) => event.outcome === 'ok')).toEqual([]);
					expect(events).toEqual([{ event: 'admin_action', actor: expect.any(String), command: spec.name, outcome: 'refused', reason: 'denied', at: expect.any(Number) }]);
					expect(events[0].actor).not.toBe('');
				}
			}
			// Nothing they tried happened: the owner is still here, under their own id, with no roles.
			expect((await request(owner, 'me', 'me', {})).result.you).toMatchObject({ user_id: ownerId, roles: [] });
		} finally { owner.close(); bot.close(); visitor.close(); }
	});

	it('records one admin_action event for each admin command an admin runs, naming its target and no content', async () => {
		const admin = await signedInAdmin();
		const users: Users = {
			alice: unique('alice'), kicked: unique('kicked'), purged: unique('purged'), resetting: unique('resetting'),
			renamed: unique('renamed'), renamedTo: unique('renamedto'), invited: unique('invited'),
		};
		const peers = await Promise.all([users.alice, users.kicked, users.purged, users.resetting, users.renamed].map(signedIn));
		try {
			for (const spec of adminCommands()) {
				events = [];
				const line = LINES[spec.name].run!(users);
				const { frame, skipped } = await command(admin, spec.name, line);
				expect(frame.result, line).toEqual({});
				expect(events, line).toHaveLength(1);
				const [event] = events;
				const target = LINES[spec.name].target!(users);
				expect(event).toMatchObject({ event: 'admin_action', actor: 'admin', command: spec.name, outcome: 'ok', at: expect.any(Number) });
				expect(event.target).toBe(target);
				expect(Object.keys(event).every((key) => ['event', 'actor', 'command', 'target', 'action', 'outcome', 'reason', 'at'].includes(key))).toBe(true);
				// No token the command handed out, and nothing it set, is in the event.
				expect(JSON.stringify(event)).not.toMatch(SECRET);
				// Those that hand out a token or set text did, so the check above means something.
				if (['invite-code', 'invite-token', 'invite-purge', 'server'].includes(spec.name)) expect(JSON.stringify(skipped)).toMatch(SECRET);
			}
			// A failure after authorization is recorded with the error's name, not its message.
			events = [];
			expect((await command(admin, 'kick-nobody', '/kick nobody_123')).frame.error.code).toBe(-32602);
			expect(events).toEqual([{ event: 'admin_action', actor: 'admin', command: 'kick', target: 'nobody_123', outcome: 'failed', reason: 'invalid_params', at: expect.any(Number) }]);
			events = [];
			expect((await command(admin, 'kick-self', '/kick admin')).frame.error.code).toBe(-32001);
			expect(events).toEqual([{ event: 'admin_action', actor: 'admin', command: 'kick', target: 'admin', outcome: 'failed', reason: 'denied', at: expect.any(Number) }]);
		} finally {
			await command(admin, 'invite-code-revoke', '/invite-code 0');
			await command(admin, 'server-clear', '/server title');
			await command(admin, 'toggle-back', '/toggle activity');
			admin.close();
			for (const peer of peers) peer.close();
		}
	});

	it('writes nothing for a usage error, and answers it alone', async () => {
		const admin = await signedInAdmin();
		try {
			for (const spec of registry()) {
				const line = LINES[spec.name].usage;
				if (line === null) continue;
				events = [];
				const before = await durableState();
				const { frame, skipped } = await command(admin, `usage-${spec.name}`, line);
				expect(frame.error?.code, line).toBe(-32602);
				// A `server` frame may follow the admin's sign-in (its wake scopes); nothing else comes.
				expect(skipped.filter((frame) => frame.method !== 'server'), line).toEqual([]);
				expect(await durableState(), line).toBe(before);
				// An admin command's usage error is audited as a failure, with no target.
				expect(events).toEqual(spec.audience === 'admins' ? [{ event: 'admin_action', actor: 'admin', command: spec.name, outcome: 'failed', reason: 'invalid_params', at: expect.any(Number) }] : []);
			}
		} finally { admin.close(); }
	});
});

describe('command forms', () => {
	const form = (spec: Record<string, unknown>) => defineCommands<ScopeBase>(({ publicCommand }) => [
		publicCommand({ name: 'demo', usageErrors: 'reply', parse: () => ({}), run: () => {}, ...spec } as never),
	]);
	const someone = { tier: 'registered', userId: 'someone_1' };

	it('name each form by its words, and write the usage, /help and the list from them', () => {
		const table = form({ forms: [{ description: 'Show it' }, { words: 'add', hint: '<id>', description: 'Add one, at most <max>', uses: ['body.embeds'], requires: ['body.embeds'] }] });
		const [demo] = table.commands;
		expect(demo.usage(undefined)).toBe('/demo, or /demo add <id>');
		const offered = table.listFor(someone, undefined, true);
		expect(commandList(offered)).toEqual([
			{ name: 'demo', group: 'all', description: 'Show it' },
			{ name: 'demo add', group: 'all', description: 'Add one, at most <max>', hint: '<id>', uses: ['body.embeds'], requires: ['body.embeds'] },
		]);
		// A description is CommonMark text in /help, so a placeholder is not read as HTML.
		expect(helpText(offered)).toBe('- `/demo`: Show it\n- `/demo add <id>`: Add one, at most \\<max\\>');
	});

	it('offer only the forms their predicates allow, and give a hint from the runtime', () => {
		const table = form({ forms: [
			{ description: 'Show it', hint: (runtime: { choices: string[] }) => runtime.choices.join('|') },
			{ words: 'add', description: 'Add one', offered: (runtime: { adding: boolean }, identity: { userId?: string }) => runtime.adding && identity.userId !== 'admin' },
		] });
		const names = (runtime: unknown, identity: { tier: string; userId?: string }) => commandList(table.listFor(identity, runtime, true)).map((entry) => entry.hint ? `${entry.name} ${entry.hint}` : entry.name);
		expect(names({ choices: ['a', 'b'], adding: true }, someone)).toEqual(['demo a|b', 'demo add']);
		expect(names({ choices: ['a'], adding: false }, someone)).toEqual(['demo a']);
		expect(names({ choices: ['a'], adding: true }, { tier: 'registered', userId: 'admin' })).toEqual(['demo a']);
		// The usage names every form, offered or not.
		expect(table.commands[0].usage({ choices: ['a'], adding: false })).toBe('/demo a, or /demo add');
	});

	it('refuse forms that say what the extension does not allow', () => {
		expect(() => form({ forms: [{ description: '' }] })).toThrow(/no description/);
		expect(() => form({ forms: [{ description: '   ' }] })).toThrow(/no description/);
		expect(() => form({ forms: [{ description: 'x', hint: ' ' }] })).toThrow(/blank hint/);
		expect(() => form({ forms: [{ words: 'a  b', description: 'x' }] })).toThrow(/one space apart/);
		expect(() => form({ forms: [{ words: ' a', description: 'x' }] })).toThrow(/one space apart/);
		expect(() => form({ forms: [{ description: 'x', uses: ['reply_to', 'reply_to'] }] })).toThrow(/repeats/);
		expect(() => form({ forms: [{ description: 'x', uses: ['body.embeds'], requires: ['body.embeds', 'body.embeds'] }] })).toThrow(/repeats/);
		expect(() => form({ forms: [{ description: 'x', requires: ['reply_to'] }] })).toThrow(/requires/);
		// A form may require room_id, as one that acts only on a room the client names.
		expect(() => form({ forms: [{ description: 'x', uses: ['room_id'], requires: ['room_id'] }] })).not.toThrow();
		expect(() => form({ forms: [{ words: 'b', description: 'x' }, { words: 'a', description: 'y' }] })).toThrow(/out of place/);
		expect(() => form({ forms: [{ words: 'a', description: 'x' }, { words: 'a', description: 'y' }] })).toThrow(/out of place/);
	});
});

describe('capabilities', () => {
	const admin = { tier: 'registered', userId: 'admin', roles: ['admin'] };
	const quiet: AuditSink = { record() {} };

	it('are issued to admins only, and a refusal is audited', () => {
		const refused: AdminAuditEvent[] = [];
		const sink: AuditSink = { record: (event) => { refused.push(event); } };
		for (const identity of [
			{ tier: 'anonymous', userId: 'guest_1' },
			{ tier: 'registered', userId: 'carol_1', roles: ['friend'] },
			{ tier: 'registered', userId: 'bot_carol_1', roles: ['admin', 'bot'] },
			{ tier: 'anonymous', userId: 'guest_2', roles: ['admin'] },
		]) {
			expect(() => authorizeAdmin(identity, 'purge', sink, 1)).toThrow(expect.objectContaining({ name: 'denied', message: 'Only an admin can use /purge' }));
		}
		expect(refused.map((event) => [event.actor, event.outcome])).toEqual([['guest_1', 'refused'], ['carol_1', 'refused'], ['bot_carol_1', 'refused'], ['guest_2', 'refused']]);
		const cap = authorizeAdmin(admin, 'purge', sink, 1);
		expect(cap).toBeInstanceOf(AdminCapability);
		expect(cap).toMatchObject({ actor: 'admin', command: 'purge', at: 1 });
		expect(() => assertAdmin(cap)).not.toThrow();
	});

	it('reject a forged AdminCapability, and one whose command has finished', () => {
		expect(() => assertAdmin({} as AdminCapability)).toThrow(TypeError);
		expect(() => assertAdmin(Object.create(AdminCapability.prototype))).toThrow(TypeError);
		expect(() => assertAdmin({ actor: 'admin', command: 'purge', at: 1 })).toThrow(TypeError);
		expect(() => assertAdmin(undefined)).toThrow(TypeError);
		// The constructor wants the module's own token, whatever TypeScript says.
		expect(() => Reflect.construct(AdminCapability, [Symbol('capability mint'), 'admin', 'purge', 1, quiet])).toThrow(TypeError);
		const recorded: AdminAuditEvent[] = [];
		const cap = authorizeAdmin(admin, 'kick', { record: (event) => { recorded.push(event); } }, 2);
		cap.settle('ok', { target: 'bob_1' });
		cap.settle('failed', {}, 'denied');
		expect(recorded).toEqual([{ event: 'admin_action', actor: 'admin', command: 'kick', target: 'bob_1', outcome: 'ok', at: 2 }]);
		expect(() => assertAdmin(cap)).toThrow(/finished/);
	});

	it('reject a forged RoleCapability, and one checked against other roles', () => {
		const friend = { tier: 'registered', userId: 'carol_1', roles: ['friend'] };
		expect(() => authorizeRoles({ tier: 'registered', userId: 'dan_1', roles: [] }, 'emoji', ['admin', 'mod', 'friend'])).toThrow(expect.objectContaining({ name: 'denied', message: '/emoji needs one of the roles admin, mod, friend' }));
		const grant = authorizeRoles(friend, 'emoji', ['admin', 'mod', 'friend']);
		expect(() => assertRoles(grant, ['admin', 'mod', 'friend'])).not.toThrow();
		expect(() => assertRoles(grant, ['admin'])).toThrow(TypeError);
		expect(() => assertRoles({} as RoleCapability, ['friend'])).toThrow(TypeError);
		expect(() => assertRoles(Object.create(RoleCapability.prototype), ['friend'])).toThrow(TypeError);
	});
});

describe('the source', () => {
	const sources = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
	const files = Object.entries(sources).map(([path, text]) => [path.replace(/^\.\.\//, ''), text] as const);
	/** The files a pattern occurs in, by path. */
	const where = (pattern: RegExp) => files.filter(([, text]) => pattern.test(text)).map(([path]) => path).sort();

	it('constructs and issues capabilities in src/commands/capability.ts alone, from the dispatcher alone', () => {
		// The glob found the source, so the checks below mean something.
		expect(files.map(([path]) => path)).toEqual(expect.arrayContaining(['src/index.ts', 'src/commands/capability.ts', 'src/commands/registry.ts']));
		expect(where(/new\s+(AdminCapability|RoleCapability)\b/)).toEqual(['src/commands/capability.ts']);
		expect(where(/\bmint(Admin|Roles)\b/)).toEqual(['src/commands/capability.ts']);
		// authorizeAdmin and authorizeRoles: defined in capability.ts, called by the dispatcher in registry.ts alone.
		expect(where(/(?<!function )\bauthorize(Admin|Roles)\(/)).toEqual(['src/commands/registry.ts']);
		// Only the dispatcher settles a command's audit event.
		expect(where(/(?<!this)\??\.settle\(/)).toEqual(['src/commands/registry.ts']);
	});

	it('casts nothing to a capability', () => {
		expect(where(/\bas\s+(AdminCapability|RoleCapability)\b|<(AdminCapability|RoleCapability)>\s*[^(,>]/)).toEqual([]);
	});

	it('asserts the capability first in every method that takes one', () => {
		for (const [path, text] of files) {
			for (const match of text.matchAll(/^\t(?:private |public )?(?:async )?(\w+)\((cap: AdminCapability|grant: RoleCapability)[^\n]*\{\n\t\t([^\n]*)/gm)) {
				expect(match[3], `${path} ${match[1]}`).toEqual(match[2].startsWith('cap') ? 'assertAdmin(cap);' : expect.stringMatching(/^assertRoles\(grant, /));
			}
		}
		// The privileged methods all take one.
		const index = files.find(([path]) => path === 'src/index.ts')![1];
		for (const method of ['purge', 'rename', 'grantAdmin', 'role', 'changeRole', 'kick', 'toggle', 'inviteToken', 'invitePurge', 'invite', 'serverCommand', 'sendStatus', 'historyCommand', 'historyJob']) {
			expect(index, method).toMatch(new RegExp(`^\\t(?:private )?(?:async )?${method}\\(cap: AdminCapability, `, 'm'));
		}
		expect(index).toMatch(/^\tprivate async emojiCommand\(grant: RoleCapability, /m);
	});
});
