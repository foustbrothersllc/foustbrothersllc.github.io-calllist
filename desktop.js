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
   ============================================================ */
(function () {
  'use strict';

  var mq = window.matchMedia('(min-width: 1024px)');

  function $(id) { return document.getElementById(id); }

  var cardList, tbody, emptyMsg, sideSearch, sideAdd, searchBox, fabAdd;

  var LOC_LABEL = { greensboro: 'GRENC', mebane: 'MEBNC', retired: 'Retired' };

  function locLabel(loc) {
    if (!loc) return '';
    return LOC_LABEL[loc] || (loc.charAt(0).toUpperCase() + loc.slice(1));
  }

  // Build a phone cell that proxies clicks to the card's own phone button
  function fillPhoneCell(td, group) {
    if (!group) {
      td.textContent = '—';
      td.className = 'dt-muted';
      return;
    }
    var numEl = group.querySelector('.phone-number');
    var tagEl = group.querySelector('.alt-tag');
    var btnEl = group.querySelector('.phone-btn');

    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'dt-phone';
    b.textContent = numEl ? numEl.textContent : '';
    b.title = 'Call / text options';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (btnEl) btnEl.click();
    });
    td.appendChild(b);

    if (tagEl && tagEl.textContent) {
      var tag = document.createElement('span');
      tag.className = 'dt-tag';
      tag.textContent = tagEl.textContent;
      td.appendChild(tag);
    }
  }

  function buildRow(outer) {
    var tr = document.createElement('tr');

    // Name
    var nameEl = outer.querySelector('.name');
    var tdName = document.createElement('td');
    tdName.className = 'dt-name';
    tdName.textContent = nameEl ? nameEl.textContent : '';
    tr.appendChild(tdName);

    // Primary phone + every other number on file (each its own line,
    // so a driver with 3, 4 or 5 numbers is fully visible — no popover
    // or "+N more" needed).
    var groups = outer.querySelectorAll('.phone-group');
    var tdP1 = document.createElement('td');
    fillPhoneCell(tdP1, groups[0] || null);
    tr.appendChild(tdP1);

    var tdOther = document.createElement('td');
    if (groups.length > 1) {
      for (var k = 1; k < groups.length; k++) {
        var line = document.createElement('div');
        line.className = 'dt-other-line';
        fillPhoneCell(line, groups[k]);
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

  function sync() {
    if (!mq.matches || !tbody) return;

    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

    var outers = cardList.querySelectorAll('.card-outer');
    var visible = 0;
    for (var i = 0; i < outers.length; i++) {
      var o = outers[i];
      if (o.style.display === 'none') continue; // respect app's own filtering
      visible++;
      tbody.appendChild(buildRow(o));
    }
    if (emptyMsg) emptyMsg.style.display = visible === 0 ? 'block' : 'none';

    // Mirror admin-only Add button (fab is shown/hidden by app.js)
    if (sideAdd && fabAdd) {
      sideAdd.style.display = fabAdd.style.display === 'none' ? 'none' : '';
    }

    // Mirror the active location filter onto the sidebar buttons
    var active = document.querySelector('.filter-btns .filter-btn.active');
    var loc = active ? active.dataset.loc : 'all';
    var sbtns = document.querySelectorAll('.ds-filter');
    for (var j = 0; j < sbtns.length; j++) {
      sbtns[j].classList.toggle('active', sbtns[j].dataset.loc === loc);
    }

    // Mirror search text (unless the user is typing in the sidebar box)
    if (sideSearch && searchBox && document.activeElement !== sideSearch) {
      sideSearch.value = searchBox.value;
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
    if (!cardList || !tbody) return; // desktop markup absent — do nothing

    // Rebuild whenever the card list changes (renders, filters, edits)
    new MutationObserver(scheduleSync).observe(cardList, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    });

    // Watch admin login/logout via the fab's visibility
    if (fabAdd) {
      new MutationObserver(scheduleSync).observe(fabAdd, {
        attributes: true,
        attributeFilter: ['style']
      });
    }

    // Sidebar search → existing header search box
    if (sideSearch && searchBox) {
      sideSearch.addEventListener('input', function () {
        searchBox.value = sideSearch.value;
        searchBox.dispatchEvent(new Event('input', { bubbles: true }));
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
