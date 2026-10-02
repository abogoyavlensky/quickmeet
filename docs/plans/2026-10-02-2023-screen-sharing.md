# Screen Sharing Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person in a call on a desktop browser can share their screen; the other person, on any device, sees it in place of the sharer's camera.

**Tech Stack:** Plain DOM and CSS in `resources/public/room.html`, `resources/public/app.css` and `resources/public/ui.js`; `livekit-client` 2.22.3 (vendored); Playwright via `lgx e2e` with headless Chromium and fake media. No server change.

---

## Design

### What it does

- The call's controls get a fifth button, **Share screen**, between the
  camera button and Leave. A click opens the browser's own picker (every
  monitor, window and tab); the choice is published as a second video
  track beside the camera. A second click, or the browser's "Stop
  sharing" bar, ends it.
- **The viewer** sees the screen in the main tile for as long as it is
  shared. The sharer's camera is not shown meanwhile; sound continues.
  When the share ends the camera comes back. The screen is always shown
  whole (`object-fit: contain`), on every device and in full screen: the
  crop-to-fill rule is for faces, not for text.
- **The sharer** does not see their own screen (it would be a hall of
  mirrors). The button is solid while sharing, and the status line says
  "You are sharing your screen." The main tile keeps showing the other
  person; the self view keeps showing the camera.
- **Phones** can watch but not share: the button is hidden there.
- Both people may share at once; each then sees the other's screen.
  Nothing is special-cased for it.

