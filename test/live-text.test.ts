import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, LIVE_TEXT_POLICY } from '../src/budget';
import { ConfigError, loadConfig, validateLiveTextPolicy } from '../src/config';
import { liveCommandNotice } from '../src/index';
import { keepAppend, keepLast, LiveBuffer, liveTextString } from '../src/live-text';
import { FREE_PLAN } from '../src/plans/free';
import { PAID_PLAN } from '../src/plans/paid';
import { LIVE_ORPHAN_GRACE_MS, MAX_TERMINAL_OUTPUT_JSON_BYTES, Store, type LiveEntry, type StoreLiveTextConfig } from '../src/store';
import { errorCode, expectRetryAfter, withStore, type TestClock } from './helpers/store';

const encode = (text: string) => new TextEncoder().encode(text);
const bytes = (...values: number[]) => new Uint8Array(values);
const LIVE: StoreLiveTextConfig = { ...LIVE_TEXT_POLICY!, publicOrigin: 'https://demo.test', enabled: true };

/** §4.8.6's reference `keep_last`, transcribed: the rule the server must match. */
function reference(output: Uint8Array, limit: number): Uint8Array {
	if (output.length <= limit) return output;
	const tail = output.slice(output.length - limit);
	for (let i = 0; i < tail.length; i++) if (tail[i] < 0x20) return tail.slice(i);
	let start = 0;
	while (start < tail.length && tail[start] >= 0x80 && tail[start] < 0xc0) start++;
	return tail.slice(start);
}

describe('liveTextString', () => {
	it("decodes as WHATWG's UTF-8 decode without BOM (§4.8.3)", () => {
		const bytes = (...b: number[]) => new Uint8Array(b);
		// One U+FFFD per maximal invalid subsequence (Unicode §3.9.6).
		expect(liveTextString(bytes(0x61, 0xf1, 0x80, 0x80, 0xe1, 0x80, 0xc2, 0x62))).toBe('a\ufffd\ufffd\ufffdb');
		expect(liveTextString(bytes(0xe1, 0x80, 0xe2, 0xf0, 0x91, 0x92, 0xf1, 0xbf, 0x41))).toBe('\ufffd\ufffd\ufffd\ufffdA');
		// An incomplete sequence at the end is one U+FFFD; a leading BOM stays.
		expect(liveTextString(bytes(0x65, 0xe2, 0x82))).toBe('e\ufffd');
		expect(liveTextString(bytes(0xef, 0xbb, 0xbf, 0x62))).toBe('\ufeffb');
	});
});

describe('keep_last and the append\'s first part', () => {
	it('cuts a terminal at its first control character in the last part (§4.8.6)', () => {
		expect(keepLast(encode('abc\x1b[31mdef'), 100)).toEqual(encode('abc\x1b[31mdef'));
		// The last 8 bytes are "[31mdef\n"? No: "1mdef\nxy"; it starts at the line feed.
		expect(liveTextString(keepLast(encode('line one\nline two\nxy'), 8))).toBe('\nxy');
		expect(liveTextString(keepLast(encode('\x1b[31mred\x1b[0m'), 6))).toBe('\x1b[0m');
	});

	it('without a control character, skips a partial character at the cut', () => {
		// "é" is C3 A9: a cut between them starts at the next whole character.
		expect(keepLast(encode('aééé'), 5)).toEqual(encode('éé'));
		expect(keepLast(bytes(0x61, 0xe2, 0x82, 0xac, 0x62), 3)).toEqual(bytes(0x62));
		expect(keepLast(bytes(0x80, 0x80, 0x80), 2)).toEqual(new Uint8Array(0));
	});

	it('matches the reference function on random bytes and limits', () => {
		const alphabet = [0x0a, 0x1b, 0x20, 0x41, 0x7e, 0x80, 0x9f, 0xbf, 0xc3, 0xe2, 0xf0];
		for (let run = 0; run < 500; run++) {
			const length = Math.floor(Math.random() * 40);
			const input = Uint8Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]);
			const limit = 1 + Math.floor(Math.random() * 30);
			expect(keepLast(input, limit)).toEqual(reference(input, limit));
		}
	});

	it('keeps an append\'s first part up to a whole character (§4.8.5)', () => {
		expect(keepAppend(encode('héllo'), 2)).toEqual(encode('h'));
		expect(keepAppend(encode('héllo'), 3)).toEqual(encode('hé'));
		expect(keepAppend(encode('abc'), 5)).toEqual(encode('abc'));
		expect(keepAppend(encode('€'), 2)).toEqual(new Uint8Array(0));
		// Kept as decoded: an invalid byte is U+FFFD's three bytes, and so is an incomplete character at the end.
		expect(keepAppend(bytes(0x61, 0xff, 0xe2, 0x82), 10)).toEqual(encode('a\ufffd\ufffd'));
	});
});

