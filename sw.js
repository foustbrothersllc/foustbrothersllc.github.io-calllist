/* ============================================================
   Driver Call List — sw.js
   ============================================================ */
const CACHE_VERSION = 'v' + (function() {
  return '20250529-01';   // ← bumped so the new SW installs immediately
})();
const CACHE_NAME = 'driver-call-list-' + CACHE_VERSION;

// ── App shell: everything needed to render the UI with zero network ──
const APP_SHELL = [
  'https://foustbrothersllc.github.io/callist/',
  'https://foustbrothersllc.github.io/callist/index.html',
  'https://foustbrothersllc.github.io/callist/app.js',
  'https://foustbrothersllc.github.io/callist/styles.css',
  'https://foustbrothersllc.github.io/callist/manifest.json',
  'https://foustbrothersllc.github.io/callist/apple-touch-icon.png',
  'https://foustbrothersllc.github.io/callist/favicon.ico',
  // SheetJS — needed for Excel import; cache it so import works offline too
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
];

// ── Install: pre-cache the entire app shell ───────────────────
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.allSettled(
        APP_SHELL.map(function(url) {
          return cache.add(url).catch(function(err) {
            console.warn('SW: could not pre-cache', url, err);
          });
        })
      );
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// ── Activate: remove old cache versions ──────────────────────
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

// ── Fetch handler ─────────────────────────────────────────────
self.addEventListener('fetch', function(event) {
  const url = event.request.url;

  // Never intercept Supabase or esm.sh — data must always come live or fail gracefully
  if (url.includes('supabase.co') || url.includes('esm.sh')) {
    return;
  }

  // CDN assets (SheetJS, etc.) — cache first, network fallback
  // These never change for a given version URL, so cache is always safe
  if (url.includes('cdnjs.cloudflare.com') || url.includes('gstatic.com')) {
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        if (cached) return cached;
        // Not in cache yet — fetch, store, return
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

  // Navigation requests — cache first for instant load, refresh in background
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
          }).catch(function() { /* offline — cached version already returned */ });

          // Serve cache immediately; only wait for network if nothing cached
          return cached || networkFetch;
        })
    );
    return;
  }

  // All other app assets (app.js, styles.css, icons, etc.)
  // Strip iOS pull-to-refresh cache-bust param before matching
  const cleanUrl = url.replace(/[?&]r=\d+/, '').replace(/[?&]$/, '');
  const cleanRequest = cleanUrl !== url
    ? new Request(cleanUrl, { mode: 'same-origin' })
    : event.request;

  // Cache first → background refresh (stale-while-revalidate)
  // This means the app always loads from cache instantly, then quietly updates
  event.respondWith(
    caches.match(cleanRequest).then(function(cached) {
      const networkFetch = fetch(event.request).then(function(response) {
        if (response && response.status === 200 && response.type !== 'opaque') {
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(cleanRequest, response.clone());
          });
        }
        return response;
      }).catch(function() { return null; });

      // Return cache immediately; if nothing cached, wait for network
      return cached || networkFetch;
    })
  );
});
