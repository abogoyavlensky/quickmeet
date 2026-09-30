# Installing quickmeet on one box

This guide installs quickmeet on a single linux/amd64 server: the binary as
a systemd service, Caddy in front of it for TLS, and two ports open for
media. It takes about fifteen minutes.

> Written on 2026-09-30 from the staging deployment at
> `https://quickmeet.absky.dev`, which runs the same binary in a container.
> As of that date the steps below had not yet been run end to end on a
> fresh box. If a step does not work as written, please open an issue.

## What you need

- A linux/amd64 server with a public IP address. A small VPS is enough:
  the app uses about 100 MB of memory plus about 25 MB per call.
- A DNS name pointing at that address, for example `meet.example.com`.
  Browsers only allow camera access over HTTPS, so there is no way around
  a name and a certificate.
- Root access, and these ports reachable from the internet:

| Port | For |
|---|---|
| 80/tcp, 443/tcp | Caddy: the certificate, the pages, the signalling WebSocket |
| 7881/tcp | media over TCP, for networks that block UDP |
| 7882/udp | media |

Every other port stays closed. In particular 8080 (the app) and 7880 (the
SFU's signalling) listen on loopback only; Caddy reaches them there.

## 1. Download and verify the release

Pick the latest tag from the
[releases page](https://github.com/abogoyavlensky/quickmeet/releases), then:

```bash
VERSION=v0.1.0   # the tag you picked
NAME=quickmeet-$VERSION-linux-amd64
curl -fLO https://github.com/abogoyavlensky/quickmeet/releases/download/$VERSION/$NAME.tar.gz
curl -fLO https://github.com/abogoyavlensky/quickmeet/releases/download/$VERSION/$NAME.tar.gz.sha256
sha256sum -c $NAME.tar.gz.sha256
tar xzf $NAME.tar.gz
cd $NAME
```

The directory holds the binary, the systemd unit, a Caddyfile, an example
environment file, and this guide.

## 2. Install the binary and the service

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin quickmeet
install -m 755 quickmeet /usr/local/bin/quickmeet
install -m 644 quickmeet.service /etc/systemd/system/quickmeet.service
```

The unit runs the app as the `quickmeet` user, keeps its database in
`/var/lib/quickmeet` (systemd creates it), and reads its settings from
`/etc/quickmeet/env`.

## 3. Write the settings

```bash
install -d -m 755 /etc/quickmeet
install -m 600 quickmeet.env.example /etc/quickmeet/env
openssl rand -hex 32    # paste the output as LIVEKIT_API_SECRET
```

Edit `/etc/quickmeet/env`:

- Set `LIVEKIT_API_SECRET` to the random value. The app refuses to start
  with its built-in development secret once the SFU is reachable from
  other machines, because anyone who knows that secret can mint tokens
  for your server.
- Set `ALLOWED_EMAILS` to the addresses that may have an account,
  comma-separated. Left empty, anyone who finds the site can sign up and
  start calls on your bandwidth.

The file explains every other variable; the defaults in it are right
for this setup. The full list is the "Configuration" table in the
[README](https://github.com/abogoyavlensky/quickmeet#configuration).

## 4. Open the firewall

Before Caddy, so its first certificate request can reach the box. With
`ufw`, for example:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 7881/tcp
ufw allow 7882/udp
ufw enable
```

Keep SSH open or you lock yourself out. Open nothing else: 8080 and 7880
already listen on loopback only (`HOST=127.0.0.1`, and the SFU's default
bind), and a closed firewall is the second layer. That matters for more
than tidiness: the rate limits trust the client address Caddy forwards,
and a client that could reach the app directly could claim any address.

## 5. Install Caddy

Install Caddy from your distribution or from
[caddyserver.com](https://caddyserver.com/docs/install), then:

```bash
sed 's/meet.example.com/YOUR.DOMAIN/' Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy
```

Caddy gets a certificate for the name on its own. It sends `/rtc*` to the
SFU's signalling and everything else to the app; the WebSocket upgrade
needs no extra configuration.

## 6. Start it

```bash
systemctl daemon-reload
systemctl enable --now quickmeet
journalctl -u quickmeet -n 20
```

The log should end with `quickmeet on http://localhost:8080` and, from
the SFU, `found external IP via STUN`.

## 7. The first account

Open `https://YOUR.DOMAIN/signup` and sign up with an address from
`ALLOWED_EMAILS`. There is no email verification: whoever registers an
allowed address first owns it, so sign up yourself before you tell anyone
else about the site. To give someone an account, add their address to
`ALLOWED_EMAILS`, `systemctl restart quickmeet`, and tell them to sign up.

## 8. Check a real call

From a checkout of the repository, with Node installed and
`lgx e2e-setup` run once, hold a two-browser call against your instance:

```bash
QM_URL=https://YOUR.DOMAIN QM_EMAIL=you@example.com QM_PASSWORD='...' QM_SECS=30 lgx smoke
```

It prints `PASS` when both sides are in the call with media flowing both
ways, and deletes the room it made. The browsers run on the machine you
run it from, so run it from somewhere other than the server.

The check that matters most is still two phones on different networks,
one of them on mobile data: open a room link on both and talk.

## Upgrading

Download the new release as in step 1, then:

```bash
install -m 755 quickmeet /usr/local/bin/quickmeet
systemctl restart quickmeet
```

The database migrates itself on start. A call that is on during the
restart shows "Reconnecting…" and comes back by itself, usually within
about 20 seconds; nobody has to click anything. If the server is away for
longer than about 45 seconds, the browsers give up and return to the
lobby, and the people join again.

## Backups

Everything quickmeet remembers is in `/var/lib/quickmeet/quickmeet.db`:
accounts, rooms and call history. Nothing backs it up for you yet
([backlog entry](https://github.com/abogoyavlensky/quickmeet/blob/master/docs/backlog/sqlite-backups.md)).
A copy that is safe to take while the app runs, as the `quickmeet` user so
no file in its directory ends up owned by root (install the `sqlite3`
package first):

```bash
install -d -o quickmeet -m 700 /var/backups/quickmeet
runuser -u quickmeet -- sqlite3 /var/lib/quickmeet/quickmeet.db ".backup /var/backups/quickmeet/quickmeet.db"
```

Put that in a daily cron job and copy the result off the box.

## What is not there

- **Password reset.** There is no email. To reset someone's password,
  delete their sessions and their account, then they sign up again and
  keep nothing from the old account:

  ```bash
  systemctl stop quickmeet
  runuser -u quickmeet -- sqlite3 /var/lib/quickmeet/quickmeet.db \
    "delete from sessions where user_id = (select id from users where email = 'them@example.com');
     delete from users where email = 'them@example.com';"
  systemctl start quickmeet
  ```
- **TURN.** A network that blocks both UDP 7882 and TCP 7881 cannot join a
  call. Most networks allow one of the two.
- **More than one box.** State is one sqlite file and the SFU runs inside
  the app; quickmeet is one process on one server.
