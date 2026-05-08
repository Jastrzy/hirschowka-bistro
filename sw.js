// Hirschówka Bistro — Service Worker
const CACHE = 'hirschowka-v2';
const ASSETS = ['/', '/index.html', '/logo-round.png', '/firebase-config.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  
  // Pomijaj wszystkie zewnętrzne API i zapytania POST
  if (e.request.method !== 'GET') return;
  if (url.includes('firebase') || url.includes('googleapis')) return;
  if (url.includes('smsapi')) return;
  if (url.includes('emailjs')) return;
  if (url.includes('/api/')) return;

  e.respondWith(
    fetch(e.request)
      .then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
