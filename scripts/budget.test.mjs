import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMISSION_BUDGET, DEFAULT_LIMITS } from '../src/budget.ts';
import { customDomains, mediaHostname, relyingPartyId, renderBinding, signInPages, renderEdgeRules, replaceBinding, splitPreviews, validateAdmission, validateDeploymentConfiguration, validateEdgeStop, webClientTarget, wranglerVars } from './budget.mjs';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';

const namespaces = { attempts: '123', prefix: '124', location: '125', live: '126' };

test('changed admission limits propagate to both Worker and optional edge policy', () => {
	const requests = ADMISSION_BUDGET.requestsPerIpMinute + 5;
	const changed = { ...ADMISSION_BUDGET, requestsPerIpMinute: requests, edgeRequestsPerIpWindow: 20 };
	assert.match(renderBinding(namespaces, changed), new RegExp(`limit = ${requests}, period = 60`));
	const edge = renderEdgeRules('chat.example.test', changed);
	assert.equal(edge.optionalZoneRateLimit.rules[0].ratelimit.requests_per_period, 20);
	assert.equal(edge.optionalZoneRateLimit.rules[0].enabled, false);
	assert.match(edge.custom.rules[0].expression, /http.host eq "chat.example.test"/);
	assert.equal(edge.custom.rules[1].enabled, false);
	assert.deepEqual(edge.custom.rules.map((rule) => rule.ref), ['apron_invalid_request', 'apron_admission_off', 'apron_budget_stop']);
	assert.equal(edge.custom.rules[2].enabled, false);
	assert.equal(edge.custom.rules[2].expression, 'http.host eq "chat.example.test"');
});

test('a browser opening the server as a page is redirected to the web client with its own host', () => {
	assert.equal(renderEdgeRules('chat.example.test').redirect, undefined);
	const edge = renderEdgeRules('chat.example.test', ADMISSION_BUDGET, undefined, false, false, 'https://web.example.test/');
	assert.equal(edge.redirect.phase, 'http_request_dynamic_redirect');
	const [rule] = edge.redirect.rules;
	assert.equal(rule.ref, 'apron_browser_redirect');
	assert.equal(rule.enabled, true);
	assert.match(rule.expression, /^\(http.host eq "chat.example.test"\) and http.request.method eq "GET" and http.request.uri.path eq "\/" /);
	// It redirects exactly the plain page loads apron_invalid_request blocks.
	assert.match(rule.expression, /and not any\(lower\(http.request.headers\["upgrade"\]\[\*\]\)\[\*\] eq "websocket"\) and not any\(http.request.uri.args\["apron_connection_status"\]\[\*\] eq "1"\)$/);
	assert.ok(edge.custom.rules[0].expression.includes('not any(lower(http.request.headers["upgrade"][*])[*] eq "websocket") and not any(http.request.uri.args["apron_connection_status"][*] eq "1")'));
	assert.deepEqual(rule.action_parameters.from_value, {
		status_code: 302,
		target_url: { expression: 'concat("https://web.example.test/#server=wss://", http.host, "/")' },
		preserve_query_string: false,
	});
	assert.doesNotMatch(rule.action_parameters.from_value.target_url.expression, /chat\.example\.test/);
	for (const bad of ['http://web.example.test/', 'https://web.example.test/#x', 'https://u:p@web.example.test/', 'not a url']) {
		assert.throws(() => webClientTarget(bad));
	}
});

test('generation is idempotent and preserves unrelated Wrangler settings', () => {
	const original = 'name = "example"\n[vars]\nADMISSION_OFF = "true"\n';
	const initial = replaceBinding(original, renderBinding(namespaces));
	assert.equal(replaceBinding(initial, renderBinding(namespaces)), initial);
	const changed = replaceBinding(initial, renderBinding({ attempts: '456', prefix: '457', location: '458', live: '459' }));
	assert.ok(changed.startsWith(original));
	assert.match(changed, /namespace_id = "456"/);
	assert.doesNotMatch(changed, /namespace_id = "123"/);
});

test('invalid windows and inconsistent attempt budgets cannot be generated', () => {
	for (const requestsPerIpMinute of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => validateAdmission({ ...ADMISSION_BUDGET, requestsPerIpMinute }));
	}
	assert.throws(() => validateAdmission({ ...ADMISSION_BUDGET, workerWindowSeconds: 10 }));
	assert.throws(() => validateAdmission({ ...ADMISSION_BUDGET, liveReadsPerLocationMinute: undefined }));
	assert.throws(() => validateAdmission({ ...ADMISSION_BUDGET, liveReadsPerLocationMinute: ADMISSION_BUDGET.requestsPerIpMinute - 1 }));
	assert.throws(() => validateAdmission({ ...ADMISSION_BUDGET, edgeWindowSeconds: 60 }));
	assert.throws(() => validateAdmission({ ...ADMISSION_BUDGET, edgeBlockSeconds: 60 }));
	assert.throws(() => validateAdmission(ADMISSION_BUDGET, {
		...DEFAULT_LIMITS, connectionAdmissionsPerIpMinute: ADMISSION_BUDGET.requestsPerIpMinute + 1,
	}));
});

