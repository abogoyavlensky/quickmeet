# While a screen is shared, the sharer's face is not shown

**Status: open**

## Problem

When the other person shares their screen, the screen takes the stage and
their camera disappears until the share ends; only their voice is left.
In a 1:1 call that loses the face for as long as a share lasts. Meet and
similar apps show it in a small tile beside the screen.

The page chooses one remote video for the stage: `showRemote()` in
`resources/public/room.html` (about line 193) shows `remoteVideo.screen`
if there is one, else `remoteVideo.camera`. The camera track stays
subscribed throughout, attached to no element.

## Proposed fix

Viewer side only; the sender already publishes both tracks.

- A second remote `<video>` in a small tile, filled from
  `remoteVideo.camera` while `remoteVideo.screen` is set, by one more
  branch in `showRemote()`. Attaching it also makes `adaptiveStream`
  resume the camera's layer for that element's size.
- Two small tiles then share the stage, the self view and the other
  person's face. The self view sits bottom right (`.tile.self`,
  `resources/public/app.css` lines 180, 212, 225 and 227); the new tile
  needs a place that clears the controls and the self view on a desktop,
  and on a phone held upright and sideways.

The phone layout is the expensive part. Every change to it so far
(orientation, the redesign, the immersive controls) took rounds on real
devices that headless Chromium could not replace. Budget for that.

Also left out of the first version: a shared tab's audio (Chrome can
capture it; `setScreenShareEnabled` asks for `audio: false`).

## Origin

Deferred in the discussion before
`docs/plans/2026-10-02-2023-screen-sharing.md` (2026-10-02). The viewer
was to see the screen alone first, with the tracks handled so this tile
could be added later without touching the sending side.
