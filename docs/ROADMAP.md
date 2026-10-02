# quickmeet v1 roadmap

## What v1 is

A web app for 1-to-1 video and audio calls. A signed-in person clicks
"New meeting", shares the link, the other opens it, both talk. Signed-in
users also keep a list of contacts and a history of their calls.

Three properties define it and settle most design questions:

1. **One binary.** The LiveKit SFU runs inside the app process. Installing
   quickmeet is copying a file and running it; the only other thing on the
   box is TLS termination.
2. **Minimal installation.** No Redis, no Postgres, no message bus, no
   container required. State is a sqlite file next to the binary.
3. **Minimal auth.** Guests need nothing to join a call. Starting one
   takes an account, so an instance's bandwidth serves the people it was
   set up for; accounts also remember contacts and history, and should
   take one step to create. The operator can limit who may have one.

Two people per room is a product decision for v1, not a technical limit:
the SFU handles more, and the UI is what would need to change.

## Non-goals for v1

- Group calls, chat, recording, transcription. Screen sharing was on
  this list too; it came after v1 (see "After v1").
- Native or React Native apps. The backend is already an HTTP API plus a
  LiveKit server, which is what LiveKit's mobile SDKs need; see
  "After v1".
- Federation, multi-node LiveKit, or any deployment larger than one box.
- Push notifications and call ringing. Calls are joined from a link; see
  "After v1" for Web Push, which shipped after the release.

## Milestones

Each milestone ends with something a person can use. Order matters:
every step assumes the previous one shipped.

### M0: a call through the embedded SFU (done, 2026-09-27)

A spike proved two browser participants exchanging live audio and video
through the SFU running inside the let-go process, on stock
`livekit-client`. Nothing LiveKit-specific was needed on the server beyond
the livekit package. See `KNOWLEDGE.md` for the numbers.

### M1: foundation (this repository's first commit)

The app skeleton that every later milestone builds on: an integrant
system with the database, the SFU, the handler and the http server; a
landing page that creates a room; a room page that joins with camera and
microphone; a JSON API for rooms and join tokens; sqlite with migrations;
tests over the handler, the migrations and the whole system.

Exit: `lgx run`, open two browser windows on the same room link, see and
hear each other.

### M2: a call people can rely on

The room page as a product rather than a demo.

After M1 the order changed: a reduced M5, staging, came before the rest
of M2. Trying the build from a phone through ngrok showed that nothing
about the product can be judged on a real device until it is deployed:
the signalling URL was built for a laptop, media needs the SFU reachable
over UDP, and camera access needs HTTPS. The open items below (lobby,
device selection, reconnection states) are about behaviour on real
devices, which headless Chromium with fake media cannot judge, so they
follow with a real device to test them on.

- Done 2026-09-29: a lobby with camera preview, camera and microphone
  pickers, and who is already in the room (polled every 3 s); joining
  publishes the preview tracks (`e2e/tests/lobby.spec.js`).
- Done 2026-09-29: mute, stop video, leave; one status banner for
  "waiting for the other person", "reconnecting" (the client's own
  reconnection) and the other side leaving; a dropped connection returns
  to the lobby with a notice; "tap to enable sound" for iOS
  (`e2e/tests/call.spec.js`).
- Done 2026-09-29: a layout for phones, portrait and landscape, and for
  short desktop windows (`e2e/tests/mobile.spec.js`).
- Done 2026-10-01: the other person's video keeps its shape. On a desktop
  the tile becomes tall for a phone held upright; on a phone the video is
  letterboxed when its orientation differs from the screen's
  (`e2e/tests/orientation.spec.js`). An upright phone sending tall frames
  was confirmed on devices 2026-10-01.
- Done 2026-10-01: the redesign, on the direction in
  `docs/plans/2026-10-01-1830-redesign.md`. Every feature kept; the pages
  say "call" where they said "meeting" ("New call"). In a call the page is
  the stage: the other person's name and a clock in the bar, round icon
  controls, and on a phone or in full screen the video edge to edge with
  the bar and controls fading while nothing is touched. Two complaints
  from real devices went with it: on a desktop the tile had a 960 px cap
  and now takes the window; on a phone the video fills the screen only
  when that crops at most a fifth of it, and is shown whole otherwise (a
  sideways phone in a browser leaves a strip about 3:1).
