# Configuration reference

## Plans

Each Cloudflare Workers plan has its own policy file: its application
defaults, admission rates, feature-switch defaults, and the included usage
the account-usage stop compares against. `PLAN` in `src/budget.ts` selects
one, and must match the account's plan.

| File | Plan | Features on by default |
| --- | --- | --- |
| [`src/plans/paid.ts`](../src/plans/paid.ts) (selected) | Workers Paid, $5/month | `activity` (typing), presence (user status, with push), live text (with `PUBLIC_ORIGIN` and `UPLOAD_SIGNING_KEY`) |
| [`src/plans/free.ts`](../src/plans/free.ts) | Workers Free | presence (user status, with push) |

The paid plan starts from the free one and raises only what Paid's included
usage pays for, sized against its monthly allowances divided by 31 days with
headroom. Paid includes 16 times the SQL rows written and 160 times the rows
read, so the SQL ceilings rise tenfold, and posts, registrations, admissions,
history pages, and member listings with them. History is kept 7 days instead
of 24 hours, matching uploaded images, with daily cleanup; the database
watermarks rise to 768 MiB (1 GiB hard), a fifth of the 5 GB-month included.

Paid includes only a third of Free's Durable Object requests (1 million a
month against 100,000 a day), so frame budgets move less: the daily frame
budget rises by half and the server-wide frame minute doubles. The total
connection limits stay; guest connections and admissions per address rise so
that two browsers on one address can each sign in. The header of
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
defaults. Resource ceilings reference those defaults rather than repeating
numeric allocations. Separate calibrated parser, payload, and memory bounds
remain in `src/budget.ts`; increasing them requires reviewing their consumers
and repeating cost calibration.

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
copy. Use Node.js 24 (`.node-version`).

`ADMISSION_BUDGET.requestsPerIpMinute` defaults to 20 attempted handshakes per
minute (10 with the Free budgets), before calling the DO. This leaves retry
headroom over the 12 accepted connections per IP per minute (5), since a refused
upgrade is followed by a status probe. `/` and `/ws` share a bucket. IPv4-mapped addresses
share their IPv4 bucket; native IPv6 shares a /56. Missing or failed limiter
bindings reject admission with 503. Exhaustion returns 429 and `Retry-After`.
The binding is approximate and local to each Cloudflare location, not a global
daily counter. NAT users share this limit. Development and production use distinct
limiter namespaces; additional deployments must use distinct namespace IDs too.

Two more limits, counted only for attempts their address's own limit let
through, stop the per-address limit from being multiplied:

- `requestsPerIpv6PrefixMinute` (60; Free: 30) is shared by a native IPv6 /48 at one
  location, across all its /56s. One host can hold a whole /48, which would
  otherwise give it 256 address limits. Past it, attempts get 429.
- `objectRequestsPerLocationMinute` (200) is shared by every address at one
  location: at most that many attempts a minute pass from there to the Durable
  Object. Each costs a Durable Object request, the allowance Paid includes the
  fewest of (32,000 a day), while a rejection before it costs only a Worker
  request (320,000 a day). It is twice a reconnect of every open connection,
  so a deploy or a wake does not reach it. Past it, attempts there get 503 with
  `Retry-After: 60`, while other locations go on.

Generation refuses a per-address limit below `connectionAdmissionsPerIpMinute`,
a /48 limit below the per-address one, and a location limit below the /48's
or `openConnections`.

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
start of the calendar month against the plan's `monthly` allowances.

On a plan that fails closed (Free), the stop is at 90% of any daily
allowance or of stored bytes. On a plan that bills past its inclusions
(Paid), the stop is in dollars: `src/pricing.ts` prices the month's usage
past each inclusion at Cloudflare's list prices (rounded up to whole billing
units, as Cloudflare does), and the server stops when the overage added
today passes `BILL_CAP_DAY` (default $5) or the month's passes
`BILL_CAP_MONTH` (default $25), on top of the $5 plan. A day well past its
31st share of the month costs nothing while the month stays inside its
inclusions, so a busy day no longer stops the server. Set either variable
in `wrangler.production.toml` as a dollar amount (`"0"` stops at the first
billed unit); a value that is not one fails startup.

