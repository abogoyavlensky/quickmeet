# Video Orientation Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The room page shows the other person's video in its own shape, tall or wide, instead of cropping it to the shape of the tile.

**Tech Stack:** Plain DOM and CSS in `resources/public/room.html` and `resources/public/app.css`, `livekit-client` 2.22.3 (vendored), Playwright via `lgx e2e` with headless Chromium and fake media.

---

## Design

### The problem

The remote tile has a fixed shape and the video is cropped to it
(`object-fit: cover`, `app.css:72`):

- Desktop: the tile is 16:9 (`app.css:71`). A 9:16 video from a phone held
  upright keeps about a third of its height.
- Phone: the tile is the whole screen (`app.css:90`). A 16:9 video from a
  desktop keeps about a quarter of its width on an upright phone.

When both sides have the same orientation nothing is lost, and that stays
as it is.

### What changes

The page learns the remote video's shape from the `<video>` element itself
(`videoWidth`, `videoHeight`, and the `resize` event, which fires when the
first frame arrives and whenever the dimensions change: the sender rotates
their phone, or the SFU switches simulcast layer). No server change, no
LiveKit API beyond what the page already uses.

One function in `room.html`, `fitRemote()`, reads the dimensions of
`#remote` and writes two things on the remote tile (the `.tile` that is
not `.self`):

- the custom property `--ratio`, a plain number: `videoWidth / videoHeight`;
- one of the classes `wide` (`videoWidth >= videoHeight`) or `tall`.

With no dimensions (`videoWidth === 0`) it removes all three, which is also
the reset. It runs on `#remote`'s `resize` and `loadedmetadata` events, and
the reset runs when the other participant disconnects and when the call
ends (`ParticipantDisconnected`, `Disconnected`), so an empty tile goes back
to 16:9.

CSS does the rest, per layout:

**Desktop (the base rules).** The tile takes the video's shape and is as
large as fits:

```css
.call { container-type: size; }
.tile {
  aspect-ratio: var(--ratio, 1.7778);
  width: min(100%, 960px, calc(100cqh * var(--ratio, 1.7778)));
}
```

`100cqh` is the height of the call area's content box (its padding already
reserves the band for the controls), so the third term is "the width at
which this shape is exactly as tall as the room available". A wide video is
limited by width as today; a tall one is limited by height and becomes a
tall tile in the middle. `max-width: 960px` folds into the `min()`;
`max-height: 100%` stays as a guard. `.tile.self` sets its own width and
never gets `--ratio`, so the self view stays a 16:9 thumbnail.

A side effect, and an improvement: a short desktop window used to give up
16:9 and crop; now the tile keeps the video's shape and gets narrower.

**Phone (the `@media (max-width: 700px), (max-height: 500px)` block).** The
tile stays the whole screen. The video is letterboxed when its orientation
disagrees with the screen's, and cropped to fill, as today, when they
agree:

```css
@media (orientation: portrait)  { .tile.wide video { object-fit: contain; } }
@media (orientation: landscape) { .tile.tall video { object-fit: contain; } }
```

nested in (or combined with) the phone block. The screen's orientation is a
media query, so rotating the phone mid-call needs no script. The self
thumbnail, the name tag and the controls already sit at the screen's edges,
over the black bars. The phone block's `.tile` rule must now set
`width: 100%` itself, since the base rule's width is no longer `100%`.

### Decisions

- **CSS container units, not script-computed sizes.** The tile's size
  depends on the call area's height; `cqh` gives that to CSS, and a window
  resize needs no listener. Supported in every current browser.
- **`--ratio` is a number, not `w / h`.** It is used both in `aspect-ratio`
  and multiplied inside `calc()`; a `16 / 9` value cannot be multiplied.
- **A square video counts as wide.** One rule, no third case.
- **The self view and the lobby preview do not change.** They show your own
  camera, mildly cropped at worst (16:9 on desktop, 3:4 on phones).
- **No tap to switch between fill and fit.** Considered and deferred: add it
  only if the letterboxed strip on a phone proves too small in use.
- **When the other side stops their camera** the tile keeps the last shape.
  Resetting on mute would make the tile jump for a pause that is usually
  short.

### What this plan does not establish

That a phone held upright sends tall frames. The page asks for the camera
without a fixed shape (`room.html:154`) and phone browsers normally rotate
the frames with the device, but it has not been checked on a device, and
headless Chromium cannot check it. Task 4 checks it on staging. If a phone
sends wide frames while upright, that is a capture problem for a separate
backlog entry; this plan's display work is correct either way.

### Testing

