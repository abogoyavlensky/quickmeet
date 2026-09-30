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

- Group calls, screen sharing, chat, recording, transcription.
- Native or React Native apps. The backend is already an HTTP API plus a
  LiveKit server, which is what LiveKit's mobile SDKs need; see
  "After v1".
- Federation, multi-node LiveKit, or any deployment larger than one box.
- Push notifications and call ringing. Calls are joined from a link.

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
  behind TLS), valid 30 days; nothing is signed. Hashing is
  `golang.org/x/crypto/bcrypt` as a `:go/interop` coord, no shim
  (`src/quickmeet/password.lg`).
- Done 2026-09-29: sign up, sign in, sign out, and a settings page with
  the display name, which the room lobby pre-fills.
- Done 2026-09-29: a guest stays a guest; creating a room takes a
  session (`POST /api/rooms` is 401 without one) and the room records
  its owner for M4.
- Done 2026-09-29: `ALLOWED_EMAILS`, checked on sign-up, sign-in and on
  every request of a live session, so a removed address is out at its
  next request. Staging reads it from a repository variable; until it is
  set, sign-up there is open.
- Decided 2026-09-29: passwords, not magic links. A magic link needs
  SMTP, a second service the "one binary" rule exists to avoid; bcrypt
  is one line. The allowlist race stands and is documented: with no
  proof of address, whoever registers an allowed address first owns it.
  On a personal instance the operator adds an address and tells the
  person to sign up. No password reset either (same reason); the
  operator deletes the row. If either bites, a verification email is an
  addition, not a change to the data model.

### M4: contacts and history

- Contacts: add by email, remove, list. A contact's page has a "call"
  button that creates a room and shows the link to share (no ringing).
- History: LiveKit's webhooks (`participant_joined`, `participant_left`,
  `room_finished`) recorded through `verify-webhook` into a `calls` table
  keyed by room id. Signed-in users see their calls with who, when and how
  long; guests see nothing.
- Join tokens for signed-in users carry their account identity, so history
  attributes calls correctly.

### M5: deployment

Staging done (2026-09-29): every push to master tests, builds and deploys
the app with uncloud to `https://quickmeet.absky.dev`, one hostname with
Caddy routing `/rtc*` to the SFU, media on one UDP port and one TCP port
in host mode. Two phones on different networks held a call there. See
"Deployment" in the README. What remains below: the install guide for
other boxes, release builds and tagging, macOS.

- A documented single-box install: the binary, a systemd unit, Caddy for
  TLS and for exposing the signalling WebSocket as `wss://`, the UDP range
  or the built-in TURN, and the environment variables.
- Production defaults: bind to all interfaces, `use_external_ip true`,
  a generated API secret, a real log level.
- Release builds via `lgx build`; linux/amd64 first, native macOS second.
- A smoke check after deploy: two devices on different networks in a call.

### M6: hardening

- Rate limits on room and account creation.
- Sign-in timing: an unknown address skips bcrypt, so response time says
  whether an account exists. A dummy comparison closes it.
- Room ids that are not enumerable and a check that a room link cannot be
  guessed from another.
- Graceful shutdown: SIGTERM stops the http server, waits for the SFU to
  drain participants, then exits.
- Backups: the sqlite file, documented. linkboard's Litestream sidecar
  plan applies unchanged: the database is a bind-mounted file on the
  uncloud host.

## After v1

- Mobile: LiveKit's Swift, Kotlin and React Native SDKs talk to the same
  SFU and the same token endpoint. What mobile adds on the server is push
  notifications for ringing, which need APNs and FCM signing that let-go
  does not have; a small Go shim or a hosted push service.
- More than two people, screen sharing, chat over LiveKit data channels.

## Open questions

- Resolved 2026-09-29: passwords for M3, the allowlist without proof of
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
