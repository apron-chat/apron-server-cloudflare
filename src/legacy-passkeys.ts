/*
 * A previous RP ID (LEGACY_RP_ID), such as production's `apron.chat` before
 * its RP ID became the server's own host, `server.apron.chat`. New passkeys
 * are made for RP_ID; passkeys made for the previous one keep working:
 *   - the passkey page's "Continue with passkey" finds either kind without
 *     asking which (src/legacy-passkeys-page.ts): it asks the device for the
 *     kind it last signed in with there, else the previous one, and the next
 *     tap for the other;
 *   - after a sign-in with an old one, it offers "Save a new passkey", added
 *     to the account at once ("Not now" skips it), unless the account
 *     already has one made since (`since`).
 * Only the passkey page takes the previous RP ID, for sign-ins only;
 * clients' own ceremonies and every new passkey use RP_ID. An old passkey
 * is one made before this server first ran with LEGACY_RP_ID (`since`).
 */
import type { StoredCredential } from "./domain";

/**
 * `LEGACY_RP_ID`: unset or empty for none, else a host name that `rpId` is
 * under (not `rpId` itself), so the passkey page, on `rpId` or a host under
 * it, may run ceremonies for it. Only the passkey page uses it, so it needs
 * `PASSKEY_PAGE`. An `error` is a ConfigError's message.
 */
export function loadLegacyRpId(value: string | undefined, rpId: string, passkeyPage: boolean): { legacyRpId?: string; error?: string } {
	const legacy = String(value ?? "").trim().toLowerCase();
	if (!legacy) return {};
	if (legacy.includes("://") || legacy.includes("/") || legacy.includes(" ")) return { error: "LEGACY_RP_ID must be a host name" };
	if (!rpId.endsWith(`.${legacy}`)) return { error: "LEGACY_RP_ID must be a domain RP_ID is under, such as apron.chat for server.apron.chat" };
	if (!passkeyPage) return { error: "LEGACY_RP_ID needs PASSKEY_PAGE, whose page signs in with its passkeys" };
	return { legacyRpId: legacy };
}

/** Whether a ceremony may be for the legacy RP ID: only a sign-in, only on the passkey page. */
export function legacyRpIdAllowed(legacyRpId: string | undefined, rpId: string, action: "register" | "login", page: boolean): boolean {
	return page && action === "login" && legacyRpId !== undefined && rpId === legacyRpId;
}

/**
 * What a passkey page begin asks of this module: a sign-in with a legacy
 * passkey (`legacy: true`), or after one, an addition for the new RP ID
 * (`upgrade`, the token that sign-in gave). Undefined for a begin that asks
 * neither; `refused` for one that cannot have what it asks.
 */
export function legacyBegin(body: Record<string, unknown>, legacyRpId: string | undefined, action: "register" | "login", hasRequest: boolean):
	undefined | "refused" | { legacy: true } | { upgrade: string } {
	if (body.legacy === undefined && body.upgrade === undefined) return undefined;
	if (!legacyRpId || action !== "login" || hasRequest) return "refused";
	if (body.legacy === true && body.upgrade === undefined) return { legacy: true };
	if (validToken(body.upgrade) && body.legacy === undefined) return { upgrade: body.upgrade };
	return "refused";
}

/** How long the page offers the upgrade after a legacy sign-in; a sign-in's code is issued when it ends. */
export const UPGRADE_TTL_MS = 10 * 60_000;
const UPGRADE_KEY_PREFIX = "signin-upgrade:";
/** When this server first ran with LEGACY_RP_ID (ms): an object storage key. */
export const SINCE_KEY = "legacy-rp:since";

function validToken(value: unknown): value is string {
	return typeof value === "string" && /^up_[A-Za-z0-9_-]{43}$/.test(value);
}

/** What binds an upgrade to the page it was offered on: the server's origin, the page, and the client's request. */
export interface UpgradeBinding {
	origin: string;
	page: string;
	request: { clientId: string; redirectUri: string; codeChallenge: string; state: string; resource: string };
}

/**
 * An upgrade, offered after a legacy sign-in: single use, kept under the
 * SHA-256 of its token (`up_…`, never a `request` handle, which addition
 * links carry). It holds the sign-in's code record, issued only when the
 * upgrade ends (finishUpgrade, skipUpgrade), so the code's 5 minutes start
 * then.
 */
export interface StoredUpgrade extends UpgradeBinding {
	v: 1;
	userId: string;
	userHandle: string;
	/** The sign-in code's record, without its expiry. */
	code: Record<string, unknown>;
	expiresMs: number;
}

/** An account as this module sees it. */
export interface LegacyAccount {
	name: string;
	userHandle?: string;
	/** Its passkeys, with when each was made. */
	passkeys: Array<{ credentialId: string; createdMs: number }>;
	/** Not `admin` or a bot, and under the passkey cap. */
	mayAddPasskey: boolean;
}

/** The Durable Object's side, which this module uses. */
export interface LegacyPort {
	account(userId: string): LegacyAccount | undefined;
	/** When this server first ran with LEGACY_RP_ID (SINCE_KEY), recorded on first use; undefined where it cannot be read. */
	since(): Promise<number | undefined>;
	/** Sign-in records (`putSignInRecord`, a read, `takeSignInRecord`), with their expiry index. */
	put(key: string, record: StoredUpgrade): Promise<void>;
	read(key: string): Promise<StoredUpgrade | undefined>;
	take(key: string): Promise<StoredUpgrade | undefined>;
	/** Adds the passkey (Store credentials.add), which throws where the account cannot take it. */
	addPasskey(input: { userId: string; userHandle: string; credential: StoredCredential; now: number; ipKey: string }): void;
	/** Tells the account's connections a passkey was added, so one they did not add can be removed. */
	tellAdded(userId: string): void;
	/** Issues a sign-in code from its record; the redirect back to the client with it. */
	issueCode(code: Record<string, unknown>, origin: string): Promise<string>;
}

