# Russian Interface Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The interface reads in Russian for a browser set to Russian, in English otherwise, and a signed-in person can pin either language in Settings; everything a person sees, down to the ring notification, follows.

**Tech Stack:** One shared script, `resources/public/i18n.js`, plain DOM on the pages; a `language` column on `users` (ragtime migration in `src/quickmeet/migrations.lg`, HoneySQL in `src/quickmeet/db.lg`), `/api/me` in `src/quickmeet/routes.lg`; the service worker `resources/public/sw.js`; a Node check script; `lgx test` and Playwright e2e (`lgx e2e`).

---

## Design

### What the person sees

- A browser whose first preferred language is Russian
  (`navigator.languages[0]`, which is what `navigator.language` reports)
  gets every page in Russian: text, button labels, tooltips, placeholders,
  the tab title, confirm and prompt dialogs, the "Camera is off" word,
  the status line. Any other browser gets English, as today.
- Settings gains a section **Language** with one select: *Auto (browser)*,
  *English*, *Русский*. Changing it saves at once and the page switches
  under the cursor. The choice is the account's: it follows the person to
  every browser they sign in on.
- A guest has no settings and gets the browser's language. A guest with a
  Russian browser who wants English changes the browser; that case is
  rare and the app stays usable either way.
- A ring notification arrives in the language of the device it lands on:
  the recipient's pinned language if they pinned one, else that device's
  own language.
- Dates in History follow the pinned language; on Auto they follow the
  browser as they do today.

### How it works

**One dictionary, keys are the English sentences.** `i18n.js` holds
`const RU = { 'Join call': 'Присоединиться', ... }` and nothing for
English: `t(key)` returns the Russian for the current language when the
dictionary has it and the key itself otherwise. Strings with a variable
use `{name}` placeholders: `t('{name} is already here.', { name })`.
English stays in the markup as the source text, so the pages read as they
do now and the dictionary is the only new artefact. The key *is* the
English copy, so changing a sentence in English means changing its key;
the check script (below) catches a key the dictionary no longer has.

**Resolution.** `i18n.js` loads in `<head>` after `ui.js`, synchronously
like it. On load it computes:

```js
// The first preferred language only, the one navigator.language reports,
// so the page and the service worker (sw.js) decide the same way.
const auto = () => /^ru\b/i.test(navigator.language || '') ? 'ru' : 'en';
// 'auto' | 'en' | 'ru': the account's choice as last seen, cached on this device.
const pinned = () => stored.get('quickmeet.lang') || 'auto';
const lang = () => (pinned() === 'auto' ? auto() : pinned());
```

`stored` is ui.js's localStorage wrapper. The cache exists so a page can
render in the right language before `/api/me` answers, and so the room
page (which a signed-in person opens most) does not flash. It is a cache,
not the truth: every page calls `/api/me` on load (History does not
today and starts to: it is a signed-in page, and the call also replaces
its own 401 check) and writes the answer's `language` into the cache,
or on a 401 (a guest, or signed out) removes it; Sign out removes it
too. A guest therefore always gets Auto, except for
the few seconds after someone else signed out on that browser without
the page loading, which the next 401 corrects.

**Applying.** On `DOMContentLoaded`, `applyLanguage()`:

- sets `document.documentElement.lang` to `lang()`;
- translates `document.title` (its text is a key like any other);
- for every element with `data-i18n`: its `textContent` is the key
  (trimmed) when the attribute is empty, else the attribute's value is
  the key; the result goes into `textContent`. For an element that holds
  an inline child (`Signed in as <span id="email">`), such sentences are
  split so the span stands alone (see task 4).
- `data-i18n-placeholder`, `data-i18n-title`, `data-i18n-aria-label`:
  the key is the attribute's value when it has one, else the current
  value of the attribute it names (`placeholder`, `title`, `aria-label`);
  the translation replaces that attribute. The `<title>` element carries
  `data-i18n` like any text.
- **Keys are stored on the first pass.** Whenever a `data-i18n*`
  attribute is empty, `applyLanguage` writes the key it read into it
  before translating. The markup therefore stays English and short, and a
  second pass (a language change after load, Russian back to English)
  reads the English key, never the Russian it wrote. Without this the
  second pass would look up Russian text and find nothing.
