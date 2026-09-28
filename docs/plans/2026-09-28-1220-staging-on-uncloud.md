# Staging on uncloud Implementation Plan

> **Status (2026-09-28):** Tasks 1-5 and 7 done on branch `staging-on-uncloud`. Tasks 6 (provisioning) and 8 (first deploy, phone check) are user-driven and still open. See "Execution summary" at the end.

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** quickmeet runs at `https://quickmeet.absky.dev` on the `unison-staging` uncloud cluster, deployed by CI on every push to master, and two phones on different networks can hold a call there.

**Tech Stack:** uncloud (`uc` 0.20.0) with its built-in Caddy, Docker Buildx with the GitHub Actions cache, GitHub Actions, the existing lgx build, LiveKit's single-port UDP mode. The app changes are small: the signalling URL, two configuration variables, a testable config function.

---

## Design

### Why deployment comes before the rest of M2

The roadmap put deployment at M5, after accounts and history. Trying the current build from a phone through ngrok showed that nothing about the product can be judged on a real device until it is deployed: the signalling URL is built for a laptop, media needs the SFU reachable over UDP, and camera access needs HTTPS. Every open M2 item (lobby, device selection, reconnection states) is about behaviour on real devices, which headless Chromium with fake media cannot judge. So the order changes: a reduced M5, "staging works, documented", comes next, and the M2 items follow with a real device to test them on. Release builds, macOS builds and a general install guide stay out of scope.

### How linkboard and unison deploy, and what is reused

Both projects deploy with uncloud: a `compose.yaml` with a `build:` section, the image built on the CI runner with the GitHub Actions cache, secrets injected through `printenv` and `x-command`, sqlite or Postgres on a mount, and one `uc deploy` over SSH. TLS and routing come from uncloud's Caddy. quickmeet takes the same shape on the same cluster as unison's backend, context `unison-staging`, a 1 GB host that already runs a JVM app, Postgres and MinIO with about 415 MB reserved.

### What is different for a video app

Caddy can proxy the app's HTTP and the SFU's signalling WebSocket, but it cannot carry WebRTC media, and uncloud containers live on an overlay network. Two LiveKit facts make this manageable:

- `rtc.udp_port` multiplexes all media over one UDP port instead of a range. Verified in `livekit-server` 1.13.7 (`pkg/service/server.go:282`): when `udp_port` is valid the range is ignored. So the compose file publishes one UDP port and the TCP fallback port in uncloud's host mode, ports identical inside and outside the container.
- `rtc.use_external_ip true` discovers the host's public address over STUN (LiveKit's default servers, `mediatransportutil/pkg/rtcconfig/config.go:38`) and advertises it in ICE candidates, so a host-mode port mapping works.

### Key decisions

