# M2: a call people can rely on, on phones — Implementation Plan

> **Status: completed (2026-09-29), pending the real-device checklist in Task 8.** See "Execution summary" at the end.

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The room page becomes a product: a lobby with camera preview, device selection and who is already there; a two-person rule with a clear message; visible reconnecting and connection-lost states; sound that works on iOS; and a layout that works on a phone. Rooms are permanent.

**Tech Stack:** let-go 1.13.0 on lgx 0.4.2, the letgo-packages `livekit` wrapper (livekit-server 1.13.7), `livekit-client` 2.22.3 vendored, plain DOM and CSS, Playwright 1.56.0 with headless Chromium and fake media. No new dependencies.

---

## Design

### Where M2 stands

Staging runs at `https://quickmeet.absky.dev` and two phones held a call there (2026-09-29). The room page (`resources/public/room.html`) already has mute, stop video, leave, a "waiting for the other side" tag, "the other side left", and a copy-link button. What is missing is what the roadmap deferred until a real device existed: a lobby with preview and device selection, a reconnecting state, the two-person rule, and a layout that works on a phone. Room expiry was on the list too; it is dropped, see the decisions.

### Facts this design rests on (verified 2026-09-29)

- livekit-server has a config-level participant cap, `room.max_participants` (`pkg/config/config.go:240`), applied to every auto-created room (`pkg/service/roomallocator.go:189`, `applyDefaultRoomConfig`). At the cap, `Room.Join` returns `ErrMaxParticipantsExceeded` (`pkg/rtc/room.go:466`).
- That refusal reaches the browser as an HTTP 500 on the signalling upgrade (`pkg/service/rtcservice.go:404-411`: a non-psrpc error maps to 500). `livekit-client` then asks `/rtc/validate`, which does not consider the cap and answers `200 success`, so the client surfaces a generic WebSocket connection error (`handleConnectionError` in the vendored client only maps 401, 403 and 404). The browser cannot tell "full" from "broken" on its own.
- The SFU's twirp room service accepts JSON: `POST /twirp/livekit.RoomService/ListParticipants` with `Authorization: Bearer <jwt>`, `Content-Type: application/json`, body `{"room":"<id>"}`. It needs the `roomAdmin` grant for that room (`EnsureAdminPermission`, `pkg/service/roomservice.go:174`); `lk/token` mints it with `:room-admin true`. A room the SFU has not created answers 404 `requested room does not exist` (`pkg/service/errors.go:38`, `psrpc.NotFound`). Participants carry `state`: `JOINING`, `JOINED`, `ACTIVE`, `DISCONNECTED`.
- let-go's `http/post` returns non-2xx responses as ordinary maps with `:status` and `:body` (`pkg/rt/http.go:640`); it throws only when the connection fails. It has no timeout; the SFU is in-process, so a hang is not expected.
- `livekit-client` 2.22.3 exports `Room.getLocalDevices(kind)`, `LocalTrack.restartTrack({deviceId})` (re-attaches to the elements the track was attached to), `RoomEvent.Reconnecting`, `Reconnected`, `Disconnected(reason)`, `AudioPlaybackStatusChanged`, `room.canPlaybackAudio`, `room.startAudio()`, and the `DisconnectReason` enum (`CLIENT_INITIATED` is the one a leave produces).
- Chromium's fake media devices go through the normal `getUserMedia` and `enumerateDevices` paths, so the lobby's preview and device lists are testable headlessly.

### Key decisions