describe('LiveBuffer', () => {
	it('keeps a terminal\'s last part exactly as one cut of everything would, however it arrives', () => {
		for (let run = 0; run < 50; run++) {
			const limit = 16 + Math.floor(Math.random() * 48);
			const buffer = new LiveBuffer('terminal', limit);
			const all: number[] = [];
			for (let chunk = 0; chunk < 40; chunk++) {
				const piece = encode(`${chunk % 3 ? 'é' : '\n'}\x1b[3${chunk % 8}mchunk ${chunk} ${'x'.repeat(chunk % 7)}`);
				all.push(...piece);
				const pushed = buffer.push(piece);
				expect(pushed.send).toEqual(piece);
				expect(buffer.kept()).toEqual(reference(Uint8Array.from(all), limit));
			}
			expect(buffer.received).toBe(all.length);
		}
	});

	it('keeps an append\'s first part, sends readers only that, and is full at its limit', () => {
		const buffer = new LiveBuffer('append', 5);
		expect(buffer.push(encode('ab')).send).toEqual(encode('ab'));
		// "c" and "é" fit the 5 bytes; "€" would cross it.
		const last = buffer.push(encode('cé€'));
		expect(last).toEqual({ send: encode('cé'), full: true });
		expect(buffer.kept()).toEqual(encode('abcé'));
		expect(buffer.push(encode('more')).send).toEqual(new Uint8Array(0));
	});

	it('applies an append\'s backspace to the code point before it, "é" and an astral emoji included (§4.8.5)', () => {
		const buffer = new LiveBuffer('append', 64);
		buffer.push(encode('caf\u00e9\b'));
		expect(liveTextString(buffer.kept())).toBe('caf');
		// One backspace removes a surrogate pair's one code point, not half of it.
		buffer.push(encode('e \u{1F680}\b\u{1F600}'));
		expect(liveTextString(buffer.kept())).toBe('cafe \u{1F600}');
		buffer.push(encode('\b\b'));
		expect(liveTextString(buffer.kept())).toBe('cafe');
		// U+FFFD from an invalid byte is one code point too.
		buffer.push(bytes(0xff, 0x08, 0x21));
		expect(liveTextString(buffer.kept())).toBe('cafe!');
	});

	it('clears an append\'s text with form feed, and a backspace with nothing before it does nothing', () => {
		const buffer = new LiveBuffer('append', 64);
		buffer.push(encode('draft one\fdraft two'));
		expect(liveTextString(buffer.kept())).toBe('draft two');
		buffer.push(encode('\f\b\b\bHello wrold\b\b\b\borld, caf\u00e9\be'));
		expect(liveTextString(buffer.kept())).toBe('Hello world, cafe');
		buffer.push(encode('\f'));
		expect(buffer.kept()).toEqual(new Uint8Array(0));
		buffer.end();
		expect(keepAppend(encode('\b\bok'), 10)).toEqual(encode('ok'));
	});

	it('edits the same however the bytes are split, a character split across chunks included', () => {
		const text = encode('ab\u00e9\u20ac\u{1F680}\bx\fy\u00e9\u{1F600}\b\u{1F431}\x08z\u00e9');
		const whole = keepAppend(text, 64);
		expect(liveTextString(whole)).toBe('y\u00e9z\u00e9');
		for (let cut = 0; cut <= text.length; cut++) {
			const buffer = new LiveBuffer('append', 64);
			const sent: number[] = [];
			sent.push(...buffer.push(text.subarray(0, cut)).send);
			sent.push(...buffer.push(text.subarray(cut)).send);
			sent.push(...buffer.end());
			expect(buffer.kept()).toEqual(whole);
			// Readers get whole characters, edits included: applied, they show the kept text.
			expect(new TextDecoder().decode(Uint8Array.from(sent))).toBe(new TextDecoder().decode(text));
		}
	});

	it('sends readers whole characters only, and the edited text so far to a reader that connects late', () => {
		const buffer = new LiveBuffer('append', 64);
		// "é" is C3 A9: the half that arrives waits for the rest.
		expect(buffer.push(bytes(0x61, 0xc3)).send).toEqual(encode('a'));
		expect(buffer.kept()).toEqual(encode('a'));
		expect(buffer.push(bytes(0xa9, 0x08, 0x62)).send).toEqual(encode('\u00e9\bb'));
		// A late reader starts from the edited text, with no erased draft.
		expect(buffer.kept()).toEqual(encode('ab'));
		// An incomplete character at the end reads as U+FFFD, for the readers too.
		expect(buffer.push(bytes(0xe2, 0x82)).send).toEqual(new Uint8Array(0));
		expect(buffer.end()).toEqual(encode('\ufffd'));
		expect(buffer.kept()).toEqual(encode('ab\ufffd'));
	});

	it('counts the edited text against an append\'s limit', () => {
		// Raw, "abcd\b\befgh" passes 4 bytes at once; edited, "abef" fits and "g" ends it.
		const buffer = new LiveBuffer('append', 4);
		expect(buffer.push(encode('abcd\b\bef')).full).toBe(false);
		expect(buffer.kept()).toEqual(encode('abef'));
		const last = buffer.push(encode('gh'));
		expect(last).toEqual({ send: new Uint8Array(0), full: true });
		expect(buffer.kept()).toEqual(encode('abef'));
		// A cut inside a chunk with edits sends readers the text read up to the cut.
		const cut = new LiveBuffer('append', 4);
		expect(cut.push(encode('xy\f\u00e9a\u20acz'))).toEqual({ send: encode('xy\f\u00e9a'), full: true });
		expect(cut.kept()).toEqual(encode('\u00e9a'));
		// Long drafts erased as they go never fill it.
		const drafts = new LiveBuffer('append', 4);
		for (let index = 0; index < 1_000; index++) expect(drafts.push(encode('four\f')).full).toBe(false);
		expect(drafts.kept()).toEqual(new Uint8Array(0));
	});

	it('leaves a terminal\'s backspace and form feed as they are', () => {
		const buffer = new LiveBuffer('terminal', 64);
		const output = encode('abc\b\bde\fclear\x08');
		expect(buffer.push(output).send).toEqual(output);
		expect(buffer.end()).toEqual(new Uint8Array(0));
		expect(buffer.kept()).toEqual(output);
	});
});

