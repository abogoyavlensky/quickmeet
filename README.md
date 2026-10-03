# quickmeet

Self-hosted 1-to-1 video calls from a single binary.

Create a room, share its link, and talk in your browser. Guests join without
an account. Reuse the same room for your next call.

## Host it yourself

quickmeet runs on your own server. There is no public hosted service.
The binary includes the app, [LiveKit](https://github.com/livekit/livekit)
for calls, and SQLite for storage. No separate media server, database
service, or container is required.

You need a **Linux server** (x86-64 or ARM64), a domain name, and HTTPS.
You can restrict account creation to an email allowlist.

### With Docker

```sh
docker run -d --name quickmeet --restart unless-stopped \
  -p 127.0.0.1:8080:8080 -p 127.0.0.1:7880:7880 \
  -p 7881:7881 -p 7882:7882/udp \
  -v quickmeet-data:/app/data \
  -e LIVEKIT_USE_EXTERNAL_IP=true \
  -e LIVEKIT_API_SECRET=$(openssl rand -hex 32) \
  -e ALLOWED_EMAILS=you@example.com \
  ghcr.io/abogoyavlensky/quickmeet:latest
```

Put an HTTPS reverse proxy in front: `/rtc*` to port 7880, everything
else to 8080. [`deploy/Caddyfile`](deploy/Caddyfile) does this for Caddy.
Open 7881/tcp and 7882/udp for media, then sign up at
`https://YOUR.DOMAIN/signup` with the allowed address. No proxy on the
server yet? The guide has a [Docker Compose setup with Caddy](docs/INSTALL.md#docker-compose-with-caddy).

### With the binary

The [installation guide](docs/INSTALL.md) covers running the release
binary with systemd, setting up Caddy for HTTPS, and opening the two
media ports.

## Highlights

- **A link you can keep.** Rooms stay available for future calls. Create
  one with an account; the other person only needs the link to join.
- **Camera, screen, and background blur.** Check your camera and microphone
  before joining. Share a screen, window, or tab from a desktop browser;
  people on phones can watch too.
- **Pick up where you left off.** Signed-in users have saved rooms and call
  history. Ring other room members who have enabled notifications.
- **Use it on your phone.** Open quickmeet in your browser or add it to your
  home screen. On iPhone, ringing requires the home-screen app.

## Try it locally

With [lgx](https://github.com/abogoyavlensky/lgx) 0.4.2 or newer and Go
installed (`.mise.toml` pins the tool versions):

```sh
git clone https://github.com/abogoyavlensky/quickmeet.git
cd quickmeet
CGO_ENABLED=0 lgx run
```

The first run builds the runtime with LiveKit and SQLite linked in.
Open [localhost:8080](http://localhost:8080), sign up, and click **New call**.
Open the room link in another browser window and join from both.

## Status

Under active development. Calls are limited to two people per room.
Email addresses are not verified, and there is no self-service password reset.
The installation guide still needs verification on a fresh server; phone
ringing and screen sharing also need testing on real devices.
[Report an issue](https://github.com/abogoyavlensky/quickmeet/issues) or
see the [roadmap](docs/ROADMAP.md).

## Documentation

- [Server installation](docs/INSTALL.md) and [configuration](docs/CONFIGURATION.md)
- [Development and testing](docs/DEVELOPMENT.md)
- [API reference](docs/API.md)
- [Deployment and releases](docs/DEPLOYMENT.md)
- [Stack and implementation notes](docs/KNOWLEDGE.md)

Written in [let-go](https://github.com/nooga/let-go), built with
[lgx](https://github.com/abogoyavlensky/lgx).

## License

[MIT](LICENSE).
