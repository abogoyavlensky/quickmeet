# Drop Ringing, and Every Call Includes the Room's Owner: Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove ringing (Web Push) from the app completely, then enforce that a call in a room always includes the room's owner: anyone holding the link may be in the room alone, but a second person gets in only if one of the two is the signed-in owner.

**Tech Stack:** let-go via lgx (`lgx test`, `lgx e2e`), ruuter routes, sqlite with ragtime migrations, the embedded LiveKit SFU and its twirp RoomService, `livekit-client` in plain DOM pages, Playwright.

---

## Design

### Why

The app should be simpler. Ringing is the largest feature that is not the
call itself: a Go shim (`webpush/`), a service worker, VAPID keys, a
subscriptions table, three endpoints, a banner, a Settings switch and a
button in the call. It goes, with nothing replacing it. A person waiting
in a room still shows on the owner's rooms list ("who is in it right
now"); that becomes the only in-app signal, as it was before ringing.

A room is for calls with its owner. Today any two people holding a link
can call each other in it: strangers using a leaked link on the
instance's bandwidth, or members using someone else's room as their own.
Both should stop.

### Phase 1: drop ringing

Everything ringing-only goes:

- **Server:** `src/quickmeet/push.lg`; the `webpush/` shim and its coord in
  `lgx.edn` (and `webpush/**` in the CI cache keys of
  `.github/workflows/test.yml` and `release.yml`); in `routes.lg` the
  `POST /api/rooms/:id/ring`, `GET /api/push/key`,
  `POST /api/push/subscriptions` and `POST /api/push/unsubscribe` routes,
  `subscription-problem`, `ring-targets`, `ring-names`, `ring-message`,
  `in-room?`, the `:ring` field of the token response, and the `push`
  argument of `handler` and `routes` (and `(push/service db)` in
  `init-key`); in `db.lg` the whole `;; ---- push` section (settings and
  subscriptions) and the subscription delete inside `delete-session!`;
  the `:ring` bucket in `ratelimit.lg`; `metrics/push-delivery!`. Helpers
  in `routes.lg` that only ringing used go too (check `secure?` and
  `request-host` before deleting: the signalling URL may use them).
- **Browser:** the Ring button and its code in `room.html` (`#ring`,
  `RING_FAILED`, `drawRing`, `resetRing`, `window.call.ring`, the
  `ring` read from the token response); the banner in `index.html`
  (`#ring-offer` and its script); the Notifications section in
  `settings.html`; the `push` object, `stored`, `PUSH_USER`,
  `PUSH_DISMISSED` and the base64url helpers in `ui.js`, and Sign out
  becomes "forget the language, sign out, go home"; the `#ring` rule in
  `app.css:246`; every ringing sentence in `i18n.js`.
- **Data:** migration `006-drop-push` drops `push_subscriptions` and
  `settings` (the VAPID key pair is the only row `settings` ever held).
  Its down step recreates both tables, empty, exactly as `004-push`
  made them. Migrations are append-only, so 004 stays.
- **Service worker:** v0.1.0 shipped `sw.js`, so some devices have it
  registered. Deleting the file would leave those registrations in place
  (a failed update check keeps the old worker). Instead `sw.js` becomes a
  stub that unregisters itself; unregistering also drops the device's
  push subscription. The `/sw.js` route stays, still `no-cache`. The
  stub can be deleted in a later release.
- **Tests:** `test/quickmeet/push_test.lg`, `e2e/tests/ring.spec.js`, and
  the ringing cases elsewhere (listed in the tasks).
- **Docs:** ringing leaves README, API, CONFIGURATION, DEVELOPMENT,
  INSTALL and KNOWLEDGE. The ROADMAP's "After v1" ringing entry gets a
  "Removed 2026-10-28" line with the reason, and push notifications go
  back under "Non-goals for v1". The three `docs/backlog/ring-*.md`
  entries become `**Status: done**` with a line "Dropped: ringing was
  removed (docs/plans/2026-10-28-1104-drop-ringing-and-owner-rule.md)."

Kept: the `language` column (migration 005). Ringing was one reason for
it, but it also carries the interface language across browsers.

### Phase 2: the owner rule

**The rule.** For a room with owner `O` (identity `user:<O>`) and the
participants the SFU reports:

- nobody there: anyone may join;
- one person there: the joiner may join only if the joiner is `user:<O>`
  or the person there is;
- two there: full, as now.

The owner counts only when signed in: identities come from
`participant-identity` (`routes.lg:263`), `user:<id>` for an account and
`guest:<hex>` otherwise. A room with no owner (none should exist) matches
nobody, so it holds one person at a time, with no special code.

One pure function holds the rule and every caller uses it, so the three
places cannot drift apart:

```clojure
(defn- owner-needed?
  "Whether `joiner` (an identity string, or nil for an unknown visitor)
   would be refused by the owner rule: exactly one person is in the room,
   and neither they nor the joiner is the room's owner. `participants` is
   the SFU's vector, nil when it could not be asked (reads as nobody)."
  [room participants joiner] ...)
```

