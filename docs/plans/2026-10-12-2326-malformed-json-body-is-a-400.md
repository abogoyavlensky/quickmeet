# A Malformed JSON Body Is a 400: Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** A request body that is not valid JSON gets `400 {"error": "invalid JSON"}` instead of a 500, and no longer shows up as a server error in telemetry.

**Tech Stack:** let-go via lgx (`lgx test`), ruuter routes, `clojure.test`. Backlog entry: `docs/backlog/malformed-json-body-is-a-500.md`.

---

## Design

### The problem

`read-json-body` (`src/quickmeet/routes.lg:112`) calls `json/read-json` with no
`try`, so a body like `not json` throws. `telemetry/wrap-route` sees the
exception, marks the request span an error, logs
`quickmeet: POST /api/auth/signup failed: invalid character 'o' ...` at
`:error`, and rethrows; let-go answers 500 with the error text. Seven routes
read a body through it: sign-up, sign-in, `POST /api/me`, rename
(`POST /api/rooms/:id`), token (`POST /api/rooms/:id/token`), push
subscribe and push unsubscribe.

Verified with `lg`: `json/read-json` throws for `not json`, for a truncated
object (`{"a":`) and for trailing garbage (`{"a":1} trailing`); `ex-info` /
`ex-data` round-trip through `try`/`catch Exception` as in Clojure.

### Approach

Two small pieces in `routes.lg`, one catch for every route:

1. **`read-json-body` signals a bad body.** It wraps the parse in `try`; on
   failure it throws `(ex-info "invalid JSON" {::invalid-json true})`. A
   blank body still returns nil, as now.
2. **`answer-invalid-json`, a route wrapper** (route map in, route map out,
   like `telemetry/wrap-route`). It runs the route's `:response` in `try`;
   an exception whose `ex-data` has `::invalid-json` becomes
   `(json-response 400 {:error "invalid JSON"})`, anything else is rethrown
   unchanged.
3. **`handler` applies it inside telemetry:**
   `(mapv (comp telemetry/wrap-route answer-invalid-json) (routes ...))`.
   `comp` applies `answer-invalid-json` first, so `wrap-route` wraps the
   already-converted route: it sees a plain 400 response, not an exception,
   so the span is not an error and no `:error` line is logged.

### Key decisions

- **Throw-and-catch-once, not a check in each handler.** The handlers
  destructure the body inline (`(let [{:keys [email password]} (read-json-body req)] ...)`);
  returning a sentinel would need a branch in all seven. Throwing a tagged
  `ex-info` keeps every handler unchanged and covers any future route that
  reads a body.
- **The catch sits inside telemetry's wrapper**, not around `r/route` in
  `handler`: a catch outside `wrap-route` would come after it had already
  logged the error, which is the noise this removes.
- **The message is fixed, `"invalid JSON"`**, never the parser's text, as
  the backlog asks.
- **Order inside handlers is unchanged.** The 400 comes wherever the body
  is read: after the content-type check (415), the rate limit (429), the
  session check (401) and the owner check, so those still answer first.
  On the token route, a missing room and a full room are checked before
  the body is read, so they still answer 404 and 409.
- **The webhook route is left alone.** It parses with `json/read-json`
  directly, and only after the SFU's signature over the body has been
  verified; a malformed signed body is a real fault and should stay a 500.

### Testing

One `deftest` in `test/quickmeet/routes_test.lg` sends `not json`
(content-type `application/json`) to each of the seven routes, with
whatever the route needs to reach its body read (a session cookie, a room
the caller owns), and checks: status 400, `{:error "invalid JSON"}`, and
the body does not contain the parser's text (`invalid character`). A second
check, in the style of `a-handler-that-throws-is-an-error-line-by-pattern`,
captures output with `with-out-str` for one route and asserts no
`failed:` line is printed. The existing tests cover the blank-body and
valid-body paths.

## File Structure

- Modify: `src/quickmeet/routes.lg` — `read-json-body` throws a tagged
  `ex-info`; new `answer-invalid-json` wrapper; `handler` composes it.
- Modify: `test/quickmeet/routes_test.lg` — the new test.
- Modify: `docs/backlog/malformed-json-body-is-a-500.md` — status.

### Task 1: Mark the backlog entry planned

**Files:**
- Modify: `docs/backlog/malformed-json-body-is-a-500.md`

- [x] **Step 1:** Replace `**Status: open**` with `**Status: planned**`
  and, on the next line, `Plan: docs/plans/2026-10-12-2326-malformed-json-body-is-a-400.md`.
