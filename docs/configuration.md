# Configuration reference

## Plans

Each Cloudflare Workers plan has its own policy file: its application
defaults, admission rates, feature-switch defaults, and the included usage
the account-usage stop compares against. `PLAN` in `src/budget.ts` selects
one, and must match the account's plan.

| File | Plan | Features on by default |
| --- | --- | --- |
| [`src/plans/paid.ts`](../src/plans/paid.ts) (selected) | Workers Paid, $5/month | `activity` (typing), presence (user status, with push) |
| [`src/plans/free.ts`](../src/plans/free.ts) | Workers Free | presence (user status, with push) |

The paid plan starts from the free one and raises only what Paid's included
usage pays for, sized against its monthly allowances divided by 31 days with
headroom. Paid includes 16 times the SQL rows written and 160 times the rows
read, so the SQL ceilings rise tenfold, and posts, registrations, admissions,
history pages, and member listings with them. History is kept 7 days instead
of 24 hours, matching uploaded images, with daily cleanup; the database
watermarks rise to 768 MiB (1 GiB hard), a fifth of the 5 GB-month included. It includes only a third of
Free's Durable Object requests (1 million a month against 100,000 a day), so
the frame budgets rise by half and connection limits stay. The header of
`src/plans/paid.ts` gives the worst case of each allowance.

To switch plans, import the other plan in `src/budget.ts`, then run the
commands below. The generated rate-limiter blocks and edge rules follow the
plan's admission rates. The calibrated ceilings that reference defaults (open
sockets, identities, limiter records, processed frames, global posts,
registrations, SQL ceilings, database watermarks) follow the selected plan too.

## Editing the deployment budget

`src/budget.ts` and the plan files are the source of truth for application
defaults, resource ceilings, maintenance reserves, and admission rates. The
Worker, standalone store, and protocol parser all consume the selected plan's
defaults. Resource ceilings reference those
defaults rather than repeating numeric allocations. Separate calibrated parser,
payload, and memory bounds remain in that same file; increasing them requires
reviewing their consumers and repeating cost calibration.

After changing the policy, run from the repository root:

```sh
npm run budget:generate
npm run typecheck
npm test
```

Commit the policy and generated changes together. Generation updates the marked
rate-limiter binding blocks in both Wrangler files and the edge-rule definitions
in `docs/edge-rules.generated.json`. It does not contact Cloudflare. Tests,
typechecking, and both supported deployment commands reject stale generated
configuration. Application defaults are imported directly and need no generated
copy. Use Node.js 24, as in the repository development environment.

`ADMISSION_BUDGET.requestsPerIpMinute` defaults to 10 attempted handshakes per
minute, before calling the DO. This leaves retry headroom over the five accepted
connections per IP per minute. `/` and `/ws` share a bucket. IPv4-mapped addresses
share their IPv4 bucket; native IPv6 shares a /64. Missing or failed limiter
bindings reject admission with 503. Exhaustion returns 429 and `Retry-After`.
The binding is approximate and local to each Cloudflare location, not a global
daily counter. NAT users share this limit. Development and production use distinct
limiter namespaces; additional deployments must use distinct namespace IDs too.

`ACCOUNT_USAGE_POLICY` in `src/budget.ts` defines the lightweight account-usage
stop. The Durable Object refreshes after about 1,000 incoming events, no more
often than once per minute, and treats a snapshot older than five minutes as
stale. Set `ACCOUNT_ID` and the read-only `ACCOUNT_ANALYTICS_TOKEN` secret on a
deployment to enable it. Without both values, local application limits remain
active and no analytics request is attempted. Refresh failures retain the last
successful snapshot and retry with backoff; they do not pause the service.
Set the token with `npx wrangler secret put ACCOUNT_ANALYTICS_TOKEN --config
wrangler.production.toml`; never put the token in Wrangler vars or source code.

The snapshot is account-wide and delayed. Each plan file's `account` sets the
daily allowances: Free's own daily ones, or Paid's monthly included usage
divided by 31 days, so stopping inside each day's share keeps the month inside
what the plan includes. Incoming WebSocket messages, which analytics report as
`hibernation` invocations, count as a twentieth of a request on Paid, as it
bills them, and as a whole one on Free. On Paid it also reads usage since the
start of the calendar month against the plan's `monthly` allowances. At 90% of
any daily allowance, or `monthlyStopRatio` of a monthly one, the object
persists a stop for that UTC day, rejects new connections,
and closes live sockets. This is an early-stop signal, not an exact remaining-
quota meter: analytics lag, sampling, and other account workloads can still cause
an earlier or later platform limit.

