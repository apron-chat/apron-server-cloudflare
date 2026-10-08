# Developer and operator guide

How to run, extend, connect to, and deploy the Apron public demo Worker. For
the protocol contract and design, see the [implementation specification](../SPEC.md).

## Overview

A single SQLite Durable Object serves the permanent `general` room and its
thread rooms over hibernating WebSockets. The backend supports guest access,
discoverable passkeys, complete-snapshot history, message
replacement/deletion/restoration/moves, thread rooms, emoji reactions, and a
rolling retention floor. Guests only read (set `GUEST_POSTING=true` to let
them post); signing in with a passkey lets a user post and invite a bot. It speaks protocol 8 with `history`,
`edit`, `rooms`, `reactions`, `command` (`/help`, `/invite-bot`, and admin
commands), and `ext` with its own extension `ext:settings`; `embed:upload`
when uploads are configured; `status` and push when VAPID keys are set; and
liveness pings and, with the Workers Paid budgets, typing through `activity`
(`ACTIVITY` overrides); see [authentication and policy](policy.md) and [the
implementation specification](../SPEC.md).

## Budgets, sessions, and analytics

See the [configuration reference](configuration.md) for all policy variables
and the [local cost report](cost-report.md) for measured bounds and assumptions.

Edit resource and admission budgets in [`src/budget.ts`](../src/budget.ts), then run
`npm run budget:generate` from the repository root. It updates the native Worker rate
limiter configuration and reviewable edge-rule definitions; it does not deploy.
The entry Worker rejects excessive connection attempts before calling the DO.
See [edge admission operations](edge-admission.md) for applying WAF rules,
their Free-plan limitations, and the quota-exhaustion runbook.

Passkey session cleanup uses an ordered expiry index. An alarm sweeps it at most
once an hour (every connection wakes the alarm at its auth deadline), processing
at most 16 expired entries and sweeping again on the next alarm after a full
batch; a sweep with no expired entries performs only a small metered probe. A
token resume rejects an expired session whether or not it has been swept. Session issuance,
renewal, and cleanup share a queue so cleanup cannot delete a concurrent renewal.
KV operations reserve conservative row allowances before running; an exhausted
maintenance budget leaves unfinished cleanup for a later alarm.

For an additional delayed account-wide safety stop, configure `ACCOUNT_ID` and
the `ACCOUNT_ANALYTICS_TOKEN` secret. The Durable Object refreshes account usage
periodically and keeps local limits as the fallback when analytics is unavailable.
Provision it with `npx wrangler secret put ACCOUNT_ANALYTICS_TOKEN --config wrangler.production.toml`.

