# Nightcord chat backend

Cloudflare Worker + SQLite Durable Objects, compatible with the JSON/WebSocket
protocol used by [workers-chat-demo](https://github.com/cloudflare/workers-chat-demo).
Production hostname: `chat.nightcord.de5.net`, Worker: `nightcord-chat`.

Optional room voice uses a separate SQLite `VoiceRoom` with Cloudflare Realtime
SFU/TURN. It currently enables only `nightcord-test`, supports up to eight
members, and keeps media credentials on the server. `VOICE_REQUIRE_PASS=true`
requires SEKAI Pass; setting it to `false` explicitly allows verified cookie
guests for development tests. Start new
installations with `VOICE_MODE=off` until credentials are configured. See
[voice setup and validation](../docs/VOICE_SETUP.md) for secrets, deployment,
local browser media tests, rollback and current limitations.

## Development and deployment

```sh
cd backend
npm ci
npm run check
npm test
# Browser tests (after downloading Chromium once):
npx playwright install chromium
npm run test:browser
# Interactive development:
npm run dev
# Deploy the backend and its custom domain:
npm run deploy
```

The account ID and custom domain are in `wrangler.jsonc`. On another account,
change both before deploying. No separate identity database is required.
Set `GUEST_SIGNING_KEY` to a cryptographically random 32-byte key encoded as
64 lowercase hexadecimal characters, using `wrangler secret put GUEST_SIGNING_KEY`
before deploying. Generate the value in a password manager or write it directly
to an ignored secret file; never place it in source, shell arguments or logs.
For local development, put it in the ignored `backend/.dev.vars` file. A missing
or malformed key makes guest initialization return 503; there is no fallback key.
`GUEST_PREVIOUS_SIGNING_KEY` optionally retains the previous key during rotation.
Keep it until credentials issued with that key have expired or have been renewed;
removing it invalidates the remaining old credentials.

`CHAT_ALLOWED_ORIGINS` is an exact, comma-separated origin allowlist. The configured
origins are `https://nightcord.de5.net`, `http://localhost:8000` and
`http://127.0.0.1:8000`. Other development ports must be configured explicitly.
Both HTTP API calls and WebSocket upgrades require an
allowed `Origin`, including scripts used for smoke tests. Never use a wildcard.
Allowed HTTP localhost/127.0.0.1 origins receive a Secure, HttpOnly cookie with
`SameSite=None` so local fetch and WebSocket connections can carry it cross-site.
Browsers that block third-party cookies must allow this development use, or use
the production site instead. The production pair uses `SameSite=Lax`. Unrelated
Pages/Workers preview domains are not interchangeable with the production pair.

The `SEKAI_PASS` service binding must target the deployed
`sekai-pass` Worker in the same account. Both DO classes use SQLite and support the Workers Free plan.
`wrangler types` generates the ignored `worker-configuration.d.ts` file.

The frontend is built with `node scripts/build-pages.mjs` from the repository
root. Configure Pages to run that command with output directory `dist`.
Its build publishes browser assets only; do not upload the repository root.

## API and storage

- `GET /health`: health check.
- `POST /api/guest/session`: initialize or renew the browser guest identity.
  Call with `credentials: 'include'` before opening a guest WebSocket. Returns
  only `{id,expiresAt}` and sets an HttpOnly, Secure, host-only,
  SameSite=Lax `__Host-nightcord_guest` cookie when needed. Responses are no-store.
- `POST /api/room`: create an unguessable 64-character private-room ID.
- `GET /api/room/<name-or-id>/websocket`: WebSocket upgrade.
- First client frame: `{"name":"nickname"}` for guests, or
  `{"accessToken":"..."}` for SEKAI Pass. Later frames: `{"message":"text"}`.
  Clients may include boolean `isMobile` in the first frame; Android/native apps
  should send `isMobile: true` when their WebSocket library uses a generic User-Agent.
- The backend calls SEKAI Pass `/oauth/userinfo` through a service binding;
  opaque tokens are validated by Pass against its database and expiry.
  Browser-supplied names, IDs, avatars and authentication claims are ignored.
- Server frames include `{type:"session",user,authExpiresAt,guestExpiresAt}`, messages
  `{name,message,timestamp,user}`, presence `{joined,user}` / `{quit,userId}`,
  `{type:"profile",user}`, `{ready:true}`, or `{error,code}`.
- Account ID is `sekai:<sub>` from this fixed issuer, stable across nicknames,
  devices and reconnects. Guest ID is `guest:<uuid>`, generated server-side and
  preserved by the signed cookie across refreshes, reconnects, renames and rooms.
  It identifies possession of a browser credential, not a unique human. Clearing
  cookies, using another browser or letting the credential expire creates a new ID.
  Cookies last 180 days and renew with the same ID when fewer than 30 days remain.
  Web Locks serialize initialization across tabs where available; without that
  API, simultaneous first visits can briefly receive different IDs and converge
  on the final cookie on subsequent connections.
  The badge means account identity was checked, not email or real-name verification.
- Profile carries displayName, username, HTTPS avatarUrl and bio. Pass calls bio
  “个性签名”; profiles are edited in Pass settings and synced from your own profile card.
  Historical messages retain the profile verified at send time.
- `user.isMobile` is a boolean device hint for both guests and Pass accounts.
  The browser reports mobile device information (including iPad desktop mode),
  and the server also checks the upgrade's User-Agent and Sec-CH-UA-Mobile headers.
  Missing hints default to false. It is informational, not an authentication claim.
  Session/ready frames describe that connection; messages retain the sending
  connection's flag. Presence aggregates active connections: true while any
  connection for that identity is mobile, updated when connections join or leave.
  Authentication refresh and guest rename preserve each connection's device flag.
  Historical profiles without the field are returned with false.
- Authentication leases last five minutes; clients refresh after four minutes
  with `{"type":"auth","accessToken":"..."}`. Invalid/revoked tokens close the
  connection with 4001; sending after lease expiry requires revalidation.
  Tokens are never persisted in room storage or broadcast to other users.
- Guest connections without a valid cookie receive `guest_session_required`
  and close with 4002 before receiving roster/history. Clients retry initialization
  once, then explain that cookies must be allowed or Pass used instead.
  Credential expiry is enforced when sending. Old guest IDs have no recoverable
  ownership proof and cannot be claimed using public IDs, names or cached profiles.
- Logging into Pass uses the verified account identity; logging out restores the
  browser's guest cookie and last guest nickname. Tabs synchronize explicit
  login/logout and guest-name changes. Historical guest messages retain their
  original identity and never gain an account badge after login. Signed cookies
  are never broadcast or stored in room history. Individual cookie revocation is
  not supported by this stateless design.
- Guest nicknames allow 32 UTF-16 code units, messages 256, as in the UI.
- Joining replays the latest 100 messages. Each room retains at most 1,000
  messages; older rows are deleted as new messages arrive. Timestamps remain
  monotonic across restarts and hibernation.
- WebSockets use the Hibernation API; connection metadata lives in attachments.
  Idle connections do not require a continuously active DO or heartbeat timer.
- Limits are shared across rooms: five initial actions, then one per five
  seconds. Joining uses the IP limit; verified sessions use their account limit.
  Guest messages use both IP and stable guest-ID limits; reconnects and changing
  rooms cannot reset the latter. Cookie initialization has a separate IP bucket.
  SQLite preserves limits across eviction.
- `npm test` starts a disposable local runtime. Identity tests use an isolated
  userinfo fixture and cover forged claims, same-name guests, multiple tabs and
  token revocation. Browser tests exercise the real frontend and local WebSockets;
  interactive production OAuth login is outside this automated test.

## Migration and rollback

The frontend defaults in `nightcord-mgr.js` and `websocket-mgr.js` point to this
service. `_headers` allows its HTTPS endpoint for private-room creation.
Browser-local history stays in place because the frontend origin and room names
stay the same. Records stored by the old public demo are not imported.
Old private-room IDs belong to its DO namespace and must be recreated here.
Already-open pages switch servers after refreshing or accepting the update toast.
For the persistent-guest upgrade, configure the signing secret before deploying
the backend, then publish the matching frontend. Old open guest pages must refresh
to initialize their cookie; existing message history is retained without assigning
old anonymous messages to newly issued guest IDs.

For rollback, restore the old hostname `edge-chat-demo.cloudflareworkers.com` in
both frontend defaults, then rebuild/redeploy Pages. Keep the new Worker and its
namespaces so its history is preserved. **Do not delete a DO namespace or edit an
already-applied migration to roll back a frontend release.**

Run the same smoke tests against production using
`CHAT_BASE_URL=https://chat.nightcord.de5.net npm test` (shell syntax varies).
The tests create fresh test rooms and never send chat messages to the public
default room. Some checks intentionally exercise IP rate limits.
