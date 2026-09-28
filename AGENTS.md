# Agent notes

Project knowledge lives in `docs/KNOWLEDGE.md` (the stack, verified facts,
gotchas) and `docs/ROADMAP.md` (milestones and open questions).
Implementation plans live in `docs/plans/`.

## Backlog

`docs/backlog/` holds known issues and ideas that are not being worked on yet.

- One file per issue, named after it (`format-selection-column-offset.md`).
- Each file starts with `**Status: open**`. When a plan is written for it,
  change the status to `**Status: planned**` with a `Plan: docs/plans/...`
  line under it; when the work ships, change it to `**Status: done**` with a
  line saying where it landed. Never delete an entry.
- "What's in the backlog?" means the open files — list every file whose status
  is not done, with its title.
- Adding an entry is its own commit (`Backlog: <what>`), never mixed with code.
