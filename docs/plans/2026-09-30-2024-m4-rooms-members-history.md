# M4: Rooms, Members and History Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Signed-in users see a list of their rooms with a name and live presence, every room they join is added to that list, and their call history is recorded from the embedded SFU's webhooks.

**Tech Stack:** let-go 1.13.0 on lgx 0.4.2, the letgo-packages `livekit` (embedded SFU, `lk/token`, `lk/verify-webhook`), sqlite via HoneySQL and ragtime, ruuter routes, plain DOM pages, clojure.test via `lgx test`, Playwright via `lgx e2e`.

---

## Design

Approved 2026-09-30 (see `docs/ROADMAP.md`, M4). Rooms are the durable
thing: permanent since M2, owned since M3. The people you call are the
people you share rooms with, so there is no contacts table and no
add-by-email. Sharing the link is the invitation.

### Participant identity

Today the join token's `identity` is the typed name, so two guests named
"bob" collide (LiveKit evicts the first) and history cannot tell an
account from a guest with the same name. From M4:

- A signed-in user's token has identity `user:<user id>` and the display
  name as the token's `:name`.
- A guest's token has identity `guest:<4 hex chars>` and the typed name
  (or an invented `guest-xxxx`) as `:name`.
- Everything a person sees shows `name`: the lobby's presence line, the
  remote tag in the call, `window.call.remote`. `sfu/participants`
  returns `{:identity .. :name ..}` and the `GET /api/rooms/:id` response
  carries both.

### Members

`room_members (room_id, user_id, created_at)`, primary key on the pair.
The owner is inserted on creation; a signed-in user asking for a join
token is inserted (insert or ignore). "My rooms" is one query over
`room_members` joined to `rooms`. `rooms.owner_id` still says who may
rename and delete. Guests leave no membership.

### Rooms list

`GET /api/rooms` for a signed-in user: every room they are a member of,
newest first, each with `id`, `name` (nullable), `owner` (boolean: the
caller owns it), and `present` (participant count now). Presence comes
from one call to LiveKit's `ListRooms` twirp method (grant `:room-list`),
which returns only active rooms with `numParticipants`; an app room the
SFU does not know has 0. If the SFU could not be asked, every `present`
is 0.

`POST /api/rooms/:id` with `{"name": "..."}` renames (owner only, JSON
only, trimmed, at most 64 chars, blank clears to null). `DELETE
/api/rooms/:id` deletes the room and its memberships (owner only). The
room's calls stay: history shows the other person, not the room.

### History

The SFU posts webhooks to the app itself over loopback. The LiveKit config
gains

```
:webhook {:api_key <api-key> :urls ["http://127.0.0.1:<PORT>/api/webhooks/livekit"]}
```

Loopback reaches the app even when it binds all interfaces, as
`sfu/participants` already relies on for the SFU. `POST
/api/webhooks/livekit` verifies the request with `lk/verify-webhook`
(the `authorization` header, lowercased by let-go, and the raw body);
anything else is 401. A verified event is recorded and answered 200
whatever its type.

Event bodies are protojson: camelCase keys and int64 as strings. What is
read:

```
event                       "participant_joined" | "participant_left" | "room_finished" | other (ignored)
room.name                   the app's room id
participant.sid             unique per participant session, "PA_..."
participant.identity        "user:<id>" | "guest:<hex>"
participant.name            the display or typed name
participant.joinedAt        unix seconds, as a string
createdAt                   unix seconds, as a string (the leave time for participant_left)
```

Two tables:

```
calls             (id text pk, room_id text not null, ended_at text)
call_participants (sid text pk, call_id text not null references calls,
                   user_id text references users, name text not null,
                   joined_at text not null, left_at text)
```

State machine, per event, in `quickmeet.history`:

- `participant_joined`: ignored when the room id is not one the app
  knows, or when the `sid` is already recorded (a redelivery, possibly
  after the call closed). Otherwise the room's open call is the one with
  `ended_at` null; if none, insert one (`id/random-hex`). Insert the
  participant with `user_id` parsed from a `user:` identity, else null,
  and `joined_at` from `joinedAt` via sqlite `datetime(?, 'unixepoch')`.
