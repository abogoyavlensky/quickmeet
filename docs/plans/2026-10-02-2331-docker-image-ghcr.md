# Official Docker Image on ghcr.io Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A version tag publishes a multi-arch image `ghcr.io/abogoyavlensky/quickmeet` alongside the release tarballs, and the README's "Host it yourself" section offers a `docker run` quickstart (behind the operator's own HTTPS proxy) next to the binary + systemd install; the install guide adds an optional Docker Compose setup with Caddy for a server that has no proxy yet.

**Tech Stack:** Docker (Alpine runtime image around the static `bin/quickmeet`), GitHub Actions (`release.yml`, `test.yml`, `deploy.yml`), ghcr.io, Docker Compose, Caddy 2, lgx tasks.

---

## Design

### What exists

- `Dockerfile`: Alpine 3.22 plus a prebuilt static `bin/quickmeet`
  (`CGO_ENABLED=0`, from `.mise.toml`). Nothing is compiled inside the image;
  building lg's Go runtime in a layer would redo it on every dependency
  change. The `.dockerignore` lets only `bin/quickmeet` in.
- `deploy.yml` (master): builds the binary, smoke-tests the image inline,
  deploys to staging with uncloud (`compose.yaml` at the root, which builds
  the image itself and sets every environment variable explicitly).
- `release.yml` (`v*` tag): one linux/amd64 static tarball + `.sha256` on a
  GitHub release. No image. No tag has been pushed yet.

The sibling project `../pagelet` already publishes to ghcr.io. Its
`release.yml` is the model: a native build per architecture, the same
smoke test, a push of `IMAGE:X.Y.Z-<arch>` per architecture, then one job
that joins them with `docker buildx imagetools create` into
`X.Y.Z`, `X.Y` and `latest`, and creates the GitHub release last so a
release never exists without its image.

### What is built

1. **The image carries container defaults.** `ENV` in the `Dockerfile`:
   `DB_PATH=/app/data/quickmeet.db`, `LIVEKIT_BIND=0.0.0.0`,
   `LIVEKIT_UDP_PORT=7882`, plus `RUN mkdir -p /app/data`, `EXPOSE 8080
   7880 7881 7882/udp`, and the OCI `description` and `source` labels.
   `HOST` stays unset (every interface, which a container behind a proxy
   needs). Because `LIVEKIT_BIND` is off loopback, the image refuses to
   start with the development secret: `docker run` without
   `LIVEKIT_API_SECRET` fails with the app's own message, which is the
   right behaviour for anything published. `LIVEKIT_USE_EXTERNAL_IP` is
   *not* an image default (it would break a laptop run); the quickstart
   sets it. Staging's `compose.yaml` sets all of these itself, so it is
   unaffected (it keeps `DB_PATH=/app/db/quickmeet.db`).

