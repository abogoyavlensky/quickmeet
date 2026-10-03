# Switch Camera and Devices in a Call Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person in a call can switch cameras with one tap (a phone flips front/back, a desktop moves to its next camera), and a desktop can pick an exact camera and microphone from a small panel in the bar; blur moves onto the self view to make room.

**Tech Stack:** Plain JavaScript and CSS in `resources/public/room.html`, `resources/public/app.css` and `resources/public/ui.js`; livekit-client 2.22.3 (vendored; `LocalTrack.restartTrack`); Playwright e2e in `e2e/` (`lgx e2e`). No server change.

---

## Design

### What changes on the call page

Three things, decided in discussion on 2026-10-03:

1. **Switch camera** is a round button in the controls row, in the slot
   blur has today: mic, camera, switch camera, share (desktop only),
   leave. Flipping is the one device action people do several times in a
   call ("look at this"), so it gets the prominent one-tap spot. It is
   shown only when the browser reports more than one camera, on every
   platform, and follows cameras plugged in or unplugged mid-call. The
   row keeps today's width on a phone (four buttons, 286 px).
2. **Blur moves onto the self view**, a 40 px glass button in the
   thumbnail's top right corner. Blur is set once and forgotten, and the
   lobby already keeps its blur button on your own picture (the
   preview's corner), so "blur lives on your picture" becomes true in
   both places. It is hidden with the thumbnail while the camera is off,
   which matches the existing rule that blur waits while the camera is
   muted. Same element, same id (`#blur`), same logic; only its place
   and style change.
3. **A "more" button (three vertical dots) at the right end of the bar,
   desktop only**, opens a small panel under the bar with two pickers,
   Camera and Microphone, the lobby's devices row reachable in the call.
   This is the precise path: the controls button cycles, the panel picks.
   Phones get no panel: the OS routes a headset itself, and the flip
   button is the whole camera story there. The bar's right end is
   already the tray for secondary, desktop-leaning actions (full screen,
   hidden on iPhones; copy link), so the panel belongs with them.

The same thing in the same place on every platform; what differs by
device is only what "the other camera" means (below) and whether the
panel exists, the way share and full screen already vary.

### What the switch button does

One tap, no menu:

- **On a handheld** (the user-agent test screen sharing already uses:
  Android, iPhone, iPad): flips between the front and the back camera by
  facing: `facingMode: { exact: 'environment' }` from the front, `{
  exact: 'user' }` from the back. Facing, not device, because iPhones
  report several back cameras ("Back Camera", "Back Ultra Wide Camera",
  …) and cycling through them would be wrong exactly where flipping
  matters. Label "Flip camera".
- **On a desktop:** moves to the next camera in the enumerated list
  (after the current one, wrapping), by `deviceId`. With two cameras that
  is a flip; with more it takes repeated clicks, and the panel is there
  for picking exactly one. Label "Switch camera".

Every device switch, from the button, the panel or the lobby's pickers,
goes through one function, `switchDevice(kind, options)`, where `kind`
is `Track.Kind.Video` or `Track.Kind.Audio` and `options` is what
`restartTrack` takes (`{ deviceId: { exact: id } }` or `{ facingMode: {
exact: side } }`). For video it adds `resolution:
VideoPresets.h720.resolution`: `restartTrack` asks `getUserMedia` for
the device alone and applies the rest with `applyConstraints` (verified
in the vendored build), so without it a switched camera captures at the
browser's default for that device. The lobby's camera picker uses the
same function and gains the same resolution.

### How a switch works, and what can go wrong

`LocalTrack.restartTrack(options)` stops the current capture, asks
`getUserMedia` for the new one, swaps it into the published sender and
every attached element, and (video) restarts the blur processor on it.
That is the library's own path for an in-call device switch
(`Room.switchActiveDevice` ends in it), for the microphone as for the
camera, so the other side hears and sees the new device with no
re-publish.

Because the old capture is stopped *before* the new one is asked for, a
failed switch (a `facingMode` the device does not have, a device another
app holds) leaves the track with a dead capture. So `switchDevice`
notes the current device id first and, if the restart throws, restarts
again with `{ deviceId: { exact: thatId } }` (or with no device, the
default, if there was no id), then says "Could not switch camera." or
"Could not switch microphone." in the status line for four seconds, the
way a failed share is said (in the lobby, through `showError`, as the
pickers do today). If the revert fails too the device is dead; the
person sees the message and can turn the device off and on, which
restarts it (an existing path). Nothing more is built for that.

A phone with one camera of each side flips; a phone that reports two
cameras on the same side gets the message and keeps its camera. That is
acceptable: the button is offered on device count, not on which way the
cameras face, because the labels that would say so are not reliable
across browsers.

**One thing at a time on a track.** `busy[kind]` is the promise of a
switch in flight for that kind, null when there is none (the shape of
`blurBusy` and `lobby.switching`). While `busy.video` is set, the switch
button, the blur button, both camera on/off buttons (lobby and call) and
both camera pickers are disabled; while `busy.audio` is set, both
microphone on/off buttons and both microphone pickers are. `join()`
waits for both after `lobby.switching`. A switch refuses to start while
`lobby.switching` is set, while its track is muted (the lobby pickers
already follow that rule), while a join is publishing (`lobby.joining
&& !window.call.joined`, the rule the blur button already follows: a
restart then could reach the other side half done), and, for video,
while `blurBusy` is set.

**A switch that outlives its track.** Leaving (or losing the connection)
during a switch returns to the lobby, which stops and discards the
tracks (`stopTracks`) and acquires new ones, while the restart is still
in flight on the old track. The library covers the restart itself: a
track stopped during a restart stops the capture it acquired
(`manuallyStopped`, verified in the vendored build). The revert would
not be covered: a second `restartTrack` resets that flag and
re-acquires a device nobody uses. So `switchDevice` reverts only while
its track is still the lobby's track of that kind (`track ===
trackOfKind(kind)`), and after either outcome stops the track if it no
longer is. `join()` waits for `busy`, so a lobby switch never overlaps
a join. `busy[kind]` stays set until that old switch ends, which
disables the new lobby's button and picker of that kind for the
restart's remaining time; acceptable.

### Which way the camera faces: the mirror

Your own picture is a mirror (`transform: scaleX(-1)` on the preview and
the self view). A back camera must not be mirrored: it shows the world,
and text in it would read backwards. The page reads the track's source
settings (`track.getSourceTrackSettings()`; the source's, because with
blur on the track's `mediaStreamTrack` is the processed one and has no
settings worth reading) and sets the class `rear-camera` on `body` while
`facingMode` says `environment`. The CSS turns the mirror off under that
class, for the preview and for the self view. A desktop camera reports
no `facingMode` and stays mirrored. The other side is unaffected: the
mirror is local CSS.

`settingsOf(kind)` returns the source settings of the track of that
kind (`{}` with no track). `fillDevices` reads the current ids through
it; today it reads `mediaStreamTrack.getSettings()`, which only works
for the camera because blur is restored after it.

### The device lists and the four pickers

`fillDevices` already enumerates both kinds for the lobby pickers; it
now keeps the lists in `devices = { video: [], audio: [] }` and fills
four selects from them: the lobby's `#cam-select` and `#mic-select` and
the panel's `#cam-pick` and `#mic-pick`, through one `fillSelect(select,
list, currentId, fallback)`. One `devicechange` listener on
`navigator.mediaDevices` re-runs `fillDevices` (once tracks exist) so a
camera or microphone plugged in or unplugged during a call shows up or
goes away, in the lists and in the switch button's visibility. Labels
come through because permission was granted when the lobby acquired the
tracks.

The four selects share two change handlers: a camera select calls
`switchDevice(Video, { deviceId: { exact: value } })`, a microphone
select `switchDevice(Audio, …)`. After any switch or revert, `drawDevices`
sets every select to its kind's current source `deviceId` when one of
its options has it, so a switch made anywhere shows everywhere.

### Drawing

`drawDevices()` is the one place the switch button, the mirror and the
four selects' values are drawn from state. It runs at the end of
`drawMedia()` (which is called from `startLobby`, `fillDevices`, around
every mute switch and from `join`), from `showCam`, and around a device
switch:

- `#switch-cam` is hidden unless there is a camera track and
  `devices.video.length > 1`; disabled while `busy.video`, `blurBusy`,
  `lobby.switching`, a join is publishing, or the camera is muted. Icon
  `flip` (new, in `ui.js`), label "Flip camera" on a handheld, "Switch
  camera" elsewhere.
