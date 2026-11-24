/*
 * The sign-in pages' HTML: the passkey page (`/passkey`) and, where
 * `external` is offered, `/oauth/authorize`. Both are one server-rendered
 * page with a small inline script that runs `navigator.credentials` on the
 * server's own origin, so the passkey's RP ID always fits. The wording is
 * SPEC.md's (section 5, Passkey page), on one screen: who is asking
 * and what they get, before the passkey. A verified passkey goes straight
 * back to the client with its code; the device's passkey sheet has already
 * shown which account it is.
 */
import { legacyPageParts } from "./legacy-passkeys-page";
import { PAGE_BEGIN_PATH, PAGE_FINISH_PATH, PAGE_PREPARED_FRESH_MS, type SignInPage } from "./oauth";

/** What a sign-in page shows: everything is text, escaped here. */
export interface SignInPageView {
	page: SignInPage;
	/** The page's one screen: `login`, `register`, or `add`, an addition for `account`. */
	start: "login" | "register" | "add";
	/** The server's title, as in the `server` frame ("Apron Demo"). */
	title: string;
	/** The server's host, such as `server.apron.chat`. */
	host: string;
	/** Who is asking, at the start of a sentence and within one, and where they started (clientLabel). */
	who: string;
	client: string;
	where: string;
	/** Whether the server recognises the client, which drops "has not verified this app". */
	recognised: boolean;
	/** The account an addition adds to. */
	account?: { userId: string; name: string };
	/** On a sign-in screen, a previous RP ID (`LEGACY_RP_ID`) whose passkeys it also finds (src/legacy-passkeys-page.ts). */
	legacyRpId?: string;
	/** The page's own query, which its script sends back with begin. */
	query: string;
	/** Where Cancel goes: the redirect with `error=access_denied`. */
	deny: string;
}

/** Headers every sign-in page response carries: never framed, never cached, no referrer to the client. */
export function pageHeaders(nonce?: string): Headers {
	const script = nonce ? `'nonce-${nonce}'` : "'none'";
	return new Headers({
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Security-Policy": `default-src 'none'; script-src ${script}; style-src ${script}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
		"X-Frame-Options": "DENY",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
	});
}

