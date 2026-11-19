import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { collectArchive, jsonlReader, jsonlWriter, linesOf } from '../src/history/archive/format';
import { connect as open, exchange, request, type Frame, type Peer } from './helpers/socket';

// `/history` end to end: a backup to the backup store (HISTORY_BLOB, local
// R2 in the tests), and imports from it: a backup of this server's own,
// skipped as it holds nothing new, and a foreign archive, added as a new
// room with an unclaimed placeholder for its user.

const stub = () => env.DEMO.getByName('public-demo-v1');
const ADMIN_TOKEN = 'admin-token-0123456789abcdef';
let nextIp = 1;

async function setAdminToken(value: string | undefined): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as { config: { adminToken?: string } };
		server.config = { ...server.config, adminToken: value };
	});
}

beforeEach(() => setAdminToken(ADMIN_TOKEN));
afterEach(() => setAdminToken(undefined));

async function signedInAdmin(): Promise<Peer> {
	const peer = await open({ ip: `198.51.100.${200 + nextIp++}`, origin: null });
	await peer.next();
	expect((await request(peer, 'auth', 'auth', { scheme: 'token', token: ADMIN_TOKEN })).result.you.user_id).toBe('admin');
	return peer;
}

/** Runs a command; its reply and the `~private` notice before it. */
async function command(peer: Peer, id: string, text: string): Promise<{ frame: Frame; notice?: string }> {
	const { frame, skipped } = await exchange(peer, id, 'command', { room_id: 'general', body: { text } });
	const notice = skipped.find((candidate) => candidate.method === 'message' && candidate.params.from.user_id === '~private');
	return { frame, notice: notice?.params.body.text as string | undefined };
}

