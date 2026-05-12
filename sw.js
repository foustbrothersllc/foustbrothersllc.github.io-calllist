/* ============================================================
   Driver Call List — sw.js
   Service Worker: caches app shell for offline use.
   Cache is versioned — bump CACHE_NAME when deploying updates.
   ============================================================ */

const CACHE_NAME = 'driver-call-list-v5';
const BASE = '/callist';

const APP_SHELL = [
  BASE + '/',
  BASE + '/index.html',
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

// Install — cache the app shell
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(APP_SHELL);
    }).then(function() {
      return self.skipWaiting();
    })
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

// Fetch — network first, fall back to cache
// Firebase/Firestore API calls always go network-only (never cache live data)
self.addEventListener('fetch', function(event) {
  const url = event.request.url;

  // Never intercept Firebase API calls — let them fail naturally if offline
  if (url.includes('firestore.googleapis.com') ||
      url.includes('firebase') ||
      url.includes('google.com/identitytoolkit') ||
      url.includes('securetoken.google.com')) {
    return;
  }

  // Strip ?r=<timestamp> cache-bust param added by iOS PWA pull-to-refresh,
  // so the SW can still match and serve the cached shell file.
  const cleanUrl = url.replace(/[?&]r=\d+/, '').replace(/[?&]$/, '');
  const cleanRequest = cleanUrl !== url ? new Request(cleanUrl, { mode: 'same-origin' }) : event.request;

  // For app shell files: network first, cache fallback
  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        // Cache a fresh copy on each successful network response
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(cleanRequest, clone);
          });
        }
        return response;
      })
      .catch(function() {
        // Network failed — serve from cache (use clean URL for lookup)
        return caches.match(cleanRequest).then(function(cached) {
          return cached || caches.match(BASE + '/index.html');
        });
      })
  );
});

