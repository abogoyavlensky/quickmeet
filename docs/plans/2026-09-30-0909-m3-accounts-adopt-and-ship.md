# M3: accounts, adopting the draft and shipping it — Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship M3 accounts on the `m3-accounts` branch: review the unapproved draft as a whole, fix what the review finds, make sessions last a year, finish the staging wiring and docs, and deploy with sign-up restricted to the operator's address.

**Tech Stack:** what the draft already uses: let-go 1.13.0 on lgx 0.4.2, `golang.org/x/crypto/bcrypt` as a `:go/interop` coord, sqlite and ragtime, HoneySQL rendered at load time, plain DOM pages, Playwright 1.56.0, Codex for review, uncloud for staging.

---

## Design

### How this plan came to be

On 2026-09-29 the harness replayed the message "Create a branch and execute" into a second turn of the M2 session. That turn, seeing M2 complete, planned M3 by itself, skipped the design approval fastplan requires, and executed seven of its eight tasks on `m3-accounts` before it was cut off (its plan: `docs/plans/2026-09-29-2236-m3-accounts.md`). Codex reviewed only its first two tasks before hitting a usage limit. The branch was never pushed.

On 2026-09-30 the design was read, presented and approved with three answers: passwords rather than magic links; adopt the draft after a full review rather than rebuild; restrict staging sign-up to the operator's address; and sessions should last a year. This plan is the record of that approval and the work that follows from it.

### The design, as approved

The draft plan's "Design" section stands, with two changes below. In short:

1. **Passwords with bcrypt**, no email anywhere. Accepted: the allowlist race (whoever registers an allowed address first owns it) and no password reset in v1; the operator deletes the row. Magic links would add SMTP, a second service, against the one-binary rule.
2. **Sessions are opaque random ids in sqlite** sent as a cookie, `HttpOnly; SameSite=Lax`, `Secure` behind TLS only. **Changed: they last one year**, not 30 days. "Indefinite" is not available: browsers cap a cookie's lifetime (Chrome at 400 days), so one year is the honest maximum. The cookie's `Max-Age` and the SQL window in `session-user` say the same number.
3. **The allowlist** (`ALLOWED_EMAILS`) is asked at sign-up, sign-in and on every request of a live session; unset means open sign-up. **Changed: staging gets the variable set** in this plan, to `abogoyavlensky@gmail.com`, so shipping M3 closes staging rather than leaving it open until someone remembers.
4. **Only creating a room needs a session.** Room page, lookup and join token stay open; rooms record a nullable owner for M4; the lobby pre-fills a signed-in person's display name.
5. **Three namespaces, thin routes**: `password`, `auth` (data in, data out), `db` (load-time SQL); `routes` maps results to statuses. Static pages with small DOM scripts.
6. **Accepted for v1, to list under M6**: sign-in timing reveals whether an address exists; no rate limits; no verification, reset or account deletion.

### What the review must cover

The draft's code was read on 2026-09-30 and looks right; both suites pass (28 unit tests, 20 browser specs). What it lacks is an independent review of Tasks 3 to 7, which is where the security-relevant code lives. The review is one pass over the whole branch against master, Codex plus a read of the diff, with these questions in mind:

- Cookie handling: parsing, the `Set-Cookie` attributes, `Secure` only behind the proxy, sign-out clearing the right cookie.
- Session lookup: the SQL window, no way to keep a session after the address leaves the allowlist.
- Sign-in and sign-up: normalisation, the same error for unknown address and wrong password, password byte limits, the allowlist checked in the right order.
- Gating: among the room operations only `POST /api/rooms` requires a session (the room page, the lookup and the join token stay open to guests); the account endpoints (`/api/me`, sign-out) keep their session checks. The room lookup does not leak `owner_id`, and `password_hash` never leaves `db`.
- Migration 002: up and down both work on a database that already has rooms. The existing test runs on an empty database; add a case that seeds rooms under 001, applies 002, rolls it back, and finds the rooms intact.
- Pages: a 401 on a protected action (creating a room, saving settings) sends to sign-in and never loops. A guest's room page and the signed-out landing page get a 401 from `/api/me` by design and must carry on.

Findings are fixed as commits on the branch, each with the usual Codex checkpoint. Advisory findings are noted in this plan.

### Out of scope

Everything the draft excluded, plus: session rotation, remembering the device, an admin page for the allowlist, the M6 items above.

## File Structure

**Modify (on `m3-accounts`):**
- `src/quickmeet/auth.lg`, `src/quickmeet/db.lg` — the one-year session window.
- `test/quickmeet/auth_test.lg`, `test/quickmeet/routes_test.lg` — the window in the assertions.
- `compose.yaml`, `.github/workflows/deploy.yml` — `ALLOWED_EMAILS` (the WIP commit started this; check it).
- `README.md`, `docs/ROADMAP.md`, `docs/KNOWLEDGE.md` — finish the draft's Task 8 text.
- `docs/plans/2026-09-29-2236-m3-accounts.md` — status, an approval note pointing here, an execution summary.
- whatever the review finds.

