# Own Screen Preview Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While you share your screen, the call page shows it in a small tile above your self view, so you can see that the share is working and what the other person sees.

**Tech Stack:** Plain DOM and CSS in `resources/public/room.html`, `resources/public/app.css` and `resources/public/i18n.js`; `livekit-client` 2.22.3 (vendored); Playwright via `lgx e2e` with headless Chromium and fake media. No server change.

---

## Design

### What it does

- While a screen track of ours is published, a small tile shows it in the
  bottom-right corner of the stage, **above** the self view. When the
  share ends, by the button or by the browser's own "Stop sharing" bar,
  the tile goes away.
- The self view stays as it is: you keep seeing your face. With the
  camera off the self view is hidden (as now) and the screen tile drops
  into the corner on its own.
- The stage is unchanged: it shows the other person, as the screen-sharing
  plan decided (`docs/plans/2026-10-02-2023-screen-sharing.md`, "The
  sharer"). This plan reverses only that plan's "the sharer does not see
  their own screen". The hall of mirrors it worried about is now confined
  to a tile 200 px wide: sharing the monitor the page is on shows a small
  tunnel in that tile, and that is accepted (it also tells you the share
  is live).
- The screen is shown whole (`object-fit: contain`) in a 16:9 black box,
  never mirrored. A 16:10 monitor or an odd-shaped window is letterboxed.
- Only desktops can share (the button is hidden on phones, `canShare` in
  `room.html`), so the tile only ever appears in desktop windows: a normal
  one, a short one and a narrow one. The two last use the phone layout's
  rules (immersive, `small` in `room.html`), so those rules must place it
  too.
- The tile has no controls and does not fade. It is labelled for screen
  readers: `aria-label="Your screen"`, translated.

Out of scope: clicking the tile to enlarge it or swap it onto the stage,
excluding the call's own tab from the picker (`selfBrowserSurface`), and
the other side's face tile (`docs/backlog/screen-share-face-tile.md`,
which stays open; it is the viewer's side and the phone layouts).

### Markup and layout

The self view (`.tile.self`, `room.html:83`) is positioned on its own
today: `position: absolute; right: 20px; bottom: 20px` in `app.css:202`,
with overrides for immersive (`app.css:249`) and for a phone held upright
(`app.css:274`, above the controls). A second tile placed by its own
offsets would have to know the self view's height in every layout and
whether it is hidden. Instead both go in one positioned wrapper that
stacks them:

```html
<div class="corner">
  <div class="my-screen" hidden><video id="my-screen" autoplay playsinline muted aria-label="Your screen" data-i18n-aria-label></video></div>
  <div class="tile self">…unchanged…</div>
</div>
```

- `.corner` takes over the positioning: `position: absolute; right: 20px;
  bottom: 20px; display: flex; flex-direction: column; align-items:
  flex-end; gap: 10px`. The two immersive overrides move from
  `.tile.self` to `.corner` unchanged. `.tile.self` keeps its size,
  radius and shadow and loses `position: absolute` and the offsets (it is
  still `position: relative` from `.tile`, which the blur button needs).
  The screen tile comes first in the markup, so it sits above the self
  view, and a hidden self view leaves it in the corner.
- The screen tile is **not** a `.tile`. `.tile` carries the stage's
  sizing (`100cqw`, `--ratio`), `.immersive .tile:not(.self)` makes a tile
  the whole stage, and the e2e suite finds the remote tile as
  `.tile:not(.self)` (`screenshare.spec.js`, `tileOf`). Its own class
  avoids all three.
- `.my-screen`: `width: 200px; max-width: 30vw; aspect-ratio: 16 / 9;
  background: #000; border-radius: 14px; overflow: hidden;` and the self
  view's box-shadow. Its video: `width: 100%; height: 100%; object-fit:
  contain; display: block`. No transform: the mirror rule targets
  `.tile.self video` only.
- In the phone-layout media query (`app.css`, "Phones, portrait (narrow)
  or landscape (short)") the self view becomes a portrait thumbnail,
  `min(28vw, 22vh)` wide. The screen tile there is `width: min(36vw,
  30vh); border-radius: 12px`, a little wider than the thumbnail, so a
  16:9 picture is not a sliver.
- `wake()` and the idle rules name `.tile.self` and its button; they stay
  as they are. The screen tile has no button and is never faded.

Expected sizes, for the layout check: at 1280x800 the stack is 200 px
wide, 112 + 10 + 112 px tall, 20 px from the corner, clear of the
centred controls. At 720x420 (short, immersive) the thumbnail is 92x123
and the screen tile 126x71, from 12 px off the corner; the controls span
about x 182 to 538, the stack x 582 to 708. At 600x900 (narrow, upright)
the stack sits 88 px up, above the controls.

### Behaviour

One function owns the tile, next to `drawShare()` in the screen-sharing
section of `room.html`:

```js
// The track on #my-screen now, so the one that ended can be detached.
let myScreen = null;
function showMyScreen(track) {
  if (myScreen && myScreen !== track) myScreen.detach($('my-screen'));
  if (track && track !== myScreen) track.attach($('my-screen'));
  myScreen = track;
  $('my-screen').parentElement.hidden = !track;
}
```

- `shareChanged` in `join()` (which already filters on the screen source
  and runs on `LocalTrackPublished` and `LocalTrackUnpublished`) calls
  `showMyScreen(sharing() ? pub.track : null)`. When
  `LocalTrackUnpublished` fires the publication is already gone, which is
  why `drawShare()` reads `sharing()` false there today; the same holds
  here.
- The `Disconnected` handler and `join()`'s catch call `showMyScreen(null)`,
  so leaving or a dropped connection while sharing leaves no stale video
  or visible tile behind for the next join.
- Nothing is published or subscribed differently: the local track is
  attached to one more element, which costs no bandwidth.

### Testing

Extend `e2e/tests/screenshare.spec.js`, "sharing from a desktop"
describe, with a helper:

- `myScreenRatio(page)`: `videoWidth / videoHeight` of `#my-screen`, or 0.
- `myFrames(page)`: `getVideoPlaybackQuality().totalVideoFrames` of
  `#my-screen`, to see that frames keep coming.

The changes:

1. *The button shares and stops* (existing): before the click
   `.my-screen` is hidden. After the click it is visible, the ratio
   reaches about 4:3 (`canvasScreen(800, 600)`, within 2%), frames grow
   between two reads, `#my-screen` has computed `object-fit: contain` and
   `transform: none`, and `.tile.self` is still visible. After the second
   click `.my-screen` is hidden and `#my-screen`'s `srcObject` is null.
   A third click shares again: the tile is back with the ratio about 4:3
   and frames growing, so a new screen track attaches after an old one
   was detached.
2. *A share ended by the browser* (existing): `.my-screen` is hidden
   after the `ended` event.
3. *New: with the camera off the screen takes the corner.* Alice turns the
   camera off (`#cam`), then shares: `.tile.self` is hidden, `.my-screen`
   visible, and its box's bottom is 20 px above the viewport's bottom
   (within 1 px).
4. *New: the tile fits every desktop window.* For each of 1280x800,
   720x420 and 600x900 (plain viewports, desktop user agent), Alice
   shares: `.my-screen` and `.tile.self` are both inside the viewport,
   the screen tile is above the self view (its bottom at or above the
   self view's top) and overlaps neither it nor `#mic`, `#cam`, `#share`,
   `#leave`. Use `box`, `inside` and `overlaps` from `helpers.js`.
5. *New: leaving while sharing clears it.* Alice shares, clicks `#leave`,
   is back in the lobby: `#my-screen`'s `srcObject` is null. She joins
   again: `.my-screen` is hidden.

The layout specs that measure the self view (`mobile.spec.js`,
`camera.spec.js`, `lobby.spec.js`) guard the wrapper refactor: they must
pass unchanged.

## File Structure

- `resources/public/room.html` — modify: the `.corner` wrapper and the
  screen tile in the markup and its comment; `myScreen` and
  `showMyScreen()` in the screen-sharing section; the calls in
  `shareChanged`, `Disconnected` and `join()`'s catch.
- `resources/public/app.css` — modify: `.corner` takes the self view's
  positioning (base, immersive, phone upright); `.my-screen` and its
  video; its size in the phone-layout query.
- `resources/public/i18n.js` — modify: "Your screen" in Russian.
- `e2e/tests/screenshare.spec.js` — modify: the tests above.
- `docs/ROADMAP.md`, `docs/KNOWLEDGE.md` — modify: the done entry and
  whatever the work verified.

Commands, from the repository root:

- One spec: `lgx build && (cd e2e && npx playwright test screenshare)`
- Layout neighbours: `lgx build && (cd e2e && npx playwright test screenshare mobile camera lobby orientation)`
- Everything: `lgx e2e`, then `lgx test` and `lgx i18n-check`

On this dev machine the pinned lgx may have to be called by path with
`CGO_ENABLED=0` exported (see "Dev tooling gotchas" in
`docs/KNOWLEDGE.md`).

Work on a branch, `own-screen-preview`, not on master.

---

### Task 1: The corner wrapper, with nothing new in it

A pure refactor first, so a layout regression shows up on its own.

**Files:**
- Modify: `resources/public/room.html`
- Modify: `resources/public/app.css`

- [ ] **Step 1: Wrap the self view**
  In `room.html`, put `.tile.self` inside `<div class="corner">`; keep the
  comment above it and say there that the corner holds your own videos.
  In `app.css`, move `position: absolute`, `right` and `bottom` from
  `.tile.self` (line 202) to a new `.corner` rule with the flex column
  from the design; move the two overrides (`.immersive .tile.self` at line
  249, and the upright phone's at line 274) to `.corner`. Leave every
  other `.tile.self` selector alone.

- [ ] **Step 2: Run the layout specs**
  Run: `lgx build && (cd e2e && npx playwright test mobile camera lobby orientation screenshare)`
  Expected: PASS, unchanged. If a self-view box check fails, the move
  missed an offset; fix the CSS, not the test.

- [ ] **Step 3: Commit**
  `git commit -m "Room page: the self view sits in a corner wrapper"`

### Task 2: The screen tile

**Files:**
- Modify: `e2e/tests/screenshare.spec.js`
- Modify: `resources/public/room.html`
- Modify: `resources/public/app.css`
- Modify: `resources/public/i18n.js`

- [ ] **Step 1: Write the failing tests**
  The helpers and the five changes under "Testing" above. Tests 4 and 5
  are new tests in the "sharing from a desktop" describe; test 4 is a
  `for` over the three viewports, each joining Alice with
  `{ viewport, init: canvasScreen(800, 600) }` and a second participant,
  so the call is not in the waiting state.

- [ ] **Step 2: Run them and see them fail**
  Run: `lgx build && (cd e2e && npx playwright test screenshare)`
  Expected: the new assertions FAIL (no `.my-screen`); the other tests
  PASS.

- [ ] **Step 3: Implement**
  Markup: the screen tile first inside `.corner`, as in the design.
  CSS: `.my-screen` and its video, and its size in the phone-layout
  query. JS: `myScreen` and `showMyScreen()` beside `drawShare()`, with a
  comment in the section's style saying what the tile is for; the calls
  in `shareChanged`, `Disconnected` and `join()`'s catch. Extend the
  section's opening comment by a sentence: the sharer sees the screen in
  a small tile above the self view, never on the stage.
  `i18n.js`: `"Your screen": "Ваш экран"`.

- [ ] **Step 4: Run the spec, then its neighbours**
  Run: `lgx build && (cd e2e && npx playwright test screenshare mobile camera lobby orientation)`
  Expected: PASS.

- [ ] **Step 5: Look at it**
  Headless screenshots of Alice's call page while sharing, with a second
  participant in the call, at 1280x800, 720x420 and 600x900, and at
  1280x800 with the camera off. Look at each: the screen tile above the
  self view, letterboxed not cropped, not mirrored, clear of the
  controls, and in the 720x420 one not crowding the bar. Change the CSS
  only if something is wrong, and say what in the commit.

- [ ] **Step 6: Commit**
  `git commit -m "Room page: the sharer sees their screen in a small tile"`

### Task 3: The whole suite

- [ ] **Step 1: Run everything**
  Run: `lgx e2e`, then `lgx test`, then `lgx i18n-check`.
  Expected: all PASS, i18n-check lists nothing missing. Then
  `cd e2e && npx playwright test screenshare --repeat-each 5`
  Expected: PASS every time. Fix what is flaky in the test or the page;
  do not raise timeouts to hide a race.

- [ ] **Step 2: Commit any fixes**
  Only if step 1 changed something.

### Task 4: Docs

**Files:**
- Modify: `docs/ROADMAP.md`
- Modify: `docs/KNOWLEDGE.md`

- [ ] **Step 1: ROADMAP**
  Under "After v1", a dated "Done" entry in the style of the screen-sharing
  one: the sharer sees the shared screen in a small tile above the self
  view; this reverses the earlier "the sharer does not see their own
  screen"; sharing the monitor the page is on shows a small tunnel in
  that tile, accepted. Not yet tried in a real browser.

- [ ] **Step 2: KNOWLEDGE**
  In "Screen sharing, verified 2026-10-02", add only what this work
  verified, dated: for example, that `LocalTrackUnpublished` fires after
  the publication is gone, if that was seen. The tests share a canvas,
  so they say nothing about the tunnel when the page's own monitor is
  shared; do not record that as seen.

- [ ] **Step 3: Commit**
  `git commit -m "Docs: the sharer's own screen tile"`

---