2. **One smoke script, `scripts/docker-smoke.sh`** (pagelet's shape):
   checks `bin/quickmeet` is statically linked, builds `quickmeet:local`,
   runs it with a throwaway 32+ char secret and `DB_PATH=/tmp/...`, curls
   `/` with `--retry-all-errors`, prints `docker ps -a` and the logs,
   removes the container, exits with curl's status. The inline smoke step
   in `deploy.yml` is replaced by this script; `test.yml` runs it too (so
   PRs prove the image starts), and a new lgx task `docker` builds then
   runs it for local use.

3. **A `docker run` quickstart, no bundled proxy.** Like pagelet, the
   quickstart is one `docker run`; HTTPS is the operator's own reverse
   proxy, as it already is in the systemd install. Many Docker
   self-hosters already run Traefik, nginx or Caddy on 80/443, and a
   bundled proxy would collide with it:
   ```sh
   docker run -d --name quickmeet --restart unless-stopped \
     -p 127.0.0.1:8080:8080 -p 127.0.0.1:7880:7880 \
     -p 7881:7881 -p 7882:7882/udp \
     -v quickmeet-data:/app/data \
     -e LIVEKIT_USE_EXTERNAL_IP=true \
     -e LIVEKIT_API_SECRET=$(openssl rand -hex 32) \
     -e ALLOWED_EMAILS=you@example.com \
     ghcr.io/abogoyavlensky/quickmeet:latest
   ```
   - 8080 (app) and 7880 (SFU signalling) are published on loopback
     only, the same addresses the systemd install uses, so the existing
     `deploy/Caddyfile` (or any proxy routing `/rtc*` to 7880 and the
     rest to 8080) works unchanged, and only the proxy on the box can
     reach the app: the forwarded client address the rate limits trust
     stays honest.
   - 7881/tcp and 7882/udp are published on every interface; media goes
     through Docker's port mapping with the STUN-found public address
     advertised, the arrangement staging already runs with uncloud's
     host-mode ports.
   - A secret generated inline is fine: it only signs short-lived join
     tokens and the SFU's webhooks inside the process; nothing stored
     depends on it (the push keys live in the database). A new one on
     every `docker run` just means joins in flight retry.
   - A named volume `quickmeet-data` keeps the database across updates.
     The image has no `sqlite3`, so backups and the password-reset
     recipe in INSTALL.md stop the container, `docker cp` the file out
     (works on a stopped container), and start it again.

4. **Optional: Docker Compose with Caddy, in `deploy/docker/`**, for a
   server with nothing on 80/443 yet. Documented in INSTALL.md only, not
   in the README.
   - `compose.yaml`: service `quickmeet` from
     `ghcr.io/abogoyavlensky/quickmeet:${QUICKMEET_VERSION:-latest}`,
     `restart: unless-stopped`, `stop_grace_period: 10s`, publishes only
     `7881:7881/tcp` and `7882:7882/udp`, bind-mounts `./data:/app/data`,
     sets `LIVEKIT_USE_EXTERNAL_IP=true`, `LIVEKIT_LOG_LEVEL=info`,
     `LIVEKIT_API_KEY=quickmeet`,
     `LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET:?set LIVEKIT_API_SECRET in .env}`
     and `ALLOWED_EMAILS=${ALLOWED_EMAILS:-}`. Service `caddy` (`caddy:2`,
     `restart: unless-stopped`) publishes 80, 443 and 443/udp, mounts
     `./Caddyfile` read-only and named volumes for `/data` and `/config`,
     gets `QUICKMEET_DOMAIN=${QUICKMEET_DOMAIN:?set QUICKMEET_DOMAIN in .env}`.
   - `Caddyfile`: `{$QUICKMEET_DOMAIN}` with `/rtc*` to `quickmeet:7880`
     and everything else to `quickmeet:8080`, the same split as
     `deploy/Caddyfile`.
   - `.env.example`: `QUICKMEET_DOMAIN`, `ALLOWED_EMAILS`,
     `LIVEKIT_API_SECRET`, optional `QUICKMEET_VERSION`, each commented.

   8080 and 7880 are not published at all: Caddy reaches them over the
   compose network, so only Caddy can reach the app. A bind mount
   (`./data`) so the database is a plain file next to the compose file
   (`sqlite3 data/quickmeet.db` on the host for backups).
   `QUICKMEET_VERSION` pins a release and lets CI run the file against
   the image it just built.

   **CI runs it.** `scripts/docker-compose-smoke.sh`, in `test.yml` after
   the image smoke: exports `QUICKMEET_VERSION=local`,
   `QUICKMEET_DOMAIN=localhost` (Caddy issues itself a local
   certificate) and a throwaway secret at the top so `up`, `logs` and the
   teardown all see them; tags `quickmeet:local` as
   `ghcr.io/abogoyavlensky/quickmeet:local`; copies `compose.yaml` and
   `Caddyfile` into `mktemp -d` (so `./data` never lands in the repo);
   `docker compose up -d`; `curl -fsSk --retry 30 --retry-all-errors
   --retry-delay 1 https://localhost/`; prints `ps -a` and logs; a trap
   runs `docker compose down -v` on any exit. Not part of `lgx docker`:
   it binds 80 and 443, which a laptop often has taken.

5. **`release.yml` publishes the image, for amd64 and arm64.**
   - Trigger tightened to `v[0-9]+.[0-9]+.[0-9]+` (the `X.Y` tag and
     `latest` assume a plain version; a pre-release must not become
     `latest`), plus `workflow_dispatch` as a dry run: tests, both builds
     and smoke tests, nothing pushed, no release.
   - `build` job, matrix `amd64` on `ubuntu-latest`, `arm64` on
     `ubuntu-24.04-arm` (native: proven in pagelet; avoids depending on
     lgx cross-building its runtime). The binary is static, so the runner's
     glibc does not matter. Runtime cache keys: amd64 keeps
     `runtimes-static-Linux-…` (shared with test.yml), arm64 uses
     `runtimes-static-arm64-Linux-…` so neither restores the other's lg.
     Steps: unit tests on arm64 only (the test job covers amd64),
     `lgx build`, `scripts/docker-smoke.sh`, pack the tarball (today's
     layout and contents, named `quickmeet-vX.Y.Z-linux-<arch>`, with its
     `.sha256`), upload it as an artifact; on a tag push only, log in to
     ghcr.io with `GITHUB_TOKEN` and push `IMAGE:X.Y.Z-<arch>`.
   - `publish` job (tag push only, `contents: write`, `packages: write`):
     download the artifacts, `imagetools create` `X.Y.Z`, `X.Y`, `latest`
     from the two arch images and inspect the result, then
     `gh release create` with all four files.
   - Permissions: top-level `contents: read`; `packages: write` only where
     pushing.
   - Publishing happens only on a pushed tag: the ghcr.io login and push
     steps and the whole `publish` job are gated on
     `github.event_name == 'push' && github.ref_type == 'tag'`. Master
     pushes (`deploy.yml`) and PRs (`test.yml`) never push an image or
     create a release; a manual dispatch builds and smoke-tests only.

   arm64 widens the release from the 2026-09-30 decision "linux/amd64
   only". It is cheap here (static Go, a native runner, the same smoke
   test) and many small VPSes are ARM. It is the decision to veto if
   unwanted; dropping it means a one-entry matrix and no manifest step
   beyond `imagetools create` over one image.

