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
```

Open http://localhost:8080, sign up (any email, no verification), click
"New meeting", open the room link in a second window, join from both.
Starting a meeting takes an account; joining one takes only the link.
The room page shows a lobby first: a preview of your camera, pickers for
the camera and microphone, and who is already in the room. Rooms are
permanent and hold two people; a third person is told the meeting is
full. A link is created once and reused for every call with that person.

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

`livekit-client` is vendored into `resources/public/` and served from the
binary, so a call page has no CDN dependency. To bump it, change the
version in the `vendor-livekit-client` task in `lgx.edn` and run
`lgx vendor-livekit-client`.

## Deployment

A push to master runs the tests, then `.github/workflows/deploy.yml`:
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
unset, sign-up would be open. Rooms are permanent and hold two people;
there is no rate limit yet.

## Configuration

Every setting is an environment variable with a development default.
The defaults bind to loopback with a well-known key: fine on a laptop,
wrong on a server.

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | the app's http port |
| `DB_PATH` | `quickmeet.db` | the sqlite file |
| `ALLOWED_EMAILS` | unset | comma-separated addresses that may sign up, sign in and keep a session; unset, sign-up is open |
| `LIVEKIT_PORT` | `7880` | SFU http and signalling port |
| `LIVEKIT_BIND` | `127.0.0.1` | SFU bind address; `0.0.0.0` when a proxy reaches it from another host or container |
| `LIVEKIT_RTC_TCP_PORT` | `7881` | ICE over TCP |
| `LIVEKIT_UDP_START`, `LIVEKIT_UDP_END` | `50000`, `50100` | media port range |
| `LIVEKIT_UDP_PORT` | unset | when set, all media over this one UDP port; the range is ignored |
| `LIVEKIT_USE_EXTERNAL_IP` | `false` | advertise the public IP in ICE candidates |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | dev values | token signing; the secret must be 32+ characters |
| `LIVEKIT_LOG_LEVEL` | `warn` | |
| `LIVEKIT_PUBLIC_URL` | unset | the signalling URL handed to browsers; otherwise derived from the request |

## Layout

```
main.lg                        starts the system, waits on the http server
src/quickmeet/system.lg        the integrant config from the environment
src/quickmeet/db.lg            ::conn (open + migrate), queries
src/quickmeet/migrations.lg    the schema history (ragtime over sqlite)
src/quickmeet/routes.lg        ::handler: pages, accounts, /api/rooms, join tokens, the two-person rule
src/quickmeet/auth.lg          sign-up, sign-in, sessions, the allowlist, the session cookie
src/quickmeet/password.lg      bcrypt (golang.org/x/crypto/bcrypt as a :go/interop coord)
src/quickmeet/id.lg            random ids for rooms, users and sessions
src/quickmeet/sfu.lg           asks the embedded SFU who is in a room (twirp over loopback)
src/quickmeet/server.lg        ::http: http/start on init, http/stop on halt
resources/public/              index, room, signup, signin, settings pages; app.css; vendored livekit-client
test/quickmeet/                routes and auth over a temp db; migrations; password; the full system
e2e/                           Playwright: two browsers in a call against bin/quickmeet
Dockerfile                     the runtime image around bin/quickmeet
compose.yaml                   the uncloud service: Caddy routes, media ports, secrets
.github/workflows/             test.yml on every push; deploy.yml on master
docs/                          ROADMAP.md, KNOWLEDGE.md
```

The components chain `server -> handler -> db` and `server -> livekit`,
so integrant starts the database and the SFU first and halts them last.

## API

```
POST /api/auth/signup            {"email", "password"}
                                 -> 201 {"email", "display_name"} + Set-Cookie: session=...
                                  | 400 {"error": "<what is wrong>"} | 403 {"error": "not allowed"} | 409 {"error": "exists"}
POST /api/auth/signin            {"email", "password"}
                                 -> 200 {"email", "display_name"} + Set-Cookie | 401 {"error": "invalid email or password"} | 403
POST /api/auth/signout           -> 200 {} + Set-Cookie clearing the session
GET  /api/me                     -> 200 {"email", "display_name"} | 401
POST /api/me                     {"display_name"} -> 200 {"email", "display_name"} | 400 | 401
POST /api/rooms                  -> 201 {"id": "0123456789ab"} | 401 (needs a session)
GET  /api/rooms/:id              -> 200 {"id", "created_at", "participants": [{"identity": "alice"}]} | 404
POST /api/rooms/:id/token        {"identity": "alice"}   (identity optional)
                                 -> 200 {"token", "identity", "url"} | 404 | 409 {"error": "full"}
GET  /room/:id                   the room page
GET  /signup, /signin, /settings the account pages
```

Sessions are opaque ids in sqlite, sent as an `HttpOnly` `SameSite=Lax`
cookie (`Secure` behind TLS), valid for a year. Passwords are bcrypt
hashes (8 to 72 bytes); emails are stored lower-cased and are not
verified, so with an allowlist, whoever registers an address first owns
it. There is no password reset: the operator deletes the row. The
account endpoints accept only `Content-Type: application/json` (415
otherwise), which keeps a cross-site form from signing a visitor in as
someone else.

`participants` is who the SFU has in the room right now (the lobby polls
it); the token endpoint answers 409 once two people are in. Rooms never
expire.

The token is a LiveKit join token for that room only, valid for an hour.
`url` is the signalling address the browser should connect to:
`LIVEKIT_PUBLIC_URL` when set; behind a proxy that sends
`x-forwarded-proto`, `ws`/`wss` on the host the request came in on;
otherwise `ws://<host>:<LIVEKIT_PORT>`.
