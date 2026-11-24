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
import { brand, chip, chips, escapeHtml, PAGE_HELPERS, STYLE } from "./sign-in-page";

export interface ReplacePageView {
	/** The server's title ("Apron Demo"), its host ("server.apron.chat"), the legacy RP ID, and the removal date as people read it. */
	title: string;
	host: string;
	legacyRpId: string;
	cutoff: string;
	/** The removal date, short ("Dec 22"). */
	cutoffShort: string;
}

/**
 * The script: prepares a sign-in for the legacy RP ID as the page shows (so
 * the tap goes straight to the passkey sheet), runs it, and shows the
 * server's answer (`create`, `already`, `full`); then, with the `upgrade`
 * token, a new passkey for this server's RP ID. A sheet dismissed, or one
 * with no passkey for the legacy RP ID (the browser does not say which),
 * shows `none`.
 */
const script = () => `
"use strict";
${PAGE_HELPERS}
const LEGACY_HINT = "Choose your passkey in your device’s prompt.";
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
	for (const element of document.querySelectorAll("[data-name]")) element.textContent = account.name || account.user_id || "You";
	if (result.added_at) for (const element of document.querySelectorAll("[data-added]")) element.textContent = new Date(result.added_at).toLocaleDateString("en-US", { month: "long", day: "numeric" });
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
	if (kind === "old") hint(LEGACY_HINT);
	let credential;
	try {
		credential = kind === "old"
			? await navigator.credentials.get({ publicKey: requestOptions(options.public_key) })
			: await navigator.credentials.create({ publicKey: creationOptions(options.public_key) });
	} catch (error) {
		busy(false);
		const refused = error && error.name === "NotAllowedError";
		if (kind === "old" && refused) show("none");
		else status(refused ? "Your passkey wasn’t saved. Try again." : "Your browser could not use a passkey" + (error && error.message ? ": " + error.message : "."));
		prepare(kind);
		return;
	}
	const result = await post(${JSON.stringify(PAGE_FINISH_PATH)}, { challenge_id: options.challenge_id, credential: credentialJson(credential) });
	busy(false);
	if (result.error) { status(kind === "new" ? "Your passkey wasn’t saved. Try again." : result.error); prepare(kind); return; }
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
	const host = e(view.host);
	const legacy = e(view.legacyRpId);
	const name = `<span data-name></span>`;
	const screen = (id: string, body: string, shown = false) => `<section id="${id}" data-screen${shown ? "" : " hidden"}>\n${body}\n</section>`;
	const screens = [
		screen("start", `<h1 tabindex="-1">Update your passkey</h1>
<p>${e(view.title)} has moved to <strong>${host}</strong>. Your passkey keeps working until <strong>${e(view.cutoff)}</strong>; update it now so it keeps working after.</p>
${chips(`Your ${legacy} passkey, then a new one for ${host}`, [
	chip({ icon: "key", name: legacy, note: "Your old passkey", tag: "Choose this", kind: "pick" }),
	chip({ icon: "key", name: host, note: "Your new passkey", tag: "Next", kind: "next" }),
])}
<p class="muted">Use your passkey once more, then save a new one. It takes a minute.</p>
<div class="actions"><button type="button" class="primary" data-run="old">Continue with passkey</button></div>`, true),
		screen("create", `<h1 tabindex="-1">Save your new passkey</h1>
<p>Signed in as <strong data-account></strong>. Your device will save a new passkey for <strong>${host}</strong>.</p>
${chips(`${legacy} passkey used; next a new one for ${host}`, [
	chip({ icon: "check", name: legacy, note: `${name} · old passkey`, tag: "Used", kind: "past ok" }),
	chip({ icon: "key", name: host, note: `${name} · new passkey`, tag: "Save this", kind: "pick next" }),
])}
<div class="actions"><button type="button" class="primary" data-run="new">Save passkey</button><button type="button" data-show="later">Not now</button></div>`),
		screen("already", `<h1 tabindex="-1">You’re all set</h1>
