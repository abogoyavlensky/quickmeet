#!/usr/bin/env bash
# Build the image around bin/quickmeet, start it, and ask for the home page.
# `lgx docker` builds the binary first. The image's own defaults bind the
# SFU and pick the UDP port, so this also checks they start. Docker's port
# proxy accepts the connection before the app listens and then resets it,
# which curl does not count as retryable, hence --retry-all-errors. No
# --rm, so a container that crashed still has its logs to print.
set -u
if ! file bin/quickmeet | grep -q 'statically linked'; then
  echo "bin/quickmeet is missing or not statically linked (build with CGO_ENABLED=0)" >&2
  exit 1
fi
docker build -t quickmeet:local . || exit 1
docker rm -f quickmeet-smoke > /dev/null 2>&1
# Bound off loopback, the app refuses the development secret; this one
# never leaves the machine.
docker run -d --name quickmeet-smoke -p 8080:8080 \
  -e LIVEKIT_API_SECRET=ci-smoke-test-secret-0123456789abcdef \
  -e DB_PATH=/tmp/quickmeet.db quickmeet:local > /dev/null || exit 1
status=0
curl -fsS --retry 15 --retry-all-errors --retry-delay 1 \
  localhost:8080/ > /dev/null || status=$?
docker ps -a --filter name=quickmeet-smoke
docker logs quickmeet-smoke
docker rm -f quickmeet-smoke > /dev/null
exit $status
