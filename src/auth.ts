import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
	type WebAuthnCredential,
} from "@simplewebauthn/server";
import type { RuntimeConfig } from "./config";
import type { Identity, StoredCredential } from "./domain";
import { legacyRpIdAllowed } from "./legacy-passkeys";
import { clientDataFramed, PAGE_CHALLENGE_TTL_MS, PAGE_PREPARED_FRESH_MS, pageOriginServes } from "./oauth";

type WebAuthnAction = "register" | "login";

export interface ChallengeRecord {
	challengeId: string;
	action: WebAuthnAction;
	challenge: string;
	origin: string;
	rpId: string;
	/** Connection and proposed identity bindings are checked again at finish. */
	connectionId?: string;
	identityUserId?: string | null;
	userId?: string;
	userHandle?: string;
	userName?: string;
	/** A registration that adds a passkey to the signed-in identity (§4.10), which is `userId`. */
	adds?: boolean;
	/**
	 * A ceremony on the passkey page (protocol §4.10.1): `origin` is
	 * the server's own, under the RP ID, rather than one of `RP_ORIGINS`, and
	 * client data from a frame on another site is refused.
	 */
	page?: boolean;
	expiresAt: number;
}

export interface CredentialRepository {
	getCredential(credentialId: string): StoredCredential | null | Promise<StoredCredential | null>;
	getIdentity?(userId: string): Identity | null | Promise<Identity | null>;
	registerCredential(input: {
		userId: string;
		name: string;
		userHandle: string;
		credential: StoredCredential;
		ipKey: string;
		now: number;
		/** Add the passkey to `userId`, the identity signed in on this connection, rather than create one (§4.10). */
		adds?: boolean;
	}): Identity | Promise<Identity>;
	updateCredentialCounter(credentialId: string, counter: number): void | Promise<void>;
}

interface AuthIdentity extends Identity {
	tier: "registered";
}

interface BeginResult {
	challenge: ChallengeRecord;
	publicKey: Record<string, unknown>;
}

interface FinishResult {
	identity: AuthIdentity;
	credential?: StoredCredential;
}

/**
 * A ceremony failure is deliberately indistinguishable from a missing or
 * unusable credential at the protocol boundary.  In particular, the
 * SimpleWebAuthn verifier may throw for malformed client data or a bad
 * signature rather than returning `{ verified: false }`.
 */
export class AuthError extends Error {
	constructor(message = "Passkey verification failed") {
		super(message);
		this.name = "denied";
	}
}

/**
 * A login whose passkey no account here has (its lookup found none). It is
 * an AuthError, and answers as one everywhere; only the passkey page tells
 * it apart, so the device can drop the passkey (signalUnknownCredential).
 * Without a key the assertion cannot be verified, so it is thrown only for
 * one whose unsigned fields name this ceremony (assertionAddressed), which a
 * forger can match; `credentialId` is the assertion's own.
 */
export class UnknownCredentialError extends AuthError {
	constructor(readonly credentialId: string) {
		super();
	}
}

export class AuthTooLargeError extends AuthError {
	constructor(message = "Passkey credential is too large") {
		super(message);
		this.name = "too_large";
	}
}

