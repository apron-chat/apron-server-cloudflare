# Developer and operator guide

How to run, extend, connect to, and deploy the Apron public demo Worker. For
the protocol contract and design, see the [implementation specification](../SPEC.md).

## Overview

A single SQLite Durable Object serves the permanent `general` room, the
top-level rooms admins and mods create, their thread rooms, and users'
private rooms over hibernating WebSockets. The backend supports guest access,
discoverable passkeys, complete-snapshot history, message
replacement/deletion/restoration/moves, emoji reactions, and a rolling
retention floor. Guests only read (set `GUEST_POSTING=true` to let them
post); signing in with a passkey lets a user post and invite a bot.

It speaks protocol 9 and advertises:

- always: `history`, `edit`, `rooms`, `reactions`, `command` (`/help`,
  `/invite-bot`, and admin commands), `ext`, and the extensions
  `ext:settings`, `ext:limits` and `ext:permissions` (EXTENSIONS.md), with
  liveness pings (`server.ping`);
- `activity` (typing) with the Workers Paid budgets (`ACTIVITY` overrides);
- `embed:upload` and `ext:media` when uploads are configured, and
  `ext:emoji` once an admin, mod or friend adds a custom emoji with
  `/emoji add`;
- `status` and push when VAPID keys are set.

See [authentication and policy](policy.md) and [the implementation
specification](../SPEC.md).

## Budgets, sessions, and analytics

See the [configuration reference](configuration.md) for all policy variables
and the [local cost report](cost-report.md) for measured bounds and assumptions.

Edit resource and admission budgets in [`src/budget.ts`](../src/budget.ts), then run
`npm run budget:generate` from the repository root. It updates the native Worker rate
limiter configuration and reviewable edge-rule definitions; it does not deploy.
The entry Worker rejects excessive connection attempts before calling the DO.
See [edge admission operations](edge-admission.md) for applying WAF rules,
their Free-plan limitations, and the quota-exhaustion runbook.

Expired passkey sessions are swept by the alarm in small batches, at most
once an hour; a token resume rejects an expired session whether or not it has
been swept, and an exhausted maintenance budget leaves the rest for a later
alarm.

