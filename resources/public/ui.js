// Shared by the pages: the icons, and the disc that stands for a person.

// 24x24, drawn with the current colour. `hang` is a filled handset turned
// face down; the rest are outlines (`blur`'s dots aside).
const ICONS = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  'mic-off': '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 3l16 18"/>',
  video: '<rect x="2.5" y="6" width="13" height="12" rx="3"/><path d="M15.5 10.5l6-3.5v10l-6-3.5"/>',
  'video-off': '<rect x="2.5" y="6" width="13" height="12" rx="3"/><path d="M15.5 10.5l6-3.5v10l-6-3.5M4 3l16 18"/>',
  hang: '<path fill="currentColor" stroke="none" transform="rotate(135 12 12)" d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  // A person, sharp, with the background around them in dots. The dots
  // are filled: as zero-length strokes they vanish at 20px.
  blur: '<circle cx="12" cy="9" r="3.5"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/><g fill="currentColor" stroke="none"><circle cx="3" cy="6" r="1.1"/><circle cx="3" cy="11.5" r="1.1"/><circle cx="3" cy="17" r="1.1"/><circle cx="21" cy="6" r="1.1"/><circle cx="21" cy="11.5" r="1.1"/><circle cx="21" cy="17" r="1.1"/><circle cx="7.5" cy="3" r="1.1"/><circle cx="16.5" cy="3" r="1.1"/></g>',
};

function icon(name) {
  return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
}

// A button that is only an icon: the label is its accessible name and its
// tooltip.
function setIcon(button, name, label) {
  button.innerHTML = icon(name);
  if (label) { button.setAttribute('aria-label', label); button.title = label; }
}

// "Copied" for a moment after a click, then the button as it was.
async function copyLink(button, url) {
  await navigator.clipboard.writeText(url);
  if (button.dataset.busy) return;
  button.dataset.busy = '1';
  const before = button.innerHTML;
  button.innerHTML = icon('check') + (button.classList.contains('icon') ? '' : '<span>Copied</span>');
  setTimeout(() => { button.innerHTML = before; delete button.dataset.busy; }, 1500);
}

// A person's disc: their initial on one of eight hues, picked by their
// name so a person keeps their colour everywhere. The initial is drawn by
// CSS from the attribute, so it never becomes part of the row's text.
// Nameless (a room nobody named yet), the disc is neutral with a link icon.
function setAvatar(el, name) {
  const text = (name || '').trim();
  if (!text) {
    el.removeAttribute('data-initial');
    el.style.removeProperty('--hue');
    el.innerHTML = icon('link');
    return;
  }
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  el.innerHTML = '';
  el.dataset.initial = [...text][0].toUpperCase();
  el.style.setProperty('--hue', [25, 60, 95, 150, 195, 240, 285, 330][hash % 8]);
}

// ---- pages of a list ----------------------------------------------------

// The page a list is on lives in the address (?page=N, none for the first),
// so a reload, or Back from a room, lands on it again.
function pageInUrl() {
  const n = parseInt(new URLSearchParams(location.search).get('page'), 10);
  return n > 0 ? n : 1;
}

function setPageInUrl(page) {
  const url = new URL(location.href);
  if (page > 1) url.searchParams.set('page', page);
  else url.searchParams.delete('page');
  history.replaceState(null, '', url);
}

// Newer and Older under a list (#newer and #older inside `nav`). `more` is
// the API's flag for an older page; `go(page)` shows that page. Called on
// every load, so the handlers are assigned, not added. A list that fits on
// one page has no pager.
function setPager(nav, page, more, go) {
  const newer = nav.querySelector('#newer'), older = nav.querySelector('#older');
  newer.disabled = page <= 1;
  older.disabled = !more;
  newer.onclick = () => go(page - 1);
  older.onclick = () => go(page + 1);
  nav.hidden = page <= 1 && !more;
}
