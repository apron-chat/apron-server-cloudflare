/*
 * The passkey page's sign-in while LEGACY_RP_ID is set (src/legacy-passkeys.ts):
 * one "Continue with passkey" that finds a passkey for either RP ID without
 * asking which, and the "Save a new passkey" step after an old one.
 */
import { PAGE_PREPARED_FRESH_MS } from "./oauth";
import { chip, chips, icon } from "./sign-in-page";

/**
 * The passkey page's additions on a sign-in screen, while LEGACY_RP_ID is
 * set: its "Continue with passkey" button (`button`, in place of the page's
 * own), which finds the person's passkey whichever RP ID it was made for,
 * without asking them which; the checklist of RP IDs tried, shown once one
 * finds none (`tries`); the screen offered after a legacy one (hidden until
 * then); and the script that runs them. The script uses the page's
 * own helpers (src/sign-in-page.ts: config, $, status, hint, busy, post,
 * forget, the option parsers and credentialJson), which a later classic
 * script shares.
 */
export function legacyPageParts(view: { legacyRpId: string; rpId: string; host: string; title: string }, escape: (text: string) => string, paths: { begin: string; finish: string }, nonce: string): { button: string; tries: string; screen: string; script: string } {
	const e = escape;
	const legacy = e(view.legacyRpId);
	const host = e(view.host);
	// One row for each RP ID, in the order tried (the script puts them in it): its name, what checking it does, and a Retry once it found none.
	const row = (kind: "login" | "legacy", name: string, note: string) => `<div class="key" data-try="${kind}" data-note="${note}">${icon("key")}${icon("miss")}<span><b>${name}</b><small>${note}</small></span><button type="button" class="link retry" data-retry="${kind}" aria-label="Retry ${name}" hidden>Retry</button></div>`;
	return {
		button: `<button type="button" class="primary" data-legacy="auto">Continue with passkey</button>`,
		// Shown with the checklist: why there's more than one place to look.
		tries: `<p id="tries-why" class="muted tries-why" hidden>This server supports additional passkey namespaces for accounts that haven’t migrated yet.</p>
<div id="tries" class="keys tries" hidden>
${row("login", e(view.rpId), "Check for passkey")}
${row("legacy", legacy, "Check for older passkey")}
</div>`,
		screen: `<div id="upgrade" hidden>
<h1 tabindex="-1">Save a new passkey</h1>
<p>You signed in with an older passkey. ${e(view.title)} has moved to <strong>${host}</strong>: save a new passkey for it, and use that one from now on.</p>
${chips(`Older passkey used; next a new one for ${host}`, [
	chip({ icon: "check", name: legacy, note: "Your older passkey", tag: "Used", kind: "past ok" }),
	chip({ icon: "key", name: host, note: "Your new passkey", tag: "Save this", kind: "pick next" }),
])}
<div class="actions"><button type="button" class="primary" data-legacy="upgrade">Save passkey</button><button type="button" data-skip>Not now</button></div>
</div>
<div id="unsaved" hidden>
<h1 tabindex="-1">Your new passkey wasn’t saved</h1>
<p>You’re signed in. You can add a passkey later in the app’s settings. If your password manager saved an entry for <strong>${host}</strong>, you can delete it.</p>
<div class="actions"><button type="button" class="primary" data-continue>Continue</button></div>
</div>`,
		script: `<script nonce="${nonce}">${legacyScript(paths)}</script>`,
	};
}

/**
 * The sign-in, whichever RP ID the person's passkey is for: one ceremony
 * can ask for one RP ID only, so "Continue with passkey" asks first for the
 * one the server says (`config.first`, from the client's hints), else the
 * one this device last signed in with here (`localStorage`), else RP_ID, so
 * an account made since the switch is asked once only. When it ends with no
 * passkey (none, or the prompt closed: the browser does not say which), the
 * checklist shows that RP ID as "No passkey used", with a Retry, and the
 * next one, which the same button asks for. A legacy one then offers a new passkey (`upgrade`).
 * Each ceremony is begun before its tap, so the tap goes straight to the
 * device's prompt, which some browsers require.
 */
