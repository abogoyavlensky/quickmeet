# A person on the list cannot be rung without first joining their room

**Status: open**

## Problem

Ringing lives on the call page only: the "Ring <name>" button shows while
the caller sits alone in the room (`resources/public/room.html`, the
ringing section). To ring Anna from the list page, the caller opens her
room, waits for the camera, presses Join, then Ring. A row on the list
(`resources/public/index.html`, `roomRow`) has Copy link, Rename and
Delete, and no call action.

The server already allows a ring only from someone in the room right now
(`POST /api/rooms/:id/ring` answers 403 otherwise, `routes.lg`, `in-room?`),
and that rule is what keeps the callee from answering into an empty room.

## Fix

A phone icon on the row that opens `/room/<id>?ring=1`; the room page,
seeing the flag, joins as soon as the lobby is ready and presses Ring
once the call is up. The server rule stays as it is.

Notes for whoever picks this up:

- The lobby is where the camera is chosen and the permission prompt
  appears; skipping it means joining with whatever `createLocalTracks`
  picks. Decide whether the shortcut keeps a one-tap lobby or skips it.
- Show the icon only on rows where a ring would reach someone; the list
  endpoint does not say that today (`ring` is in the token response
  only), so `GET /api/rooms` would gain a field.
- `routes.lg` strips the query before routing, so `?ring=1` reaches the
  room page untouched.

About forty lines across `index.html` and `room.html`, a field in
`public-room`, and an e2e case in `ring.spec.js`.

## Origin

Deferred while planning ringing (`docs/plans/2026-10-02-2050-ring-web-push.md`,
2026-10-02): the minimal version put Ring on the call page only, with the
list shortcut left for after trying it on real phones.
