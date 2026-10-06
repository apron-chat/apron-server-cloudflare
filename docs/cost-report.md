# Cloudflare Worker storage cost report

This report records local native SQLite measurements used for the storage
accounting review. It describes the current schema (schema 8: one server-wide
record log of room records, message snapshots, reaction sets, and
memberships; a `memberships` table of registered users' rooms, keyed by
room with an index by user; and the upload, push registration, user status
and room mute tables measured below) and the Workers test runtime; it does not claim a
deployed account billing rate or a free-plan capacity.

The figures were measured on 2026-09-26, and re-measured on 2026-10-05 with
user status (below) and again the same day for the current status design
(the status chosen with `me`, room mutes and the mute echo), and checked on
2026-10-06 for `status` as a request, statuses in every listing, and users'
`ext`, none of which changes a row count, with the repository's workerd
launcher:

```sh
devenv shell -- npm test -- \
  --run test/accounting.integration.test.ts --reporter=verbose
```

The test uses eleven separate Durable Objects through `runInDurableObject` and
constructs a `Store` over each object's native SQLite state with a fake clock.
The traffic tests start at a future UTC noon, cross three UTC posting days,
run cleanup a day and a half later, and evict/reinitialize one object to check
persisted limiter state.

## Reservation accounting

The reservations below gate work before it runs. The unused part of each
finished SQL reservation, measured from its cursors, is credited back in one
budget-row update, so the daily counters are charged about the rows actually
used plus one. A guest reconnect (admission, auth, one history page, room
listing) is charged about 61 writes, a post about 39, and an idle alarm run
about 14. The reservation sizes still matter: they decide whether an operation
is admitted near the ceiling.

`reserveCost` adds eight read and eight write rows for its bounded control
work. The first reservation after a wake or UTC-day handover also carries an
eight-row handover allowance. Only a `message` mutation naming a `message_id`
(an edit, which may be a move) has the conservative 256-write mutation floor;
creates, reactions, rooms and renames, measured at most 37 writes, have a
96-write floor. Request-ID mutations also do a pre-duplicate lookup of
`8 + 4 × maxEmbeds` reads (24 at the default four embeds) and 8 writes, which
reserves 32/16 after control overhead: a replay's result reflects the current
state, so it reads each upload embed's write state (§1.2). So a steady-state request-ID
create reserves 120 writes and a request-ID edit 280 (104 and 264 without a
request ID). History pages reserve a 32-write floor. A cleanup run has a
bounded due-check reservation (18 reads for its nine indexed existence
probes, one of them the purge list and two for push registrations and wake
times) plus a 1,032/1,032 batch reservation.

The table below includes the reservation SQL in the observed cursor counts.
Every operation in the runtime reservation matrix is listed so the claimed
upper bounds can be compared with the measured worst case.