describe('live text policy', () => {
	const env = { ENVIRONMENT: 'development', PUBLIC_ORIGIN: 'https://demo.test', UPLOAD_SIGNING_KEY: 'k'.repeat(32) };

	it('keeps the owner\'s limits: 120 seconds, 300 for admins and mods, appends within the text limit', () => {
		for (const plan of [FREE_PLAN, PAID_PLAN]) {
			expect(plan.liveText).toMatchObject({ maxSeconds: 120, moderatorMaxSeconds: 300, writeWindowSeconds: 120 });
			expect(plan.liveText!.appendMaxBytes).toBeLessThanOrEqual(plan.limits.maxTextBytes);
			expect(() => validateLiveTextPolicy(plan.liveText!, plan.limits)).not.toThrow();
		}
		const limits = PAID_PLAN.limits;
		expect(() => validateLiveTextPolicy({ ...PAID_PLAN.liveText!, maxSeconds: 121 }, limits)).toThrow(ConfigError);
		expect(() => validateLiveTextPolicy({ ...PAID_PLAN.liveText!, moderatorMaxSeconds: 301 }, limits)).toThrow(ConfigError);
		expect(() => validateLiveTextPolicy({ ...PAID_PLAN.liveText!, appendMaxBytes: limits.maxTextBytes + 1 }, limits)).toThrow(ConfigError);
		expect(() => validateLiveTextPolicy({ ...PAID_PLAN.liveText!, terminalKeepBytes: 64 * 1024 }, limits)).toThrow(ConfigError);
		expect(() => validateLiveTextPolicy({ ...PAID_PLAN.liveText!, concurrent: 9 }, limits)).toThrow(ConfigError);
		expect(() => validateLiveTextPolicy({ ...PAID_PLAN.liveText!, startsPerUser: 7 }, limits)).toThrow(ConfigError);
		// A finished terminal's output always fits one history response.
		expect(MAX_TERMINAL_OUTPUT_JSON_BYTES + limits.maxSnapshotBytes + 1024).toBeLessThanOrEqual(limits.historyMaxResponseBytes);
	});

	it('is configured with PUBLIC_ORIGIN and UPLOAD_SIGNING_KEY, on by the plan or LIVE_TEXT, and lowered by LIVE_TEXT_<KEY>', () => {
		expect(loadConfig({ ENVIRONMENT: 'development' }).liveText).toBeUndefined();
		const configured = loadConfig(env);
		expect(configured.liveText).toMatchObject({ publicOrigin: 'https://demo.test', policy: LIVE_TEXT_POLICY });
		expect(configured.liveTextEnabled).toBe(PAID_PLAN.features.liveText);
		expect(loadConfig({ ...env, LIVE_TEXT: 'false' }).liveTextEnabled).toBe(false);
		expect(loadConfig({ ...env, LIVE_TEXT_MAX_SECONDS: '5' } as typeof env).liveText!.policy.maxSeconds).toBe(5);
		expect(() => loadConfig({ ...env, LIVE_TEXT_MAX_SECONDS: '600' } as typeof env)).toThrow(ConfigError);
		expect(() => loadConfig({ ...env, LIVE_TEXT: 'maybe' })).toThrow(ConfigError);
	});

	it('words the command notice with the write URL and this user\'s limits', () => {
		const policy = { writeWindowSeconds: 120, maxInputBytes: 2 * 1024 * 1024 };
		const terminal = liveCommandNotice('terminal', 'https://demo.test/w/l.x', { maxMs: 300_000, limit: 32 * 1024 }, policy);
		expect(terminal).toContain('within 2 minutes (80×40, up to 300 seconds and 2 MB; the last 32 KB is kept)');
		expect(terminal).toContain("script -qfc 'stty cols 80 rows 40; YOUR_COMMAND' /dev/null | curl -sT - 'https://demo.test/w/l.x'");
		const append = liveCommandNotice('append', 'https://demo.test/w/l.y', { maxMs: 120_000, limit: 4_000 }, policy);
		expect(append).toContain('up to 120 seconds and 4,000 bytes; it is appended to your message as markdown, revised by backspace and form feed):');
		expect(terminal).not.toContain('backspace');
		expect(append).toContain("your-llm-command | curl -sT - 'https://demo.test/w/l.y'");
		// The link is a bearer credential, good for one write.
		for (const notice of [terminal, append]) expect(notice).toContain("The link works once, and anyone with it can stream as you, so don't share it.");
	});
});

