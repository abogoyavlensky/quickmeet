# Configuration

[Back to quickmeet](../README.md) · [Installation](INSTALL.md)

Every setting is an environment variable with a development default.
The defaults bind the SFU to loopback with a well-known key: fine on a
laptop. Once the SFU is reachable from other machines (`LIVEKIT_BIND`
off loopback, `LIVEKIT_USE_EXTERNAL_IP=true` or `LIVEKIT_PUBLIC_URL`
set), the app refuses to start with that key's secret and says so.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | the app's http port |
| `HOST` | unset | the app's bind address: unset or `0.0.0.0` for every interface, `127.0.0.1` for loopback only (a proxy on the same box). Nothing else: the SFU posts its webhooks to `127.0.0.1` |
| `RATE_LIMIT` | `true` | `false` switches the rate limits off (the browser tests do) |
| `DB_PATH` | `quickmeet.db` | the sqlite file |
| `ALLOWED_EMAILS` | unset | comma-separated addresses that may sign up, sign in and keep a session; unset, sign-up is open |
| `LIVEKIT_PORT` | `7880` | SFU http and signalling port |
| `LIVEKIT_BIND` | `127.0.0.1` | SFU bind address; `0.0.0.0` when a proxy reaches it from another host or container |
| `LIVEKIT_RTC_TCP_PORT` | `7881` | ICE over TCP |
| `LIVEKIT_UDP_START`, `LIVEKIT_UDP_END` | `50000`, `50100` | media port range |
| `LIVEKIT_UDP_PORT` | unset | when set, all media over this one UDP port; the range is ignored |
| `LIVEKIT_USE_EXTERNAL_IP` | `false` | advertise the public IP in ICE candidates |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | dev values | token signing; the secret must be 32+ characters, and the dev one is refused on an exposed SFU |
| `LIVEKIT_LOG_LEVEL` | `warn` | |
| `LIVEKIT_PUBLIC_URL` | unset | the signalling URL handed to browsers; otherwise derived from the request |

## Telemetry

quickmeet can send one trace per HTTP request, its warning and error
log lines, and a few metrics to any OTLP/HTTP receiver ([Tracelet](https://github.com/abogoyavlensky/tracelet),
an OpenTelemetry Collector, a vendor). It is **off** unless an endpoint is
set. The standard OpenTelemetry variables configure it, so the same lines
work for any SDK; all are optional:

| Variable | Purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | the receiver's base URL, e.g. `https://tracelet.absky.dev`; `/v1/traces`, `/v1/logs` and `/v1/metrics` are added. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `_LOGS_ENDPOINT` and `_METRICS_ENDPOINT` set one signal's full URL. Unset (and no per-signal one), nothing is sent |
| `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Bearer <ingest token>`: the credential the receiver wants |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf`, the only encoding there is |
| `OTEL_EXPORTER_OTLP_COMPRESSION` | `gzip` or none |
| `OTEL_SERVICE_NAME` | the service name; defaults to `quickmeet` |
| `OTEL_RESOURCE_ATTRIBUTES` | e.g. `deployment.environment.name=staging,service.version=abc1234`; Tracelet files records under these two |
| `OTEL_TRACES_SAMPLER` | sampling; the default records every request |
| `OTEL_METRIC_EXPORT_INTERVAL` | milliseconds between metric exports; default 60000 |

What is recorded: for each request, a server span named by the route
*pattern* (`GET /api/rooms/:id`, never the raw path), with
`http.request.method`, `http.route` and `http.response.status_code`, an error
status for a 5xx or an exception, and a child span for each question put to
the SFU. Log lines: the startup line, the shutdown lines, and the errors
below, tied to a request's trace where there is one. Every one is also
printed to stdout, whether or not telemetry is on.

| Level | Line | Meaning |
|---|---|---|
| error | `GET /api/rooms/:id failed: <message>` | a handler threw (the client got a 500) |
| error | `GET /api/rooms/:id answered 503` | a handler answered 5xx |
| error | `the SFU could not be asked (ListParticipants): <reason>` | a lookup failed, which reads as "nobody there" to the lobby and the two-person check. Not tied to a trace; the request's `sfu.*` child span is marked an error instead |
| warn | `a webhook failed verification` | something posted to the webhook URL without the SFU's signature |
| warn | `removed a participant: the room's owner is not in it` | the owner rule: two people were in a room without its owner (each held a token minted while the room was empty), and the one who joined last was disconnected. No room id in the line |

Lines name the route pattern, never the raw path, which holds a room id.

Metrics, exported every 60 s (and once more when the process stops):

| Metric | Type | Attributes | Meaning |
|---|---|---|---|
| `http.server.request.duration` | histogram, `s` | `http.request.method` (`_OTHER` for an unusual verb), `http.route`, `http.response.status_code` | how long a request took; an exception counts as 500 |
| `quickmeet.calls.active` | gauge | | calls in progress |
| `quickmeet.participants.active` | gauge | | people in a call right now |
| `quickmeet.call.duration` | histogram, `s` | | how long a call lasted, from the first join to the room closing |
| `quickmeet.token.requests` | counter | `outcome`: `ok`, `full`, `owner_absent`, `not_found` | join-token requests; `full` is a third person turned away, `owner_absent` a second person without the room's owner |
| `quickmeet.rate_limit.rejected` | counter | `bucket`: `signin`, `signup`, `create_room` | requests answered 429 |

The two gauges are set from the SFU's webhooks, so they are as current as the
last webhook that arrived. `quickmeet.call.duration` counts only calls the SFU
closed itself: a call closed at startup or shutdown has an overstated end.
Attribute values are bounded: never a room id, a user id or a raw path.

What is not recorded: raw URLs and query strings, cookies, the
`Authorization` header, request and response bodies, email addresses, room
ids (the link that grants entry).

Exports are batched (every 5 s or when a batch fills) and flushed when the
process stops on SIGTERM or SIGINT. A rejected token or an unreachable
endpoint shows as `otel: ...` lines on stderr, and does not affect requests.