test('malformed generated sections fail without rewriting configuration', () => {
	assert.throws(() => replaceBinding('# BEGIN GENERATED ADMISSION BUDGET\n', renderBinding(namespaces)));
});

test('deployment configuration isolates development and protects production selection', () => {
	const packageJson = { scripts: { deploy: 'npm run budget:check && wrangler deploy --config wrangler.production.toml' } };
	const workflow = '      - run: npm run deploy\n';
	assert.doesNotThrow(() => validateDeploymentConfiguration({
		development: 'name = "apron-cloudflare-demo-dev"\n',
		production: 'name = "apron-cloudflare-demo"\nworkers_dev = false\npreview_urls = false\nroutes = [{ pattern = "server.apron.chat", custom_domain = true }]\n',
		packageJson,
		workflow,
	}));
	assert.throws(() => validateDeploymentConfiguration({
		development: 'name = "apron-cloudflare-demo"\n',
		production: 'name = "apron-cloudflare-demo"\nworkers_dev = false\npreview_urls = false\nroutes = [{ pattern = "server.apron.chat", custom_domain = true }]\n',
		packageJson,
		workflow,
	}), /distinct/);
	assert.throws(() => validateDeploymentConfiguration({
		development: 'name = "apron-cloudflare-demo-dev"\n',
		production: 'name = "apron-cloudflare-demo"\nworkers_dev = true\npreview_urls = false\nroutes = [{ pattern = "server.apron.chat", custom_domain = true }]\n',
		packageJson,
		workflow,
	}), /workers\.dev/);
	assert.throws(() => validateDeploymentConfiguration({
		development: 'name = "apron-cloudflare-demo-dev"\n',
		production: 'name = "apron-cloudflare-demo"\nworkers_dev = false\npreview_urls = true\nroutes = [{ pattern = "server.apron.chat", custom_domain = true }]\n',
		packageJson,
		workflow,
	}), /preview/);
	assert.throws(() => validateDeploymentConfiguration({
		development: 'name = "apron-cloudflare-demo-dev"\n',
		production: 'name = "apron-cloudflare-demo"\nworkers_dev = false\npreview_urls = false\nroutes = [{ pattern = "other.example", custom_domain = true }]\n',
		packageJson,
		workflow,
	}), /custom domain/);
	assert.throws(() => validateDeploymentConfiguration({
		development: 'name = "apron-cloudflare-demo-dev"\n',
		production: 'name = "apron-cloudflare-demo"\nworkers_dev = false\npreview_urls = false\nroutes = [{ pattern = "server.apron.chat", custom_domain = true }]\n',
		packageJson: { scripts: { deploy: 'wrangler deploy' } },
		workflow,
	}), /production\.toml/);
	assert.throws(() => validateDeploymentConfiguration({
		development: 'name = "apron-cloudflare-demo-dev"\n',
		production: 'name = "apron-cloudflare-demo"\nworkers_dev = false\npreview_urls = false\nroutes = [{ pattern = "server.apron.chat", custom_domain = true }]\n[assets]\ndirectory = "./build"\n',
		packageJson,
		workflow,
	}), /static assets/);
	assert.throws(() => validateDeploymentConfiguration({
		development: 'name = "apron-cloudflare-demo-dev"\n',
		production: 'name = "apron-cloudflare-demo"\nworkers_dev = false\npreview_urls = false\nroutes = [{ pattern = "server.apron.chat", custom_domain = true }]\n',
		packageJson,
		workflow: '      - run: npx wrangler deploy\n',
	}), /deploy workflow/);
});

test('a plan that bills past its included usage requires the budget guard cron and zone', () => {
	const packageJson = { scripts: { deploy: 'npm run budget:check && wrangler deploy --config wrangler.production.toml' } };
	const workflow = '      - run: npm run deploy\n';
	const development = 'name = "apron-cloudflare-demo-dev"\n';
	const base = 'name = "apron-cloudflare-demo"\nworkers_dev = false\npreview_urls = false\nroutes = [{ pattern = "server.apron.chat", custom_domain = true }]\n';
	const zone = '[vars]\nZONE_ID = "d7467571c212da5b57bbc92afeb967b7"\n';
	const cron = '[triggers]\ncrons = ["* * * * *"]\n';
	const check = (production) => validateDeploymentConfiguration({ development, production, packageJson, workflow, budgetGuard: true });
	assert.doesNotThrow(() => check(base + zone + cron));
	assert.doesNotThrow(() => validateDeploymentConfiguration({ development, production: base, packageJson, workflow }));
	assert.throws(() => check(base + zone), /every minute/);
	assert.throws(() => check(base + zone + '[triggers]\ncrons = ["*/5 * * * *"]\n'), /every minute/);
	assert.throws(() => check(base + cron), /ZONE_ID/);
});

