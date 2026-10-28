// Ringing was removed. This file only exists to unregister the service
// worker v0.1.0 installed on some devices (unregistering also drops the
// device's push subscription). Delete it a release or two later.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.registration.unregister()));