- **One hostname, split by path at Caddy.** uncloud's `x-caddy` extension lets the service supply its own Caddy block with `{{upstreams PORT}}` templates, and host-mode `tcp` and `udp` ports are allowed alongside it. `/rtc*` goes to the SFU port, everything else to the app port. Only `/rtc*` is exposed: the browser needs `/rtc` and `/rtc/validate`; the twirp room API stays internal. This resolves roadmap open question 3 (one port or two) without WebSocket proxying in let-go.
- **The signalling URL comes from the request, with an override.** `LIVEKIT_PUBLIC_URL` wins when set. Otherwise, if the request carries `x-forwarded-proto` (Caddy sets it), the URL is that scheme mapped to `ws`/`wss` plus the `host` header as-is, no port appended. Otherwise the current behaviour: `ws://<host without port>:<SFU port>`. let-go lowercases header names (`pkg/rt/http.go:261`), so these are plain map lookups.
- **The image is a copy of the CI-built binary.** CI already builds `bin/quickmeet` for the browser tests on a cached lg runtime. The Dockerfile is `alpine` plus `ca-certificates` plus one `COPY`; `.dockerignore` admits only the binary. Tradeoff accepted: the image cannot be built from a bare clone without lgx and Go. The alternative, building inside Docker, would rebuild the Go runtime in a layer on every dependency change.
- **Every build is static: `CGO_ENABLED=0`.** A native `lgx build` keeps Go's platform default, which links against glibc (`file bin/quickmeet` said "dynamically linked" on 2026-09-28), and that binary does not start on Alpine. lgx reads `CGO_ENABLED` and keys the runtime cache on it (`lgx/gobuild.lg:212`), so setting it once is enough. It goes in `.mise.toml` under `[env]` for local builds and at workflow level in both workflow files, so the test job's binary is the one the deploy job ships. Verified: the static build is 88 MB, "statically linked", and the browser suite passes against it. The one-time cost is a runtime rebuild (about a minute) on every machine and a new CI cache entry.
- **Deploy on push to master after the tests.** `test.yml` gains `workflow_call` and stops triggering on master pushes itself; `deploy.yml` runs on master pushes, calls the test workflow, then deploys. Pull requests and other branches keep running tests as today. `bin/quickmeet` is built by `lgx e2e` in the called workflow, so the deploy job needs to build it again, or receive it: the deploy job runs `lgx build` itself (a cache hit on the runtime, seconds) rather than passing artifacts between workflows.
- **`system/config` takes an env lookup function**, `(config)` calling `(config os/getenv)`, so tests pass a map and assert the single-port and range shapes without touching the process environment.
- **Container settings.** `LIVEKIT_BIND=0.0.0.0` so Caddy reaches the SFU over the overlay; the app already binds all interfaces. Database on a bind mount `/root/quickmeet-db:/app/db`, `DB_PATH=/app/db/quickmeet.db`, matching linkboard's pattern. `mem_limit: 256m` and `mem_reservation: 128m`: the binary peaks at about 120 MB in a two-person call (measured 2026-09-28 during `lgx e2e`). `stop_grace_period: 2s` because `lg` ignores SIGTERM (`docs/KNOWLEDGE.md`) and waiting the default 10 s buys nothing.
- **Secrets and variables at repository level**, like linkboard, not a GitHub Environment: variables `SERVER_IP`, `APP_DOMAIN`; secrets `SSH_PRIVATE_KEY`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
- **Staging is public with no room expiry, no participant cap and no rate limit.** Accepted for now; the sqlite file is disposable. These are the M2 and M6 items that follow.

### Container environment

| Variable | Value | Why |
|---|---|---|
| `PORT` | `8080` | app port, reached by Caddy over the overlay |
| `LIVEKIT_PORT` | `7880` | SFU signalling, reached by Caddy for `/rtc*` |
| `LIVEKIT_BIND` | `0.0.0.0` | Caddy is not on loopback |
| `LIVEKIT_RTC_TCP_PORT` | `7881` | ICE over TCP, published in host mode |
| `LIVEKIT_UDP_PORT` | `7882` | new: single multiplexed media port, published in host mode |
| `LIVEKIT_USE_EXTERNAL_IP` | `true` | advertise the VPS address |
| `LIVEKIT_LOG_LEVEL` | `info` | the first deploys need to be readable |
| `DB_PATH` | `/app/db/quickmeet.db` | on the bind mount |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | secrets | token signing |

`LIVEKIT_PUBLIC_URL` is not set in the container: the forwarded scheme and host header produce `wss://quickmeet.absky.dev`.

### Caddy block

```caddyfile
${APP_DOMAIN} {
  handle /rtc* {
    reverse_proxy {{upstreams 7880}}
  }
  handle {
    reverse_proxy {{upstreams 8080}}
  }
}
```

Compose interpolates `${APP_DOMAIN}`; `{{upstreams ...}}` is uncloud's Go template, rendered when containers start. `uc caddy config` shows the result.

### Known unknowns, to be learned on the first deploy

- How uncloud rolls a deploy when the old container holds the host-mode UDP port. It may stop the old container first or the deploy may fail on the port; either way a deploy drops any live call, acceptable for staging. If it fails, `x-pre_deploy` or a stop-then-start strategy is the fallback, not a design change.
- Whether STUN discovery inside the container yields the right address. `docs/KNOWLEDGE.md` notes the SFU picks the host's public IP as its node IP even locally; if candidates are wrong, `rtc.node_ip` set from a variable is the fix.
- Whether Caddy needs anything for the WebSocket upgrade on `/rtc`. linkboard's and unison's chat WebSockets work through it unchanged, so expected: nothing.

### Testing strategy