- `body.rear-camera` follows the camera's source `facingMode`.
- Each select's `value` follows its kind's source `deviceId`; each is
  disabled by the rule `drawMedia` applies to the lobby pickers today
  (no options, no track, muted, `lobby.switching`), plus `busy[kind]`
  and, for the lobby's, a join publishing.

`drawMedia` also disables the lobby's camera and microphone buttons
while `busy` of their kind is set; `drawBlur` adds `busy.video` to its
condition; the call's `#mic` and `#cam` handlers return early while
`busy` of their kind is set, and `drawDevices` sets their `disabled`
once the call is up.

The three four-second status messages (`blurFailed` in the call,
`shareFailed`, and the two new ones) share one helper, `flash(text)`:
set the status, and after four seconds, if the status still says that
text and the room is up, `refreshStatus`. `blurFailed` keeps its lobby
branch (`showNotice`) and calls `flash` for the call.

### The panel

- `#more` in the bar's `.end`, after `#copy`: a 40 px round bar button
  like its neighbours, icon `more` (three vertical dots, new in `ui.js`),
  label "Settings", `aria-haspopup="dialog"`, `aria-expanded`. Hidden on
  handhelds (`handheld`) and outside the call (the CSS rule that hides
  `#full` outside the call takes `#more` too).
- `#settings`, inside `.bar .end` after `#more`: `<div id="settings"
  class="panel" hidden>` with `<label>Camera <select id="cam-pick">
  </select></label>` and `<label>Microphone <select id="mic-pick">
  </select></label>`, the lobby's `.devices` markup. `.end` becomes
  `position: relative` and the panel hangs from it: `position: absolute;
  top: calc(100% + 6px); right: 0; width: 280px; display: grid; gap:
  10px; padding: 14px; border-radius: 14px;` dark glass
  (`rgba(0,0,0,.75)` with the backdrop blur), `text-align: left`. The
  selects take the app's `select` style, which is dark on the room page
  already.