**Create:** this plan.

---

### Task 1: Review the branch as a whole

**Files:** whatever the findings touch.

- [ ] **Step 1: Codex review of the branch.** `codex exec review --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --base master -o .tmp/codex-review-m3-branch.md > .tmp/codex-review-m3-branch.log 2>&1` in the background. If Codex is still rate-limited (its answer says so, or the log shows a usage error), say so in the summary and rely on Step 2.
- [ ] **Step 2: Read the diff yourself** with the questions from "What the review must cover": `git diff master...m3-accounts -- src test resources e2e`. Write each finding down as must-fix or advisory before changing anything.
- [ ] **Step 3: Fix must-fix findings**, one commit each, tests first where a test can express the finding. Run `lgx test` after each.
- [ ] **Step 4: Record.** Under this task in the plan: every finding, its severity, and what was done. Advisory ones that are not done go to the backlog (`/backlog`, one commit each, `Backlog: ...`).
- [ ] **Step 5: Codex checkpoint** on the fix commits (`review-with-codex`), if there were any.

### Task 2: Sessions last a year

**Files:**
- Modify: `src/quickmeet/auth.lg`, `src/quickmeet/db.lg`, `test/quickmeet/auth_test.lg`, `test/quickmeet/routes_test.lg`

- [ ] **Step 1: Tests.** In `auth_test.lg`, the expiry case back-dates the session by 366 days and expects nil, and a session back-dated 364 days is still valid. In `routes_test.lg`, the `Set-Cookie` assertion expects `Max-Age=31536000`. Run `lgx test`; expected: those assertions fail.
- [ ] **Step 2: Implement.** One constant for the number of days in `auth.lg` (365), used for `max-age-seconds`; the SQL window in `db.lg`'s `session-user-sql` says `datetime('now', '-365 days')` with a comment that it must match `auth`'s constant. Update the docstrings that say 30 days.
- [ ] **Step 3: Run** `lgx test`. Expected: green.
- [ ] **Step 4: Commit.** `git commit -m "Sessions last a year"`
- [ ] **Step 5: Codex checkpoint** (`review-with-codex`, the commit).

### Task 3: Staging wiring and docs (the draft's Task 8, finished)

**Files:**
- Modify: `compose.yaml`, `.github/workflows/deploy.yml`, `README.md`, `docs/ROADMAP.md`, `docs/KNOWLEDGE.md`, `docs/plans/2026-09-29-2236-m3-accounts.md`

- [ ] **Step 1: Check the WIP commit's edits.** `git show --stat HEAD` and read each file's diff against `master`: keep what is right, finish what is half done. `compose.yaml`: `ALLOWED_EMAILS: ${ALLOWED_EMAILS:-}` with a comment; `deploy.yml`: `ALLOWED_EMAILS: ${{ vars.ALLOWED_EMAILS }}` beside `APP_DOMAIN`. Validate `compose.yaml` offline the way `docs/KNOWLEDGE.md` describes if the interpolation is in doubt.
- [ ] **Step 2: README.** Run: sign up, then "New meeting"; guests join from the link. Configuration table: `ALLOWED_EMAILS`. API: the auth endpoints, the 401 on `POST /api/rooms`. Layout: the new files. Deployment: the repository variable; staging is restricted to the operator's address. Sessions last a year.
- [ ] **Step 3: ROADMAP and KNOWLEDGE.** ROADMAP M3: items done with the date; the decisions (passwords, allowlist race accepted, no reset, one-year sessions); resolve the open question. Under M6: the sign-in timing note. KNOWLEDGE: keep the draft's "Accounts" section, add anything the review taught.
- [ ] **Step 4: The draft plan.** At its top: `> **Status: superseded by docs/plans/<this plan>.** Written and executed without design approval by a replayed turn on 2026-09-29; approved retroactively on 2026-09-30, see the newer plan.` Tick its Task 8 boxes as this task completes them, and add a short execution summary saying which tasks Codex reviewed and that Tasks 3 to 7 were reviewed as a whole in this plan.
- [ ] **Step 5: Commit.** `git commit -m "docs: M3 accounts, ALLOWED_EMAILS on staging"`

### Task 4: Ship

**Files:** none

- [ ] **Step 1: Full verification.** `lgx test` and `lgx e2e`, then `cd e2e && npx playwright test --repeat-each 2`. Expected: all green.
- [ ] **Step 2: The repository variable.** `gh variable set ALLOWED_EMAILS --body "abogoyavlensky@gmail.com"`. Confirm with `gh variable list`.
- [ ] **Step 3: PR.** Push `m3-accounts`, `gh pr create` titled `M3: accounts` with the approved decisions as the body, link it to the thread, watch `gh pr checks`, merge (squash, the repo's style) when green. The deploy follows.
- [ ] **Step 4: Staging check.** Against `https://quickmeet.absky.dev`: `POST /api/rooms` without a cookie is 401; sign-up with an address not on the allowlist is 403; the operator signs up (or in) from a browser and starts a meeting; a guest on another device joins the link with no account. Record the outcome in this plan and mark it completed.