The owner's identity is `(str "user:" (:owner_id room))`. A `nil`
`owner_id` must not match a joiner `user:` (compare only when
`owner_id` is non-nil). A signed-in caller's identity comes from
`(:identity (participant-identity user nil))`, never a second
`(str "user:" ...)`, so the two cannot drift.

**Two layers of enforcement.**

1. **The token endpoint** (`POST /api/rooms/:id/token`). After the 404 and
   the full check, and before the body is read: when `owner-needed?` for
   the caller's identity is true, answer
   `409 {"error": "owner-absent"}` and count
   `metrics/token-request! :owner-absent` (exported as `owner_absent`).
   The caller's identity is `user:<id>` when signed in; a guest's
   identity is random and minted later, so a guest is simply "not the
   owner" (pass `nil`). The participant lookup is still asked once per
   request: the full check and the owner check share its result.
2. **The webhook.** A token is valid for an hour, so the token check alone
   can be bypassed: two guests ask for tokens while the room is empty
   (each sees "nobody there"), then connect together. The SFU's own cap
   does not help. So on every verified `participant_joined` event, after
   `history/record!`, the webhook route checks the room as the SFU sees
   it: it takes the participants minus the event's joiner and asks
   `(owner-needed? room others joiner)`; when true, it asks the SFU to
   remove the participant this event is about. Using the rule function
   (not a separate "exactly two, neither the owner" test) keeps the rule
   in one place, and still works if `ListParticipants` does not list the
   joiner yet when the event fires. If two
   join at the same instant, both events remove their own joiner; both
   were breaking the rule. The intruder is connected for well under a
   second. Each removal logs one warn line,
   `quickmeet: removed a participant: the room's owner is not in it`
   (no room id: it is the link that grants entry). The webhook answers
   200 whatever the check finds; a failed lookup or removal is already
   logged by `sfu.lg` and removes nobody.

**The SFU calls.** `sfu.lg` gets `remove-participant!`: twirp
`RemoveParticipant` with the `{:room room-id :room-admin true}` grant and
body `{:room room-id :identity identity}`; it returns truthy on 200 and
nil otherwise (via `room-service`, which already logs failures). The
handler's `lookups` map gains `:remove-participant`,
`(fn [room-id identity])`, wired in `init-key` as
`(partial sfu/remove-participant! livekit)`, and stubbed in tests like
`:participants`. (Not `:remove`: destructuring that would shadow
`clojure.core/remove` across the whole `routes` body.)
`nobody-anywhere` in the routes tests gets a `:remove-participant` that
does nothing.

**Fail-open.** When the SFU cannot be asked, `participants` is nil, which
reads as nobody: the token check lets the caller in and the webhook check
removes nobody. This matches the two-person check today, and `sfu.lg`
logs every failed lookup.

**The lobby.** `GET /api/rooms/:id` gains `owner_needed`: the rule
applied to the visitor (`user:<id>` when signed in, nil for a guest)
against the participants it already fetches, so still one lookup per
request. The room page then:

- polling presence: one person there and `owner_needed` true shows
  `{name} is waiting for someone else.` and disables Join, as a full room
  does today. When that person leaves, the next poll re-enables Join.
- a Join answered `409 {"error": "owner-absent"}` shows
  `This room is busy right now.` A 409 `full` keeps the full message.
  The page must read the 409's `error` to tell the two apart.
- a failed `room.connect` asks the room again (today `isFull`); when the
  answer is `owner_needed`, it shows the busy message instead of the raw
  error.
