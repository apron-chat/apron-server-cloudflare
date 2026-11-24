/*
 * The passkey page's sign-in while LEGACY_RP_ID is set (src/legacy-passkeys.ts):
 * one "Continue with passkey" that finds a passkey for either RP ID without
 * asking which, and the "Save a new passkey" step after an old one.
 */
import { chip, chips } from "./sign-in-page";

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
<p>You signed in with an older passkey. ${e(view.title)} has moved to <strong>${host}</strong>: save a new passkey for it, and use that one from now on.</p>
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