- `#more` toggles the panel; it closes on Escape, on a click outside
  `.end`, and when the page leaves the call (`show()` for any section
  other than `call`). `wake()` counts an open panel as "something to
  read", so in full screen the bar does not fade from under it. The
  panel is inside the bar, so it fades with it otherwise.
- The panel can always be opened; a select that must wait (muted
  track, a switch in flight) just shows as disabled, as the lobby's do.

### Layout of the controls and the self view

- `.controls`: `#blur` leaves it; `#switch-cam` goes between `#cam` and
  `#share`. The existing size and glass rules apply unchanged.
- `#blur` moves inside `.tile.self` after the `<video>`:
  `position: absolute; top: 8px; right: 8px`, 40 px, the `.preview
  button` glass look (extend that selector list; the preview's buttons
  are 44 px, this one is 40 px for a 109 px thumbnail on a phone). The
  tile is already `position: absolute` with `overflow: hidden`, so the
  button clips to its rounded corner, which is fine. Its solid "on"
  state keeps the `.preview button[data-on]`-style rule
  (`#blur[data-on]`). In immersive mode it fades with the bar and the
  controls (`.immersive.idle .tile.self button` joins the transition and
  the opacity/pointer-events rules; the wake tap that brings things back
  already swallows its click at document level).
- `body.rear-camera .preview video, body.rear-camera .tile.self video { transform: none; }`.

