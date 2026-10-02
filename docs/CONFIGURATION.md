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
