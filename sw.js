/* ============================================================
   Driver Call List — sw.js
   Service Worker: caches app shell for offline use.
   ============================================================ */

const CACHE_NAME = 'driver-call-list-v6';
const BASE = '/callist';

const ASSETS = [
  BASE + '/app.js',
  BASE + '/styles.css',
  BASE + '/manifest.json',
  BASE + '/apple-touch-icon.png',
  BASE + '/favicon.ico',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.3.136/pdf.min.mjs',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js',
];

// Install — cache assets (NOT index.html — let the network always serve it)
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) { return cache.addAll(ASSETS); })
      .then(function() { return self.skipWaiting(); })
  );
});

// Activate — delete old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key)   { return caches.delete(key);  })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Fetch strategy:
// - Firebase calls: always network, never cache
// - HTML navigation requests: always network (let GitHub Pages serve them)
// - Everything else: network first, cache fallback
self.addEventListener('fetch', function(event) {
  const url = event.request.url;

  // Never intercept Firebase
  if (url.includes('firestore.googleapis.com') ||
      url.includes('firebase') ||
      url.includes('google.com/identitytoolkit') ||
      url.includes('securetoken.google.com')) {
    return;
  }

  // Let HTML navigation go straight to network — never serve from SW cache
  // This prevents the 404 loop on iOS standalone mode
  if (event.request.mode === 'navigate') {
    return;
  }

  // Strip iOS PWA pull-to-refresh cache-bust param
  const cleanUrl = url.replace(/[?&]r=\d+/, '').replace(/[?&]$/, '');
  const cleanRequest = cleanUrl !== url
    ? new Request(cleanUrl, { mode: 'same-origin' })
    : event.request;

  // Network first, cache fallback for all other assets
  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(cleanRequest, clone);
          });
        }
        return response;
      })
      .catch(function() {
        return caches.match(cleanRequest);
      })
  );
});
