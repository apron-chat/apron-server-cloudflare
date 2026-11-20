import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { collectArchive, gzip, jsonlWriter, openArchive } from '@apron/archive';
import { connect as open, exchange, request, type Frame, type Peer } from './helpers/socket';
import { type HistoryHolder, type HistorySchedule, isRefusal } from '../src/history/schedule';
import { BackupStore, MAX_IMPORT_BYTES } from '../src/history/exports';

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
		expect(key, exported.notice).toMatch(/^backups\/localhost-manual-\d{8}-\d{6}\.jsonl\.gz$/);
		const object = await env.HISTORY_BLOB!.get(key!);
		// gzip-compressed, the codec recorded with it (not encrypted).
		expect(object!.customMetadata).toEqual({ codecs: 'gzip' });
		expect(object!.httpMetadata?.contentType).toBe('application/octet-stream');
		const archive = await collectArchive(openArchive(object!.body, { codecs: [gzip] }));
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

type Backups = { everySeconds?: number; keep: number; privateRooms: boolean };
type Runtime = {
	config: { backups: Backups };
	runtimeEnv: Record<string, unknown>;
	history?: unknown;
	historySchedule: HistorySchedule;
	deadlines: { maintenance: { at?: number; clear(): void; soonest(at: number): boolean } };
	runHistory(now: number): Promise<void>;
	d1Held?: boolean;
	backupUnboundWarned: boolean;
	announce(alert: Record<string, unknown>): void;
	d1Missing(): Promise<'unbound' | 'disabled' | undefined>;
	noteD1Missing(now: number): Promise<void>;
	runScheduledBackup(now: number): Promise<void>;
	backupStore(): unknown;
	store: { historyMetaNumber(key: string): number; setHistoryMeta(key: string, value: string | null): void; historyStatePort(): { setValue(key: string, value: string | null): void }; setHistoryImportJournal(value: string | null): void };
};

/** Runs `fn` on the runtime, then puts back what it changed of it. */
async function changed(change: (runtime: Runtime) => void, fn: () => Promise<void>): Promise<void> {
	let saved: Partial<Runtime> = {};
	await runInDurableObject(stub(), (instance) => {
		const runtime = instance as unknown as Runtime;
		saved = { config: runtime.config, runtimeEnv: runtime.runtimeEnv, history: runtime.history, d1Held: runtime.d1Held, backupUnboundWarned: runtime.backupUnboundWarned };
		change(runtime);
	});
	try {
		await fn();
	} finally {
		await runInDurableObject(stub(), (instance) => {
			const runtime = instance as unknown as Runtime;
			Object.assign(runtime, saved);
			delete (runtime as { backupStore?: unknown }).backupStore;
		});
	}
}

const withBackups = (change: Partial<Backups>) => (runtime: Runtime) => {
	runtime.config = { ...runtime.config, backups: { ...runtime.config.backups, ...change } };
};

it('refuses /history export and import without a backup store (HISTORY_BLOB unbound)', async () => {
	const admin = await signedInAdmin();
	try {
		await changed((runtime) => {
			runtime.runtimeEnv = { ...runtime.runtimeEnv, HISTORY_BLOB: undefined };
		}, async () => {
			for (const [id, text] of [['no-store-export', '/history export'], ['no-store-import', '/history import backups/x.jsonl']]) {
				const refused = await command(admin, id, text);
				expect(refused.frame.error, text).toMatchObject({ code: -32602, message: expect.stringMatching(/^No backup store: bind an R2 bucket as HISTORY_BLOB/) });
			}
		});
	} finally {
		admin.close();
	}
});