- `participant_left`: set `left_at` from `createdAt` on that `sid`, if
  still null. Keyed on the sid only, so it lands even if the room was
  deleted during the call.
- `room_finished`: on the room's open call, set `left_at` from
  `createdAt` for every participant whose `left_at` is still null (a
  missed `participant_left`), then set `ended_at`. Keyed on the room id
  in `calls`, so it lands after the room row is gone.
- Anything else: ignore.

LiveKit queues events per room and delivers them in order; a missed
`participant_left` is closed off by `room_finished`, which the SFU sends
after `empty_timeout` (300 s) once the room is empty.

`GET /api/calls` for a signed-in user: the calls they took part in
(`call_participants.user_id`), newest first, each with `room_id`,
`started_at` (earliest `joined_at`), `ended_at` (latest `left_at`, or
null while someone is still in), `seconds` (their difference, null while
open) and `with` (the other participants' names, deduplicated, comma
separated). Guests have no session and see nothing.

### Pages

- `index.html`: for a signed-in user the "New meeting" button stays and
  a rooms list appears under it. Each row: the name (or `Room <id>`),
  presence ("1 waiting", "in a call", or nothing), Open (a link to
  `/room/<id>`), Copy link, and for the owner Rename (`prompt`) and
  Delete (`confirm`). A "History" link beside Settings. Signed out is
  unchanged.
- `history.html` at `/history`: a table of calls with who, when
  (`started_at`), how long. Signed out goes to `/signin` like settings.
- `room.html`: shows `participant.name` everywhere it showed identity;
  the token response's `name` fills the local tag.

### Testing

- `routes_test.lg`: membership on create and on token, the list's shape
  and ordering, rename and delete with ownership refused as 403 for a
  member who is not the owner and 401 signed out, the webhook state
  machine with genuinely signed bodies and a 401 for an unsigned one,
  the history shape.
- `system_test.lg`: the config carries the webhook URL from `PORT`, and a
  signed post reaches the endpoint over real HTTP with the real
  `verify-webhook`.
- `e2e`: two people join and leave, the host's history shows the guest's
  name and a duration; the rooms list shows the room, presence while
  someone waits, rename and delete. Existing presence assertions keep
  passing because they compare names.

Signing a webhook in a test: the body's claim is
`(io/encode :base64 (io/decode :hex (hash/sha256 body)))` and the header
is `(lk/token api-key api-secret {:sha256 claim})`, which is what the
package's own tests do with a fixed value.

### Out of scope

Web Push and ringing (After v1), calling a member from the list, guest
history, pagination, `room_started` and `track_*` events.

## File Structure

- Modify `src/quickmeet/migrations.lg`: migration `003-rooms-members-calls`.
- Modify `src/quickmeet/db.lg`: room name, members, rooms-of-user, delete; calls queries.
- Create `src/quickmeet/history.lg`: the webhook event handler (pure functions over the db) and the history query.
- Modify `src/quickmeet/sfu.lg`: `participants` returns names; new `active-rooms` (ListRooms).
- Modify `src/quickmeet/routes.lg`: identities, the new routes, the webhook route, `handler` takes a `verify` fn and the SFU lookups.
- Modify `src/quickmeet/system.lg`: the webhook config and URL.
- Modify `resources/public/index.html`, `room.html`; create `resources/public/history.html`; touch `app.css` for the list and table.
- Tests: `test/quickmeet/routes_test.lg`, `system_test.lg`, `migrations_test.lg`; `e2e/tests/rooms.spec.js` (new), `helpers.js`.
- Docs: `README.md` (API, layout), `docs/ROADMAP.md` (M4 done items), `docs/KNOWLEDGE.md` (what the webhook work taught).

---

### Task 1: Migration 003

**Files:**
- Modify: `src/quickmeet/migrations.lg`
- Test: `test/quickmeet/migrations_test.lg`

