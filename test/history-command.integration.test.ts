import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
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
