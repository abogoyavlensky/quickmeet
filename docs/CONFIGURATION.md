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

quickmeet can send one trace per HTTP request and its warning and error
log lines to any OTLP/HTTP receiver ([Tracelet](https://github.com/abogoyavlensky/tracelet),
an OpenTelemetry Collector, a vendor). It is **off** unless an endpoint is
set. The standard OpenTelemetry variables configure it, so the same lines
work for any SDK; all are optional:

| Variable | Purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | the receiver's base URL, e.g. `https://tracelet.absky.dev`; `/v1/traces` and `/v1/logs` are added. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `_LOGS_ENDPOINT` set one signal's full URL. Unset (and no per-signal one), nothing is sent |
| `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Bearer <ingest token>`: the credential the receiver wants |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf`, the only encoding there is |
| `OTEL_EXPORTER_OTLP_COMPRESSION` | `gzip` or none |
| `OTEL_SERVICE_NAME` | the service name; defaults to `quickmeet` |
| `OTEL_RESOURCE_ATTRIBUTES` | e.g. `deployment.environment.name=staging,service.version=abc1234`; Tracelet files records under these two |
| `OTEL_TRACES_SAMPLER` | sampling; the default records every request |

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
| error | `the SFU could not be asked (ListParticipants): <reason>` | a lookup failed, which reads as "nobody there" to the lobby, the two-person check and the ring |
| warn | `a webhook failed verification` | something posted to the webhook URL without the SFU's signature |
| warn | `push to <host> failed` | a ring did not reach a device |

Lines name the route pattern, never the raw path, which holds a room id.

What is not recorded: raw URLs and query strings, cookies, the
`Authorization` header, request and response bodies, email addresses, room
ids (the link that grants entry), push endpoints. A push failure is exported
as `push to <host> failed`, with the status if there was one, and never with
the HTTP client's error text, which can hold the whole subscription URL. The
same line printed to stdout keeps that text.

Exports are batched (every 5 s or when a batch fills) and flushed when the
process stops on SIGTERM or SIGINT. A rejected token or an unreachable
endpoint shows as `otel: ...` lines on stderr, and does not affect requests.