The selected budgets are for **Workers Paid** ($5/month), with SQLite Durable
Objects; select the Free ones (`src/plans/free.ts`, see
[plans](configuration.md#plans)) to deploy on **Workers Free** instead. No
auxiliary service is required. Installation and tests never deploy; merging to `main`
does (see [continuous deployment](#continuous-deployment)). A paid plan's
included allowance is not a spending cap.

## Local development

Use Node.js 24 (see `.node-version`); on NixOS, use `devenv shell` as described
below. Install from the lockfile:

```sh
npm ci
```

No secret provisioning is required for local development. Production can run
with local limits alone; configure the optional analytics secret above to enable
the delayed account-wide safety stop.

`npx wrangler dev --port 8080` serves the development Worker. To use it with the
web client, check out [apron-chat/apron-web](https://github.com/apron-chat/apron-web),
follow its README (`npm ci`, then `npm run dev`) in another terminal, and open
`http://localhost:5173`; its dev proxy connects `/ws` to port 8080. Use **localhost**, matching the development passkey
RP ID and origin. Wrangler persists local SQLite state between runs. Do not
delete its state while investigating restart-safe quotas or identity recovery.

```sh
npm run typecheck
npm test
```

`npm test` runs pure-policy and actual Workers runtime tests. Tests use local
resources, never production account quotas. There is no browser test against
this Worker: the browser interoperability tests, which drive the web client
with Chromium (and its virtual authenticator), run against the Go reference
server in [apron-chat/apron-server-go](https://github.com/apron-chat/apron-server-go)
(`tests/interop`). Check passkey and client changes against this Worker by
hand with the web client, as above.

On NixOS, enter `devenv shell` before running Wrangler or Workers tests. The
repository sets `MINIFLARE_WORKERD_PATH` to a launcher using Nix's ELF loader
and libraries with the npm lockfile's workerd executable. It does not patch
`node_modules` or require system-wide `nix-ld`. Re-enter the shell after changing
`devenv.nix`. Other platforms use the normal npm executable.

## Connecting a custom frontend

Point a browser WebSocket client at `wss://server.apron.chat/` (`/ws` is also
accepted). No frontend registration, access token, or origin approval is needed.
For example, run this from your localhost frontend's browser console:

```js
const socket = new WebSocket('wss://server.apron.chat/');
socket.onmessage = ({ data }) => {
  const frame = JSON.parse(data);
  console.log(frame);
  if (frame.method === 'server') {
    // `auth` finishes before the frames behind it run, so send them together.
    socket.send(JSON.stringify({ id: 'guest', method: 'auth', params: { scheme: 'guest' } }));
    socket.send(JSON.stringify({ id: 'rooms', method: 'room_list', params: { filter: 'joined', members: true } }));
    socket.send(JSON.stringify({ id: 'history', method: 'history', params: { room_id: 'general' } }));
  }
};
// Stay listed as connected: ping every `server.params.ping` seconds.
setInterval(() => socket.send('{"method":"ping"}'), 45_000);
```

A guest only reads: each connection gets a `~private` welcome saying so right
after the `server` frame, before any `auth`, and
`message`, `reactions`, `room_set`, `room_join`, and `room_leave` are `denied`;
`room_list` and `history` work for any room without joining it. To exercise posting,
editing, deletion/restoration, moves, threads, and reactions from your own
client, sign in on the demo with a passkey, run `/invite-bot`, and connect with
the token it gives you (see [Bots](#bots)). A new guest has joined `general`, and
receives only the rooms it has joined (a thread's messages go to its members
only); posting to a room does not require joining it. `room_list` lists
joined rooms and rooms to join by `filter`, with `members` and `users` on
request, up to 6 times a minute per user (the first `filter: "joined"`
listing after authentication is free), and `room_update` reports changes.
A registered user's joins and leaves are logged membership records,
delivered in `room_update` `memberships` and returned in `history`; a guest's live in its connection and are not logged,
so `room_list` ignores `latest_log_id` and always answers with a full
listing. `members` lists every connected member and at most 200 registered
members per room (100 with the Free budgets); a room with more lists the first by `user_id`, not by recent activity, and also gives
`member_count`. Registered users carry `roles` (`admin`, `mod`, `bot`, labels an admin gave with `/role`, or `[]` for none) in `users`
and `you`. See [SPEC section 4](../SPEC.md#memberships).
The whole server processes at most 600 frames a
minute (300 with the Free budgets); past that, requests get `retry_after` and the socket stays open. The demo
only creates thread rooms: `room_set` creations need `parent_room_id: "general"`,
and `general` itself cannot be edited. A thread's `description` (CommonMark)
says what it is about, and any participant may change it. Every room is
public: `private: true` is `unsupported`. System notices come from `~private`,
`~room`, or `~server`; no user's `user_id` starts with `~`. This is a shared public room, not
an isolated sandbox: test messages are visible to others, guest ownership lasts
only for the socket, and IP/resource quotas and retention still apply. Changing
frontend origins does not give an IP a fresh allowance. Honor `retry_after`.

The `server` frame's `welcome` is CommonMark for your sign-in screen. The server
advertises `token` (for bot tokens) and `guest` to custom frontends, and never
`email`; `signup` names the schemes that create an account (`webauthn` on the
demo's own site, and `token` for an admin's `/invite` sign-up token, whose
`auth` result carries the new user's own token to save). A user who signed up
with a token can add a passkey by registering one while signed in.
`web.apron.chat` additionally receives `webauthn`, and its `token` also resumes
passkey sessions; inspect each connection's `server.params.auth` rather than
assuming passkeys are available everywhere.
A frontend with a Content Security Policy must permit the endpoint in
`connect-src` (for example, `connect-src wss://server.apron.chat`). Wildcard
admission cannot override the frontend's own browser policies.

## Bots

Sign in on the demo with a passkey and run `/invite-bot` in any room. You get
a `~private` notice, only on that tab, with a bearer token for your bot:
`bot_<your user_id>`, named "Bot of <your name>", and instructions you can
give an LLM to connect it: read `PROTOCOL.md`, connect to the server, sign in
with the token scheme and your token, and say hello. A bot of your own
connects without a browser and signs in with the token:

```js
const socket = new WebSocket('wss://server.apron.chat/');
socket.onmessage = ({ data }) => {
  const frame = JSON.parse(data);
  if (frame.method === 'server') {
    socket.send(JSON.stringify({ id: 'auth', method: 'auth', params: { scheme: 'token', token: process.env.APRON_BOT_TOKEN } }));
    socket.send(JSON.stringify({ id: 'hello', method: 'message', params: { room_id: 'general', body: { text: 'Hello from my bot' } } }));
  }
};
```

A bot posts, reacts, starts threads, and keeps its rooms like a registered
user, under its own posting quota; it cannot rename itself or invite bots.
You can add your bot to a thread, say to keep its `description` current,
with `room_join` and its `user_id`, and remove it with `room_leave` the same
way. The
token does not expire. Running `/invite-bot` again replaces it, signs out
connections that used the old one, and renames the bot after your current name.
The first invite counts as a registration. See [SPEC section 5](../SPEC.md#bots).

This repository runs one: the [Announce workflow](../.github/workflows/announce.yml)
posts each pull request merged into `main` to `general`, with a link preview
(`og` title, description, and site name) built from the pull request, using
the [apron-pr-bot](https://github.com/apron-chat/apron-pr-bot) action. Set the
`APRON_BOT_TOKEN` secret of the `announce` environment to a token from
`/invite-bot` to turn it on; without the secret the job succeeds without
posting. Set the environment's `APRON_ROOM_ID` variable to post in a room
other than `general`. Rerunning the job for the same pull request within the
deduplication window does not post it twice.

## User-visible policies

Only the last 7 days of records (messages, reactions, room changes, and
registered users' memberships) are retained, 24 hours on Workers Free. Cleanup
once a day (hourly on Free) normally exposes 7 to 8 days; quota exhaustion may
delay physical deletion. The `general` room ID and the log head never rotate.
Recent edits can keep old messages visible. Rooms keep their current record
after its log entry expires; a thread room whose whole log has expired is
removed (its members get `room_update` `left`), which frees its slot under the
100-thread ceiling. A thread also goes, and frees its slot, as soon as the last
one in it leaves (or is removed) while none of its messages shows, because it
was never written in or each message was deleted or moved out.
This is not secure erasure, and says nothing about provider backups or copies
on clients.

Guests are numbered in arrival order: `guest_1` named "Guest 1", then
`guest_2`, and so on, so the latest number roughly counts the demo's guests.
The object reserves numbers ten at a time with one durable write and skips
the rest of a block when it restarts or wakes from hibernation, so numbers
are never reissued but have gaps (see [SPEC section 5](../SPEC.md#guest)).
Guest identities last only for their socket, including hibernation, and so do
the rooms a guest has joined. A
reconnect receives a new guest identity, joined to `general` only, so earlier
guest messages cannot be edited or deduplicated across that reconnect. A
passkey creates a separate, stable registered identity that keeps its rooms
across connections (starting with the guest's); it does not inherit guest
message ownership.
Passkeys require authentication on each new connection and do not prevent
multiple registrations by one person.

Guests only read by default. With `GUEST_POSTING=true`, guest posting is
shared by IP (native IPv6 grouped by /64): five accepted
mutations per rolling minute and 200 per UTC day (100 with the Free budgets).
Registered users receive 20/minute and 1,000/day (500), subject to the common IP and global limits. NAT users
share allowances. Creates, edits, deletion, restoration, moves, reaction
changes, thread room creation or edits, and a registered user's room joins and
leaves all consume posting quota.
Matching accepted request retries consume lookup and frame resources, but do
not post again. Request deduplication lasts 24 hours.

Temporary limits return `retry_after` with `data.retry_after` (whole
seconds); clients back off. Daily
posting/write exhaustion makes the demo read-only while affordable reads remain
available. History exhaustion returns an error. Registration caps do not revoke
existing passkeys. Permanent identity/thread-room caps return `denied`. Storage
pressure suspends growth and retains the published history boundary; it never
shortens history to accept another post. Global frame exhaustion closes sockets
and rejects new admissions until replenishment.

## Operations and secrets

IP rate limits use the first 128 bits of SHA-256 of the canonical address key,
encoded as 22 base64url characters. IPv4-mapped IPv6 shares its IPv4 key; native
IPv6 is grouped by /64. No IP secret or backup is needed. These internal hashes
are compact identifiers, not anonymization: candidate IPs can be hashed to
recover a match. Neither raw IPs nor these keys are sent to chat clients.

Keep the hash format stable across deployments to preserve active IP windows.

The public Worker reaches exactly `DEMO.getByName("public-demo-v1")`. URL,
query, room, and identity input cannot select another object. Do not expose a
second entry point or bind the namespace to an unrelated public Worker.
Requests from other Workers need particular care: Cloudflare's subrequest IP
semantics differ from direct client requests. The entry point fails admission
when trusted client attribution is missing or unusable.

Maintenance uses one alarm scheduler shared with authentication deadlines.
Expiration first publishes a durable monotonic floor, then deletes bounded
batches. Budget authority, credentials, and the room head are independent of
retention. SQLite frees pages for reuse without necessarily shrinking the file.
The inspected [workerd implementation](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/sql.c++)
reports occupied pages through `databaseSize`, excluding freelist pages. Pressure
stops growth at 96 MiB and resumes only below 80 MiB; transactions also check the
128 MiB hard target before committing. Recheck this runtime assumption on upgrades.
Do not delete the database or run unmetered VACUUM as a space-recovery measure.

## Continuous deployment

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) runs
`npm run typecheck` and `npm test` on every pull request and on `main`. A push
to `main` (a merged pull request), or a manual run of the workflow on `main`,
then runs `npm run deploy` in the `server.apron.chat` GitHub environment: it checks
generated-policy freshness and deploys with `wrangler.production.toml`. Deploys
never run concurrently, and a newer queued deploy replaces an older one that has
not started. Merging is deploying: review changes to bindings, migrations, the
storage schema, and the compatibility date against the checklist below before
merging them.

The deploy job needs two GitHub Actions secrets, on the repository or on the
`server.apron.chat` environment:

- `CLOUDFLARE_API_TOKEN`: an API token that can deploy Workers to the account
  and manage the `server.apron.chat` custom domain (for example, the "Edit
  Cloudflare Workers" template scoped to this account and the `apron.chat` zone).
- `CLOUDFLARE_ACCOUNT_ID`: the account ID (`ACCOUNT_ID` in
  `wrangler.production.toml`).

Add protection rules, such as required reviewers, to the `server.apron.chat`
environment to hold deploys for approval. Worker secrets such as
`ACCOUNT_ANALYTICS_TOKEN` are provisioned once with `wrangler secret put` and
persist across deploys.

## Deployment checklist

The production backend at `wss://server.apron.chat/` uses
`wrangler.production.toml`. The frontend is deployed separately at
`https://web.apron.chat` from [apron-chat/apron-web](https://github.com/apron-chat/apron-web)
using its `wrangler.toml`; `apron.chat` is
reserved for static documentation. The production backend has no static assets.
WebSocket upgrades use `/` or `/ws`.
The default development Worker is `apron-cloudflare-demo-dev`; it is separate
from the production Worker `apron-cloudflare-demo`. Like production, it binds no
static assets: the frontend's development server proxies to it. Keep bindings,
migrations, and compatibility settings in sync.
Custom Domains configure DNS and HTTPS through Cloudflare; workers.dev and
preview URLs are disabled for both deployments.

The RP ID stays `apron.chat` to preserve existing passkey credentials across
the move. Guest connections accept every origin, including localhost, LAN
frontends, local files (opaque origins), and clients without Origin. Passkey
verification allows only the exact `https://web.apron.chat` origin. Browser
local storage is origin-specific, so saved names and server preferences do not
move from the apex automatically.

Merging to `main` deploys the backend (see
[continuous deployment](#continuous-deployment)). The frontend deploys from
[apron-chat/apron-web](https://github.com/apron-chat/apron-web): Cloudflare
Workers Builds deploys it on a merge to its `main`, built with
`wss://server.apron.chat/` as its default server (see its README). For manual
Wrangler commands, authenticate from `devenv shell`:

```sh
npx wrangler login
npx wrangler whoami
```

For direct Wrangler production commands, always pass
`--config wrangler.production.toml` and run `npm run budget:check` first;
`npm run deploy` does both.

1. Verify the **account's actual plan matches `PLAN`** in `src/budget.ts` and
   SQLite Durable Objects are enabled. Inventory other Workers, DO namespaces,
   and staging workloads; their usage shares the same account allowances.
2. Recheck [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
   and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
   The documentation checked 2026-09-27 lists daily Free allowances of 100,000 DO
   requests, 13,000 GB-seconds, 5 million SQLite rows read, 100,000 rows written,
   5 GB account SQLite storage, and 100,000 entry Worker requests; and monthly
   Paid included usage of 1 million DO requests, 400,000 GB-seconds, 25 billion
   rows read, 50 million rows written, 5 GB-month of storage, and 10 million
   entry Worker requests. Reserve headroom for all account workloads. Confirm
   the application cost tests and configured limits still fit; the daily post
   ceiling (10,000; 5,000 on Free) is a ceiling, not a promise. On Paid, set
   up the [budget guard](configuration.md#budget-guard): the
   `apron_budget_stop` rule, the `EDGE_STOP_TOKEN` secret, and
   `ACCOUNT_ID` with `ACCOUNT_ANALYTICS_TOKEN`. Keep a Cloudflare budget alert
   as a second signal. For uploads, create the bucket, its lifecycle rules,
   domain, cache rule and signing key first ([uploads](configuration.md#uploads));
   deploying fails without the bucket. For push, set the VAPID keys and
   contact ([push](configuration.md#push)); without them push stays off.
3. Set `ALLOWED_ORIGINS = "*"` for the public reference server. Keep the
   passkey RP ID `apron.chat` and the explicit, exact `RP_ORIGINS` allowlist;
   wildcard guest admission never enables wildcard passkey verification.
   RP changes can make previously registered credentials unusable.
4. Run all checks here, and check the matching frontend in apron-chat/apron-web
   (its CI runs `npm run check`, `npm test` and `npm run build`). Review the lockfile and compatibility date together.
5. Review `wrangler.production.toml`: fixed DO binding, `new_sqlite_classes` migration,
   no paid-service bindings. Apply the initial migration once using the normal
   Wrangler deployment workflow. Do not rename or recreate the production
   object to work around a quota or schema issue. The current schema is 8
   (protocol 8, with push subscriptions, user status, and users' `ext`); a
   schema 7 object, which the deployed demo holds, is upgraded in place on its
   first wake, keeping everything: it gains the empty push and status tables
   (`push_subscriptions`, `push_wakes`, `user_status`, `room_mutes`) and the
   identities' empty `ext_json` column (see [SPEC section 8](../SPEC.md#schema-versions)).
   The upgrade is one-way: redeploying schema 7 code afterwards resets the
   object like any schema change, so fix forward instead of rolling back. It
   also fails closed: if it cannot finish, nothing changes, and the object
   throws on every wake until a fixed deploy upgrades it.
   Stored data from any other schema is not migrated: a deploy that changes
   the storage schema otherwise resets the demo on the object's first wake.
   All chat history, rooms,
   sessions, bot tokens, and limiter windows are deleted, and saved session
   tokens fall back to sign-in. Registered passkeys survive a reset from
   schema 7 or later (an older object carries none): up to 100 of the
   most recently used are carried over with their identities, so users sign in
   with the passkey they already have; older ones past that cap must be
   registered again. Besides those, only the current day's resource
   reservations and the guest-number mark are carried over. Deploy the matching
   frontend together with this backend.
6. When deployment is authorized, merge to `main` (or run the Deploy workflow)
   and merge the matching frontend in apron-chat/apron-web, which deploys it. Verify guest access, passkey registration/login, edits, threads, reactions, history,
   duplicate retries, custom-origin guest access, and rejection of passkey
   requests from unapproved origins against the deployed endpoint.
7. Exercise idle **hibernation and wake**, then a real redeploy/reconnect. Check
   identity attachments, challenges, persistent quotas, room head/floor, alarm
   scheduling, and recovery. A local reconnect test alone does not establish
   production hibernation behavior.
8. Observe aggregate resource use and cleanup across daily rollover. Never use
   production quotas for exhaustive stress tests. Stop admission if actual
   costs exceed tested bounds; do not raise budgets to conceal a discrepancy.

On Workers Free, the plan's hard limits are the zero-overage backstop. Workers
Paid has none: traffic past the included usage is billed, and the budget
guard's edge stop is what limits it. Application quotas provide
controlled degradation for admitted work, not availability under unlimited
hostile traffic: rejected HTTP requests and incoming frames still cost platform
resources. Local calibration is not proof of production billing or availability.

Failed WebSocket handshakes can be diagnosed with an HTTP GET to the same `/`
or `/ws` URL with `?apron_connection_status=1`. The response exposes `Retry-After`
through CORS and disables caching. It checks live connection capacity and the
cached daily SQL budget without reserving SQL work or opening a socket; it is
advisory, and the real upgrade still enforces every admission gate. The native
per-IP attempt limiter also applies to these probes.

When the daily SQL guard stops work, a `daily_budget_exhausted` log records the
reserved counters and limits once per object instance/day. Each operation reserves
a conservative bound before it runs, and once it finishes the unused part, measured
from its SQL cursors, is credited back, so the counters follow the rows actually
read and written (plus one row per credit). Key-value work stays charged at its
bound. Compare the counters with account analytics
before tuning operation costs. Daily reservations survive redeploys and reset at
UTC midnight; resetting the object or its counters would discard that protection.

Idle cleanup runs use indexed existence checks before reserving a deletion batch.
If no records are eligible, they only advance the cleanup deadline. Within an
object instance, a known adequate future alarm is reused without SQL bookkeeping;
earlier deadlines, fired alarms, cleanup runs, and hibernation wakes are rechecked.

On 2026-09-21 the app stopped at 59,976 reserved foreground writes after 93
admissions, while account analytics reported about 13,165 actual writes. Crediting
back each operation's measured unused reservation closes most of that gap without
relying on aggregate analytics; a crash or rollback still leaves work charged.
