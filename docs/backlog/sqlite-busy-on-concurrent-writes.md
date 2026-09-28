# Concurrent room creation fails with 500 "database is locked"

**Status: done**
Landed in da0ea5c: the DSN sets `busy_timeout(5000)` and WAL; `system_test.lg` `concurrent-room-creation` covers it. Follow-up 05c6595 dropped the `file:` prefix from the DSN below, so `#` or `%` in `DB_PATH` stay literal (`test/quickmeet/db_test.lg`).

## Problem

Two `POST /api/rooms` at the same moment can fail: the second insert gets
`database is locked (5) (SQLITE_BUSY)` and the handler answers 500. The
landing page then shows "could not create a room (500)".

Repro against a built binary (any ports):

```bash
DB_PATH=/tmp/qm-busy.db PORT=8097 ./bin/quickmeet &
for i in $(seq 50); do curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8097/api/rooms & done | sort | uniq -c
```

On 2026-09-28 this gave 19, 22 and 26 failures out of 50 across three runs.

The cause: `quickmeet.db` opens the database with `(sqlite/open path)`
(`src/quickmeet/db.lg:12`), and `sqlite.core/open` (letgo-packages
`sqlite-v0.2.0`, `sqlite/src/sqlite/core.lg:16`) passes the path to
modernc.org/sqlite as the DSN unchanged. So every connection in
database/sql's pool has SQLite's default busy timeout of 0 and the rollback
journal: a writer that finds another connection holding the lock fails at
once instead of waiting.

How narrow: it needs two room creations within a few milliseconds of each
other. On staging, with a handful of users, that is rare. In the browser
suite it shows as `expect(page).toHaveURL(/\/room\/.../)` timing out after
"New meeting" (the page never navigates because the POST failed). Serial
runs, as in CI, do not hit it. Reads (`get-room`) are not affected. Every
future write path (accounts, sessions, call history) will be.

## Fix

Open the database with a busy timeout, and WAL so readers never wait for the
writer. modernc.org/sqlite v1.57.0 runs `_pragma` DSN parameters on every
new pool connection (`sqlite.go:433`):

```clojure
(sqlite/open (str "file:" path "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"))
```

Measured with this change on a scratch build, same repro: 8, 2 and 1
failures out of 50, and every remaining failure was the separate
HoneySQL corruption in
`docs/backlog/letgo-http-handlers-share-dynamic-bindings.md`, not
`SQLITE_BUSY`. The two need fixing together before a concurrency test can
pass reliably.

Notes for whoever picks this up:

- Put the pragmas in the DSN, not in a one-off `PRAGMA` statement after
  opening: `busy_timeout` is per connection, and the pool opens connections
  lazily.
- Consider making this the default in letgo-packages' `sqlite.core/open`
  (with an opt-out), since every consumer of the package has the same
  pool and the same default. Then quickmeet needs no change beyond a
  version bump.
- WAL adds `quickmeet.db-wal` and `-shm` beside the database. That is fine
  on the staging bind mount, and it is what a Litestream sidecar (ROADMAP
  M6) needs anyway. A test that deletes the database should delete those
  too (`routes_test.lg` and `system_test.lg` `rm -f` only the `.db`).
- Add a test that fires concurrent `POST /api/rooms` through the real
  server in `system_test.lg` and expects all 201s.

About one line in `db.lg` (or the package), the test cleanup, and one
system test.

## Origin

Surfaced on 2026-09-28 while measuring parallel calls for staging on uncloud
(`docs/plans/2026-09-28-1220-staging-on-uncloud.md`). It was first taken
for a flaky `landing.spec.js` timeout; the Playwright trace's 500 body said
`SQLITE_BUSY`.