- [x] **Step 1: Test.** Following `rooms-survive-migration-002-both-ways`, add `migration-003-both-ways`: migrate up, insert a user and a room owned by them before migrating, migrate up, check the owner is now a member, insert a room name, a call and a call participant, roll back one, check `rooms` has no `name` column and the three tables are gone, migrate up again. Run `lgx test`; expected: fails (unknown column, missing tables).
- [x] **Step 2: Implement.** Append `003-rooms-members-calls`: `alter-table rooms add-column name text`; `room_members` (`room_id` references rooms, `user_id` references users, `created_at` default `CURRENT_TIMESTAMP`, primary key `(room_id, user_id)`); `calls` and `call_participants` as in the design; then a backfill, `insert into room_members (room_id, user_id) select id, owner_id from rooms where owner_id is not null`, so rooms from before M4 appear in their owner's list (HoneySQL `:insert-into` with a `:select`). Down: drop the three tables, drop the column. Comment: M4, rooms first.
- [x] **Step 3: Run** `lgx test`. Expected: green.
- [x] **Step 4: Commit.** `git commit -m "Migration 003: room names, members, calls"`

> Deviation: HoneySQL under let-go renders `:insert-into` with `:select` with the clauses reordered, so a migration step may now be a plain SQL string and the backfill is one. The two older migration tests were updated for the three-migration history. Codex (`.tmp/codex-review-6ebbca3.md`): nothing to fix.
> Note: the session task-list tools are not available in this environment; this document is the only tracking surface.

### Task 2: db queries

**Files:**
- Modify: `src/quickmeet/db.lg`
- Test: `test/quickmeet/db_test.lg`

- [x] **Step 1: Test.** Over a throwaway db (the pattern in `db_test.lg`): create two users and two rooms; `add-member!` twice for one pair does not throw; `rooms-of-user` returns the rooms newest first with `:name`, `:owner_id`; `rename-room!` sets and clears the name; `delete-room!` removes the room and its members. Run `lgx test`; expected: fails.
- [x] **Step 2: Implement.** All SQL rendered at load time with `sql-of` (see the namespace comment on dynamic bindings). Add `name` to `room-columns`. Functions: `create-room!` also inserts the owner into `room_members` when `owner-id` is given (two statements; no transaction API is assumed, so insert the room first); `add-member!` (`insert-into room_members ... on-conflict do-nothing`, HoneySQL `:on-conflict [] :do-nothing`); `rooms-of-user` (join through `room_members`, order by `rooms.created_at desc, rooms.id`); `rename-room!` (`:name` may be nil); `delete-room!` (delete members, then the room).
- [x] **Step 3: Run** `lgx test`. Expected: green.
- [x] **Step 4: Commit.** `git commit -m "db: room names and members"`

> Deviation: the ordering test ages one room by hand, since two rooms made in one second tie on `created_at`.

### Task 3: History recording and query

**Files:**
- Create: `src/quickmeet/history.lg`
- Modify: `src/quickmeet/db.lg`
- Test: `test/quickmeet/history_test.lg`

