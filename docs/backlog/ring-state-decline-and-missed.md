# A ring has no state: no decline, no cancel, no missed call in history

**Status: open**

## Problem

A ring is one push per device and nothing else
(`docs/plans/2026-10-02-2050-ring-web-push.md`). The callee cannot
decline; the caller cannot cancel, and sees "Rung" for 30 seconds
whatever happened. When the callee answers on the phone, the same
notification stays on their laptop. An unanswered ring leaves no trace in
history: `calls` holds only stretches of a room being occupied
(`quickmeet.history`), so the caller's wait alone shows as a call with
nobody else in it, and the callee sees nothing.

The notification itself says "<name> wants to talk" so that, left in the
notification centre, it serves as the missed-call record for now.

## Fix

A ring becomes a row: `rings (id, room_id, caller_id, created_at,
answered_at, declined_at, cancelled_at)`, written by the ring endpoint
and closed when the callee joins the room, presses Decline, or the caller
leaves or cancels. Then:

- the notification gets Answer and Decline actions where the platform
  has them (Chrome, Android; not iOS, which shows no actions on web push);
- a second push with the same tag clears the notification on the other
  devices once one answers (the service worker closes notifications with
  that tag on a `{"close": tag}` message);
- the caller's page polls the ring and says "Declined" or "No answer";
- history lists unanswered rings as missed calls.

Notes for whoever picks this up:

- Try the minimal version on real phones first (Task 9 of the plan):
  whether iOS shows a replacing ring, and how it sounds, decides how much
  of this is worth it.
- A close push still has to show something on iOS, or the subscription
  is revoked; there the clearing push cannot be silent.

A plan of its own: a migration, three endpoints, the service worker,
both pages and history.

## Origin

Deferred while planning ringing (`docs/plans/2026-10-02-2050-ring-web-push.md`,
2026-10-02), in discussion: "no ring state" was the agreed minimal version.
