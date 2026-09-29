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
  `lgx version`; `.mise.toml` pins 0.4.2 here.
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
  SIGKILL on teardown (`processLauncher.js`), so the open question of `lg`
  ignoring SIGTERM does not affect the tests: no listener survives a run.
- Pinned together: `@playwright/test` 1.56.0 and `chromium_headless_shell-1194`.
  A Playwright bump changes the browser build, so `lgx e2e-setup` again.

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
- `lg` ignores SIGTERM (see "Dev tooling gotchas"), so the service sets
  `stop_grace_period: 2s`; waiting Docker's default 10 s buys nothing.

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
- Not yet seen: how uncloud updates a service that holds host-mode ports.
  The first deploy created the service; the next one is the first update.

---

> **Verify against:** `lgx.edn`, `compose.yaml` and
> `.github/workflows/deploy.yml` in this repo; in uncloud v0.20.0,
> `pkg/client/compose/` and `internal/machine/caddyconfig/template.go`; in lgx,
> `lgx/gobuild.lg` (runtime build, `:go/replace`, the stamp) and
> `docs/knowledge-base/lgx-go-runtimes.md`; in letgo-packages,
> `livekit/shim/shim.go`, `livekit/src/livekit/core.lg`,
> `livekit/README.md`; in let-go 1.13.0, `pkg/rt/http.go`,
> `pkg/rt/hash_sha.go`, `pkg/rt/os.go`.
