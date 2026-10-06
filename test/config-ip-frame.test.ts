import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_LIMITS, isAllowedOrigin, loadConfig } from '../src/config';
import { ACCOUNT_USAGE_POLICY, DEFAULT_FEATURES, PLAN } from '../src/budget';
import { FREE_PLAN } from '../src/plans/free';
import { PAID_PLAN } from '../src/plans/paid';
import { canonicalizeIp, extractClientIp, hashIpKey } from '../src/ip';
import { DEFAULT_PARSE_OPTIONS, FrameError, parseFrame } from '../src/protocol';

// Independent boundary cases from the implementation specification.
describe('trusted IP boundaries', () => {
	it('keeps compact rate-limit keys stable', async () => {
		// Pin the persisted format so a refactor cannot silently reset IP quotas.
		// Grouping is covered by the canonical keys below, which is all it hashes.
		expect(await hashIpKey(canonicalizeIp('192.0.2.10')!)).toBe('zBXK6QD6CozD5FPoI5CPlQ');
	});
	it('joins dotted and hexadecimal IPv4-mapped IPv6 with IPv4', () => {
		const key = canonicalizeIp('192.0.2.10')?.key;
		expect(canonicalizeIp('::ffff:192.0.2.10')?.key).toBe(key);
		expect(canonicalizeIp('0:0:0:0:0:ffff:c000:020a')?.key).toBe(key);
		expect(canonicalizeIp('2001:db8:1:2::1')?.key).toBe(canonicalizeIp('2001:0db8:0001:0002:abcd::5')?.key);
		expect(canonicalizeIp('2001:db8:1:3::1')?.key).not.toBe(canonicalizeIp('2001:db8:1:2::1')?.key);
	});
	it('does not let an unrelated IPv6 header change a real IPv4 principal', () => {
		const headers = new Headers({ 'CF-Connecting-IP': '192.0.2.10', 'CF-Connecting-IPv6': '2001:db8::1' });
		expect(extractClientIp(headers)?.key).toBe(canonicalizeIp('192.0.2.10')?.key);
	});
	it('uses the real IPv6 address for pseudo IPv4 and fails without it', () => {
		expect(extractClientIp(new Headers({ 'CF-Connecting-IP': '240.1.2.3' }))).toBeNull();
		expect(extractClientIp(new Headers({ 'CF-Connecting-IP': '240.1.2.3', 'CF-Connecting-IPv6': '2001:db8::1' }))?.key)
			.toBe(canonicalizeIp('2001:db8::2')?.key);
	});
	it('rejects absent metadata and the cross-zone Worker sentinel', () => {
		expect(extractClientIp(new Headers({ 'X-Forwarded-For': '192.0.2.1' }))).toBeNull();
		expect(extractClientIp(new Headers({ 'CF-Connecting-IPv6': '2001:db8::1' }))).toBeNull();
		expect(extractClientIp(new Headers({ 'CF-Connecting-IP': '192.0.2.1', 'CF-Worker': 'example.test' }))).toBeNull();
		expect(extractClientIp(new Headers({ 'CF-Connecting-IP': '2a06:98c0:3600::103' }))).toBeNull();
	});
});

