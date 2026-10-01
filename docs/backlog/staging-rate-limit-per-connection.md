# On staging, per-address rate limits only hold within one connection

**Status: open**

## Problem

On staging (`https://quickmeet.absky.dev`), the sign-in limit (10 a
minute per client address, `src/quickmeet/ratelimit.lg`) triggers only
while the requests share one TCP connection. Measured 2026-10-01 from the
dev machine, whose outgoing address was the same for every request
(checked against an IP echo service):

- 15 sign-ins from one Node process over one kept-alive connection: ten
  401s, then 429 with `Retry-After: 59`. The limiter works.
- 12 sign-ins as 12 separate `curl` runs, over HTTP/2 or HTTP/1.1: all
  401, never 429.
- Ten sign-ins over one connection (429 from the ninth, the window
  already full), then three separate `curl` runs and a fresh Node
  process: all 401.

So the address the app keys on is constant within a connection and
different across connections. The app takes it from the last
`X-Forwarded-For` entry, which uncloud's Caddy sets to the peer it sees.
That Caddy publishes 80 and 443 in host mode
(`uncloud v0.20.0 pkg/client/caddy.go`), which keeps the client address
on the box. The likeliest cause is something in front of the server, in
the provider's network, that terminates connections and reconnects from a
pool of addresses. It would fit the dropped connections and the two
groups of connect times already seen there (`docs/KNOWLEDGE.md`, "The
first deploy"). Not confirmed: nobody has looked at the addresses Caddy
logs.

Locally, and on a box set up from `docs/INSTALL.md`, the same requests
hit the limit on the eleventh attempt, with or without
`X-Forwarded-For`.

How narrow: staging only, and staging's `ALLOWED_EMAILS` holds one
address, so brute-forcing a sign-in there is still bcrypt-bound
(about 60 ms a guess) and aimed at one account.

## Fix

First confirm the cause: `uc logs caddy` (or the Caddy access log on the
server) during a few separate `curl` sign-ins shows the `remote_ip` of
each. If it changes per request, the front rewrites addresses:

- If the front can send PROXY protocol or its own client-address header,
  configure Caddy's `trusted_proxies` and `client_ip_headers` for it in
  the `x-caddy` block, and keep the app's last-entry rule.
- Otherwise, accept it for staging and say so in the README.

If `remote_ip` is constant, the problem is between Caddy and the app,
and `client-ip` in `src/quickmeet/routes.lg` needs a look with the real
header values logged.

## Origin

Found on 2026-10-01 while verifying the release milestone on staging
(`docs/plans/2026-09-30-2252-release-milestone.md`, Task 12).
