# Public demo authentication and policy

The demo speaks Apron protocol **9**. Its `server` frame advertises the
capabilities `history`, `edit`, `rooms`, `reactions`, `command`, and `ext`,
the extensions `ext:settings`, `ext:limits`, and `ext:permissions`, and
`server.ping` (45 seconds). Others depend on the deployment:

- `activity` (typing) is on with the Workers Paid budgets and off with the
  Free ones; `ACTIVITY` overrides either (see
  [plans](configuration.md#plans)), and admins can turn it off and on with
  `/toggle activity`.
- `embed:upload` and `ext:media` where uploads are configured (below).
- `status` where push is configured, which also shows each user's status to
  others (presence, below; `/toggle presence`).
- `ext:emoji` once the custom emoji catalog has an emoji (below).

Server announcements are complete replacements. History availability uses
each room's `latest_log_id` and nullable `history_log_id`, without extension
negotiation. See
[history and recovery](https://github.com/shazow/apron/blob/main/PROTOCOL.md#43-history) and the
[retention implementation specification](../SPEC.md#9-rolling-history-and-base-protocol-availability).

WebAuthn uses the canonical [optional authentication scheme](https://github.com/shazow/apron/blob/main/PROTOCOL.md#410-webauthn-authentication),
advertised through `auth: ["webauthn", "token", "guest"]` only on connections whose
origin is in `RP_ORIGINS`. Other connections advertise `auth: ["token", "guest"]`,
where `token` takes bot, device, and invite tokens but not passkey sessions
(below), and reject WebAuthn requests as `unsupported`. Guest user IDs are
`guest_<n>` from a server-wide counter, with the name `Guest <n>`; a
requested `user_id` or `name` is ignored. Numbers are never reissued, so they
have gaps (see [SPEC section 5](../SPEC.md#guest)). No user ever gets a
`user_id` starting with `~`, which the protocol reserves for system
identities such as `~private`.

Production admits guest connections from any frontend origin, including opaque
origins and clients without Origin. This does not relax passkey verification,
IP attribution, quotas, or the shared `general` room. See the
[custom frontend example](guide.md#connecting-a-custom-frontend).

The implementation follows the current repository protocol. Local policy
within it:

- Rooms: every public room is visible to every client, and a connection
  receives deliveries only for the rooms its user has joined. A new guest or passkey
  identity has joined `general`; posting to a room does not require joining it.
  Anyone may create a thread under a top-level room with `room_set`, and an
  `admin` or `mod` may also create a top-level room (others' are `denied`, as
  are nested threads); creating joins the creator. Any participant may save a
  thread's `title`, `description` (CommonMark by convention), and `ext`,
  together at most 2 KiB; an `admin` or `mod` may save a created top-level
  room's, and only an admin `general`'s. Threads and public rooms always
  carry a title (`Thread` or `Room` by default). Created top-level rooms are
  permanent like `general`; at most 16 are created, and they count against
  the 100-thread ceiling.
- `ext`: `me`, and saves of messages and rooms, merge `ext` one level deep:
  each key sent replaces its value, an empty one (`""`, `[]`, `{}`) removes
  it, and keys left out stay; the size limits apply to the merged result. A
  deleted message keeps no `ext`.
- Private rooms: a registered user may create a private room (`room_set` with
  `private: true`, no parent; its `room_id` is `private_<log id>`, and its
  record carries `private: true`): only its members see it, list it, read
  it, post in it, or add others to it, whether or not `/toggle addmember` is
  on, and nobody joins one by themselves. To anyone else every request about
  it, or one of its messages, is answered as for one that does not exist.
  Its messages are not moved in or out, nor replied to from elsewhere. It has
  no threads, and no title unless given one. It goes when its last member
  leaves or its history expires. One user may have started 5 live private
  rooms and be in 20; the server holds 100.
- Memberships: `room_join` and `room_leave` work for every room, and changes arrive as
  `room_update` before the result. With another user's `user_id`, an admin
  adds or removes anyone, and a registered user their own bot; while
  `/toggle addmember` is on (the default), any registered user but a bot may
  also add anyone, and a thread's creator may remove anyone from it. Others are
  `denied`. Only registered users can be added. A thread's messages go to its
  members only. A thread is removed, with its messages, when the last one in
  it leaves. Joins and leaves that change something count as posts, a
  guest's included. A guest's rooms last for its connection and are not
  logged; a registered identity keeps its rooms across connections, and each
  of its joins and leaves is a logged membership record delivered in
  `room_update` `memberships` (with the user's own `joined` or `left`) and
  kept in history. Joins and leaves are never `user` notifications.
- Listings: `room_list` takes `filter`, `parent_room_id`, `room_id`, and
  `user_id`, and with `members: true` lists each room's members (every
  connected one and at most 200 registered ones, 100 with the Free budgets,
  in `user_id` order, with `member_count` when that leaves some out; with
  `user_id`, only that member) and their current objects in `users`, whose
  `roles` list each registered user's roles (`[]` for none), so a lost role
  clears everywhere. It ignores `latest_log_id` and always returns a full
  listing, since guest memberships are not logged. A connection quiet for
  150 seconds after its last `{"method":"ping"}`, or for 15 minutes if it
  never pinged, is closed as stale, so a peer that vanished without closing
  is not listed (see [liveness](limits.md#liveness-and-stale-connections)).
- Activity (where on): typing is relayed to the room's other
  members and never stored, at most 10 relays per user per minute; past that, updates are dropped and the
  sender gets one `~private` notice a minute saying so. A registered user's
  read cursor (`read_message_id`) is relayed to their own other connections
  only, never to others (no read receipts), and kept for the rooms they
  joined: written at most once a minute per connection and when it closes,
  and sent back after their next listing, so another device, or a reload,
  shows the same rooms read. A guest's is dropped. Activity has no part in
  push: attendance is the separate `status` request (below).
- Commands: `/help` replies with a `~private` notice listing the commands the
  sender may run. Registered users other than bots have `/invite-bot` (a bot
  token), `/invite-device add|remove [<id>]` (a token for another device), `/passkeys`,
  and, with uploads, `/avatar` (all below); those with the role `admin`,
  `mod`, or `friend` also have `/emoji add|remove :name:` (custom emoji,
  below). Admins have their own (see [SPEC section 5](../SPEC.md#admins)),
  among them `/server`, which sets the server's title, description and
  avatar (below), and `/toggle activity|uploads|presence|addmember`. An
  unknown command is `invalid_params`, and one the sender may not run
  `denied`.
- Uploads (cap `embed:upload`, Workers Paid budgets): registered users attach
  images and voice clips as `upload` embeds, written to the `write_url` in their result and
  served from the media domain once finished (see
  [SPEC section 4.3](../SPEC.md#43-uploads-and-avatars)). Only PNG, JPEG, GIF,
  and WebP images and WebM, Ogg, and MP4 audio are kept (avatars are images
  only), at most 5 MB each (avatars and custom emoji 256 KB), 20 a day per
  user and 500 a day in all, all kinds together. Attachments last a week and
  avatars a month; an avatar lasts
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
  A signed-in client sends the request `status` `{"idle": 300}`, the
  seconds since anyone attended it, when nobody is attending a connection
  (an unfocused tab, a backgrounded app) and `{"idle": false}` when someone
  is again; only that ends it. A connection starts attended, with nothing
  kept from earlier ones, and stays attended until it sends `idle` with
  seconds, however quiet it is: the server never guesses.
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
  The server replies `{}` once it applies a `status`; on an error (an
  invalid value, an unknown room, a limit) nothing changes. A `status` before signing
  in is `denied`, and one without an `id` is ignored. A guest's `mute`
  is `denied`, since guests get no pushes; a guest's `idle` alone
  applies. Going idle, and mute and status changes, are rate limited (see
  [limits](limits.md#typing-status-and-push)); only changes that apply
  count, and `{"idle": false}` is never refused.
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
  stale (Listings, above), and then waits the same minute.
  A status a user chooses is shown at once. A user shown `offline` carries
  `seen`, when they went offline (when their last connection closed, or
  when they chose `invisible`), in the notification and in later listings;
  an invisible user's connections never move it, and their own `you` never
  carries it. It is recorded at most once in 10 minutes, so it may be up to
  10 minutes earlier than the real departure, even if others saw them
  online in between (a deviation from protocol §4.5.2; see
  [SPEC section 4.4](../SPEC.md#44-push), User status). Users with none
  recorded are shown `offline` without `seen`.
  `PRESENCE` (`true` or `false`) overrides the plan, and admins can turn it
  off and on with `/toggle presence`; turning it off tells connected
  clients to clear the statuses they were shown, and listings then show
  `""` for everyone; turning it on sends each connected client the
  statuses others see, as after signing in, and users then shown `offline`
  carry the time it came on as `seen`, unless a later one is recorded.
  Invisibility hides
  presence only: posts, reactions, typing and room joins still show.
- Push (`server.push` kind `webpush`, where VAPID keys are set): registered
  users, bots included, register a browser's push subscription with
  `push_register` `{kind: "webpush", url, keys: {p256dh, auth}, push_id?,
  wake?}` (its `PushSubscription` JSON with `kind`, an optional `push_id` of
  1 to 64 letters, digits, `_` or `-`, and an optional `wake` list of
  scopes), at most 5 each; guests cannot. The scopes are `mentions` and
  `replies` (the default), `private`, and `joined`, which is kept only for an
  `admin` or `mod` (not an owner's bot) and listed in `server.push.wake` only
  on their connections; a sign-in or role change that changes that sends a
  new `server` frame. Registrations are each user's own, and lapse after 7
  days without being registered again (clients register on every
  connection). Endpoints must be public `https` hosts on an allowed push
  service (the browsers' own, plus `push.stupidtech.net` on the demo), not
  IP literals or internal names.
- Wakes: a registered user's new message wakes, on the registrations whose
  `wake` includes the scope, the author of the message it replies to
  (`replies`), the users in its `body.mentions` (`mentions`), the members of
  its private room (`private`), and, for any message in a room (or a thread
  of one) they are a member of, an `admin` or `mod` who kept `joined` (at
  `normal` urgency, after everyone else the message wakes). Guests' messages
  wake no one, and a mute or a `dnd` status silences the user. The push
  waits 30 seconds first, and is dropped if the user comes back
  (`{"idle": false}`), posts in that room, or moves a read cursor past it
  meanwhile; a message edited or deleted during the wait is pushed as it is
  then, or not at all. A user with an attended connection is not pushed:
  the wake is held (a `joined` one is dropped), and if their last attended
  connection goes idle within 10 minutes, the newest held wake is pushed,
  one push for them all.
- Push allowances: at most 10 users a message, once a minute per user and
  room, 100 pushes a day per recipient, 200 a day per sender (delivered or
  not), and 5,000 a day in all. A push only for `joined` goes at most once
  every 5 minutes per moderator and room, at most 20 a day per moderator
  apart from their 100, and is charged to no sender (see
  [SPEC section 4.4](../SPEC.md#44-push)).
- Push payload: `{push_id, unread, message}`: the registration's `push_id`
  when it has one; `unread`, the pushes the user has been sent since they
  last came back (signed in, attended a connection, or moved a read
  cursor), left out of a push only for `joined`; and the message without
  `log_id`, its text cut to 200 characters, without format or embeds, in at
  most 2048 bytes.
- Messages: a request without `room_id` is in `general`. A new message with
  empty text and no embeds is not logged and returns `{}`; an empty save is
  `invalid_params` (delete instead). `body.mentions` is stored as sent, and
  text is never parsed for mentions. Each embed must be an object with a
  non-empty string `kind`; other fields are stored as sent, except `og`, which
  keeps only `title` (256 code points), `description` (512), and `site_name`
  (128) as single-line text with control and bidirectional override characters
  removed, truncated with `…`. Media (`image`, `video`, `audio`) are dropped
  because viewers would otherwise load a URL the sender chose. Other `og`
  properties are dropped, and an `og` left empty is removed. The server
  never fetches embed URLs. Author-only edit, delete, restore, and move, except
  that an `admin`, `mod` or `threader` may move anyone's message (into a thread or back
  out) with a save that changes nothing but its room. `reply_to`
  must name a retained message when set or changed; resubmitting
  an unchanged reference stays valid after its target expires, and expiration
  never invalidates an accepted snapshot. The server keeps references bare.
- Reactions: at most 8 distinct emoji (each at most 64 UTF-8 bytes, no control
  characters) per user per message and 32 reacting users per message.
  Reactions are stored fully qualified, and entries that differ only in
  U+FE0F are one entry. A custom emoji key (`:name:`) must be in the catalog
  or already in the user's set on that message, else the request is
  `invalid_params`. New reactions on a deleted message are rejected; clearing
  is allowed. An unchanged set is accepted without a new record.
- Load: the whole server processes at most 600 frames a minute (300 with the
  Free budgets). Past that, requests get `retry_after` and notifications are
  dropped; sockets stay open. Every other limit is in
  [limits](limits.md).
- `me` renames registered users other than bots; given fields replace, omitted ones stay,
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
sign-up invite (`/invite-code <uses>`, at most 50 sign-ups within 7 days, one
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
itself does not change. Sessions are stored hashed. Signing out is local to
the client: it drops the stored token, and the connection returns as a fresh
guest.

Guests only read unless the deployment sets `GUEST_POSTING=true` (a guest's
own `you` says which, with `ext.permissions` `{"write": false}`): they can list rooms, read any room's
history without joining it, and run `/help`, and stay in `general`, where
authentication put them. Posting, reacting, joining, leaving, and creating or
editing threads are writes, `denied` ("Guests can only read here; sign in with
a passkey to post or join rooms"). Every connection gets a `~private` welcome
right after the `server` frame, before any `auth`, with no `room_id`
(protocol Appendix B): the server version, and, while guests only read, that
they do. The `server` frame's `welcome`, for the sign-in screen, is
`general`'s description; while it has none, it is a summary of how guests,
passkeys, invites, and bot tokens fit together, and how long messages are
kept. There is no email or external sign-in.

A registered user's `/invite-bot` creates or renames their bot, `bot_<their
user_id>` named "Bot of <their name>", and returns its bearer token in a
`~private` notice to that connection only. The token signs the bot in with
`scheme: "token"` from any origin, or none; it does not expire, and the next
`/invite-bot` replaces it and closes connections that used the old one. The
first invite counts as a registration against the per-IP, daily, and identity
caps. A bot posts under the registered quotas, keeps its rooms, cannot rename
itself with `me`, and cannot invite bots. An account whose only role is
`bot` that neither signs in nor posts for 7 days is signed out: its tokens
are revoked and it leaves its rooms, while its account and posts stay. See
[SPEC section 5](../SPEC.md#bots).

A registered user's `/invite-device add [<id>]` (not a bot's or the `admin`
user's) returns a bearer token that signs in as them on another device, in a
`~private` notice to that connection only. It signs in with `scheme: "token"`
from any origin, or none, and does not expire. A user holds at most 5, each
under its own id (1 to 32 letters, digits, `_`, `.` or `-`, starting with
a letter or digit; `device_1`, `device_2`, … when none is given); the same id
again replaces its token, closes the user's other connections that used the
old one, and drops the user's push registrations. `/invite-device remove <id>`
revokes a token the same way. `/rename` moves the tokens
and `/purge` revokes them. See [SPEC section 5](../SPEC.md#devices).

Guest identities last for a socket, including hibernation. Repeated guest
authentication on that socket preserves the identity. Reconnecting creates a
new guest identity, so guest ownership and deduplication cannot span reconnects.
Registered identities remain stable after verified login. Successful mutations
with IDs are deduplicated per identity for 24 hours; clients must not retry
older operations indefinitely. Matching retries do not consume posting quota,
but do consume frame and lookup resources.

Guest posting allowances (with `GUEST_POSTING=true`) are shared across a
normalized IP; native IPv6 addresses share a /56 bucket. Registered users
also share the aggregate IP limit. NAT users can therefore limit one another.
Passkeys do not provide one-person-one-account or prevent Sybil attacks.

## Server settings and extensions

The `server` frame carries `title`, `description` and `avatar` (protocol
§3.1), so clients can show which server this is: each as an admin set it
with `/server`, else from `SERVER_TITLE`, `SERVER_DESCRIPTION` and
`SERVER_AVATAR`, else, for the description, `general`'s description where it
is at most 500 bytes, else left out (`RP_NAME` is for passkey prompts only).
Each change sends every connection a new `server` frame (see
[configuration](configuration.md#server-title-description-and-avatar)).

Every extension the frame advertises is defined in
[EXTENSIONS.md](https://github.com/shazow/apron/blob/main/EXTENSIONS.md):

- `ext:settings` carries `server.params.ext.settings`: `read_cursors`,
  whether a registered user's read cursors are kept (with activity), and
  `private_rooms`, the number of private rooms one user may be in.
- `ext:media`, where uploads are configured, carries
  `server.params.ext.media`: the media origin when it is not the server's,
  and each type an attachment, avatar or custom emoji upload keeps with its
  largest size; images are never scaled, so no `max_side` is sent.
- `ext:permissions` puts `ext.permissions` on the user's own `you` only, an
  object of the keys that differ from their defaults: `write: false` for a
  guest while guests only read, `add_members` for an admin, or any
  registered user but a bot while `addmember` is on, and `move_any` for a
  registered user with `admin`, `mod` or `threader` (not an owner's bot). It
  is the server's: `me` ignores an `ext.permissions` it writes.
- `ext:emoji`, once a custom emoji has been added, carries
  `server.params.ext.emoji.catalog_url`, the catalog's URL on the media
  origin. Registered users with the role `admin`, `mod` or `friend`, other
  than bots, add an emoji with `/emoji add :name:` and one attached image,
  and remove one with `/emoji remove :name:`. Custom emoji stay until
  removed, at most 500. Each change gives the catalog a new URL and sends
  every connection a new `server` frame.
- `ext:limits` is on errors (below).

## Errors

The demo's 16 KiB frame policy is an explicit exception to the base protocol's
advisory 256 KiB recommendation. Payload lengths count UTF-8 bytes. Errors use
the base protocol codes; `retry_after` includes `data.retry_after`, whole
seconds rounded up, and, when a reading, posting or upload limit refused the
request, `data.ext.limits`: `read`, `write` or `upload` (a refused `me`
names none), which tells clients what to hold back; they ignore a value
they do not know. A `retry_after` message names the limit, never its amount
or delay. Permanent identity/thread-room ceilings return `denied`, not a
fabricated replenishment time. Every count limit the server sets (embeds per
message, emoji per reaction set, reacting users per message, push `wake`
entries, invite uses, passkeys, roles, room mutes, threads) is `denied`; a
value past its size limit is `too_large`; other rejected values are
`invalid_params`. A request method sent without an `id`, and an `id` on
`activity` or `ping`, are ignored. An `auth` scheme the server does not
offer the connection (`email` and `external` always, `webauthn` from an
origin not configured for passkeys) is `unsupported`. Each limit, its error
text, and what a client should do about it are in [limits](limits.md).