function register(store: Store, clock: TestClock, userId: string, roles: string[] = []): void {
	store.registerIdentity({
		userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: clock.value, ipKey: `ip-${userId}`,
		credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
	});
	for (const role of roles) store.setRole({ userId, role, now: clock.value });
}

function post(store: Store, clock: TestClock, userId: string, params: Record<string, unknown>, ipKey = `ip-${userId}`) {
	return store.commitMutation({ userId, ipKey, method: 'message', now: clock.value, params, identity: { user_id: userId, name: `Name of ${userId}` } });
}

type LiveWrite = { embed_id: string; kind: string; write: { key: string; max_bytes: number; expires_ms: number } };
const writeOf = (result: Record<string, unknown>) => (result.embeds as LiveWrite[])[0];
const bodyOf = (finish: { broadcasts: Array<{ params: Record<string, unknown> }> }) => finish.broadcasts[0]?.params as { body?: { text?: string; embeds?: Array<Record<string, unknown>> }; deleted?: boolean; prev_log_id?: string };

describe('store live text', () => {
	it('starts a terminal from a message, claims its write once, and publishes the kept output', async () => {
		await withStore('live-terminal', { liveText: { ...LIVE, terminalKeepBytes: 8 } }, (store, clock) => {
			register(store, clock, 'tess');
			const created = post(store, clock, 'tess', { body: { text: '', embeds: [{ kind: 'terminal', title: 'make test', url: 'https://evil.example/', output: 'forged' }] } });
			const embed = (created.message!.body!.embeds as Array<Record<string, unknown>>)[0];
			// The server owns url and output (§4.8.2); the broadcast that creates it carries url.
			expect(embed).toEqual({ embed_id: expect.stringMatching(/^embed_/), kind: 'terminal', title: 'make test', url: expect.stringMatching(/^https:\/\/demo\.test\/live\/[A-Za-z0-9_-]{22}$/) });
			const write = writeOf(created.result);
			expect(write).toEqual({ embed_id: embed.embed_id, kind: 'terminal', write: { key: expect.stringMatching(/^l\/[A-Za-z0-9_-]{22}$/), max_bytes: LIVE.maxInputBytes, expires_ms: clock.value + LIVE.writeWindowSeconds * 1_000 } });
			const claimed = store.claimLiveText(write.write.key, clock.value);
			expect(claimed?.entry).toMatchObject({ state: 'live', startedMs: clock.value, maxMs: 120_000, messageId: created.result.message_id });
			expect(claimed?.broadcasts).toEqual([]);
			expect(store.claimLiveText(write.write.key, clock.value)).toBeNull();
			const finished = store.finishLiveText(write.write.key, encode('ignored\x1b[1mbold'), clock.value);
			// The store keeps the last 8 bytes itself, whatever it is given: they start at ESC.
			expect(bodyOf(finished).body!.embeds).toEqual([{ embed_id: embed.embed_id, kind: 'terminal', title: 'make test', output: '\x1b[1mbold' }]);
			expect(store.finishLiveText(write.write.key, encode('again'), clock.value).broadcasts).toEqual([]);
			// A save keeps the output from the server's record, whatever it sends.
			const saved = post(store, clock, 'tess', { message_id: created.result.message_id, body: { text: 'done', embeds: [{ embed_id: embed.embed_id, kind: 'terminal', title: 'renamed', output: 'forged' }] } });
			expect((saved.message!.body!.embeds as unknown[])[0]).toEqual({ embed_id: embed.embed_id, kind: 'terminal', title: 'renamed', output: '\x1b[1mbold' });
		});
	});

	it('appends the kept text to the body, within the text limit, and removes the embed (§4.8.5)', async () => {
		await withStore('live-append', { liveText: LIVE, maxTextBytes: 20 }, (store, clock) => {
			register(store, clock, 'ada');
			register(store, clock, 'bob');
			const created = post(store, clock, 'ada', { body: { text: 'Plan: ', format: 'markdown', mentions: ['bob'], embeds: [{ kind: 'append' }] } });
			const write = writeOf(created.result);
			const claimed = store.claimLiveText(write.write.key, clock.value)!;
			// The append may add what the text limit leaves.
			expect(claimed.entry.limit).toBe(14);
			const finished = store.finishLiveText(write.write.key, encode('roll back @carol'), clock.value);
			const params = finished.broadcasts[0].params as { body: Record<string, unknown>; prev_log_id: string };
			// The appended text does not change mentions.
			expect(params.body).toEqual({ text: 'Plan: roll back @car', format: 'markdown', mentions: ['bob'] });
			expect(params.prev_log_id).toBe(created.result.message_id);
			// At most one append in a message (§4.8.5, invalid_params), and one live text per message (policy).
			expect(errorCode(() => post(store, clock, 'bob', { body: { embeds: [{ kind: 'append' }, { kind: 'append' }] } }))).toBe('invalid_params');
			expect(errorCode(() => post(store, clock, 'bob', { body: { embeds: [{ kind: 'terminal' }, { kind: 'append' }] } }))).toBe('denied');
			const open = post(store, clock, 'bob', { body: { text: 'x', embeds: [{ kind: 'append' }] } });
			const keptAppend = { embed_id: writeOf(open.result).embed_id, kind: 'append' };
			const twice = () => post(store, clock, 'bob', { message_id: open.result.message_id, body: { text: 'x', embeds: [keptAppend, { kind: 'append' }] } });
			expect(errorCode(twice)).toBe('invalid_params');
			expect(twice).toThrow('A message has at most one append embed');
		});
	});

	it('appends the text after its edits, which never reach into body.text (§4.8.5)', async () => {
		await withStore('live-append-edits', { liveText: LIVE, maxTextBytes: 24 }, (store, clock) => {
			register(store, clock, 'ed');
			const created = post(store, clock, 'ed', { body: { text: 'Plan:', format: 'markdown', embeds: [{ kind: 'append' }] } });
			const key = writeOf(created.result).write.key;
			store.claimLiveText(key, clock.value);
			// The store edits whatever it is given: backspaces before the live text do nothing.
			const finished = store.finishLiveText(key, encode('\b\b\b\bfirst draft\f\b ok caf\u00e9\be \u{1F680}\b!'), clock.value);
			expect(bodyOf(finished).body).toEqual({ text: 'Plan: ok cafe !', format: 'markdown' });
			// The limit counts the edited text: 23 bytes of room, of which an erased draft takes none.
			const next = post(store, clock, 'ed', { body: { text: 'x', embeds: [{ kind: 'append' }] } });
			const nextKey = writeOf(next.result).write.key;
			store.claimLiveText(nextKey, clock.value);
			const long = store.finishLiveText(nextKey, encode(`${'draft '.repeat(3)}\f${'0123456789'.repeat(3)}`), clock.value);
			expect(bodyOf(long).body!.text).toBe('x01234567890123456789012');
		});
	});

	it('ends a text early when a save removes its embed or deletes its message', async () => {
		await withStore('live-save', { liveText: LIVE }, (store, clock) => {
			register(store, clock, 'eve');
			const first = post(store, clock, 'eve', { body: { text: 'x', embeds: [{ kind: 'terminal' }] } });
			const key = writeOf(first.result).write.key;
			store.claimLiveText(key, clock.value);
			const saved = post(store, clock, 'eve', { message_id: first.result.message_id, body: { text: 'no output after all' } });
			expect(saved.liveEnded).toEqual([key]);
			expect(store.openLiveTexts(clock.value)).toEqual([]);
			expect(store.finishLiveText(key, encode('late'), clock.value).broadcasts).toEqual([]);
			const second = post(store, clock, 'eve', { body: { text: 'y', embeds: [{ kind: 'append' }] } });
			const deleted = post(store, clock, 'eve', { message_id: second.result.message_id, deleted: true });
			expect(deleted.liveEnded).toEqual([writeOf(second.result).write.key]);
		});
	});

	it('gives admins and mods 300 seconds and everyone else 120', async () => {
		await withStore('live-roles', { liveText: LIVE }, (store, clock) => {
			const cases: Array<[string, string[], number]> = [['plain', [], 120_000], ['admin_user', ['admin'], 300_000], ['mod_user', ['mod'], 300_000], ['threader_user', ['threader'], 120_000], ['friend_user', ['friend'], 120_000]];
			for (const [userId, roles, maxMs] of cases) {
				register(store, clock, userId, roles);
				const created = post(store, clock, userId, { body: { embeds: [{ kind: 'terminal' }] } });
				expect(store.openLiveTexts(clock.value).find((entry) => entry.owner === userId)!.maxMs).toBe(maxMs);
				store.finishLiveText(writeOf(created.result).write.key, null, clock.value);
			}
		});
	});

	it('allows one open text per user, pending writes included, and refuses past the server\'s concurrent texts', async () => {
		await withStore('live-concurrent', { liveText: { ...LIVE, concurrent: 2 } }, (store, clock) => {
			for (const userId of ['u1', 'u2', 'u3']) register(store, clock, userId);
			const pending = store.startLiveCommand({ userId: 'u1', ipKey: 'ip-1', identity: { user_id: 'u1' }, kind: 'terminal', roomId: 'general', now: clock.value });
			let error: unknown;
			try { store.startLiveCommand({ userId: 'u1', ipKey: 'ip-1', identity: { user_id: 'u1' }, kind: 'append', roomId: 'general', now: clock.value }); }
			catch (caught) { error = caught; }
			expect(error).toMatchObject({ code: 'denied', message: expect.stringContaining('already have a live text open') });
			expect(errorCode(() => post(store, clock, 'u1', { body: { embeds: [{ kind: 'terminal' }] } }))).toBe('denied');
			post(store, clock, 'u2', { body: { embeds: [{ kind: 'terminal' }] } });
			try { post(store, clock, 'u3', { body: { embeds: [{ kind: 'terminal' }] } }); error = undefined; }
			catch (caught) { error = caught; }
			expectRetryAfter(error);
			expect(error.message).toBe('Live text is busy on this server; try again shortly');
			// A command's write that expires frees its owner, with nothing to publish.
			clock.value = pending.writeExpiresMs + 1;
			expect(store.startLiveCommand({ userId: 'u1', ipKey: 'ip-1', identity: { user_id: 'u1' }, kind: 'append', roomId: 'general', now: clock.value }).owner).toBe('u1');
			// A message's expired write is ended by the alarm, which publishes it without the embed.
			const expired = store.expireLiveTexts(new Set(), clock.value);
			expect(expired.ended.map((entry) => entry.owner)).toEqual(['u2']);
			expect(expired.broadcasts).toHaveLength(1);
		});
	});

	it('limits starts per user, per IP and per server, a guest by their IP', async () => {
		await withStore('live-rates', { liveText: { ...LIVE, startsPerDay: 7 } }, (store, clock) => {
			register(store, clock, 'spammer');
			const start = (userId: string, ipKey: string) => {
				const entry = store.startLiveCommand({ userId, ipKey, identity: { user_id: userId }, kind: 'terminal', roomId: 'general', now: clock.value });
				store.claimLiveText(entry.key, clock.value);
				store.finishLiveText(entry.key, null, clock.value);
			};
			for (let index = 0; index < LIVE.startsPerUser; index++) start('spammer', 'ip-a');
			let error: unknown;
			try { start('spammer', 'ip-b'); } catch (caught) { error = caught; }
			expectRetryAfter(error);
			expect(error.message).toBe('Live text limit reached');
			expect((error.data as { retry_after?: number } | undefined)).toBeUndefined();
			// The window refills: one start per startWindowMinutes / startsPerUser.
			clock.value += (LIVE.startWindowMinutes * 60_000) / LIVE.startsPerUser + 1;
			start('spammer', 'ip-b');
			// Guests are limited by their IP: the IP's limit holds across guest identities.
			start('guest_1', 'ip-c');
			start('guest_2', 'ip-c');
			start('guest_3', 'ip-c');
			try { start('guest_4', 'ip-c'); error = undefined; } catch (caught) { error = caught; }
			expectRetryAfter(error);
			// The server's daily count: 7 started, so the next is refused until the reset.
			register(store, clock, 'late');
			try { start('late', 'ip-d'); error = undefined; } catch (caught) { error = caught; }
			expectRetryAfter(error);
			expect(error.message).toBe('Daily live text limit reached for the server');
			expect(error.retryAfterMs).toBe(86_400_000 - clock.value % 86_400_000);
		});
	});

	it('expires a protocol write that never comes and ends a text its object lost', async () => {
		await withStore('live-expiry', { liveText: LIVE }, (store, clock) => {
			register(store, clock, 'gil');
			register(store, clock, 'hal');
			const waiting = post(store, clock, 'gil', { body: { text: '', embeds: [{ kind: 'terminal' }] } });
			const lost = post(store, clock, 'hal', { body: { text: 'keep me', embeds: [{ kind: 'append' }] } });
			const lostKey = writeOf(lost.result).write.key;
			store.claimLiveText(lostKey, clock.value);
			// Streaming in this instance: nothing is due yet.
			const quiet = store.expireLiveTexts(new Set([lostKey]), clock.value);
			expect(quiet.broadcasts).toEqual([]);
			expect(quiet.next).toBe(clock.value + LIVE.writeWindowSeconds * 1_000);
			clock.value += LIVE.writeWindowSeconds * 1_000 + 1;
			// Not streaming here (an evicted instance had it): ended with nothing kept.
			const expired = store.expireLiveTexts(new Set(), clock.value);
			const byId = new Map(expired.broadcasts.map((record) => [record.params.message_id, record.params as Record<string, unknown>]));
			// A terminal with no text left is a tombstone; the append keeps its text, without the embed.
			expect(byId.get(waiting.result.message_id)).toMatchObject({ deleted: true });
			expect(byId.get(lost.result.message_id)!.body).toEqual({ text: 'keep me', format: 'plain' });
			expect(store.claimLiveText(writeOf(waiting.result).write.key, clock.value)).toBeNull();
			expect(store.openLiveTexts(clock.value)).toEqual([]);
			expect(LIVE_ORPHAN_GRACE_MS).toBeGreaterThan(0);
		});
	});

	it('answers a retried post with its write until the write starts (§1.2)', async () => {
		await withStore('live-retry', { liveText: LIVE }, (store, clock) => {
			register(store, clock, 'rita');
			const send = () => store.commitMutation({ userId: 'rita', ipKey: 'ip-rita', requestId: 'retry-1', method: 'message', now: clock.value, params: { body: { embeds: [{ kind: 'terminal' }] } }, identity: { user_id: 'rita' } });
			const first = send();
			expect(send().result).toEqual(first.result);
			store.claimLiveText(writeOf(first.result).write.key, clock.value);
			expect(send().result).toEqual({ message_id: first.result.message_id, embeds: [{ embed_id: writeOf(first.result).embed_id, kind: 'terminal' }] });
		});
	});

	it('posts a command\'s message when its write arrives, and forgets one whose room or reply is gone', async () => {
		await withStore('live-command', { liveText: LIVE }, (store, clock) => {
			register(store, clock, 'cy');
			const parent = post(store, clock, 'cy', { body: { text: 'question' } });
			const entry = store.startLiveCommand({ userId: 'cy', ipKey: 'ip-cy', identity: { user_id: 'cy', name: 'Cy' }, kind: 'append', roomId: 'general', text: '**Answer:** ', replyTo: parent.result.message_id as string, now: clock.value });
			const claimed = store.claimLiveText(entry.key, clock.value)!;
			expect(claimed.message).toMatchObject({
				room_id: 'general', from: { user_id: 'cy', name: 'Cy' }, reply_to: { message_id: parent.result.message_id },
				body: { text: '**Answer:** ', format: 'markdown', embeds: [{ embed_id: entry.embedId, kind: 'append', url: `https://demo.test/live/${entry.id}` }] },
			});
			expect(claimed.broadcasts).toHaveLength(1);
			store.finishLiveText(entry.key, encode('42'), clock.value);
			// An unknown room or reply is refused at the command.
			expect(errorCode(() => store.startLiveCommand({ userId: 'cy', ipKey: 'ip-cy', identity: { user_id: 'cy' }, kind: 'terminal', roomId: 'nowhere', now: clock.value }))).toBe('invalid_params');
			expect(errorCode(() => store.startLiveCommand({ userId: 'cy', ipKey: 'ip-cy', identity: { user_id: 'cy' }, kind: 'terminal', roomId: 'general', replyTo: '1', now: clock.value }))).toBe('invalid_params');
		});
	});

	it('cuts a terminal\'s output further when its JSON would pass the record cap', async () => {
		await withStore('live-json', { liveText: LIVE }, (store, clock) => {
			register(store, clock, 'jo');
			const created = post(store, clock, 'jo', { body: { embeds: [{ kind: 'terminal' }] } });
			const key = writeOf(created.result).write.key;
			store.claimLiveText(key, clock.value);
			// 32 KB of escape characters is 192 KB of JSON.
			const finished = store.finishLiveText(key, new Uint8Array(LIVE.terminalKeepBytes).fill(0x1b), clock.value);
			const output = (bodyOf(finished).body!.embeds![0] as { output: string }).output;
			expect(new TextEncoder().encode(JSON.stringify(output)).length).toBeLessThanOrEqual(MAX_TERMINAL_OUTPUT_JSON_BYTES);
			expect(output.length).toBeGreaterThan(MAX_TERMINAL_OUTPUT_JSON_BYTES / 8);
		});
	});

	it('refuses new texts while turned off, and when the day\'s budget is spent', async () => {
		await withStore('live-off', { liveText: { ...LIVE, enabled: false } }, (store, clock) => {
			register(store, clock, 'off');
			expect(errorCode(() => post(store, clock, 'off', { body: { embeds: [{ kind: 'terminal' }] } }))).toBe('denied');
			store.setToggle('livetext', true, clock.value);
			expect(writeOf(post(store, clock, 'off', { body: { embeds: [{ kind: 'terminal' }] } }).result).kind).toBe('terminal');
		});
		await withStore('live-budget', { liveText: LIVE }, (store, clock, state) => {
			register(store, clock, 'broke');
			// The day's foreground writes are spent: a fresh instance reads the budget row.
			state.storage.sql.exec('UPDATE resource_budgets SET foreground_writes = ?, writes_reserved = ?', DEFAULT_LIMITS.foregroundWritesPerDay, DEFAULT_LIMITS.foregroundWritesPerDay);
			const fresh = new Store(state, { liveText: LIVE }, clock.clock);
			fresh.initialize();
			let error: unknown;
			try { fresh.startLiveCommand({ userId: 'broke', ipKey: 'ip-broke', identity: { user_id: 'broke' }, kind: 'terminal', roomId: 'general', now: clock.value }); }
			catch (caught) { error = caught; }
			expectRetryAfter(error);
			expect(error.data).toMatchObject({ reason: 'daily_budget' });
			try { fresh.commitMutation({ userId: 'broke', ipKey: 'ip-broke', method: 'message', now: clock.value, params: { body: { embeds: [{ kind: 'append' }] } }, identity: { user_id: 'broke' } }); error = undefined; }
			catch (caught) { error = caught; }
			expectRetryAfter(error);
		});
	});

	it('keeps texts as unknown kinds where live text is not configured', async () => {
		await withStore('live-none', {}, (store, clock) => {
			register(store, clock, 'old');
			const created = post(store, clock, 'old', { body: { embeds: [{ kind: 'terminal', url: 'https://example.com/t' }] } });
			expect(created.result.embeds).toBeUndefined();
			expect((created.message!.body!.embeds as Array<Record<string, unknown>>)[0]).toMatchObject({ kind: 'terminal', url: 'https://example.com/t' });
			expect(store.openLiveTexts(clock.value)).toEqual([] as LiveEntry[]);
		});
	});
});
