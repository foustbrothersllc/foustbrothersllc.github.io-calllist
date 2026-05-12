/* ============================================================
   Driver Call List — sw.js
   ============================================================ */

const CACHE_NAME = 'driver-call-list-v7';

const APP_SHELL = [
  'https://foustbrothersllc.github.io/callist/',
  'https://foustbrothersllc.github.io/callist/index.html',
  'https://foustbrothersllc.github.io/callist/app.js',
  'https://foustbrothersllc.github.io/callist/styles.css',
  'https://foustbrothersllc.github.io/callist/apple-touch-icon.png',
  'https://foustbrothersllc.github.io/callist/favicon.ico',
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(APP_SHELL);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

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

self.addEventListener('fetch', function(event) {
  const url = event.request.url;

  // Never intercept Firebase
  if (url.includes('firestore.googleapis.com') ||
      url.includes('firebase') ||
      url.includes('google.com/identitytoolkit') ||
      url.includes('securetoken.google.com')) {
    return;
  }

  // Never intercept CDN requests
  if (url.includes('cdnjs.cloudflare.com') || url.includes('gstatic.com')) {
    return;
  }

  // Navigation requests — let network handle, fall back to cached index
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(function() {
        return caches.match('https://foustbrothersllc.github.io/callist/index.html');
      })
    );
    return;
  }

  // Strip iOS pull-to-refresh cache-bust param
  const cleanUrl = url.replace(/[?&]r=\d+/, '').replace(/[?&]$/, '');
  const cleanRequest = cleanUrl !== url
    ? new Request(cleanUrl, { mode: 'same-origin' })
    : event.request;

  // Network first, cache fallback
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