export function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** JSON inside a `<script type="application/json">`: no `<` can close the element. */
function scriptJson(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export const STYLE = `
:root { color-scheme: light dark; --bg: #faf8f4; --chip: #ffffff; --text: #161a23; --muted: #5b6170; --line: #dfd9cf; --accent: #a63d17; --on-accent: #ffffff; --ok: #2d6a45; --err: #a3261b; --warn: #8a4b00; --focus: #161a23; }
@media (prefers-color-scheme: dark) { :root { --bg: #121316; --chip: #1c1e23; --text: #eceae6; --muted: #a5a6ac; --line: #34363d; --accent: #ec8a5f; --on-accent: #1a0c05; --ok: #86cf9e; --err: #f4907f; --warn: #f0b35a; --focus: #eceae6; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; min-height: 100vh; padding: clamp(24px, 10vh, 72px) 16px 32px; background: var(--bg); color: var(--text); font: 17px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 26rem; margin: 0 auto; }
.brand { display: flex; align-items: center; gap: 8px; margin: 0 0 32px; font-size: 0.875rem; color: var(--muted); }
.brand b { color: var(--text); }
.mark { width: 24px; height: 24px; flex: none; }
.mark rect { fill: var(--accent); }
.mark path { fill: var(--bg); }
h1 { font-size: 1.875rem; line-height: 1.15; letter-spacing: -0.02em; margin: 0 0 12px; }
h1:focus { outline: none; }
p { margin: 0 0 12px; }
.muted { color: var(--muted); font-size: 0.9375rem; }
.warn { color: var(--warn); font-size: 0.9375rem; }
.i { width: 22px; height: 22px; }
.keys { margin: 24px 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; justify-items: center; }
.keys > .i { width: 18px; height: 18px; color: var(--muted); }
.key { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 14px; background: var(--chip); font-size: 0.9375rem; line-height: 1.3; overflow-wrap: anywhere; }
.key > .i { flex: none; color: var(--muted); }
.key small { display: block; color: var(--muted); font-size: 0.8125rem; }
.key em { margin-left: auto; font-style: normal; font-size: 0.75rem; font-weight: 600; color: var(--muted); white-space: nowrap; }
.key.pick { border: 2px solid var(--accent); padding: 11px 13px; }
.key.pick > .i, .key.pick em { color: var(--accent); }
.key.next { border-style: dashed; background: none; }
.key.past { opacity: 0.6; }
.key.gone { border-style: dashed; background: none; color: var(--muted); }
.key.ok em, .key.ok > .i { color: var(--ok); }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 28px; }
button { font: inherit; font-size: 1rem; font-weight: 600; border-radius: 999px; padding: 12px 22px; min-height: 48px; cursor: pointer; border: 1px solid var(--line); background: transparent; color: var(--text); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
button.link { border: 0; padding: 0; min-height: 0; border-radius: 0; font-size: inherit; font-weight: 500; background: none; color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
button:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
button:disabled { opacity: 0.6; cursor: default; }
.status { margin: 20px 0 0; font-size: 0.9375rem; color: var(--err); font-weight: 600; }
.status.hint { color: var(--muted); font-weight: 400; }
.status:empty { display: none; }
.switch { margin: 24px 0 0; }
code { font-size: 0.9em; }
@media (max-width: 30rem) { h1 { font-size: 1.625rem; } .actions button { flex: 1 1 100%; } }
`;

/** The icons the pages draw: inline SVG, which the page's CSP allows (no image requests). */
const ICONS = {
	key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 20 3m-3 3 2.5 2.5M14.5 8.5l2 2"/>',
	check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.8 2.8L16 10"/>',
	search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4M8.8 11h4.4"/>',
	app: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 8h18M8 21h8"/>',
	down: '<path d="M12 5v14m-5-5 5 5 5-5"/>',
} as const;

export function icon(name: keyof typeof ICONS): string {
	return `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** The line at the top of every page: the server's mark, its title and its host (both already escaped). */
export function brand(title: string, host: string): string {
	return `<header class="brand"><svg class="mark" viewBox="0 0 28 28" aria-hidden="true"><rect width="28" height="28" rx="8"/><path d="M8.5 8h11a2.5 2.5 0 0 1 2.5 2.5v6a2.5 2.5 0 0 1-2.5 2.5H14l-4.5 3.5V19h-1A2.5 2.5 0 0 1 6 16.5v-6A2.5 2.5 0 0 1 8.5 8z"/></svg><span><b>${title}</b> ${host}</span></header>`;
}

/**
 * A chip as the device's passkey sheet lists a passkey or a client: an
 * icon, a name, a note, and a tag (all markup, already escaped). `kind`
 * is its look: `pick` (choose this), `next`, `past`, `gone`, `ok`.
 */
export function chip(options: { icon: keyof typeof ICONS; name: string; note: string; tag?: string; kind?: string }): string {
	return `<div class="key${options.kind ? ` ${options.kind}` : ""}">${icon(options.icon)}<span><b>${options.name}</b><small>${options.note}</small></span>${options.tag ? `<em>${options.tag}</em>` : ""}</div>`;
}

/** Chips in a column, with an arrow between each; `label` says what they show to a screen reader. */
export function chips(label: string, items: string[]): string {
	return `<div class="keys" role="img" aria-label="${label}">${items.join(icon("down"))}</div>`;
}

/**
 * What every passkey page script shares: `$`, `status` (the live region),
 * the option parsers, `credentialJson`, `post` (same origin, JSON, no
 * cookies) and `busy`.
 */
export const PAGE_HELPERS = `
const $ = (id) => document.getElementById(id);
// A problem (in the error colour); \`hint\`, guidance while the device's prompt is open.
const status = (text) => { $("status").className = "status"; $("status").textContent = text; };
const hint = (text) => { $("status").className = "status hint"; $("status").textContent = text; };
const fromB64 = (text) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
// Binary data, whichever realm made it: a password manager's ArrayBuffer fails \`instanceof\` here.
const isBinary = (value) => ArrayBuffer.isView(value) || Object.prototype.toString.call(value) === "[object ArrayBuffer]";
const toB64 = (value) => {
	const bytes = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
function requestOptions(json) {
	if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(json);
	return { ...json, challenge: fromB64(json.challenge), allowCredentials: (json.allowCredentials || []).map((c) => ({ ...c, id: fromB64(c.id) })) };
}
function creationOptions(json) {
	if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(json);
	return { ...json, challenge: fromB64(json.challenge), user: { ...json.user, id: fromB64(json.user.id) }, excludeCredentials: (json.excludeCredentials || []).map((c) => ({ ...c, id: fromB64(c.id) })) };
}
// The credential's own fields, each read on its own: a password manager's credential (1Password's in
// Firefox, notably) may throw from one, hide it behind a getter, or deny access after a while.
function readCredential(credential) {
	const read = (property, getter) => {
		try { const value = property(); if (value !== undefined && value !== null) return value; } catch {}
		try { const value = getter ? getter() : undefined; return value === null ? undefined : value; } catch { return undefined; }
	};
	const r = read(() => credential.response) || {};
	const response = {};
	const put = (key, value) => { if (isBinary(value)) response[key] = toB64(value); };
	put("clientDataJSON", read(() => r.clientDataJSON));
	put("attestationObject", read(() => r.attestationObject));
	put("authenticatorData", read(() => r.authenticatorData, () => r.getAuthenticatorData()));
	put("signature", read(() => r.signature));
	put("userHandle", read(() => r.userHandle));
	put("publicKey", read(() => undefined, () => r.getPublicKey()));
	const algorithm = read(() => undefined, () => r.getPublicKeyAlgorithm());
	if (typeof algorithm === "number") response.publicKeyAlgorithm = algorithm;
	const transports = read(() => undefined, () => r.getTransports());
	if (Array.isArray(transports)) response.transports = [...transports];
	const rawId = read(() => credential.rawId);
	const id = read(() => credential.id) || (isBinary(rawId) ? toB64(rawId) : "");
	const attachment = read(() => credential.authenticatorAttachment);
	const extensions = read(() => credential.getClientExtensionResults());
	const convert = (entry) => isBinary(entry) ? toB64(entry) : Array.isArray(entry) ? entry.map(convert) : entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).map(([key, inner]) => [key, convert(inner)])) : entry;
	return { id, rawId: isBinary(rawId) ? toB64(rawId) : id, type: "public-key", response, clientExtensionResults: extensions && typeof extensions === "object" ? convert(extensions) : {}, ...(attachment ? { authenticatorAttachment: attachment } : {}) };
}
// The credential in WebAuthn JSON: its toJSON() where that agrees with its own fields, else the
// fields (a password manager's toJSON may throw, or encode them another way), as apron-web does.
function credentialJson(credential) {
	const fields = readCredential(credential);
	let json;
	try {
		if (typeof credential.toJSON !== "function") return fields;
		json = credential.toJSON();
	} catch { return fields; }
	if (!json || typeof json !== "object" || !json.response || typeof json.response !== "object") return fields;
	for (const key of ["clientDataJSON", "attestationObject", "authenticatorData", "signature", "userHandle"]) {
		if (typeof fields.response[key] === "string" && json.response[key] !== fields.response[key]) return fields;
	}
	if (fields.rawId && json.rawId !== fields.rawId) return fields;
	if (!json.clientExtensionResults || typeof json.clientExtensionResults !== "object") return { ...json, clientExtensionResults: fields.clientExtensionResults };
	return json;
}

async function post(path, body) {
	try {
		const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "omit" });
		const json = await response.json().catch(() => ({}));
		if (!response.ok) return { error: json.error || "Something went wrong. Try again.", unknownCredential: json.unknown_credential === true };
		return json;
	} catch {
		return { error: "Could not reach the server. Check your connection and try again.", network: true };
	}
}
// A finish, sent again while the server couldn't be reached: the passkey is already made, and the
// server answers the same finish again with its first answer (one that was lost on the way).
async function finish(body) {
	let result = await post(${JSON.stringify(PAGE_FINISH_PATH)}, body);
	for (let wait = 1_000; result.network && wait <= 4_000; wait *= 2) {
		await new Promise((resolve) => setTimeout(resolve, wait));
		result = await post(${JSON.stringify(PAGE_FINISH_PATH)}, body);
	}
	return result;
}
function busy(on) { for (const button of document.querySelectorAll("button")) button.disabled = on; }
`;

/**
 * The page's script: prepares the screen's ceremony as it shows (so the
 * click that the browser needs goes straight to the passkey prompt), runs
 * it, sends the credential to the server, and goes back to the client with
 * the code. On `/oauth/authorize`, "Create an account" runs a new passkey's
 * ceremony instead, begun on its click. Cancel goes back with
 * `error=access_denied`. A sign-in with a passkey no account here has stays
 * on the page, and asks the device to drop that passkey.
 */
const SCRIPT = `
"use strict";
const config = JSON.parse(document.getElementById("config").textContent);
${PAGE_HELPERS}
const primary = config.start === "login" ? "login" : "register";
let prepared = null;
let preparing = null;