1. **Rooms are permanent.** A link is created once and reused for every call with that person. The 24-hour expiry the roadmap listed only bounded what a stale link can cost, and the two-person cap already does that: a permanent link and a forgotten one cost the same, one call at a time. A row is 12 hex chars and a timestamp; the table growing by one row per click is nothing. M3 and M4 give rooms owners, and deleting one becomes an owner action. The SFU side is unchanged: LiveKit rooms are ephemeral, an empty one closes after the default 5 minutes and is recreated on the next join; the sqlite row is the room's identity.
2. **The cap is enforced twice.** The SFU config carries `max_participants: 2` and is authoritative. The app also asks the SFU who is in the room, so the token endpoint can answer 409 `{"error":"full"}` with a message the page can show, and the lobby can show who is already there. If asking the SFU fails, the token is minted anyway; the SFU cap still holds.
3. **Presence by polling, not webhooks.** `GET /api/rooms/:id` returns the room plus its participants. The lobby polls it every 3 seconds until the person joins. Webhooks are M4's tool for history; when they arrive they can feed the same endpoint from memory without changing its contract. A hidden participant in the lobby would need a package change for the `hidden` grant and is not worth it for v1.
4. **The handler takes the participant lookup as a function.** `routes/handler` gets a third argument, `participants`, `(fn [room-id] -> vector of {:identity ..} | nil)`. Handler tests stub it; the integrant component wires the real one from `quickmeet.sfu`. A nil result means "could not ask"; `[]` means "nobody there".
5. **Device selection is two native selects in the lobby.** One code path for desktop and phones: on a phone they open as pickers and read "Front camera" and "Back camera". Changing a select restarts that track on the chosen device. The preview tracks are the ones published on join, so there is one permission prompt.
6. **Media failure degrades, it does not block.** Camera plus microphone first; if that fails, audio only, with a notice; if that fails too, joining is still allowed, receive-only, with a notice.
7. **Call states live in one status banner.** "Waiting for the other person" until a remote track arrives, "Reconnecting…" between the client's `Reconnecting` and `Reconnected`, and back to waiting after the other side leaves. A disconnect the user did not initiate returns to the lobby with "Connection lost. Join again." The existing `#remote-name` tag keeps its texts; the browser tests depend on them.
8. **iOS sound.** Safari can block remote audio until a tap. On `AudioPlaybackStatusChanged`, when `room.canPlaybackAudio` is false, a "Tap to enable sound" button appears and calls `room.startAudio()`.
9. **Mobile layout is CSS only.** Under 700px the remote video fills the call area edge to edge, the self view is a portrait thumbnail top right so the controls never cover it, the controls sit at the bottom padded by the safe-area inset with 44px targets, and the page height is `100dvh` so the iOS address bar cannot push the controls off screen. Desktop keeps the current look.
10. **Out of scope:** screen sharing (after v1), webhooks (M4), rate limits and graceful shutdown (M6), room ownership (M3), any change to the livekit package.

One edge accepted with decision 2: a guest who reloads gets a fresh identity. A tab close is noticed by the SFU at once, so a reload is fine; only a tab that vanished without closing its socket keeps its seat for a few seconds, and a rejoin in that window sees "full" until the next poll.

### API

```
GET  /api/rooms/:id              -> 200 {"id", "created_at", "participants": [{"identity": "alice"}]} | 404
POST /api/rooms/:id/token        {"identity": "alice"}   (identity optional)
                                 -> 200 {"token", "identity", "url"} | 404 | 409 {"error": "full"}
```

`participants` lists people the SFU currently has in the room whose state is not `DISCONNECTED`; `[]` when the SFU has no such room or could not be asked. The 409 fires at two or more.

### The room page, state by state

Elements the tests and the tasks share (ids): `#gone` (dead-link section), `#lobby`, `#preview` (video, muted, playsinline), `#cam-select`, `#mic-select`, `#presence`, `#notice`, `#join`, `#error`; `#call`, `#status`, `#remote`, `#remote-name`, `#local`, `#local-name`, `#sound`, `#mic`, `#cam`, `#leave`; `#copy` in the header. `window.call` keeps `room`, `remote`, `joined`, `tracks`, `stats()`.

