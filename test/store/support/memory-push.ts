/*
 * The Push part in memory: for tests, never in the Worker. It keeps
 * registrations, wakes and the daily push counters as the SQLite store does
 * (SqliteStore.registerPushSubscription, claimPushes and the rest), and
 * reads what is not push state (identities and roles, memberships, rooms'
 * parents, mutes and the log) from a PushWorld the test supplies. It
 * passes the Push conformance suite (test/store/conformance/push.ts), as
 * the SQLite-backed part does.
 *
 * Not modelled: reservations and accounting (nothing here is charged), the
 * store's effective clock (`now` is taken as given), and expiry by cleanup
 * (registrations past `pushExpiryDays` are passed over, as the store's
 * reads do, but never deleted).
 */

import { MAX_PUSH_CANDIDATES, MAX_PUSHES_PER_MESSAGE, type PushPolicy } from "../../../src/budget";
import { isPrivateRoomId, JOINED_WAKE_ROLES, MAX_PUSH_URL_BYTES, PUSH_ID_PATTERN, WAKE_SCOPES } from "../../../src/domain";
import { type MessageSnapshot, type Push, type PushCandidate, type PushClaim, StoreError } from "../../../src/store";

/** What the store holds besides push state, as a claim reads it. */
export interface PushWorld {
	/** A registered identity's roles, or undefined where there is no such identity. */
	roles(userId: string): readonly string[] | undefined;
	/** Whether `userId` is a member of `roomId`. */
	isMember(roomId: string, userId: string): boolean;
	/** A thread's parent room, or undefined for a room that has none (or is unknown). */
	parentOf(roomId: string): string | undefined;
	/** Whether a `dnd` status or an unscoped mute silences `userId` at `now`. */
	silenced(userId: string, now: number): boolean;
	/** Whether `userId` muted one of `roomIds` until after `now`. */
	roomMuted(userId: string, roomIds: readonly string[], now: number): boolean;
	/** A retained message as it is now, or null. */
	message(messageId: string): MessageSnapshot | null;
}

interface Registration {
	url: string;
	p256dh: string;
	auth: string;
	pushId: string | null;
	wake: number;
	createdMs: number;
	updatedMs: number;
}

/** A day's count, as a `principal_limits` row keeps one: the day it is for, and the counts. */
interface DayRow {
	day: string;
	posts: number;
	/** The recipient's `unread` (PUSH_UNREAD_SCOPE's `uploads_day`). */
	unread: number;
}

const DEFAULT_WAKE = WAKE_SCOPES.mentions | WAKE_SCOPES.replies;
const ALL_WAKE = WAKE_SCOPES.mentions | WAKE_SCOPES.replies | WAKE_SCOPES.private | WAKE_SCOPES.joined;
/** How old an unchanged registration gets before registering it again rewrites it (the store's PUSH_REFRESH_MS). */
const REFRESH_MS = 86_400_000;
const DAY_MS = 86_400_000;

const dayFor = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayCount = (row: DayRow | undefined, day: string, column: "posts" | "unread") => row && row.day === day ? row[column] : 0;

export class MemoryPush implements Push {
	/** Each user's registrations, by endpoint. */
	readonly registrations = new Map<string, Map<string, Registration>>();
	/** When each user was last woken for each room (`user\u0000room`). */
	readonly wakes = new Map<string, number>();
	/** The server's pushes today, and each sender's. */
	private readonly sent = new Map<string, DayRow>();
	/** Each recipient's pushes today and `unread`, by scope (`push_recipient`, `push_joined_recipient`). */
	private readonly received = new Map<string, DayRow>();

	constructor(
		private readonly world: PushWorld,
		private readonly policy: PushPolicy,
		private readonly clock: { now(): number },
	) {}

