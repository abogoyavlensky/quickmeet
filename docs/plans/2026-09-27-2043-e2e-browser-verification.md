# End-to-end browser verification Implementation Plan

> **Status: completed 2026-09-27.** Summary at the end.

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command, `lgx e2e`, that builds the binary, starts it on test ports, drives two headless browsers with fake cameras through a real call, asserts media flowed both ways, and stops everything. Runnable by an agent on this machine with no human, and by CI on every push.

**Tech Stack:** `@playwright/test` 1.56.0 with `chromium-headless-shell`, Node 24 via mise, lgx tasks, GitHub Actions. The app itself is unchanged except for two test hooks on the room page and a vendored `livekit-client`.

---

## Design

### Why this shape

The room page is where every M2 change lands, and nothing verifies it today: the suite covers the handler, the migrations and the token path, and stops at the browser. The milestone 0 spike showed that headless Chromium with fake media devices can complete a real call through the embedded SFU, so the same technique becomes the project's regression test. Making it one lgx task means an agent can run it, read the report, and iterate without asking anyone to click.

### What runs

```
lgx e2e
  = lgx build                      bin/quickmeet, the artifact that ships
  + cd e2e && npx playwright test  Playwright starts bin/quickmeet on test
                                   ports with a throwaway db (webServer),
                                   runs the specs, kills the process group
```

Testing the built binary rather than `lgx run` costs a few seconds on a warm cache and buys coverage of the bundling path, where top-level forms run at compile time and would otherwise only be caught by hand.

### Key decisions

- **`@playwright/test`, pinned to 1.56.0.** The runner gives `expect` with polling, per-test isolation, retries, traces and an HTML report. The pin matches the `chromium_headless_shell-1194` already installed on the dev machine, so no new download is needed here. Config and specs are plain JavaScript (ESM), no TypeScript toolchain.
- **Two browser contexts per call test**, one per participant. Two contexts are two independent origins with their own permissions and media devices, which is how two people join in reality, and it is what the spike did not test (it joined twice from one page).
- **Fake media via Chromium flags**, `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`, plus `context.grantPermissions(['camera', 'microphone'])`. The page's `createLocalTracks` then gets a synthetic camera and microphone through the normal `getUserMedia` path, so the production code is exercised unchanged.
- **The app is started by Playwright's `webServer`**, not by a shell wrapper. It waits for the landing page to answer, pipes the app's output into the report, and on teardown kills the process group with SIGKILL (`processLauncher.js`, `process.kill(-pid, 'SIGKILL')`). That sidesteps the open question of `lg` ignoring SIGTERM, and covers `lgx run` too if the command is ever switched.
- **Dedicated test ports and database**, set through the environment variables the app already reads: app `8099`, SFU `7899`, ICE TCP `7898`, UDP `50200-50300`, database `e2e/.tmp/quickmeet.db` recreated per run. A developer's `lgx run` on the default ports and an e2e run can coexist.
- **Vendor `livekit-client` 2.22.3** into `resources/public/` and load it from `/static/`. An end-to-end check that depends on a CDN is not "on your own", and it also removes a network dependency from every user's call page (an M2 roadmap item, pulled forward because the suite needs it). 580 KB, Apache-2.0. A task `vendor-livekit-client` re-downloads a pinned version so updating is one command.
- **Two small hooks on the room page**, kept production-safe: `window.call.joined` becomes `true` once the local tracks are published, and `window.call.stats()` returns the inbound RTP stats for the remote video and audio tracks (`framesDecoded`, `packetsReceived`, `packetsLost`) read through `livekit-client`'s `getRTCStatsReport`. Everything else the tests need is already there: `window.call.remote` and the element ids.

### What the specs assert

`e2e/tests/landing.spec.js`
- "New meeting" creates a room and navigates to `/room/<12 hex>`.

