# API reference

[Back to quickmeet](../README.md) · [Development](DEVELOPMENT.md)

```
POST /api/auth/signup            {"email", "password"}
                                 -> 201 {"email", "display_name"} + Set-Cookie: session=...
                                  | 400 {"error": "<what is wrong>"} | 403 {"error": "not allowed"} | 409 {"error": "exists"} | 429
POST /api/auth/signin            {"email", "password"}
                                 -> 200 {"email", "display_name"} + Set-Cookie | 401 {"error": "invalid email or password"} | 403 | 429
POST /api/auth/signout           -> 200 {} + Set-Cookie clearing the session
GET  /api/me                     -> 200 {"email", "display_name", "language"} | 401
POST /api/me                     {"display_name", "language"} (either or both)
                                 -> 200 {"email", "display_name", "language"} | 400 | 401
POST /api/rooms                  -> 201 {"id": "0123456789ab"} | 401 (needs a session) | 429
GET  /api/rooms?page=N           -> 200 {"items": [{"id", "name", "created_at", "owner": bool, "present": n}],
                                         "page": n, "more": bool} | 401
POST /api/rooms/:id              {"name"} (blank clears) -> 200 the room | 400 | 401 | 403 (not the owner) | 404
DELETE /api/rooms/:id            -> 200 {} | 401 | 403 | 404
GET  /api/rooms/:id              -> 200 {"id", "name", "created_at", "participants": [{"identity", "name"}],
                                         "owner_needed": bool} | 404
POST /api/rooms/:id/token        {"identity": "alice"}   (the name a guest typed; optional)
                                 -> 200 {"token", "identity", "name", "url"} | 404
                                 | 409 {"error": "full"} | 409 {"error": "owner-absent"}
GET  /api/calls?page=N           -> 200 {"items": [{"room_id", "started_at", "ended_at", "seconds", "with"}],
                                         "page": n, "more": bool} | 401
POST /api/webhooks/livekit       the embedded SFU's events, signed with the API key -> 200 | 401
GET  /sw.js                      a stub that unregisters the service worker v0.1.0 installed
GET  /room/:id                   the room page
GET  /history                    the history page
GET  /signup, /signin, /settings the account pages
```

`language` is the interface's language for the account: `"auto"` (the
default) follows the browser, `"en"` and `"ru"` pin one. Any other value
is a 400, and both fields are checked before either is saved, so a bad
one changes nothing.

Sessions are opaque ids in sqlite, sent as an `HttpOnly` `SameSite=Lax`
cookie (`Secure` behind TLS), valid for a year. Passwords are bcrypt
hashes (8 to 72 bytes); emails are stored lower-cased and are not
verified, so with an allowlist, whoever registers an address first owns
it. There is no password reset: the operator deletes the row. The
account endpoints accept only `Content-Type: application/json` (415
otherwise), which keeps a cross-site form from signing a visitor in as
someone else. A 429 carries `Retry-After` in seconds and
`{"error": "Too many attempts. Try again later."}`; the limits are per
client address for sign-in and sign-up (the last `X-Forwarded-For`
entry behind a proxy) and per account for room creation. An unknown
address and a wrong password take the same time to refuse.

`participants` is who the SFU has in the room right now (the lobby polls
it); the token endpoint answers 409 once two people are in. Rooms never
expire. `GET /api/rooms` lists the rooms the caller owns or has joined,
newest first, with `present` from one question to the SFU; renaming and
deleting are the owner's. Both lists, rooms and calls, come 20 at a time:
`page` counts from 1 (missing or malformed is 1, past the end is an empty
`items`), and `more` says an older page exists. Asking for a token with a session makes the
caller a member of that room.

A participant's `identity`, what the SFU keys on, is `user:<id>` for an
account and `guest:<4 hex>` otherwise; `name` is what people see (the
display name, or what a guest typed). History is written from the SFU's
webhooks (`participant_joined`, `participant_left`, `room_finished`),
which it posts to `/api/webhooks/livekit` on loopback; `ended_at` and
`seconds` are null while a call is on, and `with` names the others.

A call always includes the room's owner. Anyone holding the link may be in
the room alone, but a second person gets in only if one of the two is the
signed-in owner (identity `user:<owner id>`). The token endpoint answers
`409 {"error": "owner-absent"}` otherwise, and `owner_needed` in the room
lookup says the same for the visitor asking: exactly one person is there
and neither they nor the visitor is the owner. A guest is never the owner.
A token lasts an hour, so the check alone could be sidestepped by asking
for two tokens while the room is empty; the SFU's `participant_joined`
webhook closes that by removing the participant that event is about when
the pair breaks the rule. If the SFU cannot be asked, the rule reads the
room as empty and lets people in.

The token is a LiveKit join token for that room only, valid for an hour.
`url` is the signalling address the browser should connect to:
`LIVEKIT_PUBLIC_URL` when set; behind a proxy that sends
`x-forwarded-proto`, `ws`/`wss` on the host the request came in on;
otherwise `ws://<host>:<LIVEKIT_PORT>`.
