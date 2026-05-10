/* ============================================================
   Driver Call List — app.js
   ============================================================ */

(function () {
  'use strict';

  // ── DOM references ──────────────────────────────────────────
  const list        = document.getElementById('cardList');
  const searchBox   = document.getElementById('searchBox');
  const countBar    = document.getElementById('countBar');
  const noResults   = document.getElementById('noResults');
  const filterBtns  = document.querySelectorAll('.filter-btn');

  let activeFilter = 'all';
  let allCards     = [];

  // ── Helpers ─────────────────────────────────────────────────

  /**
   * Normalise a phone-number string for use in a tel: href.
   * Strips everything except digits and keeps the last 10.
   */
  function toTelDigits(digits) {
    return '+1' + digits;
  }

  /**
   * Build a single location-badge element.
   */
  function makeBadge(location) {
    if (!location) return null;
    const span = document.createElement('span');
    span.className = 'loc-badge loc-' + location.toLowerCase();
    span.textContent = location;
    return span;
  }

  /**
   * Build a clickable phone-button anchor element.
   * @param {string} digits      - 10-digit phone number
   * @param {string} display     - human-readable label from the data
   * @param {boolean} isAlt      - whether this is the alternate number
   */
  function makePhoneBtn(digits, display, isAlt) {
    const a = document.createElement('a');
    a.href      = 'tel:' + toTelDigits(digits);
    a.className = 'phone-btn ' + (isAlt ? 'alt' : 'primary');

    const icon = document.createElement('span');
    icon.className   = 'phone-icon';
    icon.textContent = '📞';
    icon.setAttribute('aria-hidden', 'true');

    const num = document.createElement('span');
    num.className   = 'phone-number';
    num.textContent = display;

    a.appendChild(icon);
    a.appendChild(num);

    if (isAlt) {
      const tag = document.createElement('span');
      tag.className   = 'alt-tag';
      tag.textContent = 'Alt';
      a.appendChild(tag);
    }

    return a;
  }

  /**
   * Build a card DOM element from a driver data object.
   */
  function buildCard(driver) {
    const card = document.createElement('div');
    card.className = 'card';

    // Search string stored as a data attribute for fast filtering
    const searchStr = [
      driver.lastName,
      driver.firstName,
      driver.phone    ? driver.phone.display    : '',
      driver.altPhone ? driver.altPhone.display : '',
      driver.location,
    ].join(' ').toLowerCase();
    card.dataset.search   = searchStr;
    card.dataset.location = (driver.location || '').toLowerCase();

    // ── Header row (name + badge) ──
    const header = document.createElement('div');
    header.className = 'card-header';

    const nameEl = document.createElement('span');
    nameEl.className   = 'name';
    nameEl.textContent = driver.lastName + ', ' + driver.firstName;

    header.appendChild(nameEl);

    const badge = makeBadge(driver.location);
    if (badge) header.appendChild(badge);

    card.appendChild(header);

    // ── Phone buttons ──
    const phones = document.createElement('div');
    phones.className = 'phones';

    if (driver.phone) {
      phones.appendChild(makePhoneBtn(driver.phone.digits, driver.phone.display, false));
    }
    if (driver.altPhone) {
      phones.appendChild(makePhoneBtn(driver.altPhone.digits, driver.altPhone.display, true));
    }
    if (!driver.phone && !driver.altPhone) {
      const none = document.createElement('span');
      none.className   = 'no-phone';
      none.textContent = 'No phone listed';
      phones.appendChild(none);
    }

    card.appendChild(phones);
    return card;
  }

  // ── Render ──────────────────────────────────────────────────

  /**
   * Render all driver cards into the list element.
   * Call once after data is loaded.
   */
  function renderCards(drivers) {
    const fragment = document.createDocumentFragment();
    drivers.forEach(function (driver) {
      const card = buildCard(driver);
      fragment.appendChild(card);
      allCards.push(card);
    });
    list.insertBefore(fragment, document.getElementById('noResults'));
    updateCount(allCards.length);
  }

  // ── Filter ──────────────────────────────────────────────────

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

  // ── Event listeners ─────────────────────────────────────────

  searchBox.addEventListener('input', applyFilter);

  filterBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      filterBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      activeFilter = btn.dataset.loc;
      applyFilter();
    });
  });

  // ── Bootstrap: load data then render ────────────────────────

  fetch('drivers.json')
    .then(function (res) {
      if (!res.ok) throw new Error('Failed to load drivers.json: ' + res.status);
      return res.json();
    })
    .then(function (drivers) {
      renderCards(drivers);
    })
    .catch(function (err) {
      list.innerHTML =
        '<p style="padding:24px;color:#c00;">Error loading data: ' +
        err.message + '</p>';
      console.error(err);
    });

})();