- **Load.** `GET /api/rooms/:id`. 404: show `#gone` ("This meeting link does not exist.") with a link to `/`; nothing else runs. 200: show the lobby and start it.
- **Lobby start.** Acquire tracks (decision 6), attach the video track to `#preview`, fill the selects from `Room.getLocalDevices('videoinput')` and `('audioinput')` with the current device selected (`track.mediaStreamTrack.getSettings().deviceId`), and start the presence poll. The acquisition is a promise the join handler awaits, so a click before the preview is ready still works.
- **Presence poll.** Every 3 seconds, and once immediately: `#presence` reads "Nobody has joined yet", "<name> is already here", or "This meeting already has two people in it" (join disabled) as the count is 0, 1, or more. The poll stops on join and restarts when the lobby shows again.
- **Device change.** `restartTrack({deviceId: {exact: value}})` on the matching track; the preview keeps playing.
- **Join.** Await the lobby tracks; `POST` for a token; 409 shows "This meeting already has two people in it." in `#error`; other failures show the status. `room.connect(url, token)`; publish the lobby tracks (video attached to `#local`); stop the poll; show `#call` with `#status` "Waiting for the other person. Share the link.". A connect failure re-fetches the room lookup first: two people can both get tokens before the room fills, and the SFU then refuses one with a generic WebSocket error, so two or more participants in the lookup shows the "already has two people" message; otherwise `#error` shows the client's message. The lobby stays.
- **In call.** Presence, not media, drives the banner: `ParticipantConnected` hides `#status`, and a check of `room.remoteParticipants.size` right after `connect` covers the case where the other person was already there. `TrackSubscribed` only attaches tracks, so a receive-only participant (decision 6) is still noticed; `ParticipantDisconnected` sets the tag to "the other side left" and `#status` to "Waiting for the other person."; `Reconnecting` sets `#status` "Reconnecting…", `Reconnected` restores it (hidden if a remote is present, waiting text otherwise); `AudioPlaybackStatusChanged` shows or hides `#sound`.
- **Disconnected(reason).** Back to the lobby, which restarts the preview (the client stops local tracks on disconnect). If `reason !== DisconnectReason.CLIENT_INITIATED`, `#notice` reads "Connection lost. Join again."

### Testing

- Handler tests (`routes_test.lg`): the room lookup carries participants; the token endpoint is 409 with two, 200 with one, 200 and `[]` with nil.
- System tests (`system_test.lg`): the config carries the cap; `sfu/participants` against the real SFU returns `[]` for a room it has not created (the 404 path, the only one reachable without a browser); the room lookup over HTTP carries `participants []`.
- Browser tests: lobby (`lobby.spec.js`): unknown link, preview playing before join, device lists populated and a switch keeps the preview playing, presence text with nobody and with alice, join disabled at two plus a direct 409. Call (`call.spec.js`): existing two tests unchanged; reconnecting banner driven by emitting the events on `call.room` (network emulation cannot drop UDP deterministically); connection-lost notice driven by emitting `Disconnected` with a non-client reason. Mobile (`mobile.spec.js`): a 390×844 touch viewport, bounding-box assertions.
- Real devices: a checklist for the user after deploy (Task 8).

## File Structure

**Create:**
- `src/quickmeet/sfu.lg` — `participants`: one twirp call to the in-process SFU, returns `[{:identity ..}]`, `[]` or nil.
- `e2e/tests/lobby.spec.js` — lobby behaviour.
- `e2e/tests/mobile.spec.js` — layout on a phone viewport.

**Modify:**
- `src/quickmeet/system.lg` — `:room {:max_participants 2}` in the SFU config.
- `src/quickmeet/routes.lg` — handler takes `participants`; room lookup carries them; token 409; `init-key` wires `sfu/participants`.
- `resources/public/room.html` — lobby, states, sound button, per the design.
- `resources/public/app.css` — status banner, preview, selects, the mobile rules.
- `test/quickmeet/routes_test.lg`, `test/quickmeet/system_test.lg` — as above.
- `e2e/tests/call.spec.js` — reconnect and connection-lost tests; `joinAs` unchanged.
- `README.md`, `docs/ROADMAP.md`, `docs/KNOWLEDGE.md`.

---

### Task 1: The cap in the SFU config

**Files:**
- Modify: `src/quickmeet/system.lg`, `test/quickmeet/system_test.lg`