test('a plan that estimates log bytes requires production to sample logs at most at its rate', () => {
	const packageJson = { scripts: { deploy: 'npm run budget:check && wrangler deploy --config wrangler.production.toml' } };
	const workflow = '      - run: npm run deploy\n';
	const development = 'name = "apron-cloudflare-demo-dev"\n';
	const base = 'name = "apron-cloudflare-demo"\nworkers_dev = false\npreview_urls = false\nroutes = [{ pattern = "server.apron.chat", custom_domain = true }]\n';
	const check = (production) => validateDeploymentConfiguration({ development, production, packageJson, workflow, logSampleRate: 0.1 });
	assert.doesNotThrow(() => check(base + '[observability]\nenabled = true\nhead_sampling_rate = 0.1\n'));
	assert.doesNotThrow(() => check(base + '[observability]\nenabled = true\n# one in twenty\nhead_sampling_rate = 0.05\n'));
	assert.doesNotThrow(() => check(base + '[observability]\nenabled = false\n'));
	assert.throws(() => check(base + '[observability]\nenabled = true\nhead_sampling_rate = 0.5\n'), /head_sampling_rate/);
	// Unset, Workers Logs sample every request.
	assert.throws(() => check(base + '[observability]\nenabled = true\n'), /head_sampling_rate/);
	assert.throws(() => check(base), /head_sampling_rate/);
	assert.doesNotThrow(() => validateDeploymentConfiguration({ development, production: base, packageJson, workflow }));
});

test('a plan with an edge stop also generates the sampled flood counter', () => {
	const edgeStop = { floodRequestsPerColoMinute: 1200, floodSampleEvery: 20, holdSeconds: 1800 };
	const binding = renderBinding(namespaces, ADMISSION_BUDGET, { namespace: '456', edgeStop });
	assert.match(binding, /name = "CONNECTION_ATTEMPTS"\nnamespace_id = "123"/);
	assert.match(binding, /name = "FLOOD_WATCH"\nnamespace_id = "456"\nsimple = \{ limit = 60, period = 60 \}/);
	assert.doesNotMatch(renderBinding(namespaces), /FLOOD_WATCH/);
	assert.throws(() => validateEdgeStop({ ...edgeStop, floodSampleEvery: 7 }), /whole number/);
	// Its namespace is checked like the attempt limits' four.
	assert.throws(() => renderBinding(namespaces, ADMISSION_BUDGET, { namespace: namespaces.location, edgeStop }), /distinct/);
	assert.throws(() => renderBinding(namespaces, ADMISSION_BUDGET, { namespace: 'abc', edgeStop }), /distinct/);
	assert.throws(() => validateEdgeStop({ ...edgeStop, holdSeconds: 0 }));
});

test('the /48 and location attempt limits are generated from the plan and kept consistent', () => {
	const binding = renderBinding(namespaces);
	assert.match(binding, new RegExp(`name = "PREFIX_ATTEMPTS"\nnamespace_id = "124"\nsimple = \\{ limit = ${ADMISSION_BUDGET.requestsPerIpv6PrefixMinute}, period = 60 \\}`));
	assert.match(binding, new RegExp(`name = "LOCATION_ATTEMPTS"\nnamespace_id = "125"\nsimple = \\{ limit = ${ADMISSION_BUDGET.objectRequestsPerLocationMinute}, period = 60 \\}`));
	// Always all three: the Worker refuses every connection without any of them.
	for (const missing of ['attempts', 'prefix', 'location']) {
		assert.throws(() => renderBinding({ ...namespaces, [missing]: undefined }), /namespace IDs/);
	}
	assert.throws(() => renderBinding('123'), /namespace IDs/);
	assert.throws(() => renderBinding({ ...namespaces, location: '123' }), /distinct/);
	assert.throws(() => validateAdmission({ ...ADMISSION_BUDGET, requestsPerIpv6PrefixMinute: ADMISSION_BUDGET.requestsPerIpMinute - 1 }), /48/);
	assert.throws(() => validateAdmission({ ...ADMISSION_BUDGET, objectRequestsPerLocationMinute: DEFAULT_LIMITS.openConnections - 1 }), /location/);
	assert.throws(() => validateAdmission({ ...ADMISSION_BUDGET, objectRequestsPerLocationMinute: 0 }));
});

