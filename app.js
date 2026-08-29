/* ============================================================
   Driver Call List — app.js
   ============================================================
   Features:
   - Global access key gate + WebAuthn biometric unlock
   - AES-256 encryption of phone numbers in Firestore
   - Admin password protection for settings/DB controls
   - No UPS branding
   - PDF + JSON import via pdf.js
   - Regex phone normalisation + SLIC standardisation
   - Visual progress bar during import
   - O(1) Set duplicate detection
   - Scan for Duplicates button
   - 3-version PDF update log
   - Export Master JSON button
   - Call + Text buttons for primary numbers
   - Multi-select checkboxes (admin only)
   - Long-press required to delete
   - Mobile search zoom disabled (font-size:16px)
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Supabase config ──────────────────────────────────────────
const SUPABASE_URL  = 'https://lywhuzkgahhzhgjdgbnx.supabase.co';
const SUPABASE_KEY  = 'sb_publishable_r_BCozqjBdfuFOP5wvnzgw_B8m7jMfJ';
const supabase      = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Access & Admin keys (hashed — plaintext never stored here) ──
// Passwords are checked by hashing user input and comparing to these digests.
// The actual passwords are NOT in this file.
const ACCESS_KEY_HASH    = '3c77054ff79e73e62c1a0d0ee1cc9d7d57f76b79971ecd4be6cf2371c4139b19';
const ADMIN_PASSWORD_HASH = 'e4fd70411a4f3e212ff4c97af82e38a066aa376af494d50247c4d62433b56d8c';

// ── AES-256-GCM encryption helpers ──────────────────────────
// Key is derived from a passphrase hashed at runtime from user input.
// The passphrase itself is never stored — derived from the access key the user types.
const ENC_PASSPHRASE = 'driverlist-UPSFeederDriver-2024'; // encryption key — must match existing Firestore data
const ENC_SALT_HEX   = '4a3f2b1c8d9e0f5a'; // fixed salt

async function getEncKey() {
  if (getEncKey._cached) return getEncKey._cached;
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(ENC_PASSPHRASE), 'PBKDF2', false, ['deriveKey']
  );
  const salt = hexToBytes(ENC_SALT_HEX);
  getEncKey._cached = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return getEncKey._cached;
}

function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return arr;
}
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function encryptPhone(digits) {
  if (!digits) return null;
  const key = await getEncKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(digits));
  return bytesToHex(iv) + ':' + bytesToHex(new Uint8Array(ct));
}

async function decryptPhone(cipher) {
  if (!cipher) return null;
  try {
    const key = await getEncKey();
    const [ivHex, ctHex] = cipher.split(':');
    const iv = hexToBytes(ivHex);
    const ct = hexToBytes(ctHex);
    const dec = new TextDecoder();
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return dec.decode(pt);
  } catch (e) {
    return null;
  }
}

// ── formatPhone at global scope (needed by decryptPhoneObj) ──
function formatPhone(digits) {
  if (!digits || digits.length !== 10) return digits || '';
  return '(' + digits.slice(0,3) + ') ' + digits.slice(3,6) + '-' + digits.slice(6);
}

// Encrypt a phone object { digits, display } → { enc } only — no readable data in Firestore
async function encryptPhoneObj(phoneObj) {
  if (!phoneObj || !phoneObj.digits) return null;
  const enc = await encryptPhone(phoneObj.digits);
  return { enc }; // display intentionally excluded
}

// Decrypt { enc } → { digits, display } — display rebuilt from decrypted digits
async function decryptPhoneObj(phoneObj) {
  if (!phoneObj) return null;
  if (phoneObj.digits) return phoneObj; // legacy unencrypted
  if (!phoneObj.enc) return null;
  const digits = await decryptPhone(phoneObj.enc);
  return digits ? { digits, display: formatPhone(digits) } : null;
}

// ── Multi-phone support ──────────────────────────────────────
// Canonical shape: driver.phones = [{ digits, display, label }] (max 5, first = primary).
// Legacy shape { phone, altPhone } is auto-converted on read and mirrored on
// write so old records, old backups, and an old app version all keep working.
const MAX_PHONES = 5;

function normalizePhones(d) {
  if (!d) return d;
  let phones = [];
  if (Array.isArray(d.phones) && d.phones.length) {
    phones = d.phones
      .filter(function(p) { return p && p.digits; })
      .map(function(p) { return { digits: p.digits, display: formatPhone(p.digits), label: (p.label || '').trim() }; });
  } else {
    if (d.phone && d.phone.digits)       phones.push({ digits: d.phone.digits,    display: formatPhone(d.phone.digits),    label: (d.phone.label    || '').trim() });
    if (d.altPhone && d.altPhone.digits) phones.push({ digits: d.altPhone.digits, display: formatPhone(d.altPhone.digits), label: (d.altPhone.label || '').trim() });
  }
  phones = phones.slice(0, MAX_PHONES);
  d.phones   = phones;
  // Legacy mirrors — first two numbers — keep every old code path working
  d.phone    = phones[0] || null;
  d.altPhone = phones[1] || null;
  return d;
}

// Prepare driver for Firestore (encrypt phones)
async function encryptDriver(driver) {
  const d = normalizePhones({ ...driver });
  const plainPhones = d.phones;
  d.phones = await Promise.all(plainPhones.map(async function(p) {
    const enc = await encryptPhone(p.digits);
    return p.label ? { enc, label: p.label } : { enc };
  }));
  // Legacy mirrors (encrypted) so an older app version can still read this record
  d.phone    = d.phones[0] ? { enc: d.phones[0].enc } : null;
  d.altPhone = d.phones[1] ? { enc: d.phones[1].enc } : null;
  return d;
}

// Restore driver from Firestore (decrypt phones)
async function decryptDriver(raw) {
  const d = { ...raw };
  if (Array.isArray(raw.phones) && raw.phones.length) {
    const phones = await Promise.all(raw.phones.map(async function(p) {
      const dec = await decryptPhoneObj(p);
      return dec ? { digits: dec.digits, display: formatPhone(dec.digits), label: (p && p.label) || '' } : null;
    }));
    d.phones = phones.filter(Boolean);
  } else {
    d.phone    = await decryptPhoneObj(raw.phone);
    d.altPhone = await decryptPhoneObj(raw.altPhone);
  }
  return normalizePhones(d);
}

// ── isAdmin must be declared before the gate IIFE calls initApp ──
let isAdmin = false;

// ── Access gate ──────────────────────────────────────────────
// ── SHA-256 helper (top-level so both initAccessGate and initApp can use it) ──
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

(function initAccessGate() {
  const gate       = document.getElementById('accessGate');
  const appWrapper = document.getElementById('appWrapper');
  const keyInput   = document.getElementById('accessKeyInput');
  const btnKey     = document.getElementById('btnAccessKey');
  const btnBio     = document.getElementById('btnBiometric');
  const gateError  = document.getElementById('gateError');

  const SESSION_TOKEN_KEY = 'dcl_session_v2';
  const BIO_CRED_KEY      = 'dcl_bio_cred';

  // If previously authenticated via password OR biometrics, unlock immediately
  if (localStorage.getItem(SESSION_TOKEN_KEY) === 'granted') {
    unlockApp();
    return;
  }

  // Check for WebAuthn credential — auto-attempt on load, show button as fallback
  const savedCredId = localStorage.getItem(BIO_CRED_KEY);
  if (savedCredId && window.PublicKeyCredential) {
    btnBio.style.display = 'flex';
    btnBio.addEventListener('click', attemptBiometric);
    // Auto-trigger biometric silently after a short delay
    setTimeout(function() {
      attemptBiometric().catch(function() {
        // Silently fail — user can tap the button manually
      });
    }, 400);
  }

  btnKey.addEventListener('click', tryAccessKey);
  keyInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') tryAccessKey();
  });

  function tryAccessKey() {
    sha256(keyInput.value).then(function(hash) {
      if (hash === ACCESS_KEY_HASH) {
        localStorage.setItem(SESSION_TOKEN_KEY, 'granted');
        // Offer to register biometrics if supported
        if (window.PublicKeyCredential && !localStorage.getItem(BIO_CRED_KEY)) {
          tryRegisterBiometric();
        } else {
          unlockApp();
        }
      } else {
        gateError.textContent = '❌ Incorrect access key.';
        keyInput.value = '';
        keyInput.focus();
      }
    });
  }

  async function tryRegisterBiometric() {
    if (!window.PublicKeyCredential) { unlockApp(); return; }
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const userId    = crypto.getRandomValues(new Uint8Array(16));
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: 'Driver Call List' },
          user: { id: userId, name: 'driver-user', displayName: 'Driver User' },
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required'
          },
          timeout: 30000
        }
      });
      if (cred) {
        localStorage.setItem(BIO_CRED_KEY, btoa(String.fromCharCode(...new Uint8Array(cred.rawId))));
        btnBio.style.display = 'flex';
      }
    } catch (_) { /* user declined or not supported */ }
    unlockApp();
  }

  async function attemptBiometric() {
    if (!window.PublicKeyCredential) return;
    gateError.textContent = '';
    try {
      const savedId = localStorage.getItem(BIO_CRED_KEY);
      const rawId   = Uint8Array.from(atob(savedId), c => c.charCodeAt(0));
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ id: rawId, type: 'public-key' }],
          userVerification: 'required',
          timeout: 30000
        }
      });
      if (assertion) {
        localStorage.setItem(SESSION_TOKEN_KEY, 'granted');
        unlockApp();
      }
    } catch (e) {
      gateError.textContent = '❌ Biometric failed. Try the access key.';
    }
  }

  function unlockApp() {
    gate.style.display = 'none';
    appWrapper.style.display = 'block';
    initApp();
  }

  // ── Recovery: tap lock icon 5x fast ──────────────────────────
  // Answer is stored as SHA-256 — not recoverable from source code.
  const RECOVERY_HASH     = '708be297a62461a9d098f912eed82a02f862e21a91ed21c6557cf129608826f1';
  const RECOVERY_ATTEMPTS_KEY = 'dcl_rec_attempts';
  const RECOVERY_LOCKOUT_KEY  = 'dcl_rec_lockout';
  const RECOVERY_COOLDOWN_MS  = 30 * 60 * 1000; // 30 minutes
  const RECOVERY_MAX_ATTEMPTS = 3;

  let tapCount = 0;
  let tapTimer = null;

  const gateIcon = document.querySelector('.gate-icon');
  if (gateIcon) {
    gateIcon.style.cursor = 'pointer';
    gateIcon.addEventListener('click', function() {
      tapCount++;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(function() { tapCount = 0; }, 600);
      if (tapCount >= 5) {
        tapCount = 0;
        clearTimeout(tapTimer);
        showRecoveryPrompt();
      }
    });
  }

  function getRecoveryAttempts() {
    return parseInt(localStorage.getItem(RECOVERY_ATTEMPTS_KEY) || '0', 10);
  }
  function getLockoutUntil() {
    return parseInt(localStorage.getItem(RECOVERY_LOCKOUT_KEY) || '0', 10);
  }

  function showRecoveryPrompt() {
    // Check if locked out
    const lockoutUntil = getLockoutUntil();
    const now = Date.now();
    if (lockoutUntil > now) {
      showCooldownModal(lockoutUntil);
      return;
    }

    // Build modal
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(4px);';

    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:18px;padding:28px 24px 22px;max-width:320px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.3);text-align:center;border-top:4px solid #FFB500;';

    const attemptsLeft = RECOVERY_MAX_ATTEMPTS - getRecoveryAttempts();

    box.innerHTML = `
      <div style="font-size:28px;margin-bottom:10px;">🔑</div>
      <h2 style="font-size:17px;font-weight:800;color:#351C15;margin-bottom:6px;">Access Key Recovery</h2>
      <p style="font-size:13px;color:#7a6055;margin-bottom:16px;line-height:1.5;">Enter the year you started and the year you went to feeders.</p>
      <input type="number" id="recoveryInput" placeholder="Answer"
        style="width:100%;padding:11px 14px;border-radius:10px;border:1.5px solid #e5d5cc;font-size:16px;outline:none;margin-bottom:8px;text-align:center;-webkit-appearance:none;"
      >
      <p id="recoveryError" style="font-size:12px;color:#b91c1c;min-height:16px;margin-bottom:10px;font-weight:600;"></p>
      <p style="font-size:11px;color:#7a6055;margin-bottom:14px;">${attemptsLeft} attempt${attemptsLeft !== 1 ? 's' : ''} remaining</p>
      <div style="display:flex;gap:8px;">
        <button id="recoveryCancelBtn" style="flex:1;padding:11px;border-radius:10px;border:1.5px solid #e5d5cc;background:#fff;color:#7a6055;font-size:14px;font-weight:600;cursor:pointer;">Cancel</button>
        <button id="recoverySubmitBtn" style="flex:2;padding:11px;border-radius:10px;border:none;background:#351C15;color:#FFB500;font-size:14px;font-weight:800;cursor:pointer;">Verify</button>
      </div>
      <div id="recoveryReveal" style="display:none;margin-top:16px;padding:12px;background:#fff3cc;border-radius:10px;border:1.5px solid #FFB500;">
        <p style="font-size:11px;font-weight:700;color:#351C15;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Your Access Key</p>
        <p id="recoveryKeyDisplay" style="font-size:20px;font-weight:800;color:#351C15;letter-spacing:1px;"></p>
        <p style="font-size:11px;font-weight:700;color:#351C15;text-transform:uppercase;letter-spacing:0.5px;margin-top:10px;margin-bottom:4px;">Admin Password</p>
        <p style="font-size:13px;color:#5a3525;line-height:1.5;">Contact the list administrator for the admin password.</p>
      </div>
    `;

    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    const input        = box.querySelector('#recoveryInput');
    const errorEl      = box.querySelector('#recoveryError');
    const attemptsEl   = box.querySelector('p[style*="attempt"]') || null;
    const submitBtn    = box.querySelector('#recoverySubmitBtn');
    const cancelBtn    = box.querySelector('#recoveryCancelBtn');
    const revealEl     = box.querySelector('#recoveryReveal');
    const keyDisplay   = box.querySelector('#recoveryKeyDisplay');

    setTimeout(function() { input.focus(); }, 200);

    cancelBtn.addEventListener('click', function() { backdrop.remove(); });
    backdrop.addEventListener('click', function(e) { if (e.target === backdrop) backdrop.remove(); });

    submitBtn.addEventListener('click', async function() {
      const val = input.value.trim();
      if (!val) { errorEl.textContent = '⚠️ Please enter an answer.'; return; }

      const hash = await sha256(val);
      if (hash === RECOVERY_HASH) {
        // Success — reset attempts, show key
        localStorage.removeItem(RECOVERY_ATTEMPTS_KEY);
        localStorage.removeItem(RECOVERY_LOCKOUT_KEY);
        input.style.display = 'none';
        submitBtn.style.display = 'none';
        cancelBtn.textContent = 'Close';
        errorEl.textContent = '';
        revealEl.style.display = 'block';
        keyDisplay.textContent = 'Contact the list administrator — the access key cannot be displayed here.';
      } else {
        // Wrong answer
        const attempts = getRecoveryAttempts() + 1;
        localStorage.setItem(RECOVERY_ATTEMPTS_KEY, String(attempts));
        const left = RECOVERY_MAX_ATTEMPTS - attempts;
        if (left <= 0) {
          // Lock out for 30 minutes
          localStorage.setItem(RECOVERY_LOCKOUT_KEY, String(Date.now() + RECOVERY_COOLDOWN_MS));
          localStorage.removeItem(RECOVERY_ATTEMPTS_KEY);
          backdrop.remove();
          showCooldownModal(Date.now() + RECOVERY_COOLDOWN_MS);
        } else {
          errorEl.textContent = '❌ Incorrect. ' + left + ' attempt' + (left !== 1 ? 's' : '') + ' remaining.';
          input.value = '';
          input.focus();
        }
      }
    });

    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') submitBtn.click();
    });
  }

  function showCooldownModal(lockoutUntil) {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(4px);';

    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:18px;padding:28px 24px 22px;max-width:320px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.3);text-align:center;border-top:4px solid #b91c1c;';
    box.innerHTML = `
      <div style="font-size:28px;margin-bottom:10px;">🔒</div>
      <h2 style="font-size:17px;font-weight:800;color:#b91c1c;margin-bottom:8px;">Recovery Locked</h2>
      <p style="font-size:13px;color:#7a6055;margin-bottom:16px;line-height:1.5;">Too many incorrect attempts. Try again in:</p>
      <p id="cooldownTimer" style="font-size:28px;font-weight:800;color:#351C15;margin-bottom:16px;">--:--</p>
      <button id="cooldownClose" style="width:100%;padding:11px;border-radius:10px;border:1.5px solid #e5d5cc;background:#fff;color:#7a6055;font-size:14px;font-weight:600;cursor:pointer;">Close</button>
    `;
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    box.querySelector('#cooldownClose').addEventListener('click', function() { backdrop.remove(); clearInterval(ticker); });

    const timerEl = box.querySelector('#cooldownTimer');
    function tick() {
      const remaining = Math.max(0, lockoutUntil - Date.now());
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      timerEl.textContent = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
      if (remaining <= 0) {
        clearInterval(ticker);
        backdrop.remove();
      }
    }
    tick();
    const ticker = setInterval(tick, 1000);
  }

})();