`e2e/tests/call.spec.js` (each test creates its own room and participants; contexts are closed in `afterEach`)
- Two contexts open the same room link, enter names, click join. Each reaches `call.joined`; each sees the other's identity in `call.remote` and in the remote-name tag.
- The remote `<video>` is playing: `videoWidth > 0` and `readyState >= 2` within 15 s.
- Media flows: `call.stats()` sampled twice, 2 s apart; `framesDecoded` and audio `packetsReceived` increased on both sides; `packetsLost` is 0.
- Leaving: one participant clicks Leave; within 10 s the other's tag reads "the other side left" and its `call.remote` is null; the leaver is back in the lobby.

Timeouts are generous (15 s for media) because the first connection in a cold headless shell takes a couple of seconds; the assertions poll, so a fast run stays fast.

### Local setup and the Ubuntu 26.04 quirk

`lgx e2e-setup` runs `npm ci` in `e2e/` and `npx playwright install chromium-headless-shell`. Playwright refuses unrecognised distributions; on this dev machine (Ubuntu 26.04) the install needs `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`, and the resulting browser runs with no missing libraries. The task does not set the override itself, the README documents it, because on a supported distribution the override would pin the wrong build.

### CI

`.github/workflows/test.yml`, modelled on letgo-packages: `jdx/mise-action` installs lgx, Go and Node from `.mise.toml`; the runtime cache key hashes `lgx.edn`; `lgx test`; then `npm ci`, `npx playwright install --with-deps chromium-headless-shell` (ubuntu-latest is supported, no override), `lgx e2e`; on failure the Playwright report and traces are uploaded as an artifact. The UDP port range is local to the runner, nothing to open.

### Out of scope

The two-person rule, the lobby with device preview, room expiry, and fixing `lg`'s signal handling stay in M2 and M6. This plan only makes them verifiable.

## File Structure

**Create:**
- `e2e/package.json`, `e2e/package-lock.json` — `@playwright/test` 1.56.0 as the only dependency.
- `e2e/playwright.config.js` — `webServer`, fake-media launch args, permissions, base URL, retries and reporter.
- `e2e/tests/landing.spec.js`, `e2e/tests/call.spec.js` — the specs above.
- `e2e/.gitignore` — `node_modules/`, `.tmp/`, `test-results/`, `playwright-report/`.
- `resources/public/livekit-client.umd.min.js` — vendored 2.22.3.
- `.github/workflows/test.yml` — CI.

**Modify:**
- `resources/public/room.html` — script tag to `/static/livekit-client.umd.min.js`; the two hooks.
- `lgx.edn` — tasks `e2e`, `e2e-setup`, `vendor-livekit-client`.
- `.mise.toml` — `node = "24"`.
- `test/quickmeet/routes_test.lg` — the vendored file is served as JavaScript.
- `README.md`, `docs/KNOWLEDGE.md`, `docs/ROADMAP.md`.

---

### Task 1: Vendor `livekit-client`

**Files:**
- Create: `resources/public/livekit-client.umd.min.js`
- Modify: `resources/public/room.html`, `lgx.edn`, `test/quickmeet/routes_test.lg`

- [x] **Step 1: Add the task** to `lgx.edn`: `vendor-livekit-client` with `:doc "Download the pinned livekit-client UMD build into resources/public"` and a `:sh` step `curl -fsSL https://cdn.jsdelivr.net/npm/livekit-client@2.22.3/dist/livekit-client.umd.min.js -o resources/public/livekit-client.umd.min.js`. A comment above it says the version is pinned here and in `docs/KNOWLEDGE.md`.
- [x] **Step 2: Run it.** `lgx vendor-livekit-client`, then `ls -la resources/public/livekit-client.umd.min.js`. Expected: about 580 KB, first line a comment naming `livekit-client@2.22.3`.
- [x] **Step 3: Point the page at it.** In `room.html` replace the CDN script tag with `<script src="/static/livekit-client.umd.min.js"></script>`.
- [x] **Step 4: Test.** In `routes_test.lg` `pages-and-static`, add: `GET /static/livekit-client.umd.min.js` is 200 with `text/javascript; charset=utf-8`, and the room page body contains `/static/livekit-client.umd.min.js` and not `jsdelivr`. Run `lgx test`. Expected: 7 tests, all assertions pass.
- [x] **Step 5: Commit.** `git commit -m "Vendor livekit-client 2.22.3 and serve it from the binary"`

