import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMISSION_BUDGET, DEFAULT_LIMITS } from '../src/budget.ts';
import { renderBinding, renderEdgeRules, replaceBinding, validateAdmission, validateDeploymentConfiguration } from './budget.mjs';

test('changed admission limits propagate to both Worker and optional edge policy', () => {
	const changed = { ...ADMISSION_BUDGET, requestsPerIpMinute: 25, edgeRequestsPerIpWindow: 20 };
	assert.match(renderBinding('123', changed), /limit = 25, period = 60/);
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
	const initial = replaceBinding(original, renderBinding('123'));
	assert.equal(replaceBinding(initial, renderBinding('123')), initial);
	const changed = replaceBinding(initial, renderBinding('456'));
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
	assert.throws(() => replaceBinding('# BEGIN GENERATED ADMISSION BUDGET\n', renderBinding('123')));
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
