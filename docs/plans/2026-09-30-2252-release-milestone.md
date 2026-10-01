# Release Milestone (M5 + M6) Implementation Plan

**Status: completed** (2026-10-01), except Task 12 Step 7, which is the user's: pushing the first tag.

> **Review checkpoints:** codex reviewed Tasks 1 to 5; it then hit its usage limit (until 02:37 on 2026-10-01), and Tasks 6 to 10 were reviewed by a Claude subagent with the same brief. Every must-fix or should-fix finding went in as its own commit.

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make quickmeet installable and safe to run by someone other than its author: a tagged linux/amd64 release, an install guide, rate limits, a clean shutdown, and the remaining hardening.

**Tech Stack:** let-go 1.13.0 via lgx 0.4.2, embedded livekit-server 1.13.7, sqlite, integrant, Playwright (headless Chromium), GitHub Actions, Caddy, systemd.

---

## Design

### Scope

This plan merges what was left of ROADMAP M5 (deployment) with M6 (hardening) into one milestone, "M5: release". Decided with the user on 2026-09-30:

- linux/amd64 only. macOS builds leave v1.
- Backups (Litestream) leave the milestone and become a backlog entry, as the first commit.
- Everything else from M5 and M6 stays: install guide, production defaults, release builds, a smoke check, rate limits, sign-in timing, room-id check, graceful shutdown.

### What was measured before planning (2026-09-30)

These facts shape the design. Task 11 records them in `docs/KNOWLEDGE.md`.

- **A call survives a hard kill of the server.** Two headless Chromiums in a call against the local binary, server killed with SIGKILL and restarted after a delay: a 5 s outage had media back 18 s after the kill; a 30 s outage, 40 s after; at 60 s both clients gave up 48 s after the kill and returned to the lobby with "Connection lost. Join again." The clients reconnect on their own (`livekit-client` full reconnect); nobody clicks anything.
- **The built binary already exits on SIGTERM.** `bin/quickmeet` run directly and sent SIGTERM exits at once: Go's default action. The note "lg ignores SIGTERM" in `compose.yaml` and KNOWLEDGE came from the M0 spike under `lgx run` and was never re-checked against the binary. Whether it also exits as PID 1 in the container is checked in Task 7.
- **`ig/halt!` on the SFU would hang a shutdown.** `livekit.integrant`'s `halt-key!` calls `(lk/stop! server false)`, and `LivekitServer.Stop(false)` loops every 5 s until `roomManager.HasParticipants()` is false (`livekit-server@v1.13.7/pkg/service/server.go:358`). With a call on, it never returns. `Stop(true)` closes every room with `RoomCloseReasonServerShutdown` (`pkg/service/roommanager.go:242`), which tells clients to leave instead of letting them reconnect.
- **let-go has what the work needs.** `syscall/signal-notify` takes a channel and signal numbers (`pkg/rt/syscall_linux.go:599`; `syscall/SIGTERM`, `syscall/SIGINT` are defined; on non-linux it is an "unsupported" stub). `(http/stop server)` drains in-flight requests for up to 5 s and is idempotent; `http/wait` returns once it has. `(System/currentTimeMillis)` is the clock. The request map carries `:remote-addr`. `swap!` on an atom needs no dynamic binding.
- **Room ids are already unguessable**: 12 hex characters of a crypto-random v4 UUID, 48 bits, each independent of every other (`src/quickmeet/routes.lg:52`, `src/quickmeet/id.lg`, tested in `routes_test.lg`). That M6 item is a note in the roadmap, not work.

### Decisions

1. **Shutdown never stops the SFU.** On SIGTERM or SIGINT the process stops the http server (draining in-flight requests), closes open call-history rows, closes the database and exits 0. The SFU is left running until the process exits, so clients see a dropped connection and reconnect to the next process, exactly as they do after a hard kill. The roadmap's "wait for the SFU to drain participants" is dropped: it would either hang (graceful) or end every call (forced). The signalling WebSocket is on LiveKit's own port, so stopping the app's http server does not touch a call.

2. **Stale calls are closed at startup too.** When the process starts, the embedded SFU has no rooms, so any call without `ended_at` is left over from a process that died. The db component closes them at `datetime('now')` right after migrating. This covers SIGKILL, OOM and crashes, which a signal handler cannot. Today such a call stays open until the next join in that room, which can be days later and gives a wrong duration. After a long outage the end time is overstated by the outage; accepted. The shutdown path uses the same function, so a clean stop records the true end time.

3. **Rate limits: in-memory fixed windows, no new dependency.** A new namespace holds an atom of `{key [window-start-ms count]}`. No dynamic bindings and no request-time `sql/format`, so the open backlog item `letgo-http-handlers-share-dynamic-bindings` is not reopened. State is lost on restart, which is fine for one box. Limits:

   | Bucket | Key | Limit |
   |---|---|---|
   | `:signin` | client IP | 10 per minute |
   | `:signup` | client IP | 10 per hour |
   | `:create-room` | user id | 60 per hour |

   Over the limit is `429` with a `Retry-After` header (seconds) and `{"error": "Too many attempts. Try again later."}`. Every attempt counts, successful or not. Sign-in is limited per IP only: a per-account limit would let anyone lock the operator out by hammering their address.

4. **Client IP.** The last entry of `x-forwarded-for` when the header is present (the nearest proxy appended it), otherwise `:remote-addr` without its port. A client that reaches the app port directly can forge the header, so the guide binds the app to loopback (decision 6).

