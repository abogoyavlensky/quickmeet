# Pagination for Rooms and History, Sign Out Everywhere Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The room list and the call history are served and shown a page at a time, and every signed-in page has the Sign out button the landing page has.

**Status: completed** (2026-10-02, branch `pagination-and-sign-out`)

**Tech Stack:** let-go 1.13.0 (`src/quickmeet/*.lg`), HoneySQL over sqlite, ruuter, plain JavaScript pages in `resources/public/`, `lgx test`, Playwright (`lgx e2e`).

---

## Design

### The problem

`GET /api/rooms` and `GET /api/calls` return everything the user has, and
the pages render all of it. History only grows; the room list grows with
every "New call". The landing page also re-fetches the whole room list every
five seconds.

Separately, the top bar on `/history` (and on `/settings`) has no Sign out
button; only the landing page has one.

### Pagination

**Offset pages, one size, decided by the server.** Both endpoints take
`?page=N` (1-based) and return 20 items per page. The page size is one
private constant in `routes.lg`; the client never sends it.

**Response shape.** Both endpoints change from a bare array to an object:

```
GET /api/rooms?page=2 -> 200 {"items": [room, ...], "page": 2, "more": true}
GET /api/calls?page=2 -> 200 {"items": [call, ...], "page": 2, "more": false}
```

- `items` holds what the array held before, unchanged per item.
- `page` is the page actually served.
- `more` says whether an older page exists. The query asks for 21 rows
  (`limit` = size + 1, `offset` = (page − 1) × size); 21 rows back means
  `more`, and only the first 20 are returned. No `count(*)`, no total:
  the pager is Newer/Older, not numbered.

**Reading `page`.** The request map carries the raw query string under
`:query-string` (let-go `pkg/rt/types.go`); nothing in the app parses one
yet. A small private `page-of` in `routes.lg` reads it with a regex
(`(?:^|&)page=(\d{1,6})(?:&|$)`). Missing, malformed or `0` reads as page 1:
a list endpoint has no reason to answer 400 for it.

**A page past the end** answers 200 with `items: []` and `more: false`. The
pages handle it (below); it happens for real when the last room of the last
page is deleted.

**Stable order.** Rooms already order by `created_at desc, id asc`. Calls
order by `started_at desc` alone; add `c.id asc` as the tiebreak so two
calls starting in the same second cannot swap between pages.

**Presence is unchanged.** `/api/rooms` still asks the SFU once
(`active-rooms`) and maps it onto the rooms of the served page.

### The pager in the pages

One shared helper in `ui.js`, used by both pages:

```js
// Show Newer/Older under a list. `more` is the API's flag; `go(page)` loads
// that page. Hidden on a lone first page.
function setPager(nav, page, more, go)
```

Markup, the same on both pages, hidden until needed:

```html
<nav id="pager" class="pager" hidden>
  <button id="newer" class="link">← Newer</button>
  <button id="older" class="link">Older →</button>
</nav>
```

- Newer is disabled on page 1, Older when `more` is false; the nav is
  hidden when both would be (everything fits on one page).
- `setPager` assigns `onclick` (not `addEventListener`), since it is called
  on every load and on every five-second refresh of the room list.
- The current page lives in the URL (`/?page=2`, `/history?page=2`), read on
  load and written with `history.replaceState`, so a reload, or the
  browser's Back from a room, lands on the same page. Links to `/` (the
  brand, the room page's way home) go to page 1, on purpose: no link
  carries the page. Page 1 has no query. Both routes already match on the
  path alone.
- **Empty page past the end:** if a load returns no items and `page > 1`,
  the page loads `page - 1` instead. The empty-state text shows only for an
  empty page 1.
- **Rooms polling:** the five-second refresh re-fetches the current page.
  The existing in-place update (same ids in the same order) is kept, so
  focus survives a refresh on any page. After "New call" the browser leaves
  for the room; after a rename or delete the current page is reloaded.
- **Late answers:** a poll and a pager click can overlap. `loadRooms`
  remembers the page it asked for and drops the answer if `page` has
  changed since.