6. **Docs.**
   - `README.md` "Host it yourself": two ways, Docker first (the
     snippet above, then: put an HTTPS reverse proxy in front that sends
     `/rtc*` to 7880 and the rest to 8080, e.g. `deploy/Caddyfile`; open
     7881/tcp and 7882/udp; sign up with the allowed address), then the
     binary + systemd guide. Drop "Linux x86-64" in favour of "x86-64 or
     ARM64" and the "no published releases yet" paragraph (the image and
     tarballs come with the first tag; see Task 6).
   - `docs/INSTALL.md`: a "Run with Docker" section before "1. Get the
     binary": the `docker run` command and what each flag is for, then
     which steps of the guide still apply (4. firewall, 5. Caddy with
     `deploy/Caddyfile` as is, 7. first account, 8. check), logs
     (`docker logs quickmeet`, expect `found external IP via STUN`),
     upgrading (`docker pull`, `docker rm -f`, the same `docker run`;
     pin a version tag instead of `latest`), backups (stop, `docker cp
     quickmeet:/app/data/quickmeet.db …`, start), and the note that
     Docker's published ports bypass ufw. Then a subsection "Docker
     Compose with Caddy" for a server with no proxy yet: fetch the two
     files from `deploy/docker/` on master, write `.env` from the
     example, `docker compose up -d`, open 80/443 too; upgrading
     (`docker compose pull && docker compose up -d`), backups (`sqlite3
     data/quickmeet.db ".backup …"` on the host). The release-download snippet
     gets an `ARCH` variable. The rest stays the systemd path.
   - `docs/DEPLOYMENT.md`, `docs/DEVELOPMENT.md` (file map:
     `scripts/docker-*.sh`, `deploy/docker/`, `lgx docker`), `docs/ROADMAP.md` (an
     "After v1" entry for the image and arm64), and `docs/KNOWLEDGE.md`
     (facts the work verifies, e.g. the arm64 static build).

### One-time manual step

The first push creates the ghcr.io package as private. The owner must make
it public once (package settings → Change visibility) and check it is
linked to the repository (the `source` label does that). Documented in
`docs/DEPLOYMENT.md`; the executor cannot do it.

### Testing

No app code changes, so no unit or e2e tests change. Verification is CI:
the PR's `test.yml` run proves the image starts with its defaults and
the compose file serves a page over Caddy; the `release.yml` dry run (dispatch, after
merge, since dispatch needs the workflow on the default branch) proves
both architectures build and smoke-test. The agent cannot reach the
docker socket on the dev machine (`docs/KNOWLEDGE.md`), so local checks
are limited to `docker compose config` if the CLI is present,
shellcheck and YAML parsing.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `Dockerfile` | modify | container defaults, data dir, ports, labels |
| `scripts/docker-smoke.sh` | create | static check, build `quickmeet:local`, start, curl `/` |
| `scripts/docker-compose-smoke.sh` | create | run `deploy/docker` against `quickmeet:local`, curl via Caddy |
| `deploy/docker/compose.yaml` | create | optional stack: quickmeet + Caddy |
| `deploy/docker/Caddyfile` | create | TLS and the `/rtc*` split, domain from env |
| `deploy/docker/.env.example` | create | the settings, commented |
| `lgx.edn` | modify | `docker` task |
| `.github/workflows/test.yml` | modify | both smoke scripts after the browser tests |
| `.github/workflows/deploy.yml` | modify | inline smoke replaced by the script |
| `.github/workflows/release.yml` | rewrite | per-arch build, ghcr push, manifest, release |
| `README.md`, `docs/INSTALL.md`, `docs/DEPLOYMENT.md`, `docs/DEVELOPMENT.md`, `docs/ROADMAP.md`, `docs/KNOWLEDGE.md` | modify | documentation |