Headless Chromium's fake camera is 640×480. A tall sender is made in the
test by an init script in that participant's browser context, which wraps
`navigator.mediaDevices.getUserMedia`: it calls the real one, then swaps
the video track for a 360×640 `canvas.captureStream()` track repainted on
a timer (a canvas that is never repainted sends no frames). The page under
test is unchanged; `createLocalTracks` gets the stream through the normal
path. Tests read bounding boxes and computed styles, as
`e2e/tests/mobile.spec.js` does; no new test hook in the page.

## File Structure

- `resources/public/room.html`: `fitRemote()`, its two event listeners on
  `#remote`, and the reset in the two disconnect handlers.
- `resources/public/app.css`: the container, the tile's shape and width on
  desktop, the letterbox rules and `width: 100%` in the phone block, updated
  comments.
- `e2e/tests/helpers.js`: `tallCamera(context)`, the init script above.
  `openLobby` gains a way to apply it before the page loads (see Task 1).
- `e2e/tests/orientation.spec.js` (new): the tests for this plan.
- `docs/KNOWLEDGE.md`, `docs/ROADMAP.md`: what was learned, what shipped.

Work on a branch (`video-orientation`), one PR, as earlier milestones did.

---

### Task 1: A tall camera for the tests

**Files:**
- Modify: `e2e/tests/helpers.js`
- Create: `e2e/tests/orientation.spec.js`

- [ ] **Step 1: The helper.** Export `tallCamera(context)` from
  `helpers.js`: `context.addInitScript` with the `getUserMedia` wrapper
  described under Testing (360×640 canvas, repainted with a changing fill
  about 15 times a second, `captureStream(15)`; when the request has no
  `video`, return the real stream untouched; keep the real audio track).
  `openLobby` creates the context and the page in one go, so give its
  `contextOptions` a way to run this before `page.goto`: accept an optional
  `init` function alongside the Playwright options (`{ init: tallCamera,
  ...options }`), strip it before `browser.newContext`, and call
  `await init(context)` before `newPage`. Existing callers are unaffected.

- [ ] **Step 2: Prove the helper.** In `orientation.spec.js`, with the same
  `contexts` setup and teardown as `mobile.spec.js`, a first test "a tall
  camera reaches the other side tall": alice joins plainly, bob joins with
  `{ init: tallCamera }`; poll alice's `#remote` until `videoWidth > 0`,
  then expect `videoHeight > videoWidth`. Also expect bob's own `#local`
  to be tall.

- [ ] **Step 3: Run.**
  Run: `lgx e2e` (or, after one build, `cd e2e && npx playwright test orientation`)
  Expected: the new test passes; the whole suite still passes.
  If the canvas track does not publish or arrives with no frames, fall back
  to asking the fake device for the shape instead: wrap `getUserMedia` to
  add `width: { exact: 360 }, height: { exact: 640 }` to the video
  constraints (Chromium crops and scales the fake camera). Keep whichever
  works and say which in a deviation note under this task.

- [ ] **Step 4: Commit.** `e2e: a tall fake camera`

### Task 2: Desktop, the tile takes the video's shape

**Files:**
- Modify: `e2e/tests/orientation.spec.js`
- Modify: `resources/public/room.html`
- Modify: `resources/public/app.css`

- [ ] **Step 1: Failing tests.** A `describe('on a desktop')` with viewport
  1280×800 for alice (pass it as her context options, as `mobile.spec.js`
  does for `short`):
  - "a tall video gets a tall tile": bob joins with `tallCamera`. Poll
    until alice's remote tile (`.tile:not(.self)`) box has
    `height > width`. Then: the box's `width / height` is within 2% of
    `#remote`'s `videoWidth / videoHeight`; the box is inside the viewport;
    it does not overlap `#leave`.
  - "a wide video gets a wide tile": bob joins plainly. The same ratio
    check (the fake camera is 4:3, so the tile is 4:3, not 16:9), inside
    the viewport, clear of `#leave`.
  - "the tile goes back to 16:9 when the other side leaves": after the
    tall case, close bob's context; poll until alice's tile ratio is within
    2% of 16/9.
  Copy `box`, `inside` and `overlaps` from `mobile.spec.js` into
  `helpers.js` and import them in both specs rather than duplicating.

- [ ] **Step 2: Run, expect failure.** The tall and wide ratio checks fail
  (the tile is 16:9 whatever arrives).

- [ ] **Step 3: Script.** In `room.html`, next to the other call helpers,
  add `fitRemote()` as specified in the Design (sets or removes `--ratio`,
  `wide`, `tall` on `$('remote').parentElement`). Register it once, at
  script load, for `resize` and `loadedmetadata` on `$('remote')`. In the
  `ParticipantDisconnected` and `Disconnected` handlers, reset the tile.
  The element may still report the last frame's dimensions after the track
  is gone, so the reset must not depend on `videoWidth`: give `fitRemote` a
  way to force it (for example `fitRemote(true)`) or split out a
  `resetRemote()`. A comment says why the shape comes from the element and
  not from LiveKit's track dimensions: the element reports what is actually
  being shown, after rotation and layer switches.