- [x] **Step 1: Test.** In `config-from-the-environment`, assert `(= 2 (get-in c [:livekit/server :config :room :max_participants]))` for the empty environment.
- [x] **Step 2: Run.** `lgx test`. Expected: that assertion fails, nothing else.
- [x] **Step 3: Implement.** In `config`, add `:room {:max_participants 2}` to the `:livekit/server` `:config` map, with a comment: two people per room is a product decision (roadmap), the SFU enforces it, the app reports it. Leave `empty_timeout` and `departure_timeout` at LiveKit's defaults (300 s and 20 s).
- [x] **Step 4: Run.** `lgx test`. Expected: all green. `pages-rooms-and-tokens-over-http` proves the SFU still starts with the key (a misspelled key is a strict-parse error).
- [x] **Step 5: Commit.** `git commit -m "SFU: two participants per room"`

### Task 2: Asking the SFU who is in a room

**Files:**
- Create: `src/quickmeet/sfu.lg`
- Modify: `test/quickmeet/system_test.lg`

- [x] **Step 1: Test.** In `system_test.lg`, a new `deftest participants-of-an-unknown-room` inside `with-system`: `(sfu/participants {:api-key .. :api-secret .. :port lk-port} "0123456789ab")` is `[]`. Take the key and secret from `(system/config)` (`system/dev-api-key`, `system/dev-api-secret`). Also, in `pages-rooms-and-tokens-over-http`, `GET /api/rooms/<id>` over HTTP has `:participants []` (this assertion passes only after Task 3; add it there).
- [x] **Step 2: Run.** `lgx test`. Expected: the new test fails to load (`quickmeet.sfu` missing).
- [x] **Step 3: Implement** `quickmeet.sfu/participants`:

  ```clojure
  (defn participants
    "Who the SFU has in `room-id` now: a vector of {:identity ..}, [] when the
     SFU has no such room, nil when it could not be asked."
    [{:keys [api-key api-secret port]} room-id] ...)
  ```

  Mint `(lk/token api-key api-secret {:room room-id :room-admin true :ttl-seconds 60})`. `http/post` to `http://127.0.0.1:<port>/twirp/livekit.RoomService/ListParticipants` with body `(json/write-json {:room room-id})` and opts `{:content-type "application/json" :headers {"Authorization" (str "Bearer " token)}}`. 200: parse the body with `{:keywords? true}`, keep participants whose `:state` is not `"DISCONNECTED"`, return `(mapv #(select-keys % [:identity]) ..)`. 404: `[]`. Any other status, or an exception (wrap the call in `try`): nil. A comment explains why the app asks at all (the `/rtc/validate` fact from the design). Note that `LIVEKIT_BIND` may be `0.0.0.0` in a container; loopback still reaches it.
- [x] **Step 4: Run.** `lgx test`. Expected: green. If the SFU answers 401, the grant is wrong: check that the token carries `roomAdmin` for that room (decode the JWT payload).
- [x] **Step 5: Commit.** `git commit -m "sfu: list a room's participants over the twirp API"`

### Task 3: Room lookup with participants, token 409

**Files:**
- Modify: `src/quickmeet/routes.lg`, `test/quickmeet/routes_test.lg`, `test/quickmeet/system_test.lg`

- [x] **Step 1: Tests.** In `routes_test.lg`, `with-handler` gains an optional `participants` argument, default `(constantly [])`, passed to `routes/handler` as its third argument. New `deftest presence-and-the-two-person-rule`:
  - stub `(constantly [])`: `GET /api/rooms/:id` has `:participants []`; token 200.
  - stub `(constantly [{:identity "alice"}])`: lookup lists alice; token 200.
  - stub `(constantly [{:identity "alice"} {:identity "bob"}])`: lookup lists both; token is 409 with `{:error "full"}`.
  - stub `(constantly nil)`: lookup has `:participants []`; token 200.
  - a stub that records the room id it was called with, to check the lookup passes the room id, not the request.
  In `system_test.lg`, add the `:participants []` assertion from Task 2 Step 1.
