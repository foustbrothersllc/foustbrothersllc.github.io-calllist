/* ============================================================
   Driver Call List — desktop.js  (desktop table add-on)
   ============================================================
   Standalone add-on: mirrors the existing mobile card list into
   a table on wide screens (≥1024px). It NEVER touches app.js or
   its data — every action (Edit, call, filter, Add Driver) just
   clicks the existing hidden control, so behavior is identical.
   Safe to remove: delete this file + the desktop block in
   styles.css + the desktop markup in index.html and the app is
   exactly what it was before.

   Filtering note: the table does NOT read the mobile app's own
   filtered display:none state. app.js's search does one exact
   substring match against "lastname firstname phone label", so
   typing a first name then a last name ("Jacob Foust") never
   matches "foust jacob ..." and silently blanks the list. The
   table instead keeps its own word-order-proof match (every
   typed word must appear somewhere in the driver's search text)
   so this can't happen here. Mobile's own search is untouched.
   ============================================================ */
(function () {
  'use strict';

  var mq = window.matchMedia('(min-width: 1024px)');

  function $(id) { return document.getElementById(id); }

  var cardList, tbody, emptyMsg, sideSearch, sideAdd, searchBox, fabAdd, countBar;
  var deskQuery = '';

  var LOC_LABEL = { greensboro: 'GRENC', mebane: 'MEBNC', retired: 'Retired' };

  function locLabel(loc) {
    if (!loc) return '';
    return LOC_LABEL[loc] || (loc.charAt(0).toUpperCase() + loc.slice(1));
  }

  function matchesQuery(searchText, query) {
    if (!query) return true;
    var words = query.toLowerCase().split(/\s+/).filter(Boolean);
    for (var i = 0; i < words.length; i++) {
      if (searchText.indexOf(words[i]) === -1) return false;
    }
    return true;
  }

  // Same clipboard approach app.js itself uses for its "Copy Number" button.
  function copyToClipboard(text, onDone) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onDone).catch(function () {
        fallbackCopy(text); onDone();
      });
    } else {
      fallbackCopy(text);
      onDone();
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  // ── Driver card popup (readable view; opened from a name or number
  //    click). On desktop there's no dialer/SMS app to hand off to, so
  //    clicking a phone row here just copies the number — no Call/Text/
  //    Copy/Save sheet like mobile shows. ──
  function closeCardPopup() {
    var el = $('dtCardPopup');
    if (el) el.remove();
    document.removeEventListener('keydown', onPopupKeydown);
  }
  function onPopupKeydown(e) {
    if (e.key === 'Escape') closeCardPopup();
  }

  function openCardPopup(outer) {
    closeCardPopup();

    var nameEl  = outer.querySelector('.name');
    var badgeEl = outer.querySelector('.loc-badge');
    var groups  = outer.querySelectorAll('.phone-group');

    var backdrop = document.createElement('div');
    backdrop.id = 'dtCardPopup';
    backdrop.className = 'dt-card-backdrop';

    var card = document.createElement('div');
    card.className = 'dt-card-modal';
    backdrop.appendChild(card);

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'dt-card-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closeCardPopup);
    card.appendChild(closeBtn);

    var head = document.createElement('div');
    head.className = 'dt-card-head';
    var h = document.createElement('div');
    h.className = 'dt-card-name';
    h.textContent = nameEl ? nameEl.textContent : '';
    head.appendChild(h);
    if (badgeEl && badgeEl.textContent) {
      var badge = document.createElement('span');
      badge.className = 'dt-card-badge';
      badge.textContent = badgeEl.textContent;
      head.appendChild(badge);
    }
    card.appendChild(head);

    var list = document.createElement('div');
    list.className = 'dt-card-phones';
    if (groups.length === 0) {
      var none = document.createElement('div');
      none.className = 'dt-card-none';
      none.textContent = 'No phone number on file';
      list.appendChild(none);
    }
    for (var i = 0; i < groups.length; i++) {
      (function (group, isPrimary) {
        var numEl  = group.querySelector('.phone-number');
        var tagEl  = group.querySelector('.alt-tag');

        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'dt-card-phone-row' + (isPrimary ? ' dt-card-phone-primary' : '');
        row.title = 'Click to copy number';

        var num = document.createElement('span');
        num.className = 'dt-card-phone-num';
        num.textContent = numEl ? numEl.textContent : '';
        row.appendChild(num);

        if (tagEl && tagEl.textContent) {
          var tag = document.createElement('span');
          tag.className = 'dt-card-phone-tag';
          tag.textContent = tagEl.textContent;
          row.appendChild(tag);
        }
        if (isPrimary) {
          var pl = document.createElement('span');
          pl.className = 'dt-card-phone-primary-label';
          pl.textContent = 'Primary';
          row.appendChild(pl);
        }

        var hint = document.createElement('span');
        hint.className = 'dt-card-phone-hint';
        hint.textContent = '📋 Copy';
        row.appendChild(hint);

        // Desktop has no dialer/SMS app to hand off to, so — unlike mobile —
        // a click here just copies the number. No Call/Text/Copy/Save sheet.
        row.addEventListener('click', function () {
          var text = num.textContent;
          copyToClipboard(text, function () {
            hint.textContent = '✅ Copied';
            setTimeout(function () { hint.textContent = '📋 Copy'; }, 1400);
          });
        });
        list.appendChild(row);
      })(groups[i], i === 0);
    }
    card.appendChild(list);

    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) closeCardPopup();
    });
    document.addEventListener('keydown', onPopupKeydown);
  }

  // Build a phone cell. Clicking it opens the driver card popup (not the
  // action sheet directly — that's reached from inside the popup).
  function fillPhoneCell(container, group, outer) {
    if (!group) {
      container.textContent = '—';
      container.className = (container.className ? container.className + ' ' : '') + 'dt-muted';
      return;
    }
    var numEl = group.querySelector('.phone-number');
    var tagEl = group.querySelector('.alt-tag');

    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'dt-phone';
    b.textContent = numEl ? numEl.textContent : '';
    b.title = 'View driver card';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      openCardPopup(outer);
    });
    container.appendChild(b);

    if (tagEl && tagEl.textContent) {
      var tag = document.createElement('span');
      tag.className = 'dt-tag';
      tag.textContent = tagEl.textContent;
      container.appendChild(tag);
    }
  }

  function buildRow(outer) {
    var tr = document.createElement('tr');

    // Name — also opens the driver card popup
    var nameEl = outer.querySelector('.name');
    var tdName = document.createElement('td');
    var nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'dt-name';
    nameBtn.textContent = nameEl ? nameEl.textContent : '';
    nameBtn.title = 'View driver card';
    nameBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openCardPopup(outer);
    });
    tdName.appendChild(nameBtn);
    tr.appendChild(tdName);

    // Primary phone + every other number on file (each its own line,
    // so a driver with 3, 4 or 5 numbers is fully visible).
    var groups = outer.querySelectorAll('.phone-group');
    var tdP1 = document.createElement('td');
    fillPhoneCell(tdP1, groups[0] || null, outer);
    tr.appendChild(tdP1);

    var tdOther = document.createElement('td');
    if (groups.length > 1) {
      for (var k = 1; k < groups.length; k++) {
        var line = document.createElement('div');
        line.className = 'dt-other-line';
        fillPhoneCell(line, groups[k], outer);
        tdOther.appendChild(line);
      }
    } else {
      tdOther.textContent = '—';
      tdOther.className = 'dt-muted';
    }
    tr.appendChild(tdOther);

    // Location badge
    var tdLoc = document.createElement('td');
    tdLoc.className = 'dt-loc';
    var label = locLabel(outer.dataset.location);
    if (label) {
      var badge = document.createElement('span');
      badge.textContent = label;
      tdLoc.appendChild(badge);
    }
    tr.appendChild(tdLoc);

    // Edit (right-aligned; only exists when admin is logged in,
    // because the card only has an Edit button for admins)
    var tdEdit = document.createElement('td');
    tdEdit.className = 'dt-actions';
    var cardEdit = outer.querySelector('.btn-edit');
    if (cardEdit) {
      var eb = document.createElement('button');
      eb.type = 'button';
      eb.className = 'dt-edit';
      eb.textContent = 'Edit';
      eb.addEventListener('click', function (e) {
        e.stopPropagation();
        cardEdit.click();
      });
      tdEdit.appendChild(eb);
    }
    tr.appendChild(tdEdit);

    return tr;
  }

  function updateCountBar(visible, total) {
    if (!countBar) return;
    var meta = null;
    try { meta = JSON.parse(localStorage.getItem('dcl_last_import') || 'null'); } catch (e) {}
    var ts = meta ? ' · Updated ' + meta.date : '';
    countBar.textContent = 'Showing ' + visible + ' of ' + total + ' drivers' + ts;
  }

  function sync() {
    if (!mq.matches || !tbody) return;

    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

    // Location filter comes from whichever header button is active
    // (clicking a sidebar filter proxies a click to that real button).
    var active = document.querySelector('.filter-btns .filter-btn.active');
    var loc = active ? active.dataset.loc : 'all';

    var outers = cardList.querySelectorAll('.card-outer');
    var visible = 0;
    for (var i = 0; i < outers.length; i++) {
      var o = outers[i];
      var locMatch  = loc === 'all' || o.dataset.location === loc;
      var textMatch = matchesQuery(o.dataset.search || '', deskQuery);
      if (!locMatch || !textMatch) continue;
      visible++;
      tbody.appendChild(buildRow(o));
    }
    if (emptyMsg) emptyMsg.style.display = visible === 0 ? 'block' : 'none';
    updateCountBar(visible, outers.length);

    // Mirror admin-only Add button (fab is shown/hidden by app.js)
    if (sideAdd && fabAdd) {
      sideAdd.style.display = fabAdd.style.display === 'none' ? 'none' : '';
    }

    // Mirror the active location filter onto the sidebar buttons
    var sbtns = document.querySelectorAll('.ds-filter');
    for (var j = 0; j < sbtns.length; j++) {
      sbtns[j].classList.toggle('active', sbtns[j].dataset.loc === loc);
    }
  }

  // Debounce: card renders arrive in RAF batches; rebuild once per frame
  var scheduled = false;
  function scheduleSync() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      sync();
    });
  }

  function init() {
    cardList   = $('cardList');
    tbody      = $('desktopTableBody');
    emptyMsg   = $('desktopTableEmpty');
    sideSearch = $('desktopSearch');
    sideAdd    = $('desktopAddBtn');
    searchBox  = $('searchBox');
    fabAdd     = $('fabAdd');
    countBar   = $('countBar');
    if (!cardList || !tbody) return; // desktop markup absent — do nothing

    // Rebuild whenever the card list changes (renders, edits, admin login)
    new MutationObserver(scheduleSync).observe(cardList, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });

    // Watch admin login/logout via the fab's visibility
    if (fabAdd) {
      new MutationObserver(scheduleSync).observe(fabAdd, {
        attributes: true,
        attributeFilter: ['style']
      });
    }

    // Sidebar search: filtered independently (see file header note) —
    // mirror the text into the real search box for visual consistency
    // on a resize, but do NOT dispatch its 'input' event, so the mobile
    // field's own (buggy, order-sensitive) filter never runs from here.
    if (sideSearch) {
      sideSearch.addEventListener('input', function () {
        deskQuery = sideSearch.value;
        if (searchBox) searchBox.value = sideSearch.value;
        scheduleSync();
      });
    }

    // Sidebar Add Driver → existing fab
    if (sideAdd && fabAdd) {
      sideAdd.addEventListener('click', function () { fabAdd.click(); });
    }

    // Sidebar location filters → existing header filter buttons
    var sbtns = document.querySelectorAll('.ds-filter');
    for (var i = 0; i < sbtns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var target = document.querySelector(
            '.filter-btns .filter-btn[data-loc="' + btn.dataset.loc + '"]'
          );
          if (target) target.click();
          scheduleSync();
        });
      })(sbtns[i]);
    }

    // Re-sync when crossing the desktop breakpoint
    if (mq.addEventListener)   mq.addEventListener('change', scheduleSync);
    else if (mq.addListener)   mq.addListener(scheduleSync);

    sync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