describe('frame policy boundaries', () => {
	it('counts JSON depth by nested containers', () => {
		const options = { ...DEFAULT_PARSE_OPTIONS, maxJsonDepth: 2 };
		expect(parseFrame(JSON.stringify({ id: 'a', method: 'auth', params: { scheme: 'guest' } }), options).request.id).toBe('a');
		expect(() => parseFrame(JSON.stringify({ id: 'a', method: 'auth', params: { nested: {} } }), options)).toThrow(FrameError);
	});
	it('preserves identifiable IDs on structural policy errors', () => {
		try {
			parseFrame(JSON.stringify({ id: 'bounded', method: 'message', params: { a: 1, b: 2 } }), {
				...DEFAULT_PARSE_OPTIONS, maxJsonNodes: 4
			});
			expect.unreachable('expected structural rejection');
		} catch (error) {
			expect(error).toBeInstanceOf(FrameError);
			expect((error as FrameError).id).toBe('bounded');
		}
	});
	it('bounds raw UTF-8 bytes before parsing and rejects binary', () => {
		expect(() => parseFrame('"' + 'é'.repeat(8192) + '"')).toThrow(FrameError);
		expect(() => parseFrame(new ArrayBuffer(0))).toThrow(expect.objectContaining({ closeCode: 1003 }));
	});
	it('marks failures of notification-only methods as notifications, whatever their id (§1)', () => {
		const failure = (raw: string) => {
			try {
				parseFrame(raw, { ...DEFAULT_PARSE_OPTIONS, maxJsonDepth: 3 });
			} catch (error) {
				return error as FrameError;
			}
			throw new Error(`expected ${raw} to fail`);
		};
		for (const method of ['ping', 'activity']) {
			expect(failure(`{"id":"a","method":"${method}","params":"x"}`).notification, method).toBe(true);
			expect(failure(`{"id":"a","method":"${method}","params":{"a":{"b":{"c":{}}}}}`).notification, method).toBe(true);
			expect(failure(`{"id":7,"method":"${method}"}`).notification, method).toBe(true);
			expect(failure(`{"jsonrpc":"1.0","id":"a","method":"${method}"}`).notification, method).toBe(true);
		}
		// A client's status is a request (§4.5): its failures are answered.
		expect(failure('{"id":"a","method":"status","params":"x"}').notification).toBe(false);
		expect(failure('{"method":"status","params":"x"}').notification).toBe(true);
		// Requests are answered; so is an invalid envelope, with or without an id.
		expect(failure('{"id":"a","method":"me","params":"x"}').notification).toBe(false);
		expect(failure('{"method":"me","params":"x"}').notification).toBe(true);
		expect(failure('{"id":7,"method":"me"}').notification).toBe(false);
		expect(failure('{"jsonrpc":"1.0","method":"me"}').notification).toBe(false);
		expect(failure('{"params":{}}').notification).toBe(false);
	});
	it('accepts empty string IDs and both envelopes without treating unknown fields as operations', () => {
		expect(parseFrame('{"id":"","method":"auth","params":{},"ignored":42}').request.id).toBe('');
		expect(parseFrame('{"jsonrpc":"2.0","id":"a","method":"auth"}').request.full).toBe(true);
		expect(parseFrame('{"method":"unknown"}').request.id).toBeUndefined();
	});
});

