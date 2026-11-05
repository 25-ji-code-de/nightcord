# Nightcord chat backend

Cloudflare Worker + SQLite Durable Objects, compatible with the JSON/WebSocket
protocol used by [workers-chat-demo](https://github.com/cloudflare/workers-chat-demo).
Production hostname: `chat.nightcord.de5.net`, Worker: `nightcord-chat`.

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
change both before deploying. No application secrets or separate database setup
are required. The `SEKAI_PASS` service binding must target the deployed
`sekai-pass` Worker in the same account. Both DO classes use SQLite and support the Workers Free plan.
`wrangler types` generates the ignored `worker-configuration.d.ts` file.

The frontend is built with `node scripts/build-pages.mjs` from the repository
root. Configure Pages to run that command with output directory `dist`.
Its build publishes browser assets only; do not upload the repository root.

## API and storage

- `GET /health`: health check.
- `POST /api/room`: create an unguessable 64-character private-room ID.
- `GET /api/room/<name-or-id>/websocket`: WebSocket upgrade.
- First client frame: `{"name":"nickname"}` for guests, or
  `{"accessToken":"..."}` for SEKAI Pass. Later frames: `{"message":"text"}`.
- The backend calls SEKAI Pass `/oauth/userinfo` through a service binding;
  opaque tokens are validated by Pass against its database and expiry.
  Browser-supplied names, IDs, avatars and authentication claims are ignored.
- Server frames include `{type:"session",user,authExpiresAt}`, messages
  `{name,message,timestamp,user}`, presence `{joined,user}` / `{quit,userId}`,
  `{type:"profile",user}`, `{ready:true}`, or `{error,code}`.
- Account ID is `sekai:<sub>` from this fixed issuer, stable across nicknames,
  devices and reconnects. Guest ID is a fresh `guest:<uuid>` per connection.
  The badge means account identity was checked, not email or real-name verification.
- Profile carries displayName, username, HTTPS avatarUrl and bio. Pass calls bio
  “个性签名”; profiles are edited in Pass settings and synced from the account menu.
  Historical messages retain the profile verified at send time.
- Authentication leases last five minutes; clients refresh after four minutes
  with `{"type":"auth","accessToken":"..."}`. Invalid/revoked tokens close the
  connection with 4001; sending after lease expiry requires revalidation.
  Tokens are never persisted in room storage or broadcast to other users.
- Guest nicknames allow 32 UTF-16 code units, messages 256, as in the UI.
- Joining replays the latest 100 messages. Each room retains at most 1,000
  messages; older rows are deleted as new messages arrive. Timestamps remain
  monotonic across restarts and hibernation.
- WebSockets use the Hibernation API; connection metadata lives in attachments.
  Idle connections do not require a continuously active DO or heartbeat timer.
- Limits are shared across rooms: five initial actions, then one per five
  seconds. Joining uses the IP limit; verified sessions use their account limit.
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

For rollback, restore the old hostname `edge-chat-demo.cloudflareworkers.com` in
both frontend defaults, then rebuild/redeploy Pages. Keep the new Worker and its
namespaces so its history is preserved. **Do not delete a DO namespace or edit an
already-applied migration to roll back a frontend release.**

Run the same smoke tests against production using
`CHAT_BASE_URL=https://chat.nightcord.de5.net npm test` (shell syntax varies).
The tests create fresh test rooms and never send chat messages to the public
default room. Some checks intentionally exercise IP rate limits.