- Unit tests (`lgx test`): the three signalling URL cases in `routes_test.lg`; the config shapes in a new `system_test` case, single-port versus range and the public URL passthrough.
- The browser suite (`lgx e2e`) is unchanged and stays the regression net; it keeps using the port range.
- A local Docker run with the container's exact environment (minus the secrets, using the dev key) checks the image boots, serves `/` and answers `/rtc/validate` on the SFU port.
- The exit check is manual: two phones on different networks in a call at the domain.

---

## File Structure

**Create:**
- `Dockerfile`: alpine runtime image with the prebuilt binary.
- `.dockerignore`: everything except `bin/quickmeet`.
- `compose.yaml`: the uncloud service: build, `x-caddy`, host-mode ports, mount, environment, secrets, limits.
- `.github/workflows/deploy.yml`: tests via `workflow_call`, then build and `uc deploy`.

**Modify:**
- `src/quickmeet/system.lg`: env lookup parameter; `LIVEKIT_UDP_PORT` and `LIVEKIT_PUBLIC_URL`.
- `src/quickmeet/routes.lg`: `signalling-url` with override and forwarded scheme.
- `test/quickmeet/routes_test.lg`: signalling URL cases.
- `test/quickmeet/system_test.lg`: config shape cases.
- `.github/workflows/test.yml`: `workflow_call`, no direct run on master pushes.
- `.mise.toml`: add `uc`.
- `README.md`: new variables, deployment section.
- `docs/ROADMAP.md`: the reorder, M5 scope, open question 3 resolved.
- `docs/KNOWLEDGE.md`: deployment facts learned.

---

### Task 1: Signalling URL from the request

**Files:**
- Modify: `src/quickmeet/routes.lg`, `src/quickmeet/system.lg`
- Test: `test/quickmeet/routes_test.lg`

- [x] **Step 1: Write the failing tests**
  In `routes_test.lg`, add a `deftest signalling-url-follows-the-request` that builds handlers with three `livekit` maps and calls the token endpoint (create a room first, as `create-room-then-join` does). Give `call` an optional headers argument, or add a sibling helper, so a test can send extra headers.
  - Behind a proxy: headers `{"host" "quickmeet.absky.dev" "x-forwarded-proto" "https"}`, livekit `{:port 7880}` → `:url` is `"wss://quickmeet.absky.dev"`.
  - Behind a plain-http proxy: `x-forwarded-proto` `"http"` with host `"meet.example:8080"` → `"ws://meet.example:8080"` (host kept as-is, no SFU port appended).
  - Override: livekit map has `:public-url "wss://sfu.example"` and the request has `x-forwarded-proto` → `:url` is `"wss://sfu.example"`.
  The existing assertion `"ws://meet.example:7880"` in `create-room-then-join` stays as the no-proxy case.

- [x] **Step 2: Run the tests to see them fail**
  Run: `lgx test`
  Expected: the new deftest fails on the proxied and override cases; everything else passes.

