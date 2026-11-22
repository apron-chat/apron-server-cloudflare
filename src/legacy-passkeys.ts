/*
 * TEMPORARY: REMOVE AFTER 2026-12-22.
 *
 * Passkeys made for production's old RP ID, `apron.chat`, before it moved to
 * the server's own host, `server.apron.chat`, on 2026-11-22 (LEGACY_RP_ID).
 * For 30 days the passkey page still signs in with them ("Use one made for
 * apron.chat"), and then offers a passkey for the new RP ID, added to the
 * account at once. Clients' own ceremonies never use the old RP ID.
 *
 * Everything this needs is here, but for a few call sites marked
 * `LEGACY_RP_ID` elsewhere. To remove it:
 *   1. delete this file and test/legacy-passkeys.integration.test.ts;
 *   2. `grep -rn LEGACY_RP_ID src test docs SPEC.md wrangler*.toml worker-configuration.d.ts`
 *      and delete each marked line or block, keeping what its comment says to keep
 *      (in docs, everything from a `LEGACY_RP_ID begin` comment to its `end LEGACY_RP_ID`);
 *   3. delete the `backups/apron.chat-*` objects in the apron-history bucket
 *      (no longer pruned since history is named by the server's host).
 * Accounts that never signed in with a new passkey by then sign in another
 * way, such as with a device token.
 */
import type { StoredCredential } from "./domain";

/** The date after which this module and its call sites go. */
export const LEGACY_PASSKEYS_REMOVE_AFTER = "2026-12-22";

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

/** How long the page offers the upgrade after a legacy sign-in; the sign-in's code is issued when it ends. */
export const UPGRADE_TTL_MS = 10 * 60_000;
const UPGRADE_KEY_PREFIX = "signin-upgrade:";

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
 * upgrade ends (finishUpgrade, skipUpgrade), so the code's 5 minutes start then.
 */
export interface StoredUpgrade extends UpgradeBinding {
	v: 1;
	userId: string;
	userHandle: string;
	/** The sign-in code's record, without its expiry. */
	code: Record<string, unknown>;
	expiresMs: number;
}

