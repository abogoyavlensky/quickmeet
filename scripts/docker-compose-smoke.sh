#!/usr/bin/env bash
# Start deploy/docker (quickmeet behind Caddy) against the image
# scripts/docker-smoke.sh just built, ask for the home page over HTTPS, and
# check Caddy compresses the blur wasm.
# With the domain localhost Caddy issues itself a certificate, hence -k.
# Runs from a copy so the compose run's data/ never lands in the repo. It
# binds 80 and 443, so it is CI's check, not part of `lgx docker`.
set -u
export QUICKMEET_VERSION=local
export QUICKMEET_DOMAIN=localhost
# Never leaves the machine.
export LIVEKIT_API_SECRET=ci-smoke-test-secret-0123456789abcdef

# Where background blur's wasm lives, read before leaving the repository:
# the tag in the path is the one the bundle and routes.lg agree on.
wasm=$(grep -o "/static/blur/[^'\"]*" resources/public/track-processors.js | head -n 1)/vision_wasm_internal.wasm

docker tag quickmeet:local "ghcr.io/abogoyavlensky/quickmeet:$QUICKMEET_VERSION" || exit 1
dir=$(mktemp -d)
cp deploy/docker/compose.yaml deploy/docker/Caddyfile "$dir/"
cd "$dir" || exit 1
# The container writes data/ as root, so a container removes it.
# shellcheck disable=SC2329 # run by the trap
cleanup() {
  docker compose down -v > /dev/null 2>&1
  docker run --rm -v "$dir:/d" quickmeet:local rm -rf /d/data
  rm -rf "$dir"
}
trap cleanup EXIT

docker compose up -d || exit 1
status=0
curl -fsSk --retry 30 --retry-all-errors --retry-delay 1 \
  https://localhost/ > /dev/null || status=$?
# Caddy compresses what the app serves raw; the wasm is 9.4 MB without it.
if [ "$status" -eq 0 ]; then
  if ! curl -fsSk -o /dev/null -D - -H 'Accept-Encoding: gzip' "https://localhost$wasm" | grep -qi '^content-encoding:'; then
    echo "Caddy did not compress $wasm" >&2
    status=1
  fi
fi
docker compose ps -a
docker compose logs
exit $status
