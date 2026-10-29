# Apron on Cloudflare Workers

The public demo server for the [Apron](https://github.com/shazow/apron) chat
protocol. It runs the whole chat — rooms, threads, reactions,
history, passkeys, and bots — in a single SQLite Durable Object, and stays
inside the usage included with the **Cloudflare Workers Paid** ($5/month) plan.
The **Workers Free** budgets are kept in [`src/plans/free.ts`](src/plans/free.ts)
for a zero-overage deployment.

**Try it:** [web.apron.chat](https://web.apron.chat) &nbsp;·&nbsp;
**Connect:** `wss://server.apron.chat/`

## Highlights

- **One Durable Object, hibernating WebSockets.** A permanent `general` room,
  rooms admins and mods create, and thread rooms, with complete-snapshot
  history, edits, moves, and emoji reactions.
- **Guests and passkeys.** Anyone can read as a guest; sign in with a passkey
  to post, and run `/invite-bot` to get a token for your own bot.
- **Private rooms for DMs.** Signed-in users start private rooms
  (`private: true`) that only their members see, and add people to them;
  everyone else is answered as if the room did not exist. A room goes when
  its last member leaves or its history expires; see
  [limits](docs/limits.md#hard-caps) for how many each user may have.
- **Images, voice clips and avatars.** Signed-in users attach images and
  voice clips and set avatars (`embed:upload`), stored in R2 within its free
  tier for a week (avatars a month). Admins, mods and friends add custom
  emoji with `/emoji add :name:`, which everyone can react with
  (`ext:emoji`).
- **Push for mentions and replies.** With VAPID keys set, a mention or a
  reply wakes a signed-in user whose every tab is idle or closed, through
  their browser's Web Push service (`server.push` kind `webpush`), unless
  they muted it with `status`, everywhere or in that room, or chose `dnd`.
  The push waits 30 seconds first, and doesn't go if they come back or
  post in that room meanwhile. Admins and mods can also ask to be woken for
  every message in the rooms they joined (`joined`).
- **Who's around.** With push on, member lists show each user as online,
  idle, busy (`dnd`), or offline, with when they were last `seen`, and a
  user can choose `dnd`, `invisible`, or no status at all with `me`. A
  chosen status shows at once; other changes are coalesced to one a minute
  per user, and `seen` may be up to 10 minutes early (see
  [user status](docs/configuration.md#user-status-presence)).
- **Bring your own frontend.** Guest connections are accepted from any
  origin — even `localhost` or a browser console.
- **Built to stay inside its plan.** Every operation is metered against
  budgets sized under the plan's included usage, with rolling retention
  (7 days on Workers Paid, which production runs, and one day on Workers
  Free) and graceful read-only degradation when budgets run out.

## Quick start

```sh
npm ci
npx wrangler dev --port 8080
```

Then run the web client from
[apron-chat/apron-web](https://github.com/apron-chat/apron-web) with
`npm run dev` (see its README); its dev server proxies `/ws` to port 8080.
Open <http://localhost:5173>. Check your work with:

```sh
npm run typecheck
npm test
```

Or say hello from any browser console:

```js
const socket = new WebSocket('wss://server.apron.chat/');
socket.onmessage = ({ data }) => {
  const frame = JSON.parse(data);
  console.log(frame);
  if (frame.method === 'server') {
    socket.send(JSON.stringify({ id: 'auth', method: 'auth', params: { scheme: 'guest' } }));
    socket.send(JSON.stringify({ id: 'history', method: 'history', params: { room_id: 'general' } }));
  }
};
```

## Documentation

| | |
| --- | --- |
| [Developer and operator guide](docs/guide.md) | Local development, custom frontends, bots, user-visible policies, deployment, and operations |
| [Implementation specification](SPEC.md) | The protocol contract, architecture, and limits |
| [Authentication and policy](docs/policy.md) | Guests, passkeys, and demo policy |
| [Limits for client developers](docs/limits.md) | Every limit a client can hit, how it shows up, and a checklist for a well-behaved client |
| [Configuration reference](docs/configuration.md) | Every variable, secret and budget |
| [Edge admission](docs/edge-admission.md) | WAF rules and the quota-exhaustion runbook |
| [Cost report](docs/cost-report.md) | Measured resource bounds and assumptions |

## License

[MIT](LICENSE)