function prepare(action) {
	prepared = null;
	const mine = { action };
	preparing = mine;
	mine.done = post(${JSON.stringify(PAGE_BEGIN_PATH)}, { page: config.page, query: config.query, action }).then((result) => {
		if (preparing !== mine) return;
		preparing = null;
		if (result.error) { status(result.error); return; }
		prepared = { action, options: result, at: Date.now() };
	});
	return mine.done;
}

// A passkey no account here has, such as one made here whose sign-up was
// never finished: the device may hide or remove it. Its ID is the one the
// device just used, never one from the server.
function forget(rpId, credentialId) {
	try {
		if (PublicKeyCredential.signalUnknownCredential) PublicKeyCredential.signalUnknownCredential({ rpId, credentialId }).catch(() => {});
	} catch {}
}


async function passkey(action) {
	status("");
	if (!window.PublicKeyCredential || !navigator.credentials) { status("This browser cannot use passkeys."); return; }
	// One begun so long ago that it could expire before the passkey is back: begun again.
	if (prepared && Date.now() - prepared.at > ${PAGE_PREPARED_FRESH_MS}) prepared = null;
	if (!prepared || prepared.action !== action) {
		busy(true);
		await (preparing && preparing.action === action ? preparing.done : prepare(action));
		busy(false);
		if (!prepared || prepared.action !== action) return;
	}
	const options = prepared.options;
	prepared = null;
	busy(true);
	let credential;
	try {
		credential = action === "login"
			? await navigator.credentials.get({ publicKey: requestOptions(options.public_key) })
			: await navigator.credentials.create({ publicKey: creationOptions(options.public_key) });
	} catch (error) {
		busy(false);
		status(error && error.name === "NotAllowedError" ? "No passkey was used. Try again when you're ready." : "Your browser could not use a passkey" + (error && error.message ? ": " + error.message : "."));
		prepare(primary);
		return;
	}
	const result = await finish({ challenge_id: options.challenge_id, credential: credentialJson(credential) });
	if (result.unknownCredential && action === "login") forget(options.public_key.rpId, credential.id);
	if (result.error) { busy(false); status(result.error); prepare(primary); return; }
	location.assign(result.redirect);
}