5. **`RATE_LIMIT` switches the limits off.** Default on. The browser suite signs up dozens of accounts from 127.0.0.1 in one run and would trip the sign-up limit, so `e2e/playwright.config.js` sets `RATE_LIMIT=false`. Limits are constants in code, not configuration.

6. **`HOST` sets the app's bind address.** Default empty, meaning all interfaces as today (the container needs that: Caddy reaches it over the overlay network). The install guide sets `HOST=127.0.0.1` because Caddy is on the same box. The SFU's webhook posts to `127.0.0.1:<PORT>`, so the only supported values are empty and `127.0.0.1`; the guide says so.

7. **Production defaults: keep the development defaults, refuse the one dangerous combination.** `system/config` throws when `LIVEKIT_API_SECRET` is the development secret and the instance is visibly not a laptop: `LIVEKIT_BIND` is not `127.0.0.1` or `localhost`, or `LIVEKIT_USE_EXTERNAL_IP` is true, or `LIVEKIT_PUBLIC_URL` is set. With the well-known secret anyone can mint a join token or admin token for the SFU. Everything else the roadmap listed under "production defaults" (bind address, external IP, log level) is set by the guide's environment file, not changed in code. The image smoke test in `deploy.yml` runs with `LIVEKIT_BIND=0.0.0.0` and no secret, so it gets one.

8. **Sign-in timing.** For an unknown address, `auth/sign-in!` compares the given password against a fixed bcrypt hash of cost 10, so both paths cost one bcrypt comparison. The hash is a string literal in `password.lg`: a top-level `(hash ...)` would run at AOT compile time.

9. **Releases.** A new workflow on tags `v*` runs the tests, builds with `CGO_ENABLED=0`, checks the binary is static, and publishes a GitHub release with `quickmeet-<tag>-linux-amd64.tar.gz` (the binary plus the `deploy/` files) and its `.sha256`. No container image is published and the binary gets no `--version` flag. Pushing the first tag is left to the user: it publishes.

10. **Smoke check: a script, not a CI step.** `e2e/smoke.mjs` drives two headless Chromiums through a call against any deployed instance and watches it for a given time, printing every state change. It is the post-install check in the guide and the tool that measures what a deploy does to a live call. It is not wired into `deploy.yml`: that would need an account's password as a repository secret and that account in `ALLOWED_EMAILS`. Easy to add later if wanted.

11. **Install guide** is `docs/INSTALL.md`, with the files it installs kept in `deploy/` so the release tarball can ship them: a systemd unit, a Caddyfile and an example environment file. The guide cannot be proven on a fresh box from here; Task 9 validates the unit and the Caddyfile with their own tools and says plainly that a real install is the user's check.

### Error handling

- Rate limit: 429 as above. The account pages already show the server's `error` string; the landing page already shows the status on a failed room creation.
- Config guard: `config` throws `ex-info` whose message names the variable and how to generate a secret (`openssl rand -hex 32`). The process prints it and exits non-zero before anything starts.
- Shutdown: if `shutdown!` throws, `-main` still exits, with status 1.

### Testing

- Unit: the limiter as a pure function with an injected clock; routes answer 429 through a stub limiter; config guard cases; stale-call closing over a throwaway database; timing path by checking an unknown address still answers `:invalid`.
- System: `shutdown!` on a real system closes open calls and the database and leaves the SFU running.
- Process: SIGTERM against the built binary and against the container exits 0 quickly.
- End to end: the smoke script against the local binary through a kill and restart, and against staging during the merge deploy.

## File Structure

- Create `docs/backlog/sqlite-backups.md`: the backlog entry (own commit).
- Create `src/quickmeet/ratelimit.lg`: the limiter. One responsibility: decide whether a key may act now.
- Create `test/quickmeet/ratelimit_test.lg`.
- Modify `src/quickmeet/routes.lg`: `client-ip`, the three limit checks, the 429 response; `init-key` builds the limiter.
- Modify `src/quickmeet/system.lg`: `HOST`, `RATE_LIMIT`, the dev-secret guard, `shutdown!`.
- Modify `src/quickmeet/password.lg`, `src/quickmeet/auth.lg`: the dummy comparison.
- Modify `src/quickmeet/db.lg`: `close-open-calls!`, called from `init-key`.
- Modify `main.lg`: signal handling and exit.
- Modify tests: `routes_test.lg`, `auth_test.lg`, `db_test.lg` or `history_test.lg`, `system_test.lg`.
- Create `e2e/smoke.mjs`; modify `lgx.edn` (task `smoke`) and `e2e/playwright.config.js` (`RATE_LIMIT=false`).
- Create `deploy/quickmeet.service`, `deploy/Caddyfile`, `deploy/quickmeet.env.example`, `docs/INSTALL.md`.
- Create `.github/workflows/release.yml`; modify `.github/workflows/deploy.yml` (smoke secret), `compose.yaml` (stop grace, comment).
- Modify `README.md`, `docs/ROADMAP.md`, `docs/KNOWLEDGE.md`.

Commands used throughout: `lgx test` runs the unit and system tests; `lgx e2e` builds the binary and runs the browser suite. If mise cannot provide the pinned Go, see "Dev tooling gotchas" in `docs/KNOWLEDGE.md` (`CGO_ENABLED=0` by hand). With a running nREPL, /nrepl-eval is faster for single namespaces.

---

### Task 1: Branch and backlog entry

