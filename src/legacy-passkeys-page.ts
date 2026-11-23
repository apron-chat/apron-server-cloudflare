/*
 * TEMPORARY: REMOVE AFTER 2026-12-22, with src/legacy-passkeys.ts (LEGACY_RP_ID).
 *
 * The replace screen (`/passkey?action=replace`): sign in with a passkey made
 * for the legacy RP ID, then make one for this server's own, which is added
 * to the account at once; or learn the account already has one. No client
 * is involved and no code is issued: the person is signed in elsewhere, or
 * signs in as usual afterwards. It runs on the passkey page's routes, under
 * the same headers (pageHeaders), with the same helpers (PAGE_HELPERS).
 */
import { PAGE_BEGIN_PATH, PAGE_FINISH_PATH } from "./oauth";
import { escapeHtml, PAGE_HELPERS, STYLE } from "./sign-in-page";

export interface ReplacePageView {
	/** The server's title ("Apron Demo"), its host ("server.apron.chat"), the legacy RP ID, and the removal date as people read it. */
	title: string;
	host: string;
	legacyRpId: string;
	cutoff: string;
}

/**
 * The script: prepares a sign-in for the legacy RP ID as the page shows (so
 * the tap goes straight to the passkey sheet), runs it, and shows the
 * server's answer (`create`, `already`, `full`); then, with the `upgrade`
 * token, a new passkey for this server's RP ID. A sheet dismissed, or one
 * with no passkey for the legacy RP ID (the browser does not say which),
 * shows `none`.
 */
const SCRIPT = `
"use strict";
${PAGE_HELPERS}
let token = null;
let ready = null;
function show(id) {
	for (const screen of document.querySelectorAll("[data-screen]")) screen.hidden = screen.id !== id;
	status("");
	const heading = document.querySelector("#" + id + " h1");
	if (heading) heading.focus();
}
function fill(result) {
	const account = result.account || {};
	const label = (account.name || account.user_id || "") + (account.user_id && account.name ? " (@" + account.user_id + ")" : "");
	for (const element of document.querySelectorAll("[data-account]")) element.textContent = label;
	if (result.added_at) for (const element of document.querySelectorAll("[data-added]")) element.textContent = new Date(result.added_at).toLocaleDateString(undefined, { day: "numeric", month: "long" });
}
async function begin(kind) {
	const result = await post(${JSON.stringify(PAGE_BEGIN_PATH)}, kind === "old" ? { page: "replace", legacy: true } : { page: "replace", upgrade: token });
	if (result.error) { status(result.error); return null; }
	return result;
}
function prepare(kind) {
	ready = null;
	begin(kind).then((options) => { if (options) ready = { kind, options }; });
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
		credential = kind === "old"
			? await navigator.credentials.get({ publicKey: requestOptions(options.public_key) })
			: await navigator.credentials.create({ publicKey: creationOptions(options.public_key) });
	} catch (error) {
		busy(false);
		const refused = error && error.name === "NotAllowedError";
		if (kind === "old" && refused) show("none");
		else status(refused ? "No passkey was created. Try again when you're ready." : "Your browser could not use a passkey" + (error && error.message ? ": " + error.message : "."));
		prepare(kind);
		return;
	}
	const result = await post(${JSON.stringify(PAGE_FINISH_PATH)}, { challenge_id: options.challenge_id, credential: credentialJson(credential) });
	busy(false);
	if (result.error) { status(result.error); if (kind === "old") prepare("old"); return; }
	if (kind === "new") { show("done"); return; }
	token = result.upgrade || null;
	fill(result);
	show(result.state);
	if (token) prepare("new");
}
for (const button of document.querySelectorAll("[data-run]")) button.addEventListener("click", () => run(button.dataset.run));
for (const button of document.querySelectorAll("[data-show]")) button.addEventListener("click", () => show(button.dataset.show));
prepare("old");
`;

/** The replace screen, every state in the page, the first one shown. */
export function renderReplacePage(view: ReplacePageView, nonce: string): string {
	const e = escapeHtml;
	const host = `<strong>${e(view.host)}</strong>`;
	const legacy = `<strong>${e(view.legacyRpId)}</strong>`;
	const cutoff = e(view.cutoff);
	const screen = (id: string, body: string, shown = false) => `<section id="${id}" data-screen${shown ? "" : " hidden"}>\n${body}\n</section>`;
	const screens = [
		screen("start", `<h1 tabindex="-1">Replace your passkey</h1>
<p>${e(view.title)} now uses passkeys made for ${host}. Passkeys made for ${legacy} stop working after ${cutoff}.</p>
<p class="muted">Use your old passkey once, and your device will make the new one.</p>
<div class="actions"><button type="button" class="primary" data-run="old">Use my ${e(view.legacyRpId)} passkey</button></div>`, true),
		screen("create", `<h1 tabindex="-1">Create your new passkey</h1>
<p>Signed in as <strong data-account></strong>. Your device will save a passkey for ${host}.</p>
<div class="actions"><button type="button" class="primary" data-run="new">Create passkey</button><button type="button" data-show="later">Not now</button></div>`),
		screen("already", `<h1 tabindex="-1">You’re all set</h1>
<p>Your account, <strong data-account></strong>, already has a passkey for ${host}, added on <span data-added></span>.</p>
<p class="muted">If this device doesn’t have it, add one here too.</p>
<div class="actions"><button type="button" class="primary" data-show="close">Done</button><button type="button" data-run="new">Add one for this device</button></div>`),
		screen("full", `<h1 tabindex="-1">No room for another passkey</h1>
<p><strong data-account></strong> already has as many passkeys as an account can hold. Remove one with <code>/passkeys remove</code> in the chat, then come back.</p>`),
		screen("none", `<h1 tabindex="-1">No ${e(view.legacyRpId)} passkey found</h1>
<p>This device has no passkey for ${legacy}, or the request was cancelled.</p>
<p class="muted">If you’ve already replaced it, you’re all set: sign in as usual.</p>
<div class="actions"><button type="button" class="primary" data-run="old">Try again</button></div>`),
		screen("done", `<h1 tabindex="-1">Your new passkey is ready</h1>
<p>Sign in with it from now on. Your old passkey keeps working until ${cutoff}.</p>
<p class="muted">You can close this tab.</p>`),
		screen("later", `<h1 tabindex="-1">Nothing changed</h1>
<p>Your ${legacy} passkey keeps working until ${cutoff}. Come back to this page before then to replace it.</p>`),
		screen("close", `<h1 tabindex="-1">All done</h1>
<p class="muted">You can close this tab.</p>`),
	];
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Replace your passkey · ${e(view.title)}</title>
<style nonce="${nonce}">${STYLE}
code { font-size: 0.9em; }
h1:focus { outline: none; }</style>
</head>
<body>
<main>
${screens.join("\n")}
<noscript><p>This page needs JavaScript to use your passkey.</p></noscript>
<p id="status" class="warn" role="status" aria-live="polite"></p>
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
