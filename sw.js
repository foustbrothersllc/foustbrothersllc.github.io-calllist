/* ============================================================
   Driver Call List — sw.js
   ============================================================ */
const CACHE_VERSION = 'v' + (function() {
  return '20250529-03';  // bumped to force-clear the broken cache from 20250529-01/02
})();
const CACHE_NAME = 'driver-call-list-' + CACHE_VERSION;

const APP_SHELL = [
  'https://foustbrothersllc.github.io/callist/',
  'https://foustbrothersllc.github.io/callist/index.html',
  'https://foustbrothersllc.github.io/callist/app.js',
  'https://foustbrothersllc.github.io/callist/styles.css',
  'https://foustbrothersllc.github.io/callist/manifest.json',
  'https://foustbrothersllc.github.io/callist/apple-touch-icon.png',
  'https://foustbrothersllc.github.io/callist/favicon.ico',
  // SheetJS — now cached so Excel import works offline
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
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

  // Never intercept Supabase or esm.sh — must always go to network
  if (url.includes('supabase.co') || url.includes('esm.sh')) {
    return;
  }

  // CDN assets (SheetJS etc.) — cache first, they're versioned and never change
  if (url.includes('cdnjs.cloudflare.com') || url.includes('gstatic.com')) {
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        if (cached) return cached;
        return fetch(event.request).then(function(response) {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        });
      })
    );
    return;
  }

  // Navigation — cache first for instant load, refresh in background
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('https://foustbrothersllc.github.io/callist/index.html')
        .then(function(cached) {
          const networkFetch = fetch(event.request).then(function(response) {
            if (response && response.status === 200) {
              caches.open(CACHE_NAME).then(function(cache) {
                cache.put(event.request, response.clone());
              });
            }
            return response;
          }).catch(function() {});
          return cached || networkFetch;
        })
    );
    return;
  }

  // All other app assets — network first, cache fallback (original safe strategy)
  const cleanUrl = url.replace(/[?&]r=\d+/, '').replace(/[?&]$/, '');
  const cleanRequest = cleanUrl !== url
    ? new Request(cleanUrl, { mode: 'same-origin' })
    : event.request;

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
