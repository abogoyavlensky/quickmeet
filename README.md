# quickmeet

Self-hosted 1-to-1 video calls from a single binary.

Create a room, share its link, and talk in your browser. Guests join without
an account. Reuse the same room for your next call.

## Host it yourself

quickmeet runs on your own server. There is no public hosted service.
The binary includes the app, [LiveKit](https://github.com/livekit/livekit)
for calls, and SQLite for storage. No separate media server, database
service, or container is required.

You need a **Linux x86-64 server**, a domain name, and HTTPS. The
[installation guide](docs/INSTALL.md) covers running the binary with
systemd, setting up Caddy for HTTPS, and opening the two media ports.
You can restrict account creation to an email allowlist.

There are no published releases yet. For now, [build from source](docs/INSTALL.md#build-from-source)
and use the guide's service and proxy setup with the files in [`deploy/`](deploy/).

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