it('backs history up to the backup store, and imports a foreign archive as a new room', async () => {
	const admin = await signedInAdmin();
	try {
		for (let index = 0; index < 3; index += 1) {
			expect((await request(admin, `post-${index}`, 'message', { room_id: 'general', body: { format: 'plain', text: `backed up ${index}` } })).result).toBeDefined();
		}
		const exported = await command(admin, 'export', '/history export general');
		expect(exported.frame.result).toEqual({});
		const key = /to `([^`]+)`/.exec(exported.notice ?? '')?.[1];
		expect(key, exported.notice).toMatch(/^backups\/localhost-manual-\d{8}-\d{6}\.jsonl$/);
		const object = await env.HISTORY_BLOB!.get(key!);
		const archive = await collectArchive(jsonlReader(linesOf(await object!.text())));
		// ARCHIVE.md §2: the server's WebSocket URL, and the origins its media loads from.
		expect(archive.header).toMatchObject({ apron_archive: 1, server: 'wss://demo.test/', media: ['https://demo.test', 'https://media.test'] });
		expect(archive.records.some((record) => record.record_json.includes('backed up 2'))).toBe(true);

		// This server's own backup: the room exists, so nothing is added.
		const own = await command(admin, 'own', `/history import ${key} dry-run`);
		expect(own.notice).toMatch(/^Would import 0 records into 0 new rooms\.\nSkipped 1 rooms that exist here\./);

		// A foreign archive, written to the store by hand.
		const base = Date.now() - 60_000;
		const lines: string[] = [];
		const writer = jsonlWriter(async (line) => { lines.push(line); });
		await writer.header({ apron_archive: 1, server: 'elsewhere.test' });
		await writer.listing({ not_joined: [{ room_id: 'lobby', log_id: String(base), title: 'Lobby' }], users: [{ user_id: 'zed', name: 'Zed', roles: ['admin'] }] });
		await writer.records([
			{ room_id: 'lobby', log_id: base, commit_ms: base, kind: 'room', record_json: JSON.stringify({ room_id: 'lobby', log_id: String(base), title: 'Lobby' }) },
			...[1, 2].map((offset) => ({ room_id: 'lobby', log_id: base + offset, commit_ms: base + offset, kind: 'message', record_json: JSON.stringify({ message_id: String(base + offset), log_id: String(base + offset), room_id: 'lobby', from: { user_id: 'zed', name: 'Zed' }, body: { format: 'plain', text: `from afar ${offset}` } }) })),
		]);
		await writer.close();
		await env.HISTORY_BLOB!.put('backups/foreign.jsonl', lines.join(''));
		const dry = await command(admin, 'dry', '/history import backups/foreign.jsonl dry-run');
		expect(dry.notice).toContain('Would import 3 records into 1 new rooms (`lobby`).');
		expect(dry.notice).toContain('Users: zed → zed (unclaimed).');
		const imported = await command(admin, 'import', '/history import backups/foreign.jsonl');
		expect(imported.notice).toContain('Imported 3 records into 1 new rooms (`lobby`).');
		const page = (await request(admin, 'lobby', 'history', { room_id: 'lobby', limit: 10 })).result;
		expect(page.messages.map((message: { body: { text: string }; from: { user_id: string } }) => `${message.from.user_id}: ${message.body.text}`)).toEqual(['zed: from afar 1', 'zed: from afar 2']);
		// The placeholder is unclaimed, whatever roles the archive gave it.
		const roles = await runInDurableObject(stub(), (instance) => (instance as unknown as { store: { getIdentity(id: string): { roles: string[] } | null } }).store.getIdentity('zed')?.roles);
		expect(roles).toEqual(['unclaimed']);

		const status = await command(admin, 'status', '/history status');
		expect(status.notice).toContain('Invariants hold.');
		expect(status.notice).toContain('- History in D1:');

		const missing = await command(admin, 'missing', '/history import backups/none.jsonl');
		expect(missing.frame.error).toMatchObject({ code: -32602, message: 'No backup backups/none.jsonl' });
		const bad = await command(admin, 'bad', '/history import');
		expect(bad.frame.error?.code).toBe(-32602);
	} finally {
		admin.close();
	}
});

it('puts terminal output kept in R2 back into exported records, never the internal reference', async () => {
	await env.MEDIA!.put('f/AAAAAAAAAAAAAAAAAAAAAA', 'build ok');
	const records = await runInDurableObject(stub(), (instance) => {
		const runtime = instance as unknown as { exportRecords(records: unknown[]): Promise<Array<{ record_json: string }>> };
		const embed = { kind: 'terminal', title: 'build', output_ref: { key: 'f/AAAAAAAAAAAAAAAAAAAAAA', bytes: 8 } };
		return runtime.exportRecords([{ room_id: 'general', log_id: 5, commit_ms: 5, kind: 'message', record_json: JSON.stringify({ message_id: '5', log_id: '5', room_id: 'general', from: { user_id: 'ada' }, body: { text: '', embeds: [embed] } }) }]);
	});
	const embed = JSON.parse(records[0].record_json).body.embeds[0];
	expect(embed.output_ref).toBeUndefined();
	expect(embed.output).toBe('build ok');
});

it('refuses /history export where no export on demand is configured', async () => {
	const admin = await signedInAdmin();
	try {
		await changed((runtime) => {
			runtime.config = { ...runtime.config, history: { ...runtime.config.history!, exports: [] } };
		}, async () => {
			const refused = await command(admin, 'none', '/history export');
			expect(refused.frame.error).toMatchObject({ code: -32602, message: expect.stringMatching(/^No export on demand: add one without `every` to HISTORY.exports/) });
		});
	} finally {
		admin.close();
	}
});

type Runtime = {
	config: { history?: { exports: Array<Record<string, unknown>>; import: { plaintext: boolean } } };
	history?: unknown;
	historyBusy?: 'cycle' | 'job';
	unboundTiers: Array<{ name: string; missing: string }>;
	announce(alert: Record<string, unknown>): void;
	noteUnboundTiers(now: number): void;
	runScheduledExports(now: number): Promise<void>;
	backupTarget(): unknown;
};

/** Runs `fn` on the runtime, then puts back what it changed of it. */
async function changed(change: (runtime: Runtime) => void, fn: () => Promise<void>): Promise<void> {
	let saved: Partial<Runtime> = {};
	await runInDurableObject(stub(), (instance) => {
		const runtime = instance as unknown as Runtime;
		saved = { config: runtime.config, history: runtime.history, historyBusy: runtime.historyBusy, unboundTiers: runtime.unboundTiers };
		change(runtime);
	});
	try {
		await fn();
	} finally {
		await runInDurableObject(stub(), (instance) => {
			const runtime = instance as unknown as Runtime & { backupTarget?: unknown };
			Object.assign(runtime, saved);
			delete (runtime as { backupTarget?: unknown }).backupTarget;
		});
	}
}

it('matches users only from a backup sealed with this server\'s key, and imports only sealed backups where they are encrypted', async () => {
	const admin = await signedInAdmin();
	try {
		expect((await request(admin, 'sealed-post', 'message', { room_id: 'general', body: { format: 'plain', text: 'sealed' } })).result).toBeDefined();
		// A plain file claiming to be this server: imported here (plaintext is on in development), its users new, `admin` too.
		const base = Date.now() - 60_000;
		const lines: string[] = [];
		const writer = jsonlWriter(async (line) => { lines.push(line); });
		await writer.header({ apron_archive: 1, server: 'wss://demo.test/' });
		await writer.listing({ not_joined: [{ room_id: 'forged', log_id: String(base), title: 'Forged' }], users: [{ user_id: 'admin', name: 'Admin' }] });
		await writer.records([{ room_id: 'forged', log_id: base + 1, commit_ms: base + 1, kind: 'message', record_json: JSON.stringify({ message_id: String(base + 1), log_id: String(base + 1), room_id: 'forged', from: { user_id: 'admin', name: 'Admin', roles: ['admin'] }, body: { text: 'as admin' } }) }]);
		await writer.close();
		await env.HISTORY_BLOB!.put('backups/forged.jsonl', lines.join(''));
		const forged = await command(admin, 'forged', '/history import backups/forged.jsonl dry-run');
		expect(forged.frame.error).toBeUndefined();
		expect(forged.notice).toContain('Users: admin → imported-admin (unclaimed).');
		expect(forged.notice).toContain(`Log IDs ${base + 1} to ${base + 1}.`);
		const matched = await command(admin, 'forged-match', '/history import backups/forged.jsonl dry-run match');
		expect(matched.frame.error).toMatchObject({ code: -32602, message: expect.stringMatching(/^users match takes only a backup encrypted with one of this server's keys/) });

		// Encrypted backups, with plaintext off: one of this server's own is matched; a plain file is refused.
		await changed((runtime) => {
			const history = runtime.config.history!;
			runtime.config = { ...runtime.config, history: { ...history, exports: history.exports.map((entry) => ({ ...entry, encrypt: { keySecrets: ['HISTORY_BACKUP_KEY'] } })), import: { ...history.import, plaintext: false } } };
		}, async () => {
			const exported = await command(admin, 'sealed-export', '/history export general');
			const key = /to `([^`]+)`/.exec(exported.notice ?? '')?.[1];
			expect(key).toMatch(/\.enc$/);
			await env.HISTORY_BLOB!.put('backups/general-copy.enc', await (await env.HISTORY_BLOB!.get(key!))!.text());
			const own = await command(admin, 'sealed-import', `/history import ${key} dry-run`);
			expect(own.notice).toMatch(/^Would import 0 records into 0 new rooms\./);
			expect(own.notice).toContain('admin → admin');
			const plain = await command(admin, 'plain-refused', '/history import backups/forged.jsonl dry-run');
			expect(plain.frame.error).toMatchObject({ code: -32602, message: 'backups/forged.jsonl is not encrypted, and this server imports only encrypted backups (HISTORY.import.plaintext)' });
		});
	} finally {
		admin.close();
	}
});