| Operation | Observed reads | Observed writes | Reserved reads | Reserved writes |
| --- | ---: | ---: | ---: | ---: |
| Auth attempt reservation | 11 | 9 | 48 | 32 |
| History quota reservation | 16 | 16 | 72 | 24 |
| Frame reservation (one frame) | 16 | 16 | 28 | 24 |
| Frame block (10 frames) | 12 | 11 | 64 | 24 |
| Guest number block | 4 | 4 | 16 | 16 |
| Connection admission reservation | 17 | 16 | 72 | 40 |
| Identity registration (starts in `general`, logs that membership) | 30 | 32 | 338 | 880 |
| Identity registration starting in 100 rooms | 229 | 824 | 338 | 880 |
| Credential lookup | 4 | 2 | 16 | 8 |
| Identity lookup (with the user's rooms) | 8 | 2 | 434 | 8 |
| Identity count | 4 | 2 | 16 | 8 |
| Credential IDs lookup | 5 | 2 | 40 | 8 |
| Credential counter update | 5 | 3 | 16 | 16 |
| Push subscription register | 9 | 8 | 172 | 370 |
| Push subscription register again, unchanged within a day | 6 | 2 | 172 | 370 |
| Push wake claim (one user, one subscription; creates the server and recipient counters) | 23 | 19 | 94 | 160 |
| Push wake claim, 31 unregistered candidates before one registered | 77 | 9 | 1,024 | 160 |
| Push sender charge (delivered pushes; creates the sender counter) | 10 | 9 | 24 | 24 |
| Push registrations clear (`/passkeys remove`, a new bot token) | 3 | 3 | 144 | 400 |
| Mute set (`status` `mute`, unscoped) | 6 | 4 | 24 | 24 |
| Status set (`me` `status`) | 7 | 3 | 24 | 24 |
| Room mute set (`status` `mute` with `room_id`) | 7 | 4 | 432 | 424 |
| Room mute set past 100, refused (two counts and a delete of none ran out) | 306 | 3 | 432 | 424 |
| Room mute clear | 6 | 3 | 432 | 424 |
| Room mute expiry, 50 of 100 ran out (read, delete) | 204 | 52 | 224 | 416 |
| Status inputs at sign-in, nothing stored | 6 | 2 | 224 | 8 |
| Status inputs at sign-in, a status, a mute and one room mute | 6 | 2 | 224 | 8 |
| Status inputs at sign-in, 100 room mutes | 105 | 2 | 224 | 8 |
| Push wake claim, `dnd` and muted (passed over) | 5 | 2 | 94 | 160 |
| Push wake claim, the thread's parent muted (passed over) | 10 | 2 | 94 | 160 |
| Gone push subscription forget (one primary-key row) | 4 | 3 | 20 | 22 |
| Push reply author lookup | 5 | 2 | 16 | 8 |
| Push wake claim for a reply (creates the recipient counter) | 15 | 9 | 94 | 160 |
| Message create with request ID | 33 | 37 | 296 | 120 |
| Empty new message (not logged) | 4 | 2 | 16 | 8 |
| Deduplicated mutation retry | 5 | 2 | 32 | 16 |
| Reaction set | 27 | 27 | 296 | 120 |
| Thread room create by a registered user (stores and logs the membership) | 28 | 35 | 296 | 120 |
| Thread room save | 21 | 19 | 296 | 120 |
| Message move with one reaction set | 27 | 32 | 296 | 280 |
| Registered name mutation | 23 | 19 | 296 | 120 |
| Registered room leave (logs the membership) | 24 | 20 | 482 | 72 |
| Registered room join (logs the membership) | 23 | 17 | 482 | 72 |
| Registered room join at the 100-thread ceiling | 332 | 32 | 482 | 72 |
| History page | 12 | 2 | 264 | 40 |
| Room record lookup (`general`) | 5 | 2 | 24 | 8 |
| Room join lookup | 5 | 2 | 24 | 8 |
| Room listing (representative matrix) | 8 | 2 | 444 | 8 |
| Room members, `general` and one thread | 8 | 2 | 824 | 8 |
| Room members with status, `general` and one thread | 8 | 2 | 1,224 | 8 |
| Room members, 101 rooms with 200 registered members each | 40,403 | 2 | 40,820 | 8 |
| Room members with status, 101 rooms of 200, each member with a status row and the most push registrations and room mutes a user may hold (neither read) | 60,502 | 2 | 61,020 | 8 |
| Admission snapshot | 6 | 2 | 40 | 24 |
| Cleanup (matrix, one day later) | 105 | 38 | 1,074 | 1,058 |
| Alarm scheduling | 8 | 4 | 24 | 12 |

The matrix uses a fresh object and one representative operation for each
boundary; every operation stayed within its reservation. The room-listing test
separately populated the 100-thread policy ceiling, each thread with a
description; listing all 101 rooms measured 207/2 against its 452/16
reservation, which is derived from that ceiling (`32 + 4 * 101` rows plus
reservation control); a room's `description` is in its own row. A 180-record fixture mixing room, message, and
reaction records returned a 50-record forward page (`more: true`,
`first_log_id`/`last_log_id` spanning all kinds) at 61/6 against its 272/48
reservation. The maximum snapshot test used a 4,096-byte text body plus an
`ext` field and produced an 8,154-byte serialized snapshot. Its maximum
observed accepted mutation was 34/37, below the 304/128 request-ID create
reservation of the first operation after a handover.

The worst move was measured at the calibrated reaction ceilings rather than
the defaults: 64 reacting users, each with 16 distinct 64-byte emoji and a
320-byte name. Each reaction set measured at most 93/32. Moving the message
re-logged all 64 sets in one 92,693-byte reaction record and measured 216/158
against its 296/280 reservation; the record still fit one history response.
The per-message cap is what bounds this move: without it, the re-logged set
count would be limited only by posting quotas.

Memberships:

- A registered user's join or leave is one reservation that counts as a post.
  It stores or removes the membership row, appends one membership record, and
  advances the room's head, within the 64-write floor. The room's
  `member_count` changes in that same head update, so it writes no extra row
  (the matrix's join and leave measured the same before it). The record goes
  in `room_update` `memberships`, together with the user's own `joined` or
  `left`, in one frame per connection of the joining or leaving user. Adding or
  removing another user (`room_join`/`room_leave` with `user_id`, `/kick`)
  is the same operation, charged to the one who asked. The read floor covers
  the user's rooms, read by the user index and joined to `rooms`
  (`8 + 2 × (101 + 100)` rows for live rooms and removed rooms awaiting
  purge). A join or leave that changes nothing writes nothing.
- A registration logs a membership in each starting room (at most the 101
  rooms), so its write floor is `64 + 8 × 101`. Registrations are capped at
  100 a day; the credit-back returns the unused part.
- A guest's joins and leaves live in its connection and are not logged; a
  join reads the room record (24/8) and its members (below).
- `members` (`room_list` with `members: true`, and `room_update` `joined`)
  read each listed room's registered members by primary-key range with one
  identity lookup each, at most `roomListMembers` (200 with the Workers Paid
  budgets, 100 with the Free ones) per room: the reservation is
  `8 + rooms × (4 + 2 × roomListMembers)` reads, and
  `8 + rooms × (4 + 3 × roomListMembers)` with user status
  ([below](#user-status)). Connected members come from
  connection attachments. A user in `general` and a few threads reads about
  two rows per registered member of those rooms; the worst case, a listing of
  all 101 rooms each at the cap, measured 40,403 reads at 200, which the
  25,000,000 foreground reads a day allow about 600 times (about 20,200 at
  Free's 100, about 120 times its 2,500,000). A room whose page of
  registered members is full also reads its `member_count` (one row, within
  the per-room slack), so the listing can say how many it left out.
- Adding a passkey while signed in (§4.10) is one reservation of 96 reads
  and 48 writes, charged as a registration: the identity and credential
  lookups, a count of the account's passkeys (at most 8), the credential row
  with its indexes, and the registration limiter rows. The per-IP (5, Free 3)
  and daily registration caps bound it like new registrations.
- A sign-up with an `/invite` token is an `/invite-token` registration, plus
  up to 8 `user_id` availability probes (8 reads each, reserved), the new
  user's `getIdentity` read, and one KV read and three KV writes (the
  invite's count and the new user's own token and pointer, in one put),
  reserved at their bound before the account is created. `/invite` itself is
  one KV read and three writes, and `/invite-token` two KV writes, each at
  its bound.
- `/passkeys` reads at most 8 credential rows; `/passkeys remove` adds one
  delete with its index. Adding a passkey to an account without a WebAuthn
  user handle writes it at `begin` (one conditional row update).
- `roles` in current user objects, and the admin and bot checks, cost no
  reads: roles are a column of the identity row, read at sign-in (and kept
  on the connection) and in member listings with the name. `/role` and
  `/admin` read and update the one row.
- A user's `ext` (capability `ext`) is a column of the same identity row,
  `ext_json`, so complete user objects carry it at no extra read: `you` from
  the connection's attachment, where sign-in keeps it, and listing `users`
  from the member row already read for the name. A `me` that changes it
  writes the one row, inside the `me` mutation's reservation like a name
  change, and nothing when no key changes. The costs are bytes, not rows: up
  to 512 more per identity row, per connection attachment, per cached
  member row, and per user in a listing's `users`, which stays under the
  256 KiB listing cap as before (past it, `members` and `users` are left
  out).
- History pages read membership records from the same room range as every
  other record, and look up no user objects.
- Cleanup purges a removed thread's membership rows in the same bounded
  batch, after its other deletions. The full-batch test also purges one
  membership per removed room within the 1,032/1,032 batch reservation.
- `room_list` ignores `latest_log_id`, so a reconnect's listing is always a
  full joined listing.
- `~private` throttle notices and `/help` replies carry no `log_id`, so they
  need no SQL.

For the three-day traffic sample, the operation rows were:

| Operation | Observed reads/writes | Reserved reads/writes |
| --- | ---: | ---: |
| Day 0 create | 34 / 37 | 304 / 128 |
| Day 1 create | 27 / 23 | 312 / 136 |
| Day 2 edit of older message | 29 / 22 | 312 / 296 |
| Day 2 create | 21 / 22 | 296 / 120 |
| Cleanup | 61 / 18 | 1,070 / 1,058 |
| History after cleanup | 8 / 2 | 264 / 40 |

The native SQLite file reported `databaseSize = 167,936` bytes. These values
are a small schema/data sample and are not a per-message capacity estimate.

## Guest numbers

Measured on 2026-09-26 with the operation matrix above and
[`test/guest-numbers.integration.test.ts`](../test/guest-numbers.integration.test.ts).
Guests are numbered `guest_<n>` from a counter reserved in blocks of
`guestNumberBlock` (10): one reservation advances the stored high-water mark
(a `_meta` row; no schema change) and the object serves the block from
memory. Guest auth still stores no identity row.

| Operation | Observed reads | Observed writes | Reserved reads | Reserved writes |
| --- | ---: | ---: | ---: | ---: |
| Guest number block (steady state) | 4 | 4 | 16 | 16 |
| Guest number block (first reservation after a wake) | 6 | 6 | 24 | 24 |
| Guest number served from the block | 0 | 0 | 0 | 0 |

- The written rows are the mark and the reservation's own bookkeeping (the
  budget-row update and credit-back, and the effective clock when it
  advances); the first reservation after a wake also loads the day's budget
  row under the handover allowance. The reservation is foreground work and
  counts no frame or post.
- Every start, eviction, or hibernation wake that authenticates a guest
  reserves a fresh block, since the in-memory block is lost; the unused numbers
  are skipped. The cost is therefore about four rows per block of guests or
  per waking visit, whichever is more: at most about 800 rows a day at the
  Free plan's 2,000 guest admissions a day (1,600 at Paid's 4,000), against about 61 charged writes for each guest
  reconnect (admission, auth, history, listing).
- A schema reset reads the mark before the wipe and writes it back afterwards,
  one uncharged control row like the carried budget row, so guest IDs are
  never reissued.

## Frame blocks, activity, and throttle notices

With the operation matrix above, a single-frame
reservation reserves 28 reads and 24 writes. Connections now reserve frames in
blocks of 10 for 64 reads and 24 writes, so each frame's own bookkeeping is 2.4
reserved writes instead of 24. The 60,000-row foreground write ceiling
therefore covers about 25,000 frames a day on their own, up from 2,500. A
connection that sends one frame and closes still pays a whole block, which is
what a single frame cost before.

Blocks change what frames without SQL work of their own cost (`room_join`
lookups aside, notifications, rejected frames). A post is one frame plus its
mutation, which is charged about 39 writes after the credit-back.

`activity` is off by default (`ACTIVITY=true` enables it). When it is on, the
web client sends a typing update when typing starts, every 12 seconds while it
continues, and when typing pauses: about 5 frames, or 12 reserved writes, per
typing minute. Read-cursor updates, which the demo drops, cost the same per
frame. The per-user relay limit (10 a minute) and the frame limits (60 per
connection and 120 per IP a minute) bound a single sender.

A throttled sender's `~private` notice is sent to that connection only, at
most once per user per minute, and needs no SQL. `room_list` reuses the
room-listing reservation (444 reads, 8 writes) and adds no writes; with
`members: true` it also reads each listed room's registered members (see
Memberships above), and its connected members come from connection
attachments.

The liveness ping (`{"method":"ping"}` every `server.ping` = 45 seconds, from
clients that support it) is answered by `setWebSocketAutoResponse`: it never
wakes the object or reaches `webSocketMessage`, so it uses no duration, frame
budget, or SQL. A ping with other spacing is an ordinary frame. Incoming
WebSocket messages count as Durable Object requests at 20:1, so 100 connections
that ping all day add about 9,600 requests (under 10% of Free's 100,000 daily
allowance, and 30% of Paid's 32,000 daily share). Pings are not rate limited by
the demo; a client flooding them can spend that allowance, which the
account-usage stop bounds, and on Free also the platform's own limits.

The Free plan's foreground write ceiling is 60,000 rows per UTC day. Charged
at about 39 writes each, that is roughly 1,500 posts a day before other
foreground operations consume the same daily budget (the Paid plan's 700,000
leaves the 10,000-post ceiling reachable); near the ceiling a post
is admitted only while its full reservation (120 writes with a request ID, 280
for an edit) still fits. The 96- and 256-row mutation floors are the
configured conservative upper bounds for the posting and editing paths and
their indexed control rows; the measured maximum accepted mutation is much
smaller, so lowering a floor requires a separate proof for every allowed
mutation shape and its control rows.

Rejected work is charged when it reaches a reservation boundary. Depending on
which bounded admission check rejects a request, a post-limit failure may have
paid either the request-ID lookup or the full mutation reservation; both paths
remain within the measured bound. The explicit 1,000/1,000 foreground test
ceiling accepts a bounded pool of requests, then drains the remaining
request-ID lookup allowance. Once that pool is exhausted, repeated denials
perform no additional Store SQL. This covers the fail-closed repeated-denial
path without assuming a fixed mutation cost.

The maximum-snapshot test accepted five operations before midnight, rejected
the sixth in that minute, then accepted a five-operation burst after midnight
and two groups of four edits separated by a minute. The resulting current-day
limiter count was 13, demonstrating that the UTC reset and the two bursts are
independent.

## Push

With Web Push on (protocol §4.9), `push_register` is one frame plus the
registration above: about 7 writes the first time (the row and its two
indexes), and 2 for the reservation alone when a client registers the same
subscription (keys and `push_id`) on its next connection within a day, which
writes nothing; `registersPerUserMinute` (10) bounds the rest. These were
measured with a 64-character `push_id`, the longest allowed; it changes row
bytes, not row counts. The reservation is sized for evicting a user's whole
index range under any valid policy (64 registrations), which the credit-back
returns.

Choosing whom a new message wakes reads connection attachments, plus one
indexed read of the replied-to message's current state when the message is
a reply (5/2 with its reservation). Registrations carry their wake scopes
in the same row, so filtering by scope costs no extra rows. The wake claim then looks up the candidates in turn, at most 32: each costs
one read of its mute, and an unregistered one about one more of its live
index range, and a registered one also
reads its wake time for the room and its recipient counter, and the
sender's counter once. A message that wakes someone writes each woken user's
wake time and recipient counter, and the server's counter: 19 writes for the
day's first wake (counter rows created), about 9 after. The sender's counter
is written after delivery, once per message with delivered pushes (9 writes
the first time a day, fewer after). A message whose candidates have no live
registrations, or are all coalesced, writes nothing; one that mentions no
one idle or gone does no push SQL. The reservation covers 32 candidates at
5 registrations each (888 reads) and `wakesPerMessage` wake rows and
recipient counters (160 writes), mostly credited back. A push service's
404, 410 or 403 costs one primary-key delete per gone registration,
whatever other accounts share the endpoint: deleting by endpoint alone
would read and write every account's row for it, which an attacker can
multiply by registering one endpoint from many accounts, and would overrun
the reservation and latch accounting unsafe. Many accounts sharing one
endpoint otherwise cost what as many separate registrations do: a wake
claims at most `wakesPerMessage` users of `subscriptionsPerUser` each.

A wake claim also passes over a candidate that a mute or a `dnd` status
silences (§4.9: such a push would go only to `badge` registrations, which
this server does not have). The unscoped mute and `dnd` are in the
`user_status` row the claim reads first (5/2 for a passed-over candidate
with the reservation). Room mutes are checked only for a candidate with
live registrations: two primary-key probes of `room_mutes`, for the
message's room and, for a thread, its parent, which is read once a message
(one row). So a claim that wakes someone reads two rows more than before
(23 against 21), and the reservation grows by 4 rows a candidate and 8
once (94 against 82; 1,024 against 888 for 32 candidates).

A `status` `mute` change is one upsert or delete of the user's
`user_status` row (6/4 with the reservation) or `room_mutes` row (7/4),
and a `me` `status` change one of the `user_status` row (7/3). Each is sent
to the user's connections as `status` or `user` from the same operation,
with no SQL. A room mute past the 100 a user may hold counts the user's
room mutes and deletes those that ran out (306/3 when none did); its
reservation covers deleting all 100 (432/424). A registered sign-in on a
push server reads the `user_status` row and one key range of the user's
room mutes (6/2 with none or one, 105/2 with 100) and keeps the status and
mute ends on the connection, so `me` results and later `you` objects read
nothing. `mutesPerUserMinute` (6) bounds mute and status changes together,
counted per user across reconnects, so flipping them cannot drain the write
budget: at most about 35 written rows a user a minute. An expired unscoped
mute is read as none and never written back; a room mute that runs out
while its user is connected is read and deleted once (Store.expireRoomMutes:
204/52 for 50 of 100), and one that runs out while they are away waits, at
most 100 a user, until they next mute a room at the cap. Room mutes number
at most 100 per registered user, about 60 bytes each.

A registration now also writes its entry in the partial index of waking
registrations (9/8 against 9/7), and the wake claim reads live waking
registrations through that index, so registrations that wake for nothing
are not read.

Cleanup deletes expired registrations (`pushExpiryDays`, 7) and wake times
past `coalesceSeconds` within its existing batch, by their time indexes.
Wake times number at most one per woken user and room a day, so at most
`pushesPerDay` rows.

The pushes themselves are outbound requests from the Durable Object: no
Worker or Durable Object request is billed for them, and the object is
awake for the post anyway. `pushesPerDay` (5,000 on Paid, 1,000 on Free)
bounds them; on Paid that is at most about 50,000 claim writes a day if
every push were its own wake, about 7% of the foreground write ceiling.

## User status

Measured on 2026-10-05 with
[`test/accounting.integration.test.ts`](../test/accounting.integration.test.ts)
("measures member listings with status by population", the operation matrix,
and the 101-room ceiling),
[`test/presence.integration.test.ts`](../test/presence.integration.test.ts)
and [`test/push.integration.test.ts`](../test/push.integration.test.ts), and
re-measured the same day for the current design ([SPEC section 4.4](../SPEC.md#44-push), Chosen status,
Mute and User status). Users choose a status with `me`; others see `online`
as online, idle or offline from the user's connections, `dnd` as dnd while
connected, `invisible` as offline, and `""` as `""`, the same on both
plans. Every current user object in a listing carries `status`, `offline`
and `""` included; with presence off it is `""` for everyone, read from
nothing.

**Listings.** A listing reads each listed registered member's chosen status
with them, by a primary-key probe of `user_status`, so a member without a
connection who chose `""` shows `""` rather than `offline`. A row that is
not there costs nothing: only members who chose something other than
`online` or are muted have one. Registrations and room mutes are not read.
One room of 200 registered members, by what the members have stored:

| Members (200 in one room) | Reads without status | Reads with status | Added per member |
| --- | ---: | ---: | ---: |
| none with a status row | 404 | 403 | 0 |
| each with two live waking registrations and a room mute | 403 | 403 | 0 |
| mixed: a tenth muted, one in 30 invisible, one in 50 `""` | 403 | 434 | 0.15 |
| worst: each with a status row (`dnd` and a mute) | 403 | 603 | 1.0 |
| reserved | 420 | 620 | |

The reservation per room grows from `4 + 2 × roomListMembers` to
`4 + 3 × roomListMembers`; all 101 rooms at the cap, every member with a
status row, read 60,502 rows against the 61,020 reserved (40,403 without
status).

**Reuse.** The store keeps each room's member rows, chosen statuses
included, in memory for `statusCoalesceSeconds` (60) and serves a listing
again with no SQL and no reservation (measured 0/0) until any write to
`identities`, `memberships` or `user_status`. A reconnect wave of 100 clients listing `general`
with 200 members reads it once instead of 100 times (about 40,000 rows
saved at two a member). It is lost on hibernation; the figures below assume
no reuse.

**Sign-in and changes.** A registered sign-in reads the `user_status` row
and one key range of the user's room mutes, in `room_id` order (6/2 with
none or one; 105/2 with the 100 a user may hold), and keeps the chosen status and the mute ends on the
connection; `me` reads nothing. The mutes in effect are sent after the
`auth` result from that read, and the statuses of connected users who
share a room from attachments: the test that resends them measures no SQL
statement at all. A `me` `status` change is 7/3, an unscoped mute 6/4, a
room mute 7/4. Deriving and announcing statuses reads connection
attachments only: the tests measure 0 rows read and written, and no
statement, for an `idle` change, a sweep, a closed connection's change after
its grace, and a status snapshot, and the alarm unchanged. A mute that runs
out is told from attachments for the unscoped one (0 rows, measured); a
room mute that runs out while its user is connected costs one key range of
their room mutes and a delete of those that ran out (204/52 for 50 of 100,
once). Fan-out is one `user` frame per connection that shares a room with
the user (about 2 ms of CPU for 100 sockets, from the budget prototype), at
most once a minute per user for changes the connections cause, and one
`status` frame per mute change to each of the user's connections; outgoing
frames are not billed. A connection that never sends `idle` is told of
changes too, and stays attended: idleness is never inferred, so no sweep
reads frame times for it.

**`status` as a request.** A client's `status` is a request: it is
answered `{}`, or with an error that changes nothing. A refusal costs no
more than the change it declines (`invalid_params` and `retry_after` past `mutesPerUserMinute` or the
idle limit run no statement; an unknown room at most the one bounded room
lookup; a room mute at the cap of 100 the same 306/3). The
reply is one outgoing frame, not billed. `status` before sign-in is
`denied`, so a sign-in applies no mutes kept on the connection: it writes
nothing for them. An `idle` change still reads attachments only (0
rows, measured, limited or not); a connection may go idle 12 times a minute
(IDLE_CHANGES_PER_CONNECTION_MINUTE; `idle: false` is never refused, and
each going idle needs one to repeat), counted in memory, so a client
flipping it cannot make the object re-derive its user's status at frame
rate.

**Room mute on Free.** Room mutes are on for both plans. Against Free's
allowances: a sign-in reads one row more (the empty range), under 0.1% of
the foreground reads at its 2,000 admissions; a claim reads two rows more
per candidate with registrations, bounded by `pushesPerDay` (1,000 on Free):
at most about 3,000 reads a day; a room mute change writes about 4 rows,
bounded with status changes by `mutesPerUserMinute` (6), the same bound the
unscoped mute and `invisible` had; storage is at most 100 rows a registered
user. None of it uses requests, the plan's scarcest allowance after SQL
writes, and the one timer covers mutes that run out. So it is not a plan
setting.

**Timers, requests, and duration.** A change waits for the coalescing
minute and, when a closed connection caused it, the 60-second grace; a mute
running out within a minute arms the same timer. The designs measured or
costed for announcing it on time:

| Design | Durable Object requests | SQL rows | Duration | Verdict |
| --- | --- | --- | --- | --- |
| One-shot in-memory `setTimeout` for the earliest due change or mute ending within a minute, armed only while a signed-in connection is open (chosen) | 0 (no alarm is set: measured) | 0 (measured), but for a room mute that ran out | keeps the object awake at most 60 s after its last event, against about 10 s before it would hibernate: at most 50 s × 0.125 GB = 6.25 GB-s per change that lands in a quiet period, 0.05% of either plan's daily duration | chosen |
| An alarm per due change | 1 per wake: 2% of Free's requests, 12.5% of Paid's at 4,000 a day | alarm scheduling (8/4) and an alarm run (about 14 written rows): about 36,000 maintenance writes a day at Free's 2,000 admissions, 180% of its 20,000 | about 1.25 GB-s per wake | rejected: Free fails closed |
| Announce only on the next event | 0 | 0 | 0 | rejected: in a quiet room a change waits for the next event, however long, so peers keep seeing "online" |

A mute that runs out more than a minute after the last event is told at the
first event after it (any frame, connection, close or alarm, each of which
sweeps), so an object that sleeps meanwhile tells it late; clients count the
seconds down themselves. Telling it on time would take an alarm per mute
end, the rejected design above.

Nothing waiting is lost when the object is evicted: what others were told
is on the user's connections (`pres`), and a change owed to others for a
user with no connection left is on each connection owed it (`owed`). The
first event after a wake sweeps the attachments and announces what is due
(tested by evicting the object with changes waiting). A pending timer also
keeps the object from hibernating, so it is lost only to an eviction.

**Daily budget.** Added by user status at the load models of the budget
analysis: R (realistic, 1,000 admissions a day) and K (the admission caps:
2,000 on Free, 4,000 on Paid), with 1.5 member listings per admission, 150
(Free) or 250 (Paid) listed registered members each, the mixed population
above (0.15 reads a member), and one last disconnect per admission. Shares
are of each plan's daily allowance (Paid: its monthly included usage over
31 days), and for SQL of the application's foreground ceiling.

| Added per day | Free, R / K | Paid, R / K |
| --- | --- | --- |
| Durable Object requests | 0% / 0% | 0% / 0% |
| Durable Object duration, if every session ends in an otherwise quiet minute | ≤ 3,125 GB-s (24%) / bound by the whole day | ≤ 6,250 GB-s (48%) / bound by the whole day |
| SQL rows read (foreground) | 1.4% / 2.7% (worst, every member with a status row: 9% / 18%); sign-ins +0.04% / +0.08% | 0.2% / 0.9% (worst: 1.5% / 6%) |
| SQL rows read (account) | under 0.1% / under 0.2% | under 0.05% / under 0.2% |
| SQL rows written (foreground) | about 3 per status change and 4 per mute: ≤ 0.9% / ≤ 3.4% | ≤ 0.15% / ≤ 0.6% |
| Frames | no incoming frame beyond what push already asked for; outgoing only: announcements, the statuses and mutes in effect after each sign-in, one `status` per mute change to the user's connections, and one `user` frame per user told of on `/toggle presence` off or on, none of which an allowance counts or SQL serves | same |

Free's listings read a little more than they would without status: the price of showing a user who chose none as `""`
while away, rather than revealing that they left. The worst case needs
every listed member to have chosen a status or muted; the reuse above cuts
it further at reconnect waves.

Duration has a hard bound whatever the design: one object awake all day is
10,800 GB-s, 83% of Free's 13,000 and 84% of Paid's daily 12,900 (334,800
GB-s in a 31-day month, under Paid's 400,000 included), so the timer cannot
run either plan over; it spends the one allowance that cannot run out
instead of requests and maintenance writes, which fail closed. The duration
rows assume the worst, that every last disconnect leaves the object
otherwise idle; sessions that end during others' activity add nothing, and
with no signed-in connection open no timer is armed at all.
`offlineGraceSeconds` and `statusCoalesceSeconds` trade staleness for
duration: at 30 seconds each the duration rows halve.

## Retention, maintenance, and persistent state

The three-day cleanup advanced the internal server-wide retention floor
(`history_floor` in SQLite) past three old records (the seeded `general` room
record and two creates), removed the unreferenced old current message, and kept
the edited message whose latest record was still inside the retention window. It also removed two expired accepted-request rows without changing
the room head.

The maintenance-reserve test accepted 35 mutations under an explicit
1,000/1,000 foreground ceiling, rejected the next mutation, then ran cleanup
the next UTC day. The previous day's foreground counter was 793 while the new
day's cleanup was charged 112 maintenance writes (269/112 observed) and
removed 36 records (the creates and the seeded room record), 35 messages, and
29 request rows. The current budget row must be read by day; calling `budget()` after midnight
correctly returns the new day's foreground counters rather than the exhausted
previous day.

After `evictDurableObject`, a fresh Store instance observed a bounded set of
schema, effective-clock, and budget-cache reads and zero schema writes. The persisted principal-limit rows retained the
original daily post count and the second mutation was rejected by that daily
limit. The SQLite file remained 147,456 bytes across eviction.

## Storage pressure and page reuse

The pressure integration uses a separate native SQLite calibration table with
8,192-byte payloads inserted in 64-row transactions. It reached
`132,177,920` occupied bytes (within 3 MiB of the 128 MiB hard target), and a
default Store mutation was rejected before growth. Deleting and reinserting
the same 15,168 rows three times produced the same occupied size each time,
without VACUUM.

The fixture then reduced occupied bytes to `93,749,248` (about 89.4 MiB),
evicted the object, and confirmed that the persisted pressure latch still
rejected growth above the 80 MiB low-water mark. After reducing the occupied
size to `81,371,136` (about 77.6 MiB) and evicting again, a new Store accepted
a mutation. The runtime's `databaseSize` excludes freelist pages, so these
are occupied-byte measurements from the supported API; they do not claim a
filesystem-file shrink or require VACUUM.

## Query plans

`EXPLAIN QUERY PLAN` returned these details in the native test runtime:

```text
history (one room's log, every record kind):
  SEARCH records USING INDEX sqlite_autoindex_records_1
    (room_id=? AND log_id>? AND log_id<?)
cleanup (server-wide prefix by commit time):
  SEARCH records USING COVERING INDEX records_retention_idx (commit_ms<?)
cleanup physical delete:
  SEARCH records USING INDEX records_log_idx (log_id<?)
message state expiry:
  SEARCH message_state USING INDEX message_state_latest_idx (latest_log_id<?)
reaction state expiry:
  SEARCH reaction_state USING INDEX reaction_state_log_idx (log_id<?)
move re-logging reactions:
  SEARCH reaction_state USING INDEX sqlite_autoindex_reaction_state_1 (message_id=?)
  USE TEMP B-TREE FOR ORDER BY
room listing:
  SCAN rooms
  USE TEMP B-TREE FOR ORDER BY
dedup expiry:
  SEARCH accepted_requests USING INDEX accepted_requests_expiry_idx (expires_ms<?)
limiter expiry:
  SEARCH principal_limits USING INDEX principal_limits_updated_idx (updated_ms<?)
room members:
  SEARCH m USING COVERING INDEX sqlite_autoindex_memberships_1 (room_id=?)
  SEARCH i USING INDEX sqlite_autoindex_identities_1 (user_id=?) LEFT-JOIN
room members with status:
  SEARCH m USING COVERING INDEX sqlite_autoindex_memberships_1 (room_id=?)
  SEARCH i USING INDEX sqlite_autoindex_identities_1 (user_id=?) LEFT-JOIN
  SEARCH s USING INDEX sqlite_autoindex_user_status_1 (user_id=?) LEFT-JOIN
a wake's room mute check (the room and its parent):
  SEARCH room_mutes USING INDEX sqlite_autoindex_room_mutes_1 (user_id=? AND room_id=?)
a sign-in's room mutes:
  SEARCH room_mutes USING INDEX sqlite_autoindex_room_mutes_1 (user_id=?)
a user's rooms:
  SEARCH m USING INDEX memberships_user_idx (user_id=?)
  SEARCH r USING INDEX sqlite_autoindex_rooms_1 (room_id=?)
  USE TEMP B-TREE FOR ORDER BY
```

History reads one contiguous primary-key range of one room's log; a move is
stored once in each room it touches, so no membership filter or `UNION` is
needed. The cleanup source selection explicitly uses `records_retention_idx`
for the strict commit-time cutoff, then `records_log_idx` for the bounded
physical delete. The move's reaction read and the room listing sort at most
the capped per-message reaction sets and the capped room table respectively;
the thread-room expiry check in cleanup scans that same capped table. Room
members are one primary-key range per room, already in `user_id` order, with a
primary-key identity lookup per member, and with status one primary-key
probe of `user_status`; a user's room mutes are one primary-key range, already
in `room_id` order, and a wake checks two of them by key; a user's rooms are
one index range, sorted after joining the capped rooms table.

## Schema upgrade and reset

A schema 7 object, which the deployed demo holds, is upgraded to schema 8 in
place, once, in one transaction (`test/schema-reset.integration.test.ts`): it
creates four empty tables, `push_subscriptions` (with indexes by user and
registration time, by registration time, and a partial one by user and
registration time of those that wake for messages), `push_wakes` (with an
index by wake time), `user_status` and `room_mutes`, four indexes besides
their primary keys, and adds the identities' empty `ext_json` column. The rows
it measurably read and wrote are added to the day's maintenance counters
without a capacity check, like the reset's passkey carry, so an exhausted
budget cannot block it. The object is not wiped.

Any other stored schema version resets the object with
`deleteAll()` and recreates the schema (`test/schema-reset.integration.test.ts`).
The reset is charged the same one-time 512/512 bootstrap reservation as a new
object, added to the carried-over current-day reservation row without a
capacity check. The passkey carry (at most `MAX_CARRIED_PASSKEYS`, 100) adds
the rows it measurably read and wrote to that row's maintenance counters:
finding the most recent passkeys reads every credential and its identity (at
most the 10,000-identity cap), and each carried passkey writes its identity,
credential and `general` membership rows with their indexes.

## Measurement limits

The native test runtime reports occupied SQLite bytes with freelist pages
excluded. The pressure test therefore verifies the supported occupied-byte
contract and page reuse; it does not claim a filesystem-file shrink or a
portable freelist counter. The measured row bounds also describe this schema
and runtime, not deployed billing or a guaranteed per-message capacity.

The native calibration in
[`test/native-storage.test.ts`](../test/native-storage.test.ts) measures basic
indexed insert/update/delete costs and page reuse. It does not read a
freelist count (`PRAGMA freelist_count` is unsupported by this runtime); this
report does not infer physical freelist behavior from `databaseSize` alone.

The executable coverage for this report is in
[`test/accounting.integration.test.ts`](../test/accounting.integration.test.ts)
and [`test/pressure.integration.test.ts`](../test/pressure.integration.test.ts).