**Files:**
- Create: `docs/backlog/sqlite-backups.md`

- [x] **Step 1: Branch**
  `git checkout -b release-milestone` from an up-to-date `master`.

- [x] **Step 2: Write the backlog entry**
  Follow the shape of the existing entries (`docs/backlog/sqlite-busy-on-concurrent-writes.md`): title, `**Status: open**`, Problem, Fix, Origin. Content: the sqlite file is the only state and nothing backs it up; staging's database is called disposable in the README. Fix: a Litestream sidecar replicating `quickmeet.db` (WAL mode is already on, which Litestream needs) to object storage, as planned for linkboard; for a systemd install, Litestream as a second unit. Until then the install guide documents a manual copy with `sqlite3 quickmeet.db ".backup ..."`. Origin: moved out of ROADMAP M6 on 2026-09-30 when M5 and M6 were merged into the release milestone.

- [x] **Step 3: Commit, alone**
  `git add docs/backlog/sqlite-backups.md && git commit -m "Backlog: sqlite backups with Litestream"`

> Deviation: the branch and the plan commit came first, from the approval step, so Step 1 was already done.

### Task 2: The rate limiter

**Files:**
- Create: `src/quickmeet/ratelimit.lg`
- Test: `test/quickmeet/ratelimit_test.lg`

- [x] **Step 1: Write the tests**
  Against this interface, which Task 3 also uses:

  ```clojure
  ;; limits: {bucket {:limit n :window-ms ms}}; now-ms: (fn []) -> current ms
  (ratelimit/limiter limits now-ms)   ; -> a limiter
  (ratelimit/check! limiter bucket key) ; -> nil when allowed, else seconds until the window ends (>= 1)
  (def ratelimit/default-limits ...)  ; the table in Design, decision 3
  ```

  Cases, with a clock held in an atom: the first `limit` calls return nil and the next returns a positive number; another key and another bucket are unaffected; after the window passes the key is allowed again; an unknown bucket is always allowed; 200 concurrent `check!` calls on one key from futures allow exactly `limit` (pattern: the futures test in `system_test.lg`).

- [x] **Step 2: Run them, expect failure**
  Run: `lgx test`
  Expected: FAIL, namespace `quickmeet.ratelimit` not found.

- [x] **Step 3: Implement**
  State is one atom: `{[bucket key] [window-start-ms count]}`. `check!` does a single `swap!` that starts a new window when the old one has ended and otherwise increments the count (stop incrementing past `limit + 1` so a flood cannot grow the number), then decides from the returned state: allowed when count <= limit. When the map holds more than 10 000 entries, the same `swap!` first drops entries whose window has ended. No dynamic vars, no `binding`. Header comment: what it is for, that state is per process, and why it must stay free of dynamic bindings (the backlog entry).

- [x] **Step 4: Run the tests**
  Run: `lgx test`
  Expected: PASS, all namespaces.

- [x] **Step 5: Commit**
  `git commit -m "Rate limiter: fixed windows in memory"`

> Deviation: `limiter` takes an optional `max-entries` and there is a `size` fn, both so pruning is testable without 10 000 entries. After review, pruning runs at most once a minute (a full rebuild on every check once 10 000 windows are live would make the limiter the bottleneck), and state became `{:entries .. :pruned-at ..}` (commit `eb5de4f`).

### Task 3: Limits on sign-in, sign-up and room creation

**Files:**
- Modify: `src/quickmeet/routes.lg`, `src/quickmeet/system.lg`, `e2e/playwright.config.js`
- Test: `test/quickmeet/routes_test.lg`, `test/quickmeet/system_test.lg`

- [x] **Step 1: Write the route tests**
  The handler's fourth argument (`auth`) gains an optional `:limit`, `(fn [bucket key]) -> nil | retry-after-seconds`; absent means unlimited, so every existing test keeps passing unchanged. New tests with a stub `:limit`:
  - refusing `:signin` makes `POST /api/auth/signin` answer 429 with a `Retry-After` header and the error sentence from Design, and the stub saw the client IP as key;
  - the same for `:signup`;
  - refusing `:create-room` makes `POST /api/rooms` answer 429 for a signed-in user, keyed by the user's id; without a session it is still 401 and the limiter is not asked;
  - the key for the IP buckets: `x-forwarded-for: "1.1.1.1, 2.2.2.2"` gives `2.2.2.2`; no header and `:remote-addr "10.0.0.5:4312"` gives `10.0.0.5`; `:remote-addr "[::1]:4312"` gives `::1`.

- [x] **Step 2: Run them, expect failure**
  Run: `lgx test`
  Expected: FAIL on the new tests only.

- [x] **Step 3: Implement in routes.lg**
  A private `client-ip` and a `too-many` response builder. The limit check comes before the body is read for the two account routes, and after the session check for room creation. `init-key ::handler` puts `:limit` into the auth map: `(partial ratelimit/check! (ratelimit/limiter ratelimit/default-limits #(System/currentTimeMillis)))` when the config's `:rate-limit?` is true, nothing otherwise. Update the `handler` docstring for `:limit`.

- [x] **Step 4: Config**
  In `system.lg`, `RATE_LIMIT` (default `true`, via `env-bool`) becomes `:rate-limit?` in the `:quickmeet.routes/handler` config. Add a system test: with `RATE_LIMIT` on, the 11th `POST /api/auth/signin` within one test answers 429 through the real server. Check that the existing system tests do not sign up more than 10 accounts or sign in more than 10 times against one system; if one does, turn the limit off for that test through the `adjust` function of `with-system`.
  In `e2e/playwright.config.js`, add `RATE_LIMIT: 'false'` to `webServer.env` with a one-line comment saying why.