it('never matches users without an authenticating codec, and refuses a codec it does not know', async () => {
	const admin = await signedInAdmin();
	try {
		expect((await request(admin, 'gz-post', 'message', { room_id: 'general', body: { format: 'plain', text: 'compressed' } })).result).toBeDefined();
		// A plain file claiming to be this server: its users new, `admin` too.
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
		expect(matched.frame.error).toMatchObject({ code: -32602, message: expect.stringMatching(/^users match needs an archive verified as this server's own, by an authenticating codec/) });

		// This server's own backup, gzip-compressed: read back, but gzip verifies nothing, so no users are matched either.
		// (An earlier test's backup may hold this second's key: out of the way.)
		const earlier = (await env.HISTORY_BLOB!.list({ prefix: 'backups/localhost-manual-' })).objects.map((object) => object.key);
		if (earlier.length) await env.HISTORY_BLOB!.delete(earlier);
		const exported = await command(admin, 'gz-export', '/history export general');
		const key = /to `([^`]+)`/.exec(exported.notice ?? '')?.[1];
		expect(key, JSON.stringify(exported)).toMatch(/\.jsonl\.gz$/);
		const own = await command(admin, 'gz-import', `/history import ${key} dry-run`);
		expect(own.frame.error).toBeUndefined();
		expect(own.notice).toMatch(/^Would import 0 records into 0 new rooms\./);
		const ownMatch = await command(admin, 'gz-match', `/history import ${key} dry-run match`);
		expect(ownMatch.frame.error?.message).toMatch(/^users match needs an archive verified/);
		// Out of the way of the next backup, which may fall in the same second.
		await env.HISTORY_BLOB!.delete(key!);

		// A codec this server does not have, by name or by metadata: refused, nothing read.
		await env.HISTORY_BLOB!.put('backups/odd.jsonl.zst', 'x');
		const byName = await command(admin, 'odd-name', '/history import backups/odd.jsonl.zst dry-run');
		expect(byName.frame.error).toMatchObject({ code: -32602, message: 'unknown archive extension ".zst" in "backups/odd.jsonl.zst"' });
		await env.HISTORY_BLOB!.put('backups/odd.jsonl', 'x', { customMetadata: { codecs: 'gzip,rot13' } });
		const byMetadata = await command(admin, 'odd-metadata', '/history import backups/odd.jsonl dry-run');
		expect(byMetadata.frame.error).toMatchObject({ code: -32602, message: 'unknown archive codec "rot13"' });
		// gzip that is not: a damaged backup fails plainly.
		await env.HISTORY_BLOB!.put('backups/damaged.jsonl.gz', 'not gzip at all');
		const damaged = await command(admin, 'damaged', '/history import backups/damaged.jsonl.gz dry-run');
		expect(damaged.frame.error?.code).toBe(-32602);
		await env.HISTORY_BLOB!.delete(['backups/odd.jsonl.zst', 'backups/odd.jsonl', 'backups/damaged.jsonl.gz', 'backups/forged.jsonl']);
	} finally {
		admin.close();
	}
});

it('refuses a file larger than an import reads, before reading it', async () => {
	const admin = await signedInAdmin();
	try {
		await changed((runtime) => {
			const read = vi.fn();
			runtime.backupStore = () => new BackupStore({ get: async () => ({ size: MAX_IMPORT_BYTES + 1, stream: read }) } as never, []);
		}, async () => {
			const big = await command(admin, 'big', '/history import backups/big.jsonl');
			expect(big.frame.error).toMatchObject({ code: -32602, message: `backups/big.jsonl is ${MAX_IMPORT_BYTES + 1} bytes; an import reads at most ${MAX_IMPORT_BYTES}` });
		});
	} finally {
		admin.close();
	}
});

/** Runs `fn` while the history lock is held for `holder` (as a running cycle or job would hold it), then releases it. */
async function holding<R>(holder: HistoryHolder, fn: () => Promise<R>): Promise<R> {
	const lease = await runInDurableObject(stub(), (instance) => {
		const acquired = (instance as unknown as Runtime).historySchedule.acquire(holder);
		if (isRefusal(acquired)) throw new Error(`the history lock is held: ${JSON.stringify(acquired)}`);
		return acquired;
	});
	try {
		return await fn();
	} finally {
		await runInDurableObject(stub(), () => lease.release());
	}
}

// One history job at a time, and no /purge or /rename beside an import:
// its later writes would put back what they remove.
it.each([
	[{ kind: 'cycle' }, '/history import backups/none.jsonl', 'History upkeep is running; try again in a moment'],
	[{ kind: 'cycle' }, '/history export', 'History upkeep is running; try again in a moment'],
	[{ kind: 'job', job: 'import' }, '/purge nobody-here', 'A history import is running; try again when it ends'],
	[{ kind: 'job', job: 'import' }, '/rename nobody-here someone-else', 'A history import is running; try again when it ends'],
	[{ kind: 'rewrite' }, '/history import backups/none.jsonl', 'A purge or rename is running; try again in a moment'],
] as Array<[HistoryHolder, string, string]>)('while %j holds the history lock, refuses %s', async (holder, text, message) => {
	const admin = await signedInAdmin();
	try {
		await holding(holder, async () => {
			const refused = await command(admin, 'busy', text);
			expect(refused.frame.error).toMatchObject({ code: -32602, message });
		});
	} finally {
		admin.close();
	}
});

// The lock lives in memory, but an import's journal outlives a restart: an
// import left unfinished (its object evicted mid-import) still refuses
// /purge and /rename, which its resumed writes would undo.
it('refuses /purge and /rename while an unfinished import\'s journal remains, with no lease held', async () => {
	const admin = await signedInAdmin();
	try {
		await runInDurableObject(stub(), (instance) => {
			const runtime = instance as unknown as Runtime;
			expect(runtime.historySchedule.holder).toBeUndefined();
			runtime.store.setHistoryImportJournal(JSON.stringify({ archive: 'left-over', users: {}, ids: { mode: 'original', moved: [] }, rooms: [] }));
		});
		for (const text of ['/purge nobody-here', '/rename nobody-here someone-else']) {
			const refused = await command(admin, `pending-${text.length}`, text);
			expect(refused.frame.error).toMatchObject({ code: -32602 });
			expect(refused.frame.error.message).toMatch(/unfinished history import is pending.*restart/);
		}
		// Each refusal gave its lease back.
		await runInDurableObject(stub(), (instance) => expect((instance as unknown as Runtime).historySchedule.holder).toBeUndefined());
	} finally {
		await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.setHistoryImportJournal(null));
		admin.close();
	}
});

it('does not poll while a job holds the history lock: the cycle waits, and the job\'s end asks for it', async () => {
	const result = await runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as Runtime;
		const lease = runtime.historySchedule.acquire({ kind: 'job', job: 'export' });
		if (isRefusal(lease)) throw new Error('the history lock is held');
		const now = Date.now();
		const before = runtime.deadlines.maintenance.at;
		runtime.deadlines.maintenance.clear();
		await runtime.runHistory(now);
		// No maintenance a second away: nothing would change until the job ends.
		const polled = (runtime.deadlines.maintenance.at ?? Infinity) <= now + 1_000;
		const wanted = runtime.historySchedule.want.kind;
		const released = lease.release();
		if (before !== undefined) runtime.deadlines.maintenance.soonest(before);
		return { polled, wanted, released };
	});
	expect(result).toEqual({ polled: false, wanted: 'due', released: { cycleSoon: true } });
});

it('takes the D1 tier for off only once it holds history, and says why: unbound, or no count to keep', async () => {
	const fresh = await runInDurableObject(stub(), async (instance, state) => {
		const runtime = instance as unknown as Runtime;
		const known = state.storage.sql.exec<{ key: string }>("SELECT key FROM _meta WHERE key = 'history:tier:recent'").toArray().length > 0;
		const env = runtime.runtimeEnv;
		const config = runtime.config;
		const cached = runtime.d1Held;
		const port = runtime.store.historyStatePort();
		try {
			runtime.runtimeEnv = { ...env, HISTORY_D1: undefined };
			if (known) state.storage.sql.exec("DELETE FROM _meta WHERE key = 'history:tier:recent'");
			runtime.d1Held = undefined;
			// Unbound with no state: a deploy without D1 that simply never had it.
			const unused = await runtime.d1Missing();
			port.setValue('history:tier:recent', '{}');
			runtime.d1Held = undefined;
			const held = await runtime.d1Missing();
			// Bound, but with no count to keep: off as well, and said so.
			runtime.runtimeEnv = env;
			runtime.config = { ...config, limits: { ...(config as unknown as { limits: Record<string, unknown> }).limits, historyD1Records: 0 } } as never;
			const disabled = await runtime.d1Missing();
			runtime.config = config;
			return { unused, held, disabled, bound: await runtime.d1Missing() };
		} finally {
			runtime.runtimeEnv = env;
			runtime.config = config;
			runtime.d1Held = cached;
			if (!known) port.setValue('history:tier:recent', null);
		}
	});
	expect(fresh).toEqual({ unused: undefined, held: 'unbound', disabled: 'disabled', bound: undefined });
});

it('while the D1 tier is unbound, it shows in /history status, exports wait, and admins are alerted after six hours', async () => {
	const admin = await signedInAdmin();
	try {
		await changed((runtime) => {
			runtime.d1Held = true;
			runtime.runtimeEnv = { ...runtime.runtimeEnv, HISTORY_D1: undefined };
		}, async () => {
			const status = await command(admin, 'unbound-status', '/history status');
			expect(status.notice).toContain('- History in D1: **unbound** (it holds history; needs the `HISTORY_D1` binding): no history moves below SQLite until it is bound');
			const refused = await command(admin, 'unbound-export', '/history export');
			expect(refused.frame.error?.message).toMatch(/^History tier recent \(D1\) holds history but HISTORY_D1 is unbound in this deploy/);
			const alerts = await runInDurableObject(stub(), async (instance) => {
				const runtime = instance as unknown as Runtime;
				const seen: Array<Record<string, unknown>> = [];
				const announce = runtime.announce;
				runtime.announce = (alert) => { seen.push(alert); };
				try {
					const now = Date.now();
					await runtime.noteD1Missing(now);
					await runtime.noteD1Missing(now + 60_000);
					const early = seen.length;
					await runtime.noteD1Missing(now + 7 * 3_600_000);
					await runtime.noteD1Missing(now + 8 * 3_600_000);
					return { early, alerts: seen };
				} finally {
					runtime.announce = announce;
				}
			});
			expect(alerts.early).toBe(0);
			expect(alerts.alerts).toEqual([expect.objectContaining({ kind: 'history_stall', from: 'hot', to: 'recent' })]);
			// Bound again, the chain's first good copy clears the stall.
			await runInDurableObject(stub(), (instance) => {
				(instance as unknown as Runtime).store.historyStatePort().setValue('history:link:hot', null);
			});
		});
		// With no count to keep (LIMIT_HISTORY_D1_RECORDS 0), off as well, and the message says so.
		await changed((runtime) => {
			runtime.d1Held = true;
			runtime.config = { ...runtime.config, limits: { ...(runtime.config as unknown as { limits: Record<string, unknown> }).limits, historyD1Records: 0 } } as never;
		}, async () => {
			const refused = await command(admin, 'disabled-export', '/history export');
			expect(refused.frame.error?.message).toMatch(/^History tier recent \(D1\) holds history but LIMIT_HISTORY_D1_RECORDS is 0 in this deploy/);
		});
	} finally {
		admin.close();
	}
});

it('backs up on BACKUP_EVERY\'s schedule only, keeping BACKUP_KEEP scheduled backups apart from manual ones', async () => {
	const scheduled = async () => (await env.HISTORY_BLOB!.list({ prefix: 'backups/localhost-scheduled-' })).objects.map((object) => object.key);
	const manual = (await env.HISTORY_BLOB!.list({ prefix: 'backups/localhost-manual-' })).objects.length;
	// On demand only (development's BACKUP_EVERY = ""): no schedule runs.
	await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).runScheduledBackup(Date.now() + 86_400_000));
	expect(await scheduled()).toEqual([]);
	await changed(withBackups({ everySeconds: 3_600, keep: 2 }), async () => {
		await runInDurableObject(stub(), async (instance) => {
			const runtime = instance as unknown as Runtime;
			const last = runtime.store.historyMetaNumber('history:export:scheduled');
			try {
				// Each run writes one, a second later each; within the interval, none.
				const at = Date.now();
				for (const offset of [0, 1_000, 2_000]) {
					runtime.store.setHistoryMeta('history:export:scheduled', null);
					vi.useFakeTimers({ now: at + offset, toFake: ['Date'] });
					try { await runtime.runScheduledBackup(at + offset); } finally { vi.useRealTimers(); }
				}
				await runtime.runScheduledBackup(at + 60_000);
			} finally {
				runtime.store.setHistoryMeta('history:export:scheduled', last ? String(last) : null);
			}
		});
	});
	const keys = await scheduled();
	expect(keys).toHaveLength(2);
	for (const key of keys) expect(key).toMatch(/^backups\/localhost-scheduled-\d{8}-\d{6}\.jsonl\.gz$/);
	// Pruning the scheduled ones left the manual ones alone.
	expect((await env.HISTORY_BLOB!.list({ prefix: 'backups/localhost-manual-' })).objects.length).toBe(manual);
});

it('says once a wake that the scheduled backup has no store', async () => {
	await changed((runtime) => {
		withBackups({ everySeconds: 60 })(runtime);
		runtime.runtimeEnv = { ...runtime.runtimeEnv, HISTORY_BLOB: undefined };
		runtime.backupUnboundWarned = false;
	}, async () => {
		const warnings = await runInDurableObject(stub(), async (instance) => {
			const runtime = instance as unknown as Runtime;
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const now = Date.now() + 3_600_000;
				await runtime.runScheduledBackup(now);
				await runtime.runScheduledBackup(now + 120_000);
				return warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('history_export_unbound'));
			} finally {
				warn.mockRestore();
			}
		});
		expect(warnings).toHaveLength(1);
		expect(JSON.parse(warnings[0])).toMatchObject({ event: 'history_export_unbound', reason: 'no backup store: bind HISTORY_BLOB' });
	});
});
