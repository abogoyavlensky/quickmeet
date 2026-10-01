# After a deploy, both people can sit in the room for 40 s without seeing each other

**Status: open**

## Problem

At the deploy of PR #12 (2026-10-01), `lgx smoke` held a call on
staging through the restart. Both browsers reconnected to the new
process within about 16 s of the old container stopping (00:19:03 to
00:19:20), and both pages then showed "Waiting for the other person"
for about 40 s more: each was in the room, neither had the other as a
remote participant. At 00:20:01 they found each other and media flowed
again, 59.9 s without media in total. Nobody clicked anything.

At the previous deploy (PR #11) the same check took 27.6 s with no such
gap, so this is not every time.

How narrow: only a call that is on during a deploy or restart, and the
call does recover on its own. But 40 s of "waiting" with the other person
in fact connected reads as "they left", and a person may hang up.

## Fix

Not known yet. Candidates, to check with the SFU's logs at info level
(`LIVEKIT_LOG_LEVEL=info` on staging already) during a restart:

- The two clients reconnect at different moments; the first may land in
  a room instance that the second does not join, or the SFU may hold the
  first's previous session as a ghost until the departure timeout (20 s
  by default, `room.departure_timeout`) runs out.
- Subscription to the other's tracks may wait on ICE, if one side falls
  back to TCP 7881 after UDP fails.

Reproduce locally first: `lgx smoke` against the local binary with a
SIGTERM restart (as in the plan's Task 8 check) repeated a few times,
with the SFU at info level, and look for the gap.

## Origin

Seen on 2026-10-01 while verifying the release milestone on staging
(`docs/plans/2026-09-30-2252-release-milestone.md`, Task 12).
