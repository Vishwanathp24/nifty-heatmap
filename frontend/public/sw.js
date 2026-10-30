// Service worker, used only for Market Bias notifications: phone browsers can show a
// notification only through a service worker, and server pushes (web push) arrive here even
// when the phone is locked. No fetch handler, so nothing is cached.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))
self.addEventListener('push', e => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { d = { title: e.data && e.data.text() } }
  e.waitUntil(self.registration.showNotification(d.title || 'Market Bias', {
    body: d.body || '', tag: d.tag || 'nse-bias', icon: 'icon-192.png', badge: 'icon-192.png' }))
})
self.addEventListener('notificationclick', e => {
  e.notification.close()
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(ws => ws.length ? ws[0].focus() : self.clients.openWindow('./')))
})
