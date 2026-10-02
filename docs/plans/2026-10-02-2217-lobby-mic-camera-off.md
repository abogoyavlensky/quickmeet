# Microphone and Camera Off From the Lobby Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the lobby a person can turn the microphone and the camera off (and back on) before joining, and joins the call in that state.

**Tech Stack:** Plain JavaScript in `resources/public/room.html`, livekit-client 2.22.3 (`LocalTrack.mute` / `unmute`), CSS in `resources/public/app.css`, Playwright e2e (`lgx e2e`).

---

## Design

### What is built

Two round buttons on the lobby's preview, bottom centre: microphone and
camera. They look and read like the two in the call's controls (same icons,
same labels, off is the solid white one). The blur button stays in the
preview's bottom right corner.

- **Microphone off:** the lobby's audio track is muted. The person joins
  muted; the call's microphone button shows off and unmutes as it does today.
- **Camera off:** the lobby's video track is muted. The client stops the
  capture when a camera track is muted, so the camera light goes out. The
  preview shows "Camera is off" on black instead of a frozen last frame. The
  person joins with the camera off; the call's camera button shows off, the
  self view is hidden, and Start video restarts the same track (same device,
  blur kept).
- **Back on:** `unmute()`; for the camera the client restarts the capture and
  re-attaches it to the preview.

### How it works

The track is the truth, as with blur: a device is off while its lobby track
`isMuted`. No new state beyond one in-flight promise.

- `LocalTrack.mute()` / `unmute()` work on a track that is not published
  yet. `publishTrack` sends `muted: track.isMuted` in its add-track request
  (verified in the vendored 2.22.3 build), so a track muted in the lobby is
  published muted. After the join, `localParticipant.isMicrophoneEnabled` /
  `isCameraEnabled` read the publication's mute state, so the existing
  `showMic` / `showCam` calls draw the right thing with no change, and the
  existing `setMicrophoneEnabled(true)` / `setCameraEnabled(true)` unmute
  the same tracks.
- Verified in the vendored build: `LocalVideoTrack.mute()` stops the
  `mediaStreamTrack` when the source is the camera; `LocalAudioTrack.mute()`
  does not stop the microphone before publishing (`stopOnMute` is false), so
  the browser's microphone indicator stays on in the lobby while muted. That
  is the same as in the call today and is left alone.
- `lobby.switching`: the promise of a mute or unmute in flight, `null` when
  there is none (the shape of `blurBusy`). While it is set both buttons are
  disabled. `join()` awaits it after `lobby.ready`, before `blurBusy`, so a
  camera that is restarting is never published half way.
- `drawMedia()` draws both lobby buttons, the preview's off state and the
  device selects from the tracks:
  - a button is hidden when there is no track of its kind (no device, or
    access refused), like the blur button;
  - disabled while `lobby.switching` is set, and from the Join click until
    the lobby starts again (`lobby.joining`); the camera button also while
    a blur switch is in flight (`blurBusy`), so two operations never run on
    the camera track at once. `setBlur` therefore calls `drawMedia()`
    wherever it calls `drawBlur()`, and the click handler ignores a camera
    click while `blurBusy` is set;
  - icon and label as `showMic` / `showCam` use: `mic` "Mute" / `mic-off`
    "Unmute", `video` "Stop video" / `video-off` "Start video"; `data-off`
    and `aria-pressed="true"` when off;
  - `.preview` gets the class `cam-off` while the camera track is muted;
  - a device select is disabled while its track is muted (as well as in
    the cases `fillDevices` already covers: no devices, no track). Changing
    the device of a muted track would restart the capture behind a muted
    track; switching while off is not worth that.
  It is called from `startLobby` (before acquiring: no tracks, so both
  hidden), at the end of `fillDevices`, around every switch, and from
  `join()` next to `drawBlur()`.
- The click handler (one function for both kinds): if there is no track,
  a switch is in flight or `lobby.joining`, do nothing. Otherwise set
  `lobby.switching` to the `mute()` or `unmute()` promise, `drawMedia()` and
  `drawBlur()`, await it, clear `lobby.switching`, redraw both. A failed
  `unmute()` (camera unplugged or taken by another app) is shown with
  `showError` and the button stays off.
- Blur: `drawBlur` already disables the blur button while the camera track
  is muted, and the processor stays on the track through mute and unmute
  (the call does exactly this today). The handler calls `drawBlur()` so the
  preview's blur button follows the camera.