- [x] **Step 5: Run everything**
  Run: `lgx test` then `lgx e2e`
  Expected: PASS both.

- [x] **Step 6: Commit**
  `git commit -m "Rate limits on sign-in, sign-up and room creation"`

### Task 4: Sign-in timing

**Files:**
- Modify: `src/quickmeet/password.lg`, `src/quickmeet/auth.lg`
- Test: `test/quickmeet/password_test.lg`, `test/quickmeet/auth_test.lg`

- [x] **Step 1: Tests**
  `password/dummy-check` returns false for any password and does real work: the literal is a valid cost-10 hash (assert `(password/check <the literal> <the password it was made from>)` is true through a test-only accessor or by making the literal a public def). In `auth_test.lg`, sign-in with an unknown address still returns `{:error :invalid}`. That alone passes before the fix, so also prove the comparison runs: redefine `password/dummy-check` with `with-redefs` to record its call and assert it was called once for an unknown address and not at all for a known one.

- [x] **Step 2: Implement**
  Generate one cost-10 hash with `password/hash` at a REPL and paste it into `password.lg` as a string literal with a comment on why it is a literal (AOT runs top-level forms) and what it is for. `dummy-check [password]` runs `check` against it and returns false. In `auth/sign-in!`, when no user is found, call `password/dummy-check` before returning `:invalid`. Keep the single `:invalid` result for both cases.

- [x] **Step 3: Verify the timing by hand**
  With the app running (`lgx run`) and one account signed up, time five sign-ins each for a wrong password on the known address and for an unknown address (`curl -w '%{time_total}\n' -o /dev/null -s -H 'content-type: application/json' -d ... localhost:8080/api/auth/signin`), with `RATE_LIMIT=false` so the limit does not interfere.
  Expected: both groups around the bcrypt cost (tens of ms), no group near zero.

- [x] **Step 4: Run tests, commit**
  Run: `lgx test`. Expected: PASS.
  `git commit -m "Sign-in: an unknown address costs one bcrypt comparison too"`

> Deviation: the hash was generated through a throwaway test (there is no one-off script runner in this setup). Measured by hand: 60 to 70 ms for both an unknown address and a wrong password.

### Task 5: Config guard and HOST

**Files:**
- Modify: `src/quickmeet/system.lg`, `.github/workflows/deploy.yml`
- Test: `test/quickmeet/system_test.lg`

- [x] **Step 1: Tests**
  Calling `(system/config lookup)` with a map-backed lookup:
  - no variables: returns a config (development still works);
  - `LIVEKIT_USE_EXTERNAL_IP=true` and no secret: throws, and the message names `LIVEKIT_API_SECRET`;
  - `LIVEKIT_BIND=0.0.0.0` and no secret: throws; `LIVEKIT_PUBLIC_URL` set and no secret: throws;
  - each of those with a 32+ character `LIVEKIT_API_SECRET`: returns a config;
  - `LIVEKIT_BIND=localhost` and no secret: returns a config;
  - `HOST=127.0.0.1`, `PORT=9000`: the server's `:addr` is `127.0.0.1:9000`; no `HOST`: `:9000`.

- [x] **Step 2: Implement**
  In `config`, after reading the variables, throw `ex-info` when the secret equals `dev-api-secret` and any of the three conditions holds (Design, decision 7). The message: what is wrong, which variable to set, `openssl rand -hex 32`. `HOST` defaults to empty and is prepended to the `:addr`. Update the namespace comment, which says the defaults are "wrong on a server": now the dangerous case refuses to start.

- [x] **Step 3: Fix the image smoke test**
  In `deploy.yml`, "Smoke-test the image" runs with `LIVEKIT_BIND=0.0.0.0`; add `-e LIVEKIT_API_SECRET=ci-smoke-test-secret-0123456789abcdef` (any 32+ characters, it never leaves the runner) and a comment line saying the guard needs it.

- [x] **Step 4: Run tests, commit**
  Run: `lgx test`. Expected: PASS.
  `git commit -m "Refuse the development API secret off loopback; HOST binds the app"`

> Deviation: after review, `HOST` accepts only empty, `0.0.0.0` or `127.0.0.1` and refuses anything else, `localhost` included (a host mapping it to `::1` would also lose the webhooks); the plan had left the restriction to the guide (`06d3326`, `8c70f52`). The built binary prints a refused config as one line and exits 1 (`main.lg`, `start-or-exit`).

### Task 6: Close stale calls at startup

**Files:**
- Modify: `src/quickmeet/db.lg`
- Test: `test/quickmeet/history_test.lg` (or `db_test.lg`, wherever the call fixtures are easier)

- [x] **Step 1: Tests**
  `db/close-open-calls!` over a throwaway database with one open call (two participants, one already left), one closed call: afterwards the open call has `ended_at`, its participant without a leave has `left_at`, the participant who had left keeps the earlier `left_at`, and the closed call is untouched. A second test: open the db component twice on the same file (init, create an open call, halt, init again) and the call is closed after the second init.

