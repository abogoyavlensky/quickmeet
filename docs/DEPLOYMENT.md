# Deployment and releases

[Back to quickmeet](../README.md) · [Configuration](CONFIGURATION.md)

To run quickmeet on your own server, follow
[the installation guide](INSTALL.md): the Docker image or the release
binary under systemd, Caddy in front for TLS, two media ports open.

## Releases

Only a pushed `vX.Y.Z` tag publishes anything;
`.github/workflows/release.yml` then runs the tests and, natively on an
amd64 and an arm64 runner, builds the static binary, smoke-tests the
image around it (`scripts/docker-smoke.sh`) and packs a tarball: the
binary, the files the guide installs (`deploy/`) and the guide itself,
plus its SHA-256. It pushes each architecture's image as
`ghcr.io/abogoyavlensky/quickmeet:X.Y.Z-<arch>`, joins them into one
multi-arch image tagged `X.Y.Z`, `X.Y` and `latest`, and creates the
GitHub release with both tarballs last, so a release never exists
without its image. There is no macOS build.

Running the workflow by hand (Actions, release, Run workflow) is a dry
run: the tests, both builds and smoke tests, nothing pushed.

The first push creates the ghcr.io package as private. Make it public
once: the package's settings, Change visibility. The image's
`org.opencontainers.image.source` label links it to the repository.

## Restarts and live calls

On SIGTERM (systemd, `docker stop`) the app stops serving, closes active
calls in history and exits. Browsers try to reconnect to the new process.
Recovery time varies: staging checks have seen interruptions of about
28 to 60 seconds, including a period when both people appear to be waiting.
See the [reconnection issue](backlog/reconnect-after-deploy-can-leave-both-waiting.md).

## Staging

Staging is restricted to the operator’s account; it is not a public service.
A push to master runs the tests, then `.github/workflows/deploy.yml`:
it builds `bin/quickmeet`, checks that it is statically linked, wraps it
in the `Dockerfile` (Alpine plus the binary, nothing built inside the
image), smoke-tests the image, and deploys `compose.yaml` with
[uncloud](https://github.com/psviderski/uncloud) (`uc`) to the
`unison-staging` cluster, at `https://quickmeet.absky.dev`.

- One hostname. uncloud's Caddy terminates TLS and routes `/rtc*` to the
  SFU's port 7880 and everything else to the app's port 8080. The app
  sees `x-forwarded-proto` and hands browsers `wss://<host>` as the
  signalling URL.
- Media cannot go through Caddy: the SFU takes all UDP media on one port,
  7882, plus ICE over TCP on 7881, both published in uncloud's host mode
  and advertised with the host's public IP (found over STUN). Both must
  be open in the server's firewall.
- The database is `/root/quickmeet-db/quickmeet.db` on the server, bind
  mounted at `/app/db`. It is disposable for now.

Repository settings the workflow needs: variables `SERVER_IP`,
`APP_DOMAIN` (`quickmeet.absky.dev`) and, optionally, `ALLOWED_EMAILS`;
secrets `SSH_PRIVATE_KEY` (a key the server accepts for root),
`LIVEKIT_API_KEY` (any short identifier) and `LIVEKIT_API_SECRET` (32+
random characters, e.g. `openssl rand -hex 32`). DNS for `APP_DOMAIN`
points at the server.

Starting a meeting takes an account. Staging's `ALLOWED_EMAILS` holds
the operator's address, so nobody else can sign up or sign in there;
unset, sign-up would be open. Rooms are permanent and hold two people.
Sign-in is limited to 10 attempts a minute and sign-up to 10 an hour per
client address, room creation to 60 an hour per account; over a limit
the answer is 429 with `Retry-After`.
