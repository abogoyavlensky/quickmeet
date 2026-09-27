# quickmeet

1-to-1 video calls from a single binary. The
[LiveKit](https://github.com/livekit/livekit) SFU runs inside the app
process; the browser talks to it directly for media and to the app for
pages, rooms and join tokens. Written in
[let-go](https://github.com/nooga/let-go), built with
[lgx](https://github.com/abogoyavlensky/lgx).

Status: foundation. A room can be created, joined with camera and
microphone, and two people can talk. Accounts, contacts, history and a
deployment guide are on the roadmap ([docs/ROADMAP.md](docs/ROADMAP.md)).
What we have learned about the stack is in
[docs/KNOWLEDGE.md](docs/KNOWLEDGE.md).

## Run

Needs lgx 0.4.2 or newer and the Go toolchain on `PATH` (`.mise.toml`
pins both). The first run builds an `lg` with LiveKit and sqlite linked
in, which takes a minute; every run after that is a cache hit.

```
lgx run                 # http://localhost:8080, quickmeet.db in the cwd
lgx test                # handler, migrations and the whole system
lgx build && ./bin/quickmeet
```

Open http://localhost:8080, click "New meeting", open the room link in a
second window, join from both.

## Configuration

Every setting is an environment variable with a development default.
The defaults bind to loopback with a well-known key: fine on a laptop,
wrong on a server.

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | the app's http port |
| `DB_PATH` | `quickmeet.db` | the sqlite file |
| `LIVEKIT_PORT` | `7880` | SFU http and signalling port |
| `LIVEKIT_BIND` | `127.0.0.1` | SFU bind address |
| `LIVEKIT_RTC_TCP_PORT` | `7881` | ICE over TCP |
| `LIVEKIT_UDP_START`, `LIVEKIT_UDP_END` | `50000`, `50100` | media port range |
| `LIVEKIT_USE_EXTERNAL_IP` | `false` | advertise the public IP in ICE candidates |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | dev values | token signing; the secret must be 32+ characters |
| `LIVEKIT_LOG_LEVEL` | `warn` | |

## Layout

```
main.lg                        starts the system, waits on the http server
src/quickmeet/system.lg        the integrant config from the environment
src/quickmeet/db.lg            ::conn (open + migrate), queries
src/quickmeet/migrations.lg    the schema history (ragtime over sqlite)
src/quickmeet/routes.lg        ::handler: pages, /api/rooms, join tokens
src/quickmeet/server.lg        ::http: http/start on init, http/stop on halt
resources/public/              index.html, room.html, app.css
test/quickmeet/                routes over a temp db; migrations; the full system
docs/                          ROADMAP.md, KNOWLEDGE.md
```

The components chain `server -> handler -> db` and `server -> livekit`,
so integrant starts the database and the SFU first and halts them last.

## API

```
POST /api/rooms                  -> 201 {"id": "0123456789ab"}
GET  /api/rooms/:id              -> 200 {"id", "created_at"} | 404
POST /api/rooms/:id/token        {"identity": "alice"}   (identity optional)
                                 -> 200 {"token", "identity", "url"} | 404
GET  /room/:id                   the room page
```

The token is a LiveKit join token for that room only, valid for an hour.
`url` is the signalling address the browser should connect to.