- [x] **Step 1: Test.** Over a throwaway db with a user and a room: feed `history/record!` parsed event maps (as `json/read-json` with `:keywords? true` would produce them, `joinedAt` and `createdAt` as strings) for alice (`user:<id>`) joining, a guest joining, both leaving, `room_finished`; then `history/calls-of-user` for alice has one call with `:with "bob"`, `:seconds` equal to the difference, `:ended_at` set. A second `participant_joined` with the same sid changes nothing, including one replayed after `room_finished` (no new call). A join for an unknown room id and a `track_published` event change nothing. A `participant_left` and a `room_finished` still land after `db/delete-room!`. A `room_finished` with one participant's `left_at` missing fills it from `createdAt`, and the call then has a duration. A join after `room_finished` opens a second call. Run `lgx test`; expected: fails.
- [x] **Step 2: db.** In `db.lg`, calls SQL: `open-call` (by room id, `ended_at` null), `create-call!`, `add-call-participant!` (insert or ignore on sid; timestamps via `[:raw "datetime(?, 'unixepoch')"]`, so the parameter order in the rendered SQL must be checked against the call), `call-participant` (by sid), `set-left-at!` (only where `left_at` is null), `close-call!` (two statements: fill missing `left_at` for the call's participants, then set `ended_at`), `calls-of-user` (group by call; `min(joined_at)`, `max(left_at)`, `group_concat(distinct name)` of participants whose `user_id` is not the caller or is null; `seconds` as `strftime('%s', max(left_at)) - strftime('%s', min(joined_at))`, null when any `left_at` is null: use `case when count(*) = count(left_at)`; order by `min(joined_at) desc`).
- [x] **Step 3: history.lg.** `record!` takes `conn` and the event map: dispatches on `:event`, ignores unknown rooms (`db/get-room`), parses `user:` identities with a regex, and returns nil. `calls-of-user` delegates to db. Docstring the event shape from the design.
- [x] **Step 4: Run** `lgx test`. Expected: green.
- [x] **Step 5: Commit.** `git commit -m "History: calls recorded from LiveKit events"`

> Note: `seconds` and `with` are computed in the same query with `:raw` fragments; the raw `?` placeholders are positional, so `calls-of-user` passes the user id twice. Task 2 Codex (`.tmp/codex-review-59813c0.md`): nothing to fix.

### Task 4: SFU lookups return names; active rooms

**Files:**
- Modify: `src/quickmeet/sfu.lg`
- Test: `test/quickmeet/system_test.lg`

- [x] **Step 1: Implement.** `participants` selects `[:identity :name]`. New `active-rooms`: `POST /twirp/livekit.RoomService/ListRooms` with body `{}` and a token with `:room-list true`; returns a map of room name to `numParticipants` (an integer; protojson omits zero, so default 0), `{}` for no rooms, nil when the SFU could not be asked.
- [x] **Step 2: Test.** In `system_test.lg`, beside `participants-of-an-unknown-room`: `active-rooms` against the running SFU is `{}`. Run `lgx test`; expected: green.
- [x] **Step 3: Commit.** `git commit -m "sfu: participant names and active rooms"`

> Codex on Task 3 (`.tmp/codex-review-4e39978.md`), P2 fixed in `781e937`: a process killed mid-call never gets `room_finished`, so the next meeting merged into the stale call. `calls.sid` now records the SFU room lifetime; a join with a different sid closes the stale call and opens a new one.
> Codex on Task 4 (`.tmp/codex-review-3561c32.md`), P2 fixed in the next commit: the twirp API keeps protobuf names, so the count is `num_participants`, not `numParticipants`. `sfu/create-room!` was added so the system test can see a room the SFU lists.

### Task 5: Identities and presence names

**Files:**
- Modify: `src/quickmeet/routes.lg`, `resources/public/room.html`
- Test: `test/quickmeet/routes_test.lg`

- [x] **Step 1: Tests.** In `create-room-then-join`: a token minted with a session has `:identity` `user:<id>` and `:name` the display name; a guest's has identity starting `guest:` (4 hex) and `:name` "alice" when typed, `guest-xxxx` when not. `presence-and-the-two-person-rule`: the stub returns `{:identity .. :name ..}` and the response carries both. Run `lgx test`; expected: fails.
- [x] **Step 2: routes.** The token route: with a session, identity `user:<id>`, `:name` display name; else identity `(str "guest:" (subs (id/random-hex) 0 4))` and `:name` from `clean-identity` (rename it `clean-name`). Pass `:name` to `lk/token`. The response gains `name`.
- [x] **Step 3: room.html.** Presence line and remote tag use `participant.name` (fall back to identity when empty); `window.call.remote` is the name; the local tag shows the response's `name`. The lobby's `#identity` field stays and is what `name` is sent as.
- [x] **Step 4: Run** `lgx test` and `lgx e2e`. Expected: green; the existing specs compare typed names, which are now `name`.
- [x] **Step 5: Commit.** `git commit -m "Tokens carry account identity; pages show names"`

> Codex (`.tmp/codex-review-73bd05e.md`): nothing to fix. 20 browser tests green.

### Task 6: Rooms API

**Files:**
- Modify: `src/quickmeet/routes.lg`
- Test: `test/quickmeet/routes_test.lg`

- [x] **Step 1: Tests.** `handler` gains a stub for `active-rooms` (the same shape as `participants`: a fn, default `(constantly {})`). Tests: `GET /api/rooms` is 401 signed out; a fresh user's list has the rooms they created, newest first, `owner` true, `present` from the stub keyed by id (0 when absent); a second user who mints a token for the first user's room sees it in their list with `owner` false; a guest token adds no member. Rename: 200 and the list shows the name; blank clears; 65 chars is 400; the non-owner member gets 403; 415 without JSON. Delete: 200 for the owner and the room is 404 after; 403 for a member; 401 signed out. Run `lgx test`; expected: fails.
- [x] **Step 2: Implement.** `handler` signature becomes `[conn livekit lookups auth]` where `lookups` is `{:participants fn :active-rooms fn :verify fn}` (verify is used in Task 7; default it in tests to `(constantly true)`). Update `ig/init-key ::handler` and the existing tests' `with-handler` accordingly. Routes: `GET /api/rooms`, `POST /api/rooms/:id` (json-only), `DELETE /api/rooms/:id`. Membership: `POST /api/rooms/:id/token` calls `db/add-member!` when there is a session. Ruuter: check it routes `:delete`.
- [x] **Step 3: Run** `lgx test`. Expected: green.
- [x] **Step 4: Commit.** `git commit -m "Rooms API: list, rename, delete, membership"`

### Task 7: Webhook route and SFU wiring

**Files:**
- Modify: `src/quickmeet/routes.lg`, `src/quickmeet/system.lg`
- Test: `test/quickmeet/routes_test.lg`, `test/quickmeet/system_test.lg`

- [x] **Step 1: Routes tests.** With `:verify` as the real `lk/verify-webhook` partially applied to the test key and secret: a body signed as the design describes for `participant_joined` then `participant_left` returns 200 and `GET /api/calls` for the user shows one call; the same body with no `authorization` header, or one signed with another secret, is 401 and records nothing; `GET /api/calls` is 401 signed out. Run `lgx test`; expected: fails.
- [x] **Step 2: Routes.** `POST /api/webhooks/livekit`: `((:verify lookups) (get-in req [:headers "authorization"]) (:body req))`, then `history/record!` on the parsed body, 200 `{}`. `GET /api/calls`: `history/calls-of-user`. `ig/init-key ::handler` passes `(partial lk/verify-webhook api-key api-secret)` reordered to the `(fn [auth-header body])` shape the route calls.
- [x] **Step 3: System config.** In `system/config`, the LiveKit config gains `:webhook {:api_key api-key :urls [(str "http://127.0.0.1:" port "/api/webhooks/livekit")]}` where `port` is the `PORT` value. `config-from-the-environment` asserts the URL for the default and for `PORT=8099`. Note in the config comment that the SFU's config parser is strict, so the key names are LiveKit's.
- [x] **Step 4: System test.** `webhooks-reach-the-app`: with the system on a fixed app port (assoc `:quickmeet.server/http :addr` to `127.0.0.1:8090` and `[:livekit/server :config :webhook :urls]` to the matching URL in this test only, since `:0` cannot be known to the SFU config), post a signed `participant_joined` body over HTTP to the endpoint and expect 200; post it unsigned and expect 401. Then confirm the SFU started with the webhook config: the twirp `CreateRoom` (grant `:room-create`) then `DeleteRoom` (grant `:room-admin`) for a room id the app knows, and within 5 s (poll) the app's log or a `room_finished` reaching `history/record!` closes an open call that the test opened by posting a signed `participant_joined` first. If asserting delivery this way proves flaky, keep the signed-post assertions and drop the delivery half with a note here; the e2e test in Task 9 covers real delivery.
- [x] **Step 5: Run** `lgx test`. Expected: green.
- [x] **Step 6: Commit.** `git commit -m "LiveKit webhooks recorded over loopback"`

> Deviation: the delivery half of the system test works and stays. Two things it taught: `DeleteRoom` needs the `roomCreate` grant (`roomAdmin` is refused 401), and a room made by `CreateRoom` gets a real rtc room, so the SFU sends `room_started` and, on delete, `room_finished`. `sfu/delete-room!` was added beside `create-room!` for the test. Codex on Task 6 (`.tmp/codex-review-c519c60.md`) and the ListRooms fixup (`8f60290`): nothing to fix.

### Task 8: Pages

**Files:**
- Modify: `resources/public/index.html`, `resources/public/app.css`
- Create: `resources/public/history.html`
- Modify: `src/quickmeet/routes.lg` (`/history` route), `test/quickmeet/routes_test.lg` (`pages-and-static` covers `/history`)

- [x] **Step 1: index.html.** Under the signed-in section: `<ul id="rooms">` filled from `GET /api/rooms` after `/api/me`. Per row: name or `Room <id>`, a presence span (`1 waiting` for 1, `in a call` for 2, empty for 0), Open, Copy link, and for `owner` Rename and Delete, each posting and reloading the list. A 401 anywhere sends to `/signin` as the existing code does. Add a History link beside Settings. Refresh presence every 5 s while the page is visible.
- [x] **Step 2: history.html.** Like `settings.html`: `/api/me` first, redirect when 401; then `GET /api/calls` into a table with columns With, When (`started_at` rendered with `toLocaleString`, treating the sqlite text as UTC by appending `Z`), Duration (`m:ss`, or "in progress"). An empty state sentence.
- [x] **Step 3: CSS.** A list and a table that fit the 480px main column; reuse `.muted`, `.ghost`, `.link`.
- [x] **Step 4: Routes.** `GET /history` serves the page. Extend `pages-and-static`.
- [x] **Step 5: Run** `lgx test`. Expected: green.
- [x] **Step 6: Commit.** `git commit -m "Pages: rooms list and history"`

> Codex on Task 7 (`.tmp/codex-review-c01cdbe.md`): nothing to fix. Codex on this task (`.tmp/codex-review-7d0d83d.md`), P2 fixed in `1d81410`: the five-second refresh rebuilt every row and dropped keyboard focus; rows of an unchanged list are now updated in place.

### Task 9: Browser tests

**Files:**
- Create: `e2e/tests/rooms.spec.js`
- Modify: `e2e/tests/helpers.js` if a helper is needed

- [x] **Step 1: rooms list.** Sign up, New meeting, back to `/`: the list shows the room with Rename and Delete. Rename via `page.on('dialog')` accepting "Mom"; the row shows it. A guest opens the lobby and joins; the row shows "1 waiting" within 10 s. Delete; the list is empty and the room URL shows `#gone`.
- [x] **Step 2: membership.** A second signed-up user in its own context joins the first's room; its `/` lists the room without Rename or Delete.
- [x] **Step 3: history.** Host and a guest ("bob") join, wait for media as `call.spec.js` does, both leave; `/history` for the host shows a row with "bob" and a duration within 15 s. The page fetches once on load, so poll by reloading: `expect.poll` over `page.reload()` followed by the row count, since the webhook is asynchronous.
- [x] **Step 4: Run** `lgx e2e`, then `cd e2e && npx playwright test --repeat-each 2`. Expected: green.
- [x] **Step 5: Commit.** `git commit -m "e2e: rooms list, membership, history"`

> Codex (`.tmp/codex-review-72f3f5c.md`), P2 fixed in `61b1f79`: the history poll stopped at one row even if the leaves had not landed yet; it now polls for the finished duration too. Deviation: the history test joins the signed-in host from the fixture page (the account is what history is keyed on) and a guest from a fresh context.

### Task 10: Docs

**Files:**
- Modify: `README.md`, `docs/ROADMAP.md`, `docs/KNOWLEDGE.md`

- [x] **Step 1: README.** API block: the new routes, the token response's `name`, the participants' `name`, the webhook endpoint (internal, signed by the SFU). Layout: `history.lg`, `history.html`. A sentence on the rooms list and history in Run.
- [x] **Step 2: ROADMAP.** M4 items marked done with the date; identity scheme recorded as a decision.
- [x] **Step 3: KNOWLEDGE.** Under the livekit package: the webhook config keys, protojson's camelCase and int64-as-string, `ListRooms`, per-room ordered delivery, `room_finished` after `empty_timeout`, and the base64 claim recipe for tests.
- [x] **Step 4: Commit.** `git commit -m "docs: M4 rooms, members and history"`

> The roadmap also records the identity scheme and the room-sid decision from the Task 3 review.

### Task 11: Ship

- [x] **Step 1:** `lgx test`, `lgx e2e`, `cd e2e && npx playwright test --repeat-each 2`. Expected: green.
- [x] **Step 2:** Push `m4-rooms-and-history`, `gh pr create` titled `M4: rooms, members and history`, link it to the thread, watch `gh pr checks`, squash-merge when green.
- [x] **Step 3: Staging.** Against `https://quickmeet.absky.dev`: `GET /api/rooms` signed out is 401; the operator's rooms from before M4 are listed (the migration's backfill); a call from two devices appears in history with the guest's name. Record the outcome here.