for (const button of document.querySelectorAll("[data-passkey]")) button.addEventListener("click", () => passkey(button.dataset.passkey || primary));
for (const button of document.querySelectorAll("[data-cancel]")) button.addEventListener("click", () => { busy(true); location.assign(config.deny); });
// With LEGACY_RP_ID, the page's sign-in button is the legacy script's, which prepares its own ceremony.
if (document.querySelector('[data-passkey=""]')) prepare(primary);
`;

/** A sign-in page, ready for `navigator.credentials` on the server's origin. */
export function renderSignInPage(view: SignInPageView, nonce: string): string {
	const e = escapeHtml;
	const who = `<strong>${e(view.who)}</strong>`;
	const host = `<strong>${e(view.host)}</strong>`;
	const caution = `${view.recognised ? "" : `<p class="warn">${e(view.host)} has not verified this app.</p>`}
<p class="muted">Only continue if you just started signing in on ${e(view.where)}.</p>`;
	const cancel = `<button type="button" data-cancel>Cancel</button>`;
	// With LEGACY_RP_ID, a "Continue with passkey" that finds either kind, and the upgrade after an old one.
	const legacy = view.legacyRpId ? legacyPageParts({ legacyRpId: view.legacyRpId, host: view.host, title: view.title }, e, { begin: PAGE_BEGIN_PATH, finish: PAGE_FINISH_PATH }, nonce) : undefined;
	const signIn = legacy?.button ?? `<button type="button" class="primary" data-passkey>Continue with passkey</button>`;
	const account = view.account ? `${view.account.name} (@${view.account.userId})` : "";
	const screens = {
		// `/oauth/authorize` is always this screen, with a new account's passkey besides.
		login: `<h1>Sign in to ${e(view.title)} on ${e(view.client)}?</h1>
