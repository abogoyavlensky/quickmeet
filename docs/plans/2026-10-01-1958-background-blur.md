# Background Blur Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can blur what is behind them with one button, in the lobby and in the call; one fixed look, nothing to configure.

**Tech Stack:** `@livekit/track-processors` 0.8.1 (MediaPipe `tasks-vision` 0.10.14 and its selfie segmenter model), bundled with esbuild and vendored into `resources/public/`; plain DOM and CSS in `room.html`, `app.css`, `ui.js`; one route in `src/quickmeet/routes.lg`; Playwright via `lgx e2e`.

---

## Design

### What the person sees

One toggle, in two places, both driving the same state:

- **Lobby:** a round button in the bottom right corner of the camera
  preview. This is where blur matters most: it is on before the other
  person sees anything.
- **Call:** a fourth button in the controls row, first from the left:
  blur, microphone, camera, hang up. It belongs with the two other
  buttons that say what the camera and microphone send; the top bar
  stays for who is there, the time and the link.

The button follows the row's existing rule that the unusual state is the
solid one: blur on is solid white, like microphone off. Its accessible
name and tooltip are `Blur background` when off and `Stop blurring` when
on, and it carries `aria-pressed`.

The choice is remembered in `localStorage` (`quickmeet.blur` = `1`), so
the next lobby on that device starts blurred. There is no strength
setting and no virtual background: the library's default blur radius
(10) is the one look.

The buttons are hidden when the browser cannot do it (see "Support") or
there is no camera track, and disabled while the camera is switched off
in the call and while blur is being switched on or off.

### How it works

`@livekit/track-processors` provides `BackgroundProcessor`, a LiveKit
track processor: MediaPipe segments the person in each frame (wasm plus
WebGL) and a shader blurs the rest. `track.setProcessor(p)` puts it on
the local camera track, `track.stopProcessor()` takes it off. The
processed track replaces the raw one everywhere the track goes: the
attached `<video>` elements, and the published track. The page publishes
the lobby's tracks on join, so a processor set in the lobby carries into
the call, and `restartTrack` (device switch, camera off and on) restarts
the processor with the track.

Verified in a throwaway spike on 2026-10-01, headless Chromium 1194 with
the fake camera and every asset served from localhost: both support
checks true, `setProcessor` resolved in 345 ms, the track became a
`MediaStreamTrackGenerator`, frames kept arriving (about 1 a second:
headless falls back to software WebGL, with a deprecation warning and no
extra flag needed), and `stopProcessor` returned the raw track at full
rate.

### No CDN: the assets are vendored and served from the binary

By default the library downloads MediaPipe's wasm from jsdelivr and the
model from Google's storage. The app serves everything itself
(README: "a call page has no CDN dependency"), so both are vendored and
the processor is pointed at them with its `assetPaths` option.

Four new files in `resources/public/`, all written by a new script,
`scripts/vendor-blur.mjs` (`lgx vendor-blur`), and committed like the
other vendored files:

| File | Size | What |
|---|---|---|
| `track-processors.js` | 160 kB | the library and `tasks-vision`'s JS as one classic script, global `LivekitTrackProcessors` |
| `vision_wasm_internal.js` | 210 kB | MediaPipe's wasm loader |
| `vision_wasm_internal.wasm` | 9.4 MB | MediaPipe's wasm (the SIMD build) |
| `selfie_segmenter.tflite` | 250 kB | the segmentation model |