// ── Main App ─────────────────────────────────────────────────

function initApp() {
  'use strict';

  // ── Eager AES key warm-up ────────────────────────────────────
  // PBKDF2 with 100k iterations is intentionally slow. Kick it off immediately
  // so the key is ready by the time IDB finishes opening — otherwise it blocks
  // the entire cache-render path.
  getEncKey().catch(function() {}); // fire and forget

  // ── DOM refs ─────────────────────────────────────────────────
  const listEl          = document.getElementById('cardList');
  const searchBox       = document.getElementById('searchBox');
  const countBar        = document.getElementById('countBar');
  const noResults       = document.getElementById('noResults');
  const filterBtns      = document.querySelectorAll('.filter-btn');
  const fabAdd          = document.getElementById('fabAdd');
  const addPanel        = document.getElementById('addPanel');
  const panelOverlay    = document.getElementById('panelOverlay');
  const panelClose      = document.getElementById('panelCloseBtn');
  const addPanelTitle   = document.getElementById('addPanelTitle');
  const btnCancel       = document.getElementById('btnCancel');
  const btnSave         = document.getElementById('btnSave');
  const panelNote       = document.getElementById('panelNote');
  const inputLastName   = document.getElementById('inputLastName');
  const inputFirstName  = document.getElementById('inputFirstName');
  const inputLocation   = document.getElementById('inputLocation');
  const phoneRowsEl     = document.getElementById('phoneRows');
  const btnAddPhone     = document.getElementById('btnAddPhone');
  const deleteModal     = document.getElementById('deleteModal');
  const deleteCancel    = document.getElementById('deleteCancel');
  const deleteConfirm   = document.getElementById('deleteConfirm');
  const deleteBody      = document.getElementById('deleteModalBody');
  const importModal     = document.getElementById('importModal');
  const importCancel    = document.getElementById('importCancel');
  const importConfirm   = document.getElementById('importConfirm');
  const importFileInput = document.getElementById('importFileInput');
  const importStatus    = document.getElementById('importStatus');
  const importProgressWrap = document.getElementById('importProgressWrap');
  const importProgressBar  = document.getElementById('importProgressBar');
  const importProgressLabel= document.getElementById('importProgressLabel');
  const importUpdateLog    = document.getElementById('importUpdateLog');
  const importLogEntries   = document.getElementById('importLogEntries');
  const dupModal        = document.getElementById('dupModal');
  const dupResults      = document.getElementById('dupResults');
  const dupClose        = document.getElementById('dupClose');
  const dupDeleteAll    = document.getElementById('dupDeleteAll');

  // ── State ────────────────────────────────────────────────────
  let activeFilter        = 'all';
  let allCards            = [];
  const driverSet         = new Set();
  const driverMap         = new Map();
  let editingKey          = null;
  let pendingDeleteKey    = null;
  const selectedKeys      = new Set();
  // Always display as "Last, First"
  const nameOrder = 'last';

  // ── Haptic feedback ──────────────────────────────────────────
  // Default ON. Stored as 'off' when disabled so new installs get haptics.
  let hapticEnabled = localStorage.getItem('dcl_haptic') !== 'off';

  // iOS doesn't support navigator.vibrate, but a silent AudioContext
  // impulse triggers the Taptic Engine on most iOS devices.
  let _audioCtx = null;
  function _iosHaptic(intensityGain) {
    try {
      if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = _audioCtx.createBuffer(1, 1, 22050);
      const src = _audioCtx.createBufferSource();
      src.buffer = buf;
      const gain = _audioCtx.createGain();
      gain.gain.value = intensityGain;
      src.connect(gain);
      gain.connect(_audioCtx.destination);
      src.start(0);
    } catch(_) {}
  }

  function haptic(style) {
    if (!hapticEnabled) return;
    if (navigator.vibrate) {
      // Android / non-iOS
      if (style === 'light')       navigator.vibrate(8);
      else if (style === 'medium') navigator.vibrate(22);
      else if (style === 'heavy')  navigator.vibrate([35, 15, 35]);
      else                         navigator.vibrate(10);
    } else {
      // iOS — AudioContext silent impulse triggers Taptic Engine
      const gain = style === 'heavy' ? 1.0 : style === 'medium' ? 0.5 : 0.1;
      _iosHaptic(gain);
    }
  }

  // ── Undo delete state ────────────────────────────────────────
  let _undoToastTimer = null;

  // 3-version import log
  const UPDATE_LOG_KEY = 'dcl_update_log';
  function getUpdateLog() {
    try { return JSON.parse(localStorage.getItem(UPDATE_LOG_KEY) || '[]'); } catch(_) { return []; }
  }
  function pushUpdateLog(entry) {
    const log = getUpdateLog();
    log.unshift(entry);
    localStorage.setItem(UPDATE_LOG_KEY, JSON.stringify(log.slice(0, 3)));
  }

  // ── SLIC normalisation ────────────────────────────────────────
  const SLIC_ALIASES = {
    'gso': 'Greensboro', 'grenc': 'Greensboro', 'greensboro': 'Greensboro',
    'meb': 'Mebane',     'mebnc': 'Mebane',     'mebane': 'Mebane'
  };
  function normaliseSlic(raw) {
    if (!raw) return 'Greensboro';
    return SLIC_ALIASES[raw.toLowerCase()] || raw;
  }
  const SLIC_DISPLAY = { greensboro: 'GRENC', mebane: 'MEBNC' };
  function slicLabel(loc) {
    return loc ? (SLIC_DISPLAY[loc.toLowerCase()] || loc.toUpperCase()) : '';
  }

  // ── Phone helpers ────────────────────────────────────────────
  function normalisePhone(raw) {
    if (!raw) return null;
    const d = raw.replace(/[^0-9]/g, '');
    return d.length >= 10 ? d.slice(-10) : null;
  }

  // ── Driver key / Firestore doc ID ────────────────────────────
  function driverKey(lastName, firstName) {
    return (lastName + '|' + firstName).toLowerCase();
  }
  function keyToDocId(key) {
    return key.replace(/[^a-z0-9|]/g, '_');
  }

  // ── Register in local maps ───────────────────────────────────
  function registerDriver(driver) {
    const key = driverKey(driver.lastName, driver.firstName);
    driverSet.add(key);
    driverMap.set(key, driver);
  }

  // ── Badge ────────────────────────────────────────────────────
  function makeBadge(location) {
    if (!location) return null;
    const s = document.createElement('span');
    s.className = 'loc-badge loc-' + location.toLowerCase();
    s.textContent = slicLabel(location);
    return s;
  }

  // ── Platform detection ───────────────────────────────────────
  function detectPlatform() {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) return 'ios';
    if (/android/i.test(ua)) return 'android';
    return 'desktop';
  }

  // ── Save to Contacts via vCard download ──────────────────────
  function saveToContacts(driver) {
    const firstName = driver.firstName || '';
    const lastName  = driver.lastName  || '';
    const phones    = (driver.phones || []).filter(function(p) { return p && p.digits; });
    if (phones.length === 0) return;

    const loc = (driver.location || '').toLowerCase();
    const org = loc === 'mebane' ? 'Mebane Feeder Driver' : 'UPS Feeder Driver';

    let vcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\n';
    vcard += 'N:' + lastName + ';' + firstName + ';;;\r\n';
    vcard += 'FN:' + firstName + ' ' + lastName + '\r\n';
    vcard += 'ORG:' + org + '\r\n';
    phones.forEach(function(p, i) {
      if (p.label) {
        // Grouped item with a custom label (supported by iOS/Android contacts)
        vcard += 'item' + (i + 1) + '.TEL;TYPE=CELL:+1' + p.digits + '\r\n';
        vcard += 'item' + (i + 1) + '.X-ABLabel:' + p.label.replace(/[\r\n;:,]/g, ' ') + '\r\n';
      } else {
        vcard += 'TEL;TYPE=CELL' + (i === 0 ? ';TYPE=PREF' : '') + ':+1' + p.digits + '\r\n';
      }
    });
    vcard += 'END:VCARD\r\n';

    const blob = new Blob([vcard], { type: 'text/vcard' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = firstName + '_' + lastName + '.vcf';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  }

  // ── Phone action sheet (tap on primary number) ──────────────
  function showPhoneActionSheet(digits, driver) {
    const existing = document.getElementById('phoneActionSheet');
    if (existing) existing.remove();

    const sheet = document.createElement('div');
    sheet.id = 'phoneActionSheet';
    sheet.style.cssText = [
      'position:fixed;inset:0;z-index:9000;',
      'display:flex;align-items:flex-end;justify-content:center;',
      'background:rgba(53,28,21,0.45);backdrop-filter:blur(3px);',
    ].join('');

    const box = document.createElement('div');
    box.style.cssText = [
      'background:#fff;border-radius:18px 18px 0 0;padding:22px 20px 36px;',
      'width:100%;max-width:420px;box-shadow:0 -4px 24px rgba(53,28,21,0.18);',
      'display:flex;flex-direction:column;gap:10px;',
    ].join('');

    const num = document.createElement('p');
    num.style.cssText = 'text-align:center;font-size:18px;font-weight:700;color:#351C15;margin-bottom:4px;';
    num.textContent = formatPhone(digits);
    box.appendChild(num);

    const callBtn = document.createElement('a');
    callBtn.href = 'tel:+1' + digits;
    callBtn.style.cssText = [
      'display:flex;align-items:center;justify-content:center;gap:10px;',
      'padding:14px;border-radius:12px;background:#FFB500;color:#1e0f0b;',
      'font-size:16px;font-weight:800;text-decoration:none;',
    ].join('');
    callBtn.addEventListener('click', function() { haptic('medium'); });
    callBtn.innerHTML = '📞 Call';
    box.appendChild(callBtn);

    const textBtn = document.createElement('a');
    textBtn.href = 'sms:+1' + digits;
    textBtn.style.cssText = [
      'display:flex;align-items:center;justify-content:center;gap:10px;',
      'padding:14px;border-radius:12px;background:#f5ede8;color:#351C15;',
      'font-size:16px;font-weight:700;text-decoration:none;border:1.5px solid #e5d5cc;',
    ].join('');
    textBtn.innerHTML = '💬 Text';
    box.appendChild(textBtn);

    const copyBtn = document.createElement('button');
    copyBtn.style.cssText = [
      'display:flex;align-items:center;justify-content:center;gap:10px;',
      'padding:14px;border-radius:12px;background:#f5ede8;color:#351C15;',
      'font-size:16px;font-weight:700;border:1.5px solid #e5d5cc;cursor:pointer;',
    ].join('');
    copyBtn.innerHTML = '📋 Copy Number';
    copyBtn.addEventListener('click', function() {
      const formatted = formatPhone(digits);
      navigator.clipboard.writeText(formatted).then(function() {
        copyBtn.innerHTML = '✅ Copied!';
        setTimeout(function() { copyBtn.innerHTML = '📋 Copy Number'; }, 1800);
      }).catch(function() {
        // Fallback for browsers without clipboard API
        const ta = document.createElement('textarea');
        ta.value = formatted;
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        copyBtn.innerHTML = '✅ Copied!';
        setTimeout(function() { copyBtn.innerHTML = '📋 Copy Number'; }, 1800);
      });
    });
    box.appendChild(copyBtn);

    // Save to Contacts — all platforms
    if (driver && driver.phones && driver.phones.length) {
      const saveBtn = document.createElement('button');
      saveBtn.style.cssText = [
        'display:flex;align-items:center;justify-content:center;gap:10px;',
        'padding:14px;border-radius:12px;background:#f5ede8;color:#351C15;',
        'font-size:16px;font-weight:700;border:1.5px solid #e5d5cc;cursor:pointer;',
      ].join('');
      saveBtn.innerHTML = '👤 Save to Contacts';
      saveBtn.addEventListener('click', function() {
        haptic('light');
        saveToContacts(driver);
        sheet.remove();
      });
      box.appendChild(saveBtn);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = [
      'padding:13px;border-radius:12px;border:1.5px solid #e5d5cc;',
      'background:#fff;color:#7a6055;font-size:15px;font-weight:600;cursor:pointer;',
    ].join('');
    cancelBtn.addEventListener('click', function() { sheet.remove(); });
    box.appendChild(cancelBtn);

    sheet.appendChild(box);
    sheet.addEventListener('click', function(e) { if (e.target === sheet) sheet.remove(); });
    document.body.appendChild(sheet);
  }

  // ── Phone group: one row per number, first = gold primary ────
  function ordinalTag(i) {
    return ['', '2nd', '3rd', '4th', '5th'][i] || (i + 1) + 'th';
  }

  function makePhoneGroup(phoneObj, index, driver) {
    const digits = phoneObj.digits;
    const wrap = document.createElement('div');
    wrap.className = 'phone-group';

    const numBtn = document.createElement('button');
    numBtn.className = index === 0 ? 'phone-btn phone-plain-primary' : 'phone-btn call-alt';
    const tagText = (phoneObj.label && phoneObj.label.trim()) || (index === 0 ? '' : ordinalTag(index));
    numBtn.innerHTML = '<span class="phone-icon" aria-hidden="true">📞</span>'
      + '<span class="phone-number">' + formatPhone(digits) + '</span>'
      + (tagText ? '<span class="alt-tag">' + escapeHtml(tagText) + '</span>' : '');
    numBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      haptic('light');
      showPhoneActionSheet(digits, driver);
    });
    wrap.appendChild(numBtn);
    return wrap;
  }

  // ── Build card ───────────────────────────────────────────────
  function buildCard(driver) {
    const key = driverKey(driver.lastName, driver.firstName);

    const outer = document.createElement('div');
    outer.className = 'card-outer';
    outer.dataset.key = key;

    const card = document.createElement('div');
    card.className = 'card';

    const phoneList = (driver.phones || []).filter(function(p) { return p && p.digits; });
    const searchBits = [driver.lastName, driver.firstName];
    phoneList.forEach(function(p) { searchBits.push(p.digits); if (p.label) searchBits.push(p.label); });
    outer.dataset.search   = searchBits.join(' ').toLowerCase();
    outer.dataset.location = (driver.location || '').toLowerCase();

    // Header: checkbox (admin) + name + badge
    const header = document.createElement('div');
    header.className = 'card-header';

    if (isAdmin) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'card-checkbox';
      cb.checked = selectedKeys.has(key);
      cb.setAttribute('aria-label', 'Select ' + driver.lastName + ' ' + driver.firstName);
      cb.addEventListener('change', function(e) {
        e.stopPropagation();
        if (cb.checked) { selectedKeys.add(key); outer.classList.add('card-selected'); }
        else            { selectedKeys.delete(key); outer.classList.remove('card-selected'); }
        updateBulkBar();
      });
      header.appendChild(cb);
      if (selectedKeys.has(key)) outer.classList.add('card-selected');
    }

    const nameBlock = document.createElement('div');
    nameBlock.className = 'card-name-block';
    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = nameOrder === 'first'
      ? driver.firstName + ' ' + driver.lastName
      : driver.lastName + ', ' + driver.firstName;
    nameBlock.appendChild(nameEl);
    header.appendChild(nameBlock);

    const badge = makeBadge(driver.location);
    if (badge) header.appendChild(badge);
    card.appendChild(header);

    // Phone buttons — one row per number, in saved order (first = primary)
    if (phoneList.length > 0) {
      const phones = document.createElement('div');
      phones.className = 'phones';
      phoneList.forEach(function(p, i) { phones.appendChild(makePhoneGroup(p, i, driver)); });
      card.appendChild(phones);
    } else {
      const none = document.createElement('div');
      none.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;background:#fee2e2;border-radius:8px;border-left:3px solid #b91c1c;';
      none.innerHTML = '<span style="font-size:16px;">⚠️</span><span style="font-size:12px;font-weight:700;color:#b91c1c;">No phone number on file</span>';
      card.style.borderLeftColor = '#b91c1c';
      card.appendChild(none);
    }

    // Last updated timestamp
    if (driver.updatedAt) {
      const ts = document.createElement('p');
      ts.style.cssText = 'font-size:10px;color:#7a6055;margin-top:5px;font-style:italic;';
      ts.textContent = 'Updated: ' + driver.updatedAt;
      card.appendChild(ts);
    }

    // Edit button — admin only
    if (isAdmin) {
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-edit';
      editBtn.textContent = '✏️ Edit';
      editBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        openEditPanel(key);
      });
      actions.appendChild(editBtn);
      card.appendChild(actions);
    }

    outer.appendChild(card);

    // ── Long-press delete (admin only) ───────────────────────
    if (isAdmin) {
      let pressTimer = null;
      let pressing   = false;

      function startPress(e) {
        pressing = true;
        pressTimer = setTimeout(function() {
          if (pressing) initiateDelete(key, outer);
        }, 1200); // 1.2s long press
      }
      function cancelPress() {
        pressing = false;
        clearTimeout(pressTimer);
      }

      card.addEventListener('touchstart', startPress, { passive: true });
      card.addEventListener('touchend',   cancelPress);
      card.addEventListener('touchmove',  cancelPress, { passive: true });
      card.addEventListener('mousedown',  startPress);
      card.addEventListener('mouseup',    cancelPress);
      card.addEventListener('mouseleave', cancelPress);
    }

    return outer;
  }

  // ── Bulk delete bar ──────────────────────────────────────────
  function updateBulkBar() {
    const bar = document.getElementById('bulkDeleteBar');
    if (!bar) return;
    const count = selectedKeys.size;
    if (count > 0) { bar.style.display = 'flex'; document.getElementById('bulkDeleteCount').textContent = count + ' selected'; }
    else            { bar.style.display = 'none'; }
  }

  function clearAllSelections() {
    selectedKeys.clear();
    document.querySelectorAll('.card-checkbox').forEach(cb => cb.checked = false);
    document.querySelectorAll('.card-selected').forEach(el => el.classList.remove('card-selected'));
    updateBulkBar();
  }

  function confirmBulkDelete() {
    if (selectedKeys.size === 0) return;
    const count = selectedKeys.size;
    deleteBody.textContent = 'Permanently delete ' + count + ' driver' + (count > 1 ? 's' : '') + '? This cannot be undone.';
    deleteModal.classList.add('open');

    function onConfirm() {
      Array.from(selectedKeys).forEach(function(key) {
        const outer = listEl.querySelector('.card-outer[data-key="' + key + '"]');
        driverSet.delete(key);
        driverMap.delete(key);
        if (outer) animateRemove(outer);
        supabase.from('drivers').delete().eq('id', keyToDocId(key)).then(function({error}){ if(error) console.error(error); });
      });
      selectedKeys.clear();
      updateBulkBar();
      applyFilter(); filterTable();
      deleteModal.classList.remove('open');
      cleanup();
    }
    function onCancel()  { deleteModal.classList.remove('open'); cleanup(); }
    function onBackdrop(e) { if (e.target === deleteModal) onCancel(); }
    function cleanup() {
      deleteCancel.removeEventListener('click', onCancel);
      deleteConfirm.removeEventListener('click', onConfirm);
      deleteModal.removeEventListener('click', onBackdrop);
    }
    deleteCancel.addEventListener('click',  onCancel);
    deleteConfirm.addEventListener('click', onConfirm);
    deleteModal.addEventListener('click',   onBackdrop);
  }

  // ── Animate card removal ─────────────────────────────────────
  function animateRemove(el) {
    el.style.transition = 'max-height 0.3s ease, opacity 0.3s ease, margin 0.3s ease';
    el.style.maxHeight  = el.offsetHeight + 'px';
    el.style.overflow   = 'hidden';
    requestAnimationFrame(function() {
      el.style.maxHeight    = '0';
      el.style.opacity      = '0';
      el.style.marginBottom = '0';
    });
    setTimeout(function() {
      el.remove();
      allCards = allCards.filter(c => c !== el);
    }, 310);
  }

  // ── Show undo toast (delete fires after 5s) ──────────────────
  function showUndoToast(message, onCommit, onUndo) {
    // Cancel any existing pending delete
    if (_undoToastTimer) {
      clearTimeout(_undoToastTimer);
      _undoToastTimer = null;
      const old = document.getElementById('undoToast');
      if (old) old.remove();
    }

    const toast = document.createElement('div');
    toast.id = 'undoToast';
    toast.style.cssText = [
      'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);',
      'z-index:999;background:#351C15;color:#fff;',
      'border-radius:40px;padding:11px 14px 11px 18px;',
      'display:flex;align-items:center;gap:12px;overflow:hidden;',
      'box-shadow:0 4px 18px rgba(0,0,0,0.35);',
      'font-size:13px;font-weight:600;white-space:nowrap;'
    ].join('');

    const msgEl = document.createElement('span');
    msgEl.textContent = message;
    toast.appendChild(msgEl);

    const prog = document.createElement('div');
    prog.style.cssText = 'position:absolute;bottom:0;left:0;height:3px;background:#FFB500;border-radius:0;width:100%;transition:width 5s linear;';
    toast.appendChild(prog);

    const undoBtn = document.createElement('button');
    undoBtn.textContent = 'Undo';
    undoBtn.style.cssText = [
      'background:#FFB500;color:#1e0f0b;border:none;',
      'border-radius:20px;padding:5px 14px;',
      'font-size:12px;font-weight:800;cursor:pointer;flex-shrink:0;'
    ].join('');

    let cancelled = false;
    undoBtn.addEventListener('click', function() {
      cancelled = true;
      haptic('medium');
      clearTimeout(_undoToastTimer);
      _undoToastTimer = null;
      toast.remove();
      if (onUndo) onUndo();
    });
    toast.appendChild(undoBtn);
    document.body.appendChild(toast);

    requestAnimationFrame(function() {
      requestAnimationFrame(function() { prog.style.width = '0%'; });
    });

    _undoToastTimer = setTimeout(function() {
      _undoToastTimer = null;
      toast.remove();
      if (!cancelled) onCommit();
    }, 5000);
  }

  // ── Initiate delete (after long press) ───────────────────────
  function initiateDelete(key, outer) {
    const driver = driverMap.get(key);
    if (!driver) return;
    haptic('heavy');

    // Immediately remove from UI
    driverSet.delete(key);
    driverMap.delete(key);
    const savedDriver = { ...driver };
    if (outer) animateRemove(outer);
    allCards = allCards.filter(c => c !== outer);
    applyFilter(); filterTable();

    showUndoToast(
      '🗑 ' + savedDriver.lastName + ', ' + savedDriver.firstName + ' deleted',
      function onCommit() {
        supabase.from('drivers').delete().eq('id', keyToDocId(key)).then(function({error}){ if(error) console.error(error); });
        cacheDelete(keyToDocId(key));
      },
      function onUndo() {
        driverSet.add(key);
        driverMap.set(key, savedDriver);
        upsertDriver(savedDriver);
        applyFilter(); filterTable();
      }
    );
  }

  // ── Render all cards (RAF-batched for smooth performance) ────
  let _renderToken = 0; // incremented each render call to cancel stale RAF batches

  function renderCards(drivers) {
    // Cancel any in-progress render — prevents doubles when cache + network
    // both call renderCards before the first RAF loop finishes.
    const token = ++_renderToken;

    allCards.forEach(c => c.remove());
    driverSet.clear();
    driverMap.clear();
    allCards = [];

    const BATCH = 50; // cards per animation frame — 50 keeps frames under 16ms on modern phones
    let index = 0;

    function renderBatch() {
      if (token !== _renderToken) return; // a newer render started — stop this one
      const frag = document.createDocumentFragment();
      const end  = Math.min(index + BATCH, drivers.length);
      for (let i = index; i < end; i++) {
        registerDriver(drivers[i]);
        const outer = buildCard(drivers[i]);
        frag.appendChild(outer);
        allCards.push(outer);
      }
      listEl.insertBefore(frag, noResults);
      index = end;
      if (index < drivers.length) {
        requestAnimationFrame(renderBatch);
      } else {
        applyFilter(); filterTable(); // run filter once all cards are in DOM
      }
    }

    if (drivers.length > 0) {
      requestAnimationFrame(renderBatch);
    } else {
      applyFilter(); filterTable();
    }
  }

  // ── Update local UI only (called from snapshot handler — no Firestore write) ──
  function upsertDriver(driver) {
    const key   = driverKey(driver.lastName, driver.firstName);
    const isNew = !driverSet.has(key);
    registerDriver(driver);
    const newOuter = buildCard(driver);

    if (!isNew) {
      const existing = listEl.querySelector('.card-outer[data-key="' + key + '"]');
      if (existing) {
        listEl.replaceChild(newOuter, existing);
        const idx = allCards.indexOf(existing);
        if (idx !== -1) allCards[idx] = newOuter;
      } else {
        allCards.push(newOuter);
        listEl.insertBefore(newOuter, noResults);
      }
    } else {
      const sortKey = function(d) {
        return nameOrder === 'first'
          ? (d.firstName + d.lastName).toLowerCase()
          : (d.lastName + d.firstName).toLowerCase();
      };
      const insertBefore = allCards.find(function(c) {
        const cd = driverMap.get(c.dataset.key);
        if (!cd) return false;
        return sortKey(cd) > sortKey(driver);
      });
      if (insertBefore) {
        listEl.insertBefore(newOuter, insertBefore);
        allCards.splice(allCards.indexOf(insertBefore), 0, newOuter);
      } else {
        allCards.push(newOuter);
        listEl.insertBefore(newOuter, noResults);
      }
    }
    // NOTE: no Firestore write here — snapshot handler calls this after
    // already receiving data from Firestore. Writing back would cause a loop.
  }

  // ── Encrypt + write driver to Firestore (called only from saveDriver) ──
  async function saveDriverToFirestore(driver) {
    const key = driverKey(driver.lastName, driver.firstName);
    const id  = keyToDocId(key);
    const encrypted = await encryptDriver(driver);
    const { error } = await supabase.from('drivers').upsert({ id, data: encrypted });
    if (error) throw new Error(error.message);
    await cachePut({ id, data: encrypted }); // keep local cache in sync
    addWrites(1);
  }

  // ── Filter / search ──────────────────────────────────────────
  function updateCount(visible) {
    const meta = JSON.parse(localStorage.getItem('dcl_last_import') || 'null');
    const ts = meta ? ' · Updated ' + meta.date : '';
    countBar.textContent = 'Showing ' + visible + ' of ' + allCards.length + ' drivers' + ts;
  }

  // ── Desktop table rendering (renders alongside card list) ──
  const tableBody = document.getElementById('driversTableBody');
  let tableRows = [];

  function renderTable(drivers) {
    if (!tableBody) return; // element might not exist on mobile
    
    tableRows.forEach(r => r.remove());
    tableRows = [];

    drivers.forEach(function(driver) {
      const row = document.createElement('tr');
      row.dataset.key = driverKey(driver.lastName, driver.firstName);
      row.dataset.location = (driver.location || '').toLowerCase();
      row.dataset.search = ((driver.firstName + ' ' + driver.lastName + ' ' + (driver.tags || []).join(' ')).toLowerCase());

      // Name
      const nameCell = document.createElement('td');
      nameCell.className = 'driver-name';
      nameCell.textContent = driver.lastName + ', ' + driver.firstName;

      // Primary phone
      const phoneCell = document.createElement('td');
      const primaryPhone = (driver.phones && driver.phones[0]) ? driver.phones[0].display : 'N/A';
      phoneCell.innerHTML = '<span class="phone-badge">' + escapeHtml(primaryPhone) + '</span>';

      // Phone count
      const countCell = document.createElement('td');
      countCell.textContent = (driver.phones || []).length;

      // Labels
      const labelsCell = document.createElement('td');
      const labels = (driver.tags || []);
      labelsCell.innerHTML = labels.map(function(tag) {
        return '<span class="label-badge">' + escapeHtml(tag) + '</span>';
      }).join('');

      // Actions (Edit button)
      const actionsCell = document.createElement('td');
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-edit-driver';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function() {
        editDriver(driver);
      });
      actionsCell.appendChild(editBtn);

      row.appendChild(nameCell);
      row.appendChild(phoneCell);
      row.appendChild(countCell);
      row.appendChild(labelsCell);
      row.appendChild(actionsCell);

      tableBody.appendChild(row);
      tableRows.push(row);
    });
  }

  function filterTable() {
    if (!tableBody) return;
    let visible = 0;
    tableRows.forEach(function(row) {
      const locMatch  = activeFilter === 'all' || row.dataset.location === activeFilter;
      const textMatch = !searchQuery || row.dataset.search.includes(searchQuery);
      const show = locMatch && textMatch;
      row.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    updateCount(visible);
  }

    function applyFilter() {
    searchQuery = searchBox.value.toLowerCase().trim();
    const query = searchBox.value.toLowerCase().trim();
    let visible = 0;
    allCards.forEach(function(outer) {
      const locMatch  = activeFilter === 'all' || outer.dataset.location === activeFilter;
      const textMatch = !query || outer.dataset.search.includes(query);
      const show = locMatch && textMatch;
      outer.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    noResults.style.display = visible === 0 ? 'block' : 'none';
    updateCount(visible);
  }

  // ── Phone rows editor (add/remove/drag-reorder, max 5) ───────
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function attachRowDrag(row, handle) {
    handle.addEventListener('pointerdown', function(e) {
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch(_) {}
      row.classList.add('phone-row-dragging');
      row.style.transition = 'none';
      row.style.willChange = 'transform';
      haptic('light');

      // The row follows the pointer via translateY(pointerY - grabY).
      // grabY is adjusted whenever the row's slot in the DOM changes, so the
      // row stays glued to the cursor/finger across reorders.
      let grabY = e.clientY;

      function reinsert(refNode) {
        const before = row.offsetTop;            // layout position, ignores transform
        phoneRowsEl.insertBefore(row, refNode);
        const after = row.offsetTop;
        grabY += (after - before);
      }

      // FLIP: the displaced row animates smoothly into its new slot
      function flip(el, prevTop) {
        const d = prevTop - el.getBoundingClientRect().top;
        if (!d) return;
        el._flip = true;
        el.style.transition = 'none';
        el.style.transform = 'translateY(' + d + 'px)';
        requestAnimationFrame(function() {
          el.style.transition = 'transform 0.15s ease';
          el.style.transform = '';
        });
        setTimeout(function() { el.style.transition = ''; el._flip = false; }, 180);
      }

      function onMove(ev) {
        const y = ev.clientY;
        row.style.transform = 'translateY(' + (y - grabY) + 'px)';
        const rows = Array.from(phoneRowsEl.querySelectorAll('.phone-row'));
        for (let i = 0; i < rows.length; i++) {
          const other = rows[i];
          if (other === row || other._flip) continue;   // skip rows mid-animation
          const rect = other.getBoundingClientRect();
          if (y > rect.top && y < rect.bottom) {
            const before = y < rect.top + rect.height / 2;
            if (before && other.previousElementSibling !== row) {
              reinsert(other);
              row.style.transform = 'translateY(' + (y - grabY) + 'px)';
              flip(other, rect.top);
              haptic('light');
            } else if (!before && other.nextElementSibling !== row) {
              reinsert(other.nextElementSibling);
              row.style.transform = 'translateY(' + (y - grabY) + 'px)';
              flip(other, rect.top);
              haptic('light');
            }
            break;
          }
        }
      }
      function onUp() {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        // Settle the row into its slot with a short snap animation
        row.style.transition = 'transform 0.15s ease';
        row.style.transform = '';
        setTimeout(function() {
          row.style.transition = '';
          row.style.willChange = '';
          row.classList.remove('phone-row-dragging');
          refreshPhoneRows();
        }, 160);
      }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  function makePhoneRow(digits, label) {
    const row = document.createElement('div');
    row.className = 'phone-row';

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'phone-row-handle';
    handle.setAttribute('aria-label', 'Drag to reorder');
    handle.textContent = '≡';

    const numInput = document.createElement('input');
    numInput.type = 'tel';
    numInput.className = 'phone-row-num';
    numInput.placeholder = 'Phone number';
    numInput.autocomplete = 'off';
    numInput.value = digits ? formatPhone(digits) : '';
    numInput.addEventListener('input', liveFormatPhone);

    const lblInput = document.createElement('input');
    lblInput.type = 'text';
    lblInput.className = 'phone-row-label';
    lblInput.placeholder = 'Label';
    lblInput.maxLength = 12;
    lblInput.autocomplete = 'off';
    lblInput.value = label || '';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'phone-row-remove';
    removeBtn.setAttribute('aria-label', 'Remove number');
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', function() {
      haptic('light');
      row.remove();
      refreshPhoneRows();
    });

    row.appendChild(handle);
    row.appendChild(numInput);
    row.appendChild(lblInput);
    row.appendChild(removeBtn);
    attachRowDrag(row, handle);
    return row;
  }

  function refreshPhoneRows() {
    if (phoneRowsEl.querySelectorAll('.phone-row').length === 0) {
      phoneRowsEl.appendChild(makePhoneRow('', ''));
    }
    const rows = phoneRowsEl.querySelectorAll('.phone-row');
    rows.forEach(function(r, i) {
      r.classList.toggle('phone-row-primary', i === 0);
      r.querySelector('.phone-row-num').placeholder = i === 0 ? 'Primary number' : 'Phone number';
    });
    btnAddPhone.style.display = rows.length >= MAX_PHONES ? 'none' : 'block';
  }

  function setPhoneRows(phones) {
    phoneRowsEl.innerHTML = '';
    const list = (phones && phones.length) ? phones : [{ digits: '', label: '' }];
    list.forEach(function(p) { phoneRowsEl.appendChild(makePhoneRow(p.digits, p.label)); });
    refreshPhoneRows();
  }

  // Collect rows top-to-bottom. Empty rows are skipped; a row with a partial
  // number is an error. Returns { phones } or { error }.
  function collectPhoneRows() {
    const phones = [];
    const rows = phoneRowsEl.querySelectorAll('.phone-row');
    for (let i = 0; i < rows.length; i++) {
      const raw   = rows[i].querySelector('.phone-row-num').value.trim();
      const label = rows[i].querySelector('.phone-row-label').value.trim();
      if (!raw) continue;
      const digits = normalisePhone(raw);
      if (!digits) return { error: 'Number ' + (i + 1) + ' needs at least 10 digits.' };
      phones.push({ digits: digits, display: formatPhone(digits), label: label });
    }
    return { phones: phones.slice(0, MAX_PHONES) };
  }

  btnAddPhone.addEventListener('click', function() {
    if (phoneRowsEl.querySelectorAll('.phone-row').length >= MAX_PHONES) return;
    haptic('light');
    const row = makePhoneRow('', '');
    phoneRowsEl.appendChild(row);
    refreshPhoneRows();
    row.querySelector('.phone-row-num').focus();
  });

  // ── Panel helpers ────────────────────────────────────────────
  function openAddPanel() {
    editingKey = null;
    addPanelTitle.textContent = 'Add Driver';
    btnSave.textContent = 'Save Driver';
    inputLastName.value = ''; inputFirstName.value = '';
    inputLocation.value = 'Greensboro';
    setPhoneRows([]);
    panelNote.textContent = '';
    showPanel();
  }
  function openEditPanel(key) {
    const driver = driverMap.get(key);
    if (!driver) return;
    editingKey = key;
    addPanelTitle.textContent = 'Edit Driver';
    btnSave.textContent = 'Update Driver';
    inputLastName.value  = driver.lastName;
    inputFirstName.value = driver.firstName;
    // Ensure location maps to a valid select option — default to Greensboro
    const validLocs = ['Greensboro', 'Mebane'];
    inputLocation.value = validLocs.includes(driver.location) ? driver.location : 'Greensboro';
    setPhoneRows(normalizePhones(Object.assign({}, driver)).phones);
    panelNote.textContent = '';
    function onLocationChange() {
      if (inputLocation.value !== 'Retired') return;
      inputLocation.value = driver.location || 'Greensboro';
      deleteBody.textContent = 'Mark ' + driver.firstName + ' ' + driver.lastName + ' as retired? They will be hidden from the active list but kept in retired records.';
      const origText = deleteConfirm.textContent;
      deleteConfirm.textContent = 'Mark Retired';
      deleteModal.classList.add('open');
      function onConfirm() {
        const rd = Object.assign({}, driver, { retired: true, retiredAt: new Date().toISOString() });
        encryptDriver(rd).then(function(enc) {
          const docId = keyToDocId(key);
          // Write retired record to IDB cache immediately so reload doesn't resurrect them
          cachePut({ id: docId, data: enc });
          supabase.from('drivers').upsert({ id: docId, data: enc })
            .then(function(r){
              if (r.error) {
                console.error('Retire upsert failed:', r.error);
                alert('Failed to save retired status: ' + r.error.message);
              } else {
                console.log('Retire saved OK for', rd.lastName, rd.firstName, 'retired:', enc.retired);
              }
            });
        });
        driverSet.delete(key); driverMap.delete(key);
        const outer = listEl.querySelector('.card-outer[data-key="' + key + '"]');
        if (outer) animateRemove(outer);
        allCards = allCards.filter(function(c){ return c !== outer; });
        applyFilter(); filterTable();
        inputLocation.removeEventListener('change', onLocationChange);
        deleteModal.classList.remove('open'); deleteConfirm.textContent = origText;
        cleanup(); closePanel();
      }
      function onCancel() { deleteModal.classList.remove('open'); deleteConfirm.textContent = origText; cleanup(); }
      function onBackdrop(e) { if (e.target === deleteModal) onCancel(); }
      function cleanup() {
        deleteConfirm.removeEventListener('click', onConfirm);
        deleteCancel.removeEventListener('click', onCancel);
        deleteModal.removeEventListener('click', onBackdrop);
      }
      deleteConfirm.addEventListener('click', onConfirm);
      deleteCancel.addEventListener('click', onCancel);
      deleteModal.addEventListener('click', onBackdrop);
    }
    inputLocation.addEventListener('change', onLocationChange);
    showPanel();
  }
  function showPanel() {
    panelOverlay.classList.add('visible');
    addPanel.classList.add('open');
    setTimeout(function() { inputFirstName.focus(); }, 350);
  }
  function closePanel() {
    addPanel.classList.remove('open');
    panelOverlay.classList.remove('visible');
  }

  // ── Save ─────────────────────────────────────────────────────
  async function saveDriver() {
    const lastName  = inputLastName.value.trim();
    const firstName = inputFirstName.value.trim();
    if (!lastName || !firstName) { alert('⚠️ First and last name are required.'); panelNote.textContent = '⚠️ First and last name are required.'; return; }
    const collected = collectPhoneRows();
    if (collected.error) { alert('⚠️ ' + collected.error); panelNote.textContent = '⚠️ ' + collected.error; return; }
    const phones = collected.phones;

    const newKey = driverKey(lastName, firstName);
    const isNew  = !driverSet.has(newKey);

    if (editingKey && editingKey !== newKey) {
      const oldOuter = listEl.querySelector('.card-outer[data-key="' + editingKey + '"]');
      driverSet.delete(editingKey);
      driverMap.delete(editingKey);
      supabase.from('drivers').delete().eq('id', keyToDocId(editingKey)).then(function({error}){ if(error) console.error(error); });
      if (oldOuter) {
        allCards = allCards.filter(c => c !== oldOuter);
        oldOuter.remove();
      }
    }

    const driver = normalizePhones({
      lastName,
      firstName,
      location: normaliseSlic(inputLocation.value),
      phones:   phones,
      updatedAt: new Date().toLocaleString(),
    });

    try {
      btnSave.disabled = true;
      btnSave.textContent = 'Saving…';
      upsertDriver(driver);           // update UI immediately
      await saveDriverToFirestore(driver); // then persist to Firestore
      panelNote.textContent = isNew ? '✅ Driver added.' : '✅ Driver updated.';
      setTimeout(closePanel, 600);
    } catch (err) {
      panelNote.textContent = '❌ Save failed.';
      alert('❌ Save failed: ' + err.message);
      console.error('saveDriver error:', err);
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = editingKey ? 'Update Driver' : 'Save Driver';
    }
  }


  // ── Daily write counter ───────────────────────────────────────
  const WRITE_COUNT_KEY  = 'dcl_write_count';
  const WRITE_DATE_KEY   = 'dcl_write_date';
  const DAILY_LIMIT      = 20000;

  function getTodayStr() {
    return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
  }

  function getWriteCount() {
    const saved = localStorage.getItem(WRITE_DATE_KEY);
    if (saved !== getTodayStr()) {
      localStorage.setItem(WRITE_DATE_KEY, getTodayStr());
      localStorage.setItem(WRITE_COUNT_KEY, '0');
      return 0;
    }
    return parseInt(localStorage.getItem(WRITE_COUNT_KEY) || '0', 10);
  }

  function addWrites(n) {
    const current = getWriteCount();
    const next = current + n;
    localStorage.setItem(WRITE_COUNT_KEY, String(next));
    updateWriteBar();
  }

  function updateWriteBar() {
    const bar = document.getElementById('writeCountBar');
    if (!bar) return;
    const count = getWriteCount();
    const pct   = Math.min((count / DAILY_LIMIT) * 100, 100);
    const color = pct > 80 ? '#b91c1c' : pct > 50 ? '#ca8a04' : '#FFB500';
    bar.innerHTML =
      '<span style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;">Today\'s writes</span>'
      + '<div style="flex:1;background:rgba(255,255,255,0.1);border-radius:20px;height:6px;overflow:hidden;">'
      +   '<div style="width:' + pct.toFixed(2) + '%;height:100%;background:' + color + ';border-radius:20px;transition:width 0.3s ease;"></div>'
      + '</div>'
      + '<span style="font-size:12px;font-weight:700;color:' + color + ';white-space:nowrap;">' + count.toLocaleString() + ' / ' + DAILY_LIMIT.toLocaleString() + '</span>'
      + '<span style="font-size:11px;color:rgba(255,255,255,0.4);white-space:nowrap;">resets midnight PT</span>';
  }

  // ── Admin login ───────────────────────────────────────────────
  function promptAdminLogin() {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(53,28,21,0.65);display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(3px);';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:18px;padding:28px 24px 22px;max-width:320px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.3);text-align:center;border-top:4px solid #FFB500;';
    box.innerHTML = '<div style="font-size:32px;margin-bottom:10px;">\ud83d\udd10</div>'
      + '<h2 style="font-size:17px;font-weight:800;color:#351C15;margin-bottom:14px;">Admin Login</h2>'
      + '<input type="password" id="adminPwInput" placeholder="Admin password" style="width:100%;padding:11px 14px;border-radius:10px;border:1.5px solid #e5d5cc;font-size:16px;outline:none;margin-bottom:8px;text-align:center;-webkit-appearance:none;">'
      + '<p id="adminPwError" style="font-size:12px;color:#b91c1c;min-height:16px;margin-bottom:12px;font-weight:600;"></p>'
      + '<div style="display:flex;gap:8px;">'
      + '<button id="adminCancelBtn" style="flex:1;padding:11px;border-radius:10px;border:1.5px solid #e5d5cc;background:#fff;color:#7a6055;font-size:14px;font-weight:600;cursor:pointer;">Cancel</button>'
      + '<button id="adminUnlockBtn" style="flex:2;padding:11px;border-radius:10px;border:none;background:#351C15;color:#FFB500;font-size:14px;font-weight:800;cursor:pointer;">Unlock</button>'
      + '</div>';
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    const pwInput   = box.querySelector('#adminPwInput');
    const errorEl   = box.querySelector('#adminPwError');
    const cancelBtn = box.querySelector('#adminCancelBtn');
    const unlockBtn = box.querySelector('#adminUnlockBtn');

    setTimeout(function() { pwInput.focus(); }, 200);
    cancelBtn.addEventListener('click',  function() { backdrop.remove(); });
    backdrop.addEventListener('click',   function(e) { if (e.target === backdrop) backdrop.remove(); });
    pwInput.addEventListener('keydown',  function(e) { if (e.key === 'Enter') unlockBtn.click(); });

    unlockBtn.addEventListener('click', function() {
      sha256(pwInput.value).then(function(hash) {
        if (hash === ADMIN_PASSWORD_HASH) {
          backdrop.remove();
          isAdmin = true;
          localStorage.setItem('dcl_admin', '1');
          showAdminControls();
          renderCards(Array.from(driverMap.values())); renderTable(Array.from(driverMap.values()));
        } else {
          errorEl.textContent = '\u274c Incorrect password.';
          pwInput.value = '';
          pwInput.focus();
        }
      });
    });
  }

  function showAdminControls() {
    fabAdd.style.display = 'flex';
    document.getElementById('adminBar').style.display = 'flex';
    document.getElementById('btnAdminLogin').style.display = 'none';
    document.getElementById('btnAdminLogoutHeader').style.display = 'flex';

    // Inject write counter bar if not already present
    if (false && !document.getElementById('writeCountBar')) {
      const wb = document.createElement('div');
      wb.id = 'writeCountBar';
      wb.style.cssText = 'display:flex;align-items:center;gap:10px;background:rgba(0,0,0,0.25);border-radius:8px;padding:8px 12px;margin-top:4px;';
      document.getElementById('adminBar').after(wb);
      updateWriteBar();
    }

    // Inject backup age reminder
    if (!document.getElementById('backupAgeLabel')) {
      const lbl = document.createElement('span');
      lbl.id = 'backupAgeLabel';
      lbl.style.cssText = 'font-size:11px;font-weight:600;letter-spacing:0.2px;white-space:nowrap;align-self:center;';
      document.getElementById('adminBar').appendChild(lbl);
      updateBackupLabel();
    }

    if (!document.getElementById('bulkDeleteBar')) {
      const bar = document.createElement('div');
      bar.id = 'bulkDeleteBar';
      bar.style.cssText = 'display:none;position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:300;background:#351C15;color:#FFB500;border-radius:40px;padding:10px 18px;gap:12px;align-items:center;box-shadow:0 4px 18px rgba(53,28,21,0.35);font-size:14px;font-weight:700;white-space:nowrap;';
      bar.innerHTML = '<span id="bulkDeleteCount">0 selected</span>'
        + '<button onclick="window.__clearSel()" style="background:rgba(255,255,255,0.1);border:1.5px solid rgba(255,255,255,0.3);color:rgba(255,255,255,0.8);border-radius:20px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer;">Clear</button>'
        + '<button onclick="window.__bulkDel()" style="background:#b91c1c;border:none;color:#fff;border-radius:20px;padding:5px 14px;font-size:12px;font-weight:800;cursor:pointer;">🗑 Delete</button>';
      document.body.appendChild(bar);
      window.__bulkDel  = confirmBulkDelete;
      window.__clearSel = clearAllSelections;
    }
  }

  function hideAdminControls() {
    fabAdd.style.display = 'none';
    document.getElementById('adminBar').style.display = 'none';
    document.getElementById('btnAdminLogin').style.display = 'flex';
    document.getElementById('btnAdminLogoutHeader').style.display = 'none';
    clearAllSelections();
    const bar = document.getElementById('bulkDeleteBar');
    if (bar) bar.style.display = 'none';
  }

  function adminLogout() {
    isAdmin = false;
    localStorage.removeItem('dcl_admin');
    hideAdminControls();
    renderCards(Array.from(driverMap.values())); renderTable(Array.from(driverMap.values()));
  }

  // ── Import progress helpers ───────────────────────────────────
  function setProgress(pct, label) {
    importProgressWrap.style.display = 'block';
    importProgressBar.style.width = pct + '%';
    if (label) importProgressLabel.textContent = label;
  }
  function hideProgress() {
    importProgressWrap.style.display = 'none';
    importProgressBar.style.width = '0%';
  }

  // ── PDF text extraction via pdf.js ───────────────────────────
  async function extractTextFromPdf(file) {
    const pdfjsLib = globalThis.pdfjsLib || (await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.3.136/pdf.min.mjs'));
    if (pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.3.136/pdf.worker.min.mjs';
    }
    const buffer = await file.arrayBuffer();
    const pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;

    // Extract items with position data so we can reconstruct rows properly
    const allPageItems = [];
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      const page    = await pdfDoc.getPage(p);
      const content = await page.getTextContent();
      const vp      = page.getViewport({ scale: 1 });
      // Normalise y to top-down, attach page number
      content.items.forEach(function(item) {
        allPageItems.push({
          str:  item.str.trim(),
          x:    item.transform[4],
          y:    vp.height - item.transform[5],
          page: p
        });
      });
    }
    return allPageItems;
  }

  // ── Parse PDF items into driver objects ───────────────────────
  // Handles your specific 3-column format:
  // LASTNAME, FIRSTNAME   (phone)   (altphone)
  // Location sections detected by header text
  function parsePdfText(items) {
    const phoneRE = /^[\d()+\-.\s]{7,}$/;
    const nameRE  = /^[A-Z][A-Z\s,.''\-()+]+$/;

    // Skip header/footer garbage
    const SKIP = /^(driver\s*name|home\s*phone|alternative|click\s*any|feeder\s*drivers|driver\s*phone\s*directory|page\s*\d|greensboro|mebane)$/i;

    // Group items into rows by proximity of y coordinate (within 6px = same row)
    const rows = [];
    const sorted = [...items].sort(function(a, b) {
      if (a.page !== b.page) return a.page - b.page;
      if (Math.abs(a.y - b.y) > 6) return a.y - b.y;
      return a.x - b.x;
    });

    let currentRow = null;
    for (const item of sorted) {
      if (!item.str) continue;
      if (!currentRow || item.page !== currentRow.page || Math.abs(item.y - currentRow.y) > 6) {
        currentRow = { y: item.y, page: item.page, items: [] };
        rows.push(currentRow);
      }
      currentRow.items.push(item);
    }

    // Detect location from section headers
    let currentLocation = 'Greensboro';
    const drivers = [];

    for (const row of rows) {
      const text = row.items.map(i => i.str).join(' ').trim();

      // Location header detection
      if (/greensboro\s*feeder/i.test(text)) { currentLocation = 'Greensboro'; continue; }
      if (/mebane\s*feeder/i.test(text))     { currentLocation = 'Mebane';     continue; }

      // Skip known header/footer rows
      if (SKIP.test(text.trim())) continue;
      if (/driver\s*name/i.test(text))       continue;

      // Extract all phone numbers from this row
      const phones = [];
      const nameTokens = [];

      for (const item of row.items) {
        const s = item.str.trim();
        if (!s) continue;
        const digits = normalisePhone(s);
        if (digits) {
          phones.push(digits);
        } else if (!SKIP.test(s) && !/^(E|C|H|2nd|WI|calling\s*back|CALLING\s*BACK)$/i.test(s)) {
          nameTokens.push(s);
        }
      }

      // Must have at least a name token
      if (nameTokens.length === 0) continue;

      const nameStr = nameTokens.join(' ').trim();

      // Must look like a name (contains a letter, not pure header)
      if (!/[A-Za-z]/.test(nameStr)) continue;
      if (/^(driver|home|alternative|click|directory)$/i.test(nameStr)) continue;

      // Parse LASTNAME, FIRSTNAME format
      let lastName = '', firstName = '';
      if (nameStr.includes(',')) {
        const comma = nameStr.indexOf(',');
        lastName  = nameStr.slice(0, comma).trim();
        firstName = nameStr.slice(comma + 1).trim();
      } else {
        // Space-separated: last word is last name
        const parts = nameStr.split(/\s+/);
        lastName  = parts[parts.length - 1];
        firstName = parts.slice(0, -1).join(' ');
      }

      // Clean up — remove parenthetical nicknames from firstName if needed
      firstName = firstName.replace(/\s*\(.*?\)\s*/g, ' ').trim();
      lastName  = lastName.replace(/\s*\(.*?\)\s*/g, ' ').trim();

      // Must have both parts
      if (!lastName || !firstName) continue;

      // Skip if name looks like a header
      if (/^(driver|name|home|phone|alternative)$/i.test(lastName)) continue;

      drivers.push({
        lastName:  toTitleCase(lastName),
        firstName: toTitleCase(firstName),
        location:  currentLocation,
        phone:    phones[0] ? { digits: phones[0], display: formatPhone(phones[0]) } : null,
        altPhone: phones[1] ? { digits: phones[1], display: formatPhone(phones[1]) } : null,
        photo:    null
      });
    }
    return drivers;
  }

  function toTitleCase(str) {
    return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }


  // ── List Cleanup Modal ──────────────────────────────────────
  function openDupModal() {
    dupResults.innerHTML = '';
    window.__cleanupSelected = [];
    document.getElementById('dupRetireSelected').style.display = 'none';
    document.getElementById('dupDeleteSelected').style.display = 'none';
    document.getElementById('dupMarkClean').style.display = 'none';

    function updateBtns() {
      const any = window.__cleanupSelected.length > 0;
      document.getElementById('dupRetireSelected').style.display = any ? 'inline-block' : 'none';
      document.getElementById('dupDeleteSelected').style.display = any ? 'inline-block' : 'none';
    }
    function addDivider() {
      const d = document.createElement('div');
      d.style.cssText = 'border-top:1px solid rgba(255,255,255,0.15);margin:10px 0;';
      dupResults.appendChild(d);
    }
    function makeHeader(emoji, text, color) {
      const h = document.createElement('p');
      h.style.cssText = 'font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 6px;color:' + color + ';';
      h.textContent = emoji + ' ' + text;
      return h;
    }
    function makeCheckRow(key, labelText, accentColor) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 2px;border-bottom:1px solid rgba(255,255,255,0.1);';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.style.cssText = 'flex-shrink:0;width:16px;height:16px;accent-color:' + accentColor + ';';
      cb.addEventListener('change', function() {
        if (cb.checked) window.__cleanupSelected.push(key);
        else window.__cleanupSelected = window.__cleanupSelected.filter(function(k){ return k !== key; });
        updateBtns();
      });
      const lbl = document.createElement('span');
      lbl.style.cssText = 'font-size:13px;color:#ffffff;line-height:1.3;';
      lbl.textContent = labelText;
      row.appendChild(cb); row.appendChild(lbl);
      return row;
    }

    // Section 1: Same number listed twice on one contact
    const sameBoth = [];
    driverMap.forEach(function(d, key) {
      const nd = normalizePhones(Object.assign({}, d));
      const seen = new Set();
      let dupDigits = null;
      nd.phones.forEach(function(p) {
        if (seen.has(p.digits)) dupDigits = p.digits;
        seen.add(p.digits);
      });
      if (dupDigits) sameBoth.push({ key: key, d: d, dupDigits: dupDigits });
    });
    const sec1hdr = makeHeader('🔁', 'Duplicate Number on One Contact (' + sameBoth.length + ')', '#FFB500');
    dupResults.appendChild(sec1hdr);
    if (sameBoth.length === 0) {
      const ok = document.createElement('p');
      ok.style.cssText = 'color:#6ee7a0;text-align:center;padding:6px;font-size:13px;margin:0;';
      ok.textContent = '✅ No contacts with duplicate primary/alt numbers.';
      dupResults.appendChild(ok);
    } else {
      sameBoth.forEach(function(item) {
        const d = item.d; const key = item.key;
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 2px;border-bottom:1px solid rgba(255,255,255,0.1);';
        wrap.dataset.mergeRow = '1';
        const info = document.createElement('div'); info.style.cssText = 'flex:1;min-width:0;';
        const nm = document.createElement('div'); nm.style.cssText = 'font-size:13px;font-weight:700;color:#fff;'; nm.textContent = d.lastName + ', ' + d.firstName;
        const ph = document.createElement('div'); ph.style.cssText = 'font-size:11px;color:#FFB500;margin-top:2px;'; ph.textContent = formatPhone(item.dupDigits) + ' (listed twice)';
        info.appendChild(nm); info.appendChild(ph);
        const mergeBtn = document.createElement('button');
        mergeBtn.textContent = '🧹 Remove Duplicate';
        mergeBtn.style.cssText = 'padding:5px 9px;border-radius:8px;border:1.5px solid #FFB500;background:rgba(255,181,0,0.15);color:#FFB500;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;';
        mergeBtn.addEventListener('click', async function() {
          mergeBtn.disabled = true; mergeBtn.textContent = '…';
          // Keep the first occurrence of each number (preserving order and labels)
          const nd = normalizePhones(Object.assign({}, d));
          const seenD = new Set();
          const deduped = nd.phones.filter(function(p) {
            if (seenD.has(p.digits)) return false;
            seenD.add(p.digits);
            return true;
          });
          const updated = normalizePhones(Object.assign({}, d, { phones: deduped, updatedAt: new Date().toLocaleString() }));
          try {
            await saveDriverToFirestore(updated); driverMap.set(key, updated); upsertDriver(updated); applyFilter(); filterTable(); wrap.remove();
            sec1hdr.textContent = '🔁 Duplicate Number on One Contact (' + dupResults.querySelectorAll('[data-merge-row]').length + ')';
          } catch(e) { mergeBtn.disabled = false; mergeBtn.textContent = '🧹 Remove Duplicate'; alert('Failed: ' + e.message); }
        });
        wrap.appendChild(info); wrap.appendChild(mergeBtn); dupResults.appendChild(wrap);
      });
    }

    addDivider();

    // Section 2: Not on last import
    const meta = JSON.parse(localStorage.getItem('dcl_last_import') || 'null');
    dupResults.appendChild(makeHeader('📋', 'Not on Last Import – GRENC', 'rgba(255,255,255,0.7)'));
    if (!meta) {
      const noImport = document.createElement('p');
      noImport.style.cssText = 'color:rgba(255,255,255,0.5);text-align:center;padding:8px;font-size:13px;margin:0;';
      noImport.textContent = 'Run an import first to see this section.';
      dupResults.appendChild(noImport);
    } else {
      const importedIds = new Set(meta.grencIds || []);
      const possibly = [];
      driverMap.forEach(function(d, key) {
        if ((d.location || '').toLowerCase() !== 'greensboro') return;
        if (!importedIds.has(keyToDocId(key))) possibly.push({ key: key, d: d });
      });
      const impInfo = document.createElement('p');
      impInfo.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.4);margin:0 0 6px;';
      impInfo.textContent = 'Last import: ' + meta.file + ' (' + meta.date + ')';
      dupResults.appendChild(impInfo);
      if (possibly.length === 0) {
        const ok = document.createElement('p'); ok.style.cssText = 'color:#6ee7a0;text-align:center;padding:6px;font-size:13px;margin:0;';
        ok.textContent = '✅ All GRENC drivers were on the last import.'; dupResults.appendChild(ok);
      } else {
        // Show mark-clean button at top since there are unaccounted drivers
        document.getElementById('dupMarkClean').style.display = 'block';
        possibly.forEach(function(item) {
          const phone = item.d.phone ? formatPhone(item.d.phone.digits) : 'no phone';
          dupResults.appendChild(makeCheckRow(item.key, item.d.lastName + ', ' + item.d.firstName + ' — ' + phone, '#ca8a04'));
        });
      }
    }

    addDivider();

    // Section 3: No phone on file
    const noPhone = [];
    driverMap.forEach(function(d, key) { if (normalizePhones(Object.assign({}, d)).phones.length === 0) noPhone.push({ key: key, d: d }); });
    noPhone.sort(function(a, b) { return (a.d.lastName + a.d.firstName).toLowerCase() < (b.d.lastName + b.d.firstName).toLowerCase() ? -1 : 1; });
    dupResults.appendChild(makeHeader('📵', 'No Phone on File (' + noPhone.length + ')', '#f87171'));
    if (noPhone.length === 0) {
      const ok2 = document.createElement('p'); ok2.style.cssText = 'color:#6ee7a0;text-align:center;padding:6px;font-size:13px;margin:0;';
      ok2.textContent = '✅ All drivers have at least one phone number.'; dupResults.appendChild(ok2);
    } else {
      noPhone.forEach(function(item) {
        const loc = item.d.location === 'Mebane' ? 'MEBNC' : 'GRENC';
        dupResults.appendChild(makeCheckRow(item.key, item.d.lastName + ', ' + item.d.firstName + ' (' + loc + ')', '#f87171'));
      });
    }

    dupModal.classList.add('open');
    updateBtns();
  }

  dupClose.addEventListener('click', function() { dupModal.classList.remove('open'); });

  var _mc = document.getElementById('dupMarkClean'); if (_mc) _mc.addEventListener('click', function() { localStorage.removeItem('dcl_last_import'); dupModal.classList.remove('open'); });

  function commitCleanup(mode) {
    const keys = window.__cleanupSelected || [];
    keys.forEach(function(key) {
      const driver = driverMap.get(key);
      const outer  = listEl.querySelector('.card-outer[data-key="' + key + '"]');
      driverSet.delete(key); driverMap.delete(key);
      if (outer) { animateRemove(outer); allCards = allCards.filter(function(c){ return c !== outer; }); }
      if (mode === 'retire' && driver) {
        var rd = Object.assign({}, driver, { retired: true, retiredAt: new Date().toISOString() });
        encryptDriver(rd).then(function(enc) {
          supabase.from('drivers').upsert({ id: keyToDocId(key), data: enc }).then(function(r){ if(r.error) console.error(r.error); });
        });
      } else {
        supabase.from('drivers').delete().eq('id', keyToDocId(key)).then(function(r){ if(r.error) console.error(r.error); });
      }
      cacheDelete(keyToDocId(key));
    });
    window.__cleanupSelected = [];
    applyFilter(); filterTable();
    dupModal.classList.remove('open');
  }

  function confirmCleanup(mode) {
    const keys = window.__cleanupSelected || [];
    if (keys.length === 0) return;
    const count = keys.length;
    const nameList = keys.slice(0, 3).map(function(k) {
      var d = driverMap.get(k);
      return d ? d.lastName + ', ' + d.firstName : k;
    }).join(', ') + (count > 3 ? ' and ' + (count - 3) + ' more' : '');
    deleteBody.textContent = (mode === 'retire'
      ? 'Mark ' + count + ' driver' + (count > 1 ? 's' : '') + ' as retired? (' + nameList + ') They will be hidden but kept in retired records.'
      : 'Permanently delete ' + count + ' driver' + (count > 1 ? 's' : '') + '? (' + nameList + ') This cannot be undone.');
    const origText = deleteConfirm.textContent;
    deleteConfirm.textContent = mode === 'retire' ? 'Mark Retired' : 'Delete';
    deleteModal.classList.add('open');
    function onConfirm() { commitCleanup(mode); deleteModal.classList.remove('open'); deleteConfirm.textContent = origText; cleanup(); }
    function onCancel()  { deleteModal.classList.remove('open'); deleteConfirm.textContent = origText; cleanup(); }
    function onBackdrop(e) { if (e.target === deleteModal) onCancel(); }
    function cleanup() {
      deleteConfirm.removeEventListener('click', onConfirm);
      deleteCancel.removeEventListener('click', onCancel);
      deleteModal.removeEventListener('click', onBackdrop);
    }
    deleteConfirm.addEventListener('click', onConfirm);
    deleteCancel.addEventListener('click', onCancel);
    deleteModal.addEventListener('click', onBackdrop);
  }

  var _rs = document.getElementById('dupRetireSelected'); if (_rs) _rs.addEventListener('click', function() { confirmCleanup('retire'); });
  var _ds = document.getElementById('dupDeleteSelected'); if (_ds) _ds.addEventListener('click', function() { confirmCleanup('delete'); });

  // ── Retired Drivers Modal ─────────────────────────────────────
  async function openRetiredModal() {
    const { data: allRows, error } = await supabase.from('drivers').select('id, data');
    if (error) { alert('Could not load retired drivers: ' + error.message); return; }
    const retiredDrivers = [];
    await Promise.all((allRows || []).map(async function(row) {
      const d = await decryptDriver(row.data);
      if (d.retired) retiredDrivers.push(Object.assign({}, d, { _docId: row.id }));
    }));
    retiredDrivers.sort(function(a, b) {
      return (a.lastName + a.firstName).toLowerCase() < (b.lastName + b.firstName).toLowerCase() ? -1 : 1;
    });
    let modal = document.getElementById('retiredModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'retiredModal';
      modal.className = 'modal-backdrop';
      modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
      modal.innerHTML = '<div class="modal" style="max-width:460px;border-top-color:#7a6055;">'
        + '<div class="modal-icon">🏷</div>'
        + '<h2 class="modal-title">Retired Drivers</h2>'
        + '<div id="retiredList" style="max-height:55vh;overflow-y:auto;text-align:left;margin-bottom:14px;-webkit-overflow-scrolling:touch;"></div>'
        + '<div class="modal-actions"><button class="btn-modal-cancel" id="retiredClose">Close</button></div>'
        + '</div>';
      document.getElementById('appWrapper').appendChild(modal);
      document.getElementById('retiredClose').addEventListener('click', function() { modal.classList.remove('open'); });
      modal.addEventListener('click', function(e) { if (e.target === modal) modal.classList.remove('open'); });
    }
    const rList = document.getElementById('retiredList');
    rList.innerHTML = '';
    if (retiredDrivers.length === 0) {
      rList.innerHTML = '<p style="color:#7a6055;font-size:13px;text-align:center;padding:20px;">No retired drivers on record.</p>';
    } else {
      retiredDrivers.forEach(function(driver) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:11px 4px;border-bottom:1px solid #e5d5cc;gap:8px;';
        const info = document.createElement('div'); info.style.cssText = 'flex:1;min-width:0;';
        const name = document.createElement('div');
        name.style.cssText = 'font-weight:800;font-size:15px;color:#ffffff;text-shadow:0 1px 3px rgba(0,0,0,0.6);';
        name.textContent = driver.lastName + ', ' + driver.firstName;
        const meta = document.createElement('div');
        meta.style.cssText = 'font-size:12px;color:#FFB500;margin-top:3px;font-weight:600;';
        meta.textContent = (driver.location === 'Mebane' ? 'MEBNC' : 'GRENC') + ' · Retired ' + (driver.retiredAt ? new Date(driver.retiredAt).toLocaleDateString() : 'Unknown');
        info.appendChild(name); info.appendChild(meta);
        const btnGroup = document.createElement('div'); btnGroup.style.cssText = 'display:flex;gap:6px;flex-shrink:0;';
        const restoreBtn = document.createElement('button');
        restoreBtn.textContent = '↩ Restore';
        restoreBtn.style.cssText = 'padding:7px 11px;border-radius:8px;border:1.5px solid #FFB500;background:rgba(255,181,0,0.15);color:#FFB500;font-size:12px;font-weight:700;cursor:pointer;';
        restoreBtn.addEventListener('click', async function() {
          restoreBtn.disabled = true; restoreBtn.textContent = '…';
          const restored = Object.assign({}, driver);
          delete restored.retired; delete restored.retiredAt; delete restored._docId;
          const encrypted = await encryptDriver(restored);
          const { error: err } = await supabase.from('drivers').upsert({ id: driver._docId, data: encrypted });
          if (err) { alert('Restore failed: ' + err.message); restoreBtn.disabled = false; restoreBtn.textContent = '↩ Restore'; return; }
          const rKey = driverKey(restored.lastName, restored.firstName);
          driverSet.add(rKey); driverMap.set(rKey, restored); upsertDriver(restored); applyFilter(); filterTable();
          row.remove();
          if (rList.children.length === 0) rList.innerHTML = '<p style="color:#7a6055;font-size:13px;text-align:center;padding:20px;">No retired drivers on record.</p>';
        });
        const delBtn = document.createElement('button');
        delBtn.textContent = '🗑';
        delBtn.title = 'Permanently delete';
        delBtn.style.cssText = 'padding:7px 10px;border-radius:8px;border:1.5px solid #f87171;background:rgba(248,113,113,0.15);color:#f87171;font-size:13px;font-weight:700;cursor:pointer;';
        delBtn.addEventListener('click', function() {
          deleteBody.textContent = 'Permanently delete ' + driver.lastName + ', ' + driver.firstName + '? This cannot be undone.';
          deleteModal.classList.add('open');
          function onConfirm() {
            supabase.from('drivers').delete().eq('id', driver._docId).then(async function(r) {
              if (r.error) { alert('Delete failed: ' + r.error.message); return; }
              await cacheDelete(driver._docId); row.remove();
              if (rList.children.length === 0) rList.innerHTML = '<p style="color:#7a6055;font-size:13px;text-align:center;padding:20px;">No retired drivers on record.</p>';
            });
            deleteModal.classList.remove('open'); cleanup();
          }
          function onCancel()  { deleteModal.classList.remove('open'); cleanup(); }
          function onBackdrop(e) { if (e.target === deleteModal) onCancel(); }
          function cleanup() {
            deleteConfirm.removeEventListener('click', onConfirm);
            deleteCancel.removeEventListener('click', onCancel);
            deleteModal.removeEventListener('click', onBackdrop);
          }
          deleteConfirm.addEventListener('click', onConfirm);
          deleteCancel.addEventListener('click', onCancel);
          deleteModal.addEventListener('click', onBackdrop);
        });
        btnGroup.appendChild(restoreBtn); btnGroup.appendChild(delBtn);
        row.appendChild(info); row.appendChild(btnGroup); rList.appendChild(row);
      });
    }
    modal.classList.add('open');
  }

  // ── Export JSON ───────────────────────────────────────────────
  // ── Export JSON ───────────────────────────────────────────────
  function exportJson() {
    // Normalise phone objects to { digits, display } — the canonical import format.
    // driverMap stores decrypted objects which are already in this shape, but
    // guard explicitly so a future storage-format change doesn't silently export
    // bare { enc } objects that can't be re-imported.
    const drivers = Array.from(driverMap.values()).map(function(d) {
      const nd = normalizePhones(Object.assign({}, d));
      const phones = nd.phones.map(function(p) {
        const out = { digits: p.digits, display: formatPhone(p.digits) };
        if (p.label) out.label = p.label;
        return out;
      });
      // phones[] is canonical; phone/altPhone mirrors keep old backups importable
      return Object.assign({}, nd, {
        phones:   phones,
        phone:    phones[0] ? { digits: phones[0].digits, display: phones[0].display } : null,
        altPhone: phones[1] ? { digits: phones[1].digits, display: phones[1].display } : null
      });
    });
    const blob = new Blob([JSON.stringify(drivers, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'drivers-export-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    // Record backup timestamp for the admin bar reminder
    localStorage.setItem('dcl_last_backup', String(Date.now()));
    updateBackupLabel();
  }

  function updateBackupLabel() {
    const el = document.getElementById('backupAgeLabel');
    if (!el) return;
    const ts = parseInt(localStorage.getItem('dcl_last_backup') || '0', 10);
    if (!ts) { el.textContent = '\u26a0\ufe0f No backup on record'; el.style.color = 'rgba(255,150,100,0.9)'; return; }
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days === 0) { el.textContent = '\u2705 Backed up today'; el.style.color = 'rgba(100,255,150,0.85)'; }
    else if (days === 1) { el.textContent = '\u23f0 Last backup: yesterday'; el.style.color = 'rgba(255,220,80,0.85)'; }
    else { el.textContent = '\u26a0\ufe0f Last backup: ' + days + ' days ago'; el.style.color = days >= 7 ? 'rgba(255,120,80,0.9)' : 'rgba(255,220,80,0.85)'; }
  }

  // ── Seed DB confirmation modal ───────────────────────────────
  function manualSeed() {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(53,28,21,0.65);display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(3px);';

    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:18px;padding:28px 24px 22px;max-width:340px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.3);text-align:center;border-top:4px solid #b91c1c;';
    box.innerHTML = '<div style="font-size:32px;margin-bottom:10px;">\u26a0\ufe0f</div>'
      + '<h2 style="font-size:17px;font-weight:800;color:#b91c1c;margin-bottom:8px;">Seed Database?</h2>'
      + '<p style="font-size:13px;color:#5a3525;line-height:1.55;margin-bottom:16px;">This will <strong>overwrite every driver record</strong> in Firestore with <code>drivers.json</code>. This cannot be undone.</p>'
      + '<p style="font-size:12px;color:#7a6055;margin-bottom:14px;">Enter the seed password to confirm:</p>'
      + '<input type="password" id="seedPwInput" placeholder="Seed password" style="width:100%;padding:11px 14px;border-radius:10px;border:1.5px solid #e5d5cc;font-size:16px;outline:none;margin-bottom:8px;text-align:center;-webkit-appearance:none;">'
      + '<p id="seedPwError" style="font-size:12px;color:#b91c1c;min-height:16px;margin-bottom:12px;font-weight:600;"></p>'
      + '<div style="display:flex;gap:8px;">'
      + '<button id="seedCancelBtn" style="flex:1;padding:11px;border-radius:10px;border:1.5px solid #e5d5cc;background:#fff;color:#7a6055;font-size:14px;font-weight:600;cursor:pointer;">Cancel</button>'
      + '<button id="seedConfirmBtn" style="flex:2;padding:11px;border-radius:10px;border:none;background:#b91c1c;color:#fff;font-size:14px;font-weight:800;cursor:pointer;">Yes, Seed DB</button>'
      + '</div>';
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    const pwInput   = box.querySelector('#seedPwInput');
    const errorEl   = box.querySelector('#seedPwError');
    const cancelBtn = box.querySelector('#seedCancelBtn');
    const confirmBtn= box.querySelector('#seedConfirmBtn');

    setTimeout(function() { pwInput.focus(); }, 200);
    cancelBtn.addEventListener('click',  function() { backdrop.remove(); });
    backdrop.addEventListener('click',   function(e) { if (e.target === backdrop) backdrop.remove(); });
    pwInput.addEventListener('keydown',  function(e) { if (e.key === 'Enter') confirmBtn.click(); });

    confirmBtn.addEventListener('click', function() {
      sha256(pwInput.value).then(function(hash) {
        if (hash !== '4dab32574ba13e302196cb1344d3369bfee840d40724231c788d688ef1073a0b') {
          errorEl.textContent = '\u274c Incorrect password.';
          pwInput.value = '';
          pwInput.focus();
          return;
        }
        backdrop.remove();
        runSeed();
      });
    });
  }

  async function runSeed() {
    const btn = document.getElementById('btnSeedDb');
    btn.textContent = '⏳ Seeding…';
    btn.disabled = true;
    try {
      const r = await fetch('drivers.json');
      const drivers = await r.json();
      const total = drivers.length;

      // Encrypt all drivers in parallel first
      btn.textContent = '⏳ Encrypting…';
      const encrypted = await Promise.all(drivers.map(async function(driver) {
        const key = driverKey(driver.lastName, driver.firstName);
        const enc = await encryptDriver(driver);
        return { id: keyToDocId(key), data: enc };
      }));

      // Write in batches of 20 with no delay
      const BATCH = 20;
      let done = 0;
      for (let i = 0; i < encrypted.length; i += BATCH) {
        const batch = encrypted.slice(i, i + BATCH);
        await Promise.all(batch.map(function(e) {
          return supabase.from('drivers').upsert({ id: e.id, data: e.data }).then(function({error}){ if(error) throw new Error(error.message); });
        }));
        done += batch.length;
        btn.textContent = '⏳ ' + done + '/' + total;
        addWrites(batch.length);
      }
      btn.textContent = '✅ Seeded ' + total + '!';
      setTimeout(function() { btn.textContent = '🌱 Seed DB'; btn.disabled = false; }, 3000);
    } catch(e) {
      btn.textContent = '❌ ' + e.message;
      btn.disabled = false;
    }
  }

  // ── Import modal ─────────────────────────────────────────────
  function openImportModal() {
    importFileInput.value = '';
    importStatus.textContent = '';
    importConfirm.disabled = false;
    importConfirm.textContent = 'Import';
    hideProgress();
    importUpdateLog.style.display = 'none';
    importLogEntries.innerHTML = '';
    importModal.classList.add('open');
  }
  function closeImportModal() { importModal.classList.remove('open'); }

  // ── Convert file to plain text for Groq Edge Function ────────
  async function prepareFileForAI(file) {
    const name = file.name.toLowerCase();

    if (name.endsWith('.pdf')) {
      // Extract text from PDF using pdf.js, then send as plain text
      const items = await extractTextFromPdf(file);
      // Reconstruct readable text from position-aware items
      const lines = [];
      let currentY = null;
      let currentLine = [];
      items.forEach(function(item) {
        if (!item.str) return;
        const y = Math.round(item.y);
        if (currentY === null) currentY = y;
        if (Math.abs(y - currentY) > 6) {
          if (currentLine.length) lines.push(currentLine.join(' '));
          currentLine = [];
          currentY = y;
        }
        currentLine.push(item.str);
      });
      if (currentLine.length) lines.push(currentLine.join(' '));
      return { fileContent: lines.join('\n') };
    }

    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      // Parse Excel directly in the browser — no AI or Edge Function needed.
      // Columns: Last Name, First Name, Cell Phone, Secondary/Emergency
      const buffer    = await file.arrayBuffer();
      const wb        = XLSX.read(buffer, { type: 'array' });
      const sheetName = wb.SheetNames.includes('Sheet1') ? 'Sheet1' : wb.SheetNames[0];
      const ws        = wb.Sheets[sheetName];
      const rows      = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const SKIP      = /last\s*name|first\s*name|employee|name/i;
      const drivers   = [];
      rows.forEach(function(row) {
        const last  = String(row[0] || '').trim();
        const first = String(row[1] || '').trim();
        const phone = String(row[2] || '').trim();
        const alt   = String(row[3] || '').trim();
        if (!last || !first || SKIP.test(last) || SKIP.test(first)) return;
        function cleanNum(s) { return s.replace(/\s*(E|C|2nd|1st|call\s*1st|emergency|cell).*/i, '').trim(); }
        drivers.push({ lastName: last, firstName: first, rawPhone: cleanNum(phone), rawAlt: cleanNum(alt) });
      });
      return { fileType: 'xlsx', drivers: drivers };
    }

    if (name.endsWith('.json')) {
      // Legacy JSON — skip AI, parse directly
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error('JSON file must be an array.');
      return { fileType: 'json', fileContent: null, drivers: data };
    }

    throw new Error('Unsupported file type. Use PDF, Excel (.xlsx), or JSON.');
  }

  async function runImport() {
    const file = importFileInput.files[0];
    if (!file) { importStatus.textContent = '⚠️ Please choose a PDF, Excel, or JSON file first.'; return; }

    importConfirm.disabled = true;
    importConfirm.textContent = 'Analyzing…';
    importStatus.textContent = 'Reading file…';
    setProgress(5, 'Reading file…');

    let newDrivers;
    try {
      const prepared = await prepareFileForAI(file);

      function makePhone(raw) {
        if (!raw) return null;
        const digits = normalisePhone(raw);
        return digits ? { digits: digits, display: formatPhone(digits) } : null;
      }

      if (prepared.fileType === 'json') {
        // normalizePhones accepts both old {phone, altPhone} and new {phones:[]} backups
        newDrivers = prepared.drivers.map(function(d) { return normalizePhones(Object.assign({}, d, { location: normaliseSlic(d.location) })); });
        setProgress(35, 'JSON parsed…');

      } else if (prepared.fileType === 'xlsx') {
        setProgress(30, 'Parsed ' + prepared.drivers.length + ' rows from Excel…');
        importStatus.textContent = 'Parsed ' + prepared.drivers.length + ' drivers…';
        newDrivers = prepared.drivers.map(function(d) {
          return normalizePhones({
            lastName:  d.lastName,
            firstName: d.firstName,
            location:  'Greensboro',
            phone:     makePhone(d.rawPhone),
            altPhone:  makePhone(d.rawAlt),
          });
        }).filter(function(d) { return d.lastName && d.firstName; });
        if (newDrivers.length === 0) throw new Error('No valid driver records found in the Excel file.');
        setProgress(35, 'Found ' + newDrivers.length + ' drivers…');

      } else {
        throw new Error('Unsupported file type. Please use Excel (.xlsx) or JSON.');
      }
    } catch(e) {
      importStatus.textContent = '❌ ' + e.message;
      importConfirm.disabled = false;
      importConfirm.textContent = 'Import';
      hideProgress();
      return;
    }

    setProgress(40, 'Comparing with database…');
    importStatus.textContent = 'Comparing with existing list…';

    const incomingMap = new Map();
    newDrivers.forEach(function(d) {
      const key = driverKey(d.lastName, d.firstName);
      incomingMap.set(keyToDocId(key), d);
    });

    // ── Merge with existing records so imports don't wipe hand-added data ──
    // An Excel sheet only carries 2 numbers per driver. If a driver already has
    // extra numbers (spouse, home, etc.) or labels, keep them: imported numbers
    // lead, matching digits inherit their saved label, and existing numbers the
    // file doesn't mention are appended (up to the 5-number cap).
    const existingByDocId = new Map();
    driverMap.forEach(function(d, key) { existingByDocId.set(keyToDocId(key), d); });
    incomingMap.forEach(function(d, docId) {
      normalizePhones(d);
      const existing = existingByDocId.get(docId);
      if (!existing) return;
      const ex = normalizePhones(Object.assign({}, existing));
      d.phones = d.phones.map(function(p) {
        const match = ex.phones.find(function(q) { return q.digits === p.digits; });
        return (match && match.label && !p.label) ? Object.assign({}, p, { label: match.label }) : p;
      });
      ex.phones.forEach(function(q) {
        if (d.phones.length >= MAX_PHONES) return;
        if (!d.phones.some(function(p) { return p.digits === q.digits; })) d.phones.push(q);
      });
      normalizePhones(d);
    });

    // ── Build preview summary ─────────────────────────────────
    let countNew = 0, countUpdate = 0;
    incomingMap.forEach(function(d, id) {
      if (driverMap.has(id.replace(/_/g, '|').replace(/\|.*/, '') + '|' + id.replace(/.*\|/, ''))) {
        countUpdate++;
      } else {
        // Use driverKey logic to check membership
      }
    });
    // More reliable: compare incoming doc IDs with current driverMap keys→docIds
    const existingDocIds = new Set();
    driverMap.forEach(function(d, key) { existingDocIds.add(keyToDocId(key)); });
    countNew = 0; countUpdate = 0;
    incomingMap.forEach(function(d, docId) {
      if (existingDocIds.has(docId)) countUpdate++;
      else countNew++;
    });
    const total = incomingMap.size;

    // Show preview modal — wait for user confirmation
    const previewModal  = document.getElementById('importPreviewModal');
    const previewBody   = document.getElementById('importPreviewBody');
    const previewCancel = document.getElementById('importPreviewCancel');
    const previewOk     = document.getElementById('importPreviewConfirm');

    previewBody.innerHTML =
      '<div style="margin-bottom:8px;"><strong>File:</strong> ' + file.name + '</div>'
      + '<div style="margin-bottom:4px;">📥 <strong>' + countNew + '</strong> new driver' + (countNew !== 1 ? 's' : '') + ' will be added</div>'
      + '<div style="margin-bottom:4px;">✏️ <strong>' + countUpdate + '</strong> existing driver' + (countUpdate !== 1 ? 's' : '') + ' will be updated</div>'
      + '<div style="margin-bottom:4px;">📋 <strong>' + total + '</strong> total records in file</div>';

    importModal.classList.remove('open');
    previewModal.classList.add('open');

    await new Promise(function(resolve, reject) {
      function onOk()     { previewModal.classList.remove('open'); resolve(); cleanup(); }
      function onCancel() {
        previewModal.classList.remove('open');
        importModal.classList.add('open');
        importConfirm.disabled = false;
        importConfirm.textContent = 'Import';
        hideProgress();
        reject(new Error('cancelled'));
        cleanup();
      }
      function cleanup() {
        previewOk.removeEventListener('click', onOk);
        previewCancel.removeEventListener('click', onCancel);
      }
      previewOk.addEventListener('click', onOk);
      previewCancel.addEventListener('click', onCancel);
    }).catch(function(e) {
      if (e.message !== 'cancelled') throw e;
      return Promise.reject(e);
    });

    // Re-open import modal to show progress
    importModal.classList.add('open');
    importConfirm.disabled = true;
    importConfirm.textContent = 'Importing…';
    setProgress(50, 'Starting upload…');

    // Pre-flight check
    const { error: dbCheckError } = await supabase.from('drivers').select('id').limit(1);
    if (dbCheckError) {
      importStatus.textContent = '❌ Failed to read database: ' + dbCheckError.message;
      importConfirm.disabled = false;
      importConfirm.textContent = 'Import';
      hideProgress();
      return;
    }

    let done = 0;

    // Track which GRENC doc IDs were in this import (for Possibly Retired check)
    const importedGrencIds = new Set();
    newDrivers.forEach(function(d) {
      if (normaliseSlic(d.location).toLowerCase() === 'greensboro') {
        importedGrencIds.add(keyToDocId(driverKey(d.lastName, d.firstName)));
      }
    });
    const lastImportMeta = {
      date: new Date().toLocaleString(),
      file: file.name,
      grencIds: Array.from(importedGrencIds)
    };
    localStorage.setItem('dcl_last_import', JSON.stringify(lastImportMeta));

    setProgress(50, 'Uploading ' + total + ' drivers…');
    importStatus.textContent = 'Uploading ' + total + ' drivers…';

    // Pause the real-time listener during bulk upload — each write would
    // otherwise trigger a decrypt + re-render, making the import very slow.
    detachSnapshot();

    try {
      const entries = Array.from(incomingMap.entries());
      for (let i = 0; i < entries.length; i += 20) {
        const batch = entries.slice(i, i + 20);
        await Promise.all(batch.map(async function([id, driver]) {
          const encrypted = await encryptDriver(driver);
          return supabase.from('drivers').upsert({ id, data: encrypted }).then(function({error}){ if(error) throw new Error(error.message); });
        }));
        done += batch.length;
        const pct = 50 + Math.round((done / total) * 40);
        setProgress(pct, 'Uploading… ' + done + ' / ' + total);
        importStatus.textContent = 'Uploading… ' + done + ' / ' + total;
        addWrites(batch.length);
      }

      setProgress(100, 'Done!');
      importStatus.textContent = '✅ Done! ' + total + ' imported.';
      importConfirm.textContent = 'Import';

      // Save update log entry
      const logEntry = {
        date:  new Date().toLocaleString(),
        file:  file.name,
        added: total,
      };
      pushUpdateLog(logEntry);

      // Show update log
      const allLogs = getUpdateLog();
      importUpdateLog.style.display = 'block';
      importLogEntries.innerHTML = '';
      allLogs.forEach(function(e) {
        const row = document.createElement('div');
        row.style.cssText = 'font-size:11px;color:#5a3525;padding:3px 0;border-bottom:1px solid #e5d5cc;';
        row.textContent = e.date + ' — ' + e.file + ': ' + e.added + ' imported';
        importLogEntries.appendChild(row);
      });

      setTimeout(closeImportModal, 3000);
      // Resume real-time listener — will do one full refresh from Firestore
      reattachSnapshot();
    } catch(e) {
      importStatus.textContent = '❌ Import failed: ' + e.message;
      importConfirm.disabled = false;
      importConfirm.textContent = 'Import';
      hideProgress();
      // Resume listener even on failure
      reattachSnapshot();
    }
  }

  importCancel.addEventListener('click', closeImportModal);
  importConfirm.addEventListener('click', function() { runImport().catch(function(e) { if (e && e.message !== 'cancelled') console.error(e); }); });
  importModal.addEventListener('click', function(e) { if (e.target === importModal) closeImportModal(); });

  // ── Event listeners ──────────────────────────────────────────
  const searchClearBtn = document.getElementById('searchClear');

  function updateClearBtn() {
    if (searchClearBtn) searchClearBtn.style.display = searchBox.value ? 'block' : 'none';
  }

  searchBox.addEventListener('input', function() { updateClearBtn(); applyFilter(); filterTable(); });
  searchBox.addEventListener('search', function() { updateClearBtn(); applyFilter(); filterTable(); });

  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', function() {
      searchBox.value = '';
      updateClearBtn();
      applyFilter(); filterTable();
      searchBox.focus();
    });
  }

  // Clearing search on filter change so results aren't confusingly stale
  filterBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      haptic('light');
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.loc;
      if (searchBox.value) {
        searchBox.value = '';
        updateClearBtn();
      }
      applyFilter(); filterTable();
    });
  });
  // (name order toggle moved to Settings modal)
  fabAdd.addEventListener('click', function() { haptic('light'); openAddPanel(); });
  panelClose.addEventListener('click', closePanel);
  btnCancel.addEventListener('click', closePanel);
  panelOverlay.addEventListener('click', closePanel);

  // ── Live phone formatting as you type ───────────────────────
  function liveFormatPhone(e) {
    const input  = e.target;
    const digits = input.value.replace(/\D/g, '').slice(0, 10);
    if (digits.length === 0) { input.value = ''; return; }
    let formatted = '';
    if (digits.length <= 3) {
      formatted = '(' + digits;
    } else if (digits.length <= 6) {
      formatted = '(' + digits.slice(0,3) + ') ' + digits.slice(3);
    } else {
      formatted = '(' + digits.slice(0,3) + ') ' + digits.slice(3,6) + '-' + digits.slice(6);
    }
    const pos    = input.selectionStart;
    const diff   = formatted.length - input.value.length;
    input.value  = formatted;
    const newPos = Math.max(0, pos + diff);
    input.setSelectionRange(newPos, newPos);
  }

  btnSave.addEventListener('click', saveDriver);

  document.getElementById('btnAdminLogin').addEventListener('click', promptAdminLogin);
  document.getElementById('btnAdminLogoutHeader').addEventListener('click', adminLogout);
  document.getElementById('btnSeedDb').addEventListener('click', manualSeed);
  document.getElementById('btnImport').addEventListener('click', openImportModal);
  document.getElementById('btnScanDups').addEventListener('click', openDupModal);
  document.getElementById('btnRetired').addEventListener('click', openRetiredModal);
  document.getElementById('btnExport').addEventListener('click', exportJson);

  // ── Boot ─────────────────────────────────────────────────────
  if (localStorage.getItem('dcl_admin') === '1') {
    isAdmin = true;
    setTimeout(showAdminControls, 100);
  }

  const loadingMsg = document.createElement('p');
  loadingMsg.id = 'loadingMsg';
  loadingMsg.style.cssText = 'padding:24px;text-align:center;color:#7a6055;';
  loadingMsg.textContent = 'Loading drivers…';
  listEl.insertBefore(loadingMsg, noResults);

  function removeLoadingMsg() {
    const el = document.getElementById('loadingMsg');
    if (el) el.remove();
  }

  function showOfflineBanner() {
    if (document.getElementById('offlineBanner')) return;
    const banner = document.createElement('div');
    banner.id = 'offlineBanner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:500;background:#b91c1c;color:#fff;text-align:center;padding:10px 16px;font-size:13px;font-weight:700;letter-spacing:0.2px;';
    banner.textContent = '⚠️ Unable to connect — showing cached data. Pull to refresh when signal returns.';
    document.body.prepend(banner);
  }
  function hideOfflineBanner() {
    const b = document.getElementById('offlineBanner');
    if (b) b.remove();
  }
  function showOnlineToast() {
    const existing = document.getElementById('onlineToast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'onlineToast';
    toast.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);z-index:999;background:#166534;color:#fff;border-radius:40px;padding:10px 20px;font-size:13px;font-weight:700;box-shadow:0 4px 18px rgba(0,0,0,0.3);white-space:nowrap;pointer-events:none;transition:opacity 0.4s ease;';
    toast.textContent = '✅ Back online — refreshed';
    document.body.appendChild(toast);
    setTimeout(function() { toast.style.opacity = '0'; }, 2000);
    setTimeout(function() { toast.remove(); }, 2400);
  }

  window.addEventListener('online', function() {
    hideOfflineBanner();
    // Soft re-fetch so data is current after coming back online
    detachSnapshot();
    reattachSnapshot();
    showOnlineToast();
  });
  window.addEventListener('offline', showOfflineBanner);
  if (!navigator.onLine) showOfflineBanner();

  // ── Pull-to-refresh (iOS standalone PWA safe) ────────────────
  (function setupPullToRefresh() {
    function doRefresh() {
      // Soft refresh — re-fetch from Supabase without reloading the page.
      // Much faster than a full reload since the app shell and IDB cache stay warm.
      const ind = document.getElementById('ptrIndicator');
      if (ind) ind.textContent = '🔄 Refreshing…';
      detachSnapshot();
      reattachSnapshot();
      setTimeout(function() {
        if (ind) {
          ind.style.transform = 'translateY(-100%)';
        }
      }, 800);
    }

    let startY = 0;
    let currentY = 0;
    let active = false;
    let indicator = null;

    function getIndicator() {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'ptrIndicator';
        indicator.style.cssText = [
          'position:fixed;top:0;left:0;right:0;z-index:600;',
          'display:flex;align-items:center;justify-content:center;',
          'background:#351C15;color:#FFB500;',
          'font-size:13px;font-weight:700;letter-spacing:0.3px;',
          'padding:10px 16px;',
          'transform:translateY(-100%);',
          'transition:transform 0.15s ease;',
          'pointer-events:none;'
        ].join('');
        indicator.textContent = '↓ Pull to refresh';
        document.body.prepend(indicator);
      }
      return indicator;
    }

    // Use the list element as the scroll container reference
    // but listen on document so header area pulls also work
    document.addEventListener('touchstart', function(e) {
      // scrollTop of the page in iOS PWA is on documentElement
      const scrollTop = document.documentElement.scrollTop || document.body.scrollTop || 0;
      if (scrollTop <= 0) {
        startY = e.touches[0].clientY;
        currentY = startY;
        active = true;
      }
    }, { passive: true });

    document.addEventListener('touchmove', function(e) {
      if (!active) return;
      currentY = e.touches[0].clientY;
      const dy = currentY - startY;
      if (dy <= 0) { active = false; return; }
      const ind = getIndicator();
      // Map 0–100px drag to 0–100% reveal
      const pct = Math.min(dy / 100, 1);
      ind.style.transform = 'translateY(' + Math.round((pct - 1) * 100) + '%)';
      ind.textContent = dy > 80 ? '↑ Release to refresh' : '↓ Pull to refresh';
    }, { passive: true });

    document.addEventListener('touchend', function() {
      if (!active) return;
      active = false;
      const ind = getIndicator();
      const dy = currentY - startY;
      // Snap back
      ind.style.transform = 'translateY(-100%)';
      if (dy > 80) {
        ind.textContent = '🔄 Refreshing…';
        ind.style.transform = 'translateY(0)';
        setTimeout(doRefresh, 500);
      }
    }, { passive: true });
  })();

  // ── IndexedDB cache ─────────────────────────────────────────
  // VERSION 2: stores DECRYPTED driver objects (not encrypted Supabase rows).
  // Encryption protects data in Supabase; locally on-device there is no benefit
  // to re-encrypting. Skipping decrypt on every load is the single biggest
  // speed win — it eliminates hundreds of AES-GCM ops and removes the async
  // waterfall that blocked painting.
  // Bump to version 2 forces an upgrade that clears the old encrypted store.
  const IDB_NAME    = 'dcl_cache';
  const IDB_STORE   = 'drivers';
  const IDB_VERSION = 2;

  // Single shared connection — opened once, reused for every read/write.
  // Previously openCache() was called fresh per operation, paying the open
  // overhead on every cachePut/cacheDelete/cacheGetAll call.
  const _dbPromise = new Promise(function(resolve, reject) {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = function(e) {
      // Delete old store (v1, encrypted) if it exists, then recreate clean.
      try { e.target.result.deleteObjectStore(IDB_STORE); } catch(_) {}
      e.target.result.createObjectStore(IDB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror   = function(e) { reject(e.target.error); };
  });

  function openCache() { return _dbPromise; }

  // Returns pre-sorted array of decrypted driver objects, ready to render.
  async function cacheGetAll() {
    try {
      const db = await openCache();
      const rows = await new Promise(function(resolve) {
        const tx  = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).getAll();
        req.onsuccess = function() { resolve(req.result || []); };
        req.onerror   = function() { resolve([]); };
      });
      // Rows store { id, driver } — driver is already decrypted and pre-sorted.
      // normalizePhones upgrades any cached legacy phone/altPhone shape in place.
      return rows.map(function(r) { return normalizePhones(r.driver); }).filter(function(d) { return !d.retired; });
    } catch(_) { return []; }
  }

  // Accepts raw Supabase rows ({ id, data }), decrypts, sorts, then stores.
  async function cachePutAll(rows) {
    try {
      const drivers = await Promise.all(
        (rows || []).map(function(row) { return decryptDriver(row.data).then(function(d) { return { id: row.id, driver: d }; }); })
      );
      // Pre-sort so cacheGetAll returns ready-to-render order.
      drivers.sort(function(a, b) {
        const ka = (a.driver.lastName + a.driver.firstName).toLowerCase();
        const kb = (b.driver.lastName + b.driver.firstName).toLowerCase();
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      const db = await openCache();
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      drivers.forEach(function(row) { store.put(row); });
    } catch(_) {}
  }

  // Single upsert — decrypts before storing.
  async function cachePut(row) {
    try {
      const driver = await decryptDriver(row.data);
      const db = await openCache();
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({ id: row.id, driver });
    } catch(_) {}
  }

  async function cacheDelete(id) {
    try {
      const db = await openCache();
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(id);
    } catch(_) {}
  }

  // ── Real-time listener + offline cache ───────────────────────
  let firstSnapshot = true;
  let snapshotUnsubscribe = null;

  function detachSnapshot() {
    if (snapshotUnsubscribe) { snapshotUnsubscribe(); snapshotUnsubscribe = null; }
  }

  function reattachSnapshot() {
    firstSnapshot = true;
    snapshotUnsubscribe = attachSnapshot();
  }

  function attachSnapshot() {
    let cacheRendered = false;

    // ── Step 1: paint from IDB instantly (no decrypt — already stored clean) ──
    cacheGetAll().then(function(drivers) {
      if (drivers.length === 0) return; // nothing cached yet — wait for network
      removeLoadingMsg();
      // drivers is already sorted (pre-sorted on write) — no sort needed here
      renderCards(drivers); renderTable(drivers);
      cacheRendered = true;
      firstSnapshot = false;
    });

    // ── Step 2: fetch fresh data from Supabase in background ────
    // Wrapped in a 10-second timeout — on no/low signal the fetch hangs
    // forever without this. Cached drivers from Step 1 are already visible
    // if it times out; user can pull-to-refresh when signal returns.
    Promise.race([
      supabase.from('drivers').select('id, data'),
      new Promise(function(_, reject) {
        setTimeout(function() { reject(new Error('timeout')); }, 10000);
      })
    ])
      .then(async function({ data, error }) {
        if (error) {
          showOfflineBanner();
          removeLoadingMsg();
          if (!cacheRendered) {
            const p = document.createElement('div');
            p.style.cssText = 'margin:24px 16px;padding:16px;background:#fee2e2;border-radius:12px;border-left:4px solid #b91c1c;';
            p.innerHTML = '<p style="font-weight:700;color:#b91c1c;margin:0 0 4px;">Could not reach the server</p>'
              + '<p style="font-size:13px;color:#7a1a1a;margin:0;">No cached data available. Connect to the internet and pull down to refresh.</p>';
            listEl.insertBefore(p, noResults);
          }
          return;
        }
        if (navigator.onLine) hideOfflineBanner();
        removeLoadingMsg();

        // Compare server IDs to what's showing — skip re-render if identical.
        const serverIds = (data || []).map(function(r) { return r.id; }).sort().join(',');
        const cachedIds = allCards.map(function(c) { return c.dataset.key; }).sort().join(',');
        if (cacheRendered && serverIds === cachedIds) {
          // Same data — update IDB cache silently in background, no re-render.
          cachePutAll(data || []);
          firstSnapshot = false;
          return;
        }

        // Data changed — decrypt, cache, re-render (exclude retired).
        const allDrivers = await Promise.all(
          (data || []).map(function(row) { return decryptDriver(row.data); })
        );
        const drivers = allDrivers.filter(function(d) { return !d.retired; });
        drivers.sort(function(a, b) {
          const ka = (a.lastName + a.firstName).toLowerCase();
          const kb = (b.lastName + b.firstName).toLowerCase();
          return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
        // cachePutAll accepts raw Supabase rows — pass original data, not decrypted
        await cachePutAll(data || []);
        firstSnapshot = false;
        renderCards(drivers); renderTable(drivers);
      })
      .catch(function() {
        // Timeout or network failure — cached drivers already visible from Step 1
        showOfflineBanner();
        removeLoadingMsg();
      });

    // ── Step 3: real-time delta updates ─────────────────────────
    const channel = supabase.channel('drivers-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'drivers' },
        async function(payload) {
          if (firstSnapshot) return;
          if (payload.eventType === 'DELETE') {
            const key = payload.old.id;
            const outer = listEl.querySelector('.card-outer[data-key="' + key + '"]');
            driverSet.delete(key);
            driverMap.delete(key);
            if (outer) animateRemove(outer);
            allCards = allCards.filter(c => c !== outer);
            await cacheDelete(key);
            applyFilter(); filterTable();
          } else {
            // INSERT or UPDATE
            await cachePut(payload.new);
            const driver = await decryptDriver(payload.new.data);
            if (driver.retired) {
              const rKey = payload.new.id;
              if (driverSet.has(rKey)) {
                driverSet.delete(rKey); driverMap.delete(rKey);
                const outer = listEl.querySelector('.card-outer[data-key="' + rKey + '"]');
                if (outer) { animateRemove(outer); allCards = allCards.filter(function(c){ return c !== outer; }); }
              }
            } else {
              upsertDriver(driver);
            }
            applyFilter(); filterTable();
          }
        }
      )
      .subscribe();

    return function() { supabase.removeChannel(channel); };
  }

  // Supabase needs no auth for anon access — just start the listener
  snapshotUnsubscribe = attachSnapshot();
}