The optional Free WAF rate rule uses `edgeRequestsPerIpWindow`,
`edgeWindowSeconds`, and `edgeBlockSeconds` from the same file. Its counting and
blocking windows must both be 10 seconds on Free. It is generated disabled because
it applies across hostnames in the zone. See [edge admission operations](edge-admission.md)
before applying rules or deploying changed budgets.

Changing these files never changes the account plan, and the budgets cannot
guarantee availability under attack.

## Budget guard

Workers Free refuses work past its allowances. Workers Paid bills it instead,
and Cloudflare offers no spending cap (budget alerts only send email, a day
late). Application limits cannot bound traffic that never gets past the entry
Worker, since every request that reaches the Worker is billed, even one it
rejects. The budget guard (`src/budget-guard.ts`) is the stop for that:

- The production Worker's cron trigger runs it every minute. It reads the
  account's usage for today and for the calendar month so far, the same way
  the account-usage stop does (above).
- While usage has reached 90% of any daily share, or `monthlyStopRatio` (one
  half) of any monthly allowance, it turns on the zone custom rule
  `apron_budget_stop`, which blocks `server.apron.chat` (and, with uploads,
  `media.apron.chat`) at the edge. Blocked
  requests never invoke the Worker and are not billed. It turns the rule off
  once usage is back under every allowance: at the next UTC day for a daily
  share, or the next month for a monthly one. It touches no other rule, so
  `apron_admission_off` stays yours to use by hand.
- The monthly allowances are Worker requests, Worker CPU, Durable Object
  requests and duration, SQL rows read and written, and Workers Logs events,
  plus R2's free tier for uploads: Class A and Class B operations (each day
  also stopping at a 31st of the month) and 10 GB stored.
  A billing cycle overlaps at most two calendar months, so stopping each month
  at one half keeps any cycle inside the included usage.
- If usage or the rule cannot be read, the rule keeps its state and the guard
  logs an error (`budget_guard_*` events). It never turns the stop off
  without a successful reading.
- **Flood trip.** Analytics arrive minutes late, so the Worker also watches
  for floods itself. On every request it picks a random number; one request
  in `floodSampleEvery` (20) is counted, after the response, against the
  `FLOOD_WATCH` rate limiter, which allows `floodRequestsPerColoMinute / floodSampleEvery`
  (60) a minute at each Cloudflare location. Past it, that Worker turns the
  rule on at once. Counting writes nothing; the one write is turning the rule
  on, and each isolate tries at most once a minute. The guard then keeps the
  rule on for at least `holdSeconds` (30 minutes) after it was turned on,
  long enough for analytics to show the flood and the daily or monthly stop
  to take over. These settings are in the plan's `edgeStop`.
- **Log sampling.** Every invocation writes a Workers Logs event, billed past
  20 million a month at twice the request price, so production keeps one in
  ten (`head_sampling_rate = 0.1`). The guard's `logEvents` count every
  invocation, so it stops early on logs rather than late.

Set it up once per deployment:

1. Create `apron_budget_stop` (disabled) from
   [the generated definition](edge-rules.generated.json), as described in
   [edge admission operations](edge-admission.md). The guard only turns an
   existing rule on and off.
2. Create an API token with **Zone > WAF > Edit** on the `apron.chat` zone
   only, and store it with `npx wrangler secret put EDGE_STOP_TOKEN --config
   wrangler.production.toml`. `ZONE_ID` is a Wrangler var.
3. Keep `ACCOUNT_ID` and the `ACCOUNT_ANALYTICS_TOKEN` secret set.

`npm run deploy` refuses a plan with monthly allowances unless the production
config has the minute cron trigger and `ZONE_ID`. It cannot see secrets or the
live rule; check the Worker's logs for `budget_guard_unconfigured` or
`budget_guard_rule_missing` after deploying.

What the guard cannot promise:

- **A few seconds of every flood are billed.** A request past the included
  usage costs about $0.38 a million (request $0.30, a tenth of a log event
  $0.06, about a millisecond of CPU $0.02). Each calendar month stops at half
  its allowance plus whatever arrives before the stop takes effect, so a
  billing cycle that straddles two calendar months can be billed for two such
  windows. A flood is stopped within the rate limiter's detection (1,200
  requests at one location, a second or less at flood rates) plus the rule
  change reaching the edge, taken here as 30 seconds: at 100,000 requests a
  second, two windows cost about $2.30, and the cost grows with the rate.
  An attack spread thinly enough to stay under 20 requests a second at every
  location (a few thousand a second in all) is left to the minute guard and
  its analytics lag of about six minutes: about $1.80 for two windows. These
  are worst cases for sustained attacks that Cloudflare's own DDoS mitigation
  does not catch.
- **Open sockets.** The edge rule stops new requests, not WebSockets already
  open. The Durable Object's own account-usage stop closes them when it next
  refreshes, and its per-connection limits bound them until then.