- [x] **Step 2: Implement**
  Two statements, as plain SQL strings (no `sql-of`: HoneySQL under let-go misorders some shapes, see KNOWLEDGE): set `left_at = datetime('now')` on participants without one whose call has no `ended_at`; then set `ended_at = datetime('now')` on calls without one. Participants first. `init-key ::conn` calls it after `migrate!`. Comment there: at startup the SFU has no rooms, so an open call is left over from a process that died; and the cost, an end time overstated by the outage.
  Update the paragraph in `history.lg`'s header that says a killed process's call is closed at the next join: it is now closed at the next start, and the room-sid rule remains as the guard for anything that slips through.

- [x] **Step 3: Run tests, commit**
  Run: `lgx test`. Expected: PASS. Existing history tests that rely on a call staying open across a db re-init, if any, are adjusted to the new rule.
  `git commit -m "History: calls left open by a dead process are closed at startup"`

### Task 7: Shutdown on SIGTERM

**Files:**
- Modify: `src/quickmeet/system.lg`, `main.lg`, `compose.yaml`
- Test: `test/quickmeet/system_test.lg`

- [x] **Step 1: System test for `shutdown!`**
  Start a system (own db path, not through `with-system`, because the test controls the teardown). Insert an open call through `quickmeet.db`. Call `(system/shutdown! system)`. Then: the http port refuses connections; a fresh `sqlite/open` on the file shows the call closed; the SFU still answers (`sfu/active-rooms` with the system's livekit map returns a map, not nil). Finally stop the SFU so later tests can bind its port: `(ig/halt! system [:livekit/server])`, and remove the db files.

- [x] **Step 2: Implement `shutdown!`**
  In `system.lg`:

  ```clojure
  (defn shutdown!
    "Stop serving and close the database, leaving the SFU up until the
     process exits."
    [system] ...)
  ```

  Order: `(ig/halt! system [:quickmeet.server/http])`, then `db/close-open-calls!` on `(:quickmeet.db/conn system)`, then `(ig/halt! system [:quickmeet.db/conn])`. Check what `ig/halt!` with a key list does under integrant 1.0.1 (it halts the keys and their dependents, in reverse dependency order); if halting `::conn` would also re-halt the server, confirm `http/stop` is idempotent (it is: `stopOnce` in let-go's `http.go`) or call the component's halt directly. The comment must say why the SFU is not halted: graceful `Stop` waits for participants forever, forced `Stop` tells them to leave, and leaving it running lets clients reconnect to the next process (Design, decision 1).

- [x] **Step 3: Signals in main.lg**
  `-main`: start the system; create a channel and `(syscall/signal-notify ch syscall/SIGTERM syscall/SIGINT)`; in a `go` block take one value from the channel and call `(http/stop server)`; the main thread stays on `(http/wait server)` as today, and when it returns prints one line (`quickmeet: shutting down`), runs `system/shutdown!` and calls `(os/exit 0)`, or `(os/exit 1)` if `shutdown!` threw. `os/exit` is required: the SFU's goroutines would keep the process alive otherwise. Keep the `*compiling-aot*` guard. Require `syscall` and the async namespace the same way let-go's own examples do; confirm the exact names (`chan`, `<!`, `go`) against `pkg/rt/async.go` in let-go 1.13.0.

- [x] **Step 4: Process check**
  Run: `lgx build`, then start `bin/quickmeet` on spare ports (`PORT=8098 LIVEKIT_PORT=7897 LIVEKIT_RTC_TCP_PORT=7896 LIVEKIT_UDP_START=50400 LIVEKIT_UDP_END=50500 DB_PATH=/tmp/qm-sig.db`), wait for the landing page, `kill -TERM <pid>`, `wait <pid>; echo $?`.
  Expected: exit status 0 within about a second, the "shutting down" line in the output. Repeat with `kill -INT`.

- [x] **Step 5: Container check**
  Run: `docker build -t quickmeet:sig .` then `docker run -d --name qm-sig -e LIVEKIT_BIND=0.0.0.0 -e LIVEKIT_UDP_PORT=7882 -e LIVEKIT_API_SECRET=local-check-secret-0123456789abcdef -e DB_PATH=/tmp/q.db quickmeet:sig`, wait for it to serve, `time docker stop -t 10 qm-sig`, `docker inspect -f '{{.State.ExitCode}}' qm-sig`, `docker logs qm-sig | tail -3`, `docker rm qm-sig`.
  Expected: stop returns in well under 10 s, exit code 0, the "shutting down" line. This is the PID 1 case the old "lg ignores SIGTERM" note was about.

- [x] **Step 6: compose.yaml**
  If Step 5 passed: raise `stop_grace_period` to `10s` and replace the comment "lg ignores SIGTERM, so waiting the default 10 s buys nothing" with what is true now (the app drains http and closes history on SIGTERM; the grace period is the ceiling). If Step 5 failed, keep `2s`, leave the comment, and record what happened in KNOWLEDGE in Task 11, and report graceful shutdown in the container as not done in the ROADMAP line and the Task 12 outcome. The startup close from Task 6 keeps history right but does not replace the drain.

- [x] **Step 7: Run tests, commit**
  Run: `lgx test` and `lgx e2e`. Expected: PASS.
  `git commit -m "Shutdown: SIGTERM drains http and closes history, the SFU stays up"`

> Deviation: core `chan` takes no arguments in let-go (`(chan 1)` crashed the binary at startup; the buffered form is in the async namespace), so the channel is unbuffered. After review, signals are registered before startup, `http/wait` failing still runs `shutdown!`, and errors print their cause (`d087ce3`).
>
> Deviation: Step 5, the container check, could not run here: this user cannot reach the docker socket and cannot create user namespaces, so neither `docker stop` nor a PID 1 run under `unshare` was possible. `stop_grace_period` was raised to 10 s anyway, since the app now registers a SIGTERM handler, and PID 1 honours handled signals. The worst case is 8 s more outage per deploy. Verified instead at the Task 12 merge deploy.

### Task 8: The smoke script

**Files:**
- Create: `e2e/smoke.mjs`
- Modify: `lgx.edn`

- [x] **Step 1: Write the script**
  A standalone Node script using `@playwright/test`'s `chromium` with the same fake-media flags as `e2e/playwright.config.js`. Environment: `QM_URL` (required, the instance's base URL), `QM_EMAIL` and `QM_PASSWORD` (the account that hosts), `QM_SIGNUP=1` (sign the account up instead of signing in, for a local instance), `QM_SECS` (how long to watch, default 20). A draft from the pre-planning measurement may still exist at `/tmp/qm-deploy-check/check.mjs`; use it if it is there, otherwise write from this description.
  Behaviour: sign in (or up), click "New meeting", join as host, open a second context as a guest on the room link and join (retry a failed join up to 4 times: staging drops some TCP connections, see KNOWLEDGE); then once a second read from both pages `window.call.joined`, `window.call.remote`, the `#status` and `#notice` text and `window.call.stats()`, and fetch `/` for the http status. Print a timestamped line on every state change, not every second. At the end: delete the room (`DELETE /api/rooms/<id>` from the host page), print the longest stretch during which media was not advancing on either side, and exit 0 only if both sides are joined with frame and packet counters that advanced over the last 3 samples. Exit 1 otherwise, and on any failure still try to delete the room. Never print the password.

- [x] **Step 2: lgx task**
  In `lgx.edn` `:tasks`, add `smoke` with a `:doc` ("Hold a two-browser call against QM_URL and report what happened") running `cd e2e && node smoke.mjs`.

- [x] **Step 3: Verify locally, including a restart**
  Start `bin/quickmeet` on the e2e ports with a throwaway database and `RATE_LIMIT=false`. Run `QM_URL=http://127.0.0.1:8099 QM_SIGNUP=1 QM_EMAIL=smoke@example.com QM_PASSWORD='correct horse' QM_SECS=60 lgx smoke`; ten seconds after it reports both joined, `kill -TERM` the server, wait 5 s, start it again on the same database.
  Expected: the script prints "Reconnecting…" on both sides, then both joined with media again within about 20 s of the kill, and exits 0. This is the check that Task 7's shutdown did not break the reconnect that the hard kill allowed. Then check history: the first call is closed at the shutdown time and a second call was opened by the rejoin (`GET /api/calls` with the host's cookie, or a `sqlite3` query on the file).