it('refuses a file larger than an import reads, before reading it', async () => {
	const admin = await signedInAdmin();
	try {
		await changed((runtime) => {
			const settings = runtime.config.history!.exports[0];
			const read = vi.fn();
			runtime.backupTarget = () => ({ store: { get: async () => ({ size: 64 * 1024 * 1024 + 1, text: read }) }, settings });
		}, async () => {
			const big = await command(admin, 'big', '/history import backups/big.jsonl');
			expect(big.frame.error).toMatchObject({ code: -32602, message: `backups/big.jsonl is ${64 * 1024 * 1024 + 1} bytes; an import reads at most ${64 * 1024 * 1024}` });
		});
	} finally {
		admin.close();
	}
});

it('runs one history job at a time: an import, export or index rebuild waits for a running cycle', async () => {
	const admin = await signedInAdmin();
	try {
		await changed((runtime) => { runtime.historyBusy = 'cycle'; }, async () => {
			for (const [id, text] of [['busy-import', '/history import backups/none.jsonl'], ['busy-export', '/history export'], ['busy-index', '/history rebuild-index']]) {
				const refused = await command(admin, id, text);
				expect(refused.frame.error, text).toMatchObject({ code: -32602, message: 'History upkeep is running; try again in a moment' });
			}
		});
	} finally {
		admin.close();
	}
});