## Tasks

Work on a branch: `git checkout -b docker-image`.

### Task 1: Image defaults and the smoke script

**Files:**
- Modify: `Dockerfile`
- Create: `scripts/docker-smoke.sh`
- Modify: `lgx.edn`, `.github/workflows/deploy.yml`

- [ ] **Step 1: Dockerfile.** Add the `ENV` defaults, `mkdir -p
  /app/data`, `EXPOSE`, and labels (`source`, `description` "Self-hosted
  1-to-1 video calls from a single binary"; no `licenses` label, the repo
  has no LICENSE file). Extend the header comment: the same file makes
  the published image (release.yml), and why `LIVEKIT_USE_EXTERNAL_IP`
  is left to the `docker run` command.

- [ ] **Step 2: `scripts/docker-smoke.sh`** (executable, `set -u`),
  modelled on `../pagelet/scripts/docker-smoke.sh` and today's inline
  step in `deploy.yml`: `file bin/quickmeet | grep -q 'statically
  linked'` (fail with a message otherwise), `docker build -t
  quickmeet:local .`, remove a leftover `quickmeet-smoke`, run with
  `-p 8080:8080 -e LIVEKIT_API_SECRET=ci-smoke-test-secret-0123456789abcdef
  -e DB_PATH=/tmp/quickmeet.db` (the image supplies bind and UDP port, so
  this also proves the defaults), curl `localhost:8080/` with
  `--retry 15 --retry-all-errors --retry-delay 1`, print ps and logs,
  remove, exit with curl's status. Keep the comments about the port
  proxy reset and no `--rm`.

- [ ] **Step 3: lgx task.** In `lgx.edn` `:tasks`:
  ```clojure
  docker
  {:doc "Build the binary, then the image, and smoke-test it"
   :do [{:task lgx:build}
        {:sh "scripts/docker-smoke.sh"}]}
  ```

- [ ] **Step 4: deploy.yml.** Replace the "Build the binary" static
  check and the inline smoke step with `lgx build` followed by
  `scripts/docker-smoke.sh` (the script does the static check). Keep the
  comment that it must run before buildx is set up.

- [ ] **Step 5: Check.** `bash -n scripts/docker-smoke.sh`;
  `shellcheck scripts/docker-smoke.sh` if installed; `lgx tasks` (or
  `lgx --help`) lists `docker`. If docker is reachable, `lgx docker`
  prints the page and exits 0.

- [ ] **Step 6: Commit** `Docker image defaults and one smoke script`

### Task 2: The optional Docker Compose files

**Files:**
- Create: `deploy/docker/compose.yaml`, `deploy/docker/Caddyfile`, `deploy/docker/.env.example`

- [ ] **Step 1: Write the three files** as in Design §4. Comment them the
  way `deploy/quickmeet.env.example` and the root `compose.yaml` are
  commented: why only 7881/7882 are published, why `./data`, what
  `QUICKMEET_VERSION` does.

- [ ] **Step 2: Check.** If `docker compose` is available:
  `cd deploy/docker && QUICKMEET_DOMAIN=x LIVEKIT_API_SECRET=y docker
  compose config -q` exits 0, and without `LIVEKIT_API_SECRET` it fails
  with the message. Otherwise
  `python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' deploy/docker/compose.yaml`.

- [ ] **Step 3: Commit** `Optional Docker Compose setup with Caddy`

### Task 3: CI smoke-tests the image and the compose setup

**Files:**
- Create: `scripts/docker-compose-smoke.sh`
- Modify: `.github/workflows/test.yml`

- [ ] **Step 1: `scripts/docker-compose-smoke.sh`** (executable,
  `set -u`) as in Design §4.