<p>It will be able to read and send messages as you.</p>
${chips(`${e(view.client)} signing in to ${e(view.title)}`, [chip({ icon: "app", name: e(view.client), note: "Wants to sign in as you" })])}
${caution}
<div class="actions">${signIn}${cancel}</div>
${view.page === "authorize" ? `<p class="muted switch">New here? <button type="button" class="link" data-passkey="register">Create an account</button></p>` : ""}`,
		register: `<h1>Create an account on ${e(view.title)}</h1>
<p>${who} wants to create an account for you on ${host}, with a new passkey. It will be able to read and send messages as you.</p>
${chips(`${e(view.client)} creating an account`, [chip({ icon: "app", name: e(view.client), note: "Wants to create an account for you" })])}
${caution}
<div class="actions"><button type="button" class="primary" data-passkey>Create passkey</button>${cancel}</div>`,
		add: `<h1>Add a passkey</h1>
<p>${who} wants to add a passkey to <strong>${e(account)}</strong>’s account on ${host}.</p>
${chips(`${e(view.client)} adding a passkey`, [chip({ icon: "app", name: e(view.client), note: `Wants to add a passkey to ${e(account)}` })])}
${caution}
<div class="actions"><button type="button" class="primary" data-passkey>Create passkey</button>${cancel}</div>`,
	};
	const pageTitle = view.start === "add" ? "Add a passkey" : view.start === "register" ? `Create an account on ${view.title}` : `Sign in to ${view.title}`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${e(pageTitle)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
${brand(e(view.title), e(view.host))}
${screens[view.start]}
${legacy?.screen ?? ""}
<noscript><p>This page needs JavaScript to use your passkey.</p></noscript>
<p id="status" class="status" role="status" aria-live="polite"></p>
</main>
<script type="application/json" id="config">${scriptJson({ page: view.page, start: view.start, query: view.query, deny: view.deny })}</script>
<script nonce="${nonce}">${SCRIPT}</script>
${legacy?.script ?? ""}
</body>
</html>`;
}

/** A page for a request that cannot go on: shown here, never redirected (the return address may not be safe). */
export function renderErrorPage(title: string, message: string, nonce: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p class="muted">Close this window and start again from the app you were signing in to.</p>
</main>
</body>
</html>`;
}