### Decisions

- **Every lobby starts with both on.** The choice is not remembered across
  page loads, and a return to the lobby after a call starts over as it does
  today. Remembering "camera off" well means not opening the camera at all
  on the next visit, which changes how tracks are acquired and how the
  device lists are filled; it can be added later if wanted.
- **Mute, not stop.** Tracks stay in `lobby.tracks` so the join path, the
  device choice and blur are untouched.
- **Device selects are disabled while their device is off.**
- **No lobby restart can race a switch.** `startLobby` runs on page load, on
  a failed join and on disconnect; the last two only after `join()` began,
  which disables the buttons and awaits `lobby.switching`. `startLobby`
  still resets `lobby.switching` to `null` for tidiness.

### Testing

Chromium e2e with the fake devices, in `e2e/tests/lobby.spec.js`:

- Lobby: both buttons visible once the preview plays. Camera off: the
  button has `data-off` and the label "Start video", `.preview` has
  `cam-off`, "Camera is off" is visible, the capture is stopped
  (`trackOfKind(Track.Kind.Video).mediaStreamTrack.readyState` is
  `'ended'`), `#cam-select` and `#blur-preview` are disabled. Back on: the
  preview plays again (`readyState` `'live'`, `videoWidth` > 0), `cam-off`
  gone, `#cam-select` enabled. Microphone off and on: `data-off`, label,
  `#mic-select` disabled then enabled.
- Call: alice turns both off in the lobby and joins; bob joins. Alice's
  `#mic` and `#cam` have `data-off` and her self view is hidden; alice sees
  and hears bob (her inbound stats grow); bob's inbound video frames from
  alice do not grow over two seconds. Alice clicks `#cam` and `#mic`: bob's
  `framesDecoded` and audio `packetsReceived` grow.

The second test is the proof that a track muted before publishing is
published and can be started from the call. If it fails in a way the design
above does not explain, stop and report; do not work around it.

## File Structure

- Modify `resources/public/room.html`: the two buttons in `.preview`, the
  "Camera is off" label, `lobby.switching`, `drawMedia`, the click handler,
  the calls from `startLobby`, `fillDevices` and `join`; comments (the
  lobby markup comment and the `lobby` state comment).
- Modify `resources/public/app.css`: the buttons on the preview, the
  `cam-off` state.
- Modify `e2e/tests/lobby.spec.js`: the two tests above.
- Modify `docs/KNOWLEDGE.md`, `docs/ROADMAP.md`: what was verified, a Done
  line.

## Tasks

### Task 1: The buttons in the lobby

**Files:**
- Modify: `resources/public/room.html`, `resources/public/app.css`
- Test: `e2e/tests/lobby.spec.js`