/** The Durable Object's side, which this module's upgrade uses. */
export interface LegacyPort {
	/** The account, with whether it may take another passkey (not `admin` or a bot, and under the cap). */
	account(userId: string): { name: string; userHandle?: string; passkeys: string[]; mayAddPasskey: boolean } | undefined;
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
function upgradable(account: ReturnType<LegacyPort["account"]>, userHandle?: string): account is NonNullable<ReturnType<LegacyPort["account"]>> & { userHandle: string } {
	return !!account?.userHandle && account.mayAddPasskey && (userHandle === undefined || account.userHandle === userHandle);
}

/**
 * After a sign-in with a legacy passkey: an upgrade's token, holding the
 * sign-in's code record, where the account may take another passkey; else
 * undefined, and the caller issues the code at once.
 */
export async function offerUpgrade(port: LegacyPort, userId: string, code: Record<string, unknown>, binding: UpgradeBinding, now: number): Promise<string | undefined> {
	const account = port.account(userId);
	if (!upgradable(account)) return undefined;
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const token = `up_${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
	await port.put(await upgradeKey(token), { v: 1, ...binding, userId, userHandle: account.userHandle, code, expiresMs: now + UPGRADE_TTL_MS });
	return token;
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
	return { key, userId: record.userId, name: account.name, userHandle: record.userHandle, existing: account.passkeys };
}

/**
 * An upgrade's finish, its passkey verified: the upgrade is used up, the
 * passkey added to the account at once (the person just proved the account
 * on this page) under the user handle it began with, the account's
 * connections told, and the sign-in's code issued. A passkey that cannot be
 * added still lets the sign-in go back to the client.
 */
export async function finishUpgrade(port: LegacyPort, key: string, created: { userId: string; userHandle: string; credential: StoredCredential } | undefined, origin: string, input: { now: number; ipKey: string }):
	Promise<{ status: number; body: Record<string, unknown> }> {
	const record = await port.take(key);
	if (record?.v !== 1 || !(record.expiresMs > input.now) || record.origin !== origin) return { status: 400, body: { error: "This sign-in expired. Start again from the app." } };
	let added = false;
	if (created && created.userId === record.userId && created.userHandle === record.userHandle && upgradable(port.account(record.userId), record.userHandle)) {
		try {
			port.addPasskey({ userId: record.userId, userHandle: record.userHandle, credential: created.credential, ...input });
			added = true;
		} catch { /* the sign-in still goes back */ }
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

/**
 * The passkey page's additions on a sign-in screen: the link to sign in
 * with a legacy passkey, the screen offered after one (hidden until then),
 * and the script that runs both. The script uses the page's own helpers
 * (src/sign-in-page.ts SCRIPT: config, $, status, busy, post, the option
 * parsers and credentialJson), which a later classic script shares.
 */
export function legacyPageParts(view: { legacyRpId: string; host: string; title: string }, escape: (text: string) => string, paths: { begin: string; finish: string }, nonce: string): { link: string; screen: string; script: string } {
	const e = escape;
	return {
		link: `<p class="muted switch" data-legacy-link>Passkey not listed? <button type="button" class="link" data-legacy="legacy">Use one made for ${e(view.legacyRpId)}</button></p>`,
		screen: `<div id="upgrade" hidden>
<h1>Add a passkey for ${e(view.host)}</h1>
<p>You signed in with a passkey made for <strong>${e(view.legacyRpId)}</strong>. ${e(view.title)} now uses passkeys made for <strong>${e(view.host)}</strong>: create one now to keep signing in.</p>
<div class="actions"><button type="button" class="primary" data-legacy="upgrade">Create passkey</button><button type="button" data-skip>Not now</button></div>
</div>`,
		script: `<script nonce="${nonce}">${legacyScript(paths)}</script>`,
	};
}

function legacyScript(paths: { begin: string; finish: string }): string {
	return `
"use strict";
{
// After a sign-in with a legacy passkey: the token that adds a new one, and then issues the sign-in's code.
let upgrade = null;
let ready = null;
async function begin(kind) {
	const body = kind === "legacy" ? { action: "login", legacy: true } : { upgrade };
	const result = await post(${JSON.stringify(paths.begin)}, { page: config.page, query: config.query, ...body });
	if (result.error) { status(result.error); return null; }
	return result;
}
function prepareUpgrade() {
	ready = null;
	begin("upgrade").then((options) => { if (options && upgrade) ready = { kind: "upgrade", options }; });
}
async function run(kind) {
	status("");
	if (!window.PublicKeyCredential || !navigator.credentials) { status("This browser cannot use passkeys."); return; }
	busy(true);
	const options = ready && ready.kind === kind ? ready.options : await begin(kind);
	ready = null;
	if (!options) { busy(false); return; }
	let credential;
	try {
		credential = kind === "legacy"
			? await navigator.credentials.get({ publicKey: requestOptions(options.public_key) })
			: await navigator.credentials.create({ publicKey: creationOptions(options.public_key) });
	} catch (error) {
		busy(false);
		status(error && error.name === "NotAllowedError" ? "No passkey was used. Try again when you're ready." : "Your browser could not use a passkey" + (error && error.message ? ": " + error.message : "."));
		if (kind === "upgrade") prepareUpgrade();
		return;
	}
	const result = await post(${JSON.stringify(paths.finish)}, { challenge_id: options.challenge_id, credential: credentialJson(credential) });
	// An upgrade's answer carries the sign-in's code even when its passkey could not be added.
	if (result.redirect) { location.assign(result.redirect); return; }
	if (result.error || !result.upgrade) { busy(false); status(result.error || "Something went wrong. Try again."); if (kind === "upgrade") prepareUpgrade(); return; }
	upgrade = result.upgrade;
	const screen = $("upgrade");
	for (const element of screen.parentElement.children) if (element !== screen && element.id !== "status") element.hidden = true;
	screen.hidden = false;
	busy(false);
	prepareUpgrade();
}
for (const button of document.querySelectorAll("[data-legacy]")) button.addEventListener("click", () => run(button.dataset.legacy));
for (const button of document.querySelectorAll("[data-skip]")) button.addEventListener("click", async () => {
	busy(true);
	const result = await post(${JSON.stringify(paths.finish)}, { skip: true, upgrade });
	if (result.redirect) { location.assign(result.redirect); return; }
	busy(false);
	status(result.error || "Something went wrong. Try again.");
});
}
`;
}
