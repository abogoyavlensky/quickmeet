# Concurrent requests corrupt each other's HoneySQL statements

**Status: open**

## Problem

Under concurrent requests, `create-room!` occasionally sends SQLite a
malformed statement. Seen on 2026-09-28 with 50 concurrent
`POST /api/rooms` (repro in
`docs/backlog/sqlite-busy-on-concurrent-writes.md`):

- `table rooms has 2 columns but 1 values were supplied`: the column list
  was missing from `INSERT INTO rooms (id) VALUES (?)`.
- `near "(": syntax error`.

One to a few failures per 50. Serial requests never produce them.

The cause is in let-go 1.13.0, not in the app. The http server calls each
request's handler with `h.fn.Invoke(...)` (`pkg/rt/http.go`, `ServeHTTP`),
and `Func.Invoke` runs on the shared `RootExecContext`
(`pkg/vm/func.go:184`), whose binding stack is the process-global one
(`pkg/vm/exec_context.go:36-40`). Go's net/http serves every request on its
own goroutine, so concurrent handlers push and pop dynamic bindings on one
shared stack. HoneySQL's `format` binds `*dialect*`, `*options*` and
friends while it renders (`honey/sql.cljc`, for example lines 458 and 486),
so one request's render can read another's bindings, or lose its own
halfway through when the other pops.

let-go already isolates goroutines it spawns itself: `go`, `future` and
friends run on `ec.Child()` (`pkg/rt/async.go:646`). Only callbacks entered
from Go's own goroutines, like the http handler, miss it. `pkg/rt/http.go`
is unchanged on let-go master since 1.13.0, and no upstream issue covers it
(searched 2026-09-28).

How narrow: it needs two requests rendering SQL at the same moment, so it is
rare at staging traffic. It affects any code on the request path that binds
dynamic vars, not only HoneySQL. The failures seen so far were statements
SQLite rejected; nobody has shown that a corrupted statement SQLite accepts
is impossible.

## Fix

Upstream, in let-go: run each request in its own context, the same way
spawned goroutines do. In `ServeHTTP`:

```go
res, err := vm.RootExecContext.Child().Invoke(h.fn, []vm.Value{req})
```

`ExecContext.Invoke` exists (`pkg/vm/exec_context.go:207`) and handles
`*Func`, `*Closure` and `*MetaFn`. The same pattern probably applies to
any other place where Go calls back into let-go from a goroutine it did
not spawn itself (http client callbacks, timers). Worth checking while
there.

Notes for whoever picks this up:

- File it against nooga/let-go with the repro and a test: a handler that
  binds a dynamic var, sleeps, and returns the value it reads, hit with
  concurrent requests, must always return its own value.
- Until a let-go release has it, the app can keep dynamic bindings off
  the request path. The two queries in `src/quickmeet/db.lg` are fixed
  shapes, so their SQL can be rendered once at namespace load, or written
  as plain `["INSERT ..." id]` vectors. This does not help other code that
  binds dynamic vars.
- Test in quickmeet once fixed: concurrent `POST /api/rooms` through the
  real server in `system_test.lg`, all 201. That test also needs the
  `SQLITE_BUSY` fix.

Upstream: about one line in `http.go` plus a test. App workaround: about
ten lines in `db.lg`.

## Origin

Surfaced on 2026-09-28 while measuring parallel calls for staging on uncloud
(`docs/plans/2026-09-28-1220-staging-on-uncloud.md`), behind the
`SQLITE_BUSY` failures: once a busy timeout removed those, these were what
remained.
