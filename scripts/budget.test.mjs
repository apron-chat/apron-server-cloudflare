import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMISSION_BUDGET, DEFAULT_LIMITS } from '../src/budget.ts';
import { mediaHostname, relyingPartyId, renderBinding, renderEdgeRules, replaceBinding, validateAdmission, validateDeploymentConfiguration, validateEdgeStop } from './budget.mjs';

const namespaces = { attempts: '123', prefix: '124', location: '125' };

test('changed admission limits propagate to both Worker and optional edge policy', () => {
	const changed = { ...ADMISSION_BUDGET, requestsPerIpMinute: 25, edgeRequestsPerIpWindow: 20 };
	assert.match(renderBinding(namespaces, changed), /limit = 25, period = 60/);
	const edge = renderEdgeRules('chat.example.test', changed);
	assert.equal(edge.optionalZoneRateLimit.rules[0].ratelimit.requests_per_period, 20);
	assert.equal(edge.optionalZoneRateLimit.rules[0].enabled, false);
	assert.match(edge.custom.rules[0].expression, /http.host eq "chat.example.test"/);
	assert.equal(edge.custom.rules[1].enabled, false);
	assert.deepEqual(edge.custom.rules.map((rule) => rule.ref), ['apron_invalid_request', 'apron_admission_off', 'apron_budget_stop']);
	assert.equal(edge.custom.rules[2].enabled, false);
	assert.equal(edge.custom.rules[2].expression, 'http.host eq "chat.example.test"');
});

test('generation is idempotent and preserves unrelated Wrangler settings', () => {
	const original = 'name = "example"\n[vars]\nADMISSION_OFF = "true"\n';
	const initial = replaceBinding(original, renderBinding(namespaces));
	assert.equal(replaceBinding(initial, renderBinding(namespaces)), initial);
	const changed = replaceBinding(initial, renderBinding({ attempts: '456', prefix: '457', location: '458' }));
	assert.ok(changed.startsWith(original));
	assert.match(changed, /namespace_id = "456"/);
	assert.doesNotMatch(changed, /namespace_id = "123"/);
});

test('invalid windows and inconsistent attempt budgets cannot be generated', () => {
	for (const requestsPerIpMinute of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => validateAdmission({ ...ADMISSION_BUDGET, requestsPerIpMinute }));
	}
	assert.throws(() => validateAdmission({ ...ADMISSION_BUDGET, workerWindowSeconds: 10 }));
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
	assert.equal(mediaHostname('MEDIA_ORIGIN = "https://media.example.test"\n'), 'media.example.test');
	assert.equal(mediaHostname('MEDIA_ORIGIN = "http://media.example.test"\n'), undefined);
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
});
