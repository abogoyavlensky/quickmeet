# Send quickmeet's Traces and Logs to Tracelet: Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan spans three repositories** (`../letgo-packages`, this one, and `../tracelet`, where only a local build and backlog notes are allowed); run it from this repository and use absolute paths or `git -C` for the others. Each repository gets its own branch.

**Goal:** quickmeet staging sends one trace per HTTP request and its warning/error log lines to the Tracelet instance at `https://tracelet.absky.dev`, through a new reusable `otel` package in `letgo-packages` that wraps the Go OpenTelemetry SDK, so the owner can see how Tracelet behaves with a real service.

**Tech Stack:** let-go 1.13.0 via lgx 0.4.2 (`:lg-runtime :built`); a hand-written Go shim ("Shape B", `docs/KNOWLEDGE.md`) over `go.opentelemetry.io/otel`, its SDK, `otlptracehttp`, the log SDK and `otlploghttp`; integrant; uncloud (`uc`) for the staging deploy. Tracelet (`../tracelet`) is the receiver; it accepts OTLP/HTTP **protobuf** at `/v1/traces` and `/v1/logs` with a bearer ingest token, which is what the Go SDK sends by default. OTLP/JSON is out of scope.

---

## Design

### What this delivers

```
quickmeet (staging, uncloud "unison-staging")
  every HTTP request  → a server span "GET /api/rooms/:id", with child spans for the SFU lookups
  warn/error log lines → OTLP log records, correlated to the request's span when there is one
        │  OTLP/HTTP protobuf, gzip, Authorization: Bearer <ingest token>
        ▼
https://tracelet.absky.dev  (project "quickmeet")
        tracelet spans search / traces get / logs search / services
```

This is dogfood, not a published example: the goal is to connect one real project and see how Tracelet behaves. The traffic is low (two-person calls), which is the intended Tracelet use. JSON encoding, metrics, per-SQL-query spans, and forwarding the embedded LiveKit server's own log are out of scope; the last two are listed under "After this" so they are not lost.

### Key decisions

1. **A new package, `otel`, in `letgo-packages`.** Other let-go apps (pagelet, linkboard, unison) can use it, and it follows the repository's rule for new packages with a shim: the shim lives in-tree under `:go/local "shim"` and the release is the package tag alone (`otel-v0.1.0`), exactly like `livekit` (`letgo-packages/README.md`, "In-tree shims"). The coord is `abogoyavlensky/letgo-otel`, the namespace `otel.core`. The shim is Shape B: no generated bindings, because the SDK is configured with options and returns structs and interfaces that lgx's `-opaque-structs` bindings cannot build.

2. **The SDK's own environment variables do the configuration.** `start!` takes an optional map (`:service-name`, `:endpoint`, `:headers`, `:resource`) for defaults and for tests, but **a standard variable always wins over the matching option**, so an application default can never override a production destination or credential. The SDK's explicit options override the environment, so the shim decides **per exporter**: the traces exporter gets the `:endpoint` option only when neither `OTEL_EXPORTER_OTLP_ENDPOINT` nor `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set, the logs exporter only when neither it nor `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is set, and `:headers` follows the same rule with the `_HEADERS` variables. The service name is a resource default, not an option: it is applied *before* the environment is read, so `OTEL_SERVICE_NAME` and `service.name` in `OTEL_RESOURCE_ATTRIBUTES` both override it: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_COMPRESSION`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_SAMPLER`. Those are the names Tracelet's README documents, so the same lines work for any SDK. The one thing the shim adds: **if neither an `:endpoint` option nor `OTEL_EXPORTER_OTLP_ENDPOINT` (or the per-signal `_TRACES_`/`_LOGS_` variants) is set, `start!` returns a working no-op handle** (no exporters, nothing sent). Callers never branch on "is telemetry on"; a laptop, the browser tests and every existing quickmeet test run unchanged.

3. **Opaque handles, explicit parents.** `start-span` returns an opaque span handle; the parent is passed as an argument, never read from a dynamic var. let-go 1.13.0 runs every HTTP handler on one shared dynamic-binding stack (`docs/backlog/letgo-http-handlers-share-dynamic-bindings.md`), so a "current span" kept in a binding would leak between concurrent requests. In quickmeet the request span rides in the request map under `:otel/span`.

4. **The package API (`otel.core`), shared by Tasks 1 and 4.** Handles are opaque. `attrs` is a let-go map with string or keyword keys and string, integer, float or boolean values; anything else is dropped (the shim never throws on a bad attribute).

   | Function | Behaviour |
   |---|---|
   | `(start! opts)` | Build the tracer and logger providers; returns a handle. No-op handle when no endpoint is configured (decision 2). Throws only on a malformed configuration (bad endpoint URL). |
   | `(shutdown! h)` | Flush and stop both providers, waiting at most 5 s. Safe on a no-op handle and when called twice. |
   | `(start-span h name opts)` | `opts`: `:parent` (a span or nil), `:kind` (`:server`, `:client`, `:internal`; default `:internal`), `:attrs`. Returns a span. |
   | `(end-span! span)` | Ends it. Calling it twice is harmless. |
   | `(set-attrs! span attrs)`, `(set-error! span message)` | `set-error!` sets status Error with the message. |
   | `(in-span h name opts f)` | Starts a span (child of `:parent`), calls `(f span)`, ends the span in a `finally`, and on an exception calls `set-error!` with the exception message and rethrows. Returns `f`'s value. A function rather than a macro, so it needs no macro support. |
   | `(log! h level body attrs opts)` | `level` is `:debug`, `:info`, `:warn` or `:error`. `opts`: `:span`, which correlates the record with that span's trace and span ids. |
   | `(trace-id span)`, `(span-id span)` | Lowercase hex, for tests and for printing in logs. |

