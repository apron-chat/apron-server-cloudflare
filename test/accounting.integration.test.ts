import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MAX_ROOM_MUTES_PER_USER, MUTE_FOREVER, Store, StoreError, WAKE_SCOPES, defaultStoreConfig } from '../src/store';
import { DEFAULT_LIMITS, PUSH_POLICY } from '../src/budget';
import { expectRetryAfter, messagesOf } from './helpers/store';

// A day's retention with hourly cleanup, for tests that watch records expire.
const ONE_DAY_RETENTION = { retentionMs: 86_400_000, cleanupIntervalMs: 3_600_000 };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

class FakeClock {
	private value: number;

	constructor(value: number) {
		this.value = value;
	}

	now(): number {
		return this.value;
	}

	set(value: number): void {
		this.value = value;
	}
}

function futureUtcNoon(): number {
	// The DO constructor has already recorded the real clock.  Start the fake
	// clock two UTC days ahead so the monotonic effective clock never moves
	// backwards, even when a test starts late in the current day.
	return (Math.floor(Date.now() / DAY) + 2) * DAY + 12 * HOUR;
}

function messageInput(
	clock: FakeClock,
	userId: string,
	text: string,
	requestId?: string,
	messageId?: string,
	extensions: Record<string, unknown> = {},
) {
	return {
		userId,
		ipKey: 'audit-ip',
		...(requestId ? { requestId } : {}),
		method: 'message' as const,
		now: clock.now(),
		params: {
			room_id: 'general',
			...extensions,
			...(messageId ? { message_id: messageId } : {}),
			body: { text, format: 'plain' },
		},
		identity: { user_id: userId, name: 'Accounting audit' },
	};
}

type Accounting = ReturnType<Store['storageAccounting']>;
type Budget = ReturnType<Store['budget']>;

function diffAccounting(after: Accounting, before: Accounting) {
	return {
		reads: after.reads - before.reads,
		writes: after.writes - before.writes,
		operations: after.operations - before.operations,
	};
}

function diffBudget(after: Budget, before: Budget) {
	return {
		reads: after.reads - before.reads,
		writes: after.writes - before.writes,
		foregroundReads: after.foreground_reads - before.foreground_reads,
		foregroundWrites: after.foreground_writes - before.foreground_writes,
		maintenanceReads: after.maintenance_reads - before.maintenance_reads,
		maintenanceWrites: after.maintenance_writes - before.maintenance_writes,
		posts: after.posts - before.posts,
	};
}

type Snapshot = { budget: Budget; accounting: Accounting };
type Cost = { observed: ReturnType<typeof diffAccounting>; reserved: ReturnType<typeof diffBudget> };

/** The budget and accounting counters before an operation (see {@link costSince}). */
function snapshot(store: Store): Snapshot {
	return { budget: store.budget(), accounting: store.storageAccounting() };
}

/**
 * What the store did and reserved since `before`. Unused reservations are
 * refunded into later budget-row updates, so the rows and columns counted per
 * operation come from the store's reservation tally; quota counters still come
 * from the day row.
 */
function costSince(store: Store, before: Snapshot): Cost {
	const accounting = store.storageAccounting();
	return {
		observed: diffAccounting(accounting, before.accounting),
		reserved: {
			...diffBudget(store.budget(), before.budget),
			reads: accounting.reservedReads - before.accounting.reservedReads,
			writes: accounting.reservedWrites - before.accounting.reservedWrites,
		},
	};
}

function withinReserve({ observed, reserved }: Cost): boolean {
	return observed.reads <= reserved.reads && observed.writes <= reserved.writes;
}

function expectWithinReserve(cost: Cost): void {
	expect(cost.observed.reads).toBeLessThanOrEqual(cost.reserved.reads);
	expect(cost.observed.writes).toBeLessThanOrEqual(cost.reserved.writes);
}

type CostEntry = Cost & { label: string; withinReserve: boolean; error?: string };

/** Records the cost of each labelled operation into `costs`. */
function costLog(store: Store) {
	const costs: CostEntry[] = [];
	const record = (label: string, before: Snapshot, extra: { error?: string } = {}) => {
		const cost = costSince(store, before);
		costs.push({ label, ...cost, ...extra, withinReserve: withinReserve(cost) });
	};
	return {
		costs,
		measure<T>(label: string, callback: () => T): T {
			const before = snapshot(store);
			const value = callback();
			record(label, before);
			return value;
		},
		async measureAsync<T>(label: string, callback: () => Promise<T>): Promise<T> {
			const before = snapshot(store);
			const value = await callback();
			record(label, before);
			return value;
		},
		measureFailure(label: string, callback: () => unknown): unknown {
			const before = snapshot(store);
			let error: unknown;
			try { callback(); } catch (candidate) { error = candidate; }
			record(label, before, { error: error instanceof StoreError ? error.code : 'none' });
			return error;
		},
	};
}

function explain(sql: any, query: string, ...bindings: unknown[]) {
	const cursor = sql.exec(query, ...bindings) as { toArray(): Array<{ detail: string }> };
	return cursor.toArray().map((row: { detail: string }) => row.detail);
}

