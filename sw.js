/* ============================================================
   Driver Call List — sw.js
   Service Worker: caches app shell for offline use.
   Cache is versioned — bump CACHE_NAME when deploying updates.
   ============================================================ */

const CACHE_NAME = 'driver-call-list-v2';

const APP_SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/apple-touch-icon.png',
  '/favicon.ico',
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

  // For app shell files: network first, cache fallback
  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        // Cache a fresh copy on each successful network response
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(function() {
        // Network failed — serve from cache
        return caches.match(event.request).then(function(cached) {
          return cached || caches.match('/index.html');
        });
      })
  );
});