Out of scope, on purpose: the sharer's face in a second small tile
(decided in discussion: later, see Task 5), tab or system audio, any
quality settings (the client's defaults stand), zooming on a phone.

### What was verified before planning (2026-10-02)

- **No server change.** The join token (`src/quickmeet/routes.lg:436`)
  asks only for `:room-join`. The shim leaves `canPublish` nil when the
  key is absent, which upstream reads as "not restricted", and sets no
  `canPublishSources` (`livekit/shim/shim.go`, `Token`). The two-person
  cap counts participants, not tracks. History reads only participant
  and room events.
- **The client does the capture and the cleanup.**
  `room.localParticipant.setScreenShareEnabled(on, captureOptions)` calls
  `getDisplayMedia` and publishes or unpublishes. When the captured track
  ends by itself (the browser's "Stop sharing" bar, the shared window
  closing), the client unpublishes it (`handleTrackEnded` in
  `LocalParticipant`: a `ScreenShare` source is unpublished, not muted).
- **A page cannot choose the monitor.** `getDisplayMedia` always opens the
  browser's or the OS's picker. The page can only hint which tab of the
  picker opens first.
- **Mobile browsers.** iPhone Safari has no `getDisplayMedia` (through
  iOS 26). Chrome and Firefox for Android define it and reject every
  call, so feature detection alone would show a button that cannot work.
- **Headless Chromium answers `getDisplayMedia`** under the suite's
  existing flags (`--use-fake-ui-for-media-stream`): a track labelled
  `screen:-3:0`, 1280x720, `displaySurface: "monitor"`, with no prompt.
  Whether it delivers frames was not checked; the tests do not depend on
  it (see Testing).

### The viewer: which video is on stage

Today `TrackSubscribed` attaches every video track to `#remote`
(`room.html:540`), so a second video track would fight the camera for
the element. The page instead keeps both and decides:

- `remoteVideo = { camera: null, screen: null }` holds the subscribed
  remote video tracks by source: `screen` when
  `pub.source === Track.Source.ScreenShare`, `camera` otherwise.
- One function, `showRemote()`, puts the right one on stage: the screen
  if there is one, else the camera, else nothing. It detaches whichever
  track is on `#remote` now if it is not the chosen one
  (`track.detach($('remote'))`), attaches the chosen one, sets
  `window.call.tracks.video` to it, toggles the class `screen` on the
  remote tile, and calls `fitRemote()`. With nothing to show it calls
  `resetRemote()`.
- It runs on `TrackSubscribed` (video), on a new `TrackUnsubscribed`
  handler (which clears the slot; this is how a stopped share arrives),
  and the slots are cleared wherever the remote state is reset today
  (`ParticipantDisconnected`, `Disconnected`).
- `screen` belongs to `showRemote()` alone, and follows the selection,
  not the element: it is `!!remoteVideo.screen`, as is
  `call.remoteScreen`. `resetRemote()` must not remove it: `fitRemote()`
  calls `resetRemote()` whenever the element has no dimensions yet,
  which is the moment right after an attach, and a later `resize` runs
  only `fitRemote()`, so a class removed there would never come back.
  `fitRemote()` never sets `fill` while `remoteVideo.screen` is set. The
  tile's shape still follows the video (`--ratio`, `wide`/`tall`), so a
  screen of any shape fits the stage the way a camera does.

The camera track stays subscribed while the screen is on stage but is
attached to no element. The room runs with `adaptiveStream: true`, so
the client tells the SFU to pause a video nobody displays: the hidden
camera costs the viewer no bandwidth. This is also what makes the later
"face in a small tile" a viewer-side addition: a second `<video>` and
one more branch in `showRemote()`, nothing on the sending side.

`window.call` gains two read-only flags for tests and devtools, defined
like `call.blur` is: `sharing` (the local participant is sharing now)
and `remoteScreen` (the stage shows the other side's screen).

### The sharer: the button and the status line

- Markup: `<button id="share" hidden></button>` in `.controls` after
  `#cam`. Icon `screen` in `ui.js` (a monitor with an up arrow), labels
  "Share screen" / "Stop sharing", `data-on` and `aria-pressed` while
  sharing. `data-on` already has the solid style in `app.css:194`.
- Whether the button exists at all:

  ```js
  const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)
    && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    && !(navigator.userAgentData && navigator.userAgentData.mobile);
  ```

  The device decides, not the window's size: a narrow desktop window can
  share, an Android tablet cannot.
- The track is the truth, as with blur: `sharing()` is
  `room.localParticipant.isScreenShareEnabled`, and `drawShare()` draws
  the button from it. `drawShare()` runs after a join, after each click
  settles, and on `RoomEvent.LocalTrackPublished` and
  `RoomEvent.LocalTrackUnpublished`, so a share ended from the browser's
  own bar turns the button off without a click. Both events also call
  `refreshStatus(room)`.
- The click: `setScreenShareEnabled(!sharing(), { audio: false, video: { displaySurface: 'monitor' } })`.
  The hint opens the picker on "Entire screen"; the person can still pick
  a window or a tab. Confirm in the vendored bundle that 2.22.3 accepts
  the object form of `video` (search it for `displaySurface`); if it does
  not, pass `{ audio: false }` and drop the hint. While the picker is
  open the button is disabled, so a second click cannot start a second
  capture.
- Errors: closing the picker rejects with `NotAllowedError`; that is a
  decision, not a failure, and nothing is shown. Any other error shows
  "Screen sharing is not available here." in the status line for four
  seconds, the way `blurFailed()` does.
- The status line has one owner. `refreshStatus(room)` becomes: alone →
  "Waiting for the other person." (as now); else sharing → "You are
  sharing your screen."; else nothing. `ParticipantConnected`, which
  today calls `setStatus(null)`, calls `refreshStatus(room)` instead so
  it cannot wipe the sharing line. A visible status line already keeps
  the bar and controls from fading in full screen (`wake()` treats it as
  busy); for a sharer that is right, the way to stop stays on screen.
- Leaving or losing the connection needs nothing new: the client stops
  and unpublishes published tracks on disconnect, and the lobby starts
  over. `#share` is hidden outside a call with the rest of `#call`.

### Testing

A new spec, `e2e/tests/screenshare.spec.js`, with a new helper beside
`canvasCamera` in `e2e/tests/helpers.js`:

- `canvasScreen(width, height)`: an init script that replaces
  `navigator.mediaDevices.getDisplayMedia` with a function returning a
  `canvas.captureStream(15)` of that size, repainted on a timer like
  `canvasCamera`. This gives the screen a shape the fake camera does not
  have (the camera arrives 16:9), so a test can tell which one is on
  stage by `videoWidth / videoHeight`, and it does not depend on the
  headless shell's fake monitor delivering frames.
- `noScreen`: an init script whose `getDisplayMedia` rejects with
  `new DOMException('denied', 'NotAllowedError')`, the closed picker.

The browser's "Stop sharing" bar is simulated by dispatching `ended` on
the published screen track's `mediaStreamTrack`, which is the event the
client listens for.

Real browsers are not covered by this: the picker on Chrome, Firefox and
Safari, and a phone watching, are checked by hand on staging after the
merge (Task 4 records that this is still to do).

## File Structure

- `resources/public/ui.js` — modify: the `screen` icon.
- `resources/public/room.html` — modify: the `#share` button; the
  remote-video selection (`remoteVideo`, `showRemote`); the share logic
  (`canShare`, `sharing`, `drawShare`, the click); `refreshStatus`.
- `resources/public/app.css` — modify only if the five controls need it
  (see Task 2, step 4); the `screen` class needs no rule of its own.
- `e2e/tests/helpers.js` — modify: `canvasScreen`, `noScreen`.
- `e2e/tests/screenshare.spec.js` — create: the spec.
- `docs/ROADMAP.md`, `docs/KNOWLEDGE.md`, `README.md` — modify: the
  scope change and the verified facts.
- `docs/backlog/screen-share-face-tile.md` — create, in its own commit.

Commands used throughout, from the repository root:

- One spec: `lgx build && (cd e2e && npx playwright test screenshare)`
- Everything: `lgx e2e`

On this dev machine the pinned lgx may have to be called by path with
`CGO_ENABLED=0` exported (see "Dev tooling gotchas" in
`docs/KNOWLEDGE.md`).

Work on a branch (`screen-sharing`), not on master.

---

### Task 1: The viewer shows a shared screen

**Files:**
- Modify: `e2e/tests/helpers.js`
- Create: `e2e/tests/screenshare.spec.js`
- Modify: `resources/public/room.html`

- [x] **Step 1: Add the test helpers**
  In `helpers.js`, export `canvasScreen(width, height)` and `noScreen`
  as described under Testing. Reuse `canvasCamera`'s painting loop
  rather than copying it: pull the "canvas repainted on a timer, return
  its video track" part into one function inside the init script, or
  into a shared string, whichever keeps both init scripts
  self-contained (an init script cannot close over module scope).

- [x] **Step 2: Write the failing viewer tests**
  In `screenshare.spec.js`, with the `contexts` setup and teardown the
  other specs use. The sharer starts a share from the test, not from the
  button (the button comes in Task 2):
  `page.evaluate(() => window.call.room.localParticipant.setScreenShareEnabled(true))`,
  and stops with `false`. The sharer joins with
  `{ init: canvasScreen(800, 600) }`.

  1. *A shared screen takes the stage and the camera comes back after.*
     Alice (sharer) and Bob join. Before sharing, Bob's remote ratio is
     about 16:9 and `call.remoteScreen` is false. Alice shares: Bob's
     `#remote` reaches a ratio of about 4:3 (`expect.poll`, within 2%),
     the remote tile has the class `screen`, `call.remoteScreen` is
     true, and `framesDecoded` from `statsOf(bob.page)` grows between
     two reads. Alice stops: Bob's ratio returns to about 16:9, the
     class is gone, frames still grow.
  2. *Someone who joins during a share sees the screen.* Alice joins
     alone and shares, then Bob joins: once Bob's ratio is about 4:3,
     the tile has the class `screen`, `#remote` has computed
     `object-fit: contain` and `call.remoteScreen` is true. This holds
     whichever of the two tracks is subscribed first. Run it a second
     time with Alice's camera stopped before she shares (`#cam`), so the
     screen is the only video Bob ever gets.
  3. *A screen is never cropped.* Bob is a phone lying sideways
     (`{ viewport: { width: 667, height: 375 }, isMobile: true, hasTouch: true }`),
     Alice shares a `canvasScreen(1280, 720)`. First, without a share,
     Bob's `#remote` has computed `object-fit: cover` (the 16:9 camera
     fills a sideways phone, as `orientation.spec.js` shows). During the
     share it is `contain`; after, `cover` again.
  4. *The sharer leaving clears the stage.* Alice shares, then leaves:
     Bob's tile loses `screen` and returns to the default 16:9 shape,
     and `call.remoteScreen` is false.

- [x] **Step 3: Run them and see them fail**
  Run: `lgx build && (cd e2e && npx playwright test screenshare)`
  Expected: FAIL (`call.remoteScreen` is undefined, no `screen` class).

- [x] **Step 4: Implement the selection in `room.html`**
  Add `remoteVideo`, `showRemote()` and `call.remoteScreen` as in
  "The viewer" above, next to `fitRemote`. Change the `TrackSubscribed`
  handler to file a video track under its source and call
  `showRemote()` (audio and `arrived` stay as they are). Add a
  `TrackUnsubscribed` handler that clears the matching slot and calls
  `showRemote()`. Clear both slots in `ParticipantDisconnected` and
  `Disconnected` where `call.tracks` is reset, and call `showRemote()`
  there so the `screen` class goes with them. Make `fitRemote()` skip
  `fill` while `remoteVideo.screen` is set; leave `screen` out of
  `resetRemote()` (see "The viewer").
  Update the comment above `window.call` for the new fields.

- [x] **Step 5: Run the spec, then the specs that share this code**
  Run: `lgx build && (cd e2e && npx playwright test screenshare orientation call mobile)`
  Expected: PASS. `orientation`, `call` and `mobile` exercise the same
  attach path with a camera only and must be unchanged.

- [x] **Step 6: Commit**
  `git commit -m "Room page: a shared screen takes the stage"`

> Deviation: "the sharer has no camera" is the sharer turning the camera off (`#cam`) before sharing. The muted camera stays published, so Bob still subscribes to a camera track; it just never sends a frame. That still exercises the case the review raised: a screen that has to win while metadata is pending.
> Deviation: `canvasScreen` and `canvasMedia('user', ...)` share one init function, `canvasMedia(api, width, height)`; the two existing cameras are defined through it.
> Deviation: `startLobby` calls `clearRemote()` instead of `resetRemote()`, so a failed join cannot leave a stale slot or the `screen` class behind.

### Task 2: The share button

**Files:**
- Modify: `resources/public/ui.js`
- Modify: `resources/public/room.html`
- Modify: `resources/public/app.css` (only if step 4 says so)
- Modify: `e2e/tests/screenshare.spec.js`

- [x] **Step 1: Write the failing sharer tests**
  Add to `screenshare.spec.js`, all at a desktop viewport
  (`{ viewport: { width: 1280, height: 800 } }`):

  1. *The button shares and stops.* Alice joins with
     `canvasScreen(800, 600)`, Bob joins. `#share` is visible on Alice's
     page, labelled "Share screen", `aria-pressed="false"`. Click: it
     becomes "Stop sharing", `aria-pressed="true"`, has `data-on`;
     `#status` reads "You are sharing your screen."; `call.sharing` is
     true; Bob's `call.remoteScreen` is true. Alice's own `#remote`
     still shows Bob's camera (ratio about 16:9) and her
     `call.remoteScreen` is false. Click again: all of it reverts and
     `#status` is hidden.
  2. *A share ended by the browser turns the button off.* After sharing,
     in Alice's page dispatch `new Event('ended')` on
     `call.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.ScreenShare).track.mediaStreamTrack`.
     The button returns to "Share screen", `#status` hides,
     `call.sharing` is false, Bob's `call.remoteScreen` is false.
  3. *A closed picker is not an error.* Alice joins with `noScreen`.
     Click `#share`: the button stays "Share screen" and enabled,
     `#status` stays hidden, `call.sharing` is false.
  4. *Sharing alone keeps the waiting line.* Alice joins alone and
     shares: `#status` reads "Waiting for the other person." and the
     button is on. Bob joins: Alice's `#status` reads "You are sharing
     your screen."
  5. *A phone has no button.* A participant joined with
     `{ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: <a current Chrome-on-Android string> }`:
     `#share` is hidden. The same test, or the first one, already shows
     a desktop has it.

- [x] **Step 2: Run them and see them fail**
  Run: `lgx build && (cd e2e && npx playwright test screenshare)`
  Expected: the Task 1 tests PASS, the new ones FAIL (no `#share`).

- [x] **Step 3: Implement**
  `ui.js`: add `screen` to `ICONS`, in the set's style (24x24, outline,
  1.75 stroke): a monitor on a stand with an arrow pointing up inside
  it; extend the comment above `ICONS` only if it stops being true.
  `room.html`: the button in the markup; a `// ---- screen sharing ----`
  section after the blur section with `canShare`, `sharing()`,
  `drawShare()`, the busy flag, the click handler and the failure line,
  as in "The sharer" above; `call.sharing` defined like `call.blur`;
  `refreshStatus` with the three cases; `ParticipantConnected` calling
  `refreshStatus(room)`; the two local-track events; `drawShare()` after
  the join beside `showMic`/`showCam`. The click handler is assigned in
  `join()` with the others (`$('share').onclick = ...`), since it needs
  the room. Check the object form of `video` in the bundle, as the
  design says.