- [x] **Step 3: Implement `signalling-url`**
  In `routes.lg`, `signalling-url` takes the request and the livekit map `{:port :public-url}`. Order: `:public-url` when non-blank; else when `(get-in req [:headers "x-forwarded-proto"])` is present, `(if (= "https" proto) "wss" "ws")` + `"://"` + the `host` header unchanged; else the current `ws://<host without port>:<port>`. Thread the map through `routes` and `handler` (the docstring of `handler` lists the map's keys; add `:public-url`). Update the comment: behind TLS the proxy tells us the scheme, and the host it exposes is where `/rtc` lives.

- [x] **Step 4: Run the tests to see them pass**
  Run: `lgx test`
  Expected: PASS, all deftests.

- [x] **Step 5: Commit**
  `git commit -m "Signalling URL from the forwarded scheme, with LIVEKIT_PUBLIC_URL override"`

> Deviation: the request host comes from `:server-addr`, not the `host` header. Go's server moves `Host` out of the header map and let-go passes it as `:server-addr` (`pkg/rt/http.go:275`), so the header lookup always fell back to `127.0.0.1` over real HTTP (already true before this plan) and the forwarded case gave `"wss://"`. Found in Task 3's local probe; fixed in `abe7132`, with a forwarded-proto assertion through the real server in `system_test.lg`. Unit tests now set `:server-addr`; the `host` header stays as a fallback.

---

### Task 2: Testable config with single-port UDP and the public URL

**Files:**
- Modify: `src/quickmeet/system.lg`
- Test: `test/quickmeet/system_test.lg`

- [x] **Step 1: Write the failing tests**
  In `system_test.lg`, add `deftest config-from-the-environment` that calls `(system/config lookup)` where `lookup` is a map turned into a function (`(fn [name] (get m name))`) and asserts on the returned map, no system started:
  - Empty map: `[:livekit/server :config :rtc]` has `:port_range_start 50000` and `:port_range_end 50100` and no `:udp_port`; `[:quickmeet.routes/handler :livekit :public-url]` is nil.
  - `{"LIVEKIT_UDP_PORT" "7882" "LIVEKIT_PUBLIC_URL" "wss://quickmeet.absky.dev" "LIVEKIT_BIND" "0.0.0.0"}`: `:rtc` has `:udp_port 7882` and neither range key; `:bind_addresses` is `["0.0.0.0"]`; the handler's `:public-url` is the given string.
  Keep `with-system` calling `(system/config)` with no argument.

- [x] **Step 2: Run the tests to see them fail**
  Run: `lgx test`
  Expected: the new deftest fails (arity, then missing keys).

- [x] **Step 3: Implement**
  In `system.lg`: `env`, `env-int`, `env-bool` take the lookup function as their first argument; `(config)` calls `(config os/getenv)`; `(config lookup)` builds the map. When `LIVEKIT_UDP_PORT` is set, `:rtc` gets `:udp_port` and omits the range keys (LiveKit ignores the range in that mode, and omitting it makes the intent visible in `uc` logs). Add `:public-url (env lookup "LIVEKIT_PUBLIC_URL" nil)` to the handler's livekit map. Update the header comment: single-port mode exists for containers, where one published UDP port is all a host-mode mapping needs.

- [x] **Step 4: Run the whole suite**
  Run: `lgx test && lgx e2e`
  Expected: PASS for both; the e2e suite still uses the range on ports 50200-50300.

- [x] **Step 5: Commit**
  `git commit -m "Config from a lookup function; LIVEKIT_UDP_PORT single-port media mode"`

---

### Task 3: Container image

**Files:**
- Create: `Dockerfile`, `.dockerignore`

- [x] **Step 1: Write the Dockerfile**
  `FROM alpine:3.22`, `RUN apk add --no-cache ca-certificates`, `WORKDIR /app`, `COPY bin/quickmeet /app/quickmeet`, `LABEL org.opencontainers.image.source=https://github.com/abogoyavlensky/quickmeet`, `CMD ["/app/quickmeet"]`. A comment at the top says the binary is built by `lgx build` outside the image, and why (see Design). No `EXPOSE` lines needed: uncloud publishes from the compose file.

- [x] **Step 2: Write `.dockerignore`**
  Two lines: `*` then `!bin/quickmeet`.

- [x] **Step 3: Build and run the image locally with the container's environment**
  Note: the `lgx` on `PATH` may be older than the pinned 0.4.2 (`lgx version`); if `mise exec` cannot resolve Go, run the pinned binary directly, `~/.local/share/mise/installs/lgx/0.4.2/lgx`.
  Run:
  ```
  CGO_ENABLED=0 lgx build && file bin/quickmeet | grep -q 'statically linked' && \
  docker build -t quickmeet:local . && mkdir -p /tmp/qm-db && \
  docker run --rm -d --name qm -p 8080:8080 -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
    -v /tmp/qm-db:/app/db \
    -e PORT=8080 -e LIVEKIT_PORT=7880 -e LIVEKIT_BIND=0.0.0.0 -e LIVEKIT_RTC_TCP_PORT=7881 \
    -e LIVEKIT_UDP_PORT=7882 -e LIVEKIT_USE_EXTERNAL_IP=true -e LIVEKIT_LOG_LEVEL=info \
    -e DB_PATH=/app/db/quickmeet.db quickmeet:local && sleep 5 && \
  curl -s -o /dev/null -w 'app %{http_code}\n' localhost:8080/ && \
  curl -s -o /dev/null -w 'sfu %{http_code}\n' localhost:7880/ && docker logs qm | tail -5
  ```
  Expected: `app 200`, `sfu 200`, the log shows the migration applied and the SFU started with `portUDP 7882` (LiveKit logs its ports at startup). Then a token round trip: `curl -s -X POST localhost:8080/api/rooms` and `curl -s -X POST -H 'x-forwarded-proto: https' -H 'host: quickmeet.absky.dev' localhost:8080/api/rooms/<id>/token -d '{}'` returns `"url":"wss://quickmeet.absky.dev"`. Stop with `docker rm -f qm`.
  If `docker` is unavailable on the executing machine, say so and rely on the CI build in Task 6.

- [x] **Step 4: Commit**
  `git commit -m "Dockerfile: alpine image around the lgx-built binary"`

> Deviation: Docker is not usable on the executing machine (the user is not in the `docker` group, no sudo), so the image was not built locally. Instead the static binary ran directly with the container's exact environment: app 200, SFU 200, SFU on UDP 7882 only (`rtc.portUDP {"Start":7882,"End":0}`), STUN found the external IP, the forwarded token URL is `wss://quickmeet.absky.dev`, `/rtc/validate` answers `success`. The image itself is first built by the CI smoke step (Task 5).

---

### Task 4: Compose file for uncloud

**Files:**
- Create: `compose.yaml`
- Modify: `.mise.toml`

- [x] **Step 1: Write `compose.yaml`**
  Model on `../unison/backend/compose.yaml` (branch `origin/migrate-to-uncloud`) and `../linkboard/compose.yaml`:
  - `x-context: unison-staging`.
  - One service `quickmeet-app` with `build: { context: ., platforms: [linux/amd64], cache_from: [type=gha], cache_to: [type=gha,mode=max] }`.
  - `x-caddy` inline, the block from Design.
  - `x-ports: ["7882:7882/udp@host", "7881:7881/tcp@host"]`. No http/https entries: uncloud forbids them together with `x-caddy`.
  - `volumes: ["/root/quickmeet-db:/app/db"]`.
  - `environment:` the table from Design, secrets as `secret://livekit_api_key` and `secret://livekit_api_secret`.
  - `mem_limit: 256m`, `mem_reservation: 128m`, `stop_grace_period: 2s`, each with a one-line comment giving the reason.
  - Top-level `secrets:` with `x-command: printenv LIVEKIT_API_KEY` and `printenv LIVEKIT_API_SECRET`.
  No `scale`, no `healthcheck`.

- [x] **Step 2: Add `uc` and the static-build setting to `.mise.toml`**
  Under `[tools]`: `uc = "0.20.0"`; under `[tool_alias]`: `uc = "github:psviderski/uncloud"`. Add an `[env]` table with `CGO_ENABLED = "0"` and a comment: the binary must be static to run on Alpine, and lgx keys its runtime cache on this variable.

- [x] **Step 3: Verify shape and interpolation**
  Run: `python3 -c "import yaml; d=yaml.safe_load(open('compose.yaml')); s=d['services']['quickmeet-app']; assert d['x-context']=='unison-staging'; assert s['x-ports']==['7882:7882/udp@host','7881:7881/tcp@host']; assert '/rtc*' in s['x-caddy'] and 'upstreams 7880' in s['x-caddy'] and 'upstreams 8080' in s['x-caddy']; assert set(d['secrets'])=={'livekit_api_key','livekit_api_secret'}; assert 'scale' not in s; print('ok')"`
  Expected: `ok`.
  Run: `mise install uc && mise exec -- uc version`
  Expected: version 0.20.0. If the `uc` install fails on this machine, note it; the CI step installs it too.
  Run: `APP_DOMAIN=quickmeet.absky.dev LIVEKIT_API_KEY=k LIVEKIT_API_SECRET=s mise exec -- uc deploy -f compose.yaml --dry-run quickmeet-app 2>&1 | head -40` only if `uc deploy --help` lists a dry-run flag; otherwise skip and rely on the first CI deploy.

- [x] **Step 4: Commit**
  `git commit -m "uncloud compose: one hostname via x-caddy, host-mode media ports"`

> Deviation: `uc` 0.20.0 has no dry-run flag, so instead `compose.yaml` went through uncloud v0.20.0's own `compose.LoadProject`, `ResolveSecrets`, `ServiceSpecFromCompose` and `ServiceSpec.Validate` in a throwaway Go program: accepted, `${APP_DOMAIN}` interpolated into the Caddy block, both ports `Mode: host`, 256/128 MiB, 2 s grace. The bind mount has `CreateHostPath: true`, so uncloud creates `/root/quickmeet-db` itself (Task 6 Step 3 is optional). `uc version` prints an ASCII banner rather than a plain version; `mise install uc` succeeded.

---

### Task 5: Workflows

**Files:**
- Modify: `.github/workflows/test.yml`
- Create: `.github/workflows/deploy.yml`

- [x] **Step 1: Make the test workflow callable**
  In `test.yml`, `on:` becomes `pull_request`, `workflow_call`, and `push` with `branches-ignore: [master]`. Add a workflow-level `env: CGO_ENABLED: "0"` with a one-line comment (static binary for the container image; see `.mise.toml`). Keep the `concurrency` group and every step. Add a comment: master pushes run these tests through `deploy.yml`.

- [x] **Step 2: Write `deploy.yml`**
  Model on `../linkboard/.github/workflows/deploy.yaml`:
  - `on: push: branches: [master]`.
  - Workflow-level `env: CGO_ENABLED: "0"` and `concurrency: { group: deploy-staging, cancel-in-progress: false }` so two master pushes deploy one after the other, never at once.
  - Job `test: uses: ./.github/workflows/test.yml`.
  - Job `deploy` with `runs-on: ubuntu-latest`, `needs: [test]`, `permissions: contents: read`, `timeout-minutes: 20`. Steps: `actions/checkout@v4`; `webfactory/ssh-agent@v0.10.0` with `secrets.SSH_PRIVATE_KEY`; `jdx/mise-action@v3` (installs lgx, Go, Node and `uc` from `.mise.toml`); the same `actions/cache@v4` block for `~/.cache/go-build`, `~/go/pkg/mod`, `~/.lgx/runtimes` as `test.yml`; `docker/setup-buildx-action@v4`; `crazy-max/ghaction-github-runtime@v4` (the two comments from linkboard explaining buildx and the cache token); `lgx build` followed by `file bin/quickmeet | grep -q 'statically linked'` so a dynamically linked binary fails here, not in the container; a container smoke step: `docker build -t quickmeet:ci .`, `docker run --rm -d --name qm -p 8080:8080 -e PORT=8080 -e LIVEKIT_BIND=0.0.0.0 -e LIVEKIT_UDP_PORT=7882 -e DB_PATH=/tmp/quickmeet.db quickmeet:ci`, a short wait, `curl -fsS localhost:8080/ > /dev/null`, and `docker rm -f qm` (this catches a binary that builds but does not start on Alpine, which an image build alone cannot); then
    ```
    env:
      APP_DOMAIN: ${{ vars.APP_DOMAIN }}
      LIVEKIT_API_KEY: ${{ secrets.LIVEKIT_API_KEY }}
      LIVEKIT_API_SECRET: ${{ secrets.LIVEKIT_API_SECRET }}
    run: uc --context unison-staging --connect root@${{ vars.SERVER_IP }} deploy -f compose.yaml --yes quickmeet-app
    ```

- [x] **Step 3: Cross-check the env contract and parse both files**
  Run: `python3 -c "import yaml,re; c=open('compose.yaml').read(); d=set(re.findall(r'printenv (\w+)',c))|set(re.findall(r'\\$\{(\w+)\}',c)); w=yaml.safe_load(open('.github/workflows/deploy.yml')); s=set(w['jobs']['deploy']['steps'][-1]['env']); assert d==s, (d,s); yaml.safe_load(open('.github/workflows/test.yml')); print('ok', sorted(d))"`
  Expected: `ok ['APP_DOMAIN', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']`.

- [x] **Step 4: Commit**
  `git commit -m "ci: deploy to staging on push to master"`

> Deviation: the runtime cache key gained a `static` segment (`runtimes-static-...`) in both workflows. lgx keys the runtime on `CGO_ENABLED`, and `actions/cache` never saves on an exact key hit, so under the old key the static runtime would have been rebuilt on every run and never cached.
> Deviation: the image smoke step runs before `setup-buildx-action`. With the docker-container builder `docker build` does not load the image into the local store, so `docker run quickmeet:ci` would fail. It also retries `curl` for up to 15 s instead of a fixed wait, and prints `docker logs` either way. `actionlint` passes on both files.

---

### Task 6: Provisioning checklist (user-driven, before merge)

No repo files change. Merging to master triggers the first deploy, so these come first.

- [ ] **Step 1: DNS**
  An A record `quickmeet.absky.dev` → the `unison-staging` server IP. Caddy obtains the certificate on first request; TCP 80 and 443 are already open for unison.

- [ ] **Step 2: Firewall**
  Inbound UDP 7882 and TCP 7881 must reach the machine. Check with the provider's firewall and `ufw status` if used.

- [ ] **Step 3: Database directory**
  On the server: `mkdir -p /root/quickmeet-db`. sqlite creates the file; the directory must exist.

- [ ] **Step 4: GitHub repository settings**
  Variables: `SERVER_IP`, `APP_DOMAIN=quickmeet.absky.dev`. Secrets: `SSH_PRIVATE_KEY` (the key whose public half is in the server's `authorized_keys`, same as unison), `LIVEKIT_API_KEY` (any short identifier), `LIVEKIT_API_SECRET` (32+ random characters, e.g. `openssl rand -hex 32`).

---

### Task 7: Documentation and roadmap

**Files:**
- Modify: `README.md`, `docs/ROADMAP.md`, `docs/KNOWLEDGE.md`

- [x] **Step 1: README**
  Configuration table: add `LIVEKIT_UDP_PORT` (unset by default; when set, all media over this one UDP port and the range is ignored) and `LIVEKIT_PUBLIC_URL` (unset; the signalling URL to hand browsers, otherwise derived from the request). Update `LIVEKIT_BIND`'s note. Add a "Deployment" section after "Browser tests": pushes to master run the tests then `.github/workflows/deploy.yml`, which builds the binary, wraps it in the `Dockerfile` and deploys `compose.yaml` to the uncloud cluster; one hostname, Caddy routes `/rtc*` to the SFU; media on UDP 7882 and TCP 7881 in host mode; the database at `/root/quickmeet-db` on the server; the variables and secrets from Task 6. Update the "Status" paragraph and the Layout listing (`Dockerfile`, `compose.yaml`).

- [x] **Step 2: ROADMAP**
  - Under M2, before the item list, one paragraph: after M1 the order changed; staging (M5, reduced) came first because the remaining M2 items need a real device, and say what the ngrok attempt showed.
  - M5: mark the staging part done with the date once deployed (the executor leaves a "pending first deploy" note if Task 8 is not yet run); list what remains (install guide for other boxes, macOS build, release tagging).
  - Open questions: replace the third with a resolved note: one hostname, path split at the reverse proxy, no proxying in the app.
  - M6 backups: note linkboard's Litestream sidecar plan applies unchanged.

- [x] **Step 3: KNOWLEDGE**
  Under "Deployment facts that shape v1", add: a native `lgx build` is dynamically linked against glibc and needs `CGO_ENABLED=0` to run on Alpine (lgx keys the runtime cache on that variable, so the first such build rebuilds the runtime); `rtc.udp_port` single-port mode and where it is chosen; `use_external_ip` with default STUN servers; uncloud `x-caddy` with `{{upstreams PORT}}` and host-mode `@host` ports, and that `x-caddy` excludes http/https `x-ports`; let-go lowercases request headers; measured memory (about 120 MB peak in a two-person call); `stop_grace_period` as the SIGTERM workaround. Bump the version table with `uc 0.20.0`.

- [x] **Step 4: Commit**
  `git commit -m "docs: staging deployment, roadmap reorder, deployment facts"`

---

### Task 8: First deploy and the smoke check

**Files:** none.

- [ ] **Step 1: Merge to master and watch the deploy**
  Run: `gh run watch` on the deploy run, or `gh run list --workflow deploy.yml`.
  Expected: tests green, `uc deploy` reports the service running.

- [ ] **Step 2: Inspect the generated Caddyfile and the service**
  Run: `uc --context unison-staging --connect root@<SERVER_IP> caddy config | grep -A8 quickmeet.absky.dev` and `uc ... ps`.
  Expected: the `/rtc*` handle with the SFU upstream on 7880 and the default handle on 8080; one container running.

- [ ] **Step 3: Probe over HTTPS**
  Run: `curl -fsS https://quickmeet.absky.dev/ | head -3` and `curl -s -X POST https://quickmeet.absky.dev/api/rooms`, then the token endpoint for that room.
  Expected: the landing page; a room id; `"url":"wss://quickmeet.absky.dev"`.
  Run: `curl -s "https://quickmeet.absky.dev/rtc/validate?access_token=<token>"`
  Expected: `success`.

- [ ] **Step 4: The exit check**
  Open the link on two phones on different networks (one on Wi-Fi, one on cellular), join from both. Expected: both see and hear each other. If media does not flow, `uc ... logs quickmeet-app` and check the ICE candidates the SFU advertises; the fallback is an explicit `rtc.node_ip` from a variable.

- [ ] **Step 5: Record the outcome**
  Update `docs/ROADMAP.md` M5 with the date, and add anything learned in Step 4 to `docs/KNOWLEDGE.md`. Commit: `git commit -m "docs: staging deployed"`.

---

## Execution summary

**Implemented** (branch `staging-on-uncloud`, each commit reviewed by codex; no must-fix findings):
- `adaf4f4` signalling URL: `LIVEKIT_PUBLIC_URL` override, then `x-forwarded-proto` + request host, then `ws://<host>:<port>`.
- `f55c88a` `system/config` takes a lookup function; `LIVEKIT_UDP_PORT` single-port mode; `:public-url` wired to the handler.
- `abe7132` fix: request host from `:server-addr` (see deviation under Task 1).
- `2470f24` `Dockerfile` + `.dockerignore`.
- `fe01d91` `compose.yaml` (x-caddy path split, host-mode 7882/udp and 7881/tcp, bind mount, secrets, limits); `.mise.toml` gains `uc` and `CGO_ENABLED=0`.
- `a24c0b1` `test.yml` callable and skipped on master pushes; `deploy.yml` tests, builds, checks static linking, smoke-tests the image, `uc deploy`.
- `6c49fb4` README deployment section and variables, ROADMAP reorder and resolved question, KNOWLEDGE deployment facts.

**Verification:** `lgx test` 9 tests / 60 assertions green; `lgx e2e` 3/3 green (one run had a 15 s timeout in `landing.spec.js` while a codex review loaded the machine; three reruns passed). The static binary ran with the container's exact environment: app and SFU 200, UDP on 7882 only, STUN found the public IP, forwarded token URL `wss://quickmeet.absky.dev`, `/rtc/validate` `success`. `compose.yaml` passed uncloud v0.20.0's own loader and `ServiceSpec.Validate`; `actionlint` passes on both workflows. Not verified here: the Docker image build (no Docker access for this user) and anything on the cluster; the first CI run covers the former, Task 8 the latter.

**Issues encountered:** the plan's "host header" assumption was wrong in real HTTP (Go strips `Host`; let-go exposes `:server-addr`), and the existing no-proxy path had always fallen back to `127.0.0.1` because of it. Unit tests built request maps by hand and could not see it; the local run with the container environment did.

**Deviations:**
- Task 1: host from `:server-addr`, header as fallback; a forwarded-proto assertion through the real server in `system_test.lg`.
- Task 3: no local Docker; the binary was probed directly with the container environment instead.
- Task 4: no `uc` dry run exists; validated through uncloud's compose loader instead. uncloud creates `/root/quickmeet-db` itself (Task 6 Step 3 optional).
- Task 5: CI runtime cache key gained `static` so the static runtime actually gets cached; the image smoke step runs before buildx setup so `docker run` can see the image; `curl` retries instead of a fixed sleep.
- Environment: mise cannot install Go 1.27 on this machine (`go1.27.1` 404), and `lgx` on `PATH` is 0.2.0; ran the pinned `lgx` 0.4.2 binary with the system Go 1.26.7.

**What the plan could have specified better:** verify request-shape assumptions (headers, host) against a real HTTP round trip, not a hand-built request map, and check how `actions/cache` and buildx drivers behave when a plan changes a cache-keyed build variable or adds a `docker run` after buildx setup.