### Not built

- Speaker (audio output) selection. `setSinkId` is desktop Chrome and
  Firefox only; add a third picker to the panel when wanted.
- Remembering the camera or microphone between visits, or across a
  return to the lobby: every lobby starts as today.
- A flip button on the lobby preview for phones: the lobby's picker
  lists the phone's cameras already.
- A panel on phones.

### Testing

Headless Chromium exposes **one** fake camera (`fake_device_0`) and three
fake microphones (verified 2026-10-03 with the suite's flags), so the
switch button would never appear. A helper in `e2e/tests/helpers.js`,
`twoCameras({ backFails, backDelay } = {})`, is an init script (like
`canvasMedia`) that:

- wraps `navigator.mediaDevices.enumerateDevices` to append a `videoinput`
  `{ deviceId: 'back', groupId: '', label: 'Back Camera' }` (a plain
  object with a `toJSON`);
- wraps `getUserMedia`: a request whose `video.deviceId.exact` is `'back'`
  or whose `video.facingMode` is (or has `exact`) `'environment'` resolves
  to a stream with a repainted 640x480 canvas track, with `getSettings`
  on that track returning `{ deviceId: 'back', facingMode: 'environment',
  width: 640, height: 480 }`, `applyConstraints` resolving, and `label`
  "Back Camera" — unless `backFails`, when it throws
  `new DOMException('no such camera', 'OverconstrainedError')`; with
  `backDelay` (ms) it waits that long before answering either way. Any
  other video request goes to the real `getUserMedia` with `facingMode`
  removed from the constraints (the fake device refuses an exact
  `facingMode`, verified 2026-10-03), so the front camera is the 16:9
  fake device. Audio requests pass through untouched.

The other side tells the cameras apart by shape: `#remote`'s
`videoWidth / videoHeight` is 16:9 from the fake device and 4:3 from the
canvas. Microphones are told apart by the source `deviceId`, and a
switch is proven by the other side's audio `packetsReceived` growing
past a count taken after it. `e2e/tests/camera.spec.js`:

1. **A phone flips to the back camera and back.** Android context (as in
   `screenshare.spec.js`) with `init: twoCameras()`; alice joins, bob
   joins. `#switch-cam` is visible in the controls with label "Flip
   camera"; `#more` is hidden; `#blur`'s box lies inside `.tile.self`'s
   box. Click: the source settings (`trackOfKind('video').getSourceTrackSettings()`)
   say `facingMode` `environment`; `body` has `rear-camera`; the
   computed `transform` of `#local` is `none`; bob's remote ratio polls
   to about 1.33 and bob's `framesDecoded` keep growing. Click again:
   `rear-camera` gone, the ratio polls back to about 1.78.
2. **A desktop moves to the next camera.** Desktop viewport with
   `twoCameras()`. Label "Switch camera". Click: the source `deviceId` is
   `'back'`, bob's ratio polls to about 1.33, `#cam-select` and
   `#cam-pick` both have value `'back'`. Click again: back to the fake
   device, ratio about 1.78. Then `#cam` off: the thumbnail, `#blur` and
   the switch stay consistent (`.tile.self` hidden, `#switch-cam`
   disabled); `#cam` on: back. Before all that, alice is opened with
   `openLobby` and joined by hand: right after the `#join` click
   `#cam-select` is disabled, and once `window.call.joined` is true it is
   enabled again.
3. **With one camera there is nothing to switch.** Default context: after
   joining, `#switch-cam` is hidden and `#more` is visible (desktop).
4. **A camera that cannot start leaves the old one running.** Android
   context with `twoCameras({ backFails: true })`. Click: `#status` shows
   "Could not switch camera."; the source `facingMode` is not
   `environment`, `body` has no `rear-camera`, the track's
   `mediaStreamTrack.readyState` is `'live'`, and bob's frames keep
   growing past a count taken after the click.
5. **Leaving during a switch leaves no camera running.** Android context
   with `twoCameras({ backDelay: 2000 })`. Keep the call's camera track
   from the page (`window.__before = trackOfKind('video')`), click
   `#switch-cam`, then `#leave` at once; wait for `#lobby` to be visible
   and the preview to play. Poll: `__before.mediaStreamTrack.readyState`
   is `'ended'`, the lobby's camera is a different track object, and
   `#error` is hidden. Repeat with `{ backDelay: 2000, backFails: true }`
   for the revert path: the same checks.
6. **The panel picks a camera and a microphone.** Desktop with
   `twoCameras()`. `#more` visible; click opens `#settings` with
   `#cam-pick` (two options, "fake_device_0" selected) and `#mic-pick`
   (three options). Select `'back'` in `#cam-pick`: source `deviceId`
   `'back'`, bob's ratio about 1.33. Select the last option in
   `#mic-pick`: the audio track's source `deviceId` equals it, bob's
   audio `packetsReceived` grows past a count taken after the change,
   and `#mic-select` shows the same value. Escape closes the panel;
   `#more` has `aria-expanded` `false`. Open it again and click on
   `#remote`: closed. `#leave`: the panel is closed and `#more` hidden in
   the lobby.

`blur.spec.js` keeps passing as written: its call-side assertions on
`#blur` (disabled while the camera is off, enabled and clickable after)
hold for the moved button, since `drawBlur` still disables it and the
tile is shown again with the camera. `mobile.spec.js` lists `#blur`
among the controls it measures; those lists change (Task 1).

`lgx test` (the server suite) is unaffected; run it once at the end.

## File Structure

- Modify `resources/public/room.html`: `#blur` into the self tile,
  `#switch-cam` in the controls, `#more` and `#settings` in the bar;
  `devices`, `busy`, `settingsOf`, `switchDevice`, `drawDevices`,
  `fillSelect`, the panel open/close logic, `flash`, the `devicechange`
  listener; `fillDevices`, the pickers' handlers, `showCam`, `showMic`,
  `drawBlur`, `drawMedia`, `join`, `wake`, `show`, the `#mic` and `#cam`
  click handlers, and the `handheld` test shared with `canShare`.
- Modify `resources/public/ui.js`: the `flip` and `more` icons.
- Modify `resources/public/app.css`: `#blur` on the tile, `.panel`,
  `.end` positioning, `#more` outside the call, `rear-camera`, the
  immersive fade rule.
- Modify `e2e/tests/helpers.js`: `twoCameras`.
- Create `e2e/tests/camera.spec.js`: the tests above.
- Modify `e2e/tests/mobile.spec.js`: `#blur` moved out of the control
  lists.
- Modify `docs/KNOWLEDGE.md`, `docs/ROADMAP.md`.

## Tasks

### Task 1: The test helper and the failing tests

**Files:**
- Modify: `e2e/tests/helpers.js`, `e2e/tests/mobile.spec.js`
- Create: `e2e/tests/camera.spec.js`

- [ ] **Step 1: `twoCameras` in `helpers.js`**
  After `canvasMedia`, export `twoCameras({ backFails, backDelay } = {})`
  as an init function (`async context => context.addInitScript(fn, { backFails, backDelay })`)
  doing what Testing above describes. The script must be self-contained:
  it cannot close over module scope, so the canvas painter is written
  inside it (copy the few lines from `canvasMedia`'s `canvasTrack`; do
  not try to share them). Patch `getSettings`, `applyConstraints` and
  `label` as own properties on the canvas track instance. Keep a comment
  saying why the helper exists (one fake camera in the headless shell).

- [ ] **Step 2: `camera.spec.js`**
  Write the six tests from Testing in two `describe` blocks: "on a
  phone" (the Android context from `screenshare.spec.js`, copied; tests
  1, 4 and 5) and "on a desktop" (tests 2, 3 and 6). Use
  `joinAs(browser, contexts, roomUrl, name, { ...ctx, init: twoCameras() })`.
  Ratio of the remote video: `page.evaluate(() => { const v =
  document.getElementById('remote'); return v.videoWidth / v.videoHeight; })`,
  polled with `expect.poll(...).toBeCloseTo(4 / 3, 1)`. Frame and packet
  growth as `lobby.spec.js` does with `statsOf`. Source settings through
  `page.evaluate(k => trackOfKind(k).getSourceTrackSettings(), kind)`
  (`trackOfKind` is a global of the page's script, as `lobby.spec.js`
  uses it). Boxes with `box` and `inside` from `helpers.js`.

