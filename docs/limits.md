# Limits for client developers

What this server refuses, closes or throttles, how each refusal looks on the
wire, and what a client usually did to cause it. It is written for people
building their own Apron client against the public demo
(`wss://server.apron.chat`), so the numbers are the demo's (the Workers Paid
budgets). The authoritative tables are in
[SPEC section 6](../SPEC.md#6-default-limits) and the
[configuration reference](configuration.md#runtime-overrides); a self-hosted
deployment may change any of them.

Limits compose: passing one never bypasses another. Per-minute limits are
token buckets, so a quiet client may spend a burst at once and then refills
gradually. Daily limits reset at 00:00 UTC.

Jump to: [How a limit reaches you](#how-a-limit-reaches-you) ·
[Connecting](#connecting-http-before-the-upgrade) ·
[Closed connections](#closed-connections) ·
[Signing in](#signing-in) ·
[Requests](#requests) ·
[Hard caps](#hard-caps) ·
[Checklist](#checklist-a-well-behaved-client)

## How a limit reaches you

A limit can reach a client in four ways:

1. **An HTTP error instead of the WebSocket upgrade.** The body is
   `{"error": "<message>"}`, and a temporary refusal carries a `Retry-After`
   header in seconds. Browsers hide a failed handshake's response from
   JavaScript, so you only see a generic error event there. To learn why, send a plain
   `GET` to the same URL with `?apron_connection_status=1`. It answers with the same
   status, body and `Retry-After`, or `{"available": true}`, without opening
   a socket. It exposes `Retry-After` through CORS, and carries
   `Apron-Connection-Status: 1`, so a reply without that header came from
   something else (an edge or a proxy). The probe counts against the
   connection attempt limits below, so use it after a failure, not before
   every connect.
2. **A JSON-RPC error on a request.** The `message` names the limit:

   | Code | Name | Meaning |
   | ---: | --- | --- |
   | -32002 | `retry_after` | Temporary. `data.retry_after` is whole seconds to wait. `data.ext.limits` (extension `ext:limits`) says what to hold back: `read` (history, room listing), `write` (posting, reactions, joins, leaves, `room_set`) or `upload`. |
   | -32001 | `denied` | Not allowed, or a hard cap is full. Retrying will not help until something changes. |
   | -32003 | `too_large` | A field or frame is over its size bound. |
   | -32602 | `invalid_params` | The request is malformed. |
   | -32600 / -32700 | `invalid_request` / `parse_error` | The frame is not a valid request. |
   | -32601 | `unsupported` | The method or scheme is not offered here. |

   Three `parse_error`, `invalid_request`, `invalid_params` or `too_large`
   errors within 60 seconds close the connection (1008, "Repeated policy
   violations").
3. **A WebSocket close** with a code and a reason (below).
4. **A `~private` notice**: a `message` from `~private` with no `room_id`,
   shown only to that connection. Used when something is dropped rather
   than refused (typing over its rate) and before a stale close of a
   connection that never pinged.

## Connecting (HTTP, before the upgrade)

| Status | `error` | Limit | Retry-After | Usual cause |
| ---: | --- | --- | ---: | --- |
| 429 | Connection attempts exceeded | 20 upgrade attempts a minute per address (IPv6 grouped by /56), 60 per IPv6 /48 | 60 | A reconnect loop without backoff. Probes and refused attempts count too. |
| 503 | Demo is busy; try again shortly | 200 attempts a minute from everyone at one Cloudflare location | 60 | Other clients, or many of yours, near the same location. |
| 429 | Demo capacity reached | 100 open sockets on the server; 10 per address; 6 per address that are not signed in to an account (guests and sockets still authenticating) | 60 | Sockets left open: extra tabs, hot reload, reconnect that never closes the old socket. |
| 429 | Connection admission limit reached | 12 admitted connections a minute per address; 4,000 a day on the server | the bucket's wait, or until the next day | Reconnecting on every error or page view. A passkey sign-in on a fresh page uses up to three admissions (guest, sign-in, signed-in reconnect). |
| 429 | Daily demo capacity reached / Daily frame budget exhausted | The server's daily SQL or frame budget | until the next day | The whole demo is used up for the day. |
| 503 | Demo account capacity reached | The Cloudflare account's usage stop | 300 | Same; the operator's account is near its included usage. |
| 503 | Demo admission is closed | Operator switch | none | Maintenance or an incident. |
| 503 | Server unavailable; try again shortly | Platform failure | 60 | Not your client. |
| 403 | Origin not allowed | `ALLOWED_ORIGINS` (the demo allows any) | none | Only on a deployment that restricts origins. |
| 400 | WebSocket upgrade required | Only `GET /` or `GET /ws` with `Upgrade: websocket`, or the probe | none | A plain HTTP request. A non-`GET` gets 405 "Method not allowed", and a handshake with a body 400 "WebSocket upgrade must not contain a body". |
| 403 | Trusted client address unavailable | The edge did not supply the client's address | none | A request that did not come through Cloudflare's edge. |

A socket whose peer vanished without a close frame (sleep, a network change)
still holds a slot until it goes stale; see
[liveness](#liveness-and-stale-connections).

## Closed connections

| Code | Reason | Cause | What to do |
| ---: | --- | --- | --- |
| 1001 | Connection idle; reconnect to recover | No ping or frame for 150 seconds after the connection had pinged, or for 15 minutes if it never pinged | Reconnect. If you see it while the tab is live, your ping is not being sent. |
| 1003 | Binary application frames are not supported | A binary frame | Send text frames only. |
| 1008 | Authentication timed out | No successful `auth` within 30 seconds of connecting | Authenticate right after the `server` frame. |
| 1008 | Frame rate limit reached | More than 60 frames in a minute on this connection (the exact ping bytes do not count) | Batch or throttle. Typing and read cursors count as frames. |
| 1008 | Too many pending frames | More than 8 frames (or 128 KiB) sent and not yet processed | Wait for responses; do not pipeline bursts. |
| 1008 | Repeated policy violations | Three malformed or oversized requests within 60 seconds | Fix the request; do not retry it unchanged. |
| 1008 | Removed by an admin; Device token replaced…; Bot token replaced…; Signed out after a week without signing in or posting | Account changes | Do not reconnect with the same credentials in a loop. |
| 1009 | Frame exceeds the maximum size | A frame over 16,384 UTF-8 bytes | Check sizes before sending. |
| 1011 | Delivery failed / Delivery interrupted; reconnect to recover | The server could not deliver to the socket | Reconnect with backoff, then fetch history to catch up. |
| 1013 | Frame rate limit reached | More than 120 frames a minute from your address, all connections together. Each connection reserves frames 10 at a time, so many short-lived connections spend this fast | Back off; fewer connections. |
| 1013 | Demo capacity reached; try after daily reset / Demo account capacity reached; try later | Server-wide budgets | Back off for minutes, not seconds. |

### Liveness and stale connections

The `server` frame advertises `ping` (45 seconds). Send the text frame
`{"method":"ping"}`, byte for byte, at that interval. The runtime answers
`{"method":"pong"}` without waking the server, and these pings do not count
against any frame limit. A ping with other spacing, or with an `id`, is
answered too, but as an ordinary frame that counts.

The server cannot ping clients, so it uses your pings to find dead sockets.
A connection that has pinged is closed as stale after 150 seconds without a
ping or frame. One that never pinged gets 15 minutes, and a `~private` notice
("Did not receive `{"method":"ping"}` in 15 minutes, closing stale
connection.") just before its 1001 close. Until a vanished socket is found
stale it keeps counting against its address's and its account's connection
limits. A client that never pings can lock its own account out for up to 15
minutes after a few unclean reconnects.

## Signing in

| Error | Limit | Usual cause |
| --- | --- | --- |
| `retry_after` "Connection limit reached for this account" (`retry_after` 60) | 3 signed-in connections per account, across all devices and addresses | More tabs, devices or test instances on one account than 3, or old sockets not yet closed or stale (see above). Bots count too: 3 per bot. |
| `retry_after` "Authentication attempts limited" | 10 auth attempts a minute per address, failed ones included | Retrying a failing `auth` in a loop. |
| `retry_after` "Registration limit reached for this network" / "Registration limit reached" | 5 registrations a day per address; 300 a day on the server. Adding a passkey and a first `/invite-bot` each count as one. | Creating test accounts from one network. |
| `unsupported` "Passkeys are not offered to this origin"; `denied` "Frontend origin is not configured for passkeys" (a passkey session `token`) | Passkeys and passkey session resume work only from the configured origin (`https://web.apron.chat` on the demo) | A third-party client on another origin, or a native client. Use a guest, a bot token (`/invite-bot`) or a device token (`/invite-device`), which work from any origin or none. |
| `denied` "Session expired; sign in with your passkey" | A passkey session lasts 30 days, renewed on a resume once half has passed; it resumes only from the origin it was made on | A stale stored token, or a token from another origin. |
| `denied` "Identity switching requires reconnect" | One identity per connection once signed in | Calling `auth` again on a signed-in socket. Open a new connection instead. |
| `denied` "An account holds at most 8 passkeys" | 8 passkeys; 3 device tokens per account | Registering a new passkey on every sign-in. |

Guests get a new `guest_<n>` identity on every connection, and on the demo
they can only read: writes are `denied` ("Guests can only read here; sign in
with a passkey to post or join rooms"), and the guest's `you` carries
`ext.permissions` `{"write": false}`.

## Requests

### Posting and other writes

Posting covers message creates, edits, deletes, restores and moves, reaction
changes, thread creation and edits, name changes, and room joins and leaves (a
join or leave that changes nothing is free). Refusals carry `ext.limits`
`write`, except for `me`.

| Message | Limit |
| --- | --- |
| Guest posting limit reached | Guests (when the deployment lets them post): 5 a minute per address |
| Posting limit reached | 20 a minute per account (50 with any role); 30 a minute per address; 120 a minute on the server |
| Daily posting limit reached | 1,000 a day per account (4,000 with any role); 200 per guest address; 2,000 per address |
| Daily posting limit reached for the server | 10,000 a day on the server |

A request with an `id` that matches one accepted in the last 24 hours is
answered again without posting twice, and does not use posting quota. Retry a
mutation with the **same** `id`.

### Reading

| Message | Limit | Notes |
| --- | --- | --- |
| History request already in progress (`retry_after` 1) | 1 `history` request at a time per connection | Wait for the previous page. |
| History request limit reached | 20 a minute per account (burst 60); 60 a minute per address (burst 120) | `ext.limits` `read`. |
| Daily history limit reached / …for this network / …for the server | 3,000 a day per account; 6,000 per address; 40,000 on the server | `ext.limits` `read`. |
| Room listing limited | 6 `room_list` a minute per account | The first `filter: "joined"` listing after each sign-in is free. Keep the list current from `room_update` rather than polling. |

A history page holds at most 50 records (20 by default) and 256 KiB. Records
are kept for 7 days.

### Server-wide spikes

"Demo is busy with too many requests" (`retry_after`) means the whole server
passed 600 frames in a minute. The socket stays open. Notifications sent
meanwhile are dropped without a reply.

### Typing, status and push

| Method | Limit | Over the limit |
| --- | --- | --- |
| `activity` typing | 10 relayed a minute per account | Dropped, with one `~private` notice per minute. Send it as a notification (no `id`). |
| `status` idle changes | 12 a minute per connection | `retry_after` "Idle changes limited". `idle: false` is never refused. |
| `status` mute and `me` status changes | 6 a minute per account, together | `retry_after` "Mute changes limited" / "Status changes limited". |
| `push_register` | 10 a minute per account | `retry_after` "Push registrations limited". |

### Uploads

`server.ext.media` lists the accepted types and `max_bytes`: 5 MiB for
attachments and 256 KiB for avatars and custom emoji. A write URL is valid for
10 minutes. Refusals carry `ext.limits` `upload`: "Daily upload limit reached"
(20 a day per account), "Daily upload limit reached for the server" (500 a
day), and "Upload storage is full" (retry in an hour).

### Size bounds

Oversized fields get `too_large`; a frame over the limit closes the socket
(1009).

| Bound | Limit |
| --- | ---: |
| Frame | 16,384 UTF-8 bytes |
| Message text | 4,096 UTF-8 bytes |
| Message snapshot as stored | 8,192 bytes |
| JSON depth / values | 8 levels / 2,048 values |
| Request `id` | 128 bytes |
| Name | 80 code points and 320 bytes |
| Embeds per message | 4 |

Sizes are UTF-8 bytes, not JavaScript string length.

## Hard caps

These are `denied` and do not clear by waiting; something has to be removed
first.

| Cap | Limit |
| --- | ---: |
| Threads a user has started and still live | 25 |
| Threads on the server (`thread_limit`) | 100 |
| Private rooms a user has started / is a member of | 5 / 20 |
| Private rooms on the server | 100 |
| Users with a reaction on one message ("reaction limit reached for this message") | 32 |
| Emoji in one user's reaction set on one message | 8 |
| Room mutes per user | 100 |
| Registered accounts on the server | 10,000 |

A thread stops counting when everyone has left it or its history expires.

## Checklist: a well-behaved client

**Connections**

- [ ] Open one connection per signed-in client instance, and close it
      (`socket.close()`) before opening its replacement: on reconnect, sign
      out, component unmount, hot reload, and `pagehide`.
- [ ] Keep at most 3 connections per account across all tabs and devices.
      Share one connection between views where you can, and use separate
      accounts for test instances.
- [ ] Reconnect with exponential backoff and jitter (for example 1 s doubling
      to at most 60 s, ±50%), and reset it only after a connection has stayed
      up for a while.
- [ ] Honour `Retry-After` and `data.retry_after`: never retry sooner. Treat a
      1013 close as minutes of backoff, not an immediate reconnect.
- [ ] After a failed handshake in a browser, use the
      `?apron_connection_status=1` probe once to learn why, and show the
      reason rather than looping.
- [ ] Do not reconnect automatically after a 1008 close whose reason is about
      credentials (token replaced, removed, signed out); ask the user.

**Liveness**

- [ ] Read `ping` from the `server` frame and send the exact text
      `{"method":"ping"}` at that interval, from the moment the socket opens
      (before `auth` too).
- [ ] Treat a connection that has had no `pong` or other frame for about two
      intervals as dead: close it and reconnect.

**Signing in**

- [ ] Send `auth` right after the `server` frame; the server closes
      unauthenticated sockets after 30 seconds.
- [ ] Store the `token` from a passkey sign-in and resume with
      `scheme: "token"` on later connections, rather than a new ceremony.
      Register a passkey once, not on every sign-in.
- [ ] Outside the configured web origin (third-party web origins, native
      apps, bots), sign in with a bot or device token, or as a guest. Check
      `server.auth` for what the connection is offered.
- [ ] Switch identities by opening a new connection, not by calling `auth`
      again.
- [ ] Before showing a compose box, check `you`'s `ext.permissions`: a guest
      on the demo has `{"write": false}`.

**Requests**

- [ ] Wait for responses: keep fewer than 8 requests outstanding per
      connection, and at most one `history` at a time.
- [ ] Stay well under 60 frames a minute per connection. Throttle typing
      (it is a notification, at most 10 relayed a minute) and read cursors
      locally.
- [ ] Check sizes before sending: frames under 16 KiB, text under 4 KiB,
      request `id`s under 128 bytes, text frames only.
- [ ] Retry only `retry_after` errors, and retry a mutation with the same
      `id` so it is deduplicated. Do not resend a request that failed with
      `invalid_params`, `too_large` or `invalid_request`: three in a minute
      close the connection.
- [ ] When an error carries `ext.limits`, pause only that category (`read`,
      `write` or `upload`) and keep the rest of the client working.
- [ ] Keep rooms and members current from `room_update` and other pushed
      frames instead of polling `room_list` or `history`.

**Testing**

- [ ] Do not load-test the public demo. Run the server locally
      (`npx wrangler dev`, see the [guide](guide.md#local-development)),
      where you can also lower limits to test your handling of them
      ([runtime overrides](configuration.md#runtime-overrides)).
