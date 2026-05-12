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

import { initializeApp }       from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, doc,
  setDoc, deleteDoc, getDocs,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Firebase config ──────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyCVclqKPtCl-xu38NXY9mLNHClxRmnd1vE",
  authDomain:        "driver-manger.firebaseapp.com",
  projectId:         "driver-manger",
  storageBucket:     "driver-manger.firebasestorage.app",
  messagingSenderId: "734246658670",
  appId:             "1:734246658670:web:26b646a6c0eb35ec2efc7f",
  measurementId:     "G-JGYDLKDMC8"
};

const firebaseApp  = initializeApp(firebaseConfig);
const auth         = getAuth(firebaseApp);
// persistentLocalCache stores all Firestore docs on-device (IndexedDB).
// getDocs() will serve cached data immediately when offline.
const db           = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
const driversCol   = collection(db, 'drivers');

// ── Access & Admin keys ──────────────────────────────────────
// ⚠️  SECURITY: Keep this GitHub repo PRIVATE — these keys are visible in source.
// Firebase API keys are safe in client code provided Firestore security rules are locked down.
// Access/admin passwords should never be in a public repo.
const ACCESS_KEY    = 'UPSFeederDriver';
const ADMIN_PASSWORD = 'UPSFounded1907';

// ── AES-256-GCM encryption helpers ──────────────────────────
// Key is derived from a fixed passphrase using PBKDF2.
// Phone digits are encrypted before writing to Firestore.
const ENC_PASSPHRASE = 'driverlist-UPSFeederDriver-2024';
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

// Prepare driver for Firestore (encrypt phones)
async function encryptDriver(driver) {
  const d = { ...driver };
  d.phone    = await encryptPhoneObj(driver.phone);
  d.altPhone = await encryptPhoneObj(driver.altPhone);
  return d;
}

// Restore driver from Firestore (decrypt phones)
async function decryptDriver(raw) {
  const d = { ...raw };
  d.phone    = await decryptPhoneObj(raw.phone);
  d.altPhone = await decryptPhoneObj(raw.altPhone);
  return d;
}

// ── isAdmin must be declared before the gate IIFE calls initApp ──
let isAdmin = false;

// ── Access gate ──────────────────────────────────────────────
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
    if (keyInput.value === ACCESS_KEY) {
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
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
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
})();

// ── Main App ─────────────────────────────────────────────────