- Done 2026-09-29: two-person rule. The SFU caps rooms at two
  (`room.max_participants`); the app asks the SFU who is in the room so
  the token endpoint can say 409 "full" and the lobby can show who is
  there. Needed because a refusal by the SFU alone reaches the browser as
  a generic connection error (`src/quickmeet/sfu.lg`).
- Decided 2026-09-29: rooms are permanent, no expiry. A link is created
  once and reused for every call with that person. Expiry only bounded
  what a stale link can cost, and the two-person cap does that already:
  a permanent link and a forgotten one cost the same, one call at a time.
  M3 and M4 give rooms owners; deleting one becomes an owner action. On
  the SFU side nothing changes: an empty LiveKit room closes after its
  timeout and is recreated on the next join; the sqlite row is the room.
- Verified 2026-09-29 on two phones against staging after PR #5: lobby,
  presence, call, the third person refused.
- Done 2026-09-27: `livekit-client` served from the binary instead of a
  CDN (`lgx vendor-livekit-client`).
- Done 2026-09-27: a browser test with headless Chromium and fake media,
  `lgx e2e`, run in CI on every push; two browsers in a real call,
  media flowing both ways, leaving noticed.

### M3: accounts

The smallest auth that gates starting a call and supports contacts and
history.

- Done 2026-09-29: email plus password. Sessions are opaque random ids
  in sqlite, sent as an `HttpOnly` `SameSite=Lax` cookie (`Secure`
  behind TLS), valid a year (browsers cap a cookie's lifetime, so
  "indefinite" is not available); nothing is signed. Hashing is
  `golang.org/x/crypto/bcrypt` as a `:go/interop` coord, no shim
  (`src/quickmeet/password.lg`).
- Done 2026-09-29: sign up, sign in, sign out, and a settings page with
  the display name, which the room lobby pre-fills.
- Done 2026-09-29: a guest stays a guest; creating a room takes a
  session (`POST /api/rooms` is 401 without one) and the room records
  its owner for M4.
- Done 2026-09-29: `ALLOWED_EMAILS`, checked on sign-up, sign-in and on
  every request of a live session, so a removed address is out at its
  next request. Staging reads it from a repository variable, set to the
  operator's address when M3 shipped.
- Decided 2026-09-30, on a draft written 2026-09-29 without approval
  and approved after review (`docs/plans/2026-09-30-0909-m3-accounts-adopt-and-ship.md`):
  passwords, not magic links. A magic link needs
  SMTP, a second service the "one binary" rule exists to avoid; bcrypt
  is one line. The allowlist race stands and is documented: with no
  proof of address, whoever registers an allowed address first owns it.
  On a personal instance the operator adds an address and tells the
  person to sign up. No password reset either (same reason); the
  operator deletes the row. If either bites, a verification email is an
  addition, not a change to the data model.
- Reviewed 2026-09-30 before shipping: two fixes. A lost race for one
  address on sign-up is 409, not an error; the account endpoints take
  JSON only, which closes login CSRF from a cross-site form.

### M4: rooms, members and history

Decided 2026-09-30: rooms first, no contacts table. A room is the durable
thing (permanent since M2, owned since M3); the people you call are the
people you share rooms with. The roadmap's earlier shape, a contacts list
added by email with a "call" button, duplicated the rooms list and needed
a rule for addresses with no account yet. Sharing the link is the
invitation.

- Done 2026-09-30: rooms have an optional name; signed-in users see "my
  rooms", every room they own or have joined, with its name, the link to
  copy, and who is in it right now (one `ListRooms` question to the SFU
  for the whole list); the owner renames and deletes
  (`e2e/tests/rooms.spec.js`).
- Done 2026-09-30: members. The owner from creation, and whoever asks for
  a join token with a session (`room_members`); every owner so far was
  backfilled by the migration. Guests leave no trace beyond history.