5. **quickmeet keeps one process-wide handle, in an atom owned by `quickmeet.telemetry`.** An integrant component `:quickmeet.telemetry/otel` starts it and halts it (flushing) and the helper functions read the atom. This is deliberate: warnings are printed in places that have no handle to hand (`quickmeet.push/deliver-one!`), threading one through `push`, `history` and `main` would touch many signatures for no gain, and a dynamic var is ruled out by decision 3. With no handle (the atom is nil, as in unit tests that never start the component) every helper falls through: `in-span` just calls its function, `log!` just prints. The handler map refs the component, as the HTTP server refs the SFU, so telemetry starts before them. **Production does not stop through `ig/halt!` of the whole system**: `system/shutdown!` halts only the HTTP server and the database and leaves the SFU up until `os/exit` (`system.lg`, "What SIGTERM does"), and the telemetry component is a dependency of those, not a dependent, so it would never be flushed. `system.lg` therefore gains `halt-telemetry!`, and `main.lg` calls it as the very last step on every path, after the final message (success, `http/wait` failure, shutdown failure) and before `os/exit`, so queued spans and the shutdown messages are exported. `stop!` (tests) halts everything, telemetry included.

6. **What is recorded, and what is not.** One server span per request, created in a wrapper around each route's `:response` function so the span's name and `http.route` are the route *pattern* (`GET /api/rooms/:id`), never the raw path. Raw paths contain room ids, which in quickmeet are the link that grants entry, and cardinality stays low. Attributes: `http.request.method`, `http.route`, `http.response.status_code`. Status Error for a 5xx or an exception. Not recorded: raw URLs and query strings, cookies, the `Authorization` header, request or response bodies, emails, room ids, push endpoints. The push failure lines need care: the line printed to stdout stays as it is today, but it can carry an exception message from the HTTP client, which can contain the full subscription URL (a credential). The exported record therefore uses its own body, `push to <host> failed` plus ` status <n>` when there is one, and never the exception text; `telemetry/log!` takes the exported text separately from the printed text for this reason. Child spans (kind `:client`) wrap the SFU lookups (`participants`, `active-rooms`), the only calls inside a request that leave the process other than SQLite.

7. **Logs go to both places.** `quickmeet.telemetry/log!` prints the same line to stdout as today (so `uc logs quickmeet-app` is unchanged) and emits the OTLP record, whose body defaults to the printed line and can be given separately (decision 6). The existing `println` sites after startup (`main.lg` shutdown messages, `push.lg` delivery failures, `server.lg` startup line) switch to it. The startup refusal in `main.lg` runs before telemetry exists and stays a plain `println`.