- [ ] **Step 4: Style.** In `app.css`: `container-type: size` on `.call`;
  on `.tile`, replace `width: 100%; max-width: 960px; aspect-ratio: 16 / 9`
  with the two declarations in the Design, keeping `max-height: 100%`.
  Rewrite the comment at lines 68-70: the tile takes the video's shape and
  the largest size that fits the call area, so nothing is cropped. In the
  phone block add `width: 100%` to `.tile` (its `aspect-ratio: auto;
  height: 100%` stay), and check `.tile.self` there and in the base rules
  still sets its own width.

- [ ] **Step 5: Run.**
  Run: `lgx e2e`
  Expected: all pass, including every test in `mobile.spec.js` (the short
  desktop window test now sees a narrower, uncropped tile; its assertions
  are about fitting, and still hold). If `100cqh` turns out to include the
  call area's padding, subtract the padding in the `calc()` and note it.

- [ ] **Step 6: Commit.** `Room page: the remote tile takes the video's shape`

### Task 3: Phone, letterbox on mismatch

**Files:**
- Modify: `e2e/tests/orientation.spec.js`
- Modify: `resources/public/app.css`

- [ ] **Step 1: Failing tests.** Reuse the `phone` and `landscape` context
  options from `mobile.spec.js` (390×844 and 667×375, `isMobile`,
  `hasTouch`). Four cases, each asserting the computed `object-fit` of
  alice's `#remote` (poll: it settles once the first frame arrives) and
  that the remote tile's box is still the full viewport width:
  - upright phone, wide video (bob plain): `contain`
  - upright phone, tall video (bob `tallCamera`): `cover`
  - sideways phone, wide video: `cover`
  - sideways phone, tall video: `contain`
  And one for rotation: upright phone with a wide video, then
  `alice.page.setViewportSize({ width: 667, height: 375 })`; `object-fit`
  becomes `cover`.

- [ ] **Step 2: Run, expect failure.** The two `contain` cases fail.

- [ ] **Step 3: Style.** Add the two orientation rules from the Design
  inside the phone block, scoped so the self view is never affected
  (`.tile.wide` and `.tile.tall` are only ever set on the remote tile).
  Update the block's leading comment: the remote video fills the screen
  when it has the screen's orientation and is letterboxed when it does not.

- [ ] **Step 4: Run.**
  Run: `lgx e2e`
  Expected: all pass.

- [ ] **Step 5: Look at it.** Headless screenshots of a two-browser call,
  as M2 did (an ad hoc script under `e2e/.tmp/`, not committed), for:
  desktop 1280×800 with a tall video, upright phone with a wide video,
  sideways phone with a tall video. Check by eye that the name tag, the
  status banner, the self view and the controls sit clear of each other
  and read well over black bars. Fix what does not.

- [ ] **Step 6: Commit.** `Room page: phones letterbox a video of the other orientation`

### Task 4: Docs, review, real devices

**Files:**
- Modify: `docs/KNOWLEDGE.md`
- Modify: `docs/ROADMAP.md`
- Modify: this plan (deviation notes, checkboxes)

- [ ] **Step 1: Knowledge.** Add to the browser layout notes in
  `docs/KNOWLEDGE.md`: the `<video>` element's `resize` event and
  `videoWidth`/`videoHeight` as the source of the remote shape; container
  units (`cqh`) for sizing by the call area's height, and whether they
  measure the content box; how the tests make a tall camera. Only what was
  verified while doing the work.

- [ ] **Step 2: Roadmap.** Under M2's list in `docs/ROADMAP.md`, a "Done
  <date>" line in the style of its neighbours: the remote video keeps its
  shape, a tall tile on desktop and letterboxing on phones
  (`e2e/tests/orientation.spec.js`).

- [ ] **Step 3: Review.** Run /review-with-codex on the branch; fix what is
  real, note it under the task it belongs to.

- [ ] **Step 4: Commit and open the PR.** `docs: video orientation`

- [ ] **Step 5: Real-device checklist (the user, after the PR is merged and
  staging has deployed to `https://quickmeet.absky.dev`).**
  - Phone upright calling a desktop: the desktop shows a tall tile with the
    whole picture. This is the check that an upright phone sends tall
    frames. If the desktop shows a wide tile with the picture sideways or
    cropped, record it as a backlog entry (capture orientation) rather than
    fixing it here.
  - The same call seen from the phone: the desktop's wide video is
    letterboxed, whole, with the controls and the self view over the bars.
  - Rotate the phone during the call: the desktop's tile changes shape; the
    phone's view switches between letterboxed and filling.
  - Two upright phones: each fills the other's screen, as before.
  Record the result in this plan and in `docs/ROADMAP.md`.