- [ ] **Step 3: `mobile.spec.js`**
  In the three control lists (`['#blur', '#mic', '#cam', '#leave']` and
  the two longer ones) drop `#blur`, and where the self view's box is
  already measured add: `#blur`'s box lies inside it and is at least
  40 px tall. Keep the checks that the remaining controls clear the self
  view.

- [ ] **Step 4: Run them to see them fail**
  Run: `lgx build && (cd e2e && npx playwright test tests/camera.spec.js tests/mobile.spec.js)`
  Expected: the camera tests FAIL on a missing `#switch-cam` or `#more`
  (test 3 may fail only on `#more`); the mobile tests FAIL on `#blur`
  not inside the self view.

- [ ] **Step 5: Commit**
  `git commit -m "e2e: a second camera, and the tests for switching devices in a call"`

### Task 2: Markup, icons and style

**Files:**
- Modify: `resources/public/room.html`, `resources/public/ui.js`, `resources/public/app.css`

- [ ] **Step 1: Markup**
  In `#call`: move `<button id="blur" hidden></button>` from `.controls`
  into `.tile.self` after the video; add `<button id="switch-cam" hidden></button>`
  between `#cam` and `#share`. In the bar's `.end`, after `#copy`:
  `<button id="more" hidden></button>` and the `#settings` panel from
  The panel above. Update the comments: the self view with blur on it;
  the controls list; the bar's comment (the settings on a desktop).