- [x] **Step 2: Run.** `lgx test`. Expected: arity errors from `with-handler`.
- [x] **Step 3: Implement.** `handler` becomes `[conn livekit participants]`; `routes` takes it too. `GET /api/rooms/:id` returns `(assoc room :participants (or (participants id) []))`. The token route: after the room check, `(let [ps (participants id)] (if (>= (count ps) 2) (json-response 409 {:error "full"}) ...mint...))`. `init-key ::handler` builds the real function: `(handler db livekit (partial sfu/participants livekit))`, so a test system that overrides the SFU port (`system_test.lg` does) asks the right port. Update the `handler` docstring.
- [x] **Step 4: Run.** `lgx test`. Expected: green.
- [x] **Step 5: Commit.** `git commit -m "Rooms report who is in them; a third token is refused"`

### Task 4: The lobby

**Files:**
- Modify: `resources/public/room.html`, `resources/public/app.css`
- Create: `e2e/tests/lobby.spec.js`

- [x] **Step 1: Tests first**, in `lobby.spec.js`, reusing `newRoom` and `joinAs` (move them into `e2e/tests/helpers.js` and import from every spec). `joinAs` gains a trailing `contextOptions = {}` argument passed to `browser.newContext`, so a spec can join from a phone-sized context; `test.use` only configures the fixture `page`, not contexts a helper creates. Cases:
  - "an unknown link says so": `page.goto('/room/000000000000')`; `#gone` visible with "does not exist"; `#lobby` hidden; no `getUserMedia` call happened (assert `#preview` has `videoWidth === 0`).
  - "the lobby previews the camera and lists the devices": open a fresh room; `expect.poll` `#preview` `videoWidth > 0`; `#cam-select` and `#mic-select` each have at least one option with a non-empty label; pick the last option of `#cam-select`; the preview still plays (`videoWidth > 0` after a 500 ms wait, and `#error` hidden).
  - "the lobby shows who is already here": open a room in `page`; `#presence` reads "Nobody has joined yet"; alice joins from another context; `#presence` on `page` becomes "alice is already here" (`expect` with the default 15 s timeout covers the 3 s poll).
  - "a third person is told the meeting is full": alice and bob join; a third context opens the lobby; `#presence` reads "already has two people"; `#join` is disabled; `page.evaluate` a `fetch` of the token endpoint returns 409. Alice and bob still see each other (`call.remote` unchanged).
- [x] **Step 2: Run.** `cd e2e && npx playwright test tests/lobby.spec.js` (the binary from `lgx build` first). Expected: all four fail on missing elements.
- [x] **Step 3: Markup.** Add `#gone` (hidden), the preview video, the two selects with labels, `#presence`, `#notice`; keep `#identity`, `#join`, `#error`. Add `viewport-fit=cover` to the viewport meta.
- [x] **Step 4: Script.** Restructure the page script around small functions: `loadRoom()`, `startLobby()` (returns the tracks promise and stores it), `acquireTracks()` (decision 6), `fillDevices()`, `onDeviceChange(kind)`, `pollPresence()` with `setInterval` and a `stopPolling()`, `join()`. Keep `window.call` and `stats()` exactly as they are. `join()` awaits the tracks promise, publishes those tracks, and does not call `createLocalTracks` again. Presence texts exactly as in the design. A comment at the top says what each state is for.
- [x] **Step 5: Style.** `.preview` (black, rounded, `aspect-ratio: 16/9`, `width: 100%`), selects styled like the input, `#presence` muted text, `#notice` accent text.
- [x] **Step 6: Run** `lgx e2e`. Expected: lobby 4 passed, call 2 passed, landing 1 passed. If the device labels are empty, `getLocalDevices` ran before permission was granted; call it after the tracks resolve.
- [x] **Step 7: Commit.** `git commit -m "Room page: lobby with preview, device selection and presence"`

> Deviation: the sections' own `display: grid` rules were beating the `hidden` attribute (author styles win over the browser's `display: none`), so `#lobby` showed next to `#gone`; `app.css` now has `[hidden] { display: none !important; }`. The bug predates this task: `#call` was never really hidden either.
> Deviation: `newRoom` in `helpers.js` waits for the load state after the URL changes; the room page's elements do not exist at navigation commit.
> Codex (P2, fixed in a follow-up commit): a presence response still in flight when Join was clicked could re-enable the button and allow a second, concurrent join; and a failed `connect` left the unpublished preview tracks alive while the lobby acquired new ones. Now `lobby.joining` gates both the button and `join()`, every lobby start stops the previous tracks, and a failed join tears down whatever it connected before restarting the lobby.
> Deviation: `acquireTracks` has a third fallback, video without audio, so a phone with a camera but no microphone permission still previews.