### Task 2: Room page hooks

**Files:**
- Modify: `resources/public/room.html`

- [x] **Step 1: `call.joined`.** Initialise `window.call = { room: null, remote: null, joined: false }`; set `joined = true` after the publish loop, and back to `false` in the `Disconnected` handler.
- [x] **Step 2: `call.stats()`.** Keep the subscribed remote tracks in `call.tracks = {video, audio}` inside the `TrackSubscribed` handler (clear them on `ParticipantDisconnected`). `call.stats()` is an async function returning `{video: {framesDecoded, packetsReceived, packetsLost}, audio: {packetsReceived, packetsLost}}` from each track's `getRTCStatsReport()`, picking the `inbound-rtp` entry; a missing track yields `null` for that kind. This is the shape `call.spec.js` reads, so keep the names exactly.
- [x] **Step 3: Manual check.** (skipped, no camera browser at hand; verified headlessly in Task 4) `lgx run`, open a room in a normal browser, join, and in devtools run `await call.stats()`; expected: `{video: null, audio: null}` alone in the room, populated after a second window joins. Skip if no browser with a camera is at hand; Task 4 verifies the same thing headlessly.
- [x] **Step 4: Commit.** `git commit -m "Room page: joined flag and inbound stats for tests"`

> Deviation: the `Disconnected` handler also clears `call.tracks`, so `stats()` after a leave returns nulls instead of reading dead tracks.

### Task 3: Playwright scaffold and the landing spec

**Files:**
- Create: `e2e/package.json`, `e2e/package-lock.json`, `e2e/playwright.config.js`, `e2e/tests/landing.spec.js`, `e2e/.gitignore`
- Modify: `lgx.edn`, `.mise.toml`

- [x] **Step 1: Package.** In `e2e/`: `npm init -y`, set `"private": true`, `"type": "module"`, and `npm i -D --save-exact @playwright/test@1.56.0` (exact, not a caret range: the installed browser build is tied to the Playwright version). Commit the lock file. Add `e2e/.gitignore` with `node_modules/`, `.tmp/`, `test-results/`, `playwright-report/`.
- [x] **Step 2: Config.** `playwright.config.js` exporting `defineConfig` with: `testDir: 'tests'`; `timeout: 60_000`; `expect: { timeout: 15_000 }`; `retries: process.env.CI ? 1 : 0`; `reporter: [['list'], ['html', { open: 'never' }]]`; `use: { baseURL: 'http://127.0.0.1:8099', trace: 'retain-on-failure', permissions: ['camera', 'microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] } }`; `projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]`; and `webServer: { command: 'rm -f .tmp/quickmeet.db && mkdir -p .tmp && ../bin/quickmeet', url: 'http://127.0.0.1:8099/', reuseExistingServer: false, timeout: 60_000, stdout: 'pipe', stderr: 'pipe', env: { PORT: '8099', LIVEKIT_PORT: '7899', LIVEKIT_RTC_TCP_PORT: '7898', LIVEKIT_UDP_START: '50200', LIVEKIT_UDP_END: '50300', DB_PATH: '.tmp/quickmeet.db', LIVEKIT_LOG_LEVEL: 'warn' } }`. Note in a comment that Playwright SIGKILLs the process group on teardown, which is why no shutdown handling is needed in the app for this.
- [x] **Step 3: Tasks.** In `lgx.edn` add `e2e {:doc "Build the binary and run the browser tests against it" :do [{:task lgx:build} {:sh "cd e2e && npx playwright test"}]}` and `e2e-setup {:doc "Install the e2e dependencies and the headless browser" :do {:sh "cd e2e && npm ci && npx playwright install chromium-headless-shell"}}`. Add `node = "24"` to `.mise.toml`.
- [x] **Step 4: Landing spec.** `landing.spec.js`: `page.goto('/')`, click the button named "New meeting", `expect(page).toHaveURL(/\/room\/[0-9a-f]{12}$/)`, and the room id shown in the header equals the URL's id.
- [x] **Step 5: Run.** `lgx e2e`. Expected: the build line, then Playwright's list reporter with 1 passed, and after it `ss -ltn | grep -E ':8099 |:7899 '` prints nothing (the app was killed with the run). On this machine the browser is already installed; on a fresh one run `lgx e2e-setup` first.
- [x] **Step 6: Commit.** `git commit -m "e2e: Playwright scaffold, lgx e2e task, landing spec"`

