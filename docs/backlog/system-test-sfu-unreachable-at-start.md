# The system test for an unknown room sometimes finds the SFU unreachable

**Status: open**

## Problem

`participants-of-an-unknown-room` in `test/quickmeet/system_test.lg`
fails now and then on its first assertion:

```
FAIL (= [] (sfu/participants livekit "0123456789ab"))
  actual: (not (= [] nil))
```

`nil` is `sfu/participants`'s answer when the SFU could not be asked at
all (`src/quickmeet/sfu.lg`, `room-service`: any status but 200 and 404,
or an exception), not an answer about the room. The call is the first
request to the twirp room API after `with-system` starts a fresh SFU on
the fixed port 7890.

Seen on 2026-10-02: master failed it in 1 of 4 full `lgx test` runs, the
ringing branch in 2 of 8. Running `lgx test test/quickmeet/system_test.lg`
alone, it passed 12 of 12 (6 on each). So it shows under the load of the
whole suite, and only in the test: the app never asks the SFU in the
first moment after a start.

## Fix

Not known. Two candidates to tell apart by logging the status or the
exception in `room-service` when the test fails:

- The SFU reports `running?` before its room API answers, so the first
  request right after a start can be refused. Then the test should wait
  for the API (poll `ListRooms` until it answers) before asserting.
- The previous test's SFU on the same port is still letting go of it.
  Then a free port per `with-system` would remove the shared state.

Notes for whoever picks this up: `participants` returning `nil` for an
unreachable SFU is deliberate (the lobby reads it as nobody); do not
change that to make the test pass.

## Origin

Found while executing `docs/plans/2026-10-02-2050-ring-web-push.md`
(2026-10-02), first in Task 4 and again in the final run; repeated on a
master worktree to show it predates that work.