- [x] **Step 4: Commit**
  `git commit -m "lgx smoke: a two-browser call against a deployed instance"`

> Deviation: after review, the script retries a join only when the button is clickable again, times out stuck page calls and the room deletion, reads `#error` for failure reasons, remembers the room from the create response, ignores the pre-media seconds when timing stalls, and rejects a `QM_SECS` under 5 (`c055a1f`). Local run through a SIGTERM restart: PASS, media moved again 11.2 s after the stop, history split at the stop.

### Task 9: Install files and guide

**Files:**
- Create: `deploy/quickmeet.service`, `deploy/Caddyfile`, `deploy/quickmeet.env.example`, `docs/INSTALL.md`

- [x] **Step 1: deploy/quickmeet.env.example**
  Every variable a server sets, with a comment each: `PORT=8080`, `HOST=127.0.0.1`, `DB_PATH=/var/lib/quickmeet/quickmeet.db`, `LIVEKIT_PORT=7880`, `LIVEKIT_RTC_TCP_PORT=7881`, `LIVEKIT_UDP_PORT=7882`, `LIVEKIT_USE_EXTERNAL_IP=true`, `LIVEKIT_API_KEY=quickmeet`, `LIVEKIT_API_SECRET=` (empty, with the `openssl rand -hex 32` instruction), `LIVEKIT_LOG_LEVEL=info`, `ALLOWED_EMAILS=` (with the warning that empty means open sign-up). `LIVEKIT_BIND` stays at its loopback default: Caddy is on the same box.