### Task 4: The call spec

**Files:**
- Create: `e2e/tests/call.spec.js`

- [x] **Step 1: Helpers.** `newRoom(page)` opens `/`, clicks "New meeting" and returns the room URL. `joinAs(browser, roomUrl, name)` creates a context, grants camera and microphone, opens the room, fills `#identity`, clicks `#join`, waits for `window.call.joined === true`, and returns `{context, page}`; it attaches `page.on('pageerror')` and console errors to the test output. Every context a test creates is pushed onto a per-test array that `test.afterEach` closes, so a failed assertion never leaks a browser context into the next test. **Each test creates its own room and its own participants**; no test depends on another's state, so retries and `--repeat-each` stay valid.
- [x] **Step 2: "two participants see and hear each other".** `newRoom`, then `joinAs` alice and bob. Assertions per the design: `call.remote` on each equals the other's name (`expect.poll`); the `#remote` video has `videoWidth > 0` and `readyState >= 2`; then `expect.poll` until `call.stats()` returns both `video` and `audio` non-null on both pages (video readiness says nothing about audio), sample it twice 2 s apart, and assert `framesDecoded` and audio `packetsReceived` increased and `packetsLost === 0` on both pages.
- [x] **Step 3: "leaving is noticed".** A fresh `newRoom` and two fresh `joinAs`; wait for mutual `call.remote`; bob clicks `#leave`; alice's `#remote-name` reads "the other side left" and her `call.remote` is null; bob's `#lobby` is visible again and `call.joined` is false.
- [x] **Step 4: Run.** `lgx e2e`. Expected: 3 passed. If the fake camera delivers no frames (`videoWidth` stays 0), check the launch args reached the browser (`browser.version()` in a debug line) before touching the page; the spike proved this flag combination on this machine.
- [x] **Step 5: Run it twice more** to check for flakiness: `cd e2e && npx playwright test --repeat-each 3`. Expected: all green; if a timing assertion flakes, widen its poll rather than adding a sleep.
- [x] **Step 6: Commit.** `git commit -m "e2e: a real call between two browsers through the embedded SFU"`

### Task 5: CI

**Files:**
- Create: `.github/workflows/test.yml`

- [x] **Step 1: Workflow.** Triggers: `push` on every branch and `pull_request`, with a `concurrency` group per ref that cancels superseded runs (a push to any branch must run the suite, which is also what Step 2 relies on). One job on `ubuntu-latest`: checkout; `jdx/mise-action@v3`; `actions/cache@v4` for `~/.cache/go-build`, `~/go/pkg/mod`, `~/.lgx/runtimes` keyed on `hashFiles('lgx.edn')`; `actions/cache@v4` for `~/.cache/ms-playwright` keyed on `hashFiles('e2e/package-lock.json')`; `lgx test`; `cd e2e && npm ci`; `cd e2e && npx playwright install --with-deps chromium-headless-shell`; `lgx e2e`; `actions/upload-artifact@v4` of `e2e/playwright-report` and `e2e/test-results` with `if: failure()`.
- [x] **Step 2: Push on a branch and watch.** `git checkout -b ci && git push -u origin ci`, then `gh run watch` (or `gh run list --branch ci` and `gh run view --log-failed`). Expected: green. The first run builds the runtime cold (several minutes); the cache makes later runs fast.
- [x] **Step 3: Merge to master** (fast-forward) and delete the branch. Commit message for the workflow: `ci: unit tests and browser e2e on every push`.

