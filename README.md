# quickmeet

1-to-1 video calls from a single binary. The
[LiveKit](https://github.com/livekit/livekit) SFU runs inside the app
process; the browser talks to it directly for media and to the app for
pages, rooms and join tokens. Written in
[let-go](https://github.com/nooga/let-go), built with
[lgx](https://github.com/abogoyavlensky/lgx).

Status: foundation. A room can be created, joined with camera and
microphone, and two people can talk. Every push to master deploys a
staging instance (see "Deployment"). Accounts, contacts, history and an
install guide are on the roadmap ([docs/ROADMAP.md](docs/ROADMAP.md)).
What we have learned about the stack is in
[docs/KNOWLEDGE.md](docs/KNOWLEDGE.md).

## Run

Needs lgx 0.4.2 or newer and the Go toolchain on `PATH` (`.mise.toml`
pins both). The first run builds an `lg` with LiveKit and sqlite linked
in, which takes a minute; every run after that is a cache hit. Builds are
static (`CGO_ENABLED=0`, set in `.mise.toml`) so the binary runs on
Alpine; outside mise, export it yourself.

```
lgx run                 # http://localhost:8080, quickmeet.db in the cwd
lgx test                # handler, migrations and the whole system
lgx e2e                 # two headless browsers in a real call (see below)
lgx build && ./bin/quickmeet
lgx smoke               # a two-browser call against a running instance (QM_URL)
```

Open http://localhost:8080, sign up (any email, no verification), click
"New call", open the room link in a second window, join from both.
Starting a call takes an account; joining one takes only the link.
The room page shows a lobby first: a preview of your camera, pickers for
the camera and microphone, and who is already in the room. Rooms are
permanent and hold two people; a third person is told the call is
full. A link is created once and reused for every call with that person.

Signed in, the landing page lists your rooms: the ones you made and the
ones you joined from a link, each with a name you can give it, who is in
it right now, and its link to copy. History (`/history`) lists your
calls with who, when and how long, recorded from the SFU's own events.
Guests have neither: no account, no list, no history.

## Browser tests

The unit tests stop at the handler. The browser tests drive the whole
thing: `lgx e2e` builds `bin/quickmeet`, starts it on test ports (app
8099, SFU 7899, UDP 50200-50300, a throwaway database under `e2e/.tmp`),
opens two headless Chromiums with fake cameras and microphones on the
same room link, and checks that each side sees and hears the other:
the remote video plays, decoded frames and audio packets keep growing,
nothing is lost, and leaving is noticed. Other specs cover accounts
(sign up, sign in, sign out, settings, a guest needing none), the lobby
(preview, device pickers, who is there, a third person refused), the
call's states (waiting, reconnecting, a lost connection) and the layout
on phone-sized and short viewports by bounding boxes. Playwright stops
the app when the run ends, so it coexists with an `lgx run` on the
default ports.

```
lgx e2e-setup           # once: npm ci and the headless Chromium
lgx e2e                 # build, run the specs, stop the app
```

Needs Node 24 (`.mise.toml` pins it). The report lands in
`e2e/playwright-report/index.html`; failed tests keep a trace under
`e2e/test-results/`. Playwright only installs its browser on
distributions it recognises; on Ubuntu 26.04 run the setup as
`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 lgx e2e-setup`
(the resulting browser runs with no missing libraries). CI runs both
suites on every push (`.github/workflows/test.yml`); on master they run
as the first job of the deploy.

`lgx smoke` runs the same kind of call against any running instance,
local or deployed, and watches it for `QM_SECS` seconds, printing every
change of state: the check after an install, and the way to see what a
restart or deploy does to a live call. It reads `QM_URL`, `QM_EMAIL` and
`QM_PASSWORD` (the host's account; `QM_SIGNUP=1` signs it up first) and
exits 0 when both sides end the run in the call with media flowing
(`e2e/smoke.mjs`).

`livekit-client` is vendored into `resources/public/` and served from the
binary, so a call page has no CDN dependency. To bump it, change the
version in the `vendor-livekit-client` task in `lgx.edn` and run
`lgx vendor-livekit-client`. The typeface (Onest, OFL) is vendored the
same way, as base64 inside `fonts.css`: `lgx vendor-fonts`, version in
`scripts/vendor-fonts.mjs`.

## Deployment

To run quickmeet on your own server, follow
[`docs/INSTALL.md`](docs/INSTALL.md): the release binary under systemd,
Caddy in front for TLS, two media ports open. Releases are built by
`.github/workflows/release.yml` when a `v*` tag is pushed: a tarball with
the static linux/amd64 binary, the files the guide installs (`deploy/`)
and the guide itself, plus its SHA-256. There is no macOS build.

On SIGTERM (systemd, `docker stop`) the app stops serving, closes the
calls that were on in history and exits; it leaves the SFU to die with
the process, so a call in progress shows "Reconnecting…" and resumes
against the new process by itself, typically within 20 seconds. After
about 45 seconds away the browsers give up and return to the lobby.

The rest of this section is the staging deployment. A push to master runs the tests, then `.github/workflows/deploy.yml`:
it builds `bin/quickmeet`, checks that it is statically linked, wraps it
in the `Dockerfile` (Alpine plus the binary, nothing built inside the
image), smoke-tests the image, and deploys `compose.yaml` with
[uncloud](https://github.com/psviderski/uncloud) (`uc`) to the
`unison-staging` cluster, at `https://quickmeet.absky.dev`.

- One hostname. uncloud's Caddy terminates TLS and routes `/rtc*` to the
  SFU's port 7880 and everything else to the app's port 8080. The app
  sees `x-forwarded-proto` and hands browsers `wss://<host>` as the
  signalling URL.
- Media cannot go through Caddy: the SFU takes all UDP media on one port,
  7882, plus ICE over TCP on 7881, both published in uncloud's host mode
  and advertised with the host's public IP (found over STUN). Both must
  be open in the server's firewall.
- The database is `/root/quickmeet-db/quickmeet.db` on the server, bind
  mounted at `/app/db`. It is disposable for now.

Repository settings the workflow needs: variables `SERVER_IP`,
`APP_DOMAIN` (`quickmeet.absky.dev`) and, optionally, `ALLOWED_EMAILS`;
secrets `SSH_PRIVATE_KEY` (a key the server accepts for root),
`LIVEKIT_API_KEY` (any short identifier) and `LIVEKIT_API_SECRET` (32+
random characters, e.g. `openssl rand -hex 32`). DNS for `APP_DOMAIN`
points at the server.

Starting a meeting takes an account. Staging's `ALLOWED_EMAILS` holds
the operator's address, so nobody else can sign up or sign in there;
unset, sign-up would be open. Rooms are permanent and hold two people.
Sign-in is limited to 10 attempts a minute and sign-up to 10 an hour per
client address, room creation to 60 an hour per account; over a limit
the answer is 429 with `Retry-After`.

## Configuration

Every setting is an environment variable with a development default.
The defaults bind the SFU to loopback with a well-known key: fine on a
laptop. Once the SFU is reachable from other machines (`LIVEKIT_BIND`
off loopback, `LIVEKIT_USE_EXTERNAL_IP=true` or `LIVEKIT_PUBLIC_URL`
set), the app refuses to start with that key's secret and says so.

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | the app's http port |
| `HOST` | unset | the app's bind address: unset or `0.0.0.0` for every interface, `127.0.0.1` for loopback only (a proxy on the same box). Nothing else: the SFU posts its webhooks to `127.0.0.1` |
| `RATE_LIMIT` | `true` | `false` switches the rate limits off (the browser tests do) |
| `DB_PATH` | `quickmeet.db` | the sqlite file |
| `ALLOWED_EMAILS` | unset | comma-separated addresses that may sign up, sign in and keep a session; unset, sign-up is open |
| `LIVEKIT_PORT` | `7880` | SFU http and signalling port |
| `LIVEKIT_BIND` | `127.0.0.1` | SFU bind address; `0.0.0.0` when a proxy reaches it from another host or container |
| `LIVEKIT_RTC_TCP_PORT` | `7881` | ICE over TCP |
| `LIVEKIT_UDP_START`, `LIVEKIT_UDP_END` | `50000`, `50100` | media port range |
| `LIVEKIT_UDP_PORT` | unset | when set, all media over this one UDP port; the range is ignored |
| `LIVEKIT_USE_EXTERNAL_IP` | `false` | advertise the public IP in ICE candidates |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | dev values | token signing; the secret must be 32+ characters, and the dev one is refused on an exposed SFU |
| `LIVEKIT_LOG_LEVEL` | `warn` | |
| `LIVEKIT_PUBLIC_URL` | unset | the signalling URL handed to browsers; otherwise derived from the request |

## Layout

```
main.lg                        starts the system, waits on the http server, shuts down on SIGTERM
src/quickmeet/system.lg        the integrant config from the environment
src/quickmeet/db.lg            ::conn (open + migrate), queries
src/quickmeet/migrations.lg    the schema history (ragtime over sqlite)
src/quickmeet/routes.lg        ::handler: pages, accounts, rooms, join tokens, the two-person rule, the webhook, rate limits
src/quickmeet/ratelimit.lg     fixed-window rate limits in memory
src/quickmeet/history.lg       call history from the SFU's webhook events
src/quickmeet/auth.lg          sign-up, sign-in, sessions, the allowlist, the session cookie
src/quickmeet/password.lg      bcrypt (golang.org/x/crypto/bcrypt as a :go/interop coord)
src/quickmeet/id.lg            random ids for rooms, users and sessions
src/quickmeet/sfu.lg           asks the embedded SFU who is in a room, and which rooms are live (twirp over loopback)
src/quickmeet/server.lg        ::http: http/start on init, http/stop on halt
resources/public/              index, room, history, signup, signin, settings pages; app.css; ui.js (icons, avatars); vendored livekit-client and font
scripts/vendor-fonts.mjs       writes resources/public/fonts.css from the pinned Onest release
test/quickmeet/                routes and auth over a temp db; migrations; password; the full system
e2e/                           Playwright: two browsers in a call against bin/quickmeet; smoke.mjs for a deployed one
Dockerfile                     the runtime image around bin/quickmeet
compose.yaml                   the uncloud service: Caddy routes, media ports, secrets
deploy/                        the single-box install: systemd unit, Caddyfile, environment example
.github/workflows/             test.yml on every push; deploy.yml on master; release.yml on a v* tag
docs/                          INSTALL.md, ROADMAP.md, KNOWLEDGE.md
```

The components chain `server -> handler -> db` and `server -> livekit`,
so integrant starts the database and the SFU first and halts them last.

## API

```
POST /api/auth/signup            {"email", "password"}
                                 -> 201 {"email", "display_name"} + Set-Cookie: session=...
                                  | 400 {"error": "<what is wrong>"} | 403 {"error": "not allowed"} | 409 {"error": "exists"} | 429
POST /api/auth/signin            {"email", "password"}
                                 -> 200 {"email", "display_name"} + Set-Cookie | 401 {"error": "invalid email or password"} | 403 | 429
POST /api/auth/signout           -> 200 {} + Set-Cookie clearing the session
GET  /api/me                     -> 200 {"email", "display_name"} | 401
POST /api/me                     {"display_name"} -> 200 {"email", "display_name"} | 400 | 401
POST /api/rooms                  -> 201 {"id": "0123456789ab"} | 401 (needs a session) | 429
GET  /api/rooms                  -> 200 [{"id", "name", "created_at", "owner": bool, "present": n}] | 401
POST /api/rooms/:id              {"name"} (blank clears) -> 200 the room | 400 | 401 | 403 (not the owner) | 404
DELETE /api/rooms/:id            -> 200 {} | 401 | 403 | 404
GET  /api/rooms/:id              -> 200 {"id", "name", "created_at", "participants": [{"identity", "name"}]} | 404
POST /api/rooms/:id/token        {"identity": "alice"}   (the name a guest typed; optional)
                                 -> 200 {"token", "identity", "name", "url"} | 404 | 409 {"error": "full"}
GET  /api/calls                  -> 200 [{"room_id", "started_at", "ended_at", "seconds", "with"}] | 401
POST /api/webhooks/livekit       the embedded SFU's events, signed with the API key -> 200 | 401
GET  /room/:id                   the room page
GET  /history                    the history page
GET  /signup, /signin, /settings the account pages
```

Sessions are opaque ids in sqlite, sent as an `HttpOnly` `SameSite=Lax`
cookie (`Secure` behind TLS), valid for a year. Passwords are bcrypt
hashes (8 to 72 bytes); emails are stored lower-cased and are not
verified, so with an allowlist, whoever registers an address first owns
it. There is no password reset: the operator deletes the row. The
account endpoints accept only `Content-Type: application/json` (415
otherwise), which keeps a cross-site form from signing a visitor in as
someone else. A 429 carries `Retry-After` in seconds and
`{"error": "Too many attempts. Try again later."}`; the limits are per
client address for sign-in and sign-up (the last `X-Forwarded-For`
entry behind a proxy) and per account for room creation. An unknown
address and a wrong password take the same time to refuse.

`participants` is who the SFU has in the room right now (the lobby polls
it); the token endpoint answers 409 once two people are in. Rooms never
expire. `GET /api/rooms` lists the rooms the caller owns or has joined,
newest first, with `present` from one question to the SFU; renaming and
deleting are the owner's. Asking for a token with a session makes the
caller a member of that room.

A participant's `identity`, what the SFU keys on, is `user:<id>` for an
account and `guest:<4 hex>` otherwise; `name` is what people see (the
display name, or what a guest typed). History is written from the SFU's
webhooks (`participant_joined`, `participant_left`, `room_finished`),
which it posts to `/api/webhooks/livekit` on loopback; `ended_at` and
`seconds` are null while a call is on, and `with` names the others.

The token is a LiveKit join token for that room only, valid for an hour.
`url` is the signalling address the browser should connect to:
`LIVEKIT_PUBLIC_URL` when set; behind a proxy that sends
`x-forwarded-proto`, `ws`/`wss` on the host the request came in on;
otherwise `ws://<host>:<LIVEKIT_PORT>`.
