/* ============================================================
   UPS Driver Call List — app.js
   ============================================================
   Architecture:
   - Master list stored in a JavaScript Set (keyed by "lastName|firstName")
     for O(1) lookup. Add/update never requires a confirmation prompt.
   - Phone numbers are normalised on entry via regex that strips all
     non-digit characters, then keeps the last 10 digits.
   - Deletions require a long-press (≥500 ms) OR tapping the Delete
     button, which opens a confirmation modal before removing.
   - SLIC standardisation: "Greensboro" → "GRENC", "Mebane" → "MEBNC"
     for display; internal data stays as-is for filter matching.
   ============================================================ */

(function () {
  'use strict';

  // ── DOM references ──────────────────────────────────────────
  const listEl       = document.getElementById('cardList');
  const searchBox    = document.getElementById('searchBox');
  const countBar     = document.getElementById('countBar');
  const noResults    = document.getElementById('noResults');
  const filterBtns   = document.querySelectorAll('.filter-btn');
  const fabAdd       = document.getElementById('fabAdd');
  const addPanel     = document.getElementById('addPanel');
  const panelOverlay = document.getElementById('panelOverlay');
  const panelClose   = document.getElementById('panelCloseBtn');
  const addPanelTitle= document.getElementById('addPanelTitle');
  const btnCancel    = document.getElementById('btnCancel');
  const btnSave      = document.getElementById('btnSave');
  const panelNote    = document.getElementById('panelNote');
  const deleteModal  = document.getElementById('deleteModal');
  const deleteCancel = document.getElementById('deleteCancel');
  const deleteConfirm= document.getElementById('deleteConfirm');
  const deleteBody   = document.getElementById('deleteModalBody');

  const inputLastName  = document.getElementById('inputLastName');
  const inputFirstName = document.getElementById('inputFirstName');
  const inputLocation  = document.getElementById('inputLocation');
  const inputPhone     = document.getElementById('inputPhone');
  const inputAltPhone  = document.getElementById('inputAltPhone');

  // ── State ───────────────────────────────────────────────────
  let activeFilter = 'all';
  let allCards     = [];          // rendered card DOM elements
  /**
   * driverSet: Set of composite keys "lastName|firstName" for O(1) lookup.
   * driverMap: Map of key → driver object (the authoritative data store).
   */
  const driverSet  = new Set();
  const driverMap  = new Map();

  let editingKey   = null;        // null = new driver; string = editing existing
  let pendingDeleteKey  = null;   // key of driver awaiting delete confirmation
  let longPressTimer    = null;

  // ── SLIC display normalisation ──────────────────────────────
  const SLIC_DISPLAY = {
    greensboro: 'GRENC',
    mebane:     'MEBNC',
  };

  function slicLabel(location) {
    if (!location) return '';
    return SLIC_DISPLAY[location.toLowerCase()] || location.toUpperCase();
  }

  // ── Phone normalisation ─────────────────────────────────────
  /**
   * Strip every non-digit character, then take the last 10 digits.
   * This handles formats like "(336) 255-8460", "336.255.8460",
   * "3362558460", "+1 (336) 255-8460", etc.
   */
  function normalisePhone(raw) {
    if (!raw) return null;
    const digits = raw.replace(/[^0-9]/g, '');
    return digits.length >= 10 ? digits.slice(-10) : null;
  }

  /**
   * Format 10-digit string as "(NXX) NXX-XXXX".
   */
  function formatPhone(digits) {
    if (!digits || digits.length !== 10) return digits || '';
    return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
  }

  // ── Driver key ──────────────────────────────────────────────
  function driverKey(lastName, firstName) {
    return (lastName + '|' + firstName).toLowerCase();
  }

  // ── tel: href helper ────────────────────────────────────────
  function toTelHref(digits) {
    return 'tel:+1' + digits;
  }

  // ── Badge builder ───────────────────────────────────────────
  function makeBadge(location) {
    if (!location) return null;
    const span = document.createElement('span');
    span.className = 'loc-badge loc-' + location.toLowerCase();
    span.textContent = slicLabel(location);
    return span;
  }

  // ── Phone bubble (primary — inline with name) ───────────────
  function makeNamePhoneBubble(digits) {
    const a = document.createElement('a');
    a.href      = toTelHref(digits);
    a.className = 'name-phone-bubble';

    const icon = document.createElement('span');
    icon.className   = 'phone-icon';
    icon.textContent = '📞';
    icon.setAttribute('aria-hidden', 'true');

    const num = document.createElement('span');
    num.textContent = formatPhone(digits);

    a.appendChild(icon);
    a.appendChild(num);
    return a;
  }

  // ── Alt phone button builder ─────────────────────────────────
  function makeAltPhoneBtn(digits) {
    const a = document.createElement('a');
    a.href      = toTelHref(digits);
    a.className = 'phone-btn';

    const icon = document.createElement('span');
    icon.className   = 'phone-icon';
    icon.textContent = '📞';
    icon.setAttribute('aria-hidden', 'true');

    const num = document.createElement('span');
    num.className   = 'phone-number';
    num.textContent = formatPhone(digits);

    const tag = document.createElement('span');
    tag.className   = 'alt-tag';
    tag.textContent = 'Alt';

    a.appendChild(icon);
    a.appendChild(num);
    a.appendChild(tag);
    return a;
  }

  // ── Build card DOM element ───────────────────────────────────
  function buildCard(driver) {
    const key  = driverKey(driver.lastName, driver.firstName);
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.key      = key;
    card.dataset.location = (driver.location || '').toLowerCase();

    // Search string: covers name, phone digits, location SLIC
    const phonePrimary = driver.phone    ? driver.phone.digits    : '';
    const phoneAlt     = driver.altPhone ? driver.altPhone.digits : '';
    card.dataset.search = [
      driver.lastName,
      driver.firstName,
      phonePrimary,
      phoneAlt,
      slicLabel(driver.location),
      driver.location,
    ].join(' ').toLowerCase();

    // ── Header row: name + primary phone bubble + badge ──
    const header = document.createElement('div');
    header.className = 'card-header';

    const nameEl = document.createElement('span');
    nameEl.className   = 'name';
    nameEl.textContent = driver.lastName + ', ' + driver.firstName;
    header.appendChild(nameEl);

    if (driver.phone && driver.phone.digits) {
      header.appendChild(makeNamePhoneBubble(driver.phone.digits));
    }

    const badge = makeBadge(driver.location);
    if (badge) header.appendChild(badge);

    card.appendChild(header);

    // ── Alt phone (if any) ──
    if (driver.altPhone && driver.altPhone.digits) {
      const phones = document.createElement('div');
      phones.className = 'phones';
      phones.appendChild(makeAltPhoneBtn(driver.altPhone.digits));
      card.appendChild(phones);
    }

    if (!driver.phone && !driver.altPhone) {
      const none = document.createElement('span');
      none.className   = 'no-phone';
      none.textContent = 'No phone listed';
      card.appendChild(none);
    }

    // ── Edit / Delete action row ──
    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const editBtn = document.createElement('button');
    editBtn.className   = 'btn-edit';
    editBtn.textContent = '✏️ Edit';
    editBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openEditPanel(key);
    });

    const delBtn = document.createElement('button');
    delBtn.className   = 'btn-delete';
    delBtn.textContent = '🗑 Delete';

    // Tap: open delete confirmation
    delBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openDeleteModal(key);
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    card.appendChild(actions);

    // ── Long-press on card body (not actions) triggers delete confirm ──
    card.addEventListener('pointerdown', function () {
      longPressTimer = setTimeout(function () {
        openDeleteModal(key);
      }, 500);
    });
    card.addEventListener('pointerup',    cancelLongPress);
    card.addEventListener('pointerleave', cancelLongPress);
    card.addEventListener('pointermove',  cancelLongPress);

    return card;
  }

  function cancelLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  // ── Render all drivers into DOM ──────────────────────────────
  function renderCards(drivers) {
    // Clear existing cards (keep noResults sentinel)
    allCards.forEach(function (c) { c.remove(); });
    allCards = [];

    const fragment = document.createDocumentFragment();
    drivers.forEach(function (driver) {
      registerDriver(driver);          // populate Set + Map
      const card = buildCard(driver);
      fragment.appendChild(card);
      allCards.push(card);
    });
    listEl.insertBefore(fragment, noResults);
    applyFilter();
  }

  // ── Register a driver in the Set/Map ────────────────────────
  function registerDriver(driver) {
    const key = driverKey(driver.lastName, driver.firstName);
    driverSet.add(key);
    driverMap.set(key, driver);
  }

  // ── Add or update a driver (O(1) lookup via Set) ─────────────
  /**
   * If the key already exists in driverSet, update in place (no prompt).
   * If new, append a fresh card.
   */
  function upsertDriver(driver) {
    const key     = driverKey(driver.lastName, driver.firstName);
    const isNew   = !driverSet.has(key);

    registerDriver(driver);

    if (!isNew) {
      // Replace the existing card in-place
      const existingCard = listEl.querySelector('[data-key="' + key + '"]');
      const newCard      = buildCard(driver);
      if (existingCard) {
        listEl.replaceChild(newCard, existingCard);
        const idx = allCards.indexOf(existingCard);
        if (idx !== -1) allCards[idx] = newCard;
      } else {
        allCards.push(newCard);
        listEl.insertBefore(newCard, noResults);
      }
    } else {
      // Insert alphabetically by lastName, firstName
      const newCard = buildCard(driver);
      const insertBefore = allCards.find(function (c) {
        const cDriver = driverMap.get(c.dataset.key);
        if (!cDriver) return false;
        const cName = (cDriver.lastName + cDriver.firstName).toLowerCase();
        const nName = (driver.lastName  + driver.firstName).toLowerCase();
        return cName > nName;
      });
      if (insertBefore) {
        listEl.insertBefore(newCard, insertBefore);
        allCards.splice(allCards.indexOf(insertBefore), 0, newCard);
      } else {
        allCards.push(newCard);
        listEl.insertBefore(newCard, noResults);
      }
    }

    applyFilter();
  }

  // ── Delete a driver ──────────────────────────────────────────
  function deleteDriver(key) {
    if (!driverSet.has(key)) return;
    driverSet.delete(key);
    driverMap.delete(key);

    const card = listEl.querySelector('[data-key="' + key + '"]');
    if (card) {
      card.remove();
      allCards = allCards.filter(function (c) { return c !== card; });
    }
    applyFilter();
  }

  // ── Filter / search ──────────────────────────────────────────
  function updateCount(visible) {
    countBar.textContent =
      'Showing ' + visible + ' of ' + allCards.length + ' drivers';
  }

  function applyFilter() {
    const query   = searchBox.value.toLowerCase().trim();
    let   visible = 0;

    allCards.forEach(function (card) {
      const locMatch  = activeFilter === 'all' ||
                        card.dataset.location === activeFilter;
      const textMatch = !query || card.dataset.search.includes(query);
      const show      = locMatch && textMatch;
      card.style.display = show ? '' : 'none';
      if (show) visible++;
    });

    noResults.style.display = visible === 0 ? 'block' : 'none';
    updateCount(visible);
  }

  // ── Panel: open for Add ──────────────────────────────────────
  function openAddPanel() {
    editingKey = null;
    addPanelTitle.textContent = 'Add Driver';
    btnSave.textContent = 'Save Driver';
    inputLastName.value  = '';
    inputFirstName.value = '';
    inputLocation.value  = 'Greensboro';
    inputPhone.value     = '';
    inputAltPhone.value  = '';
    panelNote.textContent = '';
    showPanel();
  }

  // ── Panel: open for Edit ─────────────────────────────────────
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
    inputLastName.focus();
  }

  function closePanel() {
    addPanel.classList.remove('open');
    panelOverlay.classList.remove('visible');
  }

  // ── Save from panel ──────────────────────────────────────────
  function saveDriver() {
    const lastName  = inputLastName.value.trim();
    const firstName = inputFirstName.value.trim();
    if (!lastName || !firstName) {
      panelNote.textContent = '⚠️ First and last name are required.';
      return;
    }

    const rawPhone    = inputPhone.value.trim();
    const rawAltPhone = inputAltPhone.value.trim();

    const phoneDigits    = normalisePhone(rawPhone);
    const altPhoneDigits = normalisePhone(rawAltPhone);

    if (rawPhone && !phoneDigits) {
      panelNote.textContent = '⚠️ Primary phone must contain at least 10 digits.';
      return;
    }
    if (rawAltPhone && !altPhoneDigits) {
      panelNote.textContent = '⚠️ Alt phone must contain at least 10 digits.';
      return;
    }

    const newKey = driverKey(lastName, firstName);
    // If adding (not editing) and key already exists → update silently (O(1))
    const isNew = !driverSet.has(newKey);
    const isEditSelf = editingKey === newKey;

    const driver = {
      lastName:  lastName,
      firstName: firstName,
      location:  inputLocation.value,
      phone:    phoneDigits    ? { digits: phoneDigits,    display: formatPhone(phoneDigits) }    : null,
      altPhone: altPhoneDigits ? { digits: altPhoneDigits, display: formatPhone(altPhoneDigits) } : null,
    };

    // If editing and the key changed (name changed), remove old entry first
    if (editingKey && editingKey !== newKey) {
      deleteDriver(editingKey);
    }

    upsertDriver(driver);

    panelNote.textContent = isNew
      ? '✅ Driver added.'
      : '✅ Driver updated.';

    setTimeout(closePanel, 600);
  }

  // ── Delete modal ─────────────────────────────────────────────
  function openDeleteModal(key) {
    const driver = driverMap.get(key);
    if (!driver) return;
    pendingDeleteKey = key;
    deleteBody.textContent =
      'Remove ' + driver.lastName + ', ' + driver.firstName +
      ' from the list? This cannot be undone.';
    deleteModal.classList.add('open');

    // Highlight card
    const card = listEl.querySelector('[data-key="' + key + '"]');
    if (card) card.classList.add('deleting');
  }

  function closeDeleteModal() {
    if (pendingDeleteKey) {
      const card = listEl.querySelector('[data-key="' + pendingDeleteKey + '"]');
      if (card) card.classList.remove('deleting');
    }
    pendingDeleteKey = null;
    deleteModal.classList.remove('open');
  }

  // ── Event listeners ──────────────────────────────────────────
  searchBox.addEventListener('input', applyFilter);

  filterBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      filterBtns.forEach(function (b) { b.classList.remove('active'); });
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

  deleteCancel.addEventListener('click', closeDeleteModal);
  deleteConfirm.addEventListener('click', function () {
    if (pendingDeleteKey) {
      deleteDriver(pendingDeleteKey);
      pendingDeleteKey = null;
    }
    deleteModal.classList.remove('open');
  });

  // Close delete modal on backdrop click
  deleteModal.addEventListener('click', function (e) {
    if (e.target === deleteModal) closeDeleteModal();
  });

  // ── Bootstrap: load data then render ─────────────────────────
  fetch('drivers.json')
    .then(function (res) {
      if (!res.ok) throw new Error('Failed to load drivers.json: ' + res.status);
      return res.json();
    })
    .then(function (drivers) {
      renderCards(drivers);
    })
    .catch(function (err) {
      listEl.innerHTML =
        '<p style="padding:24px;color:#b91c1c;">Error loading data: ' +
        err.message + '</p>';
      console.error(err);
    });

})();