At its stop line the object persists a stop, rejects new connections, and
closes live sockets once. A daily stop holds for that UTC day, and a monthly
one (`monthly.*` on Free, the month's bill cap on Paid) for that calendar
month, even while a refresh in the new day is pending or failing. `/status`
shows the estimated bill for the month ($5 plus the overage, by resource),
the overage added today, and both caps. This is an early-stop signal, not an exact remaining-quota meter:
analytics lag, sampling, and other account workloads can still cause an
earlier or later platform limit.

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
- While the estimated overage passes the bill cap (`BILL_CAP_DAY` for the
  day, `BILL_CAP_MONTH` for the month; see the account-usage stop above), it
  turns on the zone custom rule `apron_budget_stop`, which blocks
  `server.apron.chat` (and, with uploads, `media.apron.chat`) at the edge.
  Blocked requests never invoke the Worker and are not billed. It turns the
  rule off once the overage is back under both caps: at the next UTC day for
  the day's cap, or the next month for the month's. The worst a billing
  cycle can cost is the plan plus two months' caps ($55 at the defaults),
  plus what runs up during the minute or so analytics lag behind. It touches no other rule, so
  `apron_admission_off` stays yours to use by hand.
- **Admin alert.** When the guard or the flood trip (below) turns the rule
  on or off, when the server changes tier or an action's breaker opens or
  closes (see [Server tiers](#server-tiers)), and at the day's first storage
  overrun, the server posts a public message in `general` as the `admin`
  user that mentions and pushes to every user with the `admin` role (up to
  `wakesPerMessage`, 10); see
  [SPEC section 10](../SPEC.md#10-degradation-and-public-demo-behavior).
  Give yourself the role (`/admin <user_id>`) and allow notifications in your
  client to get it on your phone; muting `general` or choosing `dnd`
  silences it. An alert that fails is logged (`trigger_notice_failed`) and
  never undoes what it tells of.
- The monthly allowances are Worker requests, Worker CPU, Durable Object
  requests and duration, SQL rows read and written, and Workers Logs bytes
  (estimated; below), plus R2's free tier for uploads: Class A and Class B operations (each day
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
- **Log sampling.** Every invocation writes a Workers Logs event. From
  2026-12-01 logs bill by the GB ([Cloudflare Observability
  pricing](https://developers.cloudflare.com/observability/pricing/): 50 GB
  ingested and 10 GB-month stored a billing cycle, then $0.25 a GB and $0.10
  a GB-month); until then by the event (20 million a month, then $0.60 a
  million). Production keeps one in ten (`head_sampling_rate = 0.1`).
  Analytics do not report log bytes, so the guard estimates them from
  invocations with the plan's `logEstimate`: every entry Worker request at
  8 KiB and every Durable Object invocation at 2 KiB, above the 6.3 KB and
  1 KB measured on the demo, times the sampling rate. `npm run budget:check`
  refuses a production config that samples more than the estimate assumes.
  The request stops come long before this one; it is a backstop.
- **Metrics.** Logs are sampled, so rare events can be missed and totals are
  estimates. The production config also binds a Workers Analytics Engine
  dataset, `METRICS` (`apron_server_metrics`), and `src/metrics.ts` writes one
  unsampled data point per event worth counting: stale connections closed
  (`stale_close`: `pinged` or `unpinged`, and the origin), alarms (`alarm`:
  `light` for status changes only, or `full`), pushes delivered (`push`:
  `sent`, `failed` or `gone`), storage overruns and accounting closing and
  reopening (`accounting`: `overrun` with the operation and its rows, as the
  log line `accounting_overrun` says; `uncertain` with what failed, as
  `accounting_closed` says; or `recovered`), tier changes (`tier`: the new
  tier and the one before), throttle trips (`throttle`: the trigger and the
  method refused; see Server tiers), admin alerts (`admins_notified`) and the edge
  stop turning on or off (`edge_stop`: `guard` or `flood`, or `lifted`). Each point
  is `blob1` the event, `blob2` and `blob3` its details and `double1` its
  value. Writing never awaits or throws, and without the binding nothing is
  written. Workers Paid includes 10 million data points a month; this server
  writes a few thousand a day. `npm run usage:report -- --days 3` (with
  `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` that has Account
  Analytics Read) prints each UTC day's Durable Object awake time, billed
  duration, peak sockets and busiest hour from GraphQL analytics, and the
  counters from the dataset.

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
live rule, and the guard only logs when it cannot work, so check after
deploying: an admin's `/status` reads the rule with the guard's own zone and
token and shows **Edge stop** as on, off, or **not working** with the reason
(a missing var or secret, a missing rule, or the API's refusal). The Worker's
logs record the same as `budget_guard_unconfigured`, `budget_guard_rule_missing`
and `budget_guard_rule_failed`, one in ten of them with log sampling.

What the guard cannot promise:

- **A few seconds of every flood are billed.** A request past the included
  usage costs about $0.49 a million from 2026-12-01 (request $0.30, about a
  millisecond of CPU $0.02, and a tenth of a 6.3 KB log event, $0.16 to
  ingest and $0.015 to keep a week); $0.38 before, when that tenth of a log
  event cost $0.06. Each calendar month stops at half
  its allowance plus whatever arrives before the stop takes effect, so a
  billing cycle that straddles two calendar months can be billed for two such
  windows. A flood is stopped within the rate limiter's detection (1,200
  requests at one location, a second or less at flood rates) plus the rule
  change reaching the edge, taken here as 30 seconds: at 100,000 requests a
  second, two windows cost about $2.95, and the cost grows with the rate.
  An attack spread thinly enough to stay under 20 requests a second at every
  location (a few thousand a second in all) is left to the minute guard and
  its analytics lag of about six minutes: about $2.30 for two windows. These
  are worst cases for sustained attacks that Cloudflare's own DDoS mitigation
  does not catch.
- **Open sockets.** The edge rule stops new requests, not WebSockets already
  open. The Durable Object's own account-usage stop closes them when it next
  refreshes, and its per-connection limits bound them until then.
- **Other Workers.** Allowances are account-wide. The guard counts every
  Worker's usage but blocks only this server. Another Worker reachable on
  `workers.dev` or preview URLs, where zone WAF rules do not apply, can still
  run up the bill; turn those off for Workers that do not need them (this
  server's production config must, or `npm run deploy` refuses it).
- **The public bucket.** Upload views go straight to R2's public domain,
  not through the Worker, so the flood trip does not see them. A flood of
  requests for images not in Cloudflare's cache, such as made-up keys, is
  billed as R2 Class B reads ($0.36 a million) past the free 10 million a
  month, until the minute guard's analytics show it: about $2.60 at 10,000
  requests a second, or about $26 at 100,000, for two six-minute windows.
  `apron_media_invalid` blocks query strings, other methods, and paths
  outside `f/`, `a/` and `e/`, so cached images cannot be bypassed.
- **Other products** on the account (KV, Queues, and so on) are not
  measured.

## Uploads

With the Workers Paid budgets, registered users attach images and voice clips
to messages and set avatars (protocol §4.8, cap `embed:upload`; see
[SPEC section 4.3](../SPEC.md#43-uploads-and-avatars)). The plan's `uploads`
in `src/plans/paid.ts` sets the limits:

| Setting | Value |
| --- | ---: |
| `maxFileBytes` (an attached image or voice clip) | 5 MB |
| `maxAvatarBytes` | 256 KB |
| `maxEmojiBytes` (a custom emoji's image, `/emoji add`) | 256 KB |
| `maxEmoji` (custom emoji in the catalog, kept until removed) | 500 |
| `uploadsPerDay` (server-wide, avatars and custom emoji included; counted when a write is claimed) | 500 |
| `uploadsPerUserDay` (counted when an upload starts) | 20 |
| `writeWindowSeconds` | 10 minutes |
| `fileRetentionSeconds` | 7 days |
| `avatarRetentionSeconds` | 30 days |
| `avatarRefreshSeconds` | 7 days |
| `lifecycleLagSeconds` | 1 day |
| `storedBytesCap` | 5 GB |

Uploads turn on once the bucket, the signing key and the two origins (below)
are set; set up all of these first:

1. **Bucket.** Create an R2 bucket named `apron-media` (the `MEDIA` binding
   in `wrangler.production.toml`). Deploying fails while it does not exist.
2. **Lifecycle rules.** On the bucket, delete objects with prefix `f/` 7 days
   after upload and prefix `a/` 30 days after upload. They must match
   `fileRetentionSeconds` and `avatarRetentionSeconds`. Add no rule for
   `e/`: custom emoji images (`e/<id>`), their catalogs (`e/c/<sha256>.json`)
   and the server's avatar (`e/<id>`, `/server avatar`) stay until the
   server deletes them.
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
   [the generated definitions](edge-rules.generated.json). With uploads,
   `apron_invalid_request` lets `write_url` requests (`PUT` and `OPTIONS` on
   `/w/`) through, `apron_budget_stop` blocks the media host too, and
   `apron_media_invalid` allows `f/`, `a/` and `e/`.
7. **CORS.** Clients fetch the custom emoji catalog with `fetch()`, from
   their own origin, so the bucket needs a CORS policy (bucket Settings, CORS
   Policy) that allows `GET` and `HEAD` from the client origins, `*` for a
   server that admits any origin as this one does:

   ```json
   [{"AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "MaxAgeSeconds": 86400}]
   ```

   Images load without it; only the catalog's `fetch()` needs it. Keep the
   methods to `GET` and `HEAD`: `apron_media_invalid` blocks the rest, a CORS
   preflight included, and a plain `GET` needs none.

An admin can turn uploads off and on again with `/toggle uploads`, without a
deploy: new connections stop being offered `embed:upload`, and new
attachments, avatars and custom emoji are refused until it is turned back on.

**Custom emoji** (extension `ext:emoji`; see
[SPEC section 4](../SPEC.md#extension-extemoji)). A registered user with the
role `admin`, `mod` or `friend` adds one with `/emoji add :name:` and one
image attached, and removes one with `/emoji remove :name:`. Each change
publishes a new catalog to the bucket at `e/c/<sha256>.json`. Emoji images
count against `uploadsPerDay`, the user's `uploadsPerUserDay`, and
`storedBytesCap`, for as long as they stay: at most 500 of 256 KB, 125 MB.
The server's avatar (`/server avatar`, below) is kept the same way, one image
of at most `maxAvatarBytes`.

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

## Live text

Live text (protocol §4.8.3, caps `embed:terminal` and `embed:append`): a
sender streams a terminal or an append with an HTTP `PUT` to a `write_url`,
and readers `GET` its `url` as it grows
([policy](policy.md), [limits](limits.md#live-text)). It needs no R2 and no
other service: the Durable Object holds each text in memory while it
streams. It is configured where the plan has a `liveText` policy and the
deployment sets `PUBLIC_ORIGIN` and the `UPLOAD_SIGNING_KEY` secret (the
same key signs upload and live `write_url`s), and on where the plan's
`features.liveText` or `LIVE_TEXT` says so; an admin's `/toggle livetext`
turns it off and on without a deploy (texts already streaming finish).

| Setting | Workers Paid | Workers Free | Ceiling |
| --- | ---: | ---: | ---: |
| On by default (`features.liveText`) | yes | no | |
| `maxSeconds` (streaming time from the `PUT`; at it the text ends) | 120 | 120 | 120 |
| `moderatorMaxSeconds` (the same for the role `admin` or `mod`) | 300 | 300 | 300 |
| `writeWindowSeconds` (an unused `write_url` expires) | 120 | 120 | 300 |
| `terminalKeepBytes` (a terminal's `output`, `keep_last`) | 32 KB | 16 KB | 32 KB |
| `maxInputBytes` (one `PUT` in all; at it the text ends) | 2 MB | 1 MB | 4 MB |
| `appendMaxBytes` (an append adds at most this, and never past `maxTextBytes`) | 4,096 | 4,096 | `maxTextBytes` |
| `startsPerUser` (a burst, then this many per `startWindowMinutes`; a guest's by IP) | 3 | 3 | `startsPerIp` |
| `startsPerIp` | 6 | 6 | |
| `startWindowMinutes` | 10 | 10 | a day |
| `startsPerUserDay` | 20 | 10 | `startsPerDay` |
| `startsPerDay` (server-wide) | 100 | 30 | 500 |
| `concurrent` (open texts server-wide, unused `write_url`s included) | 4 | 2 | 8 |
| `readersPerText` (at once) | 10 | 5 | 32 |
| `readsPerText` (over a text's life, reconnects included) | 30 | 15 | 100 |

One user has one live text open at a time, an unused `write_url` included,
and each start also counts as a post. The starts are `live` rows in
`principal_limits` (the user's or a guest's IP's, the IP's, and the
server's), like any other limiter; the open texts are one `_meta` row
(`live_texts`), read once a wake and kept in memory. A text whose instance
was evicted or redeployed while it streamed is ended, with its embed
removed, by the next instance's first live text work or by the alarm at its
time limit plus 30 seconds. Readers and the writer are counted against the
Worker's per-address and per-location attempt limiters, as connections are.
The time limit is a one-shot timer that exists only while its `PUT` does;
nothing else of live text keeps the object awake.

Each value can be lowered for a test or an incident with a
`LIVE_TEXT_<KEY>` variable in uppercase snake case, such as
`LIVE_TEXT_MAX_SECONDS=30` or `LIVE_TEXT_CONCURRENT=1`; values past the
ceilings above fail the configuration check. The cost of the defaults is in
the [cost report](cost-report.md#live-text). In production, the edge rule
`apron_invalid_request` must let live text through (see
[edge admission](edge-admission.md)).

## Server title, description and avatar

The `server` frame's `title`, `description` and `avatar` (protocol §3.1) say
which server this is in a client's list of servers. Each comes from the
first of these that sets it:

1. What an admin set with `/server` (protocol §4.1, its suggested
   convention), kept in the Durable Object's `_meta` rows (`server:title`,
   `server:description`, `server:avatar`) across restarts.
2. Its variable: `SERVER_TITLE`, `SERVER_DESCRIPTION` or `SERVER_AVATAR`
   (below). An empty one counts as unset.
3. For the description only, the default room `general`'s `description`,
   trimmed, while it is at most 500 bytes; a longer one is left out, not cut,
   since cut CommonMark can end mid-markup.

Otherwise the field is left out: without a title, clients show the server's
address. `RP_NAME` names the server only to passkey prompts.

An admin's `/server` shows the three and where each comes from;
`/server title <text>`, `/server description <text>` and `/server avatar`
(with one image attached) set one, and each without its argument clears it
(see [SPEC section 5, Admins](../SPEC.md#admins)). `/server avatar` needs
uploads, and is refused while they are toggled off; its image is kept like a
custom emoji (above). Each change sends every connection a new `server`
frame, and so does a `room_set` of `general` that changes its description
while that is the server's.

## Link preview media

A link embed's `og` is built by the client that posts it; the server never
fetches a URL (protocol §4.8.1, [SPEC section 4](../SPEC.md)). It keeps the
`og` text (`title`, `description`, `site_name`) and keeps `og.image`,
`og.video` and `og.audio` only when their `url` is `https:`, has no
credentials or port, and names a host `OG_MEDIA_HOSTS` allows; other media
are dropped. Every viewer's client loads a kept URL, so a host belongs on the
list only when whoever posts a link cannot read its access logs and it does
not redirect elsewhere: a big platform's own media CDN, not its main site,
and no shared hosting where anyone can run a server.

`OG_MEDIA_HOSTS` lists them comma-separated, as exact hosts or `*.` and a
host for its subdomains only, like `PUSH_HOSTS`; a standalone `*` keeps media
from any host, and an empty value keeps none. Unset, it is the image CDNs in
`DEFAULT_OG_MEDIA_HOSTS` (`src/config.ts`):

| Service | Hosts |
|---|---|
| YouTube thumbnails | `i.ytimg.com`, `img.youtube.com` |
| Vimeo | `i.vimeocdn.com` |
| GitHub | `opengraph.githubassets.com`, `repository-images.githubusercontent.com`, `avatars.githubusercontent.com` |
| X/Twitter | `pbs.twimg.com` |
| Bluesky | `cdn.bsky.app` |
| Reddit | `i.redd.it`, `preview.redd.it`, `external-preview.redd.it` |
| Wikipedia | `upload.wikimedia.org` |
| Imgur | `i.imgur.com` |
| Twitch | `static-cdn.jtvnw.net` |
| Substack | `substackcdn.com` |

None of these serves a site's player pages, so `og.video` such as YouTube's
`https://www.youtube.com/embed/…` is dropped: a link keeps its thumbnail but
no inline player. Clients still sanitize and sandbox what they render. A
malformed list fails the configuration check. This list does not apply to
the `og` media the server itself builds when one of its own uploads
completes.

## Push

Mentions, replies, and messages in their private rooms wake registered users
through Web Push (protocol §4.9, push kind `webpush`; admins and mods may also
wake for every message in rooms they joined; see
[SPEC section 4.4](../SPEC.md#44-push)). Both plans have a `push` policy, set
in `src/plans/free.ts` with Paid's daily and per-sender caps raised in
`src/plans/paid.ts`:

| Setting | Workers Paid | Workers Free |
| --- | ---: | ---: |
| `pushesPerDay` (server-wide, one per registration woken) | 5,000 | 1,000 |
| `wakesPerMessage` (users with live registrations one message may wake) | 10 | 10 |
| `pushesPerSenderDay` (pushes one sender's messages may claim, delivered or not) | 200 | 50 |
| `pushesPerRecipientDay` (pushes one user may receive) | 100 | 100 |
| `joinedPushesPerRecipientDay` (pushes one moderator may receive only for `joined`, apart from `pushesPerRecipientDay` and charged to no sender) | 20 | 20 |
| `coalesceSeconds` (a user is woken for a room at most once in this window) | 60 | 60 |
| `joinedCoalesceSeconds` (the same for a push only for `joined`) | 300 | 300 |
| `delaySeconds` (how long a message's wake waits before it pushes, so a user who comes back meanwhile is not pushed; `PUSH_DELAY_SECONDS` overrides it) | 30 | 30 |
| `subscriptionsPerUser` | 5 | 5 |
| `pushExpiryDays` (a registration not renewed this long is skipped, then deleted) | 7 | 7 |
| `registersPerUserMinute` (`push_register` requests per user, across reconnects) | 10 | 10 |
| `mutesPerUserMinute` (`status` `mute` and `me` `status` changes per user, together) | 6 | 6 |
| `ttlSeconds` (how long a push service keeps an undelivered push) | 1 day | 1 day |

The configuration check fails unless:

- `wakesPerMessage` times `subscriptionsPerUser`, the pushes one message may
  send, is at most 64, and `wakesPerMessage` is at most 32, the mentioned
  users one message looks up;
- `pushesPerSenderDay`, `pushesPerRecipientDay` and
  `joinedPushesPerRecipientDay` each fit `pushesPerDay`;
- `coalesceSeconds` is at most a day, and `joinedCoalesceSeconds` is
  `coalesceSeconds` to a day;
- `registersPerUserMinute` and `mutesPerUserMinute` are at most 60, the
  per-type throttle bound;
- `delaySeconds` is at most 60, since its wait keeps the object awake;
- `pushExpiryDays` is 2 to 90, and `ttlSeconds` at most four weeks.

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
other.

Browsers subscribe with the public key, so replacing the pair strands every
subscription: push services refuse pushes signed with the new key (with 403),
and clients must subscribe again. An old row goes at the first push its
service refuses with 403, or when its user's newer registration replaces it
or it expires, whichever comes first. Deleting the secret turns push off;
stored subscriptions stay, unused, until it is set again.

Pushes are outbound requests from the Durable Object, which no Worker or
Durable Object allowance counts and no edge rule needs to allow. Their SQL is
in the [cost report](cost-report.md#push); `/status` shows the day's pushes.

## User status (presence)

With push on, the server advertises capability `status` (protocol §4.5):
users choose a `status` with `me` (`online`, `""` for none, `dnd`,
`invisible`), connections report `idle`, and users mute their pushes
everywhere or in a room and its threads. With presence on, others see each
user's `status`, and the `server` frame lists `server.status: ["dnd",
"invisible"]` (see [SPEC section 4.4](../SPEC.md#44-push), Chosen status,
Mute and User status). The plan's `features.presence` turns it on, and
`PRESENCE` overrides it:

| `PRESENCE` | What others see | Extra SQL |
| --- | --- | --- |
| `true` (both plans' default) | each user's status, from their connections, or `offline` (`""` for none) without one | a listing reads each listed member's chosen status, a read only for members who chose one or muted |
| `false` | `status` is `""` (none) for everyone in listings, and no `server.status`; the chosen status is still kept and in the user's own `you`, mutes still work, and invisible users and those who chose none are still left out of connected member listings | none |

Without push there is no `status` capability, so presence is off whatever
it says. An admin's `/toggle presence` turns it off and on again without a
deploy. A status or mute change writes about 2 rows (3 for `invisible`),
and the two share `mutesPerUserMinute`.

Two limits shape how fast changes are announced, both in seconds and at most
60 (`MAX_STATUS_DELAY_SECONDS`), so what others see is never more than about
a minute behind:

- `statusCoalesceSeconds` (60): a user's status is announced at most once in
  this long; changes in between wait, and only the latest goes out. Member
  listings are also reused for up to this long, until something they read
  is written.
- `offlineGraceSeconds` (60): a change caused by a closed connection waits
  this long, so a reload or a phone reconnecting shows nothing.
- `presenceAlarmSeconds` (15; Free: 60): a registered user's waiting change
  wakes the object at the next boundary of this many seconds, so changes due
  together share a wake and statuses show up at most this much later. It
  caps presence wakes at a day's seconds over it (5,760; Free: 1,440).
- `guestPresenceAlarmSeconds` (60): the same for a guest's change, a
  multiple of `presenceAlarmSeconds`, since anyone can open a guest
  connection.

A registered user's `seen` (when they were last shown `offline`) is written
at most once in 10 minutes (`SEEN_WRITE_GRANULARITY_MS`, fixed, not a plan
limit), so at most 144 times a day per account. A waiting change uses the
object's alarm, rounded up to `presenceAlarmSeconds` (a guest's to
`guestPresenceAlarmSeconds`), so the object hibernates while it waits: each
wake costs one alarm (a Durable Object request) and about 9 metered
maintenance writes (6 if the object was still in memory). See the
[cost report](cost-report.md#user-status).

## Runtime overrides

Wrangler string variables use the exact names below. Every row of the numeric
table accepts three names, in this precedence: the `LIMIT_`-prefixed
uppercase snake case (`LIMIT_MAX_FRAME_BYTES`), plain uppercase snake case
(`MAX_FRAME_BYTES`), then camelCase as in `src/budget.ts` (`maxFrameBytes`).
Wrangler deployments should use the uppercase form; local tests may use
camelCase. Omitted variables use the defaults. Each value must be a positive
JavaScript safe integer: `0`, fractions, negative values, and values above
`Number.MAX_SAFE_INTEGER` fail startup.

Production should use the checked-in budget defaults; retain overrides for local
tests or deliberate temporary reductions. Overrides do not regenerate the native
limiter or edge rules. Remove temporary overrides before applying a budget increase.
All limits compose; reducing a global budget may prevent reaching a principal
allowance. Validate changes locally and rerun cost calibration before deployment.
Use small values for deterministic test exhaustion, not larger production limits
to make a test pass.

The worker validates relationships before it accepts an HTTP request or a
WebSocket. These checks are part of the deployment policy, not alternate
defaults:

- `historyDefaultLimit` cannot exceed `historyMaxLimit`, which is at most 50;
  one snapshot plus response overhead must fit `historyMaxResponseBytes`, which
  is at most 256 KiB.
- A user's history burst, minute and day allowances cannot exceed their IP's,
  nor an IP's daily count `historyRequestsPerDay`.
- `maxTextBytes`, credential bytes, challenge bytes, and request IDs must fit
  the frame policy. Text, names, and snapshots must fit their respective
  snapshot/frame bounds; parser depth, node, embed, and metadata caps have the
  calibrated ceilings below.
- A connection's pending frame count and bytes must hold every admitted frame.
  Across `openConnections`, the pending-byte allocation is at most 32 MiB.
  Pending frames, connection rates, and limiter records have bounded ceilings.
- Per-minute and per-day budgets cannot contradict their own windows. Trusted
  posting limits are at least the registered ones. Global posting,
  registration, identity, and processed-frame caps are fixed demo ceilings.
  Low, high, and hard storage watermarks must be strictly ordered.
- `retentionSeconds` is at least `cleanupSeconds`; `sessionTtlSeconds` is at
  most 30 days.
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
50, history response 256 KiB, one concurrent history request per connection,
pending work 8 frames/128 KiB, open sockets 100,
registered identities and limiter records 10,000 each, processed frames
150,000/day, global posts 120/minute and 10,000/day, registrations 300/day,
connection frame rate 120/minute, server-wide frames 1,000/minute (at least one
IP's minute), per-type throttles 60/minute, frame blocks
20 frames (and one block per anonymous connection must fit the IP's frame
minute), `room_list` registered members 200 per room, guest-number blocks
10,000 numbers, SQL writes 800,000/day, SQL reads 30,000,000/day,
database high-water 768 MiB and hard target 1 GiB, cleanup 100 records,
thread rooms 100 with 2 KiB of client fields, private rooms 200 and 50
memberships per user, reactions 64 users per message
and 16 emoji per user, and credentials/challenges 16 KiB. The ceilings for
open sockets, identities, limiter records, processed frames, global posts,
registrations, SQL and database watermarks are the selected plan's defaults.
Operators may lower these values but cannot raise them without changing the
implementation and recalibrating its resource model.

| Variable | Meaning |
| --- | --- |
| `RP_ID` | Explicit passkey relying-party hostname: the server's host or a domain it is under (clients check this); local default `localhost`. On the host that is `RP_ID`, the Worker answers `GET /.well-known/webauthn` with `{"origins": RP_ORIGINS}`; with a parent-domain `RP_ID`, or a Worker not on its host, nothing serves that file, so serve it there yourself |
| `RP_ORIGINS` | Comma-separated exact WebAuthn origins; defaults to `ALLOWED_ORIGINS` and must be a subset of it, but is required explicitly with wildcard guest admission; never accepts wildcards. An origin outside `RP_ID` (such as `https://web.apron.chat` with `RP_ID=apron.shazow.net`) is a [related origin](https://www.w3.org/TR/webauthn-3/#sctn-related-origins): browsers allow it only where `https://<RP_ID>/.well-known/webauthn` lists it, which the Worker serves when it is on `RP_ID`'s host; otherwise serve that file there yourself. Startup checks only that each origin is exact and in `ALLOWED_ORIGINS`, not that it sits under `RP_ID`, so a mistyped origin fails only in the browser, as a refused passkey. Browsers without related origins refuse passkeys on such a frontend, whose users then sign in another way ([guide](guide.md#passkeys-on-your-own-server)) |
| `ALLOWED_ORIGINS` | Exact browser-origin allowlist, or standalone `*` to admit every guest origin (including opaque/missing Origin); cannot mix `*` with explicit origins; all clients remain subject to quotas |
| `RP_NAME` | Bounded display name for browser passkey prompts, default `Apron Demo`; WebAuthn only, never the `server` frame's `title` |
| `ACTIVITY` | `true` advertises and relays typing (cap `activity`, section 4.2 of the spec); `false` turns it off. Unset, the plan decides: on for Workers Paid, off for Free. An admin's `/toggle activity` overrides it until toggled back. With it, registered users' read cursors are kept too (`ext.settings.read_cursors`) |
| `PRESENCE` | `true` or `false`: whether others see each user's `status` (protocol §4.5); needs push. The status users choose with `me` and their mutes are taken whatever it says. Unset, the plan decides: on for both. An admin's `/toggle presence` overrides it until toggled back. See [User status](#user-status-presence) |
| `LIVE_TEXT` | `true` or `false`: whether live text (`embed:terminal`, `embed:append`) is on where it is configured (`PUBLIC_ORIGIN` and `UPLOAD_SIGNING_KEY`). Unset, the plan decides: on for Workers Paid, off for Free. An admin's `/toggle livetext` overrides it until toggled back. `LIVE_TEXT_<KEY>` variables set its limits within their ceilings (see [Live text](#live-text)) |
| `GUEST_POSTING` | `true` lets guests post, react, join and leave rooms, and create threads under the guest quotas; default off in both plans, so guests only list rooms and read history until they sign in with a passkey. Announced in each guest's own `you`: `ext.permissions` is `{"write": false}` while guests only read (extension `ext:permissions`) |
| `SERVER_TITLE` | The `server` frame's `title` (protocol §3.1), a one-line plain name within the display-name policy (80 code points); unset or empty, left out, and clients show the server's address. The public demo sets it in `wrangler.production.toml`. An admin's `/server title` overrides it (see [Server title, description and avatar](#server-title-description-and-avatar)) |
| `SERVER_DESCRIPTION` | The `server` frame's `description`, a few words of CommonMark (at most 500 bytes) saying what the server is about; unset or empty, `general`'s description where it fits, else left out. The public demo sets it in `wrangler.production.toml`. An admin's `/server description` overrides it |
| `SERVER_AVATAR` | The `server` frame's `avatar`, the server's square icon: an `https:` URL, or a small `data:image/{png,jpeg,gif,webp};base64,` URL (at most 8 KiB); unset or empty, left out. The public demo sets it in `wrangler.production.toml`, to apron-web's icon. An admin's `/server avatar` overrides it |
| `APRON_ADMIN_TOKEN` | Optional secret, unset by default: 24 to 256 of `A-Z a-z 0-9 - _`, not starting `apron_bot_`, `apron_invite_`, `apron_join_`, or `apron_device_`. `auth` with `scheme: "token"` and this token signs in as the registered user `admin`, who is always an admin, from any origin and without a passkey ([SPEC section 5, Admins](../SPEC.md#admins)). Anyone holding it can act as the admin, so never put it in a Wrangler var or source: `npx wrangler secret put APRON_ADMIN_TOKEN --config wrangler.production.toml`. Delete the secret (`npx wrangler secret delete …`) to turn it off; the `admin` user never holds a passkey. A malformed value makes every request fail its configuration check. Locally, use `npx wrangler dev --var APRON_ADMIN_TOKEN:…` or `.dev.vars` |
| `MEDIA_ORIGIN` | Exact https origin where the upload bucket serves objects, such as `https://media.apron.chat`; with `PUBLIC_ORIGIN`, `UPLOAD_SIGNING_KEY` and the `MEDIA` binding, turns uploads on for a plan that has them. Announced as `ext.media.origins` (extension `ext:media`) when it is not `PUBLIC_ORIGIN` |
| `PUBLIC_ORIGIN` | This Worker's exact public origin, which `write_url`s and live text `url`s point at; with `UPLOAD_SIGNING_KEY`, configures live text |
| `UPLOAD_SIGNING_KEY` | Secret of at least 32 characters that signs `write_url`s, of uploads and of live text; set with `npx wrangler secret put UPLOAD_SIGNING_KEY --config wrangler.production.toml` |
| `VAPID_PUBLIC_KEY` | Uncompressed P-256 public key, unpadded base64url (`node scripts/vapid-keys.mjs`); with `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`, turns push on and is advertised as `server.push.webpush.key` |
| `VAPID_PRIVATE_KEY` | Secret: the matching 32-byte private key, unpadded base64url; set with `npx wrangler secret put VAPID_PRIVATE_KEY --config wrangler.production.toml` |
| `VAPID_SUBJECT` | `mailto:` address or `https:` URL sent to push services in each VAPID token as the operator's contact |
| `PUSH_HOSTS` | Comma-separated push service hosts registrations may name, `*.host` for a host's subdomains, or a standalone `*` for any public host; unset, the browsers' own services (see [Push](#push)) |
| `OG_MEDIA_HOSTS` | Comma-separated hosts whose `og` media (`image`, `video`, `audio`) a link embed keeps, `*.host` for a host's subdomains, a standalone `*` for any host, or empty for none; unset, big platforms' image CDNs (see [Link preview media](#link-preview-media)) |
| `PUSH_DELAY_SECONDS` | Whole seconds, 0 to 60, a message's wake waits before it pushes; unset, the plan's `push.delaySeconds`; `0` pushes at once |
| `ACCOUNT_ID` | The Cloudflare account whose analytics the account-usage stop and the budget guard read; a Wrangler var (see [Editing the deployment budget](#editing-the-deployment-budget)) |
| `ACCOUNT_ANALYTICS_TOKEN` | Secret: a read-only account analytics token; with `ACCOUNT_ID`, turns the account-usage stop on |
| `ZONE_ID` | The zone holding `apron_budget_stop`; a Wrangler var (see [Budget guard](#budget-guard)) |
| `EDGE_STOP_TOKEN` | Secret: an API token with Zone WAF edit permission on `ZONE_ID`, which the budget guard and the flood trip use |
| `ADMISSION_OFF` | `true` or `false`: operator admission switch; `true` rejects new sockets in the entry Worker with 503 before the limiter or DO call; existing sockets remain subject to DO budgets |
| `ENVIRONMENT` | Set to `development` to enable local origin defaults when `ALLOWED_ORIGINS` and `RP_ORIGINS` are omitted |
| `NODE_ENV` | Set to `test` to enable the same local origin defaults for tests; production-like deployments must configure origins explicitly |

### Server tiers

The server refuses work in tiers, each scoped and timed by what fires it,
and each lifting by itself (`src/store.ts`, `ApronDemoServer.currentTier`):

| Tier | Fires on | Does | Lifts |
| --- | --- | --- | --- |
| open | | Everything works | |
| degraded | Today's foreground SQL reads or writes, or frames, at `DEGRADE_SHARE` (70%) of their ceiling | Live text, uploads and older history (`history` with `before`) get `retry_after` (`data.reason` `degraded`); chat works | UTC midnight |
| exhausted | One of those at 99% (`EXHAUSTED_SHARE`; the ledger refuses work just short of 100%) | New work is refused with `retry_after` until the reset; open connections stay; admins' frames and `/status` still answer | UTC midnight |
| account stop | The estimated overage past `BILL_CAP_DAY` ($5) today or `BILL_CAP_MONTH` ($25) this month (the account-usage stop; on Free, 90% of a daily allowance) | 503 and sockets closed once, as it starts | The day's or month's end |
| paused (attack) | The attack pause (below): traffic burning $1 an hour or more and mostly refused, or breakers open on three actions | Everything refused with 503, every socket closed (admins' too), and the edge stop turned on for the hold | When the hold ends: 30 minutes, doubling with each pause that UTC day |

Every change of tier is announced to the admins (see the admin alert above),
going up and coming down, with why. It is evaluated at most once a minute on
frames and alarms, and at once after an overrun or a fresh usage reading, so
a change while nobody is connected is told at the next event. The edge stop
(budget guard) sits past these and is announced on and off by the guard.

**Attack pause.** The object prices recent traffic in *shadow dollars*:
each billed event at its overage rate, as if every inclusion were spent
(`src/burn.ts`). It counts its own fetches (each an entry Worker request
and an object request), WebSocket messages (a twentieth of a request),
alarms and RPCs, plus the requests the entry Worker answers without it
(refusals by the attempt limiters, media, assets), which each isolate
samples one in 100 and reports at most once a second (`noteEntrySamples`).
Each event's sampled log is priced too; SQL rows and duration are left
out, since the app's ceilings bound them. Over a rolling 10 minutes:

- $1 an hour or more over the last 2 minutes, with 80% or more of the
  requests refused, is a flood: the server pauses.
- $1 an hour or more over the 10 minutes, with half or more refused, is
  sustained abuse: the server pauses.
- $1 an hour or more mostly admitted is a busy day, not an attack: the
  admins are told (at most once an hour, `burn` metric) and the server
  stays open; the bill cap bounds what it costs.
- Breakers open on three actions at once (one of them new since the last
  such pause) mean something systematic: the server pauses.

For scale, a deploy's reconnect wave or a front-page peak (2,300 sockets,
a few thousand frames a minute) burns a few cents an hour; $1 an hour is
about 30,000 refused requests a minute. The pause closes every
connection, refuses every request with 503 and a `Retry-After` of the
hold, and turns on the edge stop with the hold written into the rule's
description (`[attack hold until …]`), which the budget guard honours
before it lifts the rule. The first pause in a UTC day holds 30 minutes,
and each later one twice as long as the one before, at most a day. It is
logged (`attack_paused`), counted (`attack` metric) and announced as the
`paused` tier; a wake stays paused. The meter itself is in memory, so it
starts empty after a wake.

**Storage overruns.** Every operation reserves the SQL rows it may read and
write before it runs. One that uses more is an *overrun*: a wrong estimate,
not a cost emergency. It is observed: the operation finishes, its excess is
charged to the day's budget (so the ceilings above stay true), and it is
logged (`accounting_overrun`) and counted (`accounting` metric) under the
operation's name with the user and address it acted for. The day's first
overrun is announced to the admins. Three overruns of one foreground
operation within an hour, or one past a hundredth of a day's SQL ceilings
(an estimate that wrong may be unbounded), open its *breaker*: that one
operation gets `retry_after` (`data.reason` `operation_paused`) for an hour
(`BREAKER_MS`), announced as it opens and closes; everything else works.
An operation is named by the Store method that made its reservation.
Maintenance work, operator alerts, admin commands and the operations every
request passes through (frames, admission, room lookup) are never refused
by a breaker; their overruns are still charged, logged and told. Nor are
the operations people cannot use the server without (`BREAKER_ALERT_ONLY`:
signing in and registering, the room list and members, and history): their
overruns are told to the admins at most once an hour each instead, so a
wrong estimate there is fixed rather than locking everyone out. Breakers
survive a wake, and `/status` lists them.

**Throttle trips.** A refusal that lasts five minutes or more
(`LONG_THROTTLE_SECONDS`: the tiers above, daily limits, an open breaker)
is a *trip*. The user is told once an hour per connection and trigger, in
a `~private` message saying what happened, until when, and a code and time
to report to an admin. It is then logged (`throttle_tripped`, with the
trigger, method and user), written to the `throttle` metric for later
analysis, and counted in `/status` ("Throttles tripped in the last 24
hours", by trigger). A trigger is the refusal's `data.reason`, else its
message as a slug (`daily_posting_limit_reached`). A connection refused at
admission for as long is counted once an hour per address, with no
message. Repeats within the hour are refused as usual, uncounted.

Earlier versions closed the server for good on any overrun until an operator
deployed a new `ACCOUNTING_RECOVERY`; that variable is no longer read, and a
stop such a version left is cleared on the next wake
(`accounting_unsafe_retired`). A storage failure (`Server storage is
unavailable; try again shortly`) still refuses work until storage works again
and clears itself (`accounting_uncertain_recovered`).

Numeric values are positive safe integer counts. Values named `Bytes` count
UTF-8 bytes, `CodePoints` count Unicode code points, and values named `Seconds`
are durations. `Limit`, `Embeds`, `Connections`, `Records`, and `Identities`
are item/count caps. `Bytes` on storage watermarks means effective occupied
SQLite bytes. Posting, history, authentication, frame, and admission `Minute`
limits are token buckets (`src/limiter.ts`): a principal may spend a burst at
once (a minute's worth, or `historyBurstPer*` for history) and then the rate
a minute, and a refused request learns its exact wait. `Day` limits use the
server's effective monotonic time and UTC calendar date; a backward
wall-clock jump cannot reset them. Cleanup and deduplication run in bounded
batches/records, while `foreground*` and `maintenance*` are daily SQL
operation budgets.

`threadLimit` counts thread rooms (rooms with a `parent_room_id`) and the
top-level rooms admins and mods create (at most 16 of them);
`threadsPerUser` (at most `threadLimit`) caps the live threads one
registered user has created, so one account cannot take every slot.
`privateRoomLimit` (at most 200) counts private rooms apart from the
threads; `privateRoomsPerUser` caps the live private rooms one registered
user has started, and `privateMembershipsPerUser` (at most 50, and at least
`privateRoomsPerUser`) the private rooms one user is in, theirs and those
others added them to, which `ext.settings.private_rooms` advertises.
`threadMetadataBytes` bounds a room's serialized client fields (`title`,
`description`, `ext`). A user's `ext` is at most 512 bytes serialized
(`MAX_USER_EXT_BYTES` in `src/store.ts`, not configurable: every connection
of the user carries it in its attachment). The `anonymous*` variables
configure the guest tier (the `guest` auth scheme).

Guests are numbered `guest_1`, `guest_2`, … from a server-wide counter. The
object reserves `guestNumberBlock` numbers at a time with one durable write
(about four written rows with the reservation's bookkeeping), then hands them
out from memory. A restart, eviction, or hibernation wake forgets the
in-memory block, so the unused numbers are skipped; numbers are never
reissued. The default of 10 favours a meaningful count over saved writes:
this object sleeps between quiet visits, and each visit after a sleep burns
the rest of a block whatever its size, so a block of 1,000 would number
occasional visitors 1, 1001, 2001, … while saving at most about 1,600 written
rows a day (at most 400 blocks for the 4,000 guest admissions a day, against
about 60 rows each guest connection already writes). Raise it only for a
deployment that stays awake.

The numeric rows are grouped by their unit and enforcement scope:

- Durations: `retentionSeconds`, `cleanupSeconds`, `challengeTtlSeconds`,
  `sessionTtlSeconds` (a passkey session token's lifetime, renewed on each
  resume), `unauthenticatedTimeoutSeconds`, `dedupTtlSeconds`, and
  `statusCoalesceSeconds`, `offlineGraceSeconds`, `presenceAlarmSeconds` and
  `guestPresenceAlarmSeconds` (each at most 60, the last a multiple of the one
  before; see [User status](#user-status-presence)).
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
  `threadLimit`, `threadsPerUser`, `privateRoomLimit`, `privateRoomsPerUser`,
  `privateMembershipsPerUser`, `reactionUsersPerMessage`, `reactionEmojisPerUser`,
  `limiterRecordCap`, `frameLease`, `roomListMembers`, `guestNumberBlock`,
  `activityMaxTypingSeconds`, `pingSeconds` (advertised as `server.ping`), `pingTimeoutSeconds`,
  `unpingedTimeoutSeconds` (seconds; the ping timeout must be at least twice
  the interval, and the timeout for a connection that never pinged at least
  the ping timeout). `roomListMembers`
  is how many registered members each room lists in `members`, in `user_id`
  order, besides every connected member; each costs two indexed reads per
  listed room. A room with more says how many members it has in
  `member_count`. `guestNumberBlock` is how many guest numbers (`guest_<n>`) one
  durable write reserves; see above.
- Minute budgets: `historyRequestsPerUserMinute` and
  `historyRequestsPerIpMinute` (after bursts of `historyBurstPerUser` and
  `historyBurstPerIp`, which must drain within the hour cleanup keeps an idle
  limiter row), `anonymousPostsPerMinute`,
  `registeredPostsPerMinute`, `trustedPostsPerMinute`, `ipPostsPerMinute`, `globalPostsPerMinute`,
  `authAttemptsPerIpMinute`, `framesPerConnectionMinute`,
  `framesPerIpMinute`, `connectionAdmissionsPerIpMinute`,
  `globalFramesPerMinute` (server-wide, in memory),
  `roomListRequestsPerUserMinute` and `activityBroadcastsPerUserMinute` (per
  user across their connections).
- UTC-day budgets: `historyRequestsPerUserDay`, `historyRequestsPerIpDay`,
  `historyRequestsPerDay` (server-wide, on the day's budget row; past it,
  history waits for the reset and everything else goes on; a page a user's
  or IP's limits refuse is not counted), `anonymousPostsPerDay`, `registeredPostsPerDay`, `trustedPostsPerDay`,
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
| `sessionTtlSeconds` | 2592000 |  |
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
| `historyBurstPerUser` | 60 | 30 |
| `historyBurstPerIp` | 120 | 60 |
| `historyRequestsPerUserDay` | 3000 | 1000 |
| `historyRequestsPerIpDay` | 6000 | 2000 |
| `historyRequestsPerDay` | 40000 | 5000 |
| `concurrentHistoryPerConnection` | 1 |  |
| `anonymousPostsPerMinute` | 5 |  |
| `anonymousPostsPerDay` | 200 | 100 |
| `registeredPostsPerMinute` | 20 |  |
| `registeredPostsPerDay` | 1000 | 500 |
| `trustedPostsPerMinute` | 50 |  |
| `trustedPostsPerDay` | 4000 | 2000 |
| `ipPostsPerMinute` | 30 |  |
| `ipPostsPerDay` | 2000 | 1000 |
| `globalPostsPerMinute` | 120 | 60 |
| `globalPostsPerDay` | 10000 | 5000 |
| `registrationsPerIpDay` | 5 | 3 |
| `registrationsPerDay` | 300 | 100 |
| `registeredIdentityCount` | 10000 |  |
| `authAttemptsPerIpMinute` | 10 |  |
| `openConnections` | 100 |  |
| `anonymousConnectionsPerIp` | 6 | 2 |
| `registeredConnectionsPerUser` | 3 |  |
| `connectionsPerIp` | 10 |  |
| `connectionAdmissionsPerIpMinute` | 12 | 5 |
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
| `unpingedTimeoutSeconds` | 900 |  |
| `guestNumberBlock` | 10 |  |
| `statusCoalesceSeconds` | 60 |  |
| `offlineGraceSeconds` | 60 |  |
| `presenceAlarmSeconds` | 15 | 60 |
| `guestPresenceAlarmSeconds` | 60 |  |
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
| `threadsPerUser` | 25 |  |
| `threadMetadataBytes` | 2048 |  |
| `privateRoomLimit` | 100 |  |
| `privateRoomsPerUser` | 5 |  |
| `privateMembershipsPerUser` | 20 |  |
| `reactionUsersPerMessage` | 32 |  |
| `reactionEmojisPerUser` | 8 |  |
| `dedupTtlSeconds` | 86400 |  |
| `limiterRecordCap` | 10000 |  |
| `maxCredentialBytes` | 16384 |  |
| `maxChallengeBytes` | 16384 |  |