async function upgradeKey(token: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
	return UPGRADE_KEY_PREFIX + Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameBinding(record: UpgradeBinding, binding: UpgradeBinding): boolean {
	const a = record.request;
	const b = binding.request;
	return record.origin === binding.origin && record.page === binding.page && a.clientId === b.clientId &&
		a.redirectUri === b.redirectUri && a.codeChallenge === b.codeChallenge && a.state === b.state && a.resource === b.resource;
}

/** The account may take a passkey for the new RP ID now, under its user handle (`userHandle`, where given). */
function upgradable(account: LegacyAccount | undefined, userHandle?: string): account is LegacyAccount & { userHandle: string } {
	return !!account?.userHandle && account.mayAddPasskey && (userHandle === undefined || account.userHandle === userHandle);
}

/** When the account's newest passkey for the new RP ID was made, if it has one; undefined while `since` is unknown. */
function newPasskeyMs(account: LegacyAccount, since: number | undefined): number | undefined {
	if (since === undefined) return undefined;
	const made = account.passkeys.filter((passkey) => passkey.createdMs >= since).map((passkey) => passkey.createdMs);
	return made.length ? Math.max(...made) : undefined;
}

function newToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return `up_${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

async function storeUpgrade(port: LegacyPort, account: LegacyAccount & { userHandle: string }, userId: string, binding: UpgradeBinding, now: number, code: Record<string, unknown>): Promise<string> {
	const token = newToken();
	await port.put(await upgradeKey(token), { v: 1, ...binding, userId, userHandle: account.userHandle, code, expiresMs: now + UPGRADE_TTL_MS });
	return token;
}

/**
 * After a sign-in with a legacy passkey on a sign-in screen: an upgrade's
 * token, holding the sign-in's code record, where the account may take
 * another passkey and has none for the new RP ID yet; else undefined, and
 * the caller issues the code at once.
 */
export async function offerUpgrade(port: LegacyPort, userId: string, code: Record<string, unknown>, binding: UpgradeBinding, now: number): Promise<string | undefined> {
	const account = port.account(userId);
	if (!upgradable(account) || newPasskeyMs(account, await port.since()) !== undefined) return undefined;
	return await storeUpgrade(port, account, userId, binding, now, code);
}

/**
 * An upgrade's begin, on the page it was offered on: the addition it is
 * (the account, under its user handle then, and the passkeys to exclude),
 * and the key its finish takes; else undefined.
 */
export async function beginUpgrade(port: LegacyPort, token: string, binding: UpgradeBinding, now: number):
	Promise<{ key: string; userId: string; name: string; userHandle: string; existing: string[] } | undefined> {
	const key = await upgradeKey(token);
	const record = await port.read(key);
	if (record?.v !== 1 || !(record.expiresMs > now) || !sameBinding(record, binding)) return undefined;
	const account = port.account(record.userId);
	if (!upgradable(account, record.userHandle)) return undefined;
	return { key, userId: record.userId, name: account.name, userHandle: record.userHandle, existing: account.passkeys.map((passkey) => passkey.credentialId) };
}

/**
 * An upgrade's finish, its passkey verified: the upgrade is used up, the
 * passkey added to the account at once (the person just proved the account
 * on this page) under the user handle it began with, the account's
 * connections told, and the sign-in's code issued: a passkey that cannot be
 * added still lets the sign-in go back to the client.
 */
export async function finishUpgrade(port: LegacyPort, key: string, created: { userId: string; userHandle: string; credential: StoredCredential } | undefined, origin: string, input: { now: number; ipKey: string }):
	Promise<{ status: number; body: Record<string, unknown> }> {
	const record = await port.take(key);
	if (record?.v !== 1 || !(record.expiresMs > input.now) || record.origin !== origin) return { status: 400, body: { error: "This page expired. Start again." } };
	let added = false;
	if (created && created.userId === record.userId && created.userHandle === record.userHandle && upgradable(port.account(record.userId), record.userHandle)) {
		try {
			port.addPasskey({ userId: record.userId, userHandle: record.userHandle, credential: created.credential, ...input });
			added = true;
		} catch { /* below */ }
	}
	if (added) port.tellAdded(record.userId);
	return { status: 200, body: { redirect: await port.issueCode(record.code, origin), ...(added ? { added: true } : { error: "The new passkey could not be added." }) } };
}

/** "Not now": the upgrade is used up and the sign-in's code issued. */
export async function skipUpgrade(port: LegacyPort, body: Record<string, unknown>, origin: string, now: number): Promise<{ status: number; body: Record<string, unknown> }> {
	const record = validToken(body.upgrade) ? await port.take(await upgradeKey(body.upgrade)) : undefined;
	if (record?.v !== 1 || !(record.expiresMs > now) || record.origin !== origin) return { status: 400, body: { error: "This sign-in expired. Start again from the app." } };
	return { status: 200, body: { redirect: await port.issueCode(record.code, origin) } };
}