- [ ] **Step 2: The icons in `ui.js`**
  `more`: three filled dots in a column, `<g fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></g>`
  (filled, as the `blur` dots are, so they survive 20 px). `flip`: a
  camera outline (the body of `video`) with two short bent arrows inside
  forming a cycle. Candidate:
  `'<path d="M3 8h3l2-3h8l2 3h3v11H3z"/><path d="M9.6 12.6a2.6 2.6 0 0 1 4.8-1.2M14.4 13.4a2.6 2.6 0 0 1-4.8 1.2"/><path d="M14.4 9.6v1.8h-1.8M9.6 16.4v-1.8h1.8"/>'`.
  Check both read at 20 px (the screenshots in Task 4), and adjust.

- [ ] **Step 3: CSS**
  In `app.css`, "the room page" section, as Layout and The panel above:
  - `.tile.self button`: the `.preview button` glass (extend that
    selector list), 40 px, `position: absolute; top: 8px; right: 8px`;
    `#blur[data-on]` joins the solid-state rule beside
    `#blur-preview[data-on]`;
  - add `.immersive.idle .tile.self button` to the fade rules (both the
    transition and the opacity/pointer-events rule);
  - `body:not(.in-call) #more` joins the rule hiding `#full` outside the
    call;
  - `.in-call .bar .end { position: relative; }` and `.panel` as
    described; `.panel label` keeps the app's `label` style (14 px,
    muted) but in the room's white-on-dark.
  - `body.rear-camera .preview video, body.rear-camera .tile.self video { transform: none; }`.