function legacyScript(paths: { begin: string; finish: string }): string {
	return `
"use strict";
{
const KEY = "apron-passkey-kind";
// Each kind's RP ID, as the page shows it (config.names).
const NAMES = config.names || { login: "", legacy: "" };
// The kind this device last signed in with here: "new", or "old" for a legacy passkey with none saved since.
const remember = (kind) => { try { localStorage.setItem(KEY, kind); } catch {} };
let order = ["login", "legacy"];
if (config.first === "login" || config.first === "legacy") order = config.first === "login" ? ["login", "legacy"] : ["legacy", "login"];
else try { if (localStorage.getItem(KEY) === "old") order = ["legacy", "login"]; } catch {}
// The RP IDs tried that found no passkey; the button asks for the first of the rest.
const missed = new Set();
const next = () => order.find((kind) => !missed.has(kind)) || order[0];
for (const kind of order) $("tries").append($("tries").querySelector('[data-try="' + kind + '"]'));
// The checklist: each RP ID that found none, with a Retry, and the one the button asks for next.
function mark() {
	const upcoming = order.find((kind) => !missed.has(kind));
	$("tries").hidden = missed.size === 0;
	// Once the checklist shows, why there's more than one place to look takes the warning's place: it was read
	// before the first tap, and the person has already chosen to continue.
	if ($("tries-why")) $("tries-why").hidden = missed.size === 0;
	for (const warning of document.querySelectorAll("[data-only-continue]")) warning.hidden = missed.size > 0;
	for (const row of $("tries").querySelectorAll("[data-try]")) {
		const kind = row.dataset.try;
		const gone = missed.has(kind);
		row.className = gone ? "key gone" : kind === upcoming ? "key pick" : "key";
		row.querySelector("small").textContent = gone ? "None selected" : row.dataset.note;
		row.querySelector("[data-retry]").hidden = !gone;
	}
	for (const button of document.querySelectorAll('[data-legacy="auto"]')) button.hidden = !upcoming;
}
// After a miss: said, as the question the button answers (it's also how a screen reader hears of it: the
// checklist isn't a live region), and focus where the next step is: the button, or once both missed, the first
// Retry (the focused button may have just been hidden). "None selected": the browser doesn't say whether
// there was none or the prompt was closed.
function missedSaid(kind) {
	const upcoming = order.find((each) => !missed.has(each));
	// Said right under the checklist it's about, above the button it asks about.
	$("tries").after($("status"));
	if (upcoming) {
		hint("Checked " + NAMES[kind] + " for passkey, none selected. Check " + NAMES[upcoming] + " for passkey?");
		const button = document.querySelector('[data-legacy="auto"]');
		if (button && button.focus) button.focus();
	} else {
		hint("Checked " + NAMES[order[0]] + " and " + NAMES[order[1]] + " for passkey, none selected. Retry either, or cancel to go back.");
		const retry = $("tries").querySelector('[data-retry="' + order[0] + '"]');
		if (retry && retry.focus) retry.focus();
	}
}
// After a sign-in with a legacy passkey: the token that adds a new one, and then issues the sign-in's code.
let upgrade = null;
// A ceremony begun ahead of its tap, for each RP ID (and the upgrade): a Retry, too, goes straight to the prompt.
const ready = new Map();
async function begin(kind) {
	const body = kind === "legacy" ? { action: "login", legacy: true } : kind === "login" ? { action: "login" } : { upgrade };
	const result = await post(${JSON.stringify(paths.begin)}, { page: config.page, query: config.query, ...body });
	if (result.error) { status(result.error); return null; }
	return result;
}
// How often each kind's held ceremony was begun again, and the kinds being begun now.
const refreshes = new Map();
const beginning = new Set();
function prepare(kind) {
	ready.delete(kind);
	beginning.add(kind);
	begin(kind).then((options) => {
		beginning.delete(kind);
		if (!options) return;
		const held = { options, at: Date.now() };
		ready.set(kind, held);
		// Begun again before it is too old to use, so a later tap still goes straight to the prompt (for half an hour).
		if ((refreshes.get(kind) || 0) < 5) setTimeout(() => { if (ready.get(kind) === held) { refreshes.set(kind, (refreshes.get(kind) || 0) + 1); prepare(kind); } }, ${PAGE_PREPARED_FRESH_MS});
	});
}
// Prepares \`kind\` unless one is held or on its way: each begin is charged as a sign-in attempt.
function ensure(kind) {
	if (!ready.has(kind) && !beginning.has(kind)) prepare(kind);
}
async function run(kind) {
	status("");
	if (!window.PublicKeyCredential || !navigator.credentials) { status("This browser cannot use passkeys."); return; }
	busy(true);
	// One begun so long ago that it could expire before the passkey is back is begun again.
	const held = ready.get(kind);
	const options = held && Date.now() - held.at <= ${PAGE_PREPARED_FRESH_MS} ? held.options : await begin(kind);
	ready.delete(kind);
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
		// No passkey for this RP ID (none, the prompt closed, or a browser or passkey manager that cannot use it):
		// it's marked, with a Retry, and the same button asks for the next.
		missed.add(kind);
		mark();
		missedSaid(kind);
		if (!refused) status("Your browser could not use a passkey" + (error && error.message ? ": " + error.message : "."));
		// The next one, and this one again for its Retry, each unless one is already held.
		ensure(next());
		ensure(kind);
		return;
	}
	const result = await finish({ challenge_id: options.challenge_id, credential: credentialJson(credential) });
	if (result.unknownCredential && kind === "login") forget(options.public_key.rpId, credential.id);
	// An upgrade's answer carries the sign-in's code even when its passkey could not be added: said, not passed over.
	if (result.redirect && kind === "upgrade" && !result.added) { show("unsaved"); onward = result.redirect; return; }
	// The device holds a passkey the server knows for the new RP ID only after a sign-in with one, or an upgrade that added one;
	// a legacy one that signed in, and wasn't replaced, is asked for first next time.
	if (result.redirect) { remember(kind === "legacy" ? "old" : "new"); location.assign(result.redirect); return; }
	if (result.error || !result.upgrade) { busy(false); status(result.error || "Something went wrong. Try again."); if (kind === "upgrade") prepare("upgrade"); else { ensure(kind); ensure(next()); } return; }
	upgrade = result.upgrade;
	// Until a new passkey is saved, this device's is the legacy one.
	remember("old");
	// The sign-in's other ceremonies are done with: dropped, so they stop being begun again.
	ready.clear();
	show("upgrade");
	prepare("upgrade");
}
// Shows the screen \`id\` in place of the rest, keeping the brand line and the status.
function show(id) {
	const screen = $(id);
	for (const element of screen.parentElement.children) if (element !== screen && element.id !== "status" && !element.classList.contains("brand")) element.hidden = true;
	screen.hidden = false;
	status("");
	screen.querySelector("h1").focus();
	busy(false);
}
// Where Continue goes once the new passkey wasn't saved: back to the client, signed in.
let onward = null;
for (const button of document.querySelectorAll("[data-continue]")) button.addEventListener("click", () => { if (onward) { busy(true); location.assign(onward); } });
for (const button of document.querySelectorAll("[data-legacy]")) button.addEventListener("click", () => run(button.dataset.legacy === "auto" ? next() : button.dataset.legacy));
// A Retry for an RP ID that found none: the browser doesn't say whether there was none or the prompt was closed.
for (const button of document.querySelectorAll("[data-retry]")) button.addEventListener("click", () => run(button.dataset.retry));
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