### Task 5: Call states, reconnecting, sound

**Files:**
- Modify: `resources/public/room.html`, `resources/public/app.css`, `e2e/tests/call.spec.js`

- [x] **Step 1: Tests first**, in `call.spec.js`:
  - "the status says who we are waiting for": alice joins alone; `#status` visible with "Waiting for the other person"; bob joins; `#status` on alice hidden; bob leaves; `#status` on alice visible with "Waiting" again.
  - "reconnecting is shown": both joined; on alice, `page.evaluate(() => call.room.emit(LivekitClient.RoomEvent.Reconnecting))`; `#status` reads "Reconnecting…"; emit `Reconnected`; `#status` hidden (bob is present).
  - "a lost connection returns to the lobby with a notice": on bob, emit `Disconnected` with `LivekitClient.DisconnectReason.SIGNAL_CLOSE`; bob's `#lobby` visible, `#notice` reads "Connection lost"; alice's `#remote-name` may or may not change (bob's SFU session is still up; do not assert on alice). The existing "leaving is noticed" test asserts `#notice` is hidden after a real leave.
- [x] **Step 2: Run** the call spec. Expected: the three new tests fail on missing elements or texts.
- [x] **Step 3: Implement.** `#status` banner and `#sound` button in `#call`; the event handlers per the design's "In call" and "Disconnected(reason)" (presence from `ParticipantConnected` and `remoteParticipants`, not from `TrackSubscribed`); the connect-failure recheck from the design's "Join"; `showLobby(notice)` that hides the call, shows the lobby, sets `#notice` (or hides it), and calls `startLobby()` again. The sound button: shown when `!room.canPlaybackAudio` on `AudioPlaybackStatusChanged` (and checked once after connect), click calls `room.startAudio()` then hides itself.
- [x] **Step 4: Style.** `.status` pill at the top centre of the call area over the video; `#sound` as a primary button below it.
- [x] **Step 5: Run** `lgx e2e`. Expected: all green. Run `cd e2e && npx playwright test --repeat-each 3` once; widen a poll rather than adding a sleep if anything flakes.
- [x] **Step 6: Commit.** `git commit -m "Room page: waiting, reconnecting and connection-lost states; iOS sound"`

> Codex (P2, fixed in a follow-up commit): the client raises `SignalReconnecting` before `Reconnecting` when only the signalling socket drops; the banner now follows both, and the test emits both.
> Deviation: the mute and video buttons reset their labels on every join; a previous call left muted would otherwise show "Unmute" over a fresh, unmuted track.

### Task 6: The phone layout

**Files:**
- Modify: `resources/public/app.css`
- Create: `e2e/tests/mobile.spec.js`

- [x] **Step 1: Test first.** `mobile.spec.js` with `test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })`:
  - "the lobby fits without scrolling": open a room; `#join` bounding box bottom ≤ 844 and `#preview` `videoWidth > 0`.
  - "the call fills the screen and the controls are reachable": alice joins through `joinAs` with `{ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }` as its context options (bob can stay desktop); on alice, `#remote` box width is 390 and height ≥ 500; `.tile.self` box is inside the viewport; `#mic`, `#cam`, `#leave` boxes are inside the viewport with height ≥ 44 and do not intersect `.tile.self`; `#copy` in the header is visible.
- [x] **Step 2: Run.** Expected: the call test fails (the 16:9 tile and the bottom-right self view).
- [x] **Step 3: CSS.** `body.room { min-height: 0; height: 100vh; height: 100dvh; }` (the base `body { min-height: 100vh }` would otherwise win over `100dvh` when the address bar is shown). Under `@media (max-width: 700px)`: `.call { padding: 0 }`; `.tile { max-width: none; aspect-ratio: auto; height: 100%; border-radius: 0 }`; `.tile.self { top: 12px; right: 12px; bottom: auto; width: 28vw; height: auto; aspect-ratio: 3/4 }` (`height: auto` because the `.tile` rule above would otherwise make it a full-height strip); `footer { bottom: calc(12px + env(safe-area-inset-bottom)) }`; `footer button { min-height: 44px; padding: 10px 16px }`; `header #room-id { display: none }`; `.lobby { margin-top: 16px }`; `.preview { aspect-ratio: 3/4; max-height: 45dvh }`. Check the desktop look is unchanged by eye at 1280px (`lgx run`, a browser window).
- [x] **Step 4: Run** `lgx e2e`. Expected: all green, mobile included.
- [x] **Step 5: Commit.** `git commit -m "Room page: a layout for phones"`

> Deviation: the look by eye was done with headless screenshots of a real two-browser call at 1280×800 and 390×844 (an ad hoc script under `e2e/.tmp/`, not committed) rather than a windowed browser. It caught two phone-only problems the bounding-box test did not: the remote tile's name tag sat under the Mute button (now top left on phones), and the transparent ghost buttons were unreadable over video (now a dark translucent fill on phones). Desktop is unchanged.
> Codex (P2, fixed in a follow-up commit): on a landscape phone (667×375) the width-sized thumbnail reached the controls and the sound button fell below the viewport. The phone rules now also apply to short viewports (`max-height: 500px`), the thumbnail is sized by the smaller dimension (`min(28vw, 22vh)`), and the overlay sits beside it under the remote name tag, never below it. Fixing that exposed a second bug: a `<video>` has an intrinsic height, and without `min-height: 0` on the flex and grid items (and `minmax(0, 1fr)` for the row) the call area grew to it and pushed the absolutely positioned controls off screen on any short viewport. A landscape test in `mobile.spec.js` covers the banner, the sound button and the controls fitting together.
> Codex (P2, fixed in a follow-up commit): clipping the call area regressed short desktop windows (1280×550), where the 16:9 tile was cut off under the controls with no way to scroll. The desktop tile now has `max-height: 100%` and the call area reserves a bottom band for the controls, so the tile gives up 16:9 before it reaches them; a 1280×550 test in `mobile.spec.js` covers it. Side effect on a normal desktop window: the tile sits about 30px higher than before.
> Deviation: the status overlay on phones sits beside the self thumbnail, under the remote name tag, rather than at the top centre, so the three never overlap in either orientation.

### Task 7: Docs

**Files:**
- Modify: `README.md`, `docs/ROADMAP.md`, `docs/KNOWLEDGE.md`

- [x] **Step 1: README.** API section: the room lookup's `participants`, the token's 409. "Run" section: the lobby (preview, devices, who is there). Deployment section: replace "Staging is public, with no room expiry, participant cap or rate limit yet." with "Rooms are permanent and hold two people; staging is public, with no rate limit yet."
- [x] **Step 2: ROADMAP.** M2: mark the lobby, states, two-person rule as done 2026-09-29 (cite the tests); replace the room-lifetime bullet with the decision: rooms are permanent, expiry dropped, owners and deletion come with M3 and M4. Add to "Open questions" a resolved line: rooms are permanent, with the reasoning from decision 1.
- [x] **Step 3: KNOWLEDGE.** Under the livekit package section: the cap in config and how a refusal looks from the browser (500 on upgrade, `/rtc/validate` still `success`, hence the app-side count); the twirp JSON call, the admin grant, the 404 for an unknown room; `http/post` returns non-2xx as maps. Under the room page or a new "Browser side" section: `restartTrack` keeps attachments; iOS needs `startAudio` after a tap; `100dvh` and `viewport-fit=cover`.
- [x] **Step 4: Commit.** `git commit -m "docs: M2 lobby, states, two-person rule; rooms are permanent"`

### Task 8: Ship and check on real phones

**Files:** none

- [ ] **Step 1: PR and merge.** Push the branch, open a PR, wait for `test.yml`, merge. `deploy.yml` deploys staging.
- [ ] **Step 2: Real-device checklist (the user, two phones on different networks).** Lobby: preview shows, the camera picker lists front and back and switching works, "Nobody has joined yet" then "<name> is already here" on the second phone. Call: remote video fills the screen, the self view is top right, the controls are reachable above the home indicator, mute and video toggles work. iOS: if sound is silent, the "Tap to enable sound" button appears and works. Reconnect: toggle airplane mode for 5 seconds; "Reconnecting…" shows and the call resumes, or the lobby shows "Connection lost". Third phone or a laptop: the lobby says the meeting already has two people.
- [ ] **Step 3: Record.** Anything learned goes into `docs/KNOWLEDGE.md`; anything broken becomes a backlog entry (`/backlog`) or a fix. Commit as `docs: M2 verified on phones`.

---

## Execution summary

**Implemented** (branch `m2-reliable-call`, every task reviewed by codex; all must-fix findings fixed in follow-up commits and re-reviewed):
- `79fa2c8` docs: plan for M2, a call people can rely on, on phones
- `d666b77` SFU: two participants per room
- `0463d43` sfu: list a room's participants over the twirp API
- `3591f02` Rooms report who is in them; a third token is refused
- `86f004a` Room page: lobby with preview, device selection and presence
- `dbd2852` Room page: one join at a time; a failed join stops its preview tracks
- `ce51717` Room page: waiting, reconnecting and connection-lost states; iOS sound
- `98644ce` Room page: signalling-only recovery shows the reconnecting banner too
- `01429a8` Room page: a layout for phones
- `a38d32f` Room page: landscape phones; the call area no longer grows to the video
- `c1afd4b` Room page: a short desktop window keeps the tile above the controls
- `a99de0b` docs: M2 lobby, states, two-person rule; rooms are permanent

**Verification:** `lgx test` 13 tests / 76 assertions green. `lgx e2e` 14 specs green, and green again with `--repeat-each 2` (28 runs) and, mid-way, `--repeat-each 3` (30 runs). Layouts checked by eye from headless screenshots of a real two-browser call at 1280×800, 1280×550, 390×844 and 667×375 (script under `e2e/.tmp/`, not committed). One unit run showed a failure while a codex review was running `lgx test` at the same time on the same fixed SFU test port; alone it is green. Not verified here: real phones (Task 8).

**Codex findings that changed the code:**
- Task 4: a presence response in flight when Join was clicked could re-enable the button and start a second join; a failed connect leaked unpublished preview tracks. Fixed with a `joining` flag and a lobby that always stops the previous tracks.
- Task 5: the client raises `SignalReconnecting` before `Reconnecting`; the banner now follows both.
- Task 6, round 1: landscape phones. The phone rules now also apply to short viewports, the thumbnail is sized by the smaller dimension, and the overlay sits beside it. Fixing it exposed the `<video>` intrinsic-height overflow (`min-height: 0`, `minmax(0, 1fr)`).
- Task 6, round 2: clipping the call area regressed short desktop windows; the desktop tile now caps its height and the call area reserves a band for the controls.

**Deviations** (also noted under each task): `[hidden] { display: none !important }` was needed because the sections' `display: grid` beat the attribute, a bug that predates this plan; `newRoom` waits for the load state; a third media fallback (video without audio); mute and video button labels reset on every join; the look by eye was done with screenshots, not a windowed browser; the phone overlay sits beside the thumbnail rather than at the top.

**Not done:** Task 8's real-device checklist needs two phones; it is the user's step after the deploy.

**What the plan could have specified better:** viewports. It named one phone size and let "desktop keeps the current look" stand in for everything else; two of the four codex findings were viewports the plan never mentioned (landscape phones, short desktop windows), and both hid a CSS mechanism (intrinsic video height, `hidden` versus author display rules) that a plan cannot foresee but a test matrix of three or four sizes would have caught in the first run. Also: the fixed SFU port in `system_test.lg` makes two concurrent `lgx test` runs fail each other; a free port, as the http server already uses, would remove that.
