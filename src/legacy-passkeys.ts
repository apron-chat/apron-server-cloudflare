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
 *      and delete each marked line or block, keeping what its comment says to keep;
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
 * (`upgrade`, a `request` handle). Undefined for a begin that asks
 * neither; `refused` for one that cannot have what it asks.
 */
export function legacyBegin(body: Record<string, unknown>, legacyRpId: string | undefined, action: "register" | "login", hasRequest: boolean):
	undefined | "refused" | { legacy: true } | { upgrade: string } {
	if (body.legacy === undefined && body.upgrade === undefined) return undefined;
	const upgrade = typeof body.upgrade === "string" && /^rq_[A-Za-z0-9_-]{43}$/.test(body.upgrade) ? body.upgrade : undefined;
	if (!legacyRpId || action !== "login" || hasRequest) return "refused";
	if (body.legacy === true && body.upgrade === undefined) return { legacy: true };
	if (upgrade && body.legacy === undefined) return { upgrade };
	return "refused";
}

/** The account side the Durable Object gives this module. */
export interface LegacyAccounts {
	/** The account's WebAuthn user handle, if it is an account. */
	userHandle(userId: string): string | undefined;
	/** Whether the account may take another passkey. */
	roomForPasskey(userId: string): boolean;
	/** An addition's `request` handle for the account, which the page's upgrade begin names. */
	requestHandle(userId: string, userHandle: string, now: number): Promise<string>;
	addPasskey(input: { userId: string; userHandle: string; credential: StoredCredential; now: number; ipKey: string }): void;
}

/**
 * After a sign-in with a legacy passkey, the handle the page's upgrade
 * begins with, where the account may still take a passkey; else undefined.
 */
export async function upgradeHandle(accounts: LegacyAccounts, userId: string, now: number): Promise<string | undefined> {
	const userHandle = accounts.userHandle(userId);
	if (!userHandle || !accounts.roomForPasskey(userId)) return undefined;
	return await accounts.requestHandle(userId, userHandle, now);
}

/**
 * An upgrade's finish: the new passkey added to the account at once, since
 * the person just proved the account on this page, under the user handle
 * it began with (`/invite-purge` may have cleared it meanwhile, and a new
 * passkey must not bring it back). The page's answer.
 */
export function addUpgradePasskey(
	accounts: LegacyAccounts,
	created: { userId: string; userHandle: string; credential: StoredCredential } | undefined,
	addsUserId: string | undefined,
	input: { now: number; ipKey: string },
): { added: true } | { error: string } {
	if (!created || created.userId !== addsUserId || accounts.userHandle(created.userId) !== created.userHandle) {
		return { error: "Your account changed. Sign in again to add a passkey." };
	}
	accounts.addPasskey({ userId: created.userId, userHandle: created.userHandle, credential: created.credential, ...input });
	return { added: true };
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
// After a sign-in with a legacy passkey: where to go back to, and the handle that adds a new one.
let upgrade = null;
let ready = null;
async function begin(kind) {
	const body = kind === "legacy" ? { action: "login", legacy: true } : { upgrade: upgrade.handle };
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
	if (result.error) { busy(false); status(result.error); if (kind === "upgrade") prepareUpgrade(); return; }
	if (kind === "upgrade" || !result.upgrade) { location.assign(kind === "upgrade" ? upgrade.redirect : result.redirect); return; }
	upgrade = { redirect: result.redirect, handle: result.upgrade };
	const screen = $("upgrade");
	for (const element of screen.parentElement.children) if (element !== screen && element.id !== "status") element.hidden = true;
	screen.hidden = false;
	busy(false);
	prepareUpgrade();
}
for (const button of document.querySelectorAll("[data-legacy]")) button.addEventListener("click", () => run(button.dataset.legacy));
for (const button of document.querySelectorAll("[data-skip]")) button.addEventListener("click", () => { busy(true); location.assign(upgrade.redirect); });
}
`;
}