<p>Your account already has a passkey for <strong>${host}</strong>, added on <span data-added></span>.</p>
${chips(`${host} passkey ready`, [chip({ icon: "check", name: host, note: `${name} · added <span data-added></span>`, tag: "Ready", kind: "ok" })])}
<p class="muted">If this device doesn’t have it yet, add one here too.</p>
<div class="actions"><button type="button" class="primary" data-show="close">Done</button><button type="button" data-run="new">Add one for this device</button></div>`),
		screen("full", `<h1 tabindex="-1">No room for another passkey</h1>
<p><strong data-account></strong> already has as many passkeys as an account can hold. Remove one with <code>/passkeys remove</code> in the chat, then come back.</p>`),
		screen("none", `<h1 tabindex="-1">No older passkey found</h1>
<p>Your device didn’t share one: there may be none here, or the prompt was closed.</p>
${chips(`No ${legacy} passkey`, [chip({ icon: "search", name: legacy, note: "Not shared by this device", kind: "gone" })])}
<p class="muted">If you’ve already updated it, you’re all set: sign in as usual.</p>
<div class="actions"><button type="button" class="primary" data-run="old">Try again</button></div>`),
		screen("done", `<h1 tabindex="-1">Your new passkey is ready</h1>
<p>Sign in with it from now on.</p>
${chips(`${host} passkey ready; ${legacy} passkey works until ${e(view.cutoff)}`, [
	chip({ icon: "check", name: host, note: `${name} · use this one`, tag: "Ready", kind: "ok" }),
	chip({ icon: "key", name: legacy, note: `${name} · old passkey`, tag: `Until ${e(view.cutoffShort)}`, kind: "past" }),
])}
<p class="muted">You can close this tab.</p>`),
		screen("later", `<h1 tabindex="-1">Nothing changed</h1>
<p>Your passkey keeps working until ${e(view.cutoff)}. You’ll be asked again next time you sign in.</p>`),
		screen("close", `<h1 tabindex="-1">All done</h1>
<p class="muted">You can close this tab.</p>`),
	];
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Update your passkey · ${e(view.title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
${brand(e(view.title), host)}
${screens.join("\n")}
<noscript><p>This page needs JavaScript to use your passkey.</p></noscript>
<p id="status" class="status" role="status" aria-live="polite"></p>
</main>
<script nonce="${nonce}">${script()}</script>
</body>
</html>`;
}

/**
 * The passkey page's additions on a sign-in screen, while LEGACY_RP_ID is
 * set: its "Continue with passkey" button (`button`, in place of the page's
 * own), which finds the person's passkey whichever RP ID it was made for,
 * without asking them which; the screen offered after a legacy one (hidden
 * until then); and the script that runs both. The script uses the page's
 * own helpers (src/sign-in-page.ts: config, $, status, hint, busy, post,
 * forget, the option parsers and credentialJson), which a later classic
 * script shares.
 */
export function legacyPageParts(view: { legacyRpId: string; host: string; title: string }, escape: (text: string) => string, paths: { begin: string; finish: string }, nonce: string): { button: string; screen: string; script: string } {
	const e = escape;
	const legacy = e(view.legacyRpId);
	const host = e(view.host);
	return {
		button: `<button type="button" class="primary" data-legacy="auto">Continue with passkey</button>`,
		screen: `<div id="upgrade" hidden>
<h1 tabindex="-1">Save a new passkey</h1>
<p>You signed in with an older passkey. ${e(view.title)} has moved to <strong>${host}</strong>, so save a new passkey now to keep signing in.</p>
${chips(`Older passkey used; next a new one for ${host}`, [
	chip({ icon: "check", name: legacy, note: "Your older passkey", tag: "Used", kind: "past ok" }),
	chip({ icon: "key", name: host, note: "Your new passkey", tag: "Save this", kind: "pick next" }),
])}
<div class="actions"><button type="button" class="primary" data-legacy="upgrade">Save passkey</button><button type="button" data-skip>Not now</button></div>
</div>`,
		script: `<script nonce="${nonce}">${legacyScript(paths)}</script>`,
	};
}

