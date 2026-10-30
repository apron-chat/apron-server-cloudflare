# Cloudflare Worker storage cost report

This report records what the current storage schema costs in SQLite rows
read and written, and in bytes, measured on native SQLite in the Workers test
runtime. The schema is 11 (`SCHEMA_VERSION` in `src/store.ts`), last
measured on 2026-10-27; a section that names another date or test says so.
It does not claim a deployed account's billing rate, a per-message capacity,
or a free-plan capacity. How reservations, the daily ceilings and the plan
guarantee work is in
[SPEC section 7](../SPEC.md#7-budget-accounting-and-plan-guarantee), and the
budgets are in `src/plans/` ([configuration](configuration.md#plans)).
Production runs Workers Paid; Free figures are given where they differ.

Reproduce with the repository's workerd launcher:

```sh
devenv shell -- npm test -- \
  --run test/accounting.integration.test.ts --reporter=verbose
```

The test uses twelve separate Durable Objects through `runInDurableObject`
and constructs a `Store` over each object's native SQLite state with a fake
clock. The traffic tests start at a future UTC noon, cross three UTC posting
days, run cleanup a day and a half later, and evict/reinitialize one object
to check persisted limiter state. Figures not re-measured on the current
schema are marked as such and listed under
[Measurement limits](#measurement-limits).

## Schema and write cost

Each row SQLite writes is billed, and so is each index entry, so the indexes
a write touches decide most of its cost. The schema
([SPEC section 8, Schema versions](../SPEC.md#schema-versions); DDL in
`SCHEMA_DDL`, `src/store.ts`) keeps only the indexes a query needs:

- Every table keyed by text or by more than one column is `WITHOUT ROWID`,
  so its key is the table rather than a second index each insert writes.
- `records` has one index, `records_log_idx`: commit times follow log order,
  so retention walks it from the floor and stops at the first record inside
  the window, reading each candidate's row.
- `message_state` (which points at the latest record, so an edit rewrites no
  snapshot copy) and `reaction_state` have no index: cleanup deletes a
  message's state row with its latest record, and each reaction set with the
  record that logged it, by whole primary key. Each state delete reads and
  writes at most the row it removes and counts against the batch with its
  record: a move's record, which names every set of its message (up to 64),
  costs 65 of a batch's 100. Deleting a message's sets by key prefix instead
  would read every set it holds for each expiring record, which a popular
  message's history could take past the cleanup reservation
  (`test/history.integration.test.ts`, 100 records each naming 64 sets).
- `log_state` is written by retention and `/purge`, not by every commit.
- A user's push registrations are a primary-key range of at most
  `subscriptionsPerUser`, sorted after reading; besides its key
  `push_subscriptions` has an index by `updated_ms` (expiry) and the partial
  `push_subscriptions_joined_idx`.

A fresh object's SQLite file is 139,264 bytes.

## Operation costs

Observed rows, including the reservation SQL, for the common operations; the
[matrix](#reservation-accounting) has every other one (reaction set 20/14,
registration 28/18, room join 15/7, admission 14/10, cleanup 121/42, …):

| Operation | Reads / writes |
| --- | ---: |
| Post, its limiter rows held (the common case) | 9 / 9 |
| Post that writes its limiter rows (first after a wake, every fourth) | 11 / 14 † |
| A poster's first post (creates its limiter rows) | 28 / 23 † |
| Edit | 12 / 9 |
| Move of a message with 64 reaction sets | 209 / 83 |
| Guest reconnect from a new address (admission, auth, a frame block, one history page with its quota, a room listing) | about 35 written † |

† Last measured with schema 10, which wrote one more index entry for every
message write, so the two post figures may be a row high; the guest
reconnect touches no table schema 11 changed.

Under the maintenance-reserve test's 1,000-row foreground ceiling, 76 posts
fit (measured with schema 10).

### Read cursors

A registered user's `read_message_id` (§4.6) costs no SQL when it arrives,
unless a push counted up their `unread` since they were last back (one small
reservation to zero it, [below](#push)) or it passes the newest of held
wakes released together (one lookup): it is relayed to their other
connections and held on the connection's attachment. Each connection writes
what it holds at most once a minute (`READ_CURSOR_FLUSH_MS`, by its next
cursor or the next alarm) and when it closes, so a reader costs about one
written row a minute and a room they read, however often their client sends.
`read_cursors` holds at most one row a membership and has no index: a leave,
an expired room and `/purge` delete the row by its key, with the membership.
The costs are the read cursor rows of the [matrix](#reservation-accounting):
each written figure includes the day's budget row, and a cursor not past the
one kept is charged one row, as every statement is, though SQLite reports
none.

## Limiter rows and the budget row

Measured on 2026-10-24 with
[`test/quota.integration.test.ts`](../test/quota.integration.test.ts)
(`charges one written row a page…`) and a per-statement cursor log of one
history page and two posts. Totals that protect the deployment stay exact; a
principal's own limits may forget a few of its charges when the object is
evicted.

- Each limiter row keeps a token bucket (`level`, `level_ms`;
  `src/limiter.ts`).
- A user's or IP's row in a minute-limited scope (posts, history, auth,
  admissions, frames) is cached in memory (at most 256 rows) and written on
  its first charge since it was read or inserted, once a minute, on a new UTC
  day, and once it holds four charges unwritten (`LIMITER_UNWRITTEN_EVENTS`;
  a post or frame block counts its weight). Server-wide rows (`global`),
  registrations, uploads and pushes are written through. An eviction (Durable
  Objects hibernate seconds after their last event, sockets open or not)
  forgets at most three events of each row, and each wake that charges a row
  writes its first charge, so a daily cap of N admits at most N + 6 to a
  principal that runs to it between evictions, and never more than 4N
  (`src/limiter-cache.ts`).
- A reservation is staged on the cached budget row and written once, when
  the operation settles, with the effective clock (`effective_ms`). An
  eviction between the two loses at most the operation in flight.
- A limiter row's `updated_ms`, which cleanup finds idle rows by, moves only
  when the row is written, so its index entry is rewritten at most once a
  minute. Cleanup keeps rows touched within the last hour (`LIMITER_IDLE_MS`),
  and every limiter must drain within it.
- The server-wide daily history count is a column of the day's budget row. A
  request that serves no page (refused by the user's or IP's limits, or an
  unknown room) gives its count back in the same write.

| History page (once its limiter rows exist) | Observed writes | Charged writes |
| --- | ---: | ---: |
| Holding its limiter rows | 1 | 1 |
| Writing them (the first page after a wake, every fourth page, once a minute: both rows, with their index entries) | 5 | 5 |
| On average, one user paging every 1 to 10 s | 2 | 2 |
| On average, one user paging every 20 s | 2.3 | 2.3 |
| A wake and one page, every 15 s | 5 | 5 |
| Refused by the user's or IP's limit | 1 | 1 |

Writing the rows every fourth page bounds what an eviction forgets; a reader
paging every 20 s or slower is charged the minute's write either way.

A post writes its message rows, the server-wide post row and the budget row;
the poster's and the IP's rows are written with the first post after a wake,
every fourth, and a minute on. At Paid's daily per-IP history count (6,000
pages) one IP is charged about 12,000 written rows, under 2% of the 700,000
foreground writes; the server-wide count (40,000) bounds history at about
80,000 (11%) and 40,000 frames (27%).

## Reservation accounting

The reservations below gate work before it runs. The unused part of each
finished SQL reservation, measured from its cursors, is credited back in one
budget-row update, so the daily counters are charged about the rows actually
used plus one: a guest reconnect from a new address about 35 writes, a post
about 9 while its limiter rows wait (14 when they are written and 23 for a
poster's first, both schema 10 figures), and an idle alarm run about 14 (not
re-measured). The reservation sizes still decide whether an operation is
admitted near the ceiling.

`reserveCost` adds eight read and eight write rows for its bounded control
work. The first reservation after a wake or UTC-day handover also carries an
eight-row handover allowance. Only a `message` mutation naming a
`message_id` (an edit, which may be a move) has the conservative 256-write
mutation floor; creates, reactions, rooms and renames, measured at most 31
writes (the maximum-snapshot test, below), have a 96-write floor.
Request-ID mutations also do a pre-duplicate lookup of `8 + 4 × maxEmbeds`
reads (24 at the default four embeds) and 8 writes, which reserves 32/16
after control overhead: a replay's result reflects the current state, so it
reads each upload embed's write state (§1.2). So a steady-state request-ID
create reserves 120 writes and a request-ID edit 280 (104 and 264 without a
request ID). History pages reserve a 32-write floor. A cleanup run has a
bounded due-check reservation (18 reads for its nine indexed existence
probes, one of them the purge list and two for push registrations and wake
times) plus a 1,832/1,032 batch reservation (`1,024 + 4 × 200` reads for the
private-room ceiling, and 1,024 writes, each with control overhead).

Every operation in the runtime reservation matrix is listed, so the claimed
upper bounds can be compared with the measured worst case:

| Operation | Observed reads | Observed writes | Reserved reads | Reserved writes |
| --- | ---: | ---: | ---: | ---: |
| Auth attempt reservation | 8 | 6 | 48 | 32 |
| Frame reservation (one frame) | 13 | 10 | 28 | 24 |
| Frame block (10 frames) | 9 | 7 | 64 | 24 |
| Guest number block | 2 | 2 | 16 | 16 |
| Connection admission reservation | 14 | 10 | 72 | 40 |
| Identity registration (starts in `general`, logs that membership) | 28 | 18 | 338 | 880 |
| Identity registration starting in 100 rooms | 225 | 513 | 338 | 880 |
| Credential lookup | 2 | 1 | 16 | 8 |
| Identity lookup (with the user's rooms) | 6 | 1 | 534 | 8 |
| Identity count | 2 | 1 | 16 | 8 |
| Credential IDs lookup | 2 | 1 | 40 | 8 |
| Credential counter update | 2 | 2 | 16 | 16 |
| Push subscription register | 8 | 4 | 172 | 436 |
| Push subscription register again, unchanged within a day | 3 | 1 | 172 | 436 |
| Push subscription register, a moderator keeping `joined` (one more index entry) | 9 | 5 | 172 | 436 |
| Push wake claim (one user, one subscription; creates the server, sender and recipient counters) | 26 | 15 | 106 | 160 |
| Push wake claim, 31 unregistered candidates before one registered | 76 | 6 | 1,408 | 160 |
| Push registrations clear (`/passkeys remove`, a new bot token) | 1 | 2 | 144 | 400 |
| Mute set (`status` `mute`, unscoped) | 3 | 2 | 24 | 24 |
| Status set (`me` `status`) | 3 | 2 | 24 | 24 |
| Seen settled, written (a registered user shown `offline` as their last connection closed, the `seen` their connection holds and the stored one over 10 minutes old: one conditional update; within 10 minutes of the one held: no statement) | 2 | 2 | 16 | 16 |
| Seen settled, the stored one standing (the connection's copy is stale: the update writes nothing, and one read of `seen_ms` finds the stored one) | 3 | 1 | 16 | 16 |
| Room mute set (`status` `mute` with `room_id`) | 4 | 2 | 432 | 424 |
| Room mute set past 100, refused (two counts and a delete of none ran out) | 303 | 2 | 432 | 424 |
| Room mute clear | 3 | 2 | 432 | 424 |
| Room mute expiry, 50 of 100 ran out (read, delete) | 201 | 51 | 224 | 416 |
| Status inputs at sign-in, nothing stored (with the `unread` probe, nothing counted) | 4 | 1 | 224 | 16 |
| Status inputs at sign-in, a status, a mute and one room mute (`seen` comes with the identity lookup) | 4 | 1 | 224 | 16 |
| Status inputs at sign-in, zeroing an `unread` count (the probe and its update) | 5 | 2 | 224 | 16 |
| Status set to `invisible`, with its `seen` (the stored one over 10 minutes old; one reservation and transaction) | 4 | 3 | 24 | 24 |
| Status set to `invisible`, the stored `seen` standing (within 10 minutes; decided from the identity row it reads anyway) | 3 | 2 | 24 | 24 |
| Seen settled for a user with no identity row (the update matches nothing; the read finds none) | 2 | 1 | 16 | 16 |
| Status inputs at sign-in, 100 room mutes | 103 | 1 | 224 | 16 |
| Push wake claim, `dnd` and muted (passed over) | 2 | 1 | 106 | 160 |
| Push wake claim, the thread's parent muted (passed over) | 8 | 1 | 106 | 160 |
| Gone push subscription forget (one primary-key row) | 2 | 2 | 20 | 22 |
| Push reply author lookup | 4 | 1 | 16 | 8 |
| Push wake claim for a reply (creates the recipient counter) | 18 | 9 | 106 | 160 |
| Push `unread` zeroed (`idle: false` or a read cursor after a push: the recipient counter's probe and its update) | 3 | 2 | 16 | 16 |
| Push `unread` zeroed, nothing counted (the probe only) | 2 | 1 | 16 | 16 |
| Push joined wakers (the moderators who kept `joined`; one range of their partial index, read for every message) | 2 | 1 | 176 | 8 |
| Push wake claim for `joined` (creates its own recipient counter; reads the role and the membership; charges no sender) | 20 | 8 | 106 | 160 |
| Message create with request ID (the poster's first: creates its limiter rows) | 26 | 22 | 296 | 120 |
| Empty new message (not logged) | 2 | 1 | 16 | 8 |
| Deduplicated mutation retry | 2 | 1 | 32 | 16 |
| Reaction set | 20 | 14 | 296 | 120 |
| Thread room create by a registered user (counts the creator's live threads; stores and logs the membership) | 20 | 19 | 414 | 120 |
| Thread room save | 10 | 8 | 296 | 120 |
| Message move with one reaction set | 17 | 15 | 296 | 280 |
| Registered name mutation | 16 | 11 | 296 | 120 |
| Registered room leave (logs the membership; the user's fourth post since its limiter row was written, which writes it) | 19 | 14 | 582 | 72 |
| Registered room join (logs the membership) | 15 | 7 | 582 | 72 |
| Registered room join at the 100-thread ceiling | 328 | 20 | 582 | 72 |
| Guest room join or leave (the guest's first: creates its and its IP's posting limiter rows) | 15 | 12 | 40 | 40 |
| Guest room join or leave (its limiter rows cached; writes the global row) | 3 | 2 | 40 | 40 |
| History page | 9 | 1 | 264 | 40 |
| History page with its quota, a new user and IP (creates both limiter rows) | 21 | 11 | 264 | 40 |
| History page with its quota, again within a minute | 9 | 1 | 264 | 40 |
| Room record lookup (`general`) | 2 | 1 | 24 | 8 |
| Room join lookup | 2 | 1 | 24 | 8 |
| Room listing (representative matrix) | 6 | 1 | 444 | 8 |
| Room members, `general` and one thread | 8 | 1 | 824 | 8 |
| Room members with status, `general` and one thread | 8 | 1 | 1,224 | 8 |
| Room members, 101 rooms with 200 registered members each | 40,401 | 1 | 40,820 | 8 |
| Room members with status, 101 rooms of 200, each member with a status row and the most push registrations and room mutes a user may hold (neither read) | 60,500 | 1 | 61,020 | 8 |
| Read cursor written, new (a membership probe and its row, keyed by user and room, no index) | 2 | 2 | 20 | 20 |
| Read cursor written, moved forward (its row) | 2 | 2 | 20 | 20 |
| Read cursor written, not past the one kept (no row changes) | 2 | 2 | 20 | 20 |
| Read cursor written for a room not joined (the probe alone) | 2 | 1 | 20 | 20 |
| Read cursors at a listing (one range of the user's rows) | 2 | 1 | 518 | 8 |
| Cleanup (matrix, one day later) | 121 | 42 | 1,874 | 1,058 |
| Alarm scheduling | 6 | 3 | 24 | 12 |

The matrix uses a fresh object and one representative operation for each
boundary; every operation stayed within its reservation. Most operations'
bookkeeping is one written row, the budget row with the effective clock.

- The room-listing test separately populated the 100-thread policy ceiling,
  each thread with a description (in its own row); listing all 101 rooms
  measured 205/1 against its 452/16 reservation, which is derived from that
  ceiling (`32 + 4 × 101` rows plus reservation control).
- A 180-record fixture mixing room, message, and reaction records returned a
  50-record forward page (`more: true`, `first_log_id`/`last_log_id`
  spanning all kinds) at 55/1 against its 272/48 reservation.
- The maximum snapshot test used a 4,096-byte text body plus an `ext` field
  and produced an 8,154-byte serialized snapshot. Its maximum observed
  accepted mutation was 28/31 (a schema 9 figure), below the 304/128
  request-ID create reservation of the first operation after a handover.

The worst move was measured at the calibrated reaction ceilings rather than
the defaults: 64 reacting users, each with 16 distinct 64-byte emoji and a
320-byte name. Each reaction set measured at most 88/27. Moving the message
re-logged all 64 sets in one 92,693-byte reaction record and measured 211/156
against its 296/280 reservation (both figures from before schema 11),
charging its posting limits 9 posts (one, and one more per 8 sets), which
writes the mover's and the IP's limiter rows; the record still fit one
history response. The per-message cap is what bounds this move, and its
extra posts what bound repeating it: at the 32-set default a move is charged
5 posts, so the posting limits allow a fifth as many such moves as plain
posts.

### Memberships and identities

- A registered user's join or leave is one reservation that counts as a
  post. It stores or removes the membership row, appends one membership
  record, and advances the room's head, within the 64-write floor; the
  room's `member_count` changes in that same head update, so it writes no
  extra row. Adding or removing another user (`room_join`/`room_leave` with
  `user_id`, `/kick`) is the same operation, charged to the one who asked.
  The read floor covers the user's rooms, read by `memberships_user_idx` and
  joined to `rooms` (`8 + 2 × (151 + 100)` rows: the 101 public rooms and 50
  private memberships a user may hold, and removed rooms awaiting purge). A
  join or leave that changes nothing writes nothing.
- A registration logs a membership in each starting room (at most the 101
  rooms), so its write floor is `64 + 8 × 101`. Registrations are capped at
  300 a day (Free 100); the credit-back returns the unused part.
- A guest's joins and leaves live in its connection and are not logged; a
  join reads the room record (24/8) and its members (below). Where guests
  may post, one that changes something is charged as a post: a 32/32
  reservation (40/40 with control overhead) for the guest's, the IP's and the
  global posting limiter rows, which writes only the global row while the
  other two are cached (3/2). A join of a room already joined, or a leave of
  one not joined, is not charged and reserves nothing.
- `members` (`room_list` with `members: true`, and `room_update` `joined`)
  reads each listed room's registered members by primary-key range with one
  identity lookup each, at most `roomListMembers` (200 on Paid, 100 on Free)
  per room: the reservation is `8 + rooms × (4 + 2 × roomListMembers)`
  reads (`3 ×` with [user status](#user-status)). Connected members come
  from connection attachments. The worst case, all 101 rooms each at the
  cap, measured 40,401 reads at 200, which the 25,000,000 foreground reads a
  day allow about 600 times (about 20,200 at Free's 100, about 120 times its
  2,500,000). A room whose page of registered members is full also reads its
  `member_count` (one row, within the per-room slack).
- Adding a passkey while signed in (§4.10) is one reservation of 96 reads
  and 48 writes, charged as a registration (the per-IP and daily
  registration caps bound it): the identity and credential lookups, a count
  of the account's passkeys (at most 8, `MAX_PASSKEYS_PER_USER`), the
  credential row with its index, and the registration limiter rows.
  `/passkeys` reads at most 8 credential rows; `/passkeys remove` adds one
  delete with its index. Adding a passkey to an account without a WebAuthn
  user handle writes it at `begin` (one conditional row update).
- A sign-up with an `/invite-code` token is an `/invite-token` registration, plus
  up to 8 `user_id` availability probes (8 reads each, reserved), the new
  user's identity read, and one KV read and three KV writes (in one put),
  reserved at their bound. `/invite-code` and `/invite-device` are one KV read and
  three writes, `/invite-token` two KV writes; signing in with a device
  token is one KV read, like a bot token.
- Roles (`roles_json`) and `ext` (`ext_json`) are columns of the identity
  row, read at sign-in (and kept on the connection) and in member listings
  with the name, so they cost no extra reads; `/role` and `/admin` read and
  update the one row, and a `me` that changes `ext` writes it inside the
  `me` mutation's reservation. `ext` costs bytes: up to 512 more per
  identity row, connection attachment, cached member row, and user in a
  listing's `users`, which stays under the 256 KiB listing cap.
- History pages read membership records from the same room range as every
  other record, and look up no user objects. Cleanup purges a removed
  thread's membership rows in the same bounded batch. `~private` throttle
  notices and `/help` replies need no SQL.

### Three-day traffic sample

| Operation | Observed reads/writes | Reserved reads/writes |
| --- | ---: | ---: |
| Day 0 create | 28 / 31 | 304 / 128 |
| Day 1 create | 19 / 21 | 312 / 136 |
| Day 2 edit of older message | 22 / 20 | 312 / 296 |
| Day 2 create | 11 / 15 | 296 / 120 |
| Cleanup | 60 / 16 | 1,074 / 1,058 |
| History after cleanup | 5 / 1 | 264 / 40 |

These rows and the native file size they ended at (`databaseSize = 217,088`
bytes) were last measured with schema 9 and have not been re-measured; the
cleanup reservation predates the private-room term above. A day's first post
writes its poster's and IP's limiter rows through (a new UTC day); the day 2
create, within a minute of the edit, leaves them in memory. These values are
a small schema/data sample and are not a per-message capacity estimate.

## Guest numbers

Measured with the operation matrix and
[`test/guest-numbers.integration.test.ts`](../test/guest-numbers.integration.test.ts).
Guests are numbered `guest_<n>` from a counter reserved in blocks of
`guestNumberBlock` (10): one reservation advances the stored high-water mark
(a `_meta` row) and the object serves the block from memory. Guest auth
stores no identity row.

| Operation | Observed reads | Observed writes | Reserved reads | Reserved writes |
| --- | ---: | ---: | ---: | ---: |
| Guest number block (steady state) | 2 | 2 | 16 | 16 |
| Guest number block (first reservation after a wake; schema 9 figure) | 6 | 6 | 24 | 24 |
| Guest number served from the block | 0 | 0 | 0 | 0 |

- The written rows are the mark and the budget-row update, which carries the
  effective clock; the first reservation after a wake also loads the day's
  budget row under the handover allowance. The reservation is foreground
  work and counts no frame or post.
- Every start, eviction, or hibernation wake that authenticates a guest
  reserves a fresh block, since the in-memory block is lost; the unused
  numbers are skipped. That is at most about 600 rows a day at Free's 2,000
  guest admissions (1,200 at Paid's 4,000), against about 35 charged writes
  for each guest reconnect from a new address.
- A schema reset reads the mark before the wipe and writes it back
  afterwards, one uncharged control row like the carried budget row, so
  guest IDs are never reissued.

## Frames, activity, and pings

Connections reserve frames in blocks of 10 (`frameLease`) for 64 reads and
24 writes, where a single frame reserves 28 and 24, so each frame's own
bookkeeping is 2.4 reserved writes, and Free's 60,000-row foreground write
ceiling covers about 25,000 frames a day on their own. A connection that
sends one frame and closes still pays a whole block. Blocks set what frames
without SQL work of their own cost (notifications, rejected frames); a post
is one frame plus its mutation.

`activity` (typing) is on in the Paid plan and off in Free; `ACTIVITY`
overrides it ([configuration](configuration.md#runtime-overrides)). The web
client sends a typing update when typing starts, every 12 seconds while it
continues, and when typing pauses: about 5 frames, or 12 reserved writes, per
typing minute. Read-cursor updates cost the same per frame, plus their own
writes ([Read cursors](#read-cursors)). The per-user relay limit (10 a
minute) and the frame limits (60 per connection and 120 per IP a minute)
bound a single sender.

A throttled sender's `~private` notice is sent to that connection only, at
most once per user per minute, and needs no SQL. `room_list` reuses the
room-listing reservation (444 reads, 8 writes) and adds no writes; with
`members: true` it also reads each listed room's registered members
([Memberships](#memberships-and-identities)).

The liveness ping (`{"method":"ping"}` every `server.ping` = 45 seconds, from
clients that support it) is answered by `setWebSocketAutoResponse`: it never
wakes the object or reaches `webSocketMessage`, so it uses no duration, frame
budget, or SQL. A ping with other spacing is an ordinary frame. Incoming
WebSocket messages count as Durable Object requests at 20:1, so 100
connections that ping all day add about 9,600 requests (under 10% of Free's
100,000 daily allowance, and 30% of Paid's 32,000 daily share). Pings are not
rate limited by the demo; a client flooding them can spend that allowance,
which the account-usage stop bounds, and on Free also the platform's own
limits.

At the post costs above, Free's 60,000-row foreground ceiling is a few
thousand posts a day before other foreground work shares it (Paid's 700,000
leaves the 10,000-post ceiling reachable). Near the ceiling a post is
admitted only while its full reservation (120 writes with a request ID, 280
for an edit) still fits. The 96- and 256-row mutation floors are
conservative upper bounds for the posting and editing paths and their
indexed control rows; the measured maximum accepted mutation is much
smaller, so lowering a floor requires a separate proof for every allowed
mutation shape and its control rows.

Rejected work is charged when it reaches a reservation boundary: a
post-limit failure may have paid either the request-ID lookup or the full
mutation reservation, both within the measured bound. Under the explicit
1,000/1,000 foreground test ceiling, a bounded pool of requests is accepted,
the remaining request-ID lookup allowance drained, and repeated denials then
perform no additional Store SQL. The maximum-snapshot test accepted five
operations before midnight, rejected the sixth in that minute, then accepted
a five-operation burst after midnight and two groups of four edits a minute
apart: a current-day limiter count of 13, so the UTC reset and the two
bursts are independent.

## Push

What Web Push does and its settings are in
[configuration](configuration.md#push) and
[SPEC section 4.4](../SPEC.md#44-push). The figures are the matrix's, with
their reservations.

**Registration.** `push_register` is one frame plus 8/4 the first time, 3/1
when a client registers the same subscription (keys and `push_id`) again
within a day, and 9/5 for a moderator keeping `joined`;
`registersPerUserMinute` (10) bounds the rest. These were measured with a
64-character `push_id`, the longest allowed (it changes row bytes, not row
counts). The 172/436 reservation is sized for evicting a user's whole range
under any valid policy (64 registrations), and mostly credited back.

**Wake claims.** Choosing whom a new message wakes reads connection
attachments, plus one indexed read of the replied-to message's state for a
reply (4/1); wake scopes are in the registration row. The claim then looks
up at most 32 candidates (`MAX_PUSH_CANDIDATES`) in turn: each costs one
read of its `user_status` row (the unscoped mute and `dnd`), an unregistered
one about one more for its key range, and a registered one also two
primary-key probes of `room_mutes` (the room and, for a thread, its parent,
read once a message), its wake time for the room and its recipient counter,
and the server's and sender's counters once. A candidate a mute or `dnd`
silences is passed over (2/1; 8/1 when the thread's parent is muted).

A message that wakes someone writes each woken user's wake time and
recipient counter, and the server's and sender's counters, charged as the
pushes are claimed, delivered or not: 26/15 for the day's first wake
(counter rows created), about 7 writes after; a reply's 18/9; 76/6 with 31
unregistered candidates before one registered. A message whose candidates
have no live registrations, or are all coalesced, writes nothing; one that
mentions no one idle or gone does no push SQL. The reservation, 106 reads
for one candidate and 1,408 for 32 (5 registrations each) and 160 writes
(`wakesPerMessage` wake rows and recipient counters), is mostly credited
back.

**Gone registrations.** A push service's 404, 410 or 403 costs one
primary-key delete per gone registration (2/2), whatever other accounts share
the endpoint: deleting by endpoint alone would read and write every account's
row for it, which an attacker can multiply by registering one endpoint from
many accounts, and would overrun the reservation and latch accounting unsafe.
Many accounts sharing one endpoint otherwise cost what as many separate
registrations do: a wake claims at most `wakesPerMessage` users of
`subscriptionsPerUser` each.

**`joined`, for moderators.** Only a registered `admin` or `mod` keeps
`joined` (`JOINED_WAKE_ROLES`), so `push_subscriptions_joined_idx` holds only
their registrations. Every new message reads that index's live range once
(`Store.joinedWakers`: 2/1 with one moderator; at most 32 users of 5
registrations, 176 reserved), and adds them as candidates after everyone
else. The claim reads each one's identity row for the role and probes their
membership of the room and, for a thread, its parent, and charges no sender:
20/8. `joinedCoalesceSeconds` (300) is read from the same `push_wakes` row,
and `joinedPushesPerRecipientDay` (20) is a recipient counter that takes the
place of the one other pushes write, so the separate allowance adds no row
to a claim, and one limiter row a day per moderator woken for `joined`.

**`unread`.** The count each push carries is kept in the `uploads_day`
column of the `push_recipient` counter the claim already writes, so counting
adds no row to a claim. Coming back zeroes it: a sign-in with one more
primary-key read in its reservation, and a write only when it held a count
(5/2); any other return (`idle: false`, a read cursor, any frame from a
connection not idle) with a reservation of its own (3/2), only when a push
counted it up since (the claim marks the user's connections, `unreadOwed` in
their attachments). Unmarked, a return runs no SQL (measured), and the
update runs only when the count is not 0 (2/1 otherwise). So a user who is
never pushed pays one read a sign-in.

**Read cursors drop pushes.** A read cursor that passes a message drops the
user's waiting and held wakes for it with no SQL of its own; only when it
passes the newest of held wakes released together does the next one left
cost its lookup (one metered read).

**Cleanup and bounds.** Cleanup deletes expired registrations
(`pushExpiryDays`, 7) and wake times past `coalesceSeconds` within its
existing batch, by their time indexes. Wake times number at most one per
woken user and room a day, so at most `pushesPerDay` rows. The pushes
themselves are outbound requests from the Durable Object: no Worker or
Durable Object request is billed for them, and the object is awake for the
post anyway. `pushesPerDay` (5,000 on Paid, 1,000 on Free) bounds them; on
Paid that is at most about 50,000 claim writes a day if every push were its
own wake, about 7% of the foreground write ceiling.

## User status

Measured with
[`test/accounting.integration.test.ts`](../test/accounting.integration.test.ts)
("measures member listings with status by population", the operation matrix,
and the 101-room ceiling),
[`test/presence.integration.test.ts`](../test/presence.integration.test.ts)
and [`test/push.integration.test.ts`](../test/push.integration.test.ts). What
users choose and see is in
[configuration](configuration.md#user-status-presence) and
[SPEC section 4.4](../SPEC.md#44-push) (Chosen status, Mute and User
status); the costs are the same on both plans. With presence off, every
status is `""`, read from nothing.

**Listings.** A listing reads each listed registered member's chosen status
with them, by a primary-key probe of `user_status`. A row that is not there
costs nothing: only members who chose something other than `online` or are
muted have one. Registrations and room mutes are not read. One room of 200
registered members, by what the members have stored:

| Members (200 in one room) | Reads without status | Reads with status | Added per member |
| --- | ---: | ---: | ---: |
| none with a status row | 402 | 401 | 0 |
| each with two live waking registrations and a room mute | 401 | 401 | 0 |
| mixed: a tenth muted, one in 30 invisible, one in 50 `""` | 401 | 432 | 0.15 |
| worst: each with a status row (`dnd` and a mute) | 401 | 601 | 1.0 |
| reserved | 420 | 620 | |

The reservation per room is `4 + 3 × roomListMembers` (`4 + 2 ×` without
status); all 101 rooms at the cap, every member with a status row, read
60,500 rows against the 61,020 reserved (40,401 without status).

**Reuse.** The store keeps each room's member rows, chosen statuses
included, in memory for `statusCoalesceSeconds` (60) and serves a listing
again with no SQL and no reservation (measured 0/0) until any write to
`identities`, `memberships` or `user_status`. A reconnect wave of 100
clients listing `general` with 200 members reads it once instead of 100
times (about 40,000 rows saved at two a member). It is lost on hibernation;
the figures below assume no reuse.

**Sign-in and changes.** A registered sign-in reads the `user_status` row,
one key range of the user's room mutes, and the `unread` probe (4/1 with
none or one room mute; 103/1 with the 100 a user may hold,
`MAX_ROOM_MUTES_PER_USER`, about 60 bytes each), takes `seen` from the
identity row it reads anyway, and keeps the chosen status, `seen` and the
mute ends on the connection, so `me` results, later `you` objects and the
statuses and mutes sent after `auth` read nothing (measured: no statement).
A `me` `status` change or an unscoped mute is 3/2, a room mute 4/2.
`mutesPerUserMinute` (6) bounds mute and status changes together, counted
per user across reconnects: at most about 35 written rows a user a minute.
A room mute past the 100 counts the user's room mutes and deletes those that
ran out (303/2 when none did; 432/424 reserved, for deleting all 100).

Deriving and announcing statuses reads connection attachments only: 0 rows
and no statement, measured, for an `idle` change (but `idle: false` after a
push counted up `unread`), a sweep, a closed connection's change after its
grace, a status snapshot, and the alarm unchanged. An unscoped mute that
runs out is read as none and never written back (0 rows); a room mute that
runs out while its user is connected costs one key range and a delete
(`Store.expireRoomMutes`: 201/51 for 50 of 100, once), and one that runs out
while they are away waits until they next mute a room at the cap. Fan-out is
one `user` frame per connection that shares a room with the user (about 2 ms
of CPU for 100 sockets, from the budget prototype), at most once a minute per
user, and one `status` frame per mute change to each of the user's
connections; outgoing frames are not billed. Idleness is never inferred, so
no sweep reads frame times.

**`seen`.** It is kept in the identity row (`seen_ms`), which a listing
reads anyway for the name (a column, not a row), and on the user's
connections from sign-in, so deciding not to write it needs no SQL. It is
written at most once in `SEEN_WRITE_GRANULARITY_MS` (10 minutes) per user:
within 10 minutes of the stored one no statement runs (measured). Otherwise
the store settles it, writing only where the one it holds does not stand
either, so a stale copy never writes twice:

- A close's write is one conditional primary-key update, 2/2 with its
  reservation (16/16 reserved): the identity row and the budget row. Where
  the stored one stands after all, 3/1; for a user with no identity row
  (purged meanwhile), 2/1.
- Several tabs closing together are one departure (remembered in memory,
  and after an eviction found in other connections' attachments): two and
  three tabs closed back to back write 1 row of `seen_ms`, measured. A
  reload loop writes at most once in 10 minutes, though `seen` is written
  at the close even when the user returns within the grace.
- A chosen `invisible` writes it in `setStatus`'s own reservation and
  transaction (an exhausted budget refuses both): 4/3 when it writes, 3/2
  when the stored one stands.
- It is not an indexed column, and it does not invalidate reused listings:
  the store updates their row in place once the write is committed (a
  `setStatus` that rolls back leaves them as they were, tested), while every
  other write to their tables invalidates them (tested).
- Guests' `seen` lives on their connection, never in SQL; changes owed to
  others carry it in their `owed` entry.

`/toggle presence` keeps when presence was turned on in one `_meta` row
(`presence_on_ms`), written with the toggle (a 4/8 reservation) and read with
it once per wake in one statement, `SELECT key, value FROM _meta WHERE key
IN (?, ?)`: nothing per user and no read at sign-in.

Per account, `seen` writes are more than 10 minutes apart: at most
86,400,000 / 600,000 = 144 a day of at most 2 rows, so at most 288 written
rows a day (0.48% of Free's 60,000 foreground writes, 0.04% of Paid's
700,000), however it reconnects or flips. Choosing `invisible` and back is
the cheapest way for one account to write rows through status:
`mutesPerUserMinute` (6) allows 3 such pairs a minute, at most 21,744
written rows a day for an account that does nothing else, 36% of Free's
foreground writes and 3.1% of Paid's (an upper bound, computed from
per-change costs higher than the matrix's). At the load models below,
`seen` writes at most 2,000 rows a day at R and 4,000 (Free) or 8,000
(Paid) at K: 2 per admission whose user left more than 10 minutes after
their last `seen`, and nothing for reloads and reconnects within 10 minutes.

**Refusals and idle changes.** A refused `status` costs no more than the
change it declines: `invalid_params`, and `retry_after` past
`mutesPerUserMinute` or the idle limit, run no statement; an unknown room
costs at most one bounded room lookup; a room mute at the cap 303/2. A
connection may go idle 12 times a minute
(`IDLE_CHANGES_PER_CONNECTION_MINUTE`), counted in memory, so a client
flipping it cannot make the object re-derive its user's status at frame
rate.

**Room mutes on Free.** A sign-in reads one row for the empty range, under
0.1% of the foreground reads at Free's 2,000 admissions; claims read two
rows per candidate with registrations, at most about 3,000 a day at
`pushesPerDay` (1,000); storage is at most 100 rows a registered user; none
of it uses requests.

**Timer and duration.** A change waits for the coalescing minute and, when
a closed connection caused it, the 60-second grace; a mute running out
within a minute arms the same timer: one in-memory `setTimeout`, armed only
while a signed-in connection is open. It sets no alarm and uses no SQL (both
measured; a room mute that ran out aside), and keeps the object awake at
most 60 s after its last event, against about 10 s before it would
hibernate: at most 50 s × 0.125 GB = 6.25 GB-s per change that lands in a
quiet period, 0.05% of either plan's daily duration. An alarm per due change
would instead cost one request per wake (2% of Free's requests, 12.5% of
Paid's at 4,000 a day), alarm scheduling (6/3) and an alarm run (about 14
written rows), about 34,000 maintenance writes a day at Free's 2,000
admissions (170% of its 20,000), and about 1.25 GB-s per wake.

A mute that runs out more than a minute after the last event is told at the
first event after it (any frame, connection, close or alarm, each of which
sweeps). Nothing waiting is lost when the object is evicted: what others
were told is on the user's connections (`pres`), and a change owed to others
for a user with no connection left is on each connection owed it (`owed`);
the first event after a wake sweeps the attachments and announces what is
due (tested by evicting the object with changes waiting).

**Daily budget.** Added by user status at the load models of the budget
analysis: R (realistic, 1,000 admissions a day) and K (the admission caps:
2,000 on Free, 4,000 on Paid), with 1.5 member listings per admission, 150
(Free) or 250 (Paid) listed registered members each, the mixed population
above (0.15 reads a member), and one last disconnect per admission. Shares
are of each plan's daily allowance (Paid: its monthly included usage over 31
days), and for SQL of the application's foreground ceiling.

| Added per day | Free, R / K | Paid, R / K |
| --- | --- | --- |
| Durable Object requests | 0% / 0% | 0% / 0% |
| Durable Object duration, if every session ends in an otherwise quiet minute | ≤ 3,125 GB-s (24%) / bound by the whole day | ≤ 6,250 GB-s (48%) / bound by the whole day |
| SQL rows read (foreground) | 1.4% / 2.7% (worst, every member with a status row: 9% / 18%); sign-ins +0.04% / +0.08% | 0.2% / 0.9% (worst: 1.5% / 6%) |
| SQL rows read (account) | under 0.1% / under 0.2% | under 0.05% / under 0.2% |
| SQL rows written (foreground) | about 2 per status change (3 for `invisible`, 4 when it writes `seen`) and 3 per mute: ≤ 0.9% / ≤ 3.4%; `seen`, 2 per registered last disconnect over 10 minutes after the user's last `seen`, none within: ≤ 3.3% / ≤ 6.7%, and ≤ 288 rows (0.48%) a day per account; one account flipping `invisible` as fast as allowed: 36% | ≤ 0.15% / ≤ 0.6%; `seen`: ≤ 0.3% / ≤ 1.1%, ≤ 0.04% per account; one account flipping: 3.1% |
| Frames | no incoming frame beyond what push already asked for; outgoing only: announcements, the statuses and mutes in effect after each sign-in, one `status` per mute change to the user's connections, and one `user` frame per user told of on `/toggle presence` off or on, none of which an allowance counts or SQL serves | same |

The read worst case needs every listed member to have chosen a status or
muted; the reuse above cuts it further at reconnect waves. The duration rows
assume every last disconnect leaves the object otherwise idle; sessions that
end during others' activity add nothing. Duration has a hard bound whatever
the design: one object awake all day is 10,800 GB-s, 83% of Free's 13,000
and 84% of Paid's daily 12,900 (334,800 GB-s in a 31-day month, under Paid's
400,000 included), so the timer cannot run either plan over.
`offlineGraceSeconds` and `statusCoalesceSeconds` trade staleness for
duration: at 30 seconds each the duration rows halve.

## Live text

Live text (`embed:terminal`, `embed:append`; [SPEC section 4.5](../SPEC.md#45-live-text),
[configuration](configuration.md#live-text)) was measured on 2026-10-30 in two
ways, both local, never against the deployed server:

- Rows and bytes: [`test/live-text-cost.integration.test.ts`](../test/live-text-cost.integration.test.ts),
  with the Workers Paid and Free policies, on native SQLite in the test
  runtime, as the rest of this report (`npm test -- --run
  test/live-text-cost.integration.test.ts --reporter=verbose` prints the table).
- Requests, wall time and CPU: [`scripts/live-text-load.py`](../scripts/live-text-load.py)
  against `npx wrangler dev` on a Linux container, with a
  local copy of `wrangler.toml` whose attempt limiters were raised to 10,000 a
  minute and `LIMIT_*` variables raising the per-address admission limits, so
  that eleven HTTP clients on one address are admitted. It streams colored
  terminal lines (66 bytes each, one chunk per line, as `script` writes them)
  to a `/embed-terminal` write URL with ten readers attached, and reads the
  CPU time the local workerd process spent from `/proc`, less the same span
  idle measured first. The number of requests is counted from the requests
  each step makes (and checked against Wrangler's request log).

### One text

| Operation | Reads / writes |
| --- | ---: |
| Message with a new terminal embed (the user's first live text: creates its `live` limiter rows) | 30 / 19 |
| Message with a new append embed (`live` limiter rows exist) | 19 / 18 |
| `/embed-terminal` (charges the post and the start; posts nothing) | 17 / 14 |
| Write claimed (the `PUT` arrives); a command's write, which posts its message | 1 / 2; 4 / 6 |
| Text finished: terminal with 32 KB of output, append with 4 KB, or nothing kept | 7 / 6 |
| Alarm ends a write that never came | 7 / 6 |
| Alarm with no open text | none (known to be none, from memory) |
| Open texts read after a wake / again | 2 / 1; none |

Each figure includes the day's budget row. A text also reschedules the alarm
when it starts, when its write arrives and when it ends (6 / 3 each, the
alarm-scheduling row of the [matrix](#reservation-accounting), `setAlarm`
included), so a whole text is about **50 rows read and 36 written**, two to
three posts' worth, whichever way it starts. Every operation stayed within
its reservation (the claim reserves a post's 264 / 120, the finish 104 / 88
as maintenance).

Stored: the finished terminal is one record, its `output` JSON-escaped (32 KB
of colored output was 45,457 bytes of JSON, and the database grew 45,056
bytes); the creation snapshot with `url` stays beside it (a few hundred
bytes). The `output` is cut further while its JSON passes 128 KiB, its worst
case (every byte a control character, six bytes of JSON each). An append adds
its kept text (at most 4 KB) to one record. The open-text row (`live_texts`)
is at most a few kilobytes and is deleted when none is open. On Free (16 KB
kept) the figures are the same rows, 22,754 bytes of JSON, and 24,576
bytes of growth.

| Load, Workers Paid limits (local) | 120 s, ordinary user, 10 readers | 300 s, admin, 10 readers | 120 s, no reader |
| --- | ---: | ---: | ---: |
| Sent (ended by the time limit) | 1,724,348 bytes, 26,126 chunks | 1,824,322 bytes, 27,641 chunks | 1,722,054 bytes |
| Each reader got | everything but the line sent after the end | the same | |
| Kept as `output` | 32,766 bytes | 32,766 bytes | 32,766 bytes |
| Worker requests / Durable Object requests | 11 / 11 (1 `PUT`, 10 `GET`s), plus 1/20 for the command's frame | 11 / 11 | 1 / 1 |
| SQL rows read / written | about 50 / 36 (above) | the same | the same |
| Durable Object awake (wall clock) | 120 s, 15 GB-s at 128 MB | 300 s, 37.5 GB-s | 120 s, 15 GB-s |
| workerd CPU, Worker and object together, less idle | 5.8 s | 9.1 s | 4.8 s |
| The same before batching readers and piping natively | 29.1 s | 31.7 s | |

Two changes came from the first measurement. Readers were sent each chunk as
it came, one write per chunk per reader through the runtime: 27,000 chunks
to ten readers cost 29 seconds of CPU. They now get what arrived in one batch
at most every 50 ms (or 16 KiB), and ten readers cost about one second over
the writer alone. And the entry Worker pumped the write's body with
JavaScript (to cancel it when the object answers early), about 0.14 ms of
Worker CPU per chunk, so 4 seconds of billed CPU for a worst-case text; it
now pipes it natively through an `IdentityTransformStream` and aborts the
pipe, so the Worker's CPU no longer grows with the text: it is the setup of
its requests (a token check, two rate-limiter calls). The CPU left is the
object's, which Durable Objects do not bill beyond duration, and local
workerd's own proxying; production CPU will differ, and the figures are an
upper bound for the work, not a billing figure.

### Worst-case month

At the Workers Paid limits, 100 texts a day start server-wide; the worst
month has every one at its limits: 30 reads each (10 at once), the longest
time (300 s, as if every writer were an admin or mod), a message whose readers
wait the whole 2-minute window for its write, and a write that never came
ending by the alarm. Requests and rows per day, times 31, against the plan's
included usage and this server's own budgets
([SPEC section 7](../SPEC.md#7-budget-accounting-and-plan-guarantee),
`src/plans/paid.ts`):

| Resource | Included (Paid, a month) | Server budget or stop | Before: worst day (month) | Live text adds, worst day (month) | After: worst day (month) |
| --- | ---: | --- | ---: | ---: | ---: |
| Durable Object requests | 1,000,000 | daily stop at 90% of 32,000; monthly stop at 50% | about 21,000 (651,000) | 3,200: 100 × (1 `PUT` + 30 `GET`s + 1 alarm), the command frames 5 (99,200) | about 24,200 (750,200) |
| Worker requests | 10,000,000 | same stops | admissions and probes within the attempt limiters | 3,100 (96,100) | + 1% of the daily share |
| Worker CPU | 30,000,000 ms | same stops | a few ms a request | the setup of 3,100 requests, about 2 ms each (about 200,000 ms) | + under 1% |
| Durable Object duration | 400,000 GB-s | daily stop at 90% of 12,900; monthly stop at 50% | one object awake all day: 10,800 (334,800) | 100 × (300 + 120) s at 128 MB: 5,250 (162,750) alone; 3,000 for ordinary users | still at most 10,800 (334,800): one object cannot be awake longer than the day |
| SQL rows written | 50,000,000 | 800,000 a day (fails closed) | up to the ceiling | about 3,600 | within the same ceiling |
| SQL rows read | 25,000,000,000 | 30,000,000 a day (fails closed) | up to the ceiling | about 5,000 | within the same ceiling |
| SQL storage | 5 GB-month | 768 MiB high-water (growth stops) | up to the watermark | the kept text of 7 days: at most 700 × 132 KiB ≈ 90 MiB (typical 45 KB each: about 31 MB) | within the same watermark |
| Logs (from 2026-12-01) | 50 GB | monthly stop at 50% | | about 32 invocations a text, sampled at 0.1: under 100 MB | + under 0.2% |

So live text fits the plan: alone its worst month is a tenth of the included
Durable Object requests, 1% of the Worker requests, and under 1% of the rows
written and CPU. It exceeds no daily share: the worst day stays under the
account-usage stop (28,800 Durable Object requests). It adds no duration the
single object did not already bound: the object cannot be awake more than a
day a day, which the duration share covers, so streaming spends duration, as
user status does, rather than adding a new risk; what it changes is the
typical month, in which the object hibernates between events and each text
keeps it awake for its length (20 two-minute texts a day are about 300 GB-s,
under 1% of a daily share). As before this change, a month spent entirely at
every ceiling would reach the budget guard's monthly stop at half the
included Durable Object requests: about day 21 instead of day 24. The guard
then blocks the hostname, so the included usage is still never billed past;
that stop is how the plan guarantee is kept (section 7), and live text moves
it three days earlier only in that all-out case. The 120- and 300-second
limits are the owner's maximums and are kept; the counts above are the
levers, and halving `readsPerText` or `startsPerDay` halves live text's share.

On Workers Free (off by default; `LIVE_TEXT=true`), at its limits a day is
30 texts × (1 + 15 + 1) = 510 Durable Object requests of 100,000, about 1,100
rows written of the 60,000 foreground, at most 3 MB kept for the day's
retention of the 96 MiB high-water mark, and duration within the same
single-object bound (10,800 of 13,000 GB-s).

## Retention, maintenance, and persistent state

The three-day cleanup advanced the internal server-wide retention floor
(`history_floor` in SQLite) past three old records (the seeded `general`
room record and two creates), removed the unreferenced old current message,
and kept the edited message whose latest record was still inside the
retention window. It also removed two expired accepted-request rows without
changing the room head.

The maintenance-reserve test (measured with schema 10) accepted 76
mutations under an explicit 1,000/1,000 foreground ceiling, rejected the
next mutation, then ran cleanup the next UTC day. The previous day's
foreground counter was 848 while the new day's cleanup, run until it found
nothing (one run deletes what its reservation covers), was charged 250
maintenance writes (615/250 observed, over six reservations) and removed 77
records (the creates and the seeded room record) and 76 messages. The
current budget row must be read by day; calling `budget()` after midnight
correctly returns the new day's foreground counters rather than the
exhausted previous day.

After `evictDurableObject`, a fresh Store instance observed a bounded set of
schema, effective-clock, and budget-cache reads and zero schema writes. The
persisted principal-limit rows retained the original daily post count and
the second mutation was rejected by that daily limit. The SQLite file
remained the same size across eviction (151,552 bytes, measured with schema
10).

## Storage pressure and page reuse

The pressure integration
([`test/pressure.integration.test.ts`](../test/pressure.integration.test.ts))
sets the Free plan's watermarks and uses a separate native SQLite
calibration table with 8,192-byte payloads inserted in 64-row transactions.
It reached `132,177,920` occupied bytes (within 3 MiB of the 128 MiB hard
target), and a default Store mutation was rejected before growth. Deleting
and reinserting the same 15,168 rows three times produced the same occupied
size each time, without VACUUM.

The fixture then reduced occupied bytes to `93,749,248` (about 89.4 MiB),
evicted the object, and confirmed that the persisted pressure latch still
rejected growth above the 80 MiB low-water mark. After reducing the occupied
size to `81,371,136` (about 77.6 MiB) and evicting again, a new Store
accepted a mutation.

## Query plans

`EXPLAIN QUERY PLAN` returned these details in the native test runtime:

```text
history (one room's log, every record kind):
  SEARCH records USING PRIMARY KEY (room_id=? AND log_id>? AND log_id<?)
cleanup (the server-wide log from the floor, in log order):
  SEARCH records USING INDEX records_log_idx (log_id>?)
cleanup physical delete:
  SEARCH records USING COVERING INDEX records_log_idx (log_id<?)
message state expiry (with its latest record):
  SEARCH message_state USING PRIMARY KEY (message_id=?)
reaction state expiry (each set the record names, by its whole key):
  SEARCH reaction_state USING PRIMARY KEY (message_id=? AND user_id=?)
a wake's registrations (one user's):
  SEARCH push_subscriptions USING PRIMARY KEY (user_id=?)
  USE TEMP B-TREE FOR ORDER BY
move re-logging reactions:
  SEARCH reaction_state USING PRIMARY KEY (message_id=?)
  USE TEMP B-TREE FOR ORDER BY
room listing:
  SCAN rooms
  USE TEMP B-TREE FOR ORDER BY
dedup expiry:
  SEARCH accepted_requests USING COVERING INDEX accepted_requests_expiry_idx (expires_ms<?)
limiter expiry:
  SEARCH principal_limits USING COVERING INDEX principal_limits_updated_idx (updated_ms<?)
room members:
  SEARCH m USING PRIMARY KEY (room_id=?)
  SEARCH i USING PRIMARY KEY (user_id=?) LEFT-JOIN
room members with status:
  SEARCH m USING PRIMARY KEY (room_id=?)
  SEARCH i USING PRIMARY KEY (user_id=?) LEFT-JOIN
  SEARCH s USING PRIMARY KEY (user_id=?) LEFT-JOIN
a wake's room mute check (the room and its parent):
  SEARCH room_mutes USING PRIMARY KEY (user_id=? AND room_id=?)
a sign-in's room mutes:
  SEARCH room_mutes USING PRIMARY KEY (user_id=?)
a user's rooms:
  SEARCH m USING COVERING INDEX memberships_user_idx (user_id=?)
  SEARCH r USING PRIMARY KEY (room_id=?)
  USE TEMP B-TREE FOR ORDER BY
```

History reads one contiguous primary-key range of one room's log; a move is
stored once in each room it touches, so no membership filter or `UNION` is
needed. The temporary sorts are bounded: the move's reaction read sorts at
most the capped per-message reaction sets, a wake at most
`subscriptionsPerUser` registrations, and the room listing and a user's
rooms the capped rooms table, which the thread-room expiry check in cleanup
also scans. On a `WITHOUT ROWID` table a secondary index holds the primary
key, so the indexes by `expires_ms` and `updated_ms` cover the expiry scans
that read only keys.

## Schema upgrades and reset

Which stored schemas are upgraded in place and which reset is in
[SPEC section 8, Schema versions](../SPEC.md#schema-versions)
(`test/schema-reset.integration.test.ts`). The measured costs:

- **Schema 10 to 11** is one charged transaction on the first wake; its
  cost was not recorded here. Dropping the uploads' `content_type` rewrites
  the uploads table.
- **Schema 9 to 11** rebuilds each table the current schema keys
  differently (`Store.upgradeFromSchema9`), reading and writing every
  retained row once: measured 10,435 written and 13,937 read for a store of
  10,000 identities, and 445 written for a nearly empty one, when the
  rebuild targeted schema 10. A full store costs on the order of its row
  count, more than a day's maintenance allocation, so the rebuild is logged
  (`storage_schema_upgraded`, with `rows_read` and `rows_written`) and not
  charged to the day's budget; the account's own usage still counts it.
- Before that, a schema 9 object made without the identities' `seen_ms`
  gains the column, charged 53 read and 3 written rows alike with 500 and
  10,000 identities (no row is rewritten or backfilled). Only a schema 9
  wake probes for it, with `SELECT seen_ms FROM identities LIMIT 0`, which
  reads and writes no row (measured 0, where `pragma_table_info` reads 11;
  the store charges it as one read, within the eight-row handover
  allowance).
- **Schema 8 to 9** adds the limiter rows' two bucket columns and the budget
  rows' two, and keeps the limiter rows' four timestamp-list columns,
  unread. Adding a column rewrites no row, so the upgrade was charged 8
  written rows over 503 limiter rows (measured on 2026-10-24); dropping the
  four lists as well measured 2,168, about 4.3 a row, so about 43,000 at the
  10,000-row limiter cap, more than Free's whole maintenance allocation.
  Schema 7 to 8, and this, add the rows they measurably read and wrote to
  the day's maintenance counters without a capacity check, so an exhausted
  budget cannot block them.

Any other stored schema version resets the object with `deleteAll()` and
recreates the schema. The reset is charged the same one-time 512/512
bootstrap reservation as a new object, added to the carried-over current-day
reservation row without a capacity check. The passkey carry (at most
`MAX_CARRIED_PASSKEYS`, 100) adds the rows it measurably read and wrote to
that row's maintenance counters: finding the most recent passkeys reads every
credential and its identity (at most the 10,000-identity cap), and each
carried passkey writes its identity, credential and `general` membership
rows with their indexes.

## Measurement limits

The native test runtime's `databaseSize` reports occupied SQLite bytes with
freelist pages excluded. The pressure test therefore verifies the supported
occupied-byte contract and page reuse; it does not claim a filesystem-file
shrink, require VACUUM, or rely on a portable freelist counter.
[`test/native-storage.test.ts`](../test/native-storage.test.ts) measures
basic indexed insert/update/delete costs and page reuse; `PRAGMA
freelist_count` is unsupported by this runtime, and this report does not
infer physical freelist behavior from `databaseSize` alone. The measured row
bounds describe this schema and runtime, not deployed billing or a
guaranteed per-message capacity.

These figures were not re-measured on schema 11 and are kept as last
measured: the three-day traffic sample and its 217,088-byte file (schema
9), the maximum-snapshot test's 28/31 accepted mutation (schema 9), the
calibrated worst move (211/156) and reaction set (88/27), the guest-number
block after a wake (6/6, schema 9), the post that writes its limiter rows
(11/14) and a poster's first post (28/23), the guest reconnect (about 35
written), the maintenance-reserve test's 76 posts, and the evicted object's
151,552-byte file (schema 10), and the schema 9 rebuild's row counts
(measured into schema 10).

Live text's CPU figures come from a local `wrangler dev`, whose workerd also
proxies and traces each request: they bound the work, not a deployed bill.
Its request counts follow from the code paths and Wrangler's request log;
Cloudflare's own analytics were not read.

The executable coverage for this report is in
[`test/accounting.integration.test.ts`](../test/accounting.integration.test.ts),
[`test/pressure.integration.test.ts`](../test/pressure.integration.test.ts)
and [`test/live-text-cost.integration.test.ts`](../test/live-text-cost.integration.test.ts).