describe('configuration policy boundaries', () => {
	const base = {
		NODE_ENV: 'test',
	} as Parameters<typeof loadConfig>[0];

	function config(extra: Record<string, string> = {}, overrides: Partial<typeof DEFAULT_LIMITS> = {}) {
		return loadConfig({ ...base, ...extra } as Parameters<typeof loadConfig>[0], overrides);
	}

	it('accepts the documented aliases in prefixed precedence order', () => {
		const loaded = config({
			LIMIT_HISTORY_MAX_LIMIT: '49',
			HISTORY_MAX_LIMIT: '48',
			historyMaxLimit: '47',
		});
		expect(loaded.limits.historyMaxLimit).toBe(49);
	});

	it('takes an optional APRON_ADMIN_TOKEN that is long, token-safe, and not a bot token', () => {
		expect(config().adminToken).toBeUndefined();
		expect(config({ APRON_ADMIN_TOKEN: '' }).adminToken).toBeUndefined();
		expect(config({ APRON_ADMIN_TOKEN: 'demo-token-0123456789abcdef' }).adminToken).toBe('demo-token-0123456789abcdef');
		expect(() => config({ APRON_ADMIN_TOKEN: 'too-short' })).toThrow(ConfigError);
		expect(() => config({ APRON_ADMIN_TOKEN: 'has spaces in it 0123456789' })).toThrow(ConfigError);
		expect(() => config({ APRON_ADMIN_TOKEN: 'apron_bot_0123456789abcdefghij' })).toThrow(ConfigError);
		expect(() => config({ APRON_ADMIN_TOKEN: 'apron_join_0123456789abcdefghij' })).toThrow(ConfigError);
	});

	it('rejects unsafe payload, queue, history, and maintenance combinations', () => {
		expect(() => config({}, { historyMaxLimit: 51 })).toThrow(ConfigError);
		expect(() => config({}, { maxTextBytes: 4_097 })).toThrow(ConfigError);
		expect(() => config({}, { pendingFramesPerConnection: 9 })).toThrow(ConfigError);
		expect(() => config({}, { pendingBytesPerConnection: DEFAULT_LIMITS.maxFrameBytes - 1 })).toThrow(ConfigError);
		expect(() => config({}, { historyMaxResponseBytes: DEFAULT_LIMITS.maxSnapshotBytes + 511 })).toThrow(ConfigError);
		expect(() => config({}, { maintenanceReadsPerDay: 8 })).toThrow(ConfigError);
		expect(() => config({}, { maintenanceWritesPerDay: 8 })).toThrow(ConfigError);
		expect(() => config({}, { maintenanceReadsPerDay: 519 })).toThrow(ConfigError);
		expect(() => config({}, { maintenanceWritesPerDay: 519 })).toThrow(ConfigError);
		expect(config({}, { maintenanceReadsPerDay: 520, maintenanceWritesPerDay: 520 }).limits.maintenanceReadsPerDay).toBe(520);
	});

	it('bounds reaction sets so a moved message fits one history response', () => {
		expect(config({ REACTION_USERS_PER_MESSAGE: '64', REACTION_EMOJIS_PER_USER: '16' }).limits.reactionUsersPerMessage).toBe(64);
		expect(() => config({}, { reactionUsersPerMessage: 65 })).toThrow(ConfigError);
		expect(() => config({}, { reactionEmojisPerUser: 17 })).toThrow(ConfigError);
		expect(() => config({}, { reactionUsersPerMessage: 64, historyMaxResponseBytes: 64 * 1024 })).toThrow(ConfigError);
	});

	it('rejects resource ceilings and per-scope counter inversions', () => {
		expect(() => config({}, { databaseHighWaterBytes: DEFAULT_LIMITS.databaseHighWaterBytes + 1 })).toThrow(ConfigError);
		expect(() => config({}, { framesPerConnectionMinute: 61, framesPerIpMinute: 60 })).toThrow(ConfigError);
		expect(() => config({}, { openConnections: 11, connectionsPerIp: 12 })).toThrow(ConfigError);
		expect(() => config({}, { registrationsPerDay: DEFAULT_LIMITS.registrationsPerDay + 1 })).toThrow(ConfigError);
	});

	it('takes feature switches from the plan unless ACTIVITY or GUEST_POSTING says otherwise', () => {
		expect(config().activityEnabled).toBe(DEFAULT_FEATURES.activity);
		expect(config().guestPosting).toBe(DEFAULT_FEATURES.guestPosting);
		expect(config({ ACTIVITY: '' }).activityEnabled).toBe(DEFAULT_FEATURES.activity);
		expect(config({ ACTIVITY: 'true' }).activityEnabled).toBe(true);
		expect(config({ ACTIVITY: 'FALSE' }).activityEnabled).toBe(false);
		expect(config({ GUEST_POSTING: 'true' }).guestPosting).toBe(true);
		expect(config({ GUEST_POSTING: 'false' }).guestPosting).toBe(false);
		expect(() => config({ ACTIVITY: 'maybe' })).toThrow(ConfigError);
		expect(() => config({ GUEST_POSTING: '1' })).toThrow(ConfigError);
	});

	it('takes presence from the plan unless PRESENCE says otherwise, and bounds status delays', () => {
		expect(config().presence).toBe(DEFAULT_FEATURES.presence);
		expect(config({ PRESENCE: '' }).presence).toBe(DEFAULT_FEATURES.presence);
		expect(config({ PRESENCE: 'false' }).presence).toBe(false);
		expect(config({ PRESENCE: 'TRUE' }).presence).toBe(true);
		// The variants are gone: status no longer differs by plan.
		expect(() => config({ PRESENCE: 'full' })).toThrow(ConfigError);
		expect(() => config({ PRESENCE: 'connected' })).toThrow(ConfigError);
		expect(() => config({ PRESENCE: 'on' })).toThrow(ConfigError);
		expect(config({ LIMIT_STATUS_COALESCE_SECONDS: '10' }).limits.statusCoalesceSeconds).toBe(10);
		expect(() => config({}, { statusCoalesceSeconds: 61 })).toThrow(ConfigError);
		expect(() => config({}, { offlineGraceSeconds: 61 })).toThrow(ConfigError);
	});

	it('keeps the free plan as it was and valid, and the paid plan inside its allowances', () => {
		expect(FREE_PLAN.features).toEqual({ activity: false, guestPosting: false, presence: true });
		expect(PAID_PLAN.features.presence).toBe(true);
		expect(FREE_PLAN.limits).toMatchObject({ globalFramesPerMinute: 300, processedFramesPerDay: 100_000, globalPostsPerDay: 5_000, registrationsPerDay: 100, sqlWritesPerDay: 80_000, sqlReadsPerDay: 3_000_000 });
		expect(FREE_PLAN.account.daily.sqlRowsWritten).toBe(100_000);
		// The calibrated ceilings follow the selected plan, and Free fits under any.
		for (const plan of new Set([FREE_PLAN, PLAN])) expect(() => config({}, plan.limits)).not.toThrow();
		for (const plan of [FREE_PLAN, PAID_PLAN]) {
			const { daily, storedBytes } = plan.account;
			expect(plan.limits.sqlWritesPerDay).toBeLessThan(daily.sqlRowsWritten * ACCOUNT_USAGE_POLICY.stopRatio);
			expect(plan.limits.sqlReadsPerDay).toBeLessThan(daily.sqlRowsRead * ACCOUNT_USAGE_POLICY.stopRatio);
			expect(plan.limits.databaseHardTargetBytes).toBeLessThan(storedBytes * ACCOUNT_USAGE_POLICY.stopRatio);
			// Worst-case billed Durable Object requests: processed frames and pings
			// from every open connection every pingSeconds, at 20 incoming WebSocket
			// messages a request, plus admissions and a cleanup alarm an hour.
			const messages = plan.limits.processedFramesPerDay + plan.limits.openConnections * Math.ceil(86_400 / plan.limits.pingSeconds);
			const requests = messages / 20 + plan.limits.connectionAdmissionsPerDay + 24;
			expect(requests).toBeLessThan(daily.durableObjectRequests * ACCOUNT_USAGE_POLICY.stopRatio);
		}
	});

	it('bounds the server-wide frame minute', () => {
		expect(() => config({}, { globalFramesPerMinute: DEFAULT_LIMITS.framesPerIpMinute - 1 })).toThrow(ConfigError);
		expect(() => config({}, { globalFramesPerMinute: 1_001 })).toThrow(ConfigError);
		expect(config().limits.frameLease).toBe(10);
		expect(() => config({}, { frameLease: 21 })).toThrow(ConfigError);
		expect(() => config({}, { frameLease: 20, framesPerIpMinute: 39 })).toThrow(ConfigError);
	});

	it('bounds the guest-number block', () => {
		expect(config().limits.guestNumberBlock).toBe(10);
		expect(config({ LIMIT_GUEST_NUMBER_BLOCK: '1000' }).limits.guestNumberBlock).toBe(1_000);
		expect(config({}, { guestNumberBlock: 10_000 }).limits.guestNumberBlock).toBe(10_000);
		expect(() => config({}, { guestNumberBlock: 10_001 })).toThrow(ConfigError);
		expect(() => config({ LIMIT_GUEST_NUMBER_BLOCK: '0' })).toThrow(ConfigError);
	});

	it('allows arbitrary guest origins with an explicit passkey allowlist', () => {
		const open = config({ ALLOWED_ORIGINS: '*', RP_ORIGINS: 'https://web.apron.chat', RP_ID: 'apron.chat' });
		for (const origin of ['http://localhost:1234', 'http://127.0.0.1:9876', 'http://[::1]:3000', 'http://192.168.1.2:8080', 'https://custom.example', 'null', null]) {
			expect(isAllowedOrigin(open, origin)).toBe(true);
		}
		expect(open.rpOrigins).toEqual(['https://web.apron.chat']);
		expect(() => config({ ALLOWED_ORIGINS: '*' })).toThrow(ConfigError);
		expect(() => config({ ALLOWED_ORIGINS: '*', RP_ORIGINS: '*' })).toThrow(ConfigError);
		expect(() => config({ ALLOWED_ORIGINS: '*,http://localhost:5173', RP_ORIGINS: 'http://localhost:5173' })).toThrow(ConfigError);
		expect(() => config({ ALLOWED_ORIGINS: '*', RP_ORIGINS: 'https://unrelated.example', RP_ID: 'apron.chat' })).toThrow(ConfigError);
		const restricted = config();
		expect(isAllowedOrigin(restricted, 'http://localhost:5173')).toBe(true);
		expect(isAllowedOrigin(restricted, null)).toBe(true);
		expect(isAllowedOrigin(restricted, 'https://custom.example')).toBe(false);
		expect(isAllowedOrigin(restricted, 'null')).toBe(false);
	});

	it('requires exact origins and bounds the browser display name', () => {
		expect(() => loadConfig({})).toThrow(ConfigError);
		expect(config({ ENVIRONMENT: 'development' }).allowedOrigins).toEqual([
			'http://localhost:5173',
			'http://localhost:8787',
		]);
		expect(() => config({
			ALLOWED_ORIGINS: 'https://chat.example.test/',
			RP_ORIGINS: 'https://chat.example.test/',
			RP_ID: 'example.test',
		})).toThrow(ConfigError);
		expect(() => config({
			ALLOWED_ORIGINS: 'https://chat.example.test',
			RP_ORIGINS: 'https://other.example.test',
			RP_ID: 'example.test',
		})).toThrow(ConfigError);
		expect(() => config({ RP_NAME: 'x'.repeat(DEFAULT_LIMITS.maxNameCodePoints + 1) })).toThrow(ConfigError);
	});
});