- [x] **Step 4: Look at the controls with five buttons**
  The controls are 56 px buttons with a 14 px gap (`app.css:182-196`);
  five of them plus the wider Leave need about 370 px, so a desktop
  window has room and a phone never has five. Take a headless
  screenshot of Alice's call page at 1280x800 while sharing, and one at
  a 720x420 window (a short desktop window, where the layout is
  immersive but the button exists), and look at both: the buttons in
  one row, nothing clipped, the status line readable. Change `app.css`
  only if something is wrong; if so, describe it in the commit.

- [x] **Step 5: Run the spec and its neighbours**
  Run: `lgx build && (cd e2e && npx playwright test screenshare call mobile blur --workers 1)`
  Expected: PASS. (`--workers 1` because blurring pages starve each
  other in parallel; see "Background blur" in `docs/KNOWLEDGE.md`.)

- [x] **Step 6: Commit**
  `git commit -m "Room page: share your screen from a desktop browser"`

> Deviation: the object form of `video` exists in 2.22.3 (`Aa` in the bundle merges the resolution into it), so the `displaySurface` hint stays.
> Deviation: the local-track events filter on the screen source before redrawing; the camera and microphone publish through the same events at every join.
> Deviation: `toggleShare` does not call `refreshStatus` itself. The publish and unpublish events do, and calling it after a failure would wipe the four-second failure line.
> Step 4: screenshots at 1280x800 and 720x420 showed one row of five buttons, the status line readable, and the viewer's 4:3 screen letterboxed. No CSS change.

