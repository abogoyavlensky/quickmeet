# Signups, rooms created and failed SFU lookups are not measured

**Status: open**

## Problem

The first metrics slice (`docs/plans/2026-10-13-0653-metrics.md`) exports
seven metrics, listed in `src/quickmeet/metrics.lg` and `telemetry/wrap-route`.
Three that were considered are not among them:

- **Signups.** Whether anyone new is using an instance. The signup route is
  `POST /api/auth/signup` (`src/quickmeet/routes.lg:418`); it is already visible
  as a request count per status in `http.server.request.duration`: a 201 on that
  route is a signup. So the number is recoverable today, just not named.
- **Rooms created.** Same reasoning for `POST /api/rooms`
  (`src/quickmeet/routes.lg:506`, status 201).
- **Failed SFU lookups.** `sfu/failed!` (`src/quickmeet/sfu.lg:25`) logs the
  reason as an `error` line, and the request's `sfu.*` child span is marked an
  error (`sfu-call` in `routes.lg`). A counter would make the rate readable
  without searching logs, and would be the thing to alert on once Tracelet has
  alerts.

## Proposed fix

Each is one function in `quickmeet.metrics` (a counter named
`quickmeet.signups`, `quickmeet.rooms.created`, `quickmeet.sfu.lookup.failures`,
no attributes) and one call at the site above. About three lines each plus a
case in `test/quickmeet/metrics_test.lg` and a row in the table in
`docs/CONFIGURATION.md`.

Notes for whoever picks this up: count a signup only when `auth/sign-up!`
succeeded, not when the route was reached (a refused address or a rate limit
also reaches it). `sfu/failed!` takes no span and runs outside a request in
some paths, so count there rather than in `sfu-call`. Attribute values must
stay bounded; the lookup `method` ("ListParticipants", "ListRooms") is.

## Why it is left alone

Nothing here is hard; the first slice stopped at the metrics that cover
health, load and the two failures that were silent (push, rate limits).
Signups and rooms are growth numbers for an instance with a handful of users,
and the request histogram already counts the 201s. Worth adding when someone
wants the number on a chart.

## Origin

Left out of `docs/plans/2026-10-13-0653-metrics.md` as YAGNI, 13 October 2026.
