import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { connect, greeting, request, until, type Frame, type Peer } from './helpers/socket';
import { sqliteIn } from './helpers/store';
import { softPasskey } from './helpers/webauthn';

// A "typical usage" storage-cost profile: one realistic session driven
// through the protocol (WebSocket frames into the real Durable Object), with
// the SQLite rows each step read and wrote (Store.storageAccounting) and what
// its reservations charged. It prints one line, `COST_PROFILE_JSON {...}`,
// which scripts/cost-profile.mjs saves (`npm run cost:profile`, to
// docs/cost-profile.json) and checks against a saved profile
// (`npm run cost:check`). Step names are stable: a step is compared with the
// step of the same name in the baseline.
//
// The test itself fails when any step's rows read or written, or reserved,
// differ from docs/cost-profile.json, up or down: a change in cost is an
// explicit decision, made by regenerating the baseline and committing it,
// so it shows in review (docs/cost-report.md, Cost profile).
//
// The scenario uses only the protocol, so it runs unchanged on older and
// newer stores. Everything that reaches inside the object is in `adapter`
// below: port the profile to another version by changing only that.

// ---------------------------------------------------------------- adapter --

type Accounting = { reads: number; writes: number; reservedReads: number; reservedWrites: number };

const adapter = {
	stub: () => env.DEMO.getByName('public-demo-v1'),
	/** The store's cumulative SQLite rows and reservations (SqliteStore.storageAccounting, under the store's parts). */
	accounting(instance: unknown): Accounting {
		return sqliteIn(instance).storageAccounting();
	},
	/** Turns `activity` (typing, read cursors) on; vitest.config.ts leaves it off. New connections are offered it. */
	enableActivity(instance: unknown): void {
		const server = instance as { config: Record<string, unknown> };
		server.config = { ...server.config, activityEnabled: true };
	},
	/**
	 * Raises the per-minute posting limits on the store, so the scenario's
	 * ~60 posts in a few seconds are not refused. The limiter writes the same
	 * rows whatever the limit (only whether a charge is admitted changes).
	 */
	raisePostingLimits(instance: unknown): void {
		const config = sqliteIn(instance).config as unknown as Record<string, number>;
		for (const key of ['guestPostsPerMinute', 'registeredPostsPerMinute', 'trustedPostsPerMinute', 'ipPostsPerMinute', 'globalPostsPerMinute']) config[key] = 10_000;
	},
	/**
	 * Holds alarms the runtime fires on its own (a connection's sign-in
	 * deadline, presence), so none lands inside an unrelated step; the
	 * scenario runs the alarm itself, as its own steps. Returns the original.
	 */
	holdAlarms(instance: unknown, held: { count: number }): () => Promise<void> {
		const server = instance as { alarm(): Promise<void> };
		const original = server.alarm.bind(server);
		server.alarm = async () => { held.count += 1; };
		return original;
	},
	/** Makes the next alarm a full one (maintenance due now), as an hourly maintenance alarm is. */
	maintenanceDue(instance: unknown): void {
		(instance as { deadlines: { maintenance: { soonest(at: number): boolean } } }).deadlines.maintenance.soonest(Date.now() - 1);
	},
};

// --------------------------------------------------------------- scenario --

const ORIGIN = 'http://localhost:5173';
/** Fixed content sizes: every post's text is exactly this long. */
const TEXT_BYTES = 120;
const text = (label: string) => `${label} `.padEnd(TEXT_BYTES, 'x');

type Step = { step: string; reads: number; writes: number; reservedReads: number; reservedWrites: number; n?: number; skipped?: string };

const runtime = <T>(fn: (instance: unknown, state: DurableObjectState) => T | Promise<T>) => runInDurableObject(adapter.stub(), fn);
const read = () => runtime((instance) => adapter.accounting(instance));
const same = (a: Accounting, b: Accounting) => a.reads === b.reads && a.writes === b.writes && a.reservedReads === b.reservedReads && a.reservedWrites === b.reservedWrites;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The accounting once the object has stopped changing it: work a reply leaves behind (broadcasts, sign-in follow-ups) included. */
async function settled(): Promise<Accounting> {
	let last = await read();
	let quiet = 0;
	for (let round = 0; round < 80 && quiet < 3; round += 1) {
		await sleep(20);
		const next = await read();
		quiet = same(next, last) ? quiet + 1 : 0;
		last = next;
	}
	return last;
}

/** A peer's frames until one matches; frames already queued count. */
const awaitFrame = (peer: Peer, match: (frame: Frame) => boolean) => until(peer, match).then(({ frame }) => frame);