- [x] **Step 2: deploy/quickmeet.service**
  A plain unit: `User=quickmeet`, `EnvironmentFile=/etc/quickmeet/env`, `ExecStart=/usr/local/bin/quickmeet`, `StateDirectory=quickmeet`, `WorkingDirectory=/var/lib/quickmeet`, `Restart=on-failure`, `TimeoutStopSec=10`, `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `WantedBy=multi-user.target`, `After=network-online.target`.

- [x] **Step 3: deploy/Caddyfile**
  One site block with a placeholder domain: `handle /rtc*` to `127.0.0.1:7880`, everything else to `127.0.0.1:8080`. Same split as `compose.yaml`'s `x-caddy`.

- [x] **Step 4: docs/INSTALL.md**
  Use /writing-clearly. Sections, in order: what you need (a linux/amd64 box with a public IP, a DNS name, ports 80 and 443/tcp for Caddy, 7881/tcp and 7882/udp for media); download and verify the release tarball; create the user, install the binary and the unit; write `/etc/quickmeet/env` from the example (generate the secret; set `ALLOWED_EMAILS`); install Caddy and the Caddyfile; open the firewall ports and only those (8080 and 7880 stay closed, which is what makes the forwarded client address trustworthy); start and enable; the first account (sign up with an allowed address: whoever registers an allowed address first owns it); check it (`lgx smoke` from a checkout, or two phones on different networks); upgrading (replace the binary, `systemctl restart quickmeet`: a live call reconnects by itself in roughly 20 s, and gives up if the server is away longer than about 45 s); backup (a manual `sqlite3 ... ".backup"`, pointing at `docs/backlog/sqlite-backups.md`); what is not there (no password reset: the operator deletes the row; no TURN, so a network that blocks both UDP 7882 and TCP 7881 cannot join). State at the top that the guide was written from the staging deployment and had not been run on a fresh box as of its date.

- [x] **Step 5: Validate what can be validated**
  Run: `systemd-analyze verify deploy/quickmeet.service` (complaints about the missing binary or user are expected; syntax errors are not).
  Run: `docker run --rm -v $PWD/deploy/Caddyfile:/etc/caddy/Caddyfile caddy:2 caddy validate --config /etc/caddy/Caddyfile`
  Expected: `Valid configuration`.
  Run the binary with the example file's variables (a secret filled in, `DB_PATH` under `/tmp`, `LIVEKIT_USE_EXTERNAL_IP=true`) and check it starts and serves `/` on 127.0.0.1 only.

- [x] **Step 6: Commit**
  `git commit -m "Install guide with a systemd unit, a Caddyfile and an environment example"`

> Deviation: `caddy validate` ran with a downloaded Caddy 2.11.4 binary rather than the docker image (no docker access). After review, the guide opens the firewall before installing Caddy, keeps SSH open and says `ufw enable`, links the README and backlog on GitHub (the tarball has neither), and runs `sqlite3` as the `quickmeet` user for backups and resets (`aebb53f`).

### Task 10: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [x] **Step 1: Write the workflow**
  Trigger: `push` of tags matching `v*`. Job `test` uses `./.github/workflows/test.yml`. Job `release` needs it, `runs-on: ubuntu-latest`, `permissions: contents: write`, env `CGO_ENABLED: "0"`. Steps mirror `deploy.yml` up to the build (checkout, `jdx/mise-action@v3`, the same `actions/cache` block and key, `lgx build`, the `statically linked` check), then: assemble `quickmeet-${GITHUB_REF_NAME}-linux-amd64/` with `quickmeet`, the three `deploy/` files and `docs/INSTALL.md`; `tar czf` it; write `<tarball>.sha256` with `sha256sum`; `gh release create "$GITHUB_REF_NAME" --generate-notes <tarball> <tarball>.sha256` with `GH_TOKEN: ${{ github.token }}`. Comments in the style of the other workflows: why static, why the tests run first.

- [x] **Step 2: Check the syntax**
  Run: `docker run --rm -v $PWD:/repo -w /repo rhysd/actionlint:latest` if docker can pull it; otherwise parse the file with any YAML parser and re-read it against `deploy.yml`.
  Expected: no errors for `release.yml`.
  The packaging lines can be run locally as a shell script against `bin/quickmeet` to confirm the tarball's layout and that `sha256sum -c` passes.

- [x] **Step 3: Commit**
  `git commit -m "Release workflow: a linux/amd64 tarball on a version tag"`

> Deviation: actionlint ran as its release binary rather than the docker image.

### Task 11: Documentation

**Files:**
- Modify: `docs/ROADMAP.md`, `docs/KNOWLEDGE.md`, `README.md`

- [x] **Step 1: ROADMAP.md**
  Replace the M5 and M6 sections with one "M5: release" section in the file's existing voice (dated "Done" and "Decided" bullets): the 2026-09-30 decision to merge the two, linux/amd64 only, backups moved to `docs/backlog/sqlite-backups.md`; staging's paragraph kept; each item this plan shipped as a dated Done line; the shutdown decision with its reason (Design, decision 1); production defaults decision (decision 7); room ids recorded as already satisfied since M3 with the file reference. Remove "native macOS second"; add macOS builds to "After v1" with the known constraint from KNOWLEDGE (cross-building from linux fails, build natively). In "Non-goals" nothing changes. In "Open questions", nothing new.

- [x] **Step 2: KNOWLEDGE.md**
  A new section "Restarts and shutdown, verified 2026-09-30" with the measurements and source references from "What was measured before planning" above, plus what Tasks 7 and 8 found (SIGTERM in the container, the restart run). Correct the two stale notes: "The `lg` process did not stop on SIGINT or SIGTERM ... Not yet investigated" under Dev tooling gotchas and "`lg` ignores SIGTERM" under deployment: say what was observed at the time and what is true of the built binary now. Add: `ig/halt!` on `:livekit/server` blocks while anyone is in a room; `syscall/signal-notify` usage; the rate limiter must stay free of dynamic bindings. Update the "Verify against" footer if new upstream files were relied on.

- [x] **Step 3: README.md**
  Configuration table: add `HOST` and `RATE_LIMIT`; change the sentence above the table to say the development secret is refused once the instance is exposed. Deployment: link `docs/INSTALL.md` for a single box and describe releases (tag `v*`, the tarball); replace "there is no rate limit yet" with the limits. Layout: add `ratelimit.lg`, `deploy/`, `e2e/smoke.mjs`. API section: the 429 response on the three endpoints. Run/Browser tests section: `lgx smoke`.

- [x] **Step 4: Commit**
  `git commit -m "docs: the release milestone in the roadmap, knowledge and README"`

> Deviation: no separate review for this docs-only task; the branch-wide review in Task 12 covered it.

### Task 12: Ship and measure

- [x] **Step 1: Full local run**
  Run: `lgx test` and `lgx e2e`.
  Expected: PASS both.

- [x] **Step 2: Review**
  Run /code-review on the branch against `master`; fix what is real.

- [x] **Step 3: Pull request**
  Push the branch and open a PR titled "M5: release milestone" with a summary of the decisions. Wait for the `test` workflow to pass.

- [x] **Step 4: Merge, watching a live call through the deploy**
  This step needs the staging account's address and password from the user as `QM_EMAIL` and `QM_PASSWORD` in the environment; they are not written anywhere in the repository. If they are not available, merge and skip the measurement, and say so in the outcome note.
  Start `QM_URL=https://quickmeet.absky.dev QM_SECS=600 lgx smoke` and, once it reports both joined, squash-merge the PR (as PRs #7 and #9 were). The merge deploys to staging. Watch the `deploy` run to the end.
  Expected: the script shows one "Reconnecting…" stretch during the deploy, both sides back without intervention, exit 0. Note the time from the first "Reconnecting…" to media flowing again: that is what a deploy costs a live call on staging, unmeasured until now.
  If the deploy fails on the config guard, the staging secret is the development one: stop and tell the user (the fix is a repository secret, not code).