function randomBase64Url(bytes = 24): string {
	const raw = new Uint8Array(bytes);
	crypto.getRandomValues(raw);
	let binary = "";
	for (const byte of raw) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Longest name part of a `user_id` picked from a requested name. */
const USER_ID_SLUG_CHARS = 16;
/** Tries at a `<slug>_<4 digits>` id before falling back to a random one. */
const USER_ID_SLUG_ATTEMPTS = 8;

/**
 * The `user_id` part a requested name suggests: lowercase ASCII letters and
 * digits, other runs as one `_`, at most 16 characters. Empty when nothing
 * usable is left or when it would pass for a guest (`guest_<n>`) or a bot
 * (`bot_…`), whose prefixes name those kinds of user.
 */
export function userIdSlug(name: string): string {
	const slug = name.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()
		.replace(/[^a-z0-9]+/g, "_").replace(/^_+/, "").slice(0, USER_ID_SLUG_CHARS).replace(/_+$/, "");
	return /^(guest|bot)(_|$)/.test(slug) ? "" : slug;
}

function randomDigits(count: number): string {
	const raw = new Uint32Array(count);
	crypto.getRandomValues(raw);
	return Array.from(raw, (value) => String(value % 10)).join("");
}

/** The name of a new account that asks for none: not "Guest", which names guests. */
export const MEMBER_NAME = "Member";

/**
 * A new registered `user_id`: `<slug>_<4 random digits>` for a requested name
 * (`Foo` → `foo_1234`), retried while taken, else `u_` plus 16 random bytes.
 */
export function candidateUserIdFor(name: string | undefined, taken: (userId: string) => boolean): string {
	const slug = name === undefined ? "" : userIdSlug(name);
	if (slug) {
		for (let attempt = 0; attempt < USER_ID_SLUG_ATTEMPTS; attempt += 1) {
			const userId = `${slug}_${randomDigits(4)}`;
			if (!taken(userId)) return userId;
		}
	}
	return `u_${randomBase64Url(16)}`;
}

/** Unpadded base64url of at most `maxLength` characters (a credential ID's 1024 by default), decoded. */
function base64UrlToBytes(value: string, maxLength = 1024): Uint8Array<ArrayBuffer> {
	if (value.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("base64url value is malformed");
	const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function bytesToBase64Url(value: Uint8Array): string {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function serializedBytes(value: unknown): number {
	const serialized = JSON.stringify(value);
	return serialized === undefined ? Number.POSITIVE_INFINITY : new TextEncoder().encode(serialized).byteLength;
}

function normalizedCredentialId(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 1024) throw new Error("credential id is invalid");
	if (bytesToBase64Url(base64UrlToBytes(value)) !== value) throw new Error("credential id is not canonical");
	return value;
}

function asCredentialResponse(value: unknown, maxBytes: number): RegistrationResponseJSON | AuthenticationResponseJSON {
	if (!isObject(value) || value.type !== "public-key") throw new AuthError("Passkey credential is invalid");
	const id = normalizedCredentialId(value.id);
	if (typeof value.rawId !== "string") throw new AuthError("Passkey credential is invalid");
	// The browser adapter serializes ArrayBuffers to base64url strings. Keep
	// rawId bounded and syntactically valid before handing it to the verifier.
	normalizedCredentialId(value.rawId);
	if (value.rawId !== id) throw new AuthError("Passkey credential is invalid");
	if (!isObject(value.response)) throw new AuthError("Passkey credential is invalid");
	if (serializedBytes(value) > maxBytes) throw new AuthTooLargeError();
	return { ...value, id } as RegistrationResponseJSON | AuthenticationResponseJSON;
}

/**
 * Discoverability is enforced by `residentKey: "required"` in the creation
 * options: a conforming client fails the ceremony rather than mint a
 * non-discoverable credential. The `credProps` extension output is optional
 * and many clients (Android, several password managers) omit it or leave
 * `rk` unset, so only an explicit `rk: false` is treated as a refusal.
 */
function reportsNonDiscoverableCredential(response: RegistrationResponseJSON | AuthenticationResponseJSON): boolean {
	if (!isObject(response.clientExtensionResults) || !isObject(response.clientExtensionResults.credProps)) return false;
	return response.clientExtensionResults.credProps.rk === false;
}

/**
 * Whether an assertion's unsigned fields name this ceremony: client data of
 * type `webauthn.get` with its challenge and origin, and authenticator data
 * for its RP ID. Nothing here is verified, since a passkey no account has
 * gives no key to check a signature with: it only keeps an honest assertion
 * meant for another ceremony, origin or RP ID from being called unknown, and
 * says nothing about one forged to match. Anything unreadable is not
 * addressed. Fields are bounded by `maxLength`, the credential's own limit.
 */
async function assertionAddressed(response: AuthenticationResponseJSON, challenge: ChallengeRecord, maxLength: number): Promise<boolean> {
	try {
		const data = JSON.parse(new TextDecoder().decode(base64UrlToBytes(response.response.clientDataJSON, maxLength))) as Record<string, unknown>;
		if (data.type !== "webauthn.get" || data.challenge !== challenge.challenge || data.origin !== challenge.origin) return false;
		const authenticatorData = base64UrlToBytes(response.response.authenticatorData, maxLength);
		const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(challenge.rpId)));
		return authenticatorData.length >= 37 && rpIdHash.every((byte, index) => authenticatorData[index] === byte);
	} catch {
		return false;
	}
}

function toWebAuthnCredential(record: StoredCredential): WebAuthnCredential {
	return {
		id: record.credentialId,
		publicKey: base64UrlToBytes(record.publicKey),
		counter: record.counter,
		transports: record.transports,
	};
}

function identityWithTier(identity: Identity): AuthIdentity {
	return { user_id: identity.user_id, ...(identity.name ? { name: identity.name } : {}), tier: "registered" };
}

/** A bounded, stateless WebAuthn ceremony helper. Durable identity writes stay in the store. */
export class WebAuthnService {
	constructor(private readonly config: RuntimeConfig) {}

	/** A ceremony's origin: one of `RP_ORIGINS`, or for the passkey page the server's own origin under the RP ID. */
	private originAllowed(origin: string, page: boolean): boolean {
		return page ? this.config.passkeyPage && pageOriginServes(origin, this.config.rpId) : this.config.rpOrigins.includes(origin);
	}

	/** Whether a ceremony may be for `rpId`: the RP ID, or LEGACY_RP_ID for a sign-in on the passkey page. */
	private rpIdAllowed(rpId: string, action: WebAuthnAction, page: boolean): boolean {
		return rpId === this.config.rpId || legacyRpIdAllowed(this.config.legacyRpId, rpId, action, page);
	}

	async begin(
		action: WebAuthnAction,
		origin: string,
		now: number,
		identity?: Identity,
		existingCredentialIds: string[] = [],
		connectionId?: string,
		/**
		 * `adds`: the registration adds a passkey to `identity`, which is signed
		 * in (§4.10), under its WebAuthn user handle when it has one, so an
		 * authenticator replaces rather than duplicates its passkey for it.
		 */
		registration: { name?: string; userIdTaken?: (userId: string) => boolean; adds?: { userHandle?: string } } = {},
		/**
		 * `page`: a ceremony on the passkey page, on the server's own origin.
		 * `legacy`: a sign-in there with a passkey for LEGACY_RP_ID (src/legacy-passkeys.ts).
		 */
		ceremony: { page?: boolean; legacy?: boolean } = {},
	): Promise<BeginResult> {
		if (!this.originAllowed(origin, ceremony.page === true)) throw new Error("origin is not configured for passkeys");
		const rpId = ceremony.legacy ? this.config.legacyRpId : this.config.rpId;
		if (rpId === undefined || !this.rpIdAllowed(rpId, action, ceremony.page === true)) throw new Error("passkeys for that RP ID are not taken here");
		const adds = action === "register" && identity?.tier === "registered" && registration.adds !== undefined;
		if (action === "register" && identity?.tier === "registered" && !adds) throw new Error("identity switching requires reconnect");
		const challengeId = randomBase64Url(18);
		const challenge = randomBase64Url(32);
		// A new account without a requested name (or a guest's to keep) is a
		// "Member", as an invite's sign-up is (not "Guest", which names
		// guests), and its `user_id` comes from its name (a guest's gives `u_…`).
		const candidateName = action !== "register" ? undefined
			: adds ? (identity!.name || identity!.user_id)
			: (registration.name ?? identity?.name ?? MEMBER_NAME);
		const candidateUserId = action !== "register" ? undefined
			: adds ? identity!.user_id : candidateUserIdFor(candidateName, registration.userIdTaken ?? (() => false));
		const candidateUserHandle = action !== "register" ? undefined
			: adds && registration.adds?.userHandle ? registration.adds.userHandle : randomBase64Url(16);
		const options = action === "register"
			? await generateRegistrationOptions({
				rpName: this.config.rpName,
				rpID: this.config.rpId,
				userName: candidateUserId!,
				userDisplayName: candidateName!.slice(0, 80),
				userID: base64UrlToBytes(candidateUserHandle!),
				challenge,
				attestationType: "none",
				// ES256 first: an authenticator takes the first algorithm it supports, and
				// ES256 is the one every authenticator can sign with. SimpleWebAuthn's default
				// puts EdDSA first, so a passkey manager that creates Ed25519 keys on one device
				// may be unable to sign with them on another running an older build (Proton
				// Pass before its August 2026 update fails with CTAP2 0x26, unsupported
				// algorithm). Verification accepts all three either way.
				supportedAlgorithmIDs: [-7, -8, -257],
				authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
				excludeCredentials: existingCredentialIds.slice(0, 10).map((id) => ({ id })),
				timeout: this.config.limits.challengeTtlSeconds * 1_000,
			})
			: await generateAuthenticationOptions({
				rpID: rpId,
				challenge,
				userVerification: "required",
				timeout: this.config.limits.challengeTtlSeconds * 1_000,
			});
		if (serializedBytes(options) > this.config.limits.maxChallengeBytes) throw new Error("generated passkey options are too large");
		return {
			challenge: {
				challengeId,
				action,
				challenge: options.challenge,
				origin,
				rpId,
				...(connectionId ? { connectionId } : {}),
				...(action === "register" ? { identityUserId: identity?.user_id ?? null } : {}),
				...(candidateUserId ? { userId: candidateUserId, userHandle: candidateUserHandle, userName: candidateName } : {}),
				...(adds ? { adds: true } : {}),
				...(ceremony.page ? { page: true } : {}),
				// A sign-in page's lasts longer, from before its tap (PAGE_CHALLENGE_TTL_MS), and always
				// long enough for the browser's whole timeout after the page last uses one it holds.
				expiresAt: now + (ceremony.page
					? Math.max(PAGE_CHALLENGE_TTL_MS, PAGE_PREPARED_FRESH_MS + this.config.limits.challengeTtlSeconds * 1_000 + 60_000)
					: this.config.limits.challengeTtlSeconds * 1_000),
			},
			publicKey: options as unknown as Record<string, unknown>,
		};
	}

	async finish(
		challenge: ChallengeRecord,
		challengeId: string,
		credentialValue: unknown,
		repository: CredentialRepository,
		input: { now: number; ipKey: string; identity?: Identity; connectionId?: string },
	): Promise<FinishResult> {
		if (challenge.challengeId !== challengeId || input.now >= challenge.expiresAt) throw new AuthError("Passkey challenge is missing or expired");
		if (challenge.connectionId !== undefined && challenge.connectionId !== input.connectionId) throw new AuthError("Passkey challenge is bound to another connection");
		if (Object.hasOwn(challenge, "identityUserId") && challenge.identityUserId !== (input.identity?.user_id ?? null)) throw new AuthError("Passkey registration identity changed");
		if (challenge.origin.length === 0 || !this.originAllowed(challenge.origin, challenge.page === true) || !this.rpIdAllowed(challenge.rpId, challenge.action, challenge.page === true)) {
			throw new AuthError("Passkey challenge binding is invalid");
		}
		if (serializedBytes(credentialValue) > this.config.limits.maxCredentialBytes) throw new AuthTooLargeError();
		// The page refuses to be framed, and so refuses a ceremony that a frame on another site ran (WebAuthn Level 3 §13.4.9).
		if (challenge.page && clientDataFramed(credentialValue)) throw new AuthError("Passkey ceremony ran in a frame");
		let response: RegistrationResponseJSON | AuthenticationResponseJSON;
		try {
			response = asCredentialResponse(credentialValue, this.config.limits.maxCredentialBytes);
		} catch (error) {
			if (error instanceof AuthError) throw error;
			throw new AuthError("Passkey credential is invalid");
		}
		if (challenge.action === "register") {
			if (reportsNonDiscoverableCredential(response as RegistrationResponseJSON)) throw new AuthError("Passkey registration requires a discoverable credential");
			if (!challenge.userId || !challenge.userHandle || !challenge.userName) throw new AuthError("Passkey registration challenge is incomplete");
			let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
			try {
				verified = await verifyRegistrationResponse({
					response: response as RegistrationResponseJSON,
					expectedChallenge: challenge.challenge,
					expectedOrigin: challenge.origin,
					expectedRPID: challenge.rpId,
					requireUserPresence: true,
					requireUserVerification: true,
				});
			} catch {
				throw new AuthError();
			}
			if (!verified.verified || !verified.registrationInfo?.userVerified) throw new AuthError();
			const info = verified.registrationInfo;
			const credentialId = typeof info.credential.id === "string" ? info.credential.id : bytesToBase64Url(info.credential.id);
			const userId = challenge.userId;
			const stored = await repository.registerCredential({
				userId,
				name: challenge.userName,
				userHandle: challenge.userHandle,
				credential: {
					credentialId,
					userId,
					publicKey: bytesToBase64Url(info.credential.publicKey),
					counter: info.credential.counter,
					deviceType: info.credentialDeviceType,
					backedUp: info.credentialBackedUp,
				},
				ipKey: input.ipKey,
				now: input.now,
				...(challenge.adds ? { adds: true } : {}),
			});
			return { identity: identityWithTier(stored) };
		}
		const credentialId = normalizedCredentialId((response as AuthenticationResponseJSON).id);
		const stored = await repository.getCredential(credentialId);
		if (stored === null && await assertionAddressed(response as AuthenticationResponseJSON, challenge, this.config.limits.maxCredentialBytes)) throw new UnknownCredentialError(credentialId);
		if (!stored) throw new AuthError();
		let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
		try {
			verified = await verifyAuthenticationResponse({
				response: response as AuthenticationResponseJSON,
				expectedChallenge: challenge.challenge,
				expectedOrigin: challenge.origin,
				expectedRPID: challenge.rpId,
				credential: toWebAuthnCredential(stored),
				requireUserVerification: true,
			});
		} catch {
			throw new AuthError();
		}
		if (!verified.verified || !verified.authenticationInfo.userVerified) throw new AuthError();
		const newCounter = verified.authenticationInfo.newCounter;
		// Synced passkeys may legitimately report zero/non-monotonic counters;
		// only persist a forward movement and leave the verifier's signature/UV
		// checks as the authenticity proof.
		if (newCounter > stored.counter) await repository.updateCredentialCounter(credentialId, newCounter);
		const identity = await repository.getIdentity?.(stored.userId) ?? { user_id: stored.userId };
		return {
			identity: identityWithTier(identity),
			credential: { ...stored, counter: Math.max(stored.counter, newCounter) },
		};
	}
}
