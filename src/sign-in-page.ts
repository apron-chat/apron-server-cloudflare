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
import { PAGE_BEGIN_PATH, PAGE_FINISH_PATH, type SignInPage } from "./oauth";

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

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** JSON inside a `<script type="application/json">`: no `<` can close the element. */
function scriptJson(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f4; --card: #ffffff; --text: #1d1d1b; --muted: #5f5f5a; --line: #deded8; --accent: #2457c5; --accent-text: #ffffff; --warn: #8a4b00; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #20201f; --text: #ececea; --muted: #a5a59f; --line: #3a3a37; --accent: #7aa2f7; --accent-text: #0f1420; --warn: #f0b35a; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 28rem; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
h1 { font-size: 1.25rem; margin: 0 0 16px; }
p { margin: 0 0 12px; }
.muted { color: var(--muted); font-size: 0.9375rem; }
.warn { color: var(--warn); font-size: 0.9375rem; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
button { font: inherit; border-radius: 8px; padding: 8px 16px; cursor: pointer; border: 1px solid var(--line); background: transparent; color: var(--text); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.link { border: 0; padding: 0; background: none; color: var(--accent); text-decoration: underline; }
button:disabled { opacity: 0.6; cursor: default; }
#status:empty { display: none; }
#status, .switch { margin-top: 16px; }
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
const $ = (id) => document.getElementById(id);
const status = (text) => { $("status").textContent = text; };
const primary = config.start === "login" ? "login" : "register";
let prepared = null;
let preparing = null;

const fromB64 = (text) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const toB64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function requestOptions(json) {
	if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(json);
	return { ...json, challenge: fromB64(json.challenge), allowCredentials: (json.allowCredentials || []).map((c) => ({ ...c, id: fromB64(c.id) })) };
}
function creationOptions(json) {
	if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(json);
	return { ...json, challenge: fromB64(json.challenge), user: { ...json.user, id: fromB64(json.user.id) }, excludeCredentials: (json.excludeCredentials || []).map((c) => ({ ...c, id: fromB64(c.id) })) };
}
function credentialJson(credential) {
	try { if (credential.toJSON) return credential.toJSON(); } catch {}
	const r = credential.response;
	const response = { clientDataJSON: toB64(r.clientDataJSON) };
	if (r.attestationObject) { response.attestationObject = toB64(r.attestationObject); if (r.getTransports) response.transports = r.getTransports(); }
	if (r.authenticatorData) response.authenticatorData = toB64(r.authenticatorData);
	if (r.signature) response.signature = toB64(r.signature);
	if (r.userHandle) response.userHandle = toB64(r.userHandle);
	return { id: credential.id, rawId: toB64(credential.rawId), type: credential.type, response, clientExtensionResults: credential.getClientExtensionResults(), authenticatorAttachment: credential.authenticatorAttachment || undefined };
}

async function post(path, body) {
	try {
		const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "omit" });
		const json = await response.json().catch(() => ({}));
		if (!response.ok) return { error: json.error || "Something went wrong. Try again.", unknownCredential: json.unknown_credential === true };
		return json;
	} catch {
		return { error: "Could not reach the server. Check your connection and try again." };
	}
}

function prepare(action) {
	prepared = null;
	const mine = { action };
	preparing = mine;
	mine.done = post(${JSON.stringify(PAGE_BEGIN_PATH)}, { page: config.page, query: config.query, action }).then((result) => {
		if (preparing !== mine) return;
		preparing = null;
		if (result.error) { status(result.error); return; }
		prepared = { action, options: result };
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

function busy(on) { for (const button of document.querySelectorAll("button")) button.disabled = on; }

async function passkey(action) {
	status("");
	if (!window.PublicKeyCredential || !navigator.credentials) { status("This browser cannot use passkeys."); return; }
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
	const result = await post(${JSON.stringify(PAGE_FINISH_PATH)}, { challenge_id: options.challenge_id, credential: credentialJson(credential) });
	if (result.unknownCredential && action === "login") forget(options.public_key.rpId, credential.id);
	if (result.error) { busy(false); status(result.error); prepare(primary); return; }
	location.assign(result.redirect);
}

for (const button of document.querySelectorAll("[data-passkey]")) button.addEventListener("click", () => passkey(button.dataset.passkey || primary));
for (const button of document.querySelectorAll("[data-cancel]")) button.addEventListener("click", () => { busy(true); location.assign(config.deny); });
prepare(primary);
`;

/** A sign-in page, ready for `navigator.credentials` on the server's origin. */
export function renderSignInPage(view: SignInPageView, nonce: string): string {
	const e = escapeHtml;
	const who = `<strong>${e(view.who)}</strong>`;
	const host = `<strong>${e(view.host)}</strong>`;
	const caution = `${view.recognised ? "" : `<p class="warn">${e(view.host)} has not verified this app.</p>`}
<p class="muted">Only continue if you just started signing in on ${e(view.where)}.</p>`;
	const cancel = `<button type="button" data-cancel>Cancel</button>`;
	const account = view.account ? `${view.account.name} (@${view.account.userId})` : "";
	const screens = {
		// `/oauth/authorize` is always this screen, with a new account's passkey besides.
		login: `<h1>Sign in to ${e(view.title)} on ${e(view.client)}?</h1>
<p>It will be able to read and send messages as you.</p>
${caution}
<div class="actions"><button type="button" class="primary" data-passkey>Continue with passkey</button>${cancel}</div>
${view.page === "authorize" ? `<p class="muted switch">New here? <button type="button" class="link" data-passkey="register">Create an account</button></p>` : ""}`,
		register: `<h1>Create an account on ${e(view.title)}</h1>
<p>${who} wants to create an account for you on ${host}, with a new passkey. It will be able to read and send messages as you.</p>
${caution}
<div class="actions"><button type="button" class="primary" data-passkey>Create passkey</button>${cancel}</div>`,
		add: `<h1>Add a passkey</h1>
<p>${who} wants to add a passkey to <strong>${e(account)}</strong>’s account on ${host}.</p>
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
${screens[view.start]}
<noscript><p>This page needs JavaScript to use your passkey.</p></noscript>
<p id="status" class="warn" role="status" aria-live="polite"></p>
</main>
<script type="application/json" id="config">${scriptJson({ page: view.page, start: view.start, query: view.query, deny: view.deny })}</script>
<script nonce="${nonce}">${SCRIPT}</script>
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