### Task 3: The whole suite

- [ ] **Step 1: Run everything**
  Run: `lgx e2e`
  Expected: PASS, every spec. Then repeat the new spec for flakiness:
  `cd e2e && npx playwright test screenshare --repeat-each 5`
  Expected: PASS, 5 of 5 for each test. Fix what is flaky in the test
  or the page; do not raise timeouts to hide a race.

- [ ] **Step 2: Commit any fixes**
  Only if step 1 changed something.

### Task 4: Docs

**Files:**
- Modify: `docs/ROADMAP.md`
- Modify: `docs/KNOWLEDGE.md`
- Modify: `README.md`

- [ ] **Step 1: ROADMAP**
  In "Non-goals for v1", take "screen sharing" out of the first bullet
  and say in a short clause where it went. Under "After v1", add a
  dated "Done" entry in the style of the PWA one: screen sharing from
  desktop browsers, the screen takes the stage on the other side, the
  button is hidden on phones because mobile browsers cannot capture the
  screen, `e2e/tests/screenshare.spec.js`; not yet tried in real
  browsers (the picker in Chrome, Firefox and Safari; a phone
  watching). Reduce the existing "More than two people, screen sharing,
  chat over LiveKit data channels" bullet to what is still open, and
  point at the backlog entry of Task 5 for the face tile.

