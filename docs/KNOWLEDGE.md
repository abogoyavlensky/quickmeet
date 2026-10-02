# What we know: let-go, lgx, LiveKit and the Go packages

Working notes for building quickmeet on let-go. Everything here was
verified against source or by running it, on the dates given. When a
claim goes stale, fix or delete it: a missing note beats a wrong one.

The authoritative docs live upstream. Read these when the summary below is
not enough:

- lgx: `docs/knowledge-base/` in
  [abogoyavlensky/lgx](https://github.com/abogoyavlensky/lgx), in
  particular `lgx-go-runtimes.md`, `lgx-go-wrappers.md`,
  `let-go-gotchas.md`, `let-go-bundling.md`.
- Packages: each package's `README.md` in
  [abogoyavlensky/letgo-packages](https://github.com/abogoyavlensky/letgo-packages),
  and the root README's "Releasing" section.
- let-go: [nooga/let-go](https://github.com/nooga/let-go).

## The stack

| Piece | Version | Role |
|---|---|---|
| let-go | 1.13.0 | the runtime; first release with the `:go/*` interop |
| lgx | 0.4.2 | project tool; builds the custom `lg` with Go packages linked in |
| letgo-packages `livekit` | livekit-v0.1.1 | embedded SFU, join tokens, webhook verification, integrant component |
| letgo-packages `sqlite`, `ragtime` | sqlite-v0.2.0, ragtime-v0.2.0 | storage and migrations |
| livekit-server | v1.13.7 | the SFU, linked into the binary |
| livekit-client (JS) | 2.22.3 | the browser side, vendored into `resources/public/` (`lgx vendor-livekit-client`) |
| @livekit/track-processors (JS) | 0.8.1 | background blur, bundled into `resources/public/track-processors.js` (`lgx vendor-blur`) |
| @mediapipe/tasks-vision | 0.10.14 | the segmentation under the blur: its wasm, plus `selfie_segmenter.tflite` pinned by SHA-256 (`scripts/vendor-blur.mjs`) |
| @playwright/test | 1.56.0 | the browser tests in `e2e/`, on `chromium_headless_shell-1194` |
| uc (uncloud) | 0.20.0 | deploys `compose.yaml` to the staging cluster; bundles Caddy |

## How Go code gets into a let-go binary

- `:lg-runtime :built` in `lgx.edn` makes lgx generate a Go module that
  imports let-go plus every declared Go package, build it, and cache the
  result under `$LGX_HOME/runtimes/<hash>/lg`. The default `:installed`
  mode never links Go code and errors on any Go coord.
- A Go coord's key is the Go package path. `:go/version` pins a released
  module, `:go/local` points at a module on disk, `:go/interop` generates a
  let-go namespace for a flat function-oriented API. A dependency's own Go
  coords flow up to the consumer, so depending on a wrapper package is one
  line.
- `:go/replace` (lgx 0.4.1) carries `replace` directives on a coord. Go
  honours replaces only in the main module, which is the one lgx generates,
  so a library that compiles only against forks needs them restated there.
  livekit-server is exactly that case: it replaces pion's `webrtc/v4`,
  `dtls/v3` and `ice/v4` with LiveKit's forks. The livekit package's
  `lgx.edn` carries the block, so consumers inherit it. When bumping
  livekit-server, copy the block from the new tag's `go.mod`.
- `:go/local` runtimes are rebuilt only when the directory's files changed
  (lgx 0.4.2, a content stamp in `local.stamp` beside the cached binary).
  Before that, every command re-ran the Go build. This is what lets the
  livekit package ship its Go shim in-tree with one tag per release.
- Two wrapper shapes. Shape A, generated bindings plus a thin shim, fits a
  flat API (`database/sql`). Shape B, a hand-written shim and nothing
  generated, fits anything configured by struct literals, generics or
  callbacks: lgx passes `-opaque-structs`, so no struct constructors are
  emitted, and generic exports are skipped silently. LiveKit and Wails are
  Shape B. Do not try to make `:go/interop` carry a framework.
- Callbacks cross one way. A Go func returned to let-go becomes a fn; a
  let-go fn cannot become a Go func. A shim holds a `vm.Fn` and invokes it
  from Go instead.
- Maps do not cross the boundary as `map[string]any`; shims take
  `vm.Value` and convert. Methods are not first-class in let-go, so
  `(apply .Method ...)` does not exist; spread variadics in a shim.

## The livekit package, verified 2026-09-26 and 2026-09-27

- The server embeds cleanly. `config.NewConfig` takes a YAML string and a
  nil CLI command; its parser is yaml.v3, which accepts JSON, so the shim
  takes a let-go map and serialises it. Keys are LiveKit's own YAML names
  (`bind_addresses`, `tcp_port`), strings or keywords, parsed strictly:
  a misspelled key is an error.
- `prometheus.Init` is idempotent, so an integrant system can halt and
  init again in one process.
- A failed `start!` is fatal for the process. Upstream `Start` opens
  listeners before it flips `running` and does not close them on a later
  failure, and `Stop` returns early while not running. Restart, do not
  retry.
- Rooms auto-create on first join by default. The app only mints tokens.
- Tokens are HS256 JWTs; `lk/token` takes the grant booleans as a map.
  Secrets must be 32+ characters.
- Webhooks are verified by `lk/verify-webhook`: the request's
  `Authorization` header is a JWT whose `sha256` claim is the base64 SHA-256
  of the raw body, and it must be issued by the app's API key.
- Pure Go on linux; `CGO_ENABLED=0` builds. Cross-building to darwin from
  linux fails because a stats dependency needs cgo there; build natively
  on a Mac instead. `lgx build` of this app, LiveKit and sqlite linked and
  the pages embedded, is 84 MB.
- Token failures are all 401. A valid join token without the right grant
  gets `{"code":"unauthenticated","msg":"permissions denied"}` from the
  room API, the same status as a bad signature. To check that the SFU
  accepts a join token, use `GET /rtc/validate?access_token=<jwt>`, which
  answers `200 success` only for a token it would let into the room; it is
  the check `livekit-client` runs to diagnose a failed join.
- The SFU detects the host's public IP as its node IP even with
  `use_external_ip false`. Harmless on a laptop, relevant when deploying.

Verified 2026-09-29, for the two-person rule:

- `room.max_participants` in the config caps every auto-created room
  (`pkg/service/roomallocator.go:189`). At the cap, `Room.Join` returns
  `ErrMaxParticipantsExceeded` (`pkg/rtc/room.go:466`), which reaches the
  browser as a plain 500 on the signalling upgrade
  (`pkg/service/rtcservice.go:404`). `livekit-client` then consults
  `/rtc/validate`, which does not consider the cap and still answers
  `success`, so the client raises a generic connection error: a browser
  cannot tell "full" from "broken" on its own. Hence `quickmeet.sfu`.
- The SFU's twirp room service takes JSON over its own http port:
  `POST /twirp/livekit.RoomService/ListParticipants`, body
  `{"room": "<id>"}`, `Authorization: Bearer <jwt>` with the `roomAdmin`
  grant for that room (`lk/token` with `:room-admin true`). A room the
  SFU has not created yet, which is every app room nobody joined, answers
  404 `requested room does not exist`. Participants carry `state`
  (`JOINING`, `JOINED`, `ACTIVE`, `DISCONNECTED`). With `LIVEKIT_BIND`
  `0.0.0.0` loopback still reaches it.
- `livekit-client` raises `SignalReconnecting` first when only the
  signalling socket drops, and `Reconnecting` only for a full reconnect;
  a UI must follow both. `Disconnected` carries a `DisconnectReason`;
  `CLIENT_INITIATED` is a leave, anything else is a lost connection.
- `LocalTrack.restartTrack({deviceId})` swaps the capture device and
  re-attaches to the elements the track was attached to, so a lobby
  preview switches cameras without touching the `<video>`. The client
  stops only published tracks on disconnect: preview tracks that never
  got published must be stopped by the page.
- Safari (iOS above all) can block remote audio until a user gesture:
  `RoomEvent.AudioPlaybackStatusChanged` plus `room.canPlaybackAudio`
  say so, and `room.startAudio()` from a click unblocks it.

## Rooms and history, verified 2026-09-30

- The SFU's config takes `webhook: {api_key, urls: [..]}` like any other
  key; with `http://127.0.0.1:<PORT>/...` the embedded SFU posts to the
  app it lives in. Delivery is queued per room and in order; the log line
  is `livekit.webhook ... sent webhook` at info level.
- Webhook bodies are protojson without proto names: camelCase keys
  (`joinedAt`, `createdAt`, `numParticipants`) and int64 as strings. The
  twirp room API is the opposite: proto names (`num_participants`) and
  zeros emitted. Read each accordingly.
- A room made through `CreateRoom` (grant `roomCreate`) is a real rtc
  room: the SFU sends `room_started` at once and `room_finished` on
  `DeleteRoom`, which also wants `roomCreate`, not `roomAdmin` (401
  `permissions denied`). `ListRooms` wants `roomList`. That is how
  `system_test.lg` sees real delivery without a browser.
- `room_finished` for an emptied room comes after `empty_timeout`
  (300 s); history's end time is the last leave, so it does not wait.
- Signing a webhook in a test: the claim is
  `(io/encode :base64 (io/decode :hex (hash/sha256 body)))` (a let-go
  string holds raw bytes) and the header `(lk/token key secret {:sha256
  claim})`. Ask for `hash` with `(:require [hash :as hash])`; `io` needs
  no require.
- HoneySQL under let-go renders `{:insert-into .. :select ..}` with the
  clauses out of order; `migrations.lg` accepts a SQL string for such a
  step. `[:raw "datetime(?, 'unixepoch')"]` works, and its `?` is a
  positional parameter like any other: pass the arguments in the order
  of the rendered SQL, not of the map.
- `(sleep ms)` is the pause in let-go; there is no `Thread/sleep`.

## Accounts, verified 2026-09-29

- `golang.org/x/crypto/bcrypt` works as a `:go/interop` coord with no
  shim. A let-go string unboxes to `[]byte` on the way in, and a `[]byte`
  result boxes to a string (`pkg/vm/value.go:233`), so
  `(bcrypt/GenerateFromPassword "pw" 10)` returns the hash as a string.
  A function whose only result is `error` returns it as a *value*, not
  an exception: `(bcrypt/CompareHashAndPassword hash "pw")` is `nil` on
  a match and a boxed Go error otherwise, so check with `nil?`. A new
  Go coord rebuilds the runtime once (a minute warm); CI's cache key is
  the hash of `lgx.edn`, so it rebuilds there once too.
- `(str (random-uuid))` is `#uuid "..."` with the tag. Stripping non-hex
  characters keeps the `d` of `uuid`: every room id before M3 starts
  with `d` for that reason (44 random bits, not 48). `quickmeet.id`
  takes the 36-character uuid out first.
- let-go's server joins repeated request headers with commas and
  lowercases the names, so the cookie header is one string under
  `"cookie"`. Response headers are added one by one (`Header.Add`), so a
  map with one `Set-Cookie` is enough. Its http client lowercases
  response header names too: read `set-cookie`, not `Set-Cookie`.
- Verified 2026-10-02: the server's `:uri` is the request URI, query
  string included (`url.RequestURI()`, `pkg/rt/http.go:270`); `:path` is
  the path alone and `:query-string` the raw query. ruuter matches `:uri`
  whole, so any `?..` used to 404. `routes/handler` strips the query
  before routing; read parameters from `:query-string`.
- `hash` and `open` are `clojure.core` names in let-go; a namespace that
  defines them warns unless it `:refer-clojure :exclude`s them.
- The sql layer treats a bare `pragma table_info(t)` as a statement
  without rows; `select name from pragma_table_info('t')` returns them.
- Sign-in timing: until 2026-09-30 an unknown address returned without
  running bcrypt (about 60 ms at cost 10), which told an attacker the
  account did not exist. Now it compares against a fixed cost-10 hash
  (`password/dummy-hash`, a literal because AOT runs top-level forms);
  measured, both paths take 60 to 70 ms.
- `with-redefs` works in let-go tests, over a namespace's public fns.

Learned in the review before shipping, 2026-09-30:

- Login CSRF: an html form with `enctype="text/plain"` can post a body
  that parses as JSON, and `SameSite=Lax` does not stop it because the
  attack needs no existing cookie; the sign-in response would set the
  attacker's session in the victim's browser. Requiring
  `Content-Type: application/json` closes it: a form cannot send that
  type, and a cross-site `fetch` with it needs a CORS preflight the
  server never answers. let-go lowercases the header name.
- A lookup-then-insert on a unique column races under concurrent
  requests (every handler runs on its own goroutine): catch the
  `UNIQUE constraint failed` error at the insert and re-check, rather
  than trust the lookup. `system_test.lg` has the pattern with futures.
- Browsers cap a cookie's lifetime (Chrome: 400 days), so "indefinite"
  sessions are not available; one number in `auth.lg` sets both the
  cookie's `Max-Age` and the SQL window, and a test pins the two.

## What the milestone 0 spike proved, 2026-09-27

Two browser participants in one tab, publishing canvas video and
oscillator audio, through the SFU embedded in the `lg` process: both
connected over the WebSocket signalling on port 7880, each subscribed to
the other's audio and video, frames decoded, zero packet loss, counters
growing. A Go client-SDK probe independently forwarded RTP through the
same SFU. The browser side is stock `livekit-client` 2.22.3; nothing
LiveKit-specific runs on the server beyond the package.

The spike lived at `~/Projects/meet-spike` on the dev machine (not in this
repo). The e2e suite in `e2e/` supersedes it: the same technique, two
browser contexts instead of one page, against the real room page and the
built binary, run by `lgx e2e` (2026-09-27).

## Dev tooling gotchas

- The `lgx` on `PATH` may be older than the one a project needs. Check
  `lgx version`; `.mise.toml` pins 0.4.2 here. When mise cannot install
  the pinned Go (the 1.27.1 download 404ed on 2026-09-29), the pinned
  lgx binary at `~/.local/share/mise/installs/lgx/0.4.2/lgx` runs fine
  with the system Go, with `CGO_ENABLED=0` exported by hand.
- The first `lgx run` or `lgx test` after a change to the Go coord set
  builds a new runtime: a minute or more with a cold Go module cache,
  seconds when warm. Later runs are cache hits.
- `lgx build` runs top-level forms at compile time. Guard the entry point
  with `(when-not *compiling-aot* (-main))` and keep every side effect
  inside `-main`, or bundling starts an SFU.
- let-go's http server lowercases request header names
  (`pkg/rt/http.go:261`), and the Host header is not among them: Go's
  server moves it to `request.Host`, which let-go passes as
  `:server-addr` (port included). A handler reading `"host"` from
  `:headers` always gets nil over real HTTP; unit tests that build the
  request map by hand will not notice (2026-09-28).
- let-go 1.13.0 runs every http handler on the shared root
  `ExecContext` (`Func.Invoke`, `pkg/vm/func.go:184`), so concurrent
  requests share one dynamic-binding stack. Anything that binds dynamic
  vars on the request path (HoneySQL's `format` does) can be corrupted
  by a concurrent request. Goroutines let-go spawns itself get their own
  context; Go's http goroutines do not. See
  `docs/backlog/letgo-http-handlers-share-dynamic-bindings.md`.
- `sqlite.core/open` passes the path to modernc.org/sqlite as the DSN, so
  pooled connections have busy timeout 0: concurrent writers fail with
  `SQLITE_BUSY` rather than wait. `path?_pragma=busy_timeout(...)` fixes
  it per connection. Leave off the `file:` prefix: with it SQLite reads
  the path as a URI, and `#` or `%` in it open a different file. See
  `docs/backlog/sqlite-busy-on-concurrent-writes.md`.
- let-go's `http/post` is `(http/post url body opts)` with `:headers` and
  `:content-type` in opts; the response map has `:status`, `:headers`,
  `:body`. `http/request` takes one map. `http/request` has no timeout.
  A non-2xx response comes back as that map, not an exception
  (`pkg/rt/http.go:640`); only a failed connection throws.
- Browser layout, learned with headless screenshots (2026-09-29): an
  author `display: grid` on a section beats the `hidden` attribute's
  `display: none`, so `[hidden] { display: none !important }` is needed;
  a `<video>` has an intrinsic height, so a flex or grid container that
  should fit the viewport needs `min-height: 0` on the items (and
  `minmax(0, 1fr)` rows) or it grows to the video and pushes absolutely
  positioned controls off screen; `100dvh` (with a `100vh` fallback and
  `min-height: 0`) keeps controls above a phone's address bar;
  `viewport-fit=cover` plus `env(safe-area-inset-bottom)` clears the
  home indicator.
- Video shape, verified 2026-10-01: a `<video>` element fires `resize`
  when the first frame arrives and whenever the frame size changes, and
  `videoWidth`/`videoHeight` give the shape actually shown; the room page
  sizes the remote tile from them. `container-type: size` on the call
  area makes `100cqh` its content-box height (padding excluded), so
  `width: min(100%, calc(100cqh * var(--ratio)))` with
  `aspect-ratio: var(--ratio)` is the largest tile of that shape that fits.
  `--ratio` is a plain number so `calc()` can multiply it. LiveKit's
  `createLocalTracks` asks for 720p, so the headless fake camera arrives
  16:9, not its native 4:3. A tall sender in tests is a `getUserMedia`
  wrapper that swaps in a `canvas.captureStream()` track, repainted on a
  timer (`tallCamera` in `e2e/tests/helpers.js`). Whether a real phone
  held upright sends tall frames is checked on devices, not here.
- `(str (random-uuid))` renders as `#uuid "..."`, tag included, not the
  bare hex. Strip everything but hex before using it in an id.
- let-go has `hash/sha256`, `base64url-encode`, `random-uuid`, JSON, but no
  HMAC, no bcrypt and no `time` namespace. Sessions should be opaque ids in
  the database rather than signed cookies; password hashing needs a Go
  package.
- During the M0 spike, `lg` under `lgx run` did not stop on SIGINT or
  SIGTERM while `http/wait` blocked. The built binary does: with no
  handler registered it takes Go's default action and dies (checked
  2026-09-30), and since then `main.lg` registers one. See "Restarts and
  shutdown".
- The T3 Code preview tab runs on another network and cannot reach this
  machine's ports, so browser tests use a local headless Chromium.
  Playwright refuses Ubuntu 26.04 by default;
  `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 lgx e2e-setup`
  installs one that works with no missing libraries. On a supported
  distribution (CI's ubuntu-latest) the override must be left out.
- Fake media devices work through the normal `getUserMedia` path in the
  headless shell: `--use-fake-device-for-media-stream` and
  `--use-fake-ui-for-media-stream` plus `grantPermissions(['camera',
  'microphone'])` on the context, and the room page's `createLocalTracks`
  gets a synthetic camera and microphone unchanged. Two browser contexts
  are two independent participants; the SFU sees a real call.
- Playwright's `webServer` kills the app's whole process group with
  SIGKILL on teardown (`processLauncher.js`), so no listener survives a
  run whatever the app does with SIGTERM.
- Pinned together: `@playwright/test` 1.56.0 and `chromium_headless_shell-1194`.
  A Playwright bump changes the browser build, so `lgx e2e-setup` again.

## The pages, verified 2026-10-01

- Binary files are served intact, corrected 2026-10-01: until then this
  note said the app could serve only text. `io/slurp` returns a let-go
  string, which is a Go string and holds raw bytes, and the http server
  writes `[]byte(s)` (`pkg/rt/ions.go:273`). 300 kB of wasm through
  `io/slurp` and `io/spit` came back identical (`cmp`), and a route test
  checks the served model's SHA-256. `static-response` serves only the
  types it lists (now including `wasm` and `tflite`). The font is still
  base64 inside `fonts.css` (120 kB, `lgx vendor-fonts`); nothing needs
  it to move. Icons are inline SVG from `ui.js`; for the favicon and
  the home-screen icons see "The installable app" below.
- Chromium's fake camera reaches the other side as 16:9, not the 640x480
  the device advertises: LiveKit asks for 720p. A 4:3 or a tall sender in
  a test is a canvas (`canvasCamera` in `e2e/tests/helpers.js`).
- On a touch screen a click lands on whatever is under the finger when it
  lifts, not where it went down. Controls that come back on `pointerdown`
  are buttons again by then, so the tap that reveals them would press one
  (it hung up, in the first version). The room page swallows the click of
  a press that began on faded controls; `mobile.spec.js` holds it.
- iPhone Safari has no Fullscreen API for pages (no
  `webkitRequestFullscreen` on elements), so the full-screen button is
  absent there; Android and desktop browsers have it. On an iPhone the
  way to lose Safari's bars is "Add to Home Screen". Not tried on a
  device yet.

## The installable app, verified 2026-10-02

- Installable through a web app manifest alone
  (`/static/manifest.webmanifest`, `display: standalone`, scope `/`):
  no service worker. Chrome no longer needs one to offer installation,
  and iOS "Add to Home Screen" never did. A manifest's scope is not
  limited by where the file lives; that rule is for service workers.
  Headless, the manifest and its icons load (`e2e/tests/app.spec.js`);
  installing on a real phone is not tried yet.
- The PNG icons and `favicon.ico` come from `scripts/make-icons.mjs`
  (`lgx icons`): pure Node, the PNG encoded by hand over `zlib`
  (`zlib.crc32` needs Node 22+), the ICO a 22-byte header around one
  32 px PNG. Two runs write identical bytes. The home-screen icons are
  full-bleed (Android and iOS cut the corners); the favicon has
  `icon.svg`'s rounded ones. `/favicon.ico` is a route of its own,
  because browsers ask for that path whatever a page links, and Safari
  ignores SVG favicons.
- A sticky bar over a list of discs needs a `z-index`. `.avatar` is
  `position: relative` and comes later in the page, so with the bar's
  and the pinned "New call"'s `z-index` set to `auto` a disc scrolled
  under them is what `elementFromPoint` finds there: it paints over
  both.
- Installed to a home screen there is no browser Back, so the lobby,
  History and Settings have a Back link to `/` (not `history.back()`: a
  lobby opened from a shared link has no history).

## Background blur, verified 2026-10-01

- `@livekit/track-processors` ships ES modules only, no UMD build. Its
  one runtime import from `livekit-client` is `getLogger`, so
  `scripts/vendor-blur.mjs` bundles it with esbuild into an IIFE (global
  `LivekitTrackProcessors`) and aliases `livekit-client` to a shim that
  reads the `LivekitClient` global. The bundle is reproducible: two runs,
  identical bytes.
- By default it loads MediaPipe's wasm from jsdelivr and the model from
  Google's storage; `assetPaths` (`tasksVisionFileSet`,
  `modelAssetPath`) points both at the app. Only the SIMD wasm is
  vendored; a browser without wasm SIMD would ask for the `nosimd` file,
  get a 404 and take the page's failure path.
- ruuter refuses two different param names at one position, so
  `/static/:tag/:file` cannot sit beside `/static/:file` ("conflicting
  param parameter names at same position"); a literal segment can, hence
  `/static/blur/:tag/:file`.
- In `livekit-client` 2.22.3, `setProcessor` attaches the processor only
  once its `init` has finished, and `LocalTrack.stop()` destroys an
  attached one. A track stopped while a processor initialises therefore
  gets that processor afterwards; the page takes it off again. With a
  processor on, `track.mediaStreamTrack` is the processed track, whose
  settings have no `deviceId` (the source's are behind the internal
  `getSourceTrackSettings()`). `restartTrack` (a device switch) and
  unmuting the camera restart the processor with the track; muting
  stops the source but keeps the processor.
- The headless shell runs it on software WebGL with no extra flag (it
  logs a SwiftShader deprecation warning). `setProcessor` took 345 ms with
  local assets; the blurred track then delivers about one frame a
  second, and the page's main thread is so busy that animation frames
  are rare. Playwright's actionability wait ("stable") needs two, so
  clicks on a blurring page are forced, and `waitForFunction` must poll
  on a timer (`polling: 500`); its default polls on animation frames.
  Three blurring pages at once starve each other past a two-minute test
  timeout: repeat `blur.spec.js` with `--workers 1`.
- On a real iPhone (2026-10-01, staging): the button shows and
  blur works in the lobby; the stock blur rippled (see below). Frame
  rate and heat not measured; Android not tried.

Why the stock blur ripples, and the patch, 2026-10-01:

- On a phone in front of a patterned wall the stock blur looked like a
  river: streaks that never held still. Three causes, all in the
  library's WebGL (`src/webgl/`). The background is shrunk to a quarter
  by a single bilinear fetch per output pixel, so a fine pattern aliases
  and the aliasing moves with every bit of noise. The Gaussian loop runs
  to `ceil(radius)` with sigma equal to the radius, so the kernel is cut
  at one sigma and acts as a box blur, which leaves a lattice. And the
  default radius 10 becomes 2 texels at quarter size. The person's mask
  is binary and new every frame.
- `scripts/vendor-blur.patch` fixes them: a 4x4 average for the shrink,
  sigma a third of the radius (up to 32 taps a side), the radius scaled
  to the frame's short side over 720, the mask blended with the previous
  one (keeping `exp(-elapsed / 50 ms)` of it), and `highp` in every
  shader. On iPhones `mediump` is a 16-bit float, about 0.6 of a texel
  across a 720-pixel texture, so samples snap; headless Chromium computes
  in 32 bits and cannot show it. The page asks for radius 60.
- Measured with a synthetic camera (a fine leaf pattern at 1280x720,
  moved by a seeded random walk, with sensor noise; per-pixel standard
  deviation over 10 output frames): the stock blur kept 27% of the
  camera's frame-to-frame change, the patched one kept 3.5% at radius 60
  and 2.8% at 80.
  In the headless shell the patched pipeline renders about 30% slower
  (1.3 against 1.9 frames a second on software WebGL).
- On the iPhone (2026-10-01) the patched blur at radius 80 held still
  and ran smoothly, but read as a flat wash, and a sharp patch of
  background the segmenter took for hair stood out against it: the
  person looked cut out. Hence 60, which keeps soft shapes of the room.
- The mask's time smoothing cannot be judged headless: at 2 to 3
  processed frames a second the camera moves between frames, and a fixed
  share of the previous mask only adds lag (it measured worse). Hence a
  time constant, which smooths at 30 frames a second and does nothing
  at 3. Whether edges look steadier is for a phone to show.
- MediaPipe's own mask helpers keep `mediump`; the patch touches only
  the library's shaders.

## Screen sharing, verified 2026-10-02

- No server change is needed. `lk/token` leaves `canPublish` nil when the
  key is absent, which upstream reads as "not restricted", and sets no
  `canPublishSources`, so the join token's `:room-join` alone lets a
  participant publish a screen (`livekit/shim/shim.go`, `Token`). The
  two-person cap counts participants, not tracks.
- `localParticipant.setScreenShareEnabled(on, options)` captures and
  publishes, or unpublishes. Its `createScreenTracks` calls
  `getDisplayMedia` and takes the first video track (and an audio track,
  if the stream has one, as `ScreenShareAudio`). The options become the
  constraints in `screenCaptureToDisplayMediaStreamOptions` (`Aa` in the
  minified bundle): `video` may be an object, into which the default
  1080p resolution is merged, so `{ displaySurface: 'monitor' }` reaches
  the browser; `audio` defaults to false.
- When a published screen track ends by itself (the browser's "Stop
  sharing" bar, the shared window closing), the client unpublishes it
  (`handleTrackEnded` in `LocalParticipant`; a camera or microphone is
  muted instead). Dispatching a synthetic `ended` on the track's
  `mediaStreamTrack` drives the same path; `screenshare.spec.js` does.
  `RoomEvent.LocalTrackPublished` and `LocalTrackUnpublished` say so, and
  fire for the camera and microphone at every join too: filter on
  `pub.source`.
- A page cannot pick the monitor. `getDisplayMedia` always opens the
  browser's or the OS's picker; `displaySurface` only chooses which of
  its tabs opens first.
- Mobile browsers cannot capture the screen. From compatibility data,
  not tried on a device: iPhone Safari (and so every iPhone browser) has
  no `getDisplayMedia` through iOS 26, with one unconfirmed report that
  iOS 27 has it; Chrome and Firefox for Android define it and reject
  every call with `NotAllowedError`. Feature detection alone would show
  a button that cannot work, so the room page also checks the user
  agent.
- A camera turned off with `setCameraEnabled(false)` stays published and
  muted, so the other side still subscribes to it: a viewer can hold a
  camera track that sends no frames.
- The headless shell answers `getDisplayMedia` under
  `--use-fake-ui-for-media-stream` with no prompt: a track labelled
  `screen:-3:0`, `displaySurface: "monitor"`, 1280x720 when asked
  plainly and 1920x1080 through the client (which asks for 1080p). It
  delivers frames: shared from the button, the viewer decoded 33 in 3 s.
  The spec still uses a canvas (`canvasScreen` in
  `e2e/tests/helpers.js`), because its shape tells it apart from the 16:9
  fake camera.
- The viewer's camera, subscribed but attached to no element while a
  screen is on stage, is paused: its `framesDecoded` stayed flat over
  3 s while the screen's grew. `adaptiveStream` asks the SFU to stop a
  video nobody shows, so the hidden camera costs no bandwidth.

## Restarts and shutdown, verified 2026-09-30

- A call survives the server process being killed. Two headless
  Chromiums in a call against the local binary, the server killed with
  SIGKILL and started again after a delay: for a 5 s outage media was
  back 18 s after the kill, for 30 s it was back after 40 s, and for 60 s
  both clients gave up 48 s after the kill and returned to the lobby
  ("Connection lost. Join again."). Nobody clicks anything in between:
  `livekit-client` first tries to resume its old session, which the new
  SFU has never heard of and refuses (it logs `could not restart
  participant` once per client; expected), then does a full reconnect
  that joins the room afresh.
- The same with the app's own shutdown, SIGTERM and a restart 5 s later:
  media moved again 11 s after the stop (`lgx smoke` run locally).
  History closed the first call at the moment of the stop and opened a
  second one on the rejoin.
- `ig/halt!` on `:livekit/server` would hang a shutdown during a call:
  `livekit.integrant`'s halt calls `(lk/stop! server false)`, and
  `LivekitServer.Stop(false)` loops every 5 s until nobody is in a room
  (`livekit-server@v1.13.7/pkg/service/server.go:358`). `Stop(true)`
  closes every room with `RoomCloseReasonServerShutdown`
  (`pkg/service/roommanager.go:242`), which tells the clients to leave
  rather than reconnect. Hence `system/shutdown!` never halts the SFU; it
  dies with the process.
- Signals: `(syscall/signal-notify ch syscall/SIGTERM syscall/SIGINT)`
  forwards each signal as an Int onto `ch` from a Go goroutine with an
  8-signal buffer (`pkg/rt/syscall_linux.go:599`; on other platforms it
  is an "unsupported" stub). Core `chan` takes no arguments; the
  buffered `(chan n)` lives in the async namespace. `(http/stop server)`
  drains in-flight requests for up to 5 s, falls back to closing them,
  and is idempotent; `http/wait` returns once it has finished. After
  `-main` returns, `os/exit` makes the status explicit.
- At startup the embedded SFU has no rooms, so a call still open in the
  database was left by a process that died; `quickmeet.db`'s `init-key`
  closes it at that moment. This assumes one process per database file.
- The rate limiter keeps its state in an atom updated with `swap!`: no
  dynamic bindings on the request path, which matters while
  `docs/backlog/letgo-http-handlers-share-dynamic-bindings.md` is open.
- What a deploy costs a live call on staging, measured with `lgx smoke`
  through the release milestone's merge deploy (2026-09-30): uncloud
  stopped the old container at 23:52:11.0, it was gone at 11.5, the new
  one was running at 14.0, and media flowed both ways again at 23:52:38,
  27.6 s without media in total. Nobody clicked anything. History split
  the call in two at the deploy, at 23:52:15, the new process's startup.
  The local restart is faster (11 s) because the browsers back off
  between reconnect attempts, so a longer outage costs more than its own
  length.
- The next deploy (PR #12, 2026-10-01) was the first to stop the new
  build: uncloud's stop took 0.73 s (00:19:02.9 to 03.6), so the SIGTERM
  handler works as PID 1, and history closed the call at 00:19:02, the
  moment of the stop, not at the next start. That call took 59.9 s to
  get media back: both browsers were back in the room within 16 s, then
  each showed "Waiting for the other person" for 40 s before they saw
  each other (`docs/backlog/reconnect-after-deploy-can-leave-both-waiting.md`).
- A join can fail once on staging with "could not establish signal
  connection" when the box drops the new connection; trying again works.
  `lgx smoke` retries up to four times.
- Sandboxes: on the dev machine the agent user cannot reach the docker
  socket and cannot create user namespaces (`unshare -U` fails), so the
  PID 1 case cannot be reproduced locally; staging is where it is seen.

## Deployment facts that shape v1

- Browsers require HTTPS for camera access anywhere except `localhost`,
  so a deployment needs TLS in front of the app, and the signalling URL
  becomes `wss://`.
- WebRTC needs the SFU reachable on its UDP range (or TCP fallback port)
  from both sides, or LiveKit's built-in TURN. This is the same for every
  SFU in every language; a proxy that only speaks HTTP cannot carry it.
- Everything the app needs at run time is one binary plus a sqlite file.

Learned while setting up staging on uncloud, 2026-09-28:

- A native `lgx build` keeps Go's platform default and links against
  glibc ("dynamically linked"), which does not start on Alpine.
  `CGO_ENABLED=0` makes it static (about 90 MB with debug info). lgx keys
  the runtime cache on that variable (`lgx/gobuild.lg:212`), so the first
  static build rebuilds the runtime, and a CI cache key must change with
  it: `actions/cache` never saves on an exact key hit.
- `rtc.udp_port` multiplexes all WebRTC media on one UDP port; when it is
  valid, livekit-server 1.13.7 ignores the port range
  (`pkg/service/server.go:282`) and logs `rtc.portUDP {"Start":7882,"End":0}`.
  The app switches to it when `LIVEKIT_UDP_PORT` is set
  (`src/quickmeet/system.lg`). One port is all a container's host-mode
  mapping needs.
- `rtc.use_external_ip true` finds the public address over LiveKit's
  default STUN servers (`mediatransportutil/pkg/rtcconfig/config.go:38`)
  and advertises it in ICE candidates; run locally it logged
  `found external IP via STUN`.
- uncloud's `x-caddy` takes a Caddyfile block per service, rendered with
  Go templates when containers start: `{{upstreams PORT}}` or
  `{{upstreams "service" PORT}}` expands to the service's container
  addresses. It cannot be combined with http/https `x-ports`, only with
  host-mode ones (`PORT:PORT/udp@host`; `pkg/client/compose/service.go:421`).
  Compose interpolates `${VAR}` inside the block first. `uc caddy config`
  shows the rendered result.
- uncloud creates a bind mount's host directory if it is missing
  (`CreateHostPath: true`). `uc deploy` has no dry run; to check a
  compose file offline, load it through uncloud's
  `compose.LoadProject` and `ServiceSpecFromCompose` and call `Validate`.
- Capacity, measured 2026-09-28 with the e2e call spec run as 1, 2 and 4
  parallel calls against one binary (headless Chromium, fake media):
  peak RSS 122, 152 and 198 MB, so each call adds about 25 MB over a fixed
  base of about 100 MB. Two calls used 11% of one core on average, 24% at
  peak. The container's `mem_limit: 256m` fits about five or six calls.
  Real cameras send more than Chrome's fake device; memory should hold
  (it is mostly per-participant buffers), CPU scales with packet rate.
- Until 2026-09-30 the service set `stop_grace_period: 2s` on the belief
  that `lg` ignores SIGTERM. It did not, even as PID 1 in the container:
  at the 2026-09-30 deploy the old build, with no handler of its own,
  stopped 0.44 s after uncloud began stopping it. Go's runtime catches
  SIGTERM itself and exits when re-raising it has no effect, which is the
  PID 1 case. The app now registers a handler, and the grace period is
  10 s, a ceiling it does not reach.

The first deploy, 2026-09-28 to 2026-09-29:

- It works end to end: two phones on different networks held a call at
  `https://quickmeet.absky.dev`. A headless-Chromium call from the dev
  machine showed ICE using UDP `85.193.88.17:7882` for one participant and
  the TCP fallback on 7881 for the other, zero loss, RTT 43-50 ms.
- STUN discovery inside the container found the server's public IP, so
  `rtc.node_ip` was not needed. Caddy passes the `/rtc` WebSocket upgrade
  with no extra config.
- A readiness probe against a freshly started container gets `curl: (56)
  Connection reset by peer`, not "connection refused": Docker's port proxy
  accepts the connection before the app listens. Use `--retry-all-errors`.
- The staging server (85.193.88.17, uncloud machine `staging-ru-1`)
  dropped about one in four new TCP connections from the dev machine, for
  unison's domain as much as quickmeet's. If pages hang there, look at the
  network or the server's firewall before the app.
- uncloud updates a service that holds host-mode ports stop-first,
  chosen on its own (plan line `replace container ... (stop-first)`): the
  old container stops, the new one starts and is monitored for 5 s, then
  the old one is removed. No port conflict and no config needed; a deploy
  drops any live call for a few seconds. The sqlite file on the bind mount
  survives (a room created before the 2026-09-29 update was still there).

---

> **Verify against:** `lgx.edn`, `compose.yaml`,
> `scripts/make-icons.mjs` and `.github/workflows/deploy.yml` in this repo;
> in uncloud v0.20.0, `pkg/client/compose/` and `internal/machine/caddyconfig/template.go`; in lgx,
> `lgx/gobuild.lg` (runtime build, `:go/replace`, the stamp) and
> `docs/knowledge-base/lgx-go-runtimes.md`; in letgo-packages,
> `livekit/shim/shim.go`, `livekit/src/livekit/core.lg`,
> `livekit/README.md`; in `@livekit/track-processors` 0.8.1,
> `src/index.ts`, `src/ProcessorWrapper.ts` and
> `src/transformers/BackgroundTransformer.ts`; in `livekit-client` 2.22.3,
> `src/room/track/LocalTrack.ts`, `LocalVideoTrack.ts` and `utils.ts`
> (`screenCaptureToDisplayMediaStreamOptions`), and
> `src/room/participant/LocalParticipant.ts` (`createScreenTracks`,
> `handleTrackEnded`), read in the minified bundle; in ruuter
> v2.1.1, `src/ruuter/core.cljc`; in let-go 1.13.0, `pkg/rt/ions.go`,
> `pkg/rt/http.go`, `pkg/rt/hash_sha.go`, `pkg/rt/os.go`,
> `pkg/rt/syscall_linux.go`, `pkg/rt/async.go`; in livekit-server v1.13.7,
> `pkg/service/server.go` and `pkg/service/roommanager.go`.
