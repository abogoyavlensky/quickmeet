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
| livekit-client (JS) | 2.x | the browser side, from a CDN for now |

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

## What the milestone 0 spike proved, 2026-09-27

Two browser participants in one tab, publishing canvas video and
oscillator audio, through the SFU embedded in the `lg` process: both
connected over the WebSocket signalling on port 7880, each subscribed to
the other's audio and video, frames decoded, zero packet loss, counters
growing. A Go client-SDK probe independently forwarded RTP through the
same SFU. The browser side is stock `livekit-client` 2.22.3; nothing
LiveKit-specific runs on the server beyond the package.

The spike lives at `~/Projects/meet-spike` on the dev machine (not in this
repo): `main.lg` (server plus token route), `index.html` (the two-participant
page) and `probe/` (the Go probe). `/tmp/pw/run.mjs` drove it with Playwright.

## Dev tooling gotchas

- The `lgx` on `PATH` may be older than the one a project needs. Check
  `lgx version`; `.mise.toml` pins 0.4.2 here.
- The first `lgx run` or `lgx test` after a change to the Go coord set
  builds a new runtime: a minute or more with a cold Go module cache,
  seconds when warm. Later runs are cache hits.
- `lgx build` runs top-level forms at compile time. Guard the entry point
  with `(when-not *compiling-aot* (-main))` and keep every side effect
  inside `-main`, or bundling starts an SFU.
- let-go's `http/post` is `(http/post url body opts)` with `:headers` and
  `:content-type` in opts; the response map has `:status`, `:headers`,
  `:body`. `http/request` takes one map. `http/request` has no timeout.
- `(str (random-uuid))` renders as `#uuid "..."`, tag included, not the
  bare hex. Strip everything but hex before using it in an id.
- let-go has `hash/sha256`, `base64url-encode`, `random-uuid`, JSON, but no
  HMAC, no bcrypt and no `time` namespace. Sessions should be opaque ids in
  the database rather than signed cookies; password hashing needs a Go
  package.
- The `lg` process did not stop on SIGINT or SIGTERM while `http/wait`
  was blocking during the spike; it needed SIGKILL. Not yet investigated.
- The T3 Code preview tab runs on another network and cannot reach this
  machine's ports, so browser tests use a local headless Chromium.
  Playwright refuses Ubuntu 26.04 by default;
  `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 npx playwright install
  chromium-headless-shell` installs one that works with no missing
  libraries, and `--use-fake-device-for-media-stream` with
  `--use-fake-ui-for-media-stream` gives it a camera and microphone.

## Deployment facts that shape v1

- Browsers require HTTPS for camera access anywhere except `localhost`,
  so a deployment needs TLS in front of the app, and the signalling URL
  becomes `wss://`.
- WebRTC needs the SFU reachable on its UDP range (or TCP fallback port)
  from both sides, or LiveKit's built-in TURN. This is the same for every
  SFU in every language; a proxy that only speaks HTTP cannot carry it.
- Everything the app needs at run time is one binary plus a sqlite file.

---

> **Verify against:** `lgx.edn` in this repo; in lgx,
> `lgx/gobuild.lg` (runtime build, `:go/replace`, the stamp) and
> `docs/knowledge-base/lgx-go-runtimes.md`; in letgo-packages,
> `livekit/shim/shim.go`, `livekit/src/livekit/core.lg`,
> `livekit/README.md`; in let-go 1.13.0, `pkg/rt/http.go`,
> `pkg/rt/hash_sha.go`, `pkg/rt/os.go`.
