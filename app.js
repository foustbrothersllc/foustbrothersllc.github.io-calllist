// ================================================================
//  app.js — TWO CHANGES for better offline / low-signal behavior
// ================================================================
//
//  CHANGE 1: Better loading message (shows cached count instantly)
//  CHANGE 2: Supabase fetch timeout (stops hanging on weak signal)
//
// ----------------------------------------------------------------
//  CHANGE 1 — Replace the loading message block near the top of
//  the boot section (around where loadingMsg is created).
//
//  FIND this in app.js:
// ----------------------------------------------------------------

/*
  const loadingMsg = document.createElement('p');
  loadingMsg.id = 'loadingMsg';
  loadingMsg.style.cssText = 'padding:24px;text-align:center;color:#7a6055;';
  loadingMsg.textContent = 'Loading drivers…';
  listEl.insertBefore(loadingMsg, noResults);
*/

//  REPLACE WITH:

  const loadingMsg = document.createElement('p');
  loadingMsg.id = 'loadingMsg';
  loadingMsg.style.cssText = 'padding:24px;text-align:center;color:#7a6055;';
  loadingMsg.textContent = 'Loading drivers…';
  listEl.insertBefore(loadingMsg, noResults);

  // Show how many drivers are already in cache so users know the app works offline
  openCache().then(function(db) {
    const tx = db.transaction(IDB_STORE, 'readonly');
    tx.objectStore(IDB_STORE).count().onsuccess = function(e) {
      const count = e.target.result;
      const el = document.getElementById('loadingMsg');
      if (el && count > 0) {
        el.textContent = 'Loading ' + count + ' driver' + (count !== 1 ? 's' : '') + ' from cache…';
      }
    };
  }).catch(function() {});

// ----------------------------------------------------------------
//  CHANGE 2 — Add a timeout to the Supabase fetch in attachSnapshot().
//
//  FIND this in app.js (inside attachSnapshot, Step 2):
// ----------------------------------------------------------------

/*
    // ── Step 2: fetch fresh data from Supabase in background ────
    supabase.from('drivers').select('id, data')
      .then(async function({ data, error }) {
*/

//  REPLACE WITH:

    // ── Step 2: fetch fresh data from Supabase in background ────
    // Wrap with a 10-second timeout — on weak signal the fetch can hang
    // indefinitely. If it times out, fall back to whatever IDB has.
    const SUPABASE_TIMEOUT_MS = 10000;
    const supabaseFetchWithTimeout = Promise.race([
      supabase.from('drivers').select('id, data'),
      new Promise(function(_, reject) {
        setTimeout(function() {
          reject(new Error('timeout'));
        }, SUPABASE_TIMEOUT_MS);
      }),
    ]);

    supabaseFetchWithTimeout
      .then(async function({ data, error }) {
        // ... rest of the existing .then() block stays exactly the same ...
      })
      .catch(function(err) {
        // Timeout or network failure — show offline banner, keep cached data visible
        showOfflineBanner();
        removeLoadingMsg();
        if (!cacheRendered) {
          const p = document.createElement('div');
          p.style.cssText = 'margin:24px 16px;padding:16px;background:#fee2e2;border-radius:12px;border-left:4px solid #b91c1c;';
          p.innerHTML = '<p style="font-weight:700;color:#b91c1c;margin:0 0 4px;">Could not reach the server</p>'
            + '<p style="font-size:13px;color:#7a1a1a;margin:0;">No cached data available. Connect to the internet and pull down to refresh.</p>';
          listEl.insertBefore(p, noResults);
        }
      });