- [x] **Step 2:** Commit together with this plan:
  `git commit -m "Plan: a malformed JSON body is a 400"`

### Task 2: The failing test

**Files:**
- Test: `test/quickmeet/routes_test.lg`

- [x] **Step 1: Write the test** `a-malformed-json-body-is-a-400`, placed
  after `account-endpoints-take-json-only`. Inside `with-handler`, sign a
  user up (`signup`), make a room as them (`POST /api/rooms` with
  `(as cookie)`), then call each route with body `"not json"` via `call`
  (which sets content-type `application/json` when a body is given):
  - `POST /api/auth/signup`, `POST /api/auth/signin` — no cookie
  - `POST /api/me`, `POST /api/rooms/<id>`, `POST /api/push/subscriptions`,
    `POST /api/push/unsubscribe` — with `(as cookie)`
  - `POST /api/rooms/<id>/token` — no cookie needed (default lookups say
    the room is empty)

  For each, `(is (= 400 (:status res)) path)`,
  `(is (= {:error "invalid JSON"} (:json res)) path)` and
  `(is (not (str/includes? (:body res) "invalid character")) path)`.
  Also send sign-up a truncated object (`{"email":`) and an object with
  trailing garbage (`{"email":"a@b.c"} x`) and expect the same 400.
  Then, for sign-up, wrap the call in `with-out-str` and assert the output
  does not include `"failed:"`.

- [x] **Step 2: Run it to make sure it fails**
  Run: `lgx test`
  Expected: the new test fails (the calls throw, the test errors); every
  other test passes.

### Task 3: Answer 400

**Files:**
- Modify: `src/quickmeet/routes.lg`

- [x] **Step 1:** In `read-json-body`, wrap `json/read-json` in `try`;
  `(catch Exception _ (throw (ex-info "invalid JSON" {::invalid-json true})))`.
  Add a short comment: a body that is not JSON is the client's mistake;
  `answer-invalid-json` turns this into a 400.
- [x] **Step 2:** Add `answer-invalid-json` (private, next to
  `read-json-body`): `[route]` → `route` with `:response` replaced by a fn
  that calls the original in `try` and, in `catch Exception e`, returns
  `(json-response 400 {:error "invalid JSON"})` when
  `(::invalid-json (ex-data e))`, else `(throw e)`. Docstring says it must
  sit inside `telemetry/wrap-route` so a bad body is not logged as an error.
- [x] **Step 3:** In `handler`, change
  `(mapv telemetry/wrap-route (routes ...))` to
  `(mapv (comp telemetry/wrap-route answer-invalid-json) (routes ...))`.
- [x] **Step 4: Run the tests**
  Run: `lgx test`
  Expected: all pass, the new one included.
- [x] **Step 5: Check by hand**
  Run the app (`lgx run`, see `docs/DEVELOPMENT.md`), then
  `curl -s -w '\n%{http_code}\n' -X POST localhost:<port>/api/auth/signup -H 'Content-Type: application/json' -d 'not json'`
  Expected: `{"error":"invalid JSON"}` and `400`; no `failed:` line in the
  app's output.
- [x] **Step 6: Commit**
  `git commit -m "A malformed JSON body is a 400, not a 500"`

### Task 4: Close the backlog entry

**Files:**
- Modify: `docs/backlog/malformed-json-body-is-a-500.md`

- [x] **Step 1:** Replace the planned status and plan line with
  `**Status: done**` and a line saying where it landed:
  `Landed in "A malformed JSON body is a 400, not a 500" (src/quickmeet/routes.lg, answer-invalid-json).`
- [x] **Step 2: Commit**
  `git commit -m "Backlog: a malformed JSON body is done"`

## Completion

Done. `read-json-body` throws a tagged `ex-info`; `answer-invalid-json` turns it into
`400 {"error":"invalid JSON"}` inside `telemetry/wrap-route`, so no span error and no
`failed:` line. New test `a-malformed-json-body-is-a-400` covers all seven routes, a
truncated body, trailing garbage and the no-log check. Full suite: 99 tests, 0 failures;
manual `curl` against `lgx run` gave `{"error":"invalid JSON"}` / 400. Codex review: no findings.

Issues: the shell's `lgx` resolves to 0.1.2, but the project pins 0.4.2, so `lgx test` fails
on `lgx.edn`; run it as `mise exec -- lgx test`. `participants-of-an-unknown-room` failed once
with an SFU connection reset and passed on three reruns (flaky, unrelated).

Deviations: none.

What the plan could have specified better: it didn't mention that `lgx` needs to be run through
`mise exec --` in this environment.
