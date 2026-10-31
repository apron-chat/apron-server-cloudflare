import { describe, expect, it } from 'vitest';
import { LIVE_TEXT_POLICY } from '../src/budget';
import { FREE_PLAN } from '../src/plans/free';
import { Store, type StoreLiveTextConfig } from '../src/store';
import { withStore, type TestClock } from './helpers/store';

// Measures what one live text costs in SQLite rows and bytes, for
// docs/cost-report.md (Live text). Run with --reporter=verbose to see the
// table it logs.

const PAID: StoreLiveTextConfig = { ...LIVE_TEXT_POLICY!, publicOrigin: 'https://demo.test', enabled: true };
const FREE: StoreLiveTextConfig = { ...FREE_PLAN.liveText!, publicOrigin: 'https://demo.test', enabled: true };

type Row = { operation: string; reads: number; writes: number; reservedReads: number; reservedWrites: number };

function measure<T>(store: Store, rows: Row[], operation: string, fn: () => T): T {
	const before = store.storageAccounting();
	const result = fn();
	const after = store.storageAccounting();
	const row = {
		operation,
		reads: after.reads - before.reads,
		writes: after.writes - before.writes,
		reservedReads: after.reservedReads - before.reservedReads,
		reservedWrites: after.reservedWrites - before.reservedWrites,
	};
	rows.push(row);
	// Every operation stays within what it reserved.
	expect(row.reads).toBeLessThanOrEqual(row.reservedReads);
	expect(row.writes).toBeLessThanOrEqual(row.reservedWrites);
	return result;
}

function register(store: Store, clock: TestClock, userId: string): void {
	store.registerIdentity({
		userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: clock.value, ipKey: `ip-${userId}`,
		credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
	});
}

/** Colorful terminal output, as `script` captures a build: SGR on most lines. */
function terminalBytes(total: number): Uint8Array {
	const lines: string[] = [];
	let size = 0;
	for (let line = 0; size < total; line++) {
		const text = `\x1b[3${line % 8}m[${String(line).padStart(5, '0')}]\x1b[0m compiling module_${line} … \x1b[1;32mok\x1b[0m\r\n`;
		lines.push(text);
		size += new TextEncoder().encode(text).length;
	}
	return new TextEncoder().encode(lines.join('')).slice(0, total);
}

describe('live text cost', () => {
	for (const [plan, live] of [['Workers Paid', PAID], ['Workers Free', FREE]] as const) {
		it(`measures the rows and bytes of one live text (${plan})`, async () => {
			const rows: Row[] = [];
			const bytes: Record<string, number> = {};
			await withStore(`live-cost-${plan.replace(' ', '-')}`, { liveText: live }, (store, clock) => {
				register(store, clock, 'warm');
				register(store, clock, 'writer');
				// Warm the poster's limiter rows, as a user who posts is.
				store.commitMutation({ userId: 'writer', ipKey: 'ip-writer', method: 'message', now: clock.value, params: { body: { text: 'hi' } }, identity: { user_id: 'writer' } });
				const post = (params: Record<string, unknown>) => store.commitMutation({ userId: 'writer', ipKey: 'ip-writer', method: 'message', now: clock.value, params, identity: { user_id: 'writer' } });
				const size = () => store.databaseSize() ?? 0;

				// Protocol flow, terminal: the message, its write, and its end.
				const created = measure(store, rows, 'Message with a new terminal embed (first live text: creates the user\'s, IP\'s and server\'s live limiter rows)', () => post({ body: { text: '', embeds: [{ kind: 'terminal', title: 'make' }] } }));
				const key = (created.result.embeds as Array<{ write: { key: string } }>)[0].write.key;
				measure(store, rows, 'Write claimed (the PUT arrives)', () => store.claimLiveText(key, clock.value));
				const output = terminalBytes(live.terminalKeepBytes);
				const before = size();
				measure(store, rows, `Terminal finished with ${live.terminalKeepBytes / 1024} KB of colored output`, () => store.finishLiveText(key, output, clock.value));
				bytes.terminal = size() - before;
				bytes.terminalJson = new TextEncoder().encode(JSON.stringify(new TextDecoder().decode(output))).length;

				// Again, its limiter rows existing.
				clock.value += 10 * 60_000;
				const second = measure(store, rows, 'Message with a new append embed (live limiter rows exist)', () => post({ body: { text: 'Plan:\n', format: 'markdown', embeds: [{ kind: 'append' }] } }));
				const appendKey = (second.result.embeds as Array<{ write: { key: string } }>)[0].write.key;
				store.claimLiveText(appendKey, clock.value);
				const appendBefore = size();
				measure(store, rows, 'Append finished, 4 KB moved into the body', () => store.finishLiveText(appendKey, new TextEncoder().encode('x'.repeat(4_096)), clock.value));
				bytes.append = size() - appendBefore;

				// Command flow: the command, then the PUT posts the message.
				clock.value += 10 * 60_000;
				const entry = measure(store, rows, '/embed-terminal (charges the post and the start; posts nothing)', () => store.startLiveCommand({ userId: 'writer', ipKey: 'ip-writer', identity: { user_id: 'writer' }, kind: 'terminal', roomId: 'general', title: 'build', now: clock.value }));
				measure(store, rows, 'Command\'s write claimed (posts its message)', () => store.claimLiveText(entry.key, clock.value));
				measure(store, rows, 'Terminal finished with nothing kept (embed removed: a tombstone)', () => store.finishLiveText(entry.key, null, clock.value));

				// A write that never comes, ended by the alarm; and the alarm's check when nothing is open.
				clock.value += 10 * 60_000;
				post({ body: { text: 'waits', embeds: [{ kind: 'terminal' }] } });
				clock.value += live.writeWindowSeconds * 1_000 + 1;
				measure(store, rows, 'Alarm ends a write that never came (publishes the message without it)', () => store.expireLiveTexts(new Set(), clock.value));
				measure(store, rows, 'Alarm check with no open text (cached)', () => store.expireLiveTexts(new Set(), clock.value));
				// A fresh instance reads the row once.
				const fresh = new Store((store as unknown as { durableStorage: ConstructorParameters<typeof Store>[0] }).durableStorage, { liveText: live }, { now: () => clock.value });
				fresh.initialize();
				measure(fresh, rows, 'Open texts read after a wake (one `_meta` row; then from memory)', () => fresh.openLiveTexts(clock.value));
				measure(fresh, rows, 'Open texts read again (no SQL)', () => fresh.openLiveTexts(clock.value));
			});
			console.log(JSON.stringify({ plan, rows, bytes }, null, 1));
			// One text's storage stays within what the plan's budgets assume (docs/cost-report.md).
			expect(bytes.terminalJson).toBeLessThanOrEqual(4 * live.terminalKeepBytes);
		});
	}
});