- Text set from scripts goes through `t()` **wrapped around the literal
  itself**, wherever the literal sits: `setIcon(b, 'back', t('Back'))`,
  `on ? ['mic', t('Mute')] : ['mic-off', t('Unmute')]`,
  `const FULL = () => t('This call already has two people in it.')`.
  Never `t(variable)`: the check script (below) finds keys by looking for
  `t('...')` with a literal inside, so a literal that reaches `t` through
  a variable is invisible to it and stays English unnoticed. `setIcon`
  and the other `ui.js` helpers do not translate on their own; their
  callers pass translated text. `copyLink`'s `Copied` and `push.on`'s
  thrown sentences are literals inside `ui.js` and get `t()` there.

A page re-applies when the language changes after load: `/api/me`
answered with a different `language` than the cache, or the Settings
select changed. `applyLanguage()` is idempotent for markup thanks to the
stored keys. Text already written by scripts is redrawn by calling the page's
draw functions where cheap (the room page's `drawBlur`, `drawMedia`,
`drawRing`; the settings page's `drawRinging`); elsewhere a changed
language takes effect on the next load, which is fine for a once-a-year
change.

**The account's choice.** Migration `005-language`: `users.language text
not null default 'auto'`. `user-columns` gains `:language`;
`public-user` returns it; `POST /api/me` accepts `language` (one of
`auto`, `en`, `ru`, else 400 `bad input` via the existing
`error-response` shape) beside `display_name`, each optional, so the
name form and the language select post independently.
`auth/rename!` is left alone; a new `auth/set-language!` validates and
writes.

**The ring.** `db/ring-targets` returns `u.language` per device.
`ring-message` adds two fields to the payload, `from` (the caller's
display name) and `language` (the recipient's pinned value, `auto`
included). Since the payload differs per recipient, `ring` builds the
message per target (`deliver!` keeps its signature and is called once per
target, or takes a function; one call per target is simpler and the
targets are a handful). The service worker renders the text itself: with
`language` `ru`, or `auto` and the worker's own `navigator.language`
Russian, the title is `{from} хочет поговорить` and the body
`Нажмите, чтобы присоединиться`; otherwise the English the server also
sends as `title` and `body`, which stay as the fallback for a worker
that has not updated yet (browsers check for a new worker on navigation,
at most once a day). The Russian strings live in `sw.js` itself: a
worker cannot load the page's `i18n.js` synchronously and two sentences
do not justify `importScripts`.

**Dates.** `history.html`'s `when` passes a locale to `toLocaleString`:
`undefined` on Auto (the browser's own format, as today), `'ru'` or
`'en'` when pinned. A helper `localeOf()` in `i18n.js` returns it.

**Server strings a person sees.** The API's error codes are mapped to
sentences on the client already (`account.js` messages, `index.html`
`api()`); those sentences go through `t()`. The two sentences the server
sends ready-made (`Too many attempts. Try again later.`, the push
subscription problems) are shown as they are; `t()` translates them when
the dictionary has them, so they are added to it.

**Completeness check.** `scripts/check-i18n.mjs` (`lgx i18n-check`)
extracts every key from the pages and scripts, by exactly the two
conventions above:

- markup: for every tag carrying a `data-i18n*` attribute, the key is
  the attribute's value when non-empty; for an empty `data-i18n` it is
  the tag's text up to the next `<`, trimmed; for an empty
  `data-i18n-placeholder` / `-title` / `-aria-label` it is the value of
  `placeholder` / `title` / `aria-label` *in the same tag* (the script
  matches whole tags, `<[^>]+>`, then reads attributes inside the match);
- scripts: every `t('...')` or `t("...")` with a literal first argument,
  in the pages' inline scripts, `ui.js` and `account.js`.

It reports any key missing from `RU` and any `RU` key no file uses, and
exits 1 on a missing key. It is a regex pass, not a parser: template
literals and concatenations are not keys, and the plan keeps them out of
`t()` by using `{x}` placeholders instead.

**Tests.** The e2e browser is pinned to `locale: 'en-US'` in
`playwright.config.js` so every existing spec keeps finding its buttons
by English name. A new `i18n.spec.js` opens contexts with
`locale: 'ru-RU'`.

### Not in scope

Pluralised counts (none in the UI beyond `1 waiting`, which has one
form); a language switch for guests; translating `docs/`, the README or
the API's error codes themselves. The worker's rendering of the ring is
checked by hand on staging (a Russian device, a pinned English one), not
by e2e: Playwright cannot receive a Web Push.

## File Structure

- Create: `resources/public/i18n.js`: `RU`, `t`, `lang`, `localeOf`,
  `applyLanguage`, the cache helpers.
- Create: `scripts/check-i18n.mjs`: the completeness check.
- Modify: `resources/public/ui.js`: `setIcon` and `copyLink` translate;
  `push` sentences through `t()`; Sign out clears the cache.
- Modify: `resources/public/index.html`, `history.html`, `settings.html`,
  `signin.html`, `signup.html`, `room.html`: `data-i18n` on markup,
  `t()` in scripts, the `i18n.js` tag, the cache write from `/api/me`.
- Modify: `resources/public/account.js`: `t()` on the messages.
- Modify: `resources/public/sw.js`: the Russian ring.
- Modify: `src/quickmeet/migrations.lg`, `db.lg`, `auth.lg`, `routes.lg`:
  the column, `/api/me`, the ring payload.
- Modify: `lgx.edn`: the `i18n-check` task.
- Modify: `e2e/playwright.config.js`: `locale`. Create:
  `e2e/tests/i18n.spec.js`.
- Modify: `test/quickmeet/routes_test.lg`, `db_test.lg` or
  `migrations_test.lg` as fits: the column, `/api/me`, the ring payload.
- Modify: `docs/API.md`, `docs/DEVELOPMENT.md`, `docs/ROADMAP.md`,
  `docs/KNOWLEDGE.md`.

---

### Task 1: The server side: a language on the account

**Files:**
- Modify: `src/quickmeet/migrations.lg`, `src/quickmeet/db.lg`,
  `src/quickmeet/auth.lg`, `src/quickmeet/routes.lg`
- Test: `test/quickmeet/routes_test.lg`, `test/quickmeet/migrations_test.lg`

- [x] **Step 1: Write the failing tests**
  `routes_test.lg`, in `accounts-and-sessions` or a new
  `the-account-language`: a fresh account's `GET /api/me` has
  `"language": "auto"`; `POST /api/me {"language":"ru"}` answers 200
  with `language ru` and leaves `display_name` as it was; `GET` then
  shows `ru`; `POST {"language":"de"}` answers 400; `POST {"display_name":"x"}`
  without `language` leaves the language alone. `migrations_test.lg`:
  if it lists migrations by id, add `005-language`; rollback and
  re-apply still work.
  Run: `lgx test`
  Expected: FAIL on the new assertions.

- [x] **Step 2: Migration and db**
  `migrations.lg`: `(migration "005-language" [{:alter-table :users :add-column [:language :text [:not nil] [:default "auto"]]}] [{:alter-table :users :drop-column :language}])`
  with a comment. `db.lg`: `:language` in `user-columns`; an
  `update-language-sql` and `update-language!` shaped like the display
  name's; `ring-targets-sql` selects `u.language` too and its docstring
  lists it.

- [x] **Step 3: auth and routes**
  `auth.lg`: `set-language!` taking `conn user-id language`, `bad-input`
  unless the value is one of `#{"auto" "en" "ru"}` (a `languages` set in
  the namespace). `routes.lg`: `public-user` selects `:language` too;
  `POST /api/me` reads the body, applies `rename!` when `display_name`
  is present and `set-language!` when `language` is present, in that
  order, answering the first error or the final `public-user`. A body
  with neither answers 400.
  > Deviation: the route checks the language before anything is written,
  > so `{"display_name": "x", "language": "de"}` changes nothing rather
  > than saving the name and refusing the language. An empty body answers
  > 400 `Nothing to change.`