The package has no UMD build, which is why the script bundles it:
esbuild, `--format=iife --global-name=LivekitTrackProcessors`, with
`livekit-client` aliased to a one-line shim that forwards `getLogger`
(the library's only runtime import from it) to the `LivekitClient`
global the page already loads.

Only the SIMD wasm is vendored. MediaPipe picks the `nosimd` build on a
browser without wasm SIMD (Safari before 16.4), which then answers 404,
and the failure path below handles it. Those browsers fail the support
check anyway (no `VideoFrame`).

**Binaries can be served after all.** `docs/KNOWLEDGE.md` and the
docstring of `static-response` say `io/slurp` reads a string so binaries
would not survive; that is wrong. Checked 2026-10-01 with `lg` 1.13.0:
300 kB of the wasm through `io/slurp` and `io/spit` comes back identical
(`cmp`). A let-go string is a Go string, which holds raw bytes, and the
http server writes `[]byte(s)` (`pkg/rt/ions.go:273`). So the wasm and
the model are plain files, with content types `application/wasm`
(needed for streaming compilation) and `application/octet-stream`.

**Caching.** 9.4 MB must not be downloaded on every call, and a cached
wasm must never meet a newer bundle. So the three MediaPipe files are
fetched under a versioned path, `/static/<tag>/<file>`, where `<tag>`
names the pinned versions (`tp0.8.1-tv0.10.14`), and answered with
`Cache-Control: public, max-age=31536000, immutable`. The route serves
only the current tag (a constant in `routes.lg`) and only those three
names; anything else under it is 404. A page left open across a deploy
that bumps the versions therefore gets a 404 for its old path and takes
the failure path below, rather than new files under an old, cached URL.
A route test holds the constant and the bundle together: the served
bundle must contain `/static/<tag>`. The tag is written
by the vendor script into the bundle as an extra export,
`LivekitTrackProcessors.assetBase` (`"/static/tp0.8.1-tv0.10.14"`), so
the page has no version to keep in step. `track-processors.js` itself is
served from `/static/track-processors.js` like `livekit-client`, with no
cache header.

The wasm is fetched only when blur is first switched on, never by a page
that does not use it. Costs accepted: the binary grows from 84 to about
94 MB, the repository by 10 MB, and the first use of blur on a phone
downloads 9.4 MB (once; the button is disabled while it loads).

### The page logic (`room.html`)

The source of truth is the track, not a flag:

```js
const BLUR_KEY = 'quickmeet.blur';
const camTrack = () => trackOfKind(Track.Kind.Video);
const blurOn = () => { const t = camTrack(); return !!(t && t.getProcessor()); };
```

`window.call.blur` is a getter over `blurOn()`, for the tests.

- `blurSupported()`: `window.LivekitTrackProcessors` exists (the script
  loaded) and `LivekitTrackProcessors.supportsBackgroundProcessors()`.
- `setBlur(on)`: no-op without a camera track, without support, or while
  another switch is in flight. On: `track.setProcessor(BackgroundProcessor({
  mode: 'background-blur', assetPaths: { tasksVisionFileSet: base,
  modelAssetPath: base + '/selfie_segmenter.tflite' } }))` with
  `base = location.origin + LivekitTrackProcessors.assetBase`, a new
  processor each time. Off: `track.stopProcessor()`. Redraws both
  buttons before and after (disabled in between). Returns whether it
  worked. The switch in flight is kept as a promise (`blurBusy`, null
  when idle), and `join()` awaits it right after `lobby.ready`: a person
  who clicks Blur and then Join while the wasm is still loading is not
  published until the switch has finished, either way.
- A click on either button calls `setBlur(!blurOn())` and, when it
  worked, stores or removes `BLUR_KEY`.
- **Failure** (the assets do not load, WebGL refuses): the processor is
  removed (`stopProcessor`, errors swallowed) so the raw camera keeps
  working, `BLUR_KEY` is removed so the next lobby does not try again,
  and the person is told `Background blur is not available here.`: in
  the lobby through `showNotice`, in the call through the status line
  for four seconds, then `refreshStatus(room)`.
- **Lobby start:** `lobby.ready = acquireTracks().then(fillDevices).then(restoreBlur)`.
  `restoreBlur` calls `setBlur(true)` when `BLUR_KEY` is set. Two things
  follow from the order. `fillDevices` runs first because it reads the
  camera's `deviceId` from `track.mediaStreamTrack.getSettings()`, and
  with a processor on, `mediaStreamTrack` is the processed track, which
  has none. And `join()` already awaits `lobby.ready`, so a person who
  asked for blur is never published unblurred because they clicked Join
  quickly.
- `drawBlur()` sets, on both buttons: `hidden` (no support or no camera
  track), `disabled` (switch in flight, or camera off in the call), the
  icon, the label, `aria-pressed` and the `data-on` attribute. It is
  called after tracks are acquired, by `setBlur`, and by `showCam`.
- `stopTracks()` stops a running processor before it stops the track
  (`t.stopProcessor()`, not awaited, errors swallowed), so a lobby that
  starts over does not leave a MediaPipe graph behind. Step 1 of task 3
  checks in the vendored `livekit-client` whether `LocalTrack.stop()`
  already does this; if it does, leave `stopTracks` alone.

### Support

`supportsBackgroundProcessors()` needs `OffscreenCanvas`, `VideoFrame`,
`createImageBitmap`, WebGL 2 and either the insertable-streams API
(Chromium) or `canvas.captureStream()` (the library's fallback path for
Safari and Firefox). Version 0.8.1 has iOS-specific handling in that
fallback, so current iPhones should pass the check; whether blur holds
up on a real iPhone (frame rate, heat) cannot be seen in headless
Chromium and is checked by hand on staging after the merge. Until then
`docs/KNOWLEDGE.md` says "not tried on a device yet", as it does for
full screen.

### Testing

- `test/quickmeet/routes_test.lg`: content types of the new files; the
  model served byte for byte (its SHA-256 equals the pinned one, which
  also proves binary serving); the versioned route's cache header and
  its 404 for other names; the room page links the bundle.
- `e2e/tests/blur.spec.js`, against the built binary, so the embedded
  wasm is what runs:
  1. Lobby to call: blur on in the lobby, it survives a reload (the
     preference), the camera select still shows a selected device, the
     other side keeps decoding frames after the join, camera off
     disables the button and camera on brings blur back, off in the call
     works.
  2. Failure: with the wasm request aborted, the click ends with blur
     off, the notice shown, the preference cleared, and the join still
     works. And with the wasm delayed, Blur then Join at once: the join
     waits, and the call starts blurred.
  3. No support: with `VideoFrame` removed before the page loads, both
     buttons stay hidden.
- `e2e/tests/mobile.spec.js`: `#blur` joins the lists of controls that
  must fit and stay clear of the self view.

Blurred video runs at about one frame a second in headless Chromium, so
frame assertions poll for growth and never count on a rate.

---

## File Structure

| File | Change |
|---|---|
| `scripts/vendor-blur.mjs` | Create. Writes the four vendored files from pinned versions. |
| `lgx.edn` | Add the `vendor-blur` task. |
| `resources/public/track-processors.js`, `vision_wasm_internal.js`, `vision_wasm_internal.wasm`, `selfie_segmenter.tflite` | Create (generated, committed). |
| `src/quickmeet/routes.lg` | Content types for `wasm` and `tflite`; the `/static/:tag/:file` route; corrected docstring. |
| `test/quickmeet/routes_test.lg` | Tests for the above. |
| `resources/public/ui.js` | The `blur` icon. |
| `resources/public/room.html` | The script tag, the two buttons, the blur logic. |
| `resources/public/app.css` | The preview button, the `data-on` state. |
| `e2e/tests/blur.spec.js` | Create. |
| `e2e/tests/mobile.spec.js` | `#blur` in the fit lists. |
| `README.md`, `docs/KNOWLEDGE.md` | Vendoring, the layout list, the corrected and new facts. |

---

### Task 0: Branch

- [x] **Step 1:** `git checkout -b background-blur` from an up-to-date
  `master`, and commit this plan there:
  `git add docs/plans/2026-10-01-1958-background-blur.md && git commit -m "Plan: background blur"`.

### Task 1: Vendor the library, the wasm and the model

**Files:**
- Create: `scripts/vendor-blur.mjs`
- Modify: `lgx.edn`
- Create (generated): the four files in `resources/public/`

- [x] **Step 1: Write `scripts/vendor-blur.mjs`**, in the manner of
  `scripts/vendor-fonts.mjs` (header comment saying what and why,
  versions pinned at the top, run from the repository root). It:
  1. makes a temporary directory (`fs.mkdtemp` under `os.tmpdir()`),
     writes a minimal `package.json` there and runs
     `npm install --no-audit --no-fund @livekit/track-processors@0.8.1 esbuild@0.28.2`
     in it (`execFileSync`);
  2. reads the installed `@mediapipe/tasks-vision` version from its
     `package.json` and fails unless it is `0.10.14` (the pin is
     explicit, a bump is deliberate), then forms
     `tag = 'tp0.8.1-tv0.10.14'` from the two versions;
  3. writes two files in the temporary directory: the shim
     `export const getLogger = (...args) => LivekitClient.getLogger(...args);`
     and the entry
     `export * from '@livekit/track-processors'; export const assetBase = '/static/<tag>';`
  4. runs esbuild from the temporary directory on the entry:
     `--bundle --minify --format=iife --global-name=LivekitTrackProcessors --alias:livekit-client=./shim.js --legal-comments=inline`,
     with a `--banner:js` comment naming both packages, their versions,
     Apache-2.0, and "generated by scripts/vendor-blur.mjs; do not
     edit", output `resources/public/track-processors.js`;
  5. copies `node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js`
     and `.wasm` into `resources/public/`;
  6. downloads
     `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite`,
     fails unless its SHA-256 is
     `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`
     (the URL says `latest`; the hash is the pin), and writes it to
     `resources/public/selfie_segmenter.tflite`;
  7. removes the temporary directory and prints what it wrote.

- [x] **Step 2: Add the task to `lgx.edn`** after `vendor-fonts`:
  `vendor-blur`, doc "Write the pinned background blur library, wasm and
  model into resources/public", `{:sh "node scripts/vendor-blur.mjs"}`,
  with a comment in the style of its neighbours.

- [x] **Step 3: Run it**
  Run: `lgx vendor-blur` (if the `lgx` on `PATH` is too old, see "Dev
  tooling gotchas" in `docs/KNOWLEDGE.md`; `node scripts/vendor-blur.mjs`
  does the same).
  Expected: the four files exist; `ls -la resources/public` shows about
  160 kB, 210 kB, 9.4 MB and 250 kB;
  `grep -c 'assetBase' resources/public/track-processors.js` is at least 1;
  `grep -c jsdelivr resources/public/track-processors.js` may be non-zero
  (the library's unused default); that is expected and the page
  overrides it.

- [x] **Step 4: Commit**
  `git add scripts/vendor-blur.mjs lgx.edn resources/public && git commit -m "Vendor the background blur library, wasm and model"`

> Deviation: `lgx` on `PATH` here is 0.2.0, which rejects this `lgx.edn`; the task ran with the pinned 0.4.2 binary (`~/.local/share/mise/installs/lgx/0.4.2/lgx`), as KNOWLEDGE.md describes. Two runs gave a byte-identical bundle.

### Task 2: Serve the binaries, with a versioned and cached path

**Files:**
- Modify: `src/quickmeet/routes.lg`
- Test: `test/quickmeet/routes_test.lg`

- [x] **Step 1: Write the tests** in `pages-and-static` (or a new
  `deftest` beside it, `the-blur-assets`):
  - `GET /static/track-processors.js` is 200, JavaScript, and its body
    includes `/static/tp0.8.1-tv0.10.14` (the bundle and the route's
    constant agree);
  - `GET /static/tp0.8.1-tv0.10.14/vision_wasm_internal.wasm` is 200
    with `Content-Type: application/wasm` and
    `Cache-Control: public, max-age=31536000, immutable`;
  - `GET /static/tp0.8.1-tv0.10.14/selfie_segmenter.tflite` is 200,
    `application/octet-stream`, and `(hash/sha256 (:body res))` equals
    the hash pinned in task 1 (require `[hash :as hash]`, as
    `docs/KNOWLEDGE.md` notes);
  - `GET /static/tp0.8.1-tv0.10.14/vision_wasm_internal.js` is 200 and
    JavaScript;
  - `GET /static/some-other-tag/vision_wasm_internal.js` is 404;
  - `GET /static/tp0.8.1-tv0.10.14/app.css` and
    `GET /static/tp0.8.1-tv0.10.14/nope.wasm` are 404.

- [x] **Step 2: Run them and see them fail**
  Run: `lgx test`
  Expected: the new assertions fail (404s), everything else passes.

- [x] **Step 3: Implement** in `routes.lg`:
  - add `"wasm" "application/wasm"` and
    `"tflite" "application/octet-stream"` to `content-types`;
  - a private constant for the current tag, `"tp0.8.1-tv0.10.14"`, with
    a comment that `scripts/vendor-blur.mjs` writes the same value into
    the bundle and a bump changes both;
  - a private set of the three versioned names
    (`vision_wasm_internal.js`, `vision_wasm_internal.wasm`,
    `selfie_segmenter.tflite`) with a comment giving the reason from
    "Caching" above;
  - let `static-response` take the `Cache-Control` value as an optional
    second argument (the `long-lived` set keeps working for
    `fonts.css`);
  - the route `{:path "/static/:tag/:file" :method :get}` after
    `/static/:file`: the current tag with a name in the set is served
    with the immutable header, anything else is the JSON 404;
  - rewrite the docstring of `static-response`: `io/slurp` returns a
    let-go string, which holds raw bytes, so binaries are served intact;
    only the listed types are served.

- [x] **Step 4: Run the tests**
  Run: `lgx test`
  Expected: PASS, no failures.

- [x] **Step 5: Commit**
  `git commit -am "Serve the blur assets: wasm and model, cached under a versioned path"`

> Deviation: the versioned path is `/static/blur/<tag>/<file>`, not `/static/<tag>/<file>`. ruuter refuses `/static/:tag/:file` beside `/static/:file` ("conflicting param parameter names at same position"); a literal segment is matched separately. `assetBase` in the vendor script and the bundle changed to match. Everywhere below, read `/static/<tag>` as `/static/blur/<tag>`.

### Task 3: The toggle in the lobby and in the call

**Files:**
- Modify: `resources/public/ui.js`, `resources/public/room.html`, `resources/public/app.css`

- [ ] **Step 1: Read first.** In `resources/public/livekit-client.umd.min.js`,
  find what `LocalTrack.stop()` does with a processor (search for
  `stopProcessor` and `processor`), to settle the `stopTracks` point in
  the design, and confirm `getProcessor`, `setProcessor` and
  `stopProcessor` are the method names.

- [ ] **Step 2: The icon.** Add `blur` to `ICONS` in `ui.js`: a head and
  shoulders with dots on both sides, in the outline style of the others.
  A starting point, to be adjusted by eye in step 6:
  `<circle cx="12" cy="9" r="3.5"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/><path d="M3 5h.01M3 10h.01M3 15h.01M21 5h.01M21 10h.01M21 15h.01M7.5 3h.01M16.5 3h.01"/>`.
  One icon serves both states; the solid button is what says "on".

- [ ] **Step 3: Markup** in `room.html`:
  `<script src="/static/track-processors.js"></script>` after the
  `livekit-client` script; `<button id="blur-preview" hidden></button>`
  inside `.preview`, after the video; `<button id="blur" hidden></button>`
  as the first child of `.controls`. Update the comment above the lobby
  section to mention the button. In `test/quickmeet/routes_test.lg`,
  assert that the room page's body includes
  `/static/track-processors.js`.

- [ ] **Step 4: Logic** in `room.html`, as "The page logic" in the
  design specifies: `BLUR_KEY`, `camTrack`, `blurOn`, `blurSupported`,
  `setBlur`, `restoreBlur`, `drawBlur`, the click handlers on both
  buttons, the `window.call.blur` getter (document it in the comment
  above `window.call`), the new order of `lobby.ready`, `drawBlur()`
  from `showCam`, the failure message in both places, and the
  `stopTracks` change if step 1 showed it is needed. Put the block
  between the lobby and call sections with a comment that explains, in
  the page's voice, that the track is the source of truth and why
  `fillDevices` runs before `restoreBlur`. A switch in flight is the
  `blurBusy` promise, which `join()` awaits. Clicks while the controls are faded are already
  swallowed by the existing handlers; nothing to add.

- [ ] **Step 5: CSS** in `app.css`:
  - `.preview { position: relative; }` and `#blur-preview`: absolute,
    12px from the right and bottom, 44px round, the glass look of
    `.controls button` (share the rule by adding the selector to it
    where that reads well, rather than copying declarations);
  - `[data-on]` solid on both buttons: extend the existing
    `.controls button[data-off]` rule and its comment ("the unusual
    state is the solid one": microphone or camera off, blur on);
  - `button:disabled` already dims.
  The lobby preview video is mirrored with `transform` on the `<video>`;
  the button is a sibling, so it is not mirrored.

- [ ] **Step 6: Look at it.** Build and run locally (`lgx build`, then
  the binary with the e2e ports from `e2e/playwright.config.js`, or a
  short Playwright script in the scratch directory) and take headless
  screenshots at 390x844, 667x375 and 1280x800 of the lobby and the
  call, blur off and on. Check: the row of four is centred and clear of
  the self view in all three; the preview button sits in the corner;
  the icon reads as "person with a blurred background" at 24px; on is
  clearly different from off. Adjust the icon and spacing until it does.
  Follow /frontend-design only as far as matching what is there.

- [ ] **Step 7: Run the existing suites**
  Run: `lgx test && lgx e2e`
  Expected: PASS. Nothing that existed changes behaviour; a failure here
  is a regression (the likeliest: the device select losing its selected
  option, or `lobby.ready` no longer resolving).

- [ ] **Step 8: Commit**
  `git commit -am "Background blur: one toggle in the lobby and in the call"`

### Task 4: Browser tests

**Files:**
- Create: `e2e/tests/blur.spec.js`
- Modify: `e2e/tests/mobile.spec.js`

- [ ] **Step 1: Write `blur.spec.js`** with the helpers in
  `e2e/tests/helpers.js` (`newRoom`, `openLobby`, `joinAs`, `statsOf`,
  `remoteOf`) and the suite's shape (own contexts, closed in
  `afterEach`). Four tests, as "Testing" in the design lists them:
  1. **From the lobby into the call.** Alice opens the lobby
     (`openLobby`), `#blur-preview` is visible; she clicks it; poll
     `window.call.blur` to `true`, `aria-pressed` is `true`,
     `localStorage['quickmeet.blur']` is `'1'`, the preview's
     `videoWidth` is above 0. Reload: `call.blur` becomes `true` again
     without a click, and `#cam-select` has a non-empty value. Select
     the last camera option: `call.blur` is still `true` (the processor
     restarts with the track) and `#error` is hidden. Fill the
     name, join; Bob joins (`joinAs`); poll Bob's
     `statsOf().video.framesDecoded` above 0, read it, then poll until
     it is larger (blurred frames arrive). Alice clicks `#cam`: `#blur`
     is disabled; clicks `#cam` again: `call.blur` is `true` and `#blur`
     enabled. Alice clicks `#blur`: `call.blur` is `false`, the
     preference is gone, and Bob's `framesDecoded` grows again.
  2. **When the assets do not load.** `init` for Alice's context routes
     `**/vision_wasm_internal.wasm` to `route.abort()`. She clicks
     `#blur-preview`; poll until the button is enabled again with
     `aria-pressed` `false`; `#notice` contains `not available`;
     `call.blur` is `false`; the preference is absent; she joins and
     `call.joined` is `true`. A second case in the same test file: the
     wasm route is delayed by two seconds instead of aborted
     (`route.continue()` after a timeout); she clicks `#blur-preview`
     and at once `#join`; when `call.joined` becomes `true`,
     `call.blur` is already `true`.
  3. **Without support.** `init` adds an init script that deletes
     `window.VideoFrame`. In the lobby, once the preview plays,
     `#blur-preview` is hidden; after the join, `#blur` is hidden.
  Give test 1 `test.setTimeout(120_000)`: software WebGL is slow.

- [ ] **Step 2: Extend `mobile.spec.js`**: add `'#blur'` to the id lists
  in "the banner, the sound button and the controls all fit" (both
  loops) and in "the remote tile, its name and the controls all fit",
  and to any other list there that names `#mic`, `#cam` and `#leave`
  together as the set of controls.

- [ ] **Step 3: Run**
  Run: `lgx e2e`
  Expected: PASS, the four new tests included. If test 1 is flaky on
  frame growth, lengthen the poll's timeout; do not assert a rate.
  Then `cd e2e && npx playwright test blur.spec.js --repeat-each 3`
  against a fresh `lgx build` (Playwright starts the binary itself).
  Expected: 12 passed.

- [ ] **Step 4: Commit**
  `git add e2e && git commit -m "e2e: background blur in the lobby and the call"`

### Task 5: Documentation

**Files:**
- Modify: `README.md`, `docs/KNOWLEDGE.md`, `docs/ROADMAP.md` (only if it has a place for shipped features)

- [ ] **Step 1: `README.md`.** Extend the vendoring paragraph (the blur
  library, wasm and model: `lgx vendor-blur`, versions in
  `scripts/vendor-blur.mjs`); add `scripts/vendor-blur.mjs` and the new
  files to the layout list; mention blur wherever the README lists what
  the room page does.

- [ ] **Step 2: `docs/KNOWLEDGE.md`.**
  - Stack table: rows for `@livekit/track-processors` 0.8.1 and
    `@mediapipe/tasks-vision` 0.10.14 (with the model's hash pin).
  - "The pages": replace the claim that the app serves only text. A
    let-go string holds raw bytes, `io/slurp` and the http server pass
    them through, verified with `cmp` on 2026-10-01 and by the route
    test; the font stays base64 because nothing needs it to move.
  - A new dated section "Background blur": what the spike and the e2e
    run showed (headless Chromium works with software WebGL at about one
    frame a second, no extra flag); a processor replaces
    `track.mediaStreamTrack`, whose settings have no `deviceId`; the
    package has no UMD build, hence the bundle and the `getLogger` shim;
    the versioned path and why; what step 1 of task 3 found about
    `LocalTrack.stop()`; and "not tried on a real iPhone yet".
  - Add the new upstream files to the "Verify against" footer.
  Use /writing-clearly.

- [ ] **Step 3: Commit**
  `git commit -am "docs: background blur"`

### Task 6: Review and pull request

- [ ] **Step 1:** Run `lgx test && lgx e2e` once more on the final tree.
  Expected: PASS.
- [ ] **Step 2:** Push the branch and open a pull request against
  `master`. The description says what was verified (the two suites,
  the screenshots) and what was not: blur on a real iPhone and on a
  real Android phone, to be tried on staging after the merge deploy.
  When it has been tried, update the "not tried" line in
  `docs/KNOWLEDGE.md` with what was seen.