For a delayed account-wide safety stop, set `ACCOUNT_ID` and the
`ACCOUNT_ANALYTICS_TOKEN` secret (see the
[configuration reference](configuration.md#editing-the-deployment-budget));
without them, local limits still apply.

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

No secret provisioning is required for local development; production secrets
are covered in the [deployment checklist](#deployment-checklist).

`npx wrangler dev --port 8080` serves the development Worker. To use it with the
web client, check out [apron-chat/apron-web](https://github.com/apron-chat/apron-web),
follow its README (`npm ci`, then `npm run dev`) in another terminal, and open
`http://localhost:5173`; its dev proxy connects `/ws` to port 8080. Use
**localhost**, matching the development passkey RP ID and origin. Wrangler persists local SQLite state between runs. Do not
delete its state while investigating restart-safe quotas or identity recovery.

Uploads, avatars and custom emoji are off locally until the upload settings
are set. Let the Worker be its own media origin, and give it an admin token
for `/emoji add` and `/server avatar`:

```sh
npx wrangler dev --port 8080 \
  --var MEDIA_ORIGIN:http://localhost:8080 --var PUBLIC_ORIGIN:http://localhost:8080 \
  --var UPLOAD_SIGNING_KEY:dev-upload-signing-key-0123456789abcdef \
  --var APRON_ADMIN_TOKEN:dev-admin-token-0123456789abcdef
```

With `MEDIA_ORIGIN` equal to `PUBLIC_ORIGIN`, the Worker serves `GET` and
`HEAD` of uploads (`f/`, `a/`, `e/`) from the local bucket itself, readable
from any origin; in production the bucket's own domain serves them and the
Worker does not.

The same `PUBLIC_ORIGIN` and `UPLOAD_SIGNING_KEY` turn live text on
(`embed:terminal` and `embed:append`; [configuration](configuration.md#live-text)).
To try it, sign in (the admin token above is an `admin`, so its texts may
stream for 300 seconds; a user from `/invite-token <user_id>` or a passkey
gets 120, as does a guest with `--var GUEST_POSTING:true`), send
`/embed-terminal make test` or `/embed-append **Plan:**`, and run the
recipe in the `~private` notice, such as:

```sh
script -qfc 'stty cols 80 rows 40; ls --color=always -l /' /dev/null | curl -sT - '<write_url>'
for word in One two three; do printf '%s ' "$word"; sleep 1; done | curl -sT - '<write_url>'
```

Then `curl -s <url>` of the message's embed shows the text as it grows. The
`PUT` is answered when the text has ended and its last snapshot is out.
`LIVE_TEXT_MAX_SECONDS=10` and the like shorten the limits for a quick try.

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
after the `server` frame, before any `auth`, and `message`, `reactions`,
`room_set`, `room_join`, and `room_leave` are `denied`; `room_list` and
`history` work for any public room without joining it. To exercise posting,
editing, deletion/restoration, moves, threads, and reactions from your own
client, sign in on the demo with a passkey, run `/invite-bot`, and connect with
the token it gives you (see [Bots](#bots)).

A new guest has joined `general`, and receives only the rooms it has joined
(a thread's messages go to its members only); posting to a room does not
require joining it. `room_list` lists joined rooms and rooms to join by
`filter`, with `members` and `users` on request, and `room_update` reports
changes; keep your list current from `room_update` rather than polling. A
registered user's joins and leaves are logged membership records; a guest's
are not, so `room_list` always answers with a full listing. `members` lists
every connected member and a capped page of registered members, in `user_id`
order, with `member_count` when the page is full. Registered users carry
`roles` (`admin`, `mod`, `threader`, `bot`, `friend`, labels an admin gave
with `/role`, or `[]` for none) in `users` and `you`. See
[SPEC section 4](../SPEC.md#memberships).

Rooms come in three kinds:

- **Threads.** Any signed-in user may create one with `room_set` and the
  `parent_room_id` of a public top-level room. A thread's `description`
  (CommonMark) says what it is about, and any participant may change it.
- **Top-level rooms.** Only an `admin` or `mod` may create one (`room_set`
  without `parent_room_id`, at most 16, kept for good) or edit one, and only
  an `admin` may edit `general` itself.
- **Private rooms.** A signed-in user creates one with `room_set` and
  `private: true` (no `parent_room_id`; private rooms have no threads). Only
  its members see it: to anyone else it answers as if it did not exist. Its
  members add others with `room_join` and a `user_id`. It is removed when its
  last member leaves or its history expires.
  `server.ext.settings.private_rooms` gives how many one user may be in.

System notices come from `~private`, `~room`, or `~server`; no user's
`user_id` starts with `~`.

This is a shared public server, not an isolated sandbox: test messages in
public rooms are visible to others, guest ownership lasts only for the
socket, and IP/resource quotas and retention still apply. Changing frontend
origins does not give an IP a fresh allowance. Honor `retry_after`;
[limits for client developers](limits.md) lists every limit a client can hit,
including the posting, listing and frame quotas and the thread and private
room caps, and ends with a checklist for a well-behaved client.

The `server` frame's `welcome` is CommonMark for your sign-in screen. The server
advertises `token` (for bot tokens) and `guest` to custom frontends, and never
`email` or `external`; `signup` names the schemes that create an account
(`webauthn` on the demo's own site, and `token` for an admin's `/invite-code`
sign-up token, whose `auth` result carries the new user's own token to save).
A user who signed up with a token can add a passkey by registering one while
signed in. `web.apron.chat` additionally receives `webauthn`, and its `token`
also resumes passkey sessions; inspect each connection's
`server.params.auth` rather than assuming passkeys are available everywhere.
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
way. The token does not expire. Running `/invite-bot` again replaces it,
signs out connections that used the old one, and renames the bot after your
current name. The first invite counts as a registration. A bot that neither
signs in nor posts for a week is signed out and taken out of its rooms (what
it posted stays); run `/invite-bot` again for a new token. See
[SPEC section 5](../SPEC.md#bots).

A bot streams an LLM's reply as it generates with live text: a `message`
whose body has `{"kind": "append"}` in `embeds` gets a `write_url` in its
result, and the bot `PUT`s the text there as a streaming body; everyone sees
the message grow, and when the body ends the text joins `body.text`. A
backspace in the text removes the character before it, and a form feed
clears the text so far, so a bot can revise what it streamed. A bot
has one open at a time, for at most two minutes and the message text limit
(see [live text](limits.md#live-text)).

This repository runs one: the [Announce workflow](../.github/workflows/announce.yml)
posts each pull request merged into `main` to `general`, with a link preview
(`og` title, description, and site name) built from the pull request, using
the [apron-pr-bot](https://github.com/apron-chat/apron-pr-bot) action, and
the [Deploy workflow](../.github/workflows/deploy.yml) reacts to those posts,
as the same bot, once it has deployed them. Set the `APRON_BOT_TOKEN` secret
of the `announce` environment to a token from `/invite-bot` to turn both on;
without the secret the jobs succeed without posting. Set the environment's
`APRON_ROOM_ID` variable to post in a room other than `general`. Rerunning
the job for the same pull request within the deduplication window does not
post it twice.

## Other devices

To sign in as yourself where your passkey isn't, such as another browser, a
command-line client, or another origin, run `/invite-device add [<id>]`
(say `/invite-device add laptop`; without an id it is `device_1`,
`device_2`, and so on). The `~private` notice holds a token that signs in
as you with the token scheme, from any origin; it does not expire, so keep it
secret. You can hold 5, each under its own id. Running `/invite-device add`
again with the same id replaces that token and signs out connections that
used the old one; `/invite-device remove <id>` revokes it, and
`/invite-device list` shows your ids with when each was added and last used. See [SPEC section 5](../SPEC.md#devices).

## User-visible policies

Only the last 7 days of records (messages, reactions, room changes, and
registered users' memberships) are retained, 24 hours on Workers Free. Cleanup
once a day (hourly on Free) normally exposes 7 to 8 days; quota exhaustion may
delay physical deletion. The `general` room ID, the top-level rooms admins
and mods create, and the log head never rotate. Recent edits can keep old
messages visible. Rooms keep their current record after its log entry
expires; a thread or private room whose whole log has expired is removed (its
members get `room_update` `left`), which frees its slot under the
[caps](limits.md#hard-caps). It also goes, and frees its slot, as soon as the
last one in it leaves (or is removed, or purged), and its messages go with it.
This is not secure erasure, and says nothing about provider backups or copies
on clients.

Guests are numbered in arrival order (`guest_1` named "Guest 1", then
`guest_2`), never reissued but with gaps (see
[SPEC section 5](../SPEC.md#guest)). Guest identities last only for their
socket, including hibernation, and so do the rooms a guest has joined. A
reconnect receives a new guest identity, joined to `general` only, so earlier
guest messages cannot be edited or deduplicated across that reconnect. A
passkey creates a separate, stable registered identity that keeps its rooms
across connections (starting with the guest's); it does not inherit guest
message ownership. Passkeys require authentication on each new connection and
do not prevent multiple registrations by one person.

Guests only read by default. Posting quotas are per account, per IP (native
IPv6 grouped by /56, so NAT users share allowances) and server-wide; creates,
edits, deletion, restoration, moves, reaction changes, room creation or
edits, and room joins and leaves (one that changes nothing is free) all
consume them. A retried request with an `id` accepted in the last 24 hours
does not post again. See [posting and other writes](limits.md#posting-and-other-writes)
for the numbers.

Live text (a terminal or an append, streamed with `curl -T` to a
`write_url`) streams for at most two minutes, five for admins and mods; a
user has one open at a time, a handful a day, and the server a hundred a
day. It lives only in the server's memory while it streams and is stored
once, when it ends, kept with its message for the retention window: a
deploy or an eviction mid-stream ends it without its text. See
[live text](limits.md#live-text).

Temporary limits return `retry_after`, and clients back off (see
[how a limit reaches you](limits.md#how-a-limit-reaches-you)). Daily
posting/write exhaustion makes the demo read-only while affordable reads
remain available. History exhaustion returns an error. Registration caps do
not revoke existing passkeys. Permanent identity/thread-room caps return
`denied`. Storage pressure suspends growth and retains the published history
boundary; it never shortens history to accept another post. Global frame
exhaustion closes sockets and rejects new admissions until replenishment.

## Passkeys on your own server

A self-hosted server sets `RP_ID` to its own host or a domain it is under;
Apron clients refuse any other ([PROTOCOL.md §4.10](https://github.com/shazow/apron/blob/main/PROTOCOL.md#410-webauthn-authentication)).
Each frontend offered passkeys is listed in `RP_ORIGINS` (and in
`ALLOWED_ORIGINS`, unless that is `*`). One on the RP ID's domain needs
nothing more; one elsewhere, such as the shared client at
`https://web.apron.chat`, works as a WebAuthn
[related origin](https://www.w3.org/TR/webauthn-3/#sctn-related-origins):

```toml
[vars]
RP_ID = "apron.shazow.net"
RP_ORIGINS = "https://apron.shazow.net,https://web.apron.chat"
ALLOWED_ORIGINS = "https://apron.shazow.net,https://web.apron.chat"
```

The browser on `web.apron.chat` fetches
`https://apron.shazow.net/.well-known/webauthn` and takes the RP ID only if
that lists its origin. The Worker answers it with `RP_ORIGINS`, cached for
five minutes, when it serves the RP ID's own host, as here, without waking
the Durable Object. Where it does not, as with the Worker on
`chat.example.com` and `RP_ID = "example.com"`, serve
`{"origins": [...]}` as JSON at `https://example.com/.well-known/webauthn`
yourself: nothing else does. Startup does not check `RP_ORIGINS` against
`RP_ID`, so a mistyped origin fails only in the browser, which refuses the
passkey there. With edge rules, regenerate them: `apron_invalid_request`
lets the path through when the production custom domain is `RP_ID`
([edge admission](edge-admission.md)). Browsers without related origins
refuse passkeys on such a frontend; there its users sign in another way,
such as with a token from `/invite-device` ([other devices](#other-devices)).
Changing `RP_ID` strands the passkeys registered under the old one.

## Operations and secrets

IP rate limits key on the first 128 bits of SHA-256 of the canonical address
(IPv4-mapped IPv6 as its IPv4, native IPv6 by /56; see
[SPEC section 5](../SPEC.md#ip-key)). No IP secret or backup is needed. These
internal hashes are compact identifiers, not anonymization: candidate IPs can
be hashed to recover a match. Neither raw IPs nor these keys are sent to chat
clients. Keep the hash format stable across deployments to preserve active IP
windows.

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
reports occupied pages through `databaseSize`, excluding freelist pages; recheck
this on runtime upgrades. Pressure stops growth at 768 MiB and resumes only
below 640 MiB; transactions also check the 1 GiB hard target before committing
(96, 80 and 128 MiB with the Free budgets). Do not delete the database or run
unmetered VACUUM as a space-recovery measure.

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
The default development Worker (`wrangler.toml`) is `apron-cloudflare-demo-dev`;
it is separate from the production Worker `apron-cloudflare-demo`. Like
production, it binds no static assets: the frontend's development server
proxies to it. Keep bindings, migrations, and compatibility settings in sync.
The production Worker's Custom Domain configures DNS and HTTPS through
Cloudflare, and its workers.dev and preview URLs are disabled (`npm run
budget:check` refuses a production config without that). `wrangler.toml` sets
neither, so turn them off before deploying it anywhere.

The RP ID stays `apron.chat` to keep existing passkey credentials working.
Guest connections accept every origin, including localhost, LAN frontends,
local files (opaque origins), and clients without Origin. Passkey
verification allows only the exact `https://web.apron.chat` origin.

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
2. Recheck [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
   [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
   [Observability pricing](https://developers.cloudflare.com/observability/pricing/)
   (Workers Logs from 2026-12-01) and [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
   The documentation checked 2026-10-29 lists daily Free allowances of 100,000 DO
   requests, 13,000 GB-seconds, 5 million SQLite rows read, 100,000 rows written,
   5 GB account SQLite storage, and 100,000 entry Worker requests; and monthly
   Paid included usage of 1 million DO requests, 400,000 GB-seconds, 25 billion
   rows read, 50 million rows written, 5 GB-month of storage, 10 million entry
   Worker requests and 30 million CPU milliseconds, 50 GB of logs ingested and
   10 GB-month stored (20 million log events before 2026-12-01), and R2's free
   1 million Class A and 10 million Class B operations and 10 GB-month. The
   plan files (`src/plans/`) encode these; change them with the prices. Reserve headroom for all account workloads. Confirm
   the application cost tests and configured limits still fit; the daily post
   ceiling (10,000; 5,000 on Free) is a ceiling, not a promise. On Paid, set
   up the [budget guard](configuration.md#budget-guard): the
   `apron_budget_stop` rule, the `EDGE_STOP_TOKEN` secret, and
   `ACCOUNT_ID` with `ACCOUNT_ANALYTICS_TOKEN`. Keep a Cloudflare budget alert
   as a second signal. For uploads, create the bucket, its lifecycle rules,
   domain, cache rule and signing key first ([uploads](configuration.md#uploads));
   deploying fails without the bucket. For push, set the VAPID keys and
   contact ([push](configuration.md#push)); without them push stays off.
   Live text needs only `PUBLIC_ORIGIN` and `UPLOAD_SIGNING_KEY`, and the
   regenerated `apron_invalid_request` rule, which lets `/w/` writes and
   `/live/` reads through ([live text](configuration.md#live-text)); until
   the rule is updated, the edge blocks them.
3. Set `ALLOWED_ORIGINS = "*"` for the public reference server. Keep the
   passkey RP ID `apron.chat` and the explicit, exact `RP_ORIGINS` allowlist;
   wildcard guest admission never enables wildcard passkey verification.
   RP changes can make previously registered credentials unusable.
4. Run all checks here, and check the matching frontend in apron-chat/apron-web
   (its CI runs `npm run check`, `npm test` and `npm run build`). Review the
   lockfile and compatibility date together.
5. Review `wrangler.production.toml`: fixed DO binding, `new_sqlite_classes`
   migration, no new paid-service bindings (the `MEDIA` R2 bucket is sized to
   R2's free tier). Apply the initial migration once using the normal
   Wrangler deployment workflow. Do not rename or recreate the production
   object to work around a quota or schema issue. The current schema is 11.
   Schemas 7 to 10 are upgraded in place on the object's first wake; the
   rebuild from schema 9 copies every row once, uncharged to the day's
   budget but logged as `storage_schema_upgraded`, so expect a one-off spike
   in the account's Durable Object writes. An upgrade is one-way and fails
   closed: if it cannot finish, nothing changes and the
   object throws on every wake until a fixed deploy upgrades it, and
   redeploying older-schema code afterwards resets the object, so fix
   forward instead of rolling back. Any other schema change resets the demo
   on the first wake: chat history, rooms, sessions, bot tokens, and limiter
   windows are deleted, and saved session tokens fall back to sign-in; up to
   100 of the most recently used passkeys (from schema 7 or later), the
   current day's resource reservations, and the guest-number mark are
   carried over. See [SPEC section 8](../SPEC.md#schema-versions). Deploy the
   matching frontend together with this backend.
6. When deployment is authorized, merge to `main` (or run the Deploy workflow)
   and merge the matching frontend in apron-chat/apron-web, which deploys it.
   Verify guest access, passkey registration/login, edits, threads, private
   rooms, reactions, history, duplicate retries, custom-origin guest access,
   rejection of passkey requests from unapproved origins, and a short
   `/embed-terminal` and `/embed-append` stream (its readers, its time limit,
   and that the `PUT`'s answer arrives after the final snapshot through the
   edge) against the deployed endpoint.
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
or `/ws` URL with `?apron_connection_status=1` (see
[how a limit reaches you](limits.md#how-a-limit-reaches-you)). It checks live
connection capacity and the cached daily SQL budget without reserving SQL
work or opening a socket; it is advisory, and the real upgrade still enforces
every admission gate.

When the daily SQL guard stops work, a `daily_budget_exhausted` log records the
reserved counters and limits once per object instance/day. Each operation reserves
a conservative bound before it runs, and once it finishes the unused part, measured
from its SQL cursors, is credited back, so the counters follow the rows actually
read and written (plus one row per credit); key-value work, and work lost to a
crash, stays charged at its bound. Compare the counters with account analytics
before tuning operation costs (see [reservation accounting](cost-report.md#reservation-accounting)).
Daily reservations survive redeploys and reset at UTC midnight; resetting the
object or its counters would discard that protection.