- Done 2026-09-30: history from the SFU's webhooks, posted to the app over
  loopback and checked with `verify-webhook`: a `calls` row per stretch
  of a room being occupied, a `call_participants` row per participant
  session. Signed-in users see their calls with who, when and how long;
  guests see nothing.
- Decided 2026-09-30: a participant's identity to the SFU is `user:<id>`
  for an account and `guest:<hex>` otherwise, with the display or typed
  name as the token's `name`. The typed name was the identity before,
  so two guests called "bob" evicted each other, and history could not
  tell an account from a guest. Pages show names.
- Decided 2026-09-30, from review: a call records the SFU's room sid. The
  process is killed on every deploy, so a call that was on never gets its
  `room_finished`; the next meeting's join carries a new sid, closes the
  stale call there and opens a new one. A `room_finished` also fills in
  any leave that never arrived.
- Notifying the other person stays out of band in v1: the link goes over
  whatever chat you already use. The rooms list showing who is waiting is
  the in-app signal. Ringing is "After v1", see Web Push there.

### M5: release

Decided 2026-09-30: what was left of M5 (deployment) and all of M6
(hardening) became one milestone, the release: installable by someone
other than the author, and safe to leave running. linux/amd64 only;
macOS builds moved to "After v1". Backups moved to the backlog
(`docs/backlog/sqlite-backups.md`). Plan:
`docs/plans/2026-09-30-2252-release-milestone.md`.