	register(input: { userId: string; url: string; p256dh: string; auth: string; pushId?: string; wake?: number; now?: number }): void {
		if (new TextEncoder().encode(input.url).byteLength > MAX_PUSH_URL_BYTES) throw new StoreError("too_large", "url is too long");
		if (input.pushId !== undefined && !PUSH_ID_PATTERN.test(input.pushId)) throw new StoreError("invalid_params", "push_id must be 1 to 64 letters, digits, _ or -");
		const requested = input.wake ?? DEFAULT_WAKE;
		if (!Number.isInteger(requested) || requested < 0 || (requested & ~ALL_WAKE) !== 0) throw new StoreError("invalid_params", "wake must name known scopes");
		const now = input.now ?? this.clock.now();
		const roles = this.world.roles(input.userId);
		if (!roles) throw new StoreError("denied", "Sign in to receive push notifications");
		const wake = roles.some((role) => JOINED_WAKE_ROLES.includes(role)) ? requested : requested & ~WAKE_SCOPES.joined;
		const pushId = input.pushId ?? null;
		let mine = this.registrations.get(input.userId);
		if (!mine) this.registrations.set(input.userId, mine = new Map());
		const existing = mine.get(input.url);
		if (existing && existing.p256dh === input.p256dh && existing.auth === input.auth && existing.pushId === pushId && existing.wake === wake &&
			now - existing.updatedMs < REFRESH_MS) return;
		mine.set(input.url, { url: input.url, p256dh: input.p256dh, auth: input.auth, pushId, wake, createdMs: existing?.createdMs ?? now, updatedMs: now });
		// The new one never goes; of the others, the most recently registered stay.
		const others = [...mine.values()].filter((row) => row.url !== input.url).sort((a, b) => b.updatedMs - a.updatedMs);
		for (const row of others.slice(this.policy.subscriptionsPerUser - 1)) mine.delete(row.url);
	}

	remove(input: { userId: string; url: string; now?: number }): void {
		this.registrations.get(input.userId)?.delete(input.url);
	}

	joinedWakers(now = this.clock.now()): string[] {
		const live = now - this.policy.pushExpiryDays * DAY_MS;
		const rows = [...this.registrations].flatMap(([userId, mine]) => [...mine.values()].map((row) => ({ userId, row })))
			.filter(({ row }) => (row.wake & WAKE_SCOPES.joined) !== 0 && row.updatedMs >= live)
			.sort((a, b) => b.row.updatedMs - a.row.updatedMs)
			.slice(0, MAX_PUSH_CANDIDATES * this.policy.subscriptionsPerUser);
		return [...new Set(rows.map(({ userId }) => userId))].slice(0, MAX_PUSH_CANDIDATES);
	}