- [ ] **Step 2: test.yml.** After "Browser tests" (which built the
  static `bin/quickmeet`), add "Smoke-test the image" running
  `scripts/docker-smoke.sh` and "Run the Docker Compose setup" running
  `scripts/docker-compose-smoke.sh`, a one-line comment each.

- [ ] **Step 3: Check.** `bash -n` and shellcheck both scripts.

- [ ] **Step 4: Commit** `Smoke-test the image and the compose setup in CI`

- [ ] **Step 5: Push the branch and open a draft PR** so `test.yml` runs
  both scripts on a real runner. Fix until green before moving on. If
  something fails, read the printed logs before changing anything.

### Task 4: release.yml publishes the image

**Files:**
- Modify (rewrite): `.github/workflows/release.yml`

- [ ] **Step 1: Write the workflow** as in Design §5, following
  `../pagelet/.github/workflows/release.yml` closely (concurrency group
  `release-${{ github.ref }}` without cancel, `env.IMAGE:
  ghcr.io/abogoyavlensky/quickmeet`, `env.CGO_ENABLED: "0"`). Matrix:
  ```yaml
  - arch: amd64
    runner: ubuntu-latest
    cache: runtimes-static-Linux
  - arch: arm64
    runner: ubuntu-24.04-arm
    cache: runtimes-static-arm64-Linux
  ```
  Cache key `${{ matrix.cache }}-${{ hashFiles('lgx.edn', 'webpush/**') }}`,
  restore-keys `${{ matrix.cache }}-`. Note: `runtimes-static-Linux-`
  is not a prefix of `runtimes-static-arm64-Linux-`, and vice versa.
  Pack step builds `quickmeet-${GITHUB_REF_NAME}-linux-${ARCH}` with the
  same five files as today, `.tar.gz` and `.tar.gz.sha256`. On a dispatch
  run `GITHUB_REF_NAME` is a branch name that may contain `/`, so the
  version part of the name is `${GITHUB_REF_NAME//\//-}`.
  Update the header comment (what a tag publishes, what a dispatch does).

- [ ] **Step 2: Check.** Parse the YAML (python yaml). If `actionlint`
  is installed, run it on `.github/workflows/`.

- [ ] **Step 3: Commit** `Publish a multi-arch image to ghcr.io on release`

### Task 5: Documentation

**Files:**
- Modify: `README.md`, `docs/INSTALL.md`, `docs/DEPLOYMENT.md`, `docs/DEVELOPMENT.md`, `docs/ROADMAP.md`, `docs/KNOWLEDGE.md`

Use /writing-clearly; match the existing docs' plain, short-sentence voice.

- [ ] **Step 1: README "Host it yourself"** as in Design §6, with the
  `docker run` snippet from Design §3. Keep it short; details live in
  INSTALL.md. Link to the INSTALL Docker section and the binary path.

- [ ] **Step 2: INSTALL.md** "Run with Docker" section and the `ARCH`
  variable in the release download, per Design §6. Update the intro
  ("linux/amd64" → amd64 or arm64; two ways to install) and the dated
  note: the Docker path is checked by CI on a runner, not yet on a
  fresh server.

- [ ] **Step 3: DEPLOYMENT.md** releases paragraph: what a tag
  publishes (two tarballs, the image tags), the dispatch dry run, the
  one-time package visibility step. **DEVELOPMENT.md** file map:
  `scripts/docker-smoke.sh`, the `docker` task.
  **ROADMAP.md**: an "After v1" entry (image + arm64, plan path).
  **KNOWLEDGE.md**: facts verified while doing this (CI results, arm64
  build time, anything surprising).

- [ ] **Step 4: Check** every relative link added resolves
  (`ls` the targets) and anchors match headings.

- [ ] **Step 5: Commit** `Docker quickstart in the README and the install guide`

### Task 6: Finish

- [ ] **Step 1:** Mark this plan `**Status: completed <date>**` under
  the header, commit, push, and get the PR's checks green.
- [ ] **Step 2:** Tell the user: after merge, (a) run `release.yml` by
  hand on master as a dry run, (b) push the first tag (e.g. `v0.1.0`)
  so the image and tarballs exist, since the README now points at them,
  (c) make the ghcr.io package public once. Tagging and the visibility
  change are the owner's calls; do not do them unasked. (d) CI only
  proves the image starts; after the first release, run the quickstart
  on a real server behind its proxy and run `lgx smoke` against it
  (`QM_URL=https://…`) to prove signalling and media through Docker's
  published ports.
