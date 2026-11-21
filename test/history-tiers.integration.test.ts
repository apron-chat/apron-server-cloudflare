import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { HistoryChain } from '../src/history/chain';
import { buildHistoryChain, historyLayout } from '../src/history/config';
import { purgedRecord, renamedRecord, rewritten } from '../src/history/records';
import type { Store } from '../src/store';
import { connect, greeting, request } from './helpers/socket';

// The tests bind a local D1 database as HISTORY_D1 (wrangler.toml), so the
// object's D1 history tier is on: records past SQLite's count go there,
// kept for historyD1Records more (no cold tier: the chain below is built without one).

const stub = () => env.DEMO.getByName('public-demo-v1');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Runtime = {
	store: Store & { config: Record<string, unknown> };
	config: { limits: Record<string, number> };
	history?: HistoryChain;
	alarm(): Promise<void>;
};

const archived = async () => (await env.HISTORY_D1!.prepare('SELECT log_id, record_json FROM records ORDER BY log_id').all<{ log_id: number; record_json: string }>()).results;

it('moves records past SQLite into D1, serves them in history, and expires them past D1\'s own limit', async () => {
	const peer = await connect({ ip: '192.0.2.91' });
	try {
		await greeting(peer);
		expect((await request(peer, 'auth', 'auth', { scheme: 'guest' })).result).toBeDefined();
		const logs = await runInDurableObject(stub(), async (instance, state) => {
			const runtime = instance as unknown as Runtime;
			// Three records in the hot log, four more in the archive, with no minimum age.
			runtime.store.config = {
				...runtime.store.config, retentionRecords: 3, historyD1Records: 4, cleanupThresholdPercent: 100,
				anonymousPostsPerMinute: 1_000, ipPostsPerMinute: 1_000, globalPostsPerMinute: 1_000,
			};
			runtime.config = { ...runtime.config, limits: { ...runtime.config.limits, retentionRecords: 3, historyD1Records: 4, cleanupThresholdPercent: 100 } };
			// The chain takes its tiers' limits when built.
			runtime.history = buildHistoryChain({ layout: historyLayout(env, runtime.config.limits as never), limits: runtime.config.limits as never, store: runtime.store, clock: { now: Date.now } });
			const logs: string[] = [];
			for (let index = 0; index < 10; index += 1) {
				// One sender's message among those the archive will hold, for /purge below.
				const userId = index === 5 ? 'archive-victim' : 'archive-poster';
				const result = runtime.store.mutate({
					userId, ipKey: 'archive-ip', requestId: `archive-${index}`, method: 'message', now: Date.now(),
					params: { room_id: 'general', body: { format: 'plain', text: `message ${index}` } },
					identity: { user_id: userId, name: userId },
				});
				logs.push(String(result.message!.log_id));
				// Each its own commit time: the count ends at one.
				await sleep(3);
			}
			// Cleanup due on each alarm, until it settles: copy, remove, find the archive's limit, publish it, trim.
			for (let round = 0; round < 8; round += 1) {
				state.storage.sql.exec('UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1');
				runtime.store.forgetCleanupDue();
				await runtime.alarm();
			}
			const hot = state.storage.sql.exec<{ log_id: number }>('SELECT log_id FROM records ORDER BY log_id').toArray().map((row) => String(row.log_id));
			expect(hot).toEqual(logs.slice(7));
			return logs;
		});

		// The archive holds the four newest records that left the hot log; the rest expired.
		expect((await archived()).map((row) => String(row.log_id))).toEqual(logs.slice(3, 7));
		const bounds = await runInDurableObject(stub(), (instance) => (instance as unknown as Runtime).store.logBounds());
		expect(bounds.history_floor).toBe(logs[3]);

		// History serves both, newest page first, as one log.
		const newest = (await request(peer, 'newest', 'history', { room_id: 'general', limit: 50 })).result;
		expect(newest.messages.map((message: { log_id: string }) => message.log_id)).toEqual(logs.slice(3));
		expect(newest.history_log_id).toBe(logs[3]);
		expect(newest.more).toBe(false);
		// Forward from the start: the archive's records first.
		const first = (await request(peer, 'first', 'history', { room_id: 'general', after: '0', limit: 2 })).result;
		expect(first.messages.map((message: { log_id: string }) => message.log_id)).toEqual(logs.slice(3, 5));
		expect(first.more).toBe(true);
		// A page across the hot floor (`before` includes its own).
		const across = (await request(peer, 'across', 'history', { room_id: 'general', before: logs[7], limit: 3 })).result;
		expect(across.messages.map((message: { log_id: string }) => message.log_id)).toEqual(logs.slice(5, 8));

		// /purge: queued for the link into D1, and applied to pages that read it before D1 has it.
		await runInDurableObject(stub(), (instance) => {
			const runtime = instance as unknown as Runtime;
			runtime.store.purgeUsers({ userIds: ['archive-victim'] });
			expect(runtime.store.historyRewrites()).toEqual([{ seq: 1, rewrite: { user: 'archive-victim', into: null, messages: [] } }]);
			// A tier that finds more of the user's messages adds them to the rewrite, once each; another seq is left alone.
			runtime.store.amendHistoryPurge(1, ['no-such-message', 'no-such-message']);
			runtime.store.amendHistoryPurge(9, ['other']);
			expect(runtime.store.historyRewrites()).toEqual([{ seq: 1, rewrite: { user: 'archive-victim', into: null, messages: ['no-such-message'] } }]);
		});
		expect((await archived()).map((row) => String(row.log_id))).toEqual(logs.slice(3, 7));
		const early = (await request(peer, 'early', 'history', { room_id: 'general', limit: 50 })).result;
		expect(early.messages.map((message: { log_id: string }) => message.log_id)).toEqual([logs[3], logs[4], ...logs.slice(6)]);
		// The next full alarm delivers it to D1 (the command asks for one in a second).
		await runInDurableObject(stub(), async (instance, state) => {
			const runtime = instance as unknown as Runtime;
			state.storage.sql.exec('UPDATE maintenance SET next_cleanup_ms = 0 WHERE id = 1');
			runtime.store.forgetCleanupDue();
			await runtime.alarm();
			expect(runtime.store.historyRewrites()).toEqual([]);
		});
		expect((await archived()).map((row) => String(row.log_id))).toEqual([logs[3], logs[4], logs[6]]);
		// /status shows what each holds against its limit.
		const status = await runInDurableObject(stub(), (instance) => (instance as unknown as { historyStatus(now: number): Promise<string[]> }).historyStatus(Date.now()));
		expect(status).toEqual(['- History in SQLite: 3 / 3 records (100%; cleanup keeps 3)', '- History in D1: 3 / 4 records (75%; cleanup keeps 4)']);
		const purged = (await request(peer, 'purged', 'history', { room_id: 'general', limit: 50 })).result;
		expect(purged.messages.map((message: { log_id: string }) => message.log_id)).toEqual([logs[3], logs[4], ...logs.slice(6)]);
	} finally { peer.close(); }
});

