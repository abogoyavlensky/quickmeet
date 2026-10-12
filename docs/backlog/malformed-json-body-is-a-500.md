# A malformed JSON body is a 500, not a 400

**Status: open**

## Problem

`read-json-body` (`src/quickmeet/routes.lg`) parses with `json/read-json` and
does not catch the parse error, so a body that is not JSON makes the handler
throw and let-go answers 500 with the error text. Seen on 2026-10-12 with
`curl -X POST /api/auth/signup -H 'Content-Type: application/json' -d 'not json'`:
status 500. The routes that read a body (`POST /api/auth/signup`, sign-in,
rename, token, push subscriptions, ...) all go through it.

It is a client mistake, so it should be a 400 with `{"error": ...}`, and it
should not show up as a server error in telemetry: the request span is marked
`error` for an exception, and since 2026-10-12 it is an `error` log line too
(`POST /api/auth/signup failed: ...`), so a scanner posting garbage makes noise.

## Idea

Catch the parse error in `read-json-body` (or once, around the route table)
and answer `json-response 400 {:error "invalid JSON"}`, with a test per kind
of body-reading route or one at the handler level. The message should not
echo the parser's text.
