/* ============================================================
   Driver Call List — sw.js
   ============================================================ */
const CACHE_VERSION = 'v' + (function() {
  return '20250517-06';
})();
const CACHE_NAME = 'driver-call-list-' + CACHE_VERSION;
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
      return Promise.allSettled(
        APP_SHELL.map(function(url) {
          return cache.add(url).catch(function(err) {
            console.warn('SW: could not cache', url, err);
          });
        })
      );
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

  // Never intercept Supabase, esm.sh, or CDN requests
  if (url.includes('supabase.co') ||
      url.includes('esm.sh') ||
      url.includes('cdnjs.cloudflare.com') ||
      url.includes('gstatic.com')) {
    return;
  }

  // Navigation requests — cache first (instant offline), then network
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('https://foustbrothersllc.github.io/callist/index.html')
        .then(function(cached) {
          // Kick off a background network fetch to keep the cache fresh
          const networkFetch = fetch(event.request).then(function(response) {
            if (response && response.status === 200) {
              caches.open(CACHE_NAME).then(function(cache) {
                cache.put(event.request, response.clone());
              });
            }
            return response;
          }).catch(function() { /* offline — cache already returned */ });

          // Return cache immediately if we have it; otherwise wait for network
          return cached || networkFetch;
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