function initApp() {
  'use strict';

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
  const inputPhone      = document.getElementById('inputPhone');
  const inputAltPhone   = document.getElementById('inputAltPhone');
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

  // ── Phone action sheet (tap on primary number) ──────────────
  function showPhoneActionSheet(digits) {
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

  // ── Phone group: plain text for primary, call-only for alt ──
  function makePhoneGroup(digits, isPrimary) {
    const wrap = document.createElement('div');
    wrap.className = 'phone-group';

    if (isPrimary) {
      // Tappable plain number — opens action sheet
      const numBtn = document.createElement('button');
      numBtn.className = 'phone-btn phone-plain-primary';
      numBtn.innerHTML = '<span class="phone-icon" aria-hidden="true">📞</span>'
        + '<span class="phone-number">' + formatPhone(digits) + '</span>';
      numBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        showPhoneActionSheet(digits);
      });
      wrap.appendChild(numBtn);
    } else {
      // Alt: direct call link, no text button
      const callA = document.createElement('a');
      callA.href = 'tel:+1' + digits;
      callA.className = 'phone-btn call-alt';
      callA.innerHTML = '<span class="phone-icon" aria-hidden="true">📞</span>'
        + '<span class="phone-number">' + formatPhone(digits) + '</span>'
        + '<span class="alt-tag">Alt</span>';
      wrap.appendChild(callA);
    }
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

    const phonePrimary = driver.phone    ? driver.phone.digits    : '';
    const phoneAlt     = driver.altPhone ? driver.altPhone.digits : '';
    outer.dataset.search   = [driver.lastName, driver.firstName, phonePrimary, phoneAlt].join(' ').toLowerCase();
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
    nameEl.textContent = driver.lastName + ', ' + driver.firstName;
    nameBlock.appendChild(nameEl);
    header.appendChild(nameBlock);

    const badge = makeBadge(driver.location);
    if (badge) header.appendChild(badge);
    card.appendChild(header);

    // Phone buttons: Call + Text for each number
    if (driver.phone || driver.altPhone) {
      const phones = document.createElement('div');
      phones.className = 'phones';
      if (driver.phone && driver.phone.digits)         phones.appendChild(makePhoneGroup(driver.phone.digits, true));
      if (driver.altPhone && driver.altPhone.digits)   phones.appendChild(makePhoneGroup(driver.altPhone.digits, false));
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
        deleteDoc(doc(db, 'drivers', keyToDocId(key))).catch(console.error);
      });
      selectedKeys.clear();
      updateBulkBar();
      applyFilter();
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

  // ── Initiate delete (after long press) ───────────────────────
  function initiateDelete(key, outer) {
    const driver = driverMap.get(key);
    if (!driver) return;
    pendingDeleteKey = key;
    deleteBody.textContent = 'Delete ' + driver.lastName + ', ' + driver.firstName + '? This cannot be undone.';
    deleteModal.classList.add('open');

    function onConfirm() {
      driverSet.delete(key);
      driverMap.delete(key);
      if (outer) animateRemove(outer);
      deleteDoc(doc(db, 'drivers', keyToDocId(key))).catch(console.error);
      applyFilter();
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

  // ── Render all cards ─────────────────────────────────────────
  function renderCards(drivers) {
    allCards.forEach(c => c.remove());
    driverSet.clear();
    driverMap.clear();
    allCards = [];
    const frag = document.createDocumentFragment();
    drivers.forEach(function(driver) {
      registerDriver(driver);
      const outer = buildCard(driver);
      frag.appendChild(outer);
      allCards.push(outer);
    });
    listEl.insertBefore(frag, noResults);
    applyFilter();
  }

  // ── Upsert locally + save to Firestore ───────────────────────
  async function upsertDriver(driver) {
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
      const insertBefore = allCards.find(function(c) {
        const cd = driverMap.get(c.dataset.key);
        if (!cd) return false;
        return (cd.lastName + cd.firstName).toLowerCase() > (driver.lastName + driver.firstName).toLowerCase();
      });
      if (insertBefore) {
        listEl.insertBefore(newOuter, insertBefore);
        allCards.splice(allCards.indexOf(insertBefore), 0, newOuter);
      } else {
        allCards.push(newOuter);
        listEl.insertBefore(newOuter, noResults);
      }
    }

    const encrypted = await encryptDriver(driver);
    await setDoc(doc(db, 'drivers', keyToDocId(key)), encrypted); // throws on failure — caught by saveDriver
    addWrites(1);
    applyFilter();
  }

  // ── Filter / search ──────────────────────────────────────────
  function updateCount(visible) {
    countBar.textContent = 'Showing ' + visible + ' of ' + allCards.length + ' drivers';
  }
  function applyFilter() {
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

  // ── Panel helpers ────────────────────────────────────────────
  function openAddPanel() {
    editingKey = null;
    addPanelTitle.textContent = 'Add Driver';
    btnSave.textContent = 'Save Driver';
    inputLastName.value = ''; inputFirstName.value = '';
    inputLocation.value = 'Greensboro';
    inputPhone.value = ''; inputAltPhone.value = '';
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
    inputLocation.value  = driver.location || 'Greensboro';
    inputPhone.value     = driver.phone    ? formatPhone(driver.phone.digits)    : '';
    inputAltPhone.value  = driver.altPhone ? formatPhone(driver.altPhone.digits) : '';
    panelNote.textContent = '';
    showPanel();
  }
  function showPanel() {
    panelOverlay.classList.add('visible');
    addPanel.classList.add('open');
    setTimeout(function() { inputLastName.focus(); }, 350);
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
    const rawPhone       = inputPhone.value.trim();
    const rawAltPhone    = inputAltPhone.value.trim();
    const phoneDigits    = normalisePhone(rawPhone);
    const altPhoneDigits = normalisePhone(rawAltPhone);
    if (rawPhone && !phoneDigits)    { alert('⚠️ Primary phone needs at least 10 digits.'); panelNote.textContent = '⚠️ Primary phone needs at least 10 digits.'; return; }
    if (rawAltPhone && !altPhoneDigits) { alert('⚠️ Alt phone needs at least 10 digits.'); panelNote.textContent = '⚠️ Alt phone needs at least 10 digits.'; return; }

    const newKey = driverKey(lastName, firstName);
    const isNew  = !driverSet.has(newKey);

    if (editingKey && editingKey !== newKey) {
      const oldOuter = listEl.querySelector('.card-outer[data-key="' + editingKey + '"]');
      driverSet.delete(editingKey);
      driverMap.delete(editingKey);
      deleteDoc(doc(db, 'drivers', keyToDocId(editingKey))).catch(console.error);
      if (oldOuter) {
        allCards = allCards.filter(c => c !== oldOuter);
        oldOuter.remove();
      }
    }

    const driver = {
      lastName,
      firstName,
      location: normaliseSlic(inputLocation.value),
      phone:    phoneDigits    ? { digits: phoneDigits,    display: formatPhone(phoneDigits) }    : null,
      altPhone: altPhoneDigits ? { digits: altPhoneDigits, display: formatPhone(altPhoneDigits) } : null,
      updatedAt: new Date().toLocaleString(),
    };

    try {
      btnSave.disabled = true;
      btnSave.textContent = 'Saving…';
      await upsertDriver(driver);
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
    const pw = prompt('Enter admin password:');
    if (pw === ADMIN_PASSWORD) {
      isAdmin = true;
      localStorage.setItem('dcl_admin', '1');
      showAdminControls();
      renderCards(Array.from(driverMap.values()));
    } else if (pw !== null) {
      alert('❌ Incorrect password.');
    }
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
    renderCards(Array.from(driverMap.values()));
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


  function openDupModal() {
    dupResults.innerHTML = '';
    window.__retiredKeysToDelete = [];

    const meta = JSON.parse(localStorage.getItem('dcl_last_import') || 'null');
    if (!meta) {
      dupResults.innerHTML = '<p style="color:#5a3525;text-align:center;padding:16px;">No import on record yet.<br>Run an import first.</p>';
      dupDeleteAll.style.display = 'none';
      dupModal.classList.add('open');
      return;
    }

    const importedIds = new Set(meta.grencIds || []);
    const possibly = [];
    driverMap.forEach(function(d, key) {
      if ((d.location || '').toLowerCase() !== 'greensboro') return; // skip MEBNC
      const docId = keyToDocId(key);
      if (!importedIds.has(docId)) possibly.push({ key, d });
    });

    if (possibly.length === 0) {
      dupResults.innerHTML = '<p style="color:#166534;text-align:center;padding:16px;">✅ All GRENC drivers were on the last import.</p>';
      dupDeleteAll.style.display = 'none';
    } else {
      dupDeleteAll.style.display = 'block';
      const header = document.createElement('p');
      header.style.cssText = 'font-size:11px;color:#5a3525;margin-bottom:10px;';
      header.textContent = 'Last import: ' + meta.file + ' (' + meta.date + ')';
      dupResults.appendChild(header);

      possibly.forEach(function(item) {
        const d = item.d;
        const key = item.key;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #e5d5cc;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.style.accentColor = '#b91c1c';
        cb.addEventListener('change', function() {
          if (cb.checked) window.__retiredKeysToDelete.push(key);
          else window.__retiredKeysToDelete = window.__retiredKeysToDelete.filter(k => k !== key);
        });
        const label = document.createElement('span');
        const phone = d.phone ? formatPhone(d.phone.digits) : 'no phone';
        label.style.cssText = 'font-size:13px;color:#351C15;';
        label.textContent = d.lastName + ', ' + d.firstName + ' — ' + phone;
        row.appendChild(cb);
        row.appendChild(label);
        dupResults.appendChild(row);
      });
    }
    dupModal.classList.add('open');
  }

  dupClose.addEventListener('click', function() { dupModal.classList.remove('open'); });
  dupDeleteAll.addEventListener('click', function() {
    const keys = window.__retiredKeysToDelete || [];
    if (keys.length === 0) { dupModal.classList.remove('open'); return; }
    keys.forEach(function(key) {
      const outer = listEl.querySelector('.card-outer[data-key="' + key + '"]');
      driverSet.delete(key);
      driverMap.delete(key);
      if (outer) animateRemove(outer);
      deleteDoc(doc(db, 'drivers', keyToDocId(key))).catch(console.error);
    });
    applyFilter();
    dupModal.classList.remove('open');
  });

  // ── Export JSON ───────────────────────────────────────────────
  function exportJson() {
    const drivers = Array.from(driverMap.values());
    const blob = new Blob([JSON.stringify(drivers, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'drivers-export-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Seed DB from drivers.json ────────────────────────────────
  async function manualSeed() {
    const pw = prompt('Enter Seed DB confirmation password:');
    if (pw !== 'GRENC2749') {
      if (pw !== null) alert('❌ Incorrect password. Seed cancelled.');
      return;
    }
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
          return setDoc(doc(db, 'drivers', e.id), e.data);
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

  async function runImport() {
    const file = importFileInput.files[0];
    if (!file) { importStatus.textContent = '⚠️ Please choose a JSON or PDF file first.'; return; }

    importConfirm.disabled = true;
    importConfirm.textContent = 'Importing…';
    importStatus.textContent = 'Reading file…';
    setProgress(5, 'Reading file…');

    let newDrivers;
    try {
      if (file.name.toLowerCase().endsWith('.pdf')) {
        importStatus.textContent = 'Parsing PDF…';
        setProgress(15, 'Extracting text from PDF…');
        const text = await extractTextFromPdf(file);
        setProgress(35, 'Parsing driver records…');
        newDrivers = parsePdfText(text);
        if (newDrivers.length === 0) throw new Error('No driver records found in PDF. Check formatting.');
      } else {
        const text = await file.text();
        newDrivers = JSON.parse(text);
        if (!Array.isArray(newDrivers)) throw new Error('File must be a JSON array.');
        // Normalise SLICs
        newDrivers = newDrivers.map(d => ({ ...d, location: normaliseSlic(d.location) }));
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

    let snapshot;
    try {
      snapshot = await getDocs(driversCol);
    } catch(e) {
      importStatus.textContent = '❌ Failed to read database: ' + e.message;
      importConfirm.disabled = false;
      importConfirm.textContent = 'Import';
      hideProgress();
      return;
    }

    const total = incomingMap.size;
    let done = 0;

    // Track which GRENC doc IDs were in this import (for Possibly Retired check)
    const importedGrencIds = new Set();
    newDrivers.forEach(function(d) {
      if (normaliseSlic(d.location).toLowerCase() === 'greensboro') {
        importedGrencIds.add(keyToDocId(driverKey(d.lastName, d.firstName)));
      }
    });
    // Save to localStorage so Possibly Retired button can use it
    const lastImportMeta = {
      date: new Date().toLocaleString(),
      file: file.name,
      grencIds: Array.from(importedGrencIds)
    };
    localStorage.setItem('dcl_last_import', JSON.stringify(lastImportMeta));

    setProgress(50, 'Uploading ' + total + ' drivers…');
    importStatus.textContent = 'Uploading ' + total + ' drivers…';

    try {
      const entries = Array.from(incomingMap.entries());
      for (let i = 0; i < entries.length; i += 20) {
        const batch = entries.slice(i, i + 20);
        await Promise.all(batch.map(async function([id, driver]) {
          const encrypted = await encryptDriver(driver);
          return setDoc(doc(db, 'drivers', id), encrypted);
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
    } catch(e) {
      importStatus.textContent = '❌ Import failed: ' + e.message;
      importConfirm.disabled = false;
      importConfirm.textContent = 'Import';
      hideProgress();
    }
  }

  importCancel.addEventListener('click', closeImportModal);
  importConfirm.addEventListener('click', runImport);
  importModal.addEventListener('click', function(e) { if (e.target === importModal) closeImportModal(); });

  // ── Event listeners ──────────────────────────────────────────
  searchBox.addEventListener('input',  applyFilter);
  searchBox.addEventListener('search', applyFilter);
  filterBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.loc;
      applyFilter();
    });
  });
  fabAdd.addEventListener('click', openAddPanel);
  panelClose.addEventListener('click', closePanel);
  btnCancel.addEventListener('click', closePanel);
  panelOverlay.addEventListener('click', closePanel);
  btnSave.addEventListener('click', saveDriver);

  document.getElementById('btnAdminLogin').addEventListener('click', promptAdminLogin);
  document.getElementById('btnAdminLogoutHeader').addEventListener('click', adminLogout);
  document.getElementById('btnSeedDb').addEventListener('click', manualSeed);
  document.getElementById('btnImport').addEventListener('click', openImportModal);
  document.getElementById('btnScanDups').addEventListener('click', openDupModal);
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
  window.addEventListener('online',  hideOfflineBanner);
  window.addEventListener('offline', showOfflineBanner);
  if (!navigator.onLine) showOfflineBanner();

  // ── Pull-to-refresh (iOS standalone PWA safe) ────────────────
  (function setupPullToRefresh() {
    const isStandalone = window.navigator.standalone === true
      || window.matchMedia('(display-mode: standalone)').matches;

    function doRefresh() {
      if (isStandalone) {
        window.location.href = window.location.pathname + '?r=' + Date.now();
      } else {
        window.location.reload(true);
      }
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

  signInAnonymously(auth).then(async function(userCredential) {
    const snapshot = await getDocs(driversCol);
    removeLoadingMsg();
    hideOfflineBanner();
    const drivers = [];
    for (const d of snapshot.docs) {
      const decrypted = await decryptDriver(d.data());
      drivers.push(decrypted);
    }
    drivers.sort(function(a, b) {
      const ka = (a.lastName + a.firstName).toLowerCase();
      const kb = (b.lastName + b.firstName).toLowerCase();
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    // If we got data from cache while offline, show the offline banner
    if (!navigator.onLine && drivers.length > 0) showOfflineBanner();
    renderCards(drivers);
  }).catch(async function(err) {
    // signInAnonymously failed — try getDocs anyway (persistent cache may still work)
    try {
      const snapshot = await getDocs(driversCol);
      removeLoadingMsg();
      const drivers = [];
      for (const d of snapshot.docs) {
        const decrypted = await decryptDriver(d.data());
        drivers.push(decrypted);
      }
      drivers.sort(function(a, b) {
        const ka = (a.lastName + a.firstName).toLowerCase();
        const kb = (b.lastName + b.firstName).toLowerCase();
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      if (drivers.length > 0) {
        showOfflineBanner();
        renderCards(drivers);
        return;
      }
    } catch(_) { /* fall through to error display */ }

    removeLoadingMsg();
    showOfflineBanner();
    console.error(err);
    if (allCards.length === 0) {
      const p = document.createElement('div');
      p.style.cssText = 'margin:24px 16px;padding:16px;background:#fee2e2;border-radius:12px;border-left:4px solid #b91c1c;';
      p.innerHTML = '<p style="font-weight:700;color:#b91c1c;margin:0 0 4px;">Could not reach the server</p>'
        + '<p style="font-size:13px;color:#7a1a1a;margin:0;">No cached data available. Connect to the internet and pull down to refresh.</p>';
      listEl.insertBefore(p, noResults);
    }
  });
}