CSS: one `.pager` rule in `app.css` (a flex row, space between, a top
margin, muted `button.link` colours matching the bar's nav).

### Sign out

`index.html` has `<button id="signout" class="link">Sign out</button>` in
the nav and an inline handler. The button is added to the navs of
`history.html` and `settings.html`, and the handler moves to `ui.js`, which
wires `#signout` if the page has one (on `DOMContentLoaded`: `ui.js` loads
in the head). After signing out the browser goes to `/` on every page; on
the landing page that equals today's reload. `settings.html` does not load
`ui.js` yet; it gains the script tag.

Settings was not in the request, but it has the same gap and the same nav,
and the shared handler makes it one line. Drop the settings change if
unwanted.

### Compatibility

Nothing outside the two pages reads the list endpoints as arrays except the
tests (`routes_test.lg`, `system_test.lg`) and the README's API table; all
are updated in the same commits as the server change. `e2e/smoke.mjs` only
posts to `/api/rooms`.

### Testing

- `routes_test.lg`: existing assertions read `:items`; a new test per
  endpoint covers 21 items → page 1 has 20 and `more`, page 2 has 1 and no
  `more`, page 3 is empty, junk `page` reads as 1, and one user's pages
  never show another's rows. Rooms are inserted with `db/create-room!`
  (distinct `created_at` set by an update so order is deterministic);
  calls with `history/record!` events.
- `system_test.lg`: read `:items` where it reads `/api/calls`.
- e2e: a rooms pager spec (21 rooms made through `page.request.post`,
  rate limits are off in e2e) and sign-out from `/history` and `/settings`.
  The history pager shares `setPager` and its server side is covered by the
  route test; no e2e for 21 real calls.

## File Structure

- `src/quickmeet/db.lg` — `rooms-of-user` and `calls-of-user` take `limit`
  and `offset`; calls get the id tiebreak.
- `src/quickmeet/history.lg` — `calls-of-user` passes `limit`/`offset` through.
- `src/quickmeet/routes.lg` — `page-size`, `page-of`, a `paged` helper; the
  two list routes answer `{items, page, more}`.
- `resources/public/ui.js` — `setPager`; the `#signout` wiring.
- `resources/public/index.html` — paged room list; inline sign-out handler removed.
- `resources/public/history.html` — paged history; Sign out in the nav.
- `resources/public/settings.html` — Sign out in the nav; loads `ui.js`.
- `resources/public/app.css` — `.pager`.
- `test/quickmeet/routes_test.lg`, `test/quickmeet/system_test.lg`,
  `test/quickmeet/history_test.lg`,
  `e2e/tests/rooms.spec.js`, `e2e/tests/account.spec.js` — tests.
- `README.md` — the API table and the paragraph under it.

## Tasks

### Task 1: Paged queries and endpoints

**Files:**
- Modify: `src/quickmeet/db.lg`, `src/quickmeet/history.lg`, `src/quickmeet/routes.lg`
- Test: `test/quickmeet/routes_test.lg`, `test/quickmeet/system_test.lg`, `test/quickmeet/history_test.lg`

- [x] **Step 1: Update the existing tests to the new shape, add the paging tests**
  In `routes_test.lg`, every read of `GET /api/rooms` and `GET /api/calls`
  goes through `:items` (`my-rooms-are-the-ones-I-own-or-joined`,
  `only-the-owner-renames-and-deletes`, `webhooks-are-verified-and-recorded`).
  The `call` helper passes `extra` into the request, so a page is asked for
  with `{:query-string "page=2"}` merged into the extras (keep `:uri` as the
  bare path: that is what the server hands ruuter).
  Add `rooms-come-a-page-at-a-time` and `calls-come-a-page-at-a-time` as
  described under Testing: 21 items; page 1 → 20 items, `:page 1`,
  `:more true`, newest first; page 2 → the oldest 1, `:more false`; page 3 →
  `[]`, `:more false`, `:page 3`; `page=abc`, `page=0` and no query → page 1;
  a second user sees none of them. `with-handler` hands the test `conn`, so
  rooms go in through `db/create-room!` plus an `update rooms set created_at`
  per room for a known order, and calls through `history/record!` with a
  `participant_joined` per call in 21 different rooms (or one room with a
  distinct room sid and `joinedAt` per call, whichever reads shorter).
  In `system_test.lg`, the `calls` fn near line 223 reads `:items`.
  `history_test.lg` calls `history/calls-of-user` with two arguments in ten
  places: give the file a private `calls-of` helper
  (`(history/calls-of-user conn user-id 100 0)`) and use it there. Grep
  `test/` for `rooms-of-user` and `calls-of-user` to catch any other caller.

- [x] **Step 2: Run the tests, see them fail**
  Run: `lgx test`
  Expected: the changed and new route tests FAIL (the endpoints still
  return arrays).

- [x] **Step 3: Page the queries in `db.lg`**
  Add `:limit` and `:offset` to `rooms-of-user-sql` and `calls-of-user-sql`
  as placeholders, in the style of the file (`sql-of` renders once at load;
  callers pass values in the order of the rendered SQL). Check the rendered
  strings in a REPL or with a `println`: both must end `LIMIT ? OFFSET ?`.
  If HoneySQL under let-go misrenders either (KNOWLEDGE.md records such
  cases), append ` limit ? offset ?` to the rendered string instead.
  Add `[:c.id :asc]` after `started_at` in the calls `order-by`.
  New signatures, which `history.lg` and `routes.lg` rely on:

  ```clojure
  (db/rooms-of-user conn user-id limit offset)
  (db/calls-of-user conn user-id limit offset)
  (history/calls-of-user conn user-id limit offset)
  ```

  Update the docstrings ("newest first, `limit` rows from `offset`").

- [x] **Step 4: Page the routes in `routes.lg`**
  Add `(def ^:private page-size 20)`, `page-of` (request → page number, per
  the Design's regex and fallbacks) and one helper both routes use:

  ```clojure
  ;; (paged req fetch) -> {:items [...] :page n :more bool};
  ;; fetch is (fn [limit offset]) -> rows, asked for one row too many.
  ```

  `GET /api/rooms` maps `public-room` over the page's items (the `active`
  lookup stays one call per request); `GET /api/calls` returns the rows as
  they are. Update the comments above both routes to say "a page of".

- [x] **Step 5: Run the tests**
  Run: `lgx test`
  Expected: PASS, all namespaces.

> Deviation: `test/quickmeet/db_test.lg` also calls `db/rooms-of-user`; it got the same `rooms-of` helper as `history_test.lg`, plus one assertion of a 1-row page from offset 1.
> Deviation: HoneySQL rendered `LIMIT ? OFFSET ?` correctly under let-go, so no raw SQL fallback was needed.

- [x] **Step 6: Commit**
  `git commit -m "Rooms and calls are served a page at a time"`

### Task 2: The pager in the pages

**Files:**
- Modify: `resources/public/ui.js`, `resources/public/index.html`, `resources/public/history.html`, `resources/public/app.css`
- Test: `e2e/tests/rooms.spec.js`

- [x] **Step 1: `setPager` and the style**
  Add `setPager(nav, page, more, go)` to `ui.js` as specified in the Design
  (it finds `#newer`/`#older` inside `nav`; a comment in the file's voice).
  Add the `.pager` rule to `app.css` next to `.rooms`/`.calls`.

- [x] **Step 2: Page the room list in `index.html`**
  Add the pager markup after `#no-rooms`. Keep a `page` variable read from
  `location.search` on load. `loadRooms()` fetches
  `/api/rooms?page=<page>`, steps back a page when `items` is empty and
  `page > 1`, renders `items` exactly as it renders the array today
  (including the in-place refresh), shows `#no-rooms` only for an empty
  page 1, calls `setPager`, and keeps the URL in step with
  `history.replaceState`. Going to a page sets `page` and calls
  `loadRooms()`. The five-second poll needs no change beyond that.

- [x] **Step 3: Page the history in `history.html`**
  The same pager markup after the table; `load()` takes the page from the
  URL, fetches `/api/calls?page=<page>`, steps back on an empty later page,
  renders `items`, shows `#empty` only for an empty page 1, calls
  `setPager`, keeps the URL in step.

- [x] **Step 4: e2e for the rooms pager**
  In `rooms.spec.js`, add a test: sign up, create 21 rooms with
  `page.request.post('/api/rooms')` (the context's cookie is sent), open
  `/`: 20 rows, the pager visible, Newer disabled; click Older: 1 row, URL
  has `page=2`, Older disabled; reload: still 1 row; delete that room
  (accept the dialog): the page steps back to 20 rows and the pager hides.
  Add to an existing rooms test an assertion that `#pager` is hidden with
  one room.

- [x] **Step 5: Run the browser tests**
  Run: `lgx e2e`
  Expected: PASS, including the existing history test in `rooms.spec.js`.

> Deviation: let-go's `:uri` is the request URI with the query string, and ruuter matches it whole, so `/api/rooms?page=1` (and any page with a query, `/?x=1` included) answered 404. `handler` now strips the query before routing (own commit, with a route test); the route paging tests send `:uri` with the query, as the real server does. The plan's "keep `:uri` as the bare path" was wrong.
> Deviation: the pager and URL helpers (`pageInUrl`, `setPageInUrl`) both live in `ui.js`, so the two pages share them.
> Deviation (codex review): the pages adopt the `page` the server served (a `?page=1000000` it cannot read is page 1), and an empty page steps back once, then to page 1, instead of one request per page. Covered in the rooms e2e test.
> Note: three blur tests time out intermittently under load; master fails them the same way with `--repeat-each=2`, so they are unrelated.

- [x] **Step 6: Commit**
  `git commit -m "Room list and history show a page at a time"`

### Task 3: Sign out on history and settings

**Files:**
- Modify: `resources/public/ui.js`, `resources/public/index.html`, `resources/public/history.html`, `resources/public/settings.html`
- Test: `e2e/tests/account.spec.js`

- [x] **Step 1: Share the handler**
  Move the `#signout` click handler from `index.html`'s inline script into
  `ui.js`: on `DOMContentLoaded`, if the page has `#signout`, a click posts
  `/api/auth/signout` and then sets `location.href = '/'`.

- [x] **Step 2: Add the button**
  Add `<button id="signout" class="link">Sign out</button>` to the navs of
  `history.html` and `settings.html`, after Settings, as on the landing
  page. Add `<script src="/static/ui.js"></script>` to `settings.html`'s head.

- [x] **Step 3: e2e**
  In `account.spec.js`, add a test: sign up, go to `/history`, click
  `#signout`, expect `/` with `#signed-out` visible; sign in again, go to
  `/settings`, do the same. Then `/history` redirects to `/signin`.

- [x] **Step 4: Run the browser tests**
  Run: `lgx e2e`
  Expected: PASS (the two existing `#signout` uses in `account.spec.js`
  still pass through the shared handler).

> Deviation: after signing out the landing page navigates to `/` like the others (it used to reload), which also drops a `?page=`.

- [x] **Step 5: Commit**
  `git commit -m "Sign out from history and settings"`

### Task 4: Docs

**Files:**
- Modify: `README.md`

- [x] **Step 1: Update the API table**
  The `GET /api/rooms` and `GET /api/calls` lines (README.md:218, 224) show
  `?page=N` and the `{"items": [...], "page": n, "more": bool}` shape; the
  paragraph near line 246 says the list comes 20 at a time, newest first.

> Deviation: `docs/KNOWLEDGE.md` also records the `:uri`/`:query-string` fact found in Task 2.

- [x] **Step 2: Commit**
  `git commit -m "docs: the list endpoints are paged"`

## Completion Summary

**Implemented.** `GET /api/rooms` and `GET /api/calls` take `?page=N` and
answer `{items, page, more}`, 20 per page, newest first (calls now tiebreak
on id). The landing page and history show Newer/Older, keep the page in the
address, drop late answers, and recover from a page past the end in at most
two extra requests. History and settings have Sign out; the handler is
shared in `ui.js` and always lands on `/`. README and KNOWLEDGE are updated.

**Verified.** `lgx test`: 66 tests, 435 assertions, 0 failures. `lgx e2e`:
39 passed, 2 failed, both blur tests that time out intermittently on this
machine and fail the same way on master (`--repeat-each=2`: 5 failures).
By hand against the built binary with 21 seeded rooms and calls: both
pagers, page 2 by URL, and Sign out from history.

**Issues found on the way.** let-go's `:uri` includes the query string and
ruuter matches it whole, so any URL with `?` answered 404, including
`/?anything` before this work. Fixed in `routes/handler`. Codex's review
caught an unbounded step-back loop and the client ignoring the page the
server actually served; both were fixed.

**Deviations, in one place.**
- `db_test.lg` also needed the new arity (a `rooms-of` helper plus one page assertion).
- HoneySQL rendered `LIMIT ? OFFSET ?` fine; no raw SQL fallback.
- `handler` strips the query string before routing (own commit), and route tests send `:uri` with it.
- The URL helpers live in `ui.js` next to `setPager`.
- Pages adopt the served `page`; an empty page steps back once, then to page 1.
- Signing out on the landing page now navigates to `/` instead of reloading.
- KNOWLEDGE.md records the `:uri`/`:query-string` fact.

**What the plan could have specified better:** checking how the real
server fills `:uri` before asserting it; the plan stated a fact about the
request map that it had not verified.
