# The Docker image cannot hold a call on localhost

**Status: open**

## Problem

The published image is set up for a server: it binds the SFU to every
interface, and the server quickstart sets `LIVEKIT_USE_EXTERNAL_IP=true`.
Run on a laptop to try quickmeet, the page loads on
`http://localhost:8080`, but media may not flow:

- With `LIVEKIT_USE_EXTERNAL_IP=true`, the SFU advertises the public IP
  it finds over STUN, which a browser on the same machine usually cannot
  reach back through the router.
- Without it, the SFU advertises the container's own addresses
  (172.17.x.x). A Linux host can reach those; Docker Desktop on macOS and
  Windows cannot.

Reasoned from the code (`src/quickmeet/system.lg`, `rtc-config`) on
2026-10-02, not tried.

## Idea

A `LIVEKIT_NODE_IP` variable mapped to LiveKit's `rtc.node_ip`, so a local
run can say `127.0.0.1`. Then the README could show a "try it with Docker"
command next to the server one:

```sh
docker run --rm -p 8080:8080 -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
  -e LIVEKIT_NODE_IP=127.0.0.1 -e LIVEKIT_API_SECRET=$(openssl rand -hex 32) \
  ghcr.io/abogoyavlensky/quickmeet:latest
```

Needs a unit test over `config`, a row in `docs/CONFIGURATION.md`, and a
real two-window call on macOS and Linux.
