// The service worker. It does two things: shows a ring as a notification,
// and opens the room when the notification is tapped. Nothing else: no
// fetch handler and no cache, so it can never serve a stale page. It is
// registered only on a device where someone turned ringing on (ui.js).

// A new version takes over at once rather than at the next visit.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// The server sends {title, body, url, tag, from, language} (routes.lg,
// ring-message). The tag is the room's, so a second ring replaces the
// first rather than stacking, and renotify makes the replacement alert
// again. A push that shows nothing gets the subscription revoked on iOS,
// so even one that cannot be read shows something.
//
// The worker puts the ring in the recipient's language itself: their
// account's choice when they pinned one, else this device's own first
// language, as the pages decide (i18n.js). The server cannot decide
// "auto"; it does not know the device. Its English title and body are the
// fallback. The two Russian sentences live here because a worker cannot
// load the pages' dictionary.
const russian = ring => ring.language === 'ru'
  || (ring.language !== 'en' && /^ru\b/i.test(self.navigator.language || ''));
self.addEventListener('push', event => {
  let ring = {};
  try { ring = event.data ? event.data.json() : {}; } catch (e) { /* shown plainly below */ }
  // Russian needs the caller's name; without it the ring is all English.
  const ru = !!ring.from && russian(ring);
  const title = ru ? ring.from + ' хочет поговорить' : ring.title || 'quickmeet';
  const body = ru ? 'Нажмите, чтобы присоединиться' : ring.body || 'Someone wants to talk.';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: ring.tag || 'quickmeet',
    renotify: true,
    icon: '/static/icon-192.png',
    data: { url: ring.url || '/' },
  }));
});

// Tapping opens the room's lobby, where Join is the answer. A window
// already at that room is brought forward instead of opening another.
// Only this site's own paths are opened.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  const url = target.origin === self.location.origin ? target.href : self.location.origin + '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(w => w.url === url);
    return open ? open.focus() : self.clients.openWindow(url);
  })());
});
