# A guest holding a room's link cannot ring its members

**Status: open**

## Problem

Only a signed-in caller can ring. `POST /api/rooms/:id/ring` answers 401
without a session (`src/quickmeet/routes.lg`), and the token response
gives a guest `"ring": []`, so the call page never shows the button to
one. A guest who opens Anna's link and waits has no way to tell Anna
they are there beyond the rooms list's "1 waiting", which she sees only
if she has the list open.

## Why it is left alone

The ring rule is "someone in the room right now", checked against the
SFU's participants by identity (`in-room?`). A guest's identity is a
random `guest:<hex>` from the token endpoint, and nothing ties a later
ring request to it: anyone who has the link could call the endpoint
claiming to be in the room. Fixing that means a proof of presence, for
example the join token itself sent with the ring and verified, plus a
limit keyed by address rather than account, since a guest has no
account to limit.

A room's link is shared on purpose, so a guest is usually someone the
member invited; ringing them back is the member's move. Worth doing if
real use shows people waiting unnoticed.

## Origin

Decided while planning ringing (`docs/plans/2026-10-02-2050-ring-web-push.md`,
2026-10-02), key decision 2 of the design: only signed-in callers ring.