async function registerPasskey(peer: Peer, id: string, name: string) {
	const passkey = await softPasskey(ORIGIN);
	const begun = await request(peer, `${id}-begin`, 'auth', { scheme: 'webauthn', action: 'register', step: 'begin', name });
	expect(begun.error).toBeUndefined();
	const credential = await passkey.register(begun.result.public_key);
	const finished = await request(peer, `${id}-finish`, 'auth', { scheme: 'webauthn', action: 'register', step: 'finish', challenge_id: begun.result.challenge_id, credential });
	expect(finished.error).toBeUndefined();
	return { passkey, finished };
}

/** Waits out the last 90 seconds of a UTC day, so no step's limiter or budget rows roll over to a new day mid-run. */
async function awayFromMidnight(): Promise<void> {
	const left = 86_400_000 - (Date.now() % 86_400_000);
	if (left < 90_000) await sleep(left + 1_000);
}

it('profiles the storage cost of a typical session', async () => {
	await awayFromMidnight();
	const steps: Step[] = [];
	const held = { count: 0 };
	let alarm: () => Promise<void> = async () => undefined;
	// Waking the object constructs it and readies the schema: the profile's first step.
	const cold = await runtime((instance) => {
		alarm = adapter.holdAlarms(instance, held);
		adapter.enableActivity(instance);
		adapter.raisePostingLimits(instance);
		return adapter.accounting(instance);
	});
	steps.push({ step: 'object.wake (construct, schema ready)', ...pick(cold) });
	let before = await settled();

	async function step<T>(name: string, fn: () => Promise<T>, n?: number): Promise<T> {
		const result = await fn();
		const after = await settled();
		const row: Step = {
			step: name,
			reads: after.reads - before.reads,
			writes: after.writes - before.writes,
			reservedReads: after.reservedReads - before.reservedReads,
			reservedWrites: after.reservedWrites - before.reservedWrites,
			...(n ? { n } : {}),
		};
		steps.push(row);
		before = after;
		return result;
	}
	const skip = (name: string, reason: string) => steps.push({ step: name, reads: 0, writes: 0, reservedReads: 0, reservedWrites: 0, skipped: reason });

	const peers: Peer[] = [];
	const open = async (ip: string) => { const peer = await connect({ ip, origin: ORIGIN }); peers.push(peer); return peer; };
	let serverVersion = 'unknown';

	try {
		// Guests: the first visit, and a reconnect.
		let guest = await step('guest.connect (server greeting, welcome)', async () => {
			const peer = await open('198.51.100.10');
			const { welcome } = await greeting(peer);
			serverVersion = /Server version: `([^`]+)`/.exec(welcome.params.body.text)?.[1] ?? serverVersion;
			return peer;
		});
		await step('guest.auth', async () => {
			expect((await request(guest, 'guest', 'auth', { scheme: 'guest' })).result.you.user_id).toMatch(/^guest_/);
		});
		guest = await step('guest.reconnect (close, connect, auth)', async () => {
			guest.close();
			const peer = await open('198.51.100.10');
			await greeting(peer);
			expect((await request(peer, 'guest-again', 'auth', { scheme: 'guest' })).result.you.user_id).toMatch(/^guest_/);
			return peer;
		});

		// Accounts: the guest registers a passkey; another visitor registers on a new connection.
		const alice = guest;
		const registered = await step('passkey.register (guest becomes an account)', () => registerPasskey(alice, 'alice', 'Alice'));
		const aliceId: string = registered.finished.result.you.user_id;
		const token: string = registered.finished.result.token;
		const bob = await step('passkey.register (new connection)', async () => {
			const peer = await open('198.51.100.20');
			await greeting(peer);
			await registerPasskey(peer, 'bob', 'Bob');
			return peer;
		});
		const bobId: string = (await request(bob, 'bob-me', 'me', {})).result.you.user_id;
		const aliceLaptop = await step('passkey.login (new connection)', async () => {
			const peer = await open('198.51.100.11');
			await greeting(peer);
			const begun = await request(peer, 'login-begin', 'auth', { scheme: 'webauthn', action: 'login', step: 'begin' });
			const credential = await registered.passkey.assert(begun.result.public_key, 1);
			const finished = await request(peer, 'login-finish', 'auth', { scheme: 'webauthn', action: 'login', step: 'finish', challenge_id: begun.result.challenge_id, credential });
			expect(finished.result.you.user_id).toBe(aliceId);
			return peer;
		});
		const alicePhone = await step('token.resume (new connection)', async () => {
			const peer = await open('198.51.100.12');
			await greeting(peer);
			expect((await request(peer, 'resume', 'auth', { scheme: 'token', token })).result.you.user_id).toBe(aliceId);
			return peer;
		});

		// Rooms.
		await step('room_list (all)', async () => { expect((await request(alice, 'list', 'room_list', {})).error).toBeUndefined(); });

		// Posting: a warm-up post (the poster's day rows), then ten more.
		const post = async (peer: Peer, id: string, params: Record<string, unknown>) => {
			const reply = await request(peer, id, 'message', params);
			expect(reply.error).toBeUndefined();
			return reply.result.message_id as string;
		};
		await step('message.post (warm-up: first post of the day)', () => post(alice, 'warm', { room_id: 'general', body: { text: text('warm-up') } }));
		const posted = await step('message.post x10', async () => {
			const ids: string[] = [];
			for (let index = 0; index < 10; index += 1) ids.push(await post(alice, `post-${index}`, { room_id: 'general', body: { text: text(`post ${index}`) } }));
			return ids;
		}, 10);
		await step('message.post (second user, first post)', () => post(bob, 'bob-post', { room_id: 'general', body: { text: text('bob') } }));
		await step('message.reply (reply_to)', () => post(bob, 'reply', { room_id: 'general', body: { text: text('reply') }, reply_to: { message_id: posted[0] } }));
		await step('message.edit', () => post(alice, 'edit', { message_id: posted[1], room_id: 'general', body: { text: text('edited') } }));
		await step('reactions.add', async () => { expect((await request(bob, 'react', 'reactions', { message_id: posted[2], emojis: ['👍'] })).error).toBeUndefined(); });
		await step('reactions.remove', async () => { expect((await request(bob, 'unreact', 'reactions', { message_id: posted[2], emojis: [] })).error).toBeUndefined(); });
		await step('message.delete', async () => { expect((await request(alice, 'delete', 'message', { message_id: posted[3], room_id: 'general', deleted: true })).error).toBeUndefined(); });

		// Threads: create one, post in it, another user joins, leaves and rejoins.
		const threadId = await step('room_set (create thread)', async () => {
			const reply = await request(alice, 'thread', 'room_set', { parent_room_id: 'general', title: 'Thread title' });
			expect(reply.error).toBeUndefined();
			return reply.result.room_id as string;
		});
		await step('message.post (in thread)', () => post(alice, 'in-thread', { room_id: threadId, body: { text: text('thread') } }));
		await step('room_join (thread)', async () => { expect((await request(bob, 'join', 'room_join', { room_id: threadId })).error).toBeUndefined(); });
		await step('room_leave (thread)', async () => { expect((await request(bob, 'leave', 'room_leave', { room_id: threadId })).error).toBeUndefined(); });
		await step('room_join (thread, again)', async () => { expect((await request(bob, 'rejoin', 'room_join', { room_id: threadId })).error).toBeUndefined(); });

		// History: enough posts for a full page of 50, then the page, and a thread's.
		await step('message.post x40 (fill a history page)', async () => {
			for (let index = 0; index < 40; index += 1) await post(index % 2 ? bob : alice, `fill-${index}`, { room_id: 'general', body: { text: text(`fill ${index}`) } });
		}, 40);
		await step('history (general, limit 50)', async () => {
			const page = await request(bob, 'history', 'history', { room_id: 'general', limit: 50 });
			expect(page.error).toBeUndefined();
			// A full page: 50 records (messages, and the memberships and reaction sets among them).
			expect(page.result.messages.length).toBeGreaterThan(40);
		});
		await step('history (thread, limit 50)', async () => { expect((await request(bob, 'history-thread', 'history', { room_id: threadId, limit: 50 })).error).toBeUndefined(); });
		await step('room_list (joined)', async () => { expect((await request(bob, 'joined', 'room_list', { filter: 'joined' })).error).toBeUndefined(); });
		await step('room_list (general, members)', async () => { expect((await request(bob, 'members', 'room_list', { room_id: 'general', members: true })).error).toBeUndefined(); });

		// Activity: a read cursor (the first is written at once, the next held), typing.
		const last = posted[9];
		await step('activity.read_cursor (first: written)', async () => {
			alice.send({ method: 'activity', params: { room_id: 'general', read_message_id: posted[8] } });
			await awaitFrame(aliceLaptop, (frame) => frame.method === 'activity' && frame.params?.read_message_id === posted[8]);
		});
		await step('activity.read_cursor (again: held)', async () => {
			alice.send({ method: 'activity', params: { room_id: 'general', read_message_id: last } });
			await awaitFrame(aliceLaptop, (frame) => frame.method === 'activity' && frame.params?.read_message_id === last);
		});
		await step('activity.typing', async () => {
			alice.send({ method: 'activity', params: { room_id: 'general', typing: 5 } });
			await awaitFrame(bob, (frame) => frame.method === 'activity' && frame.params?.typing !== undefined && frame.params?.from?.user_id === aliceId);
		});

		// Status and profile.
		await step('me.status (dnd)', async () => { expect((await request(alice, 'dnd', 'me', { status: 'dnd' })).error).toBeUndefined(); });
		await step('me.status (online)', async () => { expect((await request(alice, 'online', 'me', { status: 'online' })).error).toBeUndefined(); });
		await step('me.name', async () => { expect((await request(alice, 'name', 'me', { name: 'Alice A.' })).error).toBeUndefined(); });
		await step('command (/help)', async () => { expect((await request(alice, 'help', 'command', { room_id: 'general', body: { text: '/help' } })).error).toBeUndefined(); });

		// A private room: create, add the other user, post.
		const privateId = await step('room_set (create private room)', async () => {
			const reply = await request(alice, 'private', 'room_set', { title: 'Private title', private: true });
			return reply.error ? undefined : reply.result.room_id as string;
		});
		if (privateId) {
			await step('room_join (add a member to the private room)', async () => { expect((await request(alice, 'add', 'room_join', { room_id: privateId, user_id: bobId })).error).toBeUndefined(); });
			await step('message.post (in private room)', () => post(bob, 'in-private', { room_id: privateId, body: { text: text('private') } }));
		} else {
			skip('room_join (add a member to the private room)', 'no private rooms');
			skip('message.post (in private room)', 'no private rooms');
		}

		// Idle: connections open, nobody sends anything.
		await step('idle (1.5 s, all connections open)', () => sleep(1_500));

		// The alarm: as it comes, then a full maintenance pass with this data.
		await step('alarm (as scheduled)', () => runtime(() => alarm()));
		await step('alarm (full: maintenance due)', () => runtime((instance) => { adapter.maintenanceDue(instance); return alarm(); }));
		await step('alarm (again: nothing due)', () => runtime(() => alarm()));

		// Leaving: every connection closes.
		await step('disconnect (all connections close)', async () => {
			for (const peer of peers) peer.close();
			await sleep(100);
		});
	} finally {
		for (const peer of peers) peer.close();
	}

	console.log(`COST_PROFILE_JSON ${JSON.stringify({ version: serverVersion, heldAlarms: held.count, steps })}`);
	// Every step's rows stay within what its reservations charged.
	for (const row of steps) {
		expect.soft(row.reads, `${row.step}: reads within reserved`).toBeLessThanOrEqual(row.reservedReads);
		expect.soft(row.writes, `${row.step}: writes within reserved`).toBeLessThanOrEqual(row.reservedWrites);
	}
	// And every step costs exactly what the committed baseline says: a cost
	// that changes, up or down, is a decision, made by regenerating the
	// baseline (`npm run cost:profile`) so the change shows in review.
	expect(costChanges(steps), 'storage costs differ from docs/cost-profile.json; if intended, run `npm run cost:profile` and commit it').toEqual([]);
}, 120_000);

function pick(accounting: Accounting): Omit<Step, 'step'> {
	return { reads: accounting.reads, writes: accounting.writes, reservedReads: accounting.reservedReads, reservedWrites: accounting.reservedWrites };
}

const BASELINE = Object.values(import.meta.glob('../docs/cost-profile.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)[0];

/** Each step whose cost differs from the baseline's, or that only one of them has: `step: field baseline → now`. */
function costChanges(steps: Step[]): string[] {
	if (!BASELINE) return ['docs/cost-profile.json is missing'];
	const baseline = new Map((JSON.parse(BASELINE) as { steps: Step[] }).steps.map((row) => [row.step, row]));
	const changes: string[] = [];
	for (const row of steps) {
		const was = baseline.get(row.step);
		baseline.delete(row.step);
		if (!was) { changes.push(`${row.step}: new step`); continue; }
		for (const field of ['reads', 'writes', 'reservedReads', 'reservedWrites'] as const) {
			if (row[field] !== was[field]) changes.push(`${row.step}: ${field} ${was[field]} → ${row[field]}`);
		}
	}
	for (const step of baseline.keys()) changes.push(`${step}: no longer measured`);
	return changes;
}
