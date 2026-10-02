#!/usr/bin/env bash
# Start deploy/docker (quickmeet behind Caddy) against the image
# scripts/docker-smoke.sh just built, and ask for the home page over HTTPS.
# With the domain localhost Caddy issues itself a certificate, hence -k.
# Runs from a copy so the compose run's data/ never lands in the repo. It
# binds 80 and 443, so it is CI's check, not part of `lgx docker`.
set -u
export QUICKMEET_VERSION=local
export QUICKMEET_DOMAIN=localhost
# Never leaves the machine.
export LIVEKIT_API_SECRET=ci-smoke-test-secret-0123456789abcdef

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
docker compose ps -a
docker compose logs
exit $status