it('runs no other composition while a listed tier is unbound: it shows in /history status, and admins are alerted after stall_after', async () => {
	const admin = await signedInAdmin();
	try {
		await changed((runtime) => {
			runtime.history = undefined;
			runtime.unboundTiers = [{ name: 'recent', missing: 'the HISTORY_D1 binding' }];
		}, async () => {
			const status = await command(admin, 'unbound-status', '/history status');
			expect(status.notice).toContain('- History tier `recent`: **unbound** (needs the HISTORY_D1 binding): no history moves below SQLite until it is bound');
			const refused = await command(admin, 'unbound-export', '/history export');
			expect(refused.frame.error?.message).toMatch(/^History tier recent is unbound in this deploy/);
			const alerts = await runInDurableObject(stub(), (instance) => {
				const runtime = instance as unknown as Runtime;
				const seen: Array<Record<string, unknown>> = [];
				const announce = runtime.announce;
				runtime.announce = (alert) => { seen.push(alert); };
				try {
					const now = Date.now();
					runtime.noteUnboundTiers(now);
					runtime.noteUnboundTiers(now + 60_000);
					const early = seen.length;
					runtime.noteUnboundTiers(now + 7 * 3_600_000);
					runtime.noteUnboundTiers(now + 8 * 3_600_000);
					return { early, alerts: seen };
				} finally {
					runtime.announce = announce;
				}
			});
			expect(alerts.early).toBe(0);
			expect(alerts.alerts).toEqual([expect.objectContaining({ kind: 'history_stall', from: 'hot', to: 'recent' })]);
			// Bound again, the pipeline's first good copy clears the stall.
			await runInDurableObject(stub(), (instance) => {
				const store = (instance as unknown as { store: { saveHistoryState(name: string, head: string, update: Record<string, unknown>): void } }).store;
				store.saveHistoryState('hot', 'hot', { stalledSince: undefined, alertedAt: undefined });
			});
		});
	} finally {
		admin.close();
	}
});

it('says once a wake that a scheduled export has no store', async () => {
	await changed((runtime) => {
		const history = runtime.config.history!;
		runtime.config = { ...runtime.config, history: { ...history, exports: [{ ...history.exports[0], name: 'nightly', everySeconds: 60, store: { provider: 'r2', binding: 'NO_SUCH_BUCKET', prefix: 'backups/' } }] } };
	}, async () => {
		const warnings = await runInDurableObject(stub(), async (instance) => {
			const runtime = instance as unknown as Runtime;
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const now = Date.now() + 3_600_000;
				await runtime.runScheduledExports(now);
				await runtime.runScheduledExports(now + 120_000);
				return warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('history_export_unbound'));
			} finally {
				warn.mockRestore();
			}
		});
		expect(warnings).toHaveLength(1);
		expect(JSON.parse(warnings[0])).toMatchObject({ event: 'history_export_unbound', name: 'nightly', reason: 'its store is unavailable (bind NO_SUCH_BUCKET)' });
	});
});