it('rewrites records below SQLite as /purge and /rename rewrite SQLite\'s, and applies pending rewrites to pages read there', () => {
	const reactions = { kind: 'reactions', record_json: JSON.stringify({ message_id: 'm1', reactions: [{ from: { user_id: 'a' }, emojis: ['👍'] }, { from: { user_id: 'b' }, emojis: ['🎉'] }] }) };
	expect(JSON.parse(purgedRecord(reactions, ['a'], [])!).reactions).toEqual([{ from: { user_id: 'b' }, emojis: ['🎉'] }]);
	// Every set on a purged message goes, and a record left empty with them.
	expect(purgedRecord(reactions, ['z'], ['m1'])).toBeNull();
	const membership = { kind: 'membership', record_json: JSON.stringify({ members: [{ user: { user_id: 'a' }, joined: true }] }) };
	expect(purgedRecord(membership, ['a'], [])).toBeNull();
	const message = { kind: 'message', record_json: JSON.stringify({ message_id: 'm1', from: { user_id: 'a', name: 'A' } }) };
	expect(JSON.parse(renamedRecord(message, 'a', 'b')).from).toEqual({ user_id: 'b', name: 'A' });
	expect(JSON.parse(renamedRecord(reactions, 'a', 'c')).reactions.map((set: { from: { user_id: string } }) => set.from.user_id)).toEqual(['c', 'b']);
	expect(JSON.parse(renamedRecord(membership, 'a', 'd')).members[0].user.user_id).toBe('d');
	// Rewrites pending for a tier, applied in order to what a page read from it.
	const at = (logId: number, kind: string, value: object) => ({ room_id: 'general', log_id: logId, commit_ms: logId, kind, record_json: JSON.stringify(value) });
	const records = [
		at(1, 'message', { message_id: 'm1', from: { user_id: 'gone' } }),
		at(2, 'message', { message_id: 'm2', from: { user_id: 'old' } }),
		at(3, 'reactions', { message_id: 'm1', reactions: [{ from: { user_id: 'x' }, emojis: ['👍'] }] }),
		at(4, 'reactions', { message_id: 'm2', reactions: [{ from: { user_id: 'gone' }, emojis: ['👍'] }, { from: { user_id: 'old' }, emojis: ['🎉'] }] }),
		at(5, 'membership', { members: [{ user: { user_id: 'gone' }, joined: true }] }),
	];
	const result = rewritten(records, [{ user: 'gone', into: null }, { user: 'old', into: 'new' }]);
	expect(result.map((entry) => [entry.log_id, JSON.parse(entry.record_json)])).toEqual([
		[2, { message_id: 'm2', from: { user_id: 'new' } }],
		[4, { message_id: 'm2', reactions: [{ from: { user_id: 'new' }, emojis: ['🎉'] }] }],
	]);
});