> Task 11 outcome (2026-09-30). PR #9 squash-merged as `ed3763b`; the deploy run succeeded. Against `https://quickmeet.absky.dev`: `GET /api/rooms` and `GET /api/calls` signed out are 401; `/history` is 200 and the landing page carries the rooms list; an unsigned post to `/api/webhooks/livekit` is 401; the pre-M4 room `d3ce2d50315d` answers with `name: null`, so migration 003 ran on the staging database with its rows intact. Not done here: the operator's own sign-in to see their backfilled rooms listed, and a call from two devices showing in history with the guest's name, which need their browser and password.

---

## Execution summary (2026-09-30)

**Status: completed.** Every task done; 42 unit and system tests and 23 browser tests green (the browser suite also under `--repeat-each 2`); shipped as PR #9 and verified on staging as recorded above.

What was built: migration 003 (room names, members with the owner backfill, calls and call participants with the SFU room sid); `quickmeet.history` recording joins, leaves and finishes from verified webhooks; `sfu/active-rooms` over `ListRooms`, plus `create-room!` and `delete-room!` for the tests; participant identities `user:<id>` and `guest:<hex>` with names shown everywhere; the rooms API (list, rename, delete, membership on token); the webhook route and the SFU config pointing at it; the rooms list on the landing page and the history page; browser tests for all of it; README, ROADMAP and KNOWLEDGE.

Codex reviewed every commit. Must-fix findings, all fixed in-branch: stale open calls after a killed process (room sid on calls); `num_participants` not `numParticipants` from twirp; the five-second refresh dropping keyboard focus; the Rename prompt offering a stale name; the history browser test stopping before the leaves landed.

Deviations, gathered:
- Migration steps may be plain SQL strings, since HoneySQL under let-go misorders `INSERT ... SELECT`.
- Older migration tests updated for the three-migration history; the db ordering test ages a room by hand.
- `calls.sid` and the lifetime rule were not in the plan; added from review.
- `sfu/create-room!` and `sfu/delete-room!` added for the system test; `DeleteRoom` needs the `roomCreate` grant.
- The history browser test joins the account holder from the fixture page and a guest from a fresh context.
- The session task-list tools were unavailable; this document was the only tracking surface.

What the plan could have specified better: that a killed process never delivers `room_finished` (the lifetime rule), and the twirp field naming, both of which the review had to catch; and that `DeleteRoom` wants `roomCreate`, which cost one debugging round.