8. **Dependencies (decided with the owner: "new shim for the otel Go lib").** New Go modules in the `otel` shim only: `go.opentelemetry.io/otel`, `.../otel/sdk`, `.../otel/exporters/otlp/otlptrace/otlptracehttp`, `.../otel/log`, `.../otel/sdk/log`, `.../otel/exporters/otlp/otlplog/otlploghttp`. All pure Go (`CGO_ENABLED=0`, which quickmeet's Alpine image needs). Newest at planning time: otel, sdk and the trace exporter v1.47.0, log API and log SDK v1.47.0, the log exporter v0.23.0. Check again with `go list -m -versions <module>` when writing `go.mod`, and note that the log exporter was still pre-1.0 (its API may move; pin it exactly). quickmeet itself gains no Go dependency beyond what the package brings in.

9. **Staging configuration.** `compose.yaml` sets `OTEL_EXPORTER_OTLP_ENDPOINT` (from the GitHub variable `OTEL_EXPORTER_OTLP_ENDPOINT`), `OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf`, `OTEL_EXPORTER_OTLP_COMPRESSION: gzip`, `OTEL_SERVICE_NAME: quickmeet`, `OTEL_RESOURCE_ATTRIBUTES: deployment.environment.name=staging,service.version=${APP_VERSION}`, and `OTEL_EXPORTER_OTLP_HEADERS: secret://otel_headers`. The secret's whole value is `Authorization=Bearer tl_...`, the form Tracelet's README uses. Like the Tracelet deploy, missing values fail the deploy loudly (the `${VAR:?}` form and a guard in `deploy.yml`) rather than silently turning telemetry off. `APP_VERSION` is the short commit SHA, passed from the workflow.

### Tests

- Package (`otel/test/otel/core_test.lg`, run by `lgx test` in `letgo-packages`): a fake OTLP receiver (a let-go `http/start` server on a free port) that records each request's path, `Content-Type`, `Authorization` header and body length. Cases: no endpoint gives a no-op handle that accepts every call and sends nothing; with `:endpoint`, `:headers` and a started-then-ended span plus a log, `shutdown!` makes the receiver see `POST /v1/traces` and `POST /v1/logs` with `application/x-protobuf` and the bearer header; `in-span` returns the function's value, rethrows its exception, and still ends the span; `end-span!` twice and `shutdown!` twice do not throw; `trace-id` is 32 hex characters and a child span shares its parent's trace id (ids compared through `trace-id`/`span-id`). The path assertion matters: an `:endpoint` given as a URL must still reach `/v1/traces`, and the exporter option that takes a full URL can drop that default path.
- quickmeet (`test/quickmeet/telemetry_test.lg`, `routes_test.lg`): helpers are pass-throughs with no handle; the route wrapper passes the response through unchanged, adds the span to the request, and a throwing handler still rethrows; with a real handle pointed at a stub receiver, one request produces one `POST /v1/traces` after `stop!`. Existing tests run unchanged and offline.
- Against the real receiver: the package example and then quickmeet itself run against a local Tracelet (Tasks 2 and 6), and the results are read back with the Tracelet CLI. That is the check that Tracelet accepts what the Go SDK sends, which a fake receiver cannot prove.

### Owner steps (the plan stops and asks at each)

These are outward-facing or write to shared state, so the executor does not do them unasked: merging the `letgo-packages` PR and pushing the tag `otel-v0.1.0` (Task 3); creating the `quickmeet` project and its ingest token on the production Tracelet and setting the GitHub variable and secret (Task 8); merging the quickmeet PR, which deploys staging (Task 8).

### After this (not in the plan)

Per-query SQLite spans (needs the request span passed into `quickmeet.db`, a signature change across the module); forwarding the embedded LiveKit server's logs (needs its logger wired to `otel.core/log!`); OTLP/JSON in Tracelet (the owner is doing that separately); metrics.

## File Structure

In `../letgo-packages` (branch `otel-package`):

- Create: `otel/lgx.edn`: package config; the shim as `:go/local "shim"`, the same dependency block as `livekit/lgx.edn` where relevant.
- Create: `otel/shim/go.mod` and `otel/shim/shim.go`: the Go seam: providers, span and log functions, registration as namespace `otel.shim`.
- Create: `otel/src/otel/core.lg`: the let-go veneer with docstrings (the API table above).
- Create: `otel/test/otel/core_test.lg`: package tests with the fake receiver.
- Create: `otel/example/lgx.edn`, `otel/example/main.lg`: a tiny program that sends one trace and a few logs to whatever `OTEL_EXPORTER_OTLP_*` points at (`:local/root ".."` like `livekit/example`).
- Create: `otel/README.md`: what it is, requirements, use, the env variables, the no-op rule, limits.
- Modify: `README.md`: one row in the package table.

In this repository (branch `tracelet-telemetry`):

- Modify: `lgx.edn`: depend on `abogoyavlensky/letgo-otel` (a `:local/root` while developing, the tag at the end).
- Create: `src/quickmeet/telemetry.lg`: the integrant component, the atom, `in-span`, `log!`, and the route wrapper helper.
- Modify: `src/quickmeet/system.lg`: the component in the config map and a ref from the handler.
- Modify: `src/quickmeet/routes.lg`: wrap each route's `:response`; child spans around the SFU lookups.
- Modify: `src/quickmeet/push.lg`, `server.lg`, `main.lg`: switch the post-startup `println` sites to `telemetry/log!`.
- Create: `test/quickmeet/telemetry_test.lg`; modify `test/quickmeet/routes_test.lg`.
- Modify: `compose.yaml`, `.github/workflows/deploy.yml`: the staging configuration (decision 9).
- Modify: `docs/CONFIGURATION.md`, `docs/DEPLOYMENT.md`, `docs/KNOWLEDGE.md`: the variables, the staging setup, and what was learned about the otel package.

## Task 1: The `otel` package in letgo-packages

Work in `/home/agent/Projects/letgo-packages`. Read `livekit/lgx.edn`, `livekit/shim/shim.go` (registration with `rt.RegisterNS`, `vm.MustBox`, `ToGo` for let-go maps and `asMap`, opaque handle types) and `livekit/test/livekit/core_test.lg` first, and copy their conventions.

**Files:**
- Create: `otel/lgx.edn`, `otel/shim/go.mod`, `otel/shim/shim.go`, `otel/src/otel/core.lg`, `otel/test/otel/core_test.lg`

- [x] **Step 1: Branch**
  `git -C /home/agent/Projects/letgo-packages switch -c otel-package` from `master`.

- [x] **Step 2: Write the failing tests first**
  Write `otel/test/otel/core_test.lg` for the cases listed under "Tests", with the fake receiver as a helper in the test file. Receiver handler: records `{:path :content-type :authorization :bytes}` in an atom and returns 200 with an empty body (an empty body is a valid OTLP/HTTP protobuf success response). let-go lowercases header names. Start it with `(http/start handler "127.0.0.1:0")` and read the port from the returned record, as `quickmeet`'s `system_test.lg` does. Use `:endpoint (str "http://127.0.0.1:" port)` and `:headers {"Authorization" "Bearer tl_test"}`.
  Run: `cd otel && lgx test`
  Expected: FAIL (the namespace does not exist yet).

- [x] **Step 3: Write `otel/lgx.edn` and `otel/shim/go.mod`**
  Same shape as `livekit/lgx.edn`: `:paths ["src"]`, `:lg-runtime :built`, `:lg-version "1.13.0"`, the shim as `github.com/abogoyavlensky/letgo-packages/otel/shim {:go/local "shim"}`. No `:go/replace` block is needed (that was for LiveKit's pion forks). `go.mod`: module `github.com/abogoyavlensky/letgo-packages/otel/shim`, `go 1.26` (raise it if the SDK's `go.mod` demands more), `require github.com/nooga/let-go v0.0.0` as the other shims do (the placeholder is deliberate, see the repository README), plus the six OpenTelemetry modules from decision 8 at the versions you looked up.

- [x] **Step 4: Write `otel/shim/shim.go`**
  Types: `Handle` (tracer provider, logger provider, tracer, logger, a flag for no-op) and `Span` (the SDK span plus the `context.Context` that carries it, which is how a child gets its parent and how a log record is correlated). Behaviour per the API table. Details that are easy to get wrong:
  - `Start(opts vm.Value)`: read `:service-name`, `:endpoint`, `:headers`, `:resource` from the map. Decide "configured" by an `:endpoint` option or any of `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`; otherwise return the no-op handle (a tracer from `noop`/an unexported provider is fine; all later functions check the flag).
  - Exporters: construct them with no endpoint option so the SDK reads the environment, and add an explicit option only when the corresponding `opts` key is present **and** that exporter's own two environment variables, the common one and its signal-specific one, are both unset (decision 2; evaluate it separately for the traces and the logs exporter). Add a test for it: with `OTEL_EXPORTER_OTLP_ENDPOINT` pointing at the fake receiver and a different `:endpoint` option, the receiver named by the variable gets the request. If let-go cannot set environment variables in a test, put the precedence rule in a small Go function the test of Step 6 reaches by another route, or record in the plan's outcome that it was checked by hand with the example. For an explicit `:endpoint`, use the host-and-port option plus `WithInsecure` for an `http://` URL so the exporter appends its default `/v1/traces` and `/v1/logs`; do not use the option that takes a full URL unless a test proves the default path survives.
  - Resource: `resource.New` with the `:service-name` default first (`WithAttributes(semconv.ServiceName(...))`), then `WithFromEnv()` and `WithTelemetrySDK()` after it, so later sources win: `OTEL_SERVICE_NAME` and a `service.name` inside `OTEL_RESOURCE_ATTRIBUTES` both override the option. (Check that `WithFromEnv()` handles `OTEL_SERVICE_NAME` in the SDK version pinned; if it does not, apply it explicitly after.) `OTEL_RESOURCE_ATTRIBUTES` therefore sets `deployment.environment.name` and `service.version`, which Tracelet files records under.
  - Use a batching span processor and a batching log processor (the SDK defaults). `Shutdown` runs both with a 5 s context and returns the first error as a string-less nil/err so a failing flush is a log line, not a crash. Mark the handle shut down so the second call is a no-op.
  - Install an error handler (`otel.SetErrorHandler`) that prints `otel: <error>` to stderr, so a bad token or a wrong endpoint shows up in `uc logs` instead of failing silently. Do it once per process.
  - `StartSpan(h, name, optsVal)`: kind from `:kind`, attributes from `:attrs`, parent context from `:parent` (nil means a new root). `Log`: map `:debug`/`:info`/`:warn`/`:error` to the log severities, set the body and attributes, emit with the span's context when `:span` is given.
  - Attribute conversion: string, bool, integer and float values only; skip everything else.
  - Register as namespace `otel.shim` in `init()`, as `livekit.shim` is.

- [x] **Step 5: Write `otel/src/otel/core.lg`**
  The veneer: docstrings for every function in the API table, `in-span` built from `start-span`, `try`/`finally`, `set-error!` and `end-span!`. Keep Go-shaped things out of it.

- [x] **Step 6: Run the tests**
  Run: `cd /home/agent/Projects/letgo-packages/otel && lgx test`
  Expected: PASS. The first run builds a runtime that links the SDK and takes a while; later runs are cached. If the path assertion fails (`/` or an empty path instead of `/v1/traces`), fix the exporter options as described in Step 4.

- [x] **Step 7: Commit**
  `git -C /home/agent/Projects/letgo-packages add otel && git -C /home/agent/Projects/letgo-packages commit -m "otel: traces and logs over OTLP/HTTP through the Go SDK"`

## Task 2: Run the package against a real Tracelet

A fake receiver proves what the package sends; only Tracelet proves it accepts it. Work in `letgo-packages`, reading the Tracelet repository (`../tracelet`) only to build and run it.

**Files:**
- Create: `otel/example/lgx.edn`, `otel/example/main.lg`, `otel/README.md`
- Modify: `README.md`

- [x] **Step 1: The example**
  `otel/example/main.lg` starts the package with `{:service-name "otel-example"}`, runs `in-span` with a child span inside it, logs one info and one error line (the error one correlated to the span), calls `shutdown!` and prints the root span's trace id. `otel/example/lgx.edn`: like `livekit/example/lgx.edn` with `abogoyavlensky/letgo-otel {:local/root ".."}` and a `bin/app` target.

- [x] **Step 2: Start a local Tracelet**
  Run: `cd /home/agent/Projects/tracelet && rite build && mkdir -p /tmp/tracelet-dogfood && ./bin/tracelet serve --data-dir /tmp/tracelet-dogfood --addr :18080` (the build writes only gitignored files into that checkout; if `/tmp` is full, use a directory under `/home/agent/.cache`) in the background (check `tracelet serve --help` for the flag names; a binary built on this machine runs fine locally, only the Docker image has the glibc limit). It prints an admin token on stderr once. Then:
  `export TRACELET_URL=http://localhost:18080 TRACELET_TOKEN=<admin token>`
  `./bin/cli/tracelet projects create quickmeet --name quickmeet` (build the CLI with `rite build-cli` if `bin/cli/tracelet` is missing) and `./bin/cli/tracelet tokens create --project quickmeet --scope ingest --name dogfood` (prints the ingest token once).

- [x] **Step 3: Send from the example**
  Run: `cd /home/agent/Projects/letgo-packages/otel/example && OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:18080 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <ingest token>" OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=local,service.version=0.0.1" lgx run`
  Expected: it prints a trace id and exits 0; the Tracelet server log shows no error.

- [x] **Step 4: Read it back**
  Run, with the trace id from Step 3:
  `tracelet services --project quickmeet --last 10m` (expect `otel-example` with log and span counts),
  `tracelet traces get <trace id> --project quickmeet` (expect the root span with its child, as a tree),
  `tracelet logs search --project quickmeet --service otel-example --last 10m` (expect both lines, the error one carrying the trace id).
  Expected: all three match what the example sent. If the bearer header is rejected, check how the Go SDK parses `OTEL_EXPORTER_OTLP_HEADERS` (it percent-decodes values; a space inside `Bearer tl_...` may need to be `%20`). That is a finding for the Tracelet and quickmeet docs: record it in the package README and in Task 8's observations, and use whichever form works everywhere.

- [x] **Step 5: README**
  `otel/README.md`: what it is, requirements (lgx 0.4.2, let-go 1.13.0, Go, no C toolchain), a usage snippet, the API in one table, the variables from decision 2, the no-op rule, the "explicit parents" rule and why (the dynamic-binding bug), and that the log exporter is pre-1.0. Add the package's row to the root `README.md`.

- [x] **Step 6: Commit**
  `git -C /home/agent/Projects/letgo-packages add -A && git -C /home/agent/Projects/letgo-packages commit -m "otel: example, README, and the package table row"`

## Task 3: Release the package (owner go-ahead needed)

> Deferred: the owner asked that nothing be pushed for now, so no PR, merge or tag. `letgo-packages` branch `otel-package` holds two local commits (`5d58456`, `e5b1755`). Tasks 4 to 6 use `:local/root`; Task 7 Step 1 (the tag coordinate) stays open until the tag exists.

- [ ] **Step 1: PR**
  Push `otel-package` and open a PR against `master` in `abogoyavlensky/letgo-packages`. CI (`test.yml`) runs `lgx test` for the changed package. Expected: green. Link the PR with `link_pull_request` if that tool is available.

- [ ] **Step 2: Stop and ask the owner** to merge it and to say go for pushing the tag. Do not merge or tag without that.

- [ ] **Step 3: Tag**
  After the merge, on the merge commit: `git tag otel-v0.1.0 && git push origin otel-v0.1.0`. A package with an in-tree shim releases with the package tag alone; there is no Go module tag and no coord to flip (`letgo-packages/README.md`, "In-tree shims"). Never move or delete a pushed tag; fix forward with `otel-v0.1.1`.
  Expected: `git ls-remote --tags origin otel-v0.1.0` lists it.

## Task 4: quickmeet's telemetry namespace

Work in `/home/agent/Projects/quickmeet`. Read `src/quickmeet/db.lg` (the integrant component pattern), `src/quickmeet/system.lg` and `test/quickmeet/system_test.lg` first.

**Files:**
- Create: `src/quickmeet/telemetry.lg`, `test/quickmeet/telemetry_test.lg`
- Modify: `lgx.edn`, `src/quickmeet/system.lg`

- [x] **Step 1: Branch and dependency**
  `git -C /home/agent/Projects/quickmeet switch master && git -C /home/agent/Projects/quickmeet switch -c tracelet-telemetry`. In `lgx.edn` add `abogoyavlensky/letgo-otel {:local/root "../letgo-packages/otel"}` with a comment that it becomes the tag in Task 7. (Tasks 4 to 6 need only the working tree; if Task 3's tag already exists you may use it from the start and skip the flip in Task 7.)

- [x] **Step 2: Write the failing tests**
  `test/quickmeet/telemetry_test.lg`: with no component started (the atom nil), `in-span` calls its function and returns its value, and rethrows its exception; `log!` prints the line and returns nil without throwing. With the component started against a stub receiver (the same helper as the package test), one `in-span` plus one `log!` followed by `ig/halt!` makes the receiver see a `POST /v1/traces` and a `POST /v1/logs`. After halt the atom is nil again, so a second system in the same process starts clean.
  Run: `lgx test`
  Expected: the new tests FAIL; all existing tests still run (they should not notice the dependency).

- [x] **Step 3: Write `src/quickmeet/telemetry.lg`**
  - `(defmethod ig/init-key ::otel [_ opts])` calls `otel/start!` with `opts` (`{:service-name "quickmeet"}` plus anything the tests pass) and resets the atom to the handle; `ig/halt-key!` clears the atom first, then `shutdown!`s, so nothing logs into a handle that is shutting down.
  - `in-span` (name, an options map, function; the options are those of `otel.core/start-span` plus `:parent`, which may be a request map carrying `:otel/span`, a span, or nil) and `log!` (level, message, attrs, and an options map with `:span` and `:export-message`): both read the atom; a nil handle means call through / print only. `log!` prints exactly the line the old `println` printed (`quickmeet: ...`); the exported body is `:export-message` when given, else the printed line.
  - `wrap-route`: given a route map, returns it with `:response` replaced by a function that starts a `:server` span named `<METHOD> <pattern>` (method uppercase; the pattern is the route's `:path`, `:not-found` for the catch-all), with `http.request.method` and `http.route`; calls the original with the request plus `:otel/span`; sets `http.response.status_code`; marks the span an error for a status of 500 or above or for an exception (rethrown); ends the span in a `finally`. With no handle it must return the original `:response` untouched, so the no-telemetry path adds no work.

- [x] **Step 4: Wire it in `system.lg`**
  Add `:quickmeet.telemetry/otel {}` to the config map and `:telemetry (ig/ref :quickmeet.telemetry/otel)` to the `:quickmeet.routes/handler` map (a dependency edge only, as `:livekit` is for the server). Use `{:service-name "quickmeet"}` as the component's opts. Add `(defn halt-telemetry! [system])`, which halts only `:quickmeet.telemetry/otel` (`(ig/halt! system [:quickmeet.telemetry/otel])` would also halt its dependents, the handler and the server, which are already stopped by then and which `http/stop` tolerates; check that in the test). Add a test that mirrors `main.lg`: `shutdown!` then `halt-telemetry!`, against a stub receiver, and the receiver sees the traces and logs request. That is the production path; the `ig/halt!` test alone does not cover it. Check that `system/config`'s docstring and the tests that compare the config map still agree.

- [x] **Step 5: Run the tests**
  Run: `lgx test`
  Expected: PASS, including the existing suites.

> Deviation: added `otel/enabled?` to the package (commit `c664e3e` on `otel-package`). `start!` returns a no-op handle when nothing is configured, so "no handle" cannot be told from "handle that exports nothing"; the component keeps the atom nil for a no-op handle so the spec's fall-through (and `wrap-route` returning the route untouched) holds. Additive; no other task's interface changes.
> (Task 5 note: the production-path test briefly made its own span, because requests only produce spans once Task 5 wraps the routes; it now relies on the real request.)

- [x] **Step 6: Commit**
  `git -C /home/agent/Projects/quickmeet add -A && git -C /home/agent/Projects/quickmeet commit -m "Add the telemetry component over the otel package"`

## Task 5: Instrument requests, SFU calls and log lines

**Files:**
- Modify: `src/quickmeet/routes.lg`, `src/quickmeet/push.lg`, `src/quickmeet/server.lg`, and `main.lg` (at the repository root)
- Test: `test/quickmeet/routes_test.lg`

- [x] **Step 1: Failing tests**
  In `routes_test.lg`: the existing handler tests keep passing unchanged (no handle). Add one with a started telemetry component and a stub receiver: a request through `handler` produces a span named `GET /api/rooms/:id` (assert on the exported request count after halt; names, status codes and parenting are checked by reading the data back from a real Tracelet in Task 6, since the let-go side cannot decode protobuf), and a request to an unknown path is named with the `:not-found` route. If the handler is hard to exercise this way, test `wrap-route` directly in `telemetry_test.lg` and keep one system-level request in `system_test.lg`.

- [x] **Step 2: Wrap the routes**
  In `routes.lg`, `handler` builds `table` from `routes`; map `telemetry/wrap-route` over it before `r/route` sees it. The wrapper must not change a route's `:path` or `:method`. Confirm ruuter still matches (routes with and without `:method`).

- [x] **Step 3: Child spans for the SFU lookups**
  The lookups are `participants` and `active-rooms`, called at about `routes.lg:485` (`GET /api/rooms`), `:522` and `:538` (`GET /api/rooms/:id` and the token route), and through `in-room?` at `:312`/`:571` (the ring route). At each call site, where `req` is in scope, wrap the call in `telemetry/in-span` named `sfu.participants` or `sfu.active-rooms`, options `{:kind :client :parent req}`. `in-room?` takes the lookup function; pass it a function that already closes over the request's span rather than adding a parameter if that is smaller. The lookups must still return exactly what they returned.

- [x] **Step 4: Switch the log lines**
  `push.lg` (the two failure lines in `deliver-one!`, level `:warn`, attrs `{:push.host host}`, with `:export-message` set to `push to <host> failed` plus `status <n>` for the status case and never the exception text), `server.lg` (the startup line, `:info`), `main.lg` (the three shutdown lines: `:info` for "shutting down", `:error` for the failures). `main.lg:18`, the configuration refusal at startup, stays a `println`. The printed text does not change. Restructure the end of `-main` so `halt-telemetry!` runs last on every path, after the final message and before `os/exit` (decision 5). Add a test that a push failure whose exception message contains a URL exports a body without it (stub the `:send!` that throws).

- [x] **Step 5: Run everything**
  Run: `lgx test`
  Expected: PASS. Then `lgx e2e` (the browser suite, which also checks the page still serves with telemetry off). Expected: PASS. If `e2e` cannot run on this machine, say so and rely on CI.

- [x] **Step 6: Commit**
  `git -C /home/agent/Projects/quickmeet add -A && git -C /home/agent/Projects/quickmeet commit -m "Trace requests and SFU calls, and export warnings and errors"`

## Task 6: Run quickmeet against a local Tracelet

The check that matters before staging: a real quickmeet, a real call path, a real Tracelet.

- [x] **Step 1: Start the pieces**
  Reuse the local Tracelet from Task 2 (restart it if it is gone; its data directory, outside the Tracelet checkout, keeps the project and the ingest token). Run quickmeet from `/home/agent/Projects/quickmeet`:
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:18080 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <ingest token>" OTEL_SERVICE_NAME=quickmeet OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=local,service.version=dev" CGO_ENABLED=0 lgx run`
  Expected: quickmeet starts as before and prints its usual lines; no `otel:` error lines.

- [x] **Step 2: Generate traffic**
  With `curl` against `http://localhost:8080`: sign up (`POST /api/auth/signup`), create a room (`POST /api/rooms` with the session cookie), read it (`GET /api/rooms/<id>`), request a join token (`POST /api/rooms/<id>/token`), hit a missing path, and post a bad body to provoke a 4xx. See `docs/API.md` for the request shapes. Then stop quickmeet with Ctrl-C (SIGINT) so the batch flushes.

- [x] **Step 3: Read it back**
  `tracelet services --project quickmeet --last 15m` (expect `quickmeet`);
  `tracelet spans search --project quickmeet --service quickmeet --root --last 15m` (expect one root span per request, named by route pattern, with the status codes);
  `tracelet traces get <id of the GET /api/rooms/:id trace> --project quickmeet` (expect the request span with `sfu.participants` below it);
  `tracelet logs search --project quickmeet --service quickmeet --last 15m` (expect the "shutting down" line).
  Expected: all present, with `deployment.environment.name=local`. Check that no raw room id appears in any span name or in `http.route` (it may appear nowhere in the data).

- [x] **Step 4: Look at what you see**
  Write down, in a scratch note for Task 8, anything that felt wrong in Tracelet: a missing field, a confusing output, a slow query, anything the CLI could not answer. That is the point of the exercise.

> Task 6 result (local Tracelet `b3b9f8a`, quickmeet built with `lgx build` and stopped with SIGINT): 9 root spans, one per request, named by route pattern (`GET /api/rooms/:id`, `GET :not-found`, ...), with `http.route` and `http.response.status_code`; `GET /api/rooms/:id` and `POST /api/rooms/:id/ring` each had an `sfu.participants` child (`GET /api/rooms` had none in the data because its lookup returned inside the same span only when called, see below); the "on http://localhost:8080" and "shutting down" lines arrived as logs; `deployment.environment.name=local` and `service.version=dev` were on every record. Neither the room id nor the raw missing path appears anywhere in the data. Health after the run: 23 rows accepted, 0 rejected, 0 duplicates.
>
> Observations for Task 8 (what felt wrong in Tracelet, all minor):
> - `spans search` and `traces get` print no attributes and no status message: a span in `error` shows only the word, and its reason (`status_message`) and `http.response.status_code` are visible only with `--json`.
> - `logs search` prints no trace id or attributes either, so correlation needs `--json`.
> - In `--json` output `kind` and `status_code` are bare numbers (2, 2), not names.
> - A malformed JSON body on `POST /api/auth/signup` made the handler throw: the request span was marked `error` with the parser's message, and the client got a 500. That is quickmeet's existing behaviour, not caused by this plan; filed in `docs/backlog/`.


## Task 7: Staging configuration, docs, and the release coordinate

**Files:**
- Modify: `lgx.edn` (only if still `:local/root`), `compose.yaml`, `.github/workflows/deploy.yml`, `docs/CONFIGURATION.md`, `docs/DEPLOYMENT.md`, `docs/KNOWLEDGE.md`

- [ ] **Step 1: The coordinate**
  If `lgx.edn` still points at `:local/root`, change it to `{:git/url "https://github.com/abogoyavlensky/letgo-packages" :git/tag "otel-v0.1.0" :deps/root "otel"}` (Task 3 must be done). One `lgx test` run proves the tag resolves.
  Run: `lgx test`
  Expected: PASS.

- [ ] **Step 2: `compose.yaml`**
  Add the environment from decision 9 to the `quickmeet-app` service, with a comment saying what each is for and that the headers secret holds `Authorization=Bearer <ingest token>`. Add `secrets: otel_headers: x-command: printenv OTEL_EXPORTER_OTLP_HEADERS`. Use `${OTEL_EXPORTER_OTLP_ENDPOINT:?...}` and `${APP_VERSION:?...}` so a missing value fails the load.

- [ ] **Step 3: `deploy.yml`**
  In the "Build and deploy" step's `env`, add `OTEL_EXPORTER_OTLP_ENDPOINT: ${{ vars.OTEL_EXPORTER_OTLP_ENDPOINT }}`, `OTEL_EXPORTER_OTLP_HEADERS: ${{ secrets.OTEL_EXPORTER_OTLP_HEADERS }}` and `APP_VERSION: ${{ github.sha }}` (use the first 7 characters: compute it in the step). Add the same kind of guard Tracelet's deploy has: `: "${OTEL_EXPORTER_OTLP_HEADERS:?the OTEL_EXPORTER_OTLP_HEADERS secret must be set}"` before the `uc deploy` line, because `printenv` passes an empty secret.

- [ ] **Step 4: Offline check of the compose file**
  Same method as the Tracelet plan used: clone uncloud at the version in `.mise.toml` into `.tmp/uncloud`, add a scratch test under `pkg/client/compose/` that loads `compose.yaml` with the variables set and prints the service spec, and check the new environment and the secret; then with `OTEL_EXPORTER_OTLP_ENDPOINT` unset, loading must fail. Set `GOTMPDIR` to a directory off `/tmp` if the build hits a disk quota, and run with `-count=1` so Go does not replay a cached result. Delete the clone afterwards. Note whether `x-command` runs through a shell (the Tracelet secret relies on plain `printenv`, which works either way).

- [ ] **Step 5: Docs**
  `docs/CONFIGURATION.md`: a table of the OTEL variables (all optional, telemetry off without an endpoint) and a sentence on what is recorded and what is not (decision 6). `docs/DEPLOYMENT.md`: the staging variable and secret, and how to read the data from Tracelet. `docs/KNOWLEDGE.md`: the `otel` package (what it wraps, the no-op rule, explicit parents and why, the log exporter being pre-1.0), under the existing package notes. Use /writing-clearly if available.

- [ ] **Step 6: Run the checks and commit**
  Run: `lgx test`. Expected: PASS.
  `git -C /home/agent/Projects/quickmeet add -A && git -C /home/agent/Projects/quickmeet commit -m "Configure staging to send telemetry to Tracelet"`

## Task 8: Staging (owner steps), then look at it

- [ ] **Step 1: PR**
  Push `tracelet-telemetry` and open a PR against `master`. The body lists, under "Before merging": the GitHub variable `OTEL_EXPORTER_OTLP_ENDPOINT` (`https://tracelet.absky.dev`) and the secret `OTEL_EXPORTER_OTLP_HEADERS` (`Authorization=Bearer <ingest token>`). Expected: CI green.

- [ ] **Step 2: Stop and ask the owner** to do these, in order. The executor must not create these on the production Tracelet itself without being handed the admin token for that purpose:
  1. create the project and an ingest token on production: `TRACELET_URL=https://tracelet.absky.dev TRACELET_TOKEN=<admin token> tracelet projects create quickmeet --name quickmeet` and `tracelet tokens create --project quickmeet --scope ingest --name "quickmeet staging"`;
  2. set the variable and the secret above on the quickmeet repository;
  3. merge the PR (it deploys staging).

- [ ] **Step 3: Watch the deploy**
  `gh run watch` the `deploy` run. Expected: `uc deploy` succeeds and the app is healthy. Then use staging for a minute (open the site, create a room, join from two browsers or run `lgx smoke` with the `QM_*` variables from `e2e/smoke.mjs`).

- [ ] **Step 4: Read it back from production**
  With the owner's Tracelet access (`TRACELET_URL=https://tracelet.absky.dev`, a read or admin token): `tracelet services --project quickmeet --last 30m`, `tracelet spans search --project quickmeet --root --last 30m`, `tracelet traces get <id> --project quickmeet`, `tracelet logs search --project quickmeet --last 30m`. Expected: staging's requests appear with `deployment.environment.name=staging` and the deployed short SHA as `service.version`. Check `https://tracelet.absky.dev/api/v1/health` for `accepted_rows`, `rejected_rows`, `duplicate_spans` and `last_flush_error`, and, after the first hourly flush, that cold files appear.

- [ ] **Step 5: Observations**
  Add a short "Outcome" note at the end of this plan: run IDs, what worked, what felt wrong in Tracelet (from Task 6 Step 4 and this one), the request volume Tracelet saw, and anything to change in the `otel` package. For each real Tracelet gap or bug, write a backlog entry in `../tracelet/docs/backlog/` following that repository's AGENTS.md (one file, `**Status: open**`, its own commit titled `Backlog: <what>`), on a branch `backlog-quickmeet-dogfood` created there; do not push it or touch Tracelet's `master`, and tell the owner which entries exist. Those backlog files are the only writes this plan makes in `../tracelet`. Do not fix Tracelet in this plan.

## Completion

Mark the plan done in this file: check off the steps, add the summary the executing-plans skill asks for, and set `docs/backlog/` statuses only if an entry here was resolved (none are expected).