- [ ] **Step 4: Commit**
  `git commit -m "Call: blur on the self view, a camera switch in the controls, settings in the bar"`

### Task 3: The logic

**Files:**
- Modify: `resources/public/room.html`

- [ ] **Step 1: State and helpers**
  In the lobby section, beside `lobby`: `const devices = { video: [], audio: [] }`,
  `const busy = { video: null, audio: null }` (keyed by `Track.Kind`,
  whose values are the strings `'video'` and `'audio'`), and
  `const settingsOf = kind => (trackOfKind(kind) ? trackOfKind(kind).getSourceTrackSettings() : {})`.
  Keep every new `const` above the final `loadRoom()` call as the
  existing code does. Hoist the user-agent test out of `canShare` into
  `const handheld = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || !!(navigator.userAgentData && navigator.userAgentData.mobile)`
  near the top and use it in both places. Add `VideoPresets` to the
  `LivekitClient` destructuring.

- [ ] **Step 2: `fillDevices`, the pickers, `devicechange`**
  `fillDevices` stores both lists in `devices` and fills the four
  selects through `fillSelect(select, list, currentId, fallback)`
  (the current id from `settingsOf(kind).deviceId`). Replace
  `onDeviceChange` with the two shared handlers from The device lists
  above, wired to all four selects. Add
  `navigator.mediaDevices.addEventListener('devicechange', () => { if (lobby.tracks.length) fillDevices(); })`
  (guarded for a browser without `mediaDevices`).

- [ ] **Step 3: `switchDevice` and `flash`**
  As the design says. Shape:
  ```js
  async function switchDevice(kind, options) {
    const track = trackOfKind(kind);
    const publishing = lobby.joining && !window.call.joined;
    if (!track || busy[kind] || lobby.switching || publishing || track.isMuted) return false;
    if (kind === Track.Kind.Video && blurBusy) return false;
    const before = settingsOf(kind).deviceId;
    const extra = kind === Track.Kind.Video ? { resolution: VideoPresets.h720.resolution } : {};
    busy[kind] = (async () => {
      let ok = true;
      try { await track.restartTrack({ ...options, ...extra }); }
      catch (e) {
        ok = false;
        // The old capture is already stopped: bring the device back as
        // it was, unless the lobby has started over and this track is
        // nobody's any more.
        if (track === trackOfKind(kind)) await track.restartTrack({ deviceId: before ? { exact: before } : undefined, ...extra }).catch(() => {});
      }
      if (track !== trackOfKind(kind)) { track.stop(); return false; }
      return ok;
    })();
    drawDevices(); drawBlur(); drawMedia();
    const ok = await busy[kind];
    busy[kind] = null;
    drawDevices(); drawBlur(); drawMedia();
    if (!ok && track === trackOfKind(kind)) switchFailed(kind);
    return ok;
  }
  ```
  `switchFailed(kind)`: the text is `'Could not switch camera.'` or
  `'Could not switch microphone.'`; in the lobby `showError(new Error(text))`,
  in the call `flash(text)`. Write `flash(text)` once and have
  `blurFailed` and `shareFailed` use it.

- [ ] **Step 4: `drawDevices`, the switch button, the panel**
  `drawDevices()` as Drawing above; call it at the end of `drawMedia`
  and from `showCam` and `showMic`. The switch button's click handler:
  on a handheld `switchDevice(Video, { facingMode: { exact: settingsOf(Video).facingMode === 'environment' ? 'user' : 'environment' } })`;
  on a desktop find the current camera's index in `devices.video` by
  `deviceId` (−1 counts as the last, so the first is next) and
  `switchDevice(Video, { deviceId: { exact: next.deviceId } })`.
  The panel: `openSettings()` / `closeSettings()` toggle `#settings`'
  `hidden` and `#more`'s `aria-expanded`; `#more` click toggles; one
  `keydown` for Escape and one document `click` listener (ignoring
  clicks inside `.bar .end`) close it; `show()` closes it when the
  section is not `call`. `#more.hidden = handheld` once, at setup.
  `wake()`'s `busy` adds `!$('settings').hidden`.

