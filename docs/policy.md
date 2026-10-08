# Public demo authentication and policy

The demo speaks Apron protocol **7**, advertising `history`, `edit`, `rooms`,
`reactions`, and `command`, and `server.ping` (45 seconds). `activity`
(typing) is on with the Workers Paid budgets and off with the Free ones;
`ACTIVITY` overrides either (see [plans](configuration.md#plans)), and admins
can turn it off and on with `/toggle activity`. With push configured it
also advertises `status`, and shows each user's status to others
(presence, below; `/toggle presence`). History availability uses each room's `latest_log_id` and
nullable `history_log_id`, without extension negotiation. See
[history and recovery](https://github.com/shazow/apron/blob/main/PROTOCOL.md#42-history) and the
[retention implementation specification](../SPEC.md#9-rolling-history-and-base-protocol-availability).

WebAuthn uses the canonical [optional authentication scheme](https://github.com/shazow/apron/blob/main/PROTOCOL.md#410-webauthn-authentication),
advertised through `auth: ["webauthn", "token", "guest"]` only on connections whose
origin is in `RP_ORIGINS`. Other connections advertise `auth: ["token", "guest"]`,
where `token` takes only bot tokens (below), and reject WebAuthn requests. Guest user IDs are `guest_<n>` from a
server-wide counter, with the name `Guest <n>`; a requested `user_id` or
`name` is ignored. No user ever gets a `user_id` starting with `~`, which
the protocol reserves for system identities such as `~private`. Numbers are reserved in blocks of `guestNumberBlock` (10)
with one durable write per block, are never reissued (not across restarts,
hibernation, or schema resets either), and skip the unused rest of a block
after a restart or wake, so the latest number overstates the guest count by
at most a block per wake. Server
announcements are complete replacements.

Production admits guest connections from any frontend origin, including opaque
origins and clients without Origin. This does not relax passkey verification,
IP attribution, quotas, or the fixed shared room. See the
[custom frontend example](guide.md#connecting-a-custom-frontend).

The implementation follows the current repository protocol. Local policy
within it:

- Rooms: every room is visible to every client, and a connection receives
  deliveries only for the rooms its user has joined. A new guest or passkey
  identity has joined `general`; posting to a room does not require joining it.
  Only thread rooms under `general` may be created with `room_set` (top-level
  rooms and nested threads are `denied`), which joins the creator; any
  participant may save a thread's `title`, `description` (CommonMark by
  convention), and `ext`, together at most 2 KiB, while `general` is fixed.
  The server advertises capability `ext`: `me`, and saves of messages and
  rooms, merge `ext` one level deep: each key sent replaces its value, an
  empty one (`""`, `[]`, `{}`) removes it, and keys left out stay; the size
  limits apply to the merged result. A deleted message keeps no `ext`.
  Threads always carry a title (`Thread` by default). No room is private:
  creating one with `private: true` is `unsupported`. `room_join` and
  `room_leave` work for `general` and threads, and changes arrive as
  `room_update` before the result. With another user's `user_id`, an admin
  adds or removes anyone, and a registered user their own bot; while
  `/toggle addmember` is on (the default), any registered user may also add
  anyone, and a thread's creator may remove anyone from it. Others are
  `denied`. Only registered users can be added. A thread's messages go to its
  members only. A thread that the last one in it leaves while none of its
  messages shows (all deleted or moved out, or never written) is removed. A guest's rooms last for its connection and are not logged; a
  registered identity keeps its rooms across connections, its joins and leaves
  count as posts, and each is a logged membership record delivered in
  `room_update` `memberships` (with the user's own `joined` or `left`) and
  kept in history. Joins and
  leaves are never `user` notifications. `room_list` takes `filter`,
  `parent_room_id`, and `room_id`, and with `members: true` lists each room's
  members (every connected one and at most 200 registered ones, 100 with the
  Free budgets, first by `user_id` rather than by recent activity, with
  `member_count` when that leaves some out) and their
  current objects in `users`, whose `roles` mark admins (`admin`) and bots
  (`bot`), and are `[]` for other registered users, so a lost role clears
  everywhere; it ignores `latest_log_id` and always returns a
  full listing, since guest memberships are not logged. A client that sends
  the `{"method":"ping"}` liveness ping every 45 seconds and then goes quiet
  for 150 is disconnected, so a peer that vanished without closing is not
  listed.
- Activity (where on): typing is relayed to the room's other
  members and never stored, at most 10 relays per user per minute; past that, updates are dropped and the
  sender gets one `~private` notice a minute saying so. Read cursors are
  neither kept nor relayed. Activity has no part in push: attendance is the
  separate `status` request (below).
- Commands: `/help` replies with a `~private` notice listing the commands the
  sender may run; `/invite-bot` gives a registered user a bot token (below);
  `/avatar` sets one with an attached image (below); other commands are
  `invalid_params`.
- Uploads (cap `embed:upload`, Workers Paid budgets): registered users attach
  images as `upload` embeds, written to the `write_url` in their result and
  served from the media domain once finished (see
  [SPEC section 4.3](../SPEC.md#43-uploads-and-avatars)). Only PNG, JPEG, GIF,
  and WebP are kept, at most 5 MB each (avatars 256 KB), 20 a day per user and
  500 a day in all. Images last a week and avatars a month; an avatar lasts
  while its owner keeps signing in. Every embed gets an `embed_id`, and saves
  keep embeds by it. Admins can turn uploads off and on with
  `/toggle uploads`. Clients should resize images and strip their metadata
  (such as location) before uploading: the server stores the bytes as sent.
- Status (cap `status`, with push): a user chooses a status with `me`
  `{"status": …}`: `online` (the default), `dnd` (busy: no pushes),
  `invisible` (appear `offline` to everyone), or `""` (none: show no
  status at all). Any other value is taken as `""`. With presence on, the
  `server` frame lists `server.status: ["dnd", "invisible"]`, so clients
  offer them; with it off the list is left out. Their own `you` shows
  the choice; it lasts until changed, on every device, and is kept while
  status is turned off too. Guests may choose one for their connection.
  A signed-in client sends the request `status` `{"idle": true}` when
  nobody is attending a connection (an unfocused tab, a backgrounded app)
  and `{"idle": false}` when someone is again; only that ends it. A
  connection starts attended, with nothing kept from earlier ones, and
  stays attended until it sends `{"idle": true}`, however quiet it is:
  the server never guesses. A connection may go idle 12 times a minute;
  past that `{"idle": true}` gets `retry_after`. `{"idle": false}` is never
  refused.
  `{"mute": 3600}` (or `true`, until changed) stops a signed-in user's
  pushes; `{"mute": false}` ends it (seconds are a positive integer, so `0`
  is `invalid_params`). With `room_id`, it mutes that
  room and its threads, mentions and replies included, at most 100 rooms a
  user. A mute is private: each change is sent to all the user's own
  connections as `status`, and `mute: false` when it ends, is cleared or
  runs out; after signing in, a connection is sent each mute in effect,
  after the `auth` result (adding a passkey to a signed-in connection, or
  a repeat `auth` as the same user, is not a sign-in, and sends none).
  `room_id` scopes only `mute`; one without `mute` is `invalid_params`.
  The server replies `{}` once it applies a `status`; on an error, such as
  `invalid_params` for an invalid value or an unknown room, or
  `retry_after` past a limit, nothing changes. A `status` before signing
  in is `denied`, and one without an `id` is ignored. A guest's `mute`
  is `denied`, since guests get no pushes; a guest's `idle` alone
  applies. Mute and status changes together are limited to 6 a minute;
  only changes that apply count.
- User status (presence, with push): others see each user's `status` in
  room listings' `users` (every user carries one, `offline` and `""`
  included) and in `user` notifications: `online` when someone
  attends one of their connections, `idle` when connected and nobody does,
  `offline` with no connection, `dnd` while a busy user is connected,
  `offline` for an invisible user, and `""` for one who chose none,
  connected or not. After signing in, and after the `auth` result, a
  connection is told the status of each user it shares a room with, other
  than those shown `offline` or `""`. Changes are coalesced to at
  most one a minute per user, the latest winning, and a user who closes a
  connection is shown offline (or idle) only after a minute without them,
  so a reload or a phone reconnecting shows nothing. A peer that vanishes
  without closing (a sleeping laptop) counts as gone only once it is found
  stale, 150 seconds after its last ping, and then waits the same minute.
  A status a user chooses is shown at once.
  `PRESENCE` (`true` or `false`) overrides the plan, and admins can turn it
  off and on with `/toggle presence`; turning it off tells connected
  clients to clear the statuses they were shown, and listings then show
  `""` for everyone; turning it on sends each connected client the
  statuses others see, as after signing in. Invisibility hides
  presence only: posts, reactions, typing and room joins still show.
- Push (`server.push` kind `webpush`, where VAPID keys are set): registered
  users register a browser's push subscription with `push_register`
  `{kind: "webpush", url, keys: {p256dh, auth}, push_id?}` (its
  `PushSubscription` JSON with `kind` and an optional `push_id` of 1 to 64
  letters, digits, `_` or `-`, and an optional `wake` list of scopes, of which
  `mentions` and `replies` are implemented and the default), at most 5 each
  and 10 registrations a
  minute; guests cannot. Registrations are each user's own, and lapse after
  7 days without being registered again (clients register on every
  connection). Endpoints must be public `https` hosts on an allowed push
  service (by default the browsers' own), not IP literals or internal names. A new message that
  mentions a user, or replies to their message, wakes them by push (on the
  registrations whose `wake` includes that scope) only when none of their
  connections is
  attended (every one idle, stale, or closed) and neither a mute of
  theirs nor a `dnd` status silences it: at most 10 users with
  registrations a message, once a minute per user and room, 100 pushes a day
  per recipient, 200 delivered pushes a day per sender, and 5,000 pushes a
  day in all. Guests' messages wake no one
  (see
  [SPEC section 4.4](../SPEC.md#44-push)). The push carries
  `{push_id, message}`: the registration's `push_id` when it has one, and
  the message without `log_id`, its text cut to 200 characters, without
  format or embeds, in at most 2048 bytes.
- Messages: a request without `room_id` is in `general`. A new message with
  empty text and no embeds is not logged and returns `{}`; an empty save is
  `invalid_params` (delete instead). `body.mentions` is stored as sent, and
  text is never parsed for mentions. Each embed must be an object with a
  non-empty string `kind`; other fields are stored as sent, except `og`, which
  keeps only `title` (256 code points), `description` (512), and `site_name`
  (128) as single-line text with control and bidirectional override characters
  removed, truncated with `…`. Media (`image`, `video`, `audio`) are dropped
  because the demo hosts no media and viewers would otherwise load a URL the
  sender chose; the store's `ogRemoteMedia` setting (off, not yet exposed as
  an environment variable) keeps those with an absolute http(s) `url` and
  bounded `type`, `width`, `height`, and `alt`. Other `og` properties are
  dropped, and an `og` left empty is removed. The server
  never fetches embed URLs. Author-only edit, delete, restore, and move, except
  that an `admin` or `mod` may move anyone's message (into a thread or back
  out) with a save that changes nothing but its room. `reply_to`
  must name a retained message when set or changed; resubmitting
  an unchanged reference stays valid after its target expires, and expiration
  never invalidates an accepted snapshot. The server keeps references bare.
- Reactions: at most 8 distinct emoji (each at most 64 UTF-8 bytes, no control
  characters) per user per message and 32 reacting users per message. New
  reactions on a deleted message are rejected; clearing is allowed. An
  unchanged set is accepted without a new record.
- Load: the whole server processes at most 600 frames a minute (300 with the
  Free budgets). Past that,
  requests get `retry_after` and notifications are dropped; sockets stay open.
- `me` renames registered users only; given fields replace, omitted ones stay,
  and `name: ""` removes the name (announced as `name: ""`). Registered
  users, bots included, keep an `ext` of at most 512 bytes, merged as above;
  complete user objects carry it whole, and `user` notifications only the
  keys that changed (a cleared one as `""`). A guest's `ext` is `denied`.
  With uploads, `avatar: ""` removes the avatar; other `avatar` values and
  `roles` (which only the server assigns) are ignored. A rename or an `ext`
  change sends `user` notifications to the user's other
  connections and to users who share a room with them, as does a guest's
  connection creating a new account (passkey registration or sign-up
  invite: `new` with the retired guest as `old`). A guest's connection that
  signs in to an existing account sends no such link: the guest simply
  departs (offline after a minute's grace), and the account shows only
  through its status, so an invisible one stays unseen. History pages
  carry no `users`: records keep the names they were logged with, and
  listings carry current ones. A `user_id` or `name` requested in `auth` is
  not honored.
- Records: message snapshots carry `prev_log_id` when the previous snapshot is
  still stored, and a move's snapshot also `prev_room_id`; reaction sets and
  memberships carry neither. Deletion does not redact earlier snapshots; they
  expire with the retention window.
- Ordering: `auth` finishes before any later frame on its connection, and the
  notifications a request causes on its connection come before its result,
  except a sign-in's: those come after the `auth` result, including a new
  account's logged joins and the statuses and mutes that follow a sign-in.

## Authentication policy

An authenticated guest may begin registration while retaining guest rights.
A guest is not an account, so its new credential creates a separate
registered identity; it does not transfer ownership of guest messages. A
registration on a connection already signed in as a registered user (a
passkey user or an invited user, but not a bot or the `admin` user) instead
adds the passkey to that account (protocol §4.10), at most 8 per account,
each charged as a registration against the per-IP and daily caps. The
account's other connections are told, and `/passkeys` lists the account's
passkeys and removes any but the last. A registered
identity must reconnect before signing in as another.

`server.signup` lists the schemes that create accounts: `webauthn` where
passkeys are offered, and `token`, which creates one only with an admin's
sign-up invite (`/invite <uses>`, at most 50 sign-ups within 7 days, one
live invite at a time). Each sign-up gets its own `apron_invite_` token in
the `auth` result to sign in with afterwards. Other tokens only sign in, and
`guest` is not an account.

The canonical begin/finish exchange, JSON credential encoding, and verification
rules are defined in protocol [§4.10](https://github.com/shazow/apron/blob/main/PROTOCOL.md#410-webauthn-authentication). This demo limits challenges to 120
seconds and requires user presence and verification. A new begin replaces the
pending challenge without extending the initial 30-second authentication
deadline. A matching finish attempt consumes the challenge even on failure.
A verified login or registration returns a bearer `token` (protocol [§4.10](https://github.com/shazow/apron/blob/main/PROTOCOL.md#410-webauthn-authentication),
session resume). Presenting it with `scheme: "token"` on a later connection from
the same origin resumes the registered identity without a ceremony; once less
than half of its 30 days remain, the resume renews it for another 30. The token
itself does not change. Sessions
are stored hashed in the object and swept on expiry. Signing out is local to
the client: it drops the stored token, and the connection returns as a fresh
guest.

Guests only read unless the deployment sets `GUEST_POSTING=true`
(`ext.settings.guest_posting` says which): they can list rooms, read any room's
history without joining it, and run `/help`, and stay in `general`, where
authentication put them. Posting, reacting, joining, leaving, and creating or
editing threads are writes, `denied` ("Guests can only read here; sign in with
a passkey to post or join rooms"). Every connection gets a `~private` welcome
saying so right after the `server` frame, before any `auth`, with no
`room_id` (protocol Appendix B). The `server` frame's `welcome` says the same
for the sign-in screen: how guests, passkeys, invites, and bot tokens fit
together, and how long messages are kept. There is no email sign-in.

A registered user's `/invite-bot` creates or renames their bot, `bot_<their
user_id>` named "Bot of <their name>", and returns its bearer token in a
`~private` notice to that connection only. The token signs the bot in with
`scheme: "token"` from any origin, or none; it does not expire, and the next
`/invite-bot` replaces it and closes connections that used the old one. The
first invite counts as a registration against the per-IP, daily, and identity
caps. A bot posts under the registered quotas, keeps its rooms, cannot rename
itself with `me`, and cannot invite bots. See [SPEC section 5](../SPEC.md#bots).

Guest identities last for a socket, including hibernation. Repeated guest
authentication on that socket preserves the identity. Reconnecting creates a
new guest identity, so guest ownership and deduplication cannot span reconnects.
Registered identities remain stable after verified login. Successful mutations
with IDs are deduplicated per identity for 24 hours; clients must not retry
older operations indefinitely. Matching retries do not consume posting quota,
but do consume frame and lookup resources.

## Server settings

The `server` frame advertises `ext:settings`, this implementation's
extension, and carries its data in `server.params.ext.settings`, as the
protocol's extension naming rule has it: three booleans, which a client takes
as `true` when absent. `guest_posting` says whether guests may post, react,
join and leave rooms, and create threads (`GUEST_POSTING`),
`read_cursors: false` says read markers are dropped, so clients can skip
sending them, and `add_members` says whether registered users may add others
to rooms (`/toggle addmember`). The ping interval is the standard `server.params.ping`.
The demo's 16 KiB frame policy is an explicit exception to the base protocol's
advisory 256 KiB recommendation. Payload lengths count UTF-8 bytes. Errors use
the base protocol codes; `retry_after` includes `data.retry_after`, whole
seconds rounded up. Permanent identity/thread-room ceilings return `denied`, not a fabricated replenishment time.
Every count limit the server sets (embeds per message, emoji per reaction set,
reacting users per message, push `wake` entries, invite uses, passkeys, roles,
room mutes, threads) is `denied`; a value past its size limit is `too_large`;
other rejected values are `invalid_params`. A request method sent without an
`id`, and an `id` on `activity` or `ping`, are ignored. An `auth` scheme the
server does not offer the connection (`email` always, `webauthn` from an
origin not configured for passkeys) is `unsupported`.

Guest posting allowances (with `GUEST_POSTING=true`) are shared across a normalized IP; native IPv6
addresses share a /64 bucket. Registered users also share the aggregate IP
limit. NAT users can therefore limit one another. Passkeys do not provide
one-person-one-account or prevent Sybil attacks.