- [x] **Step 5: Verify staging**
  `curl` the landing page (with `--retry 4 --retry-all-errors`: the staging box drops some connections); 11 quick wrong-password sign-ins for a made-up address show a 429 on the last; the smoke run's call appears in the account's history as two calls split at the deploy.

- [x] **Step 6: Record the outcome**
  On a branch `docs-release-executed`, add a "Task 12 outcome" note at the end of this plan (as the M4 plan has), put the measured deploy outage into the KNOWLEDGE section from Task 11 and a dated line in ROADMAP M5, and set `docs/backlog/` statuses only if one changed (none should). PR and merge, as PR #10 did.

- [ ] **Step 7: Leave the tag to the user**
  Do not push a tag. Tell the user the release is one command away: `git tag v0.1.0 && git push origin v0.1.0`, which runs `release.yml` and publishes the tarball.

> Task 12 outcome (2026-10-01). PR #11 squash-merged as `8b6393d`; the deploy run succeeded. `lgx smoke` held a call on staging from before the merge to after the deploy and passed: uncloud stopped the old container at 23:52:11.0 (gone at 11.5), the new one ran at 14.0, both sides were back in the call with media at 23:52:38, 27.6 s without media, no clicks. History split the call at 23:52:15, the new process's startup closing the open call. The old build stopped 0.44 s after SIGTERM even as PID 1, so the old "lg ignores SIGTERM" note was wrong in the container too; the new build's own stop is first exercised by the deploy of this outcome PR. Sign-in over one connection: ten 401s, then 429 with `Retry-After: 59`. Over separate connections the limit never triggered, because the address the app sees changes per connection on staging; the limiter is fine and the cause looks like the provider's network (backlog: `docs/backlog/staging-rate-limit-per-connection.md`). Not done here: a run of `docs/INSTALL.md` on a fresh box, and the first tag.

> Follow-up (2026-10-01). The deploy of the outcome PR #12 stopped the new build for the first time: 0.73 s from uncloud's stop to the container gone, and history closed the open call at the moment of the stop. With `lgx smoke` running through it, both sides were back in the room within 16 s but did not see each other for another 40 s (59.9 s without media in total, no clicks); backlog: `docs/backlog/reconnect-after-deploy-can-leave-both-waiting.md`. That run has no PASS or FAIL line because the session running it ended at 00:22:10; media had been flowing for two minutes by then.

## Summary

All of the planned milestone shipped in PR #11, except the first tag:

- in-memory rate limits on sign-in, sign-up and room creation
- an equal-cost sign-in for unknown addresses
- a guard against the development secret on an exposed SFU, and `HOST` for the app's bind address
- shutdown on SIGTERM that keeps calls reconnectable, and stale calls closed at startup
- `lgx smoke`, the install guide with its `deploy/` files, and a release workflow
- backups moved to the backlog

Issues met on the way:

- `(chan 1)` crashed the binary at startup. The unit tests never load `main.lg`, so only the process check caught it.
- Other projects' test runs and codex's own runs collided with the system tests' fixed SFU port.
- Codex hit its usage limit after Task 5.
- This machine has no Docker access and no user namespaces, so the PID 1 check moved to staging.
- Staging's network rewrites client addresses per connection.

Deviations, all recorded under their tasks:

- **Task 1.** The branch already existed.
- **Task 2.** A test-only `max-entries` and `size`, and pruning at most once a minute.
- **Task 4.** The hash was generated through a throwaway test.
- **Task 5.** `HOST` is restricted in code.
- **Task 7.** An unbuffered channel, a hardened `main`, and the container check moved to staging.
- **Task 8.** The smoke script was hardened.
- **Tasks 9 and 10.** Tools ran as downloaded binaries, and the guide was reordered.
- **Task 11.** No separate review.
- **Reviews.** Claude subagents stood in for codex from Task 6 on.

What the plan could have specified better:

- A process-level check of `main.lg` as a task step in its own right, since no test loads it.
- Steps that do not assume Docker is available.
- A measurement of the staging network itself before trusting per-address limits there.