### Task 6: Documentation

**Files:**
- Modify: `README.md`, `docs/KNOWLEDGE.md`, `docs/ROADMAP.md`

- [x] **Step 1: README.** A "Browser tests" section: `lgx e2e-setup` once, `lgx e2e` to run, what it covers, where the report lands (`e2e/playwright-report/index.html`), the Ubuntu 26.04 override, and that `livekit-client` is vendored with `lgx vendor-livekit-client` to bump it.
- [x] **Step 2: KNOWLEDGE.** Under "Dev tooling gotchas": Playwright's `webServer` SIGKILLs the process group, so the `lg` signal question does not affect tests; fake devices work through `getUserMedia` in the headless shell; the pinned Playwright and browser build numbers. Update the "spike lives at" note to say the e2e suite in this repo supersedes it.
- [x] **Step 3: ROADMAP.** In M2, mark the vendored client and the browser test as done with the date, and add the two-person rule as the natural next item now that a third-join test can be written.
- [x] **Step 4: Commit.** `git commit -m "docs: browser tests, vendored client, roadmap"`

---

## Completion summary (2026-09-27)

**Implemented.** `lgx e2e` builds `bin/quickmeet`, Playwright starts it on the
test ports with a throwaway database, and three specs run in two headless
Chromiums with fake media: the landing page creates a room; two participants
in separate browser contexts see and hear each other (remote video playing,
`framesDecoded` and audio `packetsReceived` growing over 2 s, zero loss on
both sides); leaving is noticed by the other side. `livekit-client` 2.22.3 is
vendored and served from the binary (`lgx vendor-livekit-client`), the room
page exposes `call.joined` and `call.stats()`, and `.github/workflows/test.yml`
runs `lgx test` and `lgx e2e` on every push. README, KNOWLEDGE and ROADMAP
updated. Commits `4dccffa`, `6cb1816`, `03a8c09`, `985afd3`, `46e3b61`,
`438c079`, all on master.

**Verified.** `lgx test`: 7 tests, 46 assertions. `lgx e2e`: 3 passed, about
11 s including the build; `--repeat-each 3`: 9 of 9 passed; no listener left
on 8099 or 7899 after a run. CI run 36350223249 on the `ci` branch: green on
ubuntu-latest (unit tests 83 s with a cold runtime build, browser tests 8 s),
then fast-forwarded into master.

**Issues met.**
- This machine: the `lgx` on PATH is 0.2.0 and mise cannot fetch the pinned
  Go (dl.google.com is unreachable here, every version 404s), so the plan's
  commands were run with `~/.local/share/mise/installs/lgx/0.4.2/lgx` and
  the system Go 1.26.7. CI, which resolves both from `.mise.toml`, was fine.
- Session task tracking (TaskCreate/TaskUpdate) is not available in this
  harness; this document was the only tracking surface.
- The codex review of the docs commit (`438c079`) first hit the Codex usage
  limit; re-run 11 minutes later it passed. Every commit was reviewed by
  codex with no findings.

**Deviations.**
- Task 2: the `Disconnected` handler also clears `call.tracks`, so `stats()`
  after a leave returns nulls instead of reading dead tracks.
- Task 2, Step 3 (manual devtools check) skipped as the plan allowed; Task 4
  covers it headlessly.

**What the plan could have specified better.** It assumed `lgx` on PATH is
the pinned one; a line "run `mise trust` and check `lgx version` first" would
have saved the detour. Otherwise it held up: every pinned version, flag and
port worked first time.