- **Other Workers.** Allowances are account-wide. The guard counts every
  Worker's usage but blocks only this server. Another Worker reachable on
  `workers.dev` or preview URLs, where zone WAF rules do not apply, can still
  run up the bill; turn those off for Workers that do not need them.
- **The public bucket.** Upload views go straight to R2's public domain,
  not through the Worker, so the flood trip does not see them. A flood of
  requests for images not in Cloudflare's cache, such as made-up keys, is
  billed as R2 Class B reads ($0.36 a million) past the free 10 million a
  month, until the minute guard's analytics show it: about $2.60 at 10,000
  requests a second, or about $26 at 100,000, for two six-minute windows.
  `apron_media_invalid` blocks query strings, other methods, and paths
  outside `f/` and `a/`, so cached images cannot be bypassed.
- **Other products** on the account (KV, Queues, and so on) are not
  measured.

## Uploads

With the Workers Paid budgets, registered users attach images to messages
and set avatars (protocol §4.8, cap `embed:upload`; see
[SPEC section 4.3](../SPEC.md#43-uploads-and-avatars)). The plan's `uploads`
in `src/plans/paid.ts` sets the limits:

| Setting | Value |
| --- | ---: |
| `maxFileBytes` | 5 MB |
| `maxAvatarBytes` | 256 KB |
| `uploadsPerDay` (server-wide, avatars included) | 500 |
| `uploadsPerUserDay` | 20 |
| `writeWindowSeconds` | 10 minutes |
| `fileRetentionSeconds` | 7 days |
| `avatarRetentionSeconds` | 30 days |
| `avatarRefreshSeconds` | 7 days |
| `lifecycleLagSeconds` | 1 day |
| `storedBytesCap` | 5 GB |

Uploads are off until all of these are set:

1. **Bucket.** Create an R2 bucket named `apron-media` (the `MEDIA` binding
   in `wrangler.production.toml`). Deploying fails while it does not exist.
2. **Lifecycle rules.** On the bucket, delete objects with prefix `f/` 7 days
   after upload and prefix `a/` 30 days after upload. They must match
   `fileRetentionSeconds` and `avatarRetentionSeconds`.
3. **Public domain.** Connect the custom domain `media.apron.chat` to the
   bucket (bucket Settings, Custom Domains), and keep its `r2.dev` URL
   disabled, since WAF rules do not apply there.
4. **Cache.** Add a Cache Rule for `media.apron.chat` marking requests
   eligible for cache and respecting the origin's cache headers, and turn on
   Smart Tiered Cache. Object keys have no file extension, which Cloudflare
   does not cache by default; without the rule every view is a billed R2 read.
5. **Signing key.** `openssl rand -base64 48 | npx wrangler secret put
   UPLOAD_SIGNING_KEY --config wrangler.production.toml`. Rotating it
   invalidates `write_url`s already issued, nothing else.
6. **Edge rules.** Update `apron_invalid_request` and `apron_budget_stop`,
   and create `apron_media_invalid`, from
   [the generated definitions](edge-rules.generated.json). The old
   `apron_invalid_request` blocks `write_url` requests.

An admin can turn uploads off and on again with `/toggle uploads`, without a
deploy: new connections stop being offered `embed:upload`, and new
attachments and avatars are refused until it is turned back on.

`MEDIA_ORIGIN` (`https://media.apron.chat`) and `PUBLIC_ORIGIN`
(`https://server.apron.chat`, where `write_url`s point) are Wrangler vars;
`npm run deploy` refuses a plan with uploads that lacks them or the bucket
binding.

**Cost bounds.** At the caps, uploads stay within R2's free tier:

| Resource | Worst case | Free tier |
| --- | --- | --- |
| Storage | 5 GB (the byte cap, including a day of lifecycle lag) | 10 GB-month |
| Class A (writes, avatar refreshes) | about 16,000 uploads and a few thousand refreshes a month | 1 million a month |
| Class B (views that miss the cache) | about once per object per data center | 10 million a month |

Upload writes and their claims use the Worker and Durable Object allowances
above: two Durable Object requests and one Worker request each, at most
500 a day. Deletes are free.

## Push

Mentions and replies wake registered users through Web Push (protocol §4.9,
push kind `webpush`, advertising the wake scopes `mentions` and `replies`,
with the client's optional registration `push_id` in each push; see
[SPEC section 4.4](../SPEC.md#44-push)). Both plans have a
`push` policy, set in `src/plans/free.ts` with Paid's daily cap raised in
`src/plans/paid.ts`:

| Setting | Workers Paid | Workers Free |
| --- | ---: | ---: |
| `pushesPerDay` (server-wide, one per registration woken) | 5,000 | 1,000 |
| `wakesPerMessage` (users with live registrations one message may wake) | 10 | 10 |
| `pushesPerSenderDay` (pushes one sender's messages may get delivered, 2xx only) | 200 | 50 |
| `pushesPerRecipientDay` (pushes one user may receive) | 100 | 100 |
| `coalesceSeconds` (a user is woken for a room at most once in this window) | 60 | 60 |
| `subscriptionsPerUser` | 5 | 5 |
| `pushExpiryDays` (a registration not renewed this long is skipped, then deleted) | 7 | 7 |
| `registersPerUserMinute` (`push_register` requests per user, across reconnects) | 10 | 10 |
| `mutesPerUserMinute` (`status` `mute` and `me` `status` changes per user, together; past it either is `retry_after` and nothing changes) | 6 | 6 |
| `ttlSeconds` (how long a push service keeps an undelivered push) | 1 day | 1 day |

`wakesPerMessage` times `subscriptionsPerUser`, the pushes one message may
send, is at most 64; `wakesPerMessage` is at most 32, the mentioned users one
message looks up; `pushesPerSenderDay` and `pushesPerRecipientDay` fit
`pushesPerDay`; `registersPerUserMinute` and `mutesPerUserMinute` are at
most 60, the per-type throttle bound;
`coalesceSeconds` is at most a day; `pushExpiryDays` is 2 to 90; and
`ttlSeconds` is at most four weeks. The configuration check fails otherwise.

**Allowed push services.** `PUSH_HOSTS` lists the hosts a registration's
endpoint may name, comma-separated: an exact host such as
`fcm.googleapis.com`, or `*.` and a host for its subdomains only
(`*.push.apple.com` matches `api.push.apple.com`, not `push.apple.com`). A
standalone `*` allows any public host. Unset or empty, it is the browsers'
own push services: `fcm.googleapis.com` (Chrome, Edge on Android, and other
Chromium browsers), `*.push.services.mozilla.com` (Firefox),
`web.push.apple.com` and `*.push.apple.com` (Safari), and
`*.notify.windows.com` (Edge on Windows). Any other endpoint is refused with
`invalid_params` "push service not allowed here", after the checks that
refuse IP literals, internal names, credentials and ports, which apply
whatever the list says. A malformed list fails the configuration check.
The list is checked again before each push, so narrowing it stops pushes to
registrations made under the wider one.

Push is off, and `server.push` absent, until a VAPID key pair
([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)) and contact are set:

1. **Keys.** `node scripts/vapid-keys.mjs` prints a new P-256 key pair as
   `VAPID_PUBLIC_KEY=…` and `VAPID_PRIVATE_KEY=…`, unpadded base64url.
2. **Public key and contact.** Add `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT`
   (a `mailto:` address or `https:` URL push services may use to reach the
   operator) to `[vars]` in `wrangler.production.toml`. The public key is
   advertised to every client as `server.push.webpush.key`.
3. **Private key.** `npx wrangler secret put VAPID_PRIVATE_KEY --config
   wrangler.production.toml`, pasting the private key. Never put it in
   source.

Locally, put the three in `.dev.vars`. A malformed key or subject makes every
request fail its configuration check, and so does a private key that does
not match the public one: the check signs with one and verifies with the
other. Browsers subscribe with the public
key, so replacing the pair strands every subscription: push services refuse
pushes signed with the new key (with 403), and clients must subscribe again.
An old row goes at the first push its service refuses with 403, or when its
user's newer registration replaces it or it expires, whichever comes first. Deleting the
secret turns push off; stored subscriptions stay, unused, until it is set
again.

Pushes are outbound requests from the Durable Object, which no Worker or
Durable Object allowance counts and no edge rule needs to allow. Their SQL is
in the [cost report](cost-report.md#push); `/status` shows the day's pushes.

## User status (presence)

With push on, the server advertises capability `status` (protocol §4.5):
users choose a `status` with `me` (`online`, `""` for none, `dnd`,
`invisible`), connections report `idle`, and users mute their pushes
everywhere or in a room and its threads (at most 100 rooms a user). With
presence on, others see each user's `status`: `online`, `idle` or `offline`
from their connections when they chose `online`, `dnd` while connected,
`offline` when invisible, and `""` when they chose none (see
[SPEC section 4.4](../SPEC.md#44-push), Chosen status, Mute and User
status). The `server` frame then lists `server.status: ["dnd",
"invisible"]` (protocol §3.1), the optional values clients may offer; with
presence off it is left out, though `me` still accepts and keeps `dnd` and
`invisible` (a server choice, so a choice holds across `/toggle presence`). The plan's `features.presence` turns it on, and `PRESENCE`
overrides it:

| `PRESENCE` | What others see | Extra SQL |
| --- | --- | --- |
| `true` (both plans' default) | each user's status, from their connections, or `offline` (`""` for none) without one | a listing reads each listed member's chosen status, a read only for members who chose one or muted |
| `false` | `status` is `""` (none) for everyone in listings, and no `server.status`; the chosen status is still kept and in the user's own `you`, mutes still work, and invisible users and those who chose none are still left out of connected member listings | none |

Without push there is no `status` capability, so presence is off whatever
it says. An admin's `/toggle presence` turns it off and on again without a
deploy. A status or mute change writes about 3 or 4 rows, and the two share
`mutesPerUserMinute`. A push registration never makes anyone `idle`.

Two limits shape how fast changes are announced, both in seconds and at most
60 (`MAX_STATUS_DELAY_SECONDS`), so what others see is never more than about
a minute behind:

- `statusCoalesceSeconds` (60): a user's status is announced at most once in
  this long; changes in between wait, and only the latest goes out. Member
  listings are also reused for up to this long, until something they read
  is written.
- `offlineGraceSeconds` (60): a change caused by a closed connection waits
  this long, so a reload or a phone reconnecting shows nothing.

Waiting changes, and mutes that run out within the minute, are handled by
one in-memory timer, armed only while a signed-in connection is open, which
keeps the object awake for at most a minute after its last event; it uses no
SQL (but to read a room mute that ran out) and no alarm, so no Durable
Object request. A mute that runs out later is told at the next event. See
the [cost report](cost-report.md#user-status).

## Runtime overrides

Wrangler string variables use the exact names below. Numeric policy variables
accept camelCase, matching `src/budget.ts`, or uppercase snake case with an
optional `LIMIT_` prefix (for example `LIMIT_MAX_FRAME_BYTES`). The prefixed
form takes precedence, then uppercase, then camelCase. Omitted variables use the defaults.
Production should use the checked-in budget defaults; retain overrides for local
tests or deliberate temporary reductions. Overrides do not regenerate the native
limiter or edge rules. Remove temporary overrides before applying a budget increase.
All limits compose; reducing a global budget may prevent reaching a principal
allowance. Validate changes locally and rerun cost calibration before deployment.
Use small values for deterministic test exhaustion, not larger production limits
to make a test pass.

Every numeric variable is parsed as a positive JavaScript safe integer. `0`,
fractions, negative values, and values above `Number.MAX_SAFE_INTEGER` fail
startup. For example, `maxFrameBytes` accepts `LIMIT_MAX_FRAME_BYTES`,
`MAX_FRAME_BYTES`, or `maxFrameBytes`, in that precedence order. The same
aliases apply to every row in the numeric table; Wrangler deployments should
use the uppercase form, and local tests may use the camelCase form.

The worker validates relationships before it accepts an HTTP request or a
WebSocket. These checks are part of the deployment policy, not alternate
defaults:

- `historyDefaultLimit` cannot exceed `historyMaxLimit`, which is at most 50;
  one snapshot plus response overhead must fit `historyMaxResponseBytes`, which
  is at most 256 KiB.
- `maxTextBytes`, credential bytes, challenge bytes, and request IDs must fit
  the frame policy. Text, names, and snapshots must fit their respective
  snapshot/frame bounds; parser depth, node, embed, and metadata caps have the
  calibrated ceilings below.
- A connection's pending frame count and bytes must hold every admitted frame.
  Across `openConnections`, the pending-byte allocation is at most 32 MiB.
  Pending frames, connection rates, and limiter records have bounded ceilings.
- Per-minute and per-day budgets cannot contradict their own windows. Global
  posting, registration, identity, and processed-frame caps are fixed demo
  ceilings. Low, high, and hard storage watermarks must be strictly ordered.
- A moved message re-logs every reaction set in one record, so
  `reactionUsersPerMessage` times the per-user bound (emoji at most 64 UTF-8
  bytes each, escaped, plus the user's name) must fit `historyMaxResponseBytes`.
- `guestNumberBlock` is at most 10,000 guest numbers.
- Foreground plus maintenance SQL budgets must fit the daily SQL ceilings.
  Each maintenance budget is at least 520 operations, covering the one-time
  512-row bootstrap reservation and eight control rows for deferred cleanup.

The calibrated hard ceilings are `maxFrameBytes` 16 KiB, `maxTextBytes` 4 KiB,
`maxSnapshotBytes` 8 KiB, JSON depth 8, JSON nodes 2,048, request IDs 128
bytes, names 80 Unicode code points/320 UTF-8 bytes, embeds 4, history limit
50, history response 256 KiB, pending work 8 frames/128 KiB, open sockets 100,
registered identities and limiter records 10,000 each, processed frames
150,000/day, global posts 120/minute and 10,000/day, registrations 300/day,
connection frame rate 120/minute, server-wide frames 1,000/minute (at least one
IP's minute), per-type throttles 60/minute, frame blocks
20 frames (and one block per anonymous connection must fit the IP's frame
minute), `room_list` registered members 200 per room, guest-number blocks
10,000 numbers, SQL writes 800,000/day, SQL reads 30,000,000/day,
database high-water 768 MiB and hard target 1 GiB, cleanup 100 records,
thread rooms 100 with 2 KiB of client fields, reactions 64 users per message
and 16 emoji per user, and credentials/challenges 16 KiB. Operators
may lower these values but cannot raise them without changing the implementation
and recalibrating its resource model.

| Variable | Meaning |
| --- | --- |
| `RP_ID` | Explicit passkey relying-party hostname; local default `localhost` |
| `RP_ORIGINS` | Comma-separated exact WebAuthn origins; required explicitly with wildcard guest admission; never accepts wildcards |
| `ALLOWED_ORIGINS` | Exact browser-origin allowlist, or standalone `*` to admit every guest origin (including opaque/missing Origin); cannot mix `*` with explicit origins; all clients remain subject to quotas |
| `RP_NAME` | Bounded display name for browser passkey prompts |
| `ACTIVITY` | `true` advertises and relays typing (cap `activity`, section 4.2 of the spec); `false` turns it off. Unset, the plan decides: on for Workers Paid, off for Free. An admin's `/toggle activity` overrides it until toggled back. Read cursors are never kept |
| `PRESENCE` | `true` or `false`: whether others see each user's `status` (protocol §4.5); needs push. The status users choose with `me` and their mutes are taken whatever it says. Unset, the plan decides: on for both. An admin's `/toggle presence` overrides it until toggled back. See [User status](#user-status-presence) |
| `GUEST_POSTING` | `true` lets guests post, react, join and leave rooms, and create threads under the guest quotas; default off in both plans, so guests only list rooms and read history until they sign in with a passkey. Announced as `ext.settings.guest_posting` (extension `ext:settings`) |
| `APRON_ADMIN_TOKEN` | Optional fixed bearer token, 24 to 256 of `A-Z a-z 0-9 - _` and not starting `apron_bot_`, `apron_invite_`, or `apron_join_`: `auth` with `scheme: "token"` and this token signs in as the registered user `admin` ("Admin"), from any origin and without a passkey, created on first use (a registration against the usual caps). That user is always an admin and can run the admin commands (`/admin`, `/kick`, `/rename`, `/invite-token`, `/invite`, `/purge`, `/toggle` and `/status`; see [SPEC section 5, Admins](../SPEC.md#admins)). Unset by default. Anyone holding it can act as the admin, so set it only as a secret, never a Wrangler var in source: `npx wrangler secret put APRON_ADMIN_TOKEN --config wrangler.production.toml`. It persists across deploys; delete it with `npx wrangler secret delete APRON_ADMIN_TOKEN --config wrangler.production.toml` to turn it off (the `admin` user never holds a passkey, so nothing else signs in as it). A malformed value makes every request fail its configuration check. Locally, use `npx wrangler dev --var APRON_ADMIN_TOKEN:…` or `.dev.vars` |
| `MEDIA_ORIGIN` | Exact https origin where the upload bucket serves objects, such as `https://media.apron.chat`; with `PUBLIC_ORIGIN`, `UPLOAD_SIGNING_KEY` and the `MEDIA` binding, turns uploads on for a plan that has them |
| `PUBLIC_ORIGIN` | This Worker's exact public origin, which `write_url`s point at |
| `UPLOAD_SIGNING_KEY` | Secret of at least 32 characters that signs `write_url`s; set with `npx wrangler secret put UPLOAD_SIGNING_KEY --config wrangler.production.toml` |
| `VAPID_PUBLIC_KEY` | Uncompressed P-256 public key, unpadded base64url (`node scripts/vapid-keys.mjs`); with `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`, turns push on and is advertised as `server.push.webpush.key` |
| `VAPID_PRIVATE_KEY` | Secret: the matching 32-byte private key, unpadded base64url; set with `npx wrangler secret put VAPID_PRIVATE_KEY --config wrangler.production.toml` |
| `VAPID_SUBJECT` | `mailto:` address or `https:` URL sent to push services in each VAPID token as the operator's contact |
| `PUSH_HOSTS` | Comma-separated push service hosts registrations may name, `*.host` for a host's subdomains, or a standalone `*` for any public host; unset, the browsers' own services (see [Push](#push)) |
| `ADMISSION_OFF` | Operator admission switch; `true` rejects new sockets in the entry Worker before the limiter or DO call; existing sockets remain subject to DO budgets |
| `ENVIRONMENT` | Set to `development` to enable local origin defaults when `ALLOWED_ORIGINS` and `RP_ORIGINS` are omitted |
| `NODE_ENV` | Set to `test` to enable the same local origin defaults for tests; production-like deployments must configure origins explicitly |

Numeric values are positive safe integer counts. Values named `Bytes` count
UTF-8 bytes, `CodePoints` count Unicode code points, and values named `Seconds`
are durations. `Limit`, `Embeds`, `Connections`, `Records`, and `Identities`
are item/count caps. `Bytes` on storage watermarks means effective occupied
SQLite bytes. Posting, history, authentication, frame, and admission `Minute`
limits are rolling 60-second windows. `Day` limits use the server's effective
monotonic time and UTC calendar date; a backward wall-clock jump cannot reset
them. Cleanup and deduplication run in bounded batches/records, while
`foreground*` and `maintenance*` are daily SQL operation budgets.

`threadLimit` counts thread rooms (rooms with a `parent_room_id`) and
`threadMetadataBytes` bounds a room's serialized client fields (`title`,
`description`, `ext`). The `anonymous*` variables configure the
guest tier (the `guest` auth scheme).

Guests are numbered `guest_1`, `guest_2`, … from a server-wide counter. The
object reserves `guestNumberBlock` numbers at a time by advancing a stored
high-water mark (one `_meta` row, about four written rows with the
reservation's bookkeeping), then hands them out from memory. A restart,
eviction, or hibernation wake forgets the in-memory block, so the next guest
reserves a fresh block and the unused numbers are skipped; numbers are never
reissued. The default of 10 favours a meaningful count over saved writes:
this object sleeps between quiet visits, and each visit after a sleep burns
the rest of a block whatever its size, so a block of 1,000 would number
occasional visitors 1, 1001, 2001, … while saving at most about 1,600 written rows
a day (at most 400 blocks for the 4,000 guest admissions a day, against
about 60 rows each guest connection already writes). Raise it only for a deployment that stays awake.

The numeric rows are grouped by their unit and enforcement scope:

- Durations: `retentionSeconds`, `cleanupSeconds`, `challengeTtlSeconds`,
  `unauthenticatedTimeoutSeconds`, `dedupTtlSeconds`, and
  `statusCoalesceSeconds` and `offlineGraceSeconds` (each at most 60; see
  [User status](#user-status-presence)).
- Payload/storage bytes: `maxFrameBytes`, `maxTextBytes`, `maxSnapshotBytes`,
  `maxRequestIdBytes`, `maxNameBytes`, `historyMaxResponseBytes`, `pendingBytesPerConnection`,
  `databaseHighWaterBytes`, `databaseHardTargetBytes`,
  `databaseResumeLowWaterBytes`, `threadMetadataBytes`, `maxCredentialBytes`,
  `maxChallengeBytes`.
- Parser, item, and concurrency counts: `maxJsonDepth`, `maxJsonNodes`,
  `maxNameCodePoints`, `maxEmbeds`,
  `historyDefaultLimit`, `historyMaxLimit`, `concurrentHistoryPerConnection`,
  `registeredIdentityCount`, `openConnections`, `anonymousConnectionsPerIp`,
  `registeredConnectionsPerUser`, `connectionsPerIp`,
  `pendingFramesPerConnection`, `repeatedPolicyViolations`, `cleanupBatch`,
  `threadLimit`, `reactionUsersPerMessage`, `reactionEmojisPerUser`,
  `limiterRecordCap`, `frameLease`, `roomListMembers`, `guestNumberBlock`,
  `activityMaxTypingSeconds`, `pingSeconds` (advertised as `server.ping`), `pingTimeoutSeconds`
  (seconds; the timeout must be at least twice the interval). `roomListMembers`
  is how many registered members each room lists in `members`, in `user_id`
  order, besides every connected member; each costs two indexed reads per
  listed room. A room with more says how many members it has in
  `member_count`. `guestNumberBlock` is how many guest numbers (`guest_<n>`) one
  durable write reserves; see below.
- Rolling minute budgets: `historyRequestsPerUserMinute`,
  `historyRequestsPerIpMinute`, `anonymousPostsPerMinute`,
  `registeredPostsPerMinute`, `ipPostsPerMinute`, `globalPostsPerMinute`,
  `authAttemptsPerIpMinute`, `framesPerConnectionMinute`,
  `framesPerIpMinute`, `connectionAdmissionsPerIpMinute`,
  `globalFramesPerMinute` (server-wide, in memory),
  `roomListRequestsPerUserMinute` and `activityBroadcastsPerUserMinute` (per
  user across their connections).
- UTC-day budgets: `anonymousPostsPerDay`, `registeredPostsPerDay`,
  `ipPostsPerDay`, `globalPostsPerDay`, `registrationsPerIpDay`,
  `registrationsPerDay`, `connectionAdmissionsPerDay`,
  `processedFramesPerDay`, `sqlWritesPerDay`, `sqlReadsPerDay`,
  `foregroundWritesPerDay`, `maintenanceWritesPerDay`,
  `foregroundReadsPerDay`, `maintenanceReadsPerDay`.

| Variable | Workers Paid default | Workers Free, where different |
| --- | ---: | ---: |
| `retentionSeconds` | 604800 | 86400 |
| `cleanupSeconds` | 86400 | 3600 |
| `challengeTtlSeconds` | 120 |  |
| `maxFrameBytes` | 16384 |  |
| `maxTextBytes` | 4096 |  |
| `maxSnapshotBytes` | 8192 |  |
| `maxJsonDepth` | 8 |  |
| `maxJsonNodes` | 2048 |  |
| `maxRequestIdBytes` | 128 |  |
| `maxNameCodePoints` | 80 |  |
| `maxNameBytes` | 320 |  |
| `maxEmbeds` | 4 |  |
| `historyDefaultLimit` | 20 |  |
| `historyMaxLimit` | 50 |  |
| `historyMaxResponseBytes` | 262144 |  |
| `historyRequestsPerUserMinute` | 20 | 10 |
| `historyRequestsPerIpMinute` | 60 | 30 |
| `concurrentHistoryPerConnection` | 1 |  |
| `anonymousPostsPerMinute` | 5 |  |
| `anonymousPostsPerDay` | 200 | 100 |
| `registeredPostsPerMinute` | 20 |  |
| `registeredPostsPerDay` | 1000 | 500 |
| `ipPostsPerMinute` | 30 |  |
| `ipPostsPerDay` | 2000 | 1000 |
| `globalPostsPerMinute` | 120 | 60 |
| `globalPostsPerDay` | 10000 | 5000 |
| `registrationsPerIpDay` | 5 | 3 |
| `registrationsPerDay` | 300 | 100 |
| `registeredIdentityCount` | 10000 |  |
| `authAttemptsPerIpMinute` | 10 |  |
| `openConnections` | 100 |  |
| `anonymousConnectionsPerIp` | 2 |  |
| `registeredConnectionsPerUser` | 3 |  |
| `connectionsPerIp` | 10 |  |
| `connectionAdmissionsPerIpMinute` | 5 |  |
| `connectionAdmissionsPerDay` | 4000 | 2000 |
| `unauthenticatedTimeoutSeconds` | 30 |  |
| `pendingFramesPerConnection` | 8 |  |
| `pendingBytesPerConnection` | 131072 |  |
| `framesPerConnectionMinute` | 60 |  |
| `framesPerIpMinute` | 120 |  |
| `processedFramesPerDay` | 150000 | 100000 |
| `repeatedPolicyViolations` | 3 |  |
| `globalFramesPerMinute` | 600 | 300 |
| `activityBroadcastsPerUserMinute` | 10 |  |
| `roomListRequestsPerUserMinute` | 6 |  |
| `activityMaxTypingSeconds` | 30 |  |
| `frameLease` | 10 |  |
| `roomListMembers` | 200 | 100 |
| `pingSeconds` | 45 |  |
| `pingTimeoutSeconds` | 150 |  |
| `guestNumberBlock` | 10 |  |
| `statusCoalesceSeconds` | 60 |  |
| `offlineGraceSeconds` | 60 |  |
| `sqlWritesPerDay` | 800000 | 80000 |
| `sqlReadsPerDay` | 30000000 | 3000000 |
| `foregroundWritesPerDay` | 700000 | 60000 |
| `maintenanceWritesPerDay` | 100000 | 20000 |
| `foregroundReadsPerDay` | 25000000 | 2500000 |
| `maintenanceReadsPerDay` | 5000000 | 500000 |
| `databaseHighWaterBytes` | 805306368 | 100663296 |
| `databaseHardTargetBytes` | 1073741824 | 134217728 |
| `databaseResumeLowWaterBytes` | 671088640 | 83886080 |
| `cleanupBatch` | 100 |  |
| `threadLimit` | 100 |  |
| `threadMetadataBytes` | 2048 |  |
| `reactionUsersPerMessage` | 32 |  |
| `reactionEmojisPerUser` | 8 |  |
| `dedupTtlSeconds` | 86400 |  |
| `limiterRecordCap` | 10000 |  |
| `maxCredentialBytes` | 16384 |  |
| `maxChallengeBytes` | 16384 |  |
| `sessionTtlSeconds` | 2592000 |  |
