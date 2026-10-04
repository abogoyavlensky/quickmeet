# Lobby on a Desktop Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: completed 2026-10-04** (summary at the end)

**Goal:** On a wide screen the lobby uses the width: the camera preview large on the left, everything else in a column on the right; phones and narrow windows look as they do today.

**Tech Stack:** CSS in `resources/public/app.css`, one wrapper element in `resources/public/room.html`, Playwright e2e (`lgx e2e`).

---

## Design

### The problem

The lobby is one column capped at 560px (`app.css`, `.lobby`), the same
column the app pages use. The preview is 16:9 inside it: on a 1440px
screen that is a 520 by 290 video, with the name field and two pickers
under it. The lobby is "check yourself before you join", and a 290px
video is small for that. The cap never bites on a phone, where the
layout is right.

### What changes

Above a new wide breakpoint the lobby becomes two columns:

```
+--------------------------------------+  +--------------------+
|                                      |  | Nobody has joined  |
|            preview 16:9              |  | [ Your name ][Join]|
|   (mic) (cam)             (blur)     |  | Camera   [select]  |
|                                      |  | Microphone [select]|
+--------------------------------------+  +--------------------+
```

- **Breakpoint:** `@media (min-width: 900px) and (min-height: 501px)`.
  Below 900px wide the current single column stays (between the phone
  query's 700px and 900px two columns would be cramped); the height
  clause keeps a short landscape window, which the phone query already
  treats as a phone, out of it.
- **Grid:** `#lobby { grid-template-columns: minmax(0, 1fr) 320px; gap: 32px; align-items: center; max-width: 1120px; }`.
  The preview fills the left cell at 16:9, so at 1120px it is about 730
  by 410; at the breakpoint (900 minus 40 padding, 32 gap and the 320
  column) about 508 by 286, within a few pixels of today's 520, so
  nothing visibly shrinks across the switch.
- **Vertical position:** in the wide layout the lobby takes
  `margin-block: auto` so it sits in the middle of the room page's
  flex column instead of hanging from the bar. Narrow layouts keep
  `margin: 8px auto 0`.
- **The right column** holds, in order: presence (the lobby's heading),
  the notice, the join row (name field and Join as today, `1fr auto`),
  the error, and the device pickers stacked one per row
  (`.devices { grid-template-columns: 1fr }` in the wide layout).
- **Markup:** the lobby's non-preview children move into one wrapper,
  `<div class="lobby-side">`, a grid with the lobby's 16px gap. The lobby
  grid then has exactly two items, the preview and the side, in both
  layouts: one column narrow, two wide. No `display: contents`, no
  reordering. `#gone` keeps `class="lobby"` and is untouched: the wide
  rules are scoped to `#lobby`.
- **Nothing else moves.** The microphone, camera and blur buttons stay on
  the preview; the bar and the call are unchanged.

### Testing

A new e2e test in `e2e/tests/lobby.spec.js`, at the default desktop
viewport (1280 by 720): the preview's box is wider than 600px and its
right edge is left of the Join button's left edge; at 800 by 720
(`page.setViewportSize`) the Join button's top is below the preview's
bottom (one column); and at 1280 by 480 (wide but short, which the
phone query treats as a phone) one column again. `mobile.spec.js`
covers the phone layout already and is not touched.

## File Structure

- Modify: `resources/public/room.html`: the `.lobby-side` wrapper.
- Modify: `resources/public/app.css`: the wrapper's grid and the wide
  media query.
- Modify: `e2e/tests/lobby.spec.js`: the layout test.
- Modify: `docs/ROADMAP.md`: a Done line.

---

### Task 1: The wrapper and the wide layout

**Files:**
- Modify: `resources/public/room.html`, `resources/public/app.css`
- Test: `e2e/tests/lobby.spec.js`

- [x] **Step 1: Write the e2e test**
  In `lobby.spec.js`, test "a wide screen puts the preview beside the
  controls": `newRoom(page)`, wait for `#preview` to have `videoWidth > 0`,
  read `boundingBox()` of `.preview` and `#join`; expect preview width
  `> 600` and `preview.x + preview.width <= join.x`. Then
  `page.setViewportSize({ width: 800, height: 720 })`, read the boxes
  again; expect `join.y >= preview.y + preview.height` and preview width
  `<= 560`. Then `{ width: 1280, height: 480 }`: one column again
  (`join.y >= preview.y + preview.height`).
  Run: `lgx build && cd e2e && npx playwright test lobby`
  (Playwright runs `bin/quickmeet`, which embeds the pages: every
  targeted run rebuilds first.)
  Expected: FAIL (the preview is at most 520 wide).

- [x] **Step 2: Wrap the lobby's side**
  In `room.html`'s `#lobby`, move `#presence`, `#notice`, the `.join-row`,
  `#error` and `.devices` into `<div class="lobby-side">` after the
  `.preview`. Update the section's comment to say the side is one block
  so a wide screen can set it beside the preview.

- [x] **Step 3: Style it**
  In `app.css`, after the `.devices` rule: `.lobby-side { display: grid; gap: 16px; }`.
  Then the wide query, placed with the other room-page media queries,
  with a comment in the file's voice (a desktop has the width; the
  preview is what the lobby is for):
  ```css
  @media (min-width: 900px) and (min-height: 501px) {
    #lobby { grid-template-columns: minmax(0, 1fr) 320px; gap: 32px; align-items: center; max-width: 1120px; margin-block: auto; }
    #lobby .devices { grid-template-columns: 1fr; }
  }
  ```
  Check the preview's `aspect-ratio: 16 / 9` and `width: 100%` already
  size it from the column (they do); check the phone query's
  `.preview { aspect-ratio: 3 / 4; max-height: 40dvh; }` cannot apply at
  the same time as the wide query (it cannot: the phone query needs
  width ≤ 700 or height ≤ 500).

- [x] **Step 4: Run the lobby tests and look at it**
  Run: `lgx build && cd e2e && npx playwright test lobby`
  Expected: PASS.
  Then `lgx run`, open a room at a full desktop window, an 800px-wide
  window, and a phone-sized window (devtools), and confirm: two columns
  centred vertically; one column at 560 as today; the phone layout as
  before. Also `#gone` (`/room/000000000000`) at a desktop width:
  unchanged.
  > Checked with Playwright screenshots at 1440x900, 800x720 and 390x844,
  > and of `#gone` at 1440x900, rather than with `lgx run` by hand.

- [x] **Step 5: Run the whole e2e suite**
  Run: `lgx e2e`
  Expected: PASS (`mobile.spec.js` in particular).
  > 73 passed.

- [x] **Step 6: Commit**
  `git commit -m "Lobby: the preview beside the controls on a wide screen"`

### Task 2: Docs

**Files:**
- Modify: `docs/ROADMAP.md`

- [x] **Step 1: A Done line under "After v1"**
  Dated, in the style of its neighbours: the lobby is two columns from
  900px wide.

- [x] **Step 2: Commit**
  `git commit -m "docs: the lobby on a desktop"`

## Summary

**Status: completed.** From 900px wide, with at least 501px of height,
the lobby is two columns: the preview on the left, up to about 730px
wide, and a 320px column with presence, the name, Join and the stacked
pickers. The lobby sits in the middle of the page. Narrower or shorter
windows keep the single column, and phones are unchanged. One wrapper
element holds the side, so the lobby grid has two items in both layouts.

Verification: the new layout test in `lobby.spec.js` checks the desktop,
narrow and wide-but-short cases. The full e2e suite passed 73 of 73, and
`lgx test` needs no change for CSS and markup. Screenshots at three
widths and of the missing-room page look right.

Deviations, gathered:
- The visual check used Playwright screenshots instead of `lgx run` by
  hand.

What the plan could have specified better: nothing.