/**
 * The sign-in, whichever RP ID the person's passkey is for: one ceremony
 * can ask for one RP ID only, so "Continue with passkey" asks for the one
 * this device last signed in with here (`localStorage`), else the legacy
 * one, which nearly every returning account has; when the device has none
 * (or the prompt was closed: the browser does not say which), the next tap
 * asks for the other. A legacy one then offers a new passkey (`upgrade`).
 * Each ceremony is begun before its tap, so the tap goes straight to the
 * device's prompt, which some browsers require.
 */
function legacyScript(paths: { begin: string; finish: string }): string {
	return `
"use strict";
{
const KEY = "apron-passkey-kind";
const remember = () => { try { localStorage.setItem(KEY, "new"); } catch {} };
let order = ["legacy", "login"];
try { if (localStorage.getItem(KEY) === "new") order = ["login", "legacy"]; } catch {}
let step = 0;
// After a sign-in with a legacy passkey: the token that adds a new one, and then issues the sign-in's code.
let upgrade = null;
let ready = null;
async function begin(kind) {
	const body = kind === "legacy" ? { action: "login", legacy: true } : kind === "login" ? { action: "login" } : { upgrade };
	const result = await post(${JSON.stringify(paths.begin)}, { page: config.page, query: config.query, ...body });
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
		credential = kind === "upgrade"
			? await navigator.credentials.create({ publicKey: creationOptions(options.public_key) })
			: await navigator.credentials.get({ publicKey: requestOptions(options.public_key) });
	} catch (error) {
		busy(false);
		const refused = error && error.name === "NotAllowedError";
		if (kind === "upgrade") { status(refused ? "Your passkey wasn’t saved. Try again." : "Your browser could not use a passkey" + (error && error.message ? ": " + error.message : ".")); prepare("upgrade"); return; }
		if (refused && step === 0) {
			step = 1;
			hint(order[1] === "legacy" ? "Tap Continue with passkey again to look for an older passkey." : "Tap Continue with passkey again to look once more.");
		} else {
			step = 0;
			status(refused ? "No passkey for this account was found on this device." : "Your browser could not use a passkey" + (error && error.message ? ": " + error.message : "."));
		}
		prepare(order[step]);
		return;
	}
	const result = await post(${JSON.stringify(paths.finish)}, { challenge_id: options.challenge_id, credential: credentialJson(credential) });
	if (result.unknownCredential && kind === "login") forget(options.public_key.rpId, credential.id);
	// An upgrade's answer carries the sign-in's code even when its passkey could not be added.
	if (result.redirect) { if (kind !== "legacy") remember(); location.assign(result.redirect); return; }
	if (result.error || !result.upgrade) { busy(false); status(result.error || "Something went wrong. Try again."); prepare(kind === "upgrade" ? "upgrade" : order[step]); return; }
	upgrade = result.upgrade;
	const screen = $("upgrade");
	for (const element of screen.parentElement.children) if (element !== screen && element.id !== "status" && !element.classList.contains("brand")) element.hidden = true;
	screen.hidden = false;
	status("");
	screen.querySelector("h1").focus();
	busy(false);
	prepare("upgrade");
}
for (const button of document.querySelectorAll("[data-legacy]")) button.addEventListener("click", () => run(button.dataset.legacy === "auto" ? order[step] : button.dataset.legacy));
for (const button of document.querySelectorAll("[data-skip]")) button.addEventListener("click", async () => {
	busy(true);
	const result = await post(${JSON.stringify(paths.finish)}, { skip: true, upgrade });
	if (result.redirect) { location.assign(result.redirect); return; }
	busy(false);
	status(result.error || "Something went wrong. Try again.");
});
prepare(order[0]);
}
`;
}
