const CACHE = 'steddi-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/reset.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-180.png',
  '/icon-167.png',
  '/icon-152.png',
  '/icon-120.png',
];

// Install — cache all assets, take over immediately
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).catch(()=>{})
  );
  self.skipWaiting();
});

// Activate — clean ALL old caches (not just non-matching ones)
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(()=>self.clients.claim())
  );
});

// Fetch — same-origin GETs use cache-first; everything else goes straight to network
// This keeps cross-origin assets (CDN, fonts, APIs) fresh and out of the cache,
// so a CSP or CORS issue can never be silently cached and persist.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Only handle same-origin GETs
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Don't cache API calls — they need to be live
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone)).catch(()=>{});
        }
        return res;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
