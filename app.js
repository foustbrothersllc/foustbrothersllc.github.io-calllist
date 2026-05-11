/* ============================================================
   UPS Driver Call List — app.js
   ============================================================
   - Full-width swipe-left-to-delete (must slide 100% of card width)
   - Confirmation modal required before delete completes
   - Phone primary + alt shown side-by-side below name
   - Photo capture (camera or gallery) stored as data-URL on driver
   - O(1) Set-based upsert; regex phone normalisation
   - Firebase Firestore backend: changes sync across all devices
   - Password-protected edits; everyone can view
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, collection, doc,
  setDoc, deleteDoc, getDocs, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey:            "AIzaSyDVgCrg8HyEgOLEN0f3A9L4LcqWhOqMX_g",
  authDomain:        "call-list-editer.firebaseapp.com",
  projectId:         "call-list-editer",
  storageBucket:     "call-list-editer.firebasestorage.app",
  messagingSenderId: "321715928634",
  appId:             "1:321715928634:web:758162c068fe8ebaf17f03",
  measurementId:     "G-2T1NB1Y7N5"
};

const firebaseApp = initializeApp(firebaseConfig);
const db          = getFirestore(firebaseApp);
const driversCol  = collection(db, 'drivers');

// ── Admin password — change this to whatever you want ────────
const ADMIN_PASSWORD = 'UPS1907';
let isAdmin = false;

(function () {
  'use strict';

  // ── DOM refs ─────────────────────────────────────────────────
  const listEl         = document.getElementById('cardList');
  const searchBox      = document.getElementById('searchBox');
  const countBar       = document.getElementById('countBar');
  const noResults      = document.getElementById('noResults');
  const filterBtns     = document.querySelectorAll('.filter-btn');
  const fabAdd         = document.getElementById('fabAdd');
  const addPanel       = document.getElementById('addPanel');
  const panelOverlay   = document.getElementById('panelOverlay');
  const panelClose     = document.getElementById('panelCloseBtn');
  const addPanelTitle  = document.getElementById('addPanelTitle');
  const btnCancel      = document.getElementById('btnCancel');
  const btnSave        = document.getElementById('btnSave');
  const panelNote      = document.getElementById('panelNote');
  const photoPreview   = document.getElementById('photoPreview');
  const cameraInput    = document.getElementById('cameraInput');
  const galleryInput   = document.getElementById('galleryInput');
  const inputLastName  = document.getElementById('inputLastName');
  const inputFirstName = document.getElementById('inputFirstName');
  const inputLocation  = document.getElementById('inputLocation');
  const inputPhone     = document.getElementById('inputPhone');
  const inputAltPhone  = document.getElementById('inputAltPhone');
  const deleteModal    = document.getElementById('deleteModal');
  const deleteCancel   = document.getElementById('deleteCancel');
  const deleteConfirm  = document.getElementById('deleteConfirm');
  const deleteBody     = document.getElementById('deleteModalBody');
  const importModal    = document.getElementById('importModal');
  const importCancel   = document.getElementById('importCancel');
  const importConfirm  = document.getElementById('importConfirm');
  const importFileInput= document.getElementById('importFileInput');
  const importStatus   = document.getElementById('importStatus');

  // ── State ────────────────────────────────────────────────────
  let activeFilter        = 'all';
  let allCards            = [];
  const driverSet         = new Set();
  const driverMap         = new Map();
  let editingKey          = null;
  let pendingDeleteKey    = null;
  let currentPhotoDataUrl = null;

  // ── SLIC labels ──────────────────────────────────────────────
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
  function formatPhone(digits) {
    if (!digits || digits.length !== 10) return digits || '';
    return '(' + digits.slice(0,3) + ') ' + digits.slice(3,6) + '-' + digits.slice(6);
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

  // ── Phone button ─────────────────────────────────────────────
  function makePhoneBtn(digits, isPrimary) {
    const a = document.createElement('a');
    a.href = 'tel:+1' + digits;
    a.className = 'phone-btn ' + (isPrimary ? 'primary' : 'alt');
    const icon = document.createElement('span');
    icon.className = 'phone-icon';
    icon.textContent = '📞';
    icon.setAttribute('aria-hidden', 'true');
    const num = document.createElement('span');
    num.className = 'phone-number';
    num.textContent = formatPhone(digits);
    a.appendChild(icon);
    a.appendChild(num);
    if (!isPrimary) {
      const tag = document.createElement('span');
      tag.className = 'alt-tag';
      tag.textContent = 'Alt';
      a.appendChild(tag);
    }
    return a;
  }

  // ── Build card ───────────────────────────────────────────────
  function buildCard(driver) {
    const key = driverKey(driver.lastName, driver.firstName);

    const outer = document.createElement('div');
    outer.className = 'card-outer';
    outer.dataset.key = key;

    const deleteBg = document.createElement('div');
    deleteBg.className = 'card-delete-bg';
    deleteBg.innerHTML = '<span style="font-size:20px">🗑</span><span>DELETE</span>';
    outer.appendChild(deleteBg);

    const card = document.createElement('div');
    card.className = 'card';

    const phonePrimary = driver.phone    ? driver.phone.digits    : '';
    const phoneAlt     = driver.altPhone ? driver.altPhone.digits : '';
    outer.dataset.search   = [driver.lastName, driver.firstName, phonePrimary, phoneAlt, slicLabel(driver.location), driver.location].join(' ').toLowerCase();
    outer.dataset.location = (driver.location || '').toLowerCase();

    // Header: avatar + name + badge
    const header = document.createElement('div');
    header.className = 'card-header';
    if (driver.photo) {
      const img = document.createElement('img');
      img.src = driver.photo;
      img.className = 'card-avatar';
      img.alt = driver.firstName + ' ' + driver.lastName;
      header.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'card-avatar-placeholder';
      ph.textContent = '👤';
      header.appendChild(ph);
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

    // Phone buttons
    if (driver.phone || driver.altPhone) {
      const phones = document.createElement('div');
      phones.className = 'phones';
      if (driver.phone && driver.phone.digits)    phones.appendChild(makePhoneBtn(driver.phone.digits, true));
      if (driver.altPhone && driver.altPhone.digits) phones.appendChild(makePhoneBtn(driver.altPhone.digits, false));
      card.appendChild(phones);
    } else {
      const none = document.createElement('span');
      none.className = 'no-phone';
      none.textContent = 'No phone listed';
      card.appendChild(none);
    }

    // Edit button — admin only
    if (isAdmin) {
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-edit';
      editBtn.textContent = '✏️ Edit';
      editBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        openEditPanel(key);
      });
      actions.appendChild(editBtn);
      card.appendChild(actions);
    }

    outer.appendChild(card);

    // Swipe-to-delete — admin only
    if (isAdmin) attachSwipe(outer, card, key);

    return outer;
  }

  // ── Swipe logic ──────────────────────────────────────────────
  function attachSwipe(outer, card, key) {
    let startX = 0, startY = 0, currentX = 0;
    let swiping = false, locked = false, dirLocked = false;
    const THRESHOLD = 0.85;

    function onStart(e) {
      if (locked) return;
      const touch = e.touches ? e.touches[0] : e;
      startX = touch.clientX; startY = touch.clientY;
      currentX = 0; swiping = true; dirLocked = false;
      card.style.transition = 'none';
    }
    function onMove(e) {
      if (!swiping || locked) return;
      const touch = e.touches ? e.touches[0] : e;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (!dirLocked && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
        dirLocked = true;
        if (Math.abs(dy) > Math.abs(dx)) { swiping = false; return; }
      }
      if (!dirLocked) return;
      currentX = Math.min(0, dx);
      card.style.transform = 'translateX(' + currentX + 'px)';
      if (e.cancelable) e.preventDefault();
    }
    function onEnd() {
      if (!swiping || locked) return;
      swiping = false;
      const cardWidth = card.offsetWidth;
      if (Math.abs(currentX) >= cardWidth * THRESHOLD) {
        card.style.transition = 'transform 0.22s ease-in';
        card.style.transform  = 'translateX(-' + cardWidth + 'px)';
        locked = true;
        setTimeout(function () { openDeleteModal(key, outer, card); }, 220);
      } else {
        card.style.transition = 'transform 0.25s cubic-bezier(0.34,1.56,0.64,1)';
        card.style.transform  = 'translateX(0)';
      }
    }

    card.addEventListener('touchstart', onStart, { passive: true });
    card.addEventListener('touchmove',  onMove,  { passive: false });
    card.addEventListener('touchend',   onEnd,   { passive: true });
    card.addEventListener('mousedown', function(e) {
      onStart(e);
      function mm(ev) { onMove(ev); }
      function mu()   { onEnd(); document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); }
      document.addEventListener('mousemove', mm);
      document.addEventListener('mouseup',   mu);
    });
  }

  // ── Delete modal ─────────────────────────────────────────────
  function openDeleteModal(key, outer, card) {
    const driver = driverMap.get(key);
    if (!driver) return;
    pendingDeleteKey = key;
    deleteBody.textContent = 'Remove ' + driver.lastName + ', ' + driver.firstName + ' from the list? This cannot be undone.';
    deleteModal.classList.add('open');

    function onCancel() {
      card.style.transition = 'transform 0.3s cubic-bezier(0.34,1.56,0.64,1)';
      card.style.transform  = 'translateX(0)';
      const newOuter = buildCard(driver);
      outer.replaceWith(newOuter);
      const idx = allCards.indexOf(outer);
      if (idx !== -1) allCards[idx] = newOuter;
      pendingDeleteKey = null;
      deleteModal.classList.remove('open');
      cleanup();
    }
    function onConfirm() {
      deleteDriver(key, outer);
      pendingDeleteKey = null;
      deleteModal.classList.remove('open');
      cleanup();
    }
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

  // ── Delete driver ────────────────────────────────────────────
  function deleteDriver(key, outer) {
    driverSet.delete(key);
    driverMap.delete(key);
    const el = outer || listEl.querySelector('[data-key="' + key + '"]');
    if (el) {
      el.style.transition = 'max-height 0.3s ease, opacity 0.3s ease, margin 0.3s ease';
      el.style.maxHeight  = el.offsetHeight + 'px';
      el.style.overflow   = 'hidden';
      requestAnimationFrame(function() {
        el.style.maxHeight    = '0';
        el.style.opacity      = '0';
        el.style.marginBottom = '0';
      });
      setTimeout(function() { el.remove(); }, 310);
      allCards = allCards.filter(function(c) { return c !== el; });
    }
    deleteDoc(doc(db, 'drivers', keyToDocId(key))).catch(console.error);
    applyFilter();
  }

  // ── Render all cards ─────────────────────────────────────────
  function renderCards(drivers) {
    allCards.forEach(function(c) { c.remove(); });
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

    setDoc(doc(db, 'drivers', keyToDocId(key)), driver).catch(console.error);
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

  // ── Photo input ──────────────────────────────────────────────
  function handlePhotoFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
      currentPhotoDataUrl = e.target.result;
      photoPreview.innerHTML = '';
      const img = document.createElement('img');
      img.src = currentPhotoDataUrl;
      photoPreview.appendChild(img);
    };
    reader.readAsDataURL(file);
  }
  cameraInput.addEventListener('change', function() { handlePhotoFile(this.files[0]); });
  galleryInput.addEventListener('change', function() { handlePhotoFile(this.files[0]); });

  // ── Panel helpers ────────────────────────────────────────────
  function resetPhotoPreview() {
    currentPhotoDataUrl = null;
    photoPreview.innerHTML = '<span class="photo-placeholder">👤</span>';
  }
  function openAddPanel() {
    editingKey = null;
    addPanelTitle.textContent = 'Add Driver';
    btnSave.textContent = 'Save Driver';
    inputLastName.value = ''; inputFirstName.value = '';
    inputLocation.value = 'Greensboro';
    inputPhone.value = ''; inputAltPhone.value = '';
    panelNote.textContent = '';
    resetPhotoPreview();
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
    if (driver.photo) {
      currentPhotoDataUrl = driver.photo;
      photoPreview.innerHTML = '';
      const img = document.createElement('img');
      img.src = driver.photo;
      photoPreview.appendChild(img);
    } else {
      resetPhotoPreview();
    }
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
  function saveDriver() {
    const lastName  = inputLastName.value.trim();
    const firstName = inputFirstName.value.trim();
    if (!lastName || !firstName) {
      panelNote.textContent = '⚠️ First and last name are required.';
      return;
    }
    const rawPhone       = inputPhone.value.trim();
    const rawAltPhone    = inputAltPhone.value.trim();
    const phoneDigits    = normalisePhone(rawPhone);
    const altPhoneDigits = normalisePhone(rawAltPhone);
    if (rawPhone && !phoneDigits) {
      panelNote.textContent = '⚠️ Primary phone needs at least 10 digits.'; return;
    }
    if (rawAltPhone && !altPhoneDigits) {
      panelNote.textContent = '⚠️ Alt phone needs at least 10 digits.'; return;
    }

    const newKey = driverKey(lastName, firstName);
    const isNew  = !driverSet.has(newKey);

    if (editingKey && editingKey !== newKey) {
      const oldOuter = listEl.querySelector('.card-outer[data-key="' + editingKey + '"]');
      driverSet.delete(editingKey);
      driverMap.delete(editingKey);
      deleteDoc(doc(db, 'drivers', keyToDocId(editingKey))).catch(console.error);
      if (oldOuter) {
        allCards = allCards.filter(function(c) { return c !== oldOuter; });
        oldOuter.remove();
      }
    }

    const driver = {
      lastName,
      firstName,
      location: inputLocation.value,
      phone:    phoneDigits    ? { digits: phoneDigits,    display: formatPhone(phoneDigits) }    : null,
      altPhone: altPhoneDigits ? { digits: altPhoneDigits, display: formatPhone(altPhoneDigits) } : null,
      photo:    currentPhotoDataUrl || (editingKey ? (driverMap.get(editingKey) || {}).photo : null) || null,
    };

    upsertDriver(driver);
    panelNote.textContent = isNew ? '✅ Driver added.' : '✅ Driver updated.';
    setTimeout(closePanel, 600);
  }

  // ── Admin login ───────────────────────────────────────────────
  // Trigger: hold down the driver count bar for 1.5 seconds
  function showAdminControls() {
    fabAdd.style.display = 'flex';
    document.getElementById('adminBar').style.display = 'flex';
    document.getElementById('btnAdminLogin').style.display = 'none';
  }

  function hideAdminControls() {
    fabAdd.style.display = 'none';
    document.getElementById('adminBar').style.display = 'none';
    document.getElementById('btnAdminLogin').style.display = 'block';
  }

  async function manualSeed() {
    const btn = document.getElementById('btnSeedDb');
    btn.textContent = '⏳ Seeding…';
    btn.disabled = true;
    try {
      const r = await fetch('drivers.json');
      const drivers = await r.json();
      let done = 0;
      const total = drivers.length;
      const BATCH = 10; // smaller batches to avoid rate limiting
      for (let i = 0; i < drivers.length; i += BATCH) {
        const batch = drivers.slice(i, i + BATCH);
        await Promise.all(batch.map(function(driver) {
          const key = driverKey(driver.lastName, driver.firstName);
          return setDoc(doc(db, 'drivers', keyToDocId(key)), driver);
        }));
        done += batch.length;
        btn.textContent = '⏳ Seeding… ' + done + '/' + total;
        // Small pause between batches to avoid Firestore rate limits
        await new Promise(function(res) { setTimeout(res, 300); });
      }
      btn.textContent = '✅ Seeded ' + total + ' drivers!';
      setTimeout(function() {
        btn.textContent = '🌱 Seed DB';
        btn.disabled = false;
      }, 3000);
    } catch(e) {
      btn.textContent = '❌ Failed: ' + e.message;
      btn.disabled = false;
      console.error(e);
    }
  }

  function promptAdminLogin() {
    const pw = prompt('Enter admin password:');
    if (pw === ADMIN_PASSWORD) {
      isAdmin = true;
      localStorage.setItem('ups_admin', '1');
      showAdminControls();
      const drivers = Array.from(driverMap.values());
      renderCards(drivers);
    } else if (pw !== null) {
      alert('❌ Incorrect password.');
    }
  }

  // ── Import modal ─────────────────────────────────────────────
  function openImportModal() {
    importFileInput.value = '';
    importStatus.textContent = '';
    importConfirm.disabled = false;
    importConfirm.textContent = 'Import';
    importModal.classList.add('open');
  }

  function closeImportModal() {
    importModal.classList.remove('open');
  }

  async function runImport() {
    const file = importFileInput.files[0];
    if (!file) {
      importStatus.textContent = '⚠️ Please choose a JSON file first.';
      return;
    }

    importConfirm.disabled = true;
    importConfirm.textContent = 'Importing…';
    importStatus.textContent = 'Reading file…';

    let newDrivers;
    try {
      const text = await file.text();
      newDrivers = JSON.parse(text);
      if (!Array.isArray(newDrivers)) throw new Error('File must be a JSON array.');
    } catch (e) {
      importStatus.textContent = '❌ Invalid JSON: ' + e.message;
      importConfirm.disabled = false;
      importConfirm.textContent = 'Import';
      return;
    }

    // Build map of incoming drivers
    const incomingMap = new Map();
    newDrivers.forEach(function(d) {
      const key = driverKey(d.lastName, d.firstName);
      incomingMap.set(keyToDocId(key), d);
    });

    // Get current Firestore docs
    importStatus.textContent = 'Comparing with existing list…';
    let snapshot;
    try {
      snapshot = await getDocs(driversCol);
    } catch(e) {
      importStatus.textContent = '❌ Failed to read database: ' + e.message;
      importConfirm.disabled = false;
      importConfirm.textContent = 'Import';
      return;
    }

    const toDelete = [];
    snapshot.forEach(function(d) {
      if (!incomingMap.has(d.id)) toDelete.push(d.id);
    });

    const total   = incomingMap.size;
    const removed = toDelete.length;
    let done = 0;

    importStatus.textContent = 'Uploading ' + total + ' drivers…';

    try {
      // Upsert all incoming drivers in batches of 20
      const entries = Array.from(incomingMap.entries());
      for (let i = 0; i < entries.length; i += 20) {
        const batch = entries.slice(i, i + 20);
        await Promise.all(batch.map(function([id, driver]) {
          return setDoc(doc(db, 'drivers', id), driver);
        }));
        done += batch.length;
        importStatus.textContent = 'Uploading… ' + done + ' / ' + total;
      }

      // Delete drivers no longer in the list
      if (toDelete.length > 0) {
        importStatus.textContent = 'Removing ' + removed + ' old drivers…';
        await Promise.all(toDelete.map(function(id) {
          return deleteDoc(doc(db, 'drivers', id));
        }));
      }

      importStatus.textContent = '✅ Done! ' + total + ' drivers imported, ' + removed + ' removed.';
      importConfirm.textContent = 'Import';
      setTimeout(closeImportModal, 2000);
    } catch(e) {
      importStatus.textContent = '❌ Import failed: ' + e.message;
      importConfirm.disabled = false;
      importConfirm.textContent = 'Import';
    }
  }

  importCancel.addEventListener('click', closeImportModal);
  importConfirm.addEventListener('click', runImport);
  importModal.addEventListener('click', function(e) {
    if (e.target === importModal) closeImportModal();
  });

  function adminLogout() {
    isAdmin = false;
    localStorage.removeItem('ups_admin');
    hideAdminControls();
    const drivers = Array.from(driverMap.values());
    renderCards(drivers);
  }

  document.getElementById('btnAdminLogin').addEventListener('click', promptAdminLogin);
  document.getElementById('btnAdminLogout').addEventListener('click', adminLogout);
  document.getElementById('btnSeedDb').addEventListener('click', manualSeed);
  document.getElementById('btnImport').addEventListener('click', openImportModal);

  // ── Event listeners ──────────────────────────────────────────
  searchBox.addEventListener('input',  applyFilter);
  searchBox.addEventListener('search', applyFilter);
  filterBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      filterBtns.forEach(function(b) { b.classList.remove('active'); });
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

  // ── Boot ─────────────────────────────────────────────────────
  // Restore admin session
  if (localStorage.getItem('ups_admin') === '1') isAdmin = true;

  // Non-admins don't see the FAB
  if (!isAdmin) {
    fabAdd.style.display = 'none';
  } else {
    // Restore import button for returning admins (after cards render)
    setTimeout(showAdminControls, 100);
  }

  // Loading indicator
  const loadingMsg = document.createElement('p');
  loadingMsg.id = 'loadingMsg';
  loadingMsg.style.cssText = 'padding:24px;text-align:center;color:#7a6055;';
  loadingMsg.textContent = 'Loading drivers…';
  listEl.insertBefore(loadingMsg, noResults);

  function removeLoadingMsg() {
    const el = document.getElementById('loadingMsg');
    if (el) el.remove();
  }

  // If Firestore is empty, seed it from drivers.json first
  getDocs(driversCol).then(function(snapshot) {
    removeLoadingMsg();
    if (snapshot.empty) {
      return fetch('drivers.json')
        .then(function(r) { return r.json(); })
        .then(function(drivers) {
          return Promise.all(drivers.map(function(driver) {
            const key = driverKey(driver.lastName, driver.firstName);
            return setDoc(doc(db, 'drivers', keyToDocId(key)), driver);
          }));
        })
        .then(startRealtimeListener);
    } else {
      startRealtimeListener();
    }
  }).catch(function(err) {
    removeLoadingMsg();
    const p = document.createElement('p');
    p.style.cssText = 'padding:24px;color:#b91c1c;';
    p.textContent = 'Error connecting to database: ' + err.message;
    listEl.insertBefore(p, noResults);
    console.error(err);
  });

  function startRealtimeListener() {
    onSnapshot(driversCol, function(snapshot) {
      const drivers = [];
      snapshot.forEach(function(d) { drivers.push(d.data()); });
      drivers.sort(function(a, b) {
        const ka = (a.lastName + a.firstName).toLowerCase();
        const kb = (b.lastName + b.firstName).toLowerCase();
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      renderCards(drivers);
    }, console.error);
  }

})();