- [x] **Step 4: Run the tests**
  Run: `lgx test`
  Expected: PASS.
  > 83 tests, 603 assertions, 0 failures. Two older migration tests
  > assumed 004 was the last migration and were updated. A new
  > `migration-005-both-ways` checks an existing account gets `auto` and
  > survives the rollback.
  > Codex review: a non-object JSON body made `contains?` throw. Fixed:
  > such a body is read as empty and answers 400, with a test.

- [x] **Step 5: Commit**
  `git commit -m "Accounts: a language on the account, auto by default"`

### Task 2: The ring carries the recipient's language

**Files:**
- Modify: `src/quickmeet/routes.lg`, `resources/public/sw.js`
- Test: `test/quickmeet/routes_test.lg`

- [x] **Step 1: Extend the ring test**
  In `ringing-the-other-members` (routes_test.lg:726), the captured
  payload gains `:from "alice"` and `:language "auto"`; a second
  recipient whose language was set to `ru` gets `:language "ru"` in
  theirs, while `:title` and `:body` stay English.
  Run: `lgx test`
  Expected: FAIL.

- [x] **Step 2: Build the message per target**
  `ring-message` takes the target too and adds `:from` and `:language`
  (the target's, `auto` when nil). The ring route calls
  `push/deliver!` with a one-element vector per target, or `deliver!`
  gains an arity taking a `message-for` function; pick the one that
  keeps `push_test.lg` passing unchanged (the single-message arity must
  stay).
  > One `deliver!` call per target, with a one-element vector. `push.lg`
  > is unchanged. `db_test.lg` pins a ring target's shape and gains
  > `:language`.

- [x] **Step 3: The worker renders it**
  `sw.js`'s push handler: `const ru = ring.language === 'ru' || (ring.language !== 'en' && /^ru\b/i.test(navigator.language || ''));`
  then title `ru && ring.from ? ring.from + ' хочет поговорить' : ring.title || 'quickmeet'`,
  body `ru ? 'Нажмите, чтобы присоединиться' : ring.body || 'Someone wants to talk.'`.
  Update the comment at the top of the file: the worker translates
  the ring itself.
  > Deviation: Russian also requires `from`, so a payload without it is
  > all English rather than an English title over a Russian body. Checked
  > in Node with a stubbed `self` across pinned, auto and fallback cases.

- [x] **Step 4: Run the tests**
  Run: `lgx test`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "Ring: the notification arrives in the recipient's language"`

### Task 3: `i18n.js` and the check script

**Files:**
- Create: `resources/public/i18n.js`, `scripts/check-i18n.mjs`
- Modify: `resources/public/ui.js`, `lgx.edn`, `src/quickmeet/routes.lg`
- Test: `test/quickmeet/routes_test.lg`

- [x] **Step 1: Write `i18n.js`**
  As in the design: `RU` (empty for now), `auto`, `pinned`, `lang`,
  `localeOf` (`undefined` when pinned is `auto`, else the language),
  `t(key, vars)` (replace `{x}` from `vars`), `applyLanguage()`, and
  `rememberLanguage(value)` which writes the cache (removing it for
  `null`) and, when `lang()` changed, calls `applyLanguage()` and
  returns true. A header comment in the voice of `ui.js`. `applyLanguage`
  stores the key into an empty `data-i18n` on its first pass.
  `document.addEventListener('DOMContentLoaded', applyLanguage)`.
  > Deviation: `i18n.js` reads localStorage through its own small wrapper
  > instead of `ui.js`'s `stored`. The sign-in and sign-up pages do not
  > load `ui.js`. It also sets `html[lang]` as soon as it loads, before
  > the DOM is ready.

- [x] **Step 2: `ui.js`**
  `copyLink` writes `t('Copied')`; `push.on` and
  `pushKey`/`saveSubscription` throw `t(...)` sentences (the status code
  stays a `{status}` variable); Sign out calls `rememberLanguage(null)`
  before leaving. `setIcon` is unchanged: callers pass `t('...')`.
  > `copyLink` builds its `Copied` span with `textContent` now, since the
  > text is no longer a fixed literal inside markup.

- [x] **Step 3: Serve it**
  `routes.lg` serves `/static/i18n.js` through `/static/:file` already
  (any `.js` under `public/`); add a `pages-and-static` assertion that
  every page links `/static/i18n.js` once task 4 adds the tags. For now,
  only confirm `GET /static/i18n.js` is 200 with the JS content type.
  Run: `lgx test`
  Expected: PASS.
  > Deviation: the `<script src="/static/i18n.js">` tags went onto all six
  > pages here, not in task 4. `ui.js` calls `t` from this task on, and a
  > page without the script would break on copying a link. The route test
  > checks every page links it. `lgx test` 83 tests, 0 failures; the
  > account, rooms, landing and ring e2e specs 19 passed.

- [x] **Step 4: Write `scripts/check-i18n.mjs`**
  Reads the six pages, `ui.js`, `account.js`; collects keys as the
  design's "Completeness check" lists: whole tags (`<[^>]+>`) with a
  `data-i18n*` attribute, resolving empty ones to the tag's text or its
  `placeholder`/`title`/`aria-label`; and `\bt\(\s*(['"])(.*?)\1` literals.
  Loads `RU` by `import`ing `i18n.js` under a tiny stub of `window`,
  `document`, `navigator`, `stored`, or by evaluating the `const RU = {...}`
  block with `vm`; prints missing keys and unused keys; exits 1 on
  missing. `lgx.edn` gets `i18n-check {:doc "..." :do {:sh "node scripts/check-i18n.mjs"}}`.
  Run: `lgx i18n-check`
  Expected: exits 1, listing `Copied` and the `ui.js` sentences wrapped
  in step 2. Task 4 marks the pages and fills the dictionary; nothing is
  translated in this task.

- [x] **Step 5: Commit**
  `git commit -m "i18n: the dictionary script and its completeness check"`

### Task 4: The pages speak Russian

**Files:**
- Modify: `resources/public/index.html`, `signin.html`, `signup.html`,
  `settings.html`, `history.html`, `room.html`, `account.js`, `i18n.js`
- Test: `e2e/playwright.config.js`, `e2e/tests/i18n.spec.js`

- [x] **Step 1: Pin the e2e locale and write the Russian test**
  `playwright.config.js` `use`: `locale: 'en-US'`. New `i18n.spec.js`:
  - "a Russian browser gets the lobby in Russian": `newRoom(page)` with
    the default (English) page, then `openLobby` with
    `{ locale: 'ru-RU' }`: `html[lang]` is `ru`, `#join` reads
    `Присоединиться`, `#identity`'s placeholder is Russian, the blur
    button's `aria-label` is Russian, `#presence` says nobody has joined
    in Russian. The English host's page is unaffected.
  - "the landing page and sign-in in Russian": a `ru-RU` context visits
    `/`: the hero `h1` and the Sign in link are Russian; `/signin`'s
    heading is Russian.
  Run: `lgx build && cd e2e && npx playwright test i18n`
  (Playwright runs `bin/quickmeet`, which embeds the pages: every
  targeted run rebuilds first.)
  Expected: FAIL.
  > The sign-in test also submits a wrong password and expects the
  > server's sentence in Russian. The sign-in heading is «Войти», not
  > «Вход»: it shares the key "Sign in" with the link.

- [x] **Step 2: Mark the markup**
  Every page: `<script src="/static/i18n.js">` after `ui.js`. Every
  user-visible text node gets `data-i18n` (empty); placeholders, titles
  and `aria-label`s get their `data-i18n-*`. Sentences with an inline
  child are split so the child is its own element outside the
  translated text (`Signed in as <span>` becomes `<span data-i18n>Signed in as</span> <span id="email">`;
  `No account yet? <a>Sign up</a>` is two marked elements). The
  `<title>` is translated by `applyLanguage` from its text.
  > The room page's `<title>` is just "quickmeet" and is not marked.
  > Settings' "Signed in as {email}." lost its full stop when split.

- [x] **Step 3: Route the scripts' strings through `t()`**
  Every literal a person can see, in all six pages and `account.js`:
  the constants at the top of `room.html` become functions returning
  `t('...')` (so a language change after load takes effect), every
  `setIcon` label and `drawSwitch` label is `t('...')` around the
  literal, the template strings
  become `t('{name} is already here.', { name })` and the like,
  `prompt`/`confirm` texts, `presenceOf`, `duration`'s `in progress`,
  `Room {id}`, `nobody`, the device fallbacks `Camera {n}`, the ring
  button's `Ring {name}` / `Ring them` / `Rung`. `history.html`'s `when`
  passes `localeOf()`, and its `load()` first fetches `/api/me` (401
  goes to sign-in, as its calls fetch does today) so the language is
  known before the rows are drawn. Every page passes `/api/me`'s
  `language` to `rememberLanguage`, and `null` on 401 (the room page
  too). Where `rememberLanguage` returns true, the page redraws
  what scripts wrote: the room page calls `drawBlur`, `drawMedia`,
  `drawRing` and re-sets the static icon labels (`leave`, `back`,
  `copy`/`invite`); the other pages' script text is all drawn after
  `/api/me` anyway.
  > The room page gained `drawLabels` (link buttons, Leave, Back, the
  > settings button) and `redraw`, which also redraws the call's buttons
  > and status when joined. The server's ready-made sentences a page can
  > show (sign-up and sign-in validation, the name limits, too many
  > attempts) are mapped to `t('...')` literals on that page, so the
  > check sees them. The push-endpoint errors stay English: they are
  > technical and rare.

- [x] **Step 4: Run the check, fill the dictionary**
  Run: `lgx i18n-check`
  Expected: a list of every missing key. Translate them all into `RU`
  in `i18n.js`: natural Russian, informal-polite (вы), short labels for
  buttons (`Присоединиться`, `Выключить микрофон`, `Размыть фон`,
  `Убрать размытие`, `Поделиться экраном`, `Завершить`). Re-run until
  it exits 0. `docs/DEVELOPMENT.md` gets a paragraph: how a string is
  added (mark it or wrap it, run `lgx i18n-check`, fill `RU`).
  > 112 keys, 0 missing, 0 unused.

- [x] **Step 5: Run the e2e suites**
  Run: `lgx build && cd e2e && npx playwright test i18n`
  Expected: PASS.
  Run: `lgx e2e`
  Expected: PASS: every other spec still finds its English labels.
  > 76 of 77 passed. The one failure was the known parallel-load timeout
  > of "blurred into the call…", which passed alone on one worker.
  > Codex review: a late `/api/me` with another language re-translated
  > the bar's `#remote-name` mark and wiped the other person's name.
  > Fixed: the page keeps who is there and `drawRemoteName` draws it; the
  > element is no longer marked. A test changes the language mid-call and
  > reads the name at once.

- [x] **Step 6: Commit**
  `git commit -m "Russian: every page in the browser's language"`

### Task 5: The language setting

**Files:**
- Modify: `resources/public/settings.html`, `i18n.js`
- Test: `e2e/tests/i18n.spec.js`

- [x] **Step 1: Write the test**
  "the account pins a language": sign up in an `en-US` context, open
  `/settings`, select `Русский` in `#language`; the page's `h1` becomes
  `Настройки` without a reload, `html[lang]` is `ru`; reload: still
  Russian; open `/` : Russian; select *English* back on `/settings`
  without reloading: the `h1`, the tab title and the name field's
  placeholder are English again (the stored keys at work); `/history`
  opened directly in a fresh tab of the same context is English with
  English dates. And the other way: a `ru-RU` context signs up, pins
  English, reloads: English. And a fresh context with no cache: an
  `en-US` context signs in (`/signin`) to the account that pinned
  Russian; `/` is Russian once `/api/me` has answered (the cache is
  empty, the account decides).
  Run: `lgx build && cd e2e && npx playwright test i18n`
  Expected: FAIL.

- [x] **Step 2: The section**
  `settings.html`: a `<section class="form">` after Notifications, `h2`
  Language, a muted line (follows the browser unless pinned), and
  `<select id="language">` with options `auto`, `en`, `ru` labelled
  `Auto (browser)`, `English`, `Русский` (the names of the languages
  stay in their own language and are not translated: no `data-i18n` on
  `English` and `Русский`). On `change`: `POST /api/me {language}`, then
  `rememberLanguage(value)`; the page redraws `drawRinging()` and the
  `status`/`error` lines when it returns true. A failed save (not 200)
  shows the server's message in a `#language-error` line and puts the
  select back to the last saved value; nothing is cached. `load()` sets
  the select from `/api/me`.
  > The select carries a label, "Language of the interface", and the
  > section a line saying Auto follows this browser. A sixth e2e test
  > covers a refused save: the select goes back and the error shows.
  > The sign-out half of the Russian-browser test checks the cache is
  > cleared: the landing page is Russian again.

- [x] **Step 3: Run the tests and the check**
  Run: `lgx i18n-check && lgx build && cd e2e && npx playwright test i18n`
  Expected: PASS.
  > 116 keys, 0 missing; i18n spec 6 passed.

- [x] **Step 4: Commit**
  `git commit -m "Settings: pin the language, or follow the browser"`

### Task 6: Docs

**Files:**
- Modify: `docs/API.md`, `docs/ROADMAP.md`, `docs/KNOWLEDGE.md`

- [ ] **Step 1: Write it down**
  `docs/API.md`: `/api/me`'s `language` field and the accepted values.
  `docs/ROADMAP.md`, "After v1": a dated Done line. `docs/KNOWLEDGE.md`:
  the choices that are not obvious from the code: keys are English
  sentences, the cache is not the truth, the worker translates the
  ring, the e2e locale is pinned.

- [ ] **Step 2: Commit**
  `git commit -m "docs: the Russian interface"`