- a `Disconnected` with `DisconnectReason.PARTICIPANT_REMOVED` returns to
  the lobby with the busy message, whether or not `window.call.joined`
  was set yet (the removal can land while tracks are still publishing;
  then `join()`'s catch must show the busy message, not the raw error).

User-facing text never mentions an owner:

| Where | English | Russian |
|---|---|---|
| Lobby presence line | `{name} is waiting for someone else.` | `{name} ждёт кого-то другого.` |
| Refused Join, removed by the webhook check | `This room is busy right now.` | `Комната сейчас занята.` |

Internal names (`owner-absent`, `owner_needed`, the log line) may say
owner; nobody but the operator sees them.

### Key decisions

- **Rings go with no replacement.** The rooms list still shows who is
  waiting.
- **Drop the tables, don't leave them unused.** Stale `push_subscriptions` and
  a VAPID key in `settings` on an old install would confuse whoever reads
  the schema next.
- **A self-unregistering `sw.js`, not a deleted file**, because v0.1.0
  installed the worker on real devices.
- **Webhook enforcement instead of short-lived tokens.** Short tokens only
  narrow the bypass window; the webhook check closes it, and leaves
  reconnection untouched.
- **Guests may wait alone.** If the owner had to be in the room first, a
  waiting guest would no longer show on the owner's rooms list, and that
  list is the only signal left once ringing is gone.
- **One rule function, three callers** (token, room lookup, webhook).
- **Accepted:** a removed intruder leaves a short stay in the call
  history of whoever was waiting (the webhook records the join before the
  check runs).

### Testing

- **Unit (`lgx test`):** the token endpoint for every case of the rule
  (guest after guest refused, owner after guest allowed, guest after
  owner allowed, a signed-in non-owner member after a guest refused,
  lookup failure allowed, full still `full`); `owner_needed` on
  `GET /api/rooms/:id` for an owner, a guest and a member viewer; the
  webhook removing exactly the event's participant when two non-owners
  are there, and nobody when the owner is there, when one person is
  there, or when the lookup fails; the `owner_absent` metric outcome;
  migration 006 both ways.
- **Browser (`lgx e2e`):** every existing spec joins its calls as two
  guests, which the rule now refuses. `newRoom` makes the room's owner
  `alice` (it sets the account's display name to `alice` through
  `POST /api/me` and keeps the context's `storageState` for that room
  URL), and `openLobby` opens `alice` in a room it made with that state,
  so she joins as the signed-in owner. Most specs then pass unchanged;
  the tasks list the ones to re-check. New specs: two guests are
  refused with the lobby line, a disabled Join and the 409; the owner
  joins a waiting guest; a guest holding a token minted while the room
  was empty is removed and sees the busy message. That last spec is the
  only proof that the real SFU behaves as the webhook check assumes: it
  must pass, never be skipped or retried into green.
- Every two-person spec today pairs `alice` with `bob`, so making `alice`
  the owner covers them. No spec has the host `page` join next to
  `alice` (two connections as `user:<owner>` would make LiveKit evict one
  with `DUPLICATE_IDENTITY`). `rooms.spec.js`'s history test has the host
  `page` join with a guest called `host`, which the rule allows.
- `lgx smoke` (`e2e/smoke.mjs`) already holds its call between the
  signed-in account that made the room and a guest, so it needs no
  change. `scripts/docker-smoke.sh` only asks for pages. The system tests
  make no joins.

## File Structure

Phase 1:

- Delete: `src/quickmeet/push.lg`, `webpush/` (`go.mod`, `shim.go`, and
  `go.sum` if present), `test/quickmeet/push_test.lg`,
  `e2e/tests/ring.spec.js`
- Modify: `src/quickmeet/routes.lg`, `src/quickmeet/db.lg`,
  `src/quickmeet/migrations.lg`, `src/quickmeet/metrics.lg`,
  `src/quickmeet/ratelimit.lg`, `src/quickmeet/telemetry.lg` (comment
  only), `src/quickmeet/sfu.lg` (comment only), `lgx.edn`,
  `.github/workflows/test.yml`, `.github/workflows/release.yml`
- Modify: `resources/public/sw.js` (becomes the stub),
  `resources/public/room.html`, `resources/public/index.html`,
  `resources/public/settings.html`, `resources/public/ui.js`,
  `resources/public/app.css`, `resources/public/i18n.js`
- Modify tests: `test/quickmeet/routes_test.lg`,
  `test/quickmeet/db_test.lg`, `test/quickmeet/migrations_test.lg`,
  `test/quickmeet/metrics_test.lg`, `test/quickmeet/ratelimit_test.lg`
- Modify docs: `README.md`, `docs/API.md`, `docs/CONFIGURATION.md`,
  `docs/DEVELOPMENT.md`, `docs/INSTALL.md`, `docs/KNOWLEDGE.md`,
  `docs/ROADMAP.md`, `docs/backlog/ring-from-a-guest.md`,
  `docs/backlog/ring-from-the-list.md`,
  `docs/backlog/ring-state-decline-and-missed.md`

Phase 2:

- Modify: `src/quickmeet/sfu.lg` (`remove-participant!`),
  `src/quickmeet/routes.lg` (the rule, the token check, `owner_needed`,
  the webhook check, `:remove-participant` in lookups), `src/quickmeet/metrics.lg`
  (docstring: the new outcome)
- Modify: `resources/public/room.html`, `resources/public/i18n.js`
- Modify tests: `test/quickmeet/routes_test.lg`, `e2e/tests/helpers.js`,
  `e2e/tests/lobby.spec.js` (new owner-rule specs), and whichever specs
  the rule breaks
- Modify docs: `docs/API.md`, `docs/CONFIGURATION.md`,
  `docs/KNOWLEDGE.md`, `docs/ROADMAP.md`, `docs/DEVELOPMENT.md`,
  the comment at the top of `routes.lg`

---

## Phase 1: Drop Ringing

### Task 1: Remove ringing from the server

**Files:**
- Delete: `src/quickmeet/push.lg`, `test/quickmeet/push_test.lg`
- Modify: `src/quickmeet/routes.lg`, `src/quickmeet/db.lg`, `src/quickmeet/metrics.lg`, `src/quickmeet/ratelimit.lg`, `src/quickmeet/telemetry.lg`, `src/quickmeet/sfu.lg`
- Test: `test/quickmeet/routes_test.lg`, `test/quickmeet/db_test.lg`, `test/quickmeet/metrics_test.lg`, `test/quickmeet/ratelimit_test.lg`

- [x] **Step 1: Remove the routes and helpers**
  In `routes.lg`: drop the `quickmeet.push` require; the `;; ---- ringing`
  section (`subscription-problem`, `ring-targets`, `ring-names`,
  `in-room?`) and `ring-message`; the `/ring`, `/api/push/key`,
  `/api/push/subscriptions` and `/api/push/unsubscribe` routes; `:ring`
  in the token response and its comment; the `push` parameter of `routes`
  and `handler` and its paragraph in the `handler` docstring;
  `(push/service db)` in `init-key`. Keep `sfu-call` (the token and room
  routes use it). Delete `secure?` and `request-host` only if nothing
  else uses them (`grep -n "secure?\|request-host" src/quickmeet/routes.lg`).
  Keep the `/sw.js` route.

- [x] **Step 2: Remove the data access and the rest**
  `db.lg`: the whole `;; ---- push` section (`setting`, `add-setting!`,
  the subscription SQL and functions, `ring-targets`), the
  `(declare delete-session-subscriptions!)`, and the call in
  `delete-session!` (its docstring loses the ringing clause).
  `metrics.lg`: `push-delivery!`; `rate-limited!`'s docstring loses
  `:ring`. `ratelimit.lg`: the `:ring` bucket and the sentence about it.
  `telemetry.lg:10` and `sfu.lg` (the `failed!` comment): drop the
  mentions of push delivery and "the ring".

- [x] **Step 3: Update the tests**
  Delete `test/quickmeet/push_test.lg`. In `routes_test.lg`: delete
  `recording-push`, the `push` arity of `with-handler` (the 4-arity calls
  `routes/handler` with four arguments), the `subscription`, `subscribe`,
  `stored`, `fcm`, `token-of`, `ring` helpers if nothing else uses them,
  and the tests `devices-subscribe-and-unsubscribe`,
  `ringing-the-other-members`, `ringing-is-limited-per-caller-and-room`,
  plus the ring and push parts of other tests (the `/api/push/*` paths
  in the list at about line 482, the `recording-push` in the handler at
  about line 525, the `/api/push/key` test at about line 974). In
  `db_test.lg`: the `;; ---- push` section (`settings-are-written-once`,
  `ring-targets-are-the-other-members-live-devices`,
  `subscriptions-go-with-their-session`). In `metrics_test.lg`: the
  `push-delivery!` calls and the `quickmeet.push.deliveries` name. In
  `ratelimit_test.lg`: the `:ring` assertion.
  Then confirm nothing is left:
  Run: `grep -rn -E "push/|push-delivery|ring-targets|recording-push|:ring\b|add-setting|delete-session-subscriptions" src test`
  Expected: no output.

- [x] **Step 4: Run the tests**
  Run: `lgx test`
  Expected: PASS. (The schema still has the push tables until Task 2.)

- [x] **Step 5: Commit**
  `git commit -am "Drop ringing from the server"` (stage the deletions with `git rm`).

> Note: `secure?` and `request-host` stay (cookies and the signalling URL use them). Codex's only finding (pages still call the deleted push endpoints) is Task 4's job; advisory.

### Task 2: Migration 006 drops the push tables

**Files:**
- Modify: `src/quickmeet/migrations.lg`
- Test: `test/quickmeet/migrations_test.lg`

- [x] **Step 1: Write the migration**
  Append `(migration "006-drop-push" ...)` with a comment: ringing was
  removed; its tables go. Up: `{:drop-table :push_subscriptions}` then
  `{:drop-table :settings}`. Down: the two `:create-table` maps from
  `004-push`, copied exactly (settings first, then push_subscriptions).

- [x] **Step 2: Update the migration tests**
  `migrate-up-and-down`: six ids ending in `"006-drop-push"`; after
  migrating, the tables are `call_participants calls ragtime_migrations
  room_members rooms sessions users` (no `push_subscriptions`, no
  `settings`); drop the two column checks for those tables; `(= 6 (count ...))`
  at both places. The rollback walk gains a first step: one rollback
  brings both push tables back (empty); then the existing steps follow
  (language, push tables gone, accounts gone...). `migration-004-both-ways`
  must first roll back 006 (insert its rows after `(migrations/rollback! conn)`
  from the latest), then roll back 005 and 004 as it does now; adjust its
  counts. `migration-005-both-ways` rolls back from 006 now: adjust its
  counts. Add `migration-006-both-ways`: migrate to 005 (migrate, then
  roll back once), insert a user, a session, a subscription and a
  settings row; migrate: both tables are gone and the session stays;
  roll back: both tables exist and are empty.

- [x] **Step 3: Run the tests**
  Run: `lgx test`
  Expected: PASS.

- [x] **Step 4: Commit**
  `git commit -am "Migration 006 drops the push tables"`

### Task 3: Remove the webpush shim

**Files:**
- Delete: `webpush/`
- Modify: `lgx.edn`, `.github/workflows/test.yml`, `.github/workflows/release.yml`

- [x] **Step 1: Remove the coord and the cache key part**
  `lgx.edn`: delete the Web Push comment and the
  `github.com/abogoyavlensky/quickmeet/webpush {:go/local "webpush"}` coord.
  In both workflows, drop `'webpush/**'` from `hashFiles(...)`
  (`hashFiles('lgx.edn')`), and fix the comment at `test.yml:30` that
  mentions `webpush/`. `git rm -r webpush`.

- [x] **Step 2: Rebuild and test**
  Run: `lgx test`
  Expected: the runtime rebuilds without the shim, then PASS.
  Run: `lgx build`
  Expected: `bin/quickmeet` builds.

- [x] **Step 3: Commit**
  `git commit -am "Remove the webpush shim"`

> Deviation: `.github/workflows/deploy.yml` also hashed `webpush/**` in its cache key; dropped there too. Docs mentions (KNOWLEDGE 32/526-535/919, DEVELOPMENT 142, ROADMAP 266) are Task 5.

### Task 4: Remove ringing from the pages

**Files:**
- Modify: `resources/public/room.html`, `resources/public/index.html`, `resources/public/settings.html`, `resources/public/ui.js`, `resources/public/app.css`, `resources/public/i18n.js`, `resources/public/sw.js`
- Delete: `e2e/tests/ring.spec.js`

- [x] **Step 1: The room page**
  Remove `#ring` and the comment above it (about line 90), `RING_FAILED`,
  `window.call.ring` (from the state object and its comment), the whole
  `;; ---- ringing` block (`RING_REST_MS`, `drawRing`, `resetRing`, the
  click handler), and the calls to `drawRing`/`resetRing` and the `ring`
  read in `join()` and `startLobby`. Where `drawRing` set
  `#invite`'s `primary` class, `#invite` is now always primary: set it in
  the markup and drop the toggle.

- [x] **Step 2: The list page, Settings and ui.js**
  `index.html`: the `#ring-offer` banner and the `;; ---- ringing`
  script (and the email variable if only ringing used it).
  `settings.html`: the `#ringing` section and its script block (and any
  `push.sync` call). `ui.js`: the whole `;; ---- ringing` section
  (`PUSH_USER`, `PUSH_DISMISSED`, `stored`, the base64url helpers,
  `pushKey`, `saveSubscription`, `push`); Sign out keeps
  `rememberLanguage(null)`, then posts `/api/auth/signout` and goes to
  `/`, with no wait; its comment loses the ringing part. `app.css:246`:
  `body:not(.waiting) #invite { display: none; }`.

- [x] **Step 3: Strings**
  `i18n.js`: delete every ringing sentence (lines about 55, 88-94, 120,
  140-141, 155-156 today: "Let people ring you…", "Notifications",
  "When someone rings you…", "This browser cannot receive rings.", the
  blocked/allowed notification sentences, "Stop ringing this device",
  "Let people ring me…", "Could not ring.", "Ring {name}", "Ring them",
  "Rung" if present, "Could not turn ringing on…", the iPhone
  home-screen sentence). Drop `sw.js` from the comment at line 26.
  Run: `lgx i18n-check`
  Expected: no missing sentences.

- [x] **Step 4: The service worker stub**
  Replace `sw.js` with a stub: a comment saying ringing was removed and
  that this file only exists to unregister the worker v0.1.0 installed
  (delete it a release or two later), then:

  ```js
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', event => event.waitUntil(self.registration.unregister()));
  ```

  Update the `/sw.js` route's comment in `routes.lg` to match.

- [x] **Step 5: Browser tests**
  `git rm e2e/tests/ring.spec.js`. Search the other specs for ringing:
  `grep -rn -E "#ring|ring-offer|ringing|/api/push|sw\.js" e2e`
  Expected: no output (fix any hit).
  Run: `lgx e2e`
  Expected: PASS.

- [x] **Step 6: Commit**
  `git commit -am "Drop ringing from the pages; sw.js unregisters itself"`

> Note: `lgx e2e` has 2 failures in `blur.spec.js` (lines 71 and 131) that also fail on the untouched baseline (master + plan commit); not caused by this work.
> Deviation: also removed the unused `bell` icon from `ui.js`, and the `Notifications`/`Rung`/`Ring …`/`Turn on`/`Not now`/`Could not reach the server` sentences from `i18n.js` (`lgx i18n-check` reports 0 unused).

### Task 5: Docs and backlog for phase 1

**Files:**
- Modify: `README.md`, `docs/API.md`, `docs/CONFIGURATION.md`, `docs/DEVELOPMENT.md`, `docs/INSTALL.md`, `docs/KNOWLEDGE.md`, `docs/ROADMAP.md`, `docs/backlog/ring-*.md`

- [x] **Step 1: Docs**
  README (lines about 51-53, 75), API (the ring and push endpoints, the
  token response's `ring`), CONFIGURATION (the `push to <host> failed`
  line, the `quickmeet.push.deliveries` metric, `ring` in the rate-limit
  buckets, "push endpoints" in what is never exported, "and the ring" in
  the SFU-failure log line), DEVELOPMENT (the file map lines 133, 141-143),
  INSTALL (outbound HTTPS to push services, lines about 232-234; the
  backup paragraph's "keys that sign rings", about 311; the
  `push_subscriptions` SQL about 334, rewritten for a plain session
  delete), KNOWLEDGE (the ringing and Web Push facts: delete them or
  mark them historical, keeping only what still applies).
  ROADMAP: under "After v1", end the ringing entry with "Removed
  2026-10-28 to keep the app simple; the rooms list showing who is
  waiting is the in-app signal again
  (`docs/plans/2026-10-28-1104-drop-ringing-and-owner-rule.md`)."; put
  push notifications and ringing back in "Non-goals for v1"; drop
  "Native ringing needs APNs…" from the Mobile entry.
  Run: `grep -rn -i -E "\bring(s|ing)?\b|web push|vapid|push_subscriptions" README.md docs --include=*.md | grep -v docs/plans | grep -v docs/backlog`
  Expected: only the ROADMAP's history lines.

- [x] **Step 2: Backlog**
  In `docs/backlog/ring-from-a-guest.md`, `ring-from-the-list.md` and
  `ring-state-decline-and-missed.md`, change `**Status: open**` to
  `**Status: done**` and add under it:
  `Dropped: ringing was removed (docs/plans/2026-10-28-1104-drop-ringing-and-owner-rule.md).`
  Other backlog entries that mention ringing in passing
  (`system-test-sfu-unreachable-at-start.md` and others from
  `grep -ln -w ring docs/backlog`) get the mention fixed only if it
  describes current behaviour.

- [x] **Step 3: Commit**
  Commit the docs (Step 1) as `Docs: ringing is gone`, and the three
  backlog status changes (Step 2) on their own as
  `Backlog: ringing entries dropped`.

> Note: `system-test-sfu-unreachable-at-start.md` mentions ringing only as history of a past flaky test; left as is. ROADMAP/KNOWLEDGE keep their dated ringing history by design.

---

## Phase 2: The Owner Rule

### Task 6: Ask the SFU to remove a participant

**Files:**
- Modify: `src/quickmeet/sfu.lg`
- Test: none here; the routes tests stub it, and the held-token browser spec (Task 10) exercises it against the real SFU

- [x] **Step 1: Write `remove-participant!`**
  After `participants`: `(defn remove-participant! [livekit room-id identity] ...)`,
  calling `room-service` with method `"RemoveParticipant"`, grant
  `{:room room-id :room-admin true}`, body `{:room room-id :identity identity}`.
  Returns true on a 200 (a map), nil otherwise (`:not-found` included: the
  person already left). Docstring in the file's style. Update the file's
  top comment: the app also removes a participant the owner rule refuses.

- [x] **Step 2: Check it compiles**
  Run: `lgx test`
  Expected: PASS.

- [x] **Step 3: Commit**
  `git commit -am "sfu: remove a participant"`

### Task 7: The rule at the token endpoint and the room lookup

**Files:**
- Modify: `src/quickmeet/routes.lg`, `src/quickmeet/metrics.lg`
- Test: `test/quickmeet/routes_test.lg`

- [x] **Step 1: Write the failing tests**
  In `routes_test.lg`, change `presence-and-the-two-person-rule`'s "one
  person" case: a guest there and a guest asking is now 409
  `{:error "owner-absent"}`. Add `the-owner-rule` covering, with a stubbed
  `:participants` and a room made by `alice` (use `user-id` or the token
  response's identity to build `user:<id>`):
  - guest present, guest asks: 409 `owner-absent`;
  - guest present, alice asks: 200;
  - alice present, guest asks: 200;
  - guest present, signed-in member `bob` asks: 409;
  - lookup nil, guest asks: 200;
  - two present: 409 `full` (unchanged);
  - `GET /api/rooms/:id` `owner_needed`: true for a guest viewer and for
    bob when one guest is there; false for alice; false when nobody or
    alice is there.
  Keep the "asked once per request" assertion passing.
  In `token-requests-are-counted-by-outcome`, add an `owner_absent`
  request and assert the body includes `owner_absent`.
  Run: `lgx test`
  Expected: FAIL on the new cases.

- [x] **Step 2: Implement**
  Add `owner-needed?` (signature in the Design) beside
  `participant-identity`. Token route: fetch participants once into a
  local; after the full check, when `(owner-needed? room participants
  (when user (:identity (participant-identity user nil))))`, count `:owner-absent` and answer
  409 `{:error "owner-absent"}`. This needs the room row and the current
  user before the `:else` branch; restructure with `let` so each is read
  once. Room lookup route: compute `owner_needed` from the same
  participants it returns and add it to the response. Update
  `token-request!`'s docstring with `:owner-absent`, the route comments,
  and the comment at the top of `routes.lg` ("the join token is open to
  anyone holding a link" now carries the owner rule).

- [x] **Step 3: Run the tests**
  Run: `lgx test`
  Expected: PASS.

- [x] **Step 4: Commit**
  `git commit -am "Owner rule: a second person needs the room's owner in the call"`

> Deviation: added a `user-identity` helper (nil for a guest) beside `participant-identity`, so the token route and the room lookup compute the viewer's identity the same way. The token route now reads `user` before the full check (one `current-user` call per request, as before).
> Note: Task 4 broke `pages-and-static` (it asserted the old worker's `notificationclick`); I had run e2e but not `lgx test` then. Fixed in `1df7b8e`.

### Task 8: The webhook check

**Files:**
- Modify: `src/quickmeet/routes.lg`
- Test: `test/quickmeet/routes_test.lg`

- [x] **Step 1: Write the failing tests**
  `nobody-anywhere` gains `:remove-participant (constantly true)`. New
  test `the-webhook-removes-a-pair-without-the-owner`: a room made by
  alice; a `:remove-participant` stub recording `[room-id identity]`
  calls; a signed `participant_joined` event for `guest:bb22` with
  participants stubbed as `[guest:aa11 guest:bb22]`: 200 and exactly
  `[[id "guest:bb22"]]` removed. Also removed when the stub does not
  list the joiner yet (`[guest:aa11]` only). No removal when the
  participants are `[user:<alice> guest:bb22]`, when only `[guest:bb22]`
  is there, when the lookup returns nil, for a `participant_left` event,
  or for an unknown room. The existing
  `webhooks-are-verified-and-recorded` still passes (its default lookups
  report nobody).
  Run: `lgx test`
  Expected: FAIL.

- [x] **Step 2: Implement**
  Destructure `remove-participant` from the lookups in `routes`. In the
  webhook route, after `history/record!`, for a `participant_joined`
  event: read the room by `(get-in event [:room :name])` (skip when
  invalid or unknown) and fetch participants through `sfu-call` (span
  `"sfu.participants"`); skip when the lookup is nil. Let `joiner` be
  `(get-in event [:participant :identity])` and `others` the participants
  whose identity is not `joiner`. When `(owner-needed? room others joiner)`,
  call `(remove-participant room-id joiner)` through `sfu-call` (span
  `"sfu.remove"`) and log
  `(telemetry/log! :warn "quickmeet: removed a participant: the room's owner is not in it" {} {:span req})`.
  Wire `:remove-participant (partial sfu/remove-participant! livekit)` in
  `init-key` and document it in the `handler` docstring.

- [x] **Step 3: Run the tests**
  Run: `lgx test`
  Expected: PASS.

- [x] **Step 4: Commit**
  `git commit -am "Owner rule: the webhook removes a pair without the owner"`

> Note: the warn line is logged only when the removal call returned truthy (a participant already gone is not "removed"). The check lives in a local `enforce-owner-rule` fn inside `routes`' `let`, next to `as-owner`.

### Task 9: The lobby

**Files:**
- Modify: `resources/public/room.html`, `resources/public/i18n.js`

- [x] **Step 1: Messages**
  Add `const BUSY = () => t('This room is busy right now.');` beside
  `FULL`. Add both sentences to `i18n.js` with the Russian from the
  Design table.

- [x] **Step 2: Presence, Join, connect failure, removal**
  `pollPresence`: read `owner_needed`; with one person there and
  `owner_needed`, the line is `t('{name} is waiting for someone else.', ...)`
  and Join is disabled. `join()`: on a 409, read the JSON and throw
  `BUSY()` for `owner-absent`, `FULL()` otherwise. Replace `isFull()`
  with a check that returns `'full'`, `'busy'` or null from
  `GET /api/rooms/:id`, used after a failed `room.connect`. Track a
  removal: the `Disconnected` handler, before its `joined` guard, notes
  `reason === DisconnectReason.PARTICIPANT_REMOVED`; when joined, it
  returns to the lobby with `BUSY()` as the notice; when not yet joined,
  `join()`'s catch shows `BUSY()` instead of the raw error. Reset the
  note when a new join starts.
  Run: `lgx i18n-check`
  Expected: no missing sentences.

- [x] **Step 3: Commit**
  `git commit -am "Lobby: a room waiting for someone else is busy"`

> Note: `isFull()` became `refusal()` (returns 'full', 'busy' or null). Added a guard after the publish loop: if the server already removed us, throw the busy message rather than showing the call. Browser behaviour is proven by the Task 10 specs.
> Deviation (found by the Task 10 held-token spec): a removal that lands while `room.connect()` or `publishTrack()` is still pending left the join hanging ~15 s until those gave up (the connection state was `disconnected` after ~0.3 s). `join()` now races both against a `removal` promise that the `Disconnected` handler rejects with the busy message on `PARTICIPANT_REMOVED`. The plan's wording ("join()'s catch must show the busy message") is unchanged; only how quickly it gets there.

### Task 10: Browser tests

**Files:**
- Modify: `e2e/tests/helpers.js`, `e2e/tests/lobby.spec.js`, and specs the rule breaks

- [x] **Step 1: The owner in the helpers**
  `newRoom(page, owner = 'alice')`: after `signUp`, set the display name
  with `page.request.post('/api/me', { data: { display_name: owner } })`
  (expect 200), create the room as now, then keep
  `{ name: owner, state: await page.context().storageState() }` in a
  module-level `Map` keyed by the room URL. `openLobby`: when the room's
  stored owner name equals `name`, pass `storageState` to
  `browser.newContext`. Document it at the top of the helpers: "alice is
  the room's owner, signed in; everyone else is a guest".

- [x] **Step 2: New specs** in `lobby.spec.js`
  - two guests: `bob` joins, then `carol` opens the lobby; her presence
    line reads `bob is waiting for someone else.`, Join is disabled, and
    a token request from her page answers 409 with `owner-absent`;
  - the owner joins a waiting guest: `bob` joins, `alice` joins, each
    sees the other;
  - the webhook removes a held token. Join is disabled once bob is
    there, so carol must click while the room is empty and have her
    token request held: open carol's lobby first; install
    `carol.page.route('**/api/rooms/*/token', ...)` whose handler calls
    `route.fetch()` at once (the server mints the token while the room
    is empty), then waits on a promise before `route.fulfill({ response })`;
    carol clicks Join; wait until the handler has fetched; `bob` joins;
    release the promise. Carol connects, the webhook removes her, and
    she ends up in the lobby showing `This room is busy right now.`;
    bob's call is untouched (`window.call.joined` true,
    `remoteOf(bob.page)` null once she is gone).

- [x] **Step 3: Run the suite and fix the fallout**
  Run: `lgx e2e`
  Expected: PASS after fixes; the held-token spec must pass as written.
  Specs to check first: the
  `lobby.spec.js` presence tests (the host page is now `alice` too),
  `rooms.spec.js` "joining someone else's room…" (dana alone, fine) and
  "a finished call shows in the host's history…" (the host page joins
  with a guest), `account.spec.js:97`, `i18n.spec.js`, and any spec whose
  two participants are neither `alice` nor the host page.

- [x] **Step 4: Commit**
  `git commit -am "e2e: alice owns the room; the owner rule's specs"`

> Note: `lgx e2e` = 82 passed, 2 failed (the same two `blur.spec.js` tests that fail on the untouched baseline). The held-token spec passed 6/6 in a repeat run and once in the full suite, unmodified from the plan's description; it first failed for a real product reason (see Task 9's deviation), not a loosened assertion.
> Note: the spec waits 1.5 s after bob joins so the SFU's event for bob's own join is checked before carol connects; a late event for bob would see [bob, carol] and remove bob too (the accepted both-removed case).

### Task 11: Docs for phase 2

**Files:**
- Modify: `docs/API.md`, `docs/CONFIGURATION.md`, `docs/KNOWLEDGE.md`, `docs/ROADMAP.md`, `docs/DEVELOPMENT.md`

- [ ] **Step 1: Write**
  API: the token endpoint's `409 {"error": "owner-absent"}` and when;
  `GET /api/rooms/:id`'s `owner_needed`. CONFIGURATION: the
  `owner_absent` outcome of `quickmeet.token.requests`, and the warn line
  `removed a participant: the room's owner is not in it` with what it
  means. KNOWLEDGE: the rule, why the webhook check exists (a token
  minted while the room was empty stays valid for an hour), the twirp
  `RemoveParticipant` grant, and that the client sees
  `DisconnectReason.PARTICIPANT_REMOVED`. ROADMAP: a "Done 2026-10-28"
  entry under "After v1" for the owner rule (both concerns: leaked links
  and members), and the "Resolved 2026-09-28: who may start a call" open
  question gains a line: a call now needs the owner too. DEVELOPMENT: the
  "Run locally" paragraph (join as the signed-in owner in one window and
  open the link in a private window as a guest; two guests cannot call)
  and the browser-test paragraph (alice owns the room).

- [ ] **Step 2: Final check**
  Run: `lgx test && lgx e2e`
  Expected: both PASS.

- [ ] **Step 3: Commit**
  `git commit -am "Docs: every call includes the room's owner"`