- [ ] **Step 1: Write the failing test**
  In `lobby.spec.js` add "the microphone and the camera can be turned off
  before joining", on the fixture page after `newRoom(page)`, with the
  lobby assertions from Testing above. Wait for the preview
  (`videoWidth` > 0) and for `#cam-preview` to be visible before clicking.
  After each click wait on the button's state (`toHaveAttribute('data-off', '')`
  or `not.toHaveAttribute('data-off')`) rather than on a timeout. Read the
  track state with `page.evaluate` (`trackOfKind` and `Track` are globals
  of the page's script, as `blur.spec.js` uses them).

- [ ] **Step 2: Run it to see it fail**
  Run: `lgx build && (cd e2e && npx playwright test tests/lobby.spec.js)`
  Expected: the new test FAILS (no `#cam-preview`); the others pass.

- [ ] **Step 3: Markup**
  In `.preview`, after `#blur-preview`:
  `<p class="cam-off-label">Camera is off</p>` and
  `<div class="preview-controls"><button id="mic-preview" hidden></button><button id="cam-preview" hidden></button></div>`.
  Update the comment above `#lobby` to mention them.

- [ ] **Step 4: Style**
  In `app.css`, with the "Round glass buttons over video" rules:
  - `.preview-controls`: absolute, bottom 12px, centred horizontally, a
    flex row with a 10px gap.
  - `.preview-controls button`: the same glass look and 44px size as
    `#blur-preview` (extend those selectors rather than repeating the
    declarations, except position, which is the row's), with the
    `[data-off]` state added to the solid white rule beside
    `#blur-preview[data-on]`.
  - `.cam-off-label`: hidden by default; under `.preview.cam-off` it is
    centred over the preview, white-ish muted text, and
    `.preview.cam-off video` is `visibility: hidden`.
  Check the phone layout (`.preview` is 3:4, at most 40dvh): the row and
  the blur button must not overlap at 360px wide; three 44px buttons with
  12px margins fit.

- [ ] **Step 5: Logic**
  In the lobby section of the script, as the design's "How it works"
  describes:
  - add `switching: null` to `lobby` and to its comment;
  - `drawMedia()`;
  - the click handler, wired to `#mic-preview` (`Track.Kind.Audio`) and
    `#cam-preview` (`Track.Kind.Video`);
  - `startLobby`: reset `lobby.switching`, call `drawMedia()` beside
    `drawBlur()`;
  - `fillDevices`: call `drawMedia()` at its end (it owns
    `select.disabled` from then on; keep the two rules in one place by
    having `drawMedia` compute `no options || !track || track.isMuted`).
  Hoisting: `drawMedia` uses `setIcon` and `drawBlur`; `drawBlur` is a
  function declaration further down, which is fine, but `startLobby` must
  not run before the `const`s it reads are initialised. `loadRoom()` is
  called at the end of the script, so declare any new `const` above that
  call as the existing code does.

- [ ] **Step 6: Run the lobby tests**
  Run: `lgx build && (cd e2e && npx playwright test tests/lobby.spec.js)`
  Expected: PASS.

- [ ] **Step 7: Commit**
  `git commit -m "Lobby: turn the microphone and the camera off before joining"`

### Task 2: Joining with them off

**Files:**
- Modify: `resources/public/room.html` (`join`)
- Test: `e2e/tests/lobby.spec.js`

- [ ] **Step 1: Write the test**
  "joining with both off publishes nothing until they are turned on", as
  in Testing above: `openLobby` for alice, click `#mic-preview` and
  `#cam-preview` (wait for `data-off` on each), click `#join`, wait for
  `window.call.joined`; `joinAs` bob. Use `statsOf` from `helpers.js`; a
  null `video` stat on bob's side counts as zero frames. Poll for growth
  with `expect.poll`, as `blur.spec.js` does with `framesGrow`.

- [ ] **Step 2: Run it**
  Run: `lgx build && (cd e2e && npx playwright test tests/lobby.spec.js)`
  It may already pass: Task 1 mutes the tracks and the join path publishes
  them as they are. Note the result either way.

- [ ] **Step 3: Implement**
  In `join()`: call `drawMedia()` beside the existing `drawBlur()` (the
  buttons go disabled with `lobby.joining`), and after `await lobby.ready`
  add `await lobby.switching` before `await blurBusy`. Extend the comment
  at the top of the script ("The lobby acquires the camera and microphone
  once…") with one sentence: either can be turned off there, and is then
  published muted.

- [ ] **Step 4: Run the lobby tests**
  Same command. Expected: PASS. If the join-with-camera-off test fails,
  see the note at the end of Testing: stop and report.

- [ ] **Step 5: Commit**
  `git commit -m "Lobby: join with the microphone or the camera off"`

### Task 3: Full suite

- [ ] **Step 1: Run everything**
  Run: `lgx test` and `lgx e2e`.
  Expected: all PASS. `blur.spec.js` and `mobile.spec.js` touch the same
  preview; fix what this change broke. An unrelated flake is reported, not
  patched.

- [ ] **Step 2: Look at it**
  With the built binary running (see "Browser tests" in the README for how
  the e2e config starts it), take a screenshot of the lobby at desktop
  size, at 390x844 and at 844x390 with the camera on and off, and check the buttons
  sit as designed and nothing overlaps.

### Task 4: Docs

**Files:**
- Modify: `docs/KNOWLEDGE.md`, `docs/ROADMAP.md`

- [ ] **Step 1: Write it down**
  `docs/KNOWLEDGE.md`, beside the 2026-09-29 `restartTrack` note: a local
  track can be muted before it is published and is then published muted;
  muting a camera track stops the capture and unmuting restarts it; a
  microphone track is not stopped on mute. Dated, and only what the tests
  confirmed. `docs/ROADMAP.md`, under "After v1": a dated Done line in the
  style of its neighbours, saying the choice is not remembered between
  visits.

- [ ] **Step 2: Commit**
  `git commit -m "docs: microphone and camera off from the lobby"`