	claim(input: { senderId: string; roomId: string; candidates: readonly PushCandidate[]; allowed?: (url: string) => boolean; now?: number; alert?: boolean }): PushClaim {
		const policy = this.policy;
		const reasons = new Map<string, number>();
		for (const candidate of input.candidates) reasons.set(candidate.userId, (reasons.get(candidate.userId) ?? 0) | candidate.reasons);
		const candidates = [...reasons.keys()].slice(0, MAX_PUSH_CANDIDATES);
		const claim: PushClaim = { subscriptions: [], skipped: 0 };
		if (!candidates.length) return claim;
		const now = input.now ?? this.clock.now();
		const day = dayFor(now);
		const live = now - policy.pushExpiryDays * DAY_MS;
		const parent = this.world.parentOf(input.roomId);
		const rooms = [input.roomId, ...(parent !== undefined ? [parent] : [])];
		let sent = dayCount(this.sent.get("global"), day, "posts");
		let charged = dayCount(this.sent.get(`user:${input.senderId}`), day, "posts");
		const chargedBefore = charged;
		let woken = 0;
		for (const userId of candidates) {
			if (woken >= policy.wakesPerMessage) break;
			if (isPrivateRoomId(input.roomId) && !this.world.isMember(input.roomId, userId)) continue;
			if (this.world.silenced(userId, now)) continue;
			let why = reasons.get(userId)!;
			if (why & WAKE_SCOPES.joined) {
				const moderator = (this.world.roles(userId) ?? []).some((role) => JOINED_WAKE_ROLES.includes(role));
				if (!(moderator && rooms.some((roomId) => this.world.isMember(roomId, userId)))) {
					why &= ~WAKE_SCOPES.joined;
					if (!why) continue;
				}
			}
			let rows = [...(this.registrations.get(userId)?.values() ?? [])]
				.filter((row) => row.wake !== 0 && row.updatedMs >= live)
				.sort((a, b) => b.updatedMs - a.updatedMs)
				.slice(0, policy.subscriptionsPerUser)
				.filter((row) => (row.wake & why) !== 0 && (input.allowed?.(row.url) ?? true));
			if (!rows.length) continue;
			if (this.world.roomMuted(userId, rooms, now)) {
				why &= WAKE_SCOPES.mentions;
				rows = rows.filter((row) => (row.wake & why) !== 0);
				if (!rows.length) continue;
			}
			const joinedOnly = rows.every((row) => (row.wake & why) === WAKE_SCOPES.joined);
			const last = this.wakes.get(`${userId}\u0000${input.roomId}`);
			const window = joinedOnly ? policy.joinedCoalesceSeconds : policy.coalesceSeconds;
			if (!input.alert && last !== undefined && now - last < window * 1_000) continue;
			const scope = joinedOnly ? "push_joined_recipient" : "push_recipient";
			const recipient = this.received.get(`${scope}\u0000${userId}`);
			const received = dayCount(recipient, day, "posts");
			const unread = !joinedOnly && !input.alert ? dayCount(recipient, day, "unread") + 1 : undefined;
			const allowed = input.alert ? rows.length : Math.max(0, Math.min(
				rows.length,
				policy.pushesPerDay - sent,
				(joinedOnly ? policy.joinedPushesPerRecipientDay : policy.pushesPerRecipientDay) - received,
				joinedOnly ? Infinity : policy.pushesPerSenderDay - charged,
			));
			claim.skipped += rows.length - allowed;
			if (!allowed) continue;
			for (const row of rows.slice(0, allowed)) {
				claim.subscriptions.push({
					url: row.url, userId, p256dh: row.p256dh, auth: row.auth, ...(row.pushId !== null ? { pushId: row.pushId } : {}),
					reasons: row.wake & why, ...(unread !== undefined ? { unread } : {}),
				});
			}
			sent += allowed;
			if (!joinedOnly) charged += allowed;
			woken += 1;
			// As the store's row: the day's count, and `unread` written only when counted (else kept as it was).
			this.received.set(`${scope}\u0000${userId}`, { day, posts: received + allowed, unread: unread ?? recipient?.unread ?? 0 });
			this.wakes.set(`${userId}\u0000${input.roomId}`, now);
		}
		if (woken) {
			this.sent.set("global", { day, posts: sent, unread: 0 });
			if (charged !== chargedBefore) this.sent.set(`user:${input.senderId}`, { day, posts: charged, unread: 0 });
		}
		return claim;
	}

	clearUnread(userId: string): void {
		const row = this.received.get(`push_recipient\u0000${userId}`);
		if (row) row.unread = 0;
	}

	clearSubscriptions(userId: string): void {
		this.registrations.delete(userId);
	}

	forgetSubscriptions(gone: ReadonlyArray<{ userId: string; url: string; p256dh: string }>): void {
		for (const row of gone.slice(0, MAX_PUSHES_PER_MESSAGE)) {
			const mine = this.registrations.get(row.userId);
			if (mine?.get(row.url)?.p256dh === row.p256dh) mine.delete(row.url);
		}
	}

	message(messageId: string): MessageSnapshot | null {
		return this.world.message(messageId);
	}

	sentToday(now = this.clock.now()): number {
		return dayCount(this.sent.get("global"), dayFor(now), "posts");
	}
}