- [ ] **Step 5: The locks**
  `drawBlur`: add `!!busy.video` to the disabled condition. `drawMedia`:
  the lobby's camera and microphone buttons and all four selects wait
  on `busy` of their kind, and the lobby's selects on a join publishing
  (the same `publishing` test `drawBlur` makes). The call's `#mic` and
  `#cam` handlers: return early while `busy` of their kind is set.
  `join()`: `await busy.video; await busy.audio` after
  `await lobby.switching`. `startLobby`: `busy` is left alone (an old
  switch ends on its own and stops its track, as "A switch that outlives
  its track" says), and `drawDevices()` runs through `drawMedia()`.

- [ ] **Step 6: Run the camera and mobile tests**
  Run: `lgx build && (cd e2e && npx playwright test tests/camera.spec.js tests/mobile.spec.js)`
  Expected: PASS. If test 4 (revert) fails because the track is dead
  after the revert, check that the revert's `restartTrack` is reached and
  what it threw; do not loosen the test. If test 5 fails with the old
  capture still `live`, check whether `stop()` on the abandoned track
  ran before or after its restart finished; both orders must end it. If
  the microphone half of test 6 fails on packets, check whether the
  restarted audio track reached the sender (`replaceTrack`) before
  blaming the test.

- [ ] **Step 7: Commit**
  `git commit -m "Call: switch the camera with one tap, pick devices from the bar"`

### Task 4: Full suite and a look

- [ ] **Step 1: Run everything**
  Run: `lgx test` and `lgx e2e`.
  Expected: all PASS. `blur.spec.js` clicks the moved `#blur` and
  switches the lobby camera through the picker (now `switchDevice`);
  `screenshare.spec.js` counts the controls' width. The blur file times
  out under parallel load (see its header): re-run it alone with
  `--workers 1` before counting a failure there.

- [ ] **Step 2: Screenshots**
  `twoCameras` exists only inside the suite, so take the screenshots from
  a throwaway spec (or a `page.screenshot` call added temporarily to the
  new tests, removed before the commit): a desktop call with the panel
  open (1280x800), a phone call (390x844) with the switch in the
  controls and blur on the thumbnail, and the same with `rear-camera`
  on. Check the panel clears the bar and the remote name, the blur
  button sits in the thumbnail, and both icons read at 20 px.

### Task 5: Docs

**Files:**
- Modify: `docs/KNOWLEDGE.md`, `docs/ROADMAP.md`

- [ ] **Step 1: Write it down**
  `KNOWLEDGE.md`, beside the `restartTrack` note: it stops the old
  capture before asking for the new one, so a failed restart leaves a
  dead track and the page restarts it with the previous device; it asks
  `getUserMedia` for `deviceId` and `facingMode` only and applies the
  rest (resolution) with `applyConstraints`, so a switch without
  `resolution` captures at the browser's default; a published
  microphone restarted on another device keeps flowing to the other
  side; `getSourceTrackSettings()` for the source's settings under
  blur. In "Browser tests": the headless shell has one fake camera and
  three fake microphones, so `twoCameras` fakes a second camera, and
  the fake device refuses an exact `facingMode`. Dated 2026-10-03, only
  what the tests confirmed.
  `ROADMAP.md`, "After v1": a dated Done line in the style of its
  neighbours: switch camera in the controls (flip on phones, next camera
  on desktops, the back camera unmirrored), blur moved onto the self
  view, a desktop-only settings panel in the bar with camera and
  microphone pickers; not yet tried on a real phone.

- [ ] **Step 2: Commit**
  `git commit -m "docs: switching the camera and devices in a call"`