describe('measured storage accounting', () => {
	it('measures three UTC days of traffic, retention cleanup, and reserved versus observed work', async () => {
		const stub = env.DEMO.getByName('accounting-three-days-v1');
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, defaultStoreConfig(ONE_DAY_RETENTION), clock);
			store.initialize();
			const base = clock.now();
			const { costs: operationCosts, measure } = costLog(store);

			const first = measure('day-0 create', () => store.commitMutation(messageInput(clock, 'audit-user', 'day zero', 'day-0')));
			const firstMessageId = first.result.message_id as string | undefined;
			expect(firstMessageId).toBeTruthy();

			clock.set(clock.now() + DAY + 2 * HOUR);
			measure('day-1 create', () => store.commitMutation(messageInput(clock, 'audit-user', 'day one', 'day-1')));

			clock.set(clock.now() + DAY);
			measure('day-2 edit retained message', () => store.commitMutation(messageInput(clock, 'audit-user', 'edited after original expiry', 'day-2-edit', firstMessageId)));
			measure('day-2 create', () => store.commitMutation(messageInput(clock, 'audit-user', 'day two', 'day-2')));

			clock.set(clock.now() + 11 * HOUR);
			const cleanup = measure('cleanup', () => store.runCleanup(clock.now()));
			const history = measure('history after cleanup', () => store.historyPage({ roomId: 'general', limit: 50, now: clock.now() }));
			const room = store.getRoomState();
			const observed = store.storageAccounting();
			const budget = store.budget();
			const size = store.databaseSize();

			// The seeded general room record, the day-0 create, and the day-1
			// create expire; the day-0 message survives through its day-2 edit.
			expect(cleanup.deleted_records).toBe(3);
			expect(cleanup.deleted_messages).toBe(1);
			// The retained message and day-2 create, after the `~room` expiry notice.
			expect(messagesOf(history)).toHaveLength(3);
			expect(messagesOf(history)[0]).toMatchObject({ message_id: history.history_log_id, from: { user_id: '~room' } });
			expect(messagesOf(history).some((entry) => entry.message_id === firstMessageId)).toBe(true);
			expect(messagesOf(history).every((entry) => BigInt(entry.log_id) >= BigInt(history.history_log_id!))).toBe(true);
			expect(room.history_log_id).toBe(cleanup.history_floor);
			expect(history.latest_log_id).toBe(room.latest_log_id);
			expect(BigInt(room.latest_log_id)).toBeGreaterThanOrEqual(BigInt(room.history_log_id!));

			return {
				base,
				cleanup,
				history: { floor: history.history_log_id, messages: messagesOf(history).map((entry) => ({ log_id: entry.log_id, message_id: entry.message_id })) },
				operationCosts,
				budget,
				observed,
				databaseSize: size,
			};
		});
		console.info('accounting-three-days', JSON.stringify(result));
		for (const operation of result.operationCosts) {
			expect(operation.withinReserve, `${operation.label} exceeded its reserved rows`).toBe(true);
		}
	});

	it('credits back the unused part of a finished reservation', async () => {
		const stub = env.DEMO.getByName('accounting-refund-v1');
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, defaultStoreConfig(), clock);
			store.initialize();
			store.commitMutation(messageInput(clock, 'refund-user', 'warm up', 'warm'));
			const before = snapshot(store);
			store.commitMutation(messageInput(clock, 'refund-user', 'refunded', 'refund'));
			const { observed, reserved } = costSince(store, before);
			return {
				reserved: reserved.writes,
				observed: observed.writes,
				charged: reserved.foregroundWrites,
				chargedReads: reserved.foregroundReads,
				observedReads: observed.reads,
			};
		});
		// The mutation reserved far more than it wrote; the day is charged what it
		// wrote, and the credit's own row update is paid from the reservation.
		expect(result.reserved).toBeGreaterThan(2 * result.observed);
		expect(result.charged).toBeGreaterThanOrEqual(result.observed - 1);
		expect(result.charged).toBeLessThanOrEqual(result.observed + 1);
		expect(result.chargedReads).toBeLessThanOrEqual(result.observedReads + 1);
	});

	it('charges rejected quota work and stops repeated denial before more SQL work', async () => {
		const stub = env.DEMO.getByName('accounting-rejections-v1');
		const config = defaultStoreConfig({
			anonymousPostsPerMinute: 1,
			anonymousPostsPerDay: 100,
			ipPostsPerMinute: 1,
			ipPostsPerDay: 100,
			globalPostsPerMinute: 100,
			globalPostsPerDay: 100,
			// Deliberately small explicit exhaustion ceiling. The test drains the
			// bounded request-ID lookup allowance instead of assuming a fixed
			// mutation reservation amount.
			foregroundReadsPerDay: 1_000,
			foregroundWritesPerDay: 1_000,
		});
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, config, clock);
			store.initialize();
			const accepted = store.commitMutation(messageInput(clock, 'reject-user', 'accepted', 'accepted'));
			const afterAccepted = snapshot(store);

			let quotaError: unknown;
			try {
				store.commitMutation(messageInput(clock, 'reject-user', 'rejected by post quota', 'rejected'));
			} catch (error) {
				quotaError = error;
			}
			expectRetryAfter(quotaError);
			const { observed: rejectedObserved, reserved: rejectedReserved } = costSince(store, afterAccepted);
			// Depending on which bounded admission check rejects the request, the
			// request may have paid either the duplicate lookup or the full
			// mutation reservation. In both cases the charged work stays bounded.
			expect(rejectedReserved.posts).toBeLessThanOrEqual(1);
			expect(rejectedObserved.reads).toBeGreaterThan(0);
			expect(rejectedObserved.writes).toBeGreaterThan(0);
			expect(rejectedObserved.reads).toBeLessThanOrEqual(rejectedReserved.reads);
			expect(rejectedObserved.writes).toBeLessThanOrEqual(rejectedReserved.writes);

			let previousCapacityAccounting = store.storageAccounting();
			let reachedStableDenial = false;
			// Rejected attempts are charged only what they read and wrote, so
			// draining the small ceiling takes more of them.
			for (let attempt = 0; attempt < 400; attempt += 1) {
				let capacityError: unknown;
				try {
					store.commitMutation(messageInput(clock, 'reject-user', 'capacity stop', `capacity-${attempt}`));
				} catch (error) {
					capacityError = error;
				}
				expectRetryAfter(capacityError);
				const currentAccounting = store.storageAccounting();
				if (currentAccounting.reads === previousCapacityAccounting.reads &&
					currentAccounting.writes === previousCapacityAccounting.writes &&
					currentAccounting.operations === previousCapacityAccounting.operations) {
					reachedStableDenial = true;
					break;
				}
				previousCapacityAccounting = currentAccounting;
			}
			expect(reachedStableDenial).toBe(true);

			const transitions = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM records WHERE kind = 'message'").one().count;
			return {
				accepted: accepted.result,
				acceptedAccounting: afterAccepted.accounting,
				rejectedObserved,
				rejectedReserved,
				budget: store.budget(),
				transitionCount: Number(transitions),
			};
		});
		console.info('accounting-rejections', JSON.stringify(result));
		expect(result.transitionCount).toBe(1);
	});

	it('preserves limiter state across object eviction and does not rewrite schema on reinitialization', async () => {
		const stub = env.DEMO.getByName('accounting-persistence-v1');
		const config = defaultStoreConfig({
			anonymousPostsPerMinute: 100,
			anonymousPostsPerDay: 1,
			ipPostsPerMinute: 100,
			ipPostsPerDay: 100,
			globalPostsPerMinute: 100,
			globalPostsPerDay: 100,
		});
		const clockValue = futureUtcNoon();
		const first = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(clockValue);
			const store = new Store(state, config, clock);
			store.initialize();
			store.commitMutation(messageInput(clock, 'persistent-user', 'only daily post', 'persistent'));
			const limits = state.storage.sql.exec('SELECT scope, principal_key, post_events_json, day, posts_day FROM principal_limits').toArray();
			return { size: store.databaseSize(), budget: store.budget(), limits };
		});
		await evictDurableObject(stub);
		const second = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(clockValue);
			const store = new Store(state, config, clock);
			store.initialize();
			const afterInit = store.storageAccounting();
			expect(afterInit.writes).toBe(0);
			let error: unknown;
			try {
				store.commitMutation(messageInput(clock, 'persistent-user', 'must remain limited', 'persistent-retry'));
			} catch (candidate) {
				error = candidate;
			}
			expectRetryAfter(error);
			const limits = state.storage.sql.exec('SELECT scope, principal_key, post_events_json, day, posts_day FROM principal_limits').toArray();
			const transitions = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM records WHERE kind = 'message'").one().count;
			return { afterInit, budget: store.budget(), size: store.databaseSize(), limits, transitions: Number(transitions) };
		});
		console.info('accounting-persistence', JSON.stringify({ first, second }));
		expect(second.budget.posts).toBe(first.budget.posts + 1);
		expect(second.limits).toEqual(first.limits);
		expect(second.transitions).toBe(1);
		expect(second.size).toBe(first.size);
	});

	it('measures room listing costs at the 100-thread policy ceiling with descriptions', async () => {
		const stub = env.DEMO.getByName('accounting-room-list-v2');
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, defaultStoreConfig({ push: { ...PUSH_POLICY! } }), clock);
			store.initialize();
			state.storage.transactionSync(() => {
				for (let index = 1; index <= 100; index += 1) {
					state.storage.sql.exec(
						`INSERT INTO rooms (room_id, parent_room_id, created_log_id, record_log_id, latest_log_id, fields_json, created_ms, updated_ms)
						 VALUES (?, 'general', ?, ?, ?, ?, ?, ?)`,
						`thread-${index}`, clock.now() + 1_000 + index, clock.now() + 1_000 + index, clock.now() + 1_000 + index,
						JSON.stringify({ title: `Thread ${index}`, description: `description ${index}` }), clock.now(), clock.now(),
					);
				}
			});

			const beforeListing = snapshot(store);
			const rooms = store.listRooms(clock.now());
			const listing = costSince(store, beforeListing);
			expect(rooms).toHaveLength(101);
			expect(rooms[0].room_id).toBe('general');
			expect(rooms[1].description).toBe('description 1');
			expectWithinReserve(listing);

			// A registration that starts in 100 rooms (a guest's, carried over)
			// stores and logs a membership in each.
			const beforeRegistration = snapshot(store);
			const registered = store.registerIdentity({
				userId: 'lister', name: 'Lister', userHandle: 'lister-handle', now: clock.now(), ipKey: 'lister-ip',
				credential: { credentialId: 'lister-credential', userId: 'lister', publicKey: 'key', counter: 0 },
				rooms: ['general', ...Array.from({ length: 99 }, (_, index) => `thread-${index + 1}`), 'expired-thread'],
			});
			const registration = costSince(store, beforeRegistration);
			expect(registered.broadcasts).toHaveLength(100);
			expectWithinReserve(registration);
			const beforeJoin = snapshot(store);
			const joined = store.changeMembership({ userId: 'lister', ipKey: 'lister-ip', roomId: 'thread-100', join: true, now: clock.now() });
			const join = costSince(store, beforeJoin);
			expect(joined.rooms).toHaveLength(101);
			expect(joined.rooms).not.toContain('expired-thread');
			expectWithinReserve(join);

			// Members of every room at the listing cap: roomListMembers registered
			// members in each of the 101 rooms, read by primary-key range with a
			// name lookup each.
			state.storage.transactionSync(() => {
				for (let index = 1; index <= DEFAULT_LIMITS.roomListMembers; index += 1) {
					state.storage.sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms) VALUES (?, ?, ?, 'registered', 0, 0)", `member-${index}`, `member-handle-${index}`, `Member ${index}`);
					for (const room of rooms) state.storage.sql.exec('INSERT OR IGNORE INTO memberships (room_id, user_id) VALUES (?, ?)', room.room_id, `member-${index}`);
				}
			});
			const beforeMembers = snapshot(store);
			const members = store.roomMembers(rooms.map((room) => room.room_id), DEFAULT_LIMITS.roomListMembers, clock.now());
			const memberListing = costSince(store, beforeMembers);
			expect([...members.values()].every((list) => list.length === DEFAULT_LIMITS.roomListMembers)).toBe(true);
			expectWithinReserve(memberListing);
			// With status, at its worst: every member has a `user_status` row (a
			// chosen status and a mute), with as many registrations and room mutes
			// as a user may hold, which a listing does not read.
			state.storage.transactionSync(() => {
				for (let index = 1; index <= DEFAULT_LIMITS.roomListMembers; index += 1) {
					state.storage.sql.exec("INSERT INTO user_status (user_id, status, mute_until_ms) VALUES (?, 'dnd', ?)", `member-${index}`, clock.now() + HOUR);
					for (let registration = 0; registration < PUSH_POLICY!.subscriptionsPerUser; registration += 1) {
						state.storage.sql.exec(
							'INSERT INTO push_subscriptions (user_id, url, p256dh, auth, wake, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
							`member-${index}`, `https://push.example.net/member-${index}/${registration}`, 'p', 'a', registration === 0 ? 3 : 0, clock.now() - registration, clock.now() - registration,
						);
					}
					for (const room of rooms) state.storage.sql.exec('INSERT INTO room_mutes (user_id, room_id, mute_until_ms) VALUES (?, ?, ?)', `member-${index}`, room.room_id, clock.now() + HOUR);
				}
			});
			const beforeStatus = snapshot(store);
			const withStatus = store.roomMembers(rooms.map((room) => room.room_id), DEFAULT_LIMITS.roomListMembers, clock.now(), undefined, true);
			const statusListing = costSince(store, beforeStatus);
			expect(withStatus.get('general')?.find((member) => member.user_id === 'member-1')?.choice).toBe('dnd');
			expectWithinReserve(statusListing);
			expect(store.accountingStatus().unsafe).toBe(false);
			return { rooms: rooms.length, ...listing, registration, join, memberListing, statusListing };
		});
		console.info('accounting-room-list', JSON.stringify(result));
	});

	it('measures member listings with status by population, and reuses a listing until a write', async () => {
		const stub = env.DEMO.getByName('accounting-member-status-v1');
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, defaultStoreConfig({ push: { ...PUSH_POLICY! }, memberCacheMs: MINUTE }), clock);
			store.initialize();
			const members = DEFAULT_LIMITS.roomListMembers;
			// Four rooms of `members` registered members each: none with status
			// state; each with two live waking registrations and a room mute
			// (neither read by a listing); a mix (a third with push, a tenth
			// muted, one in thirty invisible, one in fifty with no status); and
			// the worst case, every member with a chosen status and a mute and a
			// full set of registrations.
			const populations = ['none', 'push', 'mixed', 'worst'] as const;
			state.storage.transactionSync(() => {
				for (const population of populations) {
					for (let index = 0; index < members; index += 1) {
						const userId = `${population}-${String(index).padStart(3, '0')}`;
						state.storage.sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms) VALUES (?, ?, ?, 'registered', 0, 0)", userId, `handle-${userId}`, userId);
						state.storage.sql.exec('INSERT INTO memberships (room_id, user_id) VALUES (?, ?)', population, userId);
						const register = (count: number, wake: (registration: number) => number) => {
							for (let registration = 0; registration < count; registration += 1) {
								state.storage.sql.exec(
									'INSERT INTO push_subscriptions (user_id, url, p256dh, auth, wake, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
									userId, `https://push.example.net/${userId}/${registration}`, 'p', 'a', wake(registration), clock.now() - registration, clock.now() - registration,
								);
							}
						};
						if (population === 'push') {
							register(2, () => 3);
							state.storage.sql.exec('INSERT INTO room_mutes (user_id, room_id, mute_until_ms) VALUES (?, ?, ?)', userId, population, clock.now() + HOUR);
						}
						if (population === 'mixed' && index % 3 === 0) register(2, () => 3);
						if (population === 'mixed' && (index % 10 === 0 || index % 30 === 1 || index % 50 === 7)) {
							const status = index % 30 === 1 ? 'invisible' : index % 50 === 7 ? '' : 'online';
							state.storage.sql.exec('INSERT INTO user_status (user_id, status, mute_until_ms) VALUES (?, ?, ?)', userId, status, index % 10 === 0 ? clock.now() + HOUR : null);
						}
						if (population === 'worst') {
							state.storage.sql.exec("INSERT INTO user_status (user_id, status, mute_until_ms) VALUES (?, 'dnd', ?)", userId, clock.now() + HOUR);
							register(PUSH_POLICY!.subscriptionsPerUser, (registration) => registration === 0 ? 3 : 0);
						}
					}
				}
			});
			// Rows written behind the store's back: start from nothing kept.
			(store as unknown as { memberCache: Map<string, unknown> }).memberCache.clear();
			const listing: Record<string, { plain: Cost; status: Cost; perMember: number }> = {};
			for (const population of populations) {
				(store as unknown as { memberCache: Map<string, unknown> }).memberCache.clear();
				const beforePlain = snapshot(store);
				store.roomMembers([population], members, clock.now());
				const plain = costSince(store, beforePlain);
				(store as unknown as { memberCache: Map<string, unknown> }).memberCache.clear();
				const beforeStatus = snapshot(store);
				store.roomMembers([population], members, clock.now(), undefined, true);
				const status = costSince(store, beforeStatus);
				expectWithinReserve(plain);
				expectWithinReserve(status);
				listing[population] = { plain, status, perMember: (status.observed.reads - plain.observed.reads) / members };
			}
			// Status adds nothing for members without a `user_status` row, whatever
			// else they hold, and one read at worst, against the two each costs already.
			expect(listing.none.perMember).toBeLessThanOrEqual(0.05);
			expect(listing.push.perMember).toBeLessThanOrEqual(0.05);
			expect(listing.worst.perMember).toBeLessThanOrEqual(1.05);

			// A listing again within memberCacheMs reads nothing and reserves nothing.
			store.roomMembers(['mixed'], members, clock.now(), undefined, true);
			const beforeReuse = snapshot(store);
			const reused = store.roomMembers(['mixed'], members, clock.now(), undefined, true);
			const reuse = costSince(store, beforeReuse);
			expect(reuse.observed).toEqual({ reads: 0, writes: 0, operations: 0 });
			expect(reuse.reserved.reads).toBe(0);
			// Each member carries the status they chose: `online` without a row.
			const chosen = (userId: string) => reused.get('mixed')!.find((member) => member.user_id === userId)!.choice;
			expect([chosen('mixed-000'), chosen('mixed-001'), chosen('mixed-002'), chosen('mixed-007')]).toEqual(['online', 'invisible', 'online', '']);
			// Without status, a different listing.
			const beforePlainAgain = snapshot(store);
			store.roomMembers(['mixed'], members, clock.now(), undefined, false);
			expect(costSince(store, beforePlainAgain).observed.reads).toBeGreaterThan(0);
			// Any write to what a listing read ends the reuse.
			store.registerIdentity({
				userId: 'writer', name: 'Writer', userHandle: 'writer-handle', now: clock.now(), ipKey: 'writer-ip',
				credential: { credentialId: 'writer-credential', userId: 'writer', publicKey: 'key', counter: 0 },
			});
			const beforeWrite = snapshot(store);
			store.roomMembers(['mixed'], members, clock.now(), undefined, true);
			const afterWrite = costSince(store, beforeWrite);
			expect(afterWrite.observed.reads).toBeGreaterThan(2 * members);
			// And so does time: past memberCacheMs it is read again.
			const beforeExpiry = snapshot(store);
			store.roomMembers(['mixed'], members, clock.now() + MINUTE, undefined, true);
			expect(costSince(store, beforeExpiry).observed.reads).toBeGreaterThan(2 * members);
			expect(store.accountingStatus().unsafe).toBe(false);
			return { listing, reuse };
		});
		console.info('accounting-member-status', JSON.stringify(result));
	});

	it('keeps a 50-record history page across record kinds within its reservation', async () => {
		const stub = env.DEMO.getByName('accounting-history-cardinality-v2');
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, defaultStoreConfig(), clock);
			store.initialize();
			const totalRows = 180;
			const kinds = ['message', 'reactions', 'room'] as const;
			state.storage.transactionSync(() => {
				state.storage.sql.exec('DELETE FROM records');
				for (let index = 1; index <= totalRows; index += 1) {
					const kind = kinds[index % 3];
					const record = kind === 'room'
						? { room_id: 'general', log_id: `${index}`, title: `General ${index}` }
						: kind === 'reactions'
							? { log_id: `${index}`, message_id: '3', room_id: 'general', reactions: [{ from: { user_id: 'reactor' }, emojis: ['👍'] }] }
							: { message_id: `${index}`, log_id: `${index}`, room_id: 'general', from: { user_id: 'history-user' }, body: { text: `history ${index}`, format: 'plain', embeds: [] } };
					state.storage.sql.exec(
						'INSERT INTO records (room_id, log_id, commit_ms, kind, record_json) VALUES (?, ?, ?, ?, ?)',
						'general', index, clock.now() + index, kind, JSON.stringify(record),
					);
				}
				state.storage.sql.exec('UPDATE rooms SET created_log_id = 1, record_log_id = 1, latest_log_id = ? WHERE room_id = ?', totalRows, 'general');
				state.storage.sql.exec('UPDATE log_state SET last_log_id = ?, history_floor = 1, last_commit_ms = ?', totalRows, clock.now() + totalRows);
			});

			const before = snapshot(store);
			const page = store.historyPage({ roomId: 'general', after: '0', limit: 50, now: clock.now() });
			const cost = costSince(store, before);
			expect((page.rooms?.length ?? 0) + messagesOf(page).length + (page.reactions?.length ?? 0)).toBe(50);
			expect(page.rooms).toHaveLength(17);
			expect(page.reactions).toHaveLength(17);
			expect(messagesOf(page)).toHaveLength(16);
			expect(page.more).toBe(true);
			expect(page.first_log_id).toBe('1');
			expect(page.last_log_id).toBe('50');
			expectWithinReserve(cost);
			return { ...cost, first: page.first_log_id, last: page.last_log_id, more: page.more };
		});
		console.info('accounting-history-cardinality', JSON.stringify(result));
	});

	it('calibrates a move that re-logs the maximum reaction sets', async () => {
		const stub = env.DEMO.getByName('accounting-move-reactions-v1');
		const config = defaultStoreConfig({
			// The calibrated per-message and per-user ceilings, not the defaults.
			reactionUsersPerMessage: 64,
			reactionEmojisPerUser: 16,
			anonymousPostsPerMinute: 1_000,
			ipPostsPerMinute: 1_000,
			globalPostsPerMinute: 1_000,
		});
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, config, clock);
			store.initialize();
			const identity = (userId: string) => ({ user_id: userId, name: 'n'.repeat(config.maxNameBytes) });
			const created = store.commitMutation({
				userId: 'mover', ipKey: 'move-ip', requestId: 'target', method: 'message', now: clock.now(),
				params: { room_id: 'general', body: { text: 'moving' } }, identity: identity('mover'),
			});
			const messageId = created.result.message_id;
			// Sixteen distinct 64-byte emoji strings per user.
			const emojis = Array.from({ length: 16 }, (_, index) => `${String.fromCodePoint(0x1F600 + index)}${'x'.repeat(60)}`);
			let reactionCost: Cost | undefined;
			for (let index = 0; index < 64; index += 1) {
				const before = snapshot(store);
				store.commitMutation({
					userId: `reactor-${index}`, ipKey: `react-ip-${index}`, requestId: `react-${index}`, method: 'reactions', now: clock.now(),
					params: { message_id: messageId, emojis }, identity: identity(`reactor-${index}`),
				});
				const cost = costSince(store, before);
				expectWithinReserve(cost);
				if (!reactionCost || cost.observed.writes >= reactionCost.observed.writes) reactionCost = cost;
			}
			const thread = store.commitMutation({
				userId: 'mover', ipKey: 'move-ip', requestId: 'thread', method: 'room_set', now: clock.now(),
				params: { parent_room_id: 'general', title: 'Destination' }, identity: identity('mover'),
			});
			const beforeMove = snapshot(store);
			const moved = store.commitMutation({
				userId: 'mover', ipKey: 'move-ip', requestId: 'move', method: 'message', now: clock.now(),
				params: { message_id: messageId, room_id: thread.result.room_id, body: { text: 'moved' } }, identity: identity('mover'),
			});
			const move = costSince(store, beforeMove);
			expect(moved.broadcasts.map((record) => record.method)).toEqual(['message', 'reactions']);
			expect((moved.broadcasts[1].params.reactions as unknown[]).length).toBe(64);
			const recordBytes = new TextEncoder().encode(JSON.stringify(moved.broadcasts[1].params)).byteLength;
			expectWithinReserve(move);
			// The re-logged record still fits one history response.
			const page = store.historyPage({ roomId: String(thread.result.room_id), after: '0', limit: 50, now: clock.now() });
			expect(page.reactions?.[0].reactions).toHaveLength(64);
			expect(recordBytes).toBeLessThan(config.maxHistoryResponseBytes);
			return { reaction: reactionCost, move, recordBytes };
		});
		console.info('accounting-move-reactions', JSON.stringify(result));
	});

	it('calibrates default costs for maximum snapshots, repeated edits, and a UTC midnight double burst', async () => {
		const stub = env.DEMO.getByName('accounting-default-calibration-v1');
		const config = defaultStoreConfig();
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const midnight = (Math.floor(Date.now() / DAY) + 2) * DAY;
			const clock = new FakeClock(midnight - 20_000);
			const store = new Store(state, config, clock);
			store.initialize();
			const { costs, measure, measureFailure } = costLog(store);
			const maximumText = 'x'.repeat(config.maxTextBytes);
			// Preserve a large extension field as part of the snapshot so this
			// calibration reaches the 8 KiB snapshot ceiling instead of measuring
			// only the 4 KiB body-text limit.
			const maximumExtensions = { ext: { padding: 'p'.repeat(3_850) } };
			const first = measure('maximum snapshot create', () => store.commitMutation(messageInput(clock, 'calibration-user', maximumText, 'maximum-create', undefined, maximumExtensions)));
			const messageId = first.result.message_id as string | undefined;
			expect(messageId).toBeTruthy();
			const snapshotBytes = JSON.stringify(first.message).length;
			expect(snapshotBytes).toBeGreaterThan(8_000);
			expect(snapshotBytes).toBeLessThanOrEqual(config.maxSnapshotBytes);

			// Five accepted operations fit the default anonymous minute window. The
			// sixth is intentionally rejected before the UTC rollover.
			for (let index = 0; index < 4; index += 1) {
				clock.set(midnight - 19_000 + index * 1_000);
				measure(`maximum snapshot edit pre-midnight ${index + 1}`, () => store.commitMutation(messageInput(clock, 'calibration-user', maximumText, `maximum-edit-pre-${index}`, messageId, maximumExtensions)));
			}
			clock.set(midnight - 15_000);
			const rejected = measureFailure('sixth pre-midnight post', () => store.commitMutation(messageInput(clock, 'calibration-user', 'must be rejected', 'pre-midnight-rejected')));
			expectRetryAfter(rejected);

			for (let index = 0; index < 5; index += 1) {
				clock.set(midnight + 61_000 + index * 1_000);
				measure(`post-midnight burst ${index + 1}`, () => store.commitMutation(messageInput(clock, 'calibration-user', maximumText, `maximum-create-post-${index}`, undefined, maximumExtensions)));
			}

			for (let group = 0; group < 2; group += 1) {
				const start = midnight + 130_000 + group * 61_000;
				for (let index = 0; index < 4; index += 1) {
					clock.set(start + index * 1_000);
					measure(`maximum snapshot edit group ${group + 1}.${index + 1}`, () => store.commitMutation(messageInput(clock, 'calibration-user', maximumText, `maximum-edit-${group}-${index}`, messageId, maximumExtensions)));
				}
			}

			const history = store.historyPage({ roomId: 'general', limit: 50, now: clock.now() });
			const limiter = state.storage.sql.exec<{ day: string; posts_day: number }>(
				"SELECT day, posts_day FROM principal_limits WHERE scope = 'post' AND principal_key = ? LIMIT 1",
				'anonymous:audit-ip',
			).one();
			expect(messagesOf(history)).toHaveLength(18);
			expect(limiter.posts_day).toBe(13);
			expect(limiter.day).toBe(new Date(clock.now()).toISOString().slice(0, 10));
			for (const operation of costs) {
				expect(operation.withinReserve, `${operation.label} exceeded its reservation`).toBe(true);
			}
			return {
				midnight,
				snapshotBytes,
				acceptedTransitions: messagesOf(history).length,
				postDay: limiter,
				maximumObservedReads: Math.max(...costs.map((operation) => operation.observed.reads)),
				maximumObservedWrites: Math.max(...costs.map((operation) => operation.observed.writes)),
				costs,
			};
		});
		console.info('accounting-default-calibration', JSON.stringify(result));
	});

	it('keeps the maintenance reserve available after foreground quota exhaustion', async () => {
		const stub = env.DEMO.getByName('accounting-maintenance-reserve-v1');
		// Tiny ceilings are used only for deterministic exhaustion. All row-cost
		// estimates and maintenance ceilings remain the deployment defaults.
		const config = defaultStoreConfig({
			anonymousPostsPerMinute: 1_000,
			anonymousPostsPerDay: 1_000,
			ipPostsPerMinute: 1_000,
			ipPostsPerDay: 1_000,
			globalPostsPerMinute: 1_000,
			globalPostsPerDay: 1_000,
			// The ceiling is intentionally small, but the accepted count is
			// discovered by the real reservation path rather than mirroring a
			// particular mutation-cost constant.
			foregroundReadsPerDay: 1_000,
			foregroundWritesPerDay: 1_000,
			...ONE_DAY_RETENTION,
		});
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, config, clock);
			store.initialize();
			const foregroundDay = new Date(clock.now()).toISOString().slice(0, 10);
			let acceptedMutations = 0;
			// Mutations are charged what they actually wrote, so more fit.
			for (let index = 0; index < 200; index += 1) {
				try {
					store.commitMutation(messageInput(clock, 'maintenance-user', `accepted-${index}`, `maintenance-${index}`));
					acceptedMutations += 1;
				} catch (candidate) {
					expectRetryAfter(candidate);
					break;
				}
			}
			expect(acceptedMutations).toBeGreaterThanOrEqual(2);
			let error: unknown;
			try {
				store.commitMutation(messageInput(clock, 'maintenance-user', 'foreground exhausted', 'maintenance-final'));
			} catch (candidate) {
				error = candidate;
			}
			expectRetryAfter(error);
			const beforeCleanup = store.storageAccounting();
			clock.set(clock.now() + DAY + HOUR + 1);
			const cleanup = store.runCleanup(clock.now());
			const afterCleanup = store.storageAccounting();
			const maintenanceDay = new Date(clock.now()).toISOString().slice(0, 10);
			const budgetRows = state.storage.sql.exec<{
				day: string;
				foreground_writes: number;
				maintenance_writes: number;
			}>('SELECT day, foreground_writes, maintenance_writes FROM resource_budgets WHERE day IN (?, ?) ORDER BY day', foregroundDay, maintenanceDay).toArray();
			const foregroundBudget = budgetRows.find((row) => row.day === foregroundDay);
			const maintenanceBudget = budgetRows.find((row) => row.day === maintenanceDay);
			// Every accepted create plus the seeded general room record.
			expect(cleanup.deleted_records).toBe(acceptedMutations + 1);
			expect(cleanup.deleted_messages).toBe(acceptedMutations);
			expect(BigInt(cleanup.history_floor)).toBeGreaterThan(1n);
			expect(foregroundBudget?.foreground_writes).toBeGreaterThan(0);
			expect(foregroundBudget?.foreground_writes).toBeLessThanOrEqual(config.foregroundWritesPerDay);
			expect(maintenanceBudget?.maintenance_writes).toBeGreaterThan(0);
			expect(afterCleanup.writes - beforeCleanup.writes).toBeGreaterThan(0);
			return { cleanup, acceptedMutations, foregroundBudget, maintenanceBudget, observedCleanup: diffAccounting(afterCleanup, beforeCleanup) };
		});
		console.info('accounting-maintenance-reserve', JSON.stringify(result));
	});

	it('measures every Store reservation boundary used by runtime operations', async () => {
		const stub = env.DEMO.getByName('accounting-operation-matrix-v1');
		const config = defaultStoreConfig({ push: { ...PUSH_POLICY! } });
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, config, clock);
			store.initialize();
			const { costs, measure, measureAsync } = costLog(store);

			measure('auth attempt reservation', () => store.reserveAuthAttempt({ ipKey: 'matrix-auth', now: clock.now() }));
			measure('frame reservation', () => store.reserveFrames({ ipKey: 'matrix-frame-ip', now: clock.now(), count: 1 }));
			measure('frame block', () => store.reserveFrames({ ipKey: 'matrix-block-ip', now: clock.now(), count: DEFAULT_LIMITS.frameLease }));
			measure('guest number block', () => store.reserveGuestNumbers(DEFAULT_LIMITS.guestNumberBlock, clock.now()));
			measure('connection admission reservation', () => store.reserveConnection({ ipKey: 'matrix-connection-ip', now: clock.now() }));
			measure('identity registration', () => store.registerIdentity({
				userId: 'matrix-user',
				name: 'Matrix user',
				userHandle: 'matrix-handle',
				credential: { credentialId: 'matrix-credential', userId: 'matrix-user', publicKey: 'matrix-public-key', counter: 0 },
				now: clock.now(),
				ipKey: 'matrix-registration-ip',
			}));
			measure('credential lookup', () => store.getCredential('matrix-credential'));
			measure('identity lookup', () => store.getIdentity('matrix-user'));
			measure('identity count', () => store.countIdentities());
			measure('credential IDs lookup', () => store.credentialIdsForUser('matrix-user'));
			measure('credential counter update', () => store.updateCredentialCounter('matrix-credential', 1));
			const subscription = { userId: 'matrix-user', url: 'https://push.example.net/matrix', p256dh: 'p'.repeat(87), auth: 'a'.repeat(22), pushId: 'p'.repeat(64) };
			measure('push subscription register', () => store.registerPushSubscription({ ...subscription, now: clock.now() }));
			measure('push subscription register again, unchanged', () => store.registerPushSubscription({ ...subscription, now: clock.now() }));
			expect(measure('push wake claim', () => store.claimPushes({ senderId: 'matrix-sender', roomId: 'general', candidates: [{ userId: 'matrix-user', reasons: WAKE_SCOPES.mentions }], now: clock.now() })).subscriptions).toHaveLength(1);
			const unsubscribed = Array.from({ length: 31 }, (_, index) => `matrix-unsubscribed-${index}`);
			expect(measure('push wake claim, 31 unsubscribed candidates first', () => store.claimPushes({ senderId: 'matrix-sender', roomId: 'matrix-room', candidates: [...unsubscribed, 'matrix-user'].map((userId) => ({ userId, reasons: WAKE_SCOPES.mentions })), now: clock.now() })).subscriptions).toHaveLength(1);
			measure('push sender charge', () => store.chargePushSender('matrix-sender', 2, clock.now()));
			measure('push registrations clear', () => store.clearPushSubscriptions('matrix-other', clock.now()));
			measure('gone push subscription forget', () => store.forgetPushSubscriptions([{ userId: subscription.userId, url: subscription.url, p256dh: subscription.p256dh }], clock.now()));

			const identity = { user_id: 'matrix-user', name: 'Matrix user', tier: 'registered' as const };
			const create = measure('message create', () => store.commitMutation({
				userId: 'matrix-user', ipKey: 'matrix-post-ip', requestId: 'matrix-message', method: 'message', now: clock.now(),
				params: { room_id: 'general', body: { text: 'matrix message', format: 'plain' } }, identity,
			}));
			measure('deduplicated mutation retry', () => store.commitMutation({
				userId: 'matrix-user', ipKey: 'matrix-post-ip', requestId: 'matrix-message', method: 'message', now: clock.now(),
				params: { room_id: 'general', body: { text: 'matrix message', format: 'plain' } }, identity,
			}));
			const messageId = create.result.message_id as string;
			expect(measure('push reply author lookup', () => store.messageAuthor(messageId, clock.now()))).toBe('matrix-user');
			store.registerPushSubscription({ ...subscription, now: clock.now() });
			expect(measure('push wake claim for a reply', () => store.claimPushes({ senderId: 'matrix-replier', roomId: 'matrix-reply-room', candidates: [{ userId: 'matrix-user', reasons: WAKE_SCOPES.replies }], now: clock.now() })).subscriptions).toHaveLength(1);
			measure('reaction set', () => store.commitMutation({
				userId: 'matrix-user', ipKey: 'matrix-react-ip', requestId: 'matrix-react', method: 'reactions', now: clock.now(),
				params: { message_id: messageId, emojis: ['👍', '🎉'] }, identity,
			}));
			const threadId = measure('thread room create', () => store.commitMutation({
				userId: 'matrix-user', ipKey: 'matrix-thread-ip', requestId: 'matrix-thread', method: 'room_set', now: clock.now(),
				params: { parent_room_id: 'general', title: 'Matrix thread', description: 'What the matrix measures' }, identity,
			})).result.room_id as string;
			measure('thread room update', () => store.commitMutation({
				userId: 'matrix-user', ipKey: 'matrix-thread-ip', requestId: 'matrix-thread-update', method: 'room_set', now: clock.now(),
				params: { room_id: threadId, title: 'Matrix thread renamed', ext: { demo: true } }, identity,
			}));
			const membership = (join: boolean) => store.changeMembership({ userId: 'matrix-user', ipKey: 'matrix-member-ip', roomId: threadId, join, now: clock.now() });
			expect(measure('registered room leave', () => membership(false)).changed).toBe(true);
			expect(measure('registered room join', () => membership(true)).rooms).toEqual(['general', threadId]);
			expect(measure('empty new message', () => store.commitMutation({
				userId: 'matrix-user', ipKey: 'matrix-post-ip', requestId: 'matrix-empty', method: 'message', now: clock.now(),
				params: { body: { text: '' } }, identity,
			}))).toEqual({ result: {}, broadcasts: [] });
			measure('message move with reactions', () => store.commitMutation({
				userId: 'matrix-user', ipKey: 'matrix-post-ip', requestId: 'matrix-move', method: 'message', now: clock.now(),
				params: { message_id: messageId, room_id: threadId, body: { text: 'matrix moved', format: 'plain' } }, identity,
			}));
			measure('registered name mutation', () => store.commitMutation({
				userId: 'matrix-user', ipKey: 'matrix-nick-ip', requestId: 'matrix-nick', method: 'me', now: clock.now(),
				params: { name: 'Matrix renamed' }, identity,
			}));
			measure('history page', () => store.historyPage({ roomId: 'general', limit: 50, now: clock.now() }));
			measure('room record lookup', () => store.getRoomState());
			measure('room join lookup', () => store.getRoom(threadId));
			measure('room listing', () => store.listRooms(clock.now()));
			measure('room members (general and one thread)', () => store.roomMembers(['general', threadId], DEFAULT_LIMITS.roomListMembers, clock.now()));
			measure('room members with status (general and one thread)', () => store.roomMembers(['general', threadId], DEFAULT_LIMITS.roomListMembers, clock.now(), undefined, true));
			expect(measure('status inputs at sign-in, nothing stored', () => store.statusInputs('matrix-user', clock.now()))).toEqual({ choice: 'online', roomMutes: [] });
			measure('mute set', () => store.setMute({ userId: 'matrix-user', untilMs: clock.now() + 3_600_000, now: clock.now() }));
			measure('status set', () => store.setStatus({ userId: 'matrix-user', choice: 'dnd', now: clock.now() }));
			expect(measure('push wake claim, dnd and muted', () => store.claimPushes({ senderId: 'matrix-sender', roomId: threadId, candidates: [{ userId: 'matrix-user', reasons: WAKE_SCOPES.mentions }], now: clock.now() }))).toEqual({ subscriptions: [], skipped: 0 });
			measure('room mute set', () => store.setRoomMute({ userId: 'matrix-user', roomId: 'general', untilMs: clock.now() + 60_000, now: clock.now() }));
			expect(measure('status inputs at sign-in, status, mute and one room mute', () => store.statusInputs('matrix-user', clock.now()))).toEqual({ choice: 'dnd', muteUntil: clock.now() + 3_600_000, roomMutes: [{ roomId: 'general', untilMs: clock.now() + 60_000 }] });
			store.setStatus({ userId: 'matrix-user', choice: 'online', now: clock.now() });
			store.setMute({ userId: 'matrix-user', untilMs: null, now: clock.now() });
			// The thread's parent is muted: a wake for the thread is silenced by it.
			expect(measure('push wake claim, the thread\'s parent muted', () => store.claimPushes({ senderId: 'matrix-sender', roomId: threadId, candidates: [{ userId: 'matrix-user', reasons: WAKE_SCOPES.mentions }], now: clock.now() }))).toEqual({ subscriptions: [], skipped: 0 });
			// The most room mutes a user may hold: the sign-in reads them all.
			state.storage.transactionSync(() => {
				for (let index = 1; index < MAX_ROOM_MUTES_PER_USER; index += 1) {
					state.storage.sql.exec('INSERT INTO room_mutes (user_id, room_id, mute_until_ms) VALUES (?, ?, ?)', 'matrix-user', `muted-${String(index).padStart(3, '0')}`, index % 2 ? MUTE_FOREVER : clock.now() + 30_000);
				}
			});
			expect(measure('status inputs at sign-in, 100 room mutes', () => store.statusInputs('matrix-user', clock.now())).roomMutes).toHaveLength(MAX_ROOM_MUTES_PER_USER);
			expect(measure('room mute set past the cap, refused', () => store.setRoomMute({ userId: 'matrix-user', roomId: 'one-too-many', untilMs: MUTE_FOREVER, now: clock.now() }))).toEqual({ changed: false, refused: true });
			clock.set(clock.now() + 60_001);
			// Half the mutes ran out: they go, and their place is free.
			expect(measure('room mute expiry, 50 of 100 ran out', () => store.expireRoomMutes('matrix-user', clock.now())).expired).toHaveLength(MAX_ROOM_MUTES_PER_USER / 2);
			measure('room mute clear', () => store.setRoomMute({ userId: 'matrix-user', roomId: 'muted-001', untilMs: null, now: clock.now() }));
			state.storage.sql.exec("DELETE FROM room_mutes WHERE user_id = 'matrix-user'");
			clock.set(clock.now() + DAY + HOUR + 1);
			measure('cleanup', () => store.runCleanup(clock.now()));
			await measureAsync('alarm scheduling', () => store.scheduleAlarm(clock.now() + 1_000, clock.now()));

			expect(create.result.message_id).toBeTruthy();
			expect(costs).toHaveLength(49);
			expect(store.accountingStatus().unsafe).toBe(false);
			return { costs };
		});
		console.info('accounting-operation-matrix', JSON.stringify(result));
		for (const operation of result.costs) {
			expect(operation.withinReserve, `${operation.label} exceeded its reservation`).toBe(true);
		}
	});

	it('records actual SQLite query plans for history, cleanup, room listing, dedup, and limiter paths', async () => {
		const stub = env.DEMO.getByName('accounting-query-plans-v2');
		const result = await runInDurableObject(stub, async (_instance, state) => {
			const clock = new FakeClock(futureUtcNoon());
			const store = new Store(state, defaultStoreConfig(), clock);
			store.initialize();
			for (let index = 0; index < 4; index += 1) {
				store.commitMutation(messageInput(clock, 'plan-user', `plan-${index}`, `plan-${index}`));
			}
			const sql = state.storage.sql;
			const plans = {
				history: explain(sql, `EXPLAIN QUERY PLAN
					SELECT room_id, log_id, kind, record_json FROM records
					WHERE room_id = ? AND log_id >= ? AND log_id <= ?
					ORDER BY log_id ASC LIMIT ?`, 'general', 1, Number.MAX_SAFE_INTEGER, 21),
				cleanup: explain(sql, `EXPLAIN QUERY PLAN
					SELECT log_id FROM records INDEXED BY records_retention_idx
					WHERE commit_ms < ? AND log_id >= ?
					ORDER BY commit_ms, log_id LIMIT ?`, clock.now() - DAY, 1, 100),
				cleanupDelete: explain(sql, `EXPLAIN QUERY PLAN
					SELECT room_id, log_id FROM records INDEXED BY records_log_idx
					WHERE log_id < ? ORDER BY log_id LIMIT ?`, 100, 100),
				messageExpiry: explain(sql, 'EXPLAIN QUERY PLAN SELECT message_id FROM message_state WHERE latest_log_id < ? ORDER BY latest_log_id LIMIT ?', 100, 100),
				reactionExpiry: explain(sql, 'EXPLAIN QUERY PLAN SELECT message_id, user_id FROM reaction_state WHERE log_id < ? ORDER BY log_id LIMIT ?', 100, 100),
				moveReactions: explain(sql, 'EXPLAIN QUERY PLAN SELECT message_id, user_id, log_id, from_json, emojis_json FROM reaction_state WHERE message_id = ? AND log_id >= ? ORDER BY log_id, user_id LIMIT ?', '1', 1, 32),
				roomListing: explain(sql, `EXPLAIN QUERY PLAN
					SELECT room_id, fields_json FROM rooms ORDER BY created_log_id ASC LIMIT ?`, 101),
				dedupExpiry: explain(sql, 'EXPLAIN QUERY PLAN SELECT user_id, request_id FROM accepted_requests WHERE expires_ms <= ? ORDER BY expires_ms ASC LIMIT ?', clock.now(), 100),
				limiterExpiry: explain(sql, 'EXPLAIN QUERY PLAN SELECT scope, principal_key FROM principal_limits WHERE updated_ms < ? ORDER BY updated_ms ASC LIMIT ?', clock.now() - DAY, 100),
				roomMembers: explain(sql, `EXPLAIN QUERY PLAN
					SELECT m.user_id, i.name FROM memberships m LEFT JOIN identities i ON i.user_id = m.user_id
					WHERE m.room_id = ? ORDER BY m.user_id LIMIT ?`, 'general', 100),
				roomMembersWithStatus: explain(sql, `EXPLAIN QUERY PLAN
					SELECT m.user_id, i.name, s.status
					FROM memberships m LEFT JOIN identities i ON i.user_id = m.user_id LEFT JOIN user_status s ON s.user_id = m.user_id
					WHERE m.room_id = ? ORDER BY m.user_id LIMIT ?`, 'general', 100),
				roomMuteProbe: explain(sql, 'EXPLAIN QUERY PLAN SELECT mute_until_ms FROM room_mutes WHERE user_id = ? AND room_id IN (?, ?) AND mute_until_ms > ? LIMIT 1', 'plan-user', 'general', 'thread', 0),
				roomMuteRange: explain(sql, 'EXPLAIN QUERY PLAN SELECT room_id, mute_until_ms FROM room_mutes WHERE user_id = ? ORDER BY room_id LIMIT ?', 'plan-user', 100),
				userRooms: explain(sql, `EXPLAIN QUERY PLAN
					SELECT m.room_id FROM memberships m INDEXED BY memberships_user_idx
					JOIN rooms r ON r.room_id = m.room_id
					WHERE m.user_id = ? ORDER BY r.created_log_id LIMIT ?`, 'plan-user', 101),
			};
			return { plans, databaseSize: store.databaseSize() };
		});
		console.info('accounting-query-plans', JSON.stringify(result));
		expect(result.plans.history.some((detail) => /SEARCH records USING/i.test(detail))).toBe(true);
		expect(result.plans.cleanup.some((detail) => /records_retention_idx/i.test(detail))).toBe(true);
		expect(result.plans.cleanupDelete.some((detail) => /records_log_idx/i.test(detail))).toBe(true);
		expect(result.plans.messageExpiry.some((detail) => /message_state_latest_idx/i.test(detail))).toBe(true);
		expect(result.plans.reactionExpiry.some((detail) => /reaction_state_log_idx/i.test(detail))).toBe(true);
		expect(result.plans.moveReactions.some((detail) => /SEARCH reaction_state USING/i.test(detail))).toBe(true);
		// The rooms table is capped at the thread ceiling plus `general`, so the listing scans it.
		expect(result.plans.roomListing.some((detail) => /SCAN rooms/i.test(detail))).toBe(true);
		expect(result.plans.dedupExpiry.some((detail) => /accepted_requests.*expiry|expiry.*accepted_requests/i.test(detail))).toBe(true);
		expect(result.plans.limiterExpiry.some((detail) => /principal_limits_updated_idx/i.test(detail))).toBe(true);
		expect(result.plans.roomMembers.some((detail) => /SEARCH m USING .*autoindex_memberships/i.test(detail))).toBe(true);
		expect(result.plans.roomMembers.some((detail) => /TEMP B-TREE/i.test(detail))).toBe(false);
		expect(result.plans.userRooms.some((detail) => /memberships_user_idx/i.test(detail))).toBe(true);
		// Status adds one primary-key lookup of `user_status`, and nothing of push registrations.
		expect(result.plans.roomMembersWithStatus.some((detail) => /SEARCH s USING INDEX sqlite_autoindex_user_status_1/i.test(detail))).toBe(true);
		expect(result.plans.roomMembersWithStatus.some((detail) => /push_subscriptions/i.test(detail))).toBe(false);
		expect(result.plans.roomMembersWithStatus.some((detail) => /TEMP B-TREE/i.test(detail))).toBe(false);
		// A wake's room mute check is two primary-key probes; a sign-in's read is one key range, in order.
		expect(result.plans.roomMuteProbe.some((detail) => /SEARCH room_mutes USING INDEX sqlite_autoindex_room_mutes_1 \(user_id=\? AND room_id=\?\)/i.test(detail))).toBe(true);
		expect(result.plans.roomMuteRange.some((detail) => /SEARCH room_mutes USING INDEX sqlite_autoindex_room_mutes_1 \(user_id=\?\)/i.test(detail))).toBe(true);
		expect(result.plans.roomMuteRange.some((detail) => /TEMP B-TREE/i.test(detail))).toBe(false);
	});
});
