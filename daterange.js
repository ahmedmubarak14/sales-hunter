/* ============================================================
   Sales Hunter — date range picker
   A trigger button that opens a card: preset rail, two-month
   range calendar, typed From/To fields, Cancel/Apply.
   Dependency-free and date-only (no time component) — the app
   has no build step, so this is the same control the Untitled
   UI DateRangePicker gives React, written for this stack.

   Dates are plain local Date objects pinned to midnight. The
   caller decides what the bounds mean (see rangePredicate in
   app.js); this file only ever hands back whole days.
   ============================================================ */

/* Midnight-local, never UTC: the app's day boundaries have to agree with
   lead.createdAt, which is local too. */
function drpDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function drpSameDay(a, b) {
  return !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function drpAddMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }

/* Arabic uses Latin digits here to match every other number in the app
   (fmtDate does the same), and the Gregorian calendar because that is
   what the CRM records. */
function drpLocale() { return isAr() ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB'; }

/* Sunday-first in Arabic (the working week in KSA), Monday-first in
   en-GB. Intl exposes no reliable first-day-of-week in older engines, so
   this is stated rather than derived. */
function drpFirstDay() { return isAr() ? 0 : 1; }

function drpWeekdayLabels() {
  var first = drpFirstDay();
  // 7 Jan 2024 was a Sunday, so +dayOfWeek lands on each weekday in turn.
  var fmt = new Intl.DateTimeFormat(drpLocale(), { weekday: isAr() ? 'narrow' : 'short' });
  var out = [];
  for (var i = 0; i < 7; i++) {
    var label = fmt.format(new Date(2024, 0, 7 + ((first + i) % 7)));
    out.push(isAr() ? label : label.slice(0, 2));
  }
  return out;
}

function drpMonthTitle(d) {
  return new Intl.DateTimeFormat(drpLocale(), { month: 'long', year: 'numeric' }).format(d);
}
function drpFullDate(d) {
  return new Intl.DateTimeFormat(drpLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

/* The typed field format. Deliberately numeric and fixed rather than
   locale-formatted prose: this string has to survive a round trip
   through a text input, and "11 Jun 2026" does not parse back cleanly. */
function drpFieldValue(d) {
  if (!d) return '';
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}
function drpParseField(s) {
  var v = String(s || '').trim();
  if (!v) return null;
  var m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(v);          // 11/06/2026
  var y, mo, day;
  if (m) { day = +m[1]; mo = +m[2]; y = +m[3]; }
  else {
    m = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/.exec(v);            // 2026-06-11
    if (!m) return null;
    y = +m[1]; mo = +m[2]; day = +m[3];
  }
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
  var d = new Date(y, mo - 1, day);
  // Rejects 31/02: the Date constructor rolls over instead of failing.
  return (d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === day) ? d : null;
}

/* Six rows always, even when five would do: a grid that changes height
   makes the whole card jump as you page through months. */
function drpMonthCells(monthStart) {
  var lead = (monthStart.getDay() - drpFirstDay() + 7) % 7;
  var out = [];
  for (var i = 0; i < 42; i++) {
    out.push(new Date(monthStart.getFullYear(), monthStart.getMonth(), 1 - lead + i));
  }
  return out;
}

var DRP_ICONS = {
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'
};

/* Only one picker may be open at a time, and a click anywhere else
   dismisses it. Registered once for the app's lifetime rather than per
   instance, so re-rendering a view cannot leak listeners (the same
   mistake the access picker in app.js had to be fixed for). */
var drpOpenPicker = null;
document.addEventListener('click', function () { if (drpOpenPicker) drpOpenPicker(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && drpOpenPicker) drpOpenPicker(); });

/* createDateRangePicker({ presets, value, max, onApply })
     presets  [{ key, label, range() -> {from,to} }]  — from/to null = unbounded
     value    { key, from, to }  the committed range
     max      latest selectable day (leads cannot be filed in the future)
     onApply  fn({ key, from, to }) — called only on Apply
   Returns { el, getValue }. The element is inert until inserted. */
function createDateRangePicker(opts) {
  var presets = opts.presets || [];
  var max = opts.max ? drpDay(opts.max) : null;
  var committed = { key: opts.value.key, from: opts.value.from, to: opts.value.to };
  // The draft is what the card shows. Nothing reaches the caller until
  // Apply, so Cancel (and dismissing the card) is always a true undo.
  var draft = { key: committed.key, from: committed.from, to: committed.to };
  var anchor = null;        // first click of an in-progress selection
  var hover = null;         // day under the cursor, for the preview band
  var viewMonth = null;     // left-hand month
  var focusDay = null;      // roving tabindex target

  var root = document.createElement('div');
  root.className = 'drp';

  function triggerLabel() {
    var p = presets.find(function (x) { return x.key === committed.key; });
    if (committed.key !== 'custom' && p) return p.label;
    if (committed.from && committed.to) return fmtDate(committed.from) + ' – ' + fmtDate(committed.to);
    if (committed.from) return t('drpFromOnly', { from: fmtDate(committed.from) });
    if (committed.to) return t('drpToOnly', { to: fmtDate(committed.to) });
    return t('rangeAll');
  }

  root.innerHTML =
    '<button type="button" class="drp-trigger" aria-haspopup="dialog" aria-expanded="false">' +
      DRP_ICONS.calendar + '<span class="drp-trigger-label"></span>' +
    '</button>' +
    '<div class="drp-pop" hidden role="dialog" aria-label="' + esc(t('drpDialogLabel')) + '">' +
      '<div class="drp-rail" role="group" aria-label="' + esc(t('drpPresetsLabel')) + '"></div>' +
      '<div class="drp-main">' +
        '<div class="drp-cals"></div>' +
        '<div class="drp-foot">' +
          '<div class="drp-fields">' +
            '<input type="text" class="drp-field" inputmode="numeric" autocomplete="off" spellcheck="false" data-end="from" aria-label="' + esc(t('dateFrom')) + '" placeholder="' + esc(t('drpFieldHint')) + '">' +
            '<span class="drp-dash" aria-hidden="true">–</span>' +
            '<input type="text" class="drp-field" inputmode="numeric" autocomplete="off" spellcheck="false" data-end="to" aria-label="' + esc(t('dateTo')) + '" placeholder="' + esc(t('drpFieldHint')) + '">' +
          '</div>' +
          '<div class="drp-actions">' +
            '<button type="button" class="btn secondary drp-cancel">' + t('drpCancel') + '</button>' +
            '<button type="button" class="btn drp-apply">' + t('drpApply') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  var trigger = root.querySelector('.drp-trigger');
  var triggerText = root.querySelector('.drp-trigger-label');
  var pop = root.querySelector('.drp-pop');
  var rail = root.querySelector('.drp-rail');
  var cals = root.querySelector('.drp-cals');
  var fromField = root.querySelector('.drp-field[data-end="from"]');
  var toField = root.querySelector('.drp-field[data-end="to"]');

  /* ---- rendering ---- */

  function renderTrigger() { triggerText.textContent = triggerLabel(); }

  function renderRail() {
    rail.innerHTML = presets.map(function (p) {
      return '<button type="button" class="drp-preset' + (draft.key === p.key ? ' active' : '') +
        '" data-preset="' + esc(p.key) + '" aria-pressed="' + (draft.key === p.key) + '">' + esc(p.label) + '</button>';
    }).join('');
  }

  // The band shown while a selection is half-made follows the cursor, so
  // the second click is predictable before it happens.
  function activeRange() {
    if (anchor && hover) return anchor <= hover ? { from: anchor, to: hover } : { from: hover, to: anchor };
    if (anchor) return { from: anchor, to: anchor };
    return { from: draft.from, to: draft.to };
  }

  /* The roving tabindex has to land on a day that is actually on screen.
     Paging away from the selection used to leave focusDay outside both
     months, so no cell claimed tabindex="0" and the grid dropped out of
     the tab order entirely — reachable by mouse only. */
  function tabDay() {
    var lo = viewMonth;
    var hi = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 2, 0);
    if (focusDay && focusDay >= lo && focusDay <= hi) return focusDay;
    return (max && lo > max) ? null : lo;
  }

  function renderCals() {
    var r = activeRange();
    var tab = tabDay();
    var months = [viewMonth, drpAddMonths(viewMonth, 1)];
    cals.innerHTML = months.map(function (mStart, idx) {
      var cells = drpMonthCells(mStart).map(function (d) {
        // Leading and trailing days are blanked rather than drawn. The two
        // months are adjacent, so a trailing day here is the same date the
        // next grid already shows — rendering both put the selected band
        // on screen twice for the same week.
        if (d.getMonth() !== mStart.getMonth()) return '<div class="drp-cell"></div>';
        var disabled = max && d > max;
        var isFrom = drpSameDay(d, r.from), isTo = drpSameDay(d, r.to);
        var spans = r.from && r.to && !drpSameDay(r.from, r.to);
        var inside = r.from && r.to && d > r.from && d < r.to;
        // Cell classes drive the connecting band, button classes the chip.
        var cell = ['drp-cell'];
        if (inside) cell.push('inside');
        if (spans && isFrom) cell.push('cap-start');
        if (spans && isTo) cell.push('cap-end');
        var cls = ['drp-day'];
        if (disabled) cls.push('disabled');
        if (isFrom || isTo) cls.push('sel');
        else if (inside) cls.push('in');
        if (drpSameDay(d, max)) cls.push('is-today');
        var tabbable = drpSameDay(d, tab) && !disabled;
        return '<div class="' + cell.join(' ') + '">' +
          '<button type="button" class="' + cls.join(' ') + '"' +
          ' data-iso="' + d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + '"' +
          (disabled ? ' disabled' : '') +
          ' tabindex="' + (tabbable ? '0' : '-1') + '"' +
          (drpSameDay(d, max) ? ' aria-current="date"' : '') +
          ' aria-label="' + esc(drpFullDate(d)) + '"' +
          ' aria-pressed="' + !!(isFrom || isTo) + '">' + d.getDate() + '</button></div>';
      }).join('');

      // The second month is hidden on narrow screens, so the "next"
      // control has to exist in the first header too.
      var head = '<div class="drp-cal-head">' +
        (idx === 0
          ? '<button type="button" class="drp-nav" data-nav="-1" aria-label="' + esc(t('drpPrevMonth')) + '">' + DRP_ICONS.prev + '</button>'
          : '<span class="drp-nav-gap"></span>') +
        '<div class="drp-cal-title">' + esc(drpMonthTitle(mStart)) + '</div>' +
        (idx === 0
          ? '<button type="button" class="drp-nav only-1up" data-nav="1" aria-label="' + esc(t('drpNextMonth')) + '">' + DRP_ICONS.next + '</button>'
          : '<button type="button" class="drp-nav" data-nav="1" aria-label="' + esc(t('drpNextMonth')) + '">' + DRP_ICONS.next + '</button>') +
        '</div>';

      return '<div class="drp-cal' + (idx === 1 ? ' drp-cal-2' : '') + '">' + head +
        '<div class="drp-wk">' + drpWeekdayLabels().map(function (w) {
          return '<span>' + esc(w) + '</span>';
        }).join('') + '</div>' +
        '<div class="drp-grid">' + cells + '</div></div>';
    }).join('');
  }

  /* force=true repaints the field the user is typing in too. Incidental
     re-renders (a preset click, paging months) must not yank text out
     from under a half-typed date — but a commit must, or a value that was
     swapped, clamped or rejected keeps showing the raw text while the
     draft holds something else entirely. */
  function renderFields(force) {
    if (force || document.activeElement !== fromField) fromField.value = drpFieldValue(draft.from);
    if (force || document.activeElement !== toField) toField.value = drpFieldValue(draft.to);
  }

  function renderCard(force) { renderRail(); renderCals(); renderFields(force); }

  /* ---- placement ----
     Fixed rather than absolute: the card is wider than the control that
     opens it and must be free to overhang the card, the table's scroll
     container, and the page edge without being clipped by any of them. */
  function place() {
    var r = trigger.getBoundingClientRect();
    // Measure unconstrained, then constrain: reading offsetHeight while a
    // maxHeight from the previous placement is still applied gives the
    // clamped height, and the card would creep smaller on every scroll.
    pop.style.maxHeight = '';
    var h = pop.offsetHeight, w = pop.offsetWidth;
    var below = window.innerHeight - r.bottom - 12;
    var above = r.top - 12;
    // Open downwards unless it does not fit and there is genuinely more
    // room the other way.
    var flip = h > below && above > below;
    var avail = Math.max(240, flip ? above : below);
    pop.style.maxHeight = avail + 'px';
    pop.style.top = (flip ? Math.max(8, r.top - Math.min(h, avail) - 6) : r.bottom + 6) + 'px';
    var left = isAr() ? r.right - w : r.left;
    pop.style.left = Math.max(8, Math.min(left, window.innerWidth - w - 8)) + 'px';
  }

  /* ---- open / close ---- */

  function open() {
    draft = { key: committed.key, from: committed.from, to: committed.to };
    anchor = null; hover = null;
    // Open on the month the range ends in — that is where the user last
    // was — falling back to the current month.
    var seed = draft.to || draft.from || max || new Date();
    viewMonth = new Date(seed.getFullYear(), seed.getMonth() - 1, 1);
    focusDay = draft.from || draft.to || max || new Date();
    renderCard();
    pop.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    drpOpenPicker = close;
  }

  function close() {
    if (pop.hidden) return;
    pop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    if (drpOpenPicker === close) drpOpenPicker = null;
  }

  function apply() {
    // A half-finished selection commits as a single day rather than
    // silently reverting to whatever was there before.
    if (anchor && !draft.to) { draft.from = anchor; draft.to = anchor; draft.key = 'custom'; }
    committed = { key: draft.key, from: draft.from, to: draft.to };
    renderTrigger();
    close();
    trigger.focus();
    if (opts.onApply) opts.onApply({ key: committed.key, from: committed.from, to: committed.to });
  }

  /* ---- interaction ---- */

  trigger.addEventListener('click', function (e) {
    e.stopPropagation();
    // Another picker open elsewhere closes first; the click is spent.
    if (drpOpenPicker && drpOpenPicker !== close) { drpOpenPicker(); return; }
    if (pop.hidden) open(); else close();
  });
  // Clicks inside the card must not reach the dismiss-on-outside handler.
  pop.addEventListener('click', function (e) { e.stopPropagation(); });

  rail.addEventListener('click', function (e) {
    var b = e.target.closest('[data-preset]');
    if (!b) return;
    var p = presets.find(function (x) { return x.key === b.getAttribute('data-preset'); });
    if (!p) return;
    var r = p.range();
    draft = { key: p.key, from: r.from, to: r.to };
    anchor = null; hover = null;
    var seed = draft.to || draft.from || max || new Date();
    viewMonth = new Date(seed.getFullYear(), seed.getMonth() - 1, 1);
    focusDay = draft.from || seed;
    renderCard();
    place();
  });

  cals.addEventListener('click', function (e) {
    var nav = e.target.closest('[data-nav]');
    if (nav) { viewMonth = drpAddMonths(viewMonth, +nav.getAttribute('data-nav')); renderCals(); place(); return; }
    var day = e.target.closest('.drp-day');
    if (!day || day.disabled) return;
    var d = dayOf(day);
    if (!anchor) { anchor = d; hover = d; }
    else {
      draft.from = anchor <= d ? anchor : d;
      draft.to = anchor <= d ? d : anchor;
      draft.key = 'custom';
      anchor = null; hover = null;
    }
    focusDay = d;
    renderCard();
  });

  cals.addEventListener('mouseover', function (e) {
    if (!anchor) return;
    var day = e.target.closest('.drp-day');
    if (!day || day.disabled) return;
    var d = dayOf(day);
    if (drpSameDay(d, hover)) return;
    hover = d;
    renderCals();
  });

  function dayOf(btn) {
    var p = btn.getAttribute('data-iso').split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  /* Roving tabindex: 84 day buttons would otherwise be 84 tab stops, so
     only one is tabbable and the arrows move between them. */
  cals.addEventListener('keydown', function (e) {
    var day = e.target.closest('.drp-day');
    if (!day) return;
    var step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, PageUp: -28, PageDown: 28 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    // Left and right follow reading order, so they swap under RTL.
    if (isAr() && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) step = -step;
    var d = dayOf(day);
    var next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step);
    if (max && next > max) return;
    focusDay = next;
    var leftEdge = viewMonth;
    var rightEdge = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 2, 0);
    if (next < leftEdge) viewMonth = drpAddMonths(viewMonth, -1);
    else if (next > rightEdge) viewMonth = drpAddMonths(viewMonth, 1);
    if (anchor) hover = next;
    renderCals();
    var el = cals.querySelector('.drp-day[tabindex="0"]');
    if (el) el.focus();
  });

  function commitField(input) {
    var which = input.getAttribute('data-end');
    var parsed = drpParseField(input.value);
    if (input.value.trim() === '') parsed = null;
    else if (!parsed) { renderFields(true); return; }      // unparseable: put the old value back
    if (parsed && max && parsed > max) parsed = max;
    draft[which] = parsed;
    // Typing the bounds out of order is a slip, not a request for an
    // empty table — read it as the range the two dates describe.
    if (draft.from && draft.to && draft.from > draft.to) {
      var swap = draft.from; draft.from = draft.to; draft.to = swap;
    }
    draft.key = 'custom';
    anchor = null; hover = null;
    var seed = draft[which] || draft.to || draft.from;
    if (seed) { viewMonth = new Date(seed.getFullYear(), seed.getMonth() - 1, 1); focusDay = seed; }
    renderCard(true);
    place();
  }
  [fromField, toField].forEach(function (input) {
    input.addEventListener('change', function () { commitField(input); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitField(input); }
    });
  });

  root.querySelector('.drp-cancel').addEventListener('click', function () { close(); trigger.focus(); });
  root.querySelector('.drp-apply').addEventListener('click', apply);

  renderTrigger();
  return {
    el: root,
    getValue: function () { return { key: committed.key, from: committed.from, to: committed.to }; }
  };
}
