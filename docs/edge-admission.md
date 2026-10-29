# Edge admission and quota exhaustion

On Workers Free, the plan's hard quotas, rather than application counters,
prevent Workers/SQLite DO overage charges. On Workers Paid, included usage is
not a spending cap: requests these rules block at the edge never invoke the
Worker and are not billed as Worker requests, which makes the rules the first
line against billed abuse traffic there. This policy reduces abuse and
preserves capacity where possible; distributed attacks can still exhaust a
day's allowance.

## Applying the generated rules

Edit limits in the selected plan file under `src/plans/`, then run
`npm run budget:generate` and review
[`edge-rules.generated.json`](edge-rules.generated.json). The server hostname
is read from the production Wrangler custom domain, and, for a plan with
uploads, the media hostname from its `MEDIA_ORIGIN`. This file contains rule
definitions grouped by phase; it is not a payload for replacing an entire zone
ruleset.

During an authorized deployment:

1. Verify the account's Workers plan matches `PLAN` in `src/budget.ts`, the zone's WAF capabilities,
   available rule slots, and existing rules/Skip actions. Keep HTTP DDoS protection
   enabled. Do not enable a paid feature to install these rules.
2. Add or update `apron_invalid_request` in the zone's custom-rule phase using
   the generated expression and Block action. It is scoped to the server hostname
   and rejects unsupported paths, non-GET requests, and missing/non-WebSocket
   Upgrade headers, except for the explicit `apron_connection_status=1` HTTP
   diagnostic probe and, with uploads, `write_url` requests (`PUT` and `OPTIONS`
   on `/w/`). Probes retain Worker rate limiting and origin checks.
   Header comparison is case insensitive. Have Cloudflare validate
   the expression before saving. Place it before any applicable Skip rule.
3. Optionally create `apron_admission_off`, disabled, as an emergency Block rule.
   Enabling it prevents new requests from invoking the Worker. It does not close
   already upgraded sockets. Never replace unrelated rules with this file.
   On Workers Paid, also create:
   - `apron_budget_stop`, disabled, which blocks the server hostname and, with
     uploads, the media hostname. The
     [budget guard](configuration.md#budget-guard) turns it on and off; do not
     change it by hand or reuse it for anything else.
   - With uploads, `apron_media_invalid`, enabled, which lets the media
     hostname serve only `GET` and `HEAD` of keys under `/f/`, `/a/` and `/e/`,
     without a query string that would skip the cache.

   Place these before any applicable Skip rule.
4. The optional rate rule `apron_connection_attempts` is **disabled by design**.
   It counts per location and source IP over 10 seconds. Free WAF rate rules
   cannot filter by hostname: it would count `/` and `/ws` on `apron.chat`,
   `web.apron.chat`, and every other hostname in the zone. Enable it only after
   explicitly accepting that impact and checking the available single rate-rule
   slot. Leave it disabled otherwise; the Worker admission limiter still applies.
5. Deploy the Worker by merging to `main` (the Deploy workflow runs
   `npm run deploy` after typecheck and tests) or with `npm run deploy`. Both
   check generated-policy freshness and select `wrangler.production.toml`.
   These commands do not install WAF rules. A budget change affecting an enabled
   edge rate rule requires updating that rule from the regenerated definition.

Neither generation nor local tests inspect or mutate the live account. Changes
to rules require the normal dashboard or Rulesets API deployment process. Do not
enable blanket browser challenges on WebSocket handshakes: clients cannot complete
an interactive challenge there. Guest custom frontends remain supported.

## Verification

After applying rules, use a handful of requests, not a quota-exhaustion load test:

- Confirm a normal handshake on both `/` and `/ws` succeeds, including a custom
  browser origin and an originless client. The app's normal connection caps apply.
- Confirm plain HTTP GET, POST, and invalid paths on the server hostname are
  blocked at the edge; check the matching rule in Security Events.
- Confirm `GET /ws?apron_connection_status=1` reaches the Worker and exposes
  capacity errors, `Retry-After`, and the `Apron-Connection-Status: 1` marker to
  the frontend through CORS.
- With uploads, confirm an uploaded image loads from the media hostname, and
  a query string or a path outside `/f/`, `/a/` and `/e/` there is blocked.
- Confirm the web and documentation hosts are unaffected by the custom rules.
- Review aggregate Worker/DO metrics and active edge definitions against the
  generated policy. Local tests verify admission behavior, not live WAF billing.

## When capacity runs low

On Workers Paid, the budget guard turns on `apron_budget_stop` by itself as
usage nears the plan's allowances. To stop new Worker invocations by hand,
enable the hostname-scoped `apron_admission_off`.
If only DO admission must stop, set `ADMISSION_OFF=true` and deploy: the entry
Worker rejects before invoking the DO, but those HTTP requests still consume
Worker quota. Existing sockets continue; their messages still consume DO request
units even when application handlers reject them. Application frame limits close
abusive sockets but cannot undo already received messages.

Preserve the DO and its data. Do not delete namespaces, rotate object names, or
upgrade billing to recover. Check account-wide usage, including other workloads,
and wait for the documented 00:00 UTC daily reset when a Free quota is exhausted.
Restore admission only after investigating the traffic and remaining capacity.

Rate limits at the edge and in the Worker are approximate, with enforcement
delays and location-local counters. Neither implements an exact global request
budget. Avoid a separate quota DO: each check would itself spend a DO request.

## References

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [DO pricing and Free exhaustion](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Worker rate-limiter locality and accuracy](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [WAF Free fields, windows, and limitations](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- [Rules language array functions](https://developers.cloudflare.com/ruleset-engine/rules-language/values/)

Record the actual zone plan and installed rule references alongside the
Worker version in the [deployment checklist](guide.md#deployment-checklist),
so later budget changes and drift investigations need not rediscover the
account's capabilities.
