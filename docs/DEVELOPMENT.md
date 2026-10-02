# Development

[Back to quickmeet](../README.md) · [Configuration](CONFIGURATION.md) · [API](API.md)

All source paths below are relative to the repository root.

## Run locally

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
lgx docker              # build, then the image around it, started and asked for a page
```

Open http://localhost:8080, sign up (any email, no verification), click
"New call", open the room link in a second window, join from both.
Starting a call takes an account; joining one takes only the link.
The room page shows a lobby first: a preview of your camera, pickers for
the camera and microphone, and who is already in the room. A button on
the preview, and another in the call's controls, blurs the background
behind you; the browser remembers the choice for the next call. On a
desktop another button shares your screen, a window or a tab, picked in
the browser's own dialog; the other person sees it in place of your
camera. Phones can watch a shared screen but not share one: their
browsers cannot capture the screen. Rooms are
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
call's states (waiting, reconnecting, a lost connection), background
blur (on in the lobby and into the call, a failed load, a browser that
cannot do it), screen sharing (the screen taking the other side's
stage whole, the button, a share the browser ends, no button on a
phone) and the layout
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

## Vendored assets

`livekit-client` is vendored into `resources/public/` and served from the
binary, so a call page has no CDN dependency. To bump it, change the
version in the `vendor-livekit-client` task in `lgx.edn` and run
`lgx vendor-livekit-client`. The typeface (Onest, OFL) is vendored the
same way, as base64 inside `fonts.css`: `lgx vendor-fonts`, version in
`scripts/vendor-fonts.mjs`. So is background blur: LiveKit's track
processors bundled into `track-processors.js`, MediaPipe's wasm (9.4 MB)
and the segmentation model, `lgx vendor-blur`, versions in
`scripts/vendor-blur.mjs`. The wasm and the model are served under
`/static/blur/<versions>/` with a year's cache; a bump changes the tag in
the script and in `src/quickmeet/routes.lg` together. The library is
bundled from its source with `scripts/vendor-blur.patch` applied, which
keeps the blurred background from rippling; a version bump must carry the
patch forward (it fails to apply otherwise).

The home-screen icons and `favicon.ico` are drawn by
`scripts/make-icons.mjs` after `icon.svg`; `lgx icons` rewrites them.

## Layout

```
main.lg                        starts the system, waits on the http server, shuts down on SIGTERM
src/quickmeet/system.lg        the integrant config from the environment
src/quickmeet/db.lg            ::conn (open + migrate), queries
src/quickmeet/migrations.lg    the schema history (ragtime over sqlite)
src/quickmeet/routes.lg        ::handler: pages, accounts, rooms, join tokens, the two-person rule, ringing, the webhook, rate limits
src/quickmeet/ratelimit.lg     fixed-window rate limits in memory
src/quickmeet/history.lg       call history from the SFU's webhook events
src/quickmeet/auth.lg          sign-up, sign-in, sessions, the allowlist, the session cookie
src/quickmeet/password.lg      bcrypt (golang.org/x/crypto/bcrypt as a :go/interop coord)
src/quickmeet/id.lg            random ids for rooms, users and sessions
src/quickmeet/sfu.lg           asks the embedded SFU who is in a room, and which rooms are live (twirp over loopback)
src/quickmeet/server.lg        ::http: http/start on init, http/stop on halt
src/quickmeet/push.lg          ringing: the VAPID keys, the push-service allowlist, delivery
webpush/                       the Go shim over webpush-go (a :go/local coord): encrypt, sign, send
resources/public/              index, room, history, signup, signin, settings pages; app.css; ui.js (icons, avatars, push); sw.js (rings); the manifest and app icons; vendored livekit-client, font and background blur
scripts/vendor-fonts.mjs       writes resources/public/fonts.css from the pinned Onest release
scripts/vendor-blur.mjs        writes the blur bundle, MediaPipe's wasm and the model into resources/public
scripts/make-icons.mjs         writes the home-screen icons and favicon.ico into resources/public
scripts/docker-smoke.sh        builds the image around bin/quickmeet, starts it, asks for a page (`lgx docker`)
scripts/docker-compose-smoke.sh  runs deploy/docker against that image, a page over Caddy (CI only)
test/quickmeet/                routes and auth over a temp db; migrations; password; the full system
e2e/                           Playwright: two browsers in a call against bin/quickmeet; smoke.mjs for a deployed one
Dockerfile                     the runtime image around bin/quickmeet, staging's and the published one
compose.yaml                   the uncloud service: Caddy routes, media ports, secrets
deploy/                        the single-box install: systemd unit, Caddyfile, environment example
deploy/docker/                 the optional Docker Compose setup: the image behind Caddy
.github/workflows/             test.yml on every push; deploy.yml on master; release.yml on a vX.Y.Z tag
docs/                          installation, development, configuration, API, deployment and project notes
```

The components chain `server -> handler -> db` and `server -> livekit`,
so integrant starts the database and the SFU first and halts them last.