test('with uploads, write URLs pass the invalid-request rule and the budget stop covers the media host', () => {
	const plain = renderEdgeRules('chat.example.test');
	assert.doesNotMatch(plain.custom.rules[0].expression, /\/w\//);
	const edge = renderEdgeRules('chat.example.test', ADMISSION_BUDGET, 'media.example.test');
	assert.match(edge.custom.rules[0].expression, /^\(http\.host eq "chat\.example\.test"\) and not \(http\.request\.method in \{"PUT" "OPTIONS"\} and starts_with\(http\.request\.uri\.path, "\/w\/"\)\) and /);
	assert.equal(edge.custom.rules[1].expression, 'http.host eq "chat.example.test"');
	assert.deepEqual(edge.custom.rules.map((rule) => rule.ref), ['apron_invalid_request', 'apron_admission_off', 'apron_media_invalid', 'apron_budget_stop']);
	assert.match(edge.custom.rules[2].expression, /^\(http\.host eq "media\.example\.test"\) and \(not http\.request\.method in \{"GET" "HEAD"\} or http\.request\.uri\.query ne ""/);
	assert.equal(edge.custom.rules[2].enabled, true);
	assert.equal(edge.custom.rules[3].expression, 'http.host in {"chat.example.test" "media.example.test"}');
	// Every file the bucket serves is never sniffed: an uploaded text can't run as a script.
	assert.deepEqual(edge.headers, { phase: 'http_response_headers_transform', rules: [{ ref: 'apron_media_nosniff', description: edge.headers.rules[0].description, expression: 'http.host eq "media.example.test"', action: 'rewrite', enabled: true, action_parameters: { headers: { 'X-Content-Type-Options': { operation: 'set', value: 'nosniff' } } } }] });
	assert.equal(plain.headers, undefined);
	assert.equal(mediaHostname('[vars]\nMEDIA_ORIGIN = "https://media.example.test"\n'), 'media.example.test');
	assert.equal(mediaHostname('[vars]\nMEDIA_ORIGIN = "http://media.example.test"\n'), undefined);
	// Only [vars] reach the Worker: a top-level key of the same name is no var.
	assert.equal(mediaHostname('MEDIA_ORIGIN = "https://media.example.test"\n'), undefined);
});

test('with live text, write URLs and live reads pass the invalid-request rule', () => {
	const edge = renderEdgeRules('chat.example.test', ADMISSION_BUDGET, 'media.example.test', true);
	const rule = edge.custom.rules[0];
	assert.match(rule.expression, /and not \(http\.request\.method in \{"PUT" "OPTIONS"\} and starts_with\(http\.request\.uri\.path, "\/w\/"\)\) and not \(http\.request\.method in \{"GET" "HEAD" "OPTIONS"\} and starts_with\(http\.request\.uri\.path, "\/live\/"\)\) and /);
	assert.equal(rule.description, 'Apron: allow WebSocket handshakes, connection status probes, upload writes, and live text');
	// Without uploads, live text still needs its writes.
	assert.match(renderEdgeRules('chat.example.test', ADMISSION_BUDGET, undefined, true).custom.rules[0].expression, /"\/w\/"/);
});

test('with live text, the edge streams write_url bodies rather than buffering them', () => {
	assert.equal(renderEdgeRules('chat.example.test', ADMISSION_BUDGET, 'media.example.test').config, undefined);
	const { config } = renderEdgeRules('chat.example.test', ADMISSION_BUDGET, undefined, true);
	assert.equal(config.phase, 'http_config_settings');
	assert.deepEqual(config.rules, [{
		ref: 'apron_write_streaming',
		description: 'Apron: stream write_url bodies to the Worker as they arrive (live text)',
		expression: '(http.host eq "chat.example.test") and http.request.method eq "PUT" and starts_with(http.request.uri.path, "/w/")',
		action: 'set_config', enabled: true,
		action_parameters: { request_body_buffering: 'none' },
	}]);
});

test('where the server hostname is its RP ID, passkey related origins pass the invalid-request rule', () => {
	const plain = renderEdgeRules('chat.example.test', ADMISSION_BUDGET, 'media.example.test', true);
	assert.doesNotMatch(plain.custom.rules[0].expression, /well-known/);
	const edge = renderEdgeRules('chat.example.test', ADMISSION_BUDGET, 'media.example.test', true, true);
	const rule = edge.custom.rules[0];
	assert.equal(rule.expression, plain.custom.rules[0].expression.replace(' and (http.request.method ne "GET"', ' and not (http.request.method in {"GET" "HEAD"} and http.request.uri.path eq "/.well-known/webauthn") and (http.request.method ne "GET"'));
	assert.equal(rule.description, 'Apron: allow WebSocket handshakes, connection status probes, upload writes, live text, and passkey related origins');
	assert.deepEqual(edge.custom.rules.slice(1), plain.custom.rules.slice(1));
	assert.equal(relyingPartyId('[vars]\nRP_ID = "Chat.Example.Test" # the server\n'), 'chat.example.test');
	assert.equal(relyingPartyId('[vars]\nRP_ORIGINS = "https://chat.example.test"\n'), undefined);
});

test('where the server hostname serves the passkey page, its paths pass the invalid-request rule, and external\'s with EXTERNAL_SIGN_IN', () => {
	const plain = renderEdgeRules('chat.example.test', ADMISSION_BUDGET, undefined, true);
	assert.doesNotMatch(plain.custom.rules[0].expression, /passkey|oauth/);
	const page = renderEdgeRules('chat.example.test', ADMISSION_BUDGET, undefined, true, false, undefined, { external: false });
	const passkey = ' and not (http.request.method eq "GET" and http.request.uri.path eq "/passkey") and not (http.request.method eq "POST" and http.request.uri.path in {"/passkey/begin" "/passkey/finish"})';
	assert.equal(page.custom.rules[0].expression, plain.custom.rules[0].expression.replace(' and (http.request.method ne "GET"', `${passkey} and (http.request.method ne "GET"`));
	assert.equal(page.custom.rules[0].description, 'Apron: allow WebSocket handshakes, connection status probes, live text, and the passkey page');
	assert.doesNotMatch(page.custom.rules[0].expression, /oauth/);
	const external = renderEdgeRules('chat.example.test', ADMISSION_BUDGET, undefined, true, false, undefined, { external: true });
	assert.match(external.custom.rules[0].expression, /"\/oauth\/authorize"/);
	assert.match(external.custom.rules[0].expression, /\{"POST" "OPTIONS"\} and http\.request\.uri\.path eq "\/oauth\/token"/);
	assert.match(external.custom.rules[0].expression, /"\/\.well-known\/oauth-authorization-server"/);
	assert.match(external.custom.rules[0].description, /the passkey page, and external sign-in$/);
	assert.deepEqual(external.custom.rules.slice(1), plain.custom.rules.slice(1));
	// The production host is under RP_ID: the page is on unless PASSKEY_PAGE says otherwise.
	const production = '[vars]\nRP_ID = "example.test"\n';
	assert.deepEqual(signInPages(production, 'chat.example.test'), { external: false });
	assert.deepEqual(signInPages(production, 'example.test'), { external: false });
	assert.deepEqual(signInPages(`${production}EXTERNAL_SIGN_IN = "true"\n`, 'chat.example.test'), { external: true });
	assert.equal(signInPages(`${production}PASSKEY_PAGE = "false"\n`, 'chat.example.test'), undefined);
	assert.equal(signInPages(production, 'chat.other.test'), undefined);
	assert.equal(signInPages(production, 'badexample.test'), undefined);
	assert.equal(signInPages('[vars]\n', 'chat.example.test'), undefined);
});

test('a plan with uploads requires the bucket binding and both origins', () => {
	const packageJson = { scripts: { deploy: 'npm run budget:check && wrangler deploy --config wrangler.production.toml' } };
	const workflow = '      - run: npm run deploy\n';
	const development = 'name = "apron-cloudflare-demo-dev"\n';
	const base = 'name = "apron-cloudflare-demo"\nworkers_dev = false\npreview_urls = false\nroutes = [{ pattern = "server.apron.chat", custom_domain = true }]\n';
	const vars = '[vars]\nMEDIA_ORIGIN = "https://media.apron.chat"\nPUBLIC_ORIGIN = "https://server.apron.chat"\n';
	const bucket = '[[r2_buckets]]\nbinding = "MEDIA"\nbucket_name = "apron-media"\n';
	const check = (production) => validateDeploymentConfiguration({ development, production, packageJson, workflow, uploads: true });
	assert.doesNotThrow(() => check(base + vars + bucket));
	assert.throws(() => check(base + vars), /MEDIA bucket/);
	assert.throws(() => check(base + bucket + '[vars]\nPUBLIC_ORIGIN = "https://server.apron.chat"\n'), /MEDIA_ORIGIN/);
	assert.throws(() => check(base + bucket + '[vars]\nMEDIA_ORIGIN = "https://media.apron.chat"\n'), /PUBLIC_ORIGIN/);
	// MEDIA_NOSNIFF, when set, is a switch: a typo would fail every request once deployed.
	assert.doesNotThrow(() => check(base + vars + 'MEDIA_NOSNIFF = "true"\n' + bucket));
	assert.throws(() => check(base + vars + 'MEDIA_NOSNIFF = "ture"\n' + bucket), /MEDIA_NOSNIFF/);
});

test('Previews get the same rate limiters under previews.ratelimits, in namespaces of their own', () => {
	const edgeStop = { floodRequestsPerColoMinute: 1200, floodSampleEvery: 20, holdSeconds: 1800 };
	const flood = { namespace: '127', edgeStop };
	const previews = { namespaces: { attempts: '223', prefix: '224', location: '225', live: '226' }, flood: '227' };
	const binding = renderBinding(namespaces, ADMISSION_BUDGET, flood, previews);
	// Production's tables are as without Previews; the Previews' follow, inside the generated block.
	assert.ok(binding.startsWith(renderBinding(namespaces, ADMISSION_BUDGET, flood).replace(/\n# END GENERATED ADMISSION BUDGET$/, '')));
	assert.match(binding, /\[\[previews\.ratelimits\]\]\nname = "CONNECTION_ATTEMPTS"\nnamespace_id = "223"/);
	assert.match(binding, /\[\[previews\.ratelimits\]\]\nname = "FLOOD_WATCH"\nnamespace_id = "227"\nsimple = \{ limit = 60, period = 60 \}/);
	assert.equal(binding.match(/^\[\[previews\.ratelimits\]\]$/gm).length, 5);
	assert.match(binding, /# END GENERATED ADMISSION BUDGET$/);
	assert.doesNotMatch(renderBinding({ ...namespaces }, ADMISSION_BUDGET, undefined, { namespaces: previews.namespaces }), /FLOOD_WATCH/);
	// No namespace may be shared with production's, or within the Previews'.
	assert.throws(() => renderBinding(namespaces, ADMISSION_BUDGET, flood, { ...previews, namespaces: { ...previews.namespaces, live: '123' } }), /distinct from production/);
	assert.throws(() => renderBinding(namespaces, ADMISSION_BUDGET, flood, { ...previews, flood: '127' }), /distinct from production/);
	assert.throws(() => renderBinding(namespaces, ADMISSION_BUDGET, flood, { ...previews, flood: '223' }), /flood counter/);
	assert.throws(() => renderBinding(namespaces, ADMISSION_BUDGET, flood, { ...previews, namespaces: { ...previews.namespaces, prefix: '223' } }), /namespace IDs/);
});

test('with Previews, every rule scoped to the server hostname covers the Preview hosts too', () => {
	const signIn = { external: false };
	const plain = renderEdgeRules('chat.example.test', ADMISSION_BUDGET, 'media.example.test', true, false, 'https://web.example.test/', signIn);
	const edge = renderEdgeRules('chat.example.test', ADMISSION_BUDGET, 'media.example.test', true, false, 'https://web.example.test/', signIn, { hostname: 'previews.example.test', liveText: false, signIn: { external: true } });
	const preview = 'ends_with(http.host, ".previews.example.test")';
	const [invalid, off, media, stop] = edge.custom.rules;
	// Each host lets through what it serves: production its writes, live text and passkey page; Previews their passkey page and external sign-in.
	const tail = ' and (http.request.method ne "GET"';
	const productionPart = plain.custom.rules[0].expression.slice(0, plain.custom.rules[0].expression.indexOf(tail));
	assert.ok(invalid.expression.startsWith(`((${productionPart}) or ((${preview}) and not (http.request.method eq "GET" and http.request.uri.path eq "/passkey")`));
	assert.ok(invalid.expression.endsWith(plain.custom.rules[0].expression.slice(productionPart.length)));
	assert.equal(productionPart.match(/oauth/g), null);
	assert.match(invalid.expression.slice(invalid.expression.indexOf(preview)), /"\/oauth\/authorize"/);
	assert.doesNotMatch(invalid.expression.slice(invalid.expression.indexOf(preview)), /"\/w\/"|"\/live\/"/);
	assert.equal(invalid.description, `${plain.custom.rules[0].description}; on Previews, WebSocket handshakes, connection status probes, the passkey page, and external sign-in`);
	assert.equal(off.expression, `http.host eq "chat.example.test" or ${preview}`);
	assert.deepEqual(media, plain.custom.rules[2]);
	assert.equal(stop.ref, 'apron_budget_stop');
	assert.equal(stop.expression, `http.host in {"chat.example.test" "media.example.test"} or ${preview}`);
	assert.ok(edge.redirect.rules[0].expression.startsWith(`(http.host eq "chat.example.test" or ${preview}) and http.request.method eq "GET"`));
	// No live text on Previews: the write streaming rule stays production's; the media host's rules are unchanged.
	assert.deepEqual(edge.config, plain.config);
	assert.deepEqual(edge.headers, plain.headers);
	assert.equal(renderEdgeRules('chat.example.test', ADMISSION_BUDGET, undefined, true, false, undefined, undefined, { hostname: 'previews.example.test', liveText: true }).config.rules[0].expression.startsWith(`(http.host eq "chat.example.test" or ${preview})`), true);
	// Without media, the stop names the server host alone, then the Previews.
	assert.equal(renderEdgeRules('chat.example.test', ADMISSION_BUDGET, undefined, false, false, undefined, undefined, { hostname: 'previews.example.test' }).custom.rules[2].expression, `http.host eq "chat.example.test" or ${preview}`);
	assert.throws(() => renderEdgeRules('chat.example.test', ADMISSION_BUDGET, undefined, false, false, undefined, undefined, { hostname: '"x" or true' }), /host name/);
});

test('a Wrangler config\'s Previews are read apart from production\'s settings', () => {
	const source = [
		'name = "w"',
		'routes = [',
		'  { pattern = "chat.example.test", custom_domain = true },',
		'  { pattern = "previews.example.test", custom_domain = true, previews_enabled = true, enabled = false }',
		']',
		'[vars]',
		'RP_ID = "example.test"',
		'',
		'[previews.vars]',
		'RP_ID = "previews.example.test" # their own',
		'EXTERNAL_SIGN_IN = "true"',
		'',
		'[previews.durable_objects]',
		'bindings = [{ name = "DEMO", class_name = "C" }]',
		'[[ratelimits]]',
		'name = "A"',
		'[[previews.ratelimits]]',
		'name = "B"',
		'',
	].join('\n');
	const { production, previews } = splitPreviews(source);
	assert.equal(production.previews, undefined);
	// smol-toml's tables have no prototype: compare their contents.
	const plain = (value) => JSON.parse(JSON.stringify(value));
	assert.deepEqual(plain(production.ratelimits), [{ name: 'A' }]);
	assert.deepEqual(plain(previews.ratelimits), [{ name: 'B' }]);
	assert.deepEqual(plain(previews.durable_objects), { bindings: [{ name: 'DEMO', class_name: 'C' }] });
	assert.deepEqual(wranglerVars(previews), { RP_ID: 'previews.example.test', EXTERNAL_SIGN_IN: 'true' });
	assert.deepEqual(wranglerVars(production), { RP_ID: 'example.test' });
	// Production's switches are its own: the Previews' EXTERNAL_SIGN_IN does not reach its rule.
	assert.deepEqual(signInPages(production, 'chat.example.test'), { external: false });
	assert.deepEqual(signInPages(previews, 'previews.example.test'), { external: true });
	assert.equal(relyingPartyId(production), 'example.test');
	assert.deepEqual(customDomains(source), [
		{ pattern: 'chat.example.test', enabled: true, previews: false },
		{ pattern: 'previews.example.test', enabled: false, previews: true },
	]);
	assert.equal(splitPreviews('name = "w"\n').previews, undefined);
	// Parsed as Wrangler parses it: an inline table reads as [previews.*] tables do.
	assert.deepEqual(plain(splitPreviews('name = "w"\npreviews = { vars = { RP_ID = "p.example.test" } }\n').previews), { vars: { RP_ID: 'p.example.test' } });
	assert.throws(() => splitPreviews('name = "w"\npreviews = "x"\n'), /table/);
});

test('METRICS_DATASET, where set, names the dataset its METRICS binding writes, in production and in Previews', () => {
	const packageJson = { scripts: { deploy: 'npm run budget:check && wrangler deploy --config wrangler.production.toml' } };
	const workflow = '      - run: npm run deploy\n';
	const development = 'name = "apron-cloudflare-demo-dev"\n';
	const route = 'name = "apron-cloudflare-demo"\nworkers_dev = false\npreview_urls = false\nroutes = [\n  { pattern = "server.apron.chat", custom_domain = true },\n  { pattern = "previews.apron.chat", custom_domain = true, previews_enabled = true, enabled = false }\n]\n';
	const production = (named) => `[vars]\nMEDIA_ORIGIN = "https://media.apron.chat"\nPUBLIC_ORIGIN = "https://server.apron.chat"\n${named ? `METRICS_DATASET = "${named}"\n` : ''}[[r2_buckets]]\nbinding = "MEDIA"\nbucket_name = "apron-media"\n[[analytics_engine_datasets]]\nbinding = "METRICS"\ndataset = "apron_server_metrics"\n`;
	const previews = (named) => `[previews.vars]\nMEDIA_ORIGIN = ""\nPUBLIC_ORIGIN = ""\n${named ? `METRICS_DATASET = "${named}"\n` : ''}[previews.durable_objects]\nbindings = [\n  { name = "DEMO", class_name = "ApronDemoServer" }\n]\n[[previews.analytics_engine_datasets]]\nbinding = "METRICS"\ndataset = "apron_server_metrics_preview"\n`;
	const check = (config) => validateDeploymentConfiguration({ development, production: config, packageJson, workflow, uploads: true });
	assert.doesNotThrow(() => check(route + production('apron_server_metrics') + previews('apron_server_metrics_preview')));
	assert.doesNotThrow(() => check(route + production() + previews()));
	assert.throws(() => check(route + production('apron_server_metrics_preview') + previews()), /production METRICS_DATASET/);
	assert.throws(() => check(route + production('apron_server_metrics') + previews('apron_server_metrics')), /Previews METRICS_DATASET/);
	// A name /status would not put in its SQL, though it matches the binding.
	assert.throws(() => check(route + production('apron-server-metrics').replace('dataset = "apron_server_metrics"', 'dataset = "apron-server-metrics"') + previews()), /letters, digits and _/);
});

test('Previews need their own domain and DEMO binding, and share no bucket, dataset or origin with production', () => {
	const packageJson = { scripts: { deploy: 'npm run budget:check && wrangler deploy --config wrangler.production.toml' } };
	const workflow = '      - run: npm run deploy\n';
	const development = 'name = "apron-cloudflare-demo-dev"\n';
	const route = (preview) => `name = "apron-cloudflare-demo"\nworkers_dev = false\npreview_urls = false\nroutes = [\n  { pattern = "server.apron.chat", custom_domain = true },${preview ? `\n  ${preview}` : ''}\n]\n`;
	const previewRoute = '{ pattern = "previews.apron.chat", custom_domain = true, previews_enabled = true, enabled = false }';
	const production = '[vars]\nMEDIA_ORIGIN = "https://media.apron.chat"\nPUBLIC_ORIGIN = "https://server.apron.chat"\n[[r2_buckets]]\nbinding = "MEDIA"\nbucket_name = "apron-media"\n[[analytics_engine_datasets]]\nbinding = "METRICS"\ndataset = "apron_server_metrics"\n';
	const previews = '[previews.vars]\nMEDIA_ORIGIN = ""\nPUBLIC_ORIGIN = ""\n[previews.durable_objects]\nbindings = [\n  { name = "DEMO", class_name = "ApronDemoServer" }\n]\n[[previews.analytics_engine_datasets]]\nbinding = "METRICS"\ndataset = "apron_server_metrics_preview"\n';
	const check = (config) => validateDeploymentConfiguration({ development, production: config, packageJson, workflow, uploads: true });
	assert.doesNotThrow(() => check(route(previewRoute) + production + previews));
	assert.doesNotThrow(() => check(route() + production));
	assert.throws(() => check(route() + production + previews), /exactly one custom domain/);
	assert.throws(() => check(route(previewRoute) + production), /previews block/);
	assert.throws(() => check(route(previewRoute.replace('enabled = false', 'enabled = true')) + production + previews), /only Previews/);
	assert.throws(() => check(route(previewRoute) + production + previews.replace('name = "DEMO"', 'name = "OTHER"')), /DEMO/);
	assert.throws(() => check(route(previewRoute) + production + previews.replace('PUBLIC_ORIGIN = ""', 'PUBLIC_ORIGIN = "https://server.apron.chat"')), /PUBLIC_ORIGIN/);
	assert.throws(() => check(route(previewRoute) + production + previews.replace('_preview"', '"')), /dataset/);
	assert.throws(() => check(route(previewRoute) + production + previews + '[[previews.r2_buckets]]\nbinding = "MEDIA"\nbucket_name = "apron-media"\n'), /bucket_name/);
	assert.doesNotThrow(() => check(route(previewRoute) + production + previews + '[[previews.r2_buckets]]\nbinding = "MEDIA"\nbucket_name = "apron-media-preview"\n'));
	// Production's own checks read production's settings only: a Preview's bucket does not stand in for its MEDIA binding.
	assert.throws(() => check(route(previewRoute) + production.replace('binding = "MEDIA"', 'binding = "OTHER"') + previews + '[[previews.r2_buckets]]\nbinding = "MEDIA"\nbucket_name = "apron-media-preview"\n'), /MEDIA bucket/);
});

test("production writes out the plan's own history limits, and daily backups", () => {
	const { production } = splitPreviews(readFileSync(new URL('../wrangler.production.toml', import.meta.url), 'utf8'));
	const vars = wranglerVars(production);
	const config = loadConfig(vars);
	for (const key of ['retentionRecords', 'retentionSeconds', 'minRetentionSeconds', 'historyD1Records', 'historyBlobRecords', 'cleanupThresholdPercent']) {
		const name = `LIMIT_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
		assert.ok(Object.hasOwn(vars, name), `wrangler.production.toml sets ${name}`);
		assert.equal(config.limits[key], DEFAULT_LIMITS[key], key);
	}
	assert.deepEqual(config.backups, { everySeconds: 86_400, keep: 14, privateRooms: true });
	// Backup encryption's vars are gone: a stale one fails the check instead of meaning nothing.
	for (const name of ['BACKUP_ENCRYPTION_KEY_NAME', 'BACKUP_PREVIOUS_KEY_NAMES', 'IMPORT_PLAINTEXT']) {
		assert.throws(() => loadConfig({ ...vars, [name]: '' }), new RegExp(`${name} is no longer read`));
	}
	// A typo is caught here, before a deploy, not by every request failing after one.
	assert.throws(() => loadConfig({ ...vars, BACKUP_EVERY: '1 day' }), /BACKUP_EVERY must be a duration/);
});
