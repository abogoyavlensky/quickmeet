# The sqlite database has no backup

**Status: open**

## Problem

Everything quickmeet remembers lives in one sqlite file (`DB_PATH`):
accounts, sessions, rooms, members and call history. Nothing copies it
anywhere. A lost disk or a bad `rm` loses every account and every room
link people have saved, and the links are the product: rooms are
permanent (ROADMAP M2).

On staging the README calls the database disposable, which is true for
now. On an instance someone relies on it is not.

## Fix

Continuous replication with [Litestream](https://litestream.io) to
object storage, the plan already written for linkboard:

- In the uncloud deployment, a Litestream sidecar service that mounts the
  same host directory (`/root/quickmeet-db`) and replicates
  `quickmeet.db` to an S3-compatible bucket. The database is a bind
  mounted file on the host, so the sidecar needs nothing from the app.
- On a single box installed from `docs/INSTALL.md`, Litestream as a
  second systemd unit reading `/var/lib/quickmeet/quickmeet.db`.
- WAL mode is already on (`src/quickmeet/db.lg`, the DSN), which is what
  Litestream needs.
- Document the restore: stop the app, `litestream restore`, start it.

Until then, `docs/INSTALL.md` documents a manual copy that is safe
while the app runs:

```bash
sqlite3 /var/lib/quickmeet/quickmeet.db ".backup /var/backups/quickmeet.db"
```

Notes for whoever picks this up:

- Litestream is a second process and needs bucket credentials, which
  rubs against "one binary". It is a sidecar, not part of the binary, so
  an operator who does not want it loses nothing.
- Check that migrations on startup are fine with a restored database
  (they should be: ragtime records what it applied in the file itself).

## Origin

Moved out of ROADMAP M6 on 2026-09-30, when M5 and M6 were merged into
the release milestone (`docs/plans/2026-09-30-2252-release-milestone.md`)
and backups were deliberately left out of it.