Staging done (2026-09-29): every push to master tests, builds and deploys
the app with uncloud to `https://quickmeet.absky.dev`, one hostname with
Caddy routing `/rtc*` to the SFU, media on one UDP port and one TCP port
in host mode. Two phones on different networks held a call there. See
[Deployment](DEPLOYMENT.md#staging).

- Measured 2026-09-30, before planning: a call survives the server being
  killed and restarted. The browsers reconnect by themselves: media was
  back 18 s after the kill for a 5 s outage and 40 s after for a 30 s one;
  at 60 s they gave up after 48 s and returned to the lobby. See
  "Restarts and shutdown" in `KNOWLEDGE.md`.
- Decided 2026-09-30: shutdown never stops the SFU. On SIGTERM the app
  stops serving, closes open calls in history and exits; the SFU dies
  with the process and the browsers reconnect to the next one. The
  earlier plan, "wait for the SFU to drain participants", would either
  wait forever (LiveKit's graceful stop waits for every participant to
  leave) or end every call (its forced stop tells them to).
- Decided 2026-09-30: production defaults stay development defaults, and
  the dangerous combination refuses to start: the built-in API secret on
  an SFU other machines can reach. The install guide's environment file
  sets the rest (bind address, external IP, log level).
- Done 2026-09-30: rate limits in memory, per client address for sign-in
  (10 a minute) and sign-up (10 an hour), per account for room creation
  (60 an hour); 429 with `Retry-After`. `RATE_LIMIT=false` for the
  browser suite (`src/quickmeet/ratelimit.lg`).
- Done 2026-09-30: sign-in with an unknown address pays for one bcrypt
  comparison too, so response time no longer says whether an account
  exists.
- Done 2026-09-30: `HOST` binds the app's port; the install puts it on
  loopback behind Caddy, which is what makes the forwarded client address
  trustworthy for the rate limits.
- Done 2026-09-30: SIGTERM and SIGINT shut down cleanly (exit 0 in about
  a tenth of a second), and a start closes any call a dead process left
  open. The compose stop grace period is 10 s again.
- Done 2026-09-30: `docs/INSTALL.md` with a systemd unit, a Caddyfile and
  an environment example in `deploy/`; `release.yml` publishes a
  linux/amd64 tarball on a `v*` tag; `lgx smoke` holds a two-browser call
  against any instance as the post-install check.
- Verified 2026-09-30 on staging through the merge deploy (PR #11): a
  live call came back by itself after 27.6 s without media; history split
  it at the deploy; the sign-in limit answers 429. Per-address limits
  there only hold within one connection, apparently because of the
  network in front of the box (`docs/backlog/staging-rate-limit-per-connection.md`).
  The install guide has not yet been run on a fresh box, and no release
  has been tagged.
- Verified 2026-10-01 at the next deploy (PR #12): the new build stops in
  under a second as PID 1 and closes history on time. A call took 59.9 s
  to recover that time, 40 s of it with both people back in the room but
  not seeing each other
  (`docs/backlog/reconnect-after-deploy-can-leave-both-waiting.md`).
- Satisfied since M3: room ids are 12 hex characters of a random v4 UUID,
  48 bits from crypto/rand, each independent of every other, so no link
  can be guessed from another (`src/quickmeet/id.lg`,
  `src/quickmeet/routes.lg`).

## After v1

- Done 2026-10-02: an installable web app (PWA), without a service
  worker: a manifest, home-screen icons and a favicon
  (`resources/public/manifest.webmanifest`, `scripts/make-icons.mjs`),
  and a Back link and a sticky top bar for when there is no browser
  chrome. Not yet tried installed on a phone.
- Done 2026-10-02: ringing via Web Push, the minimal version
  (`docs/plans/2026-10-02-2050-ring-web-push.md`). A signed-in person
  waiting alone in a room presses "Ring Anna"; every device the room's
  other members turned ringing on for shows "Anna wants to talk", and
  tapping it opens the room's lobby, where Join is the answer. Permission
  is asked only from a tap: a banner on the list page or a switch in
  Settings (on an iPhone in Safari, a hint to add the app to the home
  screen). The VAPID keys are made on the first start; subscriptions
  belong to sessions; one ring per caller and room every 30 s. Not a
  `:go/interop` coord after all: webpush-go takes structs, so it has a
  small shim in `webpush/`. Left for later, each in the backlog: a ring
  from the list, ring state (decline, cancel, missed calls in history),
  rings from guests. Not yet tried on a real phone.
- Done 2026-10-02: screen sharing from desktop browsers. A button in
  the call's controls opens the browser's own picker (a monitor, a
  window or a tab); on the other side the screen takes the stage in
  place of the camera, always shown whole, and the camera comes back
  when it ends. The button is hidden on phones: iPhone browsers have no
  `getDisplayMedia` and Android's refuse every call. No server change
  (`e2e/tests/screenshare.spec.js`). Not yet tried in real browsers:
  the picker in Chrome, Firefox and Safari, and a phone watching.
- Done 2026-10-02: the microphone and the camera can be turned off in
  the lobby, from two buttons on the preview, and the call starts that
  way (`docs/plans/2026-10-02-2217-lobby-mic-camera-off.md`). The camera's
  light goes out while it is off. The choice is not remembered between
  visits: every lobby starts with both on.
- Mobile: LiveKit's Swift, Kotlin and React Native SDKs talk to the same
  SFU and the same token endpoint. Native ringing needs APNs and FCM
  signing that let-go does not have; a small Go shim or a hosted push
  service. The PWA above covers phones without any of that.
- More than two people, chat over LiveKit data channels. While a screen
  is shared, the sharer's face in a small tile beside it
  (`docs/backlog/screen-share-face-tile.md`).
- macOS builds. Cross-building from linux fails (a stats dependency of
  livekit-server needs cgo on darwin), so a release would need a macOS
  runner building natively. Dropped from v1 on 2026-09-30.

## Open questions

- Resolved 2026-09-30: passwords for M3, the allowlist without proof of
  address (see M3).
- Resolved 2026-09-28: who may start a call. Signed-in users only;
  anyone with a link may join. The M2 and M6 limits (two-person cap,
  room expiry, rate limits) bound what one room or one client can cost,
  but only accounts keep strangers from using an instance at all.
- Whether room pages should work without JavaScript beyond
  `livekit-client` (currently plain DOM code, no framework).
- Resolved 2026-09-29: room lifetime. Permanent, see M2. Presence in the
  lobby is polled from the SFU; M4's webhooks can feed the same endpoint
  from memory without changing its contract.
- Resolved 2026-09-28: the signalling WebSocket stays on LiveKit's port.
  A deployment exposes one hostname and splits it by path at the reverse
  proxy (`/rtc*` to the SFU, the rest to the app); nothing is proxied in
  the app.
