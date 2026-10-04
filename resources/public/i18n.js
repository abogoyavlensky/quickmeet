// The interface's language: English, or Russian for a browser whose first
// language is Russian, unless a signed-in person pinned one in Settings.
//
// The English sentences are the keys: the markup keeps its English text
// and marks it (`data-i18n`, and `data-i18n-placeholder`, `-title`,
// `-aria-label` for attributes), and scripts wrap a literal in `t('...')`.
// RU holds the Russian for each key; a key it lacks stays English.
// `lgx i18n-check` lists the keys RU is missing (scripts/check-i18n.mjs),
// so a literal must reach `t` as a literal, never through a variable.
//
// The account holds the choice (/api/me, `language`). This device keeps a
// copy, so a page can be drawn in the right language before /api/me
// answers. Every page writes /api/me's answer into it (`rememberLanguage`)
// and clears it on a 401, so a guest always follows the browser.

const LANGUAGE_KEY = 'quickmeet.lang';

// Storage can be refused (some private modes); the browser decides then.
const languageStore = {
  get() { try { return localStorage.getItem(LANGUAGE_KEY); } catch (e) { return null; } },
  set(value) { try { localStorage.setItem(LANGUAGE_KEY, value); } catch (e) { /* not remembered */ } },
  remove() { try { localStorage.removeItem(LANGUAGE_KEY); } catch (e) { /* not remembered */ } },
};

// The first preferred language only, the one navigator.language reports,
// so the pages and the service worker (sw.js) decide the same way.
const autoLanguage = () => (/^ru\b/i.test(navigator.language || '') ? 'ru' : 'en');
// 'auto', 'en' or 'ru': the account's choice as last seen here.
const pinnedLanguage = () => {
  const value = languageStore.get();
  return value === 'en' || value === 'ru' ? value : 'auto';
};
const lang = () => (pinnedLanguage() === 'auto' ? autoLanguage() : pinnedLanguage());
// For dates: the browser's own format while following it, else the
// pinned language's.
const localeOf = () => (pinnedLanguage() === 'auto' ? undefined : lang());

const RU = {
};

// The text for `key` in the current language; `{name}` in it is replaced
// from `vars`.
function t(key, vars) {
  let text = (lang() === 'ru' && RU[key]) || key;
  if (vars) text = text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
  return text;
}

// Translates every marked element. An empty mark takes the English it
// finds as its key and keeps it, so a second pass (the language changed
// after load) reads the key, never the Russian the first one wrote.
const TRANSLATED_ATTRIBUTES = ['placeholder', 'title', 'aria-label'];
function applyLanguage() {
  document.documentElement.lang = lang();
  for (const el of document.querySelectorAll('[data-i18n]')) {
    if (!el.dataset.i18n) el.dataset.i18n = el.textContent.trim();
    el.textContent = t(el.dataset.i18n);
  }
  for (const attribute of TRANSLATED_ATTRIBUTES) {
    const mark = 'data-i18n-' + attribute;
    for (const el of document.querySelectorAll(`[${mark}]`)) {
      if (!el.getAttribute(mark)) el.setAttribute(mark, el.getAttribute(attribute) || '');
      el.setAttribute(attribute, t(el.getAttribute(mark)));
    }
  }
}

// The account's choice, as /api/me gave it ('auto', 'en', 'ru'), or null
// for nobody signed in. Redraws the marked text and answers true when the
// language changed, so the page can redraw what its scripts wrote.
function rememberLanguage(value) {
  const before = lang();
  if (value) languageStore.set(value);
  else languageStore.remove();
  if (lang() === before) return false;
  applyLanguage();
  return true;
}

document.addEventListener('DOMContentLoaded', applyLanguage);
// The language is known before the page is: say it at once.
document.documentElement.lang = lang();