- [ ] **Step 2: KNOWLEDGE**
  A new section, "Screen sharing, verified <the date>", with the facts
  from "What was verified before planning" above plus whatever the
  implementation taught (whether the object form of `video` exists in
  2.22.3; whether the headless fake monitor delivers frames, if that
  was seen; that a track attached to no element is paused under
  `adaptiveStream`, if the stats showed it). Only what was checked.
  Extend the "Verify against" footer if a new upstream file was read.

- [ ] **Step 3: README**
  Read the README's feature and "Browser tests" parts; add screen
  sharing where features are listed and the new spec where specs are,
  if those lists exist. Change nothing otherwise.

- [ ] **Step 4: Commit**
  `git commit -m "Docs: screen sharing"`

### Task 5: Backlog the face tile

**Files:**
- Create: `docs/backlog/screen-share-face-tile.md`

- [ ] **Step 1: Write the entry**
  Use /backlog. Title: while a screen is shared, show the sharer's face
  in a second small tile. Starts with `**Status: open**`. Say what is
  there now (the camera is hidden while the screen is on stage), why it
  was deferred (two small tiles need placing on a phone in both
  orientations, which has taken real-device rounds every time), and
  where it would go (`showRemote()` in `room.html`: the camera track is
  still subscribed, so it is a second `<video>` on the viewer's side
  only). Mention tab audio in one line as the other thing left out.

- [ ] **Step 2: Commit, on its own**
  `git commit -m "Backlog: the sharer's face beside a shared screen"`
  (`AGENTS.md`: a backlog entry is never mixed with code.)
